import assert from 'node:assert/strict';
import { FREE_STARTER_TOKENS } from '../../../shared/pricingCatalog.ts';
import {
  DAILY_GENERATION_LIMITS,
  MAX_ACTIVE_GENERATIONS,
  UPLOAD_SIZE_LIMITS_BYTES,
  getGenerationLimits,
  getUserGenerationUsage,
  getUserPlanLevel,
  getPlanLevelFromBillingStatus,
  isActiveGenerationLimitExceeded,
  isDailyGenerationLimitExceeded,
} from './costControls.ts';

function createPlanClient({
  subscription = null,
  purchasedBalance = 0,
  subscriptionError = null,
  balanceError = null,
} = {}) {
  return {
    from(table) {
      const query = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        in() {
          return query;
        },
        lt() {
          return query;
        },
        gte() {
          return query;
        },
        order() {
          return query;
        },
        limit() {
          return query;
        },
        maybeSingle() {
          if (table === 'subscriptions') {
            return Promise.resolve({
              data: subscription,
              error: subscriptionError,
            });
          }
          if (table === 'token_balances') {
            return Promise.resolve({
              data:
                purchasedBalance === null
                  ? null
                  : { balance: purchasedBalance },
              error: balanceError,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return query;
    },
  };
}

assert.equal(
  getPlanLevelFromBillingStatus(null),
  'free',
  'users without an active subscription are free-tier for cost controls',
);

assert.equal(
  getPlanLevelFromBillingStatus({
    subscription: { level: 'standard', status: 'trialing' },
  }),
  'standard',
  'trialing paid subscriptions receive paid cost controls',
);

assert.equal(
  getPlanLevelFromBillingStatus({
    subscription: { level: 'pro', status: 'canceled' },
  }),
  'free',
  'inactive subscriptions fall back to free-tier cost controls',
);

assert.equal(
  await getUserPlanLevel(
    createPlanClient({
      subscription: { level: 'max', status: 'active' },
      purchasedBalance: 0,
    }),
    'user-1',
  ),
  'max',
  'active subscriptions keep their subscription generation limits',
);

assert.equal(
  await getUserPlanLevel(
    createPlanClient({
      subscription: null,
      purchasedBalance: FREE_STARTER_TOKENS,
    }),
    'user-1',
  ),
  'free',
  'starter credits alone should keep free-tier generation limits',
);

assert.equal(
  await getUserPlanLevel(
    createPlanClient({
      subscription: null,
      purchasedBalance: FREE_STARTER_TOKENS + 1,
    }),
    'user-1',
  ),
  'standard',
  'purchased or admin-granted token balances above starter credit should receive paid generation limits',
);

assert.deepEqual(getGenerationLimits('free'), {
  activeGenerations: MAX_ACTIVE_GENERATIONS.free,
  dailyGenerations: DAILY_GENERATION_LIMITS.free,
  retryGenerations: DAILY_GENERATION_LIMITS.free,
  uploadBytes: UPLOAD_SIZE_LIMITS_BYTES.free,
});

assert.equal(
  isActiveGenerationLimitExceeded('free', MAX_ACTIVE_GENERATIONS.free),
  true,
  'free users may not start a second active generation',
);

assert.equal(
  isActiveGenerationLimitExceeded('pro', MAX_ACTIVE_GENERATIONS.pro - 1),
  false,
  'paid users can use their configured concurrent generation slots',
);

assert.equal(
  isDailyGenerationLimitExceeded('free', DAILY_GENERATION_LIMITS.free),
  true,
  'daily generation limits trip before starting another job',
);

assert.equal(
  isDailyGenerationLimitExceeded('standard', DAILY_GENERATION_LIMITS.free),
  false,
  'paid daily generation limits are higher than the free cap',
);

assert.deepEqual(getGenerationLimits('max'), {
  activeGenerations: MAX_ACTIVE_GENERATIONS.max,
  dailyGenerations: DAILY_GENERATION_LIMITS.max,
  retryGenerations: DAILY_GENERATION_LIMITS.max,
  uploadBytes: UPLOAD_SIZE_LIMITS_BYTES.max,
});

function createCountClient(counts, calls) {
  return {
    from(table) {
      const operations = [];
      const query = {
        select(columns, options) {
          operations.push(['select', columns, options]);
          return query;
        },
        eq(column, value) {
          operations.push(['eq', column, value]);
          return query;
        },
        in(column, values) {
          operations.push(['in', column, values]);
          return query;
        },
        lt(column, value) {
          operations.push(['lt', column, value]);
          return query;
        },
        gte(column, value) {
          operations.push(['gte', column, value]);
          return query;
        },
        order(column, options) {
          operations.push(['order', column, options]);
          return query;
        },
        limit(count) {
          operations.push(['limit', count]);
          return query;
        },
        maybeSingle() {
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve, reject) {
          calls.push({ table, operations });
          return Promise.resolve({
            count: counts[table] ?? 0,
            error: null,
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

{
  const calls = [];
  const now = new Date('2026-06-29T12:00:00.000Z');
  const usage = await getUserGenerationUsage(
    createCountClient(
      { cad_jobs: 1, meshes: 2, token_transactions: 3 },
      calls,
    ),
    'user-1',
    now,
  );

  assert.deepEqual(usage, {
    activeGenerations: 3,
    dailyGenerations: 3,
  });

  for (const table of ['cad_jobs', 'meshes']) {
    const call = calls.find((entry) => entry.table === table);
    assert.ok(call, `${table} should be counted for active generation usage`);
    assert.deepEqual(
      call.operations.find(
        ([method, column]) => method === 'gte' && column === 'created_at',
      ),
      ['gte', 'created_at', '2026-06-29T10:00:00.000Z'],
      `${table} active usage should ignore stale pending rows older than two hours`,
    );
  }

  const tokenTransactionCall = calls.find(
    (entry) => entry.table === 'token_transactions',
  );
  assert.deepEqual(
    tokenTransactionCall.operations.find(
      ([method, column]) => method === 'gte' && column === 'created_at',
    ),
    ['gte', 'created_at', '2026-06-28T12:00:00.000Z'],
    'daily usage should keep the 24 hour charged-generation window',
  );
}

console.log('cost control helper tests passed');
