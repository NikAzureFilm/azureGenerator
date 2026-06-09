import Link from 'next/link';
import { requireAdmin } from '@/lib/auth';
import {
  fetchOverview,
  fetchDailyActivity,
  fetchRecentGenerations,
  fetchTopUsers,
  fetchCostBreakdown,
  tokenCostUsd,
  tokenValueUsd,
} from '@/lib/metrics';
import { getStripeMetrics } from '@/lib/stripe';
import { PLAN_DISPLAY } from '@/lib/pricing';
import { usd, usdFromDollars, num, pct, relativeTime } from '@/lib/format';
import { generationKindLabel } from '@/lib/content';
import ActivityChart from './components/ActivityChart';
import Nav from './components/Nav';
import Kpi from './components/Kpi';
import StatusBadge from './components/StatusBadge';

// Always render fresh — this is a live dashboard.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function DashboardPage() {
  const admin = await requireAdmin();

  const [overview, daily, recent, topUsers, stripe, cost] = await Promise.all([
    fetchOverview(),
    fetchDailyActivity(30),
    fetchRecentGenerations(30),
    fetchTopUsers(10),
    getStripeMetrics(),
    // Resilient: the Overview still renders if admin_explorer.sql isn't applied.
    fetchCostBreakdown().catch(() => null),
  ]);

  const { users, generations, tokens, revenue } = overview;

  // --- Derived token economics --------------------------------------------
  const costTotalUsd = tokenCostUsd(tokens.consumed_total);
  const cost30dUsd = tokenCostUsd(tokens.consumed_30d);
  const valueTotalUsd = tokenValueUsd(tokens.consumed_total);

  // Monthly revenue picture: prefer Stripe cash if available, else DB MRR.
  const mrrCents = stripe?.mrrCents ?? revenue.mrr_cents;

  // Actual provider cost (real COGS) once provider_usage is populated; falls
  // back to the token estimate ($0.01/token) until then.
  const hasActualCost = Boolean(cost?.has_provider_usage);
  const providerCostTotalUsd = cost?.has_provider_usage
    ? cost.cost_total_usd
    : costTotalUsd;
  const providerCost30dUsd = cost?.has_provider_usage
    ? cost.cost_30d_usd
    : cost30dUsd;
  // Gross margin over the last 30 days: MRR + 30d token-pack revenue − 30d cost.
  const revenue30dUsd = (mrrCents + revenue.token_pack_revenue_30d_cents) / 100;
  const margin30dUsd = revenue30dUsd - providerCost30dUsd;
  const margin30dPct = revenue30dUsd > 0 ? margin30dUsd / revenue30dUsd : 0;

  const cadSuccessRate =
    generations.cad_jobs > 0
      ? generations.cad_jobs_success / generations.cad_jobs
      : 0;

  const byOp = tokens.by_operation ?? {};
  const opEntries = Object.entries(byOp).sort((a, b) => b[1] - a[1]);

  return (
    <div className="wrap">
      <Nav active="overview" email={admin.email} />

      {!stripe && (
        <div className="banner">
          Stripe is not configured (no <code>STRIPE_SECRET_KEY</code>). Showing
          DB-derived MRR instead of actual cash collected.
        </div>
      )}

      {/* ---------------- Headline KPIs ---------------- */}
      <div className="section-title">Overview</div>
      <div className="quick-links">
        <Link className="btn" href="/generations">
          View generated content
        </Link>
        <Link className="btn" href="/resources">
          API / Supabase / Vercel links
        </Link>
      </div>
      <div className="kpi grid">
        <Kpi
          label="Total users"
          value={num(users.total)}
          sub={
            <>
              <b className="up">+{num(users.new_7d)}</b> last 7d ·{' '}
              <b>+{num(users.new_30d)}</b> last 30d
            </>
          }
        />
        <Kpi
          label="Active users (30d)"
          value={num(users.active_30d)}
          sub={
            <>
              {users.total > 0 ? pct(users.active_30d / users.total) : '—'} of
              all users
            </>
          }
        />
        <Kpi
          label="Paying subscribers"
          value={num(users.paying)}
          sub={
            <>
              {users.total > 0 ? pct(users.paying / users.total) : '—'}{' '}
              conversion
            </>
          }
        />
        <Kpi
          label={stripe ? 'MRR (Stripe)' : 'MRR (estimated)'}
          value={usd(mrrCents)}
          sub={<>{usd(mrrCents * 12)} ARR run-rate</>}
        />
      </div>

      {/* ---------------- Revenue ---------------- */}
      <div className="section-title">Revenue</div>
      <div className="cols-3 grid">
        <div className="card">
          <div className="label">Monthly recurring revenue</div>
          <div className="value mono">{usd(mrrCents)}</div>
          <div className="sub">
            {Object.entries(revenue.by_plan).length === 0 ? (
              <>No active subscriptions</>
            ) : (
              Object.entries(revenue.by_plan).map(([plan, count]) => (
                <span key={plan} style={{ marginRight: 12 }}>
                  <b>{num(count)}</b> {PLAN_DISPLAY[plan] ?? plan}
                </span>
              ))
            )}
          </div>
        </div>

        <div className="card">
          <div className="label">Token-pack revenue</div>
          <div className="value mono">
            {usd(revenue.token_pack_revenue_cents)}
          </div>
          <div className="sub">
            <b>{usd(revenue.token_pack_revenue_30d_cents)}</b> last 30 days
          </div>
        </div>

        {stripe ? (
          <div className="card">
            <div className="label">Cash collected (Stripe, 30d)</div>
            <div className="value mono">{usd(stripe.netVolume30dCents)}</div>
            <div className="sub">
              {usd(stripe.grossVolume30dCents)} gross ·{' '}
              <b className="down">−{usd(stripe.refunded30dCents)}</b> refunded
              {stripe.truncated && ' · partial'}
            </div>
          </div>
        ) : (
          <div className="card">
            <div className="label">Total revenue (estimated)</div>
            <div className="value mono">
              {usd(mrrCents + revenue.token_pack_revenue_cents)}
            </div>
            <div className="sub">MRR + lifetime token packs</div>
          </div>
        )}
      </div>

      {/* ---------------- Token costs & margin ---------------- */}
      <div className="section-title">Token usage & cost</div>
      <div className="cols-3 grid">
        <div className="card">
          <div className="label">Tokens consumed</div>
          <div className="value mono">{num(tokens.consumed_total)}</div>
          <div className="sub">
            <b>{num(tokens.consumed_30d)}</b> last 30 days
          </div>
        </div>
        <div className="card">
          <div className="label">Provider cost (COGS)</div>
          <div className="value mono">
            {usdFromDollars(providerCostTotalUsd)}
          </div>
          <div className="sub">
            <b>{usdFromDollars(providerCost30dUsd)}</b> last 30 days ·{' '}
            {hasActualCost ? 'actual provider billing' : 'est. $0.01/token'}
          </div>
        </div>
        <div className="card">
          <div className="label">Gross margin (30d)</div>
          <div className="value mono">{usdFromDollars(margin30dUsd)}</div>
          <div className="sub">
            <b className={margin30dUsd >= 0 ? 'up' : 'down'}>
              {pct(margin30dPct)}
            </b>{' '}
            margin · {usdFromDollars(valueTotalUsd)} list value
          </div>
        </div>
      </div>

      <div className="cols-2 grid" style={{ marginTop: 14 }}>
        <div className="card">
          <div className="label">Consumption by operation</div>
          <div style={{ marginTop: 10 }}>
            {opEntries.length === 0 ? (
              <div className="muted">No usage yet.</div>
            ) : (
              opEntries.map(([op, amount]) => (
                <div className="kv" key={op}>
                  <span className="k" style={{ textTransform: 'capitalize' }}>
                    {op}
                  </span>
                  <span className="mono">
                    {num(amount)} tok ·{' '}
                    <span className="muted">
                      {usdFromDollars(tokenCostUsd(amount))}
                    </span>
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="card">
          <div className="label">Outstanding token liability</div>
          <div style={{ marginTop: 10 }}>
            <div className="kv">
              <span className="k">Subscription balance</span>
              <span className="mono">
                {num(tokens.balance_subscription)} tok
              </span>
            </div>
            <div className="kv">
              <span className="k">Purchased balance</span>
              <span className="mono">{num(tokens.balance_purchased)} tok</span>
            </div>
            <div className="kv">
              <span className="k">Lifetime refunded</span>
              <span className="mono">{num(tokens.refunded)} tok</span>
            </div>
            <div className="kv">
              <span className="k">Purchased credited (lifetime)</span>
              <span className="mono">{num(tokens.purchased_credited)} tok</span>
            </div>
          </div>
        </div>
      </div>

      {/* ---------------- Generations ---------------- */}
      <div className="section-title">What users are generating</div>
      <div className="cols-3 grid">
        <Kpi
          label="CAD jobs"
          value={num(generations.cad_jobs)}
          sub={
            <>
              <b>{num(generations.cad_jobs_30d)}</b> last 30d ·{' '}
              <b className="up">{pct(cadSuccessRate)}</b> success
            </>
          }
        />
        <Kpi
          label="Meshes"
          value={num(generations.meshes)}
          sub={
            <>
              <b>{num(generations.meshes_30d)}</b> last 30d ·{' '}
              <b className="down">{num(generations.meshes_failure)}</b> failed
            </>
          }
        />
        <Kpi
          label="Images generated"
          value={num(generations.images)}
          sub={<>reference + multiview inputs</>}
        />
        <Kpi label="Conversations" value={num(generations.conversations)} />
        <Kpi label="Messages" value={num(generations.messages)} />
        <Kpi label="Prompt-helper runs" value={num(generations.prompts)} />
      </div>

      <div style={{ marginTop: 14 }}>
        <ActivityChart data={daily} />
      </div>

      {/* ---------------- Recent generations feed ---------------- */}
      <div className="section-title">Recent generations</div>
      <div className="card" style={{ padding: 6 }}>
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>User</th>
              <th>Title</th>
              <th>Status</th>
              <th className="right">When</th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">
                  No generations yet.
                </td>
              </tr>
            ) : (
              recent.map((g) => (
                <tr key={`${g.kind}-${g.id}`}>
                  <td>
                    <span className="badge">{generationKindLabel(g.kind)}</span>
                  </td>
                  <td className="ellip">{g.user_email ?? '—'}</td>
                  <td className="ellip muted">{g.title ?? '—'}</td>
                  <td>
                    <StatusBadge status={g.status} />
                  </td>
                  <td className="right muted">{relativeTime(g.created_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ---------------- Top users ---------------- */}
      <div className="section-title">Top users by token usage</div>
      <div className="card" style={{ padding: 6 }}>
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Plan</th>
              <th className="right">Tokens used</th>
              <th className="right">Est. cost</th>
              <th className="right">Generations</th>
              <th className="right">Joined</th>
            </tr>
          </thead>
          <tbody>
            {topUsers.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  No users yet.
                </td>
              </tr>
            ) : (
              topUsers.map((u) => (
                <tr key={u.user_id}>
                  <td className="ellip">
                    <Link href={`/users/${u.user_id}`}>{u.email ?? '—'}</Link>
                    {u.full_name && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {u.full_name}
                      </div>
                    )}
                  </td>
                  <td>
                    <span
                      className={`badge ${
                        u.plan === 'pro'
                          ? 'pro'
                          : u.plan === 'standard'
                            ? 'standard'
                            : ''
                      }`}
                    >
                      {PLAN_DISPLAY[u.plan] ?? u.plan}
                    </span>
                  </td>
                  <td className="right mono">{num(u.tokens_consumed)}</td>
                  <td className="right mono muted">
                    {usdFromDollars(tokenCostUsd(u.tokens_consumed))}
                  </td>
                  <td className="right mono">{num(u.generations)}</td>
                  <td className="right muted">{relativeTime(u.created_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 12, textAlign: 'right' }}>
        <Link href="/users">View all users →</Link>
      </div>

      <div className="sub" style={{ marginTop: 28, textAlign: 'center' }}>
        Live data · refresh to update ·{' '}
        {hasActualCost
          ? 'provider cost from actual API billing'
          : 'provider cost estimated at $0.01/token until usage data accrues'}
      </div>
    </div>
  );
}
