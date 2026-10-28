/**
 * One-shot external service CORS check using a disposable MV3 isolated world.
 * No user's Chrome profile, X cookies, auth tokens or history is accessed.
 * A single public handle is requested (pignic_cafe); no write requests.
 */
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const browser=process.env.CHROMIUM_PATH||'/usr/bin/chromium';
const root=mkdtempSync(join(tmpdir(),'xmn-fxembed-cors-'));
const extension=join(root,'extension'),profile=join(root,'profile');
mkdirSync(extension,{recursive:true});
writeFileSync(join(extension,'manifest.json'),JSON.stringify({
  manifest_version:3,name:'XMN public media CORS probe',version:'0.0.1',
  content_scripts:[{matches:['http://127.0.0.1/*'],
    js:['probe.js'],run_at:'document_start'}],
}));
writeFileSync(join(extension,'probe.js'),`(() => {
  const abort=new AbortController();
  const kill=setTimeout(()=>abort.abort(),11000);
  fetch('https://api.fxtwitter.com/2/profile/pignic_cafe/media?count=5',{
    method:'GET',mode:'cors',credentials:'omit',referrerPolicy:'no-referrer',
    cache:'no-store',headers:{Accept:'application/json'},signal:abort.signal,
  }).then(r=>r.json()).then(j=>{
    document.documentElement.dataset.fxProbe=
      j.code===200 && Array.isArray(j.results)&&j.results.length>0?'ok':'invalid';
    document.documentElement.dataset.fxRows=String(j.results?.length??0);
  }).catch(e=>{document.documentElement.dataset.fxProbe='error';
    document.documentElement.dataset.fxError=String(e?.name||'unknown');})
    .finally(()=>clearTimeout(kill));
})();`);
const server=createServer((req,res)=>{
  res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
  res.end('<!doctype html><html><body>isolated public CORS test</body></html>');
});
try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const uri='http://127.0.0.1:'+server.address().port+'/';
  const output=await new Promise((resolve,reject)=>{
    const args=['--headless=new','--no-sandbox','--disable-gpu',
      '--disable-dev-shm-usage','--no-first-run','--disable-background-networking',
      '--disable-extensions-except='+extension,'--load-extension='+extension,
      '--user-data-dir='+profile,'--virtual-time-budget=22000','--dump-dom',uri];
    const child=spawn(browser,args,{stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    const timeout=setTimeout(()=>{child.kill('SIGKILL');
      reject(Error('browser CORS test timed out'));},30000);
    child.stdout.on('data',b=>stdout+=b);
    child.stderr.on('data',b=>stderr+=b);
    child.on('error',e=>{clearTimeout(timeout);reject(e);});
    child.on('close',code=>{
      clearTimeout(timeout);
      if(code!==0) reject(Error('Chromium error: '+stderr.slice(-300)));
      else resolve(stdout);
    });
  });
  const result={
    corsFromIsolatedMV3:/data-fx-probe="ok"/.test(output),
    externalRows:Number(output.match(/data-fx-rows="(\d+)"/)?.[1]||0),
    reason:output.match(/data-fx-error="([^"]+)"/)?.[1]||null,
  };
  console.log(JSON.stringify(result));
  if(!result.corsFromIsolatedMV3)process.exitCode=1;
}finally{
  await new Promise(resolve=>server.close(resolve));
  rmSync(root,{recursive:true,force:true});
}
