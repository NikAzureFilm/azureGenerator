import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/auth';
import {
  generationKindLabel,
  parseWorkerError,
  truncateText,
} from '@/lib/content';
import { generationModelDisplay } from '@/lib/generationModels';
import { formatGenerationMargin } from '@/lib/generationCosts';
import {
  fetchCadSourceCode,
  fetchGenerationDetail,
  isGenerationKind,
  pickViewerAsset,
} from '@/lib/generations';
import { fetchGenerationUsage } from '@/lib/metrics';
import { absoluteTime, num, relativeTime, usdSmall } from '@/lib/format';
import JsonBlock, { PromptPreview } from '@/app/components/JsonBlock';
import ModelViewer from '@/app/components/ModelViewer';
import Nav from '@/app/components/Nav';
import OpenScadViewer from '@/app/components/OpenScadViewer';
import StatusBadge from '@/app/components/StatusBadge';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function formatParamValue(value: unknown): string {
  if (value == null) return '-';
  if (Array.isArray(value)) return `[${value.join(', ')}]`;
  return String(value);
}

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
  // Provider usage is matched on provider_usage.reference_id, which the edge
  // functions populate with the generation id (and the message id for chats).
  const [sourceCode, usage] = await Promise.all([
    fetchCadSourceCode(detail),
    fetchGenerationUsage([detail.id, detail.message_id]),
  ]);
  const succeeded = detail.status === 'success';
  const workerError = detail.error ? parseWorkerError(detail.error) : null;
  const modelDisplay = generationModelDisplay(detail);
  const usageCostUsd = (usage ?? []).reduce(
    (sum, row) => sum + row.cost_usd,
    0,
  );
  // AI cost vs the internal budget implied by the tokens charged for the tier.
  const hasUsage = usage != null && usage.length > 0;
  const aiMargin = hasUsage
    ? formatGenerationMargin(usageCostUsd, modelDisplay?.tokens ?? null)
    : null;

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
              {detail.parametric
                ? detail.parametric.title
                : `${generationKindLabel(detail.kind)} generation${
                    detail.file_type ? ` (${detail.file_type})` : ''
                  }`}
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
            {modelDisplay && (
              <div className="sub">
                Model {modelDisplay.tier} - {modelDisplay.name}{' '}
                <span className="mono tiny">({modelDisplay.id})</span>
              </div>
            )}
            <div className="sub">
              AI cost{' '}
              {aiMargin == null ? (
                <span className="muted">—</span>
              ) : (
                <span className={aiMargin.overBudget ? 'down' : undefined}>
                  <span className="mono">{aiMargin.costText}</span>
                  <span className="muted"> / {aiMargin.budgetText}</span>
                </span>
              )}
            </div>
          </div>
          <div className="sub right">
            <div>
              <StatusBadge status={detail.status} />
            </div>
            <div style={{ marginTop: 8 }}>
              Created {relativeTime(detail.created_at)} (
              {absoluteTime(detail.created_at)})
            </div>
            {detail.updated_at && (
              <div>
                Updated {relativeTime(detail.updated_at)} (
                {absoluteTime(detail.updated_at)})
              </div>
            )}
          </div>
        </div>
        {workerError && (
          <div className="error-inline">
            {truncateText(workerError.message, 240)}
          </div>
        )}
      </div>

      {workerError && (
        <>
          <div className="section-title">Failure details</div>
          <div className="card">
            <pre className="code-block">{workerError.message}</pre>
            {workerError.traceback && (
              <details className="json-details">
                <summary>Worker traceback</summary>
                <pre className="code-block">{workerError.traceback}</pre>
              </details>
            )}
          </div>
        </>
      )}

      <div className="section-title">Output</div>
      {detail.parametric ? (
        <div className="card viewer-card">
          <OpenScadViewer
            code={detail.parametric.code}
            parameters={detail.parametric.parameters}
          />
        </div>
      ) : viewerAsset ? (
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

      {detail.parametric && detail.parametric.parameters.length > 0 && (
        <>
          <div className="section-title">Parameters</div>
          <div className="card table-card">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Group</th>
                  <th>Type</th>
                  <th>Value</th>
                  <th>Default</th>
                </tr>
              </thead>
              <tbody>
                {detail.parametric.parameters.map((p, i) => (
                  <tr key={`${p.name}-${i}`}>
                    <td>
                      {p.displayName || p.name}
                      {p.description && (
                        <div className="muted tiny">{p.description}</div>
                      )}
                    </td>
                    <td className="muted">{p.group ?? '-'}</td>
                    <td className="muted">{p.type ?? '-'}</td>
                    <td className="mono">{formatParamValue(p.value)}</td>
                    <td className="mono muted">
                      {formatParamValue(p.defaultValue)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

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

      {detail.parametric && (
        <>
          <div className="section-title">
            OpenSCAD code
            {detail.parametric.version
              ? ` (v${detail.parametric.version})`
              : ''}
          </div>
          <div className="card">
            <pre className="code-block">{detail.parametric.code}</pre>
          </div>
        </>
      )}

      <div className="section-title">Prompt</div>
      <div className="card">
        <PromptPreview value={detail.prompt} />
        <JsonBlock value={detail.prompt} summary="Prompt JSON" />
      </div>

      <div className="section-title">Provider usage</div>
      {usage === null ? (
        <div className="card muted">
          Provider usage could not be loaded for this generation.
        </div>
      ) : usage.length === 0 ? (
        <div className="card muted">
          No provider usage rows reference this generation (older rows predate
          per-generation cost logging).
        </div>
      ) : (
        <>
          <div className="card table-card">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Operation</th>
                  <th>Provider</th>
                  <th>Model</th>
                  <th className="right">In tok</th>
                  <th className="right">Out tok</th>
                  <th className="right">Cached</th>
                  <th className="right">Cost</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((row) => (
                  <tr key={row.id}>
                    <td className="muted" title={absoluteTime(row.created_at)}>
                      {relativeTime(row.created_at)}
                    </td>
                    <td>
                      {row.operation}
                      {row.function_name && (
                        <div className="muted tiny">{row.function_name}</div>
                      )}
                    </td>
                    <td className="muted">{row.provider}</td>
                    <td className="mono">{row.model}</td>
                    <td className="right mono">
                      {row.input_tokens == null ? '-' : num(row.input_tokens)}
                    </td>
                    <td className="right mono">
                      {row.output_tokens == null ? '-' : num(row.output_tokens)}
                    </td>
                    <td className="right mono">
                      {row.cached_input_tokens == null
                        ? '-'
                        : num(row.cached_input_tokens)}
                    </td>
                    <td className="right mono">{usdSmall(row.cost_usd)}</td>
                    <td>
                      <StatusBadge status={row.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="sub" style={{ marginTop: 8 }}>
            {usage.length} provider call{usage.length === 1 ? '' : 's'} ·{' '}
            {usdSmall(usageCostUsd)} total · matched by reference id
          </div>
        </>
      )}
    </div>
  );
}
