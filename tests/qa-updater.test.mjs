import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const get = name => readFileSync(new URL('../'+name,import.meta.url),'utf8');

test('the only supported updater targets Current and disables legacy QA folders',()=>{
  const ps=get('tools/update-current.ps1');
  const cmd=get('Update-Chrome-Current.cmd');
  const legacy=get('Update-Chrome-QA.cmd');
  assert.match(cmd,/update-current\.ps1/);
  assert.match(legacy,/Legacy FxEmbed QA updater is disabled/);
  assert.doesNotMatch(legacy,/update-chrome-qa\.ps1/);
  assert.match(ps,/X-Media-Navigator-Current/);
  assert.doesNotMatch(ps,/X-Media-Navigator-FxEmbed-QA-20261029/);
  assert.match(ps,/task\/xmn-b0-b3-20261029/);
  assert.match(ps,/X-Media-Navigator-Current/);
  assert.match(ps,/\.xmn-current-rollback-/);
  assert.match(ps,/Remove-Item -LiteralPath \$rollback/);
  assert.doesNotMatch(ps,/Start-Process\s+(?:chrome|msedge)/i);
});

test('manifest, package and lockfile share the v2.4.28 native QA version',()=>{
  const manifest=JSON.parse(get('extension/manifest.json'));
  const pkg=JSON.parse(get('package.json'));
  const lock=JSON.parse(get('package-lock.json'));
  assert.equal(manifest.manifest_version,3);
  assert.deepEqual(manifest.permissions,['storage']);
  assert.equal(manifest.version,'2.4.28');
  assert.match(manifest.name,/Native QA 2\.4\.28/);
  assert.match(manifest.version_name,/2\.4\.28 Native private QA candidate/);
  assert.equal(pkg.version,lock.version);
  assert.equal(pkg.version,lock.packages[''].version);
  assert.equal(pkg.version,'2.4.28-dev.1');
  assert.match(pkg.scripts['qa:update'],/update-current\.ps1/);
});

test('diagnostics remain privacy-conserving',()=>{
  const source=get('src/content.ts');
  for(const name of ['prefetch.started','prefetch.finished','preview.visible',
    'preview.finished','navigation.native_spa']){
    assert.ok(source.includes(name),name);
  }
  assert.doesNotMatch(source,/diagnostic\([^\n]*(?:url\.toString\(|\.href|\.cursor)/i);
});

test('R-018 updater rejects dirty, unpushed, unverified or same-version changes',()=>{
  const source=get('tools/update-current.ps1');
  for(const part of [
    'function Assert-Source',
    'git -C $root status --porcelain',
    'git -C $root ls-remote origin',
    'GitHub CI lookup failed',
    'Exact commit lacks successful GitHub CI',
    'npm.cmd --prefix $root run typecheck',
    'node.exe --check',
    'if((Assert-Source) -ne $head)',
    'SHA256',
    'Move-Item -LiteralPath $target -Destination $rollback',
    'Move-Item -LiteralPath $stage -Destination $target',
    'Same-version content change refused',
    'Version downgrade refused',
    'Current extension folder is missing',
    'Remove-Item -LiteralPath $stage',
    'Reload this extension card'
  ]) assert.ok(source.includes(part),'Missing gate: '+part);
  assert.doesNotMatch(source,/ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+/);
});
