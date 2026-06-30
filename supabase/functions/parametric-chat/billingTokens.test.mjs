import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

assert.match(
  source,
  /const chatReferenceId = crypto\.randomUUID\(\)/,
  'parametric chat should keep the initial chat precharge reference',
);
assert.match(
  source,
  /referenceId: chatReferenceId/,
  'parametric chat should charge the initial chat precharge with the tracked reference',
);
assert.match(
  source,
  /await tokenLedger\.refundReference\(\s*chatReferenceId,\s*logRefundFailure,\s*\)/s,
  'successful CAD builds should refund the initial chat precharge so the total CAD generation cost stays 25',
);
assert.match(
  source,
  /tokens: getParametricBuildTokenCost\(model\)/,
  'the CAD build transaction itself should be 25 tokens for admin generation rows',
);
