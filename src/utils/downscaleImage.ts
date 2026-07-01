/**
 * Downscale a rendered preview data URL to a small, compressed thumbnail.
 *
 * `generatePreview` renders at 1000px (times devicePixelRatio) and returns a
 * PNG data URL that can be several MB. Displayed thumbnails are only 28–56px,
 * so we shrink to a small WebP before caching/holding in memory — keeping each
 * cached thumbnail at a few KB instead of multiple MB.
 */
export async function downscaleImage(
  dataUrl: string,
  maxSize = 192,
  mimeType = 'image/webp',
  quality = 0.8,
): Promise<string> {
  if (typeof document === 'undefined') return dataUrl;

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image for downscale'));
    img.src = dataUrl;
  });

  const largestSide = Math.max(image.width, image.height) || 1;
  const scale = Math.min(1, maxSize / largestSide);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;

  ctx.drawImage(image, 0, 0, width, height);

  // Browsers that don't support the requested type fall back to PNG, which is
  // still correct (just larger) — so this never throws.
  return canvas.toDataURL(mimeType, quality);
}
