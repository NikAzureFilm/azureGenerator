import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const imageGenSource = readFileSync(
  new URL('./imageGen.ts', import.meta.url),
  'utf8',
);

assert.match(
  imageGenSource,
  /const GEMINI_FLASH_IMAGE_MODEL = 'gemini-3\.1-flash-image-preview';/,
  'Lite image generation uses the available Gemini 3.1 Flash Image model',
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
  /const GEMINI_FLASH_IMAGE_MODEL = 'gemini-3-flash-image';/,
  'Lite image generation does not call the unavailable gemini-3-flash-image model id',
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
assert.match(
  imageGenSource,
  /import \{\s*enforce3DObjectPrompt/,
  'image generation providers should import global 3D object prompt enforcement',
);
assert.match(
  imageGenSource,
  /const enforcedPrompt = enforce3DObjectPrompt\(prompt\);/,
  'direct prompt providers should enforce 3D object output before calling image models',
);
assert.match(
  imageGenSource,
  /const enforcedPrompt = enforce3DObjectPrompt\(promptText\);/,
  'Flux prompt provider should enforce 3D object output before enhancing prompts',
);
assert.match(
  imageGenSource,
  /watertight/i,
  'mesh image instructions should request watertight printable forms',
);
assert.match(
  imageGenSource,
  /manifold/i,
  'mesh image instructions should request manifold printable forms',
);
assert.match(
  imageGenSource,
  /minimum wall thickness/i,
  'mesh image instructions should steer away from fragile, unprintable thin walls',
);
assert.match(
  imageGenSource,
  /print bed/i,
  'mesh image instructions should ask for stable build-plate contact',
);
assert.match(
  imageGenSource,
  /no cast shadows, no ground shadows/i,
  'mesh image instructions should tell image generators to avoid shadows',
);
assert.doesNotMatch(
  imageGenSource,
  /soft shadow directly under/i,
  'mesh image instructions should not ask for shadows beneath generated models',
);
