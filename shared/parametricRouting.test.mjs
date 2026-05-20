import assert from 'node:assert/strict';
import { getCodeGenerationModelCandidates } from './parametricRouting.ts';

assert.deepEqual(getCodeGenerationModelCandidates('google/gemini-3.5-flash'), [
  'google/gemini-3.5-flash',
  'anthropic/claude-haiku-4.5',
]);

assert.deepEqual(
  getCodeGenerationModelCandidates('anthropic/claude-haiku-4.5'),
  ['anthropic/claude-haiku-4.5'],
);
