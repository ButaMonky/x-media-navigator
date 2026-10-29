import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const script=readFileSync(new URL('../extension/content_script.js',import.meta.url),'utf8');
const location={pathname:'/alice/status/400/photo/1',search:''};
const document={readyState:'loading',hidden:false,addEventListener(){}};
const context=vm.createContext({
  URL,URLSearchParams,Map,Set,Date,console,
  window:{location,addEventListener(){},setTimeout,clearTimeout},
  document,navigator:{onLine:true},Element:class{}
});
vm.runInContext(script,context);
const proto=context.XMN.Controller.prototype;
const ref=id=>context.XMN.mediaRefFromHref('/alice/status/'+id+'/photo/1','alice');
function pending(){
  let resolve;
  const promise=new Promise(ok=>{resolve=ok});
  return {promise,resolve};
}
async function waitFor(condition){
  for(let i=0;i<80;i++){
    if(condition())return;
    await new Promise(r=>setTimeout(r,0));
  }
  throw new Error('Continuation did not reach storage');
}
function fixture({terminal=false}={}){
  const native=[ref(500),ref(400)];
  const ctl=Object.assign(Object.create(proto),{
    originProfile:'alice',originTimeline:'alice|photo',navGeneration:3,
    refs:native.slice(),indexes:new Map(native.map((r,i)=>[r.key,i])),
    publicApiKeys:new Set(terminal?[native[1].key]:[]),
    publicApiAnchorFound:true,publicApiCursor:'older',
    publicApiExhausted:false,publicApiLoading:false,publicApiRetryAt:0,
    imageSources:new Map(),knownPhotoTotals:new Map(),imageSourcesRevision:0,
    navigationBusy:false,pendingBoundary:null,statusOrdinalCache:null,
    viewerStateSnapshot:null,updateViewerState(){},toast(){},
    rememberPhotoTotal(){},rememberImageSource(){},
    fetchPublicMediaPage:async()=>({
      refs:terminal?[native[1]]:[native[1],ref(300)],
      photos:[],cursor:null
    })
  });
  return {ctl,native};
}
function assertOriginal(ctl,native){
  assert.deepEqual(ctl.refs.map(x=>x.key),native.map(x=>x.key));
  assert.deepEqual([...ctl.indexes.keys()],native.map(x=>x.key));
  assert.equal(ctl.publicApiCursor,'older');
  assert.equal(ctl.publicApiExhausted,false);
  assert.equal(ctl.publicApiLoading,false);
}
test('tab hidden during worker storage must roll back uncommitted index',async()=>{
  const {ctl,native}=fixture(),gate=pending();
  ctl.persistPublicMediaSession=()=>gate.promise;
  document.hidden=false;
  const task=proto.loadPublicMediaContinuation.call(ctl,true);
  try{
    await waitFor(()=>ctl.refs.length===3);
    assert.equal(ctl.publicApiCursor,null);
    document.hidden=true;
    gate.resolve(true);
    assert.equal(await task,false);
    assertOriginal(ctl,native);
    assert.equal(ctl.publicApiKeys.has(ref(300).key),false);
  }finally{document.hidden=false;gate.resolve(false);}
});
test('hidden during a terminal-only save must not retain phantom exhaustion',async()=>{
  const {ctl,native}=fixture({terminal:true}),gate=pending();
  ctl.persistPublicMediaSession=()=>gate.promise;
  document.hidden=false;
  const task=proto.loadPublicMediaContinuation.call(ctl,true);
  try{
    await waitFor(()=>ctl.publicApiExhausted===true);
    document.hidden=true;
    gate.resolve(true);
    assert.equal(await task,false);
    assertOriginal(ctl,native);
  }finally{document.hidden=false;gate.resolve(false);}
});
test('a new session started during save must never be changed by old rollback',async()=>{
  const {ctl}=fixture(),gate=pending();
  ctl.persistPublicMediaSession=()=>gate.promise;
  document.hidden=false;
  const task=proto.loadPublicMediaContinuation.call(ctl,true);
  try{
    await waitFor(()=>ctl.refs.length===3);
    ctl.navGeneration+=1;
    ctl.originProfile='bob';
    ctl.refs=[ref(999)];
    ctl.indexes=new Map([[ref(999).key,0]]);
    ctl.publicApiCursor='new-cursor';
    gate.resolve(true);
    assert.equal(await task,false);
    assert.deepEqual(ctl.refs.map(x=>x.key),[ref(999).key]);
    assert.equal(ctl.publicApiCursor,'new-cursor');
  }finally{gate.resolve(false);}
});
