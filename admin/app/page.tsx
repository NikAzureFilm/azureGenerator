import { requireAdmin } from '@/lib/auth';
import {
  fetchOverview,
  fetchDailyActivity,
  fetchRecentGenerations,
  fetchTopUsers,
  tokenCostUsd,
  tokenValueUsd,
} from '@/lib/metrics';
import { getStripeMetrics } from '@/lib/stripe';
import { PLAN_DISPLAY } from '@/lib/pricing';
import { usd, usdFromDollars, num, pct, relativeTime } from '@/lib/format';
import ActivityChart from './components/ActivityChart';

// Always render fresh — this is a live dashboard.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function Kpi({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
}) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="value mono">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'success'
      ? 'success'
      : status === 'failure'
        ? 'failure'
        : 'pending';
  return <span className={`badge ${cls}`}>{status}</span>;
}

export default async function DashboardPage() {
  const admin = await requireAdmin();

  const [overview, daily, recent, topUsers, stripe] = await Promise.all([
    fetchOverview(),
    fetchDailyActivity(30),
    fetchRecentGenerations(30),
    fetchTopUsers(10),
    getStripeMetrics(),
  ]);

  const { users, generations, tokens, revenue } = overview;

  // --- Derived token economics --------------------------------------------
  const costTotalUsd = tokenCostUsd(tokens.consumed_total);
  const cost30dUsd = tokenCostUsd(tokens.consumed_30d);
  const valueTotalUsd = tokenValueUsd(tokens.consumed_total);

  // Monthly revenue picture: prefer Stripe cash if available, else DB MRR.
  const mrrCents = stripe?.mrrCents ?? revenue.mrr_cents;
  const cadSuccessRate =
    generations.cad_jobs > 0
      ? generations.cad_jobs_success / generations.cad_jobs
      : 0;

  const byOp = tokens.by_operation ?? {};
  const opEntries = Object.entries(byOp).sort((a, b) => b[1] - a[1]);

  return (
    <div className="wrap">
      <div className="topbar">
        <div className="brand">
          <h1>Adam Admin</h1>
          <span className="tag">analytics</span>
        </div>
        <div className="userbox">
          <span>{admin.email}</span>
          <form action="/api/logout" method="post">
            <button className="btn" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </div>

      {!stripe && (
        <div className="banner">
          Stripe is not configured (no <code>STRIPE_SECRET_KEY</code>). Showing
          DB-derived MRR instead of actual cash collected.
        </div>
      )}

      {/* ---------------- Headline KPIs ---------------- */}
      <div className="section-title">Overview</div>
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
          <div className="value mono">{usdFromDollars(costTotalUsd)}</div>
          <div className="sub">
            <b>{usdFromDollars(cost30dUsd)}</b> last 30 days · $0.01/token
          </div>
        </div>
        <div className="card">
          <div className="label">Value delivered</div>
          <div className="value mono">{usdFromDollars(valueTotalUsd)}</div>
          <div className="sub">tokens consumed × $0.03 list value</div>
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
                    <span className="badge">
                      {g.kind === 'cad' ? 'CAD' : 'Mesh'}
                    </span>
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
                    {u.email ?? '—'}
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

      <div className="sub" style={{ marginTop: 28, textAlign: 'center' }}>
        Live data · refresh to update · COGS at $0.01/token, list value
        $0.03/token
      </div>
    </div>
  );
}
