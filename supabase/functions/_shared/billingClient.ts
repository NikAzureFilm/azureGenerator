// HTTP client for the shared adam-billing service. Mirrors
// onshape-extension/src/lib/billing/client.ts so CADAM and onshape behave
// identically against the same endpoints.

import {
  PLAN_CATALOG,
  TOKEN_PACK_CATALOG,
  type PaidPlanLevel,
} from '../../../shared/pricingCatalog.ts';
import { getServiceRoleSupabaseClient } from './supabaseClient.ts';

export type SubscriptionLevel = 'standard' | 'pro';

export type BillingStatus = {
  user: {
    hasTrialed: boolean;
  };
  subscription: {
    level: SubscriptionLevel;
    status: string | null;
    currentPeriodEnd: string | null;
  } | null;
  tokens: {
    free: number;
    subscription: number;
    purchased: number;
    total: number;
  };
};

export type ConsumeSuccess = {
  ok: true;
  tokensDeducted: number;
  freeBalance: number;
  subscriptionBalance: number;
  purchasedBalance: number;
  totalBalance: number;
};

export type ConsumeFailure = {
  ok: false;
  reason: 'insufficient_tokens';
  tokensRequired: number;
  tokensAvailable: number;
  tokensDeducted: number;
};

export type ConsumeResult = ConsumeSuccess | ConsumeFailure;

export type RefundResult = {
  ok: true;
  tokensRefunded: number;
  source: 'subscription' | 'purchased';
  freeBalance: number;
  subscriptionBalance: number;
  purchasedBalance: number;
  totalBalance: number;
};

export type BillingProduct = {
  id: string;
  stripeProductId: string;
  stripePriceId: string;
  productType: 'subscription' | 'pack';
  subscriptionLevel: SubscriptionLevel | null;
  tokenAmount: number;
  name: string;
  priceCents: number;
  interval: string | null;
  active: boolean;
};

const isBillingServiceConfigured = (): boolean =>
  !!Deno.env.get('BILLING_SERVICE_URL') &&
  !!Deno.env.get('BILLING_SERVICE_KEY');

const isLocalBillingBypassEnabled = (): boolean =>
  Deno.env.get('ENVIRONMENT') === 'local' && !isBillingServiceConfigured();

const localStatus = (): BillingStatus => ({
  user: {
    hasTrialed: false,
  },
  subscription: {
    level: 'pro',
    status: 'local',
    currentPeriodEnd: null,
  },
  tokens: {
    free: 0,
    subscription: PLAN_CATALOG.pro.tokenAmount,
    purchased: 0,
    total: PLAN_CATALOG.pro.tokenAmount,
  },
});

const localConsume = (tokens: number): ConsumeSuccess => ({
  ok: true,
  tokensDeducted: tokens,
  freeBalance: 0,
  subscriptionBalance: Math.max(PLAN_CATALOG.pro.tokenAmount - tokens, 0),
  purchasedBalance: 0,
  totalBalance: Math.max(PLAN_CATALOG.pro.tokenAmount - tokens, 0),
});

const localProducts = (): BillingProduct[] => [
  ...(['standard', 'pro'] as PaidPlanLevel[]).flatMap((level) => {
    const plan = PLAN_CATALOG[level];
    return [
      {
        id: `local-${level}-monthly`,
        stripeProductId: `local-${level}`,
        stripePriceId: `local-${level}-monthly`,
        productType: 'subscription' as const,
        subscriptionLevel: level,
        tokenAmount: plan.tokenAmount,
        name: `${plan.displayName} Monthly`,
        priceCents: plan.monthlyPriceCents,
        interval: 'month',
        active: true,
      },
      {
        id: `local-${level}-yearly`,
        stripeProductId: `local-${level}`,
        stripePriceId: `local-${level}-yearly`,
        productType: 'subscription' as const,
        subscriptionLevel: level,
        tokenAmount: plan.tokenAmount,
        name: `${plan.displayName} Annual`,
        priceCents: plan.yearlyPriceCents ?? plan.monthlyPriceCents * 12,
        interval: 'year',
        active: true,
      },
    ];
  }),
  ...TOKEN_PACK_CATALOG.map((pack) => ({
    id: `local-${pack.lookupKey}`,
    stripeProductId: `local-${pack.lookupKey}`,
    stripePriceId: `local-${pack.lookupKey}`,
    productType: 'pack' as const,
    subscriptionLevel: null,
    tokenAmount: pack.tokenAmount,
    name: pack.name,
    priceCents: pack.priceCents,
    interval: null,
    active: true,
  })),
];

const readBalances = async (userId: string) => {
  const supabase = getServiceRoleSupabaseClient();
  const { error: refreshError } = await supabase.rpc('ensure_free_tier_fresh', {
    p_user_id: userId,
  });
  if (refreshError) throw refreshError;

  const { data, error } = await supabase
    .from('token_balances')
    .select('source,balance,expires_at')
    .eq('user_id', userId);
  if (error) throw error;

  const bySource = new Map((data ?? []).map((row) => [row.source, row]));
  const subscriptionRow = bySource.get('subscription');
  const subscriptionExpired =
    !!subscriptionRow?.expires_at &&
    new Date(subscriptionRow.expires_at).getTime() < Date.now();
  const subscription = subscriptionExpired
    ? 0
    : (subscriptionRow?.balance ?? 0);
  const purchased = bySource.get('purchased')?.balance ?? 0;

  return { supabase, subscription, purchased };
};

const consumeFromSupabase = async (
  body: ConsumeBody,
): Promise<ConsumeResult> => {
  if (!body.userId) {
    throw new Error('userId is required for Supabase billing fallback');
  }

  const { supabase, subscription, purchased } = await readBalances(body.userId);
  const total = subscription + purchased;
  if (total < body.tokens) {
    return {
      ok: false,
      reason: 'insufficient_tokens',
      tokensRequired: body.tokens,
      tokensAvailable: total,
      tokensDeducted: 0,
    };
  }

  const subscriptionDeduct = Math.min(body.tokens, subscription);
  const purchasedDeduct = body.tokens - subscriptionDeduct;
  const subscriptionBalance = subscription - subscriptionDeduct;
  const purchasedBalance = purchased - purchasedDeduct;

  if (subscriptionDeduct > 0) {
    const { error } = await supabase
      .from('token_balances')
      .update({
        balance: subscriptionBalance,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', body.userId)
      .eq('source', 'subscription');
    if (error) throw error;
  }

  if (purchasedDeduct > 0) {
    const { error } = await supabase
      .from('token_balances')
      .update({
        balance: purchasedBalance,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', body.userId)
      .eq('source', 'purchased');
    if (error) throw error;
  }

  const { error: transactionError } = await supabase
    .from('token_transactions')
    .insert({
      user_id: body.userId,
      operation: body.operation ?? 'chat',
      amount: -body.tokens,
      source: subscriptionDeduct > 0 ? 'subscription' : 'purchased',
      reference_id: body.referenceId ?? null,
      subscription_balance_after: subscriptionBalance,
      purchased_balance_after: purchasedBalance,
    });
  if (transactionError) throw transactionError;

  return {
    ok: true,
    tokensDeducted: body.tokens,
    freeBalance: 0,
    subscriptionBalance,
    purchasedBalance,
    totalBalance: subscriptionBalance + purchasedBalance,
  };
};

const refundToSupabase = async (body: RefundBody): Promise<RefundResult> => {
  if (!body.userId) {
    throw new Error('userId is required for Supabase billing fallback');
  }

  const { supabase, subscription, purchased } = await readBalances(body.userId);
  const subscriptionBalance = subscription + body.tokens;

  const { error: upsertError } = await supabase.from('token_balances').upsert(
    {
      user_id: body.userId,
      source: 'subscription',
      balance: subscriptionBalance,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,source' },
  );
  if (upsertError) throw upsertError;

  const { error: transactionError } = await supabase
    .from('token_transactions')
    .insert({
      user_id: body.userId,
      operation: 'refund',
      amount: body.tokens,
      source: 'subscription',
      reference_id: body.referenceId ?? null,
      subscription_balance_after: subscriptionBalance,
      purchased_balance_after: purchased,
    });
  if (transactionError) throw transactionError;

  return {
    ok: true,
    tokensRefunded: body.tokens,
    source: 'subscription',
    freeBalance: 0,
    subscriptionBalance,
    purchasedBalance: purchased,
    totalBalance: subscriptionBalance + purchased,
  };
};

export class BillingClientError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const baseUrl = (): string => {
  const url = Deno.env.get('BILLING_SERVICE_URL');
  if (!url) throw new Error('BILLING_SERVICE_URL is not set');
  return url.replace(/\/$/, '');
};

const apiKey = (): string => {
  const key = Deno.env.get('BILLING_SERVICE_KEY');
  if (!key) throw new Error('BILLING_SERVICE_KEY is not set');
  return key;
};

type CallOptions = {
  allowStatus?: number[];
};

const call = async <T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  options?: CallOptions,
): Promise<T> => {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok && !options?.allowStatus?.includes(res.status)) {
    throw new BillingClientError(
      `billing ${method} ${path} -> ${res.status}`,
      res.status,
      parsed,
    );
  }
  return parsed as T;
};

const enc = (email: string): string => encodeURIComponent(email.toLowerCase());

type ConsumeBody = {
  tokens: number;
  operation?: string;
  referenceId?: string;
  userId?: string;
};

type RefundBody = {
  tokens: number;
  operation?: string;
  referenceId?: string;
  userId?: string;
};

type CheckoutBody = {
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  trialPeriodDays?: number;
};

type CancelSubscriptionBody = {
  feedback?:
    | 'customer_service'
    | 'low_quality'
    | 'missing_features'
    | 'other'
    | 'switched_service'
    | 'too_complex'
    | 'too_expensive'
    | 'unused';
  comment?: string;
};

export type CancelSubscriptionResult =
  | { canceled: true }
  | { canceled: false; reason: 'no_subscription' | 'already_canceled' };

export const billing = {
  getStatus: (email: string) =>
    isLocalBillingBypassEnabled()
      ? Promise.resolve(localStatus())
      : call<BillingStatus>('GET', `/v1/users/${enc(email)}/status`),

  consume: (email: string, body: ConsumeBody) =>
    isLocalBillingBypassEnabled()
      ? Promise.resolve(localConsume(body.tokens))
      : !isBillingServiceConfigured()
        ? consumeFromSupabase(body)
        : call<ConsumeResult>('POST', `/v1/users/${enc(email)}/consume`, body, {
            allowStatus: [422],
          }),

  refund: (email: string, body: RefundBody) =>
    isLocalBillingBypassEnabled()
      ? Promise.resolve({
          ok: true,
          tokensRefunded: body.tokens,
          source: 'subscription' as const,
          freeBalance: 0,
          subscriptionBalance: PLAN_CATALOG.pro.tokenAmount,
          purchasedBalance: 0,
          totalBalance: PLAN_CATALOG.pro.tokenAmount,
        })
      : !isBillingServiceConfigured()
        ? refundToSupabase(body)
        : call<RefundResult>('POST', `/v1/users/${enc(email)}/refund`, body),

  createCheckout: (email: string, body: CheckoutBody) =>
    call<{ url: string }>('POST', `/v1/users/${enc(email)}/checkout`, body),

  createPortal: (email: string, body: { returnUrl: string }) =>
    call<{ url: string }>('POST', `/v1/users/${enc(email)}/portal`, body),

  cancelSubscription: (email: string, body: CancelSubscriptionBody = {}) =>
    call<CancelSubscriptionResult>(
      'POST',
      `/v1/users/${enc(email)}/cancel-subscription`,
      body,
    ),

  getProductsByType: (type: 'subscription' | 'pack') =>
    isLocalBillingBypassEnabled()
      ? Promise.resolve(
          localProducts().filter((product) => product.productType === type),
        )
      : call<BillingProduct[]>('GET', `/v1/products?type=${type}`),

  getAllProducts: () =>
    isLocalBillingBypassEnabled()
      ? Promise.resolve({
          subscriptions: localProducts().filter(
            (product) => product.productType === 'subscription',
          ),
          packs: localProducts().filter(
            (product) => product.productType === 'pack',
          ),
        })
      : call<{ subscriptions: BillingProduct[]; packs: BillingProduct[] }>(
          'GET',
          '/v1/products',
        ),
};
