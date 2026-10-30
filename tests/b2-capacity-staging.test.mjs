import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const src=relative=>readFileSync(new URL('../'+relative,import.meta.url),'utf8');
test('v2.4.23 B2 safety QA is a new, reproducible and non-overwriting package',()=>{
 const ps=src('tools/stage-b2-capacity-qa.ps1');
 const manifest=JSON.parse(src('extension/manifest.json'));
 const pkg=JSON.parse(src('package.json'));
 const lock=JSON.parse(src('package-lock.json'));
 assert.equal(manifest.version,'2.4.23');
 assert.match(manifest.version_name,/B2 capacity and B5 QA candidate/);
 assert.equal(manifest.manifest_version,3);
 assert.deepEqual(manifest.permissions,['storage']);
 assert.equal(pkg.version,'2.4.23-dev.1');
 assert.equal(pkg.version,lock.version);
 assert.equal(pkg.version,lock.packages[''].version);
 assert.equal(pkg.scripts['qa:stage-capacity'].includes('stage-b2-capacity-qa.ps1'),true);
 assert.match(ps,/task\/xmn-b2-capacity-20261030/);
 assert.match(ps,/X-Media-Navigator-v2\.4\.23-B2-CAPACITY-QA-20261030/);
 for(const protectedDir of [
  'X-Media-Navigator-Current','X-Media-Navigator-FxEmbed-QA-20261029',
  'X-Media-Navigator-v2.4.21-B4-QA-20261030',
  'X-Media-Navigator-v2.4.22-B5-QA-20261030'
 ]) assert.ok(ps.includes(protectedDir),'Protected existing install: '+protectedDir);
 for(const gate of ['git -C $root status --porcelain','git -C $root ls-remote',
  '--json headSha,status,conclusion','npm.cmd run typecheck',
  'npm.cmd test','npm.cmd run test:mv3:b5',
  'npm.cmd run test:mv3:reject','B5_READONLY_AUDIT.js',
  'Get-FileHash','Move-Item -LiteralPath $stage -Destination $Destination'
 ]) assert.ok(ps.includes(gate),'Missing gate '+gate);
 assert.doesNotMatch(ps,/Start-Process.*chrome|chrome:\/\/extensions/);
 assert.match(ps,/Destination already exists/);
 assert.match(ps,/Refusing QA package from uncommitted or untracked source/);
});
