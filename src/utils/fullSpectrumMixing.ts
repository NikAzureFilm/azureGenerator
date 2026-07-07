/**
 * Full Spectrum layer-line color mixing advisor.
 *
 * "Full Spectrum slicing" (Snapmaker Orca v2.3.3+) mixes colors by alternating
 * filaments layer by layer: when a repeating color stack stays under ~0.2 mm
 * the eye can no longer resolve the individual layers at arm's length and the
 * colors blend optically, the way pixels dither on a screen. See
 * https://www.snapmaker.com/blog/getting-started-with-full-spectrum-slicing/
 *
 * The mixing itself happens in the slicer (Ratio/Cycle/Match Mix on a
 * tool-changer printer), not in the 3MF, so this module's job is advisory:
 * given the quantized palette of a color-print export and a set of loaded
 * filaments, it computes the layer cycle ("1-2-2" style, ready for Cycle Mix)
 * that best reproduces each palette color, simulates the blended result, and
 * recommends which filament set covers the model's colors best.
 *
 * Blending model: a repeating stack of thin colored layers is partitive
 * (additive-average) mixing of reflected light, so layer colors are averaged
 * in linear-light RGB and converted back to sRGB. Match quality is scored
 * with CIE76 delta-E in Lab space, where values under ~5 are hard to tell
 * apart on a print.
 */

export type MixingFilament = {
  name: string;
  hex: string;
};

export type FilamentSetPreset = {
  id: string;
  label: string;
  description: string;
  filaments: MixingFilament[];
};

/** Recommended layer height for invisible color stacks (per the technique). */
export const FULL_SPECTRUM_LAYER_HEIGHT_MM = 0.08;
/** A repeating color stack taller than this reads as stripes at arm's length. */
export const MAX_INVISIBLE_COLOR_STACK_MM = 0.2;
export const DEFAULT_MAX_LAYERS_PER_CYCLE = 3;
/** A longer cycle must improve delta-E by at least this much to be worth it. */
const LONGER_CYCLE_MIN_GAIN_DELTA_E = 1;

export const FULL_SPECTRUM_FILAMENT_PRESETS: FilamentSetPreset[] = [
  {
    id: 'translucent-cmy',
    label: 'Translucent CMY + White + Black',
    description:
      'Widest color range (subtractive primaries). Use translucent ' +
      'cyan/magenta/yellow (transmission distance 5–8 mm, e.g. Polymaker ' +
      'Panchroma Translucent CMY) so layers blend instead of striping — ' +
      'most off-the-shelf CMYK kits are too opaque.',
    filaments: [
      { name: 'Translucent Cyan', hex: '#00AEEF' },
      { name: 'Translucent Magenta', hex: '#EC008C' },
      { name: 'Translucent Yellow', hex: '#FFF200' },
      { name: 'White', hex: '#F2F2F2' },
      { name: 'Black', hex: '#1A1A1A' },
    ],
  },
];

/** Palettes at or below this size print directly on a normal multi-color AMS. */
const CLASSIC_MODE_MAX_DIRECT_COLORS = 4;
/** Average mix ΔE above this means separate filaments reproduce colors better. */
const CLASSIC_MODE_POOR_MIX_DELTA_E = 12;

export type LayerMixRecipe = {
  targetHex: string;
  achievedHex: string;
  /** Zero-based indexes into the filament set, one entry per layer of the cycle. */
  layerFilamentIndexes: number[];
  /** One-based slot pattern ("1-2-2") ready for Snapmaker Orca's Cycle Mix. */
  patternLabel: string;
  /** CIE76 delta-E between target and achieved color (< 5 is hard to spot). */
  deltaE: number;
  stackHeightMm: number;
  /** True when the repeating stack is tall enough to read as visible stripes. */
  exceedsInvisibleStack: boolean;
};

export type FullSpectrumPlan = {
  preset: FilamentSetPreset;
  recipes: LayerMixRecipe[];
  layerHeightMm: number;
  averageDeltaE: number;
};

export type MixQuality = 'excellent' | 'good' | 'approximate';

type RgbTuple = [number, number, number];

function normalizeHex(hex: string): string | null {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  return match ? `#${match[1].toUpperCase()}` : null;
}

function hexToRgb(hex: string): RgbTuple | null {
  const normalized = normalizeHex(hex);
  if (!normalized) {
    return null;
  }

  return [
    Number.parseInt(normalized.slice(1, 3), 16) / 255,
    Number.parseInt(normalized.slice(3, 5), 16) / 255,
    Number.parseInt(normalized.slice(5, 7), 16) / 255,
  ];
}

function rgbToHex([r, g, b]: RgbTuple): string {
  const toChannel = (value: number) =>
    Math.min(255, Math.max(0, Math.round(value * 255)))
      .toString(16)
      .padStart(2, '0');

  return `#${toChannel(r)}${toChannel(g)}${toChannel(b)}`.toUpperCase();
}

function srgbChannelToLinear(channel: number): number {
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearChannelToSrgb(channel: number): number {
  return channel <= 0.0031308
    ? channel * 12.92
    : 1.055 * channel ** (1 / 2.4) - 0.055;
}

/**
 * Optical result of a repeating stack of equally thick filament layers:
 * partitive mixing, i.e. the average of the layer colors in linear light.
 */
export function blendFilamentLayers(hexes: string[]): string {
  const rgbs = hexes
    .map(hexToRgb)
    .filter((rgb): rgb is RgbTuple => rgb !== null);
  if (rgbs.length === 0) {
    return '#808080';
  }

  const linearSum: RgbTuple = [0, 0, 0];
  for (const rgb of rgbs) {
    linearSum[0] += srgbChannelToLinear(rgb[0]);
    linearSum[1] += srgbChannelToLinear(rgb[1]);
    linearSum[2] += srgbChannelToLinear(rgb[2]);
  }

  return rgbToHex([
    linearChannelToSrgb(linearSum[0] / rgbs.length),
    linearChannelToSrgb(linearSum[1] / rgbs.length),
    linearChannelToSrgb(linearSum[2] / rgbs.length),
  ]);
}

function rgbToLab(rgb: RgbTuple): RgbTuple {
  const [r, g, b] = rgb.map(srgbChannelToLinear) as RgbTuple;

  // Linear sRGB -> XYZ (D65).
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;

  const f = (value: number) =>
    value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
  const [fx, fy, fz] = [f(x), f(y), f(z)];

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 delta-E between two sRGB hex colors. */
export function colorDeltaE(hexA: string, hexB: string): number {
  const rgbA = hexToRgb(hexA);
  const rgbB = hexToRgb(hexB);
  if (!rgbA || !rgbB) {
    return Number.POSITIVE_INFINITY;
  }

  const labA = rgbToLab(rgbA);
  const labB = rgbToLab(rgbB);
  return Math.hypot(labA[0] - labB[0], labA[1] - labB[1], labA[2] - labB[2]);
}

export function describeMixQuality(deltaE: number): MixQuality {
  if (deltaE < 5) {
    return 'excellent';
  }
  return deltaE < 12 ? 'good' : 'approximate';
}

function enumerateMultisets(filamentCount: number, size: number): number[][] {
  const results: number[][] = [];
  const current: number[] = [];

  const visit = (start: number) => {
    if (current.length === size) {
      results.push([...current]);
      return;
    }

    for (let index = start; index < filamentCount; index += 1) {
      current.push(index);
      visit(index);
      current.pop();
    }
  };

  visit(0);
  return results;
}

export function computeLayerMixRecipe(
  targetHex: string,
  filaments: MixingFilament[],
  {
    maxLayersPerCycle = DEFAULT_MAX_LAYERS_PER_CYCLE,
    layerHeightMm = FULL_SPECTRUM_LAYER_HEIGHT_MM,
  }: {
    maxLayersPerCycle?: number;
    layerHeightMm?: number;
  } = {},
): LayerMixRecipe {
  const target = normalizeHex(targetHex) ?? '#808080';
  const layerLimit = Math.max(1, Math.round(maxLayersPerCycle));

  type MixCandidate = {
    indexes: number[];
    achievedHex: string;
    deltaE: number;
  };
  let best: MixCandidate | null = null;

  for (let size = 1; size <= layerLimit; size += 1) {
    let bestOfSize: MixCandidate | null = null;

    for (const indexes of enumerateMultisets(filaments.length, size)) {
      const achievedHex = blendFilamentLayers(
        indexes.map((index) => filaments[index].hex),
      );
      const deltaE = colorDeltaE(target, achievedHex);
      if (!bestOfSize || deltaE < bestOfSize.deltaE) {
        bestOfSize = { indexes, achievedHex, deltaE };
      }
    }

    if (
      bestOfSize &&
      (!best || bestOfSize.deltaE < best.deltaE - LONGER_CYCLE_MIN_GAIN_DELTA_E)
    ) {
      best = bestOfSize;
    }
  }

  const indexes = best?.indexes ?? [0];
  const stackHeightMm = indexes.length * layerHeightMm;

  return {
    targetHex: target,
    achievedHex: best?.achievedHex ?? '#808080',
    layerFilamentIndexes: indexes,
    patternLabel: indexes.map((index) => index + 1).join('-'),
    deltaE: best?.deltaE ?? Number.POSITIVE_INFINITY,
    stackHeightMm,
    exceedsInvisibleStack: stackHeightMm > MAX_INVISIBLE_COLOR_STACK_MM,
  };
}

export function buildFullSpectrumPlan({
  paletteHex,
  preset,
  maxLayersPerCycle = DEFAULT_MAX_LAYERS_PER_CYCLE,
  layerHeightMm = FULL_SPECTRUM_LAYER_HEIGHT_MM,
}: {
  paletteHex: string[];
  preset: FilamentSetPreset;
  maxLayersPerCycle?: number;
  layerHeightMm?: number;
}): FullSpectrumPlan {
  // One recipe per input color, in order, so callers can map a palette index to
  // its recipe positionally. An unparseable entry (which a detected palette
  // never produces) becomes an identity recipe on the first physical filament
  // and is left out of the match-quality average.
  const recipes: LayerMixRecipe[] = [];
  const matchedDeltaEs: number[] = [];
  for (const hex of paletteHex) {
    const normalized = normalizeHex(hex);
    if (normalized === null) {
      recipes.push(buildPassthroughRecipe(preset, layerHeightMm));
      continue;
    }
    const recipe = computeLayerMixRecipe(normalized, preset.filaments, {
      maxLayersPerCycle,
      layerHeightMm,
    });
    recipes.push(recipe);
    matchedDeltaEs.push(recipe.deltaE);
  }

  const averageDeltaE =
    matchedDeltaEs.length === 0
      ? 0
      : matchedDeltaEs.reduce((sum, deltaE) => sum + deltaE, 0) /
        matchedDeltaEs.length;

  return { preset, recipes, layerHeightMm, averageDeltaE };
}

// Placeholder recipe for an unparseable palette entry: print the first physical
// filament directly (no mixing) so downstream slot mapping stays aligned.
function buildPassthroughRecipe(
  preset: FilamentSetPreset,
  layerHeightMm: number,
): LayerMixRecipe {
  const achievedHex =
    normalizeHex(preset.filaments[0]?.hex ?? '#808080') ?? '#808080';
  return {
    targetHex: achievedHex,
    achievedHex,
    layerFilamentIndexes: [0],
    patternLabel: '1',
    deltaE: Number.POSITIVE_INFINITY,
    stackHeightMm: layerHeightMm,
    exceedsInvisibleStack: false,
  };
}

export function recommendFilamentPreset(
  paletteHex: string[],
  presets: FilamentSetPreset[] = FULL_SPECTRUM_FILAMENT_PRESETS,
): { preset: FilamentSetPreset; reason: string } {
  const plans = presets.map((preset) =>
    buildFullSpectrumPlan({ paletteHex, preset }),
  );
  const bestPlan = plans.reduce((best, plan) =>
    plan.averageDeltaE < best.averageDeltaE ? plan : best,
  );

  return {
    preset: bestPlan.preset,
    reason:
      plans.length > 1
        ? `Closest overall match to this model's colors (avg ΔE ` +
          `${bestPlan.averageDeltaE.toFixed(1)} vs ${plans
            .filter((plan) => plan !== bestPlan)
            .map((plan) => plan.averageDeltaE.toFixed(1))
            .join(', ')}).`
        : 'Only one filament set available.',
  };
}

/**
 * Recommend Classic multi-color vs Full Spectrum layer mixing for a palette.
 *
 * Classic wins when the palette is small enough that a normal AMS can load one
 * spool per color (perfect colors, no stripes), or when even the best CMY
 * mixing plan is too far off to look right. Otherwise Full Spectrum reproduces
 * many colors from a handful of translucent filaments.
 */
export function recommendPrintMode(paletteHex: string[]): {
  mode: 'classic' | 'fullSpectrum';
  reason: string;
} {
  const validColors = paletteHex
    .map((hex) => normalizeHex(hex))
    .filter((hex): hex is string => hex !== null);

  if (validColors.length <= CLASSIC_MODE_MAX_DIRECT_COLORS) {
    return {
      mode: 'classic',
      reason: `Only ${validColors.length} color${
        validColors.length === 1 ? '' : 's'
      } detected — a standard multi-color printer can load one filament per color for perfect results.`,
    };
  }

  const preset = FULL_SPECTRUM_FILAMENT_PRESETS[0];
  const plan = buildFullSpectrumPlan({ paletteHex: validColors, preset });

  if (plan.averageDeltaE > CLASSIC_MODE_POOR_MIX_DELTA_E) {
    return {
      mode: 'classic',
      reason: `Layer mixing only reaches avg ΔE ${plan.averageDeltaE.toFixed(
        1,
      )} on these colors — separate filaments reproduce them more accurately.`,
    };
  }

  return {
    mode: 'fullSpectrum',
    reason: `${validColors.length} colors reproduce well by layer mixing (avg ΔE ${plan.averageDeltaE.toFixed(
      1,
    )}) from just ${preset.filaments.length} filaments.`,
  };
}
