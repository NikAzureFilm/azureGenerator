import assert from 'node:assert/strict';
import { hasRenderableScadCode } from './parametricParts.ts';

assert.equal(hasRenderableScadCode(''), false);
assert.equal(hasRenderableScadCode('I cannot create that model.'), false);
assert.equal(hasRenderableScadCode('width = 20;\nheight = 10;'), false);
assert.equal(hasRenderableScadCode('cube([20, 10, 5]);'), true);
assert.equal(
  hasRenderableScadCode('include <BOSL2/std.scad>\nrounded_box([10,10,5]);'),
  true,
);
