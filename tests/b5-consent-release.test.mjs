import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const get = relative=>readFileSync(new URL('../'+relative,import.meta.url),'utf8');

test('B5 consent QA 2.4.26 keeps prior stable and versioned QA installations immutable',()=>{
 const m=JSON.parse(get('extension/manifest.json'));
 const pkg=JSON.parse(get('package.json'));
 const lock=JSON.parse(get('package-lock.json'));
 const stage=get('tools/stage-b5-private-qa.ps1');
 assert.equal(m.manifest_version,3);
 assert.equal(m.version,'2.4.26');
 assert.match(m.name,/Consent QA 2\.4\.26/);
 assert.match(m.version_name,/2\.4\.26 Consent private QA candidate/);
 assert.deepEqual(m.permissions,['storage']);
 assert.equal(pkg.version,'2.4.26-dev.1');
 assert.equal(lock.version,pkg.version);
 assert.equal(lock.packages[''].version,pkg.version);
 assert.match(stage,/task\/xmn-b5-consent-once-20261030/);
 assert.match(stage,/X-Media-Navigator-v2\.4\.26-CONSENT-QA-20261030/);
 for(const prior of [
  'X-Media-Navigator-Current',
  'X-Media-Navigator-FxEmbed-QA-20261029',
  'X-Media-Navigator-v2.4.21-B4-QA-20261030',
  'X-Media-Navigator-v2.4.22-B5-QA-20261030',
  'X-Media-Navigator-v2.4.23-B5-QA-20261030',
  'X-Media-Navigator-v2.4.24-HISTORY-QA-20261030',
  'X-Media-Navigator-v2.4.25-PREFLIGHT-QA-20261030'
 ]) assert.ok(stage.includes(prior),'Protected previous candidate '+prior);
 for(const gate of [
  'git -C $root status --porcelain',
  'git -C $root ls-remote',
  '--json headSha,status,conclusion',
  'npm.cmd test','npm.cmd run typecheck',
  'test:mv3:b5','test:mv3:history','test:mv3:bfcache',
  'test:mv3:reject','B5_READONLY_AUDIT.js',
  'Get-FileHash','Move-Item -LiteralPath $stage -Destination $Destination',
  'CHROME_INSTALLATION_NOT_MODIFIED=true',
  'Refusing QA package from uncommitted or untracked source'
 ]) assert.ok(stage.includes(gate),'Missing QA gate '+gate);
 assert.doesNotMatch(stage,/Start-Process\s+(?:chrome|msedge)(?:\.exe)?/i);
});

test('B5 consent flow cannot bypass route ownership or public API gate',()=>{
 const source=get('src/content.ts');
 assert.match(source,/private publicConsentPendingGeneration:number\|null=null/);
 assert.match(source,/publicConsentPendingGeneration===this\.navGeneration/);
 assert.match(source,/if\(this\.publicConsentPendingGeneration===consentGeneration\)/);
 assert.match(source,/this\.publicConsentPendingGeneration = null;/);
 assert.match(source,/fxembed\.consent_store_failed/);
 assert.match(source,/外部APIには接続しません/);
});
