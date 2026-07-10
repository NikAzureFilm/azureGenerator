import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

const creativePrompt = source.match(
  /const PROMPT_SYSTEM_PROMPT = `([\s\S]*?)`;/,
)?.[1];
const parametricPrompt = source.match(
  /const PARAMETRIC_SYSTEM_PROMPT = `([\s\S]*?)`;/,
)?.[1];

assert.ok(
  creativePrompt,
  'creative prompt generator instructions should exist',
);
assert.ok(
  parametricPrompt,
  'parametric prompt generator instructions should exist',
);
assert.equal(
  creativePrompt.match(/Assistant:/g)?.length,
  21,
  'creative prompt generator should include the original six examples plus fifteen new examples',
);
assert.equal(
  parametricPrompt.match(/Assistant:/g)?.length,
  21,
  'parametric prompt generator should include the original six examples plus fifteen new examples',
);

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
