import assert from 'node:assert/strict';
import {
  getAzureFilmMarkBounds,
  getAzureFilmMarkPoints,
} from './azurefilmMarkGeometry.ts';

const points = getAzureFilmMarkPoints();
const bounds = getAzureFilmMarkBounds(points);

assert.equal(points.length, 6400);
assert.ok(bounds.size.x > 0.5, 'expected visible width');
assert.ok(bounds.size.y > 1.5, 'expected visible height');
assert.ok(bounds.size.z > 0.5, 'expected real 3D depth');
assert.ok(Math.abs(bounds.center.x) < 0.1, 'expected centered x bounds');
assert.ok(Math.abs(bounds.center.y) < 0.1, 'expected centered y bounds');
