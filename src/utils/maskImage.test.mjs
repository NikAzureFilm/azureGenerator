import assert from 'node:assert/strict';
import { buildMaskAlphaData } from './maskImage.ts';

// 2x1 stroke canvas: pixel 0 painted opaque red, pixel 1 untouched.
// RGBA layout: [r,g,b,a, r,g,b,a]
const stroke = new Uint8ClampedArray([
  255,
  0,
  0,
  255, // painted (opaque)
  0,
  0,
  0,
  0, // untouched
]);

const mask = buildMaskAlphaData(stroke);

// Painted pixel must become fully TRANSPARENT (alpha 0) — the region OpenAI
// regenerates. This is the crux of the blocking fix: a translucent stroke used
// to yield alpha ~127 here, which OpenAI reads as "preserve".
assert.equal(mask[3], 0, 'painted pixel must be fully transparent (alpha 0)');
// Untouched pixel must be fully OPAQUE black — preserved.
assert.equal(mask[7], 255, 'untouched pixel must be fully opaque (alpha 255)');
assert.equal(mask[4], 0, 'preserved pixel red channel is black');
assert.equal(mask[5], 0, 'preserved pixel green channel is black');
assert.equal(mask[6], 0, 'preserved pixel blue channel is black');

// Binarization: any non-zero stroke coverage (e.g. an anti-aliased edge at
// alpha 1) must still fully clear the mask alpha, never leave a partial value.
const edge = new Uint8ClampedArray([255, 0, 0, 1]);
const edgeMask = buildMaskAlphaData(edge);
assert.equal(
  edgeMask[3],
  0,
  'any non-zero stroke coverage binarizes to transparent',
);

// A fully-untouched canvas yields an all-opaque (fully preserved) mask.
const empty = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 0]);
const emptyMask = buildMaskAlphaData(empty);
assert.equal(emptyMask[3], 255, 'empty canvas preserves pixel 0');
assert.equal(emptyMask[7], 255, 'empty canvas preserves pixel 1');

console.log('maskImage alpha-transform checks passed');
