import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

assert.match(
  source,
  /import \{ KIMI_K3_MODEL \}/,
  'agent mode should import the canonical Kimi K3 model id',
);
assert.match(
  source,
  /const AGENT_MODEL = KIMI_K3_MODEL/,
  'agent mode should run on Kimi K3',
);
assert.match(source, /at least 1\.2 mm walls/);
assert.match(source, /0\.25-0\.4 mm clearance per side/);
assert.match(source, /no bridges over about 10 mm/);
assert.match(source, /const KIMI_K3_MAX_ATTEMPTS = 3/);
assert.match(source, /response\.status === 429/);
assert.match(
  source,
  /const nonStreamingBody = \{ \.\.\.requestBody, stream: false \}/,
);
assert.match(source, /completionJsonAsSse/);
assert.match(source, /Kimi K3 is temporarily at capacity/);

console.log('agent Kimi K3 and printability tests passed');
