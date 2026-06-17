import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/auth';
import { generationKindLabel } from '@/lib/content';
import { fetchConversationDetail } from '@/lib/metrics';
import { num, relativeTime } from '@/lib/format';
import JsonBlock, { PromptPreview } from '@/app/components/JsonBlock';
import Nav from '@/app/components/Nav';
import StatusBadge from '@/app/components/StatusBadge';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const admin = await requireAdmin();
  const { id } = await params;
  const detail = await fetchConversationDetail(id);

  if (!detail?.conversation) notFound();

  const { conversation, messages, generations } = detail;
  const generationRows = [
    ...generations.cad_jobs,
    ...generations.meshes,
    ...generations.images,
  ].sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  return (
    <div className="wrap wide">
      <Nav active="generations" email={admin.email} />

      <div className="sub back-links">
        <Link href="/generations">Generations</Link>
        <span>/</span>
        <Link href={`/users/${conversation.user_id}`}>User</Link>
      </div>

      <div className="card">
        <div className="detail-head">
          <div>
            <div className="value detail-title">{conversation.title}</div>
            <div className="sub">
              {conversation.user_email ?? conversation.user_id} -{' '}
              {conversation.type} - {conversation.privacy}
            </div>
          </div>
          <div className="sub right">
            <div>Created {relativeTime(conversation.created_at ?? '')}</div>
            {conversation.updated_at && (
              <div>Updated {relativeTime(conversation.updated_at)}</div>
            )}
          </div>
        </div>
      </div>

      <div className="kpi grid" style={{ marginTop: 14 }}>
        <div className="card">
          <div className="label">Messages</div>
          <div className="value mono">{num(messages.length)}</div>
        </div>
        <div className="card">
          <div className="label">CAD jobs</div>
          <div className="value mono">{num(generations.cad_jobs.length)}</div>
        </div>
        <div className="card">
          <div className="label">Meshes</div>
          <div className="value mono">{num(generations.meshes.length)}</div>
        </div>
        <div className="card">
          <div className="label">Images</div>
          <div className="value mono">{num(generations.images.length)}</div>
        </div>
      </div>

      <div className="section-title">Conversation</div>
      <div className="message-list">
        {messages.length === 0 ? (
          <div className="card muted">No messages in this conversation.</div>
        ) : (
          messages.map((message) => (
            <article className="message-card" key={message.id}>
              <div className="message-meta">
                <span className="badge">{message.role}</span>
                <span>{relativeTime(message.created_at)}</span>
                {message.rating !== 0 && <span>rating {message.rating}</span>}
              </div>
              <div className="message-preview">
                <PromptPreview value={message.content} />
              </div>
              <JsonBlock value={message.content} summary="Message JSON" />
            </article>
          ))
        )}
      </div>

      <div className="section-title">Generation prompts</div>
      <div className="card table-card">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Prompt</th>
              <th>Status</th>
              <th>Format</th>
              <th className="right">When</th>
            </tr>
          </thead>
          <tbody>
            {generationRows.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">
                  No generation records for this conversation.
                </td>
              </tr>
            ) : (
              generationRows.map((g) => (
                <tr key={`${g.kind}-${g.id}`}>
                  <td>
                    <span className="badge">{generationKindLabel(g.kind)}</span>
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
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
