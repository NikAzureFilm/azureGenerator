import Link from 'next/link';
import { requireAdmin } from '@/lib/auth';
import { generationKindLabel, truncateText } from '@/lib/content';
import { fetchGenerationsPage } from '@/lib/metrics';
import { generationModelDisplay } from '@/lib/generationModels';
import { absoluteTime, num, relativeTime, usdSmall } from '@/lib/format';
import JsonBlock, { PromptPreview } from '@/app/components/JsonBlock';
import Nav from '@/app/components/Nav';
import StatusBadge from '@/app/components/StatusBadge';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const PAGE_SIZE = 50;
const KIND_OPTIONS = new Set(['all', 'cad', 'parametric', 'mesh', 'image']);
const STATUS_OPTIONS = new Set(['all', 'success', 'failure', 'pending']);

// Accepts only the YYYY-MM-DD strings produced by <input type="date">.
function parseDateParam(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return undefined;
  return Number.isNaN(new Date(`${trimmed}T00:00:00Z`).getTime())
    ? undefined
    : trimmed;
}

function generationsHref({
  q,
  kind,
  status,
  from,
  to,
  page,
}: {
  q?: string;
  kind: string;
  status: string;
  from?: string;
  to?: string;
  page: number;
}): string {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (kind !== 'all') params.set('kind', kind);
  if (status !== 'all') params.set('status', status);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `/generations?${qs}` : '/generations';
}

export default async function GenerationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const admin = await requireAdmin();
  const sp = await searchParams;
  const q = sp.q?.trim() || undefined;
  const kind =
    sp.kind && KIND_OPTIONS.has(sp.kind.toLowerCase())
      ? sp.kind.toLowerCase()
      : 'all';
  const status =
    sp.status && STATUS_OPTIONS.has(sp.status.toLowerCase())
      ? sp.status.toLowerCase()
      : 'all';
  const fromDate = parseDateParam(sp.from);
  const toDate = parseDateParam(sp.to);
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);

  const { rows, total } = await fetchGenerationsPage({
    search: q ?? null,
    kind: kind === 'all' ? null : kind,
    status: status === 'all' ? null : status,
    // Calendar dates become inclusive UTC day bounds (timestamps in the
    // table are timestamptz; the dashboard reports in UTC throughout).
    from: fromDate ? `${fromDate}T00:00:00.000Z` : null,
    to: toDate ? `${toDate}T23:59:59.999Z` : null,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(total, page * PAGE_SIZE);

  return (
    <div className="wrap wide">
      <Nav active="generations" email={admin.email} />

      <div className="section-title">Generated content</div>

      <form className="searchbar" method="get" action="/generations">
        <input
          type="text"
          name="q"
          placeholder="Search users, conversations, prompts, ids..."
          defaultValue={q ?? ''}
        />
        <select className="select" name="kind" defaultValue={kind}>
          <option value="all">All types</option>
          <option value="cad">CAD</option>
          <option value="parametric">Parametric</option>
          <option value="mesh">Mesh</option>
          <option value="image">Image</option>
        </select>
        <select className="select" name="status" defaultValue={status}>
          <option value="all">All statuses</option>
          <option value="success">Success</option>
          <option value="failure">Failure</option>
          <option value="pending">Pending</option>
        </select>
        <input
          type="date"
          name="from"
          defaultValue={fromDate ?? ''}
          title="From date (UTC, inclusive)"
          aria-label="From date"
        />
        <input
          type="date"
          name="to"
          defaultValue={toDate ?? ''}
          title="To date (UTC, inclusive)"
          aria-label="To date"
        />
        <button className="btn" type="submit">
          Search
        </button>
        {(q || kind !== 'all' || status !== 'all' || fromDate || toDate) && (
          <Link className="btn" href="/generations">
            Clear
          </Link>
        )}
      </form>

      <div className="card table-card">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Model</th>
              <th>User</th>
              <th>Conversation</th>
              <th>Prompt</th>
              <th>Status</th>
              <th>Format</th>
              <th className="right">Cost</th>
              <th className="right">Tokens</th>
              <th className="right">When</th>
              <th className="right">Output</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={11} className="muted">
                  No generated content matches.
                </td>
              </tr>
            ) : (
              rows.map((g) => {
                const modelDisplay = generationModelDisplay(g);
                return (
                  <tr key={`${g.kind}-${g.id}`}>
                    <td>
                      <span className="badge">
                        {generationKindLabel(g.kind)}
                      </span>
                    </td>
                    <td className="ellip" title={modelDisplay?.id}>
                      {modelDisplay ? (
                        <>
                          <div>{modelDisplay.tier}</div>
                          <div className="muted tiny">{modelDisplay.name}</div>
                        </>
                      ) : (
                        <span className="muted">-</span>
                      )}
                    </td>
                    <td className="ellip">
                      <Link href={`/users/${g.user_id}`}>
                        {g.email ?? g.user_id}
                      </Link>
                    </td>
                    <td className="ellip">
                      <Link href={`/conversations/${g.conversation_id}`}>
                        {g.conversation_title ?? g.conversation_id}
                      </Link>
                      {g.conversation_type && (
                        <div className="muted tiny">{g.conversation_type}</div>
                      )}
                    </td>
                    <td className="prompt-cell">
                      <div className="prompt-wrap">
                        {g.kind === 'image' && g.status === 'success' && (
                          <Link
                            className="thumb-link"
                            href={`/generations/${g.kind}/${g.id}`}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              className="gen-thumb"
                              src={`/api/generations/image/${g.id}/asset?type=image`}
                              alt=""
                              loading="lazy"
                            />
                          </Link>
                        )}
                        <div className="prompt-body">
                          <PromptPreview value={g.prompt} />
                          <JsonBlock value={g.prompt} summary="Prompt JSON" />
                          {g.error && (
                            <div className="error-inline">
                              {truncateText(g.error, 200)}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={g.status} />
                    </td>
                    <td className="muted">
                      {g.file_type ?? (g.kind === 'image' ? 'png' : '-')}
                    </td>
                    <td className="right mono">
                      {g.actual_cost_usd == null
                        ? '-'
                        : usdSmall(g.actual_cost_usd)}
                    </td>
                    <td className="right mono">
                      {g.tokens_used == null ? '-' : num(g.tokens_used)}
                    </td>
                    <td
                      className="right muted"
                      title={absoluteTime(g.created_at)}
                    >
                      {relativeTime(g.created_at)}
                    </td>
                    <td className="right">
                      <Link
                        className="view-link"
                        href={`/generations/${g.kind}/${g.id}`}
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="pager">
        {page > 1 ? (
          <Link
            href={generationsHref({
              q,
              kind,
              status,
              from: fromDate,
              to: toDate,
              page: page - 1,
            })}
          >
            Prev
          </Link>
        ) : (
          <span className="disabled">Prev</span>
        )}
        <span className="current">
          Page {num(page)} of {num(pageCount)}
        </span>
        {page < pageCount ? (
          <Link
            href={generationsHref({
              q,
              kind,
              status,
              from: fromDate,
              to: toDate,
              page: page + 1,
            })}
          >
            Next
          </Link>
        ) : (
          <span className="disabled">Next</span>
        )}
        <span className="meta">
          Showing {num(from)}-{num(to)} of {num(total)}
        </span>
      </div>
    </div>
  );
}
