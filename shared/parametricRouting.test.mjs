import assert from 'node:assert/strict';
import {
  CLAUDE_FABLE_5_MODEL,
  DEFAULT_CODE_GENERATION_MODEL,
  GEMINI_31_PRO_MODEL,
  GEMINI_35_FLASH_MODEL,
  GPT_55_MODEL,
  GPT_56_SOL_MODEL,
  OPUS_48_MODEL,
  PARAMETRIC_MODEL_ROSTER,
  getCodeGenerationProviderCandidates,
  inspectionRoundsForModel,
  modelSupportsVision,
  normalizeParametricGenerationModel,
  outputTokenCapForModel,
} from './parametricRouting.ts';

assert.equal(GEMINI_35_FLASH_MODEL, 'google/gemini-3.5-flash');
assert.equal(GEMINI_31_PRO_MODEL, 'google/gemini-3.1-pro-preview');
assert.equal(CLAUDE_FABLE_5_MODEL, 'anthropic/claude-fable-5');
assert.equal(GPT_55_MODEL, 'openai/gpt-5.5');
assert.equal(GPT_56_SOL_MODEL, 'openai/gpt-5.6-sol');
assert.equal(OPUS_48_MODEL, 'anthropic/claude-opus-4.8');

assert.equal(DEFAULT_CODE_GENERATION_MODEL, GEMINI_35_FLASH_MODEL);

// Both current CAD tiers are selectable / accepted server-side.
const ALL_MODELS = [GEMINI_35_FLASH_MODEL, GPT_56_SOL_MODEL];
assert.deepEqual(
  Object.keys(PARAMETRIC_MODEL_ROSTER).sort(),
  [...ALL_MODELS].sort(),
);
for (const model of ALL_MODELS) {
  assert.equal(normalizeParametricGenerationModel(model), model);
}

// Per-model roster-derived helpers.
assert.equal(inspectionRoundsForModel(GEMINI_35_FLASH_MODEL), 1);
assert.equal(inspectionRoundsForModel(GPT_56_SOL_MODEL), 1);
assert.equal(inspectionRoundsForModel(GEMINI_31_PRO_MODEL), 0);
assert.equal(inspectionRoundsForModel(CLAUDE_FABLE_5_MODEL), 0);
assert.equal(inspectionRoundsForModel(GPT_55_MODEL), 0);
assert.equal(inspectionRoundsForModel(OPUS_48_MODEL), 0);
assert.equal(inspectionRoundsForModel('some/unknown'), 0);

assert.equal(outputTokenCapForModel(CLAUDE_FABLE_5_MODEL), 32000);
assert.equal(outputTokenCapForModel(GEMINI_35_FLASH_MODEL), 32000);
assert.equal(outputTokenCapForModel(GPT_55_MODEL), 32000);
assert.equal(outputTokenCapForModel(GPT_56_SOL_MODEL), 32000);
assert.equal(outputTokenCapForModel(OPUS_48_MODEL), 32000);
assert.equal(outputTokenCapForModel('some/unknown'), 32000);

for (const model of ALL_MODELS) {
  assert.equal(modelSupportsVision(model), true);
}

// The current Google-provider model takes the google-direct + OpenRouter fallback pair.
assert.deepEqual(getCodeGenerationProviderCandidates(GEMINI_35_FLASH_MODEL), [
  {
    provider: 'google',
    model: GEMINI_35_FLASH_MODEL.slice('google/'.length),
    usageModel: GEMINI_35_FLASH_MODEL,
  },
  {
    provider: 'openrouter',
    model: GEMINI_35_FLASH_MODEL,
    usageModel: GEMINI_35_FLASH_MODEL,
  },
]);

// OpenAI CAD Premium routes through OpenRouter with its exact model slug.
assert.deepEqual(getCodeGenerationProviderCandidates(GPT_56_SOL_MODEL), [
  {
    provider: 'openrouter',
    model: GPT_56_SOL_MODEL,
    usageModel: GPT_56_SOL_MODEL,
  },
]);

// Removed non-google models normalize to the configured CAD model.
for (const model of [CLAUDE_FABLE_5_MODEL, GPT_55_MODEL, OPUS_48_MODEL]) {
  assert.deepEqual(getCodeGenerationProviderCandidates(model), [
    {
      provider: 'google',
      model: DEFAULT_CODE_GENERATION_MODEL.slice('google/'.length),
      usageModel: DEFAULT_CODE_GENERATION_MODEL,
    },
    {
      provider: 'openrouter',
      model: DEFAULT_CODE_GENERATION_MODEL,
      usageModel: DEFAULT_CODE_GENERATION_MODEL,
    },
  ]);
}

// Unknown / non-roster ids fall back to the default CAD model.
for (const model of ['quality', '', 'deepseek/deepseek-v4-pro']) {
  assert.equal(
    normalizeParametricGenerationModel(model),
    DEFAULT_CODE_GENERATION_MODEL,
  );
  assert.deepEqual(getCodeGenerationProviderCandidates(model), [
    {
      provider: 'google',
      model: DEFAULT_CODE_GENERATION_MODEL.slice('google/'.length),
      usageModel: DEFAULT_CODE_GENERATION_MODEL,
    },
    {
      provider: 'openrouter',
      model: DEFAULT_CODE_GENERATION_MODEL,
      usageModel: DEFAULT_CODE_GENERATION_MODEL,
    },
  ]);
}
