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
    nativeGalleryArrowAvailable(){return false;}, navigate(dir){calls.push(dir);} };
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
    activeIndex(){return 0;},photoCount(){return null;},nativeGalleryArrowAvailable(){return false;},navigate(dir){calls.push(dir);} };
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
  const instance = {viewer:{isConnected:true},originProfile:'alice',refs,imageSources:sources,
    prefetched:new Map(),activeIndex(){return 1;}};
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
    tile.querySelector=(selector)=>selector==='img[src]'
      ? { currentSrc:'https://pbs.twimg.com/media/T'+i+'?format=jpg&name=small' }
      : old(selector);
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
