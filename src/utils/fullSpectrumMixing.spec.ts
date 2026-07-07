import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_LAYERS_PER_CYCLE,
  FULL_SPECTRUM_FILAMENT_PRESETS,
  FULL_SPECTRUM_LAYER_HEIGHT_MM,
  MAX_INVISIBLE_COLOR_STACK_MM,
  blendFilamentLayers,
  buildFullSpectrumPlan,
  colorDeltaE,
  computeLayerMixRecipe,
  describeMixQuality,
  recommendFilamentPreset,
  recommendPrintMode,
} from './fullSpectrumMixing';

const CMY_PRESET = FULL_SPECTRUM_FILAMENT_PRESETS.find(
  (preset) => preset.id === 'translucent-cmy',
)!;

describe('blendFilamentLayers', () => {
  it('returns the same color for a single-color stack', () => {
    expect(blendFilamentLayers(['#FF0000'])).toBe('#FF0000');
    expect(blendFilamentLayers(['#FF0000', '#FF0000'])).toBe('#FF0000');
  });

  it('mixes cyan and yellow layers toward green', () => {
    const blended = blendFilamentLayers(['#00AEEF', '#FFF200']);
    const [r, g, b] = [1, 3, 5].map((offset) =>
      Number.parseInt(blended.slice(offset, offset + 2), 16),
    );
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });

  it('averages in linear light, not raw sRGB', () => {
    // Linear-light average of black and white is ~#BCBCBC, well above the
    // naive sRGB midpoint of #808080.
    const blended = blendFilamentLayers(['#000000', '#FFFFFF']);
    const gray = Number.parseInt(blended.slice(1, 3), 16);
    expect(gray).toBeGreaterThan(160);
  });
});

describe('colorDeltaE / describeMixQuality', () => {
  it('is zero for identical colors and large for opposites', () => {
    expect(colorDeltaE('#123456', '#123456')).toBe(0);
    expect(colorDeltaE('#000000', '#FFFFFF')).toBeGreaterThan(50);
  });

  it('maps delta-E to quality buckets', () => {
    expect(describeMixQuality(0)).toBe('excellent');
    expect(describeMixQuality(4.9)).toBe('excellent');
    expect(describeMixQuality(8)).toBe('good');
    expect(describeMixQuality(30)).toBe('approximate');
  });
});

describe('computeLayerMixRecipe', () => {
  it('uses a single layer when a filament matches the target exactly', () => {
    // Cyan is the first filament in the CMY set.
    const recipe = computeLayerMixRecipe('#00AEEF', CMY_PRESET.filaments);
    expect(recipe.layerFilamentIndexes).toEqual([0]);
    expect(recipe.patternLabel).toBe('1');
    expect(recipe.deltaE).toBe(0);
    expect(recipe.achievedHex).toBe('#00AEEF');
  });

  it('mixes multiple filaments to approximate an out-of-set color', () => {
    // Orange is not in the CMY set; a magenta+yellow blend should get closer
    // than any single filament.
    const orange = '#F08A24';
    const recipe = computeLayerMixRecipe(orange, CMY_PRESET.filaments);
    const bestSingle = Math.min(
      ...CMY_PRESET.filaments.map((filament) =>
        colorDeltaE(orange, filament.hex),
      ),
    );
    expect(recipe.layerFilamentIndexes.length).toBeGreaterThan(1);
    expect(recipe.deltaE).toBeLessThan(bestSingle);
  });

  it('respects the layer cycle limit', () => {
    const recipe = computeLayerMixRecipe('#F08A24', CMY_PRESET.filaments, {
      maxLayersPerCycle: 2,
    });
    expect(recipe.layerFilamentIndexes.length).toBeLessThanOrEqual(2);
  });

  it('flags cycles that exceed the invisible stack height', () => {
    const shortCycle = computeLayerMixRecipe('#00AEEF', CMY_PRESET.filaments);
    expect(shortCycle.stackHeightMm).toBeCloseTo(FULL_SPECTRUM_LAYER_HEIGHT_MM);
    expect(shortCycle.exceedsInvisibleStack).toBe(false);

    const tallCycle = computeLayerMixRecipe('#F08A24', CMY_PRESET.filaments, {
      layerHeightMm: 0.2,
    });
    expect(tallCycle.stackHeightMm).toBeGreaterThan(
      MAX_INVISIBLE_COLOR_STACK_MM,
    );
    expect(tallCycle.exceedsInvisibleStack).toBe(true);
  });
});

describe('buildFullSpectrumPlan', () => {
  it('emits one recipe per palette entry, keeping index alignment', () => {
    const plan = buildFullSpectrumPlan({
      paletteHex: ['#00AEEF', 'not-a-color', '#FFF200'],
      preset: CMY_PRESET,
    });
    // Position-preserving: three inputs -> three recipes, so an invalid entry
    // does not shift the colors after it.
    expect(plan.recipes).toHaveLength(3);
    expect(plan.layerHeightMm).toBe(FULL_SPECTRUM_LAYER_HEIGHT_MM);
    // The unparseable middle entry is an identity recipe on the first filament
    // and is excluded from the average, which stays 0 for the exact matches.
    expect(plan.recipes[1].layerFilamentIndexes).toEqual([0]);
    expect(plan.averageDeltaE).toBe(0);
    for (const recipe of plan.recipes) {
      expect(recipe.layerFilamentIndexes.length).toBeLessThanOrEqual(
        DEFAULT_MAX_LAYERS_PER_CYCLE,
      );
    }
  });
});

describe('recommendFilamentPreset', () => {
  it('returns the sole CMY set with a coherent reason', () => {
    const { preset, reason } = recommendFilamentPreset(
      CMY_PRESET.filaments.map((filament) => filament.hex),
    );
    expect(preset.id).toBe('translucent-cmy');
    expect(reason).toBe('Only one filament set available.');
  });
});

describe('recommendPrintMode', () => {
  it('recommends classic for a small directly-printable palette', () => {
    const { mode, reason } = recommendPrintMode(['#FF0000', '#00FF00']);
    expect(mode).toBe('classic');
    expect(reason).toContain('2 colors');
  });

  it('recommends classic when even the best mix is a poor match', () => {
    // Five saturated primaries/secondaries that translucent CMY cannot blend
    // accurately, so separate spools reproduce them better.
    const { mode } = recommendPrintMode([
      '#FF0000',
      '#00FF00',
      '#0000FF',
      '#FF00FF',
      '#00FFFF',
    ]);
    expect(mode).toBe('classic');
  });

  it('recommends full spectrum for many well-mixable colors', () => {
    // Many colors that sit close to CMY blends: cyan, magenta, yellow and
    // their pairwise mixes reproduce with low ΔE.
    const { mode, reason } = recommendPrintMode([
      '#00AEEF',
      '#EC008C',
      '#FFF200',
      '#7A5CB0',
      '#8F9E3C',
      '#F06EA9',
    ]);
    expect(mode).toBe('fullSpectrum');
    expect(reason).toContain('ΔE');
  });
});
