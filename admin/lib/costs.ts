import 'server-only';
import { getAdminClient } from './supabaseAdmin';

// ===========================================================================
// Windowed COGS explorer over provider_usage (per-call provider costs logged
// by the edge functions). Aggregation happens here rather than in SQL so the
// page works without any new database functions; volumes are bounded by
// MAX_ROWS and the table is indexed on created_at.
// ===========================================================================

export type CostTotals = {
  costUsd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  failedCalls: number;
  failedCostUsd: number;
};

export type ModelCostRow = {
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
};

export type OperationCostRow = {
  operation: string;
  calls: number;
  costUsd: number;
  units: number | null;
  unitLabel: string | null;
};

export type ProviderCostRow = {
  provider: string;
  calls: number;
  costUsd: number;
};

export type UserCostRow = {
  user_id: string;
  email: string | null;
  calls: number;
  costUsd: number;
};

export type ExpensiveCall = {
  id: number;
  created_at: string;
  user_id: string | null;
  email: string | null;
  operation: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  status: string;
};

export type CostExplorer = {
  days: number | null;
  truncated: boolean;
  rowCount: number;
  totals: CostTotals;
  byModel: ModelCostRow[];
  byOperation: OperationCostRow[];
  byProvider: ProviderCostRow[];
  topUsers: UserCostRow[];
  topCalls: ExpensiveCall[];
};

type UsageRow = {
  id: number;
  created_at: string;
  user_id: string | null;
  operation: string | null;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  cost_usd: number | string | null;
  status: string | null;
};

const PAGE_SIZE = 1000;
const MAX_ROWS = 20_000;

function cutoffIso(days: number | null): string | null {
  if (!days) return null;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

async function fetchUsageRows(
  days: number | null,
): Promise<{ rows: UsageRow[]; truncated: boolean }> {
  const supa = getAdminClient();
  const cutoff = cutoffIso(days);
  const rows: UsageRow[] = [];
  let truncated = false;

  for (let page = 0; page * PAGE_SIZE < MAX_ROWS; page++) {
    let query = supa
      .from('provider_usage')
      .select(
        'id,created_at,user_id,operation,provider,model,input_tokens,output_tokens,cached_input_tokens,cost_usd,status',
      )
      .order('created_at', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (cutoff) query = query.gte('created_at', cutoff);
    const { data, error } = await query;
    if (error) throw new Error(`provider_usage read: ${error.message}`);
    const batch = (data ?? []) as UsageRow[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return { rows, truncated };
  }
  truncated = true;
  return { rows, truncated };
}

// Counts successful generation units in the window so operations can be
// expressed as cost-per-unit. Operations missing here (chat, title, prompt)
// are conversational overhead with no single output unit.
async function fetchUnitCounts(
  days: number | null,
): Promise<Record<string, { units: number; unitLabel: string }>> {
  const supa = getAdminClient();
  const cutoff = cutoffIso(days);

  // Structural view of a head/count query so the window filter doesn't drag
  // TypeScript through supabase-js's deeply generic builder types.
  type CountQuery = PromiseLike<{ count: number | null }> & {
    gte(column: string, value: string): CountQuery;
  };

  const windowedCount = (query: unknown): Promise<number> => {
    let q = query as CountQuery;
    if (cutoff) q = q.gte('created_at', cutoff);
    return Promise.resolve(q).then((result) => result.count ?? 0);
  };

  const [parametric, meshes, images, cadJobs, previews] = await Promise.all([
    windowedCount(
      supa
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'assistant')
        .not('content->artifact', 'is', null),
    ),
    windowedCount(
      supa
        .from('meshes')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'success'),
    ),
    windowedCount(
      supa
        .from('images')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'success'),
    ),
    windowedCount(
      supa
        .from('cad_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'success'),
    ),
    windowedCount(
      supa
        .from('previews')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'success'),
    ),
  ]);

  return {
    parametric: { units: parametric, unitLabel: 'parametric models' },
    mesh: { units: meshes, unitLabel: 'meshes' },
    image: { units: images, unitLabel: 'images' },
    cad: { units: cadJobs, unitLabel: 'CAD jobs' },
    preview: { units: previews, unitLabel: 'previews' },
  };
}

async function emailMapFor(
  userIds: Array<string | null | undefined>,
): Promise<Map<string, string | null>> {
  const supa = getAdminClient();
  const unique = [...new Set(userIds.filter(Boolean) as string[])];
  const entries = await Promise.all(
    unique.map(async (userId) => {
      const { data, error } = await supa.auth.admin.getUserById(userId);
      return [userId, error ? null : (data.user?.email ?? null)] as const;
    }),
  );
  return new Map(entries);
}

export async function fetchCostExplorer(
  days: number | null,
): Promise<CostExplorer> {
  const [{ rows, truncated }, unitCounts] = await Promise.all([
    fetchUsageRows(days),
    fetchUnitCounts(days),
  ]);

  const totals: CostTotals = {
    costUsd: 0,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    failedCalls: 0,
    failedCostUsd: 0,
  };
  const byModel = new Map<string, ModelCostRow>();
  const byOperation = new Map<string, OperationCostRow>();
  const byProvider = new Map<string, ProviderCostRow>();
  const byUser = new Map<string, UserCostRow>();

  for (const row of rows) {
    const cost = Number(row.cost_usd ?? 0) || 0;
    const provider = row.provider ?? 'unknown';
    const model = row.model ?? 'unknown';
    const operation = row.operation ?? 'unknown';
    const failed = (row.status ?? 'success') !== 'success';

    totals.costUsd += cost;
    totals.calls += 1;
    totals.inputTokens += row.input_tokens ?? 0;
    totals.outputTokens += row.output_tokens ?? 0;
    totals.cachedTokens += row.cached_input_tokens ?? 0;
    if (failed) {
      totals.failedCalls += 1;
      totals.failedCostUsd += cost;
    }

    const modelKey = `${provider}|${model}`;
    const modelRow = byModel.get(modelKey) ?? {
      provider,
      model,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
    };
    modelRow.calls += 1;
    modelRow.inputTokens += row.input_tokens ?? 0;
    modelRow.outputTokens += row.output_tokens ?? 0;
    modelRow.cachedTokens += row.cached_input_tokens ?? 0;
    modelRow.costUsd += cost;
    byModel.set(modelKey, modelRow);

    const opRow = byOperation.get(operation) ?? {
      operation,
      calls: 0,
      costUsd: 0,
      units: null,
      unitLabel: null,
    };
    opRow.calls += 1;
    opRow.costUsd += cost;
    byOperation.set(operation, opRow);

    const providerRow = byProvider.get(provider) ?? {
      provider,
      calls: 0,
      costUsd: 0,
    };
    providerRow.calls += 1;
    providerRow.costUsd += cost;
    byProvider.set(provider, providerRow);

    if (row.user_id) {
      const userRow = byUser.get(row.user_id) ?? {
        user_id: row.user_id,
        email: null,
        calls: 0,
        costUsd: 0,
      };
      userRow.calls += 1;
      userRow.costUsd += cost;
      byUser.set(row.user_id, userRow);
    }
  }

  for (const opRow of byOperation.values()) {
    const unit = unitCounts[opRow.operation];
    if (unit) {
      opRow.units = unit.units;
      opRow.unitLabel = unit.unitLabel;
    }
  }

  const topUsers = [...byUser.values()]
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 10);

  const expensive = [...rows]
    .sort(
      (a, b) => (Number(b.cost_usd ?? 0) || 0) - (Number(a.cost_usd ?? 0) || 0),
    )
    .slice(0, 12);

  const emails = await emailMapFor([
    ...topUsers.map((u) => u.user_id),
    ...expensive.map((c) => c.user_id),
  ]);
  for (const user of topUsers) {
    user.email = emails.get(user.user_id) ?? null;
  }

  return {
    days,
    truncated,
    rowCount: rows.length,
    totals,
    byModel: [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd),
    byOperation: [...byOperation.values()].sort(
      (a, b) => b.costUsd - a.costUsd,
    ),
    byProvider: [...byProvider.values()].sort((a, b) => b.costUsd - a.costUsd),
    topUsers,
    topCalls: expensive.map((row) => ({
      id: row.id,
      created_at: row.created_at,
      user_id: row.user_id,
      email: row.user_id ? (emails.get(row.user_id) ?? null) : null,
      operation: row.operation ?? 'unknown',
      provider: row.provider ?? 'unknown',
      model: row.model ?? 'unknown',
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      costUsd: Number(row.cost_usd ?? 0) || 0,
      status: row.status ?? 'success',
    })),
  };
}
