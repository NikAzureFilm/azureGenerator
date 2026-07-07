/**
 * Deterministic single-piece backstop for indexed triangle meshes (mm units).
 *
 * Image->3D generators routinely emit models with disconnected floating parts
 * that cannot 3D print in one pass. The generation prompt asks for a single
 * contiguous body, but that is a soft constraint; this is the hard guarantee.
 *
 * The mesh is split into connected components via union-find over vertices
 * joined through triangles — the same approach meshConnectivity.ts uses for the
 * OFF path, but reused here for the exporter's indexed-triangle geometry rather
 * than the OpenSCAD-specific parser output. Microscopic debris is discarded;
 * every remaining component is physically fused to the main body with a
 * connecting strut so the slicer sees one solid.
 */

import * as THREE from 'three';

type VectorTuple = [number, number, number];

type IndexedTriangle = { v1: number; v2: number; v3: number };

export type ConnectableGeometry<
  TTriangle extends IndexedTriangle = IndexedTriangle,
> = {
  vertices: VectorTuple[];
  triangles: TTriangle[];
};

export type ConnectComponentsResult<
  TTriangle extends IndexedTriangle = IndexedTriangle,
> = {
  vertices: VectorTuple[];
  triangles: TTriangle[];
  /** Triangles appended as connecting struts (indexes into the output array). */
  strutTriangleIndexes: number[];
  /** Components kept after debris removal. */
  componentCount: number;
  /** Components dropped as microscopic debris. */
  droppedComponentCount: number;
};

// A component whose bounding-box diagonal is under this, or that has fewer than
// the minimum triangle count, is debris the slicer would drop anyway.
const DEBRIS_DIAGONAL_MM = 1;
const DEBRIS_TRIANGLE_COUNT = 8;

// Connecting strut geometry: a short prism spanning the closest gap between two
// bodies, over-driven ~1mm into each so the overlap fuses in the slicer.
const STRUT_RADIUS_MM = 1.2;
const STRUT_SIDES = 6;
const STRUT_END_OVERDRIVE_MM = 1;
// Below this centroid gap the components already touch/overlap after welding,
// so a strut is redundant.
const TOUCHING_GAP_MM = 1e-3;
// Cap the candidate vertices sampled per component when searching for the
// closest pair, so a 500k-triangle mesh never triggers an O(n^2) blow-up.
const MAX_CLOSEST_PAIR_SAMPLES = 512;

/**
 * Connect all disconnected components of an indexed triangle mesh into one solid.
 *
 * Vertices/triangles are in millimeters. The largest component (by triangle
 * count) is treated as the main body; each other component is either dropped as
 * debris or fused to the already-connected set via a strut.
 */
export function connectMeshComponents<TTriangle extends IndexedTriangle>(
  geometry: ConnectableGeometry<TTriangle>,
  makeStrutTriangle: (triangle: IndexedTriangle) => TTriangle,
): ConnectComponentsResult<TTriangle> {
  const { vertices, triangles } = geometry;
  const unchangedResult = (
    componentCount: number,
    droppedComponentCount: number,
  ): ConnectComponentsResult<TTriangle> => ({
    vertices,
    triangles,
    strutTriangleIndexes: [],
    componentCount,
    droppedComponentCount,
  });
  if (triangles.length === 0 || vertices.length === 0) {
    return unchangedResult(0, 0);
  }

  const roots = findComponentRoots(vertices.length, triangles);
  const components = groupTrianglesByComponent(triangles, roots);
  if (components.length <= 1) {
    return unchangedResult(components.length, 0);
  }

  // Separate debris from real bodies; debris is dropped, not connected.
  const keptComponents: number[][] = [];
  let droppedComponentCount = 0;
  for (const component of components) {
    if (isDebrisComponent(component, triangles, vertices)) {
      droppedComponentCount += 1;
    } else {
      keptComponents.push(component);
    }
  }

  if (keptComponents.length === 0) {
    // Everything was debris — keep the original geometry rather than emit an
    // empty mesh; the caller's safeguards still apply.
    return unchangedResult(0, droppedComponentCount);
  }

  // Largest kept component (by triangle count) is the main body.
  keptComponents.sort((a, b) => b.length - a.length);

  const outputVertices = vertices.slice();
  const outputTriangles = triangles.slice();
  const strutTriangleIndexes: number[] = [];

  // Vertices already part of the connected set, sampled for closest-pair search.
  const connectedVertexIndexes = collectComponentVertexIndexes(
    keptComponents[0],
    triangles,
  );

  for (
    let componentIndex = 1;
    componentIndex < keptComponents.length;
    componentIndex += 1
  ) {
    const componentVertexIndexes = collectComponentVertexIndexes(
      keptComponents[componentIndex],
      triangles,
    );

    const pair = findClosestVertexPair(
      connectedVertexIndexes,
      componentVertexIndexes,
      vertices,
    );

    // Already touching after welding — the weld unified them, no strut needed.
    if (pair && pair.distance > TOUCHING_GAP_MM) {
      appendStrut(
        outputVertices,
        outputTriangles,
        strutTriangleIndexes,
        pair.connectedIndex,
        pair.componentIndex,
        makeStrutTriangle,
      );
    }

    // The component is now part of the connected set for subsequent components.
    for (const index of componentVertexIndexes) {
      connectedVertexIndexes.push(index);
    }
  }

  return {
    vertices: outputVertices,
    triangles: outputTriangles,
    strutTriangleIndexes,
    componentCount: keptComponents.length,
    droppedComponentCount,
  };
}

function findComponentRoots(
  vertexCount: number,
  triangles: IndexedTriangle[],
): Int32Array {
  const parent = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i += 1) {
    parent[i] = i;
  }

  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (const triangle of triangles) {
    union(triangle.v1, triangle.v2);
    union(triangle.v2, triangle.v3);
  }

  const roots = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i += 1) {
    roots[i] = find(i);
  }
  return roots;
}

function groupTrianglesByComponent(
  triangles: IndexedTriangle[],
  roots: Int32Array,
): number[][] {
  const componentsByRoot = new Map<number, number[]>();
  triangles.forEach((triangle, triangleIndex) => {
    const root = roots[triangle.v1];
    const component = componentsByRoot.get(root) ?? [];
    component.push(triangleIndex);
    componentsByRoot.set(root, component);
  });
  return [...componentsByRoot.values()];
}

function collectComponentVertexIndexes(
  triangleIndexes: number[],
  triangles: IndexedTriangle[],
): number[] {
  const vertexIndexes = new Set<number>();
  for (const triangleIndex of triangleIndexes) {
    const triangle = triangles[triangleIndex];
    vertexIndexes.add(triangle.v1);
    vertexIndexes.add(triangle.v2);
    vertexIndexes.add(triangle.v3);
  }
  return [...vertexIndexes];
}

function isDebrisComponent(
  triangleIndexes: number[],
  triangles: IndexedTriangle[],
  vertices: VectorTuple[],
): boolean {
  if (triangleIndexes.length < DEBRIS_TRIANGLE_COUNT) {
    return true;
  }
  return (
    getComponentDiagonal(triangleIndexes, triangles, vertices) <
    DEBRIS_DIAGONAL_MM
  );
}

function getComponentDiagonal(
  triangleIndexes: number[],
  triangles: IndexedTriangle[],
  vertices: VectorTuple[],
): number {
  const min: VectorTuple = [Infinity, Infinity, Infinity];
  const max: VectorTuple = [-Infinity, -Infinity, -Infinity];
  for (const triangleIndex of triangleIndexes) {
    const triangle = triangles[triangleIndex];
    for (const vertexIndex of [triangle.v1, triangle.v2, triangle.v3]) {
      const vertex = vertices[vertexIndex];
      for (let axis = 0; axis < 3; axis += 1) {
        if (vertex[axis] < min[axis]) min[axis] = vertex[axis];
        if (vertex[axis] > max[axis]) max[axis] = vertex[axis];
      }
    }
  }
  const dx = max[0] - min[0];
  const dy = max[1] - min[1];
  const dz = max[2] - min[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Subsample large vertex sets to a fixed budget so the closest-pair search stays
// bounded regardless of mesh size; the strut only needs an approximate closest
// pair since it over-drives into both bodies.
function subsampleVertexIndexes(vertexIndexes: number[]): number[] {
  if (vertexIndexes.length <= MAX_CLOSEST_PAIR_SAMPLES) {
    return vertexIndexes;
  }
  const stride = Math.ceil(vertexIndexes.length / MAX_CLOSEST_PAIR_SAMPLES);
  const sampled: number[] = [];
  for (let i = 0; i < vertexIndexes.length; i += stride) {
    sampled.push(vertexIndexes[i]);
  }
  return sampled;
}

function findClosestVertexPair(
  connectedVertexIndexes: number[],
  componentVertexIndexes: number[],
  vertices: VectorTuple[],
): { connectedIndex: number; componentIndex: number; distance: number } | null {
  const connectedSamples = subsampleVertexIndexes(connectedVertexIndexes);
  const componentSamples = subsampleVertexIndexes(componentVertexIndexes);
  if (connectedSamples.length === 0 || componentSamples.length === 0) {
    return null;
  }

  let best: {
    connectedIndex: number;
    componentIndex: number;
    distanceSquared: number;
  } | null = null;
  for (const connectedIndex of connectedSamples) {
    const connectedVertex = vertices[connectedIndex];
    for (const componentIndex of componentSamples) {
      const componentVertex = vertices[componentIndex];
      const dx = connectedVertex[0] - componentVertex[0];
      const dy = connectedVertex[1] - componentVertex[1];
      const dz = connectedVertex[2] - componentVertex[2];
      const distanceSquared = dx * dx + dy * dy + dz * dz;
      if (!best || distanceSquared < best.distanceSquared) {
        best = { connectedIndex, componentIndex, distanceSquared };
      }
    }
  }

  return best
    ? {
        connectedIndex: best.connectedIndex,
        componentIndex: best.componentIndex,
        distance: Math.sqrt(best.distanceSquared),
      }
    : null;
}

// Build a closed prism between the two closest body vertices, over-driving each
// cap ~1mm past its endpoint into the body so the strut overlaps both solids and
// fuses in the slicer. The cap fans reuse the actual body vertex indices, so the
// strut also shares a vertex with each body — a plain vertex union-find then
// sees one connected component, not three.
function appendStrut<TTriangle extends IndexedTriangle>(
  outputVertices: VectorTuple[],
  outputTriangles: TTriangle[],
  strutTriangleIndexes: number[],
  startVertexIndex: number,
  endVertexIndex: number,
  makeStrutTriangle: (triangle: IndexedTriangle) => TTriangle,
): void {
  const start = outputVertices[startVertexIndex];
  const end = outputVertices[endVertexIndex];
  const startVec = new THREE.Vector3(start[0], start[1], start[2]);
  const endVec = new THREE.Vector3(end[0], end[1], end[2]);
  const axis = new THREE.Vector3().subVectors(endVec, startVec);
  const length = axis.length();
  if (length <= 0) {
    return;
  }
  axis.normalize();

  const overdrive = axis.clone().multiplyScalar(STRUT_END_OVERDRIVE_MM);
  const capStart = startVec.clone().sub(overdrive);
  const capEnd = endVec.clone().add(overdrive);

  // Two axis-perpendicular unit vectors spanning the prism cross-section.
  const reference =
    Math.abs(axis.x) < 0.9
      ? new THREE.Vector3(1, 0, 0)
      : new THREE.Vector3(0, 1, 0);
  const radial = new THREE.Vector3().crossVectors(axis, reference).normalize();
  const binormal = new THREE.Vector3().crossVectors(axis, radial).normalize();

  const ringStart: number[] = [];
  const ringEnd: number[] = [];
  for (let side = 0; side < STRUT_SIDES; side += 1) {
    const angle = (side / STRUT_SIDES) * Math.PI * 2;
    const offset = radial
      .clone()
      .multiplyScalar(Math.cos(angle) * STRUT_RADIUS_MM)
      .add(binormal.clone().multiplyScalar(Math.sin(angle) * STRUT_RADIUS_MM));

    const startPoint = capStart.clone().add(offset);
    const endPoint = capEnd.clone().add(offset);
    ringStart.push(outputVertices.length);
    outputVertices.push([startPoint.x, startPoint.y, startPoint.z]);
    ringEnd.push(outputVertices.length);
    outputVertices.push([endPoint.x, endPoint.y, endPoint.z]);
  }

  // Cap fans hub on the real body vertices so the strut is vertex-connected to
  // both bodies (not merely overlapping them).
  const startCenterIndex = startVertexIndex;
  const endCenterIndex = endVertexIndex;

  const pushTriangle = (v1: number, v2: number, v3: number) => {
    strutTriangleIndexes.push(outputTriangles.length);
    outputTriangles.push(makeStrutTriangle({ v1, v2, v3 }));
  };

  for (let side = 0; side < STRUT_SIDES; side += 1) {
    const next = (side + 1) % STRUT_SIDES;
    // Side wall quad -> two triangles.
    pushTriangle(ringStart[side], ringEnd[side], ringEnd[next]);
    pushTriangle(ringStart[side], ringEnd[next], ringStart[next]);
    // End caps as triangle fans hubbed on the body vertices.
    pushTriangle(startCenterIndex, ringStart[next], ringStart[side]);
    pushTriangle(endCenterIndex, ringEnd[side], ringEnd[next]);
  }
}
