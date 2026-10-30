import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');

test('B2 v2.4.25 release channel keeps stable and four prior QA builds separate',()=>{
 const m=JSON.parse(source('extension/manifest.json'));
 const pkg=JSON.parse(source('package.json'));
 const lock=JSON.parse(source('package-lock.json'));
 const stage=source('tools/stage-b5-private-qa.ps1');
 assert.equal(m.manifest_version,3);
 assert.equal(m.version,'2.4.25');
 assert.match(m.name,/Preflight QA 2\.4\.25/);
 assert.equal(pkg.version,'2.4.25-dev.1');
 assert.equal(lock.version,pkg.version);
 assert.equal(lock.packages[''].version,pkg.version);
 assert.deepEqual(m.permissions,['storage']);
 assert.match(stage,/X-Media-Navigator-v2\.4\.25-PREFLIGHT-QA-20261030/);
 assert.match(stage,/task\/xmn-b2-preflight-20261030/);
 for(const label of [
  'X-Media-Navigator-Current','X-Media-Navigator-FxEmbed-QA-20261029',
  'X-Media-Navigator-v2.4.21-B4-QA-20261030',
  'X-Media-Navigator-v2.4.22-B5-QA-20261030',
  'X-Media-Navigator-v2.4.23-B5-QA-20261030',
  'X-Media-Navigator-v2.4.24-HISTORY-QA-20261030'
 ]) assert.ok(stage.includes(label),'Must preserve '+label);
 for(const guard of [
  'Refusing QA package from uncommitted or untracked source',
  'GitHub CI has not succeeded for this exact QA commit',
  'test:mv3:history','test:mv3:bfcache','test:mv3:reject',
  'SHA256SUMS.txt','B5_READONLY_AUDIT.js',
  'Get-FileHash','Move-Item -LiteralPath $stage -Destination $Destination'
 ]) assert.ok(stage.includes(guard),'Missing release guard: '+guard);
 assert.doesNotMatch(stage,/Start-Process\\s+(?:chrome|msedge)(?:\\.exe)?/i);
 assert.ok(stage.includes('CHROME_INSTALLATION_NOT_MODIFIED=true'));
});

test('B2 concurrent manifest preflight is route-owned and fails closed',()=>{
 const content=source('src/content.ts');
 assert.match(content,/private publicApiPreflightGeneration:number\|null=null/);
 assert.match(content,/finally\s*\{\s*if\(this\.publicApiPreflightGeneration===generation\)/);
 assert.match(content,/this\.checkpointContinuationBlocked=true/);
 assert.match(content,/this\.checkpointCapacityReached=capacity/);
 assert.match(content,/保存済みの上限64ページ/);
 assert.match(content,/this\.checkpointCapacityReached \? 1 : 0/);
});
