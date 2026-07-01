import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { MeshFileType } from '@shared/types';
import { compileScadToStl } from '@/utils/compileScadToStl';
import { downscaleImage } from '@/utils/downscaleImage';
import { getCachedThumbnail, setCachedThumbnail } from '@/utils/thumbnailCache';

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

async function renderThumbnail(
  source: Exclude<ThumbnailSource, null>,
  userId: string,
  conversationId: string,
): Promise<string> {
  return withThumbnailSlot(async () => {
    const { generatePreview } = await import('@/utils/meshUtils');

    if (source.kind === 'scad') {
      const stl = await compileScadToStl(source.code);
      const full = await generatePreview(stl, 'stl');
      return downscaleImage(full);
    }

    const { data: blob, error } = await supabase.storage
      .from('meshes')
      .download(`${userId}/${conversationId}/${source.id}.${source.fileType}`);

    if (error || !blob) {
      throw error ?? new Error('Mesh file not available');
    }

    const full = await generatePreview(blob, source.fileType);
    return downscaleImage(full);
  });
}

/**
 * Produce a small static preview image (data URL) for a conversation's latest
 * creation. Parametric artifacts take precedence, falling back to the latest
 * mesh.
 *
 * Caching strategy (important for backend cost at scale):
 *  - Results are persisted in IndexedDB keyed by conversation + updated_at, so
 *    repeat visits do no message query, no storage download, and no render.
 *  - React Query keeps the result in memory for the session (staleTime
 *    Infinity), and dedupes when the same conversation appears in both the
 *    sidebar and the list view.
 *  - The rendered image is downscaled/compressed before caching so it stays a
 *    few KB rather than a multi-MB PNG.
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
      // 1. Persistent cache hit — no backend calls, no render.
      const cached = await getCachedThumbnail(conversationId);
      if (cached && cached.updatedAt === updatedAt) {
        return cached.dataUrl;
      }

      // 2. Find the latest renderable creation, render + compress it.
      const source = await findThumbnailSource(conversationId);
      const dataUrl = source
        ? await renderThumbnail(source, userId, conversationId)
        : null;

      // 3. Persist (including the "nothing to render" result) for next time.
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
