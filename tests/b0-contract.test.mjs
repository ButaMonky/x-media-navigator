/** B0: isolated acceptance contracts. Run RED with XMN_B0_VERIFY_FIXES=1. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../extension/content_script.js',import.meta.url),'utf8');
const ctx=vm.createContext({
 URL,URLSearchParams,Map,Set,Date,console,Element:class{},
 window:{location:{pathname:'/alice/status/400/photo/1'},addEventListener(){},
  setTimeout:(fn,ms)=>setTimeout(fn,1),clearTimeout},
 document:{readyState:'loading',hidden:false,addEventListener(){}},
 navigator:{onLine:true},
});
vm.runInContext(source,ctx);
const X=ctx.XMN,proto=X.Controller.prototype;
const ref=(n,i=1)=>X.mediaRefFromHref('/alice/status/'+n+'/photo/'+i,'alice');
const check=process.env.XMN_B0_VERIFY_FIXES==='1';
const fixed=new Set(['R-001','R-026','R-028','R-029','R-032','R-033','R-042','R-044']);
const contract=(name,fn)=>test(name,{skip:!check && ![...fixed].some(id=>name.includes(id))?'B0 RED baseline; enable after implementation':false},fn);

test('B0 fixtures originate from the exact compiled MV3 bundle',()=>{
 assert.equal(typeof X.parsePublicMediaPage,'function');
 assert.equal(typeof proto.loadPublicMediaContinuation,'function');
 assert.equal(typeof proto.scanTiles,'function');
 assert.equal(typeof proto.restorePublicMediaSession,'function');
});
const apiPost=(id,assets)=>({type:'status',id:String(id),
 url:'https://x.com/alice/status/'+id,author:{screen_name:'alice'},
 media:{all:assets}});

contract('B0 R-044: officially typed animated_gif is not silently discarded',()=>{
 const api={code:200,results:[apiPost(300,[{type:'animated_gif'}])],
  cursor:{top:null,bottom:null}};
 const result=X.parsePublicMediaPage(api,'alice');
 assert.equal(result?.refs.length,1);
 assert.equal(result.refs[0].kind,'video');
});
contract('B0 R-029: malformed cursor cannot masquerade as end',()=>{
 const input={code:200,results:[apiPost(300,[{
  type:'photo',url:'https://pbs.twimg.com/media/A.jpg?name=large'}])]};
 assert.equal(X.parsePublicMediaPage(input,'alice'),null);
});
contract('B0 R-001: untrusted reversed restored session is rejected',async()=>{
 const r=[ref(400),ref(500),ref(300)],storage=new Map([[
 'xmn-public-media-v1',JSON.stringify({profile:'alice',
   timeline:'alice|photo',expires:Date.now()+60000,
   refs:r.map(x=>x.href),apiKeys:[r[2].key],
   anchorFound:true,cursor:'opaque'})]]);
 ctx.window.sessionStorage={getItem:k=>storage.get(k)||null};
 ctx.window.location.pathname=r[2].href;
 const instance=Object.assign(Object.create(proto),{
  refs:[],indexes:new Map(),publicApiKeys:new Set(),
  imageSources:new Map(),knownPhotoTotals:new Map()});
 await proto.restorePublicMediaSession.call(instance);
 assert.notEqual(instance.publicSessionRestored,true);
});

function modelController(ids,extra={}){
 const refs=ids.map(n=>ref(n));
 ctx.window.location.pathname=refs.at(-1).href;
 return Object.assign(Object.create(proto),{
  originProfile:'alice',originTimeline:'alice|photo',navGeneration:7,
  refs,indexes:new Map(refs.map((r,i)=>[r.key,i])),
  publicApiKeys:new Set(),publicApiAnchorFound:true,
  publicApiCursor:'C1',publicApiExhausted:false,
  publicApiLoading:false,navigationBusy:false,
  knownPhotoTotals:new Map(),imageSources:new Map(),
  updateViewerState(){},persistPublicMediaSession(){return true},
  ...extra
 });
}
contract('B0 R-033: noncontiguous repeated post in API pages is rejected',async()=>{
 const oldDoc=ctx.document.hidden;ctx.document.hidden=false;
 const ctl=modelController([600,500],{
  fetchPublicMediaPage:async c=>c==='C1'
   ?{refs:[ref(400),ref(300)],photos:[],cursor:'C2'}
   :{refs:[ref(400),ref(400,2),ref(200)],photos:[],cursor:null}
 });
 try{assert.equal(await ctl.loadPublicMediaContinuation(),false);}
 finally{ctx.document.hidden=oldDoc;}
});
contract('B0 R-026: repeated pagination cursor is not committed as success',async()=>{
 const ctl=modelController([500,400],{
  fetchPublicMediaPage:async()=>({
   refs:[390,380,370,360,350,340,330,320].map(n=>ref(n)),
   photos:[],cursor:'C1'})});
 assert.equal(await ctl.loadPublicMediaContinuation(),false);
});

contract('B0 R-032: anchor post extra photos survive continuation',async()=>{
 const first=[ref(500),ref(400)];
 const ctl=modelController([500,400],{
  publicApiAnchorFound:false,publicApiCursor:null,
  fetchPublicMediaPage:async()=>({
   refs:[...first,ref(400,2),ref(400,3),ref(300)],
   photos:[],cursor:null})
 });
 assert.equal(await ctl.loadPublicMediaContinuation(),true);
 assert.equal(ctl.indexes.has(ref(400,2).key),true);
 assert.equal(ctl.indexes.has(ref(400,3).key),true);
});
contract('B0 R-028: terminal empty page marks exhaustion',async()=>{
 const ctl=modelController([500,400],{
  fetchPublicMediaPage:async()=>({
   refs:[ref(400)],photos:[],cursor:null})});
 await ctl.loadPublicMediaContinuation();
 assert.equal(ctl.publicApiExhausted,true);
});
contract('B0 R-042: new native post is inserted at head, not appended',()=>{
 const tile=id=>{
  const badge={textContent:''};
  const link={getAttribute:n=>n==='href'?'/alice/status/'+id+'/photo/1':null,
   closest:()=>null,querySelector:()=>({})};
  return {querySelectorAll:q=>q==='a[href]'?[link]:[],
   querySelector:q=>q==='img, video'?{}:q===':scope > .xmn-tile-badge'?badge:null,
   classList:{add(){}},getAttribute(){return null}};
 };
 let tiles=[tile(400),tile(300),tile(200)];
 const orig=ctx.document.querySelector,prev=ctx.window.location.pathname;
 ctx.window.location.pathname='/alice/media';
 ctx.document.querySelector=q=>q==='main [data-testid="primaryColumn"]'
  ?{querySelectorAll:()=>tiles}:null;
 const ctl=Object.assign(Object.create(proto),{
  originProfile:'alice',refs:[],indexes:new Map(),
  imageSources:new Map(),pendingGrid:null,recordTileImageSource(){}});
 try{
  proto.scanTiles.call(ctl);
  tiles=[tile(500),...tiles];
  proto.scanTiles.call(ctl);
  assert.deepEqual(Array.from(ctl.refs,r=>r.statusId),['500','400','300','200']);
 }finally{
  ctx.document.querySelector=orig;
  ctx.window.location.pathname=prev;
 }
});
