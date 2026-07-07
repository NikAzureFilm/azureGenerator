import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/auth';
import {
  fetchUserDetail,
  fetchUserConversations,
  fetchUserGenerations,
  fetchUserTransactions,
  tokenCostUsd,
} from '@/lib/metrics';
import { generationKindLabel } from '@/lib/content';
import { PLAN_DISPLAY } from '@/lib/pricing';
import {
  usd,
  usdFromDollars,
  num,
  operationLabel,
  relativeTime,
} from '@/lib/format';
import JsonBlock, { PromptPreview } from '@/app/components/JsonBlock';
import Nav from '@/app/components/Nav';
import Kpi from '@/app/components/Kpi';
import StatusBadge from '@/app/components/StatusBadge';
import TokenAdjust from '@/app/components/TokenAdjust';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function UserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const admin = await requireAdmin();
  const { id } = await params;

  const [detail, generations, conversations, transactions] = await Promise.all([
    fetchUserDetail(id),
    fetchUserGenerations(id, 50),
    fetchUserConversations(id, 50),
    fetchUserTransactions(id, 50),
  ]);

  if (!detail?.profile) notFound();

  const { profile, subscription, balances, tokens, revenue } = detail;
  const gens = detail.generations;

  const opEntries = Object.entries(tokens.by_operation ?? {}).sort(
    (a, b) => b[1] - a[1],
  );
  const balanceEntries = Object.entries(balances ?? {});
  const revenueCents = revenue.token_pack_cents + revenue.plan_monthly_cents;

  return (
    <div className="wrap">
      <Nav active="users" email={admin.email} />

      <div className="sub" style={{ marginBottom: 12 }}>
        <Link href="/users">← All users</Link>
      </div>

      {/* Header card */}
      <div className="card">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div className="value" style={{ fontSize: 22 }}>
              {profile.email ?? '—'}
            </div>
            <div className="sub">{profile.full_name ?? 'No name on file'}</div>
            <div
              style={{
                marginTop: 10,
                display: 'flex',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              <span
                className={`badge ${
                  subscription?.level === 'pro'
                    ? 'pro'
                    : subscription?.level === 'standard'
                      ? 'standard'
                      : ''
                }`}
              >
                {subscription
                  ? (PLAN_DISPLAY[subscription.level] ?? subscription.level)
                  : 'Free'}
              </span>
              {subscription?.status && (
                <span className="badge">{subscription.status}</span>
              )}
              {profile.has_trialed && <span className="badge">trialed</span>}
            </div>
          </div>
          <div className="sub" style={{ textAlign: 'right' }}>
            <div>Signed up {relativeTime(profile.created_at)}</div>
            {subscription?.stripe_customer_id && (
              <div className="mono" style={{ marginTop: 6, fontSize: 12 }}>
                cus: {subscription.stripe_customer_id}
              </div>
            )}
            {subscription?.stripe_subscription_id && (
              <div className="mono" style={{ fontSize: 12 }}>
                sub: {subscription.stripe_subscription_id}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* KPIs */}
      <div className="kpi grid" style={{ marginTop: 14 }}>
        <Kpi
          label="Tokens consumed"
          value={num(tokens.consumed_total)}
          sub={
            <>
              <b>{num(tokens.consumed_30d)}</b> last 30 days
            </>
          }
        />
        <Kpi
          label="Generations"
          value={num(gens.cad_jobs + gens.meshes + gens.images)}
          sub={
            <>
              {num(gens.cad_jobs)} CAD · {num(gens.meshes)} mesh ·{' '}
              {num(gens.images)} img
            </>
          }
        />
        <Kpi
          label="Actual cost"
          value={
            detail.actual_cost_usd == null
              ? usdFromDollars(tokenCostUsd(tokens.consumed_total))
              : usdFromDollars(detail.actual_cost_usd)
          }
          sub={
            detail.actual_cost_usd == null ? (
              <>estimated · tokens × $0.01</>
            ) : (
              <>from provider usage</>
            )
          }
        />
        <Kpi
          label="Revenue"
          value={usd(revenueCents)}
          sub={
            <>
              {usd(revenue.token_pack_cents)} packs ·{' '}
              {usd(revenue.plan_monthly_cents)}/mo
            </>
          }
        />
      </div>

      {/* Balances + consumption */}
      <div className="cols-2 grid" style={{ marginTop: 14 }}>
        <div className="card">
          <div className="label">Token balances</div>
          <div style={{ marginTop: 10 }}>
            {balanceEntries.length === 0 ? (
              <div className="muted">No balances.</div>
            ) : (
              balanceEntries.map(([source, b]) => (
                <div className="kv" key={source}>
                  <span className="k" style={{ textTransform: 'capitalize' }}>
                    {source}
                  </span>
                  <span className="mono">
                    {num(b.balance)} tok
                    {b.expires_at && (
                      <span className="muted">
                        {' '}
                        · expires {relativeTime(b.expires_at)}
                      </span>
                    )}
                  </span>
                </div>
              ))
            )}
            <div className="kv">
              <span className="k">Lifetime refunded</span>
              <span className="mono">{num(tokens.refunded)} tok</span>
            </div>
          </div>
        </div>

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
      </div>

      {/* Manual token adjustment */}
      <div style={{ marginTop: 14 }}>
        <TokenAdjust userId={profile.user_id} />
      </div>

      {/* Recent generations */}
      <div className="section-title">Generated content</div>
      <div className="card table-card">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Conversation</th>
              <th>Prompt</th>
              <th>Status</th>
              <th>Format</th>
              <th className="right">When</th>
            </tr>
          </thead>
          <tbody>
            {generations.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  No generations yet.
                </td>
              </tr>
            ) : (
              generations.map((g) => (
                <tr key={`${g.kind}-${g.id}`}>
                  <td>
                    <span className="badge">{generationKindLabel(g.kind)}</span>
                  </td>
                  <td className="ellip">
                    <Link href={`/conversations/${g.conversation_id}`}>
                      {g.title ?? g.conversation_id}
                    </Link>
                  </td>
                  <td className="prompt-cell">
                    <PromptPreview value={g.prompt} />
                    <JsonBlock value={g.prompt} summary="Prompt JSON" />
                    {g.error && <div className="error-inline">{g.error}</div>}
                  </td>
                  <td>
                    <StatusBadge status={g.status} />
                  </td>
                  <td className="muted">{g.file_type ?? '—'}</td>
                  <td className="right muted">{relativeTime(g.created_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Conversations */}
      <div className="section-title">Conversations & prompts</div>
      <div className="card table-card">
        <table>
          <thead>
            <tr>
              <th>Conversation</th>
              <th>Latest user prompt</th>
              <th className="right">Messages</th>
              <th className="right">CAD</th>
              <th className="right">Mesh</th>
              <th className="right">Image</th>
              <th className="right">Updated</th>
            </tr>
          </thead>
          <tbody>
            {conversations.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted">
                  No conversations yet.
                </td>
              </tr>
            ) : (
              conversations.map((c) => (
                <tr key={c.id}>
                  <td className="ellip">
                    <Link href={`/conversations/${c.id}`}>{c.title}</Link>
                    <div className="muted tiny">
                      {c.type} / {c.privacy}
                    </div>
                  </td>
                  <td className="prompt-cell">
                    <PromptPreview value={c.latest_user_prompt} />
                    <JsonBlock
                      value={c.latest_user_prompt}
                      summary="Prompt JSON"
                    />
                  </td>
                  <td className="right mono">{num(c.message_count)}</td>
                  <td className="right mono">{num(c.cad_jobs)}</td>
                  <td className="right mono">{num(c.meshes)}</td>
                  <td className="right mono">{num(c.images)}</td>
                  <td className="right muted">
                    {relativeTime(c.updated_at ?? c.created_at)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Recent transactions */}
      <div className="section-title">Recent token transactions</div>
      <div className="card" style={{ padding: 6 }}>
        <table>
          <thead>
            <tr>
              <th>Operation</th>
              <th className="right">Amount</th>
              <th>Source</th>
              <th>Reference</th>
              <th className="right">When</th>
            </tr>
          </thead>
          <tbody>
            {transactions.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">
                  No transactions yet.
                </td>
              </tr>
            ) : (
              transactions.map((t) => (
                <tr key={t.id}>
                  <td>
                    <span
                      className="badge"
                      style={{ textTransform: 'capitalize' }}
                    >
                      {operationLabel(t.operation)}
                    </span>
                  </td>
                  <td className={`right mono ${t.amount < 0 ? 'down' : 'up'}`}>
                    {t.amount > 0 ? '+' : ''}
                    {num(t.amount)}
                  </td>
                  <td className="muted">{t.source}</td>
                  <td className="ellip muted">{t.reference_id ?? '—'}</td>
                  <td className="right muted">{relativeTime(t.created_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
