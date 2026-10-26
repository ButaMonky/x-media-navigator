import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../extension/content_script.js', import.meta.url), 'utf8');
const state = { pathname: '/alice/media', search: '', root: null };
class FakeElement {
  constructor(tag='div', attrs={}) {
    this.tag=tag;this.attrs=attrs;this.children=[];this.classList={ add(){} };this.isConnected=true;
    this.textContent='';this.listeners={};
  }
  querySelectorAll(selector) {
    if (selector==='a[href]') return this.links || [];
    if (selector==='img, video') return this.image ? [this.image] : [];
    if (selector===':scope > .xmn-tile-badge') return this.children.filter(c=>c.attrs.class==='xmn-tile-badge');
    if (selector==='li[role="listitem"]') return this.tiles || [];
    return [];
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  setAttribute(name,value) { this.attrs[name]=value; }
  appendChild(el) { this.children.push(el);return el; }
  closest(selector) { return this.closestResult ?? null; }
  addEventListener(name, handler) { this.listeners[name]=handler; }
}
const document = {
  readyState: 'loading',
  addEventListener() {},
  querySelector(selector) { return selector==='main [data-testid="primaryColumn"]' ? state.root : null; },
  createElement(tag) { return new FakeElement(tag); },
};
const context = vm.createContext({ URL, URLSearchParams, Set, Map, Element:FakeElement, document, window: { location:state }, console });
vm.runInContext(source, context);
const proto = context.XMN.Controller.prototype;
const ref = (href) => context.XMN.mediaRefFromHref(href, 'alice');
const makeTile = (href) => {
  const tile = new FakeElement('li');
  const link = new FakeElement('a', {href});
  link.click = () => {};
  tile.links=[link];tile.image=new FakeElement('img');
  return {tile,link};
};

function keyEvent(key, extra={}) {
  return {
    key,shiftKey:false,altKey:false,ctrlKey:false,metaKey:false,repeat:false,isComposing:false,
    target:null, prevented:false, stopped:false,
    preventDefault(){ this.prevented=true; },
    stopImmediatePropagation(){this.stopped=true;},
    ...extra,
  };
}

test('compiled controller crosses posts on first/last gallery image, but not in the middle', () => {
  const calls=[];
  const instance={ viewer:{isConnected:true}, originProfile:'alice', navigationBusy:false,
    refs:['/alice/status/7/photo/1','/alice/status/11/photo/1','/alice/status/11/photo/2','/alice/status/22/photo/1'].map(ref),
    activeIndex(){return 0;}, photoCount(){return 2;},
    nativeGalleryArrowAvailable(){return false;},handleUnknownRightBoundary(){},navigate(dir){calls.push(dir);} };
  const run=(path,key,extra={})=>{state.pathname=path;const ev=keyEvent(key,extra);proto.onKeyDown.call(instance,ev);return ev;};
  assert.equal(run('/alice/status/11/photo/1','ArrowRight').prevented,false,'X should open image 2');
  assert.equal(run('/alice/status/11/photo/2','ArrowLeft').prevented,false,'X should open image 1');
  assert.equal(run('/alice/status/11/photo/2','ArrowRight').prevented,true,'last photo to next post');
  assert.equal(run('/alice/status/11/photo/1','ArrowLeft').prevented,true,'first photo to previous post');
  assert.equal(run('/alice/status/11/video/1','ArrowRight').prevented,false,'video seek stays native');
  assert.equal(run('/alice/status/11/photo/2','ArrowRight',{shiftKey:true}).prevented,false,'Shift+Arrow no longer shortcut');
  assert.deepEqual(calls,[1,-1]);
});

test('unknown right boundary, native gallery buttons, focus and blocked viewer preserve X operation', () => {
  const calls=[];
  const instance={viewer:{isConnected:true},originProfile:'alice',navigationBusy:false,
    activeIndex(){return 0;},photoCount(){return null;},nativeGalleryArrowAvailable(){return false;},handleUnknownRightBoundary(){},navigate(dir){calls.push(dir);} };
  state.pathname='/alice/status/11/photo/4';
  assert.equal((()=>{const e=keyEvent('ArrowRight');proto.onKeyDown.call(instance,e);return e.prevented})(),false);
  instance.photoCount=()=>4;
  instance.nativeGalleryArrowAvailable=(v,dir)=>dir===1;
  const enabled=keyEvent('ArrowRight');proto.onKeyDown.call(instance,enabled);
  assert.equal(enabled.prevented,false,'enabled native next button wins');
  instance.nativeGalleryArrowAvailable=()=>false;
  const focused=keyEvent('ArrowRight',{target:new FakeElement('input')});
  focused.target.closestResult=focused.target;proto.onKeyDown.call(instance,focused);
  assert.equal(focused.prevented,false);
  instance.viewer=null;const closed=keyEvent('ArrowRight');proto.onKeyDown.call(instance,closed);
  assert.equal(closed.prevented,false);
  instance.viewer={isConnected:true};instance.activeIndex=()=>null;
  const unknown=keyEvent('ArrowRight');proto.onKeyDown.call(instance,unknown);
  assert.equal(unknown.prevented,false);assert.deepEqual(calls,[]);
});

test('tile scanning distinguishes photo positions, scopes profile, reuses numbering', () => {
  const a=makeTile('/alice/status/11/photo/1');
  const b=makeTile('/alice/status/11/photo/2');
  const foreign=makeTile('/bob/status/99/photo/1');
  state.pathname='/alice/media';
  state.root=new FakeElement('div');state.root.tiles=[a.tile,b.tile,foreign.tile];
  const instance={originProfile:'alice',refs:[],indexes:new Map()};
  proto.scanTiles.call(instance);
  assert.equal(instance.refs.length,2);
  assert.equal(instance.indexes.size,2);
  assert.notEqual(instance.refs[0].key,instance.refs[1].key);
  assert.equal(a.tile.children.length,1);
  assert.equal(b.tile.children.length,1);
  const newer=makeTile('/alice/status/11/photo/2');
  state.root.tiles=[a.tile,newer.tile];
  proto.scanTiles.call(instance);
  assert.equal(instance.refs.length,2);
  assert.equal(newer.tile.children.length,1);
  assert.equal(newer.tile.children[0].textContent,'2');
});

test('navigation resolves the live replacement DOM link instead of stale one', () => {
  state.pathname='/alice/media';
  const old=makeTile('/alice/status/11/photo/1');
  const fresh=makeTile('/alice/status/11/photo/1');
  state.root=new FakeElement('div');state.root.tiles=[old.tile];
  const instance={originProfile:'alice'};
  assert.equal(proto.findLiveLink.call(instance,ref('/alice/status/11/photo/1')),old.link);
  state.root.tiles=[fresh.tile];
  assert.equal(proto.findLiveLink.call(instance,ref('/alice/status/11/photo/1')),fresh.link);
});

test('navigation only clicks a known destination after viewer closes', async () => {
  state.pathname='/alice/status/11/photo/1';
  const sequence=[];
  const viewer={isConnected:true};
  const instance={
    navigationBusy:false, navGeneration:2, originProfile:'alice',viewer,
    refs:[ref('/alice/status/11/photo/1'),ref('/alice/status/22/photo/1')],
    activeIndex(){return 0;},updateViewerState(){},
    beginVisualHandoff(){return false;},clearVisualHandoff(){},
    findCloseButton(){return {click(){sequence.push('close');viewer.isConnected=false;state.pathname='/alice/media';}};},
    async waitForViewerToClose(){sequence.push('closed');return true;},
    findLiveLink(item){return {click(){sequence.push(item.key);}};},
    toast(){sequence.push('toast');},
  };
  await proto.navigate.call(instance,1);
  assert.deepEqual(sequence,['close','closed',instance.refs[1].key]);
  assert.equal(instance.navigationBusy,false);
});

test('missing close button aborts rather than navigating elsewhere', async () => {
  state.pathname='/alice/status/11/photo/1';
  let errors=0;
  const instance={navigationBusy:false, navGeneration:1,originProfile:'alice',viewer:{isConnected:true},
    refs:[ref('/alice/status/11/photo/1'),ref('/alice/status/22/photo/1')],
    activeIndex(){return 0;},findLiveLink(){return {isConnected:true};},
    findCloseButton(){return null;},toast(){errors++;},updateViewerState(){} };
  await proto.navigate.call(instance,1);
  assert.equal(errors,1);
  assert.equal(instance.navigationBusy,false);
});

test('preloading is bounded, prioritizes adjacent images, and respects save-data/offline', () => {
  const calls=[];
  context.Image = class { set src(v) { calls.push(v); } };
  context.navigator = { onLine:true, connection: {saveData:false,effectiveType:'4g'} };
  document.hidden=false;
  state.pathname='/alice/status/11/photo/2';
  const refs=['/alice/status/11/photo/1','/alice/status/11/photo/2','/alice/status/22/photo/1'].map(ref);
  const sources = new Map([
    [refs[0].key,'https://pbs.twimg.com/media/A?format=jpg&name=large'],
    [refs[1].key,'https://pbs.twimg.com/media/B?format=jpg&name=large'],
    [refs[2].key,'https://pbs.twimg.com/media/C?format=jpg&name=large']
  ]);
  const instance = Object.assign(Object.create(proto), {viewer:{isConnected:true},originProfile:'alice',refs,imageSources:sources,
    prefetched:new Map(),prefetchFailed:new Set(),prefetchQueue:[],prefetchWanted:new Set(),prefetchInFlight:0,
    activeIndex(){return 1;}});
  proto.preloadAdjacentImages.call(instance);
  assert.equal(calls.length,2);
  assert.deepEqual(calls,[sources.get(refs[2].key),sources.get(refs[0].key)]);
  proto.preloadAdjacentImages.call(instance);
  assert.equal(calls.length,2,'same images should not be requested again');
  context.navigator.connection.saveData=true;
  instance.prefetched.clear();
  proto.preloadAdjacentImages.call(instance);
  assert.equal(calls.length,2,'save-data disables preloading');
  context.navigator.connection.saveData=false;
  context.navigator.onLine=false;
  proto.preloadAdjacentImages.call(instance);
  assert.equal(calls.length,2,'offline disables preloading');
});

test('lazy-loader keeps waiting when only more images from the SAME post arrive', async () => {
  context.window.setTimeout=(callback)=>setTimeout(callback,1);
  context.window.scrollTo=()=>{};
  document.documentElement={scrollHeight:200};
  const refs=['/alice/status/11/photo/1','/alice/status/11/photo/2'].map(ref);
  let scans=0;
  const instance={navGeneration:5,refs,
    scanTiles(){
      scans++;
      if (scans===2) this.refs.push(ref('/alice/status/11/photo/3'));
      if (scans===4) this.refs.push(ref('/alice/status/22/photo/1'));
    }
  };
  const result=await proto.loadNextPost.call(instance,'11',5);
  assert.equal(result.statusId,'22');
  assert.equal(scans,4);
});


test('changing the media filter holds old tiles until X replaces the visible grid', () => {
  state.pathname='/alice/media';state.search='?filter=photo';
  const oldTile=makeTile('/alice/status/10/photo/1');
  state.root=new FakeElement('div'); state.root.tiles=[oldTile.tile];
  const controller=Object.create(proto);
  controller.originProfile='alice';controller.originTimeline='alice|photo';
  controller.refs=[ref('/alice/status/10/photo/1')];controller.indexes=new Map();
  controller.pendingGrid=null;controller.lastPath='/alice/media';
  let scans=0, resets=0;
  controller.resetSession=function(){resets++;this.refs=[];this.pendingGrid=null;};
  let firstObserver=true;
  controller.ensureListObserver=function() { const added=firstObserver;firstObserver=false;return added; };
  controller.stopListObserver=function(){};
  controller.scanTiles=function(){scans++;this.refs=[ref(state.root.tiles[0].links[0].getAttribute('href'))];};
  controller.removeViewerUI=function(){};
  controller.syncViewer=function(){};
  proto.tick.call(controller);
  assert.equal(scans,1);
  state.search='?filter=video';
  proto.tick.call(controller);
  assert.equal(resets,1);
  assert.equal(scans,1,'old photo grid must not be indexed as video');
  assert.ok(controller.pendingGrid);
  // Moving only an unrelated query parameter should not reset any session.
  state.search='?filter=video&utm_source=test';
  proto.tick.call(controller);
  assert.equal(resets,1);
  assert.equal(scans,1);
  state.root.tiles=[makeTile('/alice/status/20/video/1').tile];
  proto.tick.call(controller);
  assert.equal(scans,2,'new list finally accepted');
  assert.equal(controller.refs[0].statusId,'20');
  assert.equal(controller.pendingGrid,null);
  // X may also update anchor URLs IN PLACE without replacing tile nodes.
  state.search='?filter=photo';
  proto.tick.call(controller);
  assert.ok(controller.pendingGrid);
  assert.equal(scans,2);
  state.root.tiles[0].links[0].attrs.href='/alice/status/30/photo/1';
  proto.tick.call(controller);
  assert.equal(controller.pendingGrid,null);
  assert.equal(scans,3);
  assert.equal(controller.refs[0].statusId,'30');
  state.search='';state.pathname='/alice/media';
});

test('photo count requires an explicit matching counter or all four photos', () => {
  state.pathname='/alice/status/100/photo/1';
  const controller=Object.create(proto);
  controller.originProfile='alice';controller.refs=[];
  const article=new FakeElement('article');
  article.querySelectorAll=(selector)=>selector==='a[href*="/photo/"]'
    ? ['/alice/status/100/photo/1','/alice/status/100/photo/2'].map(h=>new FakeElement('a',{href:h})) : [];
  const root=new FakeElement('div');
  root.querySelectorAll=(selector)=>selector==='article[data-testid="tweet"]'?[article]:[];
  const viewer=new FakeElement('div');viewer.parentElement=root;
  viewer.querySelectorAll=()=>[];
  assert.equal(proto.photoCount.call(controller,viewer,'100'),null,'2 known links might be only 2 of 4');
  const counter=new FakeElement('span',{'aria-label':'Image 1 of 2'});
  viewer.querySelectorAll=()=>[counter];
  assert.equal(proto.photoCount.call(controller,viewer,'100'),2);
  controller.knownPhotoTotals.clear();
  counter.setAttribute('aria-label','Image 2 of 3');
  assert.equal(proto.photoCount.call(controller,viewer,'100'),null,'counter for a different displayed index is ignored');
  viewer.querySelectorAll=()=>[];
  article.querySelectorAll=()=>['/alice/status/100/photo/1','/alice/status/100/photo/2',
    '/alice/status/100/photo/3','/alice/status/100/photo/4'].map(h=>new FakeElement('a',{href:h}));
  assert.equal(proto.photoCount.call(controller,viewer,'100'),4);
  state.pathname='/alice/media';
});


test('thumbnail URL cache stays bounded over a long media timeline', () => {
  state.pathname='/alice/media';state.search='';
  const tiles=Array.from({length:145},(_,i)=>{
    const {tile}=makeTile('/alice/status/'+(300+i)+'/photo/1');
    const old=tile.querySelector.bind(tile);
    const oldAll=tile.querySelectorAll.bind(tile);
    const thumbnail={ currentSrc:'https://pbs.twimg.com/media/T'+i+'?format=jpg&name=small' };
    tile.querySelector=(selector)=>selector==='img[src]' ? thumbnail : old(selector);
    tile.querySelectorAll=(selector)=>selector==='img[src]' ? [thumbnail] : oldAll(selector);
    return tile;
  });
  state.root=new FakeElement('div');state.root.tiles=tiles;
  const instance={originProfile:'alice',pendingGrid:null,refs:[],indexes:new Map(),imageSources:new Map()};
  proto.scanTiles.call(instance);
  assert.equal(instance.refs.length,145);
  assert.equal(instance.imageSources.size,128);
  assert.ok(!instance.imageSources.has(ref('/alice/status/300/photo/1').key));
  assert.ok(instance.imageSources.has(ref('/alice/status/444/photo/1').key));
});


test('unchanged media DOM is not rescanned on every route poll', () => {
  state.pathname='/alice/media';state.search='?filter=photo';
  state.root=new FakeElement('div');state.root.tiles=[makeTile('/alice/status/11/photo/1').tile];
  const ctrl=Object.create(proto);ctrl.originProfile='alice';ctrl.originTimeline='alice|photo';
  ctrl.pendingGrid=null;ctrl.lastPath='/alice/media';
  let scans=0, observerAdded=true;
  ctrl.ensureListObserver=()=>{const result=observerAdded;observerAdded=false;return result;};
  ctrl.scanTiles=()=>{scans++;};
  ctrl.removeViewerUI=()=>{};
  proto.tick.call(ctrl); proto.tick.call(ctrl); proto.tick.call(ctrl);
  assert.equal(scans,1,'initial observer attachment scans once, then waits for DOM changes');
  state.pathname='/alice/media';state.search='';
});


test('virtualized missing destination keeps the gallery open instead of losing its position', async () => {
  state.pathname='/alice/status/11/photo/1'; state.search='?filter=photo';
  const viewer={isConnected:true}; let closeAttempts=0; const messages=[];
  const instance={
    navigationBusy:false,navGeneration:1,originProfile:'alice',originTimeline:'alice|photo',viewer,
    refs:[ref('/alice/status/11/photo/1'),ref('/alice/status/22/photo/1')],
    activeIndex(){return 0;},
    findLiveLink(){return null;},
    findCloseButton(){closeAttempts++;return {click(){viewer.isConnected=false;}};},
    toast(message){messages.push(message);},updateViewerState(){},
  };
  await proto.navigate.call(instance,1);
  assert.equal(closeAttempts,0);
  assert.equal(viewer.isConnected,true);
  assert.equal(instance.navigationBusy,false);
  assert.match(messages[0],/ビューアは閉じません/);
  state.pathname='/alice/media'; state.search='';
});

test('SPA filter mismatch after modal close never opens a stale timeline ref', async () => {
  state.pathname='/alice/status/11/photo/1'; state.search='';
  const viewer={isConnected:true}; let closeAttempts=0,clicked=0;const messages=[];
  const instance={
    navigationBusy:false,navGeneration:3,originProfile:'alice',originTimeline:'alice|photo',viewer,
    refs:[ref('/alice/status/11/photo/1'),ref('/alice/status/22/photo/1')],
    activeIndex(){return 0;},
    beginVisualHandoff(){return false;},clearVisualHandoff(){},
    findLiveLink(){return {click(){clicked++;}};},
    findCloseButton(){return {click(){
      closeAttempts++;viewer.isConnected=false;state.pathname='/alice/media';state.search='?filter=video';
    }};},
    async waitForViewerToClose(){return true;},
    toast(message){messages.push(message);},updateViewerState(){},
  };
  await proto.navigate.call(instance,1);
  assert.equal(closeAttempts,1);
  assert.equal(clicked,0);
  assert.equal(instance.navigationBusy,false);
  assert.match(messages[0],/切り替わった/);
  state.pathname='/alice/media'; state.search='';
});


test('carousel showing two or three images never proves the entire album size', () => {
  const controller=Object.create(proto);
  controller.originProfile='alice';controller.refs=[];
  const root=new FakeElement('div');
  const viewer=new FakeElement('div');viewer.parentElement=root;viewer.querySelectorAll=()=>[];
  const article=new FakeElement('article');
  const entries=(count,owner='alice',status='100')=>Array.from({length:count},(_,i)=>{
    const tile=new FakeElement('div');const link=new FakeElement('a',{href:`/${owner}/status/${status}/photo/${i+1}`});
    tile.querySelectorAll=(selector)=>selector==='a[href*="/photo/"]'?[link]:[];
    return tile;
  });
  let tiles=entries(2);
  article.querySelectorAll=(selector)=>selector==='[data-testid="tweetPhoto"]'?tiles:[];
  root.querySelectorAll=(selector)=>selector==='article[data-testid="tweet"]'?[article]:[];
  state.pathname='/alice/status/100/photo/2';
  assert.equal(proto.photoCount.call(controller,viewer,'100'),null,'two mounted photos might only be 2 of 4');
  tiles=entries(3);
  state.pathname='/alice/status/100/photo/3';
  assert.equal(proto.photoCount.call(controller,viewer,'100'),null,'three mounted photos might only be 3 of 4');
  tiles=entries(3);tiles[2].querySelectorAll=()=>[];
  assert.equal(proto.photoCount.call(controller,viewer,'100'),null,'incomplete grid cannot prove count');
  tiles=entries(2,'bob');
  assert.equal(proto.photoCount.call(controller,viewer,'100'),null,'foreign owner is ignored');
  tiles=entries(2);article.closest=()=>article;
  assert.equal(proto.photoCount.call(controller,viewer,'100'),null,'quoted article is ignored');
  state.pathname='/alice/media';
});

test('unknown gallery boundary never skips first photo; repeated unchanged right confirms next post', () => {
  const controller=Object.create(proto);
  let delayed=null;let directions=[];let notices=[];
  context.window.setTimeout=(fn)=>{delayed=fn;return 91;};
  context.window.clearTimeout=()=>{};
  controller.viewer={isConnected:true};controller.originProfile='alice';controller.navGeneration=2;
  controller.navigationBusy=false;controller.rightProbeTimer=null;
  controller.refs=[ref('/alice/status/100/photo/1'),ref('/alice/status/101/photo/1')];
  controller.activeIndex=()=>0;controller.photoCount=()=>null;
  controller.nativeGalleryArrowAvailable=()=>false;
  controller.currentPhotoSignature=()=> 'stable-image';
  controller.toast=(message)=>notices.push(message);
  controller.navigate=(dir)=>directions.push(dir);
  state.pathname='/alice/status/100/photo/1';
  const first=keyEvent('ArrowRight');proto.onKeyDown.call(controller,first);
  assert.equal(first.prevented,false,'first press goes to native X gallery');
  assert.equal(directions.length,0);
  delayed();
  assert.match(notices[0],/もう一度/);
  assert.equal(directions.length,0,'no navigation on unverified first photo');
  const second=keyEvent('ArrowRight');proto.onKeyDown.call(controller,second);
  assert.equal(second.prevented,true);
  assert.deepEqual(directions,[1],'second press can navigate, no silent no-op');
  state.pathname='/alice/media';
});

test('observed native photo transition permits delayed single-press next-post fallback', () => {
  const controller=Object.create(proto);
  let delayed=null;const navigations=[];
  context.window.setTimeout=(fn)=>{delayed=fn;return 92;};
  context.window.clearTimeout=()=>{};
  controller.viewer={isConnected:true};controller.originProfile='alice';controller.navGeneration=5;
  controller.navigationBusy=false;controller.rightProbeTimer=null;
  controller.nativeAdvancedPost='100';
  controller.refs=[ref('/alice/status/100/photo/1'),ref('/alice/status/100/photo/2'),ref('/alice/status/101/photo/1')];
  controller.activeIndex=()=>1;controller.photoCount=()=>null;
  controller.nativeGalleryArrowAvailable=()=>false;
  controller.currentPhotoSignature=()=> 'same-photo-2';
  controller.toast=()=>{throw new Error('Native progress should avoid confirmation toast');};
  controller.navigate=(dir)=>navigations.push(dir);
  state.pathname='/alice/status/100/photo/2';
  const event=keyEvent('ArrowRight');proto.onKeyDown.call(controller,event);
  assert.equal(event.prevented,false);
  delayed();
  assert.deepEqual(navigations,[1]);
  state.pathname='/alice/media';
});

test('unknown boundary native X photo advancement prevents cross-post navigation', () => {
  const controller=Object.create(proto);
  let delayed=null;const navigations=[];const notes=[];
  context.window.setTimeout=(fn)=>{delayed=fn;return 93;};
  context.window.clearTimeout=()=>{};
  controller.viewer={isConnected:true};controller.originProfile='alice';controller.navGeneration=8;
  controller.navigationBusy=false;controller.rightProbeTimer=null;
  controller.refs=[ref('/alice/status/100/photo/1'),ref('/alice/status/100/photo/2'),ref('/alice/status/101/photo/1')];
  controller.activeIndex=()=>0;controller.photoCount=()=>null;
  controller.nativeGalleryArrowAvailable=()=>false;
  controller.currentPhotoSignature=()=> 'new-image';
  controller.navigate=(dir)=>navigations.push(dir);
  controller.toast=(note)=>notes.push(note);
  state.pathname='/alice/status/100/photo/1';
  const first=keyEvent('ArrowRight');proto.onKeyDown.call(controller,first);
  state.pathname='/alice/status/100/photo/2';
  delayed();
  assert.deepEqual(navigations,[],'the native photo change is never treated as end of post');
  assert.deepEqual(notes,[]);
  assert.equal(controller.nativeAdvancedPost,'100');
  state.pathname='/alice/media';
});

test('when X strips only the filter on close, an unchanged live target permits post navigation', async () => {
  state.pathname='/alice/status/100/photo/1';state.search='?filter=photo';
  const viewer={isConnected:true};const clicked=[];
  const link={isConnected:true,click(){clicked.push('target');}};
  const controller=Object.create(proto);
  controller.navigationBusy=false;controller.navGeneration=1;controller.originProfile='alice';
  controller.originTimeline='alice|photo';controller.viewer=viewer;
  controller.refs=[ref('/alice/status/100/photo/1'),ref('/alice/status/101/photo/1')];
  controller.activeIndex=()=>0;controller.updateViewerState=()=>{};
  controller.findLiveLink=()=>link;
  controller.findCloseButton=()=>({click(){viewer.isConnected=false;state.pathname='/alice/media';state.search='';}});
  controller.waitForViewerToClose=async()=>true;
  controller.toast=(m)=>{throw new Error(m);};
  await proto.navigate.call(controller,1);
  assert.deepEqual(clicked,['target']);
  assert.equal(controller.navigationBusy,false);
  state.pathname='/alice/media';state.search='';
});

test('SPA route poll retains current photo timeline during navigator-controlled close', () => {
  state.pathname='/alice/media'; state.search='';
  const controller=Object.create(proto);
  controller.originProfile='alice'; controller.originTimeline='alice|photo';
  controller.navigationBusy=true; controller.lastPath='/alice/status/100/photo/2';
  let resets=0,scans=0;
  controller.resetSession=()=>{resets++;};
  controller.ensureListObserver=()=>true;
  controller.scanTiles=()=>{scans++;};
  proto.tick.call(controller);
  assert.equal(resets,0,'closing the modal must not lose the session');
  assert.equal(scans,0,'filter-stripped intermediate route must not mix old/new tiles');
  assert.equal(controller.originTimeline,'alice|photo');
  state.search='';state.pathname='/alice/media';
});

test('filter normalization preserves lazy-loaded next post only when media grid remains intact', async () => {
  state.pathname='/alice/status/100/photo/1';state.search='?filter=photo';
  const viewer={isConnected:true}; const clicked=[];
  const source={isConnected:true,click(){clicked.push('next');}};
  const originalGrid={column:{},firstTiles:[{}],firstKeys:['100:photo:1']};
  const controller=Object.create(proto);
  controller.navigationBusy=false;controller.navGeneration=3;controller.originProfile='alice';
  controller.originTimeline='alice|photo';controller.viewer=viewer;
  controller.refs=[ref('/alice/status/100/photo/1')];
  controller.activeIndex=()=>0;controller.updateViewerState=()=>{};
  controller.captureGrid=()=>originalGrid;
  controller.hasGridTurnedOver=()=>false;
  controller.findLiveLink=(item)=>item.statusId==='101'?source:null;
  controller.findCloseButton=()=>({click(){viewer.isConnected=false;state.pathname='/alice/media';state.search='';}});
  controller.waitForViewerToClose=async()=>true;
  controller.loadNextPost=async()=>ref('/alice/status/101/photo/1');
  controller.toast=(message)=>{throw new Error(message);};
  await proto.navigate.call(controller,1);
  assert.deepEqual(clicked,['next']);
  assert.equal(controller.navigationBusy,false);
  state.pathname='/alice/media';state.search='';
});
test('native gallery controls with Japanese directional labels stay owned by X', () => {
  context.HTMLButtonElement = FakeElement;
  const next = new FakeElement('button', { 'aria-label': '次の画像へ' });
  const prev = new FakeElement('button', { 'aria-label': '前の写真へ' });
  next.disabled = false;
  prev.disabled = false;
  const viewer = new FakeElement('div');
  viewer.querySelectorAll = (selector) => selector === '[aria-label], [title]' ? [next, prev] : [];
  assert.equal(proto.nativeGalleryArrowAvailable.call({}, viewer, 1), true);
  assert.equal(proto.nativeGalleryArrowAvailable.call({}, viewer, -1), true);
  next.disabled = true;
  assert.equal(proto.nativeGalleryArrowAvailable.call({}, viewer, 1), false);
  prev.attrs['aria-disabled'] = 'true';
  assert.equal(proto.nativeGalleryArrowAvailable.call({}, viewer, -1), false);
});

test('lazy loading scrolls the visible final tile, including nested media lists', async () => {
  state.pathname = '/alice/media';
  const tile = makeTile('/alice/status/101/photo/1').tile;
  const calls = [];
  tile.scrollIntoView = (options) => calls.push(options.block);
  state.root = new FakeElement('div');
  state.root.tiles = [tile];
  context.window.scrollTo = () => calls.push('window');
  context.window.setTimeout = (fn) => setTimeout(fn, 1);
  document.documentElement = { scrollHeight: 9000 };
  const instance = { navGeneration: 2, refs: [ref('/alice/status/101/photo/1')], scanTiles() {
    if (calls.length >= 4 && this.refs.length === 1) this.refs.push(ref('/alice/status/102/photo/1'));
  }};
  const next = await proto.loadNextPost.call(instance, '101', 2);
  assert.equal(next.statusId, '102');
  assert.deepEqual(calls, ['end', 'window', 'end', 'window']);
  state.pathname = '/alice/media';
});
test('quoted and ambiguous media links are not indexed as the parent media tile', () => {
  state.pathname='/alice/media';
  state.search='';
  const main=makeTile('/alice/status/100/photo/1');
  const quote=new FakeElement('a', {href:'/alice/status/999/photo/1'});
  quote.closest=(selector)=>selector==='[data-testid="quoteTweet"]' ? new FakeElement('div') : null;
  main.tile.links=[quote,main.link];
  const ambiguous=makeTile('/alice/status/200/photo/1');
  ambiguous.tile.links.push(new FakeElement('a', {href:'/alice/status/300/photo/1'}));
  state.root=new FakeElement('div');
  state.root.tiles=[main.tile,ambiguous.tile];
  const instance={originProfile:'alice',pendingGrid:null,refs:[],indexes:new Map(),imageSources:new Map()};
  proto.scanTiles.call(instance);
  assert.deepEqual(instance.refs.map((item)=>item.statusId),['100']);
  assert.equal(main.tile.children[0].textContent,'1');
  assert.equal(ambiguous.tile.children.length,0,'ambiguous owners must not gain a navigation badge');
  assert.equal(proto.findLiveLink.call(instance,ref('/alice/status/100/photo/1')),main.link);
  assert.equal(proto.findLiveLink.call(instance,ref('/alice/status/999/photo/1')),null);

  const ownership=new FakeElement('a', {href:'/alice/status/400/photo/1'});
  ownership.image=new FakeElement('img');
  const other=new FakeElement('a', {href:'/alice/status/500/photo/1'});
  const resolved=makeTile('/alice/status/400/photo/1');
  resolved.tile.links=[other,ownership];
  state.root.tiles=[resolved.tile];
  proto.scanTiles.call(instance);
  assert.equal(instance.refs.at(-1).statusId,'400','link containing actual media wins over another same-profile permalink');
  state.root=null;
});

test('arrow shortcuts never run while a plaintext editor or combobox has focus', () => {
  state.pathname='/alice/status/11/photo/1';
  const instance={
    viewer:{isConnected:true},originProfile:'alice',navigationBusy:false,
    activeIndex(){return 0;}, photoCount(){return 1;},
    nativeGalleryArrowAvailable(){return false;},
    navigate(){throw new Error('the editor must own the arrow');},
  };
  for(const name of ['[contenteditable]:not([contenteditable="false"])','[role="combobox"]','[role="spinbutton"]']){
    const target=new FakeElement('div');
    target.closest=(selector)=>selector.includes(name) ? target : null;
    const event=keyEvent('ArrowRight',{target});
    proto.onKeyDown.call(instance,event);
    assert.equal(event.prevented,false,name);
  }
  state.pathname='/alice/media';
});
test('one explicit media link remains indexable before its thumbnail loads', () => {
  state.pathname='/alice/media';state.search='';
  const tile=new FakeElement('li');
  const link=new FakeElement('a',{href:'/alice/status/630/photo/1'});
  tile.links=[link]; // X has not loaded an <img> yet.
  const generic=new FakeElement('li');
  generic.links=[new FakeElement('a',{href:'/alice/status/631'})];
  state.root=new FakeElement('div');state.root.tiles=[tile,generic];
  const instance={originProfile:'alice',pendingGrid:null,refs:[],indexes:new Map(),imageSources:new Map()};
  proto.scanTiles.call(instance);
  assert.deepEqual(instance.refs.map((x)=>x.statusId),['630']);
  assert.equal(generic.children.length,0,'status-only text without media is not a media tile');
  state.root=null;
});
test('preloads the next photo and the NEXT POST before reaching the album edge', async () => {
  state.pathname='/alice/status/11/photo/1';
  document.hidden=false;
  context.navigator={onLine:true,connection:{saveData:false,effectiveType:'4g'}};
  const requests=[];
  context.Image=class {
    naturalWidth=800;
    classList={add(){}};
    set src(value) { requests.push(value); this.value=value; }
    get src() { return this.value; }
    decode() { return Promise.resolve(); }
  };
  const refs=['/alice/status/11/photo/1','/alice/status/11/photo/2',
              '/alice/status/22/photo/1'].map(ref);
  const urls=refs.map((item,i)=>'https://pbs.twimg.com/media/ITEM'+i+'?format=jpg&name=large');
  const ctrl=Object.assign(Object.create(proto), {
    viewer:{isConnected:true}, originProfile:'alice', refs, activeIndex(){return 0;},
    imageSources:new Map(refs.map((item,i)=>[item.key,urls[i]])),prefetched:new Map(),
    prefetchQueue:[],prefetchWanted:new Set(),prefetchInFlight:0,prefetchFailed:new Set(),
  });
  proto.preloadAdjacentImages.call(ctrl);
  assert.deepEqual(requests,[urls[1],urls[2]],'lookahead starts before the last native photo');
  assert.equal(ctrl.prefetched.size,2,'at most two images are preheated');
  await Promise.resolve();
  assert.equal(ctrl.prefetched.get(urls[1]).ready,true);
  assert.equal(ctrl.prefetched.get(urls[2]).ready,true);
  proto.preloadAdjacentImages.call(ctrl);
  assert.equal(requests.length,2,'no duplicate transfer');
  state.pathname='/alice/media';
});

test('decoded next-photo handoff is non-interactive and expires or reveals safely', () => {
  const oldBody=document.body, oldCreate=document.createElement;
  const oldSetTimeout=context.window.setTimeout, oldClearTimeout=context.window.clearTimeout;
  const oldMatchMedia=context.window.matchMedia;
  try {
    let id=0;
    const timers=new Map();
    context.window.setTimeout=(cb)=>{timers.set(++id,cb);return id;};
    context.window.clearTimeout=(token)=>timers.delete(token);
    context.window.matchMedia=()=>({matches:false});
    document.hidden=false;
    const body=new FakeElement('body');
    document.body=body;
    document.createElement=(tag)=>{
      const node=new FakeElement(tag);
      node.style={ properties:new Map(),setProperty(k,v){this.properties.set(k,v);} };
      node.remove=()=>{body.children=body.children.filter(item=>item!==node);};
      return node;
    };
    const target=ref('/alice/status/22/photo/1');
    const url='https://pbs.twimg.com/media/NEXT?format=jpg&name=large';
    const img=new FakeElement('img');
    img.naturalWidth=800;
    const ctrl=Object.create(proto);
    ctrl.handoff=null;
    ctrl.navGeneration=3;
    ctrl.originProfile='alice';
    const viewerBounds={left:0,top:0,right:700,width:700,height:600};
    const oldInnerWidth=context.window.innerWidth;
    context.window.innerWidth=1200;
    ctrl.viewer={getBoundingClientRect(){return viewerBounds;},querySelector(){return null;} };
    ctrl.imageSources=new Map([[target.key,url]]);
    ctrl.prefetched=new Map([[url,{image:img,ready:false}]]);
    assert.equal(proto.beginVisualHandoff.call(ctrl,target),false,'not decoded means no overlay');
    ctrl.prefetched.get(url).ready=true;
    context.window.matchMedia=()=>({matches:true});
    assert.equal(proto.beginVisualHandoff.call(ctrl,target),false,'respects reduced motion');
    context.window.matchMedia=()=>({matches:false});
    state.pathname='/alice/status/11/photo/1';
    assert.equal(proto.beginVisualHandoff.call(ctrl,target),true);
    assert.equal(body.children.length,1);
    const host=body.children[0];
    assert.equal(host.attrs['aria-hidden'],'true');
    assert.equal(host.children[0],img,'reuses decoded HTMLImageElement without another request');
    assert.equal(ctrl.handoff.targetStatus,'22');
    assert.equal(host.style.properties.get('width'),'700px','handoff is bounded to the left image area');
    state.pathname='/alice/status/22/photo/1';
    proto.finishVisualHandoff.call(ctrl,{isConnected:true,querySelector:()=>({complete:true,naturalWidth:1})});
    assert.notEqual(ctrl.handoff.revealTimer,null);
    const reveal=timers.get(ctrl.handoff.revealTimer);
    reveal();
    assert.equal(ctrl.handoff,null);
    assert.equal(body.children.length,0,'overlay is removed after destination viewer is ready');
    viewerBounds.right=1180;viewerBounds.width=1180;
    state.pathname='/alice/status/11/photo/1';
    assert.equal(proto.beginVisualHandoff.call(ctrl,target),false,'full-width modal must not obscure the conversation pane');
    viewerBounds.right=700;viewerBounds.width=700;
    assert.equal(proto.beginVisualHandoff.call(ctrl,target),true);
    const expires=timers.get(ctrl.handoff.timeout);
    expires();
    assert.equal(ctrl.handoff,null,'failsafe automatically removes overlay on a broken SPA route');
    assert.equal(body.children.length,0);
  } finally {
    document.body=oldBody;document.createElement=oldCreate;
    context.window.setTimeout=oldSetTimeout;context.window.clearTimeout=oldClearTimeout;
    context.window.matchMedia=oldMatchMedia;
    delete context.window.innerWidth;
    state.pathname='/alice/media';
  }
});
test('lookahead queues five future posts with at most two parallel downloads', async () => {
  const previousImage = context.Image;
  context.navigator = { onLine: true, connection: { saveData: false, effectiveType: '4g' } };
  document.hidden = false;
  const started = [], completeDecode = [];
  context.Image = class {
    naturalWidth = 1200; naturalHeight = 800;
    set src(url) { started.push(url); this.currentUrl = url; }
    get src() { return this.currentUrl; }
    decode() { return new Promise(resolve => completeDecode.push(resolve)); }
  };
  try {
    const refs = Array.from({ length: 8 }, (_, i) => ref('/alice/status/' + (100 + i) + '/photo/1'));
    const sources = new Map(refs.map((item, i) => [
      item.key, 'https://pbs.twimg.com/media/Z' + i + '?format=jpg&name=large',
    ]));
    const ctrl = Object.assign(Object.create(proto), {
      viewer: { isConnected: true }, originProfile: 'alice', refs,
      imageSources: sources, prefetched: new Map(),
      prefetchQueue: [], prefetchWanted: new Set(), prefetchInFlight: 0,
      prefetchFailed: new Set(), navGeneration: 1, navigationBusy: false,
      activeIndex() { return 0; },
    });
    state.pathname = '/alice/status/100/photo/1';
    proto.preloadAdjacentImages.call(ctrl);
    assert.equal(started.length, 2, 'only two parallel requests');
    assert.equal(ctrl.prefetchInFlight, 2);
    assert.equal(ctrl.prefetchQueue.length, 3, 'three later posts are queued');
    for (let i = 0; i < 5; i++) {
      completeDecode[i]();
      await Promise.resolve(); await Promise.resolve();
      assert.ok(ctrl.prefetchInFlight <= 2);
    }
    assert.equal(started.length, 5, 'five future posts are warmed');
    assert.equal(ctrl.prefetched.size, 5);
    assert.equal(ctrl.prefetchInFlight, 0);
    proto.preloadAdjacentImages.call(ctrl);
    assert.equal(started.length, 5, 'cached URLs do not fetch twice');
    context.navigator.connection.effectiveType = '3g';
    const slow = Object.assign(Object.create(proto), {
      ...ctrl, prefetched: new Map(), prefetchQueue: [],
      prefetchWanted: new Set(), prefetchInFlight: 0, prefetchFailed: new Set(),
    });
    proto.preloadAdjacentImages.call(slow);
    assert.equal(started.length, 7, '3g connection limits lookahead to two');
    assert.equal(slow.prefetchQueue.length, 0);
  } finally {
    context.Image = previousImage;
    state.pathname = '/alice/media';
  }
});

test('ARIA setsize and explicit disabled native next allow one right press', () => {
  const viewer = new FakeElement('div');
  viewer.parentElement = new FakeElement('div');
  const node = new FakeElement('span', { 'aria-posinset': '2', 'aria-setsize': '3' });
  viewer.querySelectorAll = (selector) => selector.includes('aria-setsize') ? [node] : [];
  const controller = Object.create(proto);
  controller.originProfile = 'alice';
  state.pathname = '/alice/status/42/photo/2';
  assert.equal(proto.photoCount.call(controller, viewer, '42'), 3);
  state.pathname = '/alice/status/42/photo/4';
  assert.equal(proto.photoCount.call(controller, viewer, '42'), 4, 'fourth photo is always last');

  const button = new FakeElement('button', { 'aria-label': '次の画像', 'aria-disabled': 'true' });
  viewer.querySelectorAll = () => [button];
  const calls = [];
  controller.viewer = viewer; controller.navigationBusy = false;
  controller.activeIndex = () => 0; controller.photoCount = () => null;
  controller.nativeGalleryArrowAvailable = () => false;
  controller.navigate = (direction) => calls.push(direction);
  state.pathname = '/alice/status/42/photo/1';
  const event = keyEvent('ArrowRight');
  proto.onKeyDown.call(controller, event);
  assert.equal(event.prevented, true, 'native disabled photo-next proves album end');
  assert.deepEqual(calls, [1]);
  state.pathname = '/alice/media';
});

test('visual handoff waits for actual X image load instead of modal mounting only', () => {
  const timers = new Map(); let nextTimer = 1;
  const oldSetTimeout = context.window.setTimeout, oldClearTimeout = context.window.clearTimeout;
  context.window.setTimeout = (handler) => { const id = nextTimer++; timers.set(id, handler); return id; };
  context.window.clearTimeout = (id) => timers.delete(id);
  try {
    const image = { complete: false, naturalWidth: 0, handler: null,
      addEventListener(event, fn) { if (event === 'load') this.handler = fn; } };
    const viewer = { isConnected: true, querySelector() { return image; } };
    const host = { removed: false, remove() { this.removed = true; } };
    const controller = Object.create(proto);
    controller.originProfile = 'alice'; controller.navGeneration = 2;
    controller.handoff = { host, targetStatus: '77', targetMediaIndex: 1,
      generation: 2, timeout: 99, revealTimer: null, observer: null, waitingImage: null };
    state.pathname = '/alice/status/77/photo/1';
    proto.finishVisualHandoff.call(controller, viewer);
    assert.equal(controller.handoff.revealTimer, null, 'not ready when img has not loaded');
    assert.equal(typeof image.handler, 'function');
    image.complete = true; image.naturalWidth = 100;
    image.handler();
    assert.notEqual(controller.handoff.revealTimer, null);
    const done = timers.get(controller.handoff.revealTimer);
    done();
    assert.equal(controller.handoff, null);
    assert.equal(host.removed, true);
  } finally {
    context.window.setTimeout = oldSetTimeout;
    context.window.clearTimeout = oldClearTimeout;
    state.pathname = '/alice/media';
  }
});

test('a confirmed album total is reused on later visits without double-pressing', () => {
  const controller=Object.create(proto);
  controller.originProfile='alice';
  controller.knownPhotoTotals=new Map();
  const viewer=new FakeElement('div');
  viewer.parentElement=new FakeElement('div');
  viewer.querySelectorAll=()=>[];
  state.pathname='/alice/status/42/photo/2';
  proto.rememberPhotoTotal.call(controller,'42',2);
  assert.equal(proto.photoCount.call(controller,viewer,'42'),2);
  state.pathname='/alice/status/43/photo/2';
  assert.equal(proto.photoCount.call(controller,viewer,'43'),null,'not inherited by another post');
  state.pathname='/alice/status/42/photo/1';
  assert.equal(proto.photoCount.call(controller,viewer,'42'),2,'evidence survives reopening');
  proto.rememberPhotoTotal.call(controller,'42',5);
  assert.equal(controller.knownPhotoTotals.get('42'),2,'invalid count cannot replace an exact count');
  state.pathname='/alice/media';
});

test('a failed prefetch does not enter an infinite retry loop', async () => {
  const prior=context.Image, priorNav=context.navigator;
  document.hidden=false;
  const started=[];
  context.navigator={onLine:true,connection:{saveData:false,effectiveType:'4g'}};
  context.Image=class {
    naturalWidth=100;naturalHeight=100;
    set src(v){this.value=v;started.push(v);}
    get src(){return this.value;}
    decode(){return this.value.includes('FAIL') ? Promise.reject(new Error('network')) : Promise.resolve();}
  };
  try {
    const refs=['/alice/status/11/photo/1','/alice/status/12/photo/1',
      '/alice/status/13/photo/1','/alice/status/14/photo/1'].map(ref);
    const urls=refs.map((r,i)=>'https://pbs.twimg.com/media/'+(i===1?'FAIL':('OK'+i))+'?format=jpg&name=large');
    const ctrl=Object.assign(Object.create(proto),{
      viewer:{isConnected:true},originProfile:'alice',refs,
      activeIndex(){return 0;},navGeneration:8,navigationBusy:false,
      prefetched:new Map(),prefetchQueue:[],prefetchWanted:new Set(),
      prefetchFailed:new Set(),prefetchInFlight:0,
      imageSources:new Map(refs.map((r,i)=>[r.key,urls[i]])),
    });
    state.pathname='/alice/status/11/photo/1';
    proto.preloadAdjacentImages.call(ctrl);
    await Promise.resolve();await Promise.resolve();await Promise.resolve();await Promise.resolve();
    assert.equal(started.filter(url=>url===urls[1]).length,1);
    assert.equal(ctrl.prefetchFailed.has(urls[1]),true);
    assert.ok(started.includes(urls[3]),'other future posts still load');
    proto.preloadAdjacentImages.call(ctrl);
    assert.equal(started.filter(url=>url===urls[1]).length,1,'failed URL does not loop');
  } finally {
    state.pathname='/alice/media';
    context.Image=prior;context.navigator=priorNav;
  }
});
test('prefetch begins in the next task without the old 350ms delay', () => {
  const prior=context.window.setTimeout;
  const scheduled=[];
  const ctrl=Object.create(proto);
  ctrl.originProfile='alice';
  ctrl.originTimeline='alice|default';
  ctrl.viewer={isConnected:true};
  ctrl.refs=[ref('/alice/status/11/photo/1'),ref('/alice/status/12/photo/1')];
  ctrl.imageSources=new Map();
  ctrl.preloadForPath='';
  ctrl.preloadTimer=null;
  let fired=0;
  ctrl.preloadAdjacentImages=()=>fired++;
  state.pathname='/alice/status/11/photo/1';
  context.window.setTimeout=(fn,delay)=>{scheduled.push({fn,delay});return scheduled.length};
  try {
    proto.schedulePreload.call(ctrl);
    assert.equal(scheduled[0].delay,0,'initial CDN requests must not wait 350ms');
    proto.schedulePreload.call(ctrl);
    assert.equal(scheduled.length,1,'same viewer does not duplicate preload');
    scheduled[0].fn();
    assert.equal(fired,1);
  } finally {
    context.window.setTimeout=prior;
    state.pathname='/alice/media';
  }
});

test('modal DOM observer handles SPA insertion immediately without polling unrelated mutations', () => {
  const prevBody=document.body, prevObserver=context.MutationObserver;
  let onChanges=null, observer=null, ticks=0;
  class MockObserver {
    constructor(callback){onChanges=callback;observer=this;}
    observe(root,settings){this.root=root;this.settings=settings;}
    disconnect(){this.disconnected=true;}
  }
  context.MutationObserver=MockObserver;
  document.body=new FakeElement('body');
  const ctrl=Object.create(proto);
  ctrl.originProfile='alice';ctrl.modalObserver=null;
  ctrl.tick=()=>ticks++;
  try {
    proto.syncModalObserver.call(ctrl);
    assert.equal(observer.root,document.body);
    assert.equal(observer.settings.subtree,true);
    const unrelated=new FakeElement('span');
    unrelated.matches=()=>false;
    unrelated.querySelector=()=>null;
    onChanges([{addedNodes:[unrelated],removedNodes:[]}]);
    assert.equal(ticks,0,'ordinary X feed mutation is ignored');

    const modal=new FakeElement('div');
    modal.matches=()=>false;
    modal.querySelector=(selector)=>selector==='[data-testid="swipe-to-dismiss"]'
      ? new FakeElement('div'):null;
    onChanges([{addedNodes:[modal],removedNodes:[]}]);
    assert.equal(ticks,1,'new X viewer synchronizes in MutationObserver callback');
    onChanges([{addedNodes:[],removedNodes:[modal]}]);
    assert.equal(ticks,2,'closing the viewer also synchronizes');
    ctrl.originProfile=null;
    proto.syncModalObserver.call(ctrl);
    assert.equal(observer.disconnected,true);
  } finally {
    document.body=prevBody;
    context.MutationObserver=prevObserver;
  }
});

test('single oversized decoded photo does not churn repeated prefetch requests', async () => {
  const previousImage=context.Image, previousNavigator=context.navigator;
  document.hidden=false;
  context.navigator={onLine:true,connection:{saveData:false,effectiveType:'4g'}};
  const requests=[];
  context.Image=class {
    naturalWidth=10000;naturalHeight=10000;
    set src(value){this.value=value;requests.push(value);}
    decode(){return Promise.resolve();}
  };
  try {
    const refs=['/alice/status/11/photo/1','/alice/status/12/photo/1'].map(ref);
    const next='https://pbs.twimg.com/media/huge?format=jpg&name=large';
    const ctrl=Object.assign(Object.create(proto),{
      viewer:{isConnected:true},originProfile:'alice',refs,
      activeIndex(){return 0;},imageSources:new Map([[refs[1].key,next]]),
      prefetched:new Map(),prefetchQueue:[],prefetchWanted:new Set(),
      prefetchInFlight:0,prefetchFailed:new Set(),prefetchTooLarge:new Set(),
      navGeneration:5,navigationBusy:false,
    });
    state.pathname='/alice/status/11/photo/1';
    proto.preloadAdjacentImages.call(ctrl);
    await Promise.resolve();await Promise.resolve();
    assert.equal(ctrl.prefetched.size,0,'oversized image not retained');
    assert.equal(ctrl.prefetchTooLarge.has(next),true,'large URL is marked as too expensive');
    proto.preloadAdjacentImages.call(ctrl);
    assert.deepEqual(requests,[next],'does not immediately re-download the same oversized image');
  } finally {
    state.pathname='/alice/media';
    context.Image=previousImage;context.navigator=previousNavigator;
  }
});
