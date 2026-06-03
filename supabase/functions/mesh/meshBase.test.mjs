import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

assert.doesNotMatch(
  source,
  /action\?: 'upscale' \| 'add-base'/,
  'mesh function should not accept add-base as a post-generation mesh action',
);

assert.doesNotMatch(
  source,
  /if \(action === 'add-base' && actionMeshId && conversationId\)/,
  'mesh function should not handle add-base actions on existing meshes',
);

assert.doesNotMatch(
  source,
  /const normalizedMeshBase = normalizeAddedMeshBase\(meshBase\)/,
  'mesh function should not normalize add-base choices',
);

assert.doesNotMatch(
  source,
  /const normalizedMeshBaseSettings\s*=\s*normalizeMeshBaseSettings\(meshBaseSettings\)/,
  'mesh function should not normalize add-base transform settings',
);

assert.doesNotMatch(
  source,
  /appendMeshBasePromptDirective\([\s\S]*originalPromptText[\s\S]*normalizedMeshBase[\s\S]*normalizedMeshBaseSettings[\s\S]*\)/,
  'mesh function should not derive add-base follow-up prompts',
);

assert.doesNotMatch(
  source,
  /baseAddedFrom: actionMeshId[\s\S]*meshBase: normalizedMeshBase[\s\S]*meshBaseSettings: normalizedMeshBaseSettings/s,
  'mesh function should not persist add-base metadata on derived mesh prompts',
);

assert.doesNotMatch(
  source,
  /submitMeshJob\([\s\S]*normalizedMeshBase/s,
  'regular mesh generation should not forward base metadata into initial generation',
);
