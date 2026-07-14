import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

assert.match(source, /declare const EdgeRuntime:\s*\{/);
assert.match(source, /async function runTextToCadJob\(/);
assert.match(source, /EdgeRuntime\.waitUntil\(\s*runTextToCadJob\(/);
assert.match(source, /function isRetryableTextToCadWorkerError\(/);
assert.match(source, /timed out\|timeout/i);
assert.match(source, /new DeferredTokenLedger\(billing\)/);
assert.match(source, /tokenLedger\.reserve\(/);
assert.match(source, /tokenLedger\.commitReference\(jobId\)/);

const persistSuccessIndex = source.indexOf('content: successContent');
const settleSuccessIndex = source.indexOf('tokenLedger.commitReference(jobId)');
assert.ok(
  persistSuccessIndex >= 0 && settleSuccessIndex > persistSuccessIndex,
  'CAD credits should settle only after success content was persisted',
);

const waitUntilIndex = source.indexOf('EdgeRuntime.waitUntil(');
const immediateReturnIndex = source.indexOf(
  'return jsonResponse({ message: assistantMessage });',
  waitUntilIndex,
);

assert.ok(
  immediateReturnIndex > waitUntilIndex,
  'cad-chat should return the pending assistant message immediately after scheduling background work',
);

console.log('cadChatBackground tests passed');
