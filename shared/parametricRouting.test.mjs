import assert from 'node:assert/strict';
import {
  CLAUDE_FABLE_5_MODEL,
  DEFAULT_CODE_GENERATION_MODEL,
  GEMINI_35_FLASH_MODEL,
  getCodeGenerationProviderCandidates,
  normalizeParametricGenerationModel,
} from './parametricRouting.ts';

assert.equal(DEFAULT_CODE_GENERATION_MODEL, 'google/gemini-3.5-flash');
assert.equal(GEMINI_35_FLASH_MODEL, 'google/gemini-3.5-flash');
assert.equal(CLAUDE_FABLE_5_MODEL, 'anthropic/claude-fable-5');

for (const model of [DEFAULT_CODE_GENERATION_MODEL, CLAUDE_FABLE_5_MODEL]) {
  assert.equal(normalizeParametricGenerationModel(model), model);
}

assert.deepEqual(getCodeGenerationProviderCandidates(GEMINI_35_FLASH_MODEL), [
  {
    provider: 'google',
    model: 'gemini-3.5-flash',
    usageModel: GEMINI_35_FLASH_MODEL,
  },
  {
    provider: 'openrouter',
    model: GEMINI_35_FLASH_MODEL,
    usageModel: GEMINI_35_FLASH_MODEL,
  },
]);

assert.deepEqual(getCodeGenerationProviderCandidates(CLAUDE_FABLE_5_MODEL), [
  {
    provider: 'openrouter',
    model: CLAUDE_FABLE_5_MODEL,
    usageModel: CLAUDE_FABLE_5_MODEL,
  },
]);

for (const model of [
  'google/gemini-3.1-pro-preview',
  'openai/gpt-5.5',
  'quality',
  '',
]) {
  assert.equal(
    normalizeParametricGenerationModel(model),
    DEFAULT_CODE_GENERATION_MODEL,
  );
  assert.deepEqual(getCodeGenerationProviderCandidates(model), [
    {
      provider: 'google',
      model: 'gemini-3.5-flash',
      usageModel: DEFAULT_CODE_GENERATION_MODEL,
    },
    {
      provider: 'openrouter',
      model: DEFAULT_CODE_GENERATION_MODEL,
      usageModel: DEFAULT_CODE_GENERATION_MODEL,
    },
  ]);
}
