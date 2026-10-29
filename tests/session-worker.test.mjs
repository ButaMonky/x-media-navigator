import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const equalResponse=(actual,expected)=>assert.deepEqual(JSON.parse(JSON.stringify(actual)),expected);
import {readFileSync} from 'node:fs';
const src=readFileSync(new URL('../extension/background.js',import.meta.url),'utf8');
const session=(profile='alice')=>({
 schema:1,profile,timeline:profile+'|photo',expires:Date.now()+60000,
 refs:['/'+profile+'/status/500/photo/1','/'+profile+'/status/400/photo/1'],
 apiKeys:['400:photo:1'],photos:[['400:photo:1',
  'https://pbs.twimg.com/media/PHOTO?format=jpg&name=large']],
 photoTotals:[['400',1]],cursor:'OPAQUE',anchorFound:true,exhausted:false
});
const sender=(tab=1,profile='alice')=>({
 tab:{id:tab},frameId:0,url:'https://x.com/'+profile+'/status/400/photo/1'
});
function worker({beforeSet}={}){
 const memory=new Map();let messageListener,tabRemoved;
 const storage={session:{
  async get(key){if(key===null)return Object.fromEntries(memory);
   const keys=Array.isArray(key)?key:[key];
   return Object.fromEntries(keys.filter(k=>memory.has(k)).map(k=>[k,memory.get(k)]))},
  async set(values){
   if(beforeSet)await beforeSet(values);
   for(const [k,v] of Object.entries(values))memory.set(k,v)
  },
  async remove(keys){for(const k of Array.isArray(keys)?keys:[keys])memory.delete(k)}
 }};
 const chrome={runtime:{onMessage:{addListener(fn){messageListener=fn}}},
  storage,tabs:{onRemoved:{addListener(fn){tabRemoved=fn}}}};
 vm.runInNewContext(src,{URL,URLSearchParams,Map,Set,Date,console,chrome});
 const send=(op,tab=1,profile='alice',payload={})=>new Promise(resolve=>{
  const returned=messageListener({kind:'xmn-store-v1',op,profile,...payload},
   sender(tab,profile),resolve);
  assert.equal(returned,true);
 });
 const raw=(message,senderData)=>new Promise(resolve=>{
  const value=messageListener(message,senderData,resolve);
  if(value!==true)resolve({ok:false});
 });
 return {send,raw,memory,tabRemoved:()=>tabRemoved};
}

test('worker keeps consent in extension-only tab/profile scope',async()=>{
 const w=worker();
 equalResponse(await w.send('consent.get'),{ok:true,granted:false});
 equalResponse(await w.send('consent.set'),{ok:true});
 equalResponse(await w.send('consent.get'),{ok:true,granted:true});
 equalResponse(await w.send('consent.get',2),{ok:true,granted:false});
 equalResponse(await w.send('consent.get',1,'bob'),{ok:true,granted:false});
 const missing=await new Promise(resolve=>{
  const ch=worker();
  ch.send('consent.get',3).then(resolve);
 });
 assert.equal(missing.granted,false);
});
test('worker accepts valid ordered public media and rejects malformed groups',async()=>{
 const w=worker();
 equalResponse(await w.send('session.set',1,'alice',{session:session()}),{ok:true});
 const result=await w.send('session.get');
 assert.equal(result.ok,true);
 equalResponse(Array.from(result.session.refs),session().refs);
 const bad=session();bad.refs.reverse();
 equalResponse(await w.send('session.set',2,'alice',{session:bad}),{ok:false});
 const dup=session();dup.refs.push(dup.refs[1]);
 equalResponse(await w.send('session.set',2,'alice',{session:dup}),{ok:false});
 const falseOwner=session();falseOwner.profile='bob';
 equalResponse(await w.send('session.set',2,'alice',{session:falseOwner}),{ok:false});
 assert.equal((await w.send('session.get',2)).session,null);
});
test('worker refuses cross-profile, wrong frame and foreign origin',async()=>{
 const w=worker();
 const r1=await w.send('consent.set',7,'alice');
 assert.equal(r1.ok,true);
 const r2=await w.send('consent.get',8,'alice');
 assert.equal(r2.granted,false);
 const message={kind:'xmn-store-v1',op:'consent.set',profile:'alice'};
 assert.equal((await w.raw(message,{...sender(7),frameId:1})).ok,false);
 assert.equal((await w.raw(message,{...sender(7),url:'https://evil.example/alice/media'})).ok,false);
 assert.equal((await w.raw(message,{...sender(7),url:'https://x.com/bob/media'})).ok,false);
 assert.equal((await w.send('consent.get',7,'bob')).granted,false);
});

test('tab removal erases public session and third-party consent',async()=>{
 const w=worker();
 await w.send('session.set',4,'alice',{session:session()});
 await w.send('consent.set',4,'alice');
 assert.equal((await w.send('session.get',4)).ok,true);
 w.tabRemoved()(4);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal((await w.send('session.get',4)).session,null);
 assert.equal((await w.send('consent.get',4)).granted,false);
});
test('worker rejects unbounded or expired snapshots',async()=>{
 const w=worker();
 const expired=session();expired.expires=Date.now()-1000;
 assert.equal((await w.send('session.set',1,'alice',{session:expired})).ok,false);
 const oversized=session();oversized.cursor='a'.repeat(1300);
 assert.equal((await w.send('session.set',1,'alice',{session:oversized})).ok,false);
 const foreign=session();foreign.refs[1]='/bob/status/400/photo/1';
 assert.equal((await w.send('session.set',1,'alice',{session:foreign})).ok,false);
});

test('B2 checkpoint pages require consent and are immutable per tab and profile',async()=>{
 const w=worker(),first=session();
 equalResponse(await w.send('checkpoint.put',1,'alice',{page:0,session:first}),{ok:false});
 equalResponse(await w.send('consent.set'),{ok:true});
 equalResponse(await w.send('checkpoint.put',1,'alice',{page:0,session:first}),{ok:true});
 equalResponse(await w.send('checkpoint.put',1,'alice',{page:0,session:first}),{ok:true},
  'identical page replay is idempotent');
 const replaced={...first,cursor:'DIFFERENT'};
 equalResponse(await w.send('checkpoint.put',1,'alice',{page:0,session:replaced}),{ok:false},
  'a cursor checkpoint must not be silently overwritten');
 const snapshot=await w.send('checkpoint.get',1,'alice',{page:0});
 equalResponse(snapshot,{ok:true,session:first});
 equalResponse(await w.send('checkpoint.list'),{ok:true,pages:[0]});
 equalResponse(await w.send('checkpoint.get',2,'alice',{page:0}),{ok:false},
  'different tab has not consented');
 equalResponse(await w.send('consent.set',2,'alice'),{ok:true});
 equalResponse(await w.send('checkpoint.get',2,'alice',{page:0}),{ok:true,session:null});
 equalResponse(await w.send('consent.set',1,'bob'),{ok:true});
 equalResponse(await w.send('checkpoint.get',1,'bob',{page:0}),{ok:true,session:null});
});
test('B2 checkpoints enforce page range, ordering, TTL and independent cleanup',async()=>{
 const w=worker();
 await w.send('consent.set');
 const valid=session();
 for(const invalid of [-1,64,1.5,'0',null,Number.MAX_SAFE_INTEGER]){
   assert.equal((await w.send('checkpoint.put',1,'alice',{
     page:invalid,session:valid})).ok,false);
 }
 equalResponse(await w.send('checkpoint.put',1,'alice',{page:63,session:valid}),{ok:true});
 equalResponse(await w.send('checkpoint.put',1,'alice',{page:0,session:valid}),{ok:true});
 equalResponse(await w.send('checkpoint.list'),{ok:true,pages:[0,63]});
 const reversed={...valid,refs:[...valid.refs].reverse()};
 equalResponse(await w.send('checkpoint.put',1,'alice',{page:1,session:reversed}),{ok:false});
 const malformed={...valid,anchorFound:false};
 equalResponse(await w.send('checkpoint.put',1,'alice',{page:1,session:malformed}),{ok:false});
 const stale={...valid,expires:Date.now()-100};
 equalResponse(await w.send('checkpoint.put',1,'alice',{page:1,session:stale}),{ok:false});
 equalResponse(await w.send('checkpoint.clear',1,'alice',{page:0}),{ok:true});
 equalResponse(await w.send('checkpoint.list'),{ok:true,pages:[63]});
 equalResponse(await w.send('checkpoint.clear'),{ok:true});
 equalResponse(await w.send('checkpoint.list'),{ok:true,pages:[]});
 assert.equal(w.memory.size,1,'only consent remains after checkpoint cleanup');
});

test('B2 checkpoint writes serialize collisions and cannot corrupt another page',async()=>{
 const w=worker();
 await w.send('consent.set');
 const a=session(),b={...a,cursor:'NEXT_VERSION'};
 const [one,two]=await Promise.all([
   w.send('checkpoint.put',1,'alice',{page:5,session:a}),
   w.send('checkpoint.put',1,'alice',{page:5,session:b})
 ]);
 equalResponse(one,{ok:true});
 equalResponse(two,{ok:false});
 equalResponse(await w.send('checkpoint.get',1,'alice',{page:5}),
   {ok:true,session:a});
 // The other page remains separate and may contain a different continuation.
 equalResponse(await w.send('checkpoint.put',1,'alice',{page:6,session:b}),
   {ok:true});
 equalResponse(await w.send('checkpoint.list'),{ok:true,pages:[5,6]});
});
test('B2 checkpoint scan removes stale records and tab closing erases all pages',async()=>{
 const w=worker();
 await w.send('consent.set',4,'alice');
 await w.send('checkpoint.put',4,'alice',{page:0,session:session()});
 await w.send('checkpoint.put',4,'alice',{page:1,session:session()});
 await w.send('consent.set',5,'alice');
 await w.send('checkpoint.put',5,'alice',{page:0,session:session()});
 // A user cannot access or revive a corrupted old checkpoint.
 const invalid={...session(),expires:Date.now()-1};
 w.memory.set('xmn:checkpoint:4:alice:0',invalid);
 equalResponse(await w.send('checkpoint.list',4,'alice'),{ok:true,pages:[1]});
 assert.equal(w.memory.has('xmn:checkpoint:4:alice:0'),false);
 await w.tabRemoved()(4);
 await new Promise(resolve=>setImmediate(resolve));
 equalResponse(await w.send('checkpoint.get',4,'alice',{page:1}),{ok:false});
 assert.equal([...w.memory.keys()].some(k=>k.startsWith('xmn:checkpoint:4:')),false);
 equalResponse(await w.send('checkpoint.get',5,'alice',{page:0}),
   {ok:true,session:await w.send('checkpoint.get',5,'alice',{page:0})
     .then(result=>result.session)});
});

test('B2 checkpoint replay compares semantic fields rather than Chrome object key order',async()=>{
 const w=worker(),original=session();
 await w.send('consent.set');
 equalResponse(await w.send('checkpoint.put',1,'alice',{page:4,session:original}),{ok:true});
 const reordered=Object.fromEntries(Object.entries(original).reverse());
 equalResponse(await w.send('checkpoint.put',1,'alice',{page:4,session:reordered}),{ok:true});
 assert.equal((await w.send('checkpoint.get',1,'alice',{page:4})).session.cursor,'OPAQUE');
 const unexpected={...original,secretMetadata:{claimed:'never store unrecognized data'}};
 equalResponse(await w.send('checkpoint.put',1,'alice',{
   page:5,session:unexpected}),{ok:false});
 equalResponse(await w.send('session.set',1,'alice',{
   session:unexpected}),{ok:false});
 assert.equal(w.memory.has('xmn:checkpoint:1:alice:5'),false);
});

test('B2 clearing a tab waits for an in-flight page write before removing it',async()=>{
 let release,signalStarted;
 const block=new Promise(resolve=>{release=resolve});
 const started=new Promise(resolve=>{signalStarted=resolve});
 const w=worker({beforeSet:async values=>{
  if(Object.keys(values).some(key=>key.startsWith('xmn:checkpoint:'))){
   signalStarted();await block;
  }
 }});
 await w.send('consent.set');
 const writing=w.send('checkpoint.put',1,'alice',{page:2,session:session()});
 await started;
 const clearing=w.send('checkpoint.clear',1,'alice');
 release();
 equalResponse(await writing,{ok:true});
 equalResponse(await clearing,{ok:true});
 equalResponse(await w.send('checkpoint.list'),{ok:true,pages:[]});
 assert.equal(w.memory.has('xmn:checkpoint:1:alice:2'),false,
  'the cleared page must not reappear after its delayed write');
});

test('B2 clearing the session also purges its checkpoints without revoking consent',async()=>{
 const w=worker(),first=session();
 await w.send('consent.set');
 await w.send('session.set',1,'alice',{session:first});
 await w.send('checkpoint.put',1,'alice',{page:3,session:first});
 equalResponse(await w.send('session.clear'),{ok:true});
 equalResponse(await w.send('session.get'),{ok:true,session:null});
 equalResponse(await w.send('checkpoint.list'),{ok:true,pages:[]});
 equalResponse(await w.send('consent.get'),{ok:true,granted:true});
});
