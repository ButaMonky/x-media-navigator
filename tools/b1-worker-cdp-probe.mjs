/** Read-only smoke of the ACTUAL MV3 worker through Chrome DevTools Protocol.
 * Disposable browser profile, localhost only. No X, passwords or account data.
 */
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync,
  existsSync, rmSync } from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const sourceRoot=fileURLToPath(new URL('..',import.meta.url));
const browser=process.env.CHROMIUM_PATH||process.env.XMN_CHROME_FOR_TESTING||
 (process.platform==='win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : '/usr/bin/chromium');
const tmp=mkdtempSync(join(tmpdir(),'xmn-worker-cdp-'));
const profile=join(tmp,'profile'),ext=join(tmp,'extension');
mkdirSync(ext,{recursive:true});
writeFileSync(join(ext,'manifest.json'),JSON.stringify({
 manifest_version:3,name:'XMN isolated worker probe',version:'0.0.1',
 permissions:['storage'],background:{service_worker:'background.js'},
 content_scripts:[{matches:['http://127.0.0.1/*'],js:['probe.js'],run_at:'document_start'}]
}));
copyFileSync(join(sourceRoot,'extension/background.js'),join(ext,'background.js'));
writeFileSync(join(ext,'probe.js'),`(() => {
 document.documentElement.dataset.xmnWorker='waiting';
 document.documentElement.dataset.xmnContent='loaded';
 chrome.runtime.sendMessage({kind:'xmn-store-v1',op:'consent.get',profile:'alice'})
  .then(reply=>{document.documentElement.dataset.xmnWorker =
    reply?.ok===false?'rejected-localhost':'unexpected-'+JSON.stringify(reply);})
  .catch(e=>{document.documentElement.dataset.xmnWorker='error-'+String(e.message).slice(0,160)});
})();`);
const server=createServer((_req,res)=>{
 res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
 res.end('<!doctype html><html><head><title>XMN LOCAL WORKER CDP</title></head><body>Local only</body></html>');
});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const readPort=async()=>{
 for(let i=0;i<180;i++){
  const f=join(profile,'DevToolsActivePort');
  if(existsSync(f)){
   const content=readFileSync(f,'utf8').trim().split(/\r?\n/);
   const port=Number(content[0]);
   if(Number.isInteger(port)&&port>0)return port;
  }
  await sleep(100);
 }
 throw Error('Chrome did not start its isolated DevTools port');
};
const getTargets=async port=>{
 const res=await fetch('http://127.0.0.1:'+port+'/json/list');
 if(!res.ok)throw Error('DevTools list HTTP '+res.status);
 return res.json();
};
const evaluate=async (target,expression)=>{
 return new Promise((resolve,reject)=>{
  const ws=new WebSocket(target.webSocketDebuggerUrl);
  const timer=setTimeout(()=>{ws.close();reject(Error('CDP timed out'))},5000);
  ws.addEventListener('open',()=>ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',
    params:{expression,returnByValue:true,awaitPromise:true}})));
  ws.addEventListener('message',ev=>{
   const r=JSON.parse(ev.data);
   if(r.id!==1)return;
   clearTimeout(timer);ws.close();
   if(r.error||r.result?.exceptionDetails)reject(Error(JSON.stringify(r.error||r.result.exceptionDetails)));
   else resolve(r.result?.result?.value);
  });
  ws.addEventListener('error',err=>{
   clearTimeout(timer);reject(Error('CDP websocket failed: '+String(err.message||err.type)));
  });
 });
};
let child=null;
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const local='http://127.0.0.1:'+server.address().port+'/worker-check';
 const args=['--headless=new','--no-sandbox','--disable-gpu','--no-first-run',
  '--disable-background-networking','--no-default-browser-check',
  '--remote-allow-origins=*','--remote-debugging-port=0',
  '--disable-extensions-except='+ext,'--load-extension='+ext,
  '--user-data-dir='+profile,local];
 child=spawn(browser,args,{stdio:['ignore','ignore','pipe'],windowsHide:true});
 let browserErrors='';
 child.stderr.on('data',b=>browserErrors+=String(b).slice(-750));
 const port=await readPort();
 let state='unknown',content='unknown',workerDetected=false;
 for(let i=0;i<35;i++){
  const targets=await getTargets(port);
  workerDetected ||= targets.some(t=>t.type==='service_worker' &&
    t.url.startsWith('chrome-extension://'));
  const page=targets.find(t=>t.type==='page' && t.url.startsWith(local));
  if(page){
   try{
    const result=await evaluate(page,`({
      result:document.documentElement.dataset.xmnWorker||null,
      content:document.documentElement.dataset.xmnContent||null
    })`);
    state=result?.result||'not-set';
    content=result?.content||'not-set';
   }catch{}
  }
  if(state!=='waiting' && state!=='not-set' && state!=='unknown')break;
  await sleep(250);
 }
 const result={contentScriptLoaded:content==='loaded',
  actualMv3WorkerTargetDetected:workerDetected,
  workerStatus:state,foreignOriginRejected:state==='rejected-localhost',
  temporaryProfileOnly:true,realXVisited:false,authenticationRead:false};
 console.log(JSON.stringify(result,null,2));
 if(!result.contentScriptLoaded || !result.foreignOriginRejected)process.exitCode=2;
}finally{
 await new Promise(resolve=>server.close(resolve));
 if(child?.pid){
  try{execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],
    {windowsHide:true,timeout:8000,stdio:'ignore'});}catch{
   try{child.kill('SIGKILL')}catch{}
  }
  await sleep(400);
 }
 try{rmSync(tmp,{recursive:true,force:true,maxRetries:8,retryDelay:250})}
 catch(e){console.error('Temporary browser profile cleanup failed:',e.message);process.exitCode=2}
}
