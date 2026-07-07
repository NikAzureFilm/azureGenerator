// Pure pixel transform for the OpenAI inpainting alpha mask.
//
// The stroke canvas is painted with FULLY OPAQUE red where the user marked
// regions to regenerate (its translucent on-screen look comes from CSS opacity
// on the canvas element, not from the pixel alpha). This transform turns that
// stroke coverage into the mask OpenAI expects:
//   - painted pixels (stroke alpha > 0) -> fully TRANSPARENT (alpha 0): these
//     are the regions OpenAI regenerates.
//   - everything else -> fully OPAQUE black (0, 0, 0, 255): preserved.
//
// The alpha is binarized (any non-zero stroke coverage becomes alpha 0) so
// anti-aliased stroke edges never leave a partial alpha that OpenAI would read
// as "partially preserve" — the previous translucent-stroke approach produced a
// uniform alpha ~127 in painted regions, which OpenAI treats as preserve, so
// edits silently no-op. The exported `strokeData` is the RGBA byte array from
// the stroke canvas's ImageData; the returned array is a new RGBA byte array of
// the same length for the mask canvas.
export function buildMaskAlphaData(
  strokeData: Uint8ClampedArray,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(strokeData.length);
  for (let i = 0; i < strokeData.length; i += 4) {
    const painted = strokeData[i + 3] > 0;
    // RGB is black either way; only alpha distinguishes preserve vs regenerate.
    out[i] = 0;
    out[i + 1] = 0;
    out[i + 2] = 0;
    out[i + 3] = painted ? 0 : 255;
  }
  return out;
}
