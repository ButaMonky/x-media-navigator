import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(
 new URL('../tools/b5-readonly-audit.js',import.meta.url),'utf8');
function run({noViewer=false,noResources=false}={}){
 let capture=null;
 const inside={left:10,top:10,width:420,height:300,right:430,bottom:310};
 const image={complete:true,naturalWidth:1280,naturalHeight:720,
  getBoundingClientRect(){return inside}};
 const button=disabled=>({disabled});
 const badge={textContent:'投稿 28 / 29+'};
 const control={querySelector(q){
  return q==='.xmn-status'?badge:q==='.xmn-prev'?
   button(false):q==='.xmn-next'?button(false):null;
 }};
 const viewer={querySelectorAll(q){return q==='img'?[image]:[]}};
 const overlay={getBoundingClientRect(){return inside}};
 const document={
  querySelector(q){
   if(q==='.xmn-controls-layer')return noViewer?null:control;
   if(q==='[data-testid="swipe-to-dismiss"]')return noViewer?null:viewer;
   return null;
  },
  querySelectorAll(q){return q==='.xmn-visual-handoff'?[overlay]:[];}
 };
 const entries=noResources?[]:[
  {name:'https://pbs.twimg.com/media/ABC123?format=jpg&name=large',
    transferSize:23000,decodedBodySize:32000,duration:20},
  {name:'https://pbs.twimg.com/media/ABC234?format=jpg&name=orig',
    transferSize:0,decodedBodySize:0,duration:42},
  {name:'https://x.com/alice/status/999/photo/1?token=S3CRET',
    transferSize:100000,decodedBodySize:100000,duration:800}
 ];
 const perf={
  getEntriesByType(name){
   assert.equal(name,'resource');
   if(noResources)throw Error('Performance API unavailable');
   return entries;
  }
 };
 const sandbox={document,performance:perf,URL,
  innerHeight:800,innerWidth:1200,
  getComputedStyle:()=>({pointerEvents:'none'}),
  console:{info(label,summary){capture={label,summary}}},
  fetch(){throw Error('Audit must not fetch')},
  localStorage:new Proxy({}, {get(){throw Error('Must not read storage')}}),
  sessionStorage:new Proxy({}, {get(){throw Error('Must not read storage')}})
 };
 const result=vm.runInNewContext(source,sandbox);
 return {result:JSON.parse(JSON.stringify(result)),
   capture:JSON.parse(JSON.stringify(capture))};
}

test('B5 manual audit reports useful aggregate numbers without URLs or secrets',()=>{
 const {result,capture}=run();
 assert.equal(result.schemaVersion,1);
 assert.equal(result.controlLayerFound,true);
 assert.equal(result.controlLayerClickThrough,true);
 assert.equal(result.parsedPostNumber,28);
 assert.equal(result.parsedLoadedPostCount,29);
 assert.equal(result.continuationIndicatorPresent,true);
 assert.equal(result.visibleDecodedImages,1);
 assert.equal(result.observedCdnMediaResources,2);
 assert.equal(result.observedCdnMediaTransfers,1);
 assert.equal(result.unknownTransferFromMissingTiming,1);
 assert.equal(result.medianCdnResourceDurationMs,42);
 assert.deepEqual(capture.summary,result);
 assert.match(capture.label,/aggregate only/);
 assert.doesNotMatch(JSON.stringify(capture),/alice|S3CRET|ABC123|ABC234|https:\/\//);
});
test('B5 manual audit remains read-only and graceful when no timing is available',()=>{
 const {result}=run({noViewer:true,noResources:true});
 assert.equal(result.viewerFound,false);
 assert.equal(result.controlLayerFound,false);
 assert.equal(result.parsedPostNumber,null);
 assert.equal(result.observedCdnMediaResources,0);
 assert.equal(result.medianCdnResourceDurationMs,null);
});
