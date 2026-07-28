/**
 * Boolean build stage for the Flexi Toy Maker (manifold-3d).
 *
 * Pure function of an (already scaled) `FlexiMeshInput`, a `FlexiToyPlan` and the
 * `FlexiToySettings`. Cuts the body into printable ball-and-socket segments and
 * returns them as SEPARATE bodies in one buffer (never unioned — see spec §6).
 *
 * Importable from both the worker and node tests: the manifold WASM instance is
 * injected (`buildFlexiToy(wasm, …)`), and `loadManifold()` is a memoised loader
 * that node can call directly. Every intermediate Manifold is `.delete()`d.
 *
 * Out of scope (v1): overlapping scale-shell segments, hinge/loop joints, manual
 * per-joint editing. This stage only realises the plan it is handed.
 */

import Module from 'manifold-3d';
import type { ManifoldToplevel, Manifold, Vec3 } from 'manifold-3d';
import {
  FLEXI_DEFAULT_JOINT_STYLE,
  FLEXI_MIN_SOCKET_WALL_MM,
} from './flexiToyTypes.ts';
import type {
  FlexiMeshInput,
  FlexiToySettings,
  FlexiToyPlan,
  FlexiJointPlan,
  FlexiJointStyle,
  FlexiToyResult,
  FlexiToyWarning,
  FlexiToyOutcome,
} from './flexiToyTypes.ts';
import { crossSectionExtentsSampler } from './flexiToyPlan.ts';
import type { FlexiSectionSampler } from './flexiToyPlan.ts';

/** Non-superseded outcome the worker forwards to the main thread. */
export type FlexiBuildOutcome = Exclude<
  FlexiToyOutcome,
  { status: 'superseded' }
>;

const SPHERE_SEGMENTS = 48;
// Below this triangle count the ITK repair filter is not worth loading; the mesh
// is small enough that a clean 'not-watertight' error is the right answer.
const ITK_REPAIR_MIN_TRIANGLES = 200;

// --- Rounded (dome-in-dish) cutter tunables (see flexi-changes-v3 spec). ---
const CUTTER_REVOLVE_SEGMENTS = 96;
// The shell cutter is a 5-part union whose warp forces an eager evaluation
// per joint; 64 azimuth segments keep chord sag < 0.05mm at seam radii while
// halving the boolean cost on dense bodies (the ≤10s budget). The profile
// arcs likewise sample at 5° — the sliding spheres' sag stays ≤ 0.002·r.
const SHELL_REVOLVE_SEGMENTS = 64;
const SHELL_ARC_STEP_DEG = 5;
// Arc sampling step (degrees) for the profile polygon.
const CUTTER_ARC_STEP_DEG = 3;
// Neck strength floor: neck half-angle ≥ asin(0.35) so the neck stays ≥ 0.35·r.
const NECK_FLOOR_RAD = Math.asin(0.35);
// Overlap the shell θ-ranges by this so boolean seams never coincide (a shared
// seam vertex reads as a zero-distance touch between the two segments).
const SHELL_OVERLAP_RAD = (3 * Math.PI) / 180;
// The visible groove floor sits just inside the thinnest local half-extent, so
// the skin band of the gap wedge stays centred on the cut plane in every
// direction the body allows.
const GROOVE_FLOOR_FACTOR = 0.92;
// The gap wedge's outer radius clears the widest local half-extent by this
// factor so the band always punches through the skin (fins included).
const GROOVE_OUT_FACTOR = 1.15;
// Minimum solid slab that must survive between two adjacent joints' gap bands
// at the widest feature (mirrors the plan's GAP_BAND_KEEP_MM).
const GAP_BAND_KEEP_MM = 3;

let cachedWasm: Promise<ManifoldToplevel> | null = null;

/**
 * Load and set up the manifold-3d WASM module once. In the vite worker pass a
 * `locateFile` that resolves the bundled `manifold.wasm?url`; node resolves the
 * wasm from the package automatically.
 */
export function loadManifold(
  locateFile?: () => string,
): Promise<ManifoldToplevel> {
  if (!cachedWasm) {
    cachedWasm = (async () => {
      const wasm = await Module(locateFile ? { locateFile } : undefined);
      wasm.setup();
      return wasm;
    })();
  }
  return cachedWasm;
}

/**
 * Build the segmented flexi geometry. Never throws for expected failure modes
 * (non-watertight input, degenerate mesh) — those return an `error` outcome.
 */
export async function buildFlexiToy(
  wasm: ManifoldToplevel,
  meshInput: FlexiMeshInput,
  plan: FlexiToyPlan,
  settings: FlexiToySettings,
): Promise<FlexiBuildOutcome> {
  const garbage: Manifold[] = [];
  const keep = (manifold: Manifold): Manifold => {
    garbage.push(manifold);
    return manifold;
  };

  try {
    const base = await buildBaseManifold(wasm, meshInput, keep);
    if (!base) {
      return {
        status: 'error',
        code: 'not-watertight',
        message:
          'This model has holes or overlaps we could not seal, so it cannot be turned into a flexi toy. Try a different model.',
      };
    }

    if (base.manifold.isEmpty()) {
      return {
        status: 'error',
        code: 'too-small',
        message: 'This model is too small or thin to build a flexi toy from.',
      };
    }

    const clearance = settings.clearanceMm;
    const jointStyle = settings.jointStyle ?? FLEXI_DEFAULT_JOINT_STYLE;
    const cutJoints = plan.joints.filter((joint) => !joint.fused);

    // Each output segment is a list of component manifolds (usually one; the
    // rounded brim can split a fin sliver off into its interval's segment).
    let segments: Manifold[][];
    let shellFallbackJoints = 0;

    if (cutJoints.length === 0) {
      segments = [[base.manifold]];
    } else if (jointStyle === 'classic') {
      const pieces = buildClassicSegments(
        wasm,
        keep,
        base.manifold,
        cutJoints,
        clearance,
      );
      if (!pieces) {
        return {
          status: 'error',
          code: 'compute-failed',
          message: 'The flexi toy could not be built from this model.',
        };
      }
      segments = pieces.map((piece) => [piece]);
    } else {
      const notes = { shellFallbackJoints: 0 };
      const grouped = buildRoundedSegments(
        wasm,
        keep,
        base.manifold,
        cutJoints,
        meshInput,
        clearance,
        settings.bendAngleDeg,
        jointStyle,
        notes,
      );
      if (grouped === 'uncut') {
        return {
          status: 'error',
          code: 'rounded-uncut',
          message:
            'The rounded joints could not fully separate this model (usually a strong off-axis feature crossing a cut). Try the Classic joint style.',
        };
      }
      if (!grouped) {
        return {
          status: 'error',
          code: 'compute-failed',
          message: 'The flexi toy could not be built from this model.',
        };
      }
      segments = grouped;
      shellFallbackJoints = notes.shellFallbackJoints;
    }

    const assembled = assemblePieces(segments, meshInput);

    const warnings: FlexiToyWarning[] = [...plan.warnings];
    if (shellFallbackJoints > 0) {
      warnings.push({
        code: 'shell-joint-fallback',
        message:
          shellFallbackJoints === 1
            ? 'One joint was too small for an overlapping shell and uses a rounded groove instead.'
            : `${shellFallbackJoints} joints were too small for overlapping shells and use rounded grooves instead.`,
      });
    }
    if (base.repaired) {
      warnings.push({
        code: 'mesh-repaired',
        message: 'The model was automatically repaired before cutting.',
      });
    }

    const jointCount = cutJoints.length;
    const fusedJointCount = plan.joints.length - cutJoints.length;

    const result: FlexiToyResult = {
      positions: assembled.positions,
      indices: assembled.indices,
      colors: assembled.colors,
      segmentTriangleRanges: assembled.segmentTriangleRanges,
      segmentCount: segments.length,
      jointCount,
      fusedJointCount,
      lengthMm: plan.spineLengthMm,
      plan,
      warnings,
    };
    return { status: 'ok', result };
  } catch (error) {
    return {
      status: 'error',
      code: 'compute-failed',
      message:
        error instanceof Error
          ? error.message
          : 'The flexi toy could not be built from this model.',
    };
  } finally {
    for (const manifold of garbage) {
      try {
        manifold.delete();
      } catch {
        // Already freed or invalid handle; nothing to do.
      }
    }
  }
}

// --- Base manifold construction + repair chain ----------------------------

type BaseManifold = { manifold: Manifold; repaired: boolean };

async function buildBaseManifold(
  wasm: ManifoldToplevel,
  meshInput: FlexiMeshInput,
  keep: (manifold: Manifold) => Manifold,
): Promise<BaseManifold | null> {
  // (1) Direct construction with weld merge vectors.
  const direct = tryManifoldFromArrays(
    wasm,
    keep,
    meshInput.positions,
    meshInput.indices,
  );
  if (direct) return { manifold: direct, repaired: false };

  // (2) Re-weld coincident vertices on a fine grid, then retry.
  const welded = weldMesh(meshInput.positions, meshInput.indices);
  const weldedManifold = tryManifoldFromArrays(
    wasm,
    keep,
    welded.positions,
    welded.indices,
  );
  if (weldedManifold) return { manifold: weldedManifold, repaired: false };

  // (3) ITK hole-filling repair (dynamic import, mirrors threeMfExport).
  const repaired = await repairWithItk(welded.positions, welded.indices);
  if (repaired) {
    const repairedManifold = tryManifoldFromArrays(
      wasm,
      keep,
      repaired.positions,
      repaired.indices,
    );
    if (repairedManifold) return { manifold: repairedManifold, repaired: true };
  }

  return null;
}

function tryManifoldFromArrays(
  wasm: ManifoldToplevel,
  keep: (manifold: Manifold) => Manifold,
  positions: Float32Array,
  indices: Uint32Array,
): Manifold | null {
  return tryManifoldFromProperties(wasm, keep, positions, indices, 3);
}

/**
 * Build a Manifold from `numProp`-strided vertex properties. With numProp > 3
 * the extra channels (uv, colour) ride through later boolean/trim operations,
 * which manifold interpolates across new geometry.
 */
function tryManifoldFromProperties(
  wasm: ManifoldToplevel,
  keep: (manifold: Manifold) => Manifold,
  vertProperties: Float32Array,
  triVerts: Uint32Array,
  numProp: number,
): Manifold | null {
  const { Manifold, Mesh } = wasm;
  try {
    const mesh = new Mesh({
      numProp,
      vertProperties: new Float32Array(vertProperties),
      triVerts: new Uint32Array(triVerts),
    });
    mesh.merge();
    const manifold = Manifold.ofMesh(mesh);
    if (manifold.status() !== 'NoError' || manifold.isEmpty()) {
      manifold.delete();
      return null;
    }
    return keep(manifold);
  } catch {
    return null;
  }
}

/**
 * Same direct → weld → ITK repair ladder `buildBaseManifold` uses, but for an
 * arbitrary-property mesh (see `flatBottomCut.ts`). Generated meshes routinely
 * fail a direct `Manifold.ofMesh`, so the fallbacks are not optional.
 *
 * Caveat: the weld and ITK stages operate on positions alone, so a mesh that
 * needs repairing comes back with numProp 3 — extra channels are dropped. The
 * caller must read `getMesh().numProp` rather than assume its input stride.
 *
 * Positions are expected in a millimetre-like scale: both fallbacks use
 * absolute tolerances.
 */
export async function buildManifoldFromMesh(
  wasm: ManifoldToplevel,
  keep: (manifold: Manifold) => Manifold,
  mesh: {
    vertProperties: Float32Array;
    triVerts: Uint32Array;
    numProp: number;
  },
): Promise<Manifold | null> {
  const direct = tryManifoldFromProperties(
    wasm,
    keep,
    mesh.vertProperties,
    mesh.triVerts,
    mesh.numProp,
  );
  if (direct) return direct;

  const vertexCount = Math.floor(mesh.vertProperties.length / mesh.numProp);
  const positions = new Float32Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v += 1) {
    positions[v * 3] = mesh.vertProperties[v * mesh.numProp];
    positions[v * 3 + 1] = mesh.vertProperties[v * mesh.numProp + 1];
    positions[v * 3 + 2] = mesh.vertProperties[v * mesh.numProp + 2];
  }

  const welded = weldMesh(positions, mesh.triVerts);
  const weldedManifold = tryManifoldFromArrays(
    wasm,
    keep,
    welded.positions,
    welded.indices,
  );
  if (weldedManifold) return weldedManifold;

  const repaired = await repairWithItk(welded.positions, welded.indices);
  if (repaired) {
    return tryManifoldFromArrays(
      wasm,
      keep,
      repaired.positions,
      repaired.indices,
    );
  }

  return null;
}

// --- Piece assembly + colouring -------------------------------------------

type AssembledGeometry = {
  positions: Float32Array;
  indices: Uint32Array;
  colors: Float32Array;
  segmentTriangleRanges: Array<{ start: number; count: number }>;
};

function assemblePieces(
  segments: Manifold[][],
  meshInput: FlexiMeshInput,
): AssembledGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const segmentTriangleRanges: Array<{ start: number; count: number }> = [];
  const colorGrid = buildColorGrid(meshInput);

  let minY = Infinity;
  for (const components of segments) {
    // One triangle range per SEGMENT — its components are concatenated so the UI
    // can tint a fin sliver together with the piece it belongs to.
    const start = indices.length;
    for (const component of components) {
      const mesh = component.getMesh();
      const numProp = mesh.numProp;
      const vertexOffset = positions.length / 3;
      const vertexCount = mesh.vertProperties.length / numProp;

      for (let v = 0; v < vertexCount; v += 1) {
        const x = mesh.vertProperties[v * numProp];
        const y = mesh.vertProperties[v * numProp + 1];
        const z = mesh.vertProperties[v * numProp + 2];
        positions.push(x, y, z);
        if (y < minY) minY = y;
      }

      for (let i = 0; i < mesh.triVerts.length; i += 1) {
        indices.push(mesh.triVerts[i] + vertexOffset);
      }
    }
    segmentTriangleRanges.push({ start, count: indices.length - start });
  }

  // Floor-align: min-Y to 0.
  const shift = Number.isFinite(minY) ? minY : 0;
  const positionArray = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    positionArray[i] = positions[i];
    positionArray[i + 1] = positions[i + 1] - shift;
    positionArray[i + 2] = positions[i + 2];
  }

  // Per-vertex colour by nearest input vertex (carries the body's colours onto
  // cut and ball faces without routing colour through the boolean ops).
  const colors = new Float32Array(positions.length);
  for (let v = 0; v < positions.length / 3; v += 1) {
    const [r, g, b] = colorGrid.nearest(
      positions[v * 3],
      positions[v * 3 + 1],
      positions[v * 3 + 2],
    );
    colors[v * 3] = r;
    colors[v * 3 + 1] = g;
    colors[v * 3 + 2] = b;
  }

  return {
    positions: positionArray,
    indices: new Uint32Array(indices),
    colors,
    segmentTriangleRanges,
  };
}

// --- Classic segments (round-2 plane-trim + ball/socket) -------------------

// Cut the body into segments with flat ring faces: trim each end plane, subtract
// the tail socket cavity, add the head ball. Returns one manifold per segment,
// or null on a degenerate/empty piece.
function buildClassicSegments(
  wasm: ManifoldToplevel,
  keep: (manifold: Manifold) => Manifold,
  body: Manifold,
  cutJoints: FlexiJointPlan[],
  clearance: number,
): Manifold[] | null {
  const pieceCount = cutJoints.length + 1;
  const pieces: Manifold[] = [];
  for (let p = 0; p < pieceCount; p += 1) {
    const tailJoint = p > 0 ? cutJoints[p - 1] : null;
    const headJoint = p < pieceCount - 1 ? cutJoints[p] : null;
    let piece = body;

    // Head cut: keep everything on the tail side of the ball's neck face. The
    // face sits a bend-driven gap (faceGapMm) behind the socket depth so the
    // printed groove is wide enough to actually flex.
    if (headJoint) {
      const faceOffset = headJoint.socketDepthMm + headJoint.faceGapMm;
      const point = pointAlong(headJoint, -faceOffset);
      const normal = negate(headJoint.axis);
      piece = keep(piece.trimByPlane(normal, dot(normal, point)));
    }
    // Tail cut: keep everything on the head side of the socket face.
    if (tailJoint) {
      const point = pointAlong(tailJoint, -tailJoint.socketDepthMm);
      const normal = tailJoint.axis as Vec3;
      piece = keep(piece.trimByPlane(normal, dot(normal, point)));
    }
    // Carve the tail socket cavity (radius = ball + clearance).
    if (tailJoint) {
      const socket = makeSphere(
        wasm,
        keep,
        tailJoint.center,
        tailJoint.ballRadiusMm + clearance,
      );
      piece = keep(piece.subtract(socket));
    }
    // Add the head ball (belongs to this segment, protrudes forward).
    if (headJoint) {
      const ball = makeSphere(
        wasm,
        keep,
        headJoint.center,
        headJoint.ballRadiusMm,
      );
      piece = keep(piece.add(ball));
    }

    if (piece.isEmpty() || piece.status() !== 'NoError') {
      return null;
    }
    pieces.push(piece);
  }
  return pieces;
}

// --- Rounded segments (revolve cutter + decompose) -------------------------

// Subtract one concentric dome-in-dish cutter per live joint, decompose the
// result into components, and group components into segment intervals by which
// cut planes each centroid lies past. Returns segment component groups; 'uncut'
// when a cut left an interval empty (a bridging feature the rounded style could
// not sever — the caller surfaces 'rounded-uncut' so the UI can suggest
// Classic); null on a genuine degenerate/boolean failure.
function buildRoundedSegments(
  wasm: ManifoldToplevel,
  keep: (manifold: Manifold) => Manifold,
  body: Manifold,
  cutJoints: FlexiJointPlan[],
  meshInput: FlexiMeshInput,
  clearance: number,
  bendAngleDeg: number,
  jointStyle: FlexiJointStyle = 'rounded',
  notes: { shellFallbackJoints: number } = { shellFallbackJoints: 0 },
): Manifold[][] | 'uncut' | null {
  // Sequential subtract, freeing each intermediate immediately so a 19-joint
  // body doesn't pile up full-body copies (only the running cut is retained).
  let cut = body;
  for (const joint of cutJoints) {
    // Groove floor from the THINNEST cross-section direction at the cut plane;
    // wedge outer radius from the WIDEST direction over the wedge's whole
    // axial band, so the gap punches through the skin (fins included) even on
    // a tall/eccentric or locally bulging section. One profile pass per joint;
    // band queries against it are just bin scans.
    const measure = crossSectionExtentsSampler(
      meshInput.positions,
      joint.center,
      joint.axis,
    );
    const planeExtents = measure();
    if (!(planeExtents.maxMm > 0)) {
      if (cut !== body) cut.delete();
      return null;
    }
    let angles = roundedGapAngles(joint, clearance, bendAngleDeg);
    if (!angles) {
      if (cut !== body) cut.delete();
      return null;
    }
    // Never let a (truncated, tail-tilted) wedge reach into a neighbouring
    // joint's cup: cap its tailward reach at the nearest station minus that
    // joint's cup wall.
    const index = cutJoints.indexOf(joint);
    let maxTailReach = Infinity;
    let minNeighborDist = Infinity;
    for (const other of [cutJoints[index - 1], cutJoints[index + 1]]) {
      if (!other) continue;
      const dx = other.center[0] - joint.center[0];
      const dy = other.center[1] - joint.center[1];
      const dz = other.center[2] - joint.center[2];
      const distance = Math.hypot(dx, dy, dz);
      const otherCup =
        other.ballRadiusMm + clearance + FLEXI_MIN_SOCKET_WALL_MM;
      maxTailReach = Math.min(maxTailReach, distance - otherCup - 1);
      minNeighborDist = Math.min(minNeighborDist, distance);
    }
    // Gap-band budget (mirrors the plan's minSegmentLengthFor term): this
    // joint's band reaches ±rho·tan(gapAngle/2) axially at radius rho, and
    // its neighbour claims the same, so each side owns half the pitch minus a
    // solid keep slab. Dragged cuts can be pinned tighter than the plan's
    // floor; cap the travel here so two bands can never jointly shave a wide
    // feature between stations.
    // The shell's flared seam-lip walls widen the band at the skin; measure
    // over the wider reach and spend part of the budget on the flare.
    const flareBudget = jointStyle === 'shell' ? SHELL_FLARE_BAND_RAD : 0;
    const flareMeasure = jointStyle === 'shell' ? SHELL_LIP_FLARE_RAD : 0;
    if (Number.isFinite(minNeighborDist)) {
      const outEstimate =
        GROOVE_OUT_FACTOR * planeExtents.maxMm + joint.faceGapMm;
      const halfWidthEstimate =
        outEstimate *
          Math.sin(angles.gapAngle / 2 + SHELL_OVERLAP_RAD + flareMeasure) +
        2;
      const bandMax = Math.max(
        planeExtents.maxMm,
        measure(halfWidthEstimate).maxMm,
      );
      const budget = Math.max(0.05, (minNeighborDist - GAP_BAND_KEEP_MM) / 2);
      const capRad =
        2 * (Math.atan2(budget, bandMax) - flareBudget) - SHELL_OVERLAP_RAD;
      const capDeg = (capRad * 180) / Math.PI;
      if (capDeg < bendAngleDeg) {
        const capped = roundedGapAngles(joint, clearance, Math.max(1, capDeg));
        if (capped) angles = capped;
      }
    }
    // The overlapping-shell style needs a lap shelf just under the thinnest
    // skin; where the body cannot host one, that joint falls back to the
    // rounded wedge.
    let cutter: Manifold | null = null;
    if (jointStyle === 'shell') {
      // Skin-lofted shell first: per-azimuth seam radii follow the local
      // skin, so flattened bodies get a uniform shallow seam instead of a
      // deep trench on the tall side.
      const loft = solveShellLoft(measure, joint, angles);
      if (loft) {
        const lofted = solveShellWedge(
          angles,
          joint,
          clearance,
          { floorMm: planeExtents.minMm, outMm: planeExtents.maxMm },
          loft,
        );
        if (lofted) {
          cutter = buildShellCutter(
            wasm,
            joint,
            clearance,
            angles,
            lofted,
            loft,
          );
        }
      }
      // Plain revolved shell when the loft could not be solved or its warp
      // failed validation.
      if (!cutter) {
        let shell = solveShellWedge(angles, joint, clearance, {
          floorMm: planeExtents.minMm,
          outMm: planeExtents.maxMm,
        });
        for (let pass = 0; shell && pass < 4; pass += 1) {
          const bandHalfWidth =
            shell.rOut *
              Math.sin(angles.gapAngle / 2 + SHELL_OVERLAP_RAD + flareMeasure) +
            2;
          const bandExtents = measure(bandHalfWidth);
          const next = solveShellWedge(angles, joint, clearance, {
            floorMm: planeExtents.minMm,
            outMm: Math.max(planeExtents.maxMm, bandExtents.maxMm),
          });
          const settled = !next || Math.abs(next.rOut - shell.rOut) < 0.25;
          shell = next;
          if (settled) break;
        }
        if (shell) {
          cutter = buildShellCutter(wasm, joint, clearance, angles, shell);
        }
      }
      if (!cutter) {
        notes.shellFallbackJoints += 1;
      }
    }
    if (!cutter) {
      // Solve the wedge, re-measure the body over the axial band that wedge
      // actually sweeps, and iterate until the outer radius stabilises — a
      // body flaring steeply next to the cut can otherwise outgrow a one-pass
      // band and bury the groove under the flare.
      let wedge = solveRoundedWedge(angles, joint, clearance, {
        floorMm: planeExtents.minMm,
        outMm: planeExtents.maxMm,
        maxTailReachMm: maxTailReach,
      });
      for (let pass = 0; pass < 4; pass += 1) {
        const bandHalfWidth =
          wedge.r3 *
            Math.max(
              Math.sin(angles.gapAngle / 2 + SHELL_OVERLAP_RAD),
              Math.cos(wedge.thetaEnd),
            ) +
          2;
        const bandExtents = measure(bandHalfWidth);
        const next = solveRoundedWedge(angles, joint, clearance, {
          floorMm: planeExtents.minMm,
          outMm: Math.max(planeExtents.maxMm, bandExtents.maxMm),
          maxTailReachMm: maxTailReach,
        });
        const settled = Math.abs(next.r3 - wedge.r3) < 0.25;
        wedge = next;
        if (settled) break;
      }
      cutter = buildRoundedCutter(wasm, joint, clearance, angles, wedge);
    }
    if (!cutter) {
      if (cut !== body) cut.delete();
      return null;
    }
    const next = cut.subtract(cutter);
    cutter.delete();
    if (cut !== body) cut.delete();
    cut = next;
  }

  // Manifold booleans are lazy: checking status per joint would force a full
  // evaluation of the growing chain each time. One check here evaluates the
  // whole subtract tree once.
  if (cut !== body && (cut.status() !== 'NoError' || cut.isEmpty())) {
    cut.delete();
    return null;
  }

  const components = cut.decompose();
  if (cut !== body) cut.delete();
  for (const component of components) {
    keep(component);
  }
  if (components.length === 0) {
    return null;
  }

  // Assign each component to a segment interval by how many joint cut planes its
  // centroid lies past (head-side). This is robust to a curved spine / tilted
  // cuts (unlike bucketing an arc-length fraction, which compresses on bends).
  const segmentCount = cutJoints.length + 1;
  const groups: Manifold[][] = Array.from({ length: segmentCount }, () => []);

  for (const component of components) {
    const centroid = componentCentroid(component);
    let segment = 0;
    for (const joint of cutJoints) {
      const dx = centroid[0] - joint.center[0];
      const dy = centroid[1] - joint.center[1];
      const dz = centroid[2] - joint.center[2];
      if (dx * joint.axis[0] + dy * joint.axis[1] + dz * joint.axis[2] > 0) {
        segment += 1;
      }
    }
    groups[Math.min(segment, segmentCount - 1)].push(component);
  }

  // An empty interval means a cut failed to separate its segment from a
  // neighbour — the rounded cutter did not sever this model.
  if (groups.some((group) => group.length === 0)) {
    return 'uncut';
  }
  return groups;
}

type RoundedGapAngles = {
  /** Neck half-angle (tail face of the gap at the cup). */
  alpha: number;
  /** Socket mouth angle from the capture criterion. */
  thetaMouth: number;
  /** Per-radius angular gap between the two faces (travel + seam overlap). */
  gapAngle: number;
};

// The rounded gap is bounded by two surfaces of revolution about the joint
// axis. A rotation about the joint centre preserves each point's distance R to
// the centre, so the segments clear a bend of β iff the ANGULAR gap between
// the faces is ≥ β at every radius — the faces need not be global cones or
// spheres. Travel is θ_mouth − α (neck meets the cup rim first), same as the
// plan's contract.
function roundedGapAngles(
  joint: FlexiJointPlan,
  clearance: number,
  bendAngleDeg: number,
): RoundedGapAngles | null {
  const rc = joint.ballRadiusMm + clearance;
  const bend = (bendAngleDeg * Math.PI) / 180;
  const thetaMouth = Math.acos(
    Math.min(1, Math.max(0, joint.socketDepthMm / rc)),
  );
  const alpha = Math.max(NECK_FLOOR_RAD, thetaMouth - bend);
  if (!(thetaMouth > alpha)) {
    return null;
  }
  return {
    alpha,
    thetaMouth,
    gapAngle: thetaMouth - alpha + SHELL_OVERLAP_RAD,
  };
}

type RoundedWedge = {
  /** Cup outer wall radius — the rise starts here. */
  r1: number;
  /** Rise slope dθ/dR in rad/mm (0 = the mouth cone runs all the way out). */
  slope: number;
  /** Radius where the tail face reaches the cut-plane band (∞ if truncated). */
  r2Knot: number;
  /** Outer radius of the wedge (beyond the skin along its exit direction). */
  r3: number;
  /** Tail-face angle actually reached at r3. */
  thetaEnd: number;
};

// Solve the gap-wedge profile radii for a joint. The two faces are the same
// profile offset by gapAngle about the joint centre, so a steep rise slides
// them along each other and the printed gap between the segments collapses:
// normal separation ≈ R·g / √(1 + (R·θ′)²). The rise slope is capped so the
// faces stay at least a clearance apart (worst at the rise's inner radius r1).
// When the capped rise cannot reach the cut-plane band inside the body
// (small/low-bend joints), the band is TRUNCATED: it climbs as far as the cap
// allows and the outer radius is grown until the tilted band still punches
// through the skin (skin distance along the exit direction ≈ out/sin(exit)) —
// otherwise the gap would seal inside the body and the printed parts would
// fuse. `maxTailReachMm` caps that growth so a truncated wedge can never carve
// into a neighbouring joint's cup; if the cap wins, the cut may fail to sever
// and the build surfaces the existing 'rounded-uncut' error instead.
function solveRoundedWedge(
  angles: RoundedGapAngles,
  joint: FlexiJointPlan,
  clearance: number,
  extents: { floorMm: number; outMm: number; maxTailReachMm: number },
): RoundedWedge {
  const { alpha, gapAngle } = angles;
  const half = gapAngle / 2;
  const bandLo = Math.PI / 2 - half;
  const riseTotal = Math.max(0, bandLo - alpha);
  const r1 = joint.ballRadiusMm + clearance + FLEXI_MIN_SOCKET_WALL_MM;
  const outerBase = GROOVE_OUT_FACTOR * extents.outMm + joint.faceGapMm;
  const slopeCap =
    Math.sqrt(Math.max(0, ((r1 * gapAngle) / clearance) ** 2 - 1)) / r1;
  const spanNeeded = slopeCap > 0 ? riseTotal / slopeCap : Infinity;
  const floorR2 = Math.max(
    r1 + 0.75,
    GROOVE_FLOOR_FACTOR * extents.floorMm,
    r1 + spanNeeded,
  );

  if (
    riseTotal > 0 &&
    Number.isFinite(spanNeeded) &&
    floorR2 + 1 <= outerBase
  ) {
    // Full band: rise to the cut plane at the groove floor, exit near θ = 90°.
    return {
      r1,
      slope: riseTotal / (floorR2 - r1),
      r2Knot: floorR2,
      r3: outerBase,
      thetaEnd: bandLo,
    };
  }

  // Truncated band: climb at the slope cap; fixed-point the outer radius so
  // the tilted exit still clears the skin (required radius shrinks as r3 and
  // therefore the exit angle grow — converges monotonically).
  const slope = Number.isFinite(spanNeeded) ? slopeCap : 0;
  const tailAt = (radius: number): number =>
    Math.min(bandLo, alpha + slope * Math.max(0, radius - r1));
  let r3 = outerBase;
  for (let i = 0; i < 12; i += 1) {
    const exit = Math.min(Math.PI / 2, tailAt(r3) + gapAngle);
    r3 = Math.max(
      r1 + 2,
      outerBase,
      (1.05 * extents.outMm) / Math.sin(exit) + joint.faceGapMm,
    );
  }
  if (Number.isFinite(extents.maxTailReachMm)) {
    r3 = Math.min(
      r3,
      Math.max(r1 + 2, extents.maxTailReachMm / Math.cos(alpha)),
    );
  }
  return {
    r1,
    slope,
    r2Knot: slope > 0 ? r1 + riseTotal / slope : Infinity,
    r3,
    thetaEnd: tailAt(r3),
  };
}

// Build the per-joint cutter solid (native axis Z), then orient it onto the
// joint axis and translate to the joint centre. Null on an invalid cutter. The
// returned manifold is owned by the caller (all shell/union intermediates are
// freed here).
//
// Two revolved parts: the ball↔cup clearance shell, and a gap WEDGE between
// two profile curves θ_tail(R) / θ_head(R) = θ_tail(R) + gapAngle. Near the
// cup the wedge is the classic mouth cone (swing room for the neck, hidden
// inside the body); from the cup wall the band rotates toward the cut plane
// (as far as the wedge's solved slope allows) and runs out through the skin.
// The visible groove is therefore centred on the cut ring, its width scales
// with the local body radius times the travel angle (the physical minimum for
// free bend), and it crosses the skin steeply — no grazing sphere, no
// feathered lips. Per-radius angular gap is constant, so travel is exactly
// the plan's θ_mouth − α everywhere.
function buildRoundedCutter(
  wasm: ManifoldToplevel,
  joint: FlexiJointPlan,
  clearance: number,
  angles: RoundedGapAngles,
  wedge: RoundedWedge,
): Manifold | null {
  const r = joint.ballRadiusMm;
  const rc = r + clearance;
  const { alpha, gapAngle } = angles;
  const { r1, slope, r2Knot, r3 } = wedge;
  const bandLo = Math.PI / 2 - gapAngle / 2;

  // Profile knots: ball surface → cup outer wall → band knee → outside.
  const r0 = r;

  // Tail-face angle by radius. The head face is tailAngle + gapAngle, which
  // reproduces the old mouth opening θ_mouth + overlap at the cup rim exactly
  // (capture is pinned against it in the plan tests).
  const tailAngle = (radius: number): number => {
    if (radius <= r1 || slope <= 0) return alpha;
    return Math.min(bandLo, alpha + slope * (radius - r1));
  };

  const stepRad = (CUTTER_ARC_STEP_DEG * Math.PI) / 180;
  const point = (radius: number, theta: number): number[] => [
    radius * Math.sin(theta),
    -radius * Math.cos(theta),
  ];

  // Sample one face of the wedge from rFrom to rTo (either direction),
  // splitting the rise span so angular steps stay ≤ CUTTER_ARC_STEP_DEG.
  const facePoints = (
    rFrom: number,
    rTo: number,
    offset: number,
  ): number[][] => {
    const knots = [r0, r1, r2Knot, r3].filter(
      (k) =>
        Number.isFinite(k) &&
        k > Math.min(rFrom, rTo) &&
        k < Math.max(rFrom, rTo),
    );
    const stops = [rFrom, ...knots, rTo];
    if (rFrom > rTo) stops.sort((a, b) => b - a);
    const points: number[][] = [];
    for (let i = 0; i < stops.length - 1; i += 1) {
      const a = stops[i];
      const b = stops[i + 1];
      const sweep = Math.abs(tailAngle(b) - tailAngle(a));
      const steps = Math.max(1, Math.ceil(sweep / stepRad));
      for (let s2 = 0; s2 < steps; s2 += 1) {
        const radius = a + ((b - a) * s2) / steps;
        points.push(point(radius, tailAngle(radius) + offset));
      }
    }
    points.push(point(rTo, tailAngle(rTo) + offset));
    return points;
  };

  const arcPoints = (radius: number, t0: number, t1: number): number[][] => {
    const steps = Math.max(1, Math.ceil(Math.abs(t1 - t0) / stepRad));
    const points: number[][] = [];
    for (let i = 1; i < steps; i += 1) {
      points.push(point(radius, t0 + ((t1 - t0) * i) / steps));
    }
    return points;
  };

  // Closed wedge polygon: head face outward, outer cap, tail face inward,
  // inner cap (along the ball surface, overlapping the cup shell radially).
  const polygon: number[][] = [
    ...facePoints(r0, r3, gapAngle),
    ...arcPoints(r3, tailAngle(r3) + gapAngle, tailAngle(r3)),
    ...facePoints(r3, r0, 0),
    ...arcPoints(r0, alpha, alpha + gapAngle),
  ];
  let area = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const [x1, y1] = polygon[i];
    const [x2, y2] = polygon[(i + 1) % polygon.length];
    area += x1 * y2 - x2 * y1;
  }
  if (area < 0) polygon.reverse();

  const { CrossSection } = wasm;
  const revolve = (poly: number[][]): Manifold => {
    const section = new CrossSection(poly as [number, number][]);
    const solid = section.revolve(CUTTER_REVOLVE_SEGMENTS);
    section.delete();
    return solid;
  };
  // Ball ↔ cup clearance gap around the captured ball, plus the gap wedge.
  const cup = revolve(shellWedge(r, rc, alpha, Math.PI));
  const wedgeSolid = revolve(polygon);
  const cutter = cup.add(wedgeSolid);
  cup.delete();
  wedgeSolid.delete();
  if (cutter.status() !== 'NoError' || cutter.isEmpty()) {
    cutter.delete();
    return null;
  }

  const oriented = cutter.transform(
    orientationMatrix(joint.axis, joint.center),
  );
  cutter.delete();
  return oriented;
}

// --- Overlapping-shell (scale) cutter --------------------------------------

// Printable minimum thickness of the lap flap's tip (the head-side skin edge
// riding over the ledge). Raised from 1.2 alongside the flared soft lips: the
// flare thins the very tip, so the base flap carries a little more meat.
const SHELL_MIN_FLAP_MM = 1.6;
// Minimum overlap length (arc under the flap), in mm at the ledge radius.
const SHELL_MIN_LAP_MM = 1.8;
// Flare of the visible seam band's side walls away from radial (soft lips):
// both skin edges leave the seam at an obtuse angle instead of a knife edge.
const SHELL_LIP_FLARE_RAD = (22 * Math.PI) / 180;
// Radius of the rounded lip arcs at the seam band's base corners (the flap
// tip and the tail-side groove root).
const SHELL_LIP_RADIUS_MM = 0.4;
// Band-reach budget the flare adds at the skin (the lofted ledge keeps the
// skin within ~1.3× the ledge radius, so the wall's angular drift at the skin
// stays ≤ ~6° even though the wall itself flares 22°). Mirrored by the plan's
// SHELL_FLARE_BAND_DEG in minSegmentLengthFor.
const SHELL_FLARE_BAND_RAD = (6 * Math.PI) / 180;
// Cap on the azimuth-slip allowance added to the ledge sliding gap (guards
// fin-edged profiles from blowing the seam open; the envelope + smoothing
// keeps ordinary flattened bodies far below this).
const SHELL_SLIP_CAP_MM = 1.2;
// Cap on the loft's slip rate L·δ (mm of seam-radius change per unit |cotθ|
// of bend-induced azimuth slip) used to grade the hidden clearances under
// the flap.
const SHELL_SLIP_RATE_CAP_MM = 2.5;

type ShellWedge = {
  /** Cup outer wall radius — the internal rise starts here. */
  r1: number;
  /** Rise slope dθ/dR toward θ_A (rad/mm). */
  slope: number;
  /** Radius where the rise reaches θ_A (inner end of the hidden band). */
  r2: number;
  /** Sliding ledge sphere radius — the seam floor, just under the skin. */
  rLedge: number;
  /** Outer radius of the seam band (beyond the skin). */
  rOut: number;
  /** Head-side edge of the visible seam band (seam spans [θ_B−g, θ_B]). */
  thetaB: number;
  /** Tail edge of the hidden inner band, θ_B + lap angle. */
  thetaA: number;
  /**
   * Angular width of the rise gap above the cup wall. Equals gapAngle when
   * the slope cap holds; widened past it when the slope-capped rise could not
   * reach θ_A within the span (see solveShellWedge). Width stays gapAngle for
   * R ≤ r1 so the mouth angle, capture and travel are bit-identical.
   */
  riseGap: number;
  /** Radial sliding gap of the ledge shell (clearance + azimuth-slip). */
  slideGap: number;
};

/** Loft overrides for a skin-following (azimuth-modulated) shell seam. */
type ShellLoft = {
  /** Base (thinnest-azimuth) ledge radius the profile is built with. */
  ledgeMm: number;
  /** Base outer radius — rOut·m(φ) clears 1.15·skin + clearance everywhere. */
  outRadiusMm: number;
  /** Ledge sliding gap: clearance preset + the azimuth-slip allowance. */
  slideGapMm: number;
  /**
   * Slip rate L·δ (mm per unit |cotθ|): how much the lofted seam radius can
   * change under the bend-induced azimuth slip Δφ ≈ δ·|cotθ|·sin(φ−φ_bend)
   * for surfaces off the bend equator. Grades the hidden clearances (ledge
   * floor drop under the flap, hidden-band knee drop) with θ.
   */
  slipRateMm: number;
  /** Per-sector radial multipliers (≥ 1), periodic in the sampler frame. */
  m: Float64Array;
  /** In-plane frame the sector azimuths are measured in. */
  frame: { e1: [number, number, number]; e2: [number, number, number] };
  /** Largest lofted outer radius (band-reach estimates). */
  maxOutMm: number;
};

// Solve the overlapping-shell joint: the visible seam is a narrow band centred
// on the cut ring whose floor is a concentric SPHERE at rLedge (it slides, so
// bending never opens a view into the joint), and the head-side skin laps
// over that floor by `lap` before a hidden band (under the flap) drops down to
// the internal rise and cup. Null when the body is too thin to host the shelf
// (caller falls back to the rounded wedge for that joint). With `loft` the
// ledge/outer radii come from the per-azimuth skin solve instead of the
// support extents (the cutter is then radially warped, see solveShellLoft).
function solveShellWedge(
  angles: RoundedGapAngles,
  joint: FlexiJointPlan,
  clearance: number,
  extents: { floorMm: number; outMm: number },
  loft?: ShellLoft,
): ShellWedge | null {
  const { alpha, gapAngle } = angles;
  const cs = joint.faceGapMm;
  const slideGap = loft ? loft.slideGapMm : cs;
  const r1 = joint.ballRadiusMm + clearance + FLEXI_MIN_SOCKET_WALL_MM;
  // Ledge just under the thinnest skin, keeping a printable flap above it.
  const rLedge = loft
    ? loft.ledgeMm
    : Math.min(
        GROOVE_FLOOR_FACTOR * extents.floorMm,
        extents.floorMm - cs - SHELL_MIN_FLAP_MM,
      );
  if (!(rLedge >= r1 + 1.2)) return null;
  const r2 = rLedge - 0.8;
  if (!(r2 > r1 + 0.5)) return null;
  const thetaB = Math.PI / 2 + gapAngle / 2;
  const thetaA = thetaB + Math.max(gapAngle, SHELL_MIN_LAP_MM / rLedge);
  // The rise must reach θ_A by r2. The slope cap keeps the parallel offset
  // faces a full clearance apart (normal separation ≈ R·g/√(1+(R·θ′)²),
  // worst at the rise's inner radius r1). When the required slope exceeds
  // the cap, WIDEN the rise gap above the cup wall instead of giving up:
  // g_rise = (c/r1)·√(1+(r1·m)²) restores the clearance at the steeper slope
  // m. For R ≤ r1 the width stays gapAngle, so the mouth angle, capture and
  // travel are bit-identical; the per-radius angular gap only grows, so the
  // rotation-safety law is untouched.
  const slope = (thetaA - alpha) / (r2 - r1);
  const slopeCap =
    Math.sqrt(Math.max(0, ((r1 * gapAngle) / clearance) ** 2 - 1)) / r1;
  const riseGap =
    slope <= slopeCap
      ? gapAngle
      : (clearance / r1) * Math.sqrt(1 + (r1 * slope) ** 2);
  // Room for the head segment's polar pillar past the hidden band and the
  // (possibly widened) rise.
  if (thetaA + Math.max(gapAngle, riseGap) > Math.PI - NECK_FLOOR_RAD) {
    return null;
  }
  return {
    r1,
    slope,
    r2,
    rLedge,
    rOut: loft ? loft.outRadiusMm : GROOVE_OUT_FACTOR * extents.outMm + cs,
    thetaB,
    thetaA,
    riseGap,
    slideGap,
  };
}

// Solve the skin-lofted seam: per-azimuth ledge/outer radii from the radial
// skin profile, expressed as a base solve plus radial multipliers m(φ) ≥ 1.
//
// WHY A θ-INVARIANT, AZIMUTH-MODULATED SEAM IS BEND-SAFE: bending is a
// rotation about an equatorial axis through the joint centre. For points on
// the bend equator the first-order motion is purely in θ with no azimuth
// change, so a θ-invariant surface r = ρ·m(φ) slides over its counterpart
// exactly like a sphere does. The residual azimuth slip for a bend of δ
// radians is Δφ ≈ δ·|cotθ|·|sin(φ−φ_bend)| + δ²/4 — second order near the
// equator (the VISIBLE seam band, θ ≈ 90° ± g/2, where |cotθ| ≤ tan(g/2)),
// first order for the parts of the ledge/flap that reach past the equator.
// Slip changes the local mating radius by at most ΔR ≤ L·Δφ with
// L = max|dD/dφ|, and that cost is paid up front where each surface lives:
// the sliding clearance carries the seam-zone terms
// (slideGap = clearance preset + L·(δ·tan(g/2) + δ²/4)), while the hidden
// θ-graded allowances carry the far-flap terms (the ledge floor steps down
// with |cotθ| under the flap and the hidden band's knee drops below r2 —
// see buildShellCutter), so no mating pair can close by more than its
// protection at any bend direction. And because the loft is applied as a
// purely RADIAL map r → r·m(φ), every ANGULAR gap in the profile is
// preserved exactly — the per-radius rotation-safety law and the exact free
// travel are untouched — while radial gaps only grow (m ≥ 1 outside the
// blend zone below the cup wall).
function solveShellLoft(
  measure: FlexiSectionSampler,
  joint: FlexiJointPlan,
  angles: RoundedGapAngles,
): ShellLoft | null {
  const cs = joint.faceGapMm;
  const sectors = measure.sectorCount;
  const dPhi = (2 * Math.PI) / sectors;
  const travel = Math.max(0, angles.gapAngle - SHELL_OVERLAP_RAD);
  const plane = measure();
  if (!(plane.maxMm > 0)) return null;
  // Axial reach the seam band sweeps at the SKIN for a given local outer
  // radius (the wall's angular drift at the skin is bounded by the derated
  // flare budget, not the raw 22° wall flare — the lofted ledge keeps the
  // skin close above it).
  const seamHalfWidth = (outMm: number): number =>
    outMm *
      Math.sin(angles.gapAngle / 2 + SHELL_OVERLAP_RAD + SHELL_FLARE_BAND_RAD) +
    2;
  // Band widths are PER AZIMUTH and ASYMMETRIC: the seam band brackets the
  // cut plane by its own (small) reach on both sides, while the flap/ledge
  // additionally reach HEADWARD to θ_A + g + overlap at the LOCAL lofted
  // radius — so a tail-side taper never sinks the ledge, and the tall side's
  // reach never bands the thin azimuths. Start from the cut-plane extents
  // and iterate to the solved per-sector radii.
  let tailWidths: number | Float64Array = seamHalfWidth(
    GROOVE_OUT_FACTOR * plane.minMm + cs,
  );
  let headWidths: number | Float64Array = tailWidths;
  let result: ShellLoft | null = null;
  for (let pass = 0; pass < 4; pass += 1) {
    const prof = measure.dirProfile(tailWidths, headWidths);
    const inner = fillMissingSectors(prof.inner, 'min');
    const outer = fillMissingSectors(prof.outer, 'max');
    if (!inner || !outer) return null;
    // ±1-sector envelopes: the warp interpolates m(φ) between sector centres,
    // so the ledge respects the skin minimum of BOTH neighbouring sectors
    // (fins between samples never get gouged) and the band outer clears their
    // maximum (never bridged).
    const innerEnv = new Float64Array(sectors);
    const outerEnv = new Float64Array(sectors);
    for (let j = 0; j < sectors; j += 1) {
      const p = (j + sectors - 1) % sectors;
      const n = (j + 1) % sectors;
      innerEnv[j] = Math.min(inner[p], inner[j], inner[n]);
      outerEnv[j] = Math.max(outer[p], outer[j], outer[n]);
    }
    // Azimuth slope of the skin: ψ is the angle between the radial direction
    // and the surface normal (tanψ = (dD/dφ)/D), the flap thickness is
    // measured along the normal so the radial drop derates by 1/cosψ (≤ ~1.25
    // at 2:1 aspect; capped for fin edges), and the max slope L feeds the
    // slip allowance above.
    let slopeMax = 0;
    const derate = new Float64Array(sectors);
    for (let j = 0; j < sectors; j += 1) {
      const p = (j + sectors - 1) % sectors;
      const n = (j + 1) % sectors;
      const dD = (innerEnv[n] - innerEnv[p]) / (2 * dPhi);
      slopeMax = Math.max(slopeMax, Math.abs(dD));
      const cosPsi = innerEnv[j] / Math.hypot(innerEnv[j], dD);
      derate[j] = Math.min(1.6, 1 / Math.max(cosPsi, 1e-6));
    }
    const slipRate = Math.min(SHELL_SLIP_RATE_CAP_MM, slopeMax * travel);
    const slideGap =
      cs +
      Math.min(
        SHELL_SLIP_CAP_MM,
        slipRate * Math.tan(angles.gapAngle / 2) +
          (slopeMax * travel * travel) / 4,
      );
    const rho = new Float64Array(sectors);
    let ledgeBase = Infinity;
    for (let j = 0; j < sectors; j += 1) {
      rho[j] = innerEnv[j] - (SHELL_MIN_FLAP_MM + slideGap) * derate[j];
      ledgeBase = Math.min(ledgeBase, rho[j]);
    }
    if (!(ledgeBase > 0)) return null;
    const m = new Float64Array(sectors);
    let outBase = 0;
    let maxOut = 0;
    for (let j = 0; j < sectors; j += 1) {
      m[j] = rho[j] / ledgeBase;
      const out = GROOVE_OUT_FACTOR * outerEnv[j] + cs;
      outBase = Math.max(outBase, out / m[j]);
      maxOut = Math.max(maxOut, out);
    }
    result = {
      ledgeMm: ledgeBase,
      outRadiusMm: outBase,
      slideGapMm: slideGap,
      slipRateMm: slipRate,
      m,
      frame: measure.frame,
      maxOutMm: maxOut,
    };
    // Re-measure over the axial reach the solved seam actually sweeps AT
    // EACH AZIMUTH: the seam band around the cut ring at the local outer
    // radius, plus the ledge/flap span reaching headward to θ_A + g +
    // overlap at the local lofted ledge radius.
    const thetaA =
      Math.PI / 2 +
      angles.gapAngle / 2 +
      Math.max(angles.gapAngle, SHELL_MIN_LAP_MM / ledgeBase);
    const headCos = Math.max(
      0,
      -Math.cos(thetaA + angles.gapAngle + SHELL_OVERLAP_RAD),
    );
    const nextTail = new Float64Array(sectors);
    const nextHead = new Float64Array(sectors);
    let moved = false;
    for (let j = 0; j < sectors; j += 1) {
      const out = GROOVE_OUT_FACTOR * outerEnv[j] + cs;
      nextTail[j] = seamHalfWidth(out);
      nextHead[j] = Math.max(
        nextTail[j],
        headCos * (Math.max(rho[j], 0) + slideGap) + 2,
      );
      const previousTail =
        typeof tailWidths === 'number' ? tailWidths : tailWidths[j];
      const previousHead =
        typeof headWidths === 'number' ? headWidths : headWidths[j];
      if (
        Math.abs(nextTail[j] - previousTail) >= 0.5 ||
        Math.abs(nextHead[j] - previousHead) >= 0.5
      ) {
        moved = true;
      }
    }
    if (!moved) break;
    tailWidths = nextTail;
    headWidths = nextHead;
  }
  return result;
}

// Fill empty azimuth sectors (no vertex data over the band) from the nearest
// present neighbours: conservatively low for the ledge ('min'), high for the
// band outer ('max'). Null when no sector has data at all.
function fillMissingSectors(
  values: Float64Array,
  mode: 'min' | 'max',
): Float64Array | null {
  const n = values.length;
  let any = false;
  for (let j = 0; j < n; j += 1) {
    if (values[j] > 0) {
      any = true;
      break;
    }
  }
  if (!any) return null;
  const out = new Float64Array(n);
  for (let j = 0; j < n; j += 1) {
    if (values[j] > 0) {
      out[j] = values[j];
      continue;
    }
    let before = 0;
    let after = 0;
    for (let s = 1; s < n; s += 1) {
      const v = values[(j + s) % n];
      if (v > 0) {
        after = v;
        break;
      }
    }
    for (let s = 1; s < n; s += 1) {
      const v = values[(j + n - s) % n];
      if (v > 0) {
        before = v;
        break;
      }
    }
    if (!(before > 0)) before = after;
    if (!(after > 0)) after = before;
    out[j] = mode === 'min' ? Math.min(before, after) : Math.max(before, after);
  }
  return out;
}

// Build the overlapping-shell cutter: cup shell + four gap parts —
//   rise: mouth cone rising from the cup to θ_A (hidden inside the body;
//     its gap widens above the cup wall when the slope cap demanded it),
//   hidden band: [θ_A, θ_A+g] from the rise up under the flap,
//   ledge: the sliding sphere shell [rLedge, rLedge+slideGap] under seam
//     and flap,
//   seam band: [θ_B−g, θ_B] from the ledge out through the skin, its side
//     walls flared SHELL_LIP_FLARE from radial with rounded lip arcs so both
//     skin edges print obtuse and blunt instead of knife-edged.
// Everything is concentric or angular, so travel is exactly the plan's
// θ_mouth − α; the ledge and cup slide with constant gaps at any bend. With
// `loft` the finished solid is additionally warped by the purely radial map
// r → r·m(φ) (blended to 1 below the cup wall) — see solveShellLoft for why
// that preserves travel and rotation safety.
function buildShellCutter(
  wasm: ManifoldToplevel,
  joint: FlexiJointPlan,
  clearance: number,
  angles: RoundedGapAngles,
  shell: ShellWedge,
  loft?: ShellLoft,
): Manifold | null {
  const r = joint.ballRadiusMm;
  const rc = r + clearance;
  const { alpha, gapAngle } = angles;
  const { r1, slope, r2, rLedge, rOut, thetaB, thetaA, riseGap, slideGap } =
    shell;
  const ov = SHELL_OVERLAP_RAD;

  const stepRad = (SHELL_ARC_STEP_DEG * Math.PI) / 180;
  const point = (radius: number, theta: number): number[] => [
    radius * Math.sin(theta),
    -radius * Math.cos(theta),
  ];
  const tailAngle = (radius: number): number => {
    if (radius <= r1) return alpha;
    return Math.min(thetaA, alpha + slope * (radius - r1));
  };
  // Rise wedge polygon (mouth cone at the cup rotating up to θ_A), sampled so
  // angular steps stay ≤ CUTTER_ARC_STEP_DEG; overlaps the hidden band at r2+.
  const riseMax = r2 + 0.3;
  const facePoints = (
    rFrom: number,
    rTo: number,
    offset: number,
  ): number[][] => {
    const knots = [r1, r2].filter(
      (k) => k > Math.min(rFrom, rTo) && k < Math.max(rFrom, rTo),
    );
    const stops = [rFrom, ...knots, rTo];
    if (rFrom > rTo) stops.sort((a, b) => b - a);
    const points: number[][] = [];
    for (let i = 0; i < stops.length - 1; i += 1) {
      const a = stops[i];
      const b = stops[i + 1];
      const sweep = Math.abs(tailAngle(b) - tailAngle(a));
      const steps = Math.max(1, Math.ceil(sweep / stepRad));
      for (let s2 = 0; s2 < steps; s2 += 1) {
        const radius = a + ((b - a) * s2) / steps;
        points.push(point(radius, tailAngle(radius) + offset));
      }
    }
    points.push(point(rTo, tailAngle(rTo) + offset));
    return points;
  };
  const arcPoints = (radius: number, t0: number, t1: number): number[][] => {
    const steps = Math.max(1, Math.ceil(Math.abs(t1 - t0) / stepRad));
    const points: number[][] = [];
    for (let i = 1; i < steps; i += 1) {
      points.push(point(radius, t0 + ((t1 - t0) * i) / steps));
    }
    return points;
  };
  // Head face of the rise: the mouth cone width gapAngle from the ball out,
  // then — when the rise had to widen — an arc out to the widened gap and
  // the offset face at riseGap. The widening jump sits a clearance BELOW the
  // cup wall (still inside the wall band, above the cavity): the jump arc
  // then keeps ≥ clearance from the steep tail face climbing from (r1, α)
  // (its distance is ≈ (r1−rJump)·r1·slope/√(1+(r1·slope)²) + rJump·g/…,
  // which the parallel-offset formula alone does not cover), while the
  // socket mouth ring at the cavity radius keeps the gapAngle cone — so
  // capture and travel are bit-identical.
  const widened = riseGap > gapAngle + 1e-9;
  const rJump = Math.max(rc + 0.2, r1 - Math.max(clearance, 0.3));
  const riseHeadFace: number[][] = widened
    ? [
        point(r, alpha + gapAngle),
        point(rJump, alpha + gapAngle),
        ...arcPoints(rJump, alpha + gapAngle, alpha + riseGap),
        ...facePoints(rJump, riseMax, riseGap),
      ]
    : facePoints(r, riseMax, gapAngle);
  const risePolygon: number[][] = [
    ...riseHeadFace,
    ...arcPoints(riseMax, tailAngle(riseMax) + riseGap, tailAngle(riseMax)),
    ...facePoints(riseMax, r, 0),
    ...arcPoints(r, alpha, alpha + gapAngle),
  ];
  fixWinding(risePolygon);

  const seamPolygon = buildSeamBandPolygon(
    rLedge,
    rOut,
    thetaB,
    gapAngle,
    slideGap,
  );

  // θ-graded slip allowances (loft only): first-order azimuth slip under a
  // bend moves off-equator points by Δφ ≈ δ·|cotθ|, which on an
  // azimuth-modulated seam changes mating radii by up to slipRate·|cotθ|.
  // Pay it where it is hidden: the ledge FLOOR steps down with |cotθ| under
  // the flap (the visible seam floor at θ ≤ θ_B keeps its depth), and the
  // hidden band's inner radius drops below r2 so the head shoulder's top
  // clears the shelf bottom at slipped azimuths near the knee.
  const slipRate = loft ? loft.slipRateMm : 0;
  const cotAt = (theta: number): number => -1 / Math.tan(theta);
  const rHB = loft
    ? Math.max(r1 + 0.1, r2 - slipRate * Math.max(0, cotAt(thetaA)))
    : r2;
  const dropAt = (theta: number): number => {
    if (!(slipRate > 0)) return 0;
    return Math.min(
      rLedge - rHB,
      Math.max(0, slipRate * (cotAt(theta) - cotAt(thetaB))),
    );
  };
  const ledgePolygon: number[][] = (() => {
    const t0 = thetaB - ov;
    const t1 = thetaA + gapAngle + ov;
    const steps = Math.max(1, Math.ceil((t1 - t0) / stepRad));
    const floor: number[][] = [];
    for (let i = 0; i <= steps; i += 1) {
      const t = t0 + ((t1 - t0) * i) / steps;
      floor.push(point(rLedge - dropAt(t), t));
    }
    floor.reverse();
    return [
      ...sphereArc(rLedge + slideGap, t0, t1, SHELL_ARC_STEP_DEG),
      ...floor,
    ];
  })();
  fixWinding(ledgePolygon);

  const { CrossSection } = wasm;
  const revolve = (poly: number[][]): Manifold => {
    const section = new CrossSection(poly as [number, number][]);
    const solid = section.revolve(SHELL_REVOLVE_SEGMENTS);
    section.delete();
    return solid;
  };
  const parts = [
    // Ball ↔ cup clearance gap around the captured ball.
    revolve(shellWedge(r, rc, alpha, Math.PI, SHELL_ARC_STEP_DEG)),
    revolve(risePolygon),
    // Hidden band under the flap, from the rise (knee dropped by the slip
    // allowance) up to the ledge.
    revolve(
      shellWedge(
        rHB,
        rLedge + slideGap,
        thetaA,
        thetaA + gapAngle,
        SHELL_ARC_STEP_DEG,
      ),
    ),
    // Sliding ledge: seam floor and the flap's underside, floor graded down
    // under the flap by the slip allowance.
    revolve(ledgePolygon),
    // Visible seam band, out through the skin (flared, soft-lipped).
    revolve(seamPolygon),
  ];
  let cutter = parts[0];
  for (let i = 1; i < parts.length; i += 1) {
    const unioned = cutter.add(parts[i]);
    cutter.delete();
    parts[i].delete();
    cutter = unioned;
  }
  if (cutter.status() !== 'NoError' || cutter.isEmpty()) {
    cutter.delete();
    return null;
  }
  if (loft) {
    const warped = warpShellCutter(cutter, shell, loft);
    cutter.delete();
    if (!warped) return null;
    cutter = warped;
  }
  const oriented = cutter.transform(
    loft
      ? basisOrientationMatrix(
          loft.frame.e1,
          loft.frame.e2,
          joint.axis,
          joint.center,
        )
      : orientationMatrix(joint.axis, joint.center),
  );
  cutter.delete();
  return oriented;
}

// Apply the loft's purely radial map r → r·m(φ) to the revolved cutter,
// blended smoothly from m = 1 below the cup wall r1 to full strength at r2.
// Blending on the spherical radius R keeps the map rotation-invariant about
// the centre, monotone in R (no self-intersection) and continuous in φ, so a
// valid solid warps to a valid solid; status() is still checked and a failure
// falls back to the plain revolved shell.
function warpShellCutter(
  cutter: Manifold,
  shell: ShellWedge,
  loft: ShellLoft,
): Manifold | null {
  const { r1, r2 } = shell;
  const sectors = loft.m.length;
  const mAt = (phi: number): number => {
    const t = (phi / (2 * Math.PI)) * sectors - 0.5;
    const j0 = Math.floor(t);
    const f = t - j0;
    const a = loft.m[((j0 % sectors) + sectors) % sectors];
    const b = loft.m[(((j0 + 1) % sectors) + sectors) % sectors];
    return a + (b - a) * f;
  };
  const span = Math.max(r2 - r1, 1e-6);
  let warped: Manifold | null = null;
  try {
    warped = cutter.warp((vert) => {
      const radius = Math.hypot(vert[0], vert[1], vert[2]);
      if (!(radius > r1)) return;
      const phi = Math.atan2(vert[1], vert[0]);
      const m = mAt(Number.isFinite(phi) ? phi : 0);
      if (!(m > 1)) return;
      const t = radius >= r2 ? 1 : (radius - r1) / span;
      const smooth = t * t * (3 - 2 * t);
      const s = 1 + (m - 1) * smooth;
      vert[0] *= s;
      vert[1] *= s;
      vert[2] *= s;
    });
  } catch {
    return null;
  }
  if (warped.status() !== 'NoError' || warped.isEmpty()) {
    warped.delete();
    return null;
  }
  return warped;
}

// The visible seam band's revolve profile: a wedge from the ledge floor out
// past the skin whose side walls are flared SHELL_LIP_FLARE from radial (both
// printed skin edges leave the seam at an obtuse angle — soft lips), with a
// SHELL_LIP_RADIUS arc rounding the flap tip (head wall at the flap's
// underside radius rLedge + slideGap) and the tail-side groove root.
function buildSeamBandPolygon(
  rLedge: number,
  rOut: number,
  thetaB: number,
  gapAngle: number,
  slideGap: number,
): number[][] {
  const stepRad = (SHELL_ARC_STEP_DEG * Math.PI) / 180;
  const fr = SHELL_LIP_RADIUS_MM;
  const flare = SHELL_LIP_FLARE_RAD;
  const point = (radius: number, theta: number): number[] => [
    radius * Math.sin(theta),
    -radius * Math.cos(theta),
  ];
  const radial = (theta: number): number[] => [
    Math.sin(theta),
    Math.cos(theta) * -1,
  ];
  const tangential = (theta: number): number[] => [
    Math.cos(theta),
    Math.sin(theta),
  ];
  const thetaOf = (p: number[]): number => {
    // Inverse of `point`: θ from the profile coordinates.
    return Math.atan2(p[0], -p[1]);
  };
  const norm2 = (p: number[]): number => Math.hypot(p[0], p[1]);
  // Line from `base` along unit `dir` to the circle of radius `radius`.
  const alongTo = (
    base: number[],
    dir: number[],
    radius: number,
  ): number[] | null => {
    const bd = base[0] * dir[0] + base[1] * dir[1];
    const disc = bd * bd - (base[0] ** 2 + base[1] ** 2) + radius * radius;
    if (!(disc >= 0)) return null;
    const lambda = -bd + Math.sqrt(disc);
    if (!(lambda > 0)) return null;
    return [base[0] + lambda * dir[0], base[1] + lambda * dir[1]];
  };
  // Arc of `radius` about `center` from point `from` to point `to` (short
  // way), endpoints included.
  const filletArc = (
    center: number[],
    from: number[],
    to: number[],
  ): number[][] => {
    const a0 = Math.atan2(from[1] - center[1], from[0] - center[0]);
    let a1 = Math.atan2(to[1] - center[1], to[0] - center[0]);
    while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
    while (a0 - a1 > Math.PI) a1 += 2 * Math.PI;
    const radius = norm2([from[0] - center[0], from[1] - center[1]]);
    const steps = Math.max(2, Math.ceil(Math.abs(a1 - a0) / stepRad));
    const points: number[][] = [];
    for (let i = 0; i <= steps; i += 1) {
      const a = a0 + ((a1 - a0) * i) / steps;
      points.push([
        center[0] + radius * Math.cos(a),
        center[1] + radius * Math.sin(a),
      ]);
    }
    return points;
  };
  const arcAt = (radius: number, t0: number, t1: number): number[][] => {
    const steps = Math.max(1, Math.ceil(Math.abs(t1 - t0) / stepRad));
    const points: number[][] = [];
    for (let i = 0; i <= steps; i += 1) {
      points.push(point(radius, t0 + ((t1 - t0) * i) / steps));
    }
    return points;
  };

  const thetaTail = thetaB - gapAngle;
  // Head wall: flared headward (+θ) from its base on the ledge.
  const headBase = point(rLedge, thetaB);
  const uH = radial(thetaB);
  const tH = tangential(thetaB);
  const wH = [
    uH[0] * Math.cos(flare) + tH[0] * Math.sin(flare),
    uH[1] * Math.cos(flare) + tH[1] * Math.sin(flare),
  ];
  // Tail wall: flared tailward (−θ).
  const tailBase = point(rLedge, thetaTail);
  const uT = radial(thetaTail);
  const tT = tangential(thetaTail);
  const wT = [
    uT[0] * Math.cos(flare) - tT[0] * Math.sin(flare),
    uT[1] * Math.cos(flare) - tT[1] * Math.sin(flare),
  ];
  const headOut = alongTo(headBase, wH, rOut);
  const tailOut = alongTo(tailBase, wT, rOut);
  if (!headOut || !tailOut) {
    // Degenerate flare (should not happen with rOut > rLedge); fall back to
    // the plain radial-walled wedge.
    return [
      ...sphereArc(rOut, thetaTail, thetaB),
      ...sphereArc(rLedge, thetaB, thetaTail),
    ];
  }

  // Flap-tip fillet: arc of radius fr tangent to the head wall (headward
  // side) and to the flap's underside sphere rLedge + slideGap from outside —
  // the union with the ledge shell then leaves a rounded, obtuse flap tip.
  const rFlap = rLedge + slideGap;
  const nH = [-wH[1], wH[0]]; // +90°: the headward side of the wall.
  let headLip: number[][] | null = null;
  {
    const q = [headBase[0] + fr * nH[0], headBase[1] + fr * nH[1]];
    const bd = q[0] * wH[0] + q[1] * wH[1];
    const target = rFlap + fr;
    const disc = bd * bd - (q[0] ** 2 + q[1] ** 2) + target * target;
    if (disc >= 0) {
      const a = -bd + Math.sqrt(disc);
      if (a > 0) {
        const center = [q[0] + a * wH[0], q[1] + a * wH[1]];
        const t1 = [center[0] - fr * nH[0], center[1] - fr * nH[1]];
        const clen = norm2(center);
        const t2 = [(center[0] * rFlap) / clen, (center[1] * rFlap) / clen];
        if (norm2(t1) < rOut - 0.5) {
          headLip = filletArc(center, t1, t2);
        }
      }
    }
  }
  // Tail groove-root fillet: cut the cutter's convex base corner with an arc
  // tangent to the ledge floor and the tail wall, so the printed groove root
  // is a rounded cove instead of a sharp crease.
  const nT = [wT[1], -wT[0]]; // −90°: the headward (interior) side.
  let tailRoot: number[][] | null = null;
  {
    const q = [tailBase[0] + fr * nT[0], tailBase[1] + fr * nT[1]];
    const bd = q[0] * wT[0] + q[1] * wT[1];
    const target = rLedge + fr;
    const disc = bd * bd - (q[0] ** 2 + q[1] ** 2) + target * target;
    if (disc >= 0) {
      const a = -bd + Math.sqrt(disc);
      if (a > 0) {
        const center = [q[0] + a * wT[0], q[1] + a * wT[1]];
        const clen = norm2(center);
        const floorTangent = [
          (center[0] * rLedge) / clen,
          (center[1] * rLedge) / clen,
        ];
        const wallTangent = [center[0] - fr * nT[0], center[1] - fr * nT[1]];
        tailRoot = [...filletArc(center, floorTangent, wallTangent)];
      }
    }
  }

  // Walk: ledge floor (headmost point under the flap tip, tailward to the
  // groove root), rounded root, up the flared tail wall, outer cap, down the
  // flared head wall into the flap-tip fillet. The closing edge (fillet's
  // sphere tangent point radially down to the floor's headmost point) is
  // buried inside the ledge shell's coverage, so the union hides it.
  const floorHeadTheta = headLip
    ? thetaOf(headLip[headLip.length - 1])
    : thetaB;
  const floorTailTheta = tailRoot ? thetaOf(tailRoot[0]) : thetaTail;
  const polygon: number[][] = [
    // Ledge floor, walked tailward. Its first point closes the polygon with
    // a radial edge down from the flap-tip fillet; its last point would
    // duplicate the groove root's first, so it is dropped when rounded.
    ...arcAt(rLedge, floorHeadTheta, floorTailTheta).slice(
      0,
      tailRoot ? -1 : undefined,
    ),
    // Rounded groove root, then up the flared tail wall.
    ...(tailRoot ?? []),
    tailOut,
    // Outer cap.
    ...arcAt(rOut, thetaOf(tailOut), thetaOf(headOut)),
    // Down the flared head wall to the flap-tip fillet.
    ...(headLip ?? []),
  ];
  fixWinding(polygon);
  return polygon;
}

// Normalize a profile polygon to CCW (positive area) in place.
function fixWinding(polygon: number[][]): void {
  let area = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const [x1, y1] = polygon[i];
    const [x2, y2] = polygon[(i + 1) % polygon.length];
    area += x1 * y2 - x2 * y1;
  }
  if (area < 0) polygon.reverse();
}

// A simple closed CCW polygon for a spherical-shell wedge between radii Ra < Rb
// over θ ∈ [t0, t1], sampled along both arcs. Point on radius R at angle θ from
// the −s (tail) axis: (ρ, s) = (R·sinθ, −R·cosθ). Outer arc first keeps it CCW.
function shellWedge(
  ra: number,
  rb: number,
  t0: number,
  t1: number,
  stepDeg: number = CUTTER_ARC_STEP_DEG,
): number[][] {
  return [...sphereArc(rb, t0, t1, stepDeg), ...sphereArc(ra, t1, t0, stepDeg)];
}

function sphereArc(
  radius: number,
  t0: number,
  t1: number,
  stepDeg: number = CUTTER_ARC_STEP_DEG,
): number[][] {
  const stepRad = (stepDeg * Math.PI) / 180;
  const steps = Math.max(1, Math.ceil(Math.abs(t1 - t0) / stepRad));
  const points: number[][] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = t0 + ((t1 - t0) * i) / steps;
    points.push([radius * Math.sin(t), -radius * Math.cos(t)]);
  }
  return points;
}

// Column-major 4×4 mapping the revolve's native +X/+Y onto an EXPLICIT
// in-plane basis (the lofted cutter's azimuths must line up with the frame
// its skin profile was measured in) and +Z onto the joint axis.
function basisOrientationMatrix(
  e1: [number, number, number],
  e2: [number, number, number],
  axis: [number, number, number],
  center: [number, number, number],
): ReturnType<typeof orientationMatrix> {
  const z = normalizeVec(axis);
  return [
    e1[0],
    e1[1],
    e1[2],
    0,
    e2[0],
    e2[1],
    e2[2],
    0,
    z[0],
    z[1],
    z[2],
    0,
    center[0],
    center[1],
    center[2],
    1,
  ];
}

// Column-major 4×4 that maps the revolve's native +Z axis onto `axis` (with an
// arbitrary perpendicular basis — the cutter is rotationally symmetric) and
// translates to `center`.
function orientationMatrix(
  axis: [number, number, number],
  center: [number, number, number],
): [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
] {
  const z: Vec3 = normalizeVec(axis);
  const reference: Vec3 = Math.abs(z[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const x = normalizeVec(crossVec(reference, z));
  const y = crossVec(z, x);
  return [
    x[0],
    x[1],
    x[2],
    0,
    y[0],
    y[1],
    y[2],
    0,
    z[0],
    z[1],
    z[2],
    0,
    center[0],
    center[1],
    center[2],
    1,
  ];
}

function componentCentroid(component: Manifold): [number, number, number] {
  const mesh = component.getMesh();
  const numProp = mesh.numProp;
  const vertexCount = mesh.vertProperties.length / numProp;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (let v = 0; v < vertexCount; v += 1) {
    sx += mesh.vertProperties[v * numProp];
    sy += mesh.vertProperties[v * numProp + 1];
    sz += mesh.vertProperties[v * numProp + 2];
  }
  const n = vertexCount || 1;
  return [sx / n, sy / n, sz / n];
}

function normalizeVec(v: [number, number, number]): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len > 1e-12 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 1];
}

function crossVec(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

// --- Geometry helpers ------------------------------------------------------

function makeSphere(
  wasm: ManifoldToplevel,
  keep: (manifold: Manifold) => Manifold,
  center: [number, number, number],
  radius: number,
): Manifold {
  const sphere = keep(wasm.Manifold.sphere(radius, SPHERE_SEGMENTS));
  return keep(sphere.translate(center as Vec3));
}

function pointAlong(joint: FlexiJointPlan, distance: number): Vec3 {
  return [
    joint.center[0] + joint.axis[0] * distance,
    joint.center[1] + joint.axis[1] * distance,
    joint.center[2] + joint.axis[2] * distance,
  ];
}

function negate(v: [number, number, number]): Vec3 {
  return [-v[0], -v[1], -v[2]];
}

function dot(a: Vec3, b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// --- Vertex weld -----------------------------------------------------------

const WELD_TOLERANCE_MM = 0.01;

function weldMesh(
  positions: Float32Array,
  indices: Uint32Array,
): { positions: Float32Array; indices: Uint32Array } {
  const map = new Map<string, number>();
  const outPositions: number[] = [];
  const remap = new Int32Array(positions.length / 3);
  for (let v = 0; v < positions.length / 3; v += 1) {
    const x = positions[v * 3];
    const y = positions[v * 3 + 1];
    const z = positions[v * 3 + 2];
    const key = `${Math.round(x / WELD_TOLERANCE_MM)},${Math.round(
      y / WELD_TOLERANCE_MM,
    )},${Math.round(z / WELD_TOLERANCE_MM)}`;
    let index = map.get(key);
    if (index === undefined) {
      index = outPositions.length / 3;
      outPositions.push(x, y, z);
      map.set(key, index);
    }
    remap[v] = index;
  }

  const outIndices: number[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = remap[indices[i]];
    const b = remap[indices[i + 1]];
    const c = remap[indices[i + 2]];
    if (a === b || b === c || a === c) continue;
    outIndices.push(a, b, c);
  }

  return {
    positions: new Float32Array(outPositions),
    indices: new Uint32Array(outIndices),
  };
}

// --- Nearest-colour spatial grid ------------------------------------------

type ColorGrid = { nearest: (x: number, y: number, z: number) => Vec3 };

function buildColorGrid(meshInput: FlexiMeshInput): ColorGrid {
  const { positions, colors } = meshInput;
  const vertexCount = Math.floor(positions.length / 3);
  if (vertexCount === 0) {
    return { nearest: () => [1, 1, 1] };
  }

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let v = 0; v < vertexCount; v += 1) {
    const x = positions[v * 3];
    const y = positions[v * 3 + 1];
    const z = positions[v * 3 + 2];
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
  const cell = Math.max(diag / 64, 1e-3);

  const grid = new Map<string, number[]>();
  const cellOf = (
    x: number,
    y: number,
    z: number,
  ): [number, number, number] => [
    Math.floor((x - minX) / cell),
    Math.floor((y - minY) / cell),
    Math.floor((z - minZ) / cell),
  ];
  for (let v = 0; v < vertexCount; v += 1) {
    const [cx, cy, cz] = cellOf(
      positions[v * 3],
      positions[v * 3 + 1],
      positions[v * 3 + 2],
    );
    const key = `${cx},${cy},${cz}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(v);
    else grid.set(key, [v]);
  }

  const nearest = (x: number, y: number, z: number): Vec3 => {
    const [cx, cy, cz] = cellOf(x, y, z);
    let best = -1;
    let bestDistance = Infinity;
    for (let radius = 0; radius <= 64; radius += 1) {
      for (let ox = -radius; ox <= radius; ox += 1) {
        for (let oy = -radius; oy <= radius; oy += 1) {
          for (let oz = -radius; oz <= radius; oz += 1) {
            // Only visit the newly added shell cells.
            if (
              radius > 0 &&
              Math.abs(ox) !== radius &&
              Math.abs(oy) !== radius &&
              Math.abs(oz) !== radius
            ) {
              continue;
            }
            const bucket = grid.get(`${cx + ox},${cy + oy},${cz + oz}`);
            if (!bucket) continue;
            for (const v of bucket) {
              const ddx = positions[v * 3] - x;
              const ddy = positions[v * 3 + 1] - y;
              const ddz = positions[v * 3 + 2] - z;
              const distance = ddx * ddx + ddy * ddy + ddz * ddz;
              if (distance < bestDistance) {
                bestDistance = distance;
                best = v;
              }
            }
          }
        }
      }
      // Once a candidate is found, one more shell guarantees correctness.
      if (best >= 0 && radius >= 1) break;
    }
    if (best < 0) return [1, 1, 1];
    return [colors[best * 3], colors[best * 3 + 1], colors[best * 3 + 2]];
  };

  return { nearest };
}

// --- ITK repair (dynamic import, node + browser) --------------------------

async function repairWithItk(
  positions: Float32Array,
  indices: Uint32Array,
): Promise<{ positions: Float32Array; indices: Uint32Array } | null> {
  if (indices.length / 3 < ITK_REPAIR_MIN_TRIANGLES) {
    return null;
  }
  try {
    const [itk, meshFilters] = await Promise.all([
      import('itk-wasm'),
      import('@itk-wasm/mesh-filters'),
    ]);
    const candidate =
      'repair' in meshFilters && typeof meshFilters.repair === 'function'
        ? meshFilters.repair
        : (meshFilters as { repairNode?: unknown }).repairNode;
    if (typeof candidate !== 'function') {
      return null;
    }
    const repairMesh = candidate as (
      mesh: unknown,
      options: Record<string, number>,
    ) => Promise<{ outputMesh?: ItkMeshLike }>;

    const inputMesh = buildItkMesh(positions, indices, itk);
    const { outputMesh } = await repairMesh(inputMesh, {
      maximumHoleArea: 100,
      maximumHoleEdges: 2048,
      mergeTolerance: 0.001,
    });
    return convertItkMesh(outputMesh);
  } catch (error) {
    console.warn('Flexi ITK repair failed; treating as not-watertight.', error);
    return null;
  }
}

function buildItkMesh(
  positions: Float32Array,
  indices: Uint32Array,
  itk: typeof import('itk-wasm'),
): unknown {
  const mesh = new itk.Mesh(
    new itk.MeshType(
      3,
      itk.FloatTypes.Float32,
      itk.IntTypes.UInt8,
      itk.PixelTypes.Scalar,
      0,
      itk.IntTypes.UInt32,
      itk.IntTypes.UInt8,
      itk.PixelTypes.Scalar,
      0,
    ),
  );
  mesh.numberOfPoints = positions.length / 3;
  mesh.points = new Float32Array(positions);
  mesh.numberOfPointPixels = 0;
  mesh.pointData = new Uint8Array();
  mesh.numberOfCells = indices.length / 3;
  mesh.cellBufferSize = (indices.length / 3) * 5;
  const cells = new Uint32Array(mesh.cellBufferSize);
  mesh.numberOfCellPixels = 0;
  mesh.cellData = new Uint8Array();
  for (let t = 0; t < indices.length / 3; t += 1) {
    cells.set(
      [2, 3, indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]],
      t * 5,
    );
  }
  mesh.cells = cells;
  return mesh;
}

type ItkMeshLike = {
  points?: ArrayLike<number>;
  cells?: ArrayLike<number>;
  numberOfPoints?: number;
};

function convertItkMesh(
  mesh: ItkMeshLike | undefined,
): { positions: Float32Array; indices: Uint32Array } | null {
  if (!mesh?.points || !mesh.cells || (mesh.numberOfPoints ?? 0) <= 0) {
    return null;
  }
  const positions = new Float32Array(mesh.points.length);
  for (let i = 0; i < mesh.points.length; i += 1) {
    positions[i] = Number(mesh.points[i]);
  }

  const indices: number[] = [];
  for (let offset = 0; offset < mesh.cells.length; ) {
    offset += 1;
    const vertexCount = Number(mesh.cells[offset]);
    offset += 1;
    if (!Number.isInteger(vertexCount) || vertexCount <= 0) {
      return null;
    }
    if (vertexCount === 3 && offset + 2 < mesh.cells.length) {
      indices.push(
        Number(mesh.cells[offset]),
        Number(mesh.cells[offset + 1]),
        Number(mesh.cells[offset + 2]),
      );
    }
    offset += vertexCount;
  }

  return { positions, indices: new Uint32Array(indices) };
}
