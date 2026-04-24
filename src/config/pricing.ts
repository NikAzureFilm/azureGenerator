/**
 * Single source of truth for subscription pricing.
 *
 * Consumed by `Subscriptions` (the full /subscription page) and
 * `UpgradeModal` (the compact in-app upgrade dialog). Neither file should
 * redeclare plan names, prices, lookup keys, or credit amounts — derive
 * the view-specific shapes from the plans below.
 */

export type PlanName = 'Free' | 'Standard' | 'Pro';

export type Cadence = 'monthly' | 'yearly';

export interface PricingPlan {
  name: PlanName;
  description: string;
  /** Price in USD per month on the monthly plan. `'0'` for Free. */
  monthlyPrice: string;
  /** Price in USD per month on the yearly plan (already divided by 12). */
  yearlyPrice: string;
  /** Number of credits granted by the plan each period. */
  creditsAmount: number;
  /** Refresh cadence for the credits allowance. */
  creditsPeriod: 'day' | 'mo';
  /** Extra feature bullets, NOT including the credits line. */
  extraFeatures: string[];
  /** Stripe price lookup key for the monthly cadence. */
  monthlyLookupKey: string;
  /** Stripe price lookup key for the yearly cadence. */
  yearlyLookupKey: string;
  /** Whether to highlight the plan visually. */
  popular?: boolean;
}

export const PRICING_PLANS: Record<PlanName, PricingPlan> = {
  Free: {
    name: 'Free',
    description: 'Get started with AzureFilm Generator',
    monthlyPrice: '0',
    yearlyPrice: '0',
    creditsAmount: 50,
    creditsPeriod: 'day',
    extraFeatures: ['All AI features', 'Community support'],
    monthlyLookupKey: 'free',
    yearlyLookupKey: 'free',
  },
  Standard: {
    name: 'Standard',
    description: 'For regular use',
    monthlyPrice: '9.99',
    yearlyPrice: '5.99',
    creditsAmount: 1000,
    creditsPeriod: 'mo',
    extraFeatures: ['All AI features', 'Buy additional token packs'],
    monthlyLookupKey: 'standard_monthly',
    yearlyLookupKey: 'standard_yearly',
  },
  Pro: {
    name: 'Pro',
    description: 'For power users',
    monthlyPrice: '29.99',
    yearlyPrice: '17.99',
    creditsAmount: 5000,
    creditsPeriod: 'mo',
    extraFeatures: [
      'Phone number of founders',
      'Exclusive access to new features',
      'Good vibes',
    ],
    monthlyLookupKey: 'pro_monthly',
    yearlyLookupKey: 'pro_yearly',
    popular: true,
  },
};

/** Display order used across both the pricing page and the upgrade modal. */
export const PLAN_ORDER: PlanName[] = ['Free', 'Standard', 'Pro'];

/**
 * Feature-list-friendly credits line, e.g. "50 tokens per day" or
 * "1,000 tokens per month". Used in the full Subscriptions page where
 * credits live inline with the other feature bullets.
 */
export function creditsFeatureLine(plan: PricingPlan): string {
  const periodWord = plan.creditsPeriod === 'day' ? 'day' : 'month';
  return `${plan.creditsAmount.toLocaleString()} tokens per ${periodWord}`;
}

/**
 * Compact credits label, e.g. "50 credits / day" or "1,000 credits / mo".
 * Used in the upgrade modal where credits appear as a dedicated badge.
 */
export function creditsBadgeLabel(plan: PricingPlan): string {
  return `${plan.creditsAmount.toLocaleString()} credits / ${plan.creditsPeriod}`;
}

export function lookupKey(plan: PricingPlan, cadence: Cadence): string {
  return cadence === 'yearly' ? plan.yearlyLookupKey : plan.monthlyLookupKey;
}

export function priceFor(plan: PricingPlan, cadence: Cadence): string {
  return cadence === 'yearly' ? plan.yearlyPrice : plan.monthlyPrice;
}
