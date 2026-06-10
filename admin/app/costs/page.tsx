import Link from 'next/link';
import { requireAdmin } from '@/lib/auth';
import { fetchCostExplorer, type CostExplorer } from '@/lib/costs';
import {
  fetchCostBreakdown,
  fetchCostDaily,
  tokenCostUsd,
} from '@/lib/metrics';
import { PLAN_DISPLAY } from '@/lib/pricing';
import {
  absoluteTime,
  num,
  pct,
  usd,
  usdFromDollars,
  usdSmall,
} from '@/lib/format';
import Nav from '@/app/components/Nav';
import Kpi from '@/app/components/Kpi';
import CostChart from '@/app/components/CostChart';
import StatusBadge from '@/app/components/StatusBadge';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const WINDOWS: { key: string; days: number | null; label: string }[] = [
  { key: '7', days: 7, label: '7 days' },
  { key: '30', days: 30, label: '30 days' },
  { key: '90', days: 90, label: '90 days' },
  { key: '365', days: 365, label: '1 year' },
  { key: 'all', days: null, label: 'All time' },
];

function windowLabel(explorer: CostExplorer): string {
  return WINDOWS.find((w) => w.days === explorer.days)?.label ?? 'window';
}

export default async function CostsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const admin = await requireAdmin();
  const sp = await searchParams;
  const windowChoice =
    WINDOWS.find((w) => w.key === (sp.days ?? '30')) ?? WINDOWS[1];

  const [breakdown, daily, explorer] = await Promise.all([
    fetchCostBreakdown(),
    fetchCostDaily(Math.min(windowChoice.days ?? 90, 90)),
    fetchCostExplorer(windowChoice.days),
  ]);

  const hasPU = breakdown.has_provider_usage;
  const { totals } = explorer;
  const label = windowLabel(explorer);

  // Lifetime token-estimate fallback (kept from the original page).
  const tokenOps = breakdown.tokens_by_operation ?? {};
  const estTotalUsd = Object.values(tokenOps).reduce(
    (s, t) => s + tokenCostUsd(t),
    0,
  );
  const lifetimeCostUsd = hasPU ? breakdown.cost_total_usd : estTotalUsd;

  const { mrr_cents, by_plan, token_pack_cents } = breakdown.revenue;
  const revenueUsd = (mrr_cents + token_pack_cents) / 100;
  const marginUsd = revenueUsd - lifetimeCostUsd;
  const marginPct = revenueUsd > 0 ? marginUsd / revenueUsd : 0;

  const failedShare =
    totals.costUsd > 0 ? totals.failedCostUsd / totals.costUsd : 0;
  const avgCallUsd = totals.calls > 0 ? totals.costUsd / totals.calls : 0;

  return (
    <div className="wrap wide">
      <Nav active="costs" email={admin.email} />

      <div className="section-title">Costs & margin</div>

      {!hasPU && (
        <div className="banner">
          No actual provider-cost data yet; lifetime figures are token-based
          estimates at $0.01/token.
        </div>
      )}

      <div className="window-pills">
        {WINDOWS.map((w) => (
          <Link
            key={w.key}
            className={w.key === windowChoice.key ? 'pill active' : 'pill'}
            href={w.key === '30' ? '/costs' : `/costs?days=${w.key}`}
          >
            {w.label}
          </Link>
        ))}
        {explorer.truncated && (
          <span className="muted tiny">
            (aggregated over the most recent {num(explorer.rowCount)} API calls)
          </span>
        )}
      </div>

      <div className="kpi grid">
        <Kpi
          label={`Provider cost (${label})`}
          value={usdFromDollars(totals.costUsd)}
          sub={
            <>
              <b>{num(totals.calls)}</b> API calls
            </>
          }
        />
        <Kpi
          label={`Avg cost per call (${label})`}
          value={usdSmall(avgCallUsd)}
          sub={
            <>
              {num(totals.inputTokens)} in / {num(totals.outputTokens)} out
              tokens
            </>
          }
        />
        <Kpi
          label={`Failed-call spend (${label})`}
          value={usdFromDollars(totals.failedCostUsd)}
          sub={
            <>
              <b className={failedShare > 0.1 ? 'down' : undefined}>
                {pct(failedShare)}
              </b>{' '}
              of spend - {num(totals.failedCalls)} failed calls
            </>
          }
        />
        <Kpi
          label="Gross margin (lifetime)"
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
              of {usdFromDollars(revenueUsd)} revenue
            </>
          }
        />
      </div>

      <div style={{ marginTop: 14 }}>
        <CostChart data={daily} />
      </div>

      <div className="section-title">Cost per generation ({label})</div>
      <div className="card table-card">
        <table>
          <thead>
            <tr>
              <th>Operation</th>
              <th className="right">API calls</th>
              <th className="right">Cost</th>
              <th className="right">Output units</th>
              <th className="right">Cost / unit</th>
              <th className="right">Share</th>
            </tr>
          </thead>
          <tbody>
            {explorer.byOperation.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  No provider usage recorded in this window.
                </td>
              </tr>
            ) : (
              explorer.byOperation.map((op) => (
                <tr key={op.operation}>
                  <td style={{ textTransform: 'capitalize' }}>
                    {op.operation}
                  </td>
                  <td className="right mono">{num(op.calls)}</td>
                  <td className="right mono">{usdFromDollars(op.costUsd)}</td>
                  <td className="right mono">
                    {op.units != null ? (
                      <>
                        {num(op.units)}{' '}
                        <span className="muted tiny">{op.unitLabel}</span>
                      </>
                    ) : (
                      <span className="muted">-</span>
                    )}
                  </td>
                  <td className="right mono">
                    {op.units ? usdSmall(op.costUsd / op.units) : '-'}
                  </td>
                  <td className="right mono muted">
                    {totals.costUsd > 0
                      ? pct(op.costUsd / totals.costUsd)
                      : '-'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="section-title">By model ({label})</div>
      <div className="card table-card">
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>Provider</th>
              <th className="right">Calls</th>
              <th className="right">Input tok</th>
              <th className="right">Output tok</th>
              <th className="right">Cached tok</th>
              <th className="right">Cost</th>
              <th className="right">Avg / call</th>
              <th className="right">Share</th>
            </tr>
          </thead>
          <tbody>
            {explorer.byModel.length === 0 ? (
              <tr>
                <td colSpan={9} className="muted">
                  No provider usage recorded in this window.
                </td>
              </tr>
            ) : (
              explorer.byModel.map((m) => (
                <tr key={`${m.provider}|${m.model}`}>
                  <td className="ellip mono tiny">{m.model}</td>
                  <td className="muted">{m.provider}</td>
                  <td className="right mono">{num(m.calls)}</td>
                  <td className="right mono">{num(m.inputTokens)}</td>
                  <td className="right mono">{num(m.outputTokens)}</td>
                  <td className="right mono muted">{num(m.cachedTokens)}</td>
                  <td className="right mono">{usdFromDollars(m.costUsd)}</td>
                  <td className="right mono muted">
                    {usdSmall(m.calls ? m.costUsd / m.calls : 0)}
                  </td>
                  <td className="right mono muted">
                    {totals.costUsd > 0 ? pct(m.costUsd / totals.costUsd) : '-'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="cols-2 grid" style={{ marginTop: 14 }}>
        <div className="card">
          <div className="label">By provider ({label})</div>
          <div style={{ marginTop: 10 }}>
            {explorer.byProvider.length === 0 ? (
              <div className="muted">No usage in this window.</div>
            ) : (
              explorer.byProvider.map((p) => (
                <div className="kv" key={p.provider}>
                  <span className="k" style={{ textTransform: 'capitalize' }}>
                    {p.provider}{' '}
                    <span className="tiny">({num(p.calls)} calls)</span>
                  </span>
                  <span className="mono">{usdFromDollars(p.costUsd)}</span>
                </div>
              ))
            )}
          </div>
        </div>
        <div className="card">
          <div className="label">Revenue (lifetime)</div>
          <div style={{ marginTop: 10 }}>
            <div className="kv">
              <span className="k">MRR (DB-derived)</span>
              <span className="mono">{usd(mrr_cents)}</span>
            </div>
            <div className="kv">
              <span className="k">Token-pack purchases</span>
              <span className="mono">{usd(token_pack_cents)}</span>
            </div>
            {Object.entries(by_plan).map(([plan, count]) => (
              <div className="kv" key={plan}>
                <span className="k">{PLAN_DISPLAY[plan] ?? plan}</span>
                <span className="mono">{num(count)} active</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="section-title">Top users by cost ({label})</div>
      <div className="card table-card">
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th className="right">API calls</th>
              <th className="right">Cost</th>
              <th className="right">Share</th>
            </tr>
          </thead>
          <tbody>
            {explorer.topUsers.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  No attributable usage in this window.
                </td>
              </tr>
            ) : (
              explorer.topUsers.map((u) => (
                <tr key={u.user_id}>
                  <td className="ellip">
                    <Link href={`/users/${u.user_id}`}>
                      {u.email ?? u.user_id}
                    </Link>
                  </td>
                  <td className="right mono">{num(u.calls)}</td>
                  <td className="right mono">{usdFromDollars(u.costUsd)}</td>
                  <td className="right mono muted">
                    {totals.costUsd > 0 ? pct(u.costUsd / totals.costUsd) : '-'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="section-title">Most expensive calls ({label})</div>
      <div className="card table-card">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>User</th>
              <th>Operation</th>
              <th>Model</th>
              <th className="right">Tokens in / out</th>
              <th>Status</th>
              <th className="right">Cost</th>
            </tr>
          </thead>
          <tbody>
            {explorer.topCalls.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted">
                  No provider usage recorded in this window.
                </td>
              </tr>
            ) : (
              explorer.topCalls.map((c) => (
                <tr key={c.id}>
                  <td className="muted tiny">{absoluteTime(c.created_at)}</td>
                  <td className="ellip">
                    {c.user_id ? (
                      <Link href={`/users/${c.user_id}`}>
                        {c.email ?? c.user_id}
                      </Link>
                    ) : (
                      <span className="muted">system</span>
                    )}
                  </td>
                  <td style={{ textTransform: 'capitalize' }}>{c.operation}</td>
                  <td className="ellip mono tiny">{c.model}</td>
                  <td className="right mono">
                    {num(c.inputTokens)} / {num(c.outputTokens)}
                  </td>
                  <td>
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="right mono">{usdSmall(c.costUsd)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
