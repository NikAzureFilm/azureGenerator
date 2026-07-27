/**
 * Planar "flat bottom" cut (manifold-3d).
 *
 * Trims everything below a horizontal plane near the model's underside and caps
 * the opening, so the model rests on one flat face — the geometric half of the
 * flat-bottom option (the prompt half lives in `shared/flatBottom.ts`).
 *
 * Why manifold rather than clipping triangles by hand: `trimByPlane` returns a
 * closed, watertight solid including the cap, for any cross-section — several
 * separate contours (a fish's belly plus its fins) or a contour with holes (a
 * cup's rim) — which ad-hoc capping gets wrong exactly where a print fails.
 *
 * Vertex properties beyond xyz (uv, colour) ride through the trim: manifold
 * interpolates them along the cut, so a textured mesh stays textured. Callers
 * therefore pass geometry in manifold's own layout (`numProp`-strided
 * `vertProperties`), which `flatBottomScene.ts` builds from a THREE scene.
 *
 * Importable from both the worker and node tests: the WASM instance is injected
 * (`flatBottomCut(wasm, …)`), reusing `loadManifold()` from flexiToyBuild. Every
 * intermediate Manifold is `.delete()`d.
 *
 * All lengths are FRACTIONS of the model's height, never mm — the cut runs on
 * raw model units before the export pipeline scales the scene to print size.
 */

import type { ManifoldToplevel, Manifold, Vec3 } from 'manifold-3d';
import { buildManifoldFromMesh } from './flexiToyBuild.ts';

export const FLAT_BOTTOM = {
  /**
   * Never remove more than this fraction of the model's height. A flat bottom
   * is meant to give the print a footing, not to amputate a figurine's legs.
   */
  MAX_CUT_FRACTION: 0.08,
  /**
   * Cut depths tried in order (fractions of height). The shallowest one that
   * produces a usable contact face wins, so an already-flat-ish model loses
   * almost nothing.
   */
  CANDIDATE_FRACTIONS: [
    0.0025, 0.005, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08,
  ],
  /**
   * A contact face counts as "usable" at this fraction of the model's
   * footprint (its bounding-box area seen from below).
   *
   * Tuned against measurements, not intuition: for a rounded body the contact
   * area grows almost linearly with cut depth, and the ratio at a given depth
   * is near-identical across shapes (a sphere, an egg and a fish-shaped
   * ellipsoid all read ~3% of footprint at 1% depth, ~15% at 5%, ~23% at 8%).
   * A 1.5% target — the obvious-looking choice — therefore stops at half a
   * percent of height, which is a knife-edge sliver, not a flat bottom. 15%
   * lands the cut at ~5% of height, which is a visibly sliced-flat underside
   * roughly 40% as wide as the body: the reference the option is named after.
   */
  TARGET_CONTACT_FRACTION: 0.15,
  /**
   * For shapes that never reach the target inside MAX_CUT_FRACTION — a
   * figurine standing on two small feet, say, where the contact area plateaus
   * as soon as the soles are flat — cutting all the way to the cap would saw
   * through its ankles for no gain. Instead take the shallowest depth that
   * already achieves this fraction of the best area on offer, i.e. the point
   * where cutting deeper stops paying.
   */
  DIMINISHING_RETURNS_FRACTION: 0.6,
  /** Vertices within this fraction of the height count as "on the plane". */
  PLANE_EPSILON_FRACTION: 1e-4,
  /** Below this the model is degenerate (zero height) and is left alone. */
  MIN_HEIGHT: 1e-6,
  /**
   * The manifold repair ladder (vertex welding, ITK hole filling) uses
   * millimetre-absolute tolerances, but this cut also runs on raw viewer units
   * where a model may be ~1 unit across. Normalizing the bounding-box diagonal
   * to this size before the manifold work — and scaling back after — makes
   * those tolerances meaningful and the whole cut scale-invariant.
   */
  WORKING_DIAGONAL: 100,
} as const;

export type CutMeshInput = {
  /** numProp-strided vertex properties; the first three are always xyz. */
  vertProperties: Float32Array;
  /** Triangle vertex indices. */
  triVerts: Uint32Array;
  /** Property stride (3 for bare positions, more when uv/colour ride along). */
  numProp: number;
};

export type FlatBottomOutcome =
  | {
      status: 'ok';
      mesh: CutMeshInput;
      /** Cut plane height, in the input's own units. */
      cutY: number;
      /** How much of the model's height was removed. */
      cutFraction: number;
      /** Area of the resulting flat face, in the input's own square units. */
      contactArea: number;
    }
  /** Nothing to do: the model already rests on a broad enough flat face. */
  | { status: 'already-flat'; contactArea: number }
  | {
      status: 'error';
      code: 'not-manifold' | 'degenerate' | 'compute-failed';
      message: string;
    };

type Bounds = {
  minY: number;
  maxY: number;
  height: number;
  footprintArea: number;
  diagonal: number;
};

/** Bounding box measures the cut is sized against. */
export function measureBounds(input: CutMeshInput): Bounds {
  const { vertProperties, numProp } = input;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i + numProp <= vertProperties.length; i += numProp) {
    const x = vertProperties[i];
    const y = vertProperties[i + 1];
    const z = vertProperties[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
    return { minY: 0, maxY: 0, height: 0, footprintArea: 0, diagonal: 0 };
  }

  const dx = Math.max(0, maxX - minX);
  const dy = Math.max(0, maxY - minY);
  const dz = Math.max(0, maxZ - minZ);

  return {
    minY,
    maxY,
    height: dy,
    footprintArea: dx * dz,
    diagonal: Math.sqrt(dx * dx + dy * dy + dz * dz),
  };
}

/** Scale only the xyz channels, leaving uv/colour properties untouched. */
function scalePositions(input: CutMeshInput, factor: number): CutMeshInput {
  if (factor === 1) return input;
  const scaled = new Float32Array(input.vertProperties);
  for (let i = 0; i + input.numProp <= scaled.length; i += input.numProp) {
    scaled[i] *= factor;
    scaled[i + 1] *= factor;
    scaled[i + 2] *= factor;
  }
  return { ...input, vertProperties: scaled };
}

/**
 * Total area of the triangles lying flat in the plane y = planeY. Used both to
 * detect a model that already has a flat bottom and to score a candidate cut.
 * Pure JS so node tests can check it without the WASM module.
 */
export function measurePlanarFaceArea(
  input: CutMeshInput,
  planeY: number,
  epsilon: number,
): number {
  const { vertProperties, triVerts, numProp } = input;
  let area = 0;

  for (let t = 0; t + 2 < triVerts.length; t += 3) {
    const a = triVerts[t] * numProp;
    const b = triVerts[t + 1] * numProp;
    const c = triVerts[t + 2] * numProp;

    if (
      Math.abs(vertProperties[a + 1] - planeY) > epsilon ||
      Math.abs(vertProperties[b + 1] - planeY) > epsilon ||
      Math.abs(vertProperties[c + 1] - planeY) > epsilon
    ) {
      continue;
    }

    // Triangle is horizontal, so its area is its footprint in the xz plane.
    const abx = vertProperties[b] - vertProperties[a];
    const abz = vertProperties[b + 2] - vertProperties[a + 2];
    const acx = vertProperties[c] - vertProperties[a];
    const acz = vertProperties[c + 2] - vertProperties[a + 2];
    area += Math.abs(abx * acz - abz * acx) / 2;
  }

  return area;
}

/**
 * Concatenate several meshes into one positions-only mesh. Used to choose the
 * cut plane for a multi-part scene, where the plane must be shared by every
 * part but each part is trimmed separately to keep its own material.
 */
export function mergeCutMeshes(meshes: CutMeshInput[]): CutMeshInput {
  let vertexCount = 0;
  let triCount = 0;
  for (const mesh of meshes) {
    vertexCount += Math.floor(mesh.vertProperties.length / mesh.numProp);
    triCount += mesh.triVerts.length;
  }

  const vertProperties = new Float32Array(vertexCount * 3);
  const triVerts = new Uint32Array(triCount);
  let vertexOffset = 0;
  let triOffset = 0;

  for (const mesh of meshes) {
    const meshVertices = Math.floor(mesh.vertProperties.length / mesh.numProp);
    for (let v = 0; v < meshVertices; v += 1) {
      const source = v * mesh.numProp;
      const target = (vertexOffset + v) * 3;
      vertProperties[target] = mesh.vertProperties[source];
      vertProperties[target + 1] = mesh.vertProperties[source + 1];
      vertProperties[target + 2] = mesh.vertProperties[source + 2];
    }
    for (let i = 0; i < mesh.triVerts.length; i += 1) {
      triVerts[triOffset + i] = mesh.triVerts[i] + vertexOffset;
    }
    vertexOffset += meshVertices;
    triOffset += mesh.triVerts.length;
  }

  return { vertProperties, triVerts, numProp: 3 };
}

function manifoldToMesh(manifold: Manifold): CutMeshInput {
  const mesh = manifold.getMesh();
  return {
    vertProperties: new Float32Array(mesh.vertProperties),
    triVerts: new Uint32Array(mesh.triVerts),
    numProp: mesh.numProp,
  };
}

/**
 * Trim the underside flat.
 *
 * Tries the candidate depths shallowest-first and keeps the first cut whose
 * contact face is broad enough; if none is, it keeps the deepest allowed cut
 * (still bounded by MAX_CUT_FRACTION) rather than giving up, because a small
 * flat face still beats a rounded one on the build plate.
 */
export async function flatBottomCut(
  wasm: ManifoldToplevel,
  input: CutMeshInput,
): Promise<FlatBottomOutcome> {
  const bounds = measureBounds(input);
  if (bounds.height < FLAT_BOTTOM.MIN_HEIGHT || input.triVerts.length < 3) {
    return {
      status: 'error',
      code: 'degenerate',
      message: 'The model is empty or has no height to cut.',
    };
  }

  const epsilon = Math.max(
    bounds.height * FLAT_BOTTOM.PLANE_EPSILON_FRACTION,
    Number.EPSILON,
  );
  const targetArea = bounds.footprintArea * FLAT_BOTTOM.TARGET_CONTACT_FRACTION;

  // Already resting on a broad flat face: leave the geometry untouched.
  const existingArea = measurePlanarFaceArea(input, bounds.minY, epsilon);
  if (existingArea >= targetArea && targetArea > 0) {
    return { status: 'already-flat', contactArea: existingArea };
  }

  const garbage: Manifold[] = [];
  const keep = (manifold: Manifold): Manifold => {
    garbage.push(manifold);
    return manifold;
  };

  // Work at a millimetre-like scale so the repair ladder's absolute tolerances
  // mean what they were tuned to mean, then scale the result back.
  const scale =
    bounds.diagonal > 0 ? FLAT_BOTTOM.WORKING_DIAGONAL / bounds.diagonal : 1;
  const working = scalePositions(input, scale);
  const workingBounds = measureBounds(working);
  const workingEpsilon = Math.max(
    workingBounds.height * FLAT_BOTTOM.PLANE_EPSILON_FRACTION,
    Number.EPSILON,
  );
  const workingTargetArea =
    workingBounds.footprintArea * FLAT_BOTTOM.TARGET_CONTACT_FRACTION;

  try {
    const base = await buildManifoldFromMesh(wasm, keep, working);
    if (!base) {
      return {
        status: 'error',
        code: 'not-manifold',
        message:
          'The model could not be repaired into a solid, so its bottom cannot be cut cleanly.',
      };
    }

    const normal: Vec3 = [0, 1, 0];
    type Candidate = {
      fraction: number;
      mesh: CutMeshInput;
      workingContactArea: number;
    };
    const candidates: Candidate[] = [];
    let reachedTarget: Candidate | null = null;

    for (const fraction of FLAT_BOTTOM.CANDIDATE_FRACTIONS) {
      if (fraction > FLAT_BOTTOM.MAX_CUT_FRACTION) break;

      const workingCutY = workingBounds.minY + workingBounds.height * fraction;
      const trimmed = keep(base.trimByPlane(normal, workingCutY));
      if (trimmed.isEmpty()) continue;

      const workingMesh = manifoldToMesh(trimmed);
      const candidate: Candidate = {
        fraction,
        mesh: workingMesh,
        workingContactArea: measurePlanarFaceArea(
          workingMesh,
          workingCutY,
          workingEpsilon,
        ),
      };
      candidates.push(candidate);

      // Shallowest cut that gives a face broad enough to stand on: done.
      if (candidate.workingContactArea >= workingTargetArea) {
        reachedTarget = candidate;
        break;
      }
    }

    if (candidates.length === 0) {
      return {
        status: 'error',
        code: 'compute-failed',
        message: 'Cutting the bottom flat produced an empty model.',
      };
    }

    // Nothing reached the target, so stop where cutting deeper stops paying
    // rather than defaulting to the deepest allowed cut.
    const chosen =
      reachedTarget ??
      (() => {
        const bestArea = Math.max(
          ...candidates.map((c) => c.workingContactArea),
        );
        const knee = bestArea * FLAT_BOTTOM.DIMINISHING_RETURNS_FRACTION;
        return (
          candidates.find((c) => c.workingContactArea >= knee) ??
          candidates[candidates.length - 1]
        );
      })();

    return {
      status: 'ok',
      mesh: scalePositions(chosen.mesh, 1 / scale),
      cutY: bounds.minY + bounds.height * chosen.fraction,
      cutFraction: chosen.fraction,
      contactArea: chosen.workingContactArea / (scale * scale),
    };
  } catch (error) {
    return {
      status: 'error',
      code: 'compute-failed',
      message:
        error instanceof Error
          ? error.message
          : 'The flat bottom could not be computed.',
    };
  } finally {
    for (const manifold of garbage) {
      try {
        manifold.delete();
      } catch {
        // Already released.
      }
    }
  }
}

/** Trim one mesh at an already-chosen plane, preserving its properties. */
export async function trimFlatBottomAt(
  wasm: ManifoldToplevel,
  input: CutMeshInput,
  cutY: number,
): Promise<CutMeshInput | null> {
  const bounds = measureBounds(input);
  // Entirely above the plane: nothing to remove.
  if (bounds.minY >= cutY) return null;

  const garbage: Manifold[] = [];
  const keep = (manifold: Manifold): Manifold => {
    garbage.push(manifold);
    return manifold;
  };

  const scale =
    bounds.diagonal > 0 ? FLAT_BOTTOM.WORKING_DIAGONAL / bounds.diagonal : 1;

  try {
    const base = await buildManifoldFromMesh(
      wasm,
      keep,
      scalePositions(input, scale),
    );
    if (!base) return null;

    const trimmed = keep(base.trimByPlane([0, 1, 0], cutY * scale));
    if (trimmed.isEmpty()) return null;

    return scalePositions(manifoldToMesh(trimmed), 1 / scale);
  } catch {
    return null;
  } finally {
    for (const manifold of garbage) {
      try {
        manifold.delete();
      } catch {
        // Already released.
      }
    }
  }
}

export type FlatBottomSceneOutcome =
  | {
      status: 'ok';
      cutY: number;
      cutFraction: number;
      contactArea: number;
      /**
       * One entry per input mesh, in order. `null` means "keep the original
       * geometry": either the part sits entirely above the cut, or it could
       * not be turned into a solid — `uncutCount` counts only the latter.
       */
      meshes: (CutMeshInput | null)[];
      uncutCount: number;
    }
  | { status: 'already-flat'; contactArea: number }
  | {
      status: 'error';
      code: 'not-manifold' | 'degenerate' | 'compute-failed';
      message: string;
    };

/**
 * Cut a whole scene's worth of meshes against one shared plane.
 *
 * The plane is chosen from all the geometry at once (a model must rest on ONE
 * face, not one per part), then each part is trimmed on its own so it keeps its
 * own material and texture. A single-mesh scene — what image-to-3D actually
 * returns — takes the direct path with no merging.
 */
export async function computeFlatBottomForScene(
  wasm: ManifoldToplevel,
  meshes: CutMeshInput[],
): Promise<FlatBottomSceneOutcome> {
  if (meshes.length === 0) {
    return {
      status: 'error',
      code: 'degenerate',
      message: 'The model has no geometry to cut.',
    };
  }

  if (meshes.length === 1) {
    const outcome = await flatBottomCut(wasm, meshes[0]);
    if (outcome.status !== 'ok') return outcome;
    return {
      status: 'ok',
      cutY: outcome.cutY,
      cutFraction: outcome.cutFraction,
      contactArea: outcome.contactArea,
      meshes: [outcome.mesh],
      uncutCount: 0,
    };
  }

  const planned = await flatBottomCut(wasm, mergeCutMeshes(meshes));
  if (planned.status !== 'ok') return planned;

  const trimmed: (CutMeshInput | null)[] = [];
  let uncutCount = 0;

  for (const mesh of meshes) {
    if (measureBounds(mesh).minY >= planned.cutY) {
      trimmed.push(null);
      continue;
    }
    const result = await trimFlatBottomAt(wasm, mesh, planned.cutY);
    if (!result) uncutCount += 1;
    trimmed.push(result);
  }

  return {
    status: 'ok',
    cutY: planned.cutY,
    cutFraction: planned.cutFraction,
    contactArea: planned.contactArea,
    meshes: trimmed,
    uncutCount,
  };
}
