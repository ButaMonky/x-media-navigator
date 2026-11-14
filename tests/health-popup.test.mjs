import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const get=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('diagnostics have a user-openable popup without extra permissions',()=>{
 const manifest=JSON.parse(get('extension/manifest.json'));
 assert.deepEqual(manifest.permissions,['storage']);
 assert.equal(manifest.action.default_popup,'popup.html');
 assert.match(get('extension/popup.html'),/popup\.js/);
 assert.doesNotMatch(get('extension/popup.html'),/onclick=/);
 const script=get('extension/popup.js');
 for(const code of ['VIEWER_READY','MEDIA_GRID_NOT_FOUND','VIEWER_NOT_FOUND','OPEN_MEDIA_TAB_FIRST'])
   assert.ok(script.includes(code));
 assert.doesNotMatch(script,/\.url\b|\.href\b|cookie|authorization/i);
});

test('content diagnostics store only code/version/time, never X identifiers',async()=>{
 const history=[];
 const ctx=vm.createContext({
   URL,URLSearchParams,Date,Set,Map,console,
   chrome:{storage:{local:{set:async value=>history.push(value)}}},
   document:{readyState:'loading',addEventListener(){}},
   window:{location:{pathname:'/sample/media',search:''},addEventListener(){}},
   Element:class{},
 });
 vm.runInContext(get('extension/content_script.js'),ctx);
 const controller=Object.create(ctx.XMN.Controller.prototype);
 controller.reportHealth('MEDIA_GRID_NOT_FOUND');
 controller.reportHealth('MEDIA_GRID_NOT_FOUND');
 await Promise.resolve();
 assert.equal(history.length,1,'same code should not repeatedly write storage');
 assert.deepEqual(Object.keys(history[0]),['xmnHealth']);
 assert.deepEqual(Object.keys(history[0].xmnHealth).sort(),['code','updatedAt','version']);
 assert.equal(history[0].xmnHealth.code,'MEDIA_GRID_NOT_FOUND');
 assert.ok(!JSON.stringify(history).includes('/sample/'));
});
