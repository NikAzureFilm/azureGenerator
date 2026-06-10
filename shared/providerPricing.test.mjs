import assert from 'node:assert/strict';
import { LLM_PRICES, llmCostUsd } from './providerPricing.ts';

assert.deepEqual(LLM_PRICES['anthropic/claude-fable-5'], {
  inputPerM: 10,
  outputPerM: 50,
});

assert.equal(
  llmCostUsd('anthropic/claude-fable-5', 1_000_000, 1_000_000),
  60,
);
