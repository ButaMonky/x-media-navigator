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
  const instance=Object.assign(Object.create(proto),{originProfile:'alice',pendingGrid:null,refs:[],indexes:new Map(),imageSources:new Map()});
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

test('an owned thumbnail avoids searching the surrounding tile for images again', () => {
  const entry=ref('/alice/status/18/photo/1');
  const image={currentSrc:'https://pbs.twimg.com/media/OWNED?format=jpg&name=small',src:''};
  const link={querySelector(){return image;}};
  const tile={querySelectorAll(){throw Error('tile-wide image query is redundant when link owns its thumbnail')}};
  const ctrl=Object.assign(Object.create(proto),{imageSources:new Map(),imageSourcesRevision:0});
  proto.recordTileImageSource.call(ctrl,tile,{link,ref:entry});
  assert.equal(ctrl.imageSources.get(entry.key),'https://pbs.twimg.com/media/OWNED?format=jpg&name=large');
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
