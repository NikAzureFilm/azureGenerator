import assert from 'node:assert/strict';
import {
  buildFeatureCostRows,
  FAL_ENDPOINTS,
  TOKEN_INTERNAL_USD_COST,
  TOKEN_USD_VALUE,
  tokensForCostUsd,
} from './fal-cost-report.mjs';
import {
  FEATURE_COSTS,
  TOKEN_INTERNAL_USD_COST as SHARED_TOKEN_INTERNAL_USD_COST,
  TOKEN_USD_VALUE as SHARED_TOKEN_USD_VALUE,
} from '../shared/tokenCosts.ts';
import { FAL_UNIT_PRICES } from '../shared/providerPricing.ts';

// The CLI's endpoint list must come from the shared price source of truth.
assert.deepEqual(FAL_ENDPOINTS, Object.keys(FAL_UNIT_PRICES));

assert.equal(TOKEN_INTERNAL_USD_COST, SHARED_TOKEN_INTERNAL_USD_COST);
assert.equal(TOKEN_USD_VALUE, SHARED_TOKEN_USD_VALUE);
assert.equal(tokensForCostUsd(0.07), 7);
assert.equal(tokensForCostUsd(0.071), 8);
assert.equal(FAL_ENDPOINTS.includes('fal-ai/pixal3d'), false);
assert.ok(FAL_ENDPOINTS.includes('fal-ai/meshy/v6-preview/image-to-3d'));
assert.ok(FAL_ENDPOINTS.includes('fal-ai/hunyuan-3d/v3.1/pro/image-to-3d'));
assert.equal(
  FAL_ENDPOINTS.includes('tripo3d/tripo/v2.5/multiview-to-3d'),
  false,
);

const unitPrices = new Map(
  [
    ['fal-ai/meshy/v6-preview/image-to-3d', 0.8],
    ['fal-ai/sam-3/3d-objects', 0.02],
    ['fal-ai/sam-3/image', 0.005],
    ['fal-ai/hunyuan-3d/v3.1/pro/image-to-3d', 0.015],
    ['fal-ai/hunyuan3d/v2/mini/turbo', 0.08],
    ['fal-ai/flux-pro/kontext/max/multi', 0.08],
    ['fal-ai/flux-pro/v1.1', 0.04],
  ].map(([endpointId, unitPrice]) => [
    endpointId,
    {
      endpoint_id: endpointId,
      unit_price: unitPrice,
      unit: 'units',
      currency: 'USD',
    },
  ]),
);

const rows = buildFeatureCostRows(unitPrices);
const byId = new Map(rows.map((row) => [row.id, row]));

assert.equal(byId.get('generatedInputImage')?.suggestedTokens, 1);
assert.equal(byId.get('multiviewFrontImage')?.suggestedTokens, 1);
assert.equal(byId.get('generatedInputImageNanoBanana')?.suggestedTokens, 7);
assert.equal(byId.get('fastMesh')?.suggestedTokens, 29);
assert.equal(byId.get('qualityMesh')?.suggestedTokens, 33);
assert.equal(byId.get('ultraMesh')?.suggestedTokens, 110);
assert.equal(byId.get('multiviewMesh')?.suggestedTokens, 61);
assert.equal(byId.get('upscaleMesh')?.suggestedTokens, 76);

for (const [key, feature] of Object.entries(FEATURE_COSTS)) {
  const row = byId.get(key);
  assert.ok(row, `missing CLI row for ${key}`);
  assert.equal(row.configuredTokens, feature.tokens, key);
}
