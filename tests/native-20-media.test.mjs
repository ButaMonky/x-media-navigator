import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const bundle=readFileSync(new URL('../extension/content_script.js',import.meta.url),'utf8');
const ctx=vm.createContext({
  URL,URLSearchParams,Set,Map,Date,console,
  document:{readyState:'loading',addEventListener(){}},
  window:{location:{pathname:'/sample/status/123456789/photo/4',search:''},addEventListener(){}},
  Element:class{},
});
vm.runInContext(bundle,ctx);
const X=ctx.XMN;
const ref=n=>X.mediaRefFromHref('/sample/status/123456789/photo/'+n,'sample');

test('X native post groups accept 1, 4, 5, 10, and 20 observed photos',()=>{
  for(const n of [1,4,5,10,20]){
    const refs=Array.from({length:n},(_,i)=>ref(i+1));
    assert.ok(refs.every(Boolean));
    const groups=X.groupMediaRefs(refs,'x-dom','complete');
    assert.ok(groups, 'should accept '+n+' photos');
    assert.equal(groups[0].refs.length,n);
  }
  assert.equal(X.groupMediaRefs(Array.from({length:21},(_,i)=>ref(i+1)),'x-dom'),null);
});

test('four visible photos are not evidence of complete post after 20 media update',()=>{
  assert.equal(X.completeMaxPhotoSet(new Set([1,2,3,4])),false);
  assert.equal(X.completeMaxPhotoSet(new Set(Array.from({length:20},(_,i)=>i+1))),true);
  assert.deepEqual([...Object.values(X.parseGalleryCounter('Image 5 of 20'))],[5,20]);
  assert.equal(X.parseGalleryCounter('Image 21 of 21'),null);
  const key={key:'ArrowRight',shiftKey:false,altKey:false,ctrlKey:false,metaKey:false};
  assert.equal(X.galleryBoundaryDirection(key,ref(4),null,false,false),null);
  assert.equal(X.galleryBoundaryDirection(key,ref(20),20,false,false),1);
});

test('no post jump at photo four when a partial gallery is visible',()=>{
 const ctl=Object.assign(Object.create(X.Controller.prototype),{
   originProfile:'sample',knownPhotoTotals:new Map(),
 });
 const viewer={closest:()=>null,parentElement:null,querySelectorAll:()=>[]};
 assert.equal(ctl.photoCount(viewer,'123456789'),null);
});
