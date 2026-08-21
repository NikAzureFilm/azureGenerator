import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const imageGenSource = readFileSync(
  new URL('./imageGen.ts', import.meta.url),
  'utf8',
);

assert.match(
  imageGenSource,
  /const GEMINI_FLASH_IMAGE_MODEL = 'gemini-3\.1-flash-image-preview';/,
  'Lite image generation uses the configured image endpoint',
);
assert.match(
  imageGenSource,
  /generateImageWithGeminiFlash = async \([\s\S]*?usageCtx\?: ImageUsageCtx/,
  'Lite image generation should accept provider usage context',
);
assert.match(
  imageGenSource,
  /generateImageWithGeminiFlashEdit = async \([\s\S]*?usageCtx\?: ImageUsageCtx/,
  'Lite image editing should accept provider usage context',
);
assert.match(
  imageGenSource,
  /const GEMINI_IMAGE_ASPECT_RATIO = '16:9';/,
  'Nano Banana image generation should use a widescreen aspect ratio',
);
assert.equal(
  imageGenSource.match(
    /imageConfig:\s*\{\s*aspectRatio: GEMINI_IMAGE_ASPECT_RATIO/g,
  )?.length,
  3,
  'Nano Banana Pro, generation, and editing should all request 16:9 output',
);
assert.match(
  imageGenSource,
  /await logGeminiImage\(\{\s*\.\.\.usageCtx,\s*model\s*\}\);/,
  'Lite image generation should log provider-specific cost',
);
assert.match(
  imageGenSource,
  /const OPENAI_IMAGE_ORCHESTRATOR_MODEL = 'gpt-5\.5';/,
  'Premium image generation uses the configured orchestration endpoint',
);
assert.match(
  imageGenSource,
  /const OPENAI_IMAGE_MODEL = 'gpt-image-2';/,
  'Premium image generation invokes the configured hosted image tool',
);
assert.doesNotMatch(
  imageGenSource,
  /const GEMINI_FLASH_IMAGE_MODEL = 'gemini-3-flash-image';/,
  'Lite image generation does not call an unavailable image endpoint',
);
assert.doesNotMatch(
  imageGenSource,
  /model: 'gpt-5\.4'/,
  'Premium image generation does not use an unsupported endpoint',
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
  'Fallback prompt provider should enforce 3D object output before enhancing prompts',
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
