import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('./AuthProvider.tsx', import.meta.url),
  'utf8',
);

assert.match(
  source,
  /BILLING_STATUS_REFETCH_INTERVAL_MS\s*=\s*10\s*\*\s*60\s*\*\s*1000/,
  'billing status should use a 10-minute fallback interval, not 30 seconds',
);

assert.match(
  source,
  /refetchInterval:\s*BILLING_STATUS_REFETCH_INTERVAL_MS/,
  'billing status query should use the named fallback interval',
);

assert.match(
  source,
  /refetchIntervalInBackground:\s*false/,
  'billing status should not poll while the tab is hidden',
);

assert.doesNotMatch(
  source,
  /refetchInterval:\s*30000/,
  'billing status should not poll every 30 seconds',
);

assert.match(
  source,
  /event:\s*'cad-job-updated'/,
  'CAD job completion should explicitly invalidate billing and message queries',
);

console.log('AuthProvider cost-control tests passed');
