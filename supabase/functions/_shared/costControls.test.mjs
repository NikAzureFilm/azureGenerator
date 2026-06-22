import assert from 'node:assert/strict';
import {
  DAILY_GENERATION_LIMITS,
  MAX_ACTIVE_GENERATIONS,
  UPLOAD_SIZE_LIMITS_BYTES,
  getGenerationLimits,
  getPlanLevelFromBillingStatus,
  isActiveGenerationLimitExceeded,
  isDailyGenerationLimitExceeded,
} from './costControls.ts';

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

console.log('cost control helper tests passed');
