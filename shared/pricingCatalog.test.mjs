import assert from 'node:assert/strict';
import {
  FREE_DAILY_TOKENS,
  PLAN_CATALOG,
  PLAN_ORDER,
  TOKEN_PACK_CATALOG,
  getAnnualDiscountPercent,
} from './pricingCatalog.ts';
import {
  FEATURE_COSTS,
  TOKEN_USD_VALUE,
  getParametricModelTokenCost,
} from './tokenCosts.ts';

assert.equal(TOKEN_USD_VALUE, 0.03);

assert.deepEqual(PLAN_ORDER, ['free', 'standard', 'pro']);

assert.equal(FREE_DAILY_TOKENS, 50);
assert.equal(PLAN_CATALOG.free.monthlyPriceCents, 0);
assert.equal(PLAN_CATALOG.free.tokenAmount, null);

assert.equal(PLAN_CATALOG.standard.monthlyPriceCents, 3000);
assert.equal(PLAN_CATALOG.standard.yearlyPriceCents, 21600);
assert.equal(PLAN_CATALOG.standard.tokenAmount, 1000);

assert.equal(PLAN_CATALOG.pro.monthlyPriceCents, 15000);
assert.equal(PLAN_CATALOG.pro.yearlyPriceCents, 108000);
assert.equal(PLAN_CATALOG.pro.tokenAmount, 5000);

assert.equal(getAnnualDiscountPercent('standard'), 40);
assert.equal(getAnnualDiscountPercent('pro'), 40);

assert.deepEqual(
  TOKEN_PACK_CATALOG.map((pack) => [
    pack.lookupKey,
    pack.tokenAmount,
    pack.priceCents,
  ]),
  [
    ['tokens_500', 500, 1500],
    ['tokens_1000', 1000, 3000],
    ['tokens_2500', 2500, 7500],
    ['tokens_5000', 5000, 15000],
  ],
);

assert.deepEqual(
  Object.fromEntries(
    Object.entries(FEATURE_COSTS).map(([key, feature]) => [
      key,
      feature.tokens,
    ]),
  ),
  {
    chat: 10,
    parametric: 35,
    parametricCadPro: 75,
    parametricCadLite: 20,
    parametricCadReasoning: 120,
    generatedInputImage: 22,
    generatedInputImageNanoBanana: 7,
    multiviewFrontImage: 22,
    multiviewNanoBananaView: 7,
    fastMesh: 41,
    qualityMesh: 34,
    ultraMesh: 122,
    multiviewMesh: 28,
    upscaleMesh: 76,
  },
);

assert.equal(getParametricModelTokenCost('openai/gpt-5.5'), 75);
assert.equal(getParametricModelTokenCost('google/gemini-3.1-pro-preview'), 20);
assert.equal(getParametricModelTokenCost('anthropic/claude-opus-4.7'), 120);
assert.equal(getParametricModelTokenCost('legacy-model'), 35);
