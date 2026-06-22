import type { SupabaseClient } from './supabaseClient.ts';

export type GeneratedAssetKind =
  | 'image'
  | 'mesh'
  | 'preview'
  | 'cad-artifact'
  | 'temp-multiview'
  | 'failed-artifact';

export type GeneratedAssetSourceTable =
  | 'images'
  | 'meshes'
  | 'previews'
  | 'cad_jobs';

export function getBodySizeBytes(body: unknown): number {
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof body === 'string')
    return new TextEncoder().encode(body).byteLength;
  return 0;
}

export async function recordGeneratedAsset({
  supabaseClient,
  userId,
  conversationId,
  sourceTable,
  sourceId,
  kind,
  bucket,
  objectKey,
  mimeType,
  sizeBytes,
  visibility = 'private',
  expiresAt,
  metadata = {},
}: {
  supabaseClient: SupabaseClient;
  userId: string;
  conversationId?: string | null;
  sourceTable?: GeneratedAssetSourceTable;
  sourceId?: string;
  kind: GeneratedAssetKind;
  bucket: string;
  objectKey: string;
  mimeType?: string | null;
  sizeBytes?: number;
  visibility?: 'private' | 'public';
  expiresAt?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const { error } = await supabaseClient.from('generation_assets').insert({
    user_id: userId,
    conversation_id: conversationId ?? null,
    source_table: sourceTable ?? null,
    source_id: sourceId ?? null,
    kind,
    provider: 'supabase',
    bucket,
    object_key: objectKey,
    mime_type: mimeType ?? null,
    size_bytes: Math.max(0, Math.round(sizeBytes ?? 0)),
    visibility,
    expires_at: expiresAt ?? null,
    metadata,
  });

  if (!error) return;

  const code = 'code' in error ? String(error.code) : '';
  if (code === '23505' || code === '42P01') {
    return;
  }

  console.warn('Failed to record generated asset metadata:', {
    bucket,
    objectKey,
    kind,
    error: error.message,
  });
}
