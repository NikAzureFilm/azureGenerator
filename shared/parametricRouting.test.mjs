import assert from 'node:assert/strict';
import {
  CODE_GENERATION_FALLBACK_MODELS,
  DEFAULT_CODE_GENERATION_MODEL,
  getCodeGenerationModelCandidates,
  normalizeParametricGenerationModel,
} from './parametricRouting.ts';

assert.equal(DEFAULT_CODE_GENERATION_MODEL, 'google/gemini-3.1-pro-preview');
assert.deepEqual(CODE_GENERATION_FALLBACK_MODELS, []);

for (const model of [
  'google/gemini-3.1-pro-preview',
  'google/gemini-3.5-flash',
  'openai/gpt-5.5',
  'anthropic/claude-fable-5',
  'quality',
  '',
]) {
  assert.equal(
    normalizeParametricGenerationModel(model),
    DEFAULT_CODE_GENERATION_MODEL,
  );
  assert.deepEqual(getCodeGenerationModelCandidates(model), [
    DEFAULT_CODE_GENERATION_MODEL,
  ]);
}
