import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

assert.doesNotMatch(
  source,
  /enable_pbr:\s*true/,
  'mesh generation should avoid PBR outputs that can bake shadow-like AO maps into models',
);
