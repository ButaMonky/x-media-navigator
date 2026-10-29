import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const compiled=readFileSync(new URL('../extension/content_script.js',import.meta.url),'utf8');
const location={pathname:'/alice/status/700/photo/1',search:''};
const context=vm.createContext({
 URL,URLSearchParams,Map,Set,Date,console,
 window:{location,addEventListener(){}},
 document:{readyState:'loading',hidden:false,addEventListener(){}},
 Element:class{}
});
vm.runInContext(compiled,context);
const X=context.XMN,proto=X.Controller.prototype;
const ref=id=>X.mediaRefFromHref('/alice/status/'+id+'/photo/1','alice');
const snapshot=(top,bottom,cursor)=>({
 schema:1,profile:'alice',timeline:'alice|photo',expires:Date.now()+60000,
 refs:[ref(top).href,ref(bottom).href],
 apiKeys:[ref(bottom).key],photos:[],photoTotals:[],
 cursor,anchorFound:true,exhausted:cursor===null
});
const p0=snapshot(900,800,'CURSOR_TO_PAGE_ONE');
const p1=snapshot(700,600,null);
function createController(store){
 return Object.assign(Object.create(proto),{
  originProfile:null,originTimeline:null,navGeneration:0,
  refs:[],indexes:new Map(),publicApiKeys:new Set(),imageSources:new Map(),
  imageSourcesRevision:0,knownPhotoTotals:new Map(),sessionStore:store
 });
}

test('B2 old document route is restored from a worker-committed checkpoint',async()=>{
 const oldPath=location.pathname,calls=[];
 location.pathname='/alice/status/700/photo/1';
 const ctl=createController({
  async load(profile){calls.push('current:'+profile);return p0},
  async findCheckpointForRoute(profile,href){
   calls.push('checkpoint:'+href);
   return {session:p1,page:1};
  }
 });
 try{
  await proto.restorePublicMediaSession.call(ctl);
  assert.equal(ctl.publicSessionRestored,true);
  assert.equal(ctl.originProfile,'alice');
  assert.equal(ctl.originTimeline,'alice|photo');
  assert.deepEqual(Array.from(ctl.refs,r=>r.statusId),['700','600']);
  assert.equal(ctl.indexes.get(ref(700).key),0);
  assert.equal(ctl.indexes.get(ref(600).key),1);
  assert.equal(ctl.publicApiKeys.has(ref(600).key),true);
  assert.equal(ctl.publicApiCursor,null);
  assert.equal(ctl.publicApiExhausted,true);
  assert.deepEqual(calls,['current:alice','checkpoint:/alice/status/700/photo/1']);
 }finally{location.pathname=oldPath}
});
test('B2 latest page restores without querying checkpoints unnecessarily',async()=>{
 const oldPath=location.pathname;
 location.pathname='/alice/status/900/photo/1';
 let fallbackCalls=0;
 const ctl=createController({
  async load(){return p0},
  async findCheckpointForRoute(){fallbackCalls++;return {session:p1,page:1}}
 });
 try{
  await proto.restorePublicMediaSession.call(ctl);
  assert.equal(ctl.originProfile,'alice');
  assert.equal(ctl.refs[0].statusId,'900');
  assert.equal(fallbackCalls,0);
 }finally{location.pathname=oldPath}
});
test('B2 denied or absent checkpoint does not restore an unrelated current page',async()=>{
 const oldPath=location.pathname;
 location.pathname='/alice/status/700/photo/1';
 const ctl=createController({
  async load(){return p0},
  async findCheckpointForRoute(){return null}
 });
 try{
  await proto.restorePublicMediaSession.call(ctl);
  assert.equal(ctl.originProfile,null);
  assert.equal(ctl.refs.length,0);
  assert.equal(ctl.publicSessionRestored,undefined);
 }finally{location.pathname=oldPath}
});

test('B2 route changes while worker searches: old checkpoint never overwrites new route',async()=>{
 const oldPath=location.pathname;
 location.pathname='/alice/status/700/photo/1';
 const ctl=createController({
  async load(){return p0},
  async findCheckpointForRoute(){
   location.pathname='/bob/status/999/photo/1';
   return {session:p1,page:1};
  }
 });
 try{
  await proto.restorePublicMediaSession.call(ctl);
  assert.equal(ctl.originProfile,null);
  assert.deepEqual(Array.from(ctl.refs),[]);
  assert.equal(ctl.publicSessionRestored,undefined);
 }finally{location.pathname=oldPath}
});
test('B2 session generation changes while worker searches: old snapshot is ignored',async()=>{
 const oldPath=location.pathname;
 location.pathname='/alice/status/700/photo/1';
 const ctl=createController({
  async load(){return p0},
  async findCheckpointForRoute(){
   ctl.navGeneration=1;
   return {session:p1,page:1};
  }
 });
 try{
  await proto.restorePublicMediaSession.call(ctl);
  assert.equal(ctl.originProfile,null);
  assert.equal(ctl.refs.length,0);
 }finally{location.pathname=oldPath}
});
test('B2 bare post route never asks Worker to infer its photo position',async()=>{
 const oldPath=location.pathname;
 location.pathname='/alice/status/700';
 let called=0;
 const ctl=createController({
  async load(){return p0},
  async findCheckpointForRoute(){called++;return {session:p1,page:1}}
 });
 try{
  await proto.restorePublicMediaSession.call(ctl);
  assert.equal(called,0);
  assert.equal(ctl.originProfile,null);
 }finally{location.pathname=oldPath}
});
test('B2 Worker cannot force unrelated checkpoint media into the visible route',async()=>{
 const oldPath=location.pathname;
 location.pathname='/alice/status/700/photo/1';
 const ctl=createController({
  async load(){return null},
  async findCheckpointForRoute(){return {session:p0,page:0}}
 });
 try{
  await proto.restorePublicMediaSession.call(ctl);
  assert.equal(ctl.originProfile,null);
  assert.equal(ctl.publicSessionRestored,undefined);
 }finally{location.pathname=oldPath}
});
