// Drift guard: the admin app vendors pricing tables from shared/ (it can't
// import across the deploy boundary). This test deep-compares the vendored
// copies against the canonical shared/ sources and fails if they drift.
//
// Run from the repo root with Node's TypeScript stripping (same as the other
// shared/*.test.mjs and admin/lib/generationTokens.test.mjs):
//   node --test admin/lib/pricingSync.test.mjs
// On Node < 22.6 add the flag: node --experimental-strip-types --test <path>

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LLM_PRICES as ADMIN_LLM_PRICES,
  OPENAI_IMAGE_PRICES as ADMIN_OPENAI_IMAGE_PRICES,
  GEMINI_IMAGE_PRICES as ADMIN_GEMINI_IMAGE_PRICES,
  FAL_UNIT_PRICES as ADMIN_FAL_UNIT_PRICES,
  FAL_FIXED_CALL_USD as ADMIN_FAL_FIXED_CALL_USD,
} from './providerPricing.ts';
import {
  TOKEN_INTERNAL_USD_COST as ADMIN_TOKEN_INTERNAL_USD_COST,
  TOKEN_USD_VALUE as ADMIN_TOKEN_USD_VALUE,
  PLAN_MONTHLY_CENTS as ADMIN_PLAN_MONTHLY_CENTS,
} from './pricing.ts';

import {
  LLM_PRICES as SHARED_LLM_PRICES,
  OPENAI_IMAGE_PRICES as SHARED_OPENAI_IMAGE_PRICES,
  GEMINI_IMAGE_PRICES as SHARED_GEMINI_IMAGE_PRICES,
  FAL_UNIT_PRICES as SHARED_FAL_UNIT_PRICES,
  FAL_FIXED_CALL_USD as SHARED_FAL_FIXED_CALL_USD,
} from '../../shared/providerPricing.ts';
import {
  TOKEN_INTERNAL_USD_COST as SHARED_TOKEN_INTERNAL_USD_COST,
  TOKEN_USD_VALUE as SHARED_TOKEN_USD_VALUE,
} from '../../shared/tokenCosts.ts';
import { PLAN_CATALOG } from '../../shared/pricingCatalog.ts';

test('LLM_PRICES matches shared/providerPricing.ts', () => {
  assert.deepEqual(ADMIN_LLM_PRICES, SHARED_LLM_PRICES);
});

test('OPENAI_IMAGE_PRICES matches shared/providerPricing.ts', () => {
  assert.deepEqual(ADMIN_OPENAI_IMAGE_PRICES, SHARED_OPENAI_IMAGE_PRICES);
});

test('GEMINI_IMAGE_PRICES matches shared/providerPricing.ts', () => {
  assert.deepEqual(ADMIN_GEMINI_IMAGE_PRICES, SHARED_GEMINI_IMAGE_PRICES);
});

test('FAL_UNIT_PRICES matches shared/providerPricing.ts', () => {
  assert.deepEqual(ADMIN_FAL_UNIT_PRICES, SHARED_FAL_UNIT_PRICES);
});

test('FAL_FIXED_CALL_USD matches shared/providerPricing.ts', () => {
  assert.deepEqual(ADMIN_FAL_FIXED_CALL_USD, SHARED_FAL_FIXED_CALL_USD);
});

test('token cost constants match shared/tokenCosts.ts', () => {
  assert.equal(
    ADMIN_TOKEN_INTERNAL_USD_COST,
    SHARED_TOKEN_INTERNAL_USD_COST,
    'TOKEN_INTERNAL_USD_COST drift',
  );
  assert.equal(
    ADMIN_TOKEN_USD_VALUE,
    SHARED_TOKEN_USD_VALUE,
    'TOKEN_USD_VALUE drift',
  );
});

test('PLAN_MONTHLY_CENTS matches shared/pricingCatalog.ts PLAN_CATALOG', () => {
  const sharedMonthlyCents = Object.fromEntries(
    Object.entries(PLAN_CATALOG).map(([level, plan]) => [
      level,
      plan.monthlyPriceCents,
    ]),
  );
  assert.deepEqual(ADMIN_PLAN_MONTHLY_CENTS, sharedMonthlyCents);
});
