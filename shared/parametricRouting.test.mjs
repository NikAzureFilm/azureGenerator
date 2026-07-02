import assert from 'node:assert/strict';
import {
  CLAUDE_FABLE_5_MODEL,
  CODE_GENERATION_FALLBACK_MODELS,
  DEFAULT_CODE_GENERATION_MODEL,
  GEMINI_35_FLASH_MODEL,
  getCodeGenerationModelCandidates,
  normalizeParametricGenerationModel,
} from './parametricRouting.ts';

assert.equal(DEFAULT_CODE_GENERATION_MODEL, 'google/gemini-3.5-flash');
assert.equal(GEMINI_35_FLASH_MODEL, 'google/gemini-3.5-flash');
assert.equal(CLAUDE_FABLE_5_MODEL, 'anthropic/claude-fable-5');
assert.deepEqual(CODE_GENERATION_FALLBACK_MODELS, [
  'openai/gpt-5.5',
  'anthropic/claude-haiku-4.5',
]);

for (const model of [DEFAULT_CODE_GENERATION_MODEL, CLAUDE_FABLE_5_MODEL]) {
  assert.equal(normalizeParametricGenerationModel(model), model);
  assert.deepEqual(getCodeGenerationModelCandidates(model), [
    model,
    ...CODE_GENERATION_FALLBACK_MODELS,
  ]);
}

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
  assert.deepEqual(getCodeGenerationModelCandidates(model), [
    DEFAULT_CODE_GENERATION_MODEL,
    ...CODE_GENERATION_FALLBACK_MODELS,
  ]);
}

assert.deepEqual(
  new Set(getCodeGenerationModelCandidates(DEFAULT_CODE_GENERATION_MODEL)).size,
  getCodeGenerationModelCandidates(DEFAULT_CODE_GENERATION_MODEL).length,
);
