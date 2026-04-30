import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const imageGenSource = readFileSync(
  new URL('./imageGen.ts', import.meta.url),
  'utf8',
);

assert.match(
  imageGenSource,
  /const GEMINI_FLASH_IMAGE_MODEL = 'gemini-2\.5-flash-image';/,
  'Lite image generation uses the documented Nano Banana model id',
);
assert.doesNotMatch(
  imageGenSource,
  /gemini-3\.1-flash-image-preview/,
  'Lite image generation does not call an unavailable Gemini 3.1 image model',
);
