import { supabase } from '@/lib/supabase';

// Cross-device cache for rendered mesh thumbnails. The first client to view a
// mesh renders a small WebP and uploads it here; everyone else fetches the
// ~5KB image instead of re-downloading the full multi-MB mesh. All calls
// degrade gracefully (return null / no-op) if the bucket does not exist yet or
// RLS/network fails, so the client is safe to ship before the migration lands.
const BUCKET = 'thumbnails';

export function thumbnailObjectKey(
  userId: string,
  conversationId: string,
  sourceKey: string,
): string {
  return `${userId}/${conversationId}/${sourceKey}.webp`;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read thumbnail blob'));
    reader.readAsDataURL(blob);
  });
}

/** Returns the stored thumbnail as a data URL, or null if not present. */
export async function fetchStoredThumbnail(
  objectKey: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .download(objectKey);
    if (error || !data) return null;
    return await blobToDataUrl(data);
  } catch {
    return null;
  }
}

// Keys uploaded successfully this session, so repeated views (chat + history,
// scrolling, remounts) don't re-PUT the same object.
const uploadedKeys = new Set<string>();

/** Uploads a rendered thumbnail. Non-fatal: swallows all errors. */
export async function storeThumbnail(
  objectKey: string,
  dataUrl: string,
): Promise<void> {
  if (uploadedKeys.has(objectKey)) return;
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(objectKey, blob, {
        contentType: 'image/webp',
        cacheControl: '31536000',
        upsert: true,
      });
    if (!error) uploadedKeys.add(objectKey);
  } catch {
    // Bucket missing / RLS / offline — the in-memory + IndexedDB caches still
    // cover this session, and a later client will materialize it.
  }
}
