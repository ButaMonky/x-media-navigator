import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const compiled=readFileSync(new URL('../extension/content_script.js',import.meta.url),'utf8');
const state={pathname:'/alice/status/800/photo/1',search:'',assign(){}};
const doc={readyState:'loading',hidden:false,addEventListener(){}};
const context=vm.createContext({
 URL,URLSearchParams,Map,Set,Date,console,Element:class{},
 window:{location:state,addEventListener(){},setTimeout,clearTimeout},
 document:doc,navigator:{onLine:true}
});
vm.runInContext(compiled,context);
const X=context.XMN, proto=X.Controller.prototype;
const ref=(id,n=1)=>X.mediaRefFromHref('/alice/status/'+id+'/photo/'+n,'alice');
const routes={next:'/alice/status/700/photo/1',previous:'/alice/status/800/photo/1'};
function controller(ids,selected,lookup,{page=null}={}){
 const refs=ids.map(x=>typeof x==='number'?ref(x):x);
 const prev={disabled:true},next={disabled:false},status={textContent:'',title:''};
 const viewer={isConnected:true,querySelector(sel){
  return sel==='.xmn-prev'?prev:sel==='.xmn-next'?next:
    sel==='.xmn-status'?status:null;
 }};
 const ctl=Object.assign(Object.create(proto),{
  originProfile:'alice',originTimeline:'alice|photo',publicSessionRestored:true,
  restoredCheckpointPage:page,navGeneration:7,navigationBusy:false,
  publicApiCursor:null,publicApiExhausted:true,
  refs,indexes:new Map(refs.map((r,i)=>[r.key,i])),viewer,
  activeIndex(){return selected},
  sessionStore:{findAdjacentCheckpoint:lookup,hasConsent(){
    throw Error('committed historical hop must not call volunteer API');
  }},
  pendingDocumentHandoff:null,checkpointBoundaryPending:false,
  toast(message){throw Error('unexpected toast: '+message)},
  fetchPublicMediaPage(){throw Error('must not refetch FxEmbed')}
 });
 return {ctl,prev,next,status};
}

test('B2 right from a saved final post uses only committed adjacent page URL',async()=>{
 const before=state.pathname, originalAssign=state.assign,targets=[],requests=[];
 state.pathname='/alice/status/800/photo/1';
 state.assign=href=>targets.push(href);
 const {ctl}=controller([900,800],1,async(profile,href,direction)=>{
  requests.push([profile,href,direction]);
  return {href:routes.next,page:1};
 });
 try{
  await proto.navigate.call(ctl,1);
  assert.deepEqual(targets,[routes.next]);
  assert.deepEqual(requests,[['alice','/alice/status/800/photo/1',1]]);
  assert.equal(ctl.pendingDocumentHandoff.target,routes.next);
  assert.equal(ctl.checkpointBoundaryPending,false);
 }finally{state.pathname=before;state.assign=originalAssign;}
});
test('B2 left from a historical first post returns to verified previous page',async()=>{
 const before=state.pathname,originalAssign=state.assign,targets=[];
 state.pathname='/alice/status/700/photo/1';
 state.assign=href=>targets.push(href);
 const {ctl,prev}=controller([700,600],0,async()=>({
  href:routes.previous,page:0
 }),{page:1});
 try{
  proto.updateViewerState.call(ctl);
  assert.equal(prev.disabled,false,'a committed previous page is an eligible back button');
  await proto.navigate.call(ctl,-1);
  assert.deepEqual(targets,[routes.previous]);
 }finally{state.pathname=before;state.assign=originalAssign;}
});
test('B2 repeated arrow while Worker resolves is single-use',async()=>{
 const before=state.pathname,originalAssign=state.assign,targets=[];
 state.pathname='/alice/status/800/photo/1';
 state.assign=href=>targets.push(href);
 let finish,lookups=0;
 const deferred=new Promise(resolve=>{finish=resolve});
 const {ctl}=controller([900,800],1,async()=>{
  lookups++;return deferred;
 });
 try{
  const one=proto.navigate.call(ctl,1);
  const two=proto.navigate.call(ctl,1);
  assert.equal(lookups,1);
  finish({href:routes.next,page:1});
  await Promise.all([one,two]);
  assert.deepEqual(targets,[routes.next]);
  await proto.navigate.call(ctl,1);
  assert.equal(targets.length,1,'the same in-flight document handoff cannot double-navigate');
 }finally{state.pathname=before;state.assign=originalAssign;}
});

test('B2 checkpoint lookup completing after route change must not navigate',async()=>{
 const before=state.pathname,originalAssign=state.assign,targets=[];
 state.pathname='/alice/status/800/photo/1';
 state.assign=href=>targets.push(href);
 const {ctl}=controller([900,800],1,async()=>{
  state.pathname='/bob/status/999/photo/1';
  return {href:routes.next,page:1};
 });
 try{
  await proto.navigate.call(ctl,1);
  assert.deepEqual(targets,[]);
  assert.equal(ctl.checkpointBoundaryPending,false);
  assert.equal(ctl.pendingDocumentHandoff,null);
 }finally{state.pathname=before;state.assign=originalAssign;}
});
test('B2 untrusted target outside the chronological next page is refused',async()=>{
 const before=state.pathname,originalAssign=state.assign,targets=[];
 state.pathname='/alice/status/800/photo/1';
 state.assign=href=>targets.push(href);
 const {ctl}=controller([900,800],1,async()=>({
  href:'/alice/status/950/photo/1',page:1
 }));
 try{
  await proto.navigate.call(ctl,1);
  assert.deepEqual(targets,[]);
  assert.equal(ctl.pendingDocumentHandoff,null);
 }finally{state.pathname=before;state.assign=originalAssign;}
});
test('B2 historical page without verified earlier neighbor disables old back button',async()=>{
 const before=state.pathname;
 state.pathname='/alice/status/700/photo/1';
 const {ctl,prev}=controller([700,600],0,async()=>null,{page:1});
 try{
  proto.updateViewerState.call(ctl);
  assert.equal(prev.disabled,false);
  await proto.navigate.call(ctl,-1);
  assert.equal(ctl.restoredCheckpointPage,null);
  assert.equal(prev.disabled,true);
 }finally{state.pathname=before;}
});
