import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./.build/core.js', import.meta.url), 'utf8');
const context = vm.createContext({ URL, Set });
vm.runInContext(source, context, { filename: 'core.js' });
const { XMN } = context;

test('only a valid profile media route activates the extension', () => {
  assert.equal(XMN.mediaProfileFromPath('/Alice/media'), 'alice');
  assert.equal(XMN.mediaProfileFromPath('/alice/media/'), 'alice');
  for (const path of ['/alice/status/123', '/home', '/alice/likes', '/alice/media/abc', '/abcdefghijklmnop/media']) {
    assert.equal(XMN.mediaProfileFromPath(path), null, path);
  }
});

test('status route must belong to the originating user', () => {
  assert.equal(XMN.profileStatusFromPath('/ALICE/status/123/photo/1', 'alice'), true);
  assert.equal(XMN.profileStatusFromPath('/other/status/123/photo/1', 'alice'), false);
  assert.equal(XMN.profileStatusFromPath('/alice/media', 'alice'), false);
});

test('media identity distinguishes images of the same post', () => {
  const one = XMN.mediaRefFromHref('/Alice/status/234/photo/1?tracking=abc', 'alice');
  const two = XMN.mediaRefFromHref('/alice/status/234/photo/2', 'alice');
  const movie = XMN.mediaRefFromHref('/alice/status/234/video/1', 'alice');
  assert.equal(one.statusId, '234');
  assert.equal(one.mediaIndex, 1);
  assert.equal(one.href, '/Alice/status/234/photo/1');
  assert.notEqual(one.key, two.key);
  assert.notEqual(one.key, movie.key);
});

test('media links cannot escape the active profile or x.com/twitter.com', () => {
  for (const href of [
    'https://example.org/alice/status/234/photo/1',
    '//malware.example/alice/status/234/photo/1',
    'javascript:alert(1)',
    '/bob/status/234/photo/1',
    '/alice/status/not-number/photo/1',
    '/alice/status/234/photo/0',
    '/alice/status/234/photo/999',
  ]) {
    assert.equal(XMN.mediaRefFromHref(href, 'alice'), null, href);
  }
  assert.equal(XMN.mediaRefFromHref('https://twitter.com/alice/status/234/video/1', 'alice').kind, 'video');
});

test('the displayed media URL maps to an exact tile instead of only a status ID', () => {
  const refs = [
    '/alice/status/1/photo/1',
    '/alice/status/1/photo/2',
    '/alice/status/2/photo/1',
  ].map((href) => XMN.mediaRefFromHref(href, 'alice'));
  assert.equal(XMN.findCurrentIndex(refs, '/alice/status/1/photo/2', 'alice'), 1);
  assert.equal(XMN.findCurrentIndex(refs, '/alice/status/1', 'alice'), null, 'ambiguous status URL');
  assert.equal(XMN.findCurrentIndex(refs, '/bob/status/1/photo/1', 'alice'), null);
});

test('status-only routing is allowed only when uniquely identifiable', () => {
  const refs = [XMN.mediaRefFromHref('/alice/status/2/photo/1', 'alice')];
  assert.equal(XMN.findCurrentIndex(refs, '/alice/status/2', 'alice'), 0);
});

test('direction lookup does not clamp back to the same tile at bounds', () => {
  assert.equal(XMN.adjacentIndex(0, 3, -1), null);
  assert.equal(XMN.adjacentIndex(2, 3, 1), null);
  assert.equal(XMN.adjacentIndex(1, 3, -1), 0);
  assert.equal(XMN.adjacentIndex(1, 3, 1), 2);
  assert.equal(XMN.adjacentIndex(-1, 3, 1), null);
});

test('bare arrow keys and other modifiers are never hijacked', () => {
  const event = { key: 'ArrowRight', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };
  assert.equal(XMN.postShortcutDirection(event), null);
  assert.equal(XMN.postShortcutDirection({ ...event, shiftKey: true }), 1);
  assert.equal(XMN.postShortcutDirection({ ...event, key: 'ArrowLeft', shiftKey: true }), -1);
  assert.equal(XMN.postShortcutDirection({ ...event, shiftKey: true, ctrlKey: true }), null);
  assert.equal(XMN.postShortcutDirection({ ...event, shiftKey: true, repeat: true }), null);
  assert.equal(XMN.postShortcutDirection({ ...event, shiftKey: true, isComposing: true }), null);
});
