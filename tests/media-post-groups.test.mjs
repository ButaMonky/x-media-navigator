import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import {fileURLToPath} from 'node:url';
const context=vm.createContext({URL,URLSearchParams,Map,Set});
const sources=['core.ts','media-window.ts'].map(file=>
 fileURLToPath(new URL('../src/'+file,import.meta.url)));
const opts={target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.None,
 strict:true,noEmitOnError:true,outFile:'media-window-validation.js'};
const program=ts.createProgram(sources,opts);
const diagnostics=ts.getPreEmitDiagnostics(program);
assert.equal(diagnostics.length,0,ts.formatDiagnosticsWithColorAndContext(
 diagnostics,{getCurrentDirectory:()=>process.cwd(),getCanonicalFileName:f=>f,
 getNewLine:()=> '\n'}));
let combined='';
program.emit(undefined,(name,source)=>{if(name.endsWith('.js'))combined=source});
assert.ok(combined.includes('var XMN'),'TypeScript project did not emit namespace');
vm.runInContext(combined,context,{filename:'media-window.js'});
const X=context.XMN;
const ref=(id,index=1,kind='photo')=>
 X.mediaRefFromHref('/alice/status/'+id+'/'+kind+'/'+index,'alice');
const group=(id,count=1,origin='x-dom',complete='complete')=>({
 statusId:String(id),refs:Array.from({length:count},(_,i)=>ref(id,i+1)),
 provenance:origin,completeness:complete
});
const ids=groups=>Array.from(groups,g=>g.statusId);
const json=value=>JSON.parse(JSON.stringify(value));

test('explicit media ownership and complete 1-20 photo album validation',()=>{
 for(let n=1;n<=20;n++)assert.equal(X.validateMediaPostGroup(group(100,n)),true);
 const incomplete=group(100,2);incomplete.refs[1]=ref(100,4);
 assert.equal(X.validateMediaPostGroup(incomplete),false);
 incomplete.completeness='partial';
 assert.equal(X.validateMediaPostGroup(incomplete),true);
 const wrong=group(100,2);wrong.refs[1]=ref(200);
 assert.equal(X.validateMediaPostGroup(wrong),false);
 const duplicate=group(100,2);duplicate.refs[1]=duplicate.refs[0];
 assert.equal(X.validateMediaPostGroup(duplicate),false);
});
test('contiguous status groups stay intact and repeated noncontiguous posts fail',()=>{
 const initial=[ref(500,1),ref(500,2),ref(400,1),ref(400,2)];
 const groups=X.groupMediaRefs(initial,'x-dom','complete');
 assert.deepEqual(ids(groups),['500','400']);
 assert.deepEqual(Array.from(groups,g=>g.refs.length),[2,2]);
 assert.equal(X.groupMediaRefs([ref(500),ref(400),ref(500,2)],'x-dom'),null);
});
test('new native head is added without corrupting the active status',()=>{
 const base=[group(500),group(400),group(300)];
 const next=X.prependNativeGroups(base,[group(700),group(600),group(500)]);
 assert.deepEqual(ids(next),['700','600','500','400','300']);
 assert.deepEqual(ids(base),['500','400','300']);
 assert.equal(X.chooseMediaWindow(next,'400',9).posts[0].statusId,'700');
 assert.equal(X.prependNativeGroups(base,[group(200)]),null);
});

test('verified API anchor adds missing photos without splitting the original post',()=>{
 const base=[group(500),group(400,1,'x-dom','partial')];
 const incoming=[group(400,3,'fxembed','complete'),group(300,1,'fxembed')];
 const merged=X.appendVerifiedPublicGroups(base,incoming,true);
 assert.ok(merged);
 assert.deepEqual(ids(merged),['500','400','300']);
 assert.deepEqual(Array.from(merged[1].refs,r=>r.mediaIndex),[1,2,3]);
 assert.equal(merged[1].provenance,'combined');
 assert.equal(merged[1].completeness,'complete');
 assert.equal(base[1].refs.length,1,'source list never mutated');
});
test('unverified cursor and noncontiguous repeated status are rejected',()=>{
 const base=[group(500),group(400)];
 const valid=[group(300),group(200)];
 assert.equal(X.appendVerifiedPublicGroups(base,valid,false),null);
 const result=X.appendVerifiedPublicGroups(base,valid,true);
 assert.deepEqual(ids(result),['500','400','300','200']);
 assert.equal(X.appendVerifiedPublicGroups(base,[group(300),group(400)],true),null);
 assert.equal(X.appendVerifiedPublicGroups(base,[group(500)],true),null);
 const wrongProfile=group(300);wrongProfile.refs[0]=X.mediaRefFromHref(
   '/bob/status/300/photo/1','bob');
 assert.equal(X.appendVerifiedPublicGroups(base,[wrongProfile],true),null);
});
test('same-post duplicates and uncertain mixed-media order are not invented',()=>{
 const base=[group(500),group(400,1,'x-dom','partial')];
 const identical=X.appendVerifiedPublicGroups(base,[group(400),group(300)],true);
 assert.deepEqual(ids(identical),['500','400','300']);
 const mixed=group(400,1,'fxembed','partial');
 mixed.refs.push(ref(400,1,'video'));
 assert.equal(X.appendVerifiedPublicGroups(base,[mixed,group(300)],true),null);
});

test('a 6000-post timeline selects a bounded window without splitting albums',()=>{
 const list=Array.from({length:6000},(_,i)=>
  group(20000-i,i%4+1,'x-dom','complete'));
 const index=new X.ValidatedMediaWindowIndex(list);
 assert.equal(index.postCount,6000);
 let checks=0;
 for(const center of [0,1,40,100,500,1500,2500,3999,4900,5998,5999]){
  const w=index.select(String(20000-center),450);
  assert.ok(w);
  assert.equal(w.posts[w.activePost].statusId,String(20000-center));
  assert.ok(w.mediaRefs<=450);
  assert.equal(w.mediaRefs,w.posts.reduce((sum,g)=>sum+g.refs.length,0));
  assert.ok(w.posts.every(g=>g.refs.length>0&&g.refs.length<=20));
  checks++;
 }
 assert.equal(checks,11);
 assert.equal(index.select('unknown',450),null);
 assert.equal(index.select('20000',451),null);
});
test('150 new posts keep active ID stable, preserve media group window bound',()=>{
 let list=Array.from({length:600},(_,i)=>
  group(5000-i,i%4+1));
 const active='4800';
 for(let i=0;i<150;i++){
  const id=6000+i;
  const merged=X.prependNativeGroups(list,[group(id,i%4+1)]);
  assert.ok(merged);
  list=merged;
  const w=X.chooseMediaWindow(list,active,450);
  assert.ok(w);
  assert.equal(w.posts[w.activePost].statusId,active);
  assert.ok(w.mediaRefs<=450);
 }
});

test('an X-proven complete album cannot be expanded by third-party data',()=>{
 const base=[group(500),group(400,1,'x-dom','complete')];
 const extra=[group(400,3,'fxembed','complete'),group(300)];
 assert.equal(X.appendVerifiedPublicGroups(base,extra,true),null);
 assert.equal(base[1].refs.length,1,'native proof is unchanged');
 const unproved=[group(500),group(400,1,'x-dom','partial')];
 assert.equal(X.appendVerifiedPublicGroups(unproved,extra,true)[1].refs.length,3);
 const unknown=group(600);unknown.refs=[X.mediaRefFromHref(
  '/alice/status/600','alice')];
 assert.equal(X.validateMediaPostGroup(unknown),false);
 unknown.completeness='unknown';
 assert.equal(X.validateMediaPostGroup(unknown),true);
});

test('validated index reuses status positions for 2500 consecutive selections',()=>{
 const rows=Array.from({length:6000},(_,i)=>group(30000-i,i%4+1));
 const cached=new X.ValidatedMediaWindowIndex(rows);
 for(let i=0;i<2500;i++){
  const id=String(30000-(i*7%6000));
  const selected=cached.select(id,450);
  assert.ok(selected);
  assert.equal(selected.posts[selected.activePost].statusId,id);
  assert.ok(selected.mediaRefs<=450);
 }
 rows[0].refs.length=0;
 assert.equal(cached.select('30000',450)?.posts[0].statusId,'30000',
  'validated index retains a defensive copy');
 assert.throws(()=>new X.ValidatedMediaWindowIndex([group(500),group(500)]),
  /invalid_media_timeline/);
});
