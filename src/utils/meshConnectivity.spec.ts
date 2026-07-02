import { describe, it, expect } from 'vitest';
import { analyzeMeshConnectivity } from './meshConnectivity';
import type { ParsedOff, OffFace } from './offParser';

// Build a watertight axis-aligned box (12 triangles, 8 shared vertices) with
// its base at z = z0. Vertices are local to this box; pass an index offset so
// several boxes can share one vertex array without colliding.
function box(
  x0: number,
  y0: number,
  z0: number,
  size: number,
  offset: number,
): { vertices: [number, number, number][]; faces: OffFace[] } {
  const s = size;
  const vertices: [number, number, number][] = [
    [x0, y0, z0],
    [x0 + s, y0, z0],
    [x0 + s, y0 + s, z0],
    [x0, y0 + s, z0],
    [x0, y0, z0 + s],
    [x0 + s, y0, z0 + s],
    [x0 + s, y0 + s, z0 + s],
    [x0, y0 + s, z0 + s],
  ];
  // Each quad face as two triangles. Winding is irrelevant to connectivity.
  const quads = [
    [0, 1, 2, 3],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  const faces: OffFace[] = [];
  for (const [a, b, c, d] of quads) {
    faces.push({
      vertices: [a + offset, b + offset, c + offset],
      color: null,
    });
    faces.push({
      vertices: [a + offset, c + offset, d + offset],
      color: null,
    });
  }
  return { vertices, faces };
}

function merge(
  ...parts: { vertices: [number, number, number][]; faces: OffFace[] }[]
): ParsedOff {
  return {
    vertices: parts.flatMap((p) => p.vertices),
    faces: parts.flatMap((p) => p.faces),
  };
}

describe('analyzeMeshConnectivity', () => {
  it('reports zero solids for an empty mesh', () => {
    const result = analyzeMeshConnectivity({ vertices: [], faces: [] });
    expect(result).toEqual({
      solidCount: 0,
      floatingCount: 0,
      hasFloatingParts: false,
    });
  });

  it('counts a single connected box as one solid with nothing floating', () => {
    const result = analyzeMeshConnectivity(merge(box(0, 0, 0, 10, 0)));
    expect(result.solidCount).toBe(1);
    expect(result.hasFloatingParts).toBe(false);
  });

  it('treats two separate boxes both on the plate as a valid kit (no floating)', () => {
    // Two boxes side by side, both resting at z = 0.
    const result = analyzeMeshConnectivity(
      merge(box(0, 0, 0, 10, 0), box(20, 0, 0, 10, 8)),
    );
    expect(result.solidCount).toBe(2);
    expect(result.floatingCount).toBe(0);
    expect(result.hasFloatingParts).toBe(false);
  });

  it('flags a body hovering above the plate as floating', () => {
    // One box on the plate, a second lifted 20mm into the air above it.
    const result = analyzeMeshConnectivity(
      merge(box(0, 0, 0, 10, 0), box(0, 0, 30, 10, 8)),
    );
    expect(result.solidCount).toBe(2);
    expect(result.floatingCount).toBe(1);
    expect(result.hasFloatingParts).toBe(true);
  });

  it('does not flag bodies sharing a coplanar base when the model is offset off z=0', () => {
    // Both boxes start at z = 50; relative to the true lowest point they are
    // both on the (raised) plate, so neither floats.
    const result = analyzeMeshConnectivity(
      merge(box(0, 0, 50, 10, 0), box(20, 0, 50, 10, 8)),
    );
    expect(result.solidCount).toBe(2);
    expect(result.hasFloatingParts).toBe(false);
  });

  it('merges overlapping bodies that share welded vertices into one solid', () => {
    // Two boxes that share an exact coincident vertex set on a touching face
    // collapse to a single component (manifold weld), not a floating part.
    const lower = box(0, 0, 0, 10, 0);
    const upper = box(0, 0, 10, 10, 8);
    // Weld the upper box's bottom corners onto the lower box's top corners so
    // the two share vertices the way a unioned solid would.
    upper.vertices[0] = lower.vertices[4];
    upper.vertices[1] = lower.vertices[5];
    upper.vertices[2] = lower.vertices[6];
    upper.vertices[3] = lower.vertices[7];
    for (const face of upper.faces) {
      face.vertices = face.vertices.map((v) => {
        if (v === 8) return 4;
        if (v === 9) return 5;
        if (v === 10) return 6;
        if (v === 11) return 7;
        return v;
      }) as [number, number, number];
    }
    const result = analyzeMeshConnectivity(merge(lower, upper));
    expect(result.solidCount).toBe(1);
    expect(result.hasFloatingParts).toBe(false);
  });
});
