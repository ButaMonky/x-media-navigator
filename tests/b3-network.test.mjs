import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const js=readFileSync(new URL('../extension/content_script.js',import.meta.url),'utf8');
const document={readyState:'loading',hidden:false,addEventListener(){}};
const location={pathname:'/alice/status/400/photo/1',search:''};
const context=vm.createContext({
 URL,URLSearchParams,Map,Set,Date,Error,AbortController,TextDecoder,TextEncoder,console,
 window:{location,addEventListener(){},setTimeout,clearTimeout},
 document,navigator:{onLine:true},Element:class{}
});
vm.runInContext(js,context);
const proto=context.XMN.Controller.prototype;
const ref=n=>context.XMN.mediaRefFromHref('/alice/status/'+n+'/photo/1','alice');
const make=()=>Object.assign(Object.create(proto),{
 originProfile:'alice',originTimeline:'alice|photo',
 refs:[ref(500),ref(400)],indexes:new Map(),
 publicApiAbort:null,publicApiRetryAt:0,publicApiFailures:0,
 publicApiExhausted:false,publicApiLoading:false,
 prefetchQueue:[],prefetchWanted:new Set(),prefetched:new Map(),
 preloadTimer:null,handoff:null,pendingBoundary:null
});

test('B3 tab hide aborts an in-flight FxEmbed fetch instead of wasting transfer',async()=>{
 const ctl=make();let observedSignal=null;
 context.fetch=(_url,opts)=>{
  observedSignal=opts.signal;
  return new Promise((resolve,reject)=>{
   opts.signal.addEventListener('abort',()=>{
    const error=new Error('cancelled');error.name='AbortError';reject(error);
   },{once:true});
  });
 };
 document.hidden=false;
 try{
  const loading=proto.fetchPublicMediaPage.call(ctl,null);
  assert.ok(observedSignal);
  document.hidden=true;
  proto.onVisibilityChange.call(ctl);
  assert.equal(observedSignal.aborted,true);
  assert.equal(await loading,null);
  assert.equal(ctl.publicApiAbort,null);
  assert.equal(ctl.pendingBoundary,null);
 }finally{document.hidden=false;delete context.fetch;}
});
test('B3 429 throttles subsequent user presses and does not retry immediately',async()=>{
 const ctl=make();let calls=0;
 context.fetch=async()=>{calls++;return {ok:false,status:429,headers:{
  get:key=>key==='retry-after'?'3':null}}};
 try{
  assert.equal(await proto.fetchPublicMediaPage.call(ctl,null),null);
  assert.equal(calls,1);
  assert.ok(ctl.publicApiRetryAt>Date.now()+2400);
  assert.equal(await proto.loadPublicMediaContinuation.call(ctl,true),false);
  assert.equal(calls,1,'no repeated API traffic during cooldown');
 }finally{delete context.fetch;}
});

test('B3 streamed FxEmbed response aborts at 4MB, not after full download',async()=>{
 let reads=0,cancels=0,releases=0,usedTextFallback=false;
 const reader={
  async read(){reads++;return {done:false,value:new Uint8Array(3_000_000)}},
  async cancel(){cancels++},releaseLock(){releases++}
 };
 const response={body:{getReader:()=>reader},
  async text(){usedTextFallback=true;throw Error('no unbounded text allowed')}};
 const ctl=make();
 assert.equal(await proto.readBoundedPublicBody.call(ctl,response),null);
 assert.equal(reads,2,'stop once two chunks cross 4MB');
 assert.equal(cancels,1);
 assert.equal(releases,1);
 assert.equal(usedTextFallback,false);
});
test('B3 correctly reassembles bounded UTF-8 streamed JSON',async()=>{
 const encoder=new TextEncoder();
 const value='{"code":200,"label":"小さなJSON"}';
 const raw=encoder.encode(value);
 let position=0;
 const reader={
  async read(){
   if(position>=raw.length)return {done:true};
   const next=raw.subarray(position,Math.min(position+3,raw.length));
   position+=next.length;return {done:false,value:next};
  },releaseLock(){}
 };
 const ctl=make();
 assert.equal(await proto.readBoundedPublicBody.call(ctl,{
  body:{getReader:()=>reader}}),value);
});

test('B3 malformed successful HTTP payload causes a bounded cooldown',async()=>{
 const ctl=make();let calls=0;
 context.fetch=async()=>{
  calls++;
  return {ok:true,status:200,headers:{get:()=>null},body:null,
   async text(){return JSON.stringify({code:200,results:[],cursor:{}})}};
 };
 try{
  assert.equal(await proto.fetchPublicMediaPage.call(ctl,null),null);
  assert.equal(calls,1);
  assert.ok(ctl.publicApiRetryAt>Date.now()+1000,'invalid data must not hammer provider');
  assert.equal(await proto.loadPublicMediaContinuation.call(ctl,true),false);
  assert.equal(calls,1,'cooldown stops repeated query');
 }finally{delete context.fetch;}
});
test('B3 nonadvancing pagination cursor imposes backoff',async()=>{
 const ctl=Object.assign(make(),{
  navGeneration:4,publicApiCursor:'STUCK',publicApiAnchorFound:true,
  indexes:new Map(),publicApiKeys:new Set(),imageSources:new Map(),
  knownPhotoTotals:new Map(),updateViewerState(){},
  fetchPublicMediaPage:async()=>({
   refs:[ref(300),ref(200)],photos:[],cursor:'STUCK'
  })
 });
 document.hidden=false;location.pathname='/alice/status/400/photo/1';
 assert.equal(await proto.loadPublicMediaContinuation.call(ctl,true),false);
 assert.ok(ctl.publicApiRetryAt>Date.now());
});

test('B3 unstreamed third-party response enforces UTF-8 bytes, not UTF-16 characters',async()=>{
 const ctl=make();
 const payload='日本語'.repeat(480_000);
 assert.ok(payload.length<4_000_000);
 assert.ok(new TextEncoder().encode(payload).byteLength>4_000_000);
 assert.equal(await proto.readBoundedPublicBody.call(ctl,{
   body:null,async text(){return payload}
 }),null,'multi-byte UTF-8 must not bypass wire-body limit');
});
test('B3 unstreamed response accepts exactly the 4MB boundary, rejects one over',async()=>{
 const ctl=make();
 for(const [amount,accepted] of [
   [4_000_000,true],[4_000_001,false]
 ]){
   const message='a'.repeat(amount);
   const result=await proto.readBoundedPublicBody.call(ctl,{
     body:null,async text(){return message}
   });
   assert.equal(result===message,accepted,'ascii '+amount);
 }
});
test('B3 unstreamed multi-byte response within 4MB still decodes',async()=>{
 const ctl=make();
 const message='☀️'.repeat(400_000);
 assert.ok(new TextEncoder().encode(message).byteLength<4_000_000);
 assert.equal(await proto.readBoundedPublicBody.call(ctl,{
   body:null,async text(){return message}
 }),message);
});

test('B3 compatibility path counts emoji pairs as four UTF-8 bytes',async()=>{
 const ctl=make();
 const exact='😀'.repeat(1_000_000);
 const over=exact+'😀';
 const read=text=>proto.readBoundedPublicBody.call(ctl,{
  body:null,async text(){return text}
 });
 assert.equal(await read(exact),exact,'exactly 4MB is permitted');
 assert.equal(await read(over),null,'4MB plus one emoji must be refused');
});
test('B3 invalid UTF-16 surrogate is budgeted as replacement UTF-8',async()=>{
 const ctl=make();
 const exact='x'.repeat(3_999_997)+'\uD800';
 const tooLong=exact+'x';
 const read=text=>proto.readBoundedPublicBody.call(ctl,{
  body:null,async text(){return text}
 });
 assert.equal(await read(exact),exact);
 assert.equal(await read(tooLong),null);
});
