export type CostControlPlanLevel = 'free' | 'standard' | 'pro' | 'max';

export const MAX_ACTIVE_GENERATIONS: Record<CostControlPlanLevel, number> = {
  free: 1,
  standard: 2,
  pro: 3,
  max: 3,
};

export const DAILY_GENERATION_LIMITS: Record<CostControlPlanLevel, number> = {
  free: 3,
  standard: 25,
  pro: 100,
  max: 250,
};

export const UPLOAD_SIZE_LIMITS_BYTES: Record<CostControlPlanLevel, number> = {
  free: 25 * 1024 * 1024,
  standard: 50 * 1024 * 1024,
  pro: 100 * 1024 * 1024,
  max: 100 * 1024 * 1024,
};

export type GenerationLimits = {
  activeGenerations: number;
  dailyGenerations: number;
  retryGenerations: number;
  uploadBytes: number;
};

export function normalizeCostControlPlanLevel(
  value: unknown,
): CostControlPlanLevel {
  return value === 'standard' || value === 'pro' || value === 'max'
    ? value
    : 'free';
}

export function getGenerationLimits(
  plan: CostControlPlanLevel,
): GenerationLimits {
  return {
    activeGenerations: MAX_ACTIVE_GENERATIONS[plan],
    dailyGenerations: DAILY_GENERATION_LIMITS[plan],
    retryGenerations: DAILY_GENERATION_LIMITS[plan],
    uploadBytes: UPLOAD_SIZE_LIMITS_BYTES[plan],
  };
}

export function getUploadSizeLimitBytes(plan: CostControlPlanLevel): number {
  return UPLOAD_SIZE_LIMITS_BYTES[plan];
}
