import 'server-only';
import { getAdminClient } from './supabaseAdmin';
import { TOKEN_INTERNAL_USD_COST, TOKEN_USD_VALUE } from './pricing';

export type Overview = {
  users: {
    total: number;
    new_7d: number;
    new_30d: number;
    active_30d: number;
    paying: number;
  };
  generations: {
    cad_jobs: number;
    cad_jobs_30d: number;
    cad_jobs_success: number;
    cad_jobs_failure: number;
    meshes: number;
    meshes_30d: number;
    meshes_failure: number;
    images: number;
    conversations: number;
    messages: number;
    prompts: number;
  };
  tokens: {
    consumed_total: number;
    consumed_30d: number;
    by_operation: Record<string, number>;
    refunded: number;
    balance_subscription: number;
    balance_purchased: number;
    purchased_credited: number;
  };
  revenue: {
    mrr_cents: number;
    by_plan: Record<string, number>;
    token_pack_revenue_cents: number;
    token_pack_revenue_30d_cents: number;
  };
};

export type DailyActivity = {
  day: string;
  signups: number;
  cad_jobs: number;
  meshes: number;
  images: number;
  tokens_consumed: number;
};

export type RecentGeneration = {
  kind: string;
  id: string;
  status: string;
  created_at: string;
  user_email: string | null;
  title: string | null;
};

export type TopUser = {
  user_id: string;
  email: string | null;
  full_name: string | null;
  tokens_consumed: number;
  generations: number;
  plan: string;
  created_at: string;
};

export async function fetchOverview(): Promise<Overview> {
  const supa = getAdminClient();
  const { data, error } = await supa.rpc('admin_overview');
  if (error) throw new Error(`admin_overview: ${error.message}`);
  return data as Overview;
}

export async function fetchDailyActivity(days = 30): Promise<DailyActivity[]> {
  const supa = getAdminClient();
  const { data, error } = await supa.rpc('admin_daily_activity', { days });
  if (error) throw new Error(`admin_daily_activity: ${error.message}`);
  return (data ?? []) as DailyActivity[];
}

export async function fetchRecentGenerations(
  limit = 30,
): Promise<RecentGeneration[]> {
  const supa = getAdminClient();
  const { data, error } = await supa.rpc('admin_recent_generations', {
    p_limit: limit,
  });
  if (error) throw new Error(`admin_recent_generations: ${error.message}`);
  return (data ?? []) as RecentGeneration[];
}

export async function fetchTopUsers(limit = 10): Promise<TopUser[]> {
  const supa = getAdminClient();
  const { data, error } = await supa.rpc('admin_top_users', { p_limit: limit });
  if (error) throw new Error(`admin_top_users: ${error.message}`);
  return (data ?? []) as TopUser[];
}

// Derived economics from consumed tokens.
export function tokenCostUsd(tokensConsumed: number): number {
  return tokensConsumed * TOKEN_INTERNAL_USD_COST;
}

export function tokenValueUsd(tokensConsumed: number): number {
  return tokensConsumed * TOKEN_USD_VALUE;
}

// ===========================================================================
// Data-explorer types + fetchers (admin_explorer.sql).
// ===========================================================================

// --- Users page -----------------------------------------------------------
export type UserRow = {
  user_id: string;
  email: string | null;
  full_name: string | null;
  plan: string;
  sub_status: string | null;
  created_at: string;
  last_active: string;
  generations: number;
  tokens_consumed: number;
  est_cost_usd: number;
  actual_cost_usd: number | null;
  revenue_cents: number;
  total_count: number;
};

export type UsersPage = { rows: UserRow[]; total: number };

export async function fetchUsersPage({
  search = null,
  limit = 50,
  offset = 0,
  sort = 'last_active',
  order = 'desc',
}: {
  search?: string | null;
  limit?: number;
  offset?: number;
  sort?: string;
  order?: string;
}): Promise<UsersPage> {
  const supa = getAdminClient();
  const { data, error } = await supa.rpc('admin_users_page', {
    p_search: search,
    p_limit: limit,
    p_offset: offset,
    p_sort: sort,
    p_order: order,
  });
  if (error) throw new Error(`admin_users_page: ${error.message}`);
  const rows = (data ?? []) as UserRow[];
  return { rows, total: rows[0]?.total_count ?? 0 };
}

// --- User detail ------------------------------------------------------------
export type UserDetail = {
  profile: {
    user_id: string;
    email: string | null;
    full_name: string | null;
    avatar_path: string | null;
    created_at: string;
    has_trialed: boolean;
  } | null;
  subscription: {
    level: string;
    status: string | null;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    created_at: string;
  } | null;
  balances: Record<string, { balance: number; expires_at: string | null }>;
  tokens: {
    consumed_total: number;
    consumed_30d: number;
    by_operation: Record<string, number>;
    refunded: number;
  };
  generations: {
    cad_jobs: number;
    cad_jobs_success: number;
    cad_jobs_failure: number;
    meshes: number;
    meshes_failure: number;
    images: number;
    conversations: number;
  };
  actual_cost_usd: number | null;
  revenue: {
    token_pack_cents: number;
    plan_monthly_cents: number;
  };
};

export async function fetchUserDetail(userId: string): Promise<UserDetail> {
  const supa = getAdminClient();
  const { data, error } = await supa.rpc('admin_user_detail', {
    p_user_id: userId,
  });
  if (error) throw new Error(`admin_user_detail: ${error.message}`);
  return data as UserDetail;
}

export type UserGeneration = {
  kind: string;
  id: string;
  status: string;
  created_at: string;
  title: string | null;
  file_type: string | null;
  conversation_id: string;
  prompt: unknown;
  message_id: string | null;
  error: string | null;
};

export async function fetchUserGenerations(
  userId: string,
  limit = 50,
): Promise<UserGeneration[]> {
  const supa = getAdminClient();
  const { data, error } = await supa.rpc('admin_user_generation_details', {
    p_user_id: userId,
    p_limit: limit,
  });
  if (error) {
    return fetchUserGenerationsDirect(userId, limit);
  }
  const rows = (data ?? []) as UserGeneration[];
  // The RPC doesn't know about parametric artifacts; merge them in.
  const parametric = await fetchParametricRowsDirect(supa, limit, userId).catch(
    () => [],
  );
  return [
    ...rows,
    ...parametric.map((row) => ({
      kind: row.kind,
      id: row.id,
      status: row.status,
      created_at: row.created_at,
      title: row.conversation_title,
      file_type: row.file_type,
      conversation_id: row.conversation_id,
      prompt: row.prompt,
      message_id: row.message_id,
      error: row.error,
    })),
  ]
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )
    .slice(0, limit);
}

export type UserConversation = {
  id: string;
  title: string;
  type: string;
  privacy: string;
  created_at: string;
  updated_at: string | null;
  message_count: number;
  cad_jobs: number;
  meshes: number;
  images: number;
  latest_message_at: string | null;
  latest_user_prompt: unknown;
};

export async function fetchUserConversations(
  userId: string,
  limit = 50,
): Promise<UserConversation[]> {
  const supa = getAdminClient();
  const { data, error } = await supa.rpc('admin_user_conversations', {
    p_user_id: userId,
    p_limit: limit,
  });
  if (error) return fetchUserConversationsDirect(userId, limit);
  return (data ?? []) as UserConversation[];
}

export type GenerationRow = {
  kind: string;
  id: string;
  status: string;
  created_at: string;
  user_id: string;
  email: string | null;
  conversation_id: string;
  conversation_title: string | null;
  conversation_type: string | null;
  prompt: unknown;
  file_type: string | null;
  message_id: string | null;
  error: string | null;
  actual_cost_usd: number | null;
  tokens_used: number | null;
  total_count: number;
};

export type GenerationsPage = { rows: GenerationRow[]; total: number };

export async function fetchGenerationsPage({
  search = null,
  kind = null,
  status = null,
  limit = 50,
  offset = 0,
}: {
  search?: string | null;
  kind?: string | null;
  status?: string | null;
  limit?: number;
  offset?: number;
}): Promise<GenerationsPage> {
  const supa = getAdminClient();

  // Parametric (OpenSCAD) artifacts live in message content, which the
  // admin_generations_page RPC doesn't know about — always served directly.
  if (kind?.toLowerCase() === 'parametric') {
    return fetchGenerationsPageDirect({ search, kind, status, limit, offset });
  }

  // Only send p_status when filtering: databases still on the 4-arg version
  // of admin_generations_page keep matching for the common unfiltered path
  // (a status-filtered call errors there and uses the direct fallback).
  const args: Record<string, unknown> = {
    p_search: search,
    p_kind: kind,
    p_limit: limit,
    p_offset: offset,
  };
  if (status) args.p_status = status;

  // For the "all kinds" view, over-fetch the RPC page so parametric rows can
  // be merged into the correct sort positions before slicing.
  const mergeParametric = !kind;
  const window = Math.min(offset + limit, 500);
  if (mergeParametric) {
    args.p_limit = window;
    args.p_offset = 0;
  }

  const { data, error } = await supa.rpc('admin_generations_page', args);
  if (error) {
    return fetchGenerationsPageDirect({ search, kind, status, limit, offset });
  }
  const rows = (data ?? []) as GenerationRow[];
  if (!mergeParametric) {
    return {
      rows: await addGenerationEconomics(supa, rows),
      total: rows[0]?.total_count ?? 0,
    };
  }

  const rpcTotal = rows[0]?.total_count ?? 0;
  // Degrade to the RPC rows alone if the parametric merge fails; the explicit
  // kind=parametric filter still surfaces such errors.
  const parametric = await fetchParametricRowsDirect(
    supa,
    window,
    undefined,
    status?.toLowerCase() || undefined,
  ).catch(() => [] as GenerationRow[]);
  const emailMap = await fetchUserEmailMap(parametric.map((r) => r.user_id));
  const merged = [
    ...rows,
    ...parametric
      .map((row) => ({ ...row, email: emailMap.get(row.user_id) ?? null }))
      .filter((row) => matchesGenerationSearch(row, search)),
  ].sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  const total = rpcTotal + (await countParametricArtifacts(supa, status));
  return {
    rows: await addGenerationEconomics(
      supa,
      merged
        .slice(offset, offset + limit)
        .map((row) => ({ ...row, total_count: total })),
    ),
    total,
  };
}

export type ConversationMessage = {
  id: string;
  created_at: string;
  role: string;
  content: unknown;
  rating: number;
  parent_message_id: string | null;
};

export type ConversationGeneration = {
  kind: string;
  id: string;
  status: string;
  created_at: string;
  prompt: unknown;
  file_type: string | null;
  message_id: string | null;
  error: string | null;
};

export type ConversationDetail = {
  conversation: {
    id: string;
    title: string;
    type: string;
    privacy: string;
    created_at: string | null;
    updated_at: string | null;
    user_id: string;
    user_email: string | null;
    settings: unknown;
  } | null;
  messages: ConversationMessage[];
  generations: {
    cad_jobs: ConversationGeneration[];
    meshes: ConversationGeneration[];
    images: ConversationGeneration[];
  };
};

export async function fetchConversationDetail(
  conversationId: string,
): Promise<ConversationDetail> {
  const supa = getAdminClient();
  const { data, error } = await supa.rpc('admin_conversation_detail', {
    p_conversation_id: conversationId,
  });
  if (error) return fetchConversationDetailDirect(conversationId);
  return data as ConversationDetail;
}

type JoinedConversation =
  | { title?: string | null; type?: string | null }
  | { title?: string | null; type?: string | null }[]
  | null;

function normalizeJoinedConversation(value: JoinedConversation) {
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

async function fetchUserEmailMap(
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

function matchesGenerationSearch(row: GenerationRow, search?: string | null) {
  const q = search?.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    row.id,
    row.user_id,
    row.email,
    row.conversation_id,
    row.conversation_title,
    row.conversation_type,
    JSON.stringify(row.prompt ?? {}),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

async function fetchGenerationsPageDirect({
  search = null,
  kind = null,
  status = null,
  limit = 50,
  offset = 0,
}: {
  search?: string | null;
  kind?: string | null;
  status?: string | null;
  limit?: number;
  offset?: number;
}): Promise<GenerationsPage> {
  const supa = getAdminClient();
  const requestedKind = kind?.toLowerCase();
  const requestedStatus = status?.toLowerCase() || undefined;
  const queryLimit = Math.min(Math.max(limit + offset, 100), 500);
  const jobs: Promise<GenerationRow[]>[] = [];

  if (!requestedKind || requestedKind === 'cad') {
    jobs.push(fetchCadRowsDirect(supa, queryLimit, undefined, requestedStatus));
  }
  if (!requestedKind || requestedKind === 'mesh') {
    jobs.push(
      fetchMeshRowsDirect(supa, queryLimit, undefined, requestedStatus),
    );
  }
  if (!requestedKind || requestedKind === 'image') {
    jobs.push(
      fetchImageRowsDirect(supa, queryLimit, undefined, requestedStatus),
    );
  }
  if (requestedKind === 'parametric') {
    jobs.push(
      fetchParametricRowsDirect(supa, queryLimit, undefined, requestedStatus),
    );
  } else if (!requestedKind) {
    // Merged view: a parametric failure shouldn't blank the other kinds.
    jobs.push(
      fetchParametricRowsDirect(
        supa,
        queryLimit,
        undefined,
        requestedStatus,
      ).catch(() => [] as GenerationRow[]),
    );
  }

  const rowsWithoutEmails = (await Promise.all(jobs)).flat();
  const emailMap = await fetchUserEmailMap(
    rowsWithoutEmails.map((row) => row.user_id),
  );
  const filtered = rowsWithoutEmails
    .map((row) => ({ ...row, email: emailMap.get(row.user_id) ?? null }))
    .filter((row) => matchesGenerationSearch(row, search))
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );

  return {
    rows: await addGenerationEconomics(
      supa,
      filtered.slice(offset, offset + limit).map((row) => ({
        ...row,
        total_count: filtered.length,
      })),
    ),
    total: filtered.length,
  };
}

async function addGenerationEconomics(
  supa: ReturnType<typeof getAdminClient>,
  rows: GenerationRow[],
): Promise<GenerationRow[]> {
  const withEmptyEconomics = () =>
    rows.map((row) => ({
      ...row,
      actual_cost_usd: row.actual_cost_usd ?? null,
      tokens_used: row.tokens_used ?? null,
    }));
  const ids = [...new Set(rows.map((row) => row.id).filter(Boolean))];
  if (ids.length === 0) return withEmptyEconomics();

  const [usageResult, tokenResult] = await Promise.all([
    supa
      .from('provider_usage')
      .select('reference_id,cost_usd')
      .in('reference_id', ids),
    supa
      .from('token_transactions')
      .select('reference_id,amount')
      .in('reference_id', ids),
  ]);

  const costs = new Map<string, number>();
  if (!usageResult.error) {
    for (const row of (usageResult.data ?? []) as Array<{
      reference_id: string | null;
      cost_usd: number | string | null;
    }>) {
      if (!row.reference_id) continue;
      const cost = Number(row.cost_usd ?? 0);
      if (!Number.isFinite(cost)) continue;
      costs.set(row.reference_id, (costs.get(row.reference_id) ?? 0) + cost);
    }
  }

  const exactTokens = new Map<string, number>();
  if (!tokenResult.error) {
    for (const row of (tokenResult.data ?? []) as Array<{
      reference_id: string | null;
      amount: number | string | null;
    }>) {
      if (!row.reference_id) continue;
      const amount = Number(row.amount ?? 0);
      if (!Number.isFinite(amount) || amount >= 0) continue;
      exactTokens.set(
        row.reference_id,
        (exactTokens.get(row.reference_id) ?? 0) - amount,
      );
    }
  }

  const enriched = rows.map((row) => ({
    ...row,
    actual_cost_usd: costs.has(row.id) ? (costs.get(row.id) ?? 0) : null,
    tokens_used: exactTokens.has(row.id)
      ? (exactTokens.get(row.id) ?? 0)
      : null,
  }));

  return addLegacyTokenMatches(supa, enriched);
}

async function addLegacyTokenMatches(
  supa: ReturnType<typeof getAdminClient>,
  rows: GenerationRow[],
): Promise<GenerationRow[]> {
  const missing = rows.filter(
    (row) =>
      row.tokens_used == null &&
      (row.kind === 'mesh' || row.kind === 'parametric'),
  );
  if (missing.length === 0) return rows;

  const userIds = [
    ...new Set(missing.map((row) => row.user_id).filter(Boolean)),
  ];
  if (userIds.length === 0) return rows;

  const times = missing.map((row) => new Date(row.created_at).getTime());
  const minCreated = Math.min(...times);
  const maxCreated = Math.max(...times);
  const { data, error } = await supa
    .from('token_transactions')
    .select('user_id,operation,amount,reference_id,created_at')
    .in('user_id', userIds)
    .in('operation', ['mesh', 'parametric'])
    .lt('amount', 0)
    .gte('created_at', new Date(minCreated - 10 * 60_000).toISOString())
    .lte('created_at', new Date(maxCreated + 10 * 60_000).toISOString())
    .order('created_at', { ascending: true });
  if (error) return rows;

  const candidates = (
    (data ?? []) as Array<{
      user_id: string | null;
      operation: string | null;
      amount: number | string | null;
      reference_id: string | null;
      created_at: string;
    }>
  ).filter(
    (candidate) => !rows.some((row) => row.id === candidate.reference_id),
  );
  const used = new Set<number>();
  const inferredTokens = new Map<string, number>();

  for (const row of missing) {
    const operation = row.kind === 'mesh' ? 'mesh' : 'parametric';
    const rowTime = new Date(row.created_at).getTime();
    const maxDistanceMs = row.kind === 'mesh' ? 2 * 60_000 : 5 * 60_000;
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    candidates.forEach((candidate, index) => {
      if (used.has(index)) return;
      if (
        candidate.user_id !== row.user_id ||
        candidate.operation !== operation
      ) {
        return;
      }
      const amount = Number(candidate.amount ?? 0);
      if (!Number.isFinite(amount) || amount >= 0) return;
      const distance = Math.abs(
        new Date(candidate.created_at).getTime() - rowTime,
      );
      if (distance <= maxDistanceMs && distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });

    if (bestIndex >= 0) {
      used.add(bestIndex);
      inferredTokens.set(row.id, -Number(candidates[bestIndex].amount ?? 0));
    }
  }

  return rows.map((row) => ({
    ...row,
    tokens_used: row.tokens_used ?? inferredTokens.get(row.id) ?? null,
  }));
}

async function fetchCadRowsDirect(
  supa: ReturnType<typeof getAdminClient>,
  limit: number,
  userId?: string,
  status?: string,
): Promise<GenerationRow[]> {
  let query = supa
    .from('cad_jobs')
    .select(
      'id,status,created_at,user_id,conversation_id,prompt,message_id,error,conversations(title,type)',
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (userId) query = query.eq('user_id', userId);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw new Error(`cad_jobs fallback: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => {
    const conversation = normalizeJoinedConversation(
      row.conversations as JoinedConversation,
    );
    return {
      kind: 'cad',
      id: row.id as string,
      status: row.status as string,
      created_at: row.created_at as string,
      user_id: row.user_id as string,
      email: null,
      conversation_id: row.conversation_id as string,
      conversation_title: conversation?.title ?? null,
      conversation_type: conversation?.type ?? null,
      prompt: row.prompt,
      file_type: null,
      message_id: (row.message_id as string | null) ?? null,
      error: (row.error as string | null) ?? null,
      actual_cost_usd: null,
      tokens_used: null,
      total_count: 0,
    };
  });
}

async function fetchMeshRowsDirect(
  supa: ReturnType<typeof getAdminClient>,
  limit: number,
  userId?: string,
  status?: string,
): Promise<GenerationRow[]> {
  let query = supa
    .from('meshes')
    .select(
      'id,status,created_at,user_id,conversation_id,prompt,file_type,conversations(title,type)',
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (userId) query = query.eq('user_id', userId);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw new Error(`meshes fallback: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => {
    const conversation = normalizeJoinedConversation(
      row.conversations as JoinedConversation,
    );
    return {
      kind: 'mesh',
      id: row.id as string,
      status: row.status as string,
      created_at: row.created_at as string,
      user_id: row.user_id as string,
      email: null,
      conversation_id: row.conversation_id as string,
      conversation_title: conversation?.title ?? null,
      conversation_type: conversation?.type ?? null,
      prompt: row.prompt,
      file_type: (row.file_type as string | null) ?? null,
      message_id: null,
      error: null,
      actual_cost_usd: null,
      tokens_used: null,
      total_count: 0,
    };
  });
}

async function fetchImageRowsDirect(
  supa: ReturnType<typeof getAdminClient>,
  limit: number,
  userId?: string,
  status?: string,
): Promise<GenerationRow[]> {
  let query = supa
    .from('images')
    .select(
      'id,status,created_at,user_id,conversation_id,prompt,conversations(title,type)',
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (userId) query = query.eq('user_id', userId);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw new Error(`images fallback: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => {
    const conversation = normalizeJoinedConversation(
      row.conversations as JoinedConversation,
    );
    return {
      kind: 'image',
      id: row.id as string,
      status: row.status as string,
      created_at: row.created_at as string,
      user_id: row.user_id as string,
      email: null,
      conversation_id: row.conversation_id as string,
      conversation_title: conversation?.title ?? null,
      conversation_type: conversation?.type ?? null,
      prompt: row.prompt,
      file_type: null,
      message_id: null,
      error: null,
      actual_cost_usd: null,
      tokens_used: null,
      total_count: 0,
    };
  });
}

// Parametric (OpenSCAD) generations are assistant messages carrying a
// `content.artifact` payload — there is no dedicated table. The conversation
// join is `!inner` so user filters apply and user_id is always present. The
// artifact code is stripped from list rows to keep pages light; the detail
// view loads the full message.
async function fetchParametricRowsDirect(
  supa: ReturnType<typeof getAdminClient>,
  limit: number,
  userId?: string,
  status?: string,
): Promise<GenerationRow[]> {
  // An artifact only exists once generation succeeded.
  if (status && status !== 'success') return [];
  let query = supa
    .from('messages')
    .select(
      'id,created_at,conversation_id,content,conversations!inner(title,type,user_id)',
    )
    .eq('role', 'assistant')
    .not('content->artifact', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (userId) query = query.eq('conversations.user_id', userId);
  const { data, error } = await query;
  if (error) throw new Error(`parametric fallback: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => {
    const conversation = normalizeJoinedConversation(
      row.conversations as JoinedConversation,
    ) as { title?: string | null; type?: string | null; user_id?: string };
    const content = (row.content ?? {}) as Record<string, unknown>;
    const artifact = (content.artifact ?? {}) as Record<string, unknown>;
    return {
      kind: 'parametric',
      id: row.id as string,
      status: 'success',
      created_at: row.created_at as string,
      user_id: conversation?.user_id ?? '',
      email: null,
      conversation_id: row.conversation_id as string,
      conversation_title: conversation?.title ?? null,
      conversation_type: conversation?.type ?? null,
      prompt: {
        text: typeof content.text === 'string' ? content.text : undefined,
        artifact: {
          title: artifact.title,
          version: artifact.version,
          parameters: Array.isArray(artifact.parameters)
            ? artifact.parameters.length
            : 0,
        },
      },
      file_type: 'scad',
      message_id: row.id as string,
      error: null,
      actual_cost_usd: null,
      tokens_used: null,
      total_count: 0,
    };
  });
}

async function countParametricArtifacts(
  supa: ReturnType<typeof getAdminClient>,
  status?: string | null,
): Promise<number> {
  if (status && status.toLowerCase() !== 'success') return 0;
  const { count, error } = await supa
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'assistant')
    .not('content->artifact', 'is', null);
  if (error) return 0;
  return count ?? 0;
}

async function fetchUserGenerationsDirect(
  userId: string,
  limit: number,
): Promise<UserGeneration[]> {
  const supa = getAdminClient();
  const rows = (
    await Promise.all([
      fetchCadRowsDirect(supa, limit, userId),
      fetchMeshRowsDirect(supa, limit, userId),
      fetchImageRowsDirect(supa, limit, userId),
      fetchParametricRowsDirect(supa, limit, userId),
    ])
  )
    .flat()
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )
    .slice(0, limit);

  return rows.map((row) => ({
    kind: row.kind,
    id: row.id,
    status: row.status,
    created_at: row.created_at,
    title: row.conversation_title,
    file_type: row.file_type,
    conversation_id: row.conversation_id,
    prompt: row.prompt,
    message_id: row.message_id,
    error: row.error,
  }));
}

async function fetchUserConversationsDirect(
  userId: string,
  limit: number,
): Promise<UserConversation[]> {
  const supa = getAdminClient();
  const { data, error } = await supa
    .from('conversations')
    .select('id,title,type,privacy,created_at,updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`conversations fallback: ${error.message}`);

  return Promise.all(
    ((data ?? []) as Array<Record<string, string | null>>).map(async (row) => {
      const conversationId = row.id as string;
      const [messages, cadJobs, meshes, images, latestPrompt] =
        await Promise.all([
          supa
            .from('messages')
            .select('id', { count: 'exact', head: true })
            .eq('conversation_id', conversationId),
          supa
            .from('cad_jobs')
            .select('id', { count: 'exact', head: true })
            .eq('conversation_id', conversationId),
          supa
            .from('meshes')
            .select('id', { count: 'exact', head: true })
            .eq('conversation_id', conversationId),
          supa
            .from('images')
            .select('id', { count: 'exact', head: true })
            .eq('conversation_id', conversationId),
          supa
            .from('messages')
            .select('content,created_at')
            .eq('conversation_id', conversationId)
            .eq('role', 'user')
            .order('created_at', { ascending: false })
            .limit(1),
        ]);

      return {
        id: conversationId,
        title: row.title ?? '',
        type: row.type ?? '',
        privacy: row.privacy ?? '',
        created_at: row.created_at ?? '',
        updated_at: row.updated_at,
        message_count: messages.count ?? 0,
        cad_jobs: cadJobs.count ?? 0,
        meshes: meshes.count ?? 0,
        images: images.count ?? 0,
        latest_message_at:
          ((latestPrompt.data?.[0] as Record<string, unknown> | undefined)
            ?.created_at as string | undefined) ?? null,
        latest_user_prompt:
          ((latestPrompt.data?.[0] as Record<string, unknown> | undefined)
            ?.content as unknown) ?? null,
      };
    }),
  );
}

async function fetchConversationDetailDirect(
  conversationId: string,
): Promise<ConversationDetail> {
  const supa = getAdminClient();
  const { data: conversationRow, error: conversationError } = await supa
    .from('conversations')
    .select('id,title,type,privacy,created_at,updated_at,user_id,settings')
    .eq('id', conversationId)
    .maybeSingle();
  if (conversationError) {
    throw new Error(`conversation fallback: ${conversationError.message}`);
  }
  if (!conversationRow) {
    return {
      conversation: null,
      messages: [],
      generations: { cad_jobs: [], meshes: [], images: [] },
    };
  }

  const row = conversationRow as Record<string, unknown>;
  const [emailMap, messages, cadJobs, meshes, images] = await Promise.all([
    fetchUserEmailMap([row.user_id as string]),
    supa
      .from('messages')
      .select('id,created_at,role,content,rating,parent_message_id')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true }),
    supa
      .from('cad_jobs')
      .select('id,status,created_at,prompt,message_id,error')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false }),
    supa
      .from('meshes')
      .select('id,status,created_at,prompt,file_type')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false }),
    supa
      .from('images')
      .select('id,status,created_at,prompt')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false }),
  ]);

  return {
    conversation: {
      id: row.id as string,
      title: row.title as string,
      type: row.type as string,
      privacy: row.privacy as string,
      created_at: (row.created_at as string | null) ?? null,
      updated_at: (row.updated_at as string | null) ?? null,
      user_id: row.user_id as string,
      user_email: emailMap.get(row.user_id as string) ?? null,
      settings: row.settings,
    },
    messages: ((messages.data ?? []) as Array<Record<string, unknown>>).map(
      (message) => ({
        id: message.id as string,
        created_at: message.created_at as string,
        role: message.role as string,
        content: message.content,
        rating: message.rating as number,
        parent_message_id: (message.parent_message_id as string | null) ?? null,
      }),
    ),
    generations: {
      cad_jobs: ((cadJobs.data ?? []) as Array<Record<string, unknown>>).map(
        (item) => ({
          kind: 'cad',
          id: item.id as string,
          status: item.status as string,
          created_at: item.created_at as string,
          prompt: item.prompt,
          file_type: null,
          message_id: (item.message_id as string | null) ?? null,
          error: (item.error as string | null) ?? null,
        }),
      ),
      meshes: ((meshes.data ?? []) as Array<Record<string, unknown>>).map(
        (item) => ({
          kind: 'mesh',
          id: item.id as string,
          status: item.status as string,
          created_at: item.created_at as string,
          prompt: item.prompt,
          file_type: (item.file_type as string | null) ?? null,
          message_id: null,
          error: null,
        }),
      ),
      images: ((images.data ?? []) as Array<Record<string, unknown>>).map(
        (item) => ({
          kind: 'image',
          id: item.id as string,
          status: item.status as string,
          created_at: item.created_at as string,
          prompt: item.prompt,
          file_type: null,
          message_id: null,
          error: null,
        }),
      ),
    },
  };
}

export type UserTransaction = {
  id: number;
  operation: string;
  amount: number;
  source: string;
  reference_id: string | null;
  created_at: string;
};

export async function fetchUserTransactions(
  userId: string,
  limit = 50,
): Promise<UserTransaction[]> {
  const supa = getAdminClient();
  const { data, error } = await supa.rpc('admin_user_transactions', {
    p_user_id: userId,
    p_limit: limit,
  });
  if (error) throw new Error(`admin_user_transactions: ${error.message}`);
  return (data ?? []) as UserTransaction[];
}

// --- Costs ------------------------------------------------------------------
export type CostBreakdown = {
  has_provider_usage: boolean;
  cost_total_usd: number;
  cost_30d_usd: number;
  by_operation: Record<string, number>;
  by_provider: Record<string, number>;
  by_model: Record<string, number>;
  tokens_by_operation: Record<string, number>;
  revenue: {
    mrr_cents: number;
    by_plan: Record<string, number>;
    token_pack_cents: number;
  };
};

export async function fetchCostBreakdown(): Promise<CostBreakdown> {
  const supa = getAdminClient();
  const { data, error } = await supa.rpc('admin_cost_breakdown');
  if (error) throw new Error(`admin_cost_breakdown: ${error.message}`);
  return data as CostBreakdown;
}

export type CostDaily = {
  day: string;
  actual_cost_usd: number;
  est_cost_usd: number;
  token_pack_cents: number;
  signups: number;
};

export async function fetchCostDaily(days = 30): Promise<CostDaily[]> {
  const supa = getAdminClient();
  const { data, error } = await supa.rpc('admin_cost_daily', { p_days: days });
  if (error) throw new Error(`admin_cost_daily: ${error.message}`);
  return (data ?? []) as CostDaily[];
}

// --- Growth & retention -----------------------------------------------------
export type GrowthWeekly = {
  week: string;
  signups: number;
  active_users: number;
  new_subscriptions: number;
};

export async function fetchGrowthWeekly(weeks = 12): Promise<GrowthWeekly[]> {
  const supa = getAdminClient();
  const { data, error } = await supa.rpc('admin_growth_weekly', {
    p_weeks: weeks,
  });
  if (error) throw new Error(`admin_growth_weekly: ${error.message}`);
  return (data ?? []) as GrowthWeekly[];
}

export type CohortRow = {
  cohort_week: string;
  cohort_size: number;
  week_offset: number;
  active: number;
};

export async function fetchRetentionCohorts(weeks = 12): Promise<CohortRow[]> {
  const supa = getAdminClient();
  const { data, error } = await supa.rpc('admin_retention_cohorts', {
    p_weeks: weeks,
  });
  if (error) throw new Error(`admin_retention_cohorts: ${error.message}`);
  return (data ?? []) as CohortRow[];
}

export type Funnel = {
  signed_up: number;
  generated_anything: number;
  currently_subscribed: number;
  ever_subscribed: number;
  canceled: number;
};

export async function fetchFunnel(): Promise<Funnel> {
  const supa = getAdminClient();
  const { data, error } = await supa.rpc('admin_funnel');
  if (error) throw new Error(`admin_funnel: ${error.message}`);
  return data as Funnel;
}
