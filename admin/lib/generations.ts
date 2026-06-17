import 'server-only';
import { getAdminClient } from './supabaseAdmin';

// ===========================================================================
// Single-generation detail fetchers + asset resolution for the admin viewer.
//
// Storage layout (written by the app / workers):
//   meshes bucket:  {user_id}/{conversation_id}/{mesh_id}.{file_type}
//   images bucket:  {user_id}/{conversation_id}/{image_id}
//   cad_jobs.artifacts: absolute URLs on the text-to-CAD worker, or
//                       (older deployments) paths inside the cad-artifacts
//                       bucket: stepPath / glbPath / stlPath / threeMfPath /
//                       sourcePath
// ===========================================================================

export type GenerationKind = 'cad' | 'parametric' | 'mesh' | 'image';

export const GENERATION_KINDS: GenerationKind[] = [
  'cad',
  'parametric',
  'mesh',
  'image',
];

export function isGenerationKind(value: string): value is GenerationKind {
  return (GENERATION_KINDS as string[]).includes(value);
}

export type CadArtifacts = {
  stepPath?: string;
  glbPath?: string;
  stlPath?: string;
  threeMfPath?: string;
  sourcePath?: string;
};

// OpenSCAD artifact embedded in an assistant message (parametric mode).
export type ParametricParameter = {
  name: string;
  displayName?: string;
  value: unknown;
  defaultValue?: unknown;
  type?: string;
  description?: string;
  group?: string;
};

export type ParametricArtifact = {
  title: string;
  version: string | null;
  code: string;
  parameters: ParametricParameter[];
};

// One downloadable/viewable file attached to a generation. `type` is the
// `?type=` value understood by the asset API route.
export type GenerationAsset = {
  type: string;
  label: string;
  format: string;
  viewable: boolean;
};

export type GenerationDetail = {
  kind: GenerationKind;
  id: string;
  status: string;
  created_at: string;
  updated_at: string | null;
  user_id: string;
  email: string | null;
  conversation_id: string;
  conversation_title: string | null;
  conversation_type: string | null;
  prompt: unknown;
  error: string | null;
  file_type: string | null;
  message_id: string | null;
  artifacts: CadArtifacts | null;
  parametric: ParametricArtifact | null;
  assets: GenerationAsset[];
};

type JoinedConversation =
  | { title?: string | null; type?: string | null }
  | { title?: string | null; type?: string | null }[]
  | null;

function joinedConversation(value: JoinedConversation) {
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

// Formats the in-browser viewer can render with three.js loaders.
const VIEWABLE_FORMATS = new Set(['glb', 'stl', 'obj', 'fbx', '3mf']);

export function isViewableFormat(format: string | null | undefined): boolean {
  return !!format && VIEWABLE_FORMATS.has(format.toLowerCase());
}

const CAD_ARTIFACT_ASSETS: Array<{
  key: keyof CadArtifacts;
  type: string;
  label: string;
  format: string;
}> = [
  { key: 'glbPath', type: 'glb', label: 'GLB model', format: 'glb' },
  { key: 'stlPath', type: 'stl', label: 'STL model', format: 'stl' },
  { key: 'threeMfPath', type: '3mf', label: '3MF model', format: '3mf' },
  { key: 'stepPath', type: 'step', label: 'STEP model', format: 'step' },
  { key: 'sourcePath', type: 'source', label: 'Source code', format: 'py' },
];

export function asCadArtifacts(value: unknown): CadArtifacts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const artifacts: CadArtifacts = {};
  for (const { key } of CAD_ARTIFACT_ASSETS) {
    const entry = record[key];
    if (typeof entry === 'string' && entry.trim()) artifacts[key] = entry;
  }
  return artifacts;
}

function cadAssets(artifacts: CadArtifacts): GenerationAsset[] {
  return CAD_ARTIFACT_ASSETS.filter(({ key }) => artifacts[key]).map(
    ({ type, label, format }) => ({
      type,
      label,
      format,
      viewable: isViewableFormat(format),
    }),
  );
}

// The artifact the 3D viewer should load, in order of preference.
export function pickViewerAsset(
  detail: GenerationDetail,
): GenerationAsset | null {
  if (detail.status !== 'success') return null;
  const viewable = detail.assets.filter((asset) => asset.viewable);
  if (viewable.length === 0) return null;
  const order = ['glb', 'stl', '3mf', 'obj', 'fbx'];
  viewable.sort(
    (a, b) =>
      order.indexOf(a.format.toLowerCase()) -
      order.indexOf(b.format.toLowerCase()),
  );
  return viewable[0];
}

async function fetchEmail(userId: string): Promise<string | null> {
  const supa = getAdminClient();
  const { data, error } = await supa.auth.admin.getUserById(userId);
  if (error) return null;
  return data.user?.email ?? null;
}

export async function fetchGenerationDetail(
  kind: GenerationKind,
  id: string,
): Promise<GenerationDetail | null> {
  const supa = getAdminClient();

  if (kind === 'cad') {
    const { data, error } = await supa
      .from('cad_jobs')
      .select(
        'id,status,created_at,updated_at,user_id,conversation_id,prompt,message_id,error,artifacts,conversations(title,type)',
      )
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`cad_jobs detail: ${error.message}`);
    if (!data) return null;
    const row = data as Record<string, unknown>;
    const conversation = joinedConversation(
      row.conversations as JoinedConversation,
    );
    const artifacts = asCadArtifacts(row.artifacts);
    return {
      kind: 'cad',
      id: row.id as string,
      status: row.status as string,
      created_at: row.created_at as string,
      updated_at: (row.updated_at as string | null) ?? null,
      user_id: row.user_id as string,
      email: await fetchEmail(row.user_id as string),
      conversation_id: row.conversation_id as string,
      conversation_title: conversation?.title ?? null,
      conversation_type: conversation?.type ?? null,
      prompt: row.prompt,
      error: (row.error as string | null) ?? null,
      file_type: null,
      message_id: (row.message_id as string | null) ?? null,
      artifacts,
      parametric: null,
      assets: cadAssets(artifacts),
    };
  }

  if (kind === 'parametric') {
    const { data, error } = await supa
      .from('messages')
      .select(
        'id,created_at,conversation_id,content,conversations!inner(title,type,user_id)',
      )
      .eq('id', id)
      .eq('role', 'assistant')
      .maybeSingle();
    if (error) throw new Error(`parametric detail: ${error.message}`);
    if (!data) return null;
    const row = data as Record<string, unknown>;
    const conversation = joinedConversation(
      row.conversations as JoinedConversation,
    ) as {
      title?: string | null;
      type?: string | null;
      user_id?: string;
    } | null;
    const content = (row.content ?? {}) as Record<string, unknown>;
    const artifact = content.artifact as Record<string, unknown> | undefined;
    if (!artifact || typeof artifact.code !== 'string') return null;
    const userId = conversation?.user_id ?? '';
    const parametric: ParametricArtifact = {
      title:
        typeof artifact.title === 'string' && artifact.title.trim()
          ? artifact.title
          : 'OpenSCAD model',
      version: typeof artifact.version === 'string' ? artifact.version : null,
      code: artifact.code,
      parameters: Array.isArray(artifact.parameters)
        ? (artifact.parameters as ParametricParameter[])
        : [],
    };
    return {
      kind: 'parametric',
      id: row.id as string,
      status: 'success',
      created_at: row.created_at as string,
      updated_at: null,
      user_id: userId,
      email: userId ? await fetchEmail(userId) : null,
      conversation_id: row.conversation_id as string,
      conversation_title: conversation?.title ?? null,
      conversation_type: conversation?.type ?? null,
      prompt: {
        text: typeof content.text === 'string' ? content.text : undefined,
        model: typeof content.model === 'string' ? content.model : undefined,
      },
      error: null,
      file_type: 'scad',
      message_id: row.id as string,
      artifacts: null,
      parametric,
      assets: [
        {
          type: 'scad',
          label: 'OpenSCAD source',
          format: 'scad',
          viewable: false,
        },
      ],
    };
  }

  if (kind === 'mesh') {
    const { data, error } = await supa
      .from('meshes')
      .select(
        'id,status,created_at,user_id,conversation_id,prompt,file_type,conversations(title,type)',
      )
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`meshes detail: ${error.message}`);
    if (!data) return null;
    const row = data as Record<string, unknown>;
    const conversation = joinedConversation(
      row.conversations as JoinedConversation,
    );
    const fileType = ((row.file_type as string | null) ?? 'glb').toLowerCase();
    return {
      kind: 'mesh',
      id: row.id as string,
      status: row.status as string,
      created_at: row.created_at as string,
      updated_at: null,
      user_id: row.user_id as string,
      email: await fetchEmail(row.user_id as string),
      conversation_id: row.conversation_id as string,
      conversation_title: conversation?.title ?? null,
      conversation_type: conversation?.type ?? null,
      prompt: row.prompt,
      error: null,
      file_type: fileType,
      message_id: null,
      artifacts: null,
      parametric: null,
      assets: [
        {
          type: 'model',
          label: `${fileType.toUpperCase()} mesh`,
          format: fileType,
          viewable: isViewableFormat(fileType),
        },
      ],
    };
  }

  const { data, error } = await supa
    .from('images')
    .select(
      'id,status,created_at,user_id,conversation_id,prompt,conversations(title,type)',
    )
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`images detail: ${error.message}`);
  if (!data) return null;
  const row = data as Record<string, unknown>;
  const conversation = joinedConversation(
    row.conversations as JoinedConversation,
  );
  return {
    kind: 'image',
    id: row.id as string,
    status: row.status as string,
    created_at: row.created_at as string,
    updated_at: null,
    user_id: row.user_id as string,
    email: await fetchEmail(row.user_id as string),
    conversation_id: row.conversation_id as string,
    conversation_title: conversation?.title ?? null,
    conversation_type: conversation?.type ?? null,
    prompt: row.prompt,
    error: null,
    file_type: null,
    message_id: null,
    artifacts: null,
    parametric: null,
    assets: [{ type: 'image', label: 'Image', format: 'png', viewable: false }],
  };
}

// ---------------------------------------------------------------------------
// Asset content resolution (used by the API route).
// ---------------------------------------------------------------------------

// Storage-backed assets resolve to a short-lived signed URL (the bytes never
// pass through the Next.js function — important for multi-MB meshes on
// Vercel). Worker-hosted CAD artifacts are proxied so we can control the
// Content-Disposition header; they are small (STEP/STL/source of parametric
// parts).
export type ResolvedAsset =
  | { kind: 'redirect'; url: string }
  | {
      kind: 'stream';
      body: Blob | ReadableStream<Uint8Array>;
      contentType: string;
      filename: string;
    };

const CONTENT_TYPES: Record<string, string> = {
  glb: 'model/gltf-binary',
  stl: 'model/stl',
  obj: 'model/obj',
  fbx: 'application/octet-stream',
  step: 'model/step',
  '3mf': 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
  py: 'text/plain; charset=utf-8',
  scad: 'text/plain; charset=utf-8',
  png: 'image/png',
};

function contentTypeFor(format: string): string {
  return CONTENT_TYPES[format.toLowerCase()] ?? 'application/octet-stream';
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'model';
}

async function signedBucketUrl(
  bucket: string,
  path: string,
  downloadAs: string | false,
): Promise<ResolvedAsset | null> {
  const supa = getAdminClient();
  const { data, error } = await supa.storage
    .from(bucket)
    .createSignedUrl(path, 60 * 10, downloadAs ? { download: downloadAs } : {});
  if (error || !data?.signedUrl) return null;
  return { kind: 'redirect', url: data.signedUrl };
}

// CAD artifact values are absolute worker URLs in current deployments, but
// older rows may hold bare paths inside the cad-artifacts bucket.
async function resolveCadArtifact(
  value: string,
  format: string,
  filename: string,
  download: boolean,
): Promise<ResolvedAsset | null> {
  if (/^https?:\/\//i.test(value)) {
    const response = await fetch(value, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok || !response.body) return null;
    return {
      kind: 'stream',
      body: response.body,
      contentType: contentTypeFor(format),
      filename,
    };
  }
  const path = value.replace(/^\/+/, '').replace(/^cad-artifacts\//, '');
  return signedBucketUrl('cad-artifacts', path, download ? filename : false);
}

export async function resolveGenerationAsset(
  detail: GenerationDetail,
  type: string,
  download = false,
): Promise<ResolvedAsset | null> {
  if (detail.kind === 'cad') {
    const entry = CAD_ARTIFACT_ASSETS.find((asset) => asset.type === type);
    const value = entry ? detail.artifacts?.[entry.key] : undefined;
    if (!entry || !value) return null;
    const urlExt = value.match(/\.([a-z0-9]+)(?:\?|$)/i)?.[1];
    const ext = entry.type === 'source' ? (urlExt ?? 'py') : entry.format;
    return resolveCadArtifact(value, ext, `cad-${detail.id}.${ext}`, download);
  }

  if (detail.kind === 'parametric' && type === 'scad') {
    if (!detail.parametric) return null;
    const blob = new Blob([detail.parametric.code], {
      type: contentTypeFor('scad'),
    });
    return {
      kind: 'stream',
      body: blob,
      contentType: contentTypeFor('scad'),
      filename: `${slugify(detail.parametric.title)}-${detail.id.slice(0, 8)}.scad`,
    };
  }

  if (detail.kind === 'mesh' && type === 'model') {
    const ext = detail.file_type ?? 'glb';
    return signedBucketUrl(
      'meshes',
      `${detail.user_id}/${detail.conversation_id}/${detail.id}.${ext}`,
      download ? `mesh-${detail.id}.${ext}` : false,
    );
  }

  if (detail.kind === 'image' && type === 'image') {
    return signedBucketUrl(
      'images',
      `${detail.user_id}/${detail.conversation_id}/${detail.id}`,
      download ? `image-${detail.id}.png` : false,
    );
  }

  return null;
}

// Fetches CAD source code as text for inline display (capped to keep the
// page light; the full file is always available via the download route).
export async function fetchCadSourceCode(
  detail: GenerationDetail,
  maxBytes = 256 * 1024,
): Promise<string | null> {
  if (detail.kind !== 'cad' || !detail.artifacts?.sourcePath) return null;
  try {
    const resolved = await resolveGenerationAsset(detail, 'source');
    if (!resolved) return null;
    const blob =
      resolved.kind === 'redirect'
        ? await (
            await fetch(resolved.url, { signal: AbortSignal.timeout(30_000) })
          ).blob()
        : resolved.body instanceof Blob
          ? resolved.body
          : await new Response(resolved.body).blob();
    const slice = blob.size > maxBytes ? blob.slice(0, maxBytes) : blob;
    const text = await slice.text();
    return blob.size > maxBytes
      ? `${text}\n\n# ... truncated (${blob.size.toLocaleString()} bytes total, download for full source)`
      : text;
  } catch {
    return null;
  }
}
