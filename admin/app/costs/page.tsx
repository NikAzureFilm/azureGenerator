import { requireAdmin } from '@/lib/auth';
import {
  fetchCostBreakdown,
  fetchCostDaily,
  tokenCostUsd,
} from '@/lib/metrics';
import { PLAN_DISPLAY } from '@/lib/pricing';
import { usd, usdFromDollars, num, pct } from '@/lib/format';
import Nav from '@/app/components/Nav';
import Kpi from '@/app/components/Kpi';
import CostChart from '@/app/components/CostChart';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Render a {label → dollars} card from a numeric (USD) map.
function CostMapCard({
  title,
  map,
  empty,
}: {
  title: string;
  map: Record<string, number>;
  empty: string;
}) {
  const entries = Object.entries(map ?? {}).sort((a, b) => b[1] - a[1]);
  return (
    <div className="card">
      <div className="label">{title}</div>
      <div style={{ marginTop: 10 }}>
        {entries.length === 0 ? (
          <div className="muted">{empty}</div>
        ) : (
          entries.map(([k, v]) => (
            <div className="kv" key={k}>
              <span className="k" style={{ textTransform: 'capitalize' }}>
                {k}
              </span>
              <span className="mono">{usdFromDollars(v)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default async function CostsPage() {
  const admin = await requireAdmin();

  const [breakdown, daily] = await Promise.all([
    fetchCostBreakdown(),
    fetchCostDaily(30),
  ]);

  const hasPU = breakdown.has_provider_usage;

  // Estimated cost from token consumption (fallback / always-available view).
  const tokenOps = breakdown.tokens_by_operation ?? {};
  const estTotalUsd = Object.values(tokenOps).reduce(
    (s, t) => s + tokenCostUsd(t),
    0,
  );

  // Drive the headline cost from provider usage when present, else the estimate.
  const costTotalUsd = hasPU ? breakdown.cost_total_usd : estTotalUsd;
  const cost30dUsd = hasPU ? breakdown.cost_30d_usd : null;

  const { mrr_cents, by_plan, token_pack_cents } = breakdown.revenue;
  const revenueCents = mrr_cents + token_pack_cents;
  const revenueUsd = revenueCents / 100;
  const marginUsd = revenueUsd - costTotalUsd;
  const marginPct = revenueUsd > 0 ? marginUsd / revenueUsd : 0;

  // For the breakdown columns: real provider maps when present, else the
  // token-estimate map (converted to USD) for by-operation.
  const estByOpUsd: Record<string, number> = {};
  for (const [op, t] of Object.entries(tokenOps)) {
    estByOpUsd[op] = tokenCostUsd(t);
  }

  return (
    <div className="wrap">
      <Nav active="costs" email={admin.email} />

      <div className="section-title">Costs & margin</div>

      {!hasPU && (
        <div className="banner">
          No actual provider-cost data yet; showing token-based estimates at
          $0.01/token.
        </div>
      )}

      <div className="kpi grid">
        <Kpi
          label={hasPU ? 'Provider cost' : 'Estimated cost'}
          value={usdFromDollars(costTotalUsd)}
          sub={
            cost30dUsd == null ? (
              <>tokens × $0.01 (no provider data)</>
            ) : (
              <>
                <b>{usdFromDollars(cost30dUsd)}</b> last 30 days
              </>
            )
          }
        />
        <Kpi
          label="MRR (DB-derived)"
          value={usd(mrr_cents)}
          sub={<>{usd(mrr_cents * 12)} ARR run-rate</>}
        />
        <Kpi
          label="Token-pack revenue"
          value={usd(token_pack_cents)}
          sub={<>lifetime purchases</>}
        />
        <Kpi
          label="Gross margin"
          value={usdFromDollars(marginUsd)}
          sub={
            <>
              {revenueUsd > 0 ? (
                <b className={marginUsd >= 0 ? 'up' : 'down'}>
                  {pct(marginPct)}
                </b>
              ) : (
                '—'
              )}{' '}
              of revenue
            </>
          }
        />
      </div>

      <div style={{ marginTop: 14 }}>
        <CostChart data={daily} />
      </div>

      <div className="section-title">Cost breakdown</div>
      <div className="cols-3 grid">
        <CostMapCard
          title="By operation"
          map={hasPU ? breakdown.by_operation : estByOpUsd}
          empty="No usage yet."
        />
        <CostMapCard
          title="By provider"
          map={breakdown.by_provider}
          empty={hasPU ? 'No usage yet.' : 'Needs provider-usage data.'}
        />
        <CostMapCard
          title="By model"
          map={breakdown.by_model}
          empty={hasPU ? 'No usage yet.' : 'Needs provider-usage data.'}
        />
      </div>

      <div className="section-title">Active plans</div>
      <div className="card">
        <div className="label">Subscribers by plan (MRR contributors)</div>
        <div style={{ marginTop: 10 }}>
          {Object.entries(by_plan).length === 0 ? (
            <div className="muted">No active subscriptions.</div>
          ) : (
            Object.entries(by_plan).map(([plan, count]) => (
              <div className="kv" key={plan}>
                <span className="k">{PLAN_DISPLAY[plan] ?? plan}</span>
                <span className="mono">{num(count)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
