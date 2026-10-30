import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const script=readFileSync(new URL('../extension/content_script.js',import.meta.url),'utf8');
const current={pathname:'/alice/status/300/photo/1',search:''};
const document={readyState:'loading',hidden:false,addEventListener(){}};
const c=vm.createContext({URL,URLSearchParams,Map,Set,Date,console,document,
 window:{location:current,addEventListener(){},setTimeout,clearTimeout},
 navigator:{onLine:true},Element:class {}});
vm.runInContext(script,c);
const X=c.XMN;
const href=id=>'/alice/status/'+id+'/photo/1';
const ref=id=>X.mediaRefFromHref(href(id),'alice');
const sourceUrl=id=>'https://pbs.twimg.com/media/ABC'+id+'?format=jpg&name=large';
const expiry=Date.now()+60000;
const source={
 schema:1,profile:'alice',timeline:'alice|photo',expires:expiry,
 refs:[href(400),href(300)],apiKeys:['300:photo:1'],
 photos:[['300:photo:1',sourceUrl(300)]],photoTotals:[['300',1]],
 cursor:'CURSOR-1',anchorFound:true,exhausted:false
};
const incoming=[ref(200),ref(100)];
const photos=new Map(incoming.map(r=>[r.key,sourceUrl(r.statusId)]));
const plain=x=>JSON.parse(JSON.stringify(x));
const makeNext=()=>X.preparePublicContinuationPage(
 'alice','alice|photo',incoming,photos,'CURSOR-2',expiry);

test('B2 provider snapshot has complete whole-post refs and immutable cursor',()=>{
 const page=makeNext();
 assert.ok(page);
 assert.deepEqual(plain(page.refs),[href(200),href(100)]);
 assert.deepEqual(plain(page.photoTotals),[['200',1],['100',1]]);
 assert.deepEqual(plain(page.apiKeys),['200:photo:1','100:photo:1']);
 assert.equal(page.cursor,'CURSOR-2');
 assert.equal(page.expires,source.expires);
});
test('B2 snapshot rejects album holes, duplicate photos and unknown image sources',()=>{
 const two=X.mediaRefFromHref('/alice/status/200/photo/2','alice');
 assert.equal(X.preparePublicContinuationPage(
  'alice','alice|photo',[two],new Map([[two.key,sourceUrl(200)]]),
  null,expiry),null);
 assert.equal(X.preparePublicContinuationPage(
  'alice','alice|photo',[incoming[0],incoming[0]],photos,
  null,expiry),null);
 assert.equal(X.preparePublicContinuationPage(
  'alice','alice|photo',incoming,new Map(),null,expiry),null);
 const wrong=[ref(100),ref(200)];
 assert.equal(X.preparePublicContinuationPage(
  'alice','alice|photo',wrong,photos,null,expiry),null);
});
test('B2 manifest links source cursor to page1 and preserves active page',()=>{
 const next=makeNext();
 const manifest=X.createPublicContinuationManifest(source,next,null);
 assert.equal(manifest?.activePage,0);
 assert.equal(manifest?.pages.length,2);
 assert.equal(manifest?.pages[1].incomingCursor,'CURSOR-1');
 assert.equal(manifest?.pages[1].outgoingCursor,'CURSOR-2');
 const again=X.createPublicContinuationManifest(next,
  X.preparePublicContinuationPage('alice','alice|photo',
   [ref(50)],new Map([[ref(50).key,sourceUrl(50)]]),
   null,expiry),{...manifest,activePage:1});
 assert.equal(again?.pages.length,3);
 assert.equal(again?.pages[2].outgoingCursor,null);
 assert.equal(again?.activePage,1);
});
test('B2 rejects wrong origin cursor, overlapping post and non-last-page extension',()=>{
 const next=makeNext(),m=X.createPublicContinuationManifest(source,next,null);
 assert.equal(X.createPublicContinuationManifest({...source,cursor:null},next,null),null);
 assert.equal(X.createPublicContinuationManifest(source,
  {...next,refs:[href(300),href(200)]},null),null);
 assert.equal(X.createPublicContinuationManifest(next,next,
  {...m,activePage:0}),null);
 assert.equal(X.createPublicContinuationManifest(source,
  {...next,timeline:'bob|photo'},null),null);
});
function controller(store){
 const refs=[ref(400),ref(300)];
 return Object.assign(Object.create(X.Controller.prototype),{
  originProfile:'alice',originTimeline:'alice|photo',
  refs,indexes:new Map(refs.map((r,i)=>[r.key,i])),
  publicApiKeys:new Set(source.apiKeys),publicApiCursor:'CURSOR-1',
  publicApiAnchorFound:true,publicApiExhausted:false,
  publicSessionRestored:false,restoredCheckpointPage:null,
  viewerStateSnapshot:null,sessionStore:store
 });
}
test('B2 archived complete page is published only after two snapshots',async()=>{
 const writes=[],store={
  async load(){return plain(source)},
  async saveCheckpoint(index,data){writes.push(['page',index,plain(data)]);return true},
  async savePageManifest(data){writes.push(['manifest',plain(data)]);return true}
 };
 const ctl=controller(store),initial=ctl.refs;
 const committed=await X.Controller.prototype.archivePublicContinuation.call(
  ctl,incoming,photos,'CURSOR-2',null,()=>true);
 assert.equal(committed,true);
 assert.deepEqual(writes.map(x=>x[0]),['page','page','manifest']);
 assert.deepEqual(writes.slice(0,2).map(x=>x[1]),[0,1]);
 assert.equal(writes[2][1].activePage,0);
 assert.equal(ctl.refs,initial);
 assert.equal(ctl.publicApiCursor,'CURSOR-1');
 assert.equal(ctl.publicSessionRestored,true);
 assert.equal(ctl.restoredCheckpointPage,0);
});
test('B2 rejects unsafe last native album before writing checkpoints',async()=>{
 const writes=[],store={
  async load(){return {...source,photoTotals:[]}},
  async saveCheckpoint(){writes.push('page');return true},
  async savePageManifest(){writes.push('manifest');return true}
 };
 const ctl=controller(store);
 assert.equal(await X.Controller.prototype.archivePublicContinuation.call(
  ctl,incoming,photos,'CURSOR-2',null,()=>true),false);
 assert.deepEqual(writes,[]);
});
test('B2 aborted manifest write cannot advertise new page or mutate current index',async()=>{
 const writes=[],store={
  async load(){return plain(source)},
  async saveCheckpoint(index){writes.push('page'+index);return true},
  async savePageManifest(){writes.push('rejected');return false}
 };
 const ctl=controller(store),previous=ctl.refs.map(r=>r.key);
 assert.equal(await X.Controller.prototype.archivePublicContinuation.call(
  ctl,incoming,photos,'CURSOR-2',null,()=>true),false);
 assert.deepEqual(writes,['page0','page1','rejected']);
 assert.deepEqual(ctl.refs.map(r=>r.key),previous);
 assert.equal(ctl.publicSessionRestored,false);
});
test('B2 hidden tab during archive aborts before manifest publication',async()=>{
 let unhide,resolve;let valid=true;
 const block=new Promise(r=>{resolve=r});
 const writes=[],store={
  async load(){return plain(source)},
  async saveCheckpoint(index){
   writes.push('page'+index);
   if(index===0)await block;
   return true;
  },
  async savePageManifest(){writes.push('manifest');return true}
 };
 const ctl=controller(store);
 const task=X.Controller.prototype.archivePublicContinuation.call(
   ctl,incoming,photos,'CURSOR-2',null,()=>valid);
 await new Promise(r=>setTimeout(r,0));
 valid=false;resolve();
 assert.equal(await task,false);
 assert.deepEqual(writes,['page0']);
 assert.equal(ctl.publicSessionRestored,false);
});


function currentPage(ids,cursor='CURSOR-START'){
 const refs=ids.map(href);
 const keys=ids.map(id=>id+':photo:1');
 return {schema:1,profile:'alice',timeline:'alice|photo',
   expires:Date.now()+60000,refs,apiKeys:keys,
   photos:ids.map(id=>[id+':photo:1',sourceUrl(id)]),
   photoTotals:ids.slice(-128).map(id=>[String(id),1]),
   cursor,anchorFound:true,exhausted:false};
}
function continuationCtl(snap,nextRefs,store,nextCursor='CURSOR-NEXT'){
 const refs=snap.refs.map(h=>X.mediaRefFromHref(h,'alice'));
 const ctl=Object.assign(Object.create(X.Controller.prototype),{
   originProfile:'alice',originTimeline:'alice|photo',navGeneration:8,
   refs,indexes:new Map(refs.map((r,i)=>[r.key,i])),
   publicApiKeys:new Set(snap.apiKeys),publicApiCursor:snap.cursor,
   publicApiAnchorFound:true,publicApiExhausted:false,
   publicApiLoading:false,publicApiRetryAt:0,publicSessionRestored:false,
   restoredCheckpointPage:null,sessionStore:store,
   imageSources:new Map(),knownPhotoTotals:new Map(snap.photoTotals),
   imageSourcesRevision:0,viewerStateSnapshot:null,
   updateViewerState(){},toast(){},
   fetchPublicMediaPage:async()=>({refs:nextRefs,
      photos:nextRefs.map(r=>[r.key,sourceUrl(r.statusId)]),
      cursor:nextCursor})
 });
 return ctl;
}
test('B2 X continuation rolls over 440+20 whole references without index loss',async()=>{
 document.hidden=false;current.pathname='/alice/status/561/photo/1';
 const snap=currentPage(Array.from({length:440},(_,i)=>1000-i));
 const next=Array.from({length:20},(_,i)=>ref(560-i));
 const writes=[],store={
  async load(){return snap},
  async loadPageManifest(){return null},
  async saveCheckpoint(index,data){writes.push(['page',index,data]);return true},
  async savePageManifest(data){writes.push(['manifest',data]);return true}
 };
 const ctl=continuationCtl(snap,next,store);
 const before=ctl.refs.map(r=>r.key);
 assert.equal(await X.Controller.prototype.loadPublicMediaContinuation.call(
  ctl,true),true);
 assert.deepEqual(ctl.refs.map(r=>r.key),before);
 assert.deepEqual(writes.map(([kind])=>kind),['page','page','manifest']);
 assert.equal(writes[1][2].refs.length,20);
 assert.equal(writes[2][1].pages.length,2);
 assert.equal(writes[2][1].activePage,0);
 assert.equal(ctl.publicSessionRestored,true);
});
test('B2 committed short page extends only by a new immutable page',async()=>{
 document.hidden=false;current.pathname='/alice/status/600/photo/1';
 const snap=currentPage([700,600],'SECOND-CURSOR');
 const earlier=currentPage([900,800],'FIRST-CURSOR');
 earlier.expires=snap.expires;
 const base=X.createPublicContinuationManifest(earlier,snap,null);
 assert.ok(base);
 base.activePage=1;
 const newRefs=[ref(500),ref(400)],writes=[],store={
  async load(){return snap},
  async loadPageManifest(){return base},
  async saveCheckpoint(page,data){writes.push(['page',page,data]);return true},
  async savePageManifest(data){writes.push(['manifest',data]);return true}
 };
 const ctl=continuationCtl(snap,newRefs,store,null);
 ctl.restoredCheckpointPage=1;ctl.publicSessionRestored=true;
 assert.equal(await X.Controller.prototype.loadPublicMediaContinuation.call(
  ctl,true),true);
 assert.deepEqual(writes.map(v=>v[0]),['page','manifest']);
 assert.equal(writes[0][1],2);
 assert.equal(writes[1][1].pages.length,3);
 assert.equal(writes[1][1].activePage,1);
 assert.equal(ctl.refs.length,2);
});
test('B2 fails closed if saved source cursor is no longer current',async()=>{
 document.hidden=false;current.pathname='/alice/status/300/photo/1';
 const snap=currentPage([400,300],'CURSOR-A');
 const other={...snap,cursor:'FOREIGN'};
 const writes=[],store={
  async load(){return other},
  async loadPageManifest(){return null},
  async saveCheckpoint(){writes.push('page');return true},
  async savePageManifest(){writes.push('manifest');return true}
 };
 const ctl=continuationCtl(snap,[ref(200),ref(100)],store,null);
 ctl.archivePublicContinuation=X.Controller.prototype.archivePublicContinuation;
 const result=await X.Controller.prototype.archivePublicContinuation.call(
  ctl,[ref(200),ref(100)],photos,null,null,()=>true);
 assert.equal(result,false);
 assert.deepEqual(writes,[]);
});


test('B2 450-ref boundary commits a second page without evicting the current album',async()=>{
 const path=current.pathname,hidden=document.hidden;
 document.hidden=false;
 const native=Array.from({length:450},(_,i)=>ref(900-i));
 const atEnd=native[native.length-1];
 current.pathname=atEnd.href;
 const existing={...source,refs:native.map(r=>r.href),
  apiKeys:native.map(r=>r.key),
  photos:[],photoTotals:[['451',1]],cursor:'CURSOR-1'};
 const saved=[],store={
  async load(){return plain(existing)},
  async loadPageManifest(){return null},
  async saveCheckpoint(index,page){saved.push(['page',index,plain(page)]);return true},
  async savePageManifest(m){saved.push(['manifest',plain(m)]);return true}
 };
 const ctl=controller(store);
 ctl.refs=native;
 ctl.indexes=new Map(native.map((r,i)=>[r.key,i]));
 ctl.publicApiKeys=new Set(existing.apiKeys);
 ctl.knownPhotoTotals=new Map([['451',1]]);
 ctl.navGeneration=4;
 ctl.publicApiLoading=false;
 ctl.publicApiExhausted=false;
 ctl.publicApiRetryAt=0;
 ctl.imageSources=new Map();
 ctl.imageSourcesRevision=0;
 ctl.publicApiFailures=0;
 ctl.publicApiAnchorFound=true;
 ctl.publicApiCursor='CURSOR-1';
 ctl.originTimeline='alice|photo';
 ctl.navigationBusy=false;
 ctl.updateViewerState=()=>{};
 const batch=Array.from({length:10},(_,i)=>ref(450-i));
 const batchPhotos=new Map(batch.map(r=>[r.key,sourceUrl(r.statusId)]));
 ctl.fetchPublicMediaPage=async()=>({
  refs:batch,photos:[...batchPhotos],cursor:'CURSOR-2'
 });
 const previous=native.map(r=>r.key);
 try{
  assert.equal(await X.Controller.prototype.loadPublicMediaContinuation.call(ctl,true),true);
  assert.deepEqual(ctl.refs.map(r=>r.key),previous,
   'all 450 existing media refs remain stable until actual navigation');
  assert.equal(ctl.publicApiCursor,'CURSOR-1');
  assert.equal(ctl.restoredCheckpointPage,0);
  assert.equal(ctl.publicSessionRestored,true);
  assert.deepEqual(saved.map(x=>x[0]),['page','page','manifest']);
  assert.equal(saved[2][1].pages[0].mediaCount,450);
  assert.equal(saved[2][1].pages[1].mediaCount,10);
  assert.equal(saved[2][1].pages[1].incomingCursor,'CURSOR-1');
  assert.equal(ctl.navigationBusy,false);
 }finally{current.pathname=path;document.hidden=hidden;}
});
test('B2 committed boundary yields exact adjacent X route, never guesses next ID',async()=>{
 const before=current.pathname,original=current.assign;
 const calls=[];
 current.pathname='/alice/status/451/photo/1';
 current.assign=url=>calls.push(url);
 const refs=[ref(900),ref(451)];
 const ctl=Object.assign(Object.create(X.Controller.prototype),{
   experimentalThirdPartyApiEnabled:true, // historical committed page navigation
  originProfile:'alice',originTimeline:'alice|photo',
  refs,indexes:new Map(refs.map((r,i)=>[r.key,i])),
  viewer:{isConnected:true},navigationBusy:false,navGeneration:4,
  publicSessionRestored:true,restoredCheckpointPage:0,
  sessionStore:{async findAdjacentCheckpoint(){return {
    href:'/alice/status/450/photo/1',page:1};}},
  activeIndex(){return 1},updateViewerState(){},toast(m){throw Error(m)}
 });
 try{
  await X.Controller.prototype.navigate.call(ctl,1);
  assert.deepEqual(calls,['/alice/status/450/photo/1']);
  assert.equal(ctl.pendingDocumentHandoff.target,calls[0]);
 }finally{current.pathname=before;
  if(original===undefined)delete current.assign;else current.assign=original;}
});

test('B2 re-fetching a previously committed neighbor must not mark current page terminal',async()=>{
 const before=current.pathname,hidden=document.hidden;
 current.pathname='/alice/status/300/photo/1';
 document.hidden=false;
 const ctl=controller({
  async loadPageManifest(){return {activePage:0,pages:[{},{}]}},
 });
 Object.assign(ctl,{
  publicApiLoading:false,publicApiExhausted:false,publicApiRetryAt:0,
  updateViewerState(){},fetchPublicMediaPage:async()=>({
   refs:[ref(300)],photos:[],cursor:null
  })
 });
 try{
  assert.equal(await X.Controller.prototype.loadPublicMediaContinuation.call(ctl,true),false);
  assert.equal(ctl.publicApiCursor,'CURSOR-1');
  assert.equal(ctl.publicApiExhausted,false,
   'an already committed older page is not evidence of global exhaustion');
  assert.deepEqual(ctl.refs.map(x=>x.key),[ref(400).key,ref(300).key]);
 }finally{current.pathname=before;document.hidden=hidden}
});

test('B2 when 64 checkpoint pages are full, repeated arrows cannot hammer FxEmbed',async()=>{
 const oldPath=current.pathname,oldHidden=document.hidden;
 document.hidden=false;current.pathname='/alice/status/300/photo/1';
 let fetches=0;const snap=currentPage([400,300],'MORE-PAGES');
 const pages=Array.from({length:64},(_,i)=>({page:i}));
 const store={async loadPageManifest(){return {
  schema:1,profile:'alice',timeline:'alice|photo',
  expires:snap.expires,activePage:63,pages
 }}};
 const ctl=continuationCtl(snap,[ref(200)],store,null);
 ctl.restoredCheckpointPage=63;ctl.publicSessionRestored=true;
 ctl.navigationBusy=false;
 ctl.fetchPublicMediaPage=async()=>{fetches++;throw Error('No network at capacity')};
 try{
  for(let i=0;i<3;i++)
   assert.equal(await X.Controller.prototype.loadPublicMediaContinuation.call(
      ctl,true),false);
  assert.equal(fetches,0,'capacity is local, must not query FxEmbed');
  assert.equal(ctl.publicApiLoading,false);
  assert.equal(ctl.publicApiCursor,'MORE-PAGES');
  assert.equal(ctl.refs.length,2);
  assert.equal(ctl.publicApiExhausted,false,
    'local 64-page limit does not mean FxEmbed itself is exhausted');
  assert.equal(ctl.checkpointContinuationBlocked,true);
  assert.equal(ctl.checkpointCapacityReached,true);
 }finally{current.pathname=oldPath;document.hidden=oldHidden;}
});
test('B2 already-committed neighbor must not request an extra public API page',async()=>{
 const oldPath=current.pathname,oldHidden=document.hidden;
 document.hidden=false;current.pathname='/alice/status/300/photo/1';
 const snap=currentPage([400,300],'MORE-PAGES');
 let fetches=0;
 const store={async loadPageManifest(){return {
  schema:1,profile:'alice',timeline:'alice|photo',
  expires:snap.expires,activePage:0,pages:[{page:0},{page:1}]
 }}};
 const ctl=continuationCtl(snap,[ref(200)],store,null);
 ctl.restoredCheckpointPage=0;ctl.publicSessionRestored=true;
 ctl.navigationBusy=false;
 ctl.fetchPublicMediaPage=async()=>{fetches++;throw Error('Already committed')};
 try{
  assert.equal(await X.Controller.prototype.loadPublicMediaContinuation.call(
   ctl,false),false);
  assert.equal(fetches,0);
  assert.equal(ctl.publicApiLoading,false);
  assert.equal(ctl.navigationBusy,false);
  assert.equal(ctl.checkpointContinuationBlocked,true);
  assert.equal(ctl.checkpointCapacityReached,false);
 }finally{current.pathname=oldPath;document.hidden=oldHidden;}
});

test('B2 delayed manifest lookup cannot fetch after navigation invalidates its session',async()=>{
 const prior=current.pathname,hidden=document.hidden;
 document.hidden=false;current.pathname='/alice/status/300/photo/1';
 let resolve;
 const waiting=new Promise(r=>{resolve=r});
 const snap=currentPage([400,300],'CURSOR-CHECK');
 let fetches=0;
 const ctl=continuationCtl(snap,[ref(200)],{
  async loadPageManifest(){return waiting}
 },null);
 ctl.restoredCheckpointPage=0;ctl.publicSessionRestored=true;
 ctl.fetchPublicMediaPage=async()=>{fetches++;throw Error('stale fetch')};
 try{
   const pending=X.Controller.prototype.loadPublicMediaContinuation.call(ctl,true);
   current.pathname='/alice/status/999/photo/1';
   ctl.navGeneration++;
   resolve({schema:1,profile:'alice',timeline:'alice|photo',
    expires:snap.expires,activePage:0,pages:[{page:0}]});
   assert.equal(await pending,false);
   assert.equal(fetches,0);
   assert.equal(ctl.refs.length,2);
   assert.equal(ctl.publicApiLoading,false);
 }finally{current.pathname=prior;document.hidden=hidden}
});
test('B2 missing immutable manifest refuses continuation instead of fetching',async()=>{
 const prior=current.pathname,hidden=document.hidden;
 document.hidden=false;current.pathname='/alice/status/300/photo/1';
 const snap=currentPage([400,300],'CURSOR-CHECK');
 let fetches=0;
 const ctl=continuationCtl(snap,[ref(200)],{
   async loadPageManifest(){return null}
 },null);
 ctl.restoredCheckpointPage=0;ctl.publicSessionRestored=true;
 ctl.fetchPublicMediaPage=async()=>{fetches++;throw Error('missing manifest fetch')};
 try{
  assert.equal(await X.Controller.prototype.loadPublicMediaContinuation.call(ctl,true),false);
  assert.equal(fetches,0);
  assert.equal(ctl.refs.length,2);
 }finally{current.pathname=prior;document.hidden=hidden}
});
test('B2 two simultaneous arrows share one manifest preflight and one provider request',async()=>{
 const previous=current.pathname,previousHidden=document.hidden;
 current.pathname='/alice/status/300/photo/1';document.hidden=false;
 const snap=currentPage([400,300],'CURSOR-PREFLIGHT');
 let resolveManifest,notifyStarted;
 const gate=new Promise(resolve=>{resolveManifest=resolve});
 const started=new Promise(resolve=>{notifyStarted=resolve});
 let manifestReads=0,networkCalls=0;
 const manifest={schema:1,profile:'alice',timeline:'alice|photo',
  expires:snap.expires,activePage:0,pages:[{page:0}]};
 const ctl=continuationCtl(snap,[ref(200)],{
  async loadPageManifest(){manifestReads++;notifyStarted();return gate}
 },null);
 ctl.publicSessionRestored=true;ctl.restoredCheckpointPage=0;
 ctl.fetchPublicMediaPage=async()=>{networkCalls++;return null};
 try{
  const first=X.Controller.prototype.loadPublicMediaContinuation.call(ctl,true);
  await started;
  const second=X.Controller.prototype.loadPublicMediaContinuation.call(ctl,true);
  resolveManifest(manifest);
  assert.deepEqual(await Promise.all([first,second]),[false,false]);
  assert.equal(manifestReads,1,'one current-route checkpoint preflight');
  assert.equal(networkCalls,1,'one public provider query per boundary');
  assert.equal(ctl.publicApiLoading,false);
  assert.equal(ctl.publicApiPreflightGeneration,null);
 }finally{resolveManifest(manifest);current.pathname=previous;
  document.hidden=previousHidden}
});
test('B2 rejected manifest preflight releases lock so a later retry can proceed',async()=>{
 const original=current.pathname,hidden=document.hidden;
 current.pathname='/alice/status/300/photo/1';document.hidden=false;
 const snap=currentPage([400,300],'CURSOR-RETRY');
 let reads=0,networkCalls=0;
 const ctl=continuationCtl(snap,[ref(200)],{
  async loadPageManifest(){
   reads++;
   if(reads===1)throw Error('MV3 storage temporarily unavailable');
   return {schema:1,profile:'alice',timeline:'alice|photo',
     expires:snap.expires,activePage:0,pages:[{page:0}]};
  }
 },null);
 ctl.publicSessionRestored=true;ctl.restoredCheckpointPage=0;
 ctl.fetchPublicMediaPage=async()=>{networkCalls++;return null};
 try{
  assert.equal(await X.Controller.prototype.loadPublicMediaContinuation.call(
    ctl,true),false);
  assert.equal(ctl.publicApiPreflightGeneration,null);
  assert.equal(await X.Controller.prototype.loadPublicMediaContinuation.call(
    ctl,true),false);
  assert.equal(reads,2);
  assert.equal(networkCalls,1);
  assert.equal(ctl.publicApiPreflightGeneration,null);
 }finally{current.pathname=original;document.hidden=hidden}
});
test('B2 local full 64-page bound skips repeated manifest and consent reads',async()=>{
 const original=current.pathname,hidden=document.hidden;
 current.pathname='/alice/status/300/photo/1';document.hidden=false;
 const snap=currentPage([400,300],'CURSOR-65');
 let manifestReads=0,providerCalls=0,consentReads=0;
 const ctl=continuationCtl(snap,[ref(200)],{
   async loadPageManifest(){manifestReads++;
    return {schema:1,profile:'alice',timeline:'alice|photo',
     expires:snap.expires,activePage:63,
     pages:Array.from({length:64},(_,page)=>({page}))}
   },
   async hasConsent(){consentReads++;return true}
 },null);
 ctl.restoredCheckpointPage=63;ctl.publicSessionRestored=true;
 ctl.viewer={isConnected:true};ctl.publicApiWarmTimer=null;
 ctl.publicApiWarmCursor=null;ctl.navigationBusy=false;
 ctl.fetchPublicMediaPage=async()=>{providerCalls++;return null};
 try{
   assert.equal(await X.Controller.prototype.loadPublicMediaContinuation.call(
     ctl,true),false);
   assert.equal(ctl.checkpointCapacityReached,true);
   await X.Controller.prototype.schedulePublicMediaWarmup.call(ctl,1);
   assert.equal(await X.Controller.prototype.loadPublicMediaContinuation.call(
     ctl,true),false);
   assert.equal(manifestReads,1,
     'verified capacity should not repeatedly read the same worker manifest');
   assert.equal(consentReads,0,'no third-party consent polling at local capacity');
   assert.equal(providerCalls,0);
   assert.equal(ctl.publicApiExhausted,false);
   assert.equal(ctl.publicApiCursor,'CURSOR-65');
 }finally{current.pathname=original;document.hidden=hidden}
});
test('B2 an old-route preflight cannot release a newer-route reservation',async()=>{
 const oldPath=current.pathname,hidden=document.hidden;
 document.hidden=false;current.pathname='/alice/status/300/photo/1';
 const snap=currentPage([400,300],'CURSOR-GENERATION');
 const pending=[],entered=[];let reads=0,providerCalls=0;
 const manifest={schema:1,profile:'alice',timeline:'alice|photo',
  expires:snap.expires,activePage:0,pages:[{page:0}]};
 const ctl=continuationCtl(snap,[ref(200)],{
  async loadPageManifest(){
   reads++;
   return await new Promise(resolve=>{
    pending.push(resolve);
    entered.shift()?.();
   });
  }
 },null);
 ctl.restoredCheckpointPage=0;ctl.publicSessionRestored=true;
 ctl.fetchPublicMediaPage=async()=>{providerCalls++;return null};
 try{
  const first=X.Controller.prototype.loadPublicMediaContinuation.call(ctl,true);
  while(pending.length!==1)await Promise.resolve();
  ctl.navGeneration++;
  current.pathname='/alice/status/300/photo/2';
  const second=X.Controller.prototype.loadPublicMediaContinuation.call(ctl,true);
  while(pending.length!==2)await Promise.resolve();
  pending[0](manifest);
  assert.equal(await first,false);
  assert.equal(ctl.publicApiPreflightGeneration,ctl.navGeneration,
    'stale cleanup must leave new generation reservation intact');
  const third=await X.Controller.prototype.loadPublicMediaContinuation.call(ctl,true);
  assert.equal(third,false);
  assert.equal(reads,2);
  pending[1](manifest);
  assert.equal(await second,false);
  assert.equal(providerCalls,1);
  assert.equal(ctl.publicApiPreflightGeneration,null);
 }finally{for(const resolve of pending)resolve(manifest);
  current.pathname=oldPath;document.hidden=hidden}
});
test('B2 visible post counter stops promising continuation at verified 64-page cap',()=>{
 const path=current.pathname;current.pathname='/alice/status/300/photo/1';
 const snap=currentPage([400,300],'CURSOR-65');
 const label={textContent:'',title:''};
 const prev={disabled:false},next={disabled:false};
 const viewer={isConnected:true,querySelector(name){
  return name==='.xmn-prev'?prev:name==='.xmn-next'?next:
   name==='.xmn-status'?label:null;
 }};
 const ctl=continuationCtl(snap,[ref(200)],{},null);
 Object.assign(ctl,{viewer,publicSessionRestored:true,
   experimentalThirdPartyApiEnabled:true, // legacy provider-bound capacity test
  restoredCheckpointPage:63,checkpointCapacityReached:false,
  viewerStateSnapshot:null,controlsHost:null,
  statusOrdinalCache:null,schedulePublicMediaWarmup(){}});
 try{
  X.Controller.prototype.updateViewerState.call(ctl);
  assert.equal(label.textContent,'投稿 2 / 2+');
  assert.ok(!prev.disabled && !next.disabled);
  ctl.checkpointCapacityReached=true;
  X.Controller.prototype.updateViewerState.call(ctl);
  assert.equal(label.textContent,'投稿 2 / 2');
  assert.match(label.title,/64ページ/);
  assert.equal(ctl.publicApiCursor,'CURSOR-65');
  assert.equal(ctl.publicApiExhausted,false);
 }finally{current.pathname=path}
});
