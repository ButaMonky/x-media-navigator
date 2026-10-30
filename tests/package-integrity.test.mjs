import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import vm from 'node:vm';

const root = fileURLToPath(new URL('..', import.meta.url));
const dev = resolve(root, 'extension');
const upstream = resolve(root, 'upstream/chrome-v1.3');
const get = (base, path) => readFileSync(resolve(base, path));

test('development manifest is a distinct, least-permission MV3 extension', () => {
  const m = JSON.parse(get(dev, 'manifest.json').toString('utf8'));
  assert.equal(m.manifest_version, 3);
  const packageVersion = JSON.parse(get(root, 'package.json').toString('utf8')).version;
  assert.equal(m.version, packageVersion.replace(/-dev\..*$/, ''));
  for (const key of ['key', 'update_url', 'host_permissions']) {
    assert.equal(Object.hasOwn(m, key), false, key);
  }
  assert.deepEqual(m.permissions,['storage']);
  assert.deepEqual(m.background,{service_worker:'background.js'});
  assert.match(m.name, /(?:TypeScript Dev|Private QA 2\.4\.21|Private QA 2\.4\.22|Private QA 2\.4\.23|History QA 2\.4\.24)/);
  assert.deepEqual(m.content_scripts[0].matches, ['https://x.com/*', 'https://twitter.com/*']);
});

test('handoff overlay reveals immediately after modal close instead of fading from a blank panel', () => {
  const css = get(dev, 'style.css').toString('utf8');
  const rule = css.match(/\.xmn-visual-handoff\s*\{([^}]+)\}/)?.[1] ?? '';
  assert.match(rule, /opacity:\s*0\s*;/,'handoff must stay hidden until safe to reveal');
  assert.match(rule, /transition:\s*none\s*;/,'fade-in after native modal close causes a blank flash');
});

test('persistent post-arrow portal is click-through except on its buttons', () => {
  const css = get(dev, 'style.css').toString('utf8');
  const portalRule = css.match(/\.xmn-controls-layer\s*\{([^}]+)\}/)?.[1] ?? '';
  assert.match(portalRule, /pointer-events:\s*none\s*!important\s*;/,
    'do not block native X media and reply-panel interactions');
  assert.match(css, /\.xmn-controls-layer\s+\.xmn-nav-button\s*\{\s*pointer-events:\s*auto\s*;/,
    'only post arrows receive pointer interaction');
});

test('manifest content scripts, CSS and referenced icons exist', () => {
  const m = JSON.parse(get(dev, 'manifest.json').toString('utf8'));
  for (const item of m.content_scripts ?? []) {
    for (const script of item.js ?? []) {
      assert.ok(existsSync(resolve(dev, script)), script);
      assert.doesNotThrow(() => new vm.Script(get(dev, script).toString('utf8')));
    }
    for (const css of item.css ?? []) assert.ok(existsSync(resolve(dev, css)), css);
  }
  assert.ok(existsSync(resolve(dev,m.background.service_worker)));
  assert.doesNotThrow(()=>new vm.Script(get(dev,m.background.service_worker).toString('utf8')));
  for (const filename of Object.values(m.icons)) assert.ok(existsSync(resolve(dev, filename)), filename);
});

test('reference snapshot matches its recorded LF-normalized SHA-256 on Windows and Linux', (t) => {
  if (!existsSync(resolve(upstream, 'content_script.js'))) {
    t.skip('Snapshot is retained in private GitHub repo, not scratch build'); return;
  }
  // Git can check out the same text as CRLF on Windows and LF on Linux.
  const canonical = get(upstream, 'content_script.js').toString('utf8').replace(/\r\n/g, '\n');
  const hash = createHash('sha256').update(canonical, 'utf8').digest('hex').toUpperCase();
  assert.equal(hash, 'BC67D0F31B7482B3FB06EB686E7CE944B4014746375696D8CDD9D915117190BE');
});

test('source-of-truth is TypeScript and no browser secret is embedded', () => {
  assert.ok(existsSync(resolve(root, 'src/core.ts')));
  assert.ok(existsSync(resolve(root, 'src/content.ts')));
  assert.ok(existsSync(resolve(root, 'src/session.ts')));
  assert.ok(existsSync(resolve(root, 'src/background.ts')));
  const manifest = get(dev, 'manifest.json').toString('utf8');
  assert.ok(!manifest.includes('chrome-extension://'));
  assert.ok(!manifest.includes('localStorage'));
});

test('progressive thumbnail overlay remains bounded and never reads cross-origin pixels', () => {
  const css = get(dev, 'style.css').toString('utf8');
  const rule=css.match(/\.xmn-visual-handoff\s+\.xmn-handoff-preview\s*\{([^}]+)\}/)?.[1]??'';
  assert.match(rule,/object-fit:\s*contain\s*;/,'do not stretch or crop a thumbnail');
  assert.match(rule,/pointer-events:\s*none\s*!important\s*;/,
    'the preview cannot intercept photo or reply-panel clicks');
  const source=get(root, 'src/content.ts').toString('utf8');
  const fn=source.split('private captureLowQualityThumbnail(')[1]
    ?.split('private promoteVisualHandoff()')[0] ?? '';
  assert.ok(fn.includes("getContext('2d'"));
  assert.doesNotMatch(fn,/\b(?:getImageData|toDataURL|toBlob|captureStream|fetch)\s*\(/,
    'never read/export a potentially tainted CDN image or fetch a new thumbnail');
  assert.match(fn,/256\s*\//,'canvas preview must be memory and size bounded');
});

test('private content script never scrolls the underlying X media tab or calls paid APIs', () => {
  const source = get(root, 'src/content.ts').toString('utf8');
  const compiled = get(dev, 'content_script.js').toString('utf8');
  for (const [label, body] of [['TypeScript',source],['Compiled JS',compiled]]) {
    assert.doesNotMatch(body,/\bscrollIntoView\s*\(|\bwindow\.scrollTo\s*\(/,
      label+' must not move the background feed when the next post is unknown');
    assert.doesNotMatch(body,/api\.x\.com\b|Authorization:\s*Bearer|graphql\/UserMedia/i,
      label+' must not call paid or undocumented X endpoints');
  }
  assert.match(source,/ここまでが読み込み済み/,
    'unknown destinations retain X viewer and show a clear boundary explanation');
});
