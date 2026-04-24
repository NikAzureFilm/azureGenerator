const FALLBACK_IMAGE_MEDIA_TYPE = 'image/jpeg';

const SUPPORTED_IMAGE_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

export function normalizeImageMediaType(
  mediaType: string | null | undefined,
): string {
  const normalized = mediaType?.split(';')[0]?.trim().toLowerCase();
  if (normalized === 'image/jpg') return 'image/jpeg';
  if (normalized && SUPPORTED_IMAGE_MEDIA_TYPES.has(normalized)) {
    return normalized;
  }
  return FALLBACK_IMAGE_MEDIA_TYPE;
}

export function detectImageMediaType(
  bytes: Uint8Array | ArrayBuffer,
  fallback?: string | null,
): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  if (
    view.length >= 3 &&
    view[0] === 0xff &&
    view[1] === 0xd8 &&
    view[2] === 0xff
  ) {
    return 'image/jpeg';
  }

  if (
    view.length >= 8 &&
    view[0] === 0x89 &&
    view[1] === 0x50 &&
    view[2] === 0x4e &&
    view[3] === 0x47 &&
    view[4] === 0x0d &&
    view[5] === 0x0a &&
    view[6] === 0x1a &&
    view[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (
    view.length >= 12 &&
    view[0] === 0x52 &&
    view[1] === 0x49 &&
    view[2] === 0x46 &&
    view[3] === 0x46 &&
    view[8] === 0x57 &&
    view[9] === 0x45 &&
    view[10] === 0x42 &&
    view[11] === 0x50
  ) {
    return 'image/webp';
  }

  if (
    view.length >= 6 &&
    view[0] === 0x47 &&
    view[1] === 0x49 &&
    view[2] === 0x46 &&
    view[3] === 0x38 &&
    (view[4] === 0x37 || view[4] === 0x39) &&
    view[5] === 0x61
  ) {
    return 'image/gif';
  }

  return normalizeImageMediaType(fallback);
}
