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
