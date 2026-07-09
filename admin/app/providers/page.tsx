import { Fragment } from 'react';
import { requireAdmin } from '@/lib/auth';
import { fetchProviderCredit, type ProviderStatus } from '@/lib/providers';
import { fetchProviderKeys, type CreditBalance } from '@/lib/providerKeys';
import { metaFor } from '@/lib/providerMeta';
import { PRICING_CATALOG } from '@/lib/providerPricing';
import { absoluteTime, num, pct, usdFromDollars, usdSmall } from '@/lib/format';
import Nav from '@/app/components/Nav';
import BudgetEditor from '@/app/components/BudgetEditor';
import ApiKeyRow from '@/app/components/ApiKeyRow';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const STATUS_LABEL: Record<ProviderStatus, string> = {
  ok: 'on budget',
  warn: 'approaching',
  over: 'over budget',
  none: 'no budget',
};

// Live-credit line for a provider with a credit strategy. Openrouter/fal report
// a remaining balance; error and unconfigured fall back to a tiny muted hint
// naming the right admin env var.
function CreditLine({
  balance,
  strategy,
}: {
  balance: CreditBalance | undefined;
  strategy: 'openrouter' | 'fal';
}) {
  const envVar = strategy === 'openrouter' ? 'OPENROUTER_API_KEY' : 'FAL_KEY';

  if (!balance || balance.kind === 'unconfigured') {
    return (
      <div className="provider-credit muted tiny">
        add {envVar} to the admin env for live credits
      </div>
    );
  }
  if (balance.kind === 'error') {
    return (
      <div className="provider-credit muted tiny">credits unavailable</div>
    );
  }
  if (balance.kind === 'openrouter') {
    return (
      <div className="provider-credit">
        Credits remaining: <b>{usdFromDollars(balance.remainingUsd)}</b>{' '}
        <span className="muted">
          of {usdFromDollars(balance.totalCreditsUsd)} purchased
        </span>
      </div>
    );
  }
  return (
    <div className="provider-credit">
      Credits remaining: <b>{usdFromDollars(balance.remainingUsd)}</b>
    </div>
  );
}

export default async function ProvidersPage() {
  const admin = await requireAdmin();
  const [credit, keys] = await Promise.all([
    fetchProviderCredit(),
    fetchProviderKeys(),
  ]);

  return (
    <div className="wrap wide">
      <Nav active="providers" email={admin.email} />

      <div className="section-title">API providers — spend &amp; budgets</div>

      {!credit.budgetsAvailable && (
        <div className="banner">
          Budgets table missing — apply{' '}
          <code>admin/sql/patches/2026-07-07-provider-budgets.sql</code>. Spend
          figures below are live; budgets and alerts are disabled until the
          patch is applied.
        </div>
      )}
      {credit.spendMayBeUnderstated && (
        <div className="banner">
          Row cap hit ({num(20000)} rows) and the{' '}
          <code>admin_provider_costs</code> aggregation function is not applied
          — spend figures are <b>lower bounds</b>. Apply{' '}
          <code>admin/sql/patches/2026-07-07-provider-costs-rpc.sql</code> for
          exact month-to-date spend and reliable budget alerts.
        </div>
      )}

      {credit.providers.length === 0 ? (
        <div className="card muted">
          No provider usage recorded in the last 62 days.
        </div>
      ) : (
        <div className="provider-grid">
          {credit.providers.map((p) => {
            const fillPct =
              p.budgetUsd && p.budgetUsd > 0
                ? Math.min(100, (p.mtdCostUsd / p.budgetUsd) * 100)
                : 0;
            const fillClass =
              p.status === 'over'
                ? 'fill over'
                : p.status === 'warn'
                  ? 'fill warn'
                  : 'fill';
            const meta = metaFor(p.provider);
            const links = meta
              ? [
                  { label: 'Console', url: meta.dashboardUrl },
                  { label: 'API keys', url: meta.keysUrl },
                  { label: 'Billing', url: meta.billingUrl },
                  { label: 'Status', url: meta.statusUrl },
                ].filter(
                  (l): l is { label: string; url: string } => l.url !== null,
                )
              : [];
            return (
              <div className="card" key={p.provider}>
                <div className="provider-card-head">
                  <span className="provider-name">{p.provider}</span>
                  <span className={`statuspill ${p.status}`}>
                    {STATUS_LABEL[p.status]}
                  </span>
                </div>

                {links.length > 0 && (
                  <div className="provider-links">
                    {links.map((l, i) => (
                      <Fragment key={l.label}>
                        {i > 0 && <span className="sep">·</span>}
                        <a href={l.url} target="_blank" rel="noreferrer">
                          {l.label}
                        </a>
                      </Fragment>
                    ))}
                  </div>
                )}

                <div className="sub" style={{ marginTop: 8 }}>
                  <b>{usdFromDollars(p.mtdCostUsd)}</b> month-to-date
                  {p.budgetUsd != null && (
                    <> of {usdFromDollars(p.budgetUsd)} budget</>
                  )}
                </div>

                {meta?.credits && (
                  <CreditLine
                    balance={keys.credits.get(p.provider)}
                    strategy={meta.credits}
                  />
                )}

                {p.budgetUsd != null && p.budgetUsd > 0 && (
                  <div
                    className="budgetbar"
                    title={`${pct(p.mtdCostUsd / p.budgetUsd)} of budget used`}
                  >
                    <div
                      className={fillClass}
                      style={{ width: `${fillPct}%` }}
                    />
                  </div>
                )}

                <div className="provider-metrics">
                  <div className="kv">
                    <span className="k">Projected month-end</span>
                    <span className="mono">
                      {usdFromDollars(p.projectedMonthUsd)}
                    </span>
                  </div>
                  <div className="kv">
                    <span className="k">Prev month</span>
                    <span className="mono">
                      {usdFromDollars(p.prevMonthCostUsd)}
                    </span>
                  </div>
                  <div className="kv">
                    <span className="k">Last 30d</span>
                    <span className="mono">
                      {usdFromDollars(p.last30dCostUsd)}
                    </span>
                  </div>
                  <div className="kv">
                    <span className="k">MTD calls</span>
                    <span className="mono">{num(p.mtdCalls)}</span>
                  </div>
                  <div className="kv">
                    <span className="k">Failed spend (MTD)</span>
                    <span className="mono">
                      {usdFromDollars(p.failedMtdCostUsd)}
                    </span>
                  </div>
                  <div className="kv">
                    <span className="k">Burn / day</span>
                    <span className="mono">{usdSmall(p.burnUsdPerDay)}</span>
                  </div>
                </div>

                {credit.budgetsAvailable && (
                  <BudgetEditor
                    provider={p.provider}
                    currentBudgetUsd={p.budgetUsd}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ---------------- API keys ---------------- */}
      <div className="section-title">API keys</div>
      <p className="muted tiny" style={{ margin: '-6px 0 14px' }}>
        These manage the Supabase edge-function secrets the product reads at
        runtime. Stored keys can never be read back — status shows only a digest
        fingerprint, and Test validates a pasted key without storing it.
      </p>
      {!keys.available ? (
        <div className="banner">
          Key management is disabled until <code>SUPABASE_ACCESS_TOKEN</code> is
          set in the admin Vercel environment. <code>SUPABASE_PROJECT_REF</code>{' '}
          is optional — the project ref is otherwise derived from{' '}
          <code>SUPABASE_URL</code>.
        </div>
      ) : keys.error ? (
        <div className="banner">{keys.error}</div>
      ) : (
        <div className="card table-card">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Secret</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys.keys.map((k) => (
                <tr key={k.provider}>
                  <td className="muted" style={{ textTransform: 'capitalize' }}>
                    {k.provider}
                  </td>
                  <td className="mono tiny">{k.secretName}</td>
                  <td>
                    {k.isSet ? (
                      <>
                        set{' '}
                        {k.digestShort && (
                          <span className="muted tiny">
                            sha-256 {k.digestShort}…
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="muted">not set</span>
                    )}
                  </td>
                  <td>
                    <ApiKeyRow
                      provider={k.provider}
                      secretName={k.secretName}
                      isSet={k.isSet}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---------------- Unpriced models ---------------- */}
      <div className="section-title">Unpriced models</div>
      {credit.unpriced.length === 0 ? (
        <div className="card muted">
          All models with activity in the last 30 days are priced.
        </div>
      ) : (
        <>
          <div className="banner">
            These models were called with real token/request activity but logged
            at $0 COGS — <code>shared/providerPricing.ts</code> has no rate for
            them. Add the rate there and to the vendored copy{' '}
            <code>admin/lib/providerPricing.ts</code> so cost and margin stay
            accurate.
          </div>
          <div className="card table-card">
            <table>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Model</th>
                  <th className="right">Calls (30d)</th>
                  <th className="right">Input tok</th>
                  <th className="right">Output tok</th>
                  <th className="right">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {credit.unpriced.map((u) => (
                  <tr key={`${u.provider}|${u.model}`}>
                    <td
                      className="muted"
                      style={{ textTransform: 'capitalize' }}
                    >
                      {u.provider}
                    </td>
                    <td className="ellip mono tiny">{u.model}</td>
                    <td className="right mono">{num(u.calls)}</td>
                    <td className="right mono">{num(u.inputTokens)}</td>
                    <td className="right mono">{num(u.outputTokens)}</td>
                    <td className="right muted tiny">
                      {absoluteTime(u.lastSeen)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ---------------- Pricing catalog (vendored) ---------------- */}
      <div className="section-title">Pricing catalog (vendored)</div>
      <div className="card table-card">
        <table>
          <thead>
            <tr>
              <th>Category</th>
              <th>Model / endpoint</th>
              <th>Rate</th>
            </tr>
          </thead>
          <tbody>
            {PRICING_CATALOG.map((row) => (
              <tr key={`${row.category}|${row.id}`}>
                <td className="muted">{row.category}</td>
                <td className="ellip mono tiny">{row.id}</td>
                <td className="mono">{row.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
