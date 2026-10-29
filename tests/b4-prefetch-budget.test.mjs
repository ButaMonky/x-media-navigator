import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../extension/content_script.js',import.meta.url),'utf8');
const context=vm.createContext({
 URL,URLSearchParams,Map,Set,Date,console,Element:class{},
 window:{location:{pathname:'/alice/status/400/photo/1'},
  addEventListener(){},setTimeout(){return 4},clearTimeout(){}},
 document:{readyState:'loading',hidden:false,addEventListener(){}},
 navigator:{onLine:true}
});
vm.runInContext(source,context);
const proto=context.XMN.Controller.prototype;
const mediaUrl='https://pbs.twimg.com/media/VERY_LARGE?format=jpg&name=large';
function controller(){
 return Object.assign(Object.create(proto),{
  viewer:{isConnected:true},originProfile:'alice',navGeneration:4,
  navigationBusy:false,prefetched:new Map(),prefetchQueue:[mediaUrl],
  prefetchWanted:new Set([mediaUrl]),prefetchTooLarge:new Set(),
  prefetchFailed:new Set(),prefetchInFlight:0,preloadTimer:null
 });
}

test('R-040: oversized image is rejected before explicit decode starts',()=>{
 let decodes=0,released=0;
 context.Image=class{
  naturalWidth=10000;naturalHeight=10000;
  set src(value){this.value=value}
  removeAttribute(name){assert.equal(name,'src');released++}
  decode(){decodes++;return Promise.resolve()}
 };
 const ctl=controller();
 proto.drainPrefetchQueue.call(ctl);
 assert.equal(decodes,0,'400MB-like decode must never be explicitly started');
 assert.equal(ctl.prefetchTooLarge.has(mediaUrl),true);
 assert.equal(ctl.prefetched.size,0);
 assert.equal(ctl.prefetchInFlight,0);
 assert.equal(ctl.prefetchFailed.size,0);
 assert.equal(released,1,'oversized network resource should be released');
});
test('R-040: dimensions becoming known on load gate the first decode',async()=>{
 let decodes=0,lastImage;
 context.Image=class{
  constructor(){lastImage=this}
  naturalWidth=0;naturalHeight=0;
  set src(value){this.value=value}
  decode(){decodes++;return Promise.resolve()}
 };
 const ctl=controller();
 proto.drainPrefetchQueue.call(ctl);
 assert.equal(decodes,0,'metadata-unavailable image should not decode early');
 lastImage.naturalWidth=1200;lastImage.naturalHeight=900;
 lastImage.onload();
 await Promise.resolve();await Promise.resolve();
 assert.equal(decodes,1);
 assert.equal(ctl.prefetched.get(mediaUrl)?.ready,true);
 assert.equal(ctl.prefetchInFlight,0);
});
