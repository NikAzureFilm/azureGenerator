import assert from 'node:assert/strict';

import {
  appendMeshBasePromptDirective,
  buildMeshBasePromptDirective,
  DEFAULT_ADDED_MESH_BASE,
  DEFAULT_MESH_BASE_SETTINGS,
  DEFAULT_MESH_BASE,
  MESH_BASE_OPTIONS,
  normalizeMeshBaseSettings,
  normalizeAddedMeshBase,
  normalizeMeshBase,
} from './meshBase.ts';

assert.equal(DEFAULT_MESH_BASE, 'none');
assert.equal(DEFAULT_ADDED_MESH_BASE, 'round');
assert.deepEqual(DEFAULT_MESH_BASE_SETTINGS, {
  rotationDeg: 0,
  scalePercent: 115,
  thicknessPercent: 10,
});
assert.equal(normalizeMeshBase('round'), 'round');
assert.equal(normalizeMeshBase('not-a-base'), DEFAULT_MESH_BASE);
assert.equal(normalizeAddedMeshBase(undefined), DEFAULT_ADDED_MESH_BASE);
assert.equal(normalizeAddedMeshBase('terrain'), 'terrain');
assert.deepEqual(
  normalizeMeshBaseSettings({
    rotationDeg: 450,
    scalePercent: 500,
    thicknessPercent: -10,
  }),
  {
    rotationDeg: 360,
    scalePercent: 200,
    thicknessPercent: 4,
  },
  'base transform settings should be clamped to printable ranges',
);
assert.equal(buildMeshBasePromptDirective('none'), undefined);

assert.equal(
  MESH_BASE_OPTIONS.some((option) => option.id === 'terrain'),
  true,
  'base presets should include a terrain-style base like the Meshy reference',
);

const roundDirective = buildMeshBasePromptDirective('round') ?? '';
assert.match(
  roundDirective,
  /integrated round display base/i,
  'round base directive should ask for an integrated round display base',
);
assert.match(
  roundDirective,
  /flat underside/i,
  'base directive should preserve 3D-printable flat underside guidance',
);

const customDirective =
  buildMeshBasePromptDirective('hex', {
    rotationDeg: 30,
    scalePercent: 140,
    thicknessPercent: 18,
  }) ?? '';
assert.match(
  customDirective,
  /rotate the base 30 degrees/i,
  'base directive should include requested base rotation',
);
assert.match(
  customDirective,
  /footprint scale at 140%/i,
  'base directive should include requested base scale',
);
assert.match(
  customDirective,
  /thickness around 18%/i,
  'base directive should include requested base thickness',
);

assert.match(
  appendMeshBasePromptDirective('a small wizard', 'terrain') ?? '',
  /a small wizard[\s\S]*rocky terrain display base/i,
  'base directive should be appended without replacing the user prompt',
);

assert.match(
  appendMeshBasePromptDirective(undefined, 'square') ?? '',
  /integrated square display base/i,
  'image-only mesh generations should still get a base directive',
);

assert.match(
  appendMeshBasePromptDirective('a small wizard', 'oval', {
    rotationDeg: 45,
    scalePercent: 130,
    thicknessPercent: 14,
  }) ?? '',
  /a small wizard[\s\S]*rotate the base 45 degrees[\s\S]*footprint scale at 130%[\s\S]*thickness around 14%/i,
  'base transform directive should be appended with the selected base directive',
);
