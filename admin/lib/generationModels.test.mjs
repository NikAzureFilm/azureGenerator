import assert from 'node:assert/strict';
import {
  CAD_LITE_MODEL_ID,
  CAD_PREMIUM_MODEL_ID,
  cadModelDisplayText,
  cadTokensForModel,
  extractGenerationModelId,
  generationModelDisplay,
} from './generationModels.ts';
import {
  CLAUDE_FABLE_5_MODEL,
  GEMINI_35_FLASH_MODEL,
} from '../../shared/parametricRouting.ts';
import {
  CAD_LITE_GENERATION_TOKEN_COST,
  CAD_PREMIUM_GENERATION_TOKEN_COST,
} from '../../shared/tokenCosts.ts';

assert.equal(CAD_PREMIUM_MODEL_ID, CLAUDE_FABLE_5_MODEL);
assert.equal(CAD_LITE_MODEL_ID, GEMINI_35_FLASH_MODEL);
assert.equal(
  cadTokensForModel(CAD_PREMIUM_MODEL_ID),
  CAD_PREMIUM_GENERATION_TOKEN_COST,
);
assert.equal(
  cadTokensForModel(CAD_LITE_MODEL_ID),
  CAD_LITE_GENERATION_TOKEN_COST,
);
assert.equal(cadTokensForModel('legacy-model'), CAD_LITE_GENERATION_TOKEN_COST);
assert.equal(cadTokensForModel(undefined), null);

assert.equal(
  cadModelDisplayText(CAD_PREMIUM_MODEL_ID),
  'Legacy / Claude Fable 5',
);
assert.equal(
  cadModelDisplayText(CAD_LITE_MODEL_ID),
  'CAD Model / Gemini 3.5 Flash',
);

assert.equal(
  extractGenerationModelId({
    kind: 'parametric',
    prompt: { model: CAD_PREMIUM_MODEL_ID },
  }),
  CAD_PREMIUM_MODEL_ID,
);
assert.equal(
  extractGenerationModelId({
    kind: 'mesh',
    prompt: { model: CAD_PREMIUM_MODEL_ID },
  }),
  null,
);

assert.deepEqual(
  generationModelDisplay({
    kind: 'cad',
    prompt: { model: CAD_LITE_MODEL_ID },
  }),
  {
    id: CAD_LITE_MODEL_ID,
    tier: 'CAD Model',
    name: 'Gemini 3.5 Flash',
    tokens: CAD_LITE_GENERATION_TOKEN_COST,
  },
);
