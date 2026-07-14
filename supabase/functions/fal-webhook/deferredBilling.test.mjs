import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

assert.match(source, /settleReservedGenerationCharge/);
assert.match(source, /releaseReservedGenerationCharge/);
assert.match(
  source,
  /await recordGeneratedAsset\([\s\S]*await settleCompletedMeshJob\(/,
  'mesh credits should settle only after the generated model is stored',
);
assert.match(
  source,
  /releaseState === 'missing' \|\| releaseState === 'charged'[\s\S]*refundLegacyFailedMeshJob/,
  'legacy prepaid jobs should retain their failure refund during rollout',
);
assert.match(
  source,
  /releaseState === 'settlement_in_progress'[\s\S]*Mesh callback already processing/,
  'duplicate callbacks must not race an in-progress token settlement',
);
assert.doesNotMatch(
  source,
  /if \(!releaseState\)/,
  'an already-released reservation must not be mistaken for a prepaid job',
);

console.log('fal webhook deferred billing tests passed');
