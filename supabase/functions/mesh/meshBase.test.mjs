import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

assert.match(
  source,
  /action\?: 'upscale' \| 'add-base'/,
  'mesh function should accept add-base as a post-generation mesh action',
);

assert.match(
  source,
  /if \(action === 'add-base' && actionMeshId && conversationId\)/,
  'mesh function should handle add-base only as an action on an existing mesh',
);

assert.match(
  source,
  /const normalizedMeshBase = normalizeAddedMeshBase\(meshBase\)/,
  'add-base action should normalize missing or invalid base choices to a printable default',
);

assert.match(
  source,
  /const normalizedMeshBaseSettings\s*=\s*normalizeMeshBaseSettings\(meshBaseSettings\)/,
  'add-base action should normalize requested base rotation, scale, and thickness',
);

assert.match(
  source,
  /appendMeshBasePromptDirective\([\s\S]*originalPromptText[\s\S]*normalizedMeshBase[\s\S]*normalizedMeshBaseSettings[\s\S]*\)/,
  'add-base action should derive a follow-up prompt with the selected base directive and transform settings',
);

assert.match(
  source,
  /baseAddedFrom: actionMeshId[\s\S]*meshBase: normalizedMeshBase[\s\S]*meshBaseSettings: normalizedMeshBaseSettings/s,
  'add-base action should persist the source mesh, selected base, and transform settings on the derived mesh prompt',
);

assert.doesNotMatch(
  source,
  /submitMeshJob\([\s\S]*normalizedMeshBase/s,
  'regular mesh generation should not forward base metadata into initial generation',
);
