export const FREE_DAILY_TOKENS = 50;

export type PlanLevel = 'free' | 'standard' | 'pro';
export type PaidPlanLevel = Exclude<PlanLevel, 'free'>;

export type PlanCatalogEntry = {
  level: PlanLevel;
  displayName: string;
  description: string;
  monthlyPriceCents: number;
  yearlyPriceCents: number | null;
  tokenAmount: number | null;
  popular: boolean;
};

export const PLAN_CATALOG = {
  free: {
    level: 'free',
    displayName: 'Free',
    description: 'Get started with Adam',
    monthlyPriceCents: 0,
    yearlyPriceCents: null,
    tokenAmount: null,
    popular: false,
  },
  standard: {
    level: 'standard',
    displayName: 'Standard',
    description: 'For regular CAD and image workflows',
    monthlyPriceCents: 1000,
    yearlyPriceCents: 7200,
    tokenAmount: 1000,
    popular: false,
  },
  pro: {
    level: 'pro',
    displayName: 'Pro',
    description: 'For heavier 3D generation work',
    monthlyPriceCents: 4000,
    yearlyPriceCents: 28800,
    tokenAmount: 5000,
    popular: true,
  },
} as const satisfies Record<PlanLevel, PlanCatalogEntry>;

export const PLAN_ORDER: PlanLevel[] = ['free', 'standard', 'pro'];

export type TokenPackCatalogEntry = {
  lookupKey: string;
  tokenAmount: number;
  name: string;
  priceCents: number;
};

export const TOKEN_PACK_CATALOG: TokenPackCatalogEntry[] = [
  {
    lookupKey: 'tokens_500',
    tokenAmount: 500,
    name: '500 tokens',
    priceCents: 500,
  },
  {
    lookupKey: 'tokens_1000',
    tokenAmount: 1000,
    name: '1,000 tokens',
    priceCents: 1000,
  },
  {
    lookupKey: 'tokens_2500',
    tokenAmount: 2500,
    name: '2,500 tokens',
    priceCents: 2500,
  },
  {
    lookupKey: 'tokens_5000',
    tokenAmount: 5000,
    name: '5,000 tokens',
    priceCents: 5000,
  },
];

export function getAnnualDiscountPercent(level: PaidPlanLevel): number {
  const plan = PLAN_CATALOG[level];
  const monthlyPriceCents: number = plan.monthlyPriceCents;
  if (!plan.yearlyPriceCents || monthlyPriceCents === 0) return 0;
  const monthlyEquivalent = plan.yearlyPriceCents / 12;
  const discount = 1 - monthlyEquivalent / monthlyPriceCents;
  return Math.round(discount * 100);
}
