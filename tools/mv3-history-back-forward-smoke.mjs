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
const dir=mkdtempSync(join(tmpdir(),'xmn-history-back-'));
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
 manifest_version:3,name:'XMN real browser back forward checkpoints test',version:'1.0.0',
 permissions:['storage'],background:{service_worker:'background.js'},
 content_scripts:[{matches:['http://127.0.0.1/*'],js:['content_script.js','probe.js'],
 css:['style.css'],run_at:'document_idle'}]
},null,2));
const probe="\n(() => {\n const id=n=>'/alice/status/'+n+'/photo/1';\n const store=new XMN.SessionStore();\n const nap=ms=>new Promise(resolve=>setTimeout(resolve,ms));\n const mark=(result,details)=>{\n  document.documentElement.dataset.mv3WorkerResult=result;\n  document.documentElement.dataset.mv3WorkerSignals=details;\n };\n const waitFor=async(index,cursor,firstRef)=>{\n  for(let i=0;i<35;i++){\n    const m=await store.loadPageManifest('alice');\n    const s=await store.load('alice');\n    const label=document.querySelector('.xmn-status')?.textContent||'';\n    if(m?.activePage===index&&m.pages.length===3&&\n       s?.refs[0]===firstRef&&s.refs.length===2&&\n       s.cursor===cursor&&label.startsWith('投稿 1 / 2'))return true;\n    await nap(120);\n  }\n  return false;\n };\n let running=false;\n const run=async()=>{\n  if(running)return;\n  running=true;\n  try{\n   const phase=sessionStorage.getItem('xmn-history-back-phase');\n   if(location.pathname===id(900)&&phase===null){\n    const expires=Date.now()+60000;\n    const snapshot=(a,b,cursor)=>({\n      schema:1,profile:'alice',timeline:'alice|photo',expires,\n      refs:[id(a),id(b)],apiKeys:[b+':photo:1'],photos:[],photoTotals:[],\n      cursor,anchorFound:true,exhausted:cursor===null\n    });\n    const pages=[\n      snapshot(900,800,'CURSOR-A'),\n      snapshot(700,600,'CURSOR-B'),\n      snapshot(500,400,null)\n    ];\n    const rows=pages.map((p,i)=>({\n      page:i,firstRef:p.refs[0],lastRef:p.refs[1],mediaCount:2,\n      incomingCursor:i===0?null:pages[i-1].cursor,\n      outgoingCursor:p.cursor\n    }));\n    const manifest={\n      schema:1,profile:'alice',timeline:'alice|photo',\n      expires,activePage:0,pages:rows\n    };\n    if(!await store.grantConsent('alice')||!await store.save(pages[0]))\n      throw Error('Failed to seed consent/session');\n    for(let i=0;i<pages.length;i++){\n      if(!await store.saveCheckpoint(i,pages[i]))\n        throw Error('Failed to seed page '+i);\n    }\n    if(!await store.savePageManifest(manifest))\n      throw Error('Failed to create verified manifest');\n    sessionStorage.setItem('xmn-history-back-phase','to-oldest');\n    location.assign(id(500));\n    return;\n   }\n   if(location.pathname===id(500)&&phase==='to-oldest'){\n    if(!await waitFor(2,null,id(500)))\n      throw Error('Page2 first activation failed');\n    sessionStorage.setItem('xmn-history-back-phase','back-to-newest');\n    history.back();\n    return;\n   }\n   if(location.pathname===id(900)&&phase==='back-to-newest'){\n    if(!await waitFor(0,'CURSOR-A',id(900)))\n      throw Error('Actual browser history.back left the Worker on page2');\n    sessionStorage.setItem('xmn-history-back-phase','forward-to-oldest');\n    history.forward();\n    return;\n   }\n   if(location.pathname===id(500)&&phase==='forward-to-oldest'){\n    if(!await waitFor(2,null,id(500)))\n      throw Error('Actual browser history.forward left Worker on page0');\n    const m=await store.loadPageManifest('alice');\n    const s=await store.load('alice');\n    mark('passed',[\n      m?.activePage,m?.pages.length,s?.refs.length,\n      document.getElementById('replies')?.textContent==='Original replies'\n    ].join(','));\n    return;\n   }\n   mark('failed','unexpected_phase '+phase);\n  }catch(e){\n   document.documentElement.dataset.mv3WorkerResult='error';\n   document.documentElement.dataset.mv3WorkerError=String(e?.message||e);\n  }finally{running=false;}\n };\n window.addEventListener('pageshow',e=>{\n  if(e.persisted)void run();\n });\n void run();\n})();\n";
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
 child=spawn(edge,args,{stdio:['ignore','ignore','pipe'],windowsHide:true,detached:process.platform!=='win32'});
 let stderr='';child.stderr.on('data',b=>{stderr+=b;if(stderr.length>3000)stderr=stderr.slice(-3000)});
 let debugPort=null;
 for(let i=0;i<210;i++){
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
  const timer=setTimeout(()=>{requests.delete(id);
   reject(Error('MV3 CDP '+method+' timed out'))},12000);
  requests.set(id,{
   resolve(value){clearTimeout(timer);resolve(value)},
   reject(error){clearTimeout(timer);reject(error)}
  });
  socket.send(JSON.stringify({id,method,params}));
 });
 await command('Runtime.enable');
 let result='waiting',details='',startupReloaded=false;
 for(let i=0;i<250;i++){
  let r;
  try{r=await command('Runtime.evaluate',{
    expression:"({result:document.documentElement.dataset.mv3WorkerResult||'waiting',signals:document.documentElement.dataset.mv3WorkerSignals||'',error:document.documentElement.dataset.mv3WorkerError||''})",
    returnByValue:true
  })}catch{await nap(250);continue;}
  const v=r?.result?.value||{};
  result=v.result||'waiting';details=v.signals||v.error||'';
  if(result!=='waiting')break;
  if(i===25&&!startupReloaded){
   const marker=await command('Runtime.evaluate',{
    expression:"sessionStorage.getItem('xmn-history-back-phase')",returnByValue:true
   }).catch(()=>null);
   const route=await command('Runtime.evaluate',{
    expression:'location.pathname',returnByValue:true
   }).catch(()=>null);
   // Only an uninitialized disposable first-page probe may reload.
   if(marker?.result?.value==null&&
      route?.result?.value==='/alice/status/900/photo/1'){
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
  crossDocumentNavigation:true,nativeBackForwardVerified:result==='passed'},null,2));
 if(result!=='passed')process.exitCode=2;
}finally{
 if(socket){try{socket.close()}catch{}}
 if(child?.pid){
  if(process.platform==='win32'){
   try{execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],
    {stdio:'ignore',timeout:10000})}catch{try{child.kill('SIGKILL')}catch{}}
  }else{
   try{process.kill(-child.pid,'SIGKILL')}catch{try{child.kill('SIGKILL')}catch{}}
  }
 }
 await nap(700);
 await new Promise(resolve=>server.close(resolve));
 rmSync(dir,{recursive:true,force:true,maxRetries:8,retryDelay:300});
}
