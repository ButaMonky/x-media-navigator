import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const js=readFileSync(new URL('../extension/content_script.js',import.meta.url),'utf8');
const context=vm.createContext({
 URL,URLSearchParams,Map,Set,Date,console,Element:class{},
 window:{location:{pathname:'/alice/status/900/photo/1'},addEventListener(){}},
 document:{readyState:'loading',addEventListener(){}}
});
vm.runInContext(js,context);
const X=context.XMN;
const r=id=>'/alice/status/'+id+'/photo/1';
const end=Date.now()+60_000;
const manifest={schema:1,profile:'alice',timeline:'alice|photo',
 expires:end,activePage:0,pages:[
  {page:0,firstRef:r(900),lastRef:r(800),mediaCount:2,
   incomingCursor:null,outgoingCursor:'C1'},
  {page:1,firstRef:r(700),lastRef:r(600),mediaCount:2,
   incomingCursor:'C1',outgoingCursor:'C2'},
  {page:2,firstRef:r(500),lastRef:r(400),mediaCount:2,
   incomingCursor:'C2',outgoingCursor:null}
]};
const plain=v=>JSON.parse(JSON.stringify(v));
test('B2 boundary plan selects one adjacent verified page only',()=>{
 assert.deepEqual(plain(X.planPublicBoundaryTransition(manifest,'alice',r(800),1)),
  {expectedActivePage:0,targetPage:1,direction:1,
   sourceRef:r(800),targetRef:r(700)});
 assert.equal(X.planPublicBoundaryTransition(manifest,'alice',r(900),1),null);
 assert.equal(X.planPublicBoundaryTransition(manifest,'alice',r(800),-1),null);
 assert.equal(X.planPublicBoundaryTransition(manifest,'bob',r(800),1),null);
 assert.equal(X.planPublicBoundaryTransition({...manifest,expires:Date.now()-1},
  'alice',r(800),1),null);
});
test('B2 read-only boundary planning handles reverse movement without guessing',()=>{
 const view={...manifest,activePage:1};
 assert.deepEqual(plain(X.planPublicBoundaryTransition(view,'alice',r(700),-1)),{
  expectedActivePage:1,targetPage:0,direction:-1,
  sourceRef:r(700),targetRef:r(800)
 });
 assert.deepEqual(plain(X.planPublicBoundaryTransition(view,'alice',r(600),1)),{
  expectedActivePage:1,targetPage:2,direction:1,
  sourceRef:r(600),targetRef:r(500)
 });
 assert.equal(X.planPublicBoundaryTransition(view,'alice',r(600),-1),null);
 assert.equal(X.planPublicBoundaryTransition({...manifest,activePage:2},
  'alice',r(400),1),null);
});
