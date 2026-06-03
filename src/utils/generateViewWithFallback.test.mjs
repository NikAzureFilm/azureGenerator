import assert from 'node:assert/strict';
import { invokeGenerateViewWithFallback } from './generateViewWithFallback.ts';

const calls = [];
const result = await invokeGenerateViewWithFallback(
  async (body) => {
    calls.push(body);
    if (body.provider === 'openai') {
      return { data: null, error: new Error('Edge Function returned non-2xx') };
    }
    return { data: { id: 'image-id', url: 'https://example.test/image.jpg' } };
  },
  {
    conversationId: 'conversation-id',
    view: 'front',
    prompt: 'simple centered cube',
    mode: 'input',
  },
  'gpt-image-2',
);

assert.equal(result.error, undefined);
assert.equal(result.data.id, 'image-id');
assert.deepEqual(
  calls.map((call) => call.provider),
  ['openai', 'nano-banana'],
  'Premium generation should retry with Lite after an OpenAI provider failure',
);

const liteCalls = [];
const liteResult = await invokeGenerateViewWithFallback(
  async (body) => {
    liteCalls.push(body);
    return { data: { id: 'lite-image-id', url: 'https://example.test/lite.jpg' } };
  },
  {
    conversationId: 'conversation-id',
    view: 'front',
    prompt: 'simple centered sphere',
    mode: 'input',
  },
  'nano-banana-2',
);

assert.equal(liteResult.data.id, 'lite-image-id');
assert.deepEqual(
  liteCalls.map((call) => call.provider),
  ['nano-banana'],
  'Lite generation should not make an unnecessary Premium request',
);
