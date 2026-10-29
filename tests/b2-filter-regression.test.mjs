import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../extension/content_script.js',import.meta.url),'utf8');
const context=vm.createContext({
 URL,URLSearchParams,Map,Set,Date,console,Element:class{},
 window:{location:{pathname:'/alice/media'},addEventListener(){}},
 document:{readyState:'loading',addEventListener(){}}
});
vm.runInContext(source,context);
const proto=context.XMN.Controller.prototype;
test('R-043: filter turnover recognizes changed tail with identical eight lead tiles',()=>{
 const col={},leading=Array.from({length:8},(_,i)=>({i}));
 let tail=[{name:'old1'},{name:'old2'}];
 const state=()=>({
  column:col,
  firstTiles:leading,firstKeys:leading.map(x=>String(x.i)),
  lastTiles:tail,lastKeys:tail.map(x=>x.name),tileCount:10
 });
 const old=state();
 const ctl=Object.assign(Object.create(proto),{captureGrid:()=>state()});
 assert.equal(ctl.hasGridTurnedOver(old),false);
 tail=[{name:'new1'},{name:'new2'}];
 assert.equal(ctl.hasGridTurnedOver(old),true);
});
