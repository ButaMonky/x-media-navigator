import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../extension/content_script.js', import.meta.url), 'utf8');
const state = { pathname: '/alice/media', root: null };
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
const context = vm.createContext({ URL, Set, Map, Element:FakeElement, document, window: { location:state }, console });
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

test('real compiled controller handles Shift+Arrow but leaves unmodified arrow to X', () => {
  const calls=[];
  const instance={ viewer:{isConnected:true}, originProfile:'alice', navigationBusy:false,
    activeIndex(){return 0;}, navigate(dir){calls.push(dir);} };
  for (const ev of [keyEvent('ArrowRight'),keyEvent('ArrowLeft'),keyEvent('ArrowRight',{ctrlKey:true,shiftKey:true}),keyEvent('ArrowRight',{shiftKey:true,repeat:true})]) {
    proto.onKeyDown.call(instance,ev);
    assert.equal(ev.prevented,false);
  }
  const right=keyEvent('ArrowRight',{shiftKey:true});
  proto.onKeyDown.call(instance,right);
  assert.equal(right.prevented,true);
  assert.equal(right.stopped,true);
  const left=keyEvent('ArrowLeft',{shiftKey:true});
  proto.onKeyDown.call(instance,left);
  assert.equal(left.prevented,true);
  assert.deepEqual(calls,[1,-1]);
});

test('shortcut is ignored if typing, viewer closed, or list mapping unavailable', () => {
  const calls=[];
  const instance={ viewer:{isConnected:true},originProfile:'alice',navigationBusy:false,
    activeIndex(){return 0;},navigate(dir){calls.push(dir);} };
  const focused=keyEvent('ArrowRight',{shiftKey:true, target:new FakeElement('input')});
  focused.target.closestResult = focused.target;
  proto.onKeyDown.call(instance,focused);
  assert.equal(focused.prevented,false);
  instance.viewer=null;
  proto.onKeyDown.call(instance,keyEvent('ArrowRight',{shiftKey:true}));
  instance.viewer={isConnected:true};
  instance.activeIndex=()=>null;
  proto.onKeyDown.call(instance,keyEvent('ArrowRight',{shiftKey:true}));
  assert.equal(calls.length,0);
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
    activeIndex(){return 0;},findCloseButton(){return null;},toast(){errors++;},updateViewerState(){} };
  await proto.navigate.call(instance,1);
  assert.equal(errors,1);
  assert.equal(instance.navigationBusy,false);
});
