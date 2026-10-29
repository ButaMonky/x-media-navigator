/** Opt-in isolated cache lab. Uses only localhost GIF bytes; never requests X. */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const browser = process.env.CHROMIUM_PATH ||
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
if(!existsSync(browser))throw Error('Chromium/Edge not available');
const pixel = Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=','base64');
const counts = {large:0,orig:0,other:0};
const server=createServer((req,res)=>{
  if(req.url?.startsWith('/image.gif')){
    const variant=new URL(req.url,'http://127.0.0.1').searchParams.get('name');
    if(variant==='large'||variant==='orig')counts[variant]++;
    else counts.other++;
    res.writeHead(200,{'content-type':'image/gif',
      'cache-control':'public, max-age=1200, immutable','content-length':pixel.length});
    return res.end(pixel);
  }
  res.writeHead(200,{'content-type':'text/html; charset=utf-8',
    'cache-control':'no-store'});
  res.end(`<!doctype html><html><body><script>
const load = src => new Promise((resolve,reject)=>{
 const img=new Image();img.onload=resolve;img.onerror=reject;img.src=src;
});
(async()=>{
 await load('/image.gif?name=large');
 await load('/image.gif?name=orig');
 await load('/image.gif?name=large');
 document.documentElement.dataset.probe='complete';
})().catch(()=>document.documentElement.dataset.probe='error');
</script></body></html>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const profile=mkdtempSync(join(tmpdir(),'xmn-size-variant-'));
try{
  const url='http://127.0.0.1:'+server.address().port+'/';
  const args=['--headless=new','--no-sandbox','--disable-gpu',
    '--no-first-run','--disable-background-networking',
    '--user-data-dir='+profile,'--virtual-time-budget=12000','--dump-dom',url];
  const output=await new Promise((resolve,reject)=>{
    const child=spawn(browser,args,{stdio:['ignore','pipe','pipe'],windowsHide:true});
    let stdout='',stderr='';
    const kill=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Browser timed out'));},28000);
    child.stdout.on('data',b=>stdout+=String(b));
    child.stderr.on('data',b=>stderr+=String(b).slice(-400));
    child.on('error',e=>{clearTimeout(kill);reject(e);});
    child.on('close',code=>{
      clearTimeout(kill);
      if(code!==0)reject(Error('Browser exit '+code+': '+stderr.slice(-350)));
      else resolve(stdout);
    });
  });
  const complete=/data-probe="complete"/.test(output);
  const passed=complete && counts.large===1 && counts.orig===1;
  console.log(JSON.stringify({
    probe:'local URL-variant browser cache test (NOT X CDN)',
    pageComplete:complete,requests:{...counts},
    inference:passed ? 'large and orig were distinct cache entries in this lab' :
      'unexpected results; no cache inference',
  }));
  if(!passed)process.exitCode=2;
}finally{
  await new Promise(resolve=>server.close(resolve));
  rmSync(profile,{recursive:true,force:true,maxRetries:8,retryDelay:250});
}
