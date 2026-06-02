import assert from 'node:assert/strict';
import { getCodeGenerationModelCandidates } from './parametricRouting.ts';

assert.deepEqual(getCodeGenerationModelCandidates('google/gemini-3.5-flash'), [
  'google/gemini-3.5-flash',
  'openai/gpt-5.5',
]);

assert.deepEqual(getCodeGenerationModelCandidates('openai/gpt-5.5'), [
  'openai/gpt-5.5',
]);
