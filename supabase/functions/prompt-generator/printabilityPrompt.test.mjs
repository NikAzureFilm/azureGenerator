import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

assert.match(
  source,
  /3D printable/i,
  'prompt generator should bias creative and parametric suggestions toward printable assets',
);
assert.match(
  source,
  /minimum wall thickness/i,
  'prompt generator should include wall-thickness guidance for printable outputs',
);
assert.match(
  source,
  /build plate/i,
  'prompt generator should include build-plate readiness guidance',
);
