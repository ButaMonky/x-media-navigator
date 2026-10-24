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

test('development manifest does not reuse Chrome Store identity/update endpoint', () => {
  const m = JSON.parse(get(dev, 'manifest.json').toString('utf8'));
  assert.equal(m.manifest_version, 3);
  assert.equal(m.version, '1.3');
  assert.equal(Object.hasOwn(m, 'key'), false);
  assert.equal(Object.hasOwn(m, 'update_url'), false);
  assert.match(m.name, /Development/);
});

test('manifest content scripts and CSS exist and parse', () => {
  const m = JSON.parse(get(dev, 'manifest.json').toString('utf8'));
  for (const item of m.content_scripts ?? []) {
    for (const script of item.js ?? []) {
      assert.ok(existsSync(resolve(dev, script)), script);
      assert.doesNotThrow(() => new vm.Script(get(dev, script).toString('utf8')));
    }
    for (const css of item.css ?? []) assert.ok(existsSync(resolve(dev, css)), css);
  }
});

test('reference content script matches recorded original SHA-256', () => {
  const hash = createHash('sha256').update(get(upstream, 'content_script.js')).digest('hex').toUpperCase();
  assert.equal(hash, 'B3185DC554E2B981C65970192D750AC82ADAE5BAC0A043E2084D4BB85D153CB0');
});
