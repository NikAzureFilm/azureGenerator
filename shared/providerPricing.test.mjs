import assert from 'node:assert/strict';
import {
  GEMINI_IMAGE_PRICES,
  FAL_UNIT_PRICES,
  LLM_PRICES,
  OPENAI_IMAGE_PRICES,
  falCostUsd,
  geminiImageCostUsd,
  llmCostUsd,
  openaiImageCostUsd,
} from './providerPricing.ts';

assert.deepEqual(LLM_PRICES['anthropic/claude-fable-5'], {
  inputPerM: 10,
  outputPerM: 50,
});

assert.equal(llmCostUsd('anthropic/claude-fable-5', 1_000_000, 1_000_000), 60);
assert.deepEqual(LLM_PRICES['anthropic/claude-opus-4.8'], {
  inputPerM: 5,
  outputPerM: 25,
});
assert.equal(llmCostUsd('anthropic/claude-opus-4.8', 1_000_000, 1_000_000), 30);
assert.deepEqual(LLM_PRICES['google/gemini-3.1-pro-preview'], {
  inputPerM: 1.25,
  outputPerM: 10,
});
assert.equal(
  llmCostUsd('google/gemini-3.1-pro-preview', 1_000_000, 1_000_000),
  11.25,
);
assert.deepEqual(LLM_PRICES['openai/gpt-5.6-sol'], {
  inputPerM: 5,
  outputPerM: 30,
  cachedInputPerM: 0.5,
});
assert.equal(llmCostUsd('openai/gpt-5.6-sol', 1_000_000, 1_000_000), 35);

assert.deepEqual(OPENAI_IMAGE_PRICES, {
  low: 0.006,
  medium: 0.053,
  high: 0.211,
});
assert.equal(openaiImageCostUsd('low'), 0.006);
assert.equal(openaiImageCostUsd('medium'), 0.053);
assert.equal(openaiImageCostUsd('high', 2), 0.422);

assert.deepEqual(GEMINI_IMAGE_PRICES, {
  'gemini-3.1-flash-image-preview': 0.067,
  'gemini-3.1-flash-image': 0.067,
  'gemini-3.1-flash-lite-image-preview': 0.0336,
  'gemini-3.1-flash-lite-image': 0.0336,
  'gemini-3-pro-image-preview': 0.134,
  'gemini-3-pro-image': 0.134,
});
assert.equal(geminiImageCostUsd('gemini-3.1-flash-image-preview'), 0.067);
assert.equal(geminiImageCostUsd('gemini-3.1-flash-lite-image'), 0.0336);
assert.equal(geminiImageCostUsd('gemini-3-pro-image-preview'), 0.134);
assert.equal(geminiImageCostUsd('gemini-3-pro-image-preview', 2), 0.268);
assert.equal(geminiImageCostUsd('unknown-google-image-model'), 0.067);

assert.deepEqual(FAL_UNIT_PRICES['fal-ai/meshy/v6-preview/image-to-3d'], {
  unitPrice: 0.8,
  unit: 'units',
});
assert.equal(falCostUsd('fal-ai/meshy/v6-preview/image-to-3d'), 0.8);
