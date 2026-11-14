import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const icons = {
  16:'4953221d3a5a51899a5678303440053cc5c2016fdebf6c9cec97c73c6063891d',
  48:'c6b5286b642d2073a97a6695c5a7c40b01e7bb77854fa3e31eb0b9e9605b9a39',
  128:'34e5830b90a620d63622c8ebcfc2da5aebafb122f3c9edc9bb731c2470250388',
};
test('the approved neon gallery artwork is installed at every Chrome icon size',()=>{
  const manifest=JSON.parse(readFileSync(new URL('../extension/manifest.json',import.meta.url),'utf8'));
  assert.equal(manifest.version,'2.4.30');
  assert.deepEqual(Object.keys(manifest.icons).sort(),Object.keys(icons).sort());
  for(const [size,sha] of Object.entries(icons)){
    const filename=manifest.icons[size];
    assert.equal(filename,'icon'+size+'.png');
    const buf=readFileSync(new URL('../extension/'+filename,import.meta.url));
    assert.equal(buf.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    assert.equal(buf.readUInt32BE(16),Number(size));
    assert.equal(buf.readUInt32BE(20),Number(size));
    assert.equal(createHash('sha256').update(buf).digest('hex'),sha);
  }
});
