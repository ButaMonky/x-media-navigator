import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../extension/content_script.js',import.meta.url),'utf8');
const location={pathname:'/alice/status/400/photo/1',search:''};
const context=vm.createContext({
 URL,URLSearchParams,Map,Set,Date,console,Element:class{},
 window:{location,addEventListener(){},setTimeout,clearTimeout},
 document:{readyState:'loading',hidden:false,addEventListener(){}},
 navigator:{onLine:true,deviceMemory:8,connection:{saveData:false,effectiveType:'4g'}}
});
vm.runInContext(source,context);
const X=context.XMN;
const proto=X.Controller.prototype;
const ref=(id,index=1)=>X.mediaRefFromHref(
 '/alice/status/'+id+'/photo/'+index,'alice');
const posts=Array.from({length:6000},(_,i)=>({
 id:String(20000-i),
 refs:Array.from({length:i%4+1},(_,n)=>ref(20000-i,n+1))
}));
const all=posts.flatMap(x=>x.refs);
const idx=all.findIndex(x=>x.statusId===posts[3001].id && x.mediaIndex===2);

function controller(refs=all){
 const ctl=Object.assign(Object.create(proto),{
  originProfile:'alice',originTimeline:'alice|photo',
  refs,indexes:new Map(refs.map((x,i)=>[x.key,i])),
  viewer:{isConnected:true},navGeneration:4,navigationBusy:false,
  imageSources:new Map(),prefetchQueue:[],prefetchWanted:new Set(),
  prefetched:new Map(),prefetchFailed:new Set(),prefetchTooLarge:new Set(),
  prefetchInFlight:0,handoff:null,prefetchFailurePath:'',
  drainPrefetchQueue(){this.drained=(this.drained||0)+1}
 });
 return ctl;
}
test('B2 runtime: 6000 groups yield a complete 450-media local window',()=>{
 const ctl=controller();
 const first=ctl.verifiedPostWindow(idx);
 assert.ok(first);
 assert.ok(first.mediaRefs<=450);
 assert.ok(first.posts.length>=1);
 assert.ok(first.posts[first.activePost].refs.some(r=>r.key===all[idx].key));
 const cached=ctl.postWindowCache.model;
 for(let n=0;n<100;n++){
  const next=ctl.verifiedPostWindow(idx);
  assert.equal(next?.posts[next.activePost].statusId,all[idx].statusId);
  assert.equal(ctl.postWindowCache.model,cached);
 }
 assert.equal(ctl.refs.length,all.length,'full indexed history is not discarded');
});
test('B2 runtime: native head addition invalidates the window without moving active post',()=>{
 const ctl=controller();
 const initial=ctl.verifiedPostWindow(idx);
 assert.ok(initial);
 const priorModel=ctl.postWindowCache.model;
 const activeKey=all[idx].key;
 const incoming=[ref(21000),ref(20999)];
 ctl.refs.unshift(...incoming);
 ctl.indexes=new Map(ctl.refs.map((x,i)=>[x.key,i]));
 const active=ctl.indexes.get(activeKey);
 const win=ctl.verifiedPostWindow(active);
 assert.ok(win);
 assert.notEqual(ctl.postWindowCache.model,priorModel);
 assert.ok(win.posts[win.activePost].refs.some(r=>r.key===activeKey));
 assert.ok(win.mediaRefs<=450);
});

test('B2 runtime: long timeline prefetch only reads verified nearby groups',()=>{
 const ctl=controller();
 location.pathname=all[idx].href;
 for(let j=idx;j<idx+16;j++){
  const media=all[j];
  ctl.imageSources.set(media.key,
   'https://pbs.twimg.com/media/KNOWN'+j+'?format=jpg&name=large');
 }
 ctl.activeIndex=()=>idx;
 try{
  ctl.preloadAdjacentImages();
  assert.ok(ctl.postWindowCache?.model);
  const window=ctl.verifiedPostWindow(idx);
  const allowed=new Set(window.posts.flatMap(g=>g.refs.map(x=>x.key)));
  const urls=new Set([...ctl.imageSources].filter(([key])=>
   allowed.has(key)).map(([,value])=>value));
  assert.ok(ctl.prefetchWanted.size<=5);
  for(const url of ctl.prefetchWanted)assert.ok(urls.has(url));
  assert.equal(ctl.drained,1,'existing prefetch engine remains the owner');
 }finally{location.pathname='/alice/status/400/photo/1'}
});
test('B2 runtime: untrusted out-of-order groups do not become a window',()=>{
 const leading=Array.from({length:451},(_,i)=>ref(10000-i));
 const x=[...leading,ref(500),ref(400),ref(500,2),ref(300)];
 const ctl=controller(x);
 assert.equal(ctl.verifiedPostWindow(452),null);
 assert.equal(ctl.postWindowCache.model,null);
 location.pathname=x[452].href;
 ctl.activeIndex=()=>452;
 try{
  ctl.preloadAdjacentImages();
  assert.equal(ctl.drained,undefined);
  assert.equal(ctl.prefetchWanted.size,0);
 }finally{location.pathname='/alice/status/400/photo/1'}
});

test('B2 runtime: leaving the 450-ref neighbourhood rebuilds only that window',()=>{
 const ctl=controller();
 const oldWindow=ctl.verifiedPostWindow(idx);
 const firstModel=ctl.postWindowCache.model;
 const distant=idx+950;
 const nextWindow=ctl.verifiedPostWindow(distant);
 assert.ok(nextWindow);
 assert.notEqual(ctl.postWindowCache.model,firstModel);
 assert.ok(nextWindow.mediaRefs<=450);
 assert.ok(nextWindow.posts[nextWindow.activePost].refs.some(r=>r.key===all[distant].key));
 assert.equal(ctl.refs.length,all.length);
 const secondModel=ctl.postWindowCache.model;
 assert.ok(ctl.verifiedPostWindow(distant+3));
 assert.equal(ctl.postWindowCache.model,secondModel);
});

test('B2 runtime: short native timeline retains original prefetch behavior',()=>{
 const short=[ref(500),ref(400),ref(300)];
 const ctl=controller(short);
 location.pathname=short[0].href;
 ctl.activeIndex=()=>0;
 ctl.imageSources.set(short[1].key,'https://pbs.twimg.com/media/SMALL1?format=jpg&name=large');
 try{
  ctl.preloadAdjacentImages();
  assert.equal(ctl.postWindowCache,undefined,'small lists do not allocate another index');
  assert.equal(ctl.drained,1,'existing lightweight fetch path is preserved');
  assert.equal(ctl.prefetchWanted.size,1);
 }finally{location.pathname='/alice/status/400/photo/1'}
});
test('B2 runtime: a 450-reference index does not require a window model',()=>{
 const refs=Array.from({length:450},(_,i)=>ref(10000-i));
 const ctl=controller(refs);
 ctl.activeIndex=()=>200;
 location.pathname=refs[200].href;
 try{
  ctl.preloadAdjacentImages();
  assert.equal(ctl.postWindowCache,undefined);
  assert.equal(ctl.drained,1);
 }finally{location.pathname='/alice/status/400/photo/1'}
});
