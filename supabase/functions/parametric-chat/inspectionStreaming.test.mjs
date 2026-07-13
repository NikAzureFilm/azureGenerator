import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const inspectionCall = source.match(
  /const gen = await generateContinuationCode\(\{[\s\S]*?operation: 'parametric-inspect'/,
)?.[0];

assert.ok(inspectionCall, 'self-inspection continuation call should exist');
assert.match(
  inspectionCall,
  /onProgress: \(\) => \{\}/,
  'self-inspection should publish rebuilt code only after the complete reply is validated',
);
assert.doesNotMatch(
  inspectionCall,
  /streamProgress\(/,
  'partial self-inspection code should never replace the last compiled artifact',
);

console.log('inspection streaming tests passed');
