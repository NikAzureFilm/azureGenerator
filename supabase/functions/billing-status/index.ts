import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { getAnonSupabaseClient } from '../_shared/supabaseClient.ts';
import { initSentry, logError } from '../_shared/sentry.ts';

initSentry();

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing']);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabase = getAnonSupabaseClient({
    global: {
      headers: { Authorization: req.headers.get('Authorization') ?? '' },
    },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user || !userData.user.email) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const userId = userData.user.id;

    const { error: refreshError } = await supabase.rpc(
      'ensure_free_tier_fresh',
      {
        p_user_id: userId,
      },
    );
    if (refreshError) throw refreshError;

    const [
      { data: balances, error: balancesError },
      { data: subscriptions, error: subscriptionError },
      { data: trialUser, error: trialError },
    ] = await Promise.all([
      supabase
        .from('token_balances')
        .select('source,balance,expires_at')
        .eq('user_id', userId),
      supabase
        .from('subscriptions')
        .select('level,status')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1),
      supabase
        .from('trial_users')
        .select('id')
        .eq('user_id', userId)
        .maybeSingle(),
    ]);

    if (balancesError) throw balancesError;
    if (subscriptionError) throw subscriptionError;
    if (trialError) throw trialError;

    const subscription = subscriptions?.[0] ?? null;
    const isPaidSubscriptionActive =
      !!subscription &&
      ACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status ?? '');

    const balanceBySource = new Map(
      (balances ?? []).map((balance) => [balance.source, balance]),
    );

    const subscriptionRow = balanceBySource.get('subscription');
    const subscriptionRowExpired =
      !!subscriptionRow?.expires_at &&
      new Date(subscriptionRow.expires_at).getTime() < Date.now();
    const timedBalance = subscriptionRowExpired
      ? 0
      : (subscriptionRow?.balance ?? 0);
    const purchased = balanceBySource.get('purchased')?.balance ?? 0;
    const free = isPaidSubscriptionActive ? 0 : timedBalance;
    const subscriptionTokens = isPaidSubscriptionActive ? timedBalance : 0;

    const status = {
      user: {
        hasTrialed: !!trialUser,
      },
      subscription: subscription
        ? {
            level: subscription.level,
            status: subscription.status,
            currentPeriodEnd: null,
          }
        : null,
      tokens: {
        free,
        subscription: subscriptionTokens,
        purchased,
        total: free + subscriptionTokens + purchased,
      },
    };

    return new Response(JSON.stringify(status), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    logError(err, {
      functionName: 'billing-status',
      statusCode: 500,
      userId: userData.user.id,
    });
    return new Response(
      JSON.stringify({ error: 'billing_status_unavailable' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }
});
