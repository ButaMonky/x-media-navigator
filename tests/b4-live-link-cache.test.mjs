import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../extension/content_script.js',import.meta.url),'utf8');
let root,gridScans=0;
const fakeDocument={
 readyState:'loading',addEventListener(){},
 createElement(){return {textContent:'',className:'',setAttribute(){}};},
 querySelector(selector){return selector==='main [data-testid="primaryColumn"]'?root:null}
};
const context=vm.createContext({
 URL,URLSearchParams,Map,Set,Date,console,Element:class{},
 window:{location:{pathname:'/alice/media'},addEventListener(){}},
 document:fakeDocument
});
vm.runInContext(source,context);
const proto=context.XMN.Controller.prototype;
const ref=id=>context.XMN.mediaRefFromHref('/alice/status/'+id+'/photo/1','alice');
function makeTile(id){
 const tile={isConnected:true,children:[],classList:{add(){}},
 querySelectorAll(selector){
  return selector==='a[href]'?[this.link]:[];
 },querySelector(selector){
  if(selector==='img, video')return {};
  if(selector===':scope > .xmn-tile-badge')return this.children[0]||null;
  return null;
 },appendChild(node){this.children.push(node);return node;}};
 const link={isConnected:true,getAttribute(name){
  return name==='href'?'/alice/status/'+id+'/photo/1':null;
 },closest(selector){return selector==='li[role="listitem"]'?tile:null},
 querySelector(selector){return selector==='img, video'?{}:null}};
 tile.link=link;return {tile,link};
}
const tiles=Array.from({length:2500},(_,i)=>makeTile(6000-i));
function useGrid(items){
 gridScans=0;
 const current=items.map(x=>x.tile);
 root={
  contains(node){return current.includes(node)},
  querySelectorAll(selector){
   if(selector==='li[role="listitem"]'){gridScans++;return current}
   return [];
  }
 };
}
test('R-012: cached observed native link avoids repeated full-grid queries',()=>{
 useGrid(tiles);
 const ctl=Object.assign(Object.create(proto),{
  originProfile:'alice',liveLinks:new Map()
 });
 const first=tiles[1200];
 const target=ref(4800);
 ctl.rememberLiveLink(target,first.link);
 for(let i=0;i<200;i++)assert.equal(ctl.findLiveLink(target),first.link);
 assert.equal(gridScans,0,'200 moves should not scan 2500 tiles');
 assert.equal(ctl.liveLinks.size,1);
});
test('R-012: React recycled/disconnected tile forces safe requery',()=>{
 const original=makeTile(400),replacement=makeTile(400);
 useGrid([original]);
 const ctl=Object.assign(Object.create(proto),{
  originProfile:'alice',liveLinks:new Map()
 });
 const target=ref(400);
 ctl.rememberLiveLink(target,original.link);
 assert.equal(ctl.findLiveLink(target),original.link);
 original.link.isConnected=false;
 useGrid([replacement]);
 assert.equal(ctl.findLiveLink(target),replacement.link);
 assert.equal(gridScans,1);
 assert.equal(ctl.findLiveLink(target),replacement.link);
 assert.equal(gridScans,1);
});

test('R-012: live link cache is bounded and rejects moved unrelated anchors',()=>{
 useGrid([tiles[0]]);
 const ctl=Object.assign(Object.create(proto),{
  originProfile:'alice',liveLinks:new Map()
 });
 for(let i=0;i<1300;i++){
  const item=makeTile(9000-i),target=ref(9000-i);
  ctl.rememberLiveLink(target,item.link,true);
 }
 assert.equal(ctl.liveLinks.size,1024);
 const current=ref(6000);
 ctl.rememberLiveLink(current,tiles[0].link,true);
 assert.equal(ctl.findLiveLink(current),tiles[0].link);
 assert.ok(ctl.liveLinks.size<=1024);
 // The same attached link outside the active media column must never be reused.
 useGrid([tiles[1]]);
 assert.equal(ctl.findLiveLink(current),null);
 assert.ok(gridScans>=1);
});

test('R-012: real scanTiles populates a reusable observed-link index',()=>{
 const current=tiles.slice(0,80);
 useGrid(current);
 const ctrl=Object.assign(Object.create(proto),{
  originProfile:'alice',refs:[],indexes:new Map(),
  imageSources:new Map(),imageSourcesRevision:0,liveLinks:new Map(),
  pendingGrid:null,statusOrdinalCache:null
 });
 ctrl.scanTiles();
 assert.equal(ctrl.refs.length,80);
 assert.equal(ctrl.indexes.size,80);
 assert.equal(ctrl.liveLinks.size,80);
 const target=ref(5971),wanted=current[29].link;
 gridScans=0;
 for(let i=0;i<100;i++)assert.equal(ctrl.findLiveLink(target),wanted);
 assert.equal(gridScans,0);
});

test('R-012: still-connected link whose href changed cannot impersonate old post',()=>{
 const item=makeTile(400);
 useGrid([item]);
 const ctl=Object.assign(Object.create(proto),{
  originProfile:'alice',liveLinks:new Map()
 });
 const target=ref(400);
 ctl.rememberLiveLink(target,item.link,true);
 assert.equal(ctl.findLiveLink(target),item.link);
 item.link.getAttribute=name=>name==='href'?'/alice/status/401/photo/1':null;
 assert.equal(ctl.findLiveLink(target),null);
 assert.equal(ctl.liveLinks.has(target.key),false);
 const newItem=makeTile(400);
 item.tile.link=newItem.link;
 newItem.link.closest=selector=>selector==='li[role="listitem"]'?item.tile:null;
 assert.equal(ctl.findLiveLink(target),newItem.link);
 assert.equal(ctl.liveLinks.get(target.key),newItem.link);
});
