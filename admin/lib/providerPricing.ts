// Vendored from shared/providerPricing.ts — keep in sync; guarded by pricingSync.test.mjs
//
// Real external-provider $ rates (our COGS). The admin dashboard is deployed
// from the admin/ directory alone and cannot import shared/, so the pricing
// tables the edge functions use to populate provider_usage are duplicated here
// for display and auditing. pricingSync.test.mjs deep-compares this copy against
// the canonical shared/providerPricing.ts and fails if they drift.

export type LlmPrice = {
  inputPerM: number;
  outputPerM: number;
  cachedInputPerM?: number; // Anthropic prompt-cache read tier (cheaper)
};

// LLM token rates — USD per 1,000,000 tokens.
export const LLM_PRICES: Record<string, LlmPrice> = {
  // --- Anthropic (direct SDK) ---
  'claude-sonnet-4-6': { inputPerM: 3, outputPerM: 15, cachedInputPerM: 0.3 },
  'claude-haiku-4-5': { inputPerM: 1, outputPerM: 5, cachedInputPerM: 0.1 },
  // --- OpenRouter slugs ---
  'google/gemini-3.5-flash': { inputPerM: 1.5, outputPerM: 9 },
  'google/gemini-3.1-pro-preview': { inputPerM: 1.25, outputPerM: 10 },
  'anthropic/claude-fable-5': { inputPerM: 10, outputPerM: 50 },
  'anthropic/claude-opus-4.8': { inputPerM: 5, outputPerM: 25 },
  'openai/gpt-5.5': { inputPerM: 5, outputPerM: 30 },
  'anthropic/claude-haiku-4.5': { inputPerM: 1, outputPerM: 5 },
};

// Image generation — USD per image (published 1024x1024 output costs).
export const OPENAI_IMAGE_PRICES = {
  low: 0.006,
  medium: 0.053,
  high: 0.211,
} as const satisfies Record<'low' | 'medium' | 'high', number>;

// Gemini image output costs per image model.
export const GEMINI_IMAGE_PRICES = {
  'gemini-3.1-flash-image-preview': 0.067,
  'gemini-3.1-flash-image': 0.067,
  'gemini-3.1-flash-lite-image-preview': 0.0336,
  'gemini-3.1-flash-lite-image': 0.0336,
  'gemini-3-pro-image-preview': 0.134,
  'gemini-3-pro-image': 0.134,
} as const satisfies Record<string, number>;

// fal.ai per-endpoint unit prices (fal returns no cost in its responses).
export type FalUnitPrice = { unitPrice: number; unit: string };

export const FAL_UNIT_PRICES: Record<string, FalUnitPrice> = {
  'fal-ai/meshy/v6-preview/image-to-3d': { unitPrice: 0.8, unit: 'units' },
  'fal-ai/sam-3/3d-objects': { unitPrice: 0.02, unit: 'units' },
  'tripo3d/tripo/v2.5/image-to-3d': {
    unitPrice: 0.00007,
    unit: 'compute seconds',
  },
  'fal-ai/hunyuan-3d/v3.1/pro/image-to-3d': { unitPrice: 0.015, unit: 'units' },
  'fal-ai/hunyuan3d/v2/mini/turbo': { unitPrice: 0.08, unit: 'generations' },
  'fal-ai/moondream3-preview/caption': { unitPrice: 1, unit: 'units' },
  'fal-ai/sam-3/image': { unitPrice: 0.005, unit: 'units' },
  'fal-ai/flux-pro/kontext/max/multi': { unitPrice: 0.08, unit: 'images' },
  'fal-ai/flux-pro/v1.1': { unitPrice: 0.04, unit: 'megapixels' },
};

// Fixed per-call fal cost estimates for endpoints whose unit isn't measurable
// per request.
export const FAL_FIXED_CALL_USD: Record<string, number> = {
  'tripo3d/tripo/v2.5/image-to-3d': 0.2,
  'fal-ai/moondream3-preview/caption': 0.001351,
};

// ---------------------------------------------------------------------------
// Flattened display catalog. One row per priced model/endpoint so the rates
// are auditable from the /providers dashboard.
// ---------------------------------------------------------------------------
export type PricingCatalogRow = {
  category: 'LLM' | 'OpenAI image' | 'Gemini image' | 'fal';
  id: string;
  detail: string;
};

function perMTok(price: LlmPrice): string {
  const cached =
    price.cachedInputPerM != null
      ? `, $${price.cachedInputPerM}/MTok cached in`
      : '';
  return `$${price.inputPerM}/MTok in, $${price.outputPerM}/MTok out${cached}`;
}

export const PRICING_CATALOG: PricingCatalogRow[] = [
  ...Object.entries(LLM_PRICES).map(([id, price]) => ({
    category: 'LLM' as const,
    id,
    detail: perMTok(price),
  })),
  ...Object.entries(OPENAI_IMAGE_PRICES).map(([id, usd]) => ({
    category: 'OpenAI image' as const,
    id: `gpt-image (${id})`,
    detail: `$${usd}/image`,
  })),
  ...Object.entries(GEMINI_IMAGE_PRICES).map(([id, usd]) => ({
    category: 'Gemini image' as const,
    id,
    detail: `$${usd}/image`,
  })),
  ...Object.entries(FAL_UNIT_PRICES).map(([id, price]) => ({
    category: 'fal' as const,
    id,
    detail: `$${price.unitPrice}/${price.unit}`,
  })),
];
