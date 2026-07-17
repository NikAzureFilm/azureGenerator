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

console.log('agent Kimi K3 and printability tests passed');
