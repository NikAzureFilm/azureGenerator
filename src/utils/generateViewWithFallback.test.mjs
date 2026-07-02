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
  'Image Gen 2 should retry with Nano Banana 2 after an OpenAI provider failure',
);
assert.deepEqual(
  calls.map((call) => call.imageGenerationModel),
  ['gpt-image-2', 'nano-banana-2'],
  'generate-view should receive the selected image generation model id',
);

const liteChainCalls = [];
const liteChainResult = await invokeGenerateViewWithFallback(
  async (body) => {
    liteChainCalls.push(body);
    if (body.provider === 'nano-banana') {
      return { data: null, error: new Error('Edge Function returned non-2xx') };
    }
    return {
      data: { id: 'chain-image-id', url: 'https://example.test/chain.jpg' },
    };
  },
  {
    conversationId: 'conversation-id',
    view: 'front',
    prompt: 'simple centered cone',
    mode: 'input',
  },
  'nano-banana-2',
);

assert.equal(liteChainResult.data.id, 'chain-image-id');
assert.deepEqual(
  liteChainCalls.map((call) => call.provider),
  ['nano-banana', 'nano-banana-lite'],
  'Nano Banana 2 should retry with Nano Banana 2 Lite after a provider failure',
);

const normalCalls = [];
const normalResult = await invokeGenerateViewWithFallback(
  async (body) => {
    normalCalls.push(body);
    return {
      data: { id: 'normal-image-id', url: 'https://example.test/normal.jpg' },
    };
  },
  {
    conversationId: 'conversation-id',
    view: 'front',
    prompt: 'simple centered cylinder',
    mode: 'input',
  },
  'nano-banana-pro',
);

assert.equal(normalResult.data.id, 'normal-image-id');
assert.deepEqual(
  normalCalls.map((call) => call.provider),
  ['nano-banana-pro'],
  'Normal generation should route directly to the Normal provider',
);

const liteCalls = [];
const liteResult = await invokeGenerateViewWithFallback(
  async (body) => {
    liteCalls.push(body);
    return {
      data: { id: 'lite-image-id', url: 'https://example.test/lite.jpg' },
    };
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
