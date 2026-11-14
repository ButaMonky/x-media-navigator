import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
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
window.navEventsSeen=[];
// Headless fixture explicitly declines the third-party API. No remote calls or
// blocking browser confirmation should be required in native X regression QA.
window.nativeOnlyConfirmations=0;
window.confirm=()=>{window.nativeOnlyConfirmations++;return false;};
window.navApiAvailable=!!window.navigation && typeof window.navigation.addEventListener==='function';
if(window.navApiAvailable) {
  window.navigation.addEventListener('currententrychange', () => {
    window.navEventsSeen.push(location.pathname+location.search);
  });
}
window.prefetchLoads=[];
window.xmnDiagnostics=[];
const originalXmnInfo=console.info.bind(console);
console.info=(message,details)=>{
  if(typeof message==='string' && message.startsWith('[XMN '))
    window.xmnDiagnostics.push({message,details});
  originalXmnInfo(message,details);
};
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
window.testSlideTranslateX = 0;
window.nativeModalCloses = 0;
function show(href, withClose=true) {
  const existing = document.getElementById('modal');
  const retain = !!existing && window.testSpaKeepModal;
  if (retain) {
    existing.querySelectorAll('[data-testid="swipe-to-dismiss"]').forEach(node=>node.remove());
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
  if (window.testSlideTranslateX) viewer.style.transform =
    'translateX('+window.testSlideTranslateX+'px)';
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
window.nativeBackgroundScrolls=0;
window.scrollTo = () => {
  window.nativeBackgroundScrolls++;
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
  // Real DOM case: X recycles the same thumbnail <img> for a new tile while
  // currentSrc still points to the old pixels. Do not initiate CDN traffic.
  const reusableTile=document.createElement('li');
  const reusableLink=document.createElement('a');
  reusableLink.href='/alice/status/445/photo/1';
  const reusablePhoto=document.createElement('img');
  reusablePhoto.setAttribute('src','data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=');
  reusableLink.appendChild(reusablePhoto);reusableTile.appendChild(reusableLink);
  Object.defineProperty(reusablePhoto,'currentSrc',{configurable:true,
    value:'https://pbs.twimg.com/media/OLD445?format=jpg&name=small'});
  Object.defineProperty(reusablePhoto,'src',{configurable:true,
    value:'https://pbs.twimg.com/media/NEW445?name=small&format=jpg'});
  Object.defineProperty(reusablePhoto,'complete',{configurable:true,value:false});
  Object.defineProperty(reusablePhoto,'naturalWidth',{configurable:true,value:0});
  const sourceCtrl=Object.create(window.XMN.Controller.prototype);
  sourceCtrl.imageSources=new Map();sourceCtrl.imageSourcesRevision=0;
  const reusableRef=window.XMN.mediaRefFromHref(
    reusableLink.getAttribute('href'),'alice');
  sourceCtrl.recordTileImageSource(reusableTile,{link:reusableLink,ref:reusableRef});
  result('recycled native image element selects new assigned CDN photo, not prior pixels',
    sourceCtrl.imageSources.get(reusableRef.key)===
    'https://pbs.twimg.com/media/NEW445?format=jpg&name=large');
  const beforeClickPreload=window.prefetchLoads.length;
  source('/alice/status/11/photo/1').click();
  result('media tile click starts prefetch synchronously before X opens the viewer',
    window.prefetchLoads.length > beforeClickPreload);
  await wait(90);
  result('adjacent prefetch starts before 350ms debounce',window.prefetchLoads.length>0);
  await wait(530);
  // Real Chromium visibility event wiring: cancel optional background
  // photo work without removing existing SPA controls, then resume once.
  const layerBeforeVisibility=document.querySelector('.xmn-controls-layer');
  let simulatedHidden=true;
  Object.defineProperty(document,'hidden',{configurable:true,get(){return simulatedHidden;}});
  document.dispatchEvent(new Event('visibilitychange'));
  const startCount=window.prefetchLoads.length;
  await wait(160);
  result('hidden document stops new optional requests without removing arrows',
    window.prefetchLoads.length===startCount &&
    document.querySelector('.xmn-controls-layer')===layerBeforeVisibility);
  simulatedHidden=false;
  document.dispatchEvent(new Event('visibilitychange'));
  await wait(100);
  delete document.hidden;
  result('returning to visible keeps the active photo controls',
    document.querySelector('.xmn-controls-layer')===layerBeforeVisibility &&
    document.querySelectorAll('.xmn-controls-layer .xmn-nav-button').length===2);
  // Progressively use an existing decoded X thumbnail (no extra CDN fetch),
  // then switch that same overlay to an already decoded full image.
  const targetPreviewRef=window.XMN.mediaRefFromHref('/alice/status/22/photo/1','alice');
  const targetPreviewLink=source('/alice/status/22/photo/1');
  const targetPreviewSrc=targetPreviewLink.querySelector('img').currentSrc;
  const targetPreviewUrl=window.XMN.preloadImageUrl(targetPreviewSrc);
  const previewCtrl=Object.create(window.XMN.Controller.prototype);
  previewCtrl.originProfile='alice';
  previewCtrl.viewer=document.querySelector('#modal [data-testid="swipe-to-dismiss"]');
  previewCtrl.navGeneration=99;
  previewCtrl.handoff=null;
  previewCtrl.imageSources=new Map([[targetPreviewRef.key,targetPreviewUrl]]);
  previewCtrl.prefetched=new Map();
  // The test represents an ALREADY decoded prefetched photo. Decode it
  // before the handoff timer starts so CI load cannot expire the 1.8s
  // overlay while this fixture is preparing the synthetic decoded resource.
  const decodedHigh=document.createElement('img');
  decodedHigh.src='data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
  await decodedHigh.decode();
  const beforePreviewRequests=window.prefetchLoads.length;
  const beforePreviewTargetRequests=window.prefetchLoads.filter(
    url=>url===targetPreviewUrl).length;
  const previewCreated=previewCtrl.beginVisualHandoff(targetPreviewRef,targetPreviewLink);
  const previewHost=previewCtrl.handoff?.host;
  const previewCanvas=previewHost?.querySelector('canvas.xmn-handoff-preview');
  await wait(0); // Let MutationObserver confirm the prepared overlay is still hidden.
  if(previewCreated)previewCtrl.showVisualHandoff();
  const lowActuallyVisible=previewCtrl.handoff?.shown===true &&
    previewHost.classList.contains('xmn-handoff-visible') &&
    getComputedStyle(previewHost).opacity==='1' &&
    window.xmnDiagnostics.some(e=>e.message.includes('preview.visible') &&
      e.details?.quality==='low');
  result('thumbnail-first canvas snapshot uses existing X tile and no new CDN request',
    previewCreated && !!previewCanvas && previewCanvas.width<=256 && previewCanvas.height<=256 &&
    lowActuallyVisible && previewCtrl.handoff.quality==='low' &&
    window.prefetchLoads.length===beforePreviewRequests &&
    getComputedStyle(previewHost).pointerEvents==='none');
  previewCtrl.prefetched.set(targetPreviewUrl,{image:decodedHigh,ready:true,loading:false,bytes:4});
  const promoted=previewCtrl.promoteVisualHandoff();
  result('same handoff upgrades from thumbnail to full image without refetch',
    promoted && previewCtrl.handoff.quality==='high' &&
    previewHost.firstElementChild===decodedHigh &&
    // Unrelated X background prefetch may legitimately begin during a
    // handoff; only a duplicate request for THIS target would be a failure.
    window.prefetchLoads.filter(url=>url===targetPreviewUrl).length===
      beforePreviewTargetRequests);
  previewCtrl.clearVisualHandoff();
  result('progressive preview releases DOM and does not intercept input',
    !document.querySelector('.xmn-visual-handoff') && previewCtrl.handoff===null);

  const nativeRight=key('ArrowRight');
  await wait(500);
  result('gallery first image native ArrowRight',!nativeRight.defaultPrevented && nativeMoves===1 && location.pathname.endsWith('/11/photo/2'));
  await wait(0);
  result('Navigation API sees a native same-document photo route commit when available',
    !window.navApiAvailable ||
    window.navEventsSeen.some(path=>path.endsWith('/11/photo/2')));
  // React may discard extension-owned descendants on a native photo rerender.
  // Post navigation controls must instead belong to a separate durable layer.
  const galleryViewer=document.querySelector('#modal [data-testid="swipe-to-dismiss"]');
  galleryViewer.querySelectorAll('.xmn-nav-button').forEach(el=>el.remove());
  const controlLayer=document.querySelector('.xmn-controls-layer');
  const durableButtons=controlLayer && [...controlLayer.querySelectorAll('.xmn-nav-button')];
  result('both post arrows persist after X rerenders photo 2',
    durableButtons?.length===2 &&
    durableButtons.every(el=>el.isConnected && getComputedStyle(el).pointerEvents!=='none') &&
    !galleryViewer.contains(controlLayer) &&
    getComputedStyle(controlLayer).pointerEvents==='none');
  const beforeWidth=controlLayer?.getBoundingClientRect().width||0;
  galleryViewer.style.width='55vw';
  window.dispatchEvent(new Event('resize'));
  const afterWidth=controlLayer?.getBoundingClientRect().width||0;
  result('window resize reanchors the post arrow layer to the photo pane',
    beforeWidth>afterWidth && afterWidth>150);
  galleryViewer.style.width='65vw';
  window.dispatchEvent(new Event('resize'));
  result('adjacent CDN image preload initiated',window.prefetchLoads.length>0 && window.prefetchLoads[0].startsWith('https://pbs.twimg.com/media/') && window.prefetchLoads[0].includes('name=large'));
  const originalModal=document.getElementById('modal');
  const originalReplies=document.getElementById('replies');
  const beforeSpaCloses=window.nativeModalCloses;
  const arrowAnchorBefore=controlLayer?.getBoundingClientRect();
  // X may animate a newly mounted swipe viewer sideways during SPA routing.
  // Buttons should NOT inherit that transient motion on every POST change.
  window.testSlideTranslateX=34;
  const boundaryRight=key('ArrowRight');
  await wait(850);
  result('last photo ArrowRight advances to next POST',boundaryRight.defaultPrevented && location.pathname.endsWith('/22/photo/1') && clicked.at(-1)==='/alice/status/22/photo/1');
  const afterRight=controlLayer?.getBoundingClientRect();
  result('animated next-POST viewer cannot shift the portaled arrow pane',
    document.querySelector('.xmn-controls-layer') === controlLayer &&
    arrowAnchorBefore && afterRight &&
    Math.abs(arrowAnchorBefore.left-afterRight.left)<1 &&
    Math.abs(arrowAnchorBefore.top-afterRight.top)<1 &&
    Math.abs(arrowAnchorBefore.width-afterRight.width)<1);
  result('native in-modal SPA keeps dialog and right replies panel mounted',
    originalModal===document.getElementById('modal') &&
    originalReplies===document.getElementById('replies') &&
    window.nativeModalCloses===beforeSpaCloses &&
    !document.querySelector('.xmn-visual-handoff'));
  window.testSlideTranslateX=-26;
  const boundaryLeft=key('ArrowLeft');
  await wait(850);
  result('first photo ArrowLeft returns to previous POST last image',boundaryLeft.defaultPrevented && location.pathname.endsWith('/11/photo/2') && clicked.at(-1)==='/alice/status/11/photo/2');
  const afterLeft=controlLayer?.getBoundingClientRect();
  result('animated previous-POST viewer does not cumulatively shift the arrows',
    document.querySelector('.xmn-controls-layer') === controlLayer &&
    arrowAnchorBefore && afterLeft &&
    Math.abs(arrowAnchorBefore.left-afterLeft.left)<1 &&
    Math.abs(arrowAnchorBefore.top-afterLeft.top)<1 &&
    Math.abs(arrowAnchorBefore.width-afterLeft.width)<1);
  window.testSlideTranslateX=0;
  document.querySelector('#modal [data-testid="swipe-to-dismiss"]')?.style.removeProperty('transform');
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
  const retainedDialog=document.getElementById('modal');
  const retainedReplies=document.getElementById('replies');
  const scrollCount=window.nativeBackgroundScrolls;
  const terminalKey1=key('ArrowRight');
  await wait(480);
  result('unknown next POST stays in modal and never scrolls the hidden X timeline',
    terminalKey1.defaultPrevented &&
    window.nativeOnlyConfirmations===0 &&
    location.pathname.endsWith('/22/photo/1') &&
    !source('/alice/status/33/photo/1') &&
    window.nativeBackgroundScrolls===scrollCount &&
    document.getElementById('modal')===retainedDialog &&
    document.getElementById('replies')===retainedReplies);
  // Only the user's EXPLICIT list scroll loads the new post.
  document.querySelector('#modal button[aria-label="Close"]')?.click();
  await wait(250);
  window.scrollTo({top:9000,behavior:'auto'});
  await wait(650);
  source('/alice/status/22/photo/1').click();
  await wait(550);
  const userLoadedRight=key('ArrowRight');
  await wait(850);
  result('user-loaded next POST advances through observed native SPA link',
    userLoadedRight.defaultPrevented &&
    location.pathname.endsWith('/33/photo/1') &&
    clicked.at(-1)==='/alice/status/33/photo/1');
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

  // X sometimes leaves photo/1's carousel pane in the DOM but hides it,
  // then mounts photo/2 in a second pane under the same modal.
  document.querySelector('#modal button[aria-label="Close"]')?.click();
  ul.appendChild(tile('/alice/status/11/photo/1'));
  ul.appendChild(tile('/alice/status/11/photo/2'));
  ul.appendChild(tile('/alice/status/22/photo/1'));
  await wait(650);
  source('/alice/status/11/photo/1').click();
  await wait(500);
  key('ArrowRight'); await wait(300);
  const firstSlide=document.querySelector('#modal [data-testid="swipe-to-dismiss"]');
  const layerBeforeSwap=document.querySelector('.xmn-controls-layer');
  firstSlide.setAttribute('aria-hidden','true');
  const visibleSecond=firstSlide.cloneNode(true);
  visibleSecond.removeAttribute('aria-hidden');
  // Real X carousel slides occupy the SAME media pane. A normal-flow
  // sibling would be below the viewport and must correctly remain hidden.
  const oldBounds=firstSlide.getBoundingClientRect();
  visibleSecond.style.position='fixed';
  visibleSecond.style.left=oldBounds.left+'px';
  visibleSecond.style.top=oldBounds.top+'px';
  visibleSecond.style.width=oldBounds.width+'px';
  visibleSecond.style.height=oldBounds.height+'px';
  firstSlide.after(visibleSecond);
  await wait(600);
  const afterLayer=document.querySelector('.xmn-controls-layer');
  const selectedViewer=window.XMN.Controller.prototype.findActiveViewer.call({});
  const layerVisible=afterLayer && getComputedStyle(afterLayer).display!=='none';
  result('hidden photo 1 and visible photo 2 keep the same portaled post arrows',
    afterLayer===layerBeforeSwap && selectedViewer===visibleSecond &&
    document.querySelectorAll('.xmn-controls-layer .xmn-nav-button').length===2 &&
    layerVisible);
  const forwardPostButton=layerBeforeSwap?.querySelector('.xmn-next');
  forwardPostButton?.click();
  await wait(700);
  result('post arrow clicked on photo 2 opens adjacent post with native SPA',
    location.pathname.endsWith('/22/photo/1') &&
    clicked.at(-1)==='/alice/status/22/photo/1');
  document.querySelector('#modal button[aria-label="Close"]')?.click();
  await wait(400);
  result('modal close removes portaled post controls without stale click targets',
    !document.querySelector('.xmn-controls-layer') &&
    !document.querySelector('.xmn-nav-button'));

  // Reaching the last loaded post must not close X, scroll the underlying
  // media feed or launch an invented URL. The user may choose to load more.
  const terminalHref='/alice/status/9999/photo/1';
  const terminalTile=tile(terminalHref);
  terminalTile.scrollIntoView=()=>{window.terminalBackgroundScrolls++;};
  window.terminalBackgroundScrolls=0;
  ul.appendChild(terminalTile);
  await wait(650);
  const terminalIndexed=!!terminalTile.querySelector('.xmn-tile-badge');
  source(terminalHref).click();
  await wait(520);
  const terminalDialog=document.getElementById('modal');
  const terminalReplies=document.getElementById('replies');
  const terminalCloses=window.nativeModalCloses;
  const terminalBefore=location.pathname;
  const oldWindowScroll=window.scrollTo;
  window.scrollTo=()=>{window.terminalBackgroundScrolls++;};
  const terminalKey=key('ArrowRight');
  await wait(420);
  window.scrollTo=oldWindowScroll;
  result('unknown next post never scrolls the background or guesses an URL',
    terminalIndexed && terminalKey.defaultPrevented &&
    window.terminalBackgroundScrolls===0 &&
    location.pathname===terminalBefore);
  result('unknown next post retains the exact modal and right replies pane',
    terminalDialog===document.getElementById('modal') &&
    terminalReplies===document.getElementById('replies') &&
    window.nativeModalCloses===terminalCloses &&
    !!document.querySelector('.xmn-toast'));

  document.body.setAttribute('data-xmn-results',records.map(r=>r.label+':'+(r.pass?'PASS':'FAIL')).join('|'));
}

</script><script src="/extension/content_script.js"></script>
<script>exercise().catch(e=>document.body.setAttribute('data-xmn-results','EXCEPTION:'+e.message+'@'+String(e.stack).split('\\n').slice(0,6).join('~')));</script>
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
      // The fixture contains ~28s of explicit waits; Linux CI needs generous
      // virtual-time headroom for image decode and navigation task queues.
      '--user-data-dir=' + userDataDir, '--virtual-time-budget=65000', '--dump-dom', url,
    ];
    const child = spawn(browser, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    // GitHub-hosted Chrome can take extra wall time even after the fixture's
    // ~28s virtual waits complete. Allow browser startup and runner overhead;
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

/** Deterministic REAL-time CDP wait; virtual-time --dump-dom may exit before
 * a long asynchronous gallery scenario has written its result marker on Linux.
 * Keep all 40 assertions and the mandatory browser quality gate unchanged.
 */
async function runChromiumUntilResult(url,userDataDir) {
  const nap=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const args=['--headless=new','--no-sandbox','--disable-gpu',
    '--disable-dev-shm-usage','--disable-background-networking',
    '--no-first-run','--no-default-browser-check',
    '--remote-allow-origins=*','--remote-debugging-port=0',
    '--user-data-dir='+userDataDir,url];
  const child=spawn(browser,args,{stdio:['ignore','ignore','pipe'],
    windowsHide:true,detached:process.platform!=='win32'});
  let stderr='', launchError=null, socket=null;
  child.stderr.on('data',data=>{
    stderr+=String(data);
    if(stderr.length>3000)stderr=stderr.slice(-3000);
  });
  child.on('error',error=>{launchError=error});
  try {
    const portFile=join(userDataDir,'DevToolsActivePort');
    let port=null;
    for(let i=0;i<450;i++){
      if(launchError)throw launchError;
      if(existsSync(portFile)){
        port=Number(readFileSync(portFile,'utf8').split(/\r?\n/)[0]);
        if(Number.isInteger(port)&&port>0)break;
      }
      await nap(100);
    }
    if(!port)throw Error('DevTools port missing '+stderr.slice(-500));
    let page=null;
    for(let i=0;i<200;i++){
      try{
        const targets=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
        page=targets.find(item=>item.type==='page'&&item.url.startsWith(new URL(url).origin+'/'));
        if(page)break;
      }catch{}
      await nap(100);
    }
    if(!page)throw Error('Chrome page target missing '+stderr.slice(-500));
    socket=new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('CDP socket timeout')),12000);
      socket.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});
      socket.addEventListener('error',()=>{clearTimeout(timer);reject(Error('CDP socket failure'))},{once:true});
    });
    const pending=new Map();
    let sequence=0;
    socket.addEventListener('message',event=>{
      let reply;
      try{reply=JSON.parse(String(event.data))}catch{return}
      const state=pending.get(reply.id);
      if(!state)return;
      clearTimeout(state.timer);
      pending.delete(reply.id);
      if(reply.error)state.reject(Error(JSON.stringify(reply.error)));
      else state.resolve(reply.result);
    });
    const command=(method,params={})=>new Promise((resolve,reject)=>{
      const id=++sequence;
      const timer=setTimeout(()=>{
        pending.delete(id);
        reject(Error('CDP '+method+' timed out'));
      },15000);
      pending.set(id,{resolve,reject,timer});
      socket.send(JSON.stringify({id,method,params}));
    });
    await command('Runtime.enable');
    let latest='';
    for(let i=0;i<480;i++){
      const reply=await command('Runtime.evaluate',{
        expression:"document.body?.getAttribute('data-xmn-results')||''",
        returnByValue:true
      });
      latest=reply?.result?.value??'';
      if(latest)return latest;
      await nap(250);
    }
    throw Error('Browser never finished synthetic gallery after 120s; '+stderr.slice(-500));
  }finally{
    if(socket)try{socket.close()}catch{}
    if(child.pid){
      if(process.platform==='win32'){
        try{execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],
          {stdio:'ignore',timeout:10000})}catch{child.kill('SIGKILL')}
      }else{
        try{process.kill(-child.pid,'SIGKILL')}catch{child.kill('SIGKILL')}
      }
    }
    await nap(500);
  }
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
    const report = await runChromiumUntilResult(`http://127.0.0.1:${port}/alice/media`, dir);
    assert.ok(!report.includes('FAIL') && !report.includes('EXCEPTION'), report);
    assert.equal(report.split('|').length, 40, report);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
});

test('Chromium displays a tainted cross-origin canvas without a second image request', {
  skip: process.env.XMN_RUN_CHROMIUM !== '1' ? 'Requires Chromium' :
    !existsSync(browser) ? 'Chromium not installed' : false,
}, async () => {
  let imageRequests=0;
  const pixel = Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64');
  const imageServer=createServer((req,res)=>{
    if(req.url==='/thumb.gif'){
      imageRequests++;
      res.writeHead(200,{'content-type':'image/gif','cache-control':'public, max-age=600'});
      res.end(pixel);
    }else{res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>imageServer.listen(0,'127.0.0.1',resolve));
  const imageUrl='http://127.0.0.1:'+imageServer.address().port+'/thumb.gif';
  const pageServer=createServer((req,res)=>{
    res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
    res.end(`<!doctype html><html><body>
<script>
const image = document.createElement('img');
image.onload=()=>{
  const canvas=document.createElement('canvas');
  canvas.width=1;canvas.height=1;
  const ctx=canvas.getContext('2d');
  ctx.drawImage(image,0,0,1,1);
  document.body.appendChild(canvas);
  let readBlocked=false;
  try{ctx.getImageData(0,0,1,1);}catch(e){readBlocked=e.name==='SecurityError';}
  document.body.dataset.canvasProof=(readBlocked && canvas.isConnected)?'passed':'failed';
};
image.onerror=()=>document.body.dataset.canvasProof='load-error';
image.src=${JSON.stringify(imageUrl)};
</script></body></html>`);
  });
  await new Promise(resolve=>pageServer.listen(0,'127.0.0.1',resolve));
  const dir=mkdtempSync(join(tmpdir(),'xmn-tainted-canvas-'));
  try {
    const output=await runChromium(
      'http://127.0.0.1:'+pageServer.address().port+'/test',dir);
    assert.match(output,/data-canvas-proof="passed"/,
      'a cross-origin tainted canvas may be displayed but its pixels cannot be read');
    assert.equal(imageRequests,1,
      'drawImage of an already downloaded thumbnail does not issue another request');
  }finally{
    await new Promise(resolve=>pageServer.close(resolve));
    await new Promise(resolve=>imageServer.close(resolve));
    rmSync(dir,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  }
});

test('native-only document navigation ignores old API session without losing replies', {
  skip: process.env.XMN_RUN_CHROMIUM !== '1' ? 'Requires Chromium' :
    !existsSync(browser) ? 'Chromium not installed' : false,
}, async () => {
  const server=createServer((req,res)=>{
    res.setHeader('content-type', req.url==='/extension/content_script.js' ?
      'text/javascript; charset=utf-8':'text/html; charset=utf-8');
    if(req.url==='/extension/content_script.js') return res.end(contentScript);
    if(req.url==='/alice/media') return res.end(`<!doctype html><html><body>
<script>
sessionStorage.setItem('xmn-public-media-v1',JSON.stringify({
  profile:'alice',timeline:'alice|photo',expires:Date.now()+60000,
  refs:['/alice/status/200/photo/1','/alice/status/100/photo/1'],
  apiKeys:['100:photo:1'],photos:[],photoTotals:[['100',1]],
  cursor:null,anchorFound:true,exhausted:true
}));
location.assign('/alice/status/100/photo/1');
</script></body></html>`);

    res.end(`<!doctype html><html><body>
<div role="dialog"><div data-testid="swipe-to-dismiss"
 style="position:relative;width:700px;height:430px">
 <img alt="loaded public photo" width="600" height="400"
 src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=">
</div><aside id="replies">Unchanged replies</aside></div>
<script>
// Test-only trusted-worker stand-in: page storage never used by production code.
window.chrome=window.chrome||{};
window.chrome.runtime=window.chrome.runtime||{};
window.__xmnSessionFixture=JSON.parse(sessionStorage.getItem('xmn-public-media-v1'));
window.workerReadCalls=0;
window.chrome.runtime.sendMessage=async request=>{
 if(request.kind==='xmn-store-v1' && request.op==='session.get'){
   window.workerReadCalls++;
   return {ok:true,session:window.__xmnSessionFixture};
 }
 return {ok:false};
};
</script>
<script src="/extension/content_script.js"></script>
<script>
setTimeout(()=>{
 const label=document.querySelector('.xmn-status')?.textContent;
 const prev=document.querySelector('.xmn-prev');
 const next=document.querySelector('.xmn-next');
 document.documentElement.dataset.xmnRestoreProof=
   !label && !prev && !next && window.workerReadCalls===0 &&
   document.getElementById('replies') ? 'passed':'failed:unexpected-external-restore';
},1250);
</script></body></html>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));

  const dir=mkdtempSync(join(tmpdir(),'xmn-public-session-'));
  try {
    const output=await runChromium(
      'http://127.0.0.1:'+server.address().port+'/alice/media',dir);
    assert.match(output,/data-xmn-restore-proof="passed"/,
      'Native-only mode must not rehydrate old provider indices or request its Worker session');
    assert.match(output, /Unchanged replies/,
      'The mocked replies panel must not be discarded by the extension');
  } finally {
    await new Promise(resolve=>server.close(resolve));
    rmSync(dir,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  }
});

test('modern X media cells and dialog photo work without legacy listitem or swipe selector', {
  skip: process.env.XMN_RUN_CHROMIUM !== '1' ? 'Requires Chromium' :
    !existsSync(browser) ? 'Chromium not installed' : false,
}, async () => {
  const modernFixture = [
    '<!doctype html><html lang="ja"><head><meta charset="utf-8">',
    '<link rel="stylesheet" href="/extension/style.css"></head><body>',
    '<main><div data-testid="primaryColumn"><div id="grid">',
    '<div data-testid="cellInnerDiv"><a href="/alice/status/50/photo/1"><img src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="></a></div>',
    '<div data-testid="cellInnerDiv"><a href="/alice/status/40/photo/1"><img src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="></a></div>',
    '</div></div></main>',
    '<script>',
    'document.querySelector("#grid").addEventListener("click",event=>{',
    'const link=event.target.closest("a[href]");if(!link)return;',
    'event.preventDefault();history.pushState({}, "", link.getAttribute("href"));',
    'const dialog=document.createElement("div");dialog.setAttribute("role","dialog");',
    'dialog.innerHTML="<div data-testid=\\"tweetPhoto\\" style=\\"width:60vw;height:75vh\\">"+',
    '"<img src=\\"data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=\\" style=\\"width:100%;height:100%\\"></div>";',
    'document.body.appendChild(dialog);});',
    '</script><script src="/extension/content_script.js"></script><script>',
    'setTimeout(()=>{',
    'const badges=document.querySelectorAll("#grid .xmn-tile-badge").length;',
    'document.querySelector("#grid a[href]").click();',
    'setTimeout(()=>{',
    'const controls=document.querySelectorAll(".xmn-controls-layer .xmn-nav-button").length;',
    'const status=document.querySelector(".xmn-status")?.textContent||"";',
    'document.body.setAttribute("data-xmn-results",',
    'badges===2&&controls===2&&status.includes("1 / 2")?"PASS":"FAIL-"+badges+"-"+controls+"-"+status);',
    '},900);},900);',
    '</script></body></html>'
  ].join('');
  const server=createServer((req,res)=>{
    if(req.url==='/extension/content_script.js'){
      res.writeHead(200,{'content-type':'application/javascript'});res.end(contentScript);
    }else if(req.url==='/extension/style.css'){
      res.writeHead(200,{'content-type':'text/css'});res.end(extensionCss);
    }else{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(modernFixture);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const dir=mkdtempSync(join(tmpdir(),'xmn-modern-dom-'));
  try{
    const report=await runChromiumUntilResult('http://127.0.0.1:'+server.address().port+'/alice/media',dir);
    assert.equal(report,'PASS','modern X UI recognition: '+report);
  }finally{
    await new Promise(resolve=>server.close(resolve));
    rmSync(dir,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  }
});
