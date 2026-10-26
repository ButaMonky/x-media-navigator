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
const extensionCss = readFileSync(join(root, 'extension/style.css'));
const browser = process.env.CHROMIUM_PATH || '/usr/bin/chromium';

const fixture = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="stylesheet" href="/extension/style.css"></head><body>
<main><div data-testid="primaryColumn"><ul id="tiles"></ul></div></main>
<script>
const wait = ms => new Promise(r => setTimeout(r, ms));
window.prefetchLoads=[];
window.Image = function() {
  // Use a real DOM Image, but replace its payload with a local 1px fixture.
  const image = document.createElement('img');
  Object.defineProperty(image,'src',{configurable:true,
    get(){return image.dataset.requested || '';},
    set(value){
      image.dataset.requested=value;
      window.prefetchLoads.push(value);
      image.setAttribute('src','data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=');
    }
  });
  Object.defineProperty(image,'naturalWidth',{configurable:true,get(){return 1;}});
  image.decode=()=>Promise.resolve();
  return image;
};
let handoffsSeen=0, nonBlockingHandoff=true, noBlackBackdrop=true, hiddenUntilClose=true;
new MutationObserver(mutations=>{
  for(const mutation of mutations){
    for(const item of mutation.addedNodes){
      if(item.nodeType===1 && item.classList.contains('xmn-visual-handoff')){
        handoffsSeen++;
        const style=getComputedStyle(item);
        nonBlockingHandoff=nonBlockingHandoff && style.pointerEvents==='none';
        noBlackBackdrop=noBlackBackdrop && style.backgroundColor!=='rgb(0, 0, 0)';
        hiddenUntilClose=hiddenUntilClose && style.opacity==='0';
      }
    }
  }
}).observe(document.body,{childList:true});
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
// Synthetic quote-link pollution and an ambiguous, unanchored thumbnail tile.
const firstTile = source('/alice/status/11/photo/1').closest('li');
const quote = document.createElement('div');quote.dataset.testid='quoteTweet';
const quoteLink = document.createElement('a');quoteLink.href='/alice/status/999/photo/1';
quote.appendChild(quoteLink);firstTile.prepend(quote);
const ambiguousTile = tile('/alice/status/888/photo/1');
ambiguousTile.appendChild(ambiguousTile.querySelector('img'));
const otherLink = document.createElement('a');otherLink.href='/alice/status/889/photo/1';
ambiguousTile.prepend(otherLink);ul.appendChild(ambiguousTile);
window.testSpaKeepModal = true;
window.testSpaIgnoreInModal = false;
window.nativeModalCloses = 0;
function show(href, withClose=true) {
  const existing = document.getElementById('modal');
  const retain = !!existing && window.testSpaKeepModal;
  if (retain) {
    existing.querySelector('[data-testid="swipe-to-dismiss"]')?.remove();
    existing.querySelector('article[data-testid="tweet"]')?.remove();
    existing.querySelector('#test-input')?.remove();
    existing.querySelector('button[aria-label="Close"]')?.remove();
  } else existing?.remove();
  history.pushState({},'',href);
  const modal = retain ? existing : document.createElement('div');
  modal.id='modal'; modal.setAttribute('role','dialog');
  if (withClose) {
    const close = document.createElement('button'); close.setAttribute('aria-label','Close');close.textContent='Close';
    close.addEventListener('click', () => { window.nativeModalCloses++; modal.remove(); history.pushState({},'', '/alice/media'); });
    modal.appendChild(close);
  }
  const viewer = document.createElement('div'); viewer.dataset.testid='swipe-to-dismiss';
  viewer.style.cssText='width:65vw; height:85vh; position:relative;';
  modal.appendChild(viewer);
  // X's modal may include loaded avatars/other media ahead of the displayed
  // photo. The handoff must wait for the exact target media ID.
  const unrelatedPhoto = document.createElement('img');
  unrelatedPhoto.src='data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
  unrelatedPhoto.style.cssText='display:block;width:35px;height:35px;';
  Object.defineProperty(unrelatedPhoto,'currentSrc',{value:'https://pbs.twimg.com/media/WRONG?format=jpg&name=large'});
  viewer.appendChild(unrelatedPhoto);
  const activePhoto = document.createElement('img');
  activePhoto.src='data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
  // Render like an actual large X photo, rather than a 1px unstyled fixture.
  activePhoto.style.cssText='display:block;width:60vw;height:72vh;object-fit:contain;';
  Object.defineProperty(activePhoto,'currentSrc',{
    value:'https://pbs.twimg.com/media/M'+href.replace(/[^a-zA-Z0-9]/g,'_')+'?format=jpg&name=orig',
  });
  activePhoto.alt='Current X media photo';
  viewer.appendChild(activePhoto);
  const article = document.createElement('article'); article.dataset.testid='tweet';
  const status = /status\\/(\\d+)/.exec(href)?.[1];
  const links = Array.from(ul.querySelectorAll('a[href]')).filter(a=>a.getAttribute('href').includes('/status/'+status+'/photo/'));
  for (const source of links) {
    const tile = document.createElement('div');tile.dataset.testid='tweetPhoto';
    const a = document.createElement('a'); a.href = source.getAttribute('href');
    tile.appendChild(a);article.appendChild(tile);
  }
  // The synthetic native gallery supplies an explicit current/total counter.
  const index = href.includes('/photo/2') ? 2 : 1;
  const counter = document.createElement('span');counter.id='gallery-counter';
  counter.setAttribute('aria-label','Image '+index+' of '+(links.length || 1));
  viewer.appendChild(counter);
  modal.appendChild(article);
  const input = document.createElement('input');input.id='test-input';modal.appendChild(input);
  if (!modal.querySelector('#replies')) {
    const panel=document.createElement('section'); panel.id='replies';
    panel.textContent='Persistent X replies pane';modal.appendChild(panel);
  }
  if (!modal.isConnected) document.body.appendChild(modal);
}
ul.addEventListener('click', e => {
  const a=e.target.closest('a[href]'); if (!a) return;
  const href=a.getAttribute('href');e.preventDefault();
  if (window.testSpaIgnoreInModal && document.getElementById('modal')) return;
  clicked.push(href);show(href);
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
    const counter=document.getElementById('gallery-counter');
    if (counter) counter.setAttribute('aria-label','Image '+next+' of '+
      Array.from(ul.querySelectorAll('a[href]')).filter(a=>a.getAttribute('href').includes('/status/'+m[1]+'/photo/')).length);
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
  result('quoted and ambiguous grid links never generate extra media entries',
    firstTile.querySelector('.xmn-tile-badge')?.textContent==='1' &&
    !ambiguousTile.querySelector('.xmn-tile-badge'));
  const beforeClickPreload=window.prefetchLoads.length;
  source('/alice/status/11/photo/1').click();
  result('media tile click starts prefetch synchronously before X opens the viewer',
    window.prefetchLoads.length > beforeClickPreload);
  await wait(90);
  result('adjacent prefetch starts before 350ms debounce',window.prefetchLoads.length>0);
  await wait(530);
  const nativeRight=key('ArrowRight');
  await wait(500);
  result('gallery first image native ArrowRight',!nativeRight.defaultPrevented && nativeMoves===1 && location.pathname.endsWith('/11/photo/2'));
  result('adjacent CDN image preload initiated',window.prefetchLoads.length>0 && window.prefetchLoads[0].startsWith('https://pbs.twimg.com/media/') && window.prefetchLoads[0].includes('name=large'));
  const originalModal=document.getElementById('modal');
  const originalReplies=document.getElementById('replies');
  const beforeSpaCloses=window.nativeModalCloses;
  const boundaryRight=key('ArrowRight');
  await wait(850);
  result('last photo ArrowRight advances to next POST',boundaryRight.defaultPrevented && location.pathname.endsWith('/22/photo/1') && clicked.at(-1)==='/alice/status/22/photo/1');
  result('native in-modal SPA keeps dialog and right replies panel mounted',
    originalModal===document.getElementById('modal') &&
    originalReplies===document.getElementById('replies') &&
    window.nativeModalCloses===beforeSpaCloses &&
    !document.querySelector('.xmn-visual-handoff'));
  const boundaryLeft=key('ArrowLeft');
  await wait(850);
  result('first photo ArrowLeft returns to previous POST last image',boundaryLeft.defaultPrevented && location.pathname.endsWith('/11/photo/2') && clicked.at(-1)==='/alice/status/11/photo/2');
  const nativeLeft=key('ArrowLeft');
  await wait(500);
  result('gallery second image native ArrowLeft',!nativeLeft.defaultPrevented && nativeMoves===2 && location.pathname.endsWith('/11/photo/1'));
  const modified=key('ArrowRight',true);
  await wait(350);
  result('Shift+arrow not a shortcut',!modified.defaultPrevented && location.pathname.endsWith('/11/photo/1'));
  key('ArrowRight'); await wait(170);
  const beforeFallbackCloses=window.nativeModalCloses;
  window.testSpaIgnoreInModal=true;
  const fallback=key('ArrowRight'); await wait(950);
  window.testSpaIgnoreInModal=false;
  result('unhandled in-modal SPA attempt falls back through one safe close',
    fallback.defaultPrevented && location.pathname.endsWith('/22/photo/1') &&
    window.nativeModalCloses===beforeFallbackCloses+1);
  // A pre-decoded bridge is allowed to remain briefly while X loads the
  // final photo. Wait for the bounded 1.8s visible-window cleanup rather
  // than assuming every Chrome build paints within the first 950ms.
  for (let i=0;i<15 && document.querySelector('.xmn-visual-handoff');i++) {
    await wait(100);
  }
  result('fallback handoff never blackens or blocks the native UI',
    nonBlockingHandoff && noBlackBackdrop && hiddenUntilClose &&
    !document.querySelector('.xmn-visual-handoff'));
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
  const noCloseModal=document.getElementById('modal');
  const beforeNoClose=window.nativeModalCloses;
  key('ArrowRight');
  await wait(400);
  result('native in-modal SPA remains usable without a close control',
    location.pathname.endsWith('/33/photo/1') &&
    document.getElementById('modal')===noCloseModal &&
    window.nativeModalCloses===beforeNoClose);

  // A previously observed destination may be removed by X's virtualized grid.
  // Preflight must preserve the current viewer rather than closing and losing it.
  document.getElementById('modal')?.remove();
  history.replaceState({},'', '/alice/media');
  await wait(550);
  source('/alice/status/22/photo/1').click();
  await wait(580);
  source('/alice/status/33/photo/1').closest('li').remove();
  const vanishedKey=key('ArrowRight');
  await wait(350);
  result('evicted known destination keeps gallery open',
    vanishedKey.defaultPrevented && location.pathname.endsWith('/22/photo/1') &&
    !!document.getElementById('modal'));
  // X can switch only the media filter query while retaining the previous list DOM.
  document.getElementById('modal')?.remove();
  history.replaceState({},'', '/alice/media?filter=photo');
  await wait(570);
  result('new filter waits for visible list refresh',document.querySelectorAll('.xmn-tile-badge').length===0);
  ul.replaceChildren(tile('/alice/status/55/photo/1'));
  await wait(650);
  result('filter DOM replacement discards old list',
    document.querySelectorAll('.xmn-tile-badge').length===1 &&
    ul.firstElementChild.querySelector('.xmn-tile-badge')?.textContent==='1');

  // No fullscreen counter: the complete original tweetPhoto thumbnail grid
  // should still prove that photo/2 is the last photo in a two-image post.
  ul.appendChild(tile('/alice/status/55/photo/2'));
  ul.appendChild(tile('/alice/status/66/photo/1'));
  await wait(650);
  source('/alice/status/55/photo/2').click();
  await wait(650);
  document.getElementById('gallery-counter')?.remove();
  const setsize=document.createElement('div');
  setsize.setAttribute('aria-posinset','2');
  setsize.setAttribute('aria-setsize','2');
  document.querySelector('[data-testid="swipe-to-dismiss"]')?.appendChild(setsize);
  const withoutCounter=key('ArrowRight');
  await wait(900);
  result('ARIA gallery setsize permits one ArrowRight without a counter',
    withoutCounter.defaultPrevented &&
    location.pathname.endsWith('/66/photo/1') && clicked.at(-1)==='/alice/status/66/photo/1');

  // Without a counter, first let X process its own ArrowRight. If the
  // displayed CDN photo remains loaded and unchanged, cross with ONE press.
  document.querySelector('#modal button[aria-label="Close"]')?.click();
  await wait(450);
  ul.appendChild(tile('/alice/status/77/photo/1'));
  await wait(550);
  source('/alice/status/66/photo/1').click();
  await wait(600);
  document.getElementById('gallery-counter')?.remove();
  document.querySelectorAll('#modal [data-testid="tweetPhoto"]').forEach(n=>n.remove());
  const unknownFirst=key('ArrowRight');
  await wait(1600);
  result('unknown last photo auto-advances with one ArrowRight after native no-op',
    !unknownFirst.defaultPrevented &&
    location.pathname.endsWith('/77/photo/1') &&
    clicked.at(-1)==='/alice/status/77/photo/1');

  // Simulate X assigning a real CDN resource that finishes after the initial
  // 1050ms probe. ONE right key should navigate after readiness, with no
  // second keydown and no skipped/native unseen album photo.
  document.querySelector('#modal button[aria-label="Close"]')?.click();
  await wait(350);
  ul.appendChild(tile('/alice/status/88/photo/1'));
  await wait(350);
  source('/alice/status/77/photo/1').click();
  await wait(550);
  document.getElementById('gallery-counter')?.remove();
  document.querySelectorAll('#modal [data-testid="tweetPhoto"]').forEach(n=>n.remove());
  const delayedPhoto=document.querySelector('#modal img[alt="Current X media photo"]');
  let imageLoaded=false;
  Object.defineProperty(delayedPhoto,'complete',{configurable:true,get(){return imageLoaded;}});
  Object.defineProperty(delayedPhoto,'naturalWidth',{configurable:true,get(){return imageLoaded?1200:0;}});
  const delayedKey=key('ArrowRight');
  await wait(1150);
  const notSkippedWhileUnready=location.pathname.endsWith('/77/photo/1');
  imageLoaded=true;
  await wait(450);
  result('one arrow waits for slow current photo without a second keystroke',
    !delayedKey.defaultPrevented && notSkippedWhileUnready &&
    location.pathname.endsWith('/88/photo/1') &&
    clicked.at(-1)==='/alice/status/88/photo/1');
  document.body.setAttribute('data-xmn-results',records.map(r=>r.label+':'+(r.pass?'PASS':'FAIL')).join('|'));
}

</script><script src="/extension/content_script.js"></script>
<script>exercise().catch(e=>document.body.setAttribute('data-xmn-results','EXCEPTION:'+e.message));</script>
</body></html>`;

test('synthetic X inline JavaScript parses', () => {
  const inline = Array.from(fixture.matchAll(/<script>([\s\S]*?)<\/script>/g));
  for (const script of inline) assert.doesNotThrow(() => new vm.Script(script[1]));
});

function runChromium(url, userDataDir) {
  return new Promise((resolve, reject) => {
    const args = [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--disable-background-networking', '--no-first-run',
      '--user-data-dir=' + userDataDir, '--virtual-time-budget=27000', '--dump-dom', url,
    ];
    const child = spawn(browser, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    // GitHub-hosted Chrome startup can exceed the 20s wall clock even when the
    // 19s *virtual* fixture completes successfully. Allow runner overhead;
    // still fail on a genuinely stalled browser, rather than skipping tests.
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Chromium timed out after 45s')) }, 45000);
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
    } else if (req.url === '/extension/style.css') {
      res.writeHead(200, {'content-type':'text/css; charset=utf-8'});res.end(extensionCss);
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
    assert.equal(report.split('|').length, 23, report);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
