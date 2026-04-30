import assert from 'node:assert/strict';
import { getCodeGenerationModelCandidates } from './parametricRouting.ts';

assert.deepEqual(getCodeGenerationModelCandidates('openai/gpt-5.5'), [
  'openai/gpt-5.5',
  'anthropic/claude-haiku-4.5',
]);

assert.deepEqual(
  getCodeGenerationModelCandidates('google/gemini-3.1-pro-preview'),
  ['google/gemini-3.1-pro-preview', 'anthropic/claude-haiku-4.5'],
);
