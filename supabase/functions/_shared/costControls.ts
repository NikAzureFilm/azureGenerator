import {
  DAILY_GENERATION_LIMITS,
  MAX_ACTIVE_GENERATIONS,
  UPLOAD_SIZE_LIMITS_BYTES,
  getGenerationLimits,
  normalizeCostControlPlanLevel,
  type CostControlPlanLevel,
} from '../../../shared/costControls.ts';

export {
  DAILY_GENERATION_LIMITS,
  MAX_ACTIVE_GENERATIONS,
  UPLOAD_SIZE_LIMITS_BYTES,
  getGenerationLimits,
};

export type PlanLevel = CostControlPlanLevel;

type BillingStatusLike = {
  subscription?: {
    level?: string | null;
    status?: string | null;
  } | null;
} | null;

type QueryError = { message: string } | null;

type QueryResult<T = unknown> = {
  data?: T | null;
  count?: number | null;
  error?: QueryError;
};

type QueryBuilder<T = unknown> = PromiseLike<QueryResult<T>> & {
  select: <TNext = unknown>(
    columns: string,
    options?: { count?: 'exact'; head?: boolean },
  ) => QueryBuilder<TNext>;
  eq: (column: string, value: unknown) => QueryBuilder<T>;
  in: (column: string, values: readonly unknown[]) => QueryBuilder<T>;
  lt: (column: string, value: unknown) => QueryBuilder<T>;
  gte: (column: string, value: unknown) => QueryBuilder<T>;
  order: (column: string, options: { ascending: boolean }) => QueryBuilder<T>;
  limit: (count: number) => QueryBuilder<T>;
  maybeSingle: () => PromiseLike<QueryResult<T>>;
};

type SupabaseCountClient = {
  from: (table: string) => QueryBuilder;
};

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing']);

export type GenerationUsage = {
  activeGenerations: number;
  dailyGenerations: number;
};

export type GenerationLimitViolation = {
  code: 'active_generation_limit' | 'daily_generation_limit';
  plan: PlanLevel;
  limit: number;
  used: number;
};

export function getPlanLevelFromBillingStatus(
  status: BillingStatusLike,
): PlanLevel {
  const subscription = status?.subscription;
  if (!subscription?.status) return 'free';
  if (!ACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status)) return 'free';
  return normalizeCostControlPlanLevel(subscription.level);
}

export function isActiveGenerationLimitExceeded(
  plan: PlanLevel,
  activeGenerations: number,
) {
  return activeGenerations >= MAX_ACTIVE_GENERATIONS[plan];
}

export function isDailyGenerationLimitExceeded(
  plan: PlanLevel,
  dailyGenerations: number,
) {
  return dailyGenerations >= DAILY_GENERATION_LIMITS[plan];
}

async function countRows(
  supabaseClient: SupabaseCountClient,
  table: 'cad_jobs' | 'meshes' | 'token_transactions',
  userId: string,
  filters: (query: QueryBuilder) => QueryBuilder,
): Promise<number> {
  const query = filters(
    supabaseClient
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId),
  );
  const { count, error } = await query;
  if (error) {
    throw new Error(`${table} usage count failed: ${error.message}`);
  }
  return count ?? 0;
}

export async function getUserPlanLevel(
  supabaseClient: SupabaseCountClient,
  userId: string,
): Promise<PlanLevel> {
  const { data, error } = await supabaseClient
    .from('subscriptions')
    .select('level,status')
    .eq('user_id', userId)
    .in('status', ['active', 'trialing'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const subscription = data as
    | { status?: string | null; level?: unknown }
    | null
    | undefined;
  if (error || !subscription) return 'free';
  if (!ACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status ?? '')) {
    return 'free';
  }
  return normalizeCostControlPlanLevel(subscription.level);
}

export async function getUserGenerationUsage(
  supabaseClient: SupabaseCountClient,
  userId: string,
  now = new Date(),
): Promise<GenerationUsage> {
  const dayStartIso = new Date(
    now.getTime() - 24 * 60 * 60 * 1000,
  ).toISOString();

  const [activeCadJobs, activeMeshes, dailyChargedGenerations] =
    await Promise.all([
      countRows(supabaseClient, 'cad_jobs', userId, (query) =>
        query.eq('status', 'pending'),
      ),
      countRows(supabaseClient, 'meshes', userId, (query) =>
        query.eq('status', 'pending'),
      ),
      countRows(supabaseClient, 'token_transactions', userId, (query) =>
        query
          .in('operation', ['mesh', 'parametric'])
          .lt('amount', 0)
          .gte('created_at', dayStartIso),
      ),
    ]);

  return {
    activeGenerations: activeCadJobs + activeMeshes,
    dailyGenerations: dailyChargedGenerations,
  };
}

export async function checkGenerationCostControls({
  supabaseClient,
  userId,
  now,
}: {
  supabaseClient: SupabaseCountClient;
  userId: string;
  now?: Date;
}): Promise<GenerationLimitViolation | null> {
  const [plan, usage] = await Promise.all([
    getUserPlanLevel(supabaseClient, userId),
    getUserGenerationUsage(supabaseClient, userId, now),
  ]);

  if (isActiveGenerationLimitExceeded(plan, usage.activeGenerations)) {
    return {
      code: 'active_generation_limit',
      plan,
      limit: MAX_ACTIVE_GENERATIONS[plan],
      used: usage.activeGenerations,
    };
  }

  if (isDailyGenerationLimitExceeded(plan, usage.dailyGenerations)) {
    return {
      code: 'daily_generation_limit',
      plan,
      limit: DAILY_GENERATION_LIMITS[plan],
      used: usage.dailyGenerations,
    };
  }

  return null;
}

export function costControlErrorBody(violation: GenerationLimitViolation) {
  return {
    error: {
      message: violation.code,
      code: violation.code,
      plan: violation.plan,
      limit: violation.limit,
      used: violation.used,
    },
  };
}
