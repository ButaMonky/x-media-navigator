/**
 * Reproducible read-only Navigation API check inside a genuine MV3 isolated
 * content-script world. Uses localhost + a disposable browser profile.
 * Does NOT open X, user Chrome profiles, authentication or any remote URL.
 * Usage: CHROMIUM_PATH=<chrome-or-edge> node tools/navigation-isolated-probe.mjs
 */
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const browser = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
const root=mkdtempSync(join(tmpdir(),'xmn-nav-isolated-'));
const profile=join(root,'profile');
const ext=join(root,'probe-extension');
mkdirSync(ext,{recursive:true});
writeFileSync(join(ext,'manifest.json'),JSON.stringify({
  manifest_version:3,name:'XMN Navigation isolated test',version:'0.0.1',
  content_scripts:[{matches:['http://127.0.0.1/*'],js:['probe.js'],run_at:'document_start'}],
}));
writeFileSync(join(ext,'probe.js'),`(() => {
  const nav = window.navigation;
  document.documentElement.dataset.xmnIsolatedLoaded='yes';
  document.documentElement.dataset.xmnIsolatedSupported=
    nav && typeof nav.addEventListener==='function'?'yes':'no';
  if(nav && typeof nav.addEventListener==='function') {
    nav.addEventListener('currententrychange',()=>{
      document.documentElement.dataset.xmnIsolatedEvent='yes';
    });
  }
})();`);
const server=createServer((request,response)=>{
  response.writeHead(200,{'content-type':'text/html; charset=utf-8'});
  response.end(`<!doctype html><html><head><title>local-isolated-navigation-test</title></head>
    <body><script>setTimeout(() => {
      history.pushState({}, '', '/new-photo');
      document.documentElement.dataset.xmnPageHistory='changed';
    },150);</script></body></html>`);
});
const run=(args)=>new Promise((resolve,reject)=>{
  const child=spawn(browser,args,{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';
  const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(Error('browser probe timed out'))},30000);
  child.stdout.on('data',d=>stdout+=d.toString());
  child.stderr.on('data',d=>stderr+=d.toString());
  child.on('error',err=>{clearTimeout(timeout);reject(err);});
  child.on('close',code=>{
    clearTimeout(timeout);
    if(code!==0) reject(Error('headless Chromium failed: '+stderr.slice(-600)));
    else resolve(stdout);
  });
});
try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port+'/start-photo';
  const html=await run(['--headless=new','--no-sandbox','--disable-gpu',
    '--disable-dev-shm-usage','--no-first-run',
    '--disable-background-networking','--no-default-browser-check',
    '--disable-extensions-except='+ext,'--load-extension='+ext,
    '--user-data-dir='+profile,'--virtual-time-budget=2800','--dump-dom',url]);
  const result={
    disposableExtensionLoaded:/data-xmn-isolated-loaded="yes"/.test(html),
    navigationAvailableInIsolatedWorld:/data-xmn-isolated-supported="yes"/.test(html),
    currentEntryChangeObserved:/data-xmn-isolated-event="yes"/.test(html),
    pageHistoryUpdateObserved:/data-xmn-page-history="changed"/.test(html),
  };
  console.log(JSON.stringify(result,null,2));
  if(!result.disposableExtensionLoaded || !result.currentEntryChangeObserved ||
      !result.pageHistoryUpdateObserved) process.exitCode=1;
}finally{
  await new Promise(resolve=>server.close(resolve));
  rmSync(root,{recursive:true,force:true});
}
