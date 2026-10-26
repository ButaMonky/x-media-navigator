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
  for (const key of ['key', 'update_url', 'host_permissions', 'permissions', 'background']) {
    assert.equal(Object.hasOwn(m, key), false, key);
  }
  assert.match(m.name, /TypeScript Dev/);
  assert.deepEqual(m.content_scripts[0].matches, ['https://x.com/*', 'https://twitter.com/*']);
});

test('handoff overlay reveals immediately after modal close instead of fading from a blank panel', () => {
  const css = get(dev, 'style.css').toString('utf8');
  const rule = css.match(/\.xmn-visual-handoff\s*\{([^}]+)\}/)?.[1] ?? '';
  assert.match(rule, /opacity:\s*0\s*;/,'handoff must stay hidden until safe to reveal');
  assert.match(rule, /transition:\s*none\s*;/,'fade-in after native modal close causes a blank flash');
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
  const manifest = get(dev, 'manifest.json').toString('utf8');
  assert.ok(!manifest.includes('chrome-extension://'));
  assert.ok(!manifest.includes('localStorage'));
});
