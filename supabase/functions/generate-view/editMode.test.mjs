import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const generateViewSource = readFileSync(
  fileURLToPath(new URL('./index.ts', import.meta.url)),
  'utf8',
);
const imageGenSource = readFileSync(
  fileURLToPath(new URL('../_shared/imageGen.ts', import.meta.url)),
  'utf8',
);
const viewPromptSource = readFileSync(
  fileURLToPath(new URL('../_shared/viewPrompt.ts', import.meta.url)),
  'utf8',
);
const fallbackSource = readFileSync(
  fileURLToPath(
    new URL('../../../src/utils/generateViewWithFallback.ts', import.meta.url),
  ),
  'utf8',
);

// generate-view accepts the new edit-mode body fields.
assert.equal(
  generateViewSource.includes('maskImageId') &&
    generateViewSource.includes('markedImageId'),
  true,
  'generate-view must destructure maskImageId and markedImageId',
);

// Edit mode is gated by a single flag and validated (prompt + ref + both masks).
assert.equal(
  generateViewSource.includes("const isEditMode = mode === 'edit'"),
  true,
  'generate-view must derive isEditMode from mode',
);
assert.equal(
  generateViewSource.includes(
    'maskImageId and markedImageId required for edit',
  ),
  true,
  'generate-view must 400 when edit mode is missing a mask artifact',
);
assert.equal(
  generateViewSource.includes('source refImageId required for edit'),
  true,
  'generate-view must 400 when edit mode has no source reference',
);
assert.equal(
  generateViewSource.includes('prompt required for edit'),
  true,
  'generate-view must 400 when edit mode has no instruction',
);

// OpenAI path forwards the mask id only in edit mode.
assert.equal(
  generateViewSource.includes('isEditMode ? maskImageId : null'),
  true,
  'generate-view must pass the mask id to gpt-image-2 only for edits',
);

// Gemini path is fed [source, marked] and the red-marking instruction.
assert.equal(
  generateViewSource.includes('[primaryRefImageId, markedImageId]'),
  true,
  'generate-view flash path must sign source + marked composite for edits',
);
assert.equal(
  generateViewSource.includes('painted in translucent red'),
  true,
  'generate-view must tell Gemini how to read the marked composite',
);

// Legacy nano-banana-pro edits route to the flash edit path.
assert.match(
  generateViewSource,
  /const generateWithNormalOrLite[\s\S]{0,200}if \(isEditMode\)[\s\S]{0,80}generateWithNanoBanana2OrLite\(\)/,
  'nano-banana-pro edits must route to the Nano Banana 2 flash edit path',
);

// The stored images row carries the edit provenance (both artifacts).
assert.equal(
  generateViewSource.includes('isEditMode && maskImageId && { maskImageId }'),
  true,
  'generate-view must record maskImageId on the images row for edits',
);
assert.equal(
  generateViewSource.includes(
    'isEditMode && markedImageId && { markedImageId }',
  ),
  true,
  'generate-view must record markedImageId on the images row for edits',
);

// imageGen forwards the mask to the image_generation tool via input_image_mask.
assert.equal(
  imageGenSource.includes('maskImageId?: string | null'),
  true,
  'generateImageWithGptImage2 must accept an optional maskImageId',
);
assert.equal(
  imageGenSource.includes('input_image_mask'),
  true,
  'gpt-image-2 tool config must pass the alpha mask via input_image_mask',
);
// Edit mode must not pin a square output size (breaks non-square alignment);
// it lets the model size automatically to match the source aspect ratio.
assert.match(
  imageGenSource,
  /size: maskBase64 \? 'auto' : '1024x1024'/,
  'gpt-image-2 must use auto size for edits and stay square otherwise',
);

// viewPrompt exposes the edit mode and its region-locked contract.
assert.equal(
  viewPromptSource.includes("'input' | 'multiview' | 'edit'"),
  true,
  'ImageGenerationMode must include edit',
);
assert.equal(
  viewPromptSource.includes('ONLY inside the user-marked region'),
  true,
  'edit prompt must constrain changes to the marked region',
);

// The fallback body builder must carry the mask ids through every retry.
assert.equal(
  fallbackSource.includes('maskImageId?: string') &&
    fallbackSource.includes('markedImageId?: string'),
  true,
  'GenerateViewBody must include the edit mask ids so they survive fallback',
);

console.log('generate-view edit-mode source checks passed');
