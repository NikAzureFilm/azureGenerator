import assert from 'node:assert/strict';
import {
  DEFAULT_IMAGE_GENERATION_MODEL,
  IMAGE_GENERATION_MODELS,
  getImageGenerationProvider,
  normalizeImageGenerationModel,
} from './imageGeneration.ts';

assert.equal(DEFAULT_IMAGE_GENERATION_MODEL, 'gpt-image-2');
assert.deepEqual(
  IMAGE_GENERATION_MODELS.map((model) => model.id),
  ['gpt-image-2', 'nano-banana-2'],
);

assert.equal(normalizeImageGenerationModel('gpt-image-2'), 'gpt-image-2');
assert.equal(normalizeImageGenerationModel('nano-banana-2'), 'nano-banana-2');
assert.equal(normalizeImageGenerationModel('openai'), 'gpt-image-2');
assert.equal(normalizeImageGenerationModel('nano-banana'), 'nano-banana-2');
assert.equal(normalizeImageGenerationModel(undefined), 'gpt-image-2');
assert.equal(normalizeImageGenerationModel('unknown-model'), 'gpt-image-2');

assert.equal(getImageGenerationProvider('gpt-image-2'), 'openai');
assert.equal(getImageGenerationProvider('nano-banana-2'), 'nano-banana');
