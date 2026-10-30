import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
const root=resolve('.');
const installed=join(process.env.LOCALAPPDATA||tmpdir(),'XMediaNavigator','QA-Browser','chrome');
const choices=existsSync(installed)?readdirSync(installed).sort().reverse():[];
// Branded Chrome 137+ ignores --load-extension; only Chromium/CfT
// can run the real MV3 Worker acceptance fixtures.
const alternatives=process.platform==='win32'?[]:[
 '/usr/bin/chromium','/usr/bin/chromium-browser'
];
// Always use a disposable temporary profile and localhost-only test origin.
const edge=process.env.XMN_CHROME_FOR_TESTING ||
  process.env.CHROMIUM_PATH ||
  choices.map(v=>join(installed,v,'chrome-win64','chrome.exe')).find(existsSync) ||
  alternatives.find(existsSync);
if(!edge || !existsSync(edge))
 throw Error('Chrome/Chromium is required for mandatory MV3 smoke');
const dir=mkdtempSync(join(tmpdir(),'xmn-b5-native-28to29-'));
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
 manifest_version:3,name:'XMN B5 native gallery 28 to 29 no third-party API',version:'1.0.0',
 permissions:['storage'],background:{service_worker:'background.js'},
 content_scripts:[{matches:['http://127.0.0.1/*'],js:['content_script.js','probe.js'],
 css:['style.css'],run_at:'document_idle'}]
},null,2));
const probe="\n(async()=>{\n  const id=n=>'/alice/status/'+n+'/photo/1';\n  const viewer=document.querySelector('[data-testid=\"swipe-to-dismiss\"]');\n  const replies=document.getElementById('replies');\n  const column=document.querySelector('main [data-testid=\"primaryColumn\"]');\n  if(!viewer?.isConnected||!replies?.isConnected||!column)throw Error('Missing native X fixture');\n  const originalPath=location.pathname,originalReplies=replies.textContent;\n  if(originalPath!==id(973))throw Error('Unexpected starting native route');\n  const refs=Array.from({length:28},(_,i)=>XMN.mediaRefFromHref(id(1000-i),'alice'));\n  const next=XMN.mediaRefFromHref(id(972),'alice');\n  if(!refs.every(Boolean)||!next)throw Error('Invalid native X refs');\n  let apiCalls=0,consentChecks=0,linkClicks=0;\n  const toasts=[];\n  const ctl=Object.assign(Object.create(XMN.Controller.prototype),{\n    experimentalThirdPartyApiEnabled:false,\n    originProfile:'alice',originTimeline:'alice|photo',navGeneration:12,\n    refs,indexes:new Map(refs.map((r,i)=>[r.key,i])),\n    publicApiKeys:new Set(),publicApiLoading:false,publicApiCursor:null,\n    publicSessionRestored:false,restoredCheckpointPage:null,\n    viewer,navigationBusy:false,knownPhotoTotals:new Map([['973',1]]),\n    imageSources:new Map(),pendingBoundary:null,checkpointBoundaryPending:false,\n    activeIndex(){const route=XMN.mediaRefFromHref(location.pathname,'alice');return this.indexes.get(route?.key)??null;},\n    photoCount(){return 1;},nativeGalleryArrowAvailable(){return false;},\n    rememberPhotoTotal(){},updateViewerState(){},\n    toast(message){toasts.push(message);},\n    beginVisualHandoff(){return false;},\n    clearVisualHandoff(){},schedulePreload(){},\n    sessionStore:{hasConsent(){consentChecks++;throw Error('External consent must not be requested');}},\n    fetchPublicMediaPage(){apiCalls++;throw Error('External API must not run');},\n    loadPublicMediaContinuation(){apiCalls++;throw Error('External continuation must not run');}\n  });\n  const key=()=>({\n    key:'ArrowRight',repeat:false,isComposing:false,\n    shiftKey:false,altKey:false,ctrlKey:false,metaKey:false,\n    target:document.body,prevented:false,stopped:false,\n    preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;}\n  });\n  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));\n  const first=key();\n  XMN.Controller.prototype.onKeyDown.call(ctl,first);\n  await sleep(150);\n  if(!first.prevented||!first.stopped)throw Error('Confirmed final photo did not handle ArrowRight');\n  if(location.pathname!==originalPath||!viewer.isConnected||replies.textContent!==originalReplies)\n    throw Error('Unknown next post unexpectedly changed native modal');\n  if(apiCalls!==0||consentChecks!==0)throw Error('Native boundary contacted external service');\n  if(toasts.length!==1||!toasts[0].includes('読み込み済み'))\n    throw Error('No native-only end-of-loaded-list explanation');\n  const tile=document.createElement('li');tile.setAttribute('role','listitem');\n  const link=document.createElement('a');link.href=next.href;\n  const img=document.createElement('img');\n  img.src='data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';\n  link.appendChild(img);tile.appendChild(link);column.appendChild(tile);\n  link.addEventListener('click',event=>{\n    event.preventDefault();linkClicks++;\n    // Mock X itself claims the exact observed link, not the extension.\n    history.pushState({xOwned:true},'',next.href);\n  });\n  // Simulate user-initiated Media-tab loading of a newly observed tile.\n  ctl.refs.push(next);ctl.indexes.set(next.key,28);\n  const second=key();\n  XMN.Controller.prototype.onKeyDown.call(ctl,second);\n  await sleep(450);\n  const good=second.prevented&&second.stopped&&linkClicks===1&&\n    location.pathname===next.href&&viewer.isConnected&&\n    replies.textContent===originalReplies&&apiCalls===0&&consentChecks===0&&\n    ctl.refs.length===29;\n  document.documentElement.dataset.mv3WorkerResult=good?'passed':'failed';\n  document.documentElement.dataset.mv3WorkerSignals=[\n    first.prevented,second.prevented,linkClicks,\n    location.pathname===next.href,viewer.isConnected,apiCalls,consentChecks\n  ].join(',');\n})().catch(error=>{\n  document.documentElement.dataset.mv3WorkerResult='error';\n  document.documentElement.dataset.mv3WorkerError=String(error?.message||error);\n});\n";
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
  '--disable-dev-shm-usage',
  '--remote-debugging-port=0','--remote-allow-origins=*',
  '--user-data-dir='+join(dir,'profile'),'--disable-extensions-except='+ext,
  '--load-extension='+ext,'http://127.0.0.1:'+port+'/alice/status/973/photo/1'];
 child=spawn(edge,args,{stdio:['ignore','ignore','pipe'],
  windowsHide:true,detached:process.platform!=='win32'});
 let stderr='';child.stderr.on('data',b=>{stderr+=b;if(stderr.length>3000)stderr=stderr.slice(-3000)});
 let debugPort=null;
 for(let i=0;i<220;i++){
  const f=join(dir,'profile','DevToolsActivePort');
  if(existsSync(f)){
   debugPort=Number(readBytes(f,'utf8').split(/\r?\n/)[0]);break;
  }
  await nap(200);
 }
 if(!debugPort)throw Error('No Chrome DevToolsActivePort '+stderr.slice(-350));
 let page=null,targets=[];
 for(let i=0;i<100;i++){
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
  const timeout=setTimeout(()=>rej(Error('CDP WebSocket timeout')),12000);
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
  const id=seq++;
  const timer=setTimeout(()=>{
    requests.delete(id);
    reject(Error('MV3 CDP '+method+' timed out'));
  },12000);
  requests.set(id,{
    resolve(value){clearTimeout(timer);resolve(value)},
    reject(error){clearTimeout(timer);reject(error)}
  });
  socket.send(JSON.stringify({id,method,params}));
 });
 await command('Runtime.enable');
 let result='waiting',details='',startupReloaded=false;
 for(let i=0;i<240;i++){
  let r;
  try{r=await command('Runtime.evaluate',{
    expression:"({result:document.documentElement.dataset.mv3WorkerResult||'waiting',signals:document.documentElement.dataset.mv3WorkerSignals||'',error:document.documentElement.dataset.mv3WorkerError||''})",
    returnByValue:true
  })}catch{await nap(250);continue;}
  const v=r?.result?.value||{};
  result=v.result||'waiting';details=v.signals||v.error||'';
  if(result!=='waiting')break;
  // On Linux, an extension can finish loading after Chrome's first page.
  // Recover ONLY when the B5 probe never entered its first stage. Once it
  // sets the sessionStorage phase, reload would destroy useful evidence.
  // This does not skip any media/consent assertion or weaken a failed probe.
  if(i===25 && !startupReloaded){
    const phase=await command('Runtime.evaluate',{
      expression:"sessionStorage.getItem('xmn-native-b5-phase')",
      returnByValue:true
    });
    if(phase?.result?.value==null){
      startupReloaded=true;
      await command('Page.enable');
      await command('Page.reload',{ignoreCache:true});
    }
  }
  await nap(260);
 }
 const types=targets.map(t=>t.type);
 console.log(JSON.stringify({mv3Test:result,details,targets:types,
  genuineChromeForTesting:true,serviceWorkerResponded:false,
  testOrigin:'localhost only',productionGuardUnchanged:true,startupReloaded,
  crossDocumentNavigation:false,nativeFirstClick29Verified:result==='passed',
   nativeOnly:true,nativeModalRetained:result==='passed'},null,2));
 if(result!=='passed')process.exitCode=2;
}finally{
 if(socket){try{socket.close()}catch{}}
 if(child?.pid){
  if(process.platform==='win32'){
    try{execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],
      {stdio:'ignore',timeout:10000})}
    catch{try{child.kill('SIGKILL')}catch{}}
  }else{
    // Kill only the disposable Chromium process group after this smoke.
    try{process.kill(-child.pid,'SIGKILL')}
    catch{try{child.kill('SIGKILL')}catch{}}
  }
 }
 await nap(700);
 await new Promise(resolve=>server.close(resolve));
 rmSync(dir,{recursive:true,force:true,maxRetries:8,retryDelay:300});
}
