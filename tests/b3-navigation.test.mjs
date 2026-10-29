import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../extension/content_script.js',import.meta.url),'utf8');
const location={pathname:'/alice/status/400/photo/1',search:''};
const doc={readyState:'loading',hidden:false,addEventListener(){}};
const context=vm.createContext({URL,URLSearchParams,Map,Set,Date,console,
 window:{location,addEventListener(){},setTimeout:(cb,ms)=>setTimeout(cb,ms),
 clearTimeout},document:doc,navigator:{onLine:true},Element:class{}});
vm.runInContext(source,context);
const proto=context.XMN.Controller.prototype;
const ref=id=>context.XMN.mediaRefFromHref('/alice/status/'+id+'/photo/1','alice');
function ctrl(){
 const refs=[ref(500),ref(400)],calls=[];
 const ctl=Object.assign(Object.create(proto),{
  originProfile:'alice',originTimeline:'alice|photo',
  refs,indexes:new Map(refs.map((x,i)=>[x.key,i])),
  viewer:{isConnected:true},navGeneration:7,navigationBusy:false,
  publicApiKeys:new Set(),publicApiAnchorFound:true,publicApiCursor:'next',
  publicApiExhausted:false,publicApiLoading:true,
  imageSources:new Map(),knownPhotoTotals:new Map(),
  activeIndex(){return this.refs.findIndex(x=>x.statusId==='400')},
  updateViewerState(){},persistPublicMediaSession(){return true},
  toast(){},navigate:async direction=>{calls.push(direction)},
  fetchPublicMediaPage:async()=>({refs:[ref(300)],photos:[],cursor:null})
 });
 return {ctl,calls};
}

test('one right key during warmup resumes once after verified older post',async()=>{
 const {ctl,calls}=ctrl();
 doc.hidden=false;location.pathname='/alice/status/400/photo/1';
 await proto.navigate.call(ctl,1);
 await proto.navigate.call(ctl,1); // Same intent, never two queued actions.
 assert.equal(ctl.pendingBoundary?.statusId,'400');
 ctl.publicApiLoading=false;
 assert.equal(await proto.loadPublicMediaContinuation.call(ctl,true),true);
 assert.deepEqual(calls,[1]);
 assert.equal(ctl.pendingBoundary,null);
});
test('route change while continuation is in flight prevents resuming a stale right key',async()=>{
 const {ctl,calls}=ctrl();
 doc.hidden=false;location.pathname='/alice/status/400/photo/1';
 await proto.navigate.call(ctl,1);
 ctl.publicApiLoading=false;
 ctl.fetchPublicMediaPage=async()=>{
  location.pathname='/alice/status/500/photo/1';
  return {refs:[ref(300)],photos:[],cursor:null};
 };
 try{
  assert.equal(await proto.loadPublicMediaContinuation.call(ctl,true),false);
  assert.deepEqual(calls,[]);
  assert.equal(ctl.pendingBoundary,null);
 }finally{location.pathname='/alice/status/400/photo/1'}
});
test('an opposite key or closed viewer cancels a pending intent',()=>{
 const {ctl}=ctrl();
 ctl.pendingBoundary={path:'/alice/status/400/photo/1',
  statusId:'400',generation:7};
 ctl.viewer=null;
 proto.onKeyDown.call(ctl,{key:'ArrowLeft',target:null});
 assert.equal(ctl.pendingBoundary,null);
});

test('B3 document handoff issues only one navigation under repeated right keys',async()=>{
 const previous=location.pathname,originalAssign=location.assign;
 const calls=[];
 location.pathname='/alice/status/500/photo/1';
 location.assign=url=>calls.push(url);
 const current=ref(500),next=ref(400);
 const ctl=Object.assign(Object.create(proto),{
  originProfile:'alice',originTimeline:'alice|photo',
  navGeneration:5,refs:[current,next],
  indexes:new Map([[current.key,0],[next.key,1]]),
  publicApiKeys:new Set([next.key]),publicSessionRestored:true,
  viewer:{isConnected:true},navigationBusy:false,
  activeIndex(){return 0},findLiveLink(){return null},
  updateViewerState(){},persistPublicMediaSession:async()=>true,
  toast(msg){throw Error(msg)}
 });
 try{
  await proto.navigate.call(ctl,1);
  await proto.navigate.call(ctl,1);
  assert.deepEqual(calls,[next.href]);
  assert.equal(ctl.pendingDocumentHandoff?.target,next.href);
 }finally{
  location.pathname=previous;
  if(originalAssign===undefined)delete location.assign;
  else location.assign=originalAssign;
 }
});
