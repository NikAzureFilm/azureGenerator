import Link from 'next/link';
import { requireAdmin } from '@/lib/auth';
import { fetchUsersPage } from '@/lib/metrics';
import { PLAN_DISPLAY } from '@/lib/pricing';
import { usd, usdFromDollars, num, relativeTime } from '@/lib/format';
import Nav from '@/app/components/Nav';
import { usersHref, sortHref, type UsersQuery } from '@/lib/searchParams';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const PAGE_SIZE = 50;

const SORT_COLS = new Set([
  'email',
  'full_name',
  'plan',
  'created_at',
  'last_active',
  'generations',
  'tokens_consumed',
  'est_cost_usd',
  'actual_cost_usd',
  'revenue_cents',
]);

// Sortable column header: anchor that toggles order and shows a direction arrow.
function SortTh({
  col,
  label,
  query,
  right,
}: {
  col: string;
  label: string;
  query: UsersQuery;
  right?: boolean;
}) {
  const active = query.sort === col;
  const arrow = active ? (query.order === 'asc' ? '▲' : '▼') : '';
  return (
    <th className={right ? 'right' : undefined}>
      <Link href={sortHref(query, col)}>
        {label}
        {arrow && <span className="arrow">{arrow}</span>}
      </Link>
    </th>
  );
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const admin = await requireAdmin();
  const sp = await searchParams;

  const q = sp.q?.trim() || undefined;
  const sort = sp.sort && SORT_COLS.has(sp.sort) ? sp.sort : 'last_active';
  const order: 'asc' | 'desc' = sp.order === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);

  const query: UsersQuery = { q, sort, order, page };

  const { rows, total } = await fetchUsersPage({
    search: q ?? null,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    sort,
    order,
  });

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(total, page * PAGE_SIZE);

  return (
    <div className="wrap">
      <Nav active="users" email={admin.email} />

      <div className="section-title">Users</div>

      <form className="searchbar" method="get" action="/users">
        <input
          type="text"
          name="q"
          placeholder="Search by email or name…"
          defaultValue={q ?? ''}
        />
        {/* Preserve sort/order across a new search; reset to page 1. */}
        <input type="hidden" name="sort" value={sort} />
        <input type="hidden" name="order" value={order} />
        <button className="btn" type="submit">
          Search
        </button>
        {q && (
          <Link
            className="btn"
            href={usersHref(query, { q: undefined, page: 1 })}
          >
            Clear
          </Link>
        )}
      </form>

      <div className="card" style={{ padding: 6 }}>
        <table>
          <thead>
            <tr>
              <SortTh col="email" label="User" query={query} />
              <SortTh col="plan" label="Plan" query={query} />
              <th>Status</th>
              <SortTh col="created_at" label="Signed up" query={query} right />
              <SortTh
                col="last_active"
                label="Last active"
                query={query}
                right
              />
              <SortTh col="generations" label="Gens" query={query} right />
              <SortTh
                col="tokens_consumed"
                label="Tokens"
                query={query}
                right
              />
              <SortTh
                col="est_cost_usd"
                label="Est. cost"
                query={query}
                right
              />
              <SortTh
                col="actual_cost_usd"
                label="Actual cost"
                query={query}
                right
              />
              <SortTh col="revenue_cents" label="Revenue" query={query} right />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="muted">
                  No users match.
                </td>
              </tr>
            ) : (
              rows.map((u) => (
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
                  <td className="muted">{u.sub_status ?? '—'}</td>
                  <td className="right muted">{relativeTime(u.created_at)}</td>
                  <td className="right muted">{relativeTime(u.last_active)}</td>
                  <td className="right mono">{num(u.generations)}</td>
                  <td className="right mono">{num(u.tokens_consumed)}</td>
                  <td className="right mono muted">
                    {usdFromDollars(u.est_cost_usd)}
                  </td>
                  <td className="right mono muted">
                    {u.actual_cost_usd == null
                      ? '—'
                      : usdFromDollars(u.actual_cost_usd)}
                  </td>
                  <td className="right mono">{usd(u.revenue_cents)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="pager">
        {page > 1 ? (
          <Link href={usersHref(query, { page: page - 1 })}>← Prev</Link>
        ) : (
          <span className="disabled">← Prev</span>
        )}
        <span className="current">
          Page {num(page)} of {num(pageCount)}
        </span>
        {page < pageCount ? (
          <Link href={usersHref(query, { page: page + 1 })}>Next →</Link>
        ) : (
          <span className="disabled">Next →</span>
        )}
        <span className="meta">
          Showing {num(from)}–{num(to)} of {num(total)}
        </span>
      </div>
    </div>
  );
}
