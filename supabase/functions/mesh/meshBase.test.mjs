import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

assert.match(
  source,
  /appendMeshBasePromptDirective/,
  'mesh function should use the shared helper to append base directives to generation prompts',
);

assert.match(
  source,
  /const normalizedMeshBase = normalizeMeshBase\(meshBase\)/,
  'mesh function should normalize the requested base before storing or forwarding it',
);

assert.match(
  source,
  /prompt:\s*{[\s\S]*meshBase/s,
  'mesh function should persist selected base metadata on mesh prompts',
);

assert.match(
  source,
  /submitMeshJob\([\s\S]*normalizedMeshBase/s,
  'mesh function should forward selected base metadata into async mesh generation',
);

assert.match(
  source,
  /const meshTextPrompt = appendMeshBasePromptDirective\(text, meshBase\)/,
  'mesh generation should derive prompt text with the selected base directive',
);
