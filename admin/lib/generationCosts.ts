import { getAdminClient } from './supabaseAdmin.ts';
import { CAD_LITE_MODEL_ID, CAD_PREMIUM_MODEL_ID } from './generationModels.ts';
import { TOKEN_INTERNAL_USD_COST } from './pricing.ts';

// ===========================================================================
// Per-generation true-cost metering. A text-to-CAD generation fans out into
// several LLM calls (agent, code-gen, and — once the agentic loop ships —
// repair/review/revision rounds) that all log to provider_usage under the same
// reference_id (the assistant message id / cad reference id). True cost per
// generation is therefore SUM(cost_usd) grouped by reference_id. Aggregation is
// done here in JS rather than in SQL to match the costs.ts house pattern (no new
// database functions); id sets are batched into bounded .in() queries.
// ===========================================================================

const CHUNK_SIZE = 100;
const PAGE_SIZE = 1000;
const MAX_ROWS = 20_000;

// provider_usage.operation values that belong to a text-to-CAD generation.
// 'parametric-inspect' is the merged self-inspection round; 'parametric-review'
// is the retired reviewer op, kept so historical rows still sum into COGS.
export const GENERATION_COST_OPERATIONS = [
  'parametric',
  'parametric-inspect',
  'parametric-review',
  'text-to-cad',
];

export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return items.length ? [items] : [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

// Sums provider_usage.cost_usd grouped by reference_id for the given ids,
// batching into chunks so a large displayed page stays within one .in() cap.
// Reference ids absent from the result had no logged usage rows.
export async function fetchGenerationCosts(
  referenceIds: string[],
): Promise<Map<string, number>> {
  const ids = [...new Set(referenceIds.filter(Boolean))];
  const costs = new Map<string, number>();
  if (ids.length === 0) return costs;

  const supa = getAdminClient();
  for (const group of chunk(ids, CHUNK_SIZE)) {
    const { data, error } = await supa
      .from('provider_usage')
      .select('reference_id,cost_usd')
      .in('reference_id', group);
    if (error) {
      throw new Error(`provider_usage generation costs: ${error.message}`);
    }
    for (const row of (data ?? []) as Array<{
      reference_id: string | null;
      cost_usd: number | string | null;
    }>) {
      if (!row.reference_id) continue;
      const cost = Number(row.cost_usd ?? 0);
      if (!Number.isFinite(cost)) continue;
      costs.set(row.reference_id, (costs.get(row.reference_id) ?? 0) + cost);
    }
  }
  return costs;
}

export type GenerationMargin = {
  costText: string;
  budgetText: string;
  overBudget: boolean;
};

function usd2(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

// True provider cost vs the internal budget implied by the tokens charged for
// the generation (chargedTokens × $0.01). chargedTokens is null for kinds with
// no tier token cost (mesh/image), leaving the budget unknown.
export function formatGenerationMargin(
  costUsd: number,
  chargedTokens: number | null,
): GenerationMargin {
  const costText = usd2(costUsd);
  if (chargedTokens == null) {
    return { costText, budgetText: '—', overBudget: false };
  }
  const budgetUsd = chargedTokens * TOKEN_INTERNAL_USD_COST;
  return {
    costText,
    budgetText: usd2(budgetUsd),
    overBudget: costUsd > budgetUsd,
  };
}

// --- Windowed per-generation summary (costs page) --------------------------

export type GenerationTier = 'premium' | 'lite' | 'other';

// Classifies a generation by the model id recorded on its provider_usage rows.
export function classifyGenerationTier(
  model: string | null | undefined,
): GenerationTier {
  const id = (model ?? '').trim().toLowerCase();
  if (!id) return 'other';
  // Lite is the only no-inspection draft tier; everything else in the picker
  // (Fable, Gemini 3.1 Pro, GPT-5.5, Opus 4.8) is a premium inspection model.
  if (id === CAD_LITE_MODEL_ID || id.includes('gemini-3.5-flash'))
    return 'lite';
  if (
    id === CAD_PREMIUM_MODEL_ID ||
    id.includes('fable') ||
    id.includes('gemini-3.1-pro') ||
    id.includes('gpt-5.5') ||
    id.includes('gpt-5.6-sol') ||
    id.includes('opus-4.8')
  )
    return 'premium';
  return 'other';
}

// Linear-interpolated percentile (p in 0..100) of a sample of costs.
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - rank) + sorted[hi] * (rank - lo);
}

export type GenerationCostRow = {
  reference_id: string | null;
  cost_usd: number | string | null;
  model: string | null;
  operation?: string | null;
};

export type TierGenerationStats = {
  tier: GenerationTier;
  count: number;
  totalUsd: number;
  avgUsd: number;
  p90Usd: number;
};

export type GenerationCostSummary = {
  count: number;
  totalUsd: number;
  avgUsd: number;
  p90Usd: number;
  premium: TierGenerationStats;
  lite: TierGenerationStats;
};

function statsFor(tier: GenerationTier, costs: number[]): TierGenerationStats {
  const totalUsd = costs.reduce((sum, cost) => sum + cost, 0);
  return {
    tier,
    count: costs.length,
    totalUsd,
    avgUsd: costs.length ? totalUsd / costs.length : 0,
    p90Usd: percentile(costs, 90),
  };
}

// Collapses raw provider_usage rows into one cost per generation (grouped by
// reference_id), then reports overall and per-tier (Premium/Lite) statistics.
// A generation is Premium if any of its rows used the premium model, else Lite
// if any used the lite model; 'other'-tier generations are excluded from the
// tier splits but still counted in the overall figures.
export function summarizeGenerationCosts(
  rows: GenerationCostRow[],
): GenerationCostSummary {
  const byRef = new Map<
    string,
    { cost: number; premium: boolean; lite: boolean }
  >();
  for (const row of rows) {
    if (!row.reference_id) continue;
    const entry = byRef.get(row.reference_id) ?? {
      cost: 0,
      premium: false,
      lite: false,
    };
    const cost = Number(row.cost_usd ?? 0);
    if (Number.isFinite(cost)) entry.cost += cost;
    const tier = classifyGenerationTier(row.model);
    if (tier === 'premium') entry.premium = true;
    else if (tier === 'lite') entry.lite = true;
    byRef.set(row.reference_id, entry);
  }

  const generations = [...byRef.values()].map((entry) => {
    const tier: GenerationTier = entry.premium
      ? 'premium'
      : entry.lite
        ? 'lite'
        : 'other';
    return { cost: entry.cost, tier };
  });

  const allCosts = generations.map((g) => g.cost);
  const overall = statsFor('other', allCosts);
  return {
    count: overall.count,
    totalUsd: overall.totalUsd,
    avgUsd: overall.avgUsd,
    p90Usd: overall.p90Usd,
    premium: statsFor(
      'premium',
      generations.filter((g) => g.tier === 'premium').map((g) => g.cost),
    ),
    lite: statsFor(
      'lite',
      generations.filter((g) => g.tier === 'lite').map((g) => g.cost),
    ),
  };
}

// Fetches windowed text-to-CAD provider_usage rows (bounded page walk, matching
// costs.ts) and reduces them to a per-generation cost summary.
export async function fetchGenerationCostSummary(
  days: number | null,
): Promise<GenerationCostSummary> {
  const supa = getAdminClient();
  const cutoff = days
    ? new Date(Date.now() - days * 86_400_000).toISOString()
    : null;
  const rows: GenerationCostRow[] = [];

  for (let page = 0; page * PAGE_SIZE < MAX_ROWS; page++) {
    let query = supa
      .from('provider_usage')
      .select('reference_id,cost_usd,model,operation')
      .in('operation', GENERATION_COST_OPERATIONS)
      .order('created_at', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (cutoff) query = query.gte('created_at', cutoff);
    const { data, error } = await query;
    if (error) {
      throw new Error(`provider_usage generation summary: ${error.message}`);
    }
    const batch = (data ?? []) as GenerationCostRow[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }

  return summarizeGenerationCosts(rows);
}
