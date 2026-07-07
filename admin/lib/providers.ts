import 'server-only';
import { getAdminClient } from './supabaseAdmin';

// ===========================================================================
// Provider credit & budget data layer.
//
// Per-provider spend prefers the admin_provider_costs() RPC, which aggregates
// ALL of provider_usage (accurate even in a >20k-row month). When that function
// is absent it falls back to a bounded 20k-row JS aggregation over a 62-day
// window (same paged pattern as lib/costs.ts) — which can understate spend if
// the cap is hit; that case is surfaced via spendMayBeUnderstated. Budgets come
// from admin_provider_budgets (optional table; graceful 42P01 fallback). The
// unpriced-model scan always uses the JS row read (needs per-row token counts).
// ===========================================================================

export type ProviderStatus = 'ok' | 'warn' | 'over' | 'none';

export type ProviderCreditRow = {
  provider: string;
  budgetUsd: number | null;
  mtdCostUsd: number;
  last30dCostUsd: number;
  prevMonthCostUsd: number;
  mtdCalls: number;
  failedMtdCostUsd: number;
  burnUsdPerDay: number;
  projectedMonthUsd: number;
  status: ProviderStatus;
};

export type UnpricedModelRow = {
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  lastSeen: string;
};

export type ProviderCredit = {
  budgetsAvailable: boolean;
  // The JS-fallback read hit its row cap (62-day window clipped).
  truncated: boolean;
  // True only when spend figures came from the truncated JS fallback (the
  // admin_provider_costs RPC is missing) — i.e. the figures are lower bounds.
  spendMayBeUnderstated: boolean;
  providers: ProviderCreditRow[];
  unpriced: UnpricedModelRow[];
};

type UsageRow = {
  created_at: string;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | string | null;
  status: string | null;
};

type ProviderCostRpcRow = {
  provider: string | null;
  mtd_cost_usd: number | string | null;
  mtd_calls: number | string | null;
  failed_mtd_cost_usd: number | string | null;
  prev_month_cost_usd: number | string | null;
  last30d_cost_usd: number | string | null;
};

type BudgetRow = {
  provider: string;
  monthly_budget_usd: number | string | null;
};

// Thrown by upsertProviderBudget when admin_provider_budgets doesn't exist, so
// the API route can return an actionable 501 instead of a raw 500.
export class BudgetsTableMissingError extends Error {
  constructor() {
    super(
      'admin_provider_budgets missing — apply admin/sql/patches/2026-07-07-provider-budgets.sql',
    );
    this.name = 'BudgetsTableMissingError';
  }
}

const PAGE_SIZE = 1000;
const MAX_ROWS = 20_000;
const WINDOW_DAYS = 62;

// Providers we always show a budget slot for, even with no usage yet. Mirrors
// the provider_kind enum in supabase/migrations/20260608120000_provider_usage.sql.
const KNOWN_PROVIDERS = [
  'anthropic',
  'openai',
  'openrouter',
  'google',
  'fal',
  'worker',
] as const;

function num(value: number | string | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

// Only a genuinely-absent relation counts as "missing" — 42P01 (undefined
// table) or PGRST205 (PostgREST can't find it in the schema cache). Anything
// else (e.g. a permission error) must surface, not silently read as $0.
function isMissingRelationError(error: {
  code?: string;
  message?: string;
}): boolean {
  return error.code === '42P01' || error.code === 'PGRST205';
}

function isMissingFunctionError(error: {
  code?: string;
  message?: string;
}): boolean {
  return error.code === '42883' || error.code === 'PGRST202';
}

// UTC calendar-month boundaries for "now".
function monthBounds(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const monthStart = Date.UTC(year, month, 1);
  const nextMonthStart = Date.UTC(year, month + 1, 1);
  const prevMonthStart = Date.UTC(year, month - 1, 1);
  const daysInMonth = new Date(nextMonthStart - 1).getUTCDate();
  // Days elapsed this month, inclusive of today (>= 1) so burn is never /0.
  const daysElapsed = Math.max(1, now.getUTCDate());
  return {
    monthStart,
    nextMonthStart,
    prevMonthStart,
    daysInMonth,
    daysElapsed,
    last30dStart: now.getTime() - 30 * 86_400_000,
  };
}

async function fetchUsageRows(): Promise<{
  rows: UsageRow[];
  truncated: boolean;
}> {
  const supa = getAdminClient();
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  const rows: UsageRow[] = [];

  for (let page = 0; page * PAGE_SIZE < MAX_ROWS; page++) {
    const { data, error } = await supa
      .from('provider_usage')
      .select(
        'created_at,provider,model,input_tokens,output_tokens,cost_usd,status',
      )
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (error) {
      // provider_usage missing → no spend data, but the page can still render
      // budgets/pricing catalog.
      if (isMissingRelationError(error)) {
        return { rows, truncated: false };
      }
      throw new Error(`provider_usage read: ${error.message}`);
    }
    const batch = (data ?? []) as UsageRow[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return { rows, truncated: false };
  }
  // Hit the row cap: the 62-day window is clipped, so prev-month totals may be
  // partial. Callers surface `truncated` so the numbers stay honest.
  return { rows, truncated: true };
}

async function fetchBudgets(): Promise<{
  available: boolean;
  budgets: Map<string, number>;
}> {
  const supa = getAdminClient();
  const { data, error } = await supa
    .from('admin_provider_budgets')
    .select('provider,monthly_budget_usd');
  if (error) {
    if (isMissingRelationError(error)) {
      return { available: false, budgets: new Map() };
    }
    throw new Error(`admin_provider_budgets read: ${error.message}`);
  }
  const budgets = new Map<string, number>();
  for (const row of (data ?? []) as BudgetRow[]) {
    budgets.set(row.provider, num(row.monthly_budget_usd));
  }
  return { available: true, budgets };
}

type Accum = {
  provider: string;
  mtdCostUsd: number;
  last30dCostUsd: number;
  prevMonthCostUsd: number;
  mtdCalls: number;
  failedMtdCostUsd: number;
};

// Per-provider spend from the admin_provider_costs RPC (aggregates ALL rows).
// Returns null when the function isn't applied yet so the caller can fall back
// to the bounded JS aggregation.
async function fetchProviderCostsRpc(): Promise<Map<string, Accum> | null> {
  const supa = getAdminClient();
  const { data, error } = await supa.rpc('admin_provider_costs');
  if (error) {
    if (isMissingFunctionError(error)) return null;
    throw new Error(`admin_provider_costs: ${error.message}`);
  }
  const map = new Map<string, Accum>();
  for (const row of (data ?? []) as ProviderCostRpcRow[]) {
    const provider = row.provider ?? 'unknown';
    map.set(provider, {
      provider,
      mtdCostUsd: num(row.mtd_cost_usd),
      last30dCostUsd: num(row.last30d_cost_usd),
      prevMonthCostUsd: num(row.prev_month_cost_usd),
      mtdCalls: num(row.mtd_calls),
      failedMtdCostUsd: num(row.failed_mtd_cost_usd),
    });
  }
  return map;
}

type UnpricedAccum = {
  provider: string;
  model: string;
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  lastSeen: string;
};

function statusFor(
  budget: number | null,
  mtdCostUsd: number,
  projectedMonthUsd: number,
): ProviderStatus {
  if (budget == null) return 'none';
  if (mtdCostUsd > budget) return 'over';
  if (projectedMonthUsd > budget || mtdCostUsd > 0.7 * budget) return 'warn';
  return 'ok';
}

export async function fetchProviderCredit(): Promise<ProviderCredit> {
  const [rpcCosts, { rows, truncated }, { available, budgets }] =
    await Promise.all([
      fetchProviderCostsRpc(),
      fetchUsageRows(),
      fetchBudgets(),
    ]);

  const bounds = monthBounds();
  // Spend comes from the RPC when available; otherwise from the JS aggregation
  // below. Either way `byProvider` is the canonical per-provider spend map.
  const byProvider = new Map<string, Accum>(rpcCosts ?? undefined);
  const useRpc = rpcCosts !== null;
  const unpriced = new Map<string, UnpricedAccum>();

  const accumFor = (provider: string): Accum => {
    let acc = byProvider.get(provider);
    if (!acc) {
      acc = {
        provider,
        mtdCostUsd: 0,
        last30dCostUsd: 0,
        prevMonthCostUsd: 0,
        mtdCalls: 0,
        failedMtdCostUsd: 0,
      };
      byProvider.set(provider, acc);
    }
    return acc;
  };

  // Always scan the JS rows for unpriced-model detection (needs per-row token
  // counts the RPC doesn't return). Aggregate spend here too, but only apply it
  // when the RPC is unavailable.
  for (const row of rows) {
    const provider = row.provider ?? 'unknown';
    const model = row.model ?? 'unknown';
    const cost = num(row.cost_usd);
    const ts = new Date(row.created_at).getTime();
    const failed = (row.status ?? 'success') !== 'success';

    if (!useRpc) {
      const acc = accumFor(provider);
      if (ts >= bounds.monthStart && ts < bounds.nextMonthStart) {
        acc.mtdCostUsd += cost;
        acc.mtdCalls += 1;
        if (failed) acc.failedMtdCostUsd += cost;
      }
      if (ts >= bounds.prevMonthStart && ts < bounds.monthStart) {
        acc.prevMonthCostUsd += cost;
      }
      if (ts >= bounds.last30dStart) {
        acc.last30dCostUsd += cost;
      }
    }

    // Unpriced detection uses the last-30d window only.
    if (ts >= bounds.last30dStart) {
      const key = `${provider}|${model}`;
      let u = unpriced.get(key);
      if (!u) {
        u = {
          provider,
          model,
          calls: 0,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          lastSeen: row.created_at,
        };
        unpriced.set(key, u);
      }
      u.calls += 1;
      u.costUsd += cost;
      u.inputTokens += num(row.input_tokens);
      u.outputTokens += num(row.output_tokens);
      if (new Date(row.created_at).getTime() > new Date(u.lastSeen).getTime()) {
        u.lastSeen = row.created_at;
      }
    }
  }

  // Ensure a card exists for every known provider and every budgeted provider,
  // even with no usage, so budgets can be set proactively.
  for (const provider of KNOWN_PROVIDERS) accumFor(provider);
  for (const provider of budgets.keys()) accumFor(provider);

  // Only a truncated JS fallback read produces understated spend.
  const spendMayBeUnderstated = !useRpc && truncated;

  const providers: ProviderCreditRow[] = [...byProvider.values()]
    .map((acc) => {
      const budgetUsd = budgets.has(acc.provider)
        ? (budgets.get(acc.provider) ?? null)
        : null;
      const burnUsdPerDay = acc.mtdCostUsd / bounds.daysElapsed;
      const projectedMonthUsd = burnUsdPerDay * bounds.daysInMonth;
      return {
        provider: acc.provider,
        budgetUsd,
        mtdCostUsd: acc.mtdCostUsd,
        last30dCostUsd: acc.last30dCostUsd,
        prevMonthCostUsd: acc.prevMonthCostUsd,
        mtdCalls: acc.mtdCalls,
        failedMtdCostUsd: acc.failedMtdCostUsd,
        burnUsdPerDay,
        projectedMonthUsd,
        status: statusFor(budgetUsd, acc.mtdCostUsd, projectedMonthUsd),
      };
    })
    .sort(
      (a, b) =>
        b.mtdCostUsd - a.mtdCostUsd || b.last30dCostUsd - a.last30dCostUsd,
    );

  // Unpriced models: logged at $0 COGS despite real activity — shared pricing
  // lacks a rate for them.
  const unpricedRows: UnpricedModelRow[] = [...unpriced.values()]
    .filter(
      (u) =>
        u.costUsd === 0 && (u.inputTokens + u.outputTokens > 0 || u.calls > 3),
    )
    .map((u) => ({
      provider: u.provider,
      model: u.model,
      calls: u.calls,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      lastSeen: u.lastSeen,
    }))
    .sort((a, b) => b.calls - a.calls);

  return {
    budgetsAvailable: available,
    truncated,
    spendMayBeUnderstated,
    providers,
    unpriced: unpricedRows,
  };
}

// Upsert (or delete when null) a provider's monthly budget. Validates the
// provider against the known enum set plus any provider actually seen in usage.
export async function upsertProviderBudget(
  provider: string,
  monthlyBudgetUsd: number | null,
): Promise<void> {
  const supa = getAdminClient();
  const normalized = provider.trim().toLowerCase();
  if (!normalized) throw new Error('provider is required');

  const allowed = new Set<string>(KNOWN_PROVIDERS);
  if (!allowed.has(normalized)) {
    // Allow any provider that has appeared in usage so operators can budget
    // for a newly introduced provider before the enum is widened. provider is a
    // provider_kind ENUM column, so an unknown value makes the equality throw
    // 22P02 (invalid enum text) — which is exactly the "unknown provider" case.
    const { data, error } = await supa
      .from('provider_usage')
      .select('provider')
      .eq('provider', normalized)
      .limit(1);
    if (error) {
      if (error.code === '22P02') {
        throw new Error(`unknown provider: ${provider}`);
      }
      if (!isMissingRelationError(error)) {
        throw new Error(`provider_usage lookup: ${error.message}`);
      }
    }
    if (!data || data.length === 0) {
      throw new Error(`unknown provider: ${provider}`);
    }
  }

  if (monthlyBudgetUsd == null) {
    const { error } = await supa
      .from('admin_provider_budgets')
      .delete()
      .eq('provider', normalized);
    if (error) {
      if (isMissingRelationError(error)) throw new BudgetsTableMissingError();
      throw new Error(`admin_provider_budgets delete: ${error.message}`);
    }
    return;
  }

  const { error } = await supa.from('admin_provider_budgets').upsert(
    {
      provider: normalized,
      monthly_budget_usd: monthlyBudgetUsd,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'provider' },
  );
  if (error) {
    if (isMissingRelationError(error)) throw new BudgetsTableMissingError();
    throw new Error(`admin_provider_budgets upsert: ${error.message}`);
  }
}

// Lightweight alert feed for the Overview page: only providers at/over budget.
// Must never throw — the Overview page renders regardless.
export async function fetchBudgetAlerts(): Promise<ProviderCreditRow[]> {
  try {
    const { providers } = await fetchProviderCredit();
    return providers.filter((p) => p.status === 'over' || p.status === 'warn');
  } catch {
    return [];
  }
}
