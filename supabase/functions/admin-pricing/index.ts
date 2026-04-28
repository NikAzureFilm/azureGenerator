import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { getAnonSupabaseClient } from '../_shared/supabaseClient.ts';
import { initSentry, logError } from '../_shared/sentry.ts';
import {
  FEATURE_COSTS,
  type PublicFeatureCost,
} from '../../../shared/tokenCosts.ts';

initSentry();

type InternalPricingInput = {
  tokenUsdValue: number;
  markupMultiplier: number;
  rows: Array<{
    id: string;
    provider: string;
    providerCostUsd: number;
    notes?: string;
  }>;
};

type AdminPricingRow = {
  id: string;
  label: string;
  description: string;
  provider: string;
  providerCostUsd: number;
  tokens: number;
  customerRevenueUsd: number;
  grossMarginUsd: number;
  grossMarginPercent: number | null;
  notes: string | null;
};

const featureById = new Map<string, PublicFeatureCost>(
  Object.values(FEATURE_COSTS).map((feature) => [feature.id, feature]),
);

function parseAdminEmails(): Set<string> {
  return new Set(
    (Deno.env.get('ADMIN_EMAILS') ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

function parsePricingConfig(): InternalPricingInput | null {
  const raw = Deno.env.get('ADMIN_PRICING_CONFIG_JSON');
  if (!raw) return null;

  const parsed = JSON.parse(raw) as InternalPricingInput;
  if (
    typeof parsed.tokenUsdValue !== 'number' ||
    typeof parsed.markupMultiplier !== 'number' ||
    !Array.isArray(parsed.rows)
  ) {
    throw new Error('Invalid ADMIN_PRICING_CONFIG_JSON shape');
  }

  return parsed;
}

function buildRows(config: InternalPricingInput): AdminPricingRow[] {
  return config.rows.map((row) => {
    const publicFeature = featureById.get(row.id);
    const tokens = publicFeature?.tokens ?? 0;
    const customerRevenueUsd = tokens * config.tokenUsdValue;
    const grossMarginUsd = customerRevenueUsd - row.providerCostUsd;
    const grossMarginPercent =
      customerRevenueUsd > 0 ? grossMarginUsd / customerRevenueUsd : null;

    return {
      id: row.id,
      label: publicFeature?.label ?? row.id,
      description: publicFeature?.description ?? '',
      provider: row.provider,
      providerCostUsd: row.providerCostUsd,
      tokens,
      customerRevenueUsd,
      grossMarginUsd,
      grossMarginPercent,
      notes: row.notes ?? null,
    };
  });
}

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

  const adminEmails = parseAdminEmails();
  const userEmail = userData.user.email.toLowerCase();
  if (!adminEmails.has(userEmail)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const config = parsePricingConfig();
    if (!config) {
      return new Response(
        JSON.stringify({ error: 'admin_pricing_not_configured' }),
        {
          status: 503,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    return new Response(
      JSON.stringify({
        tokenUsdValue: config.tokenUsdValue,
        markupMultiplier: config.markupMultiplier,
        rows: buildRows(config),
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  } catch (err) {
    logError(err, {
      functionName: 'admin-pricing',
      statusCode: 500,
      userId: userData.user.id,
    });

    return new Response(
      JSON.stringify({ error: 'admin_pricing_unavailable' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }
});
