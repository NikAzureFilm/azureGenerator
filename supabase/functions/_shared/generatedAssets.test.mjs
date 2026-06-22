import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { getBodySizeBytes } from './generatedAssets.ts';

assert.equal(getBodySizeBytes(new ArrayBuffer(4)), 4);
assert.equal(getBodySizeBytes(new Uint8Array([1, 2, 3])), 3);
assert.equal(getBodySizeBytes(Buffer.from('asset')), 5);
assert.equal(getBodySizeBytes('asset'), 5);
assert.equal(getBodySizeBytes(null), 0);

console.log('generated asset helper tests passed');
