import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

assert.match(source, /new DeferredTokenLedger\(billing\)/);
assert.match(source, /const chatReferenceId = `\$\{newMessageId\}:chat`/);
assert.match(source, /tokenLedger\.reserve\(userData\.user\.email/);
assert.match(source, /await tokenLedger\.commitReference\(chatReferenceId\)/);
assert.match(source, /startStreamHeartbeat\(controller\)/);

const persistIndex = source.indexOf(
  'let finalMessageData = await persistContent(content);',
);
const settleIndex = source.indexOf(
  'await tokenLedger.commitReference(chatReferenceId)',
);
assert.ok(
  persistIndex >= 0 && settleIndex > persistIndex,
  'agent chat should charge only after its final message was persisted',
);

console.log('agent deferred billing tests passed');
