import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../tools/media-cache-audit.js', import.meta.url), 'utf8');

test('read-only CDN audit aggregates counts without exposing URLs or claiming opaque cache hits', () => {
  const events=[],urls=[
    'https://pbs.twimg.com/media/ABC?format=jpg&name=large',
    'https://pbs.twimg.com/media/ABC?format=jpg&name=orig',
    'https://pbs.twimg.com/media/DEF?format=jpg&name=large',
    'https://example.com/media/PRIVATE?format=jpg&name=orig',
  ];
  const entries=urls.map((name,i)=>({
    name,transferSize:[12000,0,0,100][i],
    decodedBodySize:[20000,0,9000,100][i],duration:[25,9,2,3][i],
  }));
  const image={
    currentSrc: urls[1],
    closest(){return null;},
    getBoundingClientRect(){return {left:10,top:10,right:500,bottom:500,width:490,height:490};},
  };
  const context={URL,Map,Set,innerHeight:900,innerWidth:1200,
    performance:{getEntriesByType(type){assert.equal(type,'resource');return entries;}},
    document:{querySelectorAll(sel){assert.equal(sel,'[data-testid="swipe-to-dismiss"] img');return [image];}},
    console:{info(...args){events.push(args);}},
  };
  const result=vm.runInNewContext(source,context);
  assert.equal(result.observedResourceEntries,4);
  assert.equal(result.observedMediaResources,3);
  assert.equal(result.uniqueMediaIds,2);
  assert.equal(result.mediaIdsWithMultipleNameVariants,1);
  assert.equal(result.measuredTransfers,1);
  assert.equal(result.cacheHitsWithDecodedSizeEvidence,1);
  assert.equal(result.unknownTransferDueToMissingTiming,1,
    'opaque cross-origin timing is not definitive evidence of cache reuse');
  assert.equal(result.visibleCdnImages,1);
  assert.equal(result.visibleImagesWithObservedResource,1);
  assert.equal(result.medianObservedResourceDurationMs,9);
  assert.equal(events.length,1);
  for (const url of urls) assert.ok(!JSON.stringify(result).includes(url));
  assert.equal(events[0][1],result);
});

test('performance audit gracefully handles empty resource timing buffer', () => {
  const result=vm.runInNewContext(source,{
    URL,Map,Set,innerHeight:900,innerWidth:1200,
    performance:{getEntriesByType(){return [];}},
    document:{querySelectorAll(){return [];}},
    console:{info(){}},
  });
  assert.equal(result.uniqueMediaIds,0);
  assert.equal(result.medianObservedResourceDurationMs,null);
});
