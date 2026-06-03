import assert from 'node:assert/strict';

import {
  appendMeshBasePromptDirective,
  buildMeshBasePromptDirective,
  DEFAULT_MESH_BASE,
  MESH_BASE_OPTIONS,
  normalizeMeshBase,
} from './meshBase.ts';

assert.equal(DEFAULT_MESH_BASE, 'none');
assert.equal(normalizeMeshBase('round'), 'round');
assert.equal(normalizeMeshBase('not-a-base'), DEFAULT_MESH_BASE);
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
