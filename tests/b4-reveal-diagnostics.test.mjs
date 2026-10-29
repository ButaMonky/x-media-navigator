import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../extension/content_script.js',import.meta.url),'utf8');
function trial(revealFails){
 const logs=[],changes=[];
 const fakeConsole={info(message,detail){logs.push({message,detail})}};
 const win={location:{pathname:'/alice/status/2/photo/1'},
  addEventListener(){},setTimeout(fn,ms){return 5},
  clearTimeout(handle){changes.push('cleared-'+handle)}};
 const context=vm.createContext({
  URL,URLSearchParams,Map,Set,Date,console:fakeConsole,
  window:win,document:{readyState:'loading',addEventListener(){}},
  Element:class {}
 });
 vm.runInContext(source,context);
 const handoff={quality:'low',generation:3,shown:false,shownAt:null,timeout:4,
  host:{classList:{add(value){
   if(revealFails)throw Error('fixture: classList failed');
   changes.push('applied-'+value);
  }}}};
 const ctl=Object.assign(Object.create(context.XMN.Controller.prototype),{
  navGeneration:3,handoff,promoteVisualHandoff(){return false},
  clearVisualHandoff(){changes.push('disposed');this.handoff=null}
 });
 ctl.showVisualHandoff();
 return {logs,changes,handoff,ctl};
}

test('R-010: preview.visible is logged only after the DOM reveal instruction',()=>{
 const r=trial(false);
 const visible=r.logs.filter(x=>x.message.endsWith('preview.visible'));
 assert.equal(visible.length,1);
 assert.equal(r.changes[0],'applied-xmn-handoff-visible');
 assert.equal(r.handoff.shown,true);
 assert.ok(typeof r.handoff.shownAt==='number');
 assert.equal(visible[0].detail.quality,'low');
});
test('R-010: failed classList reveal cannot produce false visible event',()=>{
 const r=trial(true);
 const visible=r.logs.filter(x=>x.message.endsWith('preview.visible'));
 const rejected=r.logs.filter(x=>x.message.endsWith('preview.skipped'));
 assert.equal(visible.length,0);
 assert.equal(rejected.length,1);
 assert.equal(rejected[0].detail.reason,'reveal_failed');
 assert.equal(r.handoff.shown,false);
 assert.equal(r.ctl.handoff,null);
 assert.equal(r.changes.includes('disposed'),true);
});
