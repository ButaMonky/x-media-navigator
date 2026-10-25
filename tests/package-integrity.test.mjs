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
  assert.equal(m.version, '2.0.0');
  for (const key of ['key', 'update_url', 'host_permissions', 'permissions', 'background']) {
    assert.equal(Object.hasOwn(m, key), false, key);
  }
  assert.match(m.name, /TypeScript Dev/);
  assert.deepEqual(m.content_scripts[0].matches, ['https://x.com/*', 'https://twitter.com/*']);
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

test('reference source script matches the original Chrome 1.3 snapshot', (t) => {
  if (!existsSync(resolve(upstream, 'content_script.js'))) { t.skip('Snapshot is retained in private GitHub repo, not scratch build'); return; }
  const hash = createHash('sha256').update(get(upstream, 'content_script.js')).digest('hex').toUpperCase();
  assert.equal(hash, 'B3185DC554E2B981C65970192D750AC82ADAE5BAC0A043E2084D4BB85D153CB0');
});

test('source-of-truth is TypeScript and no browser secret is embedded', () => {
  assert.ok(existsSync(resolve(root, 'src/core.ts')));
  assert.ok(existsSync(resolve(root, 'src/content.ts')));
  const manifest = get(dev, 'manifest.json').toString('utf8');
  assert.ok(!manifest.includes('chrome-extension://'));
  assert.ok(!manifest.includes('localStorage'));
});
