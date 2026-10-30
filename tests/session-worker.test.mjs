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

const checkpointSession=(top,bottom,cursor)=>{
 const p=session();
 const refs=[top,bottom].map(id=>'/alice/status/'+id+'/photo/1');
 return {...p,refs,apiKeys:[bottom+':photo:1'],photos:[],
  photoTotals:[],cursor,anchorFound:true};
};
const descriptor=(page,snapshot,incomingCursor)=>({
 page,firstRef:snapshot.refs[0],lastRef:snapshot.refs.at(-1),
 mediaCount:snapshot.refs.length,incomingCursor,outgoingCursor:snapshot.cursor
});
const manifest=(pages,expires=Math.min(...pages.map(p=>p.snap.expires)))=>({
 schema:1,profile:'alice',timeline:'alice|photo',expires,activePage:0,
 pages:pages.map(({snap,incoming},i)=>descriptor(i,snap,incoming))
});
test('B2 manifest cannot commit a missing checkpoint page or bypass consent',async()=>{
 const w=worker(),p0=checkpointSession(900,800,'CURSOR_A');
 const m=manifest([{snap:p0,incoming:null}]);
 equalResponse(await w.send('manifest.put',1,'alice',{manifest:m}),{ok:false});
 await w.send('consent.set');
 equalResponse(await w.send('manifest.put',1,'alice',{manifest:m}),{ok:false},
  'metadata must not become visible until its immutable page is saved');
 equalResponse(await w.send('manifest.get'),{ok:true,manifest:null});
 equalResponse(await w.send('checkpoint.put',1,'alice',{page:0,session:p0}),{ok:true});
 equalResponse(await w.send('manifest.put',1,'alice',{manifest:m}),{ok:true});
 equalResponse(await w.send('manifest.get'),{ok:true,manifest:m});
 equalResponse(await w.send('manifest.get',2,'alice'),{ok:false});
});
test('B2 manifest proves two complete pages and an unmodified forward cursor',async()=>{
 const w=worker(),p0=checkpointSession(900,800,'CURSOR_A');
 const p1=checkpointSession(700,600,'CURSOR_B');
 const m=manifest([{snap:p0,incoming:null},{snap:p1,incoming:p0.cursor}]);
 await w.send('consent.set');
 await w.send('checkpoint.put',1,'alice',{page:0,session:p0});
 await w.send('checkpoint.put',1,'alice',{page:1,session:p1});
 equalResponse(await w.send('manifest.put',1,'alice',{manifest:m}),{ok:true});
 const next={...m,activePage:1};
 equalResponse(await w.send('manifest.put',1,'alice',{manifest:next}),{ok:false},
  'an active-page change requires a verified target document');
 const transition={
  expectedActivePage:0,targetPage:1,direction:1,
  sourceRef:p0.refs.at(-1),targetRef:p1.refs[0]
 };
 equalResponse(await w.raw({kind:'xmn-store-v1',op:'manifest.activate',
  profile:'alice',transition},{...sender(),url:'https://x.com'+p1.refs[0]}),
  {ok:true,session:p1,manifest:next});
 equalResponse(await w.send('manifest.get'),{ok:true,manifest:next});
 equalResponse(await w.send('checkpoint.get',1,'alice',{page:0}),
   {ok:true,session:p0});
 equalResponse(await w.send('checkpoint.get',1,'alice',{page:1}),
   {ok:true,session:p1});
});

test('B2 manifest refuses unverified order, cursor gaps, fabricated totals and mutation',async()=>{
 const w=worker(),p0=checkpointSession(900,800,'CURSOR_A');
 const p1=checkpointSession(700,600,'CURSOR_B');
 const base=manifest([{snap:p0,incoming:null}]);
 await w.send('consent.set');
 await w.send('checkpoint.put',1,'alice',{page:0,session:p0});
 await w.send('checkpoint.put',1,'alice',{page:1,session:p1});
 equalResponse(await w.send('manifest.put',1,'alice',{manifest:base}),{ok:true});
 const expected=manifest([{snap:p0,incoming:null},{snap:p1,incoming:'CURSOR_A'}]);
 for(const faulty of [
  {...expected,pages:[...expected.pages.slice(0,1),
   {...expected.pages[1],incomingCursor:'WRONG_CURSOR'}]},
  {...expected,pages:[...expected.pages.slice(0,1),
   {...expected.pages[1],firstRef:'/alice/status/850/photo/1'}]},
  {...expected,pages:[...expected.pages.slice(0,1),
   {...expected.pages[1],mediaCount:400}]},
  {...expected,pages:[...expected.pages.slice(0,1),
   {...expected.pages[1],outgoingCursor:'FABRICATED'}]},
  {...expected,activePage:2},
  {...expected,pages:[...expected.pages.slice(0,1),
   {...expected.pages[1],page:4}]},
  {...expected,profile:'bob'},
  {...expected,expires:Date.now()+40*60_000},
  {...expected,unexpectedSecret:'not a schema field'},
  {...expected,pages:[{...expected.pages[0],lastRef:'/alice/status/123/photo/1'},
    expected.pages[1]]}
 ]){
  equalResponse(await w.send('manifest.put',1,'alice',{manifest:faulty}),{ok:false});
 }
 equalResponse(await w.send('manifest.get'),{ok:true,manifest:base});
 equalResponse(await w.send('manifest.put',1,'alice',{manifest:expected}),{ok:true});
 // Once the second page is committed, a shorter manifest cannot silently
 // hide it or mutate its immutable first-page boundary.
 equalResponse(await w.send('manifest.put',1,'alice',{manifest:base}),{ok:false});
 const change={...expected,pages:[{...expected.pages[0],outgoingCursor:'BAD'},
   expected.pages[1]]};
 equalResponse(await w.send('manifest.put',1,'alice',{manifest:change}),{ok:false});
});
test('B2 manifests are invalidated if a page disappears or expires',async()=>{
 const w=worker(),p0=checkpointSession(900,800,'CURSOR_A');
 const p1=checkpointSession(700,600,null);
 const m=manifest([{snap:p0,incoming:null},{snap:p1,incoming:'CURSOR_A'}]);
 await w.send('consent.set');
 await w.send('checkpoint.put',1,'alice',{page:0,session:p0});
 await w.send('checkpoint.put',1,'alice',{page:1,session:p1});
 await w.send('manifest.put',1,'alice',{manifest:m});
 // Deliberate storage corruption simulates a missing page or browser
 // persistence loss; no partially validated index may be restored.
 w.memory.delete('xmn:checkpoint:1:alice:1');
 equalResponse(await w.send('manifest.get'),{ok:true,manifest:null});
 assert.equal(w.memory.has('xmn:manifest:1:alice'),false);
 await w.send('checkpoint.clear');
 equalResponse(await w.send('manifest.get'),{ok:true,manifest:null});
});

test('B2 clearing a checkpoint invalidates its manifest but preserves unrelated tab',async()=>{
 const w=worker(),p0=checkpointSession(900,800,null);
 const m=manifest([{snap:p0,incoming:null}]);
 await w.send('consent.set',1,'alice');
 await w.send('consent.set',2,'alice');
 for(const tab of [1,2]){
  equalResponse(await w.send('checkpoint.put',tab,'alice',{page:0,session:p0}),{ok:true});
  equalResponse(await w.send('manifest.put',tab,'alice',{manifest:m}),{ok:true});
 }
 equalResponse(await w.send('checkpoint.clear',1,'alice',{page:0}),{ok:true});
 equalResponse(await w.send('manifest.get',1,'alice'),{ok:true,manifest:null});
 equalResponse(await w.send('manifest.get',2,'alice'),{ok:true,manifest:m});
 equalResponse(await w.send('manifest.clear',2,'alice'),{ok:true});
 equalResponse(await w.send('manifest.get',2,'alice'),{ok:true,manifest:null});
 equalResponse(await w.send('checkpoint.list',2,'alice'),{ok:true,pages:[]});
});
test('B2 manifest and all pages clear when the owning tab closes',async()=>{
 const w=worker(),p0=checkpointSession(900,800,null);
 const m=manifest([{snap:p0,incoming:null}]);
 await w.send('consent.set',1,'alice');
 await w.send('checkpoint.put',1,'alice',{page:0,session:p0});
 await w.send('manifest.put',1,'alice',{manifest:m});
 w.tabRemoved()(1);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal([...w.memory.keys()].some(k=>k.includes(':1:')),false);
 assert.equal(w.memory.has('xmn:manifest:1:alice'),false);
});

test('B2 manifest cannot outlive its immutable pages or invent repeated boundary post',async()=>{
 const w=worker(),p0=checkpointSession(900,800,'CONT_A');
 const p1=checkpointSession(800,700,null);
 await w.send('consent.set');
 await w.send('checkpoint.put',1,'alice',{page:0,session:p0});
 await w.send('checkpoint.put',1,'alice',{page:1,session:p1});
 const sameStatusBoundary=manifest([
  {snap:p0,incoming:null},{snap:p1,incoming:'CONT_A'}]);
 equalResponse(await w.send('manifest.put',1,'alice',{
  manifest:sameStatusBoundary}),{ok:false});
 const validSingle=manifest([{snap:p0,incoming:null}]);
 const extendedLifetime={...validSingle,expires:p0.expires+10_000};
 equalResponse(await w.send('manifest.put',1,'alice',{
  manifest:extendedLifetime}),{ok:false},
  'cannot claim a longer manifest lifetime than its source page');
 equalResponse(await w.send('manifest.put',1,'alice',{
  manifest:validSingle}),{ok:true});
});
test('B2 failed manifest storage commit leaves immutable page unadvertised',async()=>{
 const w=worker({beforeSet:async values=>{
  if(Object.keys(values).some(key=>key.startsWith('xmn:manifest:')))
   throw Error('fixture storage quota or write failure');
 }});
 const p0=checkpointSession(900,800,null);
 await w.send('consent.set');
 equalResponse(await w.send('checkpoint.put',1,'alice',{
  page:0,session:p0}),{ok:true});
 equalResponse(await w.send('manifest.put',1,'alice',{
  manifest:manifest([{snap:p0,incoming:null}])}),{ok:false});
 assert.equal(w.memory.has('xmn:manifest:1:alice'),false);
 equalResponse(await w.send('manifest.get'),{ok:true,manifest:null});
 equalResponse(await w.send('checkpoint.get',1,'alice',{page:0}),
   {ok:true,session:p0});
});

test('B2 find returns only the historical page matching the exact sender route',async()=>{
 const w=worker();
 const current=checkpointSession(900,800,'CURSOR_A');
 const historical=checkpointSession(700,600,null);
 const m=manifest([
  {snap:current,incoming:null},
  {snap:historical,incoming:'CURSOR_A'}
 ]);
 await w.send('consent.set');
 await w.send('session.set',1,'alice',{session:current});
 await w.send('checkpoint.put',1,'alice',{page:0,session:current});
 await w.send('checkpoint.put',1,'alice',{page:1,session:historical});
 await w.send('manifest.put',1,'alice',{manifest:m});
 const find=(url,href=url,tab=1)=>w.raw({
  kind:'xmn-store-v1',op:'checkpoint.find',profile:'alice',href
 },{...sender(tab),url:'https://x.com'+url});
 equalResponse(await find('/alice/status/700/photo/1'),{
  ok:true,session:historical,page:1
 });
 equalResponse(await find('/alice/status/900/photo/1'),{
  ok:true,session:current,page:0
 });
 equalResponse(await find('/alice/status/777/photo/1'),{
  ok:true,session:null,page:null
 });
 equalResponse(await find('/alice/status/700/photo/1','/alice/status/800/photo/1'),
  {ok:false});
 equalResponse(await find('/alice/status/700/photo/1',
  '/alice/status/700/photo/1',2),{ok:false});
 equalResponse(await find('/alice/status/700'),{ok:false},
  'bare status routes cannot assert unproven photo ownership');
 equalResponse(await find('/alice/status/700/photo/1',
  '/bob/status/700/photo/1'),{ok:false});
});
test('B2 route lookup fails closed if any committed checkpoint is corrupted',async()=>{
 const w=worker();
 const p0=checkpointSession(900,800,'CURSOR_A');
 const p1=checkpointSession(700,600,null);
 await w.send('consent.set');
 await w.send('checkpoint.put',1,'alice',{page:0,session:p0});
 await w.send('checkpoint.put',1,'alice',{page:1,session:p1});
 await w.send('manifest.put',1,'alice',{
  manifest:manifest([{snap:p0,incoming:null},{snap:p1,incoming:'CURSOR_A'}])
 });
 w.memory.delete('xmn:checkpoint:1:alice:0');
 const senderRoute={...sender(1),url:'https://x.com/alice/status/700/photo/1'};
 equalResponse(await w.raw({
  kind:'xmn-store-v1',op:'checkpoint.find',profile:'alice',
  href:'/alice/status/700/photo/1'
 },senderRoute),{ok:true,session:null,page:null});
 assert.equal(w.memory.has('xmn:manifest:1:alice'),false,
  'a partially corrupted multi-page manifest is not usable');
});

test('B2 committed adjacent-page hop returns only saved URLs in both directions',async()=>{
 const w=worker();
 const p0=checkpointSession(900,800,'CURSOR_A');
 p0.refs=['/alice/status/900/photo/1','/alice/status/800/photo/1',
  '/alice/status/800/photo/2'];
 p0.apiKeys=['800:photo:1','800:photo:2'];
 const p1=checkpointSession(700,600,null);
 await w.send('consent.set');
 equalResponse(await w.send('checkpoint.put',1,'alice',{page:0,session:p0}),{ok:true});
 equalResponse(await w.send('checkpoint.put',1,'alice',{page:1,session:p1}),{ok:true});
 equalResponse(await w.send('manifest.put',1,'alice',{
   manifest:manifest([{snap:p0,incoming:null},{snap:p1,incoming:'CURSOR_A'}])
 }),{ok:true});
 const adjacent=(route,direction,href=route,tab=1)=>w.raw({
   kind:'xmn-store-v1',op:'checkpoint.adjacent',profile:'alice',
   href,direction
 },{...sender(tab),url:'https://x.com'+route});
 equalResponse(await adjacent('/alice/status/800/photo/1',1),
   {ok:true,href:'/alice/status/700/photo/1',page:1});
 equalResponse(await adjacent('/alice/status/800/photo/2',1),
   {ok:true,href:'/alice/status/700/photo/1',page:1});
 const forward={
   expectedActivePage:0,targetPage:1,direction:1,
   sourceRef:p0.refs.at(-1),targetRef:p1.refs[0]
 };
 equalResponse(await w.raw({kind:'xmn-store-v1',op:'manifest.activate',
   profile:'alice',transition:forward},{
   ...sender(),url:'https://x.com'+p1.refs[0]
 }),{ok:true,session:p1,manifest:{
   ...manifest([{snap:p0,incoming:null},{snap:p1,incoming:'CURSOR_A'}]),
   activePage:1
 }});
 equalResponse(await adjacent('/alice/status/700/photo/1',-1),
   {ok:true,href:'/alice/status/800/photo/1',page:0});
 equalResponse(await adjacent('/alice/status/800/photo/1',1),
   {ok:true,href:null,page:null},
   'stale source pages cannot navigate while another page is active');
 equalResponse(await adjacent('/alice/status/900/photo/1',1),
   {ok:true,href:null,page:null});
 equalResponse(await adjacent('/alice/status/600/photo/1',1),
   {ok:true,href:null,page:null});
 equalResponse(await adjacent('/alice/status/800/photo/1',-1),
   {ok:true,href:null,page:null});
 equalResponse(await adjacent('/alice/status/800/photo/1',0),{ok:false});
 equalResponse(await adjacent('/alice/status/800/photo/1',1,
   '/alice/status/900/photo/1'),{ok:false});
 equalResponse(await adjacent('/alice/status/700/photo/1',-1,
   '/alice/status/700/photo/1',2),{ok:false});
});

test('B2 verified page activation moves forward and backward only after target X route',async()=>{
 const w=worker(),p0=checkpointSession(900,800,'CURSOR_A');
 const p1=checkpointSession(700,600,null);
 const base=manifest([{snap:p0,incoming:null},{snap:p1,incoming:'CURSOR_A'}]);
 await w.send('consent.set');
 await w.send('checkpoint.put',1,'alice',{page:0,session:p0});
 await w.send('checkpoint.put',1,'alice',{page:1,session:p1});
 equalResponse(await w.send('manifest.put',1,'alice',{manifest:base}),{ok:true});
 const forward={
  expectedActivePage:0,targetPage:1,direction:1,
  sourceRef:p0.refs.at(-1),targetRef:p1.refs[0]
 };
 const forwardMessage={kind:'xmn-store-v1',op:'manifest.activate',
  profile:'alice',transition:forward};
 equalResponse(await w.raw(forwardMessage,sender()),{ok:false},
  'worker must not advance while X still displays the source page');
 equalResponse(await w.raw(forwardMessage,{...sender(),
  url:'https://x.com'+p1.refs[0]}),{
  ok:true,session:p1,manifest:{...base,activePage:1}
 });
 equalResponse(await w.send('manifest.get'),{
  ok:true,manifest:{...base,activePage:1}
 });
 equalResponse(await w.raw(forwardMessage,{...sender(),
  url:'https://x.com'+p1.refs[0]}),{ok:false},
  'a repeated right key cannot activate the same stale generation twice');
 const backward={
  expectedActivePage:1,targetPage:0,direction:-1,
  sourceRef:p1.refs[0],targetRef:p0.refs.at(-1)
 };
 equalResponse(await w.raw({...forwardMessage,transition:backward},
  {...sender(),url:'https://x.com'+p0.refs.at(-1)}),{
  ok:true,session:p0,manifest:base
 });
});
test('B2 active page transition refuses skips, wrong boundaries and unrelated tabs',async()=>{
 const w=worker(),p0=checkpointSession(900,800,'CURSOR_A');
 const p1=checkpointSession(700,600,'CURSOR_B');
 const p2=checkpointSession(500,400,null);
 const m=manifest([{snap:p0,incoming:null},{snap:p1,incoming:'CURSOR_A'},
  {snap:p2,incoming:'CURSOR_B'}]);
 await w.send('consent.set');
 for(const [idx,page] of [p0,p1,p2].entries()){
  await w.send('checkpoint.put',1,'alice',{page:idx,session:page});
 }
 await w.send('manifest.put',1,'alice',{manifest:m});
 const valid={expectedActivePage:0,targetPage:1,direction:1,
  sourceRef:p0.refs[1],targetRef:p1.refs[0]};
 const send=(transition,url='https://x.com'+p1.refs[0],tab=1)=>{
  return w.raw({kind:'xmn-store-v1',op:'manifest.activate',
   profile:'alice',transition},{...sender(tab),url});
 };
 for(const t of [
  {...valid,targetPage:2},
  {...valid,expectedActivePage:1},
  {...valid,sourceRef:p0.refs[0]},
  {...valid,targetRef:p1.refs[1]},
  {...valid,direction:-1},
  {...valid,extraPrivateData:'malicious'},
  {...valid,targetPage:'1'},
 ]){
  equalResponse(await send(t),{ok:false});
 }
 equalResponse(await send(valid,'https://x.com'+p1.refs[1]),{ok:false});
 equalResponse(await send(valid,undefined,2),{ok:false});
 equalResponse(await w.send('manifest.get'),{ok:true,manifest:m});
});

test('B2 active manifest blocks stale public session writes without breaking idempotent handoff',async()=>{
 const w=worker(),p0=checkpointSession(900,800,'CURSOR_A');
 const p1=checkpointSession(700,600,null);
 const m=manifest([{snap:p0,incoming:null},{snap:p1,incoming:'CURSOR_A'}]);
 await w.send('consent.set');
 equalResponse(await w.send('session.set',1,'alice',{session:p0}),{ok:true});
 await w.send('checkpoint.put',1,'alice',{page:0,session:p0});
 await w.send('checkpoint.put',1,'alice',{page:1,session:p1});
 equalResponse(await w.send('manifest.put',1,'alice',{manifest:m}),{ok:true});
 const wrong={...p0,refs:['/alice/status/901/photo/1',p0.refs[1]]};
 equalResponse(await w.send('session.set',1,'alice',{session:wrong}),{ok:false});
 const refreshed={...p0,expires:Math.min(Date.now()+120000,p0.expires+5000)};
 equalResponse(await w.send('session.set',1,'alice',{session:refreshed}),{ok:true},
  'same exact committed media snapshot remains navigable');
 equalResponse(await w.send('session.get'),{ok:true,session:p0});
 const transition={expectedActivePage:0,targetPage:1,direction:1,
  sourceRef:p0.refs.at(-1),targetRef:p1.refs[0]};
 equalResponse(await w.raw({kind:'xmn-store-v1',op:'manifest.activate',
  profile:'alice',transition},{...sender(),url:'https://x.com'+p1.refs[0]}),
  {ok:true,session:p1,manifest:{...m,activePage:1}});
 equalResponse(await w.send('session.set',1,'alice',{session:p0}),{ok:false},
  'previous page cannot replace the new active checkpoint');
 equalResponse(await w.send('session.get'),{ok:true,session:p1});
});
test('B2 activation and an in-flight earlier-page session.set are serialized',async()=>{
 let hold=false,entered,release;
 const enteredPromise=new Promise(r=>{entered=r});
 const gate=new Promise(r=>{release=r});
 const w=worker({beforeSet:async values=>{
  if(hold && Object.keys(values).length===1 &&
     Object.hasOwn(values,'xmn:session:1')){
   entered();await gate;
  }
 }});
 const p0=checkpointSession(900,800,'CURSOR_A');
 const p1=checkpointSession(700,600,null);
 const m=manifest([{snap:p0,incoming:null},{snap:p1,incoming:'CURSOR_A'}]);
 await w.send('consent.set');
 await w.send('session.set',1,'alice',{session:p0});
 await w.send('checkpoint.put',1,'alice',{page:0,session:p0});
 await w.send('checkpoint.put',1,'alice',{page:1,session:p1});
 await w.send('manifest.put',1,'alice',{manifest:m});
 hold=true;
 const pending=w.send('session.set',1,'alice',{session:p0});
 await enteredPromise;
 const transition={expectedActivePage:0,targetPage:1,direction:1,
  sourceRef:p0.refs.at(-1),targetRef:p1.refs[0]};
 const activation=w.raw({kind:'xmn-store-v1',op:'manifest.activate',
   profile:'alice',transition},{...sender(),url:'https://x.com'+p1.refs[0]});
 release();
 equalResponse(await pending,{ok:true});
 equalResponse(await activation,{
  ok:true,session:p1,manifest:{...m,activePage:1}});
 equalResponse(await w.send('session.get'),{ok:true,session:p1});
});

test('B2 active manifest rejects a stale session.set even after page activation',async()=>{
 const w=worker(),p0=checkpointSession(900,800,'CURSOR_A');
 const p1=checkpointSession(700,600,null);
 const m=manifest([{snap:p0,incoming:null},{snap:p1,incoming:'CURSOR_A'}]);
 await w.send('consent.set');
 equalResponse(await w.send('session.set',1,'alice',{session:p0}),{ok:true});
 await w.send('checkpoint.put',1,'alice',{page:0,session:p0});
 await w.send('checkpoint.put',1,'alice',{page:1,session:p1});
 await w.send('manifest.put',1,'alice',{manifest:m});
 equalResponse(await w.send('session.set',1,'alice',{
  session:{...p0,expires:p0.expires+1000}
 }),{ok:true},'identical media with refreshed TTL is acknowledged without overwrite');
 equalResponse(await w.send('session.get'),{ok:true,session:p0});
 equalResponse(await w.send('session.set',1,'alice',{session:p0}),{ok:true});
 const t={expectedActivePage:0,targetPage:1,direction:1,
  sourceRef:p0.refs.at(-1),targetRef:p1.refs[0]};
 equalResponse(await w.raw({
  kind:'xmn-store-v1',op:'manifest.activate',
  profile:'alice',transition:t
 },{...sender(),url:'https://x.com'+p1.refs[0]}),{
   ok:true,session:p1,manifest:{...m,activePage:1}
 });
 equalResponse(await w.send('session.set',1,'alice',{session:p0}),{ok:false},
  'a prior document must never restore stale worker storage');
 equalResponse(await w.send('session.get'),{ok:true,session:p1});
 equalResponse(await w.send('session.set',1,'alice',{session:p1}),{ok:true});
});
test('B2 reverse activation opens first photo of prior last album only',async()=>{
 const w=worker(),p0=checkpointSession(900,800,'CURSOR_A');
 p0.refs=['/alice/status/900/photo/1','/alice/status/800/photo/1',
  '/alice/status/800/photo/2'];
 p0.apiKeys=['800:photo:1','800:photo:2'];
 const p1=checkpointSession(700,600,null);
 const m=manifest([{snap:p0,incoming:null},{snap:p1,incoming:'CURSOR_A'}]);
 await w.send('consent.set');
 await w.send('checkpoint.put',1,'alice',{page:0,session:p0});
 await w.send('checkpoint.put',1,'alice',{page:1,session:p1});
 await w.send('manifest.put',1,'alice',{manifest:m});
 const forward={expectedActivePage:0,targetPage:1,direction:1,
  sourceRef:p0.refs.at(-1),targetRef:p1.refs[0]};
 await w.raw({kind:'xmn-store-v1',op:'manifest.activate',
  profile:'alice',transition:forward},
  {...sender(),url:'https://x.com'+p1.refs[0]});
 const back={expectedActivePage:1,targetPage:0,direction:-1,
  sourceRef:p1.refs[0],targetRef:p0.refs[1]};
 const reply=await w.raw({kind:'xmn-store-v1',op:'manifest.activate',
  profile:'alice',transition:{...back,targetRef:p0.refs[2]}},
  {...sender(),url:'https://x.com'+p0.refs[2]});
 equalResponse(reply,{ok:false},'do not jump backward into the middle of a post');
 equalResponse(await w.raw({kind:'xmn-store-v1',op:'manifest.activate',
  profile:'alice',transition:back},
  {...sender(),url:'https://x.com'+p0.refs[1]}),{
   ok:true,session:p0,manifest:m
 });
});


test('B2 a stable committed page remains navigable after only decoded photo cache changes',async()=>{
 const w=worker(),p0=checkpointSession(900,800,'CURSOR_A');
 p0.photos=[['800:photo:1',
  'https://pbs.twimg.com/media/CACHE800?format=jpg&name=large']];
 p0.photoTotals=[['800',1]];
 const p1=checkpointSession(700,600,null);
 const m=manifest([{snap:p0,incoming:null},{snap:p1,incoming:'CURSOR_A'}]);
 await w.send('consent.set');
 await w.send('session.set',1,'alice',{session:p0});
 await w.send('checkpoint.put',1,'alice',{page:0,session:p0});
 await w.send('checkpoint.put',1,'alice',{page:1,session:p1});
 await w.send('manifest.put',1,'alice',{manifest:m});
 const cacheChanged={...p0,photos:[],photoTotals:[],
  expires:p0.expires+500};
 equalResponse(await w.send('session.set',1,'alice',
  {session:cacheChanged}),{ok:true},
  'public media identity is unchanged; cached image metadata is not persisted');
 equalResponse(await w.send('session.get'),{ok:true,session:p0});
 equalResponse(await w.send('manifest.get'),{ok:true,manifest:m});
});
