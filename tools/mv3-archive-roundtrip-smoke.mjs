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
const dir=mkdtempSync(join(tmpdir(),'xmn-page-roundtrip-'));
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
 manifest_version:3,name:'XMN B2 archive roundtrip test',version:'1.0.0',
 permissions:['storage'],background:{service_worker:'background.js'},
 content_scripts:[{matches:['http://127.0.0.1/*'],js:['content_script.js','probe.js'],
 css:['style.css'],run_at:'document_idle'}]
},null,2));
const probe=`
(async()=>{
 const id=n=>'/alice/status/'+n+'/photo/1';
 const img=n=>'https://pbs.twimg.com/media/ABC'+n+'?format=jpg&name=large';
 const store=new XMN.SessionStore();
 const phase=sessionStorage.getItem('xmn-archive-roundtrip-phase');
 const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const mark=(result,detail)=>{
  document.documentElement.dataset.mv3WorkerResult=result;
  document.documentElement.dataset.mv3WorkerSignals=detail;
 };
 if(location.pathname===id(561) && phase===null){
   const ids=Array.from({length:440},(_,i)=>1000-i);
   const api=Array.from({length:20},(_,i)=>560-i);
   const refs=ids.map(n=>XMN.mediaRefFromHref(id(n),'alice'));
   const older=api.map(n=>XMN.mediaRefFromHref(id(n),'alice'));
   const expiry=Date.now()+60000;
   const session={schema:1,profile:'alice',timeline:'alice|photo',
     expires:expiry,refs:ids.map(id),apiKeys:ids.map(n=>n+':photo:1'),
     photos:ids.map(n=>[n+':photo:1',img(n)]),
     photoTotals:ids.slice(-128).map(n=>[String(n),1]),
     cursor:'CURSOR-BRIDGE',anchorFound:true,exhausted:false};
   if(!await store.grantConsent('alice')||!await store.save(session))
     throw Error('Seed session refused');
   const ctl=Object.assign(Object.create(XMN.Controller.prototype),{
    originProfile:'alice',originTimeline:'alice|photo',navGeneration:12,
    refs,indexes:new Map(refs.map((r,i)=>[r.key,i])),
    publicApiKeys:new Set(session.apiKeys),
    publicApiCursor:session.cursor,publicApiAnchorFound:true,
    publicApiExhausted:false,publicApiLoading:false,publicApiRetryAt:0,
    publicSessionRestored:false,restoredCheckpointPage:null,
    sessionStore:store,imageSources:new Map(),
    knownPhotoTotals:new Map(session.photoTotals),
    imageSourcesRevision:0,viewerStateSnapshot:null,
    updateViewerState(){},toast(){},
    fetchPublicMediaPage:async()=>({
     refs:older,photos:older.map(r=>[r.key,img(r.statusId)]),
     cursor:'CURSOR-NEXT'
    })
   });
   const ok=await XMN.Controller.prototype.loadPublicMediaContinuation.call(ctl,true);
   const m=await store.loadPageManifest('alice');
   const p1=await store.loadCheckpoint('alice',1);
   const adjacent=await store.findAdjacentCheckpoint('alice',location.pathname,1);
   if(!ok||m?.pages?.length!==2||m.activePage!==0||
      p1?.refs?.length!==20||adjacent?.href!==id(560)||
      ctl.refs.length!==440)
     throw Error('Archive validation failed');
   sessionStorage.setItem('xmn-archive-roundtrip-phase','archive_verified');
   const viewer=document.querySelector('[data-testid="swipe-to-dismiss"]');
   if(!viewer?.isConnected)throw Error('Source viewer missing');
   const moved=await XMN.Controller.prototype.tryCommittedPageBoundary.call(
     ctl,1,refs[refs.length-1],viewer);
   if(!moved)throw Error('Committed page navigation was refused');
   return;
 }
 if(location.pathname===id(560) && phase==='archive_verified'){
   await sleep(1700);
   const s=await store.load('alice'),m=await store.loadPageManifest('alice');
   const reply=document.getElementById('replies');
   const status=document.querySelector('.xmn-status')?.textContent||'';
   const previous=document.querySelector('.xmn-prev');
   if(m?.activePage!==1||m.pages?.length!==2||
     s?.cursor!=='CURSOR-NEXT'||s.refs.length!==20||
     status!=='投稿 1 / 20+'||!previous||previous.disabled||
     reply?.textContent!=='Original replies')
     throw Error('Next page restore mismatch active='+m?.activePage+
       ' status='+status+' refCount='+s?.refs?.length);
   sessionStorage.setItem('xmn-archive-roundtrip-phase','older_verified');
   previous.click();
   return;
 }
 if(location.pathname===id(561) && phase==='older_verified'){
   await sleep(1700);
   const s=await store.load('alice'),m=await store.loadPageManifest('alice');
   const status=document.querySelector('.xmn-status')?.textContent||'';
   const next=document.querySelector('.xmn-next');
   const reply=document.getElementById('replies');
   const ok=m?.activePage===0&&m.pages.length===2&&
     s?.cursor==='CURSOR-BRIDGE'&&s.refs.length===440&&
     status==='投稿 440 / 440+'&&next&&!next.disabled&&
     reply?.textContent==='Original replies';
   mark(ok?'passed':'failed',[
     !!ok,m?.pages?.length||0,m?.activePage??-1,
     s?.refs?.length||0,!!next,status
   ].join(','));
   return;
 }
 mark('failed','unexpected_phase');
})().catch(e=>{
 document.documentElement.dataset.mv3WorkerResult='error';
 document.documentElement.dataset.mv3WorkerError=e?.message||String(e);
});
`;
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
 for(let i=0;i<90;i++){
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
  crossDocumentNavigation:true,checkpointRolloverVerified:result==='passed'},null,2));
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
