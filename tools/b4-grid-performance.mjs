/** Opt-in browser microbenchmark on a disposable localhost-only media grid.
 * No X session, user cookies, credentials, or outside HTTP requests.
 */
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,readdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const root=resolve('.');
const installed=join(process.env.LOCALAPPDATA||tmpdir(),
  'XMediaNavigator','QA-Browser','chrome');
const candidates=existsSync(installed)?
  readdirSync(installed).sort().reverse().map(
   v=>join(installed,v,'chrome-win64','chrome.exe')):[];
const browser=process.env.CHROMIUM_PATH||
  candidates.find(existsSync)||
  (process.platform==='win32'?null:'/usr/bin/chromium');
if(!browser||!existsSync(browser))
 throw Error('Chrome for Testing/Chromium unavailable');
const COUNT=Number(process.env.XMN_B4_TILE_COUNT||1200);
if(!Number.isInteger(COUNT)||COUNT<100||COUNT>5000)
 throw Error('XMN_B4_TILE_COUNT must be an integer from 100 to 5000');
const work=mkdtempSync(join(tmpdir(),'xmn-b4-grid-'));
const profile=join(work,'profile');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const pixel='data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
const html='<!doctype html><html><head><meta charset="utf-8"></head><body>'+
  '<main><div data-testid="primaryColumn"><ul id="tiles"></ul></div></main>'+
  '<script>'+
  'const list=document.getElementById("tiles");'+
  'const frag=document.createDocumentFragment();'+
  'for(let i=0;i<'+COUNT+';i++){'+
   'const li=document.createElement("li");li.setAttribute("role","listitem");'+
   'li.id="tile-"+i;const a=document.createElement("a");'+
   'a.href="/alice/status/"+(900000-i)+"/photo/1";'+
   'const img=document.createElement("img");img.src='+JSON.stringify(pixel)+';'+
   'a.appendChild(img);li.appendChild(a);frag.appendChild(li);}'+
  'list.appendChild(frag);'+
  '</script><script src="/content_script.js"></script></body></html>';
const server=createServer((req,res)=>{
 res.setHeader('content-type',req.url==='/content_script.js'?
  'text/javascript; charset=utf-8':'text/html; charset=utf-8');
 res.end(req.url==='/content_script.js'?
  readFileSync(join(root,'extension/content_script.js')):html);
});
let child=null,socket=null;
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 const args=['--headless=new','--no-sandbox','--disable-gpu',
  '--disable-dev-shm-usage','--disable-background-networking',
  '--no-first-run','--no-default-browser-check',
  '--remote-debugging-port=0','--remote-allow-origins=*',
  '--user-data-dir='+profile,origin+'/alice/media'];
 child=spawn(browser,args,{stdio:['ignore','ignore','pipe'],windowsHide:true});
 let stderr='';
 child.stderr.on('data',b=>{stderr+=b;
  if(stderr.length>3000)stderr=stderr.slice(-3000)});
 let port=null;
 for(let i=0;i<160;i++){
   const f=join(profile,'DevToolsActivePort');
   if(existsSync(f)){
     port=Number(readFileSync(f,'utf8').split(/\r?\n/)[0]);
     if(Number.isInteger(port)&&port>0)break;
   }
   await sleep(100);
 }
 if(!port)throw Error('Chrome DevTools port missing '+stderr.slice(-400));
 let page=null;
 for(let i=0;i<80;i++){
   try{
     const targets=await (await fetch(
      'http://127.0.0.1:'+port+'/json/list')).json();
     page=targets.find(x=>x.type==='page'&&x.url.startsWith(origin));
     if(page)break;
   }catch{}
   await sleep(150);
 }
 if(!page)throw Error('Chrome page missing '+stderr.slice(-500));
 socket=new WebSocket(page.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('CDP socket timeout')),6000);
  socket.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});
  socket.addEventListener('error',()=>{clearTimeout(timer);
   reject(Error('CDP connection failed'))},{once:true});
 });
 const pending=new Map();
 let id=0;
 socket.addEventListener('message',e=>{
  let value;try{value=JSON.parse(e.data)}catch{return}
  const entry=pending.get(value.id);
  if(!entry)return;
  pending.delete(value.id);clearTimeout(entry.timer);
  if(value.error)entry.reject(Error(JSON.stringify(value.error)));
  else entry.resolve(value.result);
 });
 const command=(method,params={})=>new Promise((resolve,reject)=>{
  const next=++id;
  const timer=setTimeout(()=>{pending.delete(next);
   reject(Error('CDP '+method+' timed out'))},9000);
  pending.set(next,{resolve,reject,timer});
  socket.send(JSON.stringify({id:next,method,params}));
 });
 await command('Runtime.enable');
 const evaluate=async expression=>{
  const result=await command('Runtime.evaluate',{
   expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails)
    throw Error(JSON.stringify(result.exceptionDetails).slice(0,800));
  return result?.result?.value;
 };
 let ready=0;
 for(let i=0;i<160;i++){
  ready=await evaluate(
   "document.querySelectorAll('li[role=listitem] .xmn-tile-badge').length");
  if(ready===COUNT)break;
  await sleep(100);
 }
 if(ready!==COUNT)
  throw Error('Initial media badges did not reach '+COUNT+': '+ready);
 const benchmark=await evaluate(`(()=>{
   const ctl=Object.create(XMN.Controller.prototype);
   ctl.originProfile='alice';
   const times=[];
   const base=ctl.captureGrid();
   for(let i=0;i<15;i++){
     const started=performance.now();
     if(ctl.hasGridTurnedOver(base))throw Error('unchanged grid changed');
     times.push(performance.now()-started);
   }
   const anchor=document.querySelector('#tile-'+Math.floor(${COUNT}/2)+' a');
   anchor.setAttribute('href','/alice/status/123456/photo/1');
   const keyChanged=ctl.hasGridTurnedOver(base);
   const replacedBase=ctl.captureGrid();
   const tile=document.getElementById('tile-'+(Math.floor(${COUNT}/2)+1));
   const replacement=tile.cloneNode(true);
   tile.replaceWith(replacement);
   const nodeChanged=ctl.hasGridTurnedOver(replacedBase);
   times.sort((a,b)=>a-b);
   return {tileCount:document.querySelectorAll('li[role=listitem]').length,
     badgeCount:document.querySelectorAll('.xmn-tile-badge').length,
     middleKeyChanged:keyChanged,middleNodeChanged:nodeChanged,
     medianFingerprintMs:Math.round(times[Math.floor(times.length/2)]*100)/100,
     slowestFingerprintMs:Math.round(times.at(-1)*100)/100,
     measurements:times.length,
     scope:'localhost disposable Chromium',realXVisited:false};
 })()`);
 if(!benchmark||benchmark.tileCount!==COUNT||
  benchmark.badgeCount!==COUNT||
  !benchmark.middleKeyChanged||!benchmark.middleNodeChanged)
   throw Error('B4 grid integrity check failed '+JSON.stringify(benchmark));
 console.log(JSON.stringify(benchmark,null,2));
}finally{
 if(socket)try{socket.close()}catch{}
 if(child?.pid){
  try{if(process.platform==='win32'){
    execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],
      {stdio:'ignore',timeout:10000});
   }else process.kill(child.pid,'SIGKILL');
  }catch{try{child.kill('SIGKILL')}catch{}}
 }
 await sleep(500);
 await new Promise(resolve=>server.listening?server.close(resolve):resolve());
 rmSync(work,{recursive:true,force:true,maxRetries:8,retryDelay:250});
}
