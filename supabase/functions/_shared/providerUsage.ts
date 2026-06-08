// Records the ACTUAL dollar cost of each paid external-provider call into the
// `provider_usage` table, so the admin dashboard can report real COGS / margin.
//
// Every function here is fire-and-forget and SWALLOWS its own errors — cost
// logging must never break or slow a generation. Call them without awaiting in
// the hot path, ideally inside `EdgeRuntime.waitUntil(...)` so the row is
// written after the response is flushed. They use the service-role client,
// which bypasses RLS (the table has no anon/authenticated policies).

import { getServiceRoleSupabaseClient } from './supabaseClient.ts';
import { logError } from './sentry.ts';
import {
  type ProviderKind,
  falCostUsd,
  geminiImageCostUsd,
  llmCostUsd,
  openaiImageCostUsd,
} from '../../../shared/providerPricing.ts';

type BaseUsage = {
  functionName: string;
  operation: string;
  userId?: string | null;
  conversationId?: string | null;
  referenceId?: string | null;
  status?: 'success' | 'failure';
  metadata?: Record<string, unknown>;
};

type UsageRow = {
  function_name: string;
  operation: string;
  provider: ProviderKind;
  model: string;
  cost_usd: number;
  pricing_source: string;
  status: string;
  user_id?: string | null;
  conversation_id?: string | null;
  reference_id?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cached_input_tokens?: number | null;
  request_units?: number | null;
  unit?: string | null;
  metadata?: Record<string, unknown>;
};

let cachedClient: ReturnType<typeof getServiceRoleSupabaseClient> | null = null;

function client() {
  if (!cachedClient) cachedClient = getServiceRoleSupabaseClient();
  return cachedClient;
}

async function insertUsage(row: UsageRow): Promise<void> {
  try {
    const { error } = await client().from('provider_usage').insert(row);
    if (error) {
      logError(new Error(error.message), {
        functionName: 'provider-usage',
        statusCode: 500,
        additionalContext: { attempted: row },
      });
    }
  } catch (e) {
    // Never let cost logging throw into the generation path.
    logError(e, {
      functionName: 'provider-usage',
      statusCode: 500,
      additionalContext: { attempted: row },
    });
  }
}

function base(p: BaseUsage) {
  return {
    function_name: p.functionName,
    operation: p.operation,
    status: p.status ?? 'success',
    user_id: p.userId ?? null,
    conversation_id: p.conversationId ?? null,
    reference_id: p.referenceId ?? null,
    metadata: p.metadata ?? {},
  };
}

// Anthropic (direct SDK) or OpenRouter LLM call. Pass the usage you already get
// back. If the provider returns its own billed cost (OpenRouter does when you
// opt in), pass it as `costUsdOverride` — that's the true number.
export function logLlmUsage(
  p: BaseUsage & {
    provider: 'anthropic' | 'openrouter' | 'openai' | 'google';
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    costUsdOverride?: number;
  },
): Promise<void> {
  const cost =
    p.costUsdOverride ??
    llmCostUsd(
      p.model,
      p.inputTokens,
      p.outputTokens,
      p.cachedInputTokens ?? 0,
    );
  return insertUsage({
    ...base(p),
    provider: p.provider,
    model: p.model,
    input_tokens: p.inputTokens,
    output_tokens: p.outputTokens,
    cached_input_tokens: p.cachedInputTokens ?? null,
    unit: 'tokens',
    cost_usd: cost,
    pricing_source: p.costUsdOverride != null ? 'measured' : 'rate_table',
  });
}

// OpenAI gpt-image-2: cost is driven by quality (size fixed at 1024x1024).
export function logOpenAiImage(
  p: BaseUsage & { quality: 'low' | 'medium' | 'high'; images?: number },
): Promise<void> {
  const images = p.images ?? 1;
  return insertUsage({
    ...base(p),
    provider: 'openai',
    model: 'gpt-image-2',
    request_units: images,
    unit: 'images',
    cost_usd: openaiImageCostUsd(p.quality, images),
    pricing_source: 'catalog',
    metadata: { quality: p.quality, ...(p.metadata ?? {}) },
  });
}

// Gemini "nano banana" reference image.
export function logGeminiImage(
  p: BaseUsage & { model?: string; images?: number },
): Promise<void> {
  const images = p.images ?? 1;
  return insertUsage({
    ...base(p),
    provider: 'google',
    model: p.model ?? 'gemini-nano-banana',
    request_units: images,
    unit: 'images',
    cost_usd: geminiImageCostUsd(images),
    pricing_source: 'catalog',
  });
}

// fal.ai call. fal does not return cost, so cost = unit_price * units from the
// catalog, OR pass an explicit `costUsd` for endpoints with a fixed per-call
// estimate (see FAL_FIXED_CALL_USD in shared/providerPricing.ts).
export function logFalUsage(
  p: BaseUsage & {
    endpoint: string;
    units?: number;
    costUsd?: number;
    falRequestId?: string;
  },
): Promise<void> {
  const units = p.units ?? 1;
  return insertUsage({
    ...base(p),
    provider: 'fal',
    model: p.endpoint,
    request_units: units,
    unit: 'units',
    cost_usd: p.costUsd ?? falCostUsd(p.endpoint, units),
    pricing_source: 'catalog',
    metadata: { fal_request_id: p.falRequestId, ...(p.metadata ?? {}) },
  });
}
