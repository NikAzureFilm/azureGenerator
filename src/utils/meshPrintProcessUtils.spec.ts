import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { GLTF } from 'three-stdlib';
import {
  processUserModelForDownload,
  processUserModelForPrint,
} from './meshPrintProcessUtils';

// Build a minimal GLTF-like wrapper around a single box mesh whose bounding box
// is `size` scene units on every axis. Only `.scene` is read by the processor.
function boxGltf(size: number): GLTF {
  const geometry = new THREE.BoxGeometry(size, size, size);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  const scene = new THREE.Scene();
  scene.add(mesh);
  return { scene } as unknown as GLTF;
}

// Two separate boxes with a gap between them, as one GLTF scene.
function twoBoxGltf(size: number, gap: number): GLTF {
  const scene = new THREE.Scene();
  const left = new THREE.Mesh(
    new THREE.BoxGeometry(size, size, size),
    new THREE.MeshStandardMaterial(),
  );
  left.position.set(0, 0, 0);
  const right = new THREE.Mesh(
    new THREE.BoxGeometry(size, size, size),
    new THREE.MeshStandardMaterial(),
  );
  right.position.set(size + gap, 0, 0);
  scene.add(left, right);
  return { scene } as unknown as GLTF;
}

function smallestFinalDimension(scene: THREE.Scene): number {
  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3();
  box.getSize(size);
  return Math.min(size.x, size.y, size.z);
}

// Parse a binary STL blob into triangles of world-space vertex corners.
async function parseBinaryStlTriangles(
  file: File,
): Promise<[number, number, number][][]> {
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  const triangleCount = view.getUint32(80, true);
  const triangles: [number, number, number][][] = [];
  let offset = 84;
  for (let i = 0; i < triangleCount; i += 1) {
    offset += 12; // skip the per-facet normal
    const corners: [number, number, number][] = [];
    for (let corner = 0; corner < 3; corner += 1) {
      corners.push([
        view.getFloat32(offset, true),
        view.getFloat32(offset + 4, true),
        view.getFloat32(offset + 8, true),
      ]);
      offset += 12;
    }
    triangles.push(corners);
    offset += 2; // attribute byte count
  }
  return triangles;
}

// Count connected components of an STL (no shared indices) by welding vertices
// on rounded coordinates, then union-find over triangle corners.
function countStlComponents(triangles: [number, number, number][][]): number {
  const tolerance = 0.05;
  const keyToIndex = new Map<string, number>();
  const indexOf = (v: [number, number, number]) => {
    const key = v.map((value) => Math.round(value / tolerance)).join(',');
    let index = keyToIndex.get(key);
    if (index === undefined) {
      index = keyToIndex.size;
      keyToIndex.set(key, index);
    }
    return index;
  };
  const welded = triangles.map(
    (corners) => corners.map(indexOf) as [number, number, number],
  );

  const parent = Array.from({ length: keyToIndex.size }, (_unused, i) => i);
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
  for (const [a, b, c] of welded) {
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

describe('processUserModelForDownload scaling (1 scene unit = 1 mm)', () => {
  it('scales a 1-unit model up to ~100mm (100-140 with multipliers)', async () => {
    const scene = await processUserModelForDownload(boxGltf(1));
    const smallest = smallestFinalDimension(scene);
    expect(smallest).toBeGreaterThanOrEqual(100);
    expect(smallest).toBeLessThanOrEqual(140);
  });

  it('does not upscale a model that is already large (1500 units)', async () => {
    const scene = await processUserModelForDownload(boxGltf(1500));
    const smallest = smallestFinalDimension(scene);
    // "Already large" branch caps scale at <= 1.0, so the model is never grown
    // past its authored size (it may still be trimmed toward the 100mm floor).
    expect(smallest).toBeLessThanOrEqual(1500 + 1);
    expect(smallest).toBeGreaterThanOrEqual(100);
  });
});

describe('processUserModelForPrint STL fusion', () => {
  it('exports two separated bodies as a single connected STL solid', async () => {
    // Two 10-unit boxes with a 5-unit gap; the scale fix keeps them mm-scale.
    const file = await processUserModelForPrint(
      twoBoxGltf(10, 5),
      () => 'two-body',
    );
    expect(file.name).toBe('two-body_PRINTABLE.stl');

    const triangles = await parseBinaryStlTriangles(file);
    expect(triangles.length).toBeGreaterThan(0);
    // Without the connecting strut this would weld into 2 components.
    expect(countStlComponents(triangles)).toBe(1);
  });
});
