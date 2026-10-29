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
const dir=mkdtempSync(join(tmpdir(),'xmn-real-mv3-test-'));
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
 manifest_version:3,name:'XMN B1 isolated worker QA',version:'1.0.0',
 permissions:['storage'],background:{service_worker:'background.js'},
 content_scripts:[{matches:['http://127.0.0.1/*'],js:['content_script.js','probe.js'],
 css:['style.css'],run_at:'document_idle'}]
},null,2));
const probe=`
(async()=>{
 const m=(op,session,page,manifest,href)=>chrome.runtime.sendMessage({
  kind:'xmn-store-v1',op,profile:'alice',session,page,manifest,href
 });
 if(location.pathname.endsWith('/media')){
   sessionStorage.setItem('xmn-fxembed-consent-alice','yes');
   const before=await m('consent.get');
   const granted=await m('consent.set');
   const after=await m('consent.get');
   const snapshot={schema:1,profile:'alice',timeline:'alice|photo',
    expires:Date.now()+60000,
    refs:['/alice/status/500/photo/1','/alice/status/400/photo/1'],
    apiKeys:['400:photo:1'],photos:[],photoTotals:[],
    cursor:'NEXT',anchorFound:true,exhausted:false};
   const historical={...snapshot,
     refs:['/alice/status/300/photo/1','/alice/status/200/photo/1'],
     apiKeys:['200:photo:1'],cursor:null,exhausted:true};
   const saved=await m('session.set',snapshot);
   const malformed=await m('session.set',{
    ...snapshot,refs:snapshot.refs.slice().reverse()});
   const checkpoint=await m('checkpoint.put',snapshot,0);
   const duplicate=await m('checkpoint.put',snapshot,0);
   const collision=await m('checkpoint.put',{...snapshot,cursor:'INVALID_REPLACEMENT'},0);
   const olderPage=await m('checkpoint.put',historical,1);
   const pages=await m('checkpoint.list');
   const archived=await m('checkpoint.get',undefined,0);
   const pageManifest={
     schema:1,profile:'alice',timeline:'alice|photo',
     expires:snapshot.expires,activePage:1,pages:[{
       page:0,firstRef:snapshot.refs[0],lastRef:snapshot.refs.at(-1),
       mediaCount:2,incomingCursor:null,outgoingCursor:'NEXT'
     },{
       page:1,firstRef:historical.refs[0],lastRef:historical.refs.at(-1),
       mediaCount:2,incomingCursor:'NEXT',outgoingCursor:null
     }]
   };
   const manifestSaved=await m('manifest.put',undefined,undefined,pageManifest);
   const manifestRead=await m('manifest.get');
   const ok=before?.granted===false&&granted?.ok===true&&
    after?.granted===true&&saved?.ok===true&&malformed?.ok===false&&
    checkpoint?.ok===true&&duplicate?.ok===true&&collision?.ok===false&&
    olderPage?.ok===true&&pages?.pages?.length===2&&
    pages.pages[0]===0&&pages.pages[1]===1&&
    archived?.session?.cursor==='NEXT'&&
    manifestSaved?.ok===true&&manifestRead?.manifest?.pages?.length===2;
   if(!ok)throw Error('setup flags='+[
     before?.granted===false,granted?.ok===true,after?.granted===true,
     saved?.ok===true,malformed?.ok===false,checkpoint?.ok===true,
     duplicate?.ok===true,collision?.ok===false,
     olderPage?.ok===true,pages?.pages?.length===2,
     pages?.pages?.[0]===0,pages?.pages?.[1]===1,
     archived?.session?.cursor==='NEXT',manifestSaved?.ok===true,
     manifestRead?.manifest?.pages?.length===2
   ].join(','));
   // Main saved session still points to 500/400, while this exact URL is
   // owned by the separately committed 300/200 historical checkpoint.
   location.assign('/alice/status/200/photo/1');
   return;
 }
 const session=await m('session.get');
 const consent=await m('consent.get');
 const checkpoint=await m('checkpoint.get',undefined,1);
 const manifest=await m('manifest.get');
 const located=await m('checkpoint.find',undefined,undefined,
   undefined,location.pathname);
 const ok=location.pathname==='/alice/status/200/photo/1'&&
   session?.ok===true&&session?.session?.refs?.length===2&&
   session.session.cursor==='NEXT'&&consent?.granted===true&&
   checkpoint?.ok===true&&checkpoint?.session?.cursor===null&&
   manifest?.ok===true&&manifest.manifest?.pages?.length===2&&
   located?.ok===true&&located?.page===1&&
   located?.session?.refs?.at(-1)==='/alice/status/200/photo/1';
 setTimeout(()=>{
   const label=document.querySelector('.xmn-status')?.textContent||'';
   const previous=document.querySelector('.xmn-prev');
   const viewer=document.querySelector('[data-testid="swipe-to-dismiss"]');
   const replies=document.getElementById('replies');
   const visible=label==='投稿 2 / 2'&&previous&&!previous.disabled&&
     !!viewer?.isConnected&&replies?.textContent==='Original replies';
   document.documentElement.dataset.mv3WorkerResult=ok&&visible?'passed':'failed';
   document.documentElement.dataset.mv3WorkerSignals=[
    !!session?.ok,session?.session?.refs?.length||0,!!consent?.granted,
    !!visible,label
   ].join(',');
 },1300);
})().catch(e=>{
 document.documentElement.dataset.mv3WorkerResult='error';
 document.documentElement.dataset.mv3WorkerError=e?.message||'unknown';
});`;
writeFileSync(join(ext,'probe.js'),probe);
const server=createServer((req,res)=>{
 res.setHeader('content-type','text/html; charset=utf-8');
 if(req.url?.includes('/status/200/')){
   res.end(`<!doctype html><html><head><title>B2 historical checkpoint modal fixture</title></head><body>
    <main><div data-testid="primaryColumn"></div></main>
    <div role="dialog"><button data-testid="app-bar-close" aria-label="Close">Close</button>
     <div data-testid="swipe-to-dismiss" style="width:690px;height:420px">
      <img width="600" height="400" alt="fixture photo"
       src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=">
     </div><aside id="replies">Original replies</aside>
    </div>
    </body></html>`);
 }else{
   res.end('<!doctype html><html><head><title>B1 first page</title></head><body><main><div data-testid="primaryColumn"></div></main></body></html>');
 }
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
  '--load-extension='+ext,'http://127.0.0.1:'+port+'/alice/media'];
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
  crossDocumentNavigation:true,spoofedPageConsentIgnored:true},null,2));
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
