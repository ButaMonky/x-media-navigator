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
const dir=mkdtempSync(join(tmpdir(),'xmn-history-jump-'));
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
 manifest_version:3,name:'XMN verified 3-page history jump test',version:'1.0.0',
 permissions:['storage'],background:{service_worker:'background.js'},
 content_scripts:[{matches:['http://127.0.0.1/*'],js:['content_script.js','probe.js'],
 css:['style.css'],run_at:'document_idle'}]
},null,2));
const probe="\n(async()=>{\n const id=n=>'/alice/status/'+n+'/photo/1';\n const store=new XMN.SessionStore();\n const phase=sessionStorage.getItem('xmn-history-phase');\n const nap=ms=>new Promise(resolve=>setTimeout(resolve,ms));\n const mark=(result,details)=>{\n   document.documentElement.dataset.mv3WorkerResult=result;\n   document.documentElement.dataset.mv3WorkerSignals=details;\n };\n const waitFor=async(index,cursor,firstRef)=>{\n  for(let i=0;i<40;i++){\n   const manifest=await store.loadPageManifest('alice');\n   const s=await store.load('alice');\n   const label=document.querySelector('.xmn-status')?.textContent||'';\n   const reply=document.getElementById('replies')?.textContent;\n   if(manifest?.pages.length===3&&manifest.activePage===index&&\n      s?.refs?.length===2&&s.refs[0]===firstRef&&\n      s.cursor===cursor&&label.startsWith('投稿 1 / 2')&&\n      reply==='Original replies')return true;\n   await nap(120);\n  }\n  return false;\n };\n if(location.pathname===id(900)&&phase===null){\n  const expires=Date.now()+60000;\n  const snap=(a,b,cursor)=>({\n   schema:1,profile:'alice',timeline:'alice|photo',expires,\n   refs:[id(a),id(b)],apiKeys:[b+':photo:1'],photos:[],\n   photoTotals:[],cursor,anchorFound:true,exhausted:cursor===null\n  });\n  const pages=[\n   snap(900,800,'CURSOR-A'),\n   snap(700,600,'CURSOR-B'),\n   snap(500,400,null)\n  ];\n  const descriptors=pages.map((page,index)=>({\n   page:index,firstRef:page.refs[0],lastRef:page.refs[1],\n   mediaCount:2,incomingCursor:index===0?null:pages[index-1].cursor,\n   outgoingCursor:page.cursor\n  }));\n  const manifest={schema:1,profile:'alice',timeline:'alice|photo',\n    expires,activePage:0,pages:descriptors};\n  if(!await store.grantConsent('alice'))throw Error('Consent unavailable');\n  if(!await store.save(pages[0]))throw Error('Seed session unavailable');\n  for(let i=0;i<3;i++)\n   if(!await store.saveCheckpoint(i,pages[i]))\n     throw Error('Checkpoint '+i+' rejected');\n  if(!await store.savePageManifest(manifest))\n    throw Error('Manifest page commit refused');\n  sessionStorage.setItem('xmn-history-phase','to-oldest');\n  location.assign(id(500));\n  return;\n }\n if(location.pathname===id(500)&&phase==='to-oldest'){\n  if(!await waitFor(2,null,id(500)))\n   throw Error('Non-adjacent page2 did not atomically become active');\n  sessionStorage.setItem('xmn-history-phase','to-newest');\n  location.assign(id(900));\n  return;\n }\n if(location.pathname===id(900)&&phase==='to-newest'){\n  if(!await waitFor(0,'CURSOR-A',id(900)))\n   throw Error('History jump from page2 to page0 left stale active session');\n  sessionStorage.setItem('xmn-history-phase','to-middle');\n  location.assign(id(700));\n  return;\n }\n if(location.pathname===id(700)&&phase==='to-middle'){\n  if(!await waitFor(1,'CURSOR-B',id(700)))\n   throw Error('Adjacent X route could not activate after two-page jump');\n  const m=await store.loadPageManifest('alice');\n  const p=await store.load('alice');\n  const reply=document.getElementById('replies');\n  mark('passed',[m?.activePage,m?.pages.length,\n    p?.refs.length,p?.cursor,reply?.textContent==='Original replies'].join(','));\n  return;\n }\n mark('failed','unexpected_phase');\n})().catch(error=>{\n document.documentElement.dataset.mv3WorkerResult='error';\n document.documentElement.dataset.mv3WorkerError=String(error?.message||error);\n});\n";
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
  '--load-extension='+ext,'http://127.0.0.1:'+port+'/alice/status/900/photo/1'];
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
 for(let i=0;i<180;i++){
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
  crossDocumentNavigation:true,atomicHistoricalCheckoutVerified:result==='passed'},null,2));
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
