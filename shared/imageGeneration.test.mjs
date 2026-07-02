import assert from 'node:assert/strict';
import {
  DEFAULT_IMAGE_GENERATION_MODEL,
  IMAGE_GENERATION_MODELS,
  getImageGenerationFallbackModel,
  getImageGenerationProvider,
  getImageGenerationTokenCost,
  getOpenAiImageGenerationQuality,
  normalizeImageGenerationModel,
} from './imageGeneration.ts';

assert.equal(DEFAULT_IMAGE_GENERATION_MODEL, 'nano-banana-2');
assert.deepEqual(
  IMAGE_GENERATION_MODELS.map((model) => model.id),
  ['gpt-image-2', 'nano-banana-2', 'nano-banana-2-lite'],
);
assert.deepEqual(
  IMAGE_GENERATION_MODELS.map((model) => model.name),
  ['Image Gen 2', 'Nano Banana 2', 'Nano Banana 2 Lite'],
);
assert.deepEqual(
  IMAGE_GENERATION_MODELS.map((model) => model.description),
  [
    'Slow and usually better generations.',
    'Balanced speed and quality for most generations.',
    'Fastest and lowest-cost generations.',
  ],
);
// The legacy Normal tier stays out of the picker but keeps resolving.
assert.equal(
  IMAGE_GENERATION_MODELS.some((model) => model.id === 'nano-banana-pro'),
  false,
);

assert.equal(normalizeImageGenerationModel('gpt-image-2'), 'gpt-image-2');
assert.equal(
  normalizeImageGenerationModel('nano-banana-pro'),
  'nano-banana-pro',
);
assert.equal(normalizeImageGenerationModel('nano-banana-2'), 'nano-banana-2');
assert.equal(
  normalizeImageGenerationModel('nano-banana-2-lite'),
  'nano-banana-2-lite',
);
assert.equal(
  normalizeImageGenerationModel('nano-banana-lite'),
  'nano-banana-2-lite',
);
assert.equal(normalizeImageGenerationModel('openai'), 'gpt-image-2');
assert.equal(normalizeImageGenerationModel('nano-banana'), 'nano-banana-2');
assert.equal(normalizeImageGenerationModel(undefined), 'nano-banana-2');
assert.equal(normalizeImageGenerationModel('unknown-model'), 'nano-banana-2');

assert.equal(getImageGenerationProvider('gpt-image-2'), 'openai');
assert.equal(getImageGenerationProvider('nano-banana-pro'), 'nano-banana-pro');
assert.equal(getImageGenerationProvider('nano-banana-2'), 'nano-banana');
assert.equal(
  getImageGenerationProvider('nano-banana-2-lite'),
  'nano-banana-lite',
);

assert.equal(getOpenAiImageGenerationQuality('gpt-image-2'), 'high');
assert.equal(getOpenAiImageGenerationQuality('nano-banana-2'), 'high');

assert.equal(getImageGenerationTokenCost('gpt-image-2'), 22);
assert.equal(getImageGenerationTokenCost('nano-banana-pro'), 14);
assert.equal(getImageGenerationTokenCost('nano-banana-2'), 7);
assert.equal(getImageGenerationTokenCost('nano-banana-2-lite'), 4);

assert.equal(getImageGenerationFallbackModel('gpt-image-2'), 'nano-banana-2');
assert.equal(
  getImageGenerationFallbackModel('nano-banana-pro'),
  'nano-banana-2',
);
assert.equal(
  getImageGenerationFallbackModel('nano-banana-2'),
  'nano-banana-2-lite',
);
assert.equal(getImageGenerationFallbackModel('nano-banana-2-lite'), null);
