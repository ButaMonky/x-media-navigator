import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('..', import.meta.url));
const contentScript = readFileSync(join(root, 'extension/content_script.js'));
const browser = process.env.CHROMIUM_PATH || '/usr/bin/chromium';

const fixture = `<!doctype html><html lang="ja"><head><meta charset="utf-8"></head><body>
<main><div data-testid="primaryColumn"><ul id="tiles"></ul></div></main>
<script>
const wait = ms => new Promise(r => setTimeout(r, ms));
window.prefetchLoads=[];
window.Image = class { set src(value) { window.prefetchLoads.push(value); } };
const records = [];
let nativeMoves = 0, clicked = [];
const ul = document.getElementById('tiles');
function tile(href) {
  const li = document.createElement('li'); li.setAttribute('role','listitem');
  li.innerHTML = '<a href="'+href+'"><img alt="thumbnail" src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="></a>';
  const thumb=li.querySelector('img');
  Object.defineProperty(thumb,'currentSrc',{value:'https://pbs.twimg.com/media/M'+href.replace(/[^a-zA-Z0-9]/g,'_')+'?format=jpg&name=small'});
  return li;
}
['/alice/status/11/photo/1','/alice/status/11/photo/2','/alice/status/22/photo/1','/bob/status/999/photo/1'].forEach(href => ul.appendChild(tile(href)));
const source = href => Array.from(ul.querySelectorAll('a')).find(a => a.getAttribute('href') === href);
function show(href, withClose=true) {
  document.getElementById('modal')?.remove();
  history.pushState({},'',href);
  const modal = document.createElement('div'); modal.id='modal'; modal.setAttribute('role','dialog');
  if (withClose) {
    const close = document.createElement('button'); close.setAttribute('aria-label','Close');close.textContent='Close';
    close.addEventListener('click', () => { modal.remove(); history.pushState({},'', '/alice/media'); });
    modal.appendChild(close);
  }
  const viewer = document.createElement('div'); viewer.dataset.testid='swipe-to-dismiss';modal.appendChild(viewer);
  const article = document.createElement('article'); article.dataset.testid='tweet';
  const status = /status\\/(\\d+)/.exec(href)?.[1];
  const links = Array.from(ul.querySelectorAll('a[href]')).filter(a=>a.getAttribute('href').includes('/status/'+status+'/photo/'));
  for (const source of links) { const a = document.createElement('a'); a.href = source.getAttribute('href');article.appendChild(a); }
  modal.appendChild(article);
  const input = document.createElement('input');input.id='test-input';modal.appendChild(input);
  document.body.appendChild(modal);
}
ul.addEventListener('click', e => {
  const a=e.target.closest('a[href]'); if (!a) return;
  const href=a.getAttribute('href');e.preventDefault();clicked.push(href);show(href);
});
document.addEventListener('keydown', e => {
  if (e.shiftKey || !['ArrowRight','ArrowLeft'].includes(e.key)) return;
  const pathname=location.pathname;
  const m=/status\\/(\\d+)\\/photo\\/(\\d+)/.exec(pathname);
  if (!m) return;
  const next=Number(m[2])+(e.key==='ArrowRight'?1:-1);
  if (source('/alice/status/'+m[1]+'/photo/'+next)) {
    nativeMoves++;
    history.replaceState({},'', '/alice/status/'+m[1]+'/photo/'+next);
  }
});
window.scrollTo = () => {
  if (window.testLazyLoad && !source('/alice/status/33/photo/1')) {
    window.testLazyLoad = false;
    setTimeout(()=>ul.appendChild(tile('/alice/status/33/photo/1')),160);
  }
};
const key = (keyName, shift=false, el=document.body) => {
  const e = new KeyboardEvent('keydown', { key:keyName, shiftKey:shift, bubbles:true, cancelable:true });
  el.dispatchEvent(e);return e;
};
function result(label, pass) { records.push({label,pass}); }
async function exercise() {
  await wait(750);
  const badges = Array.from(document.querySelectorAll('.xmn-tile-badge')).map(n=>n.textContent);
  result('profile scope 3 badges', badges.length===3 && badges.join(',')==='1,2,3');
  source('/alice/status/11/photo/1').click();
  await wait(620);
  const nativeRight=key('ArrowRight');
  await wait(500);
  result('gallery first image native ArrowRight',!nativeRight.defaultPrevented && nativeMoves===1 && location.pathname.endsWith('/11/photo/2'));
  result('adjacent CDN image preload initiated',window.prefetchLoads.length>0 && window.prefetchLoads[0].startsWith('https://pbs.twimg.com/media/') && window.prefetchLoads[0].includes('name=large'));
  const boundaryRight=key('ArrowRight');
  await wait(850);
  result('last photo ArrowRight advances to next POST',boundaryRight.defaultPrevented && location.pathname.endsWith('/22/photo/1') && clicked.at(-1)==='/alice/status/22/photo/1');
  const boundaryLeft=key('ArrowLeft');
  await wait(850);
  result('first photo ArrowLeft returns to previous POST last image',boundaryLeft.defaultPrevented && location.pathname.endsWith('/11/photo/2') && clicked.at(-1)==='/alice/status/11/photo/2');
  const nativeLeft=key('ArrowLeft');
  await wait(500);
  result('gallery second image native ArrowLeft',!nativeLeft.defaultPrevented && nativeMoves===2 && location.pathname.endsWith('/11/photo/1'));
  const modified=key('ArrowRight',true);
  await wait(350);
  result('Shift+arrow not a shortcut',!modified.defaultPrevented && location.pathname.endsWith('/11/photo/1'));
  document.querySelector('#modal button[aria-label="Close"]').click();
  await wait(500);
  const old=source('/alice/status/11/photo/2').closest('li');
  old.replaceWith(tile('/alice/status/11/photo/2'));
  source('/alice/status/11/photo/2').click();
  await wait(550);
  key('ArrowRight');
  await wait(850);
  result('recreated DOM navigates to next POST',location.pathname.endsWith('/22/photo/1') && clicked.at(-1)==='/alice/status/22/photo/1');
  const input=document.getElementById('test-input');input.focus();
  const inputEvent=key('ArrowRight',false,input);
  await wait(450);
  result('focused input retains native keys',location.pathname.endsWith('/22/photo/1') && !inputEvent.defaultPrevented);
  window.testLazyLoad=true;
  key('ArrowRight');
  await wait(1500);
  result('lazy load navigates only after new POST exists',location.pathname.endsWith('/33/photo/1') && clicked.at(-1)==='/alice/status/33/photo/1');
  document.querySelector('#modal button[aria-label="Close"]').click();
  await wait(400);
  show('/alice/status/22/photo/1',false);
  await wait(550);
  key('ArrowRight');
  await wait(400);
  result('missing close button safely aborts',location.pathname.endsWith('/22/photo/1') && !!document.getElementById('modal'));
  document.body.setAttribute('data-xmn-results',records.map(r=>r.label+':'+(r.pass?'PASS':'FAIL')).join('|'));
}

</script><script src="/extension/content_script.js"></script>
<script>exercise().catch(e=>document.body.setAttribute('data-xmn-results','EXCEPTION:'+e.message));</script>
</body></html>`;

test('synthetic X inline JavaScript parses before opening Chromium', () => {
  for (const [, source] of fixture.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/g)) {
    if (source.trim()) assert.doesNotThrow(() => new vm.Script(source));
  }
});

function runChromium(url, userDataDir) {
  return new Promise((resolve, reject) => {
    const args = [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--disable-background-networking', '--no-first-run',
      '--user-data-dir=' + userDataDir, '--virtual-time-budget=19000', '--dump-dom', url,
    ];
    const child = spawn(browser, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Chromium timed out')) }, 20000);
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', err => { clearTimeout(timeout); reject(err); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error('Chromium exit '+code+': '+stderr.slice(-500)));
      else resolve(stdout);
    });
  });
}

test('Chromium synthetic-X DOM: gallery edges, native arrows, post grouping, reflow, lazy load, graceful fallback', {
  skip: process.env.XMN_RUN_CHROMIUM !== '1' ? 'Requires XMN_RUN_CHROMIUM=1 and functioning headless Chromium' : !existsSync(browser) ? 'Chromium not installed' : false,
}, async () => {
  const server = createServer((req, res) => {
    if (req.url === '/extension/content_script.js') {
      res.writeHead(200, {'content-type':'text/javascript; charset=utf-8'});res.end(contentScript);
    } else {
      res.writeHead(200, {'content-type':'text/html; charset=utf-8'});res.end(fixture);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = mkdtempSync(join(tmpdir(), 'xmn-chromium-'));
  try {
    const port = server.address().port;
    const output = await runChromium(`http://127.0.0.1:${port}/alice/media`, dir);
    const match = output.match(/data-xmn-results="([^"]+)"/);
    assert.ok(match, 'Missing browser result marker; output: ' + output.slice(-1000));
    const report = match[1].replace(/&quot;/g,'"').replace(/&amp;/g,'&');
    assert.ok(!report.includes('FAIL') && !report.includes('EXCEPTION'), report);
    assert.equal(report.split('|').length, 6, report);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});