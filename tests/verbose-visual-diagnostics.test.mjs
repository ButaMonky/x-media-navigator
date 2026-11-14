import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const bundle=readFileSync(new URL('../extension/content_script.js',import.meta.url),'utf8');
function makeContext() {
 const logs=[];
 const document={
   readyState:'loading',visibilityState:'visible',hidden:false,fullscreenElement:null,
   styleSheets:[{}],body:null,
   addEventListener(){},
   querySelector(){return null;},
   querySelectorAll(){return [];},
 };
 const window={
   location:{pathname:'/secret_visitor/status/9876543219876543219/photo/7',search:'?filter=photo&auth=PRIVATE_QUERY'},
   innerWidth:1366,innerHeight:768,devicePixelRatio:1.5,
   scrollX:0,scrollY:0,
   visualViewport:{width:1366,height:768,offsetLeft:0,offsetTop:0,scale:1},
   addEventListener(){},getComputedStyle(){throw Error('Unexpected style request')}
 };
 const context=vm.createContext({
   console:{info(...args){logs.push(args)},log(){},warn(){}},
   document,window,
   URL,URLSearchParams,Date,Set,Map,Element:class {},
 });
 vm.runInContext(bundle,context);
 return {context,logs,window,document};
}
const params={
 viewer:null,host:null,indexedRefs:3,indexedPosts:2,activeIndex:1,
 profileReady:true,gridPending:false,navigationBusy:false,prefetchInFlight:2,
 cacheEntries:4,photoTotals:0,listObserverActive:true,
 modalObserverActive:true,healthCode:'CONTROLS_LAYOUT_OK',
};
test('verbose snapshot reports detailed but nonidentifying state',()=>{
 const {context}=makeContext();
 const obj=context.XMN.collectVisualDebug(params);
 assert.equal(obj.route.route,'post');
 assert.equal(obj.route.position,7);
 assert.equal(obj.route.filter,'photo');
 assert.equal(obj.session.indexedPosts,2);
 assert.equal(obj.domCounts.xmnArrows,0);
 assert.equal(obj.browser.innerWidth,1366);
 assert.equal(obj.domCounts.modalTopLayer,0);
 const asText=JSON.stringify(obj);
 for(const secret of ['secret_visitor','9876543219876543219','PRIVATE_QUERY','?filter=photo&auth='])
   assert.ok(!asText.includes(secret),'No personal or URL fields: '+secret);
 assert.ok(asText.includes('credentials'), 'Snapshot has privacy notes');
});
test('automatic diagnostic emits one privacy-safe JSON record per throttle window',()=>{
 const {context,logs}=makeContext();
 const ctl=Object.assign(Object.create(context.XMN.Controller.prototype),{
   verboseVisualEnabled:true,verboseVisualLastAt:0,
   verboseVisualLastRoute:'',verboseVisualSnapshots:0,
   viewer:null,controlsHost:null,refs:[],originProfile:null,
   pendingGrid:null,navigationBusy:false,prefetchInFlight:0,
   prefetched:new Map(),knownPhotoTotals:new Map(),
   listObserver:null,modalObserver:null,
 });
 ctl.maybeLogVerboseVisual();
 ctl.maybeLogVerboseVisual();
 const collected=logs.filter(l=>String(l[0]).includes('visual.snapshot'));
 assert.equal(collected.length,1,'Throttle should prevent log spam');
 const snapshot=JSON.parse(collected[0][1]);
 assert.equal(snapshot.route.mediaKind,'photo');
 assert.equal(snapshot.session.healthCode,'VIEWER_NOT_FOUND');
 assert.ok(!JSON.stringify(collected).includes('secret_visitor'));
 assert.ok(!JSON.stringify(collected).includes('9876543219876543219'));
});
