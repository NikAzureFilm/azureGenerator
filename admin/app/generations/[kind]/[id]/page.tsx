import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/auth';
import { generationKindLabel } from '@/lib/content';
import {
  fetchCadSourceCode,
  fetchGenerationDetail,
  isGenerationKind,
  pickViewerAsset,
} from '@/lib/generations';
import { relativeTime } from '@/lib/format';
import JsonBlock, { PromptPreview } from '@/app/components/JsonBlock';
import ModelViewer from '@/app/components/ModelViewer';
import Nav from '@/app/components/Nav';
import StatusBadge from '@/app/components/StatusBadge';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function assetUrl(
  kind: string,
  id: string,
  type: string,
  download = false,
): string {
  return `/api/generations/${kind}/${id}/asset?type=${encodeURIComponent(type)}${
    download ? '&download=1' : ''
  }`;
}

export default async function GenerationDetailPage({
  params,
}: {
  params: Promise<{ kind: string; id: string }>;
}) {
  const admin = await requireAdmin();
  const { kind, id } = await params;
  if (!isGenerationKind(kind)) notFound();

  const detail = await fetchGenerationDetail(kind, id);
  if (!detail) notFound();

  const viewerAsset = pickViewerAsset(detail);
  const sourceCode = await fetchCadSourceCode(detail);
  const succeeded = detail.status === 'success';

  return (
    <div className="wrap wide">
      <Nav active="generations" email={admin.email} />

      <div className="sub back-links">
        <Link href="/generations">Generations</Link>
        <span>/</span>
        <Link href={`/conversations/${detail.conversation_id}`}>
          Conversation
        </Link>
        <span>/</span>
        <Link href={`/users/${detail.user_id}`}>User</Link>
      </div>

      <div className="card">
        <div className="detail-head">
          <div>
            <div className="value detail-title">
              {generationKindLabel(detail.kind)} generation
              {detail.file_type ? ` (${detail.file_type})` : ''}
            </div>
            <div className="sub">
              <Link href={`/users/${detail.user_id}`}>
                {detail.email ?? detail.user_id}
              </Link>{' '}
              -{' '}
              <Link href={`/conversations/${detail.conversation_id}`}>
                {detail.conversation_title ?? detail.conversation_id}
              </Link>
              {detail.conversation_type && ` - ${detail.conversation_type}`}
            </div>
            <div className="sub mono tiny">{detail.id}</div>
          </div>
          <div className="sub right">
            <div>
              <StatusBadge status={detail.status} />
            </div>
            <div style={{ marginTop: 8 }}>
              Created {relativeTime(detail.created_at)}
            </div>
            {detail.updated_at && (
              <div>Updated {relativeTime(detail.updated_at)}</div>
            )}
          </div>
        </div>
        {detail.error && <div className="error-inline">{detail.error}</div>}
      </div>

      <div className="section-title">Output</div>
      {viewerAsset ? (
        <div className="card viewer-card">
          <ModelViewer
            src={assetUrl(detail.kind, detail.id, viewerAsset.type)}
            format={viewerAsset.format}
          />
        </div>
      ) : detail.kind === 'image' && succeeded ? (
        <div className="card viewer-card image-card">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="image-preview"
            src={assetUrl(detail.kind, detail.id, 'image')}
            alt="Generated output"
          />
        </div>
      ) : (
        <div className="card muted">
          {!succeeded
            ? detail.status === 'pending'
              ? 'Generation is still pending - no output yet.'
              : 'Generation failed - no output was produced.'
            : detail.assets.length > 0
              ? 'This output format cannot be previewed in the browser. Download it below.'
              : 'No output files recorded for this generation.'}
        </div>
      )}

      <div className="section-title">Downloads</div>
      <div className="card">
        {succeeded && detail.assets.length > 0 ? (
          <div className="download-row">
            {detail.assets.map((asset) => (
              <a
                key={asset.type}
                className="btn"
                href={assetUrl(detail.kind, detail.id, asset.type, true)}
                download
              >
                {asset.label}
                <span className="muted"> .{asset.format}</span>
              </a>
            ))}
          </div>
        ) : (
          <span className="muted">
            {succeeded
              ? 'No files recorded for this generation.'
              : 'Downloads become available once the generation succeeds.'}
          </span>
        )}
      </div>

      {detail.kind === 'cad' && (
        <>
          <div className="section-title">Generated code</div>
          <div className="card">
            {sourceCode ? (
              <pre className="code-block">{sourceCode}</pre>
            ) : (
              <span className="muted">
                {detail.artifacts?.sourcePath
                  ? 'Source file could not be fetched - try the download above.'
                  : 'No source code was recorded for this CAD job.'}
              </span>
            )}
          </div>
        </>
      )}

      <div className="section-title">Prompt</div>
      <div className="card">
        <PromptPreview value={detail.prompt} />
        <JsonBlock value={detail.prompt} summary="Prompt JSON" />
      </div>
    </div>
  );
}
