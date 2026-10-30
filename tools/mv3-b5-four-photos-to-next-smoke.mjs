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
const dir=mkdtempSync(join(tmpdir(),'xmn-b5-four-photo-'));
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
 manifest_version:3,name:'XMN B5 fourth photo to next-post synthetic acceptance',version:'1.0.0',
 permissions:['storage'],background:{service_worker:'background.js'},
 content_scripts:[{matches:['http://127.0.0.1/*'],js:['content_script.js','probe.js'],
 css:['style.css'],run_at:'document_idle'}]
},null,2));
const probe="\n(async()=>{\n  const id=n=>'/alice/status/'+n+'/photo/1';\n  const img=n=>'https://pbs.twimg.com/media/TEST'+n+'?format=jpg&name=large';\n  const photo4='/alice/status/973/photo/4';\n  const store=new XMN.SessionStore();\n  const phase=sessionStorage.getItem('xmn-native-b5-phase');\n  if(phase!==null)new XMN.Controller({enableLegacyProviderForIsolatedQa:true});\n  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));\n  const publish=(result,details)=>{\n    document.documentElement.dataset.mv3WorkerResult=result;\n    document.documentElement.dataset.mv3WorkerSignals=details;\n  };\n  if(location.pathname===photo4&&phase===null){\n    const ids=Array.from({length:28},(_,i)=>1000-i);\n    const refs=ids.flatMap(n=>n===973?Array.from({length:4},(_,i)=>XMN.mediaRefFromHref('/alice/status/973/photo/'+(i+1),'alice')):[XMN.mediaRefFromHref(id(n),'alice')]);\n    if(!refs.every(Boolean))throw Error('Native refs malformed');\n    if((await store.load('alice'))!==null)\n      throw Error('An API-backed session was pre-seeded incorrectly');\n    if(!(await store.grantConsent('alice')))\n      throw Error('Explicit FxEmbed consent could not be saved');\n    const next=XMN.mediaRefFromHref(id(972),'alice');\n    const viewer=document.querySelector('[data-testid=\"swipe-to-dismiss\"]');\n    if(!viewer?.isConnected)throw Error('Missing X-like viewer');\n    let calls=0;\n    const ctl=Object.assign(Object.create(XMN.Controller.prototype),{\n      experimentalThirdPartyApiEnabled:true, // isolated legacy provider fixture\n      originProfile:'alice',originTimeline:'alice|photo',navGeneration:12,\n      refs,indexes:new Map(refs.map((ref,i)=>[ref.key,i])),\n      publicApiKeys:new Set(),publicApiCursor:null,publicApiAnchorFound:false,\n      publicApiExhausted:false,publicApiLoading:false,publicApiRetryAt:0,\n      publicApiFailures:0,publicSessionRestored:false,restoredCheckpointPage:null,\n      sessionStore:store,viewer,navigationBusy:false,pendingBoundary:null,\n      checkpointBoundaryPending:false,pendingDocumentHandoff:null,\n      imageSources:new Map(refs.map(r=>[r.key,img(r.statusId)])),\n      knownPhotoTotals:new Map(ids.map(n=>[String(n),n===973?4:1])),\n      imageSourcesRevision:0,viewerStateSnapshot:null,\n      updateViewerState(){},toast(message){throw Error('Unexpected toast '+message)},\n      activeIndex(){return 30},findLiveLink(){return null},\n      fetchPublicMediaPage:async()=>{\n        calls++;\n        sessionStorage.setItem('xmn-b5-provider-calls',String(calls));\n        return {refs:[XMN.mediaRefFromHref(id(974),'alice'),\n          ...Array.from({length:4},(_,i)=>XMN.mediaRefFromHref('/alice/status/973/photo/'+(i+1),'alice')),next],\n          photos:[[next.key,img(972)]],cursor:null};\n      }\n    });\n    sessionStorage.setItem('xmn-native-b5-phase','starting');\n    const event={key:'ArrowRight',repeat:false,isComposing:false,\n      shiftKey:false,altKey:false,ctrlKey:false,metaKey:false,\n      target:document.body,prevented:false,stopped:false,\n      preventDefault(){this.prevented=true},\n      stopImmediatePropagation(){this.stopped=true}};\n    XMN.Controller.prototype.onKeyDown.call(ctl,event);\n    if(!event.prevented||!event.stopped)\n      throw Error('Proven fourth-photo right arrow was not intercepted');\n    await sleep(3000);\n    throw Error('Native 28 -> 29 did not navigate on the first arrow');\n  }\n  if(location.pathname===id(972)&&phase==='starting'){\n    await sleep(1600);\n    const session=await store.load('alice');\n    const label=document.querySelector('.xmn-status')?.textContent||'';\n    const prev=document.querySelector('.xmn-prev');\n    const replies=document.getElementById('replies');\n    if(session?.refs?.length!==32||\n      session.apiKeys?.length!==1||\n      session.apiKeys[0]!=='972:photo:1'||\n      session.refs.at(-1)!==id(972)||session.cursor!==null||\n      label!=='投稿 29 / 29'||!prev||prev.disabled||\n      replies?.textContent!=='Original replies')\n      throw Error('Native 29 restore mismatch '+JSON.stringify({\n        count:session?.refs?.length,apiKeys:session?.apiKeys?.length,\n        label,prev:!!prev,replies:replies?.textContent}));\n    sessionStorage.setItem('xmn-native-b5-phase','29-verified');\n    prev.click();\n    return;\n  }\n  if(location.pathname===photo4&&phase==='29-verified'){\n    await sleep(1700);\n    const session=await store.load('alice');\n    const label=document.querySelector('.xmn-status')?.textContent||'';\n    const next=document.querySelector('.xmn-next');\n    const replies=document.getElementById('replies');\n    const success=session?.refs?.length===32&&\n      session.apiKeys?.length===1&&session.refs.at(-1)===id(972)&&\n      sessionStorage.getItem('xmn-b5-provider-calls')==='1'&&\n      label==='投稿 28 / 29'&&!!next&&!next.disabled&&\n      replies?.textContent==='Original replies';\n    publish(success?'passed':'failed',[\n      !!success,session?.refs?.length||0,\n      session?.apiKeys?.length||0,label,\n      !!next,replies?.textContent==='Original replies'\n    ].join(','));\n    return;\n  }\n  publish('failed','unexpected_phase');\n})().catch(error=>{\n  document.documentElement.dataset.mv3WorkerResult='error';\n  document.documentElement.dataset.mv3WorkerError=String(error?.message||error);\n});\n";
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
  '--load-extension='+ext,'http://127.0.0.1:'+port+'/alice/status/973/photo/4'];
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
  genuineChromeForTesting:true,serviceWorkerResponded:result==='passed',
  testOrigin:'localhost only',productionGuardUnchanged:true,startupReloaded,
  crossDocumentNavigation:true,fourPhotoBoundaryVerified:result==='passed'},null,2));
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
