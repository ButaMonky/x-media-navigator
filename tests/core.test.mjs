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


test('query parameter ordering never duplicates the same X CDN photo prefetch', () => {
  const forward=XMN.preloadImageUrl('https://pbs.twimg.com/media/ORDER?name=small&format=jpg');
  const reversed=XMN.preloadImageUrl('https://pbs.twimg.com/media/ORDER?format=jpg&name=thumb');
  assert.equal(forward,reversed,'identical X image variants must share one cache/queue key');
  assert.equal(forward,'https://pbs.twimg.com/media/ORDER?format=jpg&name=large');
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
    assert.equal(XMN.completeMaxPhotoSet(new Set(group)), false, JSON.stringify(group));
  }
  assert.equal(XMN.completeMaxPhotoSet(new Set([4,2,3,1])), false);
  assert.equal(XMN.completeMaxPhotoSet(new Set(Array.from({length:20},(_,i)=>i+1))),true);
});

test('recognizes only explicit bounded gallery counters', () => {
  for (const label of ['Image 2 of 4', 'Photo 1 of 2', 'Image 5 of 20', '画像 4/4', '1 / 1']) {
    assert.ok(XMN.parseGalleryCounter(label), label);
  }
  for (const label of ['20 of 40', '2 of 21', 'Image 2 of 1', '2 likes', '1/2 comments']) {
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
  for (const label of ['2枚中3枚目', '21枚中1枚目', '全3枚中4枚目', '3/21', '画像 2/3 件']) {
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

test('public media API page parses only matching-author photo links in order', () => {
  const raw={
    code:200,
    results:[
      {type:'status',id:'300',url:'https://x.com/alice/status/300',author:{screen_name:'alice'},
        media:{all:[{type:'photo',url:'https://pbs.twimg.com/media/A?format=jpg&name=orig'},
          {type:'photo',url:'https://pbs.twimg.com/media/B?format=jpg&name=orig'}]}},
      {type:'status',id:'200',url:'https://x.com/alice/status/200',author:{screen_name:'alice'},
        media:{all:[{type:'video',url:'https://video.twimg.com/ext_tw_video/video.mp4'}]}},
      {type:'status',id:'199',url:'https://x.com/bob/status/199',author:{screen_name:'bob'},
        media:{all:[{type:'photo',url:'https://pbs.twimg.com/media/X?format=jpg&name=orig'}]}},
    ],
    cursor:{bottom:'CURSOR_2',top:'CURSOR_1'},
  };
  const result=XMN.parsePublicMediaPage(raw,'alice');
  assert.ok(result);
  assert.equal(result.cursor,'CURSOR_2');
  assert.deepEqual(Array.from(result.refs,r=>r.href),[
    '/alice/status/300/photo/1','/alice/status/300/photo/2','/alice/status/200/video/1']);
  assert.deepEqual(Array.from(result.photos,([key,url])=>[key,url]),[
    ['300:photo:1','https://pbs.twimg.com/media/A?format=jpg&name=large'],
    ['300:photo:2','https://pbs.twimg.com/media/B?format=jpg&name=large']]);
});

test('public API refuses malformed owned media pages rather than silently skipping posts', () => {
  const row=(id,photos,url='https://pbs.twimg.com/media/X?format=jpg&name=large')=>({
    type:'status',id,url:'https://x.com/alice/status/'+id,author:{screen_name:'alice'},
    media:{all:Array.from({length:photos},()=>({type:'photo',url}))},
  });
  const raw={code:200,results:[
    row('301',1,'https://evil.example/media/X?format=jpg&name=orig'),
    {...row('302',1),author:{screen_name:'eve'}},
    {...row('303',1),media:{all:[
      {type:'photo',url:'https://pbs.twimg.com/media/A?format=jpg&name=orig'},
      {type:'video',url:'https://video.twimg.com/1.mp4'}]}},
    row('304',5),
    row('305',1),
    row('305',1),
  ],cursor:{bottom:null}};
  const r=XMN.parsePublicMediaPage(raw,'alice');
  assert.equal(r,null,'a mixed, duplicate or malformed owned post makes the pagination page unusable');
  assert.equal(XMN.parsePublicMediaPage({...raw,code:429},'alice'),null);
  assert.equal(XMN.parsePublicMediaPage(raw,'invalid!'),null);
});

test('public media parser never converts a photo URL into another origin', () => {
  const media='https://pbs.twimg.com/media/VALID?format=jpg&name=small';
  const result=XMN.parsePublicMediaPage({
    code:200,results:[{type:'status',id:'12345678',
      url:'https://x.com/pignic_cafe/status/12345678',
      author:{screen_name:'pignic_cafe'},media:{all:[{type:'photo',url:media}]}}],
    cursor:{bottom:'abc'},
  },'pignic_cafe');
  assert.equal(result.refs[0].key,'12345678:photo:1');
  assert.equal(result.photos[0][1],
    'https://pbs.twimg.com/media/VALID?format=jpg&name=large');
});

test('FxEmbed real photo URL /media/ID.jpg?name=orig normalizes to prefetch CDN URL', () => {
  assert.equal(XMN.normalizePublicPhotoUrl(
    'https://pbs.twimg.com/media/HVpT9ftbsAACG4v.jpg?name=orig'),
    'https://pbs.twimg.com/media/HVpT9ftbsAACG4v?format=jpg&name=large');
  assert.equal(XMN.normalizePublicPhotoUrl(
    'https://pbs.twimg.com/media/HVpT9ftbsAACG4v?name=orig&format=jpg'),
    'https://pbs.twimg.com/media/HVpT9ftbsAACG4v?format=jpg&name=large');
  for(const url of [
    'https://pbs.twimg.com/profile_images/ABC.jpg?name=orig',
    'https://attacker.net/media/ABC.jpg?name=orig',
    'https://pbs.twimg.com/media/ABC.exe?name=orig',
    'https://pbs.twimg.com/media/ABC.jpg?name=orig&format=webp',
  ]) assert.equal(XMN.normalizePublicPhotoUrl(url),null);
});
test('actual third-party photo media payload produces a usable candidate after parsing', () => {
  const out=XMN.parsePublicMediaPage({
    code:200,results:[{type:'status',id:'2115352872984698984',
      url:'https://x.com/pignic_cafe/status/2115352872984698984',
      author:{screen_name:'pignic_cafe'},
      media:{all:[{type:'photo',url:'https://pbs.twimg.com/media/HVpT9ftbsAACG4v.jpg?name=orig'}]}}],
    cursor:{bottom:'NEXT'},
  },'pignic_cafe');
  assert.equal(out.refs.length,1);
  assert.equal(out.photos[0][1],
    'https://pbs.twimg.com/media/HVpT9ftbsAACG4v?format=jpg&name=large');
});

test('B5 provider page refuses to skip an authored mixed-media post and advance the cursor',()=>{
 const owned=(id,attachments)=>({
  type:'status',id,url:'https://x.com/alice/status/'+id,
  author:{screen_name:'alice'},media:{all:attachments}
 });
 const photo=id=>[{type:'photo',
  url:'https://pbs.twimg.com/media/IMG'+id+'?format=jpg&name=orig'}];
 const valid=owned('400',photo('400'));
 const mixed=owned('300',[
  ...photo('300'),{type:'video',url:'https://video.twimg.com/example.mp4'}
 ]);
 const older=owned('200',photo('200'));
 const input={code:200,results:[valid,mixed,older],
  cursor:{top:'CURRENT',bottom:'AFTER_200'}};
 assert.equal(XMN.parsePublicMediaPage(input,'alice'),null,
  'a missing post cannot be hidden while still advancing the API cursor');
 const invalid=owned('300',[{type:'photo',url:'https://evil.invalid/IMG300'}]);
 assert.equal(XMN.parsePublicMediaPage({...input,results:[valid,invalid,older]},'alice'),null,
  'a verified user-owned post with an invalid image CDN is a hard barrier');
 const duplicated={...input,results:[valid,owned('400',photo('400')),older]};
 assert.equal(XMN.parsePublicMediaPage(duplicated,'alice'),null,
  'a duplicate user-owned status is not a valid unambiguous provider page');
});
test('B5 provider page still ignores unrelated owners and non-media text posts',()=>{
 const photo={type:'photo',url:'https://pbs.twimg.com/media/IMG300?format=jpg&name=orig'};
 const status=(id,author,media)=>({
  type:'status',id,url:'https://x.com/'+author+'/status/'+id,
  author:{screen_name:author},media
 });
 const result=XMN.parsePublicMediaPage({
  code:200,results:[
   status('300','alice',{all:[photo]}),
   status('250','bob',{all:[{type:'video'}]}),
   status('225','alice',{all:[]}),
   status('200','alice',{all:[{type:'animated_gif'}]})
  ],cursor:{bottom:'NEXT'}
 },'alice');
 assert.ok(result);
 assert.deepEqual(Array.from(result.refs,r=>r.href),[
  '/alice/status/300/photo/1','/alice/status/200/video/1']);
 assert.equal(result.cursor,'NEXT');
});
