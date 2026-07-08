import assert from 'node:assert/strict';
import {
  chunk,
  classifyGenerationTier,
  formatGenerationMargin,
  percentile,
  summarizeGenerationCosts,
} from './generationCosts.ts';
import {
  CAD_LITE_MODEL_ID,
  CAD_PREMIUM_MODEL_ID,
} from './generationModels.ts';

// --- chunk ------------------------------------------------------------------
assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
assert.deepEqual(chunk([], 100), []);
assert.deepEqual(chunk([1, 2, 3], 100), [[1, 2, 3]]);
assert.deepEqual(chunk([1, 2, 3], 0), [[1, 2, 3]]);
// A page of 250 ids batches into three .in() queries of <=100.
assert.equal(chunk(Array.from({ length: 250 }, (_, i) => i), 100).length, 3);

// --- formatGenerationMargin -------------------------------------------------
assert.deepEqual(formatGenerationMargin(0.23, 50), {
  costText: '$0.23',
  budgetText: '$0.50',
  overBudget: false,
});
assert.deepEqual(formatGenerationMargin(0.6, 15), {
  costText: '$0.60',
  budgetText: '$0.15',
  overBudget: true,
});
// Exactly on budget is not over budget.
assert.equal(formatGenerationMargin(0.5, 50).overBudget, false);
// Unknown charged tokens (mesh/image) -> no budget to compare against.
assert.deepEqual(formatGenerationMargin(0.12, null), {
  costText: '$0.12',
  budgetText: '—',
  overBudget: false,
});

// --- classifyGenerationTier -------------------------------------------------
assert.equal(classifyGenerationTier(CAD_PREMIUM_MODEL_ID), 'premium');
assert.equal(classifyGenerationTier(CAD_LITE_MODEL_ID), 'lite');
assert.equal(classifyGenerationTier('anthropic/claude-fable-5'), 'premium');
assert.equal(classifyGenerationTier('google/gemini-3.5-flash'), 'lite');
assert.equal(classifyGenerationTier('some-other-model'), 'other');
assert.equal(classifyGenerationTier(null), 'other');
assert.equal(classifyGenerationTier(''), 'other');

// --- percentile -------------------------------------------------------------
assert.equal(percentile([], 90), 0);
assert.equal(percentile([5], 90), 5);
assert.equal(percentile([1, 2, 3, 4, 5], 0), 1);
assert.equal(percentile([1, 2, 3, 4, 5], 100), 5);
assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
// p90 of 1..10 (interpolated): rank = 0.9*9 = 8.1 -> between 9 and 10.
assert.ok(
  Math.abs(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90) - 9.1) < 1e-9,
);

// --- summarizeGenerationCosts -----------------------------------------------
// Two generations: one premium (two rows share a reference_id and are summed),
// one lite. Rows without a reference_id are ignored.
const summary = summarizeGenerationCosts([
  { reference_id: 'gen-a', cost_usd: '0.10', model: CAD_PREMIUM_MODEL_ID },
  { reference_id: 'gen-a', cost_usd: 0.15, model: CAD_PREMIUM_MODEL_ID },
  { reference_id: 'gen-b', cost_usd: '0.05', model: CAD_LITE_MODEL_ID },
  { reference_id: null, cost_usd: '9.99', model: CAD_PREMIUM_MODEL_ID },
]);
assert.equal(summary.count, 2);
assert.ok(Math.abs(summary.totalUsd - 0.3) < 1e-9);
assert.ok(Math.abs(summary.avgUsd - 0.15) < 1e-9);
assert.equal(summary.premium.count, 1);
assert.ok(Math.abs(summary.premium.totalUsd - 0.25) < 1e-9);
assert.ok(Math.abs(summary.premium.avgUsd - 0.25) < 1e-9);
assert.equal(summary.lite.count, 1);
assert.ok(Math.abs(summary.lite.totalUsd - 0.05) < 1e-9);

// A generation that mixes a premium row and a lite row classifies as premium.
const mixed = summarizeGenerationCosts([
  { reference_id: 'gen-c', cost_usd: 0.2, model: CAD_LITE_MODEL_ID },
  { reference_id: 'gen-c', cost_usd: 0.3, model: CAD_PREMIUM_MODEL_ID },
]);
assert.equal(mixed.premium.count, 1);
assert.equal(mixed.lite.count, 0);
assert.ok(Math.abs(mixed.premium.totalUsd - 0.5) < 1e-9);

// Empty input yields zeroed stats, not a throw.
const empty = summarizeGenerationCosts([]);
assert.equal(empty.count, 0);
assert.equal(empty.avgUsd, 0);
assert.equal(empty.p90Usd, 0);
assert.equal(empty.premium.count, 0);
assert.equal(empty.lite.count, 0);

console.log('generationCosts.test.mjs OK');
