// Vendored pricing constants — kept in sync with the main app's
// shared/tokenCosts.ts and shared/pricingCatalog.ts. Duplicated here so the
// admin project is self-contained and deployable on its own.

// What one token costs us to provide, and what we charge for it.
export const TOKEN_INTERNAL_USD_COST = 0.01; // our cost per token (COGS)
export const TOKEN_USD_VALUE = 0.03; // customer-facing value per token

// Monthly plan prices in cents (mirrors PLAN_CATALOG.monthlyPriceCents).
export const PLAN_MONTHLY_CENTS: Record<string, number> = {
  free: 0,
  standard: 3000,
  pro: 15000,
  max: 150000,
};

export const PLAN_DISPLAY: Record<string, string> = {
  free: 'Free',
  standard: 'Standard',
  pro: 'Pro',
  max: 'Max',
};
