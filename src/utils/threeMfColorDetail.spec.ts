import { describe, expect, it } from 'vitest';

import {
  DEFAULT_THREE_MF_COLOR_DETAIL,
  clampThreeMfColorDetail,
  getThreeMfColorDetailSettings,
} from './threeMfExport';

describe('clampThreeMfColorDetail', () => {
  it('clamps to the 0-100 range and rounds', () => {
    expect(clampThreeMfColorDetail(-5)).toBe(0);
    expect(clampThreeMfColorDetail(150)).toBe(100);
    expect(clampThreeMfColorDetail(37.6)).toBe(38);
  });

  it('falls back to the default for non-finite values', () => {
    expect(clampThreeMfColorDetail(Number.NaN)).toBe(
      DEFAULT_THREE_MF_COLOR_DETAIL,
    );
    expect(clampThreeMfColorDetail(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_THREE_MF_COLOR_DETAIL,
    );
  });
});

describe('getThreeMfColorDetailSettings', () => {
  it('reproduces the historical fixed behavior at the default value', () => {
    expect(
      getThreeMfColorDetailSettings(DEFAULT_THREE_MF_COLOR_DETAIL),
    ).toEqual({
      smoothingIterations: 3,
      smallColorIslandTriangleCount: 24,
      similarColorIslandDistanceSquared: 0.03,
      forceTextureDetail: false,
      textureDetailSubdivisionPixelSpan: 48,
      textureDetailMaxSubdivisionLevel: 4,
    });
  });

  it('merges aggressively at the rough end', () => {
    const rough = getThreeMfColorDetailSettings(0);
    expect(rough.smallColorIslandTriangleCount).toBe(120);
    expect(rough.smoothingIterations).toBe(5);
    expect(rough.similarColorIslandDistanceSquared).toBeCloseTo(0.2);
    expect(rough.forceTextureDetail).toBe(false);
  });

  it('disables smoothing and enables texture subdivision at the detailed end', () => {
    const detailed = getThreeMfColorDetailSettings(100);
    expect(detailed.smallColorIslandTriangleCount).toBe(0);
    expect(detailed.smoothingIterations).toBe(0);
    expect(detailed.similarColorIslandDistanceSquared).toBe(0);
    expect(detailed.forceTextureDetail).toBe(true);
    expect(detailed.textureDetailSubdivisionPixelSpan).toBe(20);
    expect(detailed.textureDetailMaxSubdivisionLevel).toBe(5);
  });

  it('reduces island merging monotonically as detail increases', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let detail = 0; detail <= 100; detail += 10) {
      const settings = getThreeMfColorDetailSettings(detail);
      expect(settings.smallColorIslandTriangleCount).toBeLessThanOrEqual(
        previous,
      );
      previous = settings.smallColorIslandTriangleCount;
    }
  });
});
