import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { MeshFileType } from '@shared/types';
import { compileScadToStl } from '@/utils/compileScadToStl';
import { downscaleImage } from '@/utils/downscaleImage';
import { getCachedThumbnail, setCachedThumbnail } from '@/utils/thumbnailCache';
import {
  fetchStoredThumbnail,
  storeThumbnail,
  thumbnailObjectKey,
} from '@/utils/thumbnailBucket';

// Throttle heavy thumbnail generation. Mounting many cards at once (the
// sidebar list + the history list view) would otherwise spin up a dozen
// OpenSCAD workers / WebGL renderers simultaneously and jank the app.
const MAX_CONCURRENT = 3;
let activeSlots = 0;
const waiters: Array<() => void> = [];

async function withThumbnailSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeSlots >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  activeSlots++;
  try {
    return await fn();
  } finally {
    activeSlots--;
    waiters.shift()?.();
  }
}

type ContentRecord = Record<string, unknown>;

function asRecord(value: unknown): ContentRecord | null {
  return value && typeof value === 'object' ? (value as ContentRecord) : null;
}

type ThumbnailSource =
  | { kind: 'scad'; code: string }
  | { kind: 'mesh'; id: string; fileType: MeshFileType }
  | null;

async function findThumbnailSource(
  conversationId: string,
): Promise<ThumbnailSource> {
  const { data: messages, error } = await supabase
    .from('messages')
    .select('content')
    .eq('conversation_id', conversationId)
    .eq('role', 'assistant')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) throw error;

  // Parametric artifact takes precedence (matches the visual grid card).
  for (const message of messages ?? []) {
    const artifact = asRecord(asRecord(message.content)?.artifact);
    if (artifact && typeof artifact.code === 'string') {
      return { kind: 'scad', code: artifact.code };
    }
  }

  // Fall back to the latest generated mesh.
  for (const message of messages ?? []) {
    const mesh = asRecord(asRecord(message.content)?.mesh);
    if (mesh && typeof mesh.id === 'string') {
      const fileType: MeshFileType =
        typeof mesh.fileType === 'string'
          ? (mesh.fileType as MeshFileType)
          : 'glb';
      return { kind: 'mesh', id: mesh.id, fileType };
    }
  }

  return null;
}

// Compile a parametric artifact to an STL and render a compressed preview.
// Parametric creations have no Storage egress (the code is already in the
// message query), so these are not materialized to the thumbnails bucket.
async function renderScadThumbnail(code: string): Promise<string> {
  return withThumbnailSlot(async () => {
    const stl = await compileScadToStl(code);
    const { generatePreview } = await import('@/utils/meshUtils');
    const full = await generatePreview(stl, 'stl');
    return downscaleImage(full);
  });
}

// Download the full mesh and render a compressed preview. This is the
// expensive path (multi-MB download) we avoid via the thumbnails bucket on all
// but the first view of a given mesh.
async function renderMeshThumbnail(
  meshId: string,
  fileType: MeshFileType,
  userId: string,
  conversationId: string,
): Promise<string> {
  return withThumbnailSlot(async () => {
    const { data: blob, error } = await supabase.storage
      .from('meshes')
      .download(`${userId}/${conversationId}/${meshId}.${fileType}`);

    if (error || !blob) {
      throw error ?? new Error('Mesh file not available');
    }

    const { generatePreview } = await import('@/utils/meshUtils');
    const full = await generatePreview(blob, fileType);
    return downscaleImage(full);
  });
}

/**
 * Produce a small static preview image (data URL) for a conversation's latest
 * creation. Parametric artifacts take precedence, falling back to the latest
 * mesh.
 *
 * Caching strategy (important for backend cost at scale), fastest tier first:
 *  1. IndexedDB (per device) keyed by conversation + updated_at — repeat visits
 *     do no backend calls at all.
 *  2. The "thumbnails" storage bucket (cross-device) — for meshes, fetch a
 *     ~5KB WebP instead of re-downloading the multi-MB mesh. The first viewer
 *     of a mesh renders it and uploads it here for everyone after.
 *  3. Render from source — download the mesh (or compile the SCAD) and render,
 *     then downscale/compress so the cached image stays a few KB.
 *
 * React Query keeps the result in memory for the session (staleTime Infinity)
 * and dedupes when the same conversation appears in both the sidebar and list.
 */
export function useCreationThumbnail({
  conversationId,
  userId,
  updatedAt,
  enabled = true,
}: {
  conversationId: string;
  userId: string;
  updatedAt: string;
  enabled?: boolean;
}) {
  const query = useQuery({
    queryKey: ['creationThumbnail', conversationId, updatedAt],
    enabled: enabled && !!conversationId && !!userId,
    staleTime: Infinity,
    gcTime: 1000 * 60 * 30,
    retry: false,
    queryFn: async (): Promise<string | null> => {
      // Tier 1: per-device IndexedDB — no backend calls, no render.
      const cached = await getCachedThumbnail(conversationId);
      if (cached && cached.updatedAt === updatedAt) {
        return cached.dataUrl;
      }

      const source = await findThumbnailSource(conversationId);
      let dataUrl: string | null = null;

      if (source?.kind === 'mesh') {
        // Tier 2: cross-device thumbnails bucket (~5KB) before the mesh.
        const objectKey = thumbnailObjectKey(userId, conversationId, source.id);
        dataUrl = await fetchStoredThumbnail(objectKey);

        if (!dataUrl) {
          // Tier 3: render from the mesh, then materialize for next time.
          dataUrl = await renderMeshThumbnail(
            source.id,
            source.fileType,
            userId,
            conversationId,
          );
          void storeThumbnail(objectKey, dataUrl);
        }
      } else if (source?.kind === 'scad') {
        dataUrl = await renderScadThumbnail(source.code);
      }

      // Persist (including the "nothing to render" null) for next time.
      await setCachedThumbnail(conversationId, { updatedAt, dataUrl });
      return dataUrl;
    },
  });

  return {
    thumbnail: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
