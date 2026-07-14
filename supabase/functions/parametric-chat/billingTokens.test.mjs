import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

assert.match(
  source,
  /const tokenLedger = new DeferredTokenLedger\(billing\)/,
  'parametric chat should reserve generation credits without precharging',
);
assert.match(
  source,
  /const chatReferenceId = `\$\{newMessageId\}:chat`/,
  'parametric chat should use a deterministic message-scoped reservation',
);
assert.match(
  source,
  /await tokenLedger\.releaseReference\(\s*chatReferenceId,\s*logReservationFailure,\s*\)/s,
  'CAD builds should replace the chat reservation with the model-specific reservation',
);
assert.match(
  source,
  /tokens: getParametricBuildTokenCost\(model\)/,
  'the CAD build transaction itself should use the selected model token cost for admin generation rows',
);
assert.match(
  source,
  /await tokenLedger\.commitReference\(chargeReferenceId\)/,
  'the final charge should settle only after the assistant message was persisted',
);
assert.match(
  source,
  /startStreamHeartbeat\(controller\)/,
  'long-running CAD streams should emit heartbeats to avoid the relay idle timeout',
);
