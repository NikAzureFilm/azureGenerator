// Marketing copy for each plan tier. Price, name, and token amount come from
// shared pricing/billing config; the bullets below are product copy.

import {
  PLAN_CATALOG,
  PLAN_ORDER,
  type PlanLevel,
} from '@shared/pricingCatalog';

export type { PlanLevel } from '@shared/pricingCatalog';

type PlanCopy = {
  description: string;
  features: string[];
};

export const PLAN_FEATURES: Record<PlanLevel, PlanCopy> = {
  free: {
    description: PLAN_CATALOG.free.description,
    features: ['All AI features', 'Community support'],
  },
  standard: {
    description: PLAN_CATALOG.standard.description,
    features: [
      'All AI features',
      'Tokens shared between CADAM and the Onshape extension',
    ],
  },
  pro: {
    description: PLAN_CATALOG.pro.description,
    features: [
      'All AI features',
      'Priority support',
      'Tokens shared between CADAM and the Onshape extension',
    ],
  },
};

export const PLAN_DISPLAY_NAMES: Record<PlanLevel, string> = {
  free: PLAN_CATALOG.free.displayName,
  standard: PLAN_CATALOG.standard.displayName,
  pro: PLAN_CATALOG.pro.displayName,
};

export { PLAN_ORDER };
