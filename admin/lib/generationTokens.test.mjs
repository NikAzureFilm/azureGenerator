import assert from 'node:assert/strict';
import { displayGenerationTokens } from './generationTokens.ts';

assert.equal(displayGenerationTokens({ kind: 'parametric', tokens_used: 15 }), 25);
assert.equal(displayGenerationTokens({ kind: 'parametric', tokens_used: 50 }), 25);
assert.equal(displayGenerationTokens({ kind: 'parametric', tokens_used: null }), 25);
assert.equal(displayGenerationTokens({ kind: 'mesh', tokens_used: 61 }), 61);
assert.equal(displayGenerationTokens({ kind: 'image', tokens_used: null }), null);
assert.equal(
  displayGenerationTokens({
    kind: 'image',
    tokens_used: null,
    prompt: { source: 'generate-view', imageGenerationModel: 'gpt-image-2' },
  }),
  22,
);
assert.equal(
  displayGenerationTokens({
    kind: 'image',
    tokens_used: null,
    asset_metadata: {
      source: 'generate-view',
      imageGenerationModel: 'nano-banana-pro',
    },
  }),
  14,
);
assert.equal(
  displayGenerationTokens({
    kind: 'image',
    tokens_used: null,
    asset_metadata: {
      source: 'generate-view',
      imageGenerationModel: 'nano-banana-2',
    },
  }),
  7,
);
assert.equal(
  displayGenerationTokens({
    kind: 'image',
    tokens_used: null,
    prompt: { imageGenerationModel: 'gpt-image-2' },
    asset_metadata: { source: 'mesh', model: 'ultra' },
  }),
  null,
);
