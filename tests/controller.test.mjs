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
const context = vm.createContext({ URL, URLSearchParams, Set, Map, Element:FakeElement, document, window: { location:state, addEventListener(){}, removeEventListener(){} }, console });
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
  const instance=Object.assign(Object.create(proto),{originProfile:'alice',refs:[],indexes:new Map()});
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

test('native in-modal media link can preserve the same viewer without closing it', async () => {
  state.pathname='/alice/status/11/photo/1';
  let closes=0, clicks=0;
  const viewer={isConnected:true};
  const dest=ref('/alice/status/22/photo/1');
  const link={isConnected:true, getAttribute(name){return name==='href'?'/alice/status/22/photo/1':null;},
    click(){clicks++;state.pathname='/alice/status/22/photo/1';}};
  const oldQuery=document.querySelector;
  document.querySelector=sel=>sel==='[data-testid="swipe-to-dismiss"]'?viewer:oldQuery(sel);
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice', navGeneration:1, navigationBusy:false, viewer,
    refs:[ref('/alice/status/11/photo/1'),dest],
    activeIndex(){return 0;}, findLiveLink(){return link;}, updateViewerState(){},
    findCloseButton(){return {click(){closes++;viewer.isConnected=false;state.pathname='/alice/media';}};}, toast(m){throw Error(m);},
  });
  try{
    await proto.navigate.call(ctrl,1);
    assert.equal(clicks,1,'use only the observed native X media link');
    assert.equal(closes,0,'do not close the currently mounted modal');
    assert.equal(ctrl.viewer,viewer);
    assert.equal(viewer.isConnected,true);
  }finally{document.querySelector=oldQuery;state.pathname='/alice/media';}
});

test('rapid consecutive SPA navigation never reuses an overlay for the previous post', async () => {
  state.pathname='/alice/status/22/photo/1';
  const steps=[],viewer={isConnected:true};
  const current=ref('/alice/status/22/photo/1');
  const target=ref('/alice/status/33/photo/1');
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice',navGeneration:6,navigationBusy:false,viewer,
    handoff:{targetStatus:'22',targetMediaIndex:1,targetPhotoIdentity:'OLD',shown:true},
    refs:[current,target],activeIndex(){return 0;},findLiveLink(){return {isConnected:true}},
    updateViewerState(){},findCloseButton(){return {click(){steps.push('close');}};},
    beginVisualHandoff(ref){steps.push('begin:'+ref.statusId);
      this.handoff={targetStatus:ref.statusId,targetMediaIndex:ref.mediaIndex,targetPhotoIdentity:'NEW'};return true;},
    clearVisualHandoff(){steps.push('clear:'+(this.handoff?.targetStatus??'null'));this.handoff=null;},
    nativeSpaTargetRendered(){return true;},
    tryNativeInModalNavigation:async()=>{state.pathname='/alice/status/33/photo/1';return 'retained';},
    toast(m){throw Error(m);},
  });
  try {
    await proto.navigate.call(ctrl,1);
    assert.deepEqual(steps,['clear:22','begin:33','clear:33'],
      'clear stale preview before preparing the newly selected post');
  } finally {state.pathname='/alice/media';}
});

test('in-modal SPA uses an already decoded photo bridge only while X target is pending', async () => {
  state.pathname='/alice/status/11/photo/1';
  const steps=[],viewer={isConnected:true};
  const dest=ref('/alice/status/22/photo/1');
  const link={isConnected:true,click(){}};
  const oldQuery=document.querySelector;
  document.querySelector=sel=>sel==='[data-testid="swipe-to-dismiss"]'?viewer:oldQuery(sel);
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice',navGeneration:5,navigationBusy:false,viewer,
    refs:[ref('/alice/status/11/photo/1'),dest],imageSources:new Map(),
    activeIndex(){return 0;},findLiveLink(){return link;},updateViewerState(){},
    findCloseButton(){return {click(){steps.push('close');}};},
    beginVisualHandoff(){steps.push('begin');this.handoff={targetPhotoIdentity:'TARGET'};return true;},
    showVisualHandoff(){steps.push('show');},
    finishVisualHandoff(){steps.push('finish');},
    clearVisualHandoff(){steps.push('clear');this.handoff=null;},
    displayedPhoto(){return {src:'https://pbs.twimg.com/media/OLD?format=jpg&name=large',
      currentSrc:'https://pbs.twimg.com/media/OLD?format=jpg&name=large',
      complete:true,naturalWidth:1200};},
    tryNativeInModalNavigation:async()=>{state.pathname='/alice/status/22/photo/1';return 'retained';},
    schedulePreload(){steps.push('preload');},
    toast(m){throw Error(m);},
  });
  try{
    await proto.navigate.call(ctrl,1);
    assert.deepEqual(steps,['begin','show','finish','preload'],
      'native SPA should bridge only the left image and schedule next lookahead');
    assert.equal(ctrl.navigationBusy,false);
    assert.notEqual(ctrl.handoff,null,'keep decoded image until X target is actually ready');
  }finally{document.querySelector=oldQuery;state.pathname='/alice/media';}
});

test('native SPA skips the bridge when X has already rendered the decoded target', async () => {
  state.pathname='/alice/status/11/photo/1';
  const events=[],viewer={isConnected:true};
  const dest=ref('/alice/status/22/photo/1');
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice',navGeneration:3,navigationBusy:false,viewer,
    refs:[ref('/alice/status/11/photo/1'),dest],
    activeIndex(){return 0;},findLiveLink(){return {isConnected:true}},updateViewerState(){},
    findCloseButton(){return {click(){events.push('close');}};},
    beginVisualHandoff(){events.push('begin');this.handoff={targetPhotoIdentity:'TARGET'};return true;},
    showVisualHandoff(){events.push('show');},
    clearVisualHandoff(){events.push('clear');this.handoff=null;},
    displayedPhoto(){return {src:'https://pbs.twimg.com/media/TARGET?format=jpg&name=large',
      currentSrc:'https://pbs.twimg.com/media/TARGET?format=jpg&name=orig',
      complete:true,naturalWidth:1600};},
    tryNativeInModalNavigation:async()=>{state.pathname='/alice/status/22/photo/1';return 'retained';},
    toast(m){throw Error(m);},
  });
  try{
    await proto.navigate.call(ctrl,1);
    assert.deepEqual(events,['begin','clear'],'already rendered photo must not be overpainted');
  }finally{state.pathname='/alice/media';}
});

test('deferred X SPA route change within the bounded probe prevents duplicate clicks', async () => {
  state.pathname='/alice/status/11/photo/1';
  const oldSet=context.window.setTimeout,oldQuery=document.querySelector;
  let clicks=0,ticks=0,closes=0;
  const viewer={isConnected:true};
  const link={isConnected:true,getAttribute(){return '/alice/status/22/photo/1';},click(){clicks++;}};
  context.window.setTimeout=(fn,ms)=>{ticks++;if(ticks===1)state.pathname='/alice/status/22/photo/1';fn();return 5;};
  document.querySelector=sel=>sel==='[data-testid="swipe-to-dismiss"]'?viewer:oldQuery(sel);
  const ctrl=Object.assign(Object.create(proto),{
    viewer,originProfile:'alice',navGeneration:5,navigationBusy:false,
    refs:[ref('/alice/status/11/photo/1'),ref('/alice/status/22/photo/1')],
    activeIndex(){return 0;},findLiveLink(){return link;},updateViewerState(){},
    findCloseButton(){return {click(){closes++;}};},toast(m){throw Error(m);},
  });
  try{
    await proto.navigate.call(ctrl,1);
    assert.equal(clicks,1);assert.equal(closes,0);assert.ok(ticks>=1);
  }finally{
    context.window.setTimeout=oldSet;document.querySelector=oldQuery;
    state.pathname='/alice/media';
  }
});

test('unexpected native X route aborts without closing or clicking twice', async () => {
  state.pathname='/alice/status/11/photo/1';
  let closes=0,clicks=0;
  const viewer={isConnected:true};
  const link={isConnected:true,getAttribute(){return '/alice/status/22/photo/1';},
    click(){clicks++;state.pathname='/alice/status/99/photo/1';}};
  const ctrl=Object.assign(Object.create(proto),{
    viewer,originProfile:'alice',navGeneration:7,navigationBusy:false,
    refs:[ref('/alice/status/11/photo/1'),ref('/alice/status/22/photo/1')],
    activeIndex(){return 0;},findLiveLink(){return link;},updateViewerState(){},
    findCloseButton(){return {click(){closes++;}};},toast(){},
  });
  try{
    await proto.navigate.call(ctrl,1);
    assert.equal(clicks,1,'do not duplicate an X-owned navigation');
    assert.equal(closes,0,'wrong/native route must never be followed by a close');
    assert.equal(ctrl.navigationBusy,false);
  }finally{state.pathname='/alice/media';}
});

test('temporary link guard prevents a hard browser navigation after X delegated handlers', async () => {
  const oldNode=context.Node, oldAdd=context.window.addEventListener,oldRemove=context.window.removeEventListener;
  const listeners=new Map(); let prevented=false;
  context.Node=FakeElement;
  context.window.addEventListener=(type,fn)=>listeners.set(type,fn);
  context.window.removeEventListener=(type,fn)=>{if(listeners.get(type)===fn)listeners.delete(type);};
  state.pathname='/alice/status/11/photo/1';
  const link=new FakeElement('a',{href:'/alice/status/22/photo/1'});
  link.click=()=>{
    const event={target:link,preventDefault(){prevented=true;}};
    listeners.get('click')(event);
    state.pathname='/alice/status/22/photo/1';
  };
  const viewer={isConnected:true},oldQuery=document.querySelector;
  document.querySelector=sel=>sel==='[data-testid="swipe-to-dismiss"]'?viewer:oldQuery(sel);
  const ctrl={originProfile:'alice',navGeneration:10};
  try {
    const result=await proto.tryNativeInModalNavigation.call(ctrl,ref('/alice/status/22/photo/1'),link,viewer,10);
    assert.equal(result,'retained');assert.equal(prevented,true);
    assert.equal(listeners.size,0,'the window guard must not leak');
  }finally{
    document.querySelector=oldQuery;context.Node=oldNode;
    context.window.addEventListener=oldAdd;context.window.removeEventListener=oldRemove;
    state.pathname='/alice/media';
  }
});

test('X-unclaimed in-modal link falls back promptly without six 50ms polls', async () => {
  const oldNode=context.Node,oldAdd=context.window.addEventListener,
    oldRemove=context.window.removeEventListener,oldSet=context.window.setTimeout;
  const listeners=new Map(),delays=[];
  context.Node=FakeElement;
  context.window.addEventListener=(type,fn)=>listeners.set(type,fn);
  context.window.removeEventListener=(type,fn)=>listeners.delete(type);
  context.window.setTimeout=(fn,ms)=>{delays.push(ms);fn();return delays.length;};
  const viewer={isConnected:true};
  const link=new FakeElement('a',{href:'/alice/status/72/photo/1'});
  link.click=()=>{
    const event={target:link,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};
    listeners.get('click')(event);
  };
  const ctrl={originProfile:'alice',navGeneration:7};
  state.pathname='/alice/status/71/photo/1';
  try{
    const result=await proto.tryNativeInModalNavigation.call(ctrl,ref('/alice/status/72/photo/1'),link,viewer,7);
    assert.equal(result,'fallback');
    assert.ok(delays.reduce((a,b)=>a+b,0)<=100,'an unclaimed native click should not impose the full 300ms wait');
    assert.equal(listeners.size,0,'the safety listener still detaches');
  }finally{
    context.Node=oldNode;context.window.addEventListener=oldAdd;
    context.window.removeEventListener=oldRemove;context.window.setTimeout=oldSet;
    state.pathname='/alice/media';
  }
});

test('ignored in-modal route attempts fall back once without guessing a URL', async () => {
  state.pathname='/alice/status/11/photo/1';
  const oldSet=context.window.setTimeout;
  const timers=[];
  context.window.setTimeout=(fn,ms)=>{timers.push(ms);fn();return 3;};
  const viewer={isConnected:true};
  let closes=0, clicks=0;
  const link={isConnected:true,getAttribute(){return '/alice/status/22/photo/1';},
    click(){clicks++;if(closes)state.pathname='/alice/status/22/photo/1';}};
  const ctrl=Object.assign(Object.create(proto),{
    viewer,originProfile:'alice',navGeneration:5,navigationBusy:false,
    refs:[ref('/alice/status/11/photo/1'),ref('/alice/status/22/photo/1')],
    activeIndex(){return 0;},findLiveLink(){return link;},updateViewerState(){},
    findCloseButton(){return {click(){closes++;viewer.isConnected=false;state.pathname='/alice/media';}};},
    async waitForViewerToClose(){return true;},toast(m){throw Error(m);},
  });
  try{
    await proto.navigate.call(ctrl,1);
    assert.equal(closes,1,'fallback must close only after trying the in-modal link');
    assert.equal(clicks,2,'one bounded attempt and one ordinary reopened link');
    assert.ok(timers.length<=6,'do not stall the viewer with long probes');
  }finally{state.pathname='/alice/media';context.window.setTimeout=oldSet;}
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

test('handoff detects a closed X modal within a short polling interval', async () => {
  const oldQuery=document.querySelector,oldSet=context.window.setTimeout;
  const viewer={isConnected:true},delays=[];
  document.querySelector=(selector)=>selector==='[data-testid="swipe-to-dismiss"]'
    ? viewer : oldQuery(selector);
  context.window.setTimeout=(fn,ms)=>{delays.push(ms);viewer.isConnected=false;fn();return 5;};
  try {
    assert.equal(await proto.waitForViewerToClose.call({},viewer),true);
    assert.ok(delays[0]<=50,'125ms polling leaves a visible blank gap after X closes');
  } finally {
    document.querySelector=oldQuery;context.window.setTimeout=oldSet;
  }
});

test('native SPA succeeds even when X omits its modal close control', async () => {
  state.pathname='/alice/status/11/photo/1';
  const viewer={isConnected:true},dest=ref('/alice/status/22/photo/1');
  let calls=0,notices=0;
  const ctrl=Object.assign(Object.create(proto),{
    navigationBusy:false,navGeneration:2,originProfile:'alice',viewer,
    refs:[ref('/alice/status/11/photo/1'),dest],
    activeIndex(){return 0;},findLiveLink(){return {isConnected:true}},
    findCloseButton(){return null;},updateViewerState(){},
    tryNativeInModalNavigation:async()=>{calls++;state.pathname='/alice/status/22/photo/1';return 'retained';},
    toast(){notices++;},
  });
  try {
    await proto.navigate.call(ctrl,1);
    assert.equal(calls,1,'SPA route does not depend on the availability of a close button');
    assert.equal(notices,0);
  } finally {state.pathname='/alice/media';}
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

test('loading more photos from the SAME post does not invent a next post or scroll', async () => {
  const prior=state.pathname;
  state.pathname='/alice/status/11/photo/1';
  const viewer={isConnected:true},messages=[];
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice',viewer,refs:[
      ref('/alice/status/11/photo/1'),ref('/alice/status/11/photo/2')],
    activeIndex(){return 0;},navGeneration:5,navigationBusy:false,
    findCloseButton(){throw Error('never close');},
    toast(m){messages.push(m);},
  });
  try {
    await proto.navigate.call(ctrl,1);
    assert.equal(messages.length,1);
    ctrl.refs.push(ref('/alice/status/11/photo/3'));
    await proto.navigate.call(ctrl,1);
    assert.equal(messages.length,2,'new same-post photo is not a new post');
    assert.equal(viewer.isConnected,true);
  }finally{state.pathname=prior;}
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
  const instance=Object.assign(Object.create(proto),{originProfile:'alice',pendingGrid:null,refs:[],indexes:new Map(),imageSources:new Map()});
  proto.scanTiles.call(instance);
  assert.equal(instance.refs.length,145);
  assert.equal(instance.imageSources.size,128);
  assert.ok(!instance.imageSources.has(ref('/alice/status/300/photo/1').key));
  assert.ok(instance.imageSources.has(ref('/alice/status/444/photo/1').key));
});


test('Navigation API event schedules an immediate coalesced route scan', () => {
  const priorNav=context.window.navigation, priorSet=context.window.setTimeout;
  const previousPath=state.pathname, previousSearch=state.search;
  const callbacks=new Map(), scheduled=[];
  context.window.navigation={addEventListener(type,fn){callbacks.set(type,fn);}};
  context.window.setTimeout=(fn,delay)=>{scheduled.push({fn,delay});return scheduled.length;};
  const visited=[];
  const ctrl=Object.assign(Object.create(proto),{
    observedRouteKey:'/alice/status/11/photo/1',routeTickTimer:null,
    tick(){visited.push(state.pathname+state.search);},
  });
  try {
    assert.equal(proto.installRouteObserver.call(ctrl),true,'Navigation API is preferred without new permissions');
    assert.equal(callbacks.has('currententrychange'),true);
    state.pathname='/alice/status/11/photo/2';
    callbacks.get('currententrychange')();
    callbacks.get('currententrychange')();
    assert.equal(scheduled.length,1,'multiple same-route events are coalesced');
    assert.equal(scheduled[0].delay,0,'do not wait for the 450ms safety poll');
    scheduled[0].fn();
    assert.deepEqual(visited,['/alice/status/11/photo/2']);
    state.search='?filter=photo';
    callbacks.get('currententrychange')();
    assert.equal(scheduled.length,2,'query-only SPA filter changes also trigger a scan');
    scheduled[1].fn();
    assert.deepEqual(visited,['/alice/status/11/photo/2','/alice/status/11/photo/2?filter=photo']);
  } finally {
    context.window.navigation=priorNav;context.window.setTimeout=priorSet;
    state.pathname=previousPath;state.search=previousSearch;
  }
});

test('Navigation API unsupported safely preserves the 450ms polling fallback', () => {
  const priorNav=context.window.navigation;
  const priorAdd=context.window.addEventListener;
  const callbacks=new Map();
  context.window.navigation=undefined;
  context.window.addEventListener=(type,fn)=>callbacks.set(type,fn);
  const ctrl=Object.create(proto);
  try {
    assert.equal(proto.installRouteObserver.call(ctrl),false);
    assert.equal(callbacks.has('popstate'),true,'native Back should still get an immediate route check');
  }finally{
    context.window.navigation=priorNav;context.window.addEventListener=priorAdd;
  }
});

test('a route event during native SPA navigation cannot close the modal prematurely', () => {
  const oldSet=context.window.setTimeout;
  const previousPath=state.pathname;
  const queue=[];
  context.window.setTimeout=(fn,delay)=>{queue.push({fn,delay});return queue.length;};
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice',navigationBusy:true,routeTickTimer:null,observedRouteKey:'/alice/status/11/photo/1',
    tick(){throw Error('must not run a full DOM reconciliation while X route is still in-flight');},
  });
  try{
    state.pathname='/alice/status/22/photo/1';
    proto.scheduleRouteTick.call(ctrl);
    assert.equal(queue.length,1);
    queue[0].fn();
    assert.equal(ctrl.routeTickTimer,null);
  }finally{context.window.setTimeout=oldSet;state.pathname=previousPath;}
});

test('Navigation URL event before modal mount never removes the visible old controls', () => {
  const oldSet=context.window.setTimeout, oldPath=state.pathname;
  const oldQuery=document.querySelector, queue=[];
  context.window.setTimeout=(fn,ms)=>{queue.push(fn);return queue.length;};
  document.querySelector=()=>null;
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice',observedRouteKey:'/alice/status/11/photo/1',
    routeTickTimer:null,navigationBusy:false,
    tick(){throw Error('a route event must not tear down controls before X mounts its new viewer');},
  });
  try {
    state.pathname='/alice/status/22/photo/1';
    proto.scheduleRouteTick.call(ctrl);
    assert.equal(queue.length,1);
    queue[0]();
    assert.equal(ctrl.routeTickTimer,null);
  }finally{
    state.pathname=oldPath;context.window.setTimeout=oldSet;
    document.querySelector=oldQuery;
  }
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


test('stale timeline index falls back to exact live media key without skipping posts', () => {
  const oldPath=state.pathname;
  const refs=[
    ref('/alice/status/21/photo/1'),
    ref('/alice/status/22/photo/1'),
    ref('/alice/status/22/photo/2'),
    ref('/alice/status/23/photo/1'),
  ];
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice',refs,
    indexes:new Map([[refs[2].key,1]]), // simulated stale index, points to another photo
  });
  state.pathname=refs[2].href;
  try {
    assert.equal(proto.activeIndex.call(ctrl),2,'never return an index whose key disagrees with the route');
  }finally{state.pathname=oldPath;}
});

test('ordinal cache preserves first-seen ordering for repeated post groups', () => {
  const oldPath=state.pathname;
  const refs=[
    ref('/alice/status/21/photo/1'),
    ref('/alice/status/21/photo/2'),
    ref('/alice/status/22/photo/1'),
    ref('/alice/status/21/photo/3'),
    ref('/alice/status/23/photo/1'),
  ];
  const label={textContent:''},prev={disabled:false},next={disabled:false};
  const viewer={querySelector(sel){
    return sel==='.xmn-prev'?prev:sel==='.xmn-next'?next:sel==='.xmn-status'?label:null;
  }};
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice',refs,viewer,navigationBusy:false,
    activeIndex(){return refs.findIndex(ref=>ref.href===state.pathname);},
  });
  try {
    for(const [i,expected] of [[0,'投稿 1 / 3'],[2,'投稿 2 / 3'],
        [3,'投稿 1 / 3'],[4,'投稿 3 / 3']]){
      state.pathname=refs[i].href;
      proto.updateViewerState.call(ctrl);
      assert.equal(label.textContent,expected);
    }
  }finally{state.pathname=oldPath;}
});

test('indexed current photo on a 3000-entry media timeline avoids linear position scans', () => {
  const previousPath=state.pathname,originalRefs=Array.from({length:3000},(_,i)=>
    ref('/alice/status/'+(10000+i)+'/photo/1'));
  const targetIndex=2468,target=originalRefs[targetIndex];
  let reads=0;
  const watched=new Proxy(originalRefs,{
    get(arr,key,receiver){
      if(typeof key==='string' && /^\d+$/.test(key)){
        reads++;
        if(reads>5) throw Error('unexpected linear scan of a pre-indexed media timeline');
      }
      return Reflect.get(arr,key,receiver);
    },
  });
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice',refs:watched,indexes:new Map([[target.key,targetIndex]]),
  });
  state.pathname=target.href;
  try{
    assert.equal(proto.activeIndex.call(ctrl),targetIndex);
    assert.ok(reads<=5);
  }finally{state.pathname=previousPath;}
});

test('post position labels reuse ordinal lookup across route changes in a long timeline', () => {
  const previous=state.pathname;
  const refs=Array.from({length:2000},(_,i)=>ref('/alice/status/'+(1000+i)+'/photo/1'));
  const prev={disabled:false},next={disabled:false},status={textContent:''};
  const viewer={querySelector(sel){
    return sel==='.xmn-prev'?prev:sel==='.xmn-next'?next:sel==='.xmn-status'?status:null;
  }};
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice',viewer,refs,navigationBusy:false,
    activeIndex(){const id=Number(state.pathname.match(/status\/(\d+)/)?.[1]);return id===9999?2000:id-1000;},
  });
  try{
    state.pathname=refs[0].href;
    proto.updateViewerState.call(ctrl);
    assert.equal(status.textContent,'投稿 1 / 2000');
    refs.map=()=>{throw Error('duplicate list must not be rebuilt on route changes')};
    for(const i of [1,500,999,1999]){
      state.pathname=refs[i].href;
      proto.updateViewerState.call(ctrl);
      assert.equal(status.textContent,`投稿 ${i+1} / 2000`);
    }
    refs.push(ref('/alice/status/9999/photo/1'));
    state.pathname=refs[2000].href;
    proto.updateViewerState.call(ctrl);
    assert.equal(status.textContent,'投稿 2001 / 2001',
      'a newly indexed media entry invalidates cached ordinal count');
  }finally{state.pathname=previous;}
});

test('unchanged modal polling reuses its status view without rescanning a long timeline', () => {
  const previous=state.pathname;
  state.pathname='/alice/status/520/photo/1';
  const prev={disabled:false}, next={disabled:false}, label={textContent:''};
  const viewer={isConnected:true,querySelector(s){
    return s==='.xmn-prev'?prev:s==='.xmn-next'?next:s==='.xmn-status'?label:null;
  }};
  let scans=0;
  const ctrl=Object.assign(Object.create(proto),{
    viewer,originProfile:'alice',navigationBusy:false,
    refs:Array.from({length:1200},(_,i)=>ref('/alice/status/'+(520+i)+'/photo/1')),
    activeIndex(){scans++;return 0;},
  });
  try {
    proto.updateViewerState.call(ctrl);
    for(let i=0;i<30;i++) proto.updateViewerState.call(ctrl);
    assert.equal(scans,1,'unchanged 450ms ticks must not repeatedly inspect 1200 media entries');
    state.pathname='/alice/status/521/photo/1';
    proto.updateViewerState.call(ctrl); assert.equal(scans,2,'route change refreshes buttons');
    ctrl.navigationBusy=true;
    proto.updateViewerState.call(ctrl); assert.equal(scans,3,'busy state changes refresh buttons');
    ctrl.refs.push(ref('/alice/status/99999/photo/1'));
    proto.updateViewerState.call(ctrl); assert.equal(scans,4,'new media item refreshes position');
  } finally {state.pathname=previous;}
});

test('page-to-page carousel animation never moves the post arrows from the original photo pane', () => {
  const oldPath=state.pathname;
  const oldW=context.window.innerWidth,oldH=context.window.innerHeight;
  context.window.innerWidth=1536; context.window.innerHeight=900;
  let samples=0;
  const viewer={getBoundingClientRect(){
    const shift=samples++ * 11;
    return {left:16+shift,top:90+shift,width:1010-2*shift,height:760-shift,
      right:1026-shift,bottom:850};
  }};
  const host={style:{}};
  const ctrl=Object.assign(Object.create(proto),{
    controlsHost:host,controlsGeometryKey:'',controlsLayoutPath:'',
  });
  try {
    state.pathname='/alice/status/100/photo/1';
    proto.positionControls.call(ctrl,viewer);
    const original=[host.style.left,host.style.top,host.style.width,host.style.height];
    for(let i=0;i<14;i++){
      state.pathname='/alice/status/'+(101+i)+'/photo/1';
      proto.positionControls.call(ctrl,viewer);
      assert.deepEqual([host.style.left,host.style.top,host.style.width,host.style.height],original,
        'transient viewer geometry must not accumulate as arrow drift');
    }
    assert.ok(samples<=2,'do not repeatedly force layout for an unchanged media-pane viewport');
  } finally {
    state.pathname=oldPath;context.window.innerWidth=oldW;context.window.innerHeight=oldH;
  }
});

test('React replacing a detached viewer does not discard the fixed pane anchor', () => {
  const oldPath=state.pathname;
  const anchor={left:16,top:90,width:1000,height:760,
    viewportWidth:1536,viewportHeight:900,fullscreenRoot:null};
  let removals=0;
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice',navigationBusy:false,viewer:null,rightProbeTimer:null,
    controlsPaneAnchor:anchor,controlsHost:{remove(){removals++;}},
    controlsGeometryKey:'16,90,1000,760',controlsLayoutPath:'/alice/status/19/photo/1',
  });
  try {
    state.pathname='/alice/status/20/photo/1';
    proto.removeViewerUI.call(ctrl);
    assert.equal(ctrl.controlsPaneAnchor,anchor,
      'post-to-post DOM teardown must not erase the stable pane geometry');
    assert.equal(removals,1);
    ctrl.controlsHost=null;
    state.pathname='/alice/media';
    proto.removeViewerUI.call(ctrl);
    assert.equal(ctrl.controlsPaneAnchor,null,'explicit modal close should allow fresh geometry');
  }finally{state.pathname=oldPath;}
});

test('React removing the old carousel slide before mounting the next preserves one post-control layer', () => {
  const oldObserver=context.MutationObserver;
  context.MutationObserver=class { observe(){} disconnect(){} };
  const dialog=new FakeElement('div');
  const detached=new FakeElement('div'),next=new FakeElement('div');
  detached.closest=()=>null; // React already removed its parent chain
  next.closest=s=>s==='[role="dialog"]'?dialog:null;
  const preserves=[];
  const ctrl=Object.assign(Object.create(proto),{
    viewer:detached,controlsDialog:dialog,controlsHost:{isConnected:true},
    removeViewerUI(preserve){preserves.push(preserve);this.viewer=null;},
    ensureViewerButtons(){},finishVisualHandoff(){},
  });
  try {
    proto.syncViewer.call(ctrl,next);
    assert.deepEqual(preserves,[true],'do not rebuild buttons while X retains the same dialog');
    assert.equal(ctrl.viewer,next);
  }finally{context.MutationObserver=oldObserver;}
});

test('a real viewport resize deliberately refreshes the otherwise fixed photo-pane anchor', () => {
  const oldW=context.window.innerWidth,oldH=context.window.innerHeight;
  context.window.innerWidth=1536;context.window.innerHeight=900;
  const host={style:{}};
  let rect={left:12,top:90,right:1012,bottom:850,width:1000,height:760};
  const viewer={getBoundingClientRect(){return rect;}};
  const ctrl=Object.assign(Object.create(proto),{controlsHost:host,controlsGeometryKey:'',controlsLayoutPath:''});
  try {
    proto.positionControls.call(ctrl,viewer);
    assert.equal(host.style.left,'12px');
    context.window.innerWidth=1250;context.window.innerHeight=760;
    rect={left:8,top:70,right:850,bottom:700,width:842,height:630};
    proto.positionControls.call(ctrl,viewer);
    assert.equal(host.style.left,'8px');
    assert.equal(host.style.width,'842px');
    assert.equal(host.style.top,'70px');
  }finally{context.window.innerWidth=oldW;context.window.innerHeight=oldH;}
});

test('fullscreen root changes re-anchor arrows even without viewport dimension changes', () => {
  const oldRoot=document.fullscreenElement;
  const oldW=context.window.innerWidth,oldH=context.window.innerHeight;
  context.window.innerWidth=1280;context.window.innerHeight=800;
  const fullscreen=new FakeElement('div');
  const host={style:{}};
  let rect={left:12,top:60,right:900,bottom:760,width:888,height:700};
  const viewer={getBoundingClientRect(){return rect;}};
  const ctrl=Object.assign(Object.create(proto),{controlsHost:host,controlsGeometryKey:'',controlsPaneAnchor:null});
  try {
    document.fullscreenElement=null;
    proto.positionControls.call(ctrl,viewer);
    assert.equal(host.style.top,'60px');
    document.fullscreenElement=fullscreen;
    rect={left:0,top:0,right:1180,bottom:790,width:1180,height:790};
    proto.positionControls.call(ctrl,viewer);
    assert.equal(host.style.top,'0px');
    assert.equal(ctrl.controlsPaneAnchor.fullscreenRoot,fullscreen);
  }finally{
    document.fullscreenElement=oldRoot;context.window.innerWidth=oldW;context.window.innerHeight=oldH;
  }
});

test('replaced modal indicator invalidates idle status cache and refreshes safely', () => {
  const oldPath=state.pathname,oldCreate=document.createElement;
  state.pathname='/alice/status/78/photo/1';
  const prev={disabled:false},next={disabled:false};
  let status={textContent:''},calls=0;
  const viewer={isConnected:true,querySelector(s){
    return s==='.xmn-prev'?prev:s==='.xmn-next'?next:s==='.xmn-status'?status:null;
  },appendChild(el){status=el;return el;}};
  const ctrl=Object.assign(Object.create(proto),{
    viewer,originProfile:'alice',refs:[ref('/alice/status/78/photo/1')],
    navigationBusy:false,activeIndex(){calls++;return 0;},schedulePreload(){},
  });
  document.createElement=tag=>new FakeElement(tag);
  try {
    proto.updateViewerState.call(ctrl);
    assert.equal(calls,1);
    status=null; // X remounted the indicator without changing the route
    proto.ensureViewerButtons.call(ctrl);
    assert.equal(calls,2,'newly attached controls require a real state update');
    assert.equal(status.textContent,'投稿 1 / 1');
  }finally{state.pathname=oldPath;document.createElement=oldCreate;}
});

test('active photo lookup avoids building temporary per-item objects for missing exact links', () => {
  const previous=state.pathname;
  state.pathname='/alice/status/77/photo/2';
  const refs=[ref('/alice/status/77/photo/1'),ref('/alice/status/88/photo/1')];
  refs.map=()=>{throw Error('an O(N) temporary object array must not be built')};
  const ctrl=Object.assign(Object.create(proto),{originProfile:'alice',refs});
  try {assert.equal(proto.activeIndex.call(ctrl),0);}
  finally{state.pathname=previous;}
});

test('recycled tile prefetches newly assigned src rather than stale previous currentSrc', () => {
  const entry=ref('/alice/status/222/photo/1');
  const old='https://pbs.twimg.com/media/OLDPHOTO?format=jpg&name=small';
  const next='https://pbs.twimg.com/media/NEWPHOTO?name=thumb&format=jpg';
  const img={src:next,currentSrc:old,complete:false,naturalWidth:0};
  const link={querySelector(){return img;}};
  const tile={querySelectorAll(){throw Error('owned image must not search outside its anchor')}};
  const ctrl=Object.assign(Object.create(proto),{imageSources:new Map(),imageSourcesRevision:0});
  proto.recordTileImageSource.call(ctrl,tile,{link,ref:entry});
  assert.equal(ctrl.imageSources.get(entry.key),
    'https://pbs.twimg.com/media/NEWPHOTO?format=jpg&name=large',
    'prefetch must not use the old visible media from a recycled tile');
});

test('late currentSrc completion does not churn image-source revision or prefetch queues', () => {
  const entry=ref('/alice/status/224/photo/1');
  const next='https://pbs.twimg.com/media/ASSIGNED?format=webp&name=small';
  const image={src:next,currentSrc:'https://pbs.twimg.com/media/PREVIOUS?format=jpg&name=small',
    complete:false,naturalWidth:0};
  const ctrl=Object.assign(Object.create(proto),{imageSources:new Map(),imageSourcesRevision:0});
  const found={ref:entry,link:{querySelector(){return image;}}};
  proto.recordTileImageSource.call(ctrl,{},found);
  assert.equal(ctrl.imageSourcesRevision,1);
  const stored=ctrl.imageSources.get(entry.key);
  image.currentSrc=next;image.complete=true;image.naturalWidth=900;
  proto.recordTileImageSource.call(ctrl,{},found);
  assert.equal(ctrl.imageSourcesRevision,1,
    'when X finishes rendering the assigned photo, its canonical CDN URL remains unchanged');
  assert.equal(ctrl.imageSources.get(entry.key),stored);
});

test('a loaded srcset candidate takes precedence over an unrelated fallback src', () => {
  const entry=ref('/alice/status/223/photo/1');
  const old='https://pbs.twimg.com/media/FALLBACK?format=jpg&name=large';
  const current='https://pbs.twimg.com/media/ACTUAL?format=webp&name=small';
  const img={src:old,currentSrc:current,complete:true,naturalWidth:800};
  const ctrl=Object.assign(Object.create(proto),{imageSources:new Map(),imageSourcesRevision:0});
  proto.recordTileImageSource.call(ctrl,{}, {link:{querySelector(){return img;}},ref:entry});
  assert.equal(ctrl.imageSources.get(entry.key),
    'https://pbs.twimg.com/media/ACTUAL?format=webp&name=large',
    'use the actual loaded srcset candidate rather than an unrelated fallback');
});

test('an owned thumbnail avoids searching the surrounding tile for images again', () => {
  const entry=ref('/alice/status/18/photo/1');
  const image={currentSrc:'https://pbs.twimg.com/media/OWNED?format=jpg&name=small',src:''};
  const link={querySelector(){return image;}};
  const tile={querySelectorAll(){throw Error('tile-wide image query is redundant when link owns its thumbnail')}};
  const ctrl=Object.assign(Object.create(proto),{imageSources:new Map(),imageSourcesRevision:0});
  proto.recordTileImageSource.call(ctrl,tile,{link,ref:entry});
  assert.equal(ctrl.imageSources.get(entry.key),'https://pbs.twimg.com/media/OWNED?format=jpg&name=large');
});

test('unknown next post never closes X viewer or scrolls the background timeline', async () => {
  const prior=state.pathname, oldScroll=context.window.scrollTo;
  state.pathname='/alice/status/100/photo/1';
  const clicks=[],messages=[];
  const viewer={isConnected:true};
  context.window.scrollTo=()=>{throw Error('background scroll must never run on ArrowRight');};
  const ctrl=Object.assign(Object.create(proto),{
    navigationBusy:false,navGeneration:6,originProfile:'alice',
    viewer,originTimeline:'alice|photo',
    refs:[ref('/alice/status/100/photo/1')],activeIndex(){return 0;},
    findCloseButton(){throw Error('do not even query close button without a known destination');},
    captureGrid(){throw Error('do not inspect background media grid');},
    findLiveLink(){throw Error('no destination to resolve');},
    toast(m){messages.push(m);},updateViewerState(){clicks.push('redraw');},
    loadNextPost(){throw Error('no automatic lazy-load scroll');},
  });
  try {
    await proto.navigate.call(ctrl,1);
    assert.equal(viewer.isConnected,true,'current native viewer stays open');
    assert.equal(ctrl.navigationBusy,false,'do not block other shortcuts');
    assert.equal(state.pathname,'/alice/status/100/photo/1');
    assert.equal(clicks.length,0,'no transient disabled controls or React rerenders');
    assert.equal(messages.length,1);
    assert.match(messages[0],/読み込み済み|一覧/,'plain explanation instead of silent no-op');
  } finally {state.pathname=prior;context.window.scrollTo=oldScroll;}
});

test('when X naturally adds the next post later the arrow resumes without scrolling', async () => {
  const prior=state.pathname;
  state.pathname='/alice/status/100/photo/1';
  const current=ref('/alice/status/100/photo/1');
  const next=ref('/alice/status/200/photo/1');
  const clicks=[],toasts=[];
  const viewer={isConnected:true};
  const ctrl=Object.assign(Object.create(proto),{
    navigationBusy:false,navGeneration:9,originProfile:'alice',
    originTimeline:'alice|photo',viewer,refs:[current],
    activeIndex(){return 0;},
    findCloseButton(){return {click(){throw Error('successful in-modal route should not close');}};},
    findLiveLink(ref){return ref.key===next.key?{isConnected:true}:null;},
    beginVisualHandoff(){return false;},
    tryNativeInModalNavigation:async()=>{state.pathname=next.href;clicks.push('native');return 'retained';},
    toast(m){toasts.push(m);},updateViewerState(){},
    findActiveViewer(){return viewer;},
  });
  try {
    await proto.navigate.call(ctrl,1);
    assert.equal(toasts.length,1);
    ctrl.refs.push(next);
    await proto.navigate.call(ctrl,1);
    assert.equal(state.pathname,next.href);
    assert.deepEqual(clicks,['native']);
    assert.equal(viewer.isConnected,true);
    assert.equal(ctrl.navigationBusy,false);
  } finally {state.pathname=prior;}
});

test('native gallery ArrowRight at the end cannot produce a background scroll', async () => {
  const prior=state.pathname;
  state.pathname='/alice/status/100/photo/1';
  const calls=[];
  const instance=Object.assign(Object.create(proto),{
    viewer:{isConnected:true},originProfile:'alice',navigationBusy:false,
    navGeneration:4,refs:[ref('/alice/status/100/photo/1')],
    activeIndex(){return 0;},photoCount(){return 1;},
    nativeGalleryArrowAvailable(){return false;},
    toast(message){calls.push(message);},
    findCloseButton(){throw Error('must not close X modal');},
  });
  try {
    const ev=keyEvent('ArrowRight');
    proto.onKeyDown.call(instance,ev);
    assert.equal(ev.prevented,true,'confirmed album edge belongs to post navigation');
    await Promise.resolve();await Promise.resolve();
    assert.equal(calls.length,1,'do not start hidden background loading');
  } finally {state.pathname=prior;}
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

test('unknown gallery boundary never skips a still-unverified photo, even after a repeated right key', () => {
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
  assert.match(notices[0],/Xの操作を優先/,'an unverified image must not ask for a second arrow');
  assert.equal(directions.length,0,'no navigation on unverified first photo');
  const second=keyEvent('ArrowRight');proto.onKeyDown.call(controller,second);
  assert.equal(second.prevented,false,'unverified photo keeps native X controls on repeated input');
  assert.deepEqual(directions,[],'an unready photo must not be skipped by manual confirmation');
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
  assert.equal(delayed,null,'a known later /photo/2 prevents any automatic post probe');
  state.pathname='/alice/status/100/photo/2';
  assert.deepEqual(navigations,[],'a known later image must never be skipped');
  assert.deepEqual(notes,[]);
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

test('known destination survives filter normalization without background grid snapshots', async () => {
  const prior=state.pathname,priorSearch=state.search;
  state.pathname='/alice/status/100/photo/1';state.search='?filter=photo';
  const viewer={isConnected:true};const clicks=[];
  const source={isConnected:true,click(){clicks.push('next');}};
  const ctrl=Object.assign(Object.create(proto),{
    navigationBusy:false,navGeneration:3,originProfile:'alice',originTimeline:'alice|photo',
    viewer,refs:[ref('/alice/status/100/photo/1'),ref('/alice/status/101/photo/1')],
    activeIndex(){return 0;},updateViewerState(){},
    captureGrid(){throw Error('known post must not snapshot background media grid');},
    findLiveLink(item){return item.statusId==='101'?source:null;},
    async tryNativeInModalNavigation(){return 'fallback';},
    beginVisualHandoff(){return false;},
    findCloseButton(){return {click(){
      viewer.isConnected=false;state.pathname='/alice/media';state.search='';
    }};},
    waitForViewerToClose:async()=>true,
    toast(m){throw Error(m);},
  });
  try {
    await proto.navigate.call(ctrl,1);
    assert.deepEqual(clicks,['next']);
    assert.equal(ctrl.navigationBusy,false);
  }finally{state.pathname=prior;state.search=priorSearch;}
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

test('new posts loaded by natural X scrolling become navigable without extension scrolling', () => {
  const prior=state.pathname,priorRoot=state.root;
  state.pathname='/alice/media';
  const first=makeTile('/alice/status/101/photo/1');
  const second=makeTile('/alice/status/102/photo/1');
  first.tile.scrollIntoView=()=>{throw Error('extension must not auto-scroll');};
  second.tile.scrollIntoView=()=>{throw Error('extension must not auto-scroll');};
  state.root=new FakeElement('div');state.root.tiles=[first.tile];
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice',pendingGrid:null,refs:[],indexes:new Map(),imageSources:new Map(),
  });
  try{
    proto.scanTiles.call(ctrl);
    assert.equal(ctrl.refs.length,1);
    assert.equal(context.XMN.adjacentPostIndex(ctrl.refs,'101',1,0),null);
    // Only X/user-driven timeline growth is ingested; no automatic scroll.
    state.root.tiles.push(second.tile);
    proto.scanTiles.call(ctrl);
    assert.equal(ctrl.refs.length,2);
    assert.equal(context.XMN.adjacentPostIndex(ctrl.refs,'101',1,0),1);
    assert.equal(ctrl.refs[1].href,'/alice/status/102/photo/1');
  }finally{state.pathname=prior;state.root=priorRoot;}
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
  const instance=Object.assign(Object.create(proto),{originProfile:'alice',pendingGrid:null,refs:[],indexes:new Map(),imageSources:new Map()});
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
  const instance=Object.assign(Object.create(proto),{originProfile:'alice',pendingGrid:null,refs:[],indexes:new Map(),imageSources:new Map()});
  proto.scanTiles.call(instance);
  assert.deepEqual(instance.refs.map((x)=>x.statusId),['630']);
  assert.equal(generic.children.length,0,'status-only text without media is not a media tile');
  state.root=null;
});
test('lookahead warms the second photo of the nearest next post within five slots', () => {
  const oldNav=context.navigator;
  context.navigator={onLine:true,connection:{saveData:false,effectiveType:'4g'},deviceMemory:8};
  document.hidden=false;
  const urls=['/alice/status/10/photo/1','/alice/status/20/photo/1',
    '/alice/status/20/photo/2','/alice/status/20/photo/3',
    '/alice/status/30/photo/1','/alice/status/40/photo/1',
    '/alice/status/50/photo/1'].map(ref);
  const sources=urls.map((x,i)=>'https://pbs.twimg.com/media/MULTI'+i+'?format=jpg&name=large');
  const ctrl=Object.assign(Object.create(proto),{
    viewer:{isConnected:true},originProfile:'alice',refs:urls,
    activeIndex(){return 0;},imageSources:new Map(urls.map((r,i)=>[r.key,sources[i]])),
    prefetched:new Map(),prefetchFailed:new Set(),prefetchTooLarge:new Set(),
    prefetchWanted:new Set(),prefetchQueue:[],prefetchInFlight:0,
    drainPrefetchQueue(){},
  });
  const old=state.pathname;state.pathname='/alice/status/10/photo/1';
  try{
    proto.preloadAdjacentImages.call(ctrl);
    assert.equal(ctrl.prefetchWanted.size,5,'do not exceed five images');
    assert.ok(ctrl.prefetchWanted.has(sources[1]),'next post photo 1');
    assert.ok(ctrl.prefetchWanted.has(sources[2]),'next post photo 2 should be warmed before navigation');
    assert.ok(ctrl.prefetchWanted.has(sources[4]),'another adjacent post must remain available');
  }finally{context.navigator=oldNav;state.pathname=old;}
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

test('loaded matching CDN thumbnail becomes a bounded canvas preview without network', () => {
  const oldCreate=document.createElement;
  const oldImage=context.Image;
  const target=ref('/alice/status/44/photo/1');
  const source='https://pbs.twimg.com/media/PHOTOFOR44?format=jpg&name=small';
  const img={src:source,currentSrc:source,complete:true,
    naturalWidth:640,naturalHeight:420};
  const link={isConnected:true,getAttribute(n){return n==='href'?target.href:null;},
    querySelector(){return img;}};
  const draws=[],created=[];
  document.createElement=tag=>{
    created.push(tag);
    if(tag!=='canvas') throw Error('preview must not allocate images or wrappers');
    return {width:0,height:0,getContext(name,opts){
      assert.equal(name,'2d');
      return {drawImage(...args){draws.push(args);}};
    },classList:{add(){} }};
  };
  context.Image=class {constructor(){throw Error('no new CDN Image request permitted');}};
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice',imageSources:new Map([[
      target.key,'https://pbs.twimg.com/media/PHOTOFOR44?format=jpg&name=large',
    ]]),
  });
  try{
    const canvas=proto.captureLowQualityThumbnail.call(ctrl,target,link);
    assert.ok(canvas,'existing thumbnail should be captured');
    assert.ok(canvas.width>0 && canvas.width<=256);
    assert.ok(canvas.height>0 && canvas.height<=256);
    assert.equal(draws.length,1);
    assert.equal(draws[0][0],img);
    assert.deepEqual(created,['canvas'],'no additional image resource fetch');
  }finally{document.createElement=oldCreate;context.Image=oldImage;}
});

test('low-quality snapshot rejects unrelated, unready and stale recycled thumbnails', () => {
  const oldCreate=document.createElement;
  const target=ref('/alice/status/55/photo/1');
  const next='https://pbs.twimg.com/media/RIGHT55?format=jpg&name=small';
  const prior='https://pbs.twimg.com/media/WRONG55?format=jpg&name=small';
  const img={src:next,currentSrc:prior,complete:false,naturalWidth:0,naturalHeight:0};
  let draws=0;
  document.createElement=tag=>{
    assert.equal(tag,'canvas');
    return {width:0,height:0,classList:{add(){}},getContext(){return {drawImage(){draws++;}};}};
  };
  const link={isConnected:true,getAttribute(n){return n==='href'?target.href:null;},
    querySelector(){return img;}};
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice',imageSources:new Map([[target.key,
      'https://pbs.twimg.com/media/RIGHT55?format=jpg&name=large']]),
  });
  try{
    assert.equal(proto.captureLowQualityThumbnail.call(ctrl,target,link),null);
    img.complete=true;img.naturalWidth=128;img.naturalHeight=96;
    assert.equal(proto.captureLowQualityThumbnail.call(ctrl,target,link),null,
      'a completed thumbnail of the wrong identity must not be displayed');
    img.currentSrc=next;
    link.getAttribute=()=>'/alice/status/999/photo/1';
    assert.equal(proto.captureLowQualityThumbnail.call(ctrl,target,link),null,
      'a recycled link that changed its target cannot be captured');
    link.getAttribute=n=>n==='href'?target.href:null;
    assert.ok(proto.captureLowQualityThumbnail.call(ctrl,target,link));
    assert.equal(draws,1,'only correct decoded image is rendered');
  }finally{document.createElement=oldCreate;}
});

test('unready large photo can use decoded grid thumbnail as a hidden SPA handoff', () => {
  const oldBody=document.body,oldCreate=document.createElement;
  const oldSet=context.window.setTimeout,oldClear=context.window.clearTimeout;
  const oldMatch=context.window.matchMedia,oldWidth=context.window.innerWidth;
  const timers=new Map();let nextTimer=1;
  context.window.setTimeout=(fn,ms)=>{const id=nextTimer++;timers.set(id,{fn,ms});return id;};
  context.window.clearTimeout=id=>timers.delete(id);
  context.window.matchMedia=()=>({matches:false});context.window.innerWidth=1200;
  const target=ref('/alice/status/66/photo/1');
  const url='https://pbs.twimg.com/media/PREVIEW66?format=jpg&name=large';
  const thumb={currentSrc:'https://pbs.twimg.com/media/PREVIEW66?format=jpg&name=small',
    src:'',complete:true,naturalWidth:320,naturalHeight:240};
  const link={isConnected:true,getAttribute(n){return n==='href'?target.href:null;},
    querySelector(){return thumb;}};
  const body={children:[],appendChild(n){this.children.push(n);return n;}};
  document.body=body;
  document.createElement=tag=>{
    const node={tag,children:[],classNames:[],attrs:{},
      classList:{add(name){node.classNames.push(name);}},
      style:{values:new Map(),setProperty(k,v){this.values.set(k,v);}},
      setAttribute(k,v){this.attrs[k]=v;},appendChild(el){this.children.push(el);},
      remove(){body.children=body.children.filter(c=>c!==node);},
      replaceChildren(...children){this.children=children;},
    };
    if(tag==='canvas'){
      node.getContext=()=>({drawImage(){}});
    }
    return node;
  };
  const ctrl=Object.assign(Object.create(proto),{
    navGeneration:3,originProfile:'alice',handoff:null,
    imageSources:new Map([[target.key,url]]),
    prefetched:new Map([[url,{image:{naturalWidth:0},ready:false,loading:true}]]),
    viewer:{getBoundingClientRect:()=>({left:0,top:0,right:720,bottom:610,
      width:720,height:610}),querySelector(){return null;}},
  });
  try{
    assert.equal(proto.beginVisualHandoff.call(ctrl,target,link),true);
    assert.equal(body.children.length,1);
    const host=body.children[0];
    assert.equal(host.children[0].tag,'canvas');
    assert.ok(host.children[0].classNames.includes('xmn-handoff-preview'));
    assert.equal(ctrl.handoff.quality,'low');
    assert.equal(ctrl.handoff.shown,false,'do not show future image before X changes route');
    assert.equal(timers.get(ctrl.handoff.timeout).ms,1800);
    proto.clearVisualHandoff.call(ctrl);
    assert.equal(body.children.length,0);
  }finally{
    document.body=oldBody;document.createElement=oldCreate;
    context.window.setTimeout=oldSet;context.window.clearTimeout=oldClear;
    context.window.matchMedia=oldMatch;context.window.innerWidth=oldWidth;
  }
});

test('decoded full quality prefetch promotes a thumbnail preview without new downloads', () => {
  const thumb={};
  const host={children:[thumb],replaceChildren(...kids){this.children=kids;}};
  const high={naturalWidth:1280};high.classList={add(name){high.className=name;}};
  const url='https://pbs.twimg.com/media/QUALITY77?format=jpg&name=large';
  const ctrl=Object.assign(Object.create(proto),{
    navGeneration:8,
    handoff:{quality:'low',generation:8,host,targetStatus:'77',
      targetMediaIndex:1,targetPhotoIdentity:'QUALITY77',targetPrefetchUrl:url},
    prefetched:new Map([[url,{ready:true,loading:false,image:high,bytes:1250}]]),
  });
  assert.equal(proto.promoteVisualHandoff.call(ctrl),true);
  assert.deepEqual(host.children,[high]);
  assert.equal(ctrl.handoff.quality,'high');
  assert.equal(high.className,'xmn-handoff-image');
  assert.equal(proto.promoteVisualHandoff.call(ctrl),false,'promotion only once');
  const other='https://pbs.twimg.com/media/WRONG?format=jpg&name=large';
  ctrl.handoff.quality='low';
  ctrl.prefetched=new Map([[url,{ready:true,image:high}],
    [other,{ready:true,image:{naturalWidth:2000}}]]);
  assert.equal(proto.promoteVisualHandoff.call(ctrl),true,
    'only the verified exact target URL may promote the placeholder');
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
    proto.finishVisualHandoff.call(ctrl,{isConnected:true,querySelectorAll:()=>[{
      currentSrc:'https://pbs.twimg.com/media/NEXT?format=jpg&name=orig',
      src:'',complete:true,naturalWidth:1,
    }]});
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
test('visual handoff begins its safety expiry only when the old modal has closed', () => {
  const oldSet=context.window.setTimeout,oldClear=context.window.clearTimeout;
  const cleared=[],timers=new Map();
  let next=100;
  context.window.setTimeout=(fn,ms)=>{const id=next++;timers.set(id,{fn,ms});return id;};
  context.window.clearTimeout=(id)=>{cleared.push(id);timers.delete(id);};
  const classes=[];
  const ctrl=Object.assign(Object.create(proto),{
    navGeneration:3,
    handoff:{generation:3,timeout:42,shown:false,
      host:{classList:{add(c){classes.push(c);}},remove(){}},
      revealTimer:null,observer:null,waitingImage:null,waitingLoadHandler:null},
  });
  try {
    proto.showVisualHandoff.call(ctrl);
    assert.ok(cleared.includes(42),'the timer created before modal close must be cleared');
    assert.deepEqual(classes,['xmn-handoff-visible']);
    assert.equal(timers.get(100)?.ms,1800,'a full handoff window remains after modal close');
    proto.showVisualHandoff.call(ctrl);
    assert.equal(timers.size,1,'repeated reveal must not restart the expiry indefinitely');
  } finally {
    context.window.setTimeout=oldSet;context.window.clearTimeout=oldClear;
  }
});

test('five-image prefetch reserves a slot for the nearest previous post', () => {
  const previousNav=context.navigator, oldHidden=document.hidden;
  context.navigator={onLine:true,connection:{saveData:false,effectiveType:'4g'},deviceMemory:8};
  document.hidden=false;
  const refs=Array.from({length:12},(_,i)=>ref('/alice/status/'+(100+i)+'/photo/1'));
  const urls=refs.map((_,i)=>'https://pbs.twimg.com/media/BACK'+i+'?format=jpg&name=large');
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice',viewer:{isConnected:true},refs,navGeneration:4,navigationBusy:false,
    activeIndex(){return 5;},imageSources:new Map(refs.map((item,i)=>[item.key,urls[i]])),
    prefetched:new Map(),prefetchQueue:[],prefetchWanted:new Set(),
    prefetchFailed:new Set(),prefetchTooLarge:new Set(),prefetchInFlight:0,
    drainPrefetchQueue(){},
  });
  state.pathname='/alice/status/105/photo/1';
  try{
    proto.preloadAdjacentImages.call(ctrl);
    assert.equal(ctrl.prefetchWanted.size,5);
    assert.equal(ctrl.prefetchWanted.has(urls[4]),true,'previous post must not be starved by distant future posts');
    assert.equal(ctrl.prefetchWanted.has(urls[6]),true);
    assert.equal(ctrl.prefetchWanted.has(urls[7]),true);
    assert.equal(ctrl.prefetchWanted.has(urls[10]),false,'evict a distant future post instead');
  } finally{context.navigator=previousNav;document.hidden=oldHidden;state.pathname='/alice/media';}
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
      currentSrc:'https://pbs.twimg.com/media/MATCH?format=jpg&name=orig',
      addEventListener(event, fn) { if (event === 'load') this.handler = fn; } };
    const unrelated = { complete: true, naturalWidth: 200,
      currentSrc:'https://pbs.twimg.com/profile_images/123/photo_200x200.jpg' };
    const wrongPhoto = { complete:true,naturalWidth:1000,
      currentSrc:'https://pbs.twimg.com/media/OTHER?format=jpg&name=large' };
    const viewer = { isConnected:true, querySelectorAll() { return [unrelated,wrongPhoto,image]; } };
    const host = { removed: false, remove() { this.removed = true; } };
    const controller = Object.create(proto);
    controller.originProfile = 'alice'; controller.navGeneration = 2;
    controller.handoff = { host, targetStatus: '77', targetMediaIndex: 1,
      targetPhotoIdentity:'MATCH',
      generation: 2, timeout: 99, revealTimer: null, observer: null, waitingImage: null };
    state.pathname = '/alice/status/77/photo/1';
    proto.finishVisualHandoff.call(controller, viewer);
    assert.equal(controller.handoff.revealTimer, null,
      'loaded avatar and unrelated photo must not hide the target image');
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

test('late decode after background cancellation cannot restart stale transfers', async () => {
  const oldImage=context.Image,oldNav=context.navigator;
  const oldSet=context.window.setTimeout,oldClear=context.window.clearTimeout;
  const oldHidden=document.hidden,oldPath=state.pathname;
  const pending=[],started=[],timers=new Map();
  let nextTimer=1;
  context.window.setTimeout=(fn,ms)=>{const id=nextTimer++;timers.set(id,{fn,ms});return id;};
  context.window.clearTimeout=(id)=>timers.delete(id);
  context.navigator={onLine:true,connection:{saveData:false,effectiveType:'4g'},deviceMemory:8};
  context.Image=class {
    naturalWidth=1600;naturalHeight=900;
    set src(v){started.push(v);this.url=v;}
    decode(){return new Promise(resolve=>pending.push(resolve));}
    removeAttribute(name){assert.equal(name,'src');this.url='';}
  };
  document.hidden=false;state.pathname='/alice/status/10/photo/1';
  const urls=['ONE','TWO','THREE'].map(x=>'https://pbs.twimg.com/media/'+x+'?format=jpg&name=large');
  const ctrl=Object.assign(Object.create(proto),{
    viewer:{isConnected:true},originProfile:'alice',navGeneration:12,
    navigationBusy:false,
    prefetched:new Map(),prefetchQueue:[...urls],prefetchWanted:new Set(urls),
    prefetchedTooLarge:new Set(),prefetchFailed:new Set(),prefetchTooLarge:new Set(),
    prefetchInFlight:0,preloadTimer:null,preloadForPath:'cached',
  });
  try {
    proto.drainPrefetchQueue.call(ctrl);
    assert.equal(ctrl.prefetchInFlight,2);
    assert.deepEqual(started,urls.slice(0,2));
    document.hidden=true;
    proto.onVisibilityChange.call(ctrl);
    assert.equal(ctrl.prefetchInFlight,0,'cancel releases both transfer slots');
    assert.equal(ctrl.prefetchQueue.length,0,'queued third resource is abandoned');
    assert.equal(ctrl.prefetchFailed.size,0,'cancellation is not a CDN failure');
    pending[0]();pending[1]();
    await Promise.resolve();await Promise.resolve();await Promise.resolve();
    assert.equal(ctrl.prefetchInFlight,0,'late promise cannot free slots twice');
    assert.deepEqual(started,urls.slice(0,2),'late decode must not start stale third request');
    assert.equal(ctrl.prefetched.size,0,'canceled records must not come back');
    assert.equal(timers.size,0,'all abandoned watchdog timers are released');
  }finally{
    context.Image=oldImage;context.navigator=oldNav;context.window.setTimeout=oldSet;
    context.window.clearTimeout=oldClear;document.hidden=oldHidden;state.pathname=oldPath;
  }
});

test('hidden background route polls do no media DOM work and resume once on return', () => {
  const oldHidden=document.hidden,oldPath=state.pathname;
  state.pathname='/alice/media';
  document.hidden=true;
  let observerWork=0,reconciliations=0,prefetches=0;
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice',originTimeline:'alice|default',navigationBusy:false,
    viewer:{isConnected:true},preloadForPath:'old',
    ensureListObserver(){observerWork++;return false;},
    scanTiles(){observerWork++;},syncModalObserver(){observerWork++;},
    schedulePreload(){prefetches++;},
  });
  try {
    proto.tick.call(ctrl);
    assert.equal(observerWork,0,'hidden interval should avoid touching the DOM');
    ctrl.tick=()=>{reconciliations++;};
    document.hidden=false;
    proto.onVisibilityChange.call(ctrl);
    assert.equal(reconciliations,1,'resume promptly reconciles X state before prefetching');
    assert.equal(prefetches,1);
  }finally{document.hidden=oldHidden;state.pathname=oldPath;}
});

test('backgrounding the tab stops obsolete prefetch downloads without dropping decoded photos', () => {
  const oldHidden=document.hidden;
  const oldClear=context.window.clearTimeout;
  const cancelled=[], cleared=[];
  context.window.clearTimeout=(id)=>cleared.push(id);
  document.hidden=true;
  const decoded={image:{},ready:true,loading:false,bytes:6400};
  const unfinished={image:{},ready:false,loading:true,bytes:0,
    cancel(){cancelled.push('obsolete');ctrl.prefetched.delete('obsolete');ctrl.prefetchInFlight--;}};
  const handoffImage={};
  const handoffLoading={image:handoffImage,ready:false,loading:true,bytes:0,
    cancel(){cancelled.push('visible');}};
  const ctrl=Object.assign(Object.create(proto),{
    viewer:{isConnected:true},originProfile:'alice',navGeneration:7,
    prefetched:new Map([['decoded',decoded],['obsolete',unfinished],['visible',handoffLoading]]),
    prefetchedReady:new Set(),prefetchQueue:['pending','stale'],
    prefetchWanted:new Set(['pending','obsolete','visible']),
    prefetchInFlight:2,preloadForPath:'cached',preloadTimer:15,
    handoff:{host:{contains(image){return image===handoffImage;}}},
  });
  try{
    proto.onVisibilityChange.call(ctrl);
    assert.deepEqual(cancelled,['obsolete'],'only non-visible in-flight prefetch should be canceled');
    assert.equal(ctrl.prefetchQueue.length,0,'queued background transfers should be abandoned');
    assert.equal(ctrl.prefetchWanted.size,0,'no pending demand while tab is hidden');
    assert.equal(ctrl.prefetched.get('decoded'),decoded,'retain bounded already decoded image for return');
    assert.equal(ctrl.prefetched.has('visible'),true,'handoff image must not be canceled');
    assert.equal(ctrl.prefetchInFlight,1);
    assert.ok(cleared.includes(15),'clear startup timer so it does not run while hidden');
  }finally{
    document.hidden=oldHidden;context.window.clearTimeout=oldClear;
  }
});

test('returning to a visible media viewer recalculates prefetch even for unchanged route', () => {
  const oldHidden=document.hidden;
  document.hidden=false;
  let scheduled=0,reconciled=0;
  const ctrl=Object.assign(Object.create(proto),{
    viewer:{isConnected:true},originProfile:'alice',
    preloadForPath:'old-route-cache-key',
    tick(){reconciled++;},schedulePreload(){scheduled++;},
  });
  try{
    proto.onVisibilityChange.call(ctrl);
    assert.equal(ctrl.preloadForPath,'','stale same-route dedup must be reset after backgrounding');
    assert.equal(scheduled,1,'restart only the bounded existing queue on tab return');
    ctrl.viewer=null;
    proto.onVisibilityChange.call(ctrl);
    assert.equal(scheduled,1,'a closed gallery must not start background downloads');
  }finally{document.hidden=oldHidden;}
});

test('decoded-memory budget evicts farthest prefetch before the nearest next photo', () => {
  const mib=1024*1024;
  const photo=()=>({image:{},ready:true,loading:false,bytes:35*mib});
  const ctrl=Object.assign(Object.create(proto),{
    prefetched:new Map([['near',photo()],['middle',photo()],['far',photo()]]),
    prefetchWanted:new Set(['near','middle','far']),
    handoff:null,
  });
  proto.trimPrefetched.call(ctrl);
  assert.deepEqual([...ctrl.prefetched.keys()],['near','middle'],
    'under 80MiB, keep the nearest decoded images instead of distant future photos');
  const bytes=[...ctrl.prefetched.values()].reduce((sum,p)=>sum+p.bytes,0);
  assert.ok(bytes<=80*mib);
});

test('decoded budget discards an obsolete cache record before any requested photo', () => {
  const mib=1024*1024;
  const photo=()=>({image:{},ready:true,loading:false,bytes:35*mib});
  const ctrl=Object.assign(Object.create(proto),{
    prefetched:new Map([['near',photo()],['obsolete',photo()],['middle',photo()]]),
    prefetchWanted:new Set(['near','middle']),
    handoff:null,
  });
  proto.trimPrefetched.call(ctrl);
  assert.deepEqual([...ctrl.prefetched.keys()],['near','middle']);
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
test('clicking a media tile begins bounded future-photo prefetch before modal opens', () => {
  const previousSetTimeout=context.window.setTimeout,previousClearTimeout=context.window.clearTimeout;
  const oldNavigator=context.navigator;
  context.navigator={onLine:true,connection:{effectiveType:'4g',saveData:false},deviceMemory:8};
  state.pathname='/alice/media';state.search='?filter=photo';
  const tile=makeTile('/alice/status/41/photo/1');
  const next=ref('/alice/status/42/photo/1');
  const first=ref('/alice/status/41/photo/1');
  tile.link.closest=(selector)=>selector==='li[role="listitem"]'?tile.tile:
    selector==='a[href]'?tile.link:null;
  const ctrl=Object.create(proto);
  ctrl.originProfile='alice'; ctrl.originTimeline='alice|photo';
  ctrl.navigationBusy=false; ctrl.pendingGrid=null;
  ctrl.refs=[first,next];ctrl.indexes=new Map([[first.key,0],[next.key,1]]);
  ctrl.preopenExpireTimer=null;ctrl.viewer=null;
  ctrl.prefetchQueue=[];ctrl.prefetchWanted=new Set();
  const launches=[],timers=[];
  ctrl.preloadAdjacentImages=(arg)=>launches.push(arg);
  context.window.setTimeout=(fn,delay)=>{timers.push({fn,delay});return 1;};
  context.window.clearTimeout=()=>{};
  try {
    const event={button:0,target:tile.link,ctrlKey:false,altKey:false,
      shiftKey:false,metaKey:false,preventDefault(){throw new Error('Do not cancel user click');}};
    proto.onMediaTileClick.call(ctrl,event);
    assert.equal(launches.length,1,'image prefetch is scheduled synchronously before X modal opens');
    assert.equal(launches[0].index,0);
    assert.equal(launches[0].current.statusId,'41');
    assert.equal(timers.at(-1).delay,2000);
    timers.at(-1).fn();
    assert.equal(ctrl.preopenExpireTimer,null);
    for(const key of ['ctrlKey','shiftKey','altKey','metaKey']) {
      proto.onMediaTileClick.call(ctrl,{...event,[key]:true});
    }
    proto.onMediaTileClick.call(ctrl,{...event,button:1});
    assert.equal(launches.length,1,'modified and middle clicks never prefetch');
    context.navigator.connection.effectiveType='3g';
    proto.onMediaTileClick.call(ctrl,event);
    assert.equal(launches.length,1,'slower network avoids competing with initial native modal photo');
  } finally {
    context.window.setTimeout=previousSetTimeout;
    context.window.clearTimeout=previousClearTimeout;
    context.navigator=oldNavigator;
    state.pathname='/alice/media';state.search='';
  }
});

test('media timeline listens for src swaps after thumbnails are inserted', () => {
  const oldObserver=context.MutationObserver;
  let observer=null;
  class Observer {
    constructor(callback){this.callback=callback;observer=this;}
    observe(column,options){this.column=column;this.options=options;}
    disconnect(){}
  }
  context.MutationObserver=Observer;
  state.pathname='/alice/media';
  state.root=new FakeElement('div');
  const ctrl=Object.create(proto);
  ctrl.originProfile='alice';
  ctrl.observedColumn=null;ctrl.scanTimer=null;
  ctrl.stopListObserver=()=>{ctrl.observedColumn=null;ctrl.listObserver=null;};
  try {
    assert.equal(proto.ensureListObserver.call(ctrl),true);
    assert.equal(observer.column,state.root);
    assert.equal(observer.options.subtree,true);
    assert.equal(observer.options.attributes,true);
    assert.equal(observer.options.attributeFilter.join(','),'src,srcset');
  } finally {
    context.MutationObserver=oldObserver;
    state.root=null;state.pathname='/alice/media';
  }
});

test('late-loaded thumbnail image URL can join bounded prefetch sources', () => {
  state.pathname='/alice/media';
  const {tile}=makeTile('/alice/status/77/photo/1');
  const img={currentSrc:'',src:'data:image/gif;base64,AAAA'};
  const oldQuery=tile.querySelector.bind(tile);
  const oldQueryAll=tile.querySelectorAll.bind(tile);
  tile.querySelector=(sel)=>sel==='img[src]'?img:oldQuery(sel);
  tile.querySelectorAll=(sel)=>sel==='img[src]'?[img]:oldQueryAll(sel);
  state.root=new FakeElement('div');state.root.tiles=[tile];
  const ctrl=Object.create(proto);
  ctrl.originProfile='alice';ctrl.pendingGrid=null;
  ctrl.refs=[];ctrl.indexes=new Map();ctrl.imageSources=new Map();
  try {
    proto.scanTiles.call(ctrl);
    assert.equal(ctrl.imageSources.size,0,'placeholder data URI is not preheated');
    img.currentSrc='https://pbs.twimg.com/media/LATER?format=jpg&name=small';
    proto.scanTiles.call(ctrl);
    assert.equal(ctrl.imageSources.get(ref('/alice/status/77/photo/1').key),
      'https://pbs.twimg.com/media/LATER?format=jpg&name=large');
  } finally {
    state.root=null;state.pathname='/alice/media';
  }
});
test('pre-open click downloads only two photos until the native viewer exists', async () => {
  const oldImage=context.Image, oldNav=context.navigator;
  document.hidden=false;
  context.navigator={onLine:true,connection:{saveData:false,effectiveType:'4g'},deviceMemory:8};
  const started=[],resolveDecode=[];
  context.Image=class {
    naturalWidth=1200;naturalHeight=800;
    set src(url){started.push(url);this.url=url;}
    decode(){return new Promise(resolve=>resolveDecode.push(resolve));}
  };
  const refs=Array.from({length:7},(_,i)=>ref('/alice/status/'+(100+i)+'/photo/1'));
  const urls=refs.map((r,i)=>'https://pbs.twimg.com/media/P'+i+'?format=jpg&name=large');
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice',viewer:null,refs,
    activeIndex(){return 0;},
    imageSources:new Map(refs.map((r,i)=>[r.key,urls[i]])),
    prefetched:new Map(),prefetchQueue:[],prefetchWanted:new Set(),prefetchFailed:new Set(),
    prefetchTooLarge:new Set(),prefetchInFlight:0,navGeneration:12,navigationBusy:false,
  });
  try {
    state.pathname='/alice/media';
    proto.preloadAdjacentImages.call(ctrl,{index:0,current:refs[0]});
    assert.equal(started.length,2);
    assert.equal(ctrl.prefetchQueue.length,3);
    resolveDecode[0]();resolveDecode[1]();
    await Promise.resolve();await Promise.resolve();await Promise.resolve();
    assert.equal(started.length,2,'do not download all five while no X modal exists');
    assert.equal(ctrl.prefetchQueue.length,3);
    ctrl.viewer={isConnected:true};
    state.pathname='/alice/status/100/photo/1';
    proto.preloadAdjacentImages.call(ctrl);
    assert.equal(started.length,4,'native viewer can resume the queued future photos');
    resolveDecode[2]();resolveDecode[3]();
    await Promise.resolve();await Promise.resolve();await Promise.resolve();
    assert.equal(started.length,5);
  } finally {
    context.Image=oldImage;context.navigator=oldNav;
    state.pathname='/alice/media';
  }
});
test('attribute-only image mutation updates its tile without scanning the full grid', () => {
  const oldObserver=context.MutationObserver;
  const oldTimeout=context.window.setTimeout;
  const oldClear=context.window.clearTimeout;
  const scheduled=[];
  let observer;
  class Observer {
    constructor(callback){this.callback=callback;observer=this;}
    observe(root,opts){this.root=root;this.opts=opts;}
    disconnect(){}
  }
  context.MutationObserver=Observer;
  context.window.setTimeout=(cb,ms)=>{scheduled.push({cb,ms});return scheduled.length;};
  context.window.clearTimeout=()=>{};
  state.pathname='/alice/media';state.root=new FakeElement('div');
  const tile=makeTile('/alice/status/11/photo/1').tile;
  const image=new FakeElement('img');
  image.closest=sel=>sel==='li[role="listitem"]'?tile:null;
  const avatar=new FakeElement('img');
  avatar.closest=()=>null;
  let fullScans=0,partialScans=0;
  const ctrl=Object.create(proto);
  ctrl.originProfile='alice';ctrl.pendingGrid=null;
  ctrl.observedColumn=null;ctrl.scanTimer=null;
  ctrl.pendingSourceTiles=new Set();ctrl.pendingFullScan=false;
  ctrl.scanTiles=()=>fullScans++;
  ctrl.refreshKnownTileSource=(item)=>{assert.equal(item,tile);partialScans++;};
  try {
    assert.equal(proto.ensureListObserver.call(ctrl),true);
    observer.callback([{type:'attributes',target:avatar}]);
    assert.equal(scheduled.length,0,'unrelated avatar does not trigger a scan');
    observer.callback([{type:'attributes',target:image}]);
    assert.equal(scheduled.length,1);
    assert.equal(scheduled[0].ms,100);
    scheduled[0].cb();
    assert.equal(partialScans,1);
    assert.equal(fullScans,0,'changing one image must not rescan all grid items');

    observer.callback([{type:'attributes',target:image}]);
    const newTile=new FakeElement('li');
    newTile.matches=sel=>sel==='li[role="listitem"]';
    newTile.querySelector=()=>null;
    observer.callback([{type:'childList',target:state.root,
      addedNodes:[newTile],removedNodes:[]}]);
    assert.equal(scheduled.length,2,'structural event is folded into existing debounce');
    scheduled[1].cb();
    assert.equal(fullScans,1,'a genuinely new tile requires a full scan');
    assert.equal(partialScans,1,'structural scan subsumes thumbnail work');

    const statusBadge=new FakeElement('span');
    statusBadge.matches=()=>false;statusBadge.querySelector=()=>null;
    observer.callback([{type:'childList',target:state.root,
      addedNodes:[statusBadge],removedNodes:[]}]);
    assert.equal(scheduled.length,2,'unrelated DOM decoration is ignored');
  } finally {
    context.MutationObserver=oldObserver;
    context.window.setTimeout=oldTimeout;
    context.window.clearTimeout=oldClear;
    state.root=null;state.pathname='/alice/media';
  }
});

test('identical thumbnail URL does not churn cache; a new URL advances source revision', () => {
  state.pathname='/alice/media';
  const {tile}=makeTile('/alice/status/88/photo/1');
  const image={currentSrc:'https://pbs.twimg.com/media/SRC1?format=jpg&name=small'};
  const oldQ=tile.querySelector.bind(tile),oldAll=tile.querySelectorAll.bind(tile);
  tile.querySelector=sel=>sel==='img[src]'?image:oldQ(sel);
  tile.querySelectorAll=sel=>sel==='img[src]'?[image]:oldAll(sel);
  state.root=new FakeElement('div');state.root.tiles=[tile];
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice',pendingGrid:null,
    indexes:new Map(),refs:[],imageSources:new Map(),imageSourcesRevision:0,
  });
  try{
    proto.scanTiles.call(ctrl);
    assert.equal(ctrl.imageSourcesRevision,1);
    proto.scanTiles.call(ctrl);
    assert.equal(ctrl.imageSourcesRevision,1,'unchanged image URL stays cached');
    image.currentSrc='https://pbs.twimg.com/media/SRC2?format=jpg&name=small';
    proto.refreshKnownTileSource.call(ctrl,tile);
    assert.equal(ctrl.imageSourcesRevision,2);
    assert.equal(ctrl.imageSources.get(ref('/alice/status/88/photo/1').key),
      'https://pbs.twimg.com/media/SRC2?format=jpg&name=large');
    assert.equal(ctrl.imageSources.size,1);
  }finally{state.root=null;state.pathname='/alice/media';}
});
test('rapid post change cancels obsolete images and frees both transfer slots', () => {
  const oldImage=context.Image, oldNavigator=context.navigator;
  document.hidden=false;
  context.navigator={onLine:true,connection:{effectiveType:'4g',saveData:false},deviceMemory:8};
  const requests=[],canceled=[];
  context.Image=class {
    naturalWidth=1000;naturalHeight=800;
    set src(url){if(url.startsWith('https:'))requests.push(url);this.value=url;}
    get src(){return this.value;}
    removeAttribute(name){if(name==='src'){canceled.push(this.value);this.value='';}}
    decode(){return new Promise(()=>{});}
  };
  const refs=Array.from({length:12},(_,i)=>ref('/alice/status/'+(100+i)+'/photo/1'));
  const urlFor=i=>'https://pbs.twimg.com/media/F'+i+'?format=jpg&name=large';
  const instance=Object.assign(Object.create(proto),{
    viewer:{isConnected:true},originProfile:'alice',refs,navGeneration:5,navigationBusy:false,
    activeIndex(){return 0;},
    imageSources:new Map(refs.map((r,i)=>[r.key,urlFor(i)])),
    prefetched:new Map(),prefetchWanted:new Set(),prefetchQueue:[],prefetchInFlight:0,
    prefetchFailed:new Set(),prefetchTooLarge:new Set(),
  });
  try {
    state.pathname='/alice/status/100/photo/1';
    proto.preloadAdjacentImages.call(instance);
    assert.deepEqual(requests,[urlFor(1),urlFor(2)]);
    assert.equal(instance.prefetchInFlight,2);
    instance.activeIndex=()=>5;
    state.pathname='/alice/status/105/photo/1';
    proto.preloadAdjacentImages.call(instance);
    assert.deepEqual(canceled,[urlFor(1),urlFor(2)]);
    assert.ok(requests.includes(urlFor(6)) && requests.includes(urlFor(7)),
      'new nearest-post requests start without waiting for abandoned loads');
    assert.equal(instance.prefetchInFlight,2,'two-slot concurrency is maintained');
    assert.ok(!instance.prefetchFailed.has(urlFor(1)) &&
      !instance.prefetchFailed.has(urlFor(2)),'intentional cancellation is not CDN failure');
    for(const record of instance.prefetched.values())record.cancel?.();
  } finally {
    context.Image=oldImage;context.navigator=oldNavigator;state.pathname='/alice/media';
  }
});

test('stalled decode watchdog releases a slot and advances the queued future photo', () => {
  const oldImage=context.Image, oldNavigator=context.navigator;
  const oldSet=context.window.setTimeout,oldClear=context.window.clearTimeout;
  document.hidden=false;
  context.navigator={onLine:true,connection:{effectiveType:'4g',saveData:false},deviceMemory:8};
  const timers=new Map(),requests=[];
  let seq=0;
  context.window.setTimeout=(cb,ms)=>{const id=++seq;timers.set(id,{cb,ms});return id;};
  context.window.clearTimeout=(id)=>timers.delete(id);
  context.Image=class {
    naturalWidth=100;naturalHeight=100;
    set src(url){if(url.startsWith('https:'))requests.push(url);this.url=url;}
    removeAttribute(){}
    decode(){return new Promise(()=>{});}
  };
  const refs=Array.from({length:6},(_,i)=>ref('/alice/status/'+(200+i)+'/photo/1'));
  const urls=refs.map((r,i)=>'https://pbs.twimg.com/media/S'+i+'?format=jpg&name=large');
  const instance=Object.assign(Object.create(proto),{
    viewer:{isConnected:true},originProfile:'alice',refs,navGeneration:4,navigationBusy:false,
    activeIndex(){return 0;},imageSources:new Map(refs.map((r,i)=>[r.key,urls[i]])),
    prefetched:new Map(),prefetchWanted:new Set(),prefetchQueue:[],
    prefetchInFlight:0,prefetchFailed:new Set(),prefetchTooLarge:new Set(),
  });
  try {
    state.pathname='/alice/status/200/photo/1';
    proto.preloadAdjacentImages.call(instance);
    assert.equal(requests.length,2);
    assert.equal(timers.get(1).ms,12000);
    timers.get(1).cb();
    assert.equal(instance.prefetchFailed.has(urls[1]),true);
    assert.equal(instance.prefetchInFlight,2);
    assert.deepEqual(requests.slice(0,3),urls.slice(1,4));
    for(const record of instance.prefetched.values())record.cancel?.();
  } finally {
    context.Image=oldImage;context.navigator=oldNavigator;
    context.window.setTimeout=oldSet;context.window.clearTimeout=oldClear;
    state.pathname='/alice/media';
  }
});

test('a lazy currentSrc placeholder falls back to the validated live img.src URL', () => {
  state.pathname='/alice/media';
  const {tile}=makeTile('/alice/status/777/photo/1');
  const image={
    currentSrc:'data:image/gif;base64,AAA',
    src:'https://pbs.twimg.com/media/VALID?format=webp&name=small',
  };
  const q=tile.querySelector.bind(tile),qa=tile.querySelectorAll.bind(tile);
  tile.querySelector=selector=>selector==='img[src]'?image:q(selector);
  tile.querySelectorAll=selector=>selector==='img[src]'?[image]:qa(selector);
  state.root=new FakeElement('div');state.root.tiles=[tile];
  const instance=Object.assign(Object.create(proto),{
    originProfile:'alice',pendingGrid:null,refs:[],indexes:new Map(),
    imageSources:new Map(),imageSourcesRevision:0,
  });
  try {
    proto.scanTiles.call(instance);
    assert.equal(instance.imageSources.get(ref('/alice/status/777/photo/1').key),
      'https://pbs.twimg.com/media/VALID?format=webp&name=large');
  } finally {state.root=null;}
});

test('leaving a media session cancels unfinished CDN prefetches and clears its queue', () => {
  const oldQueryAll=document.querySelectorAll;
  document.querySelectorAll=()=>[];
  let aborted=0;
  const ctrl=Object.assign(Object.create(proto),{
    navGeneration:7,navigationBusy:false,pendingGrid:null,
    originProfile:'alice',originTimeline:'alice|photo',refs:[ref('/alice/status/11/photo/1')],
    indexes:new Map(),imageSources:new Map(),knownPhotoTotals:new Map(),
    prefetched:new Map([['old',{loading:true,cancel(){aborted++;}}]]),
    prefetchQueue:['next'],prefetchWanted:new Set(['next']),
    prefetchFailed:new Set(),prefetchTooLarge:new Set(),
    prefetchInFlight:1,preloadForPath:'old',pendingRightConfirmation:null,
    rightProbeTimer:null,preloadTimer:null,preopenExpireTimer:null,
    clearVisualHandoff(){},removeViewerUI(){},stopListObserver(){},
  });
  try {
    proto.resetSession.call(ctrl);
    assert.equal(aborted,1,'unfinished image request is canceled');
    assert.equal(ctrl.prefetched.size,0);
    assert.equal(ctrl.prefetchQueue.length,0);
    assert.equal(ctrl.prefetchWanted.size,0);
    assert.equal(ctrl.prefetchInFlight,0);
    assert.equal(ctrl.navGeneration,8,'late callbacks are isolated from the new session');
  } finally {
    document.querySelectorAll=oldQueryAll;
  }
});
test('SPA handoff waits for the matching displayed CDN photo and its decode', async () => {
  const oldSet=context.window.setTimeout, oldClear=context.window.clearTimeout;
  let tick=1, resolveDecode, decodeCalls=0;
  const timers=new Map();
  context.window.setTimeout=(fn)=>{timers.set(tick,fn);return tick++;};
  context.window.clearTimeout=(id)=>timers.delete(id);
  const current='https://pbs.twimg.com/media/BEFORE?format=jpg&name=large';
  const target='https://pbs.twimg.com/media/DEST?format=jpg&name=orig';
  const image={
    complete:true,naturalWidth:1024,currentSrc:current,src:target,
    decode(){decodeCalls++;return new Promise(resolve=>{resolveDecode=resolve;});},
    addEventListener(){},
    removeEventListener(){},
  };
  const avatar={
    complete:true,naturalWidth:100,
    src:'https://pbs.twimg.com/profile_images/xyz/photo.jpg',
    currentSrc:'https://pbs.twimg.com/profile_images/xyz/photo.jpg',
  };
  const other={complete:true,naturalWidth:400,currentSrc:current,src:current};
  const viewer={isConnected:true,querySelectorAll(){return [avatar,other,image];}};
  const host={removed:false,remove(){this.removed=true;}};
  const controller=Object.create(proto);
  controller.originProfile='alice';controller.navGeneration=6;
  controller.handoff={
    host,targetStatus:'99',targetMediaIndex:1,targetPhotoIdentity:'DEST',
    generation:6,timeout:90,revealTimer:null,decodingImage:null,decodingSrc:null,
    decodedImage:null,decodedSrc:null,observer:null,waitingImage:null,
  };
  state.pathname='/alice/status/99/photo/1';
  try {
    proto.finishVisualHandoff.call(controller,viewer);
    assert.equal(controller.handoff.revealTimer,null,
      'changing src while currentSrc still shows an old photo must not remove the handoff');
    assert.equal(decodeCalls,0,'not even begin decoding the wrong displayed image');
    image.currentSrc=target;
    proto.finishVisualHandoff.call(controller,viewer);
    assert.equal(decodeCalls,1);
    assert.equal(controller.handoff.revealTimer,null,
      'loaded pixels alone are insufficient: wait for Image.decode');
    proto.finishVisualHandoff.call(controller,viewer);
    assert.equal(decodeCalls,1,'repeated MutationObserver checks must not duplicate decode');
    resolveDecode();
    await Promise.resolve();await Promise.resolve();await Promise.resolve();
    assert.notEqual(controller.handoff.revealTimer,null);
    timers.get(controller.handoff.revealTimer)();
    assert.equal(controller.handoff,null);
    assert.equal(host.removed,true);
  } finally {
    context.window.setTimeout=oldSet;context.window.clearTimeout=oldClear;
    state.pathname='/alice/media';
  }
});
test('late decode from an old image cannot release a newly displayed target', async () => {
  const oldSet=context.window.setTimeout,oldClear=context.window.clearTimeout;
  const timers=[];
  context.window.setTimeout=(fn)=>{timers.push(fn);return timers.length;};
  context.window.clearTimeout=()=>{};
  let resolveDecode;
  const original='https://pbs.twimg.com/media/TARGET?format=jpg&name=large';
  const photo={currentSrc:original,src:original,complete:true,naturalWidth:800,
    addEventListener(){},
    decode(){return new Promise(resolve=>{resolveDecode=resolve;});}};
  const viewer={isConnected:true,querySelectorAll(){return [photo];}};
  const ctrl=Object.create(proto);
  ctrl.originProfile='alice';ctrl.navGeneration=12;
  const host={removed:false,remove(){this.removed=true;}};
  ctrl.handoff={
    host,generation:12,targetStatus:'50',targetMediaIndex:1,
    targetPhotoIdentity:'TARGET',timeout:1,revealTimer:null,
    waitingImage:null,observer:null,decodingImage:null,decodingSrc:null,
    decodedImage:null,decodedSrc:null,
  };
  state.pathname='/alice/status/50/photo/1';
  try {
    proto.finishVisualHandoff.call(ctrl,viewer);
    assert.equal(typeof resolveDecode,'function');
    photo.currentSrc='https://pbs.twimg.com/media/OTHER?format=jpg&name=large';
    resolveDecode();
    await Promise.resolve();await Promise.resolve();await Promise.resolve();
    assert.equal(ctrl.handoff.revealTimer,null,'old photo completion must not remove overlay');
    assert.equal(host.removed,false);
  } finally {
    context.window.setTimeout=oldSet;
    context.window.clearTimeout=oldClear;
    state.pathname='/alice/media';
  }
});
test('when X mounts several carousel slides, choose the visible viewer, not hidden photo 1', () => {
  const oldAll=document.querySelectorAll;
  const hidden=new FakeElement('div',{'aria-hidden':'true'});
  hidden.getBoundingClientRect=()=>({left:0,top:0,right:700,bottom:650,width:700,height:650});
  const visible=new FakeElement('div');
  visible.getBoundingClientRect=()=>({left:0,top:0,right:700,bottom:650,width:700,height:650});
  document.querySelectorAll=s=>s==='[data-testid="swipe-to-dismiss"]'?[hidden,visible]:[];
  try {
    const ctrl=Object.create(proto);
    assert.equal(proto.findActiveViewer.call(ctrl),visible,'the hidden first slide may remain mounted in DOM');
    visible.attrs['aria-hidden']='true';
    assert.equal(proto.findActiveViewer.call(ctrl),null,'no visible slide: never pin controls to a hidden viewer');
  } finally {document.querySelectorAll=oldAll;}
});

test('opacity-hidden native photo 1 never steals controls from visible photo 2', () => {
  const oldQuery=document.querySelectorAll,oldStyle=context.window.getComputedStyle;
  const old=new FakeElement('div'),current=new FakeElement('div');
  const area=()=>({left:0,top:0,right:700,bottom:600,width:700,height:600});
  old.getBoundingClientRect=area;current.getBoundingClientRect=area;
  document.querySelectorAll=s=>s==='[data-testid="swipe-to-dismiss"]'?[old,current]:[];
  context.window.getComputedStyle=el=>({display:'block',visibility:'visible',opacity:el===old?'0':'1'});
  try { assert.equal(proto.findActiveViewer.call(Object.create(proto)),current); }
  finally {document.querySelectorAll=oldQuery;context.window.getComputedStyle=oldStyle;}
});

test('steady native gallery polls reuse the selected viewer until route or visibility changes', () => {
  const previous=state.pathname;
  state.pathname='/alice/status/100/photo/1';
  const pane=new FakeElement('div');
  pane.getBoundingClientRect=()=>({left:0,top:0,right:700,bottom:600,width:700,height:600});
  const ctrl=Object.create(proto);
  let scans=0;
  ctrl.viewer=pane;
  ctrl.activeViewerPath='';
  ctrl.findActiveViewer=()=>{scans++;return pane;};
  try {
    assert.equal(proto.activeViewerForRoute.call(ctrl),pane);
    for(let i=0;i<100;i++) assert.equal(proto.activeViewerForRoute.call(ctrl),pane);
    assert.equal(scans,1,'no repeated document query and forced layout for idle polls');
    state.pathname='/alice/status/100/photo/2';
    assert.equal(proto.activeViewerForRoute.call(ctrl),pane);
    assert.equal(scans,2,'new native photo route must recheck the active pane');
    pane.attrs['aria-hidden']='true';
    proto.activeViewerForRoute.call(ctrl);
    assert.equal(scans,3,'X hiding the selected slide invalidates the cache');
  }finally{state.pathname=previous;}
});

test('SPA viewer observer reacts to an in-place image source swap', () => {
  const oldObserver=context.MutationObserver,oldImage=context.HTMLImageElement;
  let observer=null,ui=0,handoffs=0;
  context.HTMLImageElement=FakeElement;
  context.MutationObserver=class {
    constructor(callback){this.callback=callback;observer=this;}
    observe(target,config){this.target=target;this.config=config;}
    disconnect(){this.disconnected=true;}
  };
  const viewer=new FakeElement('div');
  const instance=Object.create(proto);
  instance.viewer=null;instance.originProfile='alice';
  instance.removeViewerUI=()=>{instance.viewer=null;};
  instance.ensureViewerButtons=()=>{ui++;};
  instance.finishVisualHandoff=()=>{handoffs++;};
  try{
    proto.syncViewer.call(instance,viewer);
    assert.equal(observer.config.attributes,true);
    assert.deepEqual(Array.from(observer.config.attributeFilter),['src','srcset']);
    const beforeUI=ui,beforeHandoff=handoffs;
    const photo=new FakeElement('img');
    observer.callback([{type:'attributes',target:photo,attributeName:'src'}]);
    assert.equal(ui,beforeUI,'source swap does not unnecessarily rebuild buttons');
    assert.equal(handoffs,beforeHandoff+1,'source swap rechecks SPA photo readiness');
    const badge=new FakeElement('span');
    badge.matches=()=>false;badge.querySelector=()=>null;
    observer.callback([{type:'childList',addedNodes:[badge],removedNodes:[]}]);
    assert.equal(ui,beforeUI,'status badge changes do not trigger extra viewer rebuild');
    const appended=new FakeElement('img');
    appended.matches=(selector)=>selector.includes('img');
    appended.querySelector=()=>null;
    observer.callback([{type:'childList',addedNodes:[appended],removedNodes:[]}]);
    assert.equal(ui,beforeUI+1,'new photo renders refresh the viewer controls');
    assert.equal(handoffs,beforeHandoff+2);
  }finally{
    observer?.disconnect();
    context.MutationObserver=oldObserver;
    context.HTMLImageElement=oldImage;
    state.pathname='/alice/media';
  }
});

test('SPA reuses an img: wait for its target src to finish loading', () => {
  const oldSet=context.window.setTimeout,oldClear=context.window.clearTimeout;
  const handlers=new Map(),timers=new Map();let next=1;
  context.window.setTimeout=(fn)=>{timers.set(next,fn);return next++;};
  context.window.clearTimeout=(id)=>timers.delete(id);
  const old='https://pbs.twimg.com/media/OLD?format=jpg&name=large';
  const target='https://pbs.twimg.com/media/NEW?format=jpg&name=orig';
  const img={src:target,currentSrc:old,complete:false,naturalWidth:0,
    addEventListener(event,fn){handlers.set(event,fn);}};
  const viewer={isConnected:true,querySelectorAll(){return [img];}};
  const host={removed:false,remove(){this.removed=true;}};
  const instance=Object.create(proto);
  instance.navGeneration=4;instance.originProfile='alice';
  instance.handoff={
    host,targetStatus:'88',targetMediaIndex:1,targetPhotoIdentity:'NEW',
    generation:4,timeout:100,revealTimer:null,waitingImage:null,
    decodingImage:null,decodingSrc:null,decodedImage:null,decodedSrc:null,observer:null,
  };
  state.pathname='/alice/status/88/photo/1';
  try{
    proto.finishVisualHandoff.call(instance,viewer);
    assert.equal(typeof handlers.get('load'),'function');
    assert.equal(instance.handoff.revealTimer,null);
    img.currentSrc=target;img.complete=true;img.naturalWidth=1000;
    handlers.get('load')();
    assert.notEqual(instance.handoff.revealTimer,null);
    timers.get(instance.handoff.revealTimer)();
    assert.equal(instance.handoff,null);
    assert.equal(host.removed,true);
  }finally{
    context.window.setTimeout=oldSet;
    context.window.clearTimeout=oldClear;
    state.pathname='/alice/media';
  }
});

test('paint-delay handoff never reveals a different photo after React recycles its img', () => {
  const oldSet=context.window.setTimeout, oldClear=context.window.clearTimeout;
  const timers=new Map(); let next=1;
  context.window.setTimeout=(fn)=>{const id=next++;timers.set(id,fn);return id;};
  context.window.clearTimeout=id=>timers.delete(id);
  const target='https://pbs.twimg.com/media/DEST?format=jpg&name=orig';
  const wrong='https://pbs.twimg.com/media/OTHER?format=jpg&name=large';
  const image={currentSrc:target,src:target,complete:true,naturalWidth:1600,isConnected:true};
  const viewer={isConnected:true,querySelectorAll(){return [image];}};
  const host={removed:false,remove(){this.removed=true;}};
  const controller=Object.create(proto);
  controller.originProfile='alice';controller.navGeneration=4;
  controller.handoff={
    host,generation:4,targetStatus:'19',targetMediaIndex:1,
    targetPhotoIdentity:'DEST',timeout:99,revealTimer:null,observer:null,
    waitingImage:null,decodingImage:null,decodingSrc:null,
    decodedImage:null,decodedSrc:null,
  };
  state.pathname='/alice/status/19/photo/1';
  try{
    proto.finishVisualHandoff.call(controller,viewer);
    const first=controller.handoff.revealTimer;
    assert.equal(typeof timers.get(first),'function');
    image.currentSrc=wrong;image.src=wrong;
    timers.get(first)();
    assert.equal(controller.handoff.revealTimer,null,
      'old scheduled reveal is rejected after image content changes');
    assert.equal(host.removed,false);
    image.currentSrc=target;image.src=target;
    proto.finishVisualHandoff.call(controller,viewer);
    const second=controller.handoff.revealTimer;
    assert.notEqual(second,first);
    timers.get(second)();
    assert.equal(controller.handoff,null);
    assert.equal(host.removed,true);
  } finally {
    context.window.setTimeout=oldSet;
    context.window.clearTimeout=oldClear;
    state.pathname='/alice/media';
  }
});

test('closing SPA handoff detaches abandoned photo load listeners and the observer', () => {
  const oldClear=context.window.clearTimeout;
  const cleared=[];
  context.window.clearTimeout=id=>cleared.push(id);
  let detached=0,disconnected=0,removed=0;
  const image={
    removeEventListener(type,handler){
      assert.equal(type,'load');assert.equal(typeof handler,'function');detached++;
    },
  };
  const controller=Object.create(proto);
  controller.handoff={
    timeout:11,revealTimer:12,observer:{disconnect(){disconnected++;}},
    host:{remove(){removed++;}},waitingImage:image,waitingLoadHandler:()=>{},
    decodedImage:null,decodedSrc:null,
  };
  try {
    proto.clearVisualHandoff.call(controller);
    assert.equal(controller.handoff,null);
    assert.deepEqual(cleared,[11,12]);
    assert.equal(detached,1);
    assert.equal(disconnected,1);
    assert.equal(removed,1);
    proto.clearVisualHandoff.call(controller);
    assert.equal(detached,1,'clear is idempotent');
  } finally {
    context.window.clearTimeout=oldClear;
  }
});

test('late decode after closing the modal cannot resurrect visual handoff', async () => {
  const oldSet=context.window.setTimeout,oldClear=context.window.clearTimeout;
  const timers=new Map();let id=1,resolve;
  context.window.setTimeout=(fn)=>{const n=id++;timers.set(n,fn);return n;};
  context.window.clearTimeout=n=>timers.delete(n);
  const src='https://pbs.twimg.com/media/DEST?format=jpg&name=orig';
  const img={currentSrc:src,src,complete:true,naturalWidth:320,
    decode(){return new Promise(r=>{resolve=r;});}};
  const viewer={isConnected:true,querySelectorAll(){return [img];}};
  const host={removed:0,remove(){this.removed++;}};
  const ctrl=Object.create(proto);
  ctrl.originProfile='alice';ctrl.navGeneration=7;
  ctrl.handoff={
    host,targetStatus:'42',targetMediaIndex:1,targetPhotoIdentity:'DEST',
    generation:7,timeout:14,revealTimer:null,
    waitingImage:null,waitingLoadHandler:null,observer:null,
    decodingImage:null,decodingSrc:null,decodedImage:null,decodedSrc:null,
  };
  state.pathname='/alice/status/42/photo/1';
  try{
    proto.finishVisualHandoff.call(ctrl,viewer);
    assert.equal(typeof resolve,'function');
    proto.clearVisualHandoff.call(ctrl);
    assert.equal(ctrl.handoff,null);
    assert.equal(host.removed,1);
    resolve();
    await Promise.resolve();await Promise.resolve();await Promise.resolve();
    assert.equal(ctrl.handoff,null);
    assert.equal(timers.size,0,'late promise must never schedule a reveal');
    assert.equal(host.removed,1);
  } finally {
    context.window.setTimeout=oldSet;
    context.window.clearTimeout=oldClear;
    state.pathname='/alice/media';
  }
});
test('failed SPA MutationObserver setup removes overlay and does not block later transitions', () => {
  const oldBody=document.body,oldCreate=document.createElement;
  const oldObserver=context.MutationObserver,oldMatch=context.window.matchMedia;
  const oldWidth=context.window.innerWidth,oldSet=context.window.setTimeout,oldClear=context.window.clearTimeout;
  const removedTimers=[];
  const body=new FakeElement('body');
  document.body=body; document.hidden=false;
  document.createElement=tag=>{
    const element=new FakeElement(tag);
    element.style={setProperty(){}};
    element.remove=()=>{body.children=body.children.filter(x=>x!==element);};
    return element;
  };
  context.MutationObserver=class { observe(){throw new Error('observer unavailable');} };
  context.window.matchMedia=()=>({matches:false});
  context.window.innerWidth=1200;
  context.window.setTimeout=()=>91;
  context.window.clearTimeout=id=>removedTimers.push(id);
  const url='https://pbs.twimg.com/media/DEST?format=jpg&name=large';
  const target=ref('/alice/status/42/photo/1');
  const image=new FakeElement('img');image.naturalWidth=900;
  const ctrl=Object.create(proto);
  ctrl.handoff=null;ctrl.originProfile='alice';ctrl.navGeneration=1;
  ctrl.viewer={getBoundingClientRect(){return {left:0,top:0,width:700,height:600,right:700};},querySelector(){return null;}};
  ctrl.imageSources=new Map([[target.key,url]]);
  ctrl.prefetched=new Map([[url,{image,ready:true}]]);
  try{
    assert.equal(proto.beginVisualHandoff.call(ctrl,target),false);
    assert.equal(ctrl.handoff,null);
    assert.equal(body.children.length,0);
    assert.deepEqual(removedTimers,[91]);
  }finally{
    document.body=oldBody;document.createElement=oldCreate;
    context.MutationObserver=oldObserver;
    context.window.matchMedia=oldMatch;
    context.window.innerWidth=oldWidth;
    context.window.setTimeout=oldSet;
    context.window.clearTimeout=oldClear;
  }
});
test('a single right key retries an initially unready photo without requesting another key', () => {
  const oldSet=context.window.setTimeout,oldClear=context.window.clearTimeout;
  const queue=[],navigations=[],messages=[];
  let clock=0;
  context.window.setTimeout=(fn,delay)=>{const id=++clock;queue.push({fn,delay,id});return id;};
  context.window.clearTimeout=id=>{const item=queue.find(x=>x.id===id);if(item)item.cancelled=true;};
  const url='https://pbs.twimg.com/media/SLOWONE?format=jpg&name=large';
  const photo={src:url,currentSrc:'',complete:false,naturalWidth:0};
  const viewer=new FakeElement('div');
  viewer.querySelectorAll=s=>s==='img[src], img[srcset]'?[photo]:[];
  const ctrl=Object.assign(Object.create(proto),{
    viewer,originProfile:'alice',navGeneration:4,navigationBusy:false,
    refs:[ref('/alice/status/71/photo/1'),ref('/alice/status/72/photo/1')],
    activeIndex(){return 0;},photoCount(){return null;},
    nativeGalleryArrowAvailable(){return false;},navigate(d){navigations.push(d);},
    toast(m){messages.push(m);},rightProbeTimer:null,pendingRightConfirmation:null,
  });
  state.pathname='/alice/status/71/photo/1';
  const runNext=()=>{const item=queue.shift();assert.ok(item,'a bounded follow-up must be scheduled');if(!item.cancelled)item.fn();};
  try{
    const key=keyEvent('ArrowRight');proto.onKeyDown.call(ctrl,key);
    assert.equal(key.prevented,false,'first arrow stays with native X gallery');
    assert.equal(queue[0].delay,1050);
    runNext();
    assert.equal(navigations.length,0,'unready media cannot be skipped');
    assert.equal(queue.length,1,'one first press automatically awaits a ready image');
    photo.complete=true;photo.naturalWidth=1200;photo.currentSrc=url;
    runNext();
    assert.deepEqual(navigations,[1],'one key finishes once the same photo is actually ready');
    assert.ok(!messages.some(m=>m.includes('もう一度')),'never demand a misleading second arrow');
  }finally{
    context.window.setTimeout=oldSet;context.window.clearTimeout=oldClear;
    state.pathname='/alice/media';
  }
});

test('a stale currentSrc finishes loading without consuming a second right key', () => {
  const oldSet=context.window.setTimeout,oldClear=context.window.clearTimeout;
  const queue=[],moved=[];
  context.window.setTimeout=(fn,delay)=>{queue.push({fn,delay});return queue.length;};
  context.window.clearTimeout=()=>{};
  const oldUrl='https://pbs.twimg.com/media/OLD?format=jpg&name=large';
  const nextUrl='https://pbs.twimg.com/media/ASSIGNED?format=jpg&name=large';
  const image={src:nextUrl,currentSrc:oldUrl,complete:false,naturalWidth:0};
  const viewer=new FakeElement('div');
  viewer.querySelectorAll=s=>s==='img[src], img[srcset]'?[image]:[];
  const ctrl=Object.assign(Object.create(proto),{
    viewer,originProfile:'alice',navGeneration:8,navigationBusy:false,
    refs:[ref('/alice/status/81/photo/2'),ref('/alice/status/82/photo/1')],
    activeIndex(){return 0;},photoCount(){return null;},
    nativeGalleryArrowAvailable(){return false;},navigate(d){moved.push(d);},
    toast(){},rightProbeTimer:null,
  });
  state.pathname='/alice/status/81/photo/2';
  try{
    proto.onKeyDown.call(ctrl,keyEvent('ArrowRight'));
    image.currentSrc=nextUrl;image.complete=true;image.naturalWidth=1280;
    queue.shift().fn();
    assert.deepEqual(moved,[1],'compare the route-assigned image rather than stale displayed pixels');
  }finally{
    context.window.setTimeout=oldSet;context.window.clearTimeout=oldClear;
    state.pathname='/alice/media';
  }
});

test('another right press does not postpone the first native gallery probe', () => {
  const oldSet=context.window.setTimeout,oldClear=context.window.clearTimeout;
  const queue=[];let ticks=0;
  context.window.setTimeout=(fn,delay)=>{ticks++;queue.push({fn,delay});return ticks;};
  context.window.clearTimeout=()=>{};
  const image={src:'https://pbs.twimg.com/media/UNCHANGED?format=jpg&name=large',
    currentSrc:'https://pbs.twimg.com/media/UNCHANGED?format=jpg&name=large',
    complete:true,naturalWidth:900};
  const viewer=new FakeElement('div');viewer.querySelectorAll=s=>s==='img[src], img[srcset]'?[image]:[];
  const nav=[];
  const ctrl=Object.assign(Object.create(proto),{
    viewer,originProfile:'alice',navGeneration:6,navigationBusy:false,
    refs:[ref('/alice/status/91/photo/1'),ref('/alice/status/92/photo/1')],
    activeIndex(){return 0;},photoCount(){return null;},
    nativeGalleryArrowAvailable(){return false;},navigate(d){nav.push(d);},
    toast(){},rightProbeTimer:null,
  });
  state.pathname='/alice/status/91/photo/1';
  try {
    proto.onKeyDown.call(ctrl,keyEvent('ArrowRight'));
    proto.onKeyDown.call(ctrl,keyEvent('ArrowRight'));
    assert.equal(ticks,1,'do not replace and delay an outstanding boundary probe');
    queue[0].fn();assert.deepEqual(nav,[1]);
  }finally{
    context.window.setTimeout=oldSet;context.window.clearTimeout=oldClear;
    state.pathname='/alice/media';
  }
});

test('an offscreen preloaded duplicate never impersonates the visible X photo', () => {
  const old=state.pathname;state.pathname='/alice/status/74/photo/1';
  const hidden={src:'https://pbs.twimg.com/media/ACTIVE?format=jpg&name=large',
    currentSrc:'https://pbs.twimg.com/media/ACTIVE?format=jpg&name=large',
    complete:true,naturalWidth:1600,
    getBoundingClientRect(){return {left:-900,top:0,right:-100,bottom:600,width:800,height:600}}};
  const visible={src:'https://pbs.twimg.com/media/OLDER?format=jpg&name=large',
    currentSrc:'https://pbs.twimg.com/media/OLDER?format=jpg&name=large',
    complete:true,naturalWidth:900,
    getBoundingClientRect(){return {left:0,top:0,right:700,bottom:600,width:700,height:600}}};
  const viewer=new FakeElement('div');viewer.querySelectorAll=s=>s==='img[src], img[srcset]'?[hidden,visible]:[];
  const current=ref('/alice/status/74/photo/1');
  const ctrl=Object.assign(Object.create(proto),{viewer,originProfile:'alice',
    imageSources:new Map([[current.key,'https://pbs.twimg.com/media/ACTIVE?format=jpg&name=large']])});
  try{
    assert.equal(proto.displayedPhoto.call(ctrl),visible,'offscreen target CDN image is not proof of rendered pixels');
    assert.equal(proto.currentPhotoReady.call(ctrl),false,'visible old pixels do not prove the route-assigned image is ready');
  }finally{state.pathname=old;}
});

test('the active tile CDN identity resolves visually equal-size gallery images', () => {
  const old=state.pathname;state.pathname='/alice/status/73/photo/1';
  const main={src:'https://pbs.twimg.com/media/ACTIVE?name=orig&format=jpg',
    currentSrc:'https://pbs.twimg.com/media/ACTIVE?name=orig&format=jpg',
    complete:true,naturalWidth:1400,getBoundingClientRect(){return {left:0,top:0,width:700,height:600,right:700,bottom:600}}};
  const other={src:'https://pbs.twimg.com/media/UNRELATED?name=orig&format=jpg',
    currentSrc:'https://pbs.twimg.com/media/UNRELATED?name=orig&format=jpg',
    complete:true,naturalWidth:900,getBoundingClientRect(){return {left:0,top:0,width:700,height:600,right:700,bottom:600}}};
  const viewer=new FakeElement('div');
  viewer.querySelectorAll=s=>s==='img[src], img[srcset]'?[other,main]:[];
  const current=ref('/alice/status/73/photo/1');
  const ctrl=Object.assign(Object.create(proto),{
    viewer,originProfile:'alice',
    imageSources:new Map([[current.key,'https://pbs.twimg.com/media/ACTIVE?format=jpg&name=large']]),
  });
  try {
    assert.equal(proto.displayedPhoto.call(ctrl),main,'prefer the active post photo over equally sized unrelated media');
    assert.equal(proto.currentPhotoReady.call(ctrl),true);
  }finally{state.pathname=old;}
});

test('one right press advances when X leaves a ready photo unchanged', () => {
  const oldSet=context.window.setTimeout,oldClear=context.window.clearTimeout;
  let scheduled=null,scheduledMs=null;
  context.window.setTimeout=(fn,ms)=>{scheduled=fn;scheduledMs=ms;return 21;};
  context.window.clearTimeout=()=>{};
  const photo={
    complete:true,naturalWidth:1200,
    src:'https://pbs.twimg.com/media/ONE?format=jpg&name=large',
    currentSrc:'https://pbs.twimg.com/media/ONE?format=jpg&name=large',
  };
  const viewer=new FakeElement('div');
  viewer.querySelectorAll=(selector)=>selector==='img[src], img[srcset]'?[photo]:[];
  const ctrl=Object.create(proto);
  const moved=[],messages=[];
  Object.assign(ctrl,{
    viewer,originProfile:'alice',navigationBusy:false,navGeneration:3,
    refs:[ref('/alice/status/31/photo/1'),ref('/alice/status/32/photo/1')],
    activeIndex(){return 0;},photoCount(){return null;},
    nativeGalleryArrowAvailable(){return false;},
    navigate(dir){moved.push(dir);},
    toast(msg){messages.push(msg);},
    rightProbeTimer:null,pendingRightConfirmation:null,
  });
  state.pathname='/alice/status/31/photo/1';
  try{
    const ev=keyEvent('ArrowRight');
    proto.onKeyDown.call(ctrl,ev);
    assert.equal(ev.prevented,false,'give native gallery the first key');
    assert.equal(scheduledMs,1050);
    assert.deepEqual(moved,[]);
    scheduled();
    assert.deepEqual(moved,[1],'after a verified native no-op, one key crosses posts');
    assert.equal(messages.length,0,'no request for a second key');
  }finally{
    context.window.setTimeout=oldSet;context.window.clearTimeout=oldClear;
    state.pathname='/alice/media';
  }
});

test('no post jump if native X changes photo source or is still loading', () => {
  const oldSet=context.window.setTimeout,oldClear=context.window.clearTimeout;
  let probe=null;
  context.window.setTimeout=(fn)=>{probe=fn;return 23;};
  context.window.clearTimeout=()=>{};
  const photo={complete:true,naturalWidth:1200,
    src:'https://pbs.twimg.com/media/BEFORE?format=jpg&name=large',
    currentSrc:'https://pbs.twimg.com/media/BEFORE?format=jpg&name=large'};
  const viewer=new FakeElement('div');
  viewer.querySelectorAll=s=>s==='img[src], img[srcset]'?[photo]:[];
  const nav=[],toasts=[];
  const ctrl=Object.assign(Object.create(proto),{
    viewer,originProfile:'alice',navGeneration:4,navigationBusy:false,
    refs:[ref('/alice/status/11/photo/1'),ref('/alice/status/22/photo/1')],
    activeIndex(){return 0;},photoCount(){return null;},
    nativeGalleryArrowAvailable(){return false;},
    navigate(dir){nav.push(dir);},toast(msg){toasts.push(msg);},
    rightProbeTimer:null,
  });
  state.pathname='/alice/status/11/photo/1';
  try {
    proto.onKeyDown.call(ctrl,keyEvent('ArrowRight'));
    photo.src='https://pbs.twimg.com/media/NEXT?format=jpg&name=large';
    photo.complete=false;
    probe();
    assert.deepEqual(nav,[],'slow native photo load must not skip');
    assert.deepEqual(toasts,[]);
    photo.src=photo.currentSrc='https://pbs.twimg.com/media/BEFORE?format=jpg&name=large';
    photo.complete=false;
    proto.onKeyDown.call(ctrl,keyEvent('ArrowRight'));
    probe();
    assert.deepEqual(nav,[],'current photo not ready must not auto-cross');
    assert.deepEqual(toasts,[],'slow loading must not demand a second key');
  }finally{
    context.window.setTimeout=oldSet;context.window.clearTimeout=oldClear;
    state.pathname='/alice/media';
  }
});

test('disabled next-photo control cannot prove gallery end when another next-photo control is enabled', () => {
  context.HTMLButtonElement=FakeElement;
  const disabled=new FakeElement('button',{'aria-label':'Next photo','aria-disabled':'true'});
  const enabled=new FakeElement('button',{'aria-label':'Next photo'});
  const viewer=new FakeElement('div');
  viewer.querySelectorAll=s=>s==='[aria-label], [title]'?[disabled,enabled]:[];
  const ctrl=Object.create(proto);
  assert.equal(proto.nativeGalleryArrowDisabled.call(ctrl,viewer),false,'an enabled native arrow vetoes terminal evidence');
  enabled.attrs['aria-disabled']='true';
  assert.equal(proto.nativeGalleryArrowDisabled.call(ctrl,viewer),true,'all observed photo arrows are disabled');
});

test('aria-hidden photo arrows never create false gallery-boundary evidence', () => {
  context.HTMLButtonElement=FakeElement;
  const hiddenNext=new FakeElement('button',{'aria-label':'Next photo','aria-hidden':'true'});
  const hiddenDisabled=new FakeElement('button',{'aria-label':'Next photo','aria-disabled':'true'});
  // X may leave a disabled native arrow inside a hidden carousel subtree.
  hiddenDisabled.closest=s=>s.includes('[aria-hidden="true"]') ? {} : null;
  const viewer=new FakeElement('div');
  viewer.querySelectorAll=s=>s==='[aria-label], [title]'?[hiddenNext,hiddenDisabled]:[];
  assert.equal(proto.nativeGalleryArrowAvailable.call({},viewer,1),false,'hidden enabled arrow must not block a verified boundary');
  assert.equal(proto.nativeGalleryArrowDisabled.call({},viewer),false,'hidden disabled arrow must not fake a gallery edge');
});

test('generic Previous and Next controls are not photo-specific arrows', () => {
  context.HTMLButtonElement=FakeElement;
  const previous=new FakeElement('button',{'aria-label':'Previous'});
  const next=new FakeElement('button',{'aria-label':'Next'});
  const viewer=new FakeElement('div');
  viewer.querySelectorAll=s=>s==='[aria-label], [title]'?[previous,next]:[];
  const controller=Object.create(proto);
  assert.equal(proto.nativeGalleryArrowAvailable.call(controller,viewer,-1),false);
  assert.equal(proto.nativeGalleryArrowAvailable.call(controller,viewer,1),false);
  next.attrs['aria-label']='Next photo';
  assert.equal(proto.nativeGalleryArrowAvailable.call(controller,viewer,1),true);
});

test('visual handoff appears only after navigation closes the old modal', async () => {
  state.pathname='/alice/status/11/photo/1';
  const order=[], viewer={isConnected:true};
  const ctrl=Object.assign(Object.create(proto),{
    navigationBusy:false, navGeneration:12, originProfile:'alice', viewer,
    refs:[ref('/alice/status/11/photo/1'),ref('/alice/status/22/photo/1')],
    activeIndex(){return 0;},updateViewerState(){},
    findCloseButton(){return {click(){order.push('close');viewer.isConnected=false;state.pathname='/alice/media';}};},
    async waitForViewerToClose(){order.push('closed');return true;},
    findLiveLink(item){return {isConnected:true,click(){order.push('open:'+item.statusId);}};},
    beginVisualHandoff(){
      this.handoff={generation:12,host:{classList:{add(name){order.push('reveal:'+name);}}}};
      return true;
    },
    clearVisualHandoff(){},toast(msg){throw new Error(msg);}
  });
  try {
    await proto.navigate.call(ctrl,1);
    assert.deepEqual(order,['close','closed','reveal:xmn-handoff-visible','open:22']);
  } finally {state.pathname='/alice/media';}
});

test('the handoff overlay never paints a second black backdrop', () => {
  const style=readFileSync(new URL('../extension/style.css',import.meta.url),'utf8');
  const section=style.match(/\.xmn-visual-handoff\s*\{([^}]+)\}/)?.[1] ?? '';
  assert.match(section,/background:\s*transparent/);
  assert.match(section,/opacity:\s*0/);
  assert.match(style,/\.xmn-visual-handoff\.xmn-handoff-visible\s*\{\s*opacity:\s*1/);
});

test('primary visible photo wins over small thumbnails and unrelated media', () => {
  const picture=(id,w,h,extra={})=>({
    currentSrc:'https://pbs.twimg.com/media/'+id+'?format=jpg&name=large',
    src:'https://pbs.twimg.com/media/'+id+'?format=jpg&name=large',
    complete:true,naturalWidth:1000,
    getBoundingClientRect:()=>({left:0,top:0,right:w,bottom:h,width:w,height:h}),
    ...extra,
  });
  const main=picture('MAIN',820,690);
  const other=picture('OTHER',120,130);
  const thumbnail=picture('HIDDEN',0,0);
  const viewer=new FakeElement('div');
  viewer.querySelectorAll=s=>s==='img[src], img[srcset]'?[other,thumbnail,main]:[];
  const controller=Object.assign(Object.create(proto),{viewer});
  assert.equal(proto.displayedPhoto.call(controller),main);
  assert.equal(proto.currentPhotoReady.call(controller),true);
  assert.match(proto.currentPhotoSignature.call(controller),/MAIN/);
  other.src=other.currentSrc='https://pbs.twimg.com/media/ANOTHER?format=jpg&name=large';
  assert.match(proto.currentPhotoSignature.call(controller),/MAIN/,
    'unrelated thumbnail source changes do not abort the gallery no-op probe');
  main.src='https://pbs.twimg.com/media/LOADING?format=jpg&name=large';
  assert.equal(proto.currentPhotoReady.call(controller),false,
    'new assigned photo with old displayed media is not ready');
  main.src=main.currentSrc;
  main.complete=false;
  assert.equal(proto.currentPhotoReady.call(controller),false);
});

test('ambiguous two large pictures abstain instead of guessing gallery boundary', () => {
  const make=(id,w)=>({
    src:'https://pbs.twimg.com/media/'+id+'?format=jpg&name=large',
    currentSrc:'https://pbs.twimg.com/media/'+id+'?format=jpg&name=large',
    complete:true,naturalWidth:100,
    getBoundingClientRect(){return {left:0,top:0,width:w,height:500,right:w,bottom:500};}
  });
  const viewer=new FakeElement('div');
  viewer.querySelectorAll=s=>s==='img[src], img[srcset]'?[make('A',600),make('B',570)]:[];
  const controller=Object.assign(Object.create(proto),{viewer});
  assert.equal(proto.displayedPhoto.call(controller),null);
  assert.equal(proto.currentPhotoSignature.call(controller),null);
  assert.equal(proto.currentPhotoReady.call(controller),false);
});

test('native gallery loading indicator blocks one-press auto navigation', () => {
  const photo={
    complete:true,naturalWidth:800,
    src:'https://pbs.twimg.com/media/READY?format=jpg&name=large',
    currentSrc:'https://pbs.twimg.com/media/READY?format=jpg&name=large',
  };
  const viewer=new FakeElement('div');
  viewer.querySelectorAll=s=>s==='img[src], img[srcset]'?[photo]:[];
  viewer.querySelector=s=>s.includes('aria-busy')?{isConnected:true}:null;
  const ctrl=Object.assign(Object.create(proto),{viewer});
  assert.equal(proto.currentPhotoReady.call(ctrl),false);
  viewer.querySelector=()=>null;
  assert.equal(proto.currentPhotoReady.call(ctrl),true);
});

test('single-viewer photo is chosen without relying on artificial fixture dimensions', () => {
  const image={
    complete:true,naturalWidth:200,
    src:'https://pbs.twimg.com/media/TINY?format=jpg&name=large',
    currentSrc:'https://pbs.twimg.com/media/TINY?format=jpg&name=large',
  };
  const viewer=new FakeElement('div');
  viewer.querySelectorAll=s=>s==='img[src], img[srcset]'?[image]:[];
  const ctrl=Object.assign(Object.create(proto),{viewer});
  assert.equal(proto.displayedPhoto.call(ctrl),image);
  assert.equal(proto.currentPhotoReady.call(ctrl),true);
});

test('decoded handoff photo fits captured media panel instead of cropping at viewport size', () => {
  const style=readFileSync(new URL('../extension/style.css',import.meta.url),'utf8');
  const css=style.match(/\.xmn-visual-handoff\s+\.xmn-handoff-image\s*\{([^}]+)\}/)?.[1] ?? '';
  assert.match(css,/max-width:\s*100%/,'decoded image must fit the handoff panel width');
  assert.match(css,/max-height:\s*100%/,'decoded image must fit the handoff panel height');
  assert.doesNotMatch(css,/max-(?:width|height):\s*100v[wh]/,'viewport sizing can crop a narrower X viewer');
});

test('late prefetch decode automatically replaces a low-resolution handoff in-place', async () => {
  const oldImage=context.Image,oldNav=context.navigator;
  const oldSet=context.window.setTimeout,oldClear=context.window.clearTimeout;
  const oldPath=state.pathname,oldHidden=document.hidden;
  const url='https://pbs.twimg.com/media/PROMOTE88?format=jpg&name=large';
  const pending=[],downloads=[];
  context.Image=class {
    naturalWidth=1920;naturalHeight=1080;classList={add(){}};
    set src(v){downloads.push(v);this._src=v;}
    decode(){return new Promise(resolve=>pending.push(resolve));}
  };
  context.window.setTimeout=(fn,ms)=>52;
  context.window.clearTimeout=()=>{};
  context.navigator={onLine:true,connection:{saveData:false,effectiveType:'4g'}};
  document.hidden=false;state.pathname='/alice/status/88/photo/1';
  const preview={kind:'canvas'},host={children:[preview],
    contains(img){return this.children.includes(img);},
    replaceChildren(...els){this.children=els;}};
  const ctrl=Object.assign(Object.create(proto),{
    viewer:{isConnected:true},originProfile:'alice',navGeneration:12,
    navigationBusy:false,preloadForPath:'',prefetchInFlight:0,
    prefetched:new Map(),prefetchQueue:[url],prefetchWanted:new Set([url]),
    prefetchFailed:new Set(),prefetchTooLarge:new Set(),
    handoff:{quality:'low',generation:12,host,targetStatus:'88',
      targetMediaIndex:1,targetPhotoIdentity:'PROMOTE88',targetPrefetchUrl:url},
  });
  try{
    proto.drainPrefetchQueue.call(ctrl);
    assert.deepEqual(downloads,[url],'only existing high-res queued prefetch is requested');
    assert.equal(host.children[0],preview);
    pending[0]();
    await Promise.resolve();await Promise.resolve();await Promise.resolve();
    assert.equal(ctrl.handoff.quality,'high');
    assert.equal(host.children[0],ctrl.prefetched.get(url).image);
    assert.deepEqual(downloads,[url],'upgrade must not fetch another small/large variant');
    assert.equal(ctrl.prefetchInFlight,0);
  }finally{
    context.Image=oldImage;context.navigator=oldNav;
    context.window.setTimeout=oldSet;context.window.clearTimeout=oldClear;
    document.hidden=oldHidden;state.pathname=oldPath;
  }
});

test('wrong media ID or closed handoff cannot be promoted after late decode', () => {
  const url='https://pbs.twimg.com/media/EXPECTED89?format=jpg&name=large';
  const image={naturalWidth:800,classList:{add(){}}};
  const host={children:[{}],replaceChildren(){throw Error('should not touch unrelated overlay')}};
  const ctrl=Object.assign(Object.create(proto),{
    navGeneration:10,
    handoff:{quality:'low',generation:10,host,targetPhotoIdentity:'UNRELATED',
      targetPrefetchUrl:url},
    prefetched:new Map([[url,{ready:true,image}]]),
  });
  assert.equal(proto.promoteVisualHandoff.call(ctrl),false);
  assert.equal(ctrl.handoff.quality,'low');
  ctrl.handoff=null;
  assert.equal(proto.promoteVisualHandoff.call(ctrl),false,'closed overlay cannot reappear');
});



test('canvas preview is optional and navigation remains possible when drawImage fails', () => {
  const oldCreate=document.createElement;
  const target=ref('/alice/status/91/photo/1');
  const url='https://pbs.twimg.com/media/FALLBACK91?format=jpg&name=small';
  const image={currentSrc:url,src:url,complete:true,naturalWidth:320,naturalHeight:200};
  const link={isConnected:true,getAttribute(){return target.href;},
    querySelector(){return image;}};
  document.createElement=tag=>{
    assert.equal(tag,'canvas');
    return {width:0,height:0,getContext(){return {drawImage(){throw new Error('GPU unavailable');}};}};
  };
  const ctrl=Object.assign(Object.create(proto),{originProfile:'alice',imageSources:new Map([[
    target.key,'https://pbs.twimg.com/media/FALLBACK91?format=jpg&name=large']])});
  try {
    assert.equal(proto.captureLowQualityThumbnail.call(ctrl,target,link),null,
      'optional low-res preview must not block native X navigation');
  }finally{document.createElement=oldCreate;}
});

test('progressive preview never opens on a different post or when X navigation aborts', async () => {
  const previous=state.pathname;
  const original=ref('/alice/status/101/photo/1');
  const target=ref('/alice/status/102/photo/1');
  state.pathname=original.href;
  let shown=0,closed=0;
  const viewer={isConnected:true};
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice',navGeneration:5,viewer,navigationBusy:false,
    refs:[original,target],activeIndex(){return 0;},
    findLiveLink(){return {isConnected:true};},
    updateViewerState(){},findCloseButton(){return {click(){throw Error('must not close');}};},
    beginVisualHandoff(){this.handoff={targetStatus:'102',targetMediaIndex:1};return true;},
    tryNativeInModalNavigation:async()=>{
      state.pathname='/alice/status/999/photo/1';return 'abort';
    },
    showVisualHandoff(){shown++;},
    clearVisualHandoff(){closed++;this.handoff=null;},
  });
  try {
    await proto.navigate.call(ctrl,1);
    assert.equal(shown,0,'wrong target route must never reveal the low-res future image');
    assert.equal(closed,1,'aborted SPA must clear the pending placeholder');
    assert.equal(ctrl.handoff,null);
  }finally{state.pathname=previous;}
});

test('public FxEmbed continuation aligns with verified native tail, never guesses a post ID', async () => {
  const oldPath=state.pathname,oldHidden=document.hidden,oldNav=context.navigator;
  document.hidden=false;context.navigator={onLine:true};
  const refs=[ref('/alice/status/400/photo/1'),ref('/alice/status/300/photo/1'),
    ref('/alice/status/200/photo/1')];
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice',refs,indexes:new Map(refs.map((r,i)=>[r.key,i])),
    publicApiKeys:new Set(),publicApiAnchorFound:false,
    publicApiCursor:null,publicApiExhausted:false,publicApiLoading:false,
    imageSources:new Map(), navigationBusy:false,
    updateViewerState(){},persistPublicMediaSession(){return true;},
    fetchPublicMediaPage:async()=>({
      refs:[
        ref('/alice/status/500/photo/1'),ref('/alice/status/400/photo/1'),
        ref('/alice/status/300/photo/1'),ref('/alice/status/200/photo/1'),
        ref('/alice/status/100/photo/1'),ref('/alice/status/90/photo/1')],
      photos:[['100:photo:1','https://pbs.twimg.com/media/OLDER100?format=jpg&name=large']],
      cursor:null,
    }),
  });
  try {
    assert.equal(await proto.loadPublicMediaContinuation.call(ctrl),true);
    assert.deepEqual(ctrl.refs.slice(-2).map(x=>x.statusId),['100','90']);
    assert.equal(ctrl.publicApiKeys.has('100:photo:1'),true);
    assert.equal(ctrl.publicApiKeys.has('500:photo:1'),false,'do not append already newer posts');
    assert.equal(ctrl.imageSources.get('100:photo:1'),
      'https://pbs.twimg.com/media/OLDER100?format=jpg&name=large');
    assert.equal(ctrl.navigationBusy,false);
  } finally {state.pathname=oldPath;document.hidden=oldHidden;context.navigator=oldNav;}
});

test('wrong external API timeline does not pollute verified native order', async () => {
  const oldHidden=document.hidden,oldNav=context.navigator;
  document.hidden=false;context.navigator={onLine:true};
  const refs=[ref('/alice/status/400/photo/1'),ref('/alice/status/300/photo/1')];
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice',refs,indexes:new Map(refs.map((r,i)=>[r.key,i])),
    publicApiKeys:new Set(),publicApiAnchorFound:false,publicApiCursor:null,
    navigationBusy:false,publicApiExhausted:false,publicApiLoading:false,
    imageSources:new Map(),updateViewerState(){},
    fetchPublicMediaPage:async()=>({refs:[
      ref('/alice/status/400/photo/1'),ref('/alice/status/299/photo/1')],
      photos:[],cursor:null}),
  });
  try{
    assert.equal(await proto.loadPublicMediaContinuation.call(ctrl),false);
    assert.equal(ctrl.refs.length,2,'native timeline remains untouched');
  }finally{document.hidden=oldHidden;context.navigator=oldNav;}
});

test('public media HTTP request sends no cookies, user data, or referrer', async () => {
  const oldFetch=context.fetch,oldAbort=context.AbortController,
    oldSet=context.window.setTimeout,oldClear=context.window.clearTimeout;
  const calls=[];
  context.AbortController=AbortController;
  context.fetch=async(url,options)=>{
    calls.push({url,options});
    return {ok:true,headers:{get(){return null;}},
      async text(){return JSON.stringify({code:200,results:[],cursor:{bottom:null}});}};
  };
  context.window.setTimeout=()=>33;context.window.clearTimeout=()=>{};
  const ctrl=Object.assign(Object.create(proto),{originProfile:'alice'});
  try{
    assert.ok(await proto.fetchPublicMediaPage.call(ctrl,null));
    assert.equal(calls.length,1);
    assert.match(calls[0].url,/^https:\/\/api\.fxtwitter\.com\/2\/profile\/alice\/media\?count=100$/);
    assert.equal(calls[0].options.credentials,'omit');
    assert.equal(calls[0].options.referrerPolicy,'no-referrer');
    assert.equal(calls[0].options.mode,'cors');
    assert.deepEqual(Object.keys(calls[0].options.headers),['Accept']);
  }finally{
    context.fetch=oldFetch;context.AbortController=oldAbort;
    context.window.setTimeout=oldSet;context.window.clearTimeout=oldClear;
  }
});

test('one-time public API consent uses worker-owned tab state, never page storage',async()=>{
 const prev=state.pathname,oldConfirm=context.window.confirm,hidden=document.hidden,nav=context.navigator;
 const consent={allowed:false,stored:null,grants:0},navigations=[];
 context.window.confirm=()=>true;
 state.pathname='/alice/status/200/photo/1';state.assign=href=>navigations.push(href);
 document.hidden=false;context.navigator={onLine:true};
 const current=ref('/alice/status/200/photo/1');
 const ctrl=Object.assign(Object.create(proto),{
  originProfile:'alice',originTimeline:'alice|default',
  refs:[current],indexes:new Map([[current.key,0]]),
  viewer:{isConnected:true},navigationBusy:false,navGeneration:2,
  publicApiKeys:new Set(),publicApiAnchorFound:false,publicApiCursor:null,
  publicApiExhausted:false,publicApiLoading:false,imageSources:new Map(),
  knownPhotoTotals:new Map(),activeIndex(){return 0},updateViewerState(){},
  findLiveLink(){return null},toast(message){throw Error(message)},
  sessionStore:{
   async hasConsent(){return consent.allowed},
   async grantConsent(){consent.allowed=true;consent.grants++;return true},
   async save(data){consent.stored=data;return true}
  },
  fetchPublicMediaPage:async()=>({refs:[current,ref('/alice/status/100/photo/1')],
   photos:[],cursor:null})
 });
 try{
  await proto.navigate.call(ctrl,1);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(navigations,['/alice/status/100/photo/1']);
  assert.equal(consent.allowed,true);assert.equal(consent.grants,1);
  assert.equal(consent.stored?.profile,'alice');
  assert.equal(consent.stored?.refs.length,2);
 }finally{
  state.pathname=prev;delete state.assign;
  context.window.confirm=oldConfirm;document.hidden=hidden;context.navigator=nav;
 }
});

test('worker-owned media session restores exact routes but never another profile',async()=>{
 const before=state.pathname;
 const latest=ref('/alice/status/100/photo/1'),api=ref('/alice/status/90/photo/1');
 const source='https://pbs.twimg.com/media/CACHED90?format=jpg&name=large';
 let snapshot={
  profile:'alice',timeline:'alice|photo',expires:Date.now()+90000,
  refs:[latest.href,api.href],apiKeys:[api.key],
  photos:[[api.key,source]],photoTotals:[],cursor:'NEXT',
  anchorFound:true,exhausted:false
 };
 const ctrl=Object.assign(Object.create(proto),{
  originProfile:null,navGeneration:0,refs:[],indexes:new Map(),publicApiKeys:new Set(),
  imageSources:new Map(),knownPhotoTotals:new Map(),
  sessionStore:{async load(profile){
   return snapshot.profile===profile&&snapshot.expires>Date.now()?snapshot:null
  }}
 });
 try{
  state.pathname=api.href;
  await proto.restorePublicMediaSession.call(ctrl);
  assert.equal(ctrl.originProfile,'alice');
  assert.equal(ctrl.refs.length,2);
  assert.equal(ctrl.indexes.get(api.key),1);
  assert.equal(ctrl.publicApiKeys.has(api.key),true);
  assert.equal(ctrl.imageSources.get(api.key),source);
  assert.equal(ctrl.publicApiCursor,'NEXT');
  ctrl.originProfile=null;ctrl.refs=[];ctrl.indexes.clear();ctrl.publicApiKeys.clear();
  state.pathname='/bob/status/90/photo/1';
  await proto.restorePublicMediaSession.call(ctrl);
  assert.equal(ctrl.originProfile,null);
  state.pathname=latest.href;
  await proto.restorePublicMediaSession.call(ctrl);
  assert.equal(ctrl.originProfile,'alice');
  ctrl.originProfile=null;ctrl.refs=[];ctrl.indexes.clear();ctrl.publicApiKeys.clear();
  snapshot={...snapshot,expires:Date.now()-1000};
  state.pathname=api.href;
  await proto.restorePublicMediaSession.call(ctrl);
  assert.equal(ctrl.originProfile,null);
 }finally{state.pathname=before;}
});

test('public continuation is discarded when X route changes during the API request', async () => {
  const oldPath=state.pathname,oldHidden=document.hidden,oldNav=context.navigator;
  state.pathname='/alice/status/200/photo/1';
  document.hidden=false;context.navigator={onLine:true};
  const current=ref('/alice/status/200/photo/1'),next=ref('/alice/status/100/photo/1');
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice',originTimeline:'alice|photo',
    refs:[current],indexes:new Map([[current.key,0]]),
    publicApiKeys:new Set(),publicApiAnchorFound:false,publicApiCursor:null,
    publicApiExhausted:false,publicApiLoading:false,
    imageSources:new Map(),navGeneration:6,
    navigationBusy:false,updateViewerState(){},
    fetchPublicMediaPage:async()=>{state.pathname='/bob/status/1/photo/1';
      return {refs:[current,next],photos:[],cursor:null};},
    persistPublicMediaSession(){throw Error('must not store results after tab navigation');},
  });
  try {
    assert.equal(await proto.loadPublicMediaContinuation.call(ctrl),false);
    assert.deepEqual(ctrl.refs.map(r=>r.statusId),['200']);
    assert.equal(ctrl.publicApiKeys.size,0);
    assert.equal(ctrl.navigationBusy,false);
  }finally{state.pathname=oldPath;document.hidden=oldHidden;context.navigator=oldNav;}
});

test('storage quota failure rolls back appended public media and leaves native refs untouched', async () => {
  const oldPath=state.pathname,oldHidden=document.hidden,oldNav=context.navigator;
  state.pathname='/alice/status/200/photo/1';
  document.hidden=false;context.navigator={onLine:true};
  const current=ref('/alice/status/200/photo/1'),next=ref('/alice/status/100/photo/1');
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice',originTimeline:'alice|photo',
    refs:[current],indexes:new Map([[current.key,0]]),
    publicApiKeys:new Set(),publicApiAnchorFound:false,publicApiCursor:null,
    publicApiExhausted:false,publicApiLoading:false,navGeneration:6,
    imageSources:new Map(),navigationBusy:false,updateViewerState(){},
    fetchPublicMediaPage:async()=>({refs:[current,next],
      photos:[[next.key,'https://pbs.twimg.com/media/YES?format=jpg&name=large']],cursor:null}),
    persistPublicMediaSession(){return false;},
  });
  try{
    assert.equal(await proto.loadPublicMediaContinuation.call(ctrl),false);
    assert.deepEqual(ctrl.refs.map(r=>r.statusId),['200']);
    assert.equal(ctrl.indexes.has(next.key),false);
    assert.equal(ctrl.publicApiKeys.size,0);
    assert.equal(ctrl.imageSources.has(next.key),false);
    assert.equal(ctrl.publicApiAnchorFound,false);
    assert.equal(ctrl.publicApiCursor,null);
    assert.equal(ctrl.navigationBusy,false);
  }finally{state.pathname=oldPath;document.hidden=oldHidden;context.navigator=oldNav;}
});

test('external media continuation rejects API chronology inversions without editing native refs', async () => {
  const before=state.pathname,oldHidden=document.hidden,oldNav=context.navigator;
  state.pathname='/alice/status/300/photo/1';
  document.hidden=false;context.navigator={onLine:true};
  const native=[ref('/alice/status/400/photo/1'),ref('/alice/status/300/photo/1')];
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice',originTimeline:'alice|photo',refs:native,
    indexes:new Map(native.map((r,i)=>[r.key,i])),
    publicApiKeys:new Set(),publicApiAnchorFound:false,
    publicApiCursor:null,publicApiExhausted:false,publicApiLoading:false,
    navigationBusy:false,imageSources:new Map(),updateViewerState(){},
    fetchPublicMediaPage:async()=>({
      refs:[native[0],native[1],
        ref('/alice/status/200/photo/1'),
        ref('/alice/status/250/photo/1')],
      photos:[],cursor:null,
    }),
    persistPublicMediaSession(){throw Error('invalid API ordering must never persist');},
  });
  try{
    assert.equal(await proto.loadPublicMediaContinuation.call(ctrl),false);
    assert.equal(ctrl.refs.length,2);
    assert.equal(ctrl.publicApiKeys.size,0);
    assert.equal(ctrl.publicApiLoading,false);
  }finally{state.pathname=before;document.hidden=oldHidden;context.navigator=oldNav;}
});

test('bounded URL session refuses partial albums rather than skipping cursor pages', async () => {
  const before=state.pathname,oldHidden=document.hidden,oldNav=context.navigator;
  const oldTimer=context.window.setTimeout;
  // Expose a real timer for this pagination-delay scenario in the isolated VM.
  context.window.setTimeout=(cb,ms)=>setTimeout(cb,ms);
  const refs=Array.from({length:449},(_,i)=>ref('/alice/status/'+(1000-i)+'/photo/1'));
  const last=refs[448];
  state.pathname=last.href;document.hidden=false;context.navigator={onLine:true};
  const future=[
    ref('/alice/status/500/photo/1'),ref('/alice/status/500/photo/2')],
    ctrl=Object.assign(Object.create(proto),{
      originProfile:'alice',originTimeline:'alice|photo',refs,
      indexes:new Map(refs.map((r,i)=>[r.key,i])),
      publicApiKeys:new Set(),publicApiAnchorFound:true,
      publicApiCursor:'old',publicApiExhausted:false,publicApiLoading:false,
      imageSources:new Map(),navigationBusy:false,updateViewerState(){},
      fetchPublicMediaPage:async()=>({
        refs:future,photos:[],cursor:'new',
      }),persistPublicMediaSession(){throw Error('over-budget continuation must not persist');},
    });
  try{
    assert.equal(await proto.loadPublicMediaContinuation.call(ctrl),false);
    assert.equal(ctrl.refs.length,449);
    assert.equal(ctrl.publicApiKeys.size,0);
    assert.equal(ctrl.publicApiCursor,'old');
  }finally{state.pathname=before;document.hidden=oldHidden;context.navigator=oldNav;
    context.window.setTimeout=oldTimer;}
});

test('API photo album size survives worker session restore after document handoff',async()=>{
 const prev=state.pathname,hidden=document.hidden,nav=context.navigator;
 document.hidden=false;context.navigator={onLine:true};
 const initial=ref('/alice/status/200/photo/1');
 const next1=ref('/alice/status/100/photo/1'),next2=ref('/alice/status/100/photo/2');
 let saved=null;
 state.pathname=initial.href;
 const store={async save(data){saved=data;return true},
   async load(profile){return saved?.profile===profile?saved:null}};
 const ctrl=Object.assign(Object.create(proto),{
  originProfile:'alice',originTimeline:'alice|photo',
  refs:[initial],indexes:new Map([[initial.key,0]]),
  publicApiKeys:new Set(),publicApiAnchorFound:false,publicApiCursor:null,
  publicApiExhausted:false,publicApiLoading:false,knownPhotoTotals:new Map(),
  imageSources:new Map(),navGeneration:3,navigationBusy:false,
  sessionStore:store,updateViewerState(){},
  fetchPublicMediaPage:async()=>({refs:[initial,next1,next2],photos:[],cursor:null})
 });
 try{
  assert.equal(await proto.loadPublicMediaContinuation.call(ctrl),true);
  assert.equal(ctrl.knownPhotoTotals.get('100'),2);
  assert.deepEqual(Array.from(saved.photoTotals,([id,n])=>[id,n]),[['100',2]]);
  state.pathname=next2.href;
  const nextCtrl=Object.assign(Object.create(proto),{
   originProfile:null,navGeneration:0,refs:[],indexes:new Map(),
   sessionStore:store,publicApiKeys:new Set(),
   imageSources:new Map(),knownPhotoTotals:new Map()
  });
  await proto.restorePublicMediaSession.call(nextCtrl);
  assert.equal(nextCtrl.knownPhotoTotals.get('100'),2);
 }finally{state.pathname=prev;document.hidden=hidden;context.navigator=nav;}
});

test('restored public session can navigate back to a previously verified native post', async () => {
  const oldPath=state.pathname,oldAssign=state.assign;
  const native=ref('/alice/status/200/photo/1');
  const api=ref('/alice/status/100/photo/1');
  const navigations=[];
  state.pathname=api.href;
  state.assign=(href)=>navigations.push(href);
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice',originTimeline:'alice|default',navGeneration:2,
    refs:[native,api],indexes:new Map([[native.key,0],[api.key,1]]),
    publicApiKeys:new Set([api.key]),publicSessionRestored:true,
    viewer:{isConnected:true},navigationBusy:false,
    activeIndex(){return 1;},
    findLiveLink(){return null;},
    updateViewerState(){},
    persistPublicMediaSession(){return true;},
    toast(msg){throw Error(msg);},
  });
  try {
    await proto.navigate.call(ctrl,-1);
    assert.deepEqual(navigations,[native.href],
      'return to a verified native URL even after the original X grid is no longer mounted');
  } finally {
    state.pathname=oldPath;
    if(oldAssign===undefined)delete state.assign;else state.assign=oldAssign;
  }
});
test('FxEmbed continuation keeps the original X Photos/Videos media filter', async () => {
  const oldPath=state.pathname,oldHidden=document.hidden,oldNav=context.navigator;
  document.hidden=false;context.navigator={onLine:true};
  try {
    for(const kind of ['photo','video']) {
      const other=kind==='photo'?'video':'photo';
      const native=[ref(`/alice/status/500/${kind}/1`),ref(`/alice/status/400/${kind}/1`)];
      const allowed=ref(`/alice/status/300/${kind}/1`);
      const unrelated=ref(`/alice/status/200/${other}/1`);
      state.pathname=native[1].href;
      const ctrl=Object.assign(Object.create(proto),{
        originProfile:'alice',originTimeline:'alice|'+kind,
        refs:native,indexes:new Map(native.map((r,i)=>[r.key,i])),
        publicApiKeys:new Set(),publicApiAnchorFound:false,
        publicApiCursor:null,publicApiExhausted:false,publicApiLoading:false,
        imageSources:new Map(),knownPhotoTotals:new Map(),navGeneration:12,
        navigationBusy:false,updateViewerState(){},persistPublicMediaSession(){return true;},
        fetchPublicMediaPage:async()=>({refs:[...native,allowed,unrelated],photos:[],cursor:null}),
      });
      assert.equal(await proto.loadPublicMediaContinuation.call(ctrl),true);
      assert.deepEqual(ctrl.refs.map(r=>r.key),[native[0].key,native[1].key,allowed.key],
        'must never append '+other+' posts to the '+kind+' filter');
    }
  } finally {state.pathname=oldPath;document.hidden=oldHidden;context.navigator=oldNav;}
});

test('restored API session resets stale media ordering when returning to X media tab', () => {
  const oldPath=state.pathname,oldSearch=state.search;
  state.pathname='/alice/media';state.search='?filter=photo';
  let resets=0,scans=0;
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice',originTimeline:'alice|photo',publicSessionRestored:true,
    refs:[ref('/alice/status/400/photo/1'),ref('/alice/status/300/photo/1')],
    indexes:new Map(),pendingGrid:null,lastPath:'/alice/status/300/photo/1',
    resetSession(){resets++;this.refs=[];this.indexes.clear();
      this.publicSessionRestored=false;this.originProfile=null;},
    ensureListObserver(){return true;},scanTiles(){scans++;},
    syncModalObserver(){},removeViewerUI(){},
  });
  try {
    proto.tick.call(ctrl);
    assert.equal(resets,1,'stale API ordering must not be kept on a newly mounted X grid');
    assert.equal(scans,1,'index the current native media grid after reset');
    assert.equal(ctrl.publicSessionRestored,false);
    assert.equal(ctrl.originTimeline,'alice|photo');
  } finally {state.pathname=oldPath;state.search=oldSearch;}
});

test('worker-consented FxEmbed warmup runs only near end and once per cursor',async()=>{
 const prev=state.pathname,hidden=document.hidden,oldTimer=context.window.setTimeout;
 let granted=false,scheduled=null,requests=0;
 document.hidden=false;
 context.window.setTimeout=(cb,delay)=>{scheduled={cb,delay};return 17};
 const refs=Array.from({length:8},(_,i)=>
   ref('/alice/status/'+(800-i*100)+'/photo/1'));
 const ctrl=Object.assign(Object.create(proto),{
  originProfile:'alice',originTimeline:'alice|photo',refs,
  viewer:{isConnected:true},publicApiAnchorFound:true,
  publicApiCursor:'OPAQUE_A',publicApiExhausted:false,
  publicApiLoading:false,navigationBusy:false,publicApiWarmCursor:null,
  publicApiWarmTimer:null,
  sessionStore:{async hasConsent(){return granted}},
  loadPublicMediaContinuation:async background=>{
   assert.equal(background,true);requests++;return true;
  }
 });
 try{
  state.pathname=refs[4].href;
  await ctrl.schedulePublicMediaWarmup(4);
  assert.equal(scheduled,null,'never fetch before opt-in');
  granted=true;
  await ctrl.schedulePublicMediaWarmup(1);
  assert.equal(scheduled,null,'not near end');
  await ctrl.schedulePublicMediaWarmup(4);
  assert.equal(scheduled.delay,400);
  assert.equal(ctrl.publicApiWarmCursor,null,'queued timer is not proof of a started request');
  scheduled.cb();
  assert.equal(ctrl.publicApiWarmCursor,'OPAQUE_A');
  assert.equal(requests,1);
  scheduled=null;
  await ctrl.schedulePublicMediaWarmup(6);
  assert.equal(scheduled,null,'one warmup per cursor');
  ctrl.publicApiCursor='OPAQUE_B';
  await ctrl.schedulePublicMediaWarmup(6);
  assert.equal(scheduled.delay,400);
 }finally{
  state.pathname=prev;document.hidden=hidden;
  context.window.setTimeout=oldTimer;
 }
});

test('background FxEmbed continuation never locks the visible gallery',async()=>{
  const oldPath=state.pathname,oldHidden=document.hidden,oldNav=context.navigator;
  document.hidden=false;context.navigator={onLine:true};
  const native=[ref('/alice/status/300/photo/1'),ref('/alice/status/200/photo/1')];
  const older=ref('/alice/status/100/photo/1');
  const ctrl=Object.assign(Object.create(proto),{

    originProfile:'alice',originTimeline:'alice|photo',
    refs:native,indexes:new Map(native.map((r,i)=>[r.key,i])),
    publicApiKeys:new Set(),publicApiAnchorFound:true,publicApiCursor:'CURSOR',
    publicApiExhausted:false,publicApiLoading:false,knownPhotoTotals:new Map(),
    imageSources:new Map(),navGeneration:5,navigationBusy:false,
    updateViewerState(){assert.equal(this.navigationBusy,false);},
    persistPublicMediaSession(){return true;},
    fetchPublicMediaPage:async()=>({refs:[older],photos:[],cursor:null}),
  });
  try {
    state.pathname=native[1].href;
    assert.equal(await proto.loadPublicMediaContinuation.call(ctrl,true),true);
    assert.equal(ctrl.navigationBusy,false,'background prefetch must not disable X post arrows');
    assert.equal(ctrl.publicApiLoading,false);
    assert.equal(ctrl.refs.at(-1).key,older.key);
  }finally{state.pathname=oldPath;document.hidden=oldHidden;context.navigator=oldNav;}
});

test('diagnostics identify the actual low-quality visible handoff and completion',()=>{
  const oldConsole=context.console,oldSet=context.window.setTimeout,
    oldClear=context.window.clearTimeout;
  const logs=[];
  context.console={info:(...args)=>logs.push(args)};
  context.window.clearTimeout=()=>{};
  context.window.setTimeout=()=>19;
  const handoff={
    generation:8,quality:'low',shown:false,shownAt:null,

    timeout:3,revealTimer:null,observer:null,waitingImage:null,
    waitingLoadHandler:null,host:{
      classList:{add(){}},remove(){},contains(){return false;}
    },
  };
  const ctrl=Object.assign(Object.create(proto),{
    navGeneration:8,handoff,promoteVisualHandoff(){return false;},
  });
  try {
    proto.showVisualHandoff.call(ctrl);
    assert.equal(handoff.shown,true);
    assert.ok(handoff.shownAt);
    proto.clearVisualHandoff.call(ctrl,'native_photo_ready');
    assert.equal(ctrl.handoff,null);
    assert.ok(logs.some(([message,details])=>
      message.includes('preview.visible') && details.quality==='low'));
    assert.ok(logs.some(([message,details])=>
      message.includes('preview.finished') && details.reason==='native_photo_ready'
      && details.visible===true));
    assert.ok(logs.every(([message,details])=>
      !String(message+JSON.stringify(details)).includes('https://')));
  }finally{
    context.console=oldConsole;
    context.window.setTimeout=oldSet;
    context.window.clearTimeout=oldClear;
  }
});

test('FxEmbed stale cursor cannot append newer posts after an older indexed tail',async()=>{
  const oldPath=state.pathname,oldHidden=document.hidden,oldNav=context.navigator;
  state.pathname='/alice/status/200/photo/1';
  document.hidden=false;context.navigator={onLine:true};
  const native=[ref('/alice/status/400/photo/1'),
    ref('/alice/status/300/photo/1'),ref('/alice/status/200/photo/1')];
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice',originTimeline:'alice|photo',navGeneration:7,
    refs:[...native],indexes:new Map(native.map((r,i)=>[r.key,i])),
    publicApiKeys:new Set(),publicApiAnchorFound:true,
    publicApiCursor:'cursor-stale',publicApiExhausted:false,
    publicApiLoading:false,navigationBusy:false,
    imageSources:new Map(),knownPhotoTotals:new Map(),updateViewerState(){},
    fetchPublicMediaPage:async()=>({
      refs:[ref('/alice/status/250/photo/1'),ref('/alice/status/150/photo/1')],
      photos:[],cursor:null,
    }),
    persistPublicMediaSession(){return true;},
  });
  try {
    assert.equal(await proto.loadPublicMediaContinuation.call(ctrl),false);
    assert.deepEqual(ctrl.refs.map(r=>r.statusId),['400','300','200']);
    assert.equal(ctrl.publicApiCursor,'cursor-stale');
    assert.equal(ctrl.publicApiKeys.size,0);
  }finally{state.pathname=oldPath;document.hidden=oldHidden;context.navigator=oldNav;}
});

test('FxEmbed cursor may repeat exactly the previous last status before older posts',async()=>{
  const oldPath=state.pathname,oldHidden=document.hidden,oldNav=context.navigator;
  state.pathname='/alice/status/200/photo/1';
  document.hidden=false;context.navigator={onLine:true};
  const native=[ref('/alice/status/300/photo/1'),ref('/alice/status/200/photo/1')];
  const next=ref('/alice/status/150/photo/1');
  const ctrl=Object.assign(Object.create(proto),{
    originProfile:'alice',originTimeline:'alice|photo',navGeneration:8,
    refs:[...native],indexes:new Map(native.map((r,i)=>[r.key,i])),
    publicApiKeys:new Set(),publicApiAnchorFound:true,
    publicApiCursor:'page2',publicApiExhausted:false,publicApiLoading:false,
    navigationBusy:false,imageSources:new Map(),knownPhotoTotals:new Map(),
    updateViewerState(){},
    fetchPublicMediaPage:async()=>({refs:[native[1],next],photos:[],cursor:null}),
    persistPublicMediaSession(){return true;},
  });
  try{
    assert.equal(await proto.loadPublicMediaContinuation.call(ctrl),true);
    assert.deepEqual(ctrl.refs.map(r=>r.statusId),['300','200','150']);
    assert.equal(ctrl.publicApiKeys.has(next.key),true);
    assert.equal(ctrl.publicApiKeys.has(native[1].key),false);
  }finally{state.pathname=oldPath;document.hidden=oldHidden;context.navigator=oldNav;}
});
