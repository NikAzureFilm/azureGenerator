/**
 * Body-count topology analysis for a compiled model's mesh.
 *
 * The self-inspection loop shows the reviewer a 7-view render of what the
 * OpenSCAD actually produced. A silent failure mode is a part that should be
 * attached but prints as a separate floating body — hard to see in an
 * untextured grey render. This module recovers the number of distinct solid
 * bodies so the render can color them apart (see renderInspectionSheet), making
 * a disconnection visible to the one existing reviewer at ZERO extra model
 * calls.
 *
 * Method:
 *  1. Vertex-weld: STL geometry is non-indexed (3 loose vertices per triangle),
 *     so coincident corners are welded on a grid whose cell size is a small
 *     fraction of the bounding-box diagonal. OpenSCAD's manifold backend emits
 *     bit-coincident shared vertices, so any tolerance welds them; the tolerance
 *     only absorbs float noise.
 *  2. Union-find over welded vertices, joined through each triangle, groups the
 *     triangles into SHELLS (maximal vertex-connected surfaces).
 *  3. Containment/overlap merge: two shells belong to the same BODY when one's
 *     centroid lies inside the other (a sealed cavity's inner shell, or two
 *     interpenetrating solids that share material). A bbox pre-filter avoids the
 *     ray test on shells that can't possibly contain one another.
 *
 * Never throws into the render path: any empty, degenerate, or unexpected input
 * falls back to a single body.
 */

import type { BufferGeometry } from 'three';

export type MeshTopology = {
  /** Number of distinct solid bodies (>= 1). */
  bodyCount: number;
  /**
   * Body index (0..bodyCount-1) for each triangle, in geometry triangle order.
   * Length equals the triangle count. STL triangle order is not body-contiguous,
   * so this per-triangle map — not a start/end range — is what the renderer needs
   * to color each body.
   */
  triangleBodies: Uint32Array;
  /** Triangle count per body, index-aligned with the body indices above. */
  bodyTriangleCounts: number[];
};

// Weld grid cell = this fraction of the bbox diagonal. Small enough to keep
// genuinely distinct corners apart, large enough to absorb float noise.
const WELD_TOLERANCE_FRACTION = 1e-4;

// Above this shell count, skip the pairwise containment merge and treat each
// shell as its own body. Real inspection meshes have a handful of shells; this
// only bounds pathological inputs so analyze() stays well under 1s.
const MAX_SHELLS_FOR_CONTAINMENT = 64;

// A fixed, non-axis-aligned ray direction for the point-in-shell parity test,
// so a ray fired from a body centroid doesn't graze coincident axis-aligned
// faces/edges of a box and miscount crossings.
const RAY_DX = 0.57735026918962;
const RAY_DY = 0.556776436283;
const RAY_DZ = 0.59764301234567;

function singleBodyFallback(triangleCount: number): MeshTopology {
  const count = Math.max(0, triangleCount);
  return {
    bodyCount: 1,
    triangleBodies: new Uint32Array(count),
    bodyTriangleCounts: [count],
  };
}

/**
 * Analyze a compiled mesh geometry into its distinct solid bodies. Pure and
 * defensive: returns a single-body fallback for any empty/degenerate/unexpected
 * input rather than throwing.
 */
export function analyze(geometry: BufferGeometry): MeshTopology {
  try {
    return analyzeUnsafe(geometry);
  } catch {
    const position = geometry?.getAttribute?.('position');
    const triCount = position ? Math.floor(position.count / 3) : 0;
    return singleBodyFallback(triCount);
  }
}

function analyzeUnsafe(geometry: BufferGeometry): MeshTopology {
  const position = geometry.getAttribute('position');
  if (!position || position.itemSize !== 3 || position.count < 3) {
    return singleBodyFallback(position ? Math.floor(position.count / 3) : 0);
  }
  const positions = position.array as ArrayLike<number>;
  const vertexCount = position.count;
  const triangleCount = Math.floor(vertexCount / 3);
  if (triangleCount === 0) return singleBodyFallback(0);

  // --- Bounding box + weld tolerance. ---
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return singleBodyFallback(triangleCount);
    }
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const dx = maxX - minX;
  const dy = maxY - minY;
  const dz = maxZ - minZ;
  const diag = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const tol = diag > 0 ? diag * WELD_TOLERANCE_FRACTION : 0;
  const invTol = tol > 0 ? 1 / tol : 0;
  const quantize = (v: number): number =>
    tol > 0 ? Math.round(v * invTol) : v;

  // --- Vertex weld: quantized position → weld index. ---
  const weldOf = new Int32Array(vertexCount);
  const weldMap = new Map<string, number>();
  let weldCount = 0;
  for (let i = 0; i < vertexCount; i++) {
    const key = `${quantize(positions[i * 3])},${quantize(
      positions[i * 3 + 1],
    )},${quantize(positions[i * 3 + 2])}`;
    let w = weldMap.get(key);
    if (w === undefined) {
      w = weldCount++;
      weldMap.set(key, w);
    }
    weldOf[i] = w;
  }

  // --- Union-find over welds, joined through each triangle. ---
  const parent = new Int32Array(weldCount);
  for (let i = 0; i < weldCount; i++) parent[i] = i;
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
  for (let t = 0; t < triangleCount; t++) {
    const a = weldOf[t * 3];
    const b = weldOf[t * 3 + 1];
    const c = weldOf[t * 3 + 2];
    union(a, b);
    union(b, c);
  }

  // --- Shell id per triangle. ---
  const shellIdOfRoot = new Map<number, number>();
  const triangleShell = new Int32Array(triangleCount);
  let shellCount = 0;
  for (let t = 0; t < triangleCount; t++) {
    const root = find(weldOf[t * 3]);
    let sid = shellIdOfRoot.get(root);
    if (sid === undefined) {
      sid = shellCount++;
      shellIdOfRoot.set(root, sid);
    }
    triangleShell[t] = sid;
  }
  if (shellCount <= 1) return singleBodyFallback(triangleCount);

  // --- Per-shell bbox, centroid, and triangle list. ---
  const shellMin = new Float64Array(shellCount * 3).fill(Infinity);
  const shellMax = new Float64Array(shellCount * 3).fill(-Infinity);
  const centroidSum = new Float64Array(shellCount * 3);
  const shellTriIndices: number[][] = Array.from(
    { length: shellCount },
    () => [],
  );
  for (let t = 0; t < triangleCount; t++) {
    const sid = triangleShell[t];
    shellTriIndices[sid].push(t);
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let k = 0; k < 3; k++) {
      const base = (t * 3 + k) * 3;
      const x = positions[base];
      const y = positions[base + 1];
      const z = positions[base + 2];
      if (x < shellMin[sid * 3]) shellMin[sid * 3] = x;
      if (y < shellMin[sid * 3 + 1]) shellMin[sid * 3 + 1] = y;
      if (z < shellMin[sid * 3 + 2]) shellMin[sid * 3 + 2] = z;
      if (x > shellMax[sid * 3]) shellMax[sid * 3] = x;
      if (y > shellMax[sid * 3 + 1]) shellMax[sid * 3 + 1] = y;
      if (z > shellMax[sid * 3 + 2]) shellMax[sid * 3 + 2] = z;
      cx += x;
      cy += y;
      cz += z;
    }
    centroidSum[sid * 3] += cx / 3;
    centroidSum[sid * 3 + 1] += cy / 3;
    centroidSum[sid * 3 + 2] += cz / 3;
  }
  const centroid = new Float64Array(shellCount * 3);
  for (let s = 0; s < shellCount; s++) {
    const n = shellTriIndices[s].length || 1;
    centroid[s * 3] = centroidSum[s * 3] / n;
    centroid[s * 3 + 1] = centroidSum[s * 3 + 1] / n;
    centroid[s * 3 + 2] = centroidSum[s * 3 + 2] / n;
  }

  // --- Merge shells that share solid volume into bodies. ---
  const shellParent = new Int32Array(shellCount);
  for (let s = 0; s < shellCount; s++) shellParent[s] = s;
  const findShell = (x: number): number => {
    let root = x;
    while (shellParent[root] !== root) root = shellParent[root];
    while (shellParent[x] !== root) {
      const next = shellParent[x];
      shellParent[x] = root;
      x = next;
    }
    return root;
  };
  if (shellCount <= MAX_SHELLS_FOR_CONTAINMENT) {
    for (let i = 0; i < shellCount; i++) {
      const px = centroid[i * 3];
      const py = centroid[i * 3 + 1];
      const pz = centroid[i * 3 + 2];
      for (let j = 0; j < shellCount; j++) {
        if (j === i || findShell(i) === findShell(j)) continue;
        // bbox pre-filter: i's centroid must lie within j's box to be inside j.
        if (
          px < shellMin[j * 3] ||
          px > shellMax[j * 3] ||
          py < shellMin[j * 3 + 1] ||
          py > shellMax[j * 3 + 1] ||
          pz < shellMin[j * 3 + 2] ||
          pz > shellMax[j * 3 + 2]
        ) {
          continue;
        }
        if (pointInsideShell(px, py, pz, positions, shellTriIndices[j])) {
          union2(shellParent, findShell, i, j);
        }
      }
    }
  }

  // --- Bodies = connected shell components. ---
  const bodyIdOfShellRoot = new Map<number, number>();
  let bodyCount = 0;
  const bodyOfShell = new Int32Array(shellCount);
  for (let s = 0; s < shellCount; s++) {
    const root = findShell(s);
    let bid = bodyIdOfShellRoot.get(root);
    if (bid === undefined) {
      bid = bodyCount++;
      bodyIdOfShellRoot.set(root, bid);
    }
    bodyOfShell[s] = bid;
  }

  const triangleBodies = new Uint32Array(triangleCount);
  const bodyTriangleCounts = new Array<number>(bodyCount).fill(0);
  for (let t = 0; t < triangleCount; t++) {
    const bid = bodyOfShell[triangleShell[t]];
    triangleBodies[t] = bid;
    bodyTriangleCounts[bid]++;
  }
  return { bodyCount, triangleBodies, bodyTriangleCounts };
}

function union2(
  shellParent: Int32Array,
  findShell: (x: number) => number,
  a: number,
  b: number,
): void {
  const ra = findShell(a);
  const rb = findShell(b);
  if (ra !== rb) shellParent[ra] = rb;
}

// Odd-parity point-in-shell test: fire a fixed skewed ray from the point and
// count Möller–Trumbore intersections with the shell's triangles. Odd => inside.
function pointInsideShell(
  px: number,
  py: number,
  pz: number,
  positions: ArrayLike<number>,
  triangles: number[],
): boolean {
  let crossings = 0;
  const EPS = 1e-9;
  for (let n = 0; n < triangles.length; n++) {
    const t = triangles[n];
    const a = t * 9;
    const ax = positions[a];
    const ay = positions[a + 1];
    const az = positions[a + 2];
    const bx = positions[a + 3];
    const by = positions[a + 4];
    const bz = positions[a + 5];
    const cx = positions[a + 6];
    const cy = positions[a + 7];
    const cz = positions[a + 8];
    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;
    // pvec = dir × e2
    const pvx = RAY_DY * e2z - RAY_DZ * e2y;
    const pvy = RAY_DZ * e2x - RAY_DX * e2z;
    const pvz = RAY_DX * e2y - RAY_DY * e2x;
    const det = e1x * pvx + e1y * pvy + e1z * pvz;
    if (det > -EPS && det < EPS) continue; // ray parallel to triangle
    const inv = 1 / det;
    const tvx = px - ax;
    const tvy = py - ay;
    const tvz = pz - az;
    const u = (tvx * pvx + tvy * pvy + tvz * pvz) * inv;
    if (u < 0 || u > 1) continue;
    // qvec = tvec × e1
    const qvx = tvy * e1z - tvz * e1y;
    const qvy = tvz * e1x - tvx * e1z;
    const qvz = tvx * e1y - tvy * e1x;
    const v = (RAY_DX * qvx + RAY_DY * qvy + RAY_DZ * qvz) * inv;
    if (v < 0 || u + v > 1) continue;
    const dist = (e2x * qvx + e2y * qvy + e2z * qvz) * inv;
    if (dist > EPS) crossings++;
  }
  return (crossings & 1) === 1;
}
