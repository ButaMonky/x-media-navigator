import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const ci=readFileSync(new URL('../.github/workflows/check.yml',import.meta.url),'utf8');
test('R-021: CI must fail if Chromium integration tests cannot run',()=>{
 assert.match(ci,/Required synthetic browser navigation check/,
  'browser verification must be a required CI quality gate');
 assert.match(ci,/XMN_RUN_CHROMIUM=1 CHROMIUM_PATH=/,
  'the browser test must not silently skip its Chromium fixtures');
 assert.match(ci,/::error::No Chrome\/Chromium found/);
 assert.match(ci,/\n\s+exit 1\n/,
  'missing a browser must end the CI job unsuccessfully');
});
