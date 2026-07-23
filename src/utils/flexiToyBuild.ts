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
import { FLEXI_DEFAULT_JOINT_STYLE } from './flexiToyTypes.ts';
import type {
  FlexiMeshInput,
  FlexiToySettings,
  FlexiToyPlan,
  FlexiJointPlan,
  FlexiToyResult,
  FlexiToyWarning,
  FlexiToyOutcome,
} from './flexiToyTypes.ts';
import { crossSectionExtentsAt } from './flexiToyPlan.ts';

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
const CUTTER_REVOLVE_SEGMENTS = 64;
// Arc sampling step (degrees) for the profile polygon.
const CUTTER_ARC_STEP_DEG = 3;
// Neck strength floor: neck half-angle ≥ asin(0.35) so the neck stays ≥ 0.35·r.
const NECK_FLOOR_RAD = Math.asin(0.35);
// Extra angular room past the mouth for the bowl before the brim flares out.
const BOWL_MARGIN_RAD = (12 * Math.PI) / 180;
// Overlap the shell θ-ranges by this so boolean seams never coincide (a shared
// seam vertex reads as a zero-distance touch between the two segments).
const SHELL_OVERLAP_RAD = (3 * Math.PI) / 180;
// Brim outer radius as a multiple of the local body radius, so the plate exits
// the skin (the visible groove) but not much further.
const BRIM_PLATE_FACTOR = 1.25;

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
      const grouped = buildRoundedSegments(
        wasm,
        keep,
        base.manifold,
        cutJoints,
        meshInput,
        clearance,
        settings.bendAngleDeg,
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
    }

    const assembled = assemblePieces(segments, meshInput);

    const warnings: FlexiToyWarning[] = [...plan.warnings];
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
  const { Manifold, Mesh } = wasm;
  try {
    const mesh = new Mesh({
      numProp: 3,
      vertProperties: new Float32Array(positions),
      triVerts: new Uint32Array(indices),
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
): Manifold[][] | 'uncut' | null {
  // Sequential subtract, freeing each intermediate immediately so a 19-joint
  // body doesn't pile up full-body copies (only the running cut is retained).
  let cut = body;
  for (const joint of cutJoints) {
    // Brim radius from the WIDEST cross-section direction so the plate exits the
    // skin even on a tall/eccentric section; containment (min direction) is
    // enforced in planning.
    const extents = crossSectionExtentsAt(
      meshInput.positions,
      joint.center,
      joint.axis,
    );
    if (!(extents.maxMm > 0)) {
      return null;
    }
    const cutter = buildRoundedCutter(
      wasm,
      joint,
      clearance,
      bendAngleDeg,
      extents.maxMm,
    );
    if (!cutter) {
      return null;
    }
    const next = cut.subtract(cutter);
    cutter.delete();
    if (cut !== body) cut.delete();
    cut = next;
    if (cut.status() !== 'NoError' || cut.isEmpty()) {
      if (cut !== body) cut.delete();
      return null;
    }
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

// Build the per-joint cutter solid (native axis Z), then orient it onto the
// joint axis and translate to the joint centre. Null on an invalid cutter. The
// returned manifold is owned by the caller (all shell/union intermediates are
// freed here). `brimRadius` is the widest local half-extent so the plate exits
// the skin even on an eccentric cross-section.
function buildRoundedCutter(
  wasm: ManifoldToplevel,
  joint: FlexiJointPlan,
  clearance: number,
  bendAngleDeg: number,
  brimRadius: number,
): Manifold | null {
  const r = joint.ballRadiusMm;
  const h = joint.socketDepthMm;
  const c = clearance;
  const gb = joint.faceGapMm;
  const rc = r + c;
  // The outer "plate" is a LARGE concentric sphere (radius > the local skin so it
  // exits as the visible groove). Being concentric with the joint, its gap is
  // rotation-invariant — the segments never collide there, so travel is limited
  // only by the neck reaching the socket mouth (a flat plate would collide on
  // bend at ~2°, defeating the whole point).
  const rPlate = BRIM_PLATE_FACTOR * brimRadius;
  const bend = (bendAngleDeg * Math.PI) / 180;

  // θ_mouth from the socket depth (same capture criterion as planning), α_neck
  // floored for strength.
  const thetaMouth = Math.acos(Math.min(1, Math.max(0, h / rc)));
  const alpha = Math.max(NECK_FLOOR_RAD, thetaMouth - bend);
  // The plate sweeps from the mouth out past the equator so the large sphere
  // definitely crosses (and exits) the skin near θ = 90°.
  const thetaHi = Math.min(
    Math.PI - 0.05,
    Math.PI * 0.5 + bend + BOWL_MARGIN_RAD,
  );
  if (!(thetaMouth > alpha) || !(thetaHi > thetaMouth + SHELL_OVERLAP_RAD)) {
    return null;
  }

  // Three simple revolved shells whose θ-ranges are overlapped by SHELL_OVERLAP
  // so boolean seams do not coincide (a shared seam vertex reads as a
  // zero-distance touch). The mouth shell therefore opens a hair past θ_mouth —
  // capture is pinned against θ_mouth + SHELL_OVERLAP in the plan tests. All
  // three gap surfaces are spheres concentric with the joint centre.
  const { CrossSection } = wasm;
  const revolve = (polygon: number[][]): Manifold => {
    const section = new CrossSection(polygon as [number, number][]);
    const solid = section.revolve(CUTTER_REVOLVE_SEGMENTS);
    section.delete();
    return solid;
  };
  const parts = [
    // Ball ↔ cup clearance gap around the captured ball.
    revolve(shellWedge(r, rc, alpha, Math.PI)),
    // Mouth: open swing room from the ball out to the plate for the neck.
    revolve(shellWedge(r, rPlate + gb, alpha, thetaMouth + SHELL_OVERLAP_RAD)),
    // Plate: the large concentric sphere gap that exits the skin.
    revolve(
      shellWedge(rPlate, rPlate + gb, thetaMouth - SHELL_OVERLAP_RAD, thetaHi),
    ),
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

  const oriented = cutter.transform(
    orientationMatrix(joint.axis, joint.center),
  );
  cutter.delete();
  return oriented;
}

// A simple closed CCW polygon for a spherical-shell wedge between radii Ra < Rb
// over θ ∈ [t0, t1], sampled along both arcs. Point on radius R at angle θ from
// the −s (tail) axis: (ρ, s) = (R·sinθ, −R·cosθ). Outer arc first keeps it CCW.
function shellWedge(
  ra: number,
  rb: number,
  t0: number,
  t1: number,
): number[][] {
  return [...sphereArc(rb, t0, t1), ...sphereArc(ra, t1, t0)];
}

function sphereArc(radius: number, t0: number, t1: number): number[][] {
  const stepRad = (CUTTER_ARC_STEP_DEG * Math.PI) / 180;
  const steps = Math.max(1, Math.ceil(Math.abs(t1 - t0) / stepRad));
  const points: number[][] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = t0 + ((t1 - t0) * i) / steps;
    points.push([radius * Math.sin(t), -radius * Math.cos(t)]);
  }
  return points;
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
