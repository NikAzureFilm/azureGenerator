import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

assert.match(source, /settleReservedGenerationCharge/);
assert.match(source, /releaseReservedGenerationCharge/);
assert.match(
  source,
  /releaseState === 'settlement_in_progress'[\s\S]*settlement is already in progress/,
  'a failure callback must not race a successful settlement',
);
assert.match(
  source,
  /releaseState === 'missing' \|\| releaseState === 'charged'[\s\S]*refundLegacyFailedCadJob/,
  'only prepaid or actually charged failed jobs should be refunded',
);

console.log('cad worker callback deferred billing tests passed');
