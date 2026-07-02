/**
 * Connected-component analysis for a parsed OFF mesh.
 *
 * The OpenSCAD code-generation prompt asks for models that print either as one
 * connected piece or as a kit of separate parts resting flat on the build
 * plate. This is the deterministic backstop for that intent: it counts the
 * disconnected solid bodies in the compiled mesh and flags any that float
 * above the plate (a body lifted into mid-air with nothing beneath it — the
 * classic "floating part" defect).
 *
 * Why this works: OpenSCAD's manifold backend welds coincident vertices, so
 * two bodies that genuinely overlap (a unioned single piece) share vertices
 * and collapse into one component, while bodies separated by an air gap have
 * disjoint vertices and fall into different components. A union-find over the
 * triangle vertices therefore recovers the true solid count exactly.
 *
 * Floating vs. a legitimate kit: the "build plate" is the model's lowest point
 * (a slicer drops the whole model onto the bed). A body resting on the plate
 * has its minimum Z at that level; a floating body sits a clear gap above it.
 * A valid multi-part kit has every body on the plate, so floatingCount === 0.
 */

import type { ParsedOff } from './offParser';

export type MeshConnectivityResult = {
  /** Number of disconnected solid bodies in the mesh. */
  solidCount: number;
  /**
   * Bodies hovering above the build plate (lowest point a meaningful gap
   * above the model's lowest point). These are the "floating part" defect.
   */
  floatingCount: number;
  /** Convenience flag: floatingCount > 0. */
  hasFloatingParts: boolean;
};

const EMPTY: MeshConnectivityResult = {
  solidCount: 0,
  floatingCount: 0,
  hasFloatingParts: false,
};

// A body counts as "floating" only when its lowest point clears the plate by
// more than this gap. Take the larger of an absolute floor (so tiny models
// don't trip on rounding) and a fraction of the model's height (so the
// threshold scales with large models). Floating gaps in practice are several
// millimetres, well above either bound.
const ABSOLUTE_GAP_MM = 0.5;
const RELATIVE_GAP_FRACTION = 0.02;

export function analyzeMeshConnectivity(
  parsed: ParsedOff,
): MeshConnectivityResult {
  const { vertices, faces } = parsed;
  if (faces.length === 0 || vertices.length === 0) return EMPTY;

  // --- Union-find over vertex indices, joined through each triangle. ---
  const parent = new Int32Array(vertices.length);
  for (let i = 0; i < vertices.length; i++) parent[i] = i;

  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    // Path compression keeps repeated lookups near O(1).
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

  // Only vertices touched by a face belong to a solid; unreferenced vertices
  // would otherwise show up as phantom single-point components.
  const used = new Uint8Array(vertices.length);
  for (const face of faces) {
    const [a, b, c] = face.vertices;
    used[a] = used[b] = used[c] = 1;
    union(a, b);
    union(b, c);
  }

  // --- Per-component bounds (min Z) plus the global plate level. ---
  let globalMinZ = Infinity;
  let globalMaxZ = -Infinity;
  const componentMinZ = new Map<number, number>();

  for (let i = 0; i < vertices.length; i++) {
    if (!used[i]) continue;
    const z = vertices[i][2];
    if (!Number.isFinite(z)) continue;
    if (z < globalMinZ) globalMinZ = z;
    if (z > globalMaxZ) globalMaxZ = z;

    const root = find(i);
    const prev = componentMinZ.get(root);
    if (prev === undefined || z < prev) componentMinZ.set(root, z);
  }

  const solidCount = componentMinZ.size;
  if (solidCount <= 1 || !Number.isFinite(globalMinZ)) {
    return { solidCount, floatingCount: 0, hasFloatingParts: false };
  }

  const zExtent = globalMaxZ - globalMinZ;
  const gapThreshold = Math.max(
    ABSOLUTE_GAP_MM,
    RELATIVE_GAP_FRACTION * zExtent,
  );

  let floatingCount = 0;
  for (const minZ of componentMinZ.values()) {
    if (minZ - globalMinZ > gapThreshold) floatingCount++;
  }

  return { solidCount, floatingCount, hasFloatingParts: floatingCount > 0 };
}
