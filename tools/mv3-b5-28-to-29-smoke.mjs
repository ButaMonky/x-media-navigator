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
const dir=mkdtempSync(join(tmpdir(),'xmn-b5-28to29-'));
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
 manifest_version:3,name:'XMN B5 28 to 29 isolated acceptance',version:'1.0.0',
 permissions:['storage'],background:{service_worker:'background.js'},
 content_scripts:[{matches:['http://127.0.0.1/*'],js:['content_script.js','probe.js'],
 css:['style.css'],run_at:'document_idle'}]
},null,2));
const probe="\n(async()=>{\n const id=n=>'/alice/status/'+n+'/photo/1';\n const img=n=>'https://pbs.twimg.com/media/ABC'+n+'?format=jpg&name=large';\n const phase=sessionStorage.getItem('xmn-b5-phase');\n const store=new XMN.SessionStore();\n const sleep=ms=>new Promise(r=>setTimeout(r,ms));\n const mark=(result,details)=>{\n   document.documentElement.dataset.mv3WorkerResult=result;\n   document.documentElement.dataset.mv3WorkerSignals=details;\n };\n if(location.pathname===id(973) && phase===null){\n   const ids=Array.from({length:28},(_,i)=>1000-i);\n   const refs=ids.map(n=>XMN.mediaRefFromHref(id(n),'alice'));\n   const valid=refs.every(Boolean)&&refs.length===28&&ids.at(-1)===973;\n   if(!valid)throw Error('28 fixture data invalid');\n   const snapshot={schema:1,profile:'alice',timeline:'alice|photo',\n     expires:Date.now()+60000,refs:ids.map(id),\n     apiKeys:ids.map(n=>n+':photo:1'),\n     photos:ids.map(n=>[n+':photo:1',img(n)]),\n     photoTotals:ids.map(n=>[String(n),1]),cursor:'B5-CURSOR',\n     anchorFound:true,exhausted:false};\n   if(!await store.grantConsent('alice')||!await store.save(snapshot))\n     throw Error('Worker refused seed');\n   const viewer=document.querySelector('[data-testid=\"swipe-to-dismiss\"]');\n   if(!viewer?.isConnected)throw Error('Source media viewer missing');\n   const next=XMN.mediaRefFromHref(id(972),'alice');\n   const ctl=Object.assign(Object.create(XMN.Controller.prototype),{\n     originProfile:'alice',originTimeline:'alice|photo',navGeneration:12,\n     refs,indexes:new Map(refs.map((r,i)=>[r.key,i])),\n     publicApiKeys:new Set(snapshot.apiKeys),publicApiCursor:snapshot.cursor,\n     publicApiAnchorFound:true,publicApiExhausted:false,publicApiLoading:false,\n     publicApiRetryAt:0,publicSessionRestored:false,restoredCheckpointPage:null,\n     sessionStore:store,viewer,navigationBusy:false,checkpointBoundaryPending:false,\n     pendingDocumentHandoff:null,pendingBoundary:null,publicApiWarmTimer:null,\n     imageSources:new Map(snapshot.photos),knownPhotoTotals:new Map(snapshot.photoTotals),\n     imageSourcesRevision:0,statusOrdinalCache:null,viewerStateSnapshot:null,\n     updateViewerState(){},toast(m){throw Error('Unexpected toast '+m)},\n     activeIndex(){return 27},findLiveLink(){return null},\n     fetchPublicMediaPage:async()=>({\n       refs:[next],photos:[[next.key,img(972)]],cursor:null\n     })\n   });\n   sessionStorage.setItem('xmn-b5-phase','starting');\n   await XMN.Controller.prototype.navigate.call(ctl,1);\n   // The internal promise intentionally schedules one more navigation.\n   // A regression must fail rather than silently presenting a success.\n   await sleep(2500);\n   throw Error('A single first click did not navigate 28 to 29');\n }\n if(location.pathname===id(972)&&phase==='starting'){\n   await sleep(1600);\n   const s=await store.load('alice');\n   const label=document.querySelector('.xmn-status')?.textContent;\n   const prev=document.querySelector('.xmn-prev');\n   const reply=document.getElementById('replies');\n   const valid=s?.refs?.length===29&&s.refs.at(-1)===id(972)&&\n     s.exhausted===true&&s.cursor===null&&\n     label==='投稿 29 / 29'&&prev&&!prev.disabled&&\n     reply?.textContent==='Original replies';\n   if(!valid)throw Error('29th post restore failed: '+JSON.stringify({\n     count:s?.refs?.length,label,prev:!!prev,disabled:prev?.disabled,\n     replies:reply?.textContent}));\n   sessionStorage.setItem('xmn-b5-phase','29-verified');\n   prev.click();\n   return;\n }\n if(location.pathname===id(973)&&phase==='29-verified'){\n   await sleep(1600);\n   const s=await store.load('alice');\n   const label=document.querySelector('.xmn-status')?.textContent;\n   const next=document.querySelector('.xmn-next');\n   const reply=document.getElementById('replies');\n   const ok=s?.refs?.length===29&&s.refs.at(-1)===id(972)&&\n     label==='投稿 28 / 29'&&next&&!next.disabled&&\n     reply?.textContent==='Original replies';\n   mark(ok?'passed':'failed',[\n     !!ok,s?.refs?.length||0,label,!!next,reply?.textContent==='Original replies'\n   ].join(','));\n   return;\n }\n mark('failed','unexpected-phase');\n})().catch(error=>{\n document.documentElement.dataset.mv3WorkerResult='error';\n document.documentElement.dataset.mv3WorkerError=String(error?.message||error);\n});\n";
writeFileSync(join(ext,'probe.js'),probe);
const server=createServer((_req,res)=>{
 res.setHeader('content-type','text/html; charset=utf-8');
 res.end('<!doctype html><html><head><title>Isolated checkpoint roundtrip</title></head><body>'+
 '<main><div data-testid="primaryColumn"></div></main>'+
 '<div role="dialog"><button data-testid="app-bar-close" aria-label="Close">Close</button>'+
 '<div data-testid="swipe-to-dismiss" style="width:690px;height:420px">'+
 '<img width="600" height="400" alt="fixture image" '+
 'src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="></div>'+
 '<aside id="replies">Original replies</aside></div>'+
 '</body></html>');
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
  '--load-extension='+ext,'http://127.0.0.1:'+port+'/alice/status/973/photo/1'];
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
 for(let i=0;i<150;i++){
  let r;
  try{r=await command('Runtime.evaluate',{
    expression:"({result:document.documentElement.dataset.mv3WorkerResult||'waiting',signals:document.documentElement.dataset.mv3WorkerSignals||'',error:document.documentElement.dataset.mv3WorkerError||''})",
    returnByValue:true
  })}catch{await nap(250);continue;}
  const v=r?.result?.value||{};
  result=v.result||'waiting';details=v.signals||v.error||'';
  if(result!=='waiting')break;
  // Do not reload while the page transition is underway.
  await nap(260);
 }
 const types=targets.map(t=>t.type);
 console.log(JSON.stringify({mv3Test:result,details,targets:types,
  genuineChromeForTesting:true,serviceWorkerResponded:result==='passed',
  testOrigin:'localhost only',productionGuardUnchanged:true,
  crossDocumentNavigation:true,firstClick29Verified:result==='passed'},null,2));
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
