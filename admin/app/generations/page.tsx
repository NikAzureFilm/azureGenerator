import Link from 'next/link';
import { requireAdmin } from '@/lib/auth';
import { generationKindLabel } from '@/lib/content';
import { fetchGenerationsPage } from '@/lib/metrics';
import { num, relativeTime } from '@/lib/format';
import JsonBlock, { PromptPreview } from '@/app/components/JsonBlock';
import Nav from '@/app/components/Nav';
import StatusBadge from '@/app/components/StatusBadge';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const PAGE_SIZE = 50;
const KIND_OPTIONS = new Set(['all', 'cad', 'mesh', 'image']);

function generationsHref({
  q,
  kind,
  page,
}: {
  q?: string;
  kind: string;
  page: number;
}): string {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (kind !== 'all') params.set('kind', kind);
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
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);

  const { rows, total } = await fetchGenerationsPage({
    search: q ?? null,
    kind: kind === 'all' ? null : kind,
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
          <option value="mesh">Mesh</option>
          <option value="image">Image</option>
        </select>
        <button className="btn" type="submit">
          Search
        </button>
        {(q || kind !== 'all') && (
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
              <th>User</th>
              <th>Conversation</th>
              <th>Prompt</th>
              <th>Status</th>
              <th>Format</th>
              <th className="right">When</th>
              <th className="right">Output</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="muted">
                  No generated content matches.
                </td>
              </tr>
            ) : (
              rows.map((g) => (
                <tr key={`${g.kind}-${g.id}`}>
                  <td>
                    <span className="badge">{generationKindLabel(g.kind)}</span>
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
                    <PromptPreview value={g.prompt} />
                    <JsonBlock value={g.prompt} summary="Prompt JSON" />
                    {g.error && <div className="error-inline">{g.error}</div>}
                  </td>
                  <td>
                    <StatusBadge status={g.status} />
                  </td>
                  <td className="muted">{g.file_type ?? '-'}</td>
                  <td className="right muted">{relativeTime(g.created_at)}</td>
                  <td className="right">
                    <Link
                      className="view-link"
                      href={`/generations/${g.kind}/${g.id}`}
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="pager">
        {page > 1 ? (
          <Link href={generationsHref({ q, kind, page: page - 1 })}>Prev</Link>
        ) : (
          <span className="disabled">Prev</span>
        )}
        <span className="current">
          Page {num(page)} of {num(pageCount)}
        </span>
        {page < pageCount ? (
          <Link href={generationsHref({ q, kind, page: page + 1 })}>Next</Link>
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
