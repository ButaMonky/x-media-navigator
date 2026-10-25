/**
 * Private beta packaging gate: only audited, runnable Chrome files may be uploaded.
 * This script runs after TypeScript build, tests, and Chromium smoke tests.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'extension';
const allowed = [
  'content_script.js',
  'icon128.png',
  'icon16.png',
  'icon48.png',
  'manifest.json',
  'style.css',
];
const listed = readdirSync(dir).sort();
assert.deepEqual(listed, allowed, 'Unexpected extension file; packaging refused');

for (const filename of allowed) {
  assert.ok(statSync(join(dir, filename)).isFile(), filename);
  assert.ok(statSync(join(dir, filename)).size > 0, filename + ' is empty');
}
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, pkg.version.replace(/-dev\..*$/, ''));
assert.equal(manifest.name, 'X Media Navigator (TypeScript Dev)');
for (const field of [
  'key', 'update_url', 'host_permissions', 'permissions', 'background',
  'externally_connectable', 'web_accessible_resources',
]) {
  assert.equal(Object.hasOwn(manifest, field), false, field);
}
assert.equal(manifest.content_scripts?.length, 1);
assert.deepEqual(manifest.content_scripts[0].js, ['content_script.js']);
assert.deepEqual(manifest.content_scripts[0].css, ['style.css']);
assert.deepEqual(
  manifest.content_scripts[0].matches,
  ['https://x.com/*', 'https://twitter.com/*'],
);
assert.deepEqual(Object.values(manifest.icons).sort(), [
  'icon128.png', 'icon16.png', 'icon48.png',
].sort());
console.log('Verified Chrome beta v' + manifest.version + ': six files, no extra permissions or store identity.');
