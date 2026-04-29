import assert from 'node:assert/strict';
import {
  FREE_DAILY_TOKENS,
  PLAN_CATALOG,
  PLAN_ORDER,
  TOKEN_PACK_CATALOG,
  getAnnualDiscountPercent,
} from './pricingCatalog.ts';
import { FEATURE_COSTS, TOKEN_USD_VALUE } from './tokenCosts.ts';

assert.equal(TOKEN_USD_VALUE, 0.01);

assert.deepEqual(PLAN_ORDER, ['free', 'standard', 'pro']);

assert.equal(FREE_DAILY_TOKENS, 50);
assert.equal(PLAN_CATALOG.free.monthlyPriceCents, 0);
assert.equal(PLAN_CATALOG.free.tokenAmount, null);

assert.equal(PLAN_CATALOG.standard.monthlyPriceCents, 1000);
assert.equal(PLAN_CATALOG.standard.yearlyPriceCents, 7200);
assert.equal(PLAN_CATALOG.standard.tokenAmount, 1000);

assert.equal(PLAN_CATALOG.pro.monthlyPriceCents, 4000);
assert.equal(PLAN_CATALOG.pro.yearlyPriceCents, 28800);
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
    ['tokens_500', 500, 500],
    ['tokens_1000', 1000, 1000],
    ['tokens_2500', 2500, 2500],
    ['tokens_5000', 5000, 5000],
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
    chat: 1,
    parametric: 5,
    generatedInputImage: 63,
    generatedInputImageNanoBanana: 15,
    multiviewFrontImage: 63,
    multiviewNanoBananaView: 15,
    fastMesh: 26,
    qualityMesh: 123,
    ultraMesh: 213,
    multiviewMesh: 258,
    upscaleMesh: 213,
  },
);
