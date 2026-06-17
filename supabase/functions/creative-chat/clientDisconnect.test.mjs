import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

assert.doesNotMatch(
  source,
  /req\.signal\.addEventListener\('abort'[\s\S]*?abortController\.abort/s,
  'browser navigation or hard refresh should not explicitly cancel a creative generation',
);

assert.match(
  source,
  /cancel-request-\$\{messageId\}/,
  'explicit Stop generation requests should still use the cancellation channel',
);

console.log('creative-chat client disconnect tests passed');
