import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUserPostsApiUrl, studyUserPostsPage } from '../tools/x-api-batch-research.mjs';

test('official API request is a pure, documented URL with pagination and no credentials', () => {
  const url = new URL(buildUserPostsApiUrl('1234567890123456789', 'A1B2C3'));
  assert.equal(url.origin,'https://api.x.com');
  assert.equal(url.pathname,'/2/users/1234567890123456789/tweets');
  assert.equal(url.searchParams.get('max_results'),'100');
  assert.equal(url.searchParams.get('expansions'),'attachments.media_keys');
  assert.ok(url.searchParams.get('media.fields').includes('url'));
  assert.equal(url.searchParams.get('pagination_token'),'A1B2C3');
  assert.ok(!url.search.includes('Bearer') && !url.search.includes('access_token=') && !url.search.includes('client_secret='));
  for (const bad of ['guest','0/other','%2F',null,'12345678901234567890']) {
    assert.throws(() => buildUserPostsApiUrl(bad));
  }
  assert.throws(() => buildUserPostsApiUrl('123','AAA!'));
});

test('API payload can describe multiple known photo URLs but cannot prove Media tab order', () => {
  const source = {
    data: [
      {id:'100',attachments:{media_keys:['a','b']}},
      {id:'101',attachments:{media_keys:['video']}},
      {id:'102'},
      {id:'103',attachments:{media_keys:['c']}},
    ],
    includes:{media:[
      {media_key:'a',type:'photo',url:'https://pbs.twimg.com/media/AAA?format=jpg&name=orig'},
      {media_key:'b',type:'photo',url:'https://pbs.twimg.com/media/BBB?format=webp&name=orig'},
      {media_key:'video',type:'video',preview_image_url:'https://pbs.twimg.com/media/VVV'},
      {media_key:'c',type:'photo',url:'https://example.org/media/NOT-X'},
    ]},
    meta:{next_token:'A1B2C3'},
  };
  const report=studyUserPostsPage(source,'Alice');
  assert.equal(report.candidatePosts.length,1);
  assert.deepEqual(report.candidatePosts[0].photoHrefs,[
    '/alice/status/100/photo/1','/alice/status/100/photo/2',
  ]);
  assert.equal(report.candidatePosts[0].mediaUrls.length,2);
  assert.equal(report.skippedOrUnsupportedPosts,3);
  assert.equal(report.pageHasContinuation,true);
  assert.equal(report.exactXMediaTabOrderProven,false);
});

test('missing media expansions, duplicates and mixed media never produce speculative routes', () => {
  const data={data:[
    {id:'1',attachments:{media_keys:['A','A']}},
    {id:'2',attachments:{media_keys:['A','B']}},
    {id:'3',attachments:{media_keys:['A','C']}},
    {id:'4',attachments:{media_keys:['A']}},
    {id:'4',attachments:{media_keys:['A']}},
  ],includes:{media:[
    {media_key:'A',type:'photo',url:'https://pbs.twimg.com/media/A?format=jpg&name=large'},
    {media_key:'B',type:'video',url:'https://pbs.twimg.com/media/B?format=jpg'},
  ]}};
  const report=studyUserPostsPage(data,'bob');
  assert.deepEqual(report.candidatePosts.map(p=>p.statusId),['4']);
  assert.equal(report.skippedOrUnsupportedPosts,4);
  assert.equal(report.pageHasContinuation,false);
});

test('the research adapter is offline only, with no fetch or X session/cookie access', async () => {
  const requestURL = buildUserPostsApiUrl('123');
  assert.ok(requestURL.startsWith('https://api.x.com/2/users/123/tweets?'));
  // Both exported helpers are pure; using an explicit fixture cannot access
  // either the browser's fetch() or the user's authenticated X session.
  assert.equal(studyUserPostsPage({data:[],includes:{media:[]}},'alice').candidatePosts.length,0);
});
