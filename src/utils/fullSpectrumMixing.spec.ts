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
} from './fullSpectrumMixing';

const RYB_PRESET = FULL_SPECTRUM_FILAMENT_PRESETS.find(
  (preset) => preset.id === 'ryb',
)!;
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
    const recipe = computeLayerMixRecipe('#E53935', RYB_PRESET.filaments);
    expect(recipe.layerFilamentIndexes).toEqual([0]);
    expect(recipe.patternLabel).toBe('1');
    expect(recipe.deltaE).toBe(0);
    expect(recipe.achievedHex).toBe('#E53935');
  });

  it('mixes multiple filaments to approximate an out-of-set color', () => {
    // Orange is not in the RYB set; a red+yellow blend should get closer
    // than any single filament.
    const orange = '#F08A24';
    const recipe = computeLayerMixRecipe(orange, RYB_PRESET.filaments);
    const bestSingle = Math.min(
      ...RYB_PRESET.filaments.map((filament) =>
        colorDeltaE(orange, filament.hex),
      ),
    );
    expect(recipe.layerFilamentIndexes.length).toBeGreaterThan(1);
    expect(recipe.deltaE).toBeLessThan(bestSingle);
  });

  it('respects the layer cycle limit', () => {
    const recipe = computeLayerMixRecipe('#F08A24', RYB_PRESET.filaments, {
      maxLayersPerCycle: 2,
    });
    expect(recipe.layerFilamentIndexes.length).toBeLessThanOrEqual(2);
  });

  it('flags cycles that exceed the invisible stack height', () => {
    const shortCycle = computeLayerMixRecipe('#E53935', RYB_PRESET.filaments);
    expect(shortCycle.stackHeightMm).toBeCloseTo(FULL_SPECTRUM_LAYER_HEIGHT_MM);
    expect(shortCycle.exceedsInvisibleStack).toBe(false);

    const tallCycle = computeLayerMixRecipe('#F08A24', RYB_PRESET.filaments, {
      layerHeightMm: 0.2,
    });
    expect(tallCycle.stackHeightMm).toBeGreaterThan(
      MAX_INVISIBLE_COLOR_STACK_MM,
    );
    expect(tallCycle.exceedsInvisibleStack).toBe(true);
  });
});

describe('buildFullSpectrumPlan', () => {
  it('produces one recipe per valid palette color', () => {
    const plan = buildFullSpectrumPlan({
      paletteHex: ['#E53935', 'not-a-color', '#1E88E5'],
      preset: RYB_PRESET,
    });
    expect(plan.recipes).toHaveLength(2);
    expect(plan.layerHeightMm).toBe(FULL_SPECTRUM_LAYER_HEIGHT_MM);
    expect(plan.averageDeltaE).toBe(0);
    for (const recipe of plan.recipes) {
      expect(recipe.layerFilamentIndexes.length).toBeLessThanOrEqual(
        DEFAULT_MAX_LAYERS_PER_CYCLE,
      );
    }
  });
});

describe('recommendFilamentPreset', () => {
  it('recommends the set whose blends match the palette best', () => {
    const { preset, reason } = recommendFilamentPreset([
      '#E53935',
      '#FDD835',
      '#1E88E5',
    ]);
    expect(preset.id).toBe('ryb');
    expect(reason).toContain('ΔE');
  });

  it('recommends the CMY set for its own primaries', () => {
    const { preset } = recommendFilamentPreset(
      CMY_PRESET.filaments.map((filament) => filament.hex),
    );
    expect(preset.id).toBe('translucent-cmy');
  });
});
