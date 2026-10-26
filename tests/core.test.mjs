import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./.build/core.js', import.meta.url), 'utf8');
const context = vm.createContext({ URL, URLSearchParams, Set });
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

test('bare arrow keys are eligible, modifiers and repeats are not', () => {
  const event = { key:'ArrowRight', shiftKey:false,altKey:false,ctrlKey:false,metaKey:false };
  assert.equal(XMN.postShortcutDirection(event), 1);
  assert.equal(XMN.postShortcutDirection({...event,key:'ArrowLeft'}), -1);
  for (const variant of [{shiftKey:true},{ctrlKey:true},{altKey:true},{metaKey:true},{repeat:true},{isComposing:true}]) {
    assert.equal(XMN.postShortcutDirection({...event,...variant}),null);
  }
});

test('bare arrows change POSTS only at first/last photo; video remains native', () => {
  const a=XMN.mediaRefFromHref('/alice/status/11/photo/1','alice');
  const b=XMN.mediaRefFromHref('/alice/status/11/photo/2','alice');
  const c=XMN.mediaRefFromHref('/alice/status/11/photo/3','alice');
  const movie=XMN.mediaRefFromHref('/alice/status/44/video/1','alice');
  const key=(key)=>({key,shiftKey:false,altKey:false,ctrlKey:false,metaKey:false});
  assert.equal(XMN.galleryBoundaryDirection(key('ArrowRight'),a,3),null);
  assert.equal(XMN.galleryBoundaryDirection(key('ArrowRight'),b,3),null);
  assert.equal(XMN.galleryBoundaryDirection(key('ArrowRight'),c,3),1);
  assert.equal(XMN.galleryBoundaryDirection(key('ArrowRight'),c,3,true),null,'native X next button wins');
  assert.equal(XMN.galleryBoundaryDirection(key('ArrowRight'),c,null),null,'unknown gallery size: safe fallback');
  assert.equal(XMN.galleryBoundaryDirection(key('ArrowLeft'),a,3),-1);
  assert.equal(XMN.galleryBoundaryDirection(key('ArrowLeft'),a,3,false,true),-1,'photo/1 always crosses to previous post');
  assert.equal(XMN.galleryBoundaryDirection(key('ArrowLeft'),b,3),null);
  assert.equal(XMN.galleryBoundaryDirection(key('ArrowRight'),movie,1),null,'do not hijack video seek');
  assert.equal(XMN.galleryBoundaryDirection(key('ArrowRight'),null,1),null);
  assert.equal(XMN.galleryBoundaryDirection({...key('ArrowRight'),shiftKey:true},c,3),null);
});

test('post navigation skips the remaining image tiles of the same status', () => {
  const refs=['/alice/status/11/photo/1','/alice/status/11/photo/2','/alice/status/22/photo/1',
    '/alice/status/22/photo/2','/alice/status/33/photo/1'].map((p)=>XMN.mediaRefFromHref(p,'alice'));
  assert.equal(XMN.adjacentPostIndex(refs,'11',1),2);
  assert.equal(XMN.adjacentPostIndex(refs,'22',-1),1,'backwards returns previous post last photo');
  assert.equal(XMN.adjacentPostIndex(refs,'22',1),4);
  assert.equal(XMN.adjacentPostIndex(refs,'11',-1),null);
  assert.equal(XMN.adjacentPostIndex(refs,'33',1),null);
  assert.equal(XMN.adjacentPostIndex(refs,'other',1),null);
});

test('image preloader only uses X image CDN, never arbitrary third-party or videos', () => {
  assert.equal(XMN.preloadImageUrl('https://pbs.twimg.com/media/ABCdef_01?format=jpg&name=small'),
    'https://pbs.twimg.com/media/ABCdef_01?format=jpg&name=large');
  for (const url of ['https://evil.example/media/ABC?format=jpg&name=small',
    'http://pbs.twimg.com/media/ABC?format=jpg&name=small',
    'https://pbs.twimg.com/profile_images/ABC?format=jpg&name=small',
    'https://pbs.twimg.com/media/ABC?format=svg&name=small',
    'https://pbs.twimg.com/media/ABC?format=jpg',
    'https://video.twimg.com/video/ABC',
    'data:image/png;base64,AAAA']) assert.equal(XMN.preloadImageUrl(url),null,url);
});


test('media timeline context distinguishes Photos/Videos but ignores tracking parameters', () => {
  assert.equal(XMN.mediaTimelineKey('/Alice/media', '?filter=photo'), 'alice|photo');
  assert.equal(XMN.mediaTimelineKey('/alice/media/', '?filter=PHOTO&utm_source=foo'), 'alice|photo');
  assert.equal(XMN.mediaTimelineKey('/alice/media', '?filter=video'), 'alice|video');
  assert.equal(XMN.mediaTimelineKey('/alice/media', '?filter=unknown'), 'alice|unknown');
  assert.equal(XMN.mediaTimelineKey('/alice/media', '?utm_source=bar'), 'alice|default');
  assert.notEqual(XMN.mediaTimelineKey('/alice/media','?filter=photo'), XMN.mediaTimelineKey('/alice/media','?filter=video'));
  assert.equal(XMN.mediaTimelineKey('/alice/status/1/photo/2', '?filter=photo'), null);
});

test('an incomplete set of thumbnails never proves the last photo', () => {
  for (const group of [[],[1],[1,2],[1,2,3],[1,3,4],[0,1,2,3]]) {
    assert.equal(XMN.completeFourPhotoSet(new Set(group)), false, JSON.stringify(group));
  }
  assert.equal(XMN.completeFourPhotoSet(new Set([4,2,3,1])), true);
});

test('recognizes only explicit bounded gallery counters', () => {
  for (const label of ['Image 2 of 4', 'Photo 1 of 2', '画像 4/4', '1 / 1']) {
    assert.ok(XMN.parseGalleryCounter(label), label);
  }
  for (const label of ['20 of 40', '2 of 5', 'Image 2 of 1', '2 likes', '1/2 comments']) {
    assert.equal(XMN.parseGalleryCounter(label), null, label);
  }
});
test('Japanese photo counters preserve total/current ordering and full-width digits', () => {
  const valid = [
    ['3枚中2枚目', 2, 3],
    ['全3枚中3枚目', 3, 3],
    ['全４枚中４枚目', 4, 4],
    ['画像 ２／３', 2, 3],
    ['写真 1/1', 1, 1],
  ];
  for (const [label, current, total] of valid) {
    const count = XMN.parseGalleryCounter(label);
    assert.equal(count?.current, current, label);
    assert.equal(count?.total, total, label);
  }
  for (const label of ['2枚中3枚目', '5枚中1枚目', '全3枚中4枚目', '3/5', '画像 2/3 件']) {
    assert.equal(XMN.parseGalleryCounter(label), null, label);
  }
});
test('repeated noncontiguous status IDs never skip intervening posts', () => {
  const refs = [
    '/alice/status/11/photo/1',
    '/alice/status/22/photo/1',
    '/alice/status/11/photo/2',
    '/alice/status/33/photo/1',
    '/alice/status/33/photo/2',
  ].map((p) => XMN.mediaRefFromHref(p, 'alice'));
  assert.equal(XMN.adjacentPostIndex(refs, '11', 1, 0), 1, 'first 11 advances to 22, not 33');
  assert.equal(XMN.adjacentPostIndex(refs, '11', 1, 2), 3, 'later 11 advances to 33');
  assert.equal(XMN.adjacentPostIndex(refs, '11', -1, 2), 1, 'later 11 returns to 22');
  assert.equal(XMN.adjacentPostIndex(refs, '33', -1, 4), 2, 'backwards skips contiguous 33 photos only');
  assert.equal(XMN.adjacentPostIndex(refs, '22', -1, 1), 0);
  assert.equal(XMN.adjacentPostIndex(refs, '22', 1, 1), 2);
  assert.equal(XMN.adjacentPostIndex(refs, 'other', 1, 2), null);
  assert.equal(XMN.adjacentPostIndex(refs, '11', 1, 99), 1, 'invalid anchor uses conservative fallback');
});
test('same photo CDN identity matches different X image sizes but never other images', () => {
  const base='https://pbs.twimg.com/media/EXAMPLE_ID';
  const cases=[
    base+'?format=jpg&name=small',
    base+'?format=jpg&name=large',
    base+'?format=png&name=orig',
    base+'.jpg?name=large',
    base+'.webp:large',
    base+'.png:orig',
    base+'?format=webp&name=4096x4096',
  ];
  for(const url of cases) assert.equal(XMN.photoCdnIdentity(url),'EXAMPLE_ID',url);
  for(const url of [
    'data:image/png;base64,AAAA',
    'https://pbs.twimg.com/profile_images/EXAMPLE_ID/photo.jpg',
    'https://other.example/media/EXAMPLE_ID?format=jpg&name=large',
    'http://pbs.twimg.com/media/EXAMPLE_ID?format=jpg&name=large',
    'https://user:secret@pbs.twimg.com/media/EXAMPLE_ID?format=jpg&name=large',
    'https://pbs.twimg.com:8080/media/EXAMPLE_ID?format=jpg&name=large',
    'https://pbs.twimg.com/media/EXAMPLE_ID.gif?name=orig',
    'https://pbs.twimg.com/media/other.jpg:evil',
  ]) assert.equal(XMN.photoCdnIdentity(url),null,url);
  assert.notEqual(XMN.photoCdnIdentity(base+'?format=jpg&name=large'),
    XMN.photoCdnIdentity('https://pbs.twimg.com/media/OTHER?format=jpg&name=large'));
});
