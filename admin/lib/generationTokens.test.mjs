import assert from 'node:assert/strict';
import { displayGenerationTokens } from './generationTokens.ts';

assert.equal(displayGenerationTokens({ kind: 'parametric', tokens_used: 15 }), 25);
assert.equal(displayGenerationTokens({ kind: 'parametric', tokens_used: 50 }), 25);
assert.equal(displayGenerationTokens({ kind: 'parametric', tokens_used: null }), 25);
assert.equal(displayGenerationTokens({ kind: 'mesh', tokens_used: 61 }), 61);
assert.equal(displayGenerationTokens({ kind: 'image', tokens_used: null }), null);
