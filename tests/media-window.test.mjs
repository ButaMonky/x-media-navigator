import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('./.build/core.js',import.meta.url),'utf8');
const context=vm.createContext({URL,URLSearchParams,Map,Set});
vm.runInContext(source,context);
const core=context.XMN,ref=(id,pos=1)=>core.mediaRefFromHref(
 '/alice/status/'+id+'/photo/'+pos,'alice');
test('complete-post window retains active identity and does not split album',()=>{
 const posts=Array.from({length:6000},(_,i)=>{
  const id=20000-i;
  return Array.from({length:i%4+1},(_,n)=>ref(id,n+1))
 });
 const all=posts.flat(),anchors=[0,1,3333,10000,all.length-1];
 for(const pos of anchors){
  const current=all[pos],win=core.planMediaWindow(all,current.key,450);
  assert.ok(win);assert.ok(win.refs.length<=450);
  assert.equal(win.refs[win.activeIndex].key,current.key);
  assert.equal(win.base+win.activeIndex,pos);
  const unique=[...new Set(win.refs.map(x=>x.statusId))];
  for(const id of unique){
   assert.equal(win.refs.filter(r=>r.statusId===id).length,
     all.filter(r=>r.statusId===id).length);
  }
 }
});

test('R-042 front insertion retains the SAME active post, not its ordinal',()=>{
 const base=[700,600,500,400].flatMap((id,i)=>
  Array.from({length:i%4+1},(_,n)=>ref(id,n+1)));
 const key=ref(500).key;
 let source=base;
 for(let i=0;i<150;i++){
  source=[...Array.from({length:1+i%4},(_,n)=>ref(701+i,n+1)),...source];
  const win=core.planMediaWindow(source,key,20);
  assert.equal(win?.refs[win.activeIndex].key,key);
  assert.ok(win.refs.length<=20);
 }
});
test('inconsistent working window refuses ambiguous duplicate media keys/groups',()=>{
 const dup=[ref(300),ref(300)];
 assert.equal(core.planMediaWindow(dup,dup[0].key,450),null);
 const split=[ref(300),ref(200),ref(300,2)];
 assert.equal(core.planMediaWindow(split,split[0].key,450),null);
 assert.equal(core.planMediaWindow([ref(300)],'no-such-key'),null);
});
