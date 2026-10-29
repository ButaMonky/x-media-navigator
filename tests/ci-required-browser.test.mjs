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
 assert.match(ci,/\r?\n\s+exit 1\r?\n/,
  'missing a browser must end the CI job unsuccessfully');
});

test('synthetic X Chrome fixture reserves headroom beyond awaited timers',()=>{
 const source=readFileSync(new URL('./browser.test.mjs',import.meta.url),'utf8');
 const budget=Number(source.match(/--virtual-time-budget=(\d+)/)?.[1]||0);
 const explicitWaits=Array.from(source.matchAll(/await\s+wait\(\s*(\d+)\s*\)/g),
  match=>Number(match[1])).reduce((a,b)=>a+b,0);
 assert.ok(explicitWaits>0);
 assert.ok(budget>=explicitWaits+20000,
  'headless Chrome must not dump DOM before synthetic gallery scenario completes');
});
