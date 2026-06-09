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
};

export async function fetchUserGenerations(
  userId: string,
  limit = 50,
): Promise<UserGeneration[]> {
  const supa = getAdminClient();
  const { data, error } = await supa.rpc('admin_user_generations', {
    p_user_id: userId,
    p_limit: limit,
  });
  if (error) throw new Error(`admin_user_generations: ${error.message}`);
  return (data ?? []) as UserGeneration[];
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
