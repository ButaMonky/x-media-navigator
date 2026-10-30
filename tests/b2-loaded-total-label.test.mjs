import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../extension/content_script.js',import.meta.url),'utf8');
const location={pathname:'/alice/status/300/photo/1',search:''};
const context=vm.createContext({
 URL,URLSearchParams,Map,Set,Date,console,
 window:{location,addEventListener(){}},
 document:{readyState:'loading',hidden:false,addEventListener(){}},
 Element:class{}
});
vm.runInContext(source,context);
const X=context.XMN;
const ref=(id)=>X.mediaRefFromHref('/alice/status/'+id+'/photo/1','alice');
test('R-041: unknown total is visibly different from an exhausted loaded index',()=>{
 const refs=[ref(400),ref(300)];
 const indicator={textContent:'',title:''};
 const next={disabled:false},prev={disabled:false};
 const viewer={isConnected:true,querySelector(s){
  return s==='.xmn-status'?indicator:s==='.xmn-prev'?prev:s==='.xmn-next'?next:null;
 }};
 const ctl=Object.assign(Object.create(X.Controller.prototype),{
  originProfile:'alice',originTimeline:'alice|photo',refs,viewer,
  indexes:new Map(refs.map((r,i)=>[r.key,i])),
  navigationBusy:false,publicApiCursor:'NEXT_PAGE',
  experimentalThirdPartyApiEnabled:true, // preserve opt-in cursor regression
  publicApiAnchorFound:true,publicApiExhausted:false,
  activeIndex(){return 1}
 });
 ctl.updateViewerState();
 assert.equal(indicator.textContent,'投稿 2 / 2+');
 assert.match(indicator.title,/読み込み済み/);
 const oldSnapshot=ctl.viewerStateSnapshot;
 ctl.publicApiCursor=null;ctl.publicApiExhausted=true;
 ctl.updateViewerState();
 assert.equal(indicator.textContent,'投稿 2 / 2');
 assert.notEqual(ctl.viewerStateSnapshot,oldSnapshot,
  'cursor terminal state must invalidate an unchanged route label');
});
