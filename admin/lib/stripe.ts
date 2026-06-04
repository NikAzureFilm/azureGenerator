import 'server-only';
import Stripe from 'stripe';

export type StripeMetrics = {
  mrrCents: number;
  activeSubscriptions: number;
  grossVolume30dCents: number;
  refunded30dCents: number;
  netVolume30dCents: number;
  truncated: boolean;
};

function normalizeToMonthlyCents(
  price: Stripe.Price,
  quantity: number,
): number {
  const amount = (price.unit_amount ?? 0) * quantity;
  const recurring = price.recurring;
  if (!recurring) return 0;
  const count = recurring.interval_count || 1;
  switch (recurring.interval) {
    case 'year':
      return amount / (12 * count);
    case 'week':
      return (amount * 52) / 12 / count;
    case 'day':
      return (amount * 365) / 12 / count;
    case 'month':
    default:
      return amount / count;
  }
}

// Returns null when STRIPE_SECRET_KEY is not configured or Stripe errors.
export async function getStripeMetrics(): Promise<StripeMetrics | null> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;

  try {
    const stripe = new Stripe(key);

    // --- Live MRR from active subscriptions -------------------------------
    let mrrCents = 0;
    let activeSubscriptions = 0;
    for await (const sub of stripe.subscriptions.list({
      status: 'active',
      limit: 100,
      expand: ['data.items.data.price'],
    })) {
      activeSubscriptions += 1;
      for (const item of sub.items.data) {
        mrrCents += normalizeToMonthlyCents(
          item.price as Stripe.Price,
          item.quantity ?? 1,
        );
      }
    }

    // --- Actual cash collected over the last 30 days ----------------------
    const since = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
    let grossVolume30dCents = 0;
    let refunded30dCents = 0;
    let pages = 0;
    const MAX_PAGES = 50; // cap at ~5000 charges to bound the request count
    let truncated = false;

    for await (const charge of stripe.charges.list({
      created: { gte: since },
      limit: 100,
    })) {
      if (charge.paid && charge.status === 'succeeded') {
        grossVolume30dCents += charge.amount_captured ?? charge.amount ?? 0;
        refunded30dCents += charge.amount_refunded ?? 0;
      }
      // crude page accounting for the cap
      if (++pages >= MAX_PAGES * 100) {
        truncated = true;
        break;
      }
    }

    return {
      mrrCents: Math.round(mrrCents),
      activeSubscriptions,
      grossVolume30dCents,
      refunded30dCents,
      netVolume30dCents: grossVolume30dCents - refunded30dCents,
      truncated,
    };
  } catch {
    return null;
  }
}
