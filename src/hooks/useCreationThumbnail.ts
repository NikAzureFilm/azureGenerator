import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { MeshFileType } from '@shared/types';
import { compileScadToStl } from '@/utils/compileScadToStl';

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

/**
 * Produce a small static preview image (data URL) for a conversation's latest
 * creation. Parametric artifacts take precedence (matching the visual grid
 * card); mesh generations fall back to their downloaded file. Results are
 * cached indefinitely per conversation so the sidebar and list view share the
 * same render.
 */
export function useCreationThumbnail({
  conversationId,
  userId,
  enabled = true,
}: {
  conversationId: string;
  userId: string;
  enabled?: boolean;
}) {
  const query = useQuery({
    queryKey: ['creationThumbnail', conversationId],
    enabled: enabled && !!conversationId && !!userId,
    staleTime: Infinity,
    gcTime: 1000 * 60 * 30,
    retry: false,
    queryFn: async (): Promise<string | null> => {
      const { data: messages, error } = await supabase
        .from('messages')
        .select('content')
        .eq('conversation_id', conversationId)
        .eq('role', 'assistant')
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) throw error;

      // Parametric artifact takes precedence.
      for (const message of messages ?? []) {
        const content = asRecord(message.content);
        const artifact = asRecord(content?.artifact);
        if (artifact && typeof artifact.code === 'string') {
          return withThumbnailSlot(async () => {
            const stl = await compileScadToStl(artifact.code as string);
            const { generatePreview } = await import('@/utils/meshUtils');
            return generatePreview(stl, 'stl');
          });
        }
      }

      // Fall back to the latest generated mesh.
      for (const message of messages ?? []) {
        const content = asRecord(message.content);
        const mesh = asRecord(content?.mesh);
        if (mesh && typeof mesh.id === 'string') {
          const fileType: MeshFileType =
            typeof mesh.fileType === 'string'
              ? (mesh.fileType as MeshFileType)
              : 'glb';

          return withThumbnailSlot(async () => {
            const { data: blob, error: downloadError } = await supabase.storage
              .from('meshes')
              .download(`${userId}/${conversationId}/${mesh.id}.${fileType}`);

            if (downloadError || !blob) {
              throw downloadError ?? new Error('Mesh file not available');
            }

            const { generatePreview } = await import('@/utils/meshUtils');
            return generatePreview(blob, fileType);
          });
        }
      }

      return null;
    },
  });

  return {
    thumbnail: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
