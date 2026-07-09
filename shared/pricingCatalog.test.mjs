import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  FREE_STARTER_TOKENS,
  PLAN_CATALOG,
  PLAN_ORDER,
  TOKEN_PACK_CATALOG,
  getAnnualDiscountPercent,
} from './pricingCatalog.ts';
import {
  CAD_GENERATION_TOKEN_COST,
  CAD_PREMIUM_GENERATION_TOKEN_COST,
  FEATURE_COSTS,
  TOKEN_INTERNAL_USD_COST,
  TOKEN_USD_VALUE,
  getCadBackendTokenCost,
  getParametricBuildTokenCost,
  getParametricModelTokenCost,
  tokensForProviderCost,
} from './tokenCosts.ts';

const pricingViewSource = readFileSync(
  fileURLToPath(new URL('../src/views/PricingView.tsx', import.meta.url)),
  'utf8',
);

assert.equal(TOKEN_INTERNAL_USD_COST, 0.01);
assert.equal(TOKEN_USD_VALUE, 0.03);
assert.equal(TOKEN_USD_VALUE / TOKEN_INTERNAL_USD_COST, 3);
assert.equal(CAD_GENERATION_TOKEN_COST, CAD_PREMIUM_GENERATION_TOKEN_COST);
assert.equal(tokensForProviderCost(0), 0);
assert.equal(tokensForProviderCost(0.07), 7);
assert.equal(tokensForProviderCost(0.3), 30);
assert.equal(tokensForProviderCost(0.301), 31);

assert.deepEqual(PLAN_ORDER, ['free', 'standard', 'pro', 'max']);

assert.equal(FREE_STARTER_TOKENS, 100);
assert.equal(PLAN_CATALOG.free.monthlyPriceCents, 0);
assert.equal(PLAN_CATALOG.free.tokenAmount, null);

assert.equal(PLAN_CATALOG.standard.monthlyPriceCents, 3000);
assert.equal(PLAN_CATALOG.standard.yearlyPriceCents, 21600);
assert.equal(PLAN_CATALOG.standard.tokenAmount, 1000);

assert.equal(PLAN_CATALOG.pro.monthlyPriceCents, 15000);
assert.equal(PLAN_CATALOG.pro.yearlyPriceCents, 108000);
assert.equal(PLAN_CATALOG.pro.tokenAmount, 5000);

assert.equal(PLAN_CATALOG.max.monthlyPriceCents, 150000);
assert.equal(PLAN_CATALOG.max.yearlyPriceCents, 1080000);
assert.equal(PLAN_CATALOG.max.tokenAmount, 50000);

assert.equal(getAnnualDiscountPercent('standard'), 40);
assert.equal(getAnnualDiscountPercent('pro'), 40);
assert.equal(getAnnualDiscountPercent('max'), 40);

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
    promptGeneration: 10,
    parametric: 25,
    parametricCadReasoning: 25,
    generatedInputImage: 22,
    generatedInputImageNormal: 14,
    generatedInputImageLite: 7,
    generatedInputImageNanoLite: 4,
    multiviewFrontImage: 22,
    multiviewLiteView: 7,
    fastMesh: 41,
    qualityMesh: 34,
    ultraMesh: 110,
    multiviewMesh: 61,
    upscaleMesh: 76,
  },
);

assert.ok(
  FEATURE_COSTS.ultraMesh.tokens > FEATURE_COSTS.fastMesh.tokens,
  'Max quality mesh should cost more than textureless mesh',
);
assert.ok(
  FEATURE_COSTS.ultraMesh.tokens > FEATURE_COSTS.qualityMesh.tokens,
  'Max quality mesh should cost more than draft mesh',
);

// The current CAD model and all stale/off-roster ids charge the app-wide CAD cost.
assert.equal(getParametricModelTokenCost('google/gemini-3.5-flash'), 25);
assert.equal(getParametricModelTokenCost('google/gemini-3.1-pro-preview'), 25);
assert.equal(getParametricModelTokenCost('anthropic/claude-fable-5'), 25);
assert.equal(getParametricModelTokenCost('openai/gpt-5.5'), 25);
assert.equal(getParametricModelTokenCost('anthropic/claude-opus-4.8'), 25);
assert.equal(getParametricModelTokenCost('anthropic/claude-opus-4.7'), 25);
assert.equal(getParametricModelTokenCost('legacy-model'), 25);
assert.equal(getParametricBuildTokenCost('google/gemini-3.5-flash'), 25);
assert.equal(getParametricBuildTokenCost('google/gemini-3.1-pro-preview'), 25);
assert.equal(getParametricBuildTokenCost('anthropic/claude-fable-5'), 25);
assert.equal(getParametricBuildTokenCost('openai/gpt-5.5'), 25);
assert.equal(getParametricBuildTokenCost('anthropic/claude-opus-4.8'), 25);
assert.equal(getParametricBuildTokenCost('legacy-model', 25), 25);
assert.equal(getCadBackendTokenCost('openscad', 'google/gemini-3.5-flash'), 25);
assert.equal(
  getCadBackendTokenCost('text-to-cad', 'google/gemini-3.5-flash'),
  25,
);
assert.equal(
  getCadBackendTokenCost('text-to-cad', 'anthropic/claude-opus-4.7'),
  25,
);
assert.equal(
  getCadBackendTokenCost('text-to-cad', 'anthropic/claude-fable-5'),
  25,
);

assert.equal(pricingViewSource.includes('parametricCadReasoning'), false);
assert.equal(pricingViewSource.includes('FEATURE_COSTS.upscaleMesh'), false);
