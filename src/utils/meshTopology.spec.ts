import { describe, it, expect } from 'vitest';
import { BufferGeometry, Float32BufferAttribute } from 'three';
import { analyze } from './meshTopology';

// Append an axis-aligned box (12 triangles, 36 loose vertices — the non-indexed
// "triangle soup" an STL produces) starting at (x0,y0,z0) with edge length s.
function pushBox(
  out: number[],
  x0: number,
  y0: number,
  z0: number,
  s: number,
): void {
  const x1 = x0 + s;
  const y1 = y0 + s;
  const z1 = z0 + s;
  const c: [number, number, number][] = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  const tris = [
    [0, 1, 2],
    [0, 2, 3],
    [4, 6, 5],
    [4, 7, 6],
    [0, 4, 5],
    [0, 5, 1],
    [1, 5, 6],
    [1, 6, 2],
    [2, 6, 7],
    [2, 7, 3],
    [3, 7, 4],
    [3, 4, 0],
  ];
  for (const [a, b, d] of tris) {
    out.push(...c[a], ...c[b], ...c[d]);
  }
}

function geometryFrom(positions: number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  return geometry;
}

describe('meshTopology.analyze', () => {
  it('counts a single solid as one body', () => {
    const p: number[] = [];
    pushBox(p, 0, 0, 0, 10);
    const result = analyze(geometryFrom(p));
    expect(result.bodyCount).toBe(1);
    expect(result.bodyTriangleCounts).toEqual([12]);
    expect(result.triangleBodies.length).toBe(12);
  });

  it('counts two separated cubes as two bodies', () => {
    const p: number[] = [];
    pushBox(p, 0, 0, 0, 10);
    pushBox(p, 20, 0, 0, 10); // clear air gap → disjoint vertices, no overlap
    const result = analyze(geometryFrom(p));
    expect(result.bodyCount).toBe(2);
    expect(result.bodyTriangleCounts).toEqual([12, 12]);
  });

  it('treats a hollow cube with a sealed inner cavity as one body', () => {
    const p: number[] = [];
    pushBox(p, 0, 0, 0, 20); // outer shell
    pushBox(p, 5, 5, 5, 10); // inner cavity shell, fully inside the outer
    const result = analyze(geometryFrom(p));
    expect(result.bodyCount).toBe(1);
  });

  it('merges overlapping (interpenetrating) cubes into one body', () => {
    const p: number[] = [];
    pushBox(p, 0, 0, 0, 10); // spans 0..10, centroid (5,5,5)
    pushBox(p, 4, 4, 4, 10); // spans 4..14, centroid (9,9,9) — inside the first
    const result = analyze(geometryFrom(p));
    expect(result.bodyCount).toBe(1);
  });

  it('falls back to a single body for an empty mesh without throwing', () => {
    const empty = new BufferGeometry();
    expect(() => analyze(empty)).not.toThrow();
    const result = analyze(empty);
    expect(result.bodyCount).toBe(1);
    expect(result.triangleBodies.length).toBe(0);
    expect(result.bodyTriangleCounts).toEqual([0]);
  });

  it('falls back to a single body for a degenerate zero-area triangle', () => {
    // Three coincident vertices → one welded vertex, no real surface.
    const result = analyze(geometryFrom([1, 1, 1, 1, 1, 1, 1, 1, 1]));
    expect(result.bodyCount).toBe(1);
    expect(() =>
      analyze(geometryFrom([1, 1, 1, 1, 1, 1, 1, 1, 1])),
    ).not.toThrow();
  });
});
