// Real external-provider $ rates — our cost of goods (COGS) per generation.
//
// Used by the Supabase edge functions to compute the actual dollar cost of each
// paid AI call (Anthropic, OpenRouter, OpenAI images, Gemini, fal.ai) and write
// it to `provider_usage`, so the admin dashboard can show true cost and margin
// instead of the flat $0.01/token estimate.
//
// Pure data + pure functions: importable from Deno edge functions, the Vite
// app, and Node scripts run with `--experimental-strip-types`. Do NOT add any
// Deno- or Node-only APIs here.
//
// KEEP IN SYNC with vendor pricing. `FAL_UNIT_PRICES` mirrors the checked-in
// fallback prices in `scripts/fal-cost-report.mjs` (which imports them from
// here). The LLM token rates below are best-effort and MUST be verified against
// each provider's published pricing — token COUNTS we log are measured and
// exact, but the per-token $ rate is only as good as this table.

export type ProviderKind =
  | 'anthropic'
  | 'openai'
  | 'openrouter'
  | 'google'
  | 'fal'
  | 'worker';

// ---------------------------------------------------------------------------
// LLM token rates — USD per 1,000,000 tokens.
// Keyed by the provider id exactly as it appears in the edge functions.
// Unknown ids cost $0 (a visible gap, not a crash) — add pricing here when
// introducing a new paid provider call.
// ---------------------------------------------------------------------------
export type LlmPrice = {
  inputPerM: number;
  outputPerM: number;
  cachedInputPerM?: number; // Anthropic prompt-cache read tier (cheaper)
};

export const LLM_PRICES: Record<string, LlmPrice> = {
  // --- Anthropic (direct SDK) ---
  // creative-chat main turn — verified $3 / $15 per MTok.
  'claude-sonnet-4-6': { inputPerM: 3, outputPerM: 15, cachedInputPerM: 0.3 },
  // title-generator + creative-chat suggestions (Haiku-class; estimate).
  'claude-haiku-4-5': { inputPerM: 1, outputPerM: 5, cachedInputPerM: 0.1 },
  // --- OpenRouter slugs ---
  // Lite/Fast parametric CAD model.
  'google/gemini-3.5-flash': { inputPerM: 1.5, outputPerM: 9 },
  // CADAM-aligned parametric-chat agent + code-gen model.
  'google/gemini-3.1-pro-preview': { inputPerM: 1.25, outputPerM: 10 },
  // Claude Fable 5 via OpenRouter / Anthropic — verified $10 / $50.
  'anthropic/claude-fable-5': { inputPerM: 10, outputPerM: 50 },
  // prompt-generator + code-gen fallback — verified $5 / $30.
  'openai/gpt-5.5': { inputPerM: 5, outputPerM: 30 },
  // prompt-generator fallback (Haiku-class; estimate).
  'anthropic/claude-haiku-4.5': { inputPerM: 1, outputPerM: 5 },
};

// ---------------------------------------------------------------------------
// Image generation — USD per image.
// gpt-image-2 cost is driven by quality and size. The app requests 1024x1024,
// so these are the published 1024x1024 per-image output costs.
// ---------------------------------------------------------------------------
export const OPENAI_IMAGE_PRICES = {
  low: 0.006,
  medium: 0.053,
  high: 0.211,
} as const satisfies Record<'low' | 'medium' | 'high', number>;

// Gemini image output costs differ by image model. The app uses
// gemini-3.1-flash-image-preview (Nano Banana 2) for generated
// input/reference images, gemini-3.1-flash-lite-image (Nano Banana 2 Lite)
// for the lowest-cost tier, and gemini-3-pro-image-preview for mesh-mode
// multi-turn image generation.
export const GEMINI_IMAGE_PRICES = {
  'gemini-3.1-flash-image-preview': 0.067,
  'gemini-3.1-flash-image': 0.067,
  // Verified against Google's published Nano Banana 2 Lite pricing:
  // $0.0336 per 1K-resolution image.
  'gemini-3.1-flash-lite-image-preview': 0.0336,
  'gemini-3.1-flash-lite-image': 0.0336,
  'gemini-3-pro-image-preview': 0.134,
  'gemini-3-pro-image': 0.134,
} as const satisfies Record<string, number>;

const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image-preview';

// ---------------------------------------------------------------------------
// fal.ai per-endpoint unit prices. fal does NOT return cost in its API
// responses, so cost is computed from this catalog. Mirrors the checked-in
// fallback prices in scripts/fal-cost-report.mjs (DEFAULT_UNIT_PRICES); keep
// the two identical. Some endpoints are priced per ambiguous unit ('compute
// seconds') that we can't measure per call — for those, callers pass an
// explicit `costUsd` (see logFalUsage) using the fixed per-call estimate from
// fal-cost-report.mjs FEATURE_BREAKDOWNS instead of unit_price * units.
// ---------------------------------------------------------------------------
export type FalUnitPrice = { unitPrice: number; unit: string };

export const FAL_UNIT_PRICES: Record<string, FalUnitPrice> = {
  // Verified against live fal Platform Pricing ($0.80/unit) — the old $0.06
  // fallback was stale and under-counted Max Quality mesh cost ~13x.
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
// per request (mirrors the fixedCostUsd values in fal-cost-report.mjs). Pass
// these as the explicit `costUsd` to logFalUsage.
export const FAL_FIXED_CALL_USD: Record<string, number> = {
  // Tripo textureless image-to-3D: fal gallery fixed textureless cost.
  'tripo3d/tripo/v2.5/image-to-3d': 0.2,
  // Moondream caption: recent historical per-call estimate.
  'fal-ai/moondream3-preview/caption': 0.001351,
};

// Hunyuan 3D v3.1 Pro is billed in "units"; multiview and upscale apply a
// surcharge expressed as a unit multiplier (0.015 * units). Mirrors the
// multiview fixed 0.525 (=35 units) and upscale 45-unit cost in
// fal-cost-report.mjs.
export const HUNYUAN_PRO_MULTIVIEW_UNITS = 35;
export const HUNYUAN_PRO_UPSCALE_UNITS = 45;

// ---------------------------------------------------------------------------
// Cost helpers
// ---------------------------------------------------------------------------
// Strip a trailing dated snapshot suffix so dated ids resolve to the base rate.
function normalizeModelId(model: string): string {
  return model.replace(/-\d{8}$/, '');
}

// Output $/1M-token rate for a model (0 when unknown). Shares the LLM_PRICES
// table with llmCostUsd so budget math and cost accounting never diverge.
export function llmOutputPerMUsd(model: string): number {
  const price = LLM_PRICES[model] ?? LLM_PRICES[normalizeModelId(model)];
  return price?.outputPerM ?? 0;
}

// Input $/1M-token rate for a model (0 when unknown), same table.
export function llmInputPerMUsd(model: string): number {
  const price = LLM_PRICES[model] ?? LLM_PRICES[normalizeModelId(model)];
  return price?.inputPerM ?? 0;
}

export function llmCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): number {
  const price = LLM_PRICES[model] ?? LLM_PRICES[normalizeModelId(model)];
  if (!price) return 0;
  const billedInput = Math.max(0, inputTokens - cachedInputTokens);
  const cachedRate = price.cachedInputPerM ?? price.inputPerM;
  return (
    (billedInput / 1_000_000) * price.inputPerM +
    (cachedInputTokens / 1_000_000) * cachedRate +
    (outputTokens / 1_000_000) * price.outputPerM
  );
}

export function openaiImageCostUsd(
  quality: 'low' | 'medium' | 'high',
  images = 1,
): number {
  return (OPENAI_IMAGE_PRICES[quality] ?? OPENAI_IMAGE_PRICES.high) * images;
}

export function geminiImageCostUsd(
  model = DEFAULT_GEMINI_IMAGE_MODEL,
  images = 1,
): number {
  const price =
    GEMINI_IMAGE_PRICES[model as keyof typeof GEMINI_IMAGE_PRICES] ??
    GEMINI_IMAGE_PRICES[DEFAULT_GEMINI_IMAGE_MODEL];
  return price * images;
}

export function falCostUsd(endpoint: string, units = 1): number {
  const price = FAL_UNIT_PRICES[endpoint];
  if (!price) return 0;
  return price.unitPrice * units;
}
