import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const js=readFileSync(new URL('../extension/content_script.js',import.meta.url),'utf8');
const location={pathname:'/alice/status/500/photo/1',search:''};
const context=vm.createContext({
 URL,URLSearchParams,Set,Map,Date,console,
 window:{location,addEventListener(){},setTimeout,clearTimeout},
 document:{readyState:'loading',hidden:false,addEventListener(){}},
 navigator:{onLine:true},Element:class{}
});
vm.runInContext(js,context);
const proto=context.XMN.Controller.prototype;
const ref=n=>context.XMN.mediaRefFromHref(
 '/alice/status/'+n+'/photo/1','alice');
const cdn=n=>'https://pbs.twimg.com/media/IMAGE'+n+'?format=jpg&name=large';

test('R-014: shared image URL memory stays bounded for 175 FxEmbed photos',async()=>{
 const native=ref(500);
 const apiRefs=Array.from({length:175},(_,i)=>ref(499-i));
 const photos=apiRefs.map((r,i)=>[r.key,cdn(i)]);
 const controller=Object.assign(Object.create(proto),{
  originProfile:'alice',originTimeline:'alice|photo',navGeneration:7,
  refs:[native],indexes:new Map([[native.key,0]]),
  publicApiKeys:new Set(),publicApiAnchorFound:true,publicApiCursor:'OLD',
  publicApiExhausted:false,publicApiLoading:false,navigationBusy:false,
  imageSources:new Map(),imageSourcesRevision:0,knownPhotoTotals:new Map(),
  updateViewerState(){},persistPublicMediaSession:async()=>true,
  fetchPublicMediaPage:async()=>({refs:apiRefs,photos,cursor:null})
 });
 const success=await proto.loadPublicMediaContinuation.call(controller);
 assert.equal(success,true);
 assert.equal(controller.refs.length,176);
 assert.equal(controller.imageSources.size,128);
 assert.equal(controller.imageSources.has(apiRefs[0].key),false);
 assert.equal(controller.imageSources.get(apiRefs.at(-1).key),cdn(174));
 assert.equal(controller.imageSourcesRevision,175);
});

test('R-014: cached URLs retain deduplication, revision and eviction order',()=>{
 const ctrl=Object.assign(Object.create(proto),{
  imageSources:new Map(),imageSourcesRevision:0
 });
 for(let i=0;i<128;i++)ctrl.rememberImageSource('K'+i,cdn(i));
 assert.equal(ctrl.imageSources.size,128);
 ctrl.rememberImageSource('K12',cdn(12));
 assert.equal(ctrl.imageSourcesRevision,128,'same URL does not churn revision');
 ctrl.rememberImageSource('K128',cdn(128));
 assert.equal(ctrl.imageSources.size,128);
 assert.equal(ctrl.imageSources.has('K0'),false);
 assert.equal(ctrl.imageSources.has('K127'),true);
 assert.equal(ctrl.imageSources.has('K128'),true);
 ctrl.rememberImageSource('OTHER','https://evil.example/image.jpg');
 assert.equal(ctrl.imageSources.size,128,'foreign URLs cannot enter cache');
 assert.equal(ctrl.imageSourcesRevision,129);
});

test('R-014: failed storage rolls back evicted native image URLs too',async()=>{
 const native=ref(500);
 const urls=new Map(Array.from({length:128},(_,i)=>[
  'native-'+i,cdn('N'+i)
 ]));
 const older=Array.from({length:175},(_,i)=>ref(499-i));
 const ctl=Object.assign(Object.create(proto),{
  originProfile:'alice',originTimeline:'alice|photo',navGeneration:4,
  refs:[native],indexes:new Map([[native.key,0]]),
  publicApiKeys:new Set(),publicApiAnchorFound:true,publicApiCursor:'OLD',
  publicApiExhausted:false,publicApiLoading:false,navigationBusy:false,
  imageSources:new Map(urls),imageSourcesRevision:7,
  knownPhotoTotals:new Map(),updateViewerState(){},
  persistPublicMediaSession:async()=>false,
  fetchPublicMediaPage:async()=>({refs:older,photos:older.map((r,i)=>[r.key,cdn(i)]),cursor:null})
 });
 assert.equal(await ctl.loadPublicMediaContinuation(),false);
 assert.deepEqual(Array.from(ctl.imageSources),Array.from(urls));
 assert.equal(ctl.imageSourcesRevision,7);
 assert.equal(ctl.refs.length,1);
 assert.equal(ctl.publicApiCursor,'OLD');
});

test('B2: route change during asynchronous storage never edits the new session',async()=>{
 const native=ref(500),older=ref(400);
 const nextProfile=context.XMN.mediaRefFromHref('/bob/status/900/photo/1','bob');
 const ctl=Object.assign(Object.create(proto),{
  originProfile:'alice',originTimeline:'alice|photo',navGeneration:10,
  refs:[native],indexes:new Map([[native.key,0]]),
  publicApiKeys:new Set(),publicApiAnchorFound:true,
  publicApiCursor:'ALICE',publicApiExhausted:false,publicApiLoading:false,
  navigationBusy:false,imageSources:new Map(),imageSourcesRevision:0,
  knownPhotoTotals:new Map(),updateViewerState(){},
  async persistPublicMediaSession(){
   this.navGeneration++;
   this.originProfile='bob';
   this.originTimeline='bob|photo';
   this.refs=[nextProfile];
   this.indexes=new Map([[nextProfile.key,0]]);
   this.publicApiCursor='BOB';
   this.imageSources=new Map([['bob-key',cdn('BOB')]]);
   return true;
  },
  fetchPublicMediaPage:async()=>({refs:[older],photos:[],cursor:null})
 });
 const success=await ctl.loadPublicMediaContinuation();
 assert.equal(success,false);
 assert.equal(ctl.originProfile,'bob');
 assert.deepEqual(ctl.refs.map(r=>r.key),[nextProfile.key]);
 assert.equal(ctl.publicApiCursor,'BOB');
 assert.equal(ctl.imageSources.get('bob-key'),cdn('BOB'));
});
