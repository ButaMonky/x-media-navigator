import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const get=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const cases=[
 ['test:mv3:native','mv3-b5-native-28-to-29-smoke.mjs'],
 ['test:mv3:fourphoto','mv3-b5-four-photos-to-next-smoke.mjs'],
 ['test:mv3:deny','mv3-b5-deny-consent-smoke.mjs'],
 ['test:mv3:unverified','mv3-b5-unverified-cursor-smoke.mjs']
];
test('B5 protected CI runs all real Chrome MV3 acceptance and refusal cases',()=>{
 const workflow=get('.github/workflows/check.yml');
 const pkg=JSON.parse(get('package.json'));
 assert.match(workflow,/Required isolated Chrome MV3 B5 acceptance and security gate/);
 assert.match(workflow,/export XMN_CHROME_FOR_TESTING=/);
 assert.match(workflow,/exit 1/);
 for(const [name,file] of cases){
   assert.ok(workflow.includes('npm run '+name),name);
   assert.equal(pkg.scripts[name],'npm run build && node tools/'+file);
 }
 assert.match(workflow,/Verify committed compiled JS is up to date/);
});
test('B5 CI smoke always uses temporary profile, localhost, bounded CDP',()=>{
 for(const [,file] of cases){
  const src=get('tools/'+file);
  assert.match(src,/mkdtempSync\(/);
  assert.match(src,/--user-data-dir=/);
  assert.match(src,/--load-extension=/);
  assert.match(src,/--disable-extensions-except=/);
  assert.match(src,/testOrigin:'localhost only'/);
  assert.match(src,/productionGuardUnchanged:true/);
  assert.match(src,/process.platform==='win32'/);
  assert.match(src,/process.kill\(-child.pid,'SIGKILL'\)/);
  assert.match(src,/XMN_CHROME_FOR_TESTING/);
  assert.match(src,/MV3 CDP .* timed out/);
 }
});
