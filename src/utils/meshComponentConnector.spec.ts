import { describe, it, expect } from 'vitest';
import {
  connectMeshComponents,
  type ConnectableGeometry,
} from './meshComponentConnector';

type Vec = [number, number, number];
type Tri = { v1: number; v2: number; v3: number };

// Axis-aligned box (12 triangles, 8 shared vertices) with its min corner at
// (x0, y0, z0). Returns geometry local to itself; merge() offsets indices so
// several boxes can share one vertex array as distinct components.
function box(x0: number, y0: number, z0: number, size: number) {
  const s = size;
  const vertices: Vec[] = [
    [x0, y0, z0],
    [x0 + s, y0, z0],
    [x0 + s, y0 + s, z0],
    [x0, y0 + s, z0],
    [x0, y0, z0 + s],
    [x0 + s, y0, z0 + s],
    [x0 + s, y0 + s, z0 + s],
    [x0, y0 + s, z0 + s],
  ];
  const quads = [
    [0, 1, 2, 3],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  const triangles: Tri[] = [];
  for (const [a, b, c, d] of quads) {
    triangles.push({ v1: a, v2: b, v3: c });
    triangles.push({ v1: a, v2: c, v3: d });
  }
  return { vertices, triangles };
}

function merge(
  ...parts: { vertices: Vec[]; triangles: Tri[] }[]
): ConnectableGeometry<Tri> {
  const vertices: Vec[] = [];
  const triangles: Tri[] = [];
  for (const part of parts) {
    const offset = vertices.length;
    vertices.push(...part.vertices);
    for (const triangle of part.triangles) {
      triangles.push({
        v1: triangle.v1 + offset,
        v2: triangle.v2 + offset,
        v3: triangle.v3 + offset,
      });
    }
  }
  return { vertices, triangles };
}

// Count connected components of a triangle mesh via union-find over vertices,
// welding coincident vertices first (struts overlap the bodies but don't share
// vertex indices, so unwelded counts would over-report).
function countComponents(geometry: ConnectableGeometry<Tri>): number {
  const weldTolerance = 1e-4;
  const keyToIndex = new Map<string, number>();
  const remap = geometry.vertices.map((vertex) => {
    const key = vertex
      .map((value) => Math.round(value / weldTolerance))
      .join(',');
    let index = keyToIndex.get(key);
    if (index === undefined) {
      index = keyToIndex.size;
      keyToIndex.set(key, index);
    }
    return index;
  });

  const count = keyToIndex.size;
  const parent = Array.from({ length: count }, (_unused, index) => index);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const used = new Set<number>();
  for (const triangle of geometry.triangles) {
    const a = remap[triangle.v1];
    const b = remap[triangle.v2];
    const c = remap[triangle.v3];
    used.add(a);
    used.add(b);
    used.add(c);
    union(a, b);
    union(b, c);
  }

  const roots = new Set<number>();
  for (const index of used) roots.add(find(index));
  return roots.size;
}

const identity = (triangle: Tri): Tri => triangle;

describe('connectMeshComponents', () => {
  it('fuses two separated cubes into a single connected component with a strut', () => {
    // Two 10mm cubes with a 15mm air gap between them.
    const geometry = merge(box(0, 0, 0, 10), box(25, 0, 0, 10));
    expect(countComponents(geometry)).toBe(2);

    const result = connectMeshComponents(geometry, identity);

    expect(result.componentCount).toBe(2);
    expect(result.droppedComponentCount).toBe(0);
    expect(result.strutTriangleIndexes.length).toBeGreaterThan(0);
    expect(countComponents(result)).toBe(1);
  });

  it('drops microscopic debris instead of connecting it', () => {
    // A real 10mm body plus a 0.5mm fragment (also under the triangle-count floor).
    const geometry = merge(box(0, 0, 0, 10), box(50, 0, 0, 0.5));

    const result = connectMeshComponents(geometry, identity);

    expect(result.componentCount).toBe(1);
    expect(result.droppedComponentCount).toBe(1);
    // No strut: the debris was discarded, not bridged.
    expect(result.strutTriangleIndexes).toHaveLength(0);
  });

  it('adds no strut when components already touch after welding', () => {
    // Two cubes sharing a face (touching), so the weld already unifies them.
    const geometry = merge(box(0, 0, 0, 10), box(10, 0, 0, 10));

    const result = connectMeshComponents(geometry, identity);

    expect(result.strutTriangleIndexes).toHaveLength(0);
  });

  it('returns geometry unchanged for a single-component mesh', () => {
    const geometry = box(0, 0, 0, 10);

    const result = connectMeshComponents(geometry, identity);

    expect(result.strutTriangleIndexes).toHaveLength(0);
    expect(result.triangles).toHaveLength(geometry.triangles.length);
  });
});
