import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const get = (name) => readFileSync(new URL('../'+name, import.meta.url),'utf8');

test('private QA update is one-click, test-gated, backed up and does not target stable installation',()=>{
  const ps=get('tools/update-chrome-qa.ps1');
  const cmd=get('Update-Chrome-QA.cmd');
  assert.match(cmd,/update-chrome-qa\.ps1/i);
  assert.match(ps,/handoff\/fxembed-media-continuation-20261029/);
  assert.match(ps,/npm\.cmd run typecheck/);
  assert.match(ps,/npm\.cmd test/);
  assert.match(ps,/npm\.cmd run test:browser/);
  assert.match(ps,/X-Media-Navigator-FxEmbed-QA-20261029/);
  assert.match(ps,/Get-FileHash/);
  assert.match(ps,/background\.js/,'the future QA must include the MV3 worker');
  assert.match(ps,/\$stableFiles/,'existing stable install has no worker');
  assert.match(ps,/fxembed-qa-pre-/);
  assert.match(ps,/Move-Item -LiteralPath \$stage -Destination \$target/);
  assert.match(ps,/\$stableHashes/);
  assert.doesNotMatch(ps,/Copy-Item[^\n]*-Destination[^\n]*\$stable/);
  assert.doesNotMatch(ps,/Move-Item[^\n]*-Destination[^\n]*\$stable/);
  assert.match(ps,/chrome:\/\/extensions/);
});

test('QA manifest, package and lockfile share the same Chrome version',()=>{
  const manifest=JSON.parse(get('extension/manifest.json'));
  const pkg=JSON.parse(get('package.json'));
  const lock=JSON.parse(get('package-lock.json'));
  assert.equal(manifest.version,pkg.version.replace(/-dev\..*$/,''));
  assert.equal(pkg.version,lock.version);
  assert.equal(pkg.version,lock.packages[''].version);
  assert.equal(pkg.scripts['qa:update'].includes('update-chrome-qa.ps1'),true);
  assert.match(manifest.version_name,/(?:FxEmbed QA|B0-B3 candidate)/);
});

test('user diagnostics contain named events but never log full media URLs or cursor values',()=>{
  const source=get('src/content.ts');
  for(const name of ['fxembed.request','fxembed.continuation_ready',
    'preview.low_thumbnail_decoded','preview.visible',
    'preview.promoted_to_high','preview.finished','navigation.document_handoff']){
    assert.ok(source.includes(name),name);
  }
  assert.doesNotMatch(source,/diagnostic\([^\n]*(?:url\.toString\(|\.href|\.cursor)/i);
});

test('R-018 QA updater only stages an already pushed clean commit with reproducible assets',()=>{
  const ps=get('tools/update-chrome-qa.ps1');
  assert.match(ps,/function Assert-QACommittedSource/);
  assert.match(ps,/git -C \$root diff --name-only HEAD --/);
  assert.match(ps,/git -C \$root ls-files --others --exclude-standard/);
  assert.match(ps,/git -C \$root ls-remote origin/);
  assert.match(ps,/Refusing QA deployment from an unpushed or outdated Git commit/);
  assert.ok((ps.match(/Assert-QACommittedSource/g)||[]).length>=3,
    'verify committed state once before running tests and again after tests');
  assert.match(ps,/Refusing same-version content change/);
  assert.match(ps,/bump the Chrome version/);
  assert.match(ps,/verified clean and GitHub-synced/);
  assert.doesNotMatch(ps,/preview\.visible[^\n]*proves actual display/,
    'classList reveal is not proof that real screen pixels were painted');
});
