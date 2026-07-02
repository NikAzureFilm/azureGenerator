import 'server-only';
import { getAdminClient } from './supabaseAdmin';
import { displayGenerationTokens } from './generationTokens';
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
  from = null,
  to = null,
  limit = 50,
  offset = 0,
}: {
  search?: string | null;
  kind?: string | null;
  status?: string | null;
  // Inclusive created_at bounds as ISO timestamps.
  from?: string | null;
  to?: string | null;
  limit?: number;
  offset?: number;
}): Promise<GenerationsPage> {
  const supa = getAdminClient();
  const fromBound = from || undefined;
  const toBound = to || undefined;

  // Parametric (OpenSCAD) artifacts live in message content, which the
  // admin_generations_page RPC doesn't know about — always served directly.
  if (kind?.toLowerCase() === 'parametric') {
    return fetchGenerationsPageDirect({
      search,
      kind,
      status,
      from,
      to,
      limit,
      offset,
    });
  }

  // Only send p_status when filtering: databases still on the 4-arg version
  // of admin_generations_page keep matching for the common unfiltered path
  // (a status-filtered call errors there and uses the direct fallback).
  // p_from/p_to work the same way: databases without the date-filter patch
  // (admin/sql/patches/2026-06-11-generations-date-filter.sql) reject the
  // extra args and the direct fallback applies the dates instead.
  const args: Record<string, unknown> = {
    p_search: search,
    p_kind: kind,
    p_limit: limit,
    p_offset: offset,
  };
  if (status) args.p_status = status;
  if (fromBound) args.p_from = fromBound;
  if (toBound) args.p_to = toBound;

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
    return fetchGenerationsPageDirect({
      search,
      kind,
      status,
      from,
      to,
      limit,
      offset,
    });
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
    fromBound,
    toBound,
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
  const total =
    rpcTotal +
    (await countParametricArtifacts(supa, status, fromBound, toBound));
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

type ImageAssetMatch = {
  metadata: Record<string, unknown>;
  created_at: string | null;
};

type ProviderUsageCandidate = {
  reference_id: string | null;
  user_id: string | null;
  conversation_id: string | null;
  created_at: string;
  model: string | null;
  cost_usd: number | string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function imageObjectKey(row: GenerationRow): string {
  return `${row.user_id}/${row.conversation_id}/${row.id}`;
}

function imageIdFromObjectKey(objectKey: string): string | null {
  const parts = objectKey.split('/').filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] ?? null) : null;
}

function isGenerateViewAsset(asset: ImageAssetMatch | undefined): boolean {
  return asset?.metadata.source === 'generate-view';
}

function imagePromptWithGeneratedSource(
  row: GenerationRow,
  asset: ImageAssetMatch | undefined,
): unknown {
  if (!asset || !isGenerateViewAsset(asset)) return row.prompt;
  const metadata = asset.metadata;

  const prompt = isRecord(row.prompt) ? row.prompt : {};
  const existingText = stringValue(prompt.text);
  if (existingText && existingText !== 'User uploaded image') return row.prompt;

  const view = stringValue(metadata.view);
  const mode = stringValue(metadata.mode);
  const label =
    mode === 'multiview' && view
      ? `${view} view image`
      : mode === 'input'
        ? 'input image'
        : 'image';

  return {
    ...metadata,
    generated: true,
    source: 'generate-view',
    text: `Generated ${label}`,
  };
}

async function fetchImageAssetMatches(
  supa: ReturnType<typeof getAdminClient>,
  rows: GenerationRow[],
): Promise<Map<string, ImageAssetMatch>> {
  const imageRows = rows.filter((row) => row.kind === 'image');
  const ids = [...new Set(imageRows.map((row) => row.id).filter(Boolean))];
  if (ids.length === 0) return new Map();

  const idSet = new Set(ids);
  const objectKeys = [...new Set(imageRows.map(imageObjectKey))];
  const matches = new Map<string, ImageAssetMatch>();

  const [sourceResult, objectResult] = await Promise.all([
    supa
      .from('generation_assets')
      .select('source_id,object_key,metadata,created_at')
      .eq('kind', 'image')
      .is('deleted_at', null)
      .in('source_id', ids),
    supa
      .from('generation_assets')
      .select('source_id,object_key,metadata,created_at')
      .eq('kind', 'image')
      .is('deleted_at', null)
      .in('object_key', objectKeys),
  ]);

  const addRows = (
    data:
      | Array<{
          source_id: string | null;
          object_key: string | null;
          metadata: unknown;
          created_at: string | null;
        }>
      | null
      | undefined,
  ) => {
    for (const asset of data ?? []) {
      const sourceId =
        asset.source_id && idSet.has(asset.source_id) ? asset.source_id : null;
      const objectId =
        asset.object_key != null
          ? imageIdFromObjectKey(asset.object_key)
          : null;
      const id =
        sourceId ?? (objectId && idSet.has(objectId) ? objectId : null);
      if (!id) continue;
      matches.set(id, {
        metadata: isRecord(asset.metadata) ? asset.metadata : {},
        created_at: asset.created_at ?? null,
      });
    }
  };

  if (!sourceResult.error) {
    addRows(sourceResult.data as Parameters<typeof addRows>[0]);
  }
  if (!objectResult.error) {
    addRows(objectResult.data as Parameters<typeof addRows>[0]);
  }

  return matches;
}

async function fetchGenerationsPageDirect({
  search = null,
  kind = null,
  status = null,
  from = null,
  to = null,
  limit = 50,
  offset = 0,
}: {
  search?: string | null;
  kind?: string | null;
  status?: string | null;
  from?: string | null;
  to?: string | null;
  limit?: number;
  offset?: number;
}): Promise<GenerationsPage> {
  const supa = getAdminClient();
  const requestedKind = kind?.toLowerCase();
  const requestedStatus = status?.toLowerCase() || undefined;
  const fromBound = from || undefined;
  const toBound = to || undefined;
  const queryLimit = Math.min(Math.max(limit + offset, 100), 500);
  const jobs: Promise<GenerationRow[]>[] = [];

  if (!requestedKind || requestedKind === 'cad') {
    jobs.push(
      fetchCadRowsDirect(
        supa,
        queryLimit,
        undefined,
        requestedStatus,
        fromBound,
        toBound,
      ),
    );
  }
  if (!requestedKind || requestedKind === 'mesh') {
    jobs.push(
      fetchMeshRowsDirect(
        supa,
        queryLimit,
        undefined,
        requestedStatus,
        fromBound,
        toBound,
      ),
    );
  }
  if (!requestedKind || requestedKind === 'image') {
    jobs.push(
      fetchImageRowsDirect(
        supa,
        queryLimit,
        undefined,
        requestedStatus,
        fromBound,
        toBound,
      ),
    );
  }
  if (requestedKind === 'parametric') {
    jobs.push(
      fetchParametricRowsDirect(
        supa,
        queryLimit,
        undefined,
        requestedStatus,
        fromBound,
        toBound,
      ),
    );
  } else if (!requestedKind) {
    // Merged view: a parametric failure shouldn't blank the other kinds.
    jobs.push(
      fetchParametricRowsDirect(
        supa,
        queryLimit,
        undefined,
        requestedStatus,
        fromBound,
        toBound,
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
      tokens_used: displayGenerationTokens({
        kind: row.kind,
        tokens_used: row.tokens_used ?? null,
        prompt: row.prompt,
      }),
    }));
  const ids = [...new Set(rows.map((row) => row.id).filter(Boolean))];
  if (ids.length === 0) return withEmptyEconomics();

  const [usageResult, tokenResult, imageAssetMatches] = await Promise.all([
    supa
      .from('provider_usage')
      .select('reference_id,cost_usd,model')
      .in('reference_id', ids),
    supa
      .from('token_transactions')
      .select('reference_id,amount')
      .in('reference_id', ids),
    fetchImageAssetMatches(supa, rows),
  ]);

  const costs = new Map<string, number>();
  const providerModels = new Map<string, string | null>();
  if (!usageResult.error) {
    for (const row of (usageResult.data ?? []) as Array<{
      reference_id: string | null;
      cost_usd: number | string | null;
      model: string | null;
    }>) {
      if (!row.reference_id) continue;
      const cost = Number(row.cost_usd ?? 0);
      if (!Number.isFinite(cost)) continue;
      costs.set(row.reference_id, (costs.get(row.reference_id) ?? 0) + cost);
      providerModels.set(row.reference_id, row.model ?? null);
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
    prompt:
      row.kind === 'image'
        ? imagePromptWithGeneratedSource(row, imageAssetMatches.get(row.id))
        : row.prompt,
    actual_cost_usd: costs.has(row.id)
      ? (costs.get(row.id) ?? 0)
      : (row.actual_cost_usd ?? null),
    tokens_used: exactTokens.has(row.id)
      ? (exactTokens.get(row.id) ?? 0)
      : (row.tokens_used ?? null),
  }));

  const withLegacyImageUsage = await addLegacyImageUsageMatches(
    supa,
    enriched,
    imageAssetMatches,
    providerModels,
  );
  const withLegacyMatches = await addLegacyTokenMatches(
    supa,
    withLegacyImageUsage,
  );
  return withLegacyMatches.map((row) => ({
    ...row,
    tokens_used: displayGenerationTokens({
      kind: row.kind,
      tokens_used: row.tokens_used ?? null,
      prompt: row.prompt,
      provider_model: providerModels.get(row.id) ?? null,
      asset_metadata: imageAssetMatches.get(row.id)?.metadata,
    }),
  }));
}

async function addLegacyImageUsageMatches(
  supa: ReturnType<typeof getAdminClient>,
  rows: GenerationRow[],
  imageAssetMatches: Map<string, ImageAssetMatch>,
  providerModels: Map<string, string | null>,
): Promise<GenerationRow[]> {
  const missing = rows.filter(
    (row) =>
      row.kind === 'image' &&
      row.actual_cost_usd == null &&
      isGenerateViewAsset(imageAssetMatches.get(row.id)),
  );
  if (missing.length === 0) return rows;

  const userIds = [
    ...new Set(missing.map((row) => row.user_id).filter(Boolean)),
  ];
  if (userIds.length === 0) return rows;

  const rowIds = new Set(rows.map((row) => row.id));
  const times = missing.map((row) => new Date(row.created_at).getTime());
  const assetTimes = missing
    .map((row) => imageAssetMatches.get(row.id)?.created_at)
    .filter(Boolean)
    .map((createdAt) => new Date(createdAt as string).getTime());
  const allTimes = [...times, ...assetTimes].filter(Number.isFinite);
  if (allTimes.length === 0) return rows;

  const minCreated = Math.min(...allTimes);
  const maxCreated = Math.max(...allTimes);
  const { data, error } = await supa
    .from('provider_usage')
    .select(
      'reference_id,user_id,conversation_id,created_at,model,cost_usd,operation',
    )
    .in('user_id', userIds)
    .eq('operation', 'image')
    .gte('created_at', new Date(minCreated - 10 * 60_000).toISOString())
    .lte('created_at', new Date(maxCreated + 10 * 60_000).toISOString())
    .order('created_at', { ascending: true });
  if (error) return rows;

  const candidates = (
    (data ?? []) as Array<
      ProviderUsageCandidate & { operation?: string | null }
    >
  ).filter(
    (candidate) =>
      !candidate.reference_id || !rowIds.has(candidate.reference_id),
  );
  const used = new Set<number>();
  const inferredCosts = new Map<string, number>();

  for (const row of missing) {
    const rowTime = new Date(row.created_at).getTime();
    const assetTime = imageAssetMatches.get(row.id)?.created_at
      ? new Date(imageAssetMatches.get(row.id)?.created_at as string).getTime()
      : rowTime;
    const targetTime = Number.isFinite(assetTime) ? assetTime : rowTime;
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    candidates.forEach((candidate, index) => {
      if (used.has(index)) return;
      if (
        candidate.user_id !== row.user_id ||
        candidate.conversation_id !== row.conversation_id
      ) {
        return;
      }
      const cost = Number(candidate.cost_usd ?? 0);
      if (!Number.isFinite(cost)) return;
      const distance = Math.abs(
        new Date(candidate.created_at).getTime() - targetTime,
      );
      if (distance <= 10 * 60_000 && distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });

    if (bestIndex >= 0) {
      const candidate = candidates[bestIndex];
      const cost = Number(candidate.cost_usd ?? 0);
      used.add(bestIndex);
      inferredCosts.set(row.id, cost);
      providerModels.set(row.id, candidate.model ?? null);
    }
  }

  return rows.map((row) => ({
    ...row,
    actual_cost_usd: row.actual_cost_usd ?? inferredCosts.get(row.id) ?? null,
  }));
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

// --- Per-generation provider usage (detail-page debug view) ----------------
export type GenerationUsageRow = {
  id: number;
  created_at: string;
  function_name: string;
  operation: string;
  provider: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  cost_usd: number;
  status: string;
};

// provider_usage rows logged for one generation, matched on reference_id
// (edge functions store the cad job / mesh / message id there). Returns null
// when the table can't be read so the detail page can degrade gracefully.
export async function fetchGenerationUsage(
  referenceIds: Array<string | null | undefined>,
): Promise<GenerationUsageRow[] | null> {
  const supa = getAdminClient();
  const ids = [...new Set(referenceIds.filter(Boolean) as string[])];
  if (ids.length === 0) return [];
  const { data, error } = await supa
    .from('provider_usage')
    .select(
      'id,created_at,function_name,operation,provider,model,input_tokens,output_tokens,cached_input_tokens,cost_usd,status',
    )
    .in('reference_id', ids)
    .order('created_at', { ascending: true });
  if (error) return null;
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: row.id as number,
    created_at: row.created_at as string,
    function_name: (row.function_name as string | null) ?? '',
    operation: (row.operation as string | null) ?? 'unknown',
    provider: (row.provider as string | null) ?? 'unknown',
    model: (row.model as string | null) ?? 'unknown',
    input_tokens: (row.input_tokens as number | null) ?? null,
    output_tokens: (row.output_tokens as number | null) ?? null,
    cached_input_tokens: (row.cached_input_tokens as number | null) ?? null,
    cost_usd: Number(row.cost_usd ?? 0) || 0,
    status: (row.status as string | null) ?? 'success',
  }));
}

// --- CAD failure breakdown (overview) ---------------------------------------
export type CadFailureBreakdownRow = {
  model: string;
  failures: number;
  total: number;
};

// CAD job outcomes for the recent window grouped by the model recorded in
// cad_jobs.prompt (the table has no model column — cad-chat writes the model
// into the prompt jsonb). Direct query, aggregated here; returns null on any
// error so the overview can degrade gracefully.
export async function fetchCadFailureBreakdown(
  days = 30,
  maxRows = 2000,
): Promise<CadFailureBreakdownRow[] | null> {
  const supa = getAdminClient();
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await supa
    .from('cad_jobs')
    .select('status,prompt')
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(maxRows);
  if (error) return null;

  const byModel = new Map<string, CadFailureBreakdownRow>();
  for (const row of (data ?? []) as Array<{
    status: string | null;
    prompt: unknown;
  }>) {
    const prompt =
      row.prompt && typeof row.prompt === 'object' && !Array.isArray(row.prompt)
        ? (row.prompt as Record<string, unknown>)
        : {};
    const model =
      typeof prompt.model === 'string' && prompt.model.trim()
        ? prompt.model
        : 'unknown';
    const entry = byModel.get(model) ?? { model, failures: 0, total: 0 };
    entry.total += 1;
    if (row.status === 'failure') entry.failures += 1;
    byModel.set(model, entry);
  }
  return [...byModel.values()].sort(
    (a, b) => b.failures - a.failures || b.total - a.total,
  );
}

async function fetchCadRowsDirect(
  supa: ReturnType<typeof getAdminClient>,
  limit: number,
  userId?: string,
  status?: string,
  from?: string,
  to?: string,
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
  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', to);
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
  from?: string,
  to?: string,
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
  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', to);
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
  from?: string,
  to?: string,
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
  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', to);
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
  from?: string,
  to?: string,
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
  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', to);
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
  from?: string,
  to?: string,
): Promise<number> {
  if (status && status.toLowerCase() !== 'success') return 0;
  let query = supa
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'assistant')
    .not('content->artifact', 'is', null);
  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', to);
  const { count, error } = await query;
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
