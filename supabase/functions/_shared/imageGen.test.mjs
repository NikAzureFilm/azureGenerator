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
assert.match(
  imageGenSource,
  /const OPENAI_IMAGE_ORCHESTRATOR_MODEL = 'gpt-5\.5';/,
  'OpenAI image generation uses a Responses model that supports the image_generation tool',
);
assert.match(
  imageGenSource,
  /const OPENAI_IMAGE_MODEL = 'gpt-image-2';/,
  'OpenAI image generation invokes gpt-image-2 through the hosted image tool',
);
assert.doesNotMatch(
  imageGenSource,
  /gemini-3\.1-flash-image-preview/,
  'Lite image generation does not call an unavailable Gemini 3.1 image model',
);
assert.doesNotMatch(
  imageGenSource,
  /model: 'gpt-5\.4'/,
  'OpenAI image generation does not use an unsupported gpt-5.4 Responses model',
);
assert.doesNotMatch(
  imageGenSource,
  /result: null,\s+status: 'completed'/,
  'Prior image_generation_call references only pass the documented call id',
);
