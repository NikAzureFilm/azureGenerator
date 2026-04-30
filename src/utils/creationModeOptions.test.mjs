import assert from 'node:assert/strict';
import { CREATION_MODE_OPTIONS } from './creationModeOptions.ts';

assert.deepEqual(
  CREATION_MODE_OPTIONS.map(({ type }) => type),
  ['parametric', 'creative'],
);

assert.equal(CREATION_MODE_OPTIONS[0].title, 'CAD Engineering');
assert.equal(
  CREATION_MODE_OPTIONS[0].description,
  'Precise parts, mechanisms, practical engineering',
);

assert.equal(CREATION_MODE_OPTIONS[1].title, 'Mesh Generation');
assert.equal(
  CREATION_MODE_OPTIONS[1].description,
  'Figurines, organic shapes, sculpts',
);

assert.equal(CREATION_MODE_OPTIONS[1].printability.includes('wide base'), true);
assert.equal(
  CREATION_MODE_OPTIONS[1].printability.includes('thick features'),
  true,
);
