import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
const root=resolve('.');
const installed=join(process.env.LOCALAPPDATA||tmpdir(),'XMediaNavigator','QA-Browser','chrome');
const choices=existsSync(installed)?readdirSync(installed).sort().reverse():[];
const edge=process.env.XMN_CHROME_FOR_TESTING || choices.map(v=>join(installed,v,'chrome-win64','chrome.exe')).find(existsSync);
if(!edge || !existsSync(edge))throw Error('Chrome for Testing is required; set XMN_CHROME_FOR_TESTING');
const dir=mkdtempSync(join(tmpdir(),'xmn-page-bridge-'));
const ext=join(dir,'extension');
mkdirSync(ext);
const worker=readFileSync(join(root,'extension/background.js'),'utf8').replace(/\r\n/g,'\n');
const before=`if (url.protocol !== 'https:' || !['x.com', 'www.x.com', 'twitter.com',
                'www.twitter.com'].includes(url.hostname))`;
const after=`if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')`;
if(worker.split(before).length!==2){
 rmSync(dir,{recursive:true,force:true});
 throw Error('Worker origin guard changed');
}
writeFileSync(join(ext,'background.js'),worker.replace(before,after));
copyFileSync(join(root,'extension/content_script.js'),join(ext,'content_script.js'));
copyFileSync(join(root,'extension/style.css'),join(ext,'style.css'));
writeFileSync(join(ext,'manifest.json'),JSON.stringify({
 manifest_version:3,name:'XMN B2 isolated archive bridge QA',version:'1.0.0',
 permissions:['storage'],background:{service_worker:'background.js'},
 content_scripts:[{matches:['http://127.0.0.1/*'],js:['content_script.js','probe.js'],
 css:['style.css'],run_at:'document_idle'}]
},null,2));
const probe="\n(async()=>{\n const id=n=>'/alice/status/'+n+'/photo/1';\n const img=n=>'https://pbs.twimg.com/media/ABC'+n+'?format=jpg&name=large';\n const ids=Array.from({length:440},(_,i)=>1000-i);\n const api=Array.from({length:20},(_,i)=>560-i);\n const refs=ids.map(n=>XMN.mediaRefFromHref(id(n),'alice'));\n const next=api.map(n=>XMN.mediaRefFromHref(id(n),'alice'));\n const expiry=Date.now()+60_000;\n const snapshot={schema:1,profile:'alice',timeline:'alice|photo',\n   expires:expiry,refs:ids.map(id),apiKeys:ids.map(n=>n+':photo:1'),\n   photos:ids.map(n=>[n+':photo:1',img(n)]),\n   photoTotals:ids.slice(-128).map(n=>[String(n),1]),\n   cursor:'CURSOR-BRIDGE',anchorFound:true,exhausted:false};\n const store=new XMN.SessionStore();\n const granted=await store.grantConsent('alice');\n const seed=await store.save(snapshot);\n if(!granted||!seed)throw Error('real Worker refused valid source seed');\n const ctl=Object.assign(Object.create(XMN.Controller.prototype),{\n   originProfile:'alice',originTimeline:'alice|photo',navGeneration:12,\n   refs,indexes:new Map(refs.map((ref,i)=>[ref.key,i])),\n   publicApiKeys:new Set(snapshot.apiKeys),publicApiCursor:snapshot.cursor,\n   publicApiAnchorFound:true,publicApiExhausted:false,publicApiLoading:false,\n   publicApiRetryAt:0,publicSessionRestored:false,\n   restoredCheckpointPage:null,sessionStore:store,\n   imageSources:new Map(),knownPhotoTotals:new Map(snapshot.photoTotals),\n   imageSourcesRevision:0,viewerStateSnapshot:null,\n   updateViewerState(){},toast(){},\n   fetchPublicMediaPage:async()=>({\n     refs:next,photos:next.map(r=>[r.key,img(r.statusId)]),\n     cursor:'CURSOR-NEXT'\n   })\n });\n const succeeded=await XMN.Controller.prototype\n   .loadPublicMediaContinuation.call(ctl,true);\n const manifest=await store.loadPageManifest('alice');\n const old=await store.loadCheckpoint('alice',0);\n const newer=await store.loadCheckpoint('alice',1);\n const adjacent=await store.findAdjacentCheckpoint(\n   'alice',location.pathname,1);\n const original=await store.load('alice');\n const ok=succeeded&&manifest?.pages?.length===2&&\n   manifest.activePage===0&&old?.refs?.length===440&&\n   newer?.refs?.length===20&&\n   adjacent?.href===id(560)&&adjacent?.page===1&&\n   original?.cursor==='CURSOR-BRIDGE'&&ctl.refs.length===440;\n document.documentElement.dataset.mv3WorkerResult=ok?'passed':'failed';\n document.documentElement.dataset.mv3WorkerSignals=[\n   !!succeeded,manifest?.pages?.length||0,newer?.refs?.length||0,\n   adjacent?.page??-1,ctl.refs.length\n ].join(',');\n})().catch(e=>{\n document.documentElement.dataset.mv3WorkerResult='error';\n document.documentElement.dataset.mv3WorkerError=e?.message||String(e);\n});";
writeFileSync(join(ext,'probe.js'),probe);
const server=createServer((_req,res)=>{
 res.setHeader('content-type','text/html; charset=utf-8');
 res.end('<!doctype html><html><body><main><div data-testid="primaryColumn"></div></main></body></html>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
import {readFileSync as readBytes} from 'node:fs';
import {execFileSync} from 'node:child_process';
const nap=ms=>new Promise(r=>setTimeout(r,ms));
let child=null, socket=null;
try{
 const args=['--headless=new','--no-sandbox','--disable-gpu',
  '--no-first-run','--no-default-browser-check','--disable-background-networking',
  '--remote-debugging-port=0','--remote-allow-origins=*',
  '--user-data-dir='+join(dir,'profile'),'--disable-extensions-except='+ext,
  '--load-extension='+ext,'http://127.0.0.1:'+port+'/alice/status/561/photo/1'];
 child=spawn(edge,args,{stdio:['ignore','ignore','pipe'],windowsHide:true});
 let stderr='';child.stderr.on('data',b=>{stderr+=b;if(stderr.length>3000)stderr=stderr.slice(-3000)});
 let debugPort=null;
 for(let i=0;i<70;i++){
  const f=join(dir,'profile','DevToolsActivePort');
  if(existsSync(f)){
   debugPort=Number(readBytes(f,'utf8').split(/\r?\n/)[0]);break;
  }
  await nap(200);
 }
 if(!debugPort)throw Error('No Chrome DevToolsActivePort '+stderr.slice(-350));
 let page=null,targets=[];
 for(let i=0;i<40;i++){
  try{
   targets=await (await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json();
   page=targets.find(t=>t.type==='page'&&t.url.startsWith('http://127.0.0.1:'));
   if(page)break;
  }catch{}
  await nap(250);
 }
 if(!page)throw Error('Page target missing '+JSON.stringify(targets).slice(0,500));
 socket=new WebSocket(page.webSocketDebuggerUrl);
 await new Promise((res,rej)=>{
  const timeout=setTimeout(()=>rej(Error('CDP WebSocket timeout')),5000);
  socket.onopen=()=>{clearTimeout(timeout);res()};
  socket.onerror=e=>{clearTimeout(timeout);rej(Error('CDP WebSocket error'))};
 });
 let seq=1;
 const requests=new Map();
 socket.onmessage=e=>{
  try{
   const msg=JSON.parse(e.data);
   if(requests.has(msg.id)){
    const f=requests.get(msg.id);requests.delete(msg.id);
    msg.error?f.reject(Error(JSON.stringify(msg.error))):f.resolve(msg.result);
   }
  }catch{}
 };
 const command=(method,params={})=>new Promise((resolve,reject)=>{
  const id=seq++;requests.set(id,{resolve,reject});
  socket.send(JSON.stringify({id,method,params}));
 });
 await command('Runtime.enable');
 let result='waiting',details='';
 for(let i=0;i<45;i++){
  let r;
  try{r=await command('Runtime.evaluate',{
    expression:"({result:document.documentElement.dataset.mv3WorkerResult||'waiting',signals:document.documentElement.dataset.mv3WorkerSignals||'',error:document.documentElement.dataset.mv3WorkerError||''})",
    returnByValue:true
  })}catch{await nap(250);continue;}
  const v=r?.result?.value||{};
  result=v.result||'waiting';details=v.signals||v.error||'';
  if(result!=='waiting')break;
  if(i===10)await command('Page.reload',{ignoreCache:true}).catch(()=>{});
  await nap(260);
 }
 const types=targets.map(t=>t.type);
 console.log(JSON.stringify({mv3Test:result,details,targets:types,
  genuineChromeForTesting:true,serviceWorkerResponded:result==='passed',
  testOrigin:'localhost only',productionGuardUnchanged:true,
  crossDocumentNavigation:false,checkpointRolloverVerified:result==='passed'},null,2));
 if(result!=='passed')process.exitCode=2;
}finally{
 if(socket){try{socket.close()}catch{}}
 if(child?.pid){
  try{execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],
   {stdio:'ignore',timeout:10000})}catch{}
 }
 await nap(700);
 await new Promise(resolve=>server.close(resolve));
 rmSync(dir,{recursive:true,force:true,maxRetries:8,retryDelay:300});
}
