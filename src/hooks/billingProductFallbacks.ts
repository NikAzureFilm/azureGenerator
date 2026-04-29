import {
  PLAN_CATALOG,
  TOKEN_PACK_CATALOG,
  type PaidPlanLevel,
} from '../../shared/pricingCatalog.ts';
import type { BillingProduct } from '@/hooks/useBillingProducts';

const paidPlanLevels: PaidPlanLevel[] = ['standard', 'pro'];

export function getFallbackSubscriptionProducts(): BillingProduct[] {
  return paidPlanLevels.flatMap((level) => {
    const plan = PLAN_CATALOG[level];
    const monthlyPriceCents: number = plan.monthlyPriceCents;
    const yearlyPriceCents: number =
      plan.yearlyPriceCents ?? monthlyPriceCents * 12;

    return [
      {
        id: `fallback-${level}-monthly`,
        stripeProductId: '',
        stripePriceId: '',
        productType: 'subscription' as const,
        subscriptionLevel: level,
        tokenAmount: plan.tokenAmount,
        name: `${plan.displayName} Monthly`,
        priceCents: monthlyPriceCents,
        interval: 'month',
        active: true,
      },
      {
        id: `fallback-${level}-yearly`,
        stripeProductId: '',
        stripePriceId: '',
        productType: 'subscription' as const,
        subscriptionLevel: level,
        tokenAmount: plan.tokenAmount,
        name: `${plan.displayName} Annual`,
        priceCents: yearlyPriceCents,
        interval: 'year',
        active: true,
      },
    ];
  });
}

export function getFallbackTokenPackProducts(): BillingProduct[] {
  return TOKEN_PACK_CATALOG.map((pack) => ({
    id: `fallback-${pack.lookupKey}`,
    stripeProductId: '',
    stripePriceId: '',
    productType: 'pack' as const,
    subscriptionLevel: null,
    tokenAmount: pack.tokenAmount,
    name: pack.name,
    priceCents: pack.priceCents,
    interval: null,
    active: true,
  }));
}
