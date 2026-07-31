/**
 * Pure planning for the Flexi Toy Maker (no three.js, no manifold).
 *
 * Operates on the transferable typed arrays of a `FlexiMeshInput` and produces a
 * deterministic `FlexiToyPlan`: principal spine, evenly spaced cut stations, and
 * per-joint ball/socket sizing that honours the printable floors in
 * `flexiToyTypes.ts`. The boolean build (`flexiToyBuild.ts`) consumes this plan.
 *
 * Coordinate space: this module plans in whatever mm space the positions it is
 * given occupy. The caller (worker / build test) scales the mesh to the target
 * length first via `computeFlexiScale` + `scaleFlexiPositions`, so the plan's
 * joint sizing sees absolute millimetres.
 */

import {
  FLEXI_MIN_SEGMENTS,
  FLEXI_MAX_SEGMENTS,
  FLEXI_MIN_BALL_RADIUS_MM,
  FLEXI_MIN_SOCKET_WALL_MM,
  FLEXI_CAPTURE_MARGIN_MM,
  FLEXI_MAX_FACE_GAP_MM,
  FLEXI_DEFAULT_JOINT_STYLE,
  assertNever,
} from './flexiToyTypes.ts';
import type {
  FlexiMeshInput,
  FlexiToySettings,
  FlexiToyPlan,
  FlexiJointPlan,
  FlexiToyWarning,
  FlexiAxisOverride,
  FlexiJointStyle,
} from './flexiToyTypes.ts';

type Vec3 = [number, number, number];

// Planning tunables (see spec §4.2–4.3). Kept module-local so the numbers live
// next to the maths that reads them.
const BIN_COUNT = 64;
const SMOOTH_TAPS = 5;
const CROSS_SECTION_DIRECTIONS = 16;
// Signed azimuth sectors for the radial skin profile (the lofted shell seam
// needs the actual radial skin distance per azimuth, not the support-function
// max-projection the direction fan measures). 64 sectors keep the ±1-sector
// safety envelope's cost under ~0.5mm on a 2:1 elliptical section.
const CROSS_SECTION_SECTORS = 64;
const AUTO_SEGMENT_PITCH_MM = 22;
const AUTO_MIN_SEGMENTS = 4;
const BALL_SIZE_FACTOR = 0.55;
const SOCKET_DEPTH_FACTOR = 0.65;
const SOCKET_DEPTH_FACTOR_MAX = 0.75;
// Cross-section profile: axial bin width, the widening slab half-widths used to
// evaluate a cross-section (start thin, widen only when the slab is too sparse
// to trust — coarse tessellation can otherwise leave a mid-body slab empty),
// and the minimum point count that makes a slab trustworthy.
const PROFILE_BIN_MM = 0.5;
const SLAB_WIDEN_HALF_WIDTHS = [1, 2, 3];
const MIN_SLAB_POINTS = 8;
// Containment: number of axial samples across the ball's full reach ±(r+c), and
// the ball-radius decrement used to shrink until the socket sphere is contained.
const CONTAINMENT_SAMPLES = 8;
const SIZING_SHRINK_STEP_MM = 0.2;
// Extra clear space required between two joints' spheres inside one short segment.
const OVERLAP_MARGIN_MM = 0.5;
// Gap-band spacing budget (rounded family): seam overlap angle added to the
// travel (mirrors the build's SHELL_OVERLAP_RAD) and the minimum solid slab
// that must survive between two adjacent joints' bands at the widest feature.
const GAP_BAND_OVERLAP_DEG = 3;
const GAP_BAND_KEEP_MM = 3;
// Overlapping-shell planning mirrors of the build's cutter tunables (the build
// cannot be imported here without a cycle): seam-floor factor, printable flap
// tip, and the minimum lap shelf (ledge − cup wall) the plan should reserve so
// a joint sized here actually hosts the shell in the build. The plan floor
// (2.5mm) is deliberately looser than the build's hard gate (1.2mm) — sizing
// shrinks the ball a step to make the shelf fit rather than letting the whole
// joint fall back to the rounded groove.
const SHELL_FLOOR_FACTOR = 0.92;
const SHELL_MIN_FLAP_MM = 1.6;
const SHELL_LAP_SHELF_MM = 2.5;
// Extra half-band angle (deg) the shell seam's flared lip walls can add to the
// gap band's axial reach at the skin (mirrors the build's SHELL_LIP_FLARE
// derated by the lofted ledge sitting close under the skin).
const SHELL_FLARE_BAND_DEG = 6;
// --- Strong ("strong joints") style tunables -------------------------------
// The male is a SPHERICAL bearing HEAD at the pivot on a rectangular BAR that
// crosses the visible gap and buries itself in the tail segment. The female is a
// CONCENTRIC spherical pocket behind a THROAT LAND whose tapered slot passes the
// bar. These live here — not in the build — because both stages call
// `solveStrongJointGeometry`, so the two cannot drift.
//
// WHY A SPHERE (fix-3). The first cut of this style used a truncated octahedral
// gem with a FLAT rear face. Two independent defects came out of that one
// choice, and both are structural, not tuning:
//
//  · RATTLE. A flat face is not rotation-invariant. Its outer corner sweeps to a
//    depth `S·cos β + (r−S)·sin β` when the joint bends, so the cavity's tail
//    wall has to sit behind that — and the gem can then slide the whole way
//    back. Measured pull-out reached 2.92mm at bend 25°, 4× the reference toy's.
//  · ESCAPE. Pinning capture on the lateral axis only (`rear − throat = 0.3`)
//    left the gem THINNER (2·S) than the slot was TALL, so a ~50° roll turned it
//    edge-on and it walked straight out of the throat.
//
// Law 2 — concentric spheres slide on each other with constant gap — kills both
// at once. A ball of radius `r` in a ball of radius `r + c`:
//  · has exactly `c` of play in five of the six translation directions, and the
//    sixth (pull-out, where the throat slot interrupts the bearing surface) is
//    solved and capped at `strongPullBudget` (§`solveStrongJointGeometry`);
//  · is CAPTIVE under any rigid motion whatsoever, because a ball of radius `r`
//    cannot pass a rectangular hole whose smaller half-extent is under `r` —
//    an argument that does not care about roll, tilt, or their composition;
//  · keeps its clearance exactly through the bend without any swept-envelope
//    bookkeeping, since rotation about the pivot preserves every radius.
//
// The cost is honest and recorded in §risks: the head is no longer faceted, so
// the pocket roof prints as a dome (exactly what the shipped `rounded` socket
// already does), and the twist key is now the bar alone.
const STRONG_BLADE_FRACTION = 0.35; // target bar half-width  = 0.35·r
const STRONG_BLADE_HEIGHT_FRACTION = 0.62; // target bar half-height = 0.62·r
const STRONG_BLADE_MIN_MM = 1.4; // hard floor on bar WIDTH (2·bh)
const STRONG_BLADE_MIN_HEIGHT_MM = 0.6; // hard floor on bar half-HEIGHT
// Seam overlap on top of the travel (mirrors GAP_BAND_OVERLAP_DEG / the build's
// SHELL_OVERLAP_RAD) and the caps on the near-axis clearance term.
//
// This is the SEAM's cushion, not the joint's travel margin. The seam is the
// loosest part of the mechanism: what actually stops a swing first is the bar
// in its slot or the ball in its pocket, so the measured first contact lands at
// bend + 2.6° … + 5° across the tested box (spindle and winged fixtures, bend
// 12 and 25, clearance 0.4) rather than at exactly bend + 3°. Every direction
// clears the requested bend; do not read this constant as the delivered margin.
const STRONG_SEAM_OVERLAP_DEG = 3;
const STRONG_SEAM_EXTRA_MAX_RAD = Math.PI / 3;
const STRONG_SEAM_EPS_MM = 0.25;
const STRONG_SEAM_INNER_PAD_MM = 1.0;
const STRONG_GEM_UNION_OVERLAP_MM = 0.2;
// The bar solve is a short fixed point: the oblique-bend corner pad depends on
// the very half-extents it helps size.
const STRONG_SOLVE_ITERATIONS = 12;
// Samples used to maximise the rectangular bar's oblique-bend corner excess
// (see `strongCornerPad`). 32 steps pins the maximum to well under 1 µm.
const STRONG_CORNER_SAMPLES = 32;
// Fixed-point depth of the bearing-radius solve (where the throat slot's wall
// meets the cavity's spherical wall). Converges geometrically; 40 is far past
// machine precision for the whole legal settings box.
const STRONG_BEARING_ITERATIONS = 40;
// Facet count of the head/pocket spheres. The build reads these — they live here
// because the SOLVER has to know them: a faceted sphere is not its ideal ball,
// and the difference is the same order as the tolerance the pull-out budget is
// stated to, so ignoring it would make the solved figure a fiction. (Measured
// on the built solids: n = 64 alone put the pull-out 0.06mm over budget at
// bend 25° / clearance 0.55.)
//
// manifold's geodesic sphere refines an octahedron and puts every VERTEX on the
// sphere, so its facet planes sit at `1 − 13.5/n²` of the nominal radius
// (measured 13.26/n², flat across n = 32…128; rounded up here). The pocket is
// therefore built oversize by the reciprocal so it still CONTAINS its ideal
// ball, and the head is left nominal so it is CONTAINED in its own.
export const STRONG_SPHERE_SEGMENTS = 96;
const STRONG_SPHERE_INRADIUS_RATIO =
  1 - 13.5 / (STRONG_SPHERE_SEGMENTS * STRONG_SPHERE_SEGMENTS);
export const STRONG_SPHERE_INFLATION = 1 / STRONG_SPHERE_INRADIUS_RATIO;
/** Thickness of the annular land plate the throat slot is cut through. */
const strongThroatLand = (r: number): number =>
  Math.min(1.6, Math.max(0.8, 0.3 * r));
/**
 * Ceiling on the strong joint's pull-out slop. `clearanceMm` is what the other
 * five directions give for free; the pull-out direction is interrupted by the
 * throat slot, so it is allowed one capture margin more and the bar is narrowed
 * until it complies. The reference toy measures 0.72mm printed pull-out, which
 * is this budget at the standard preset.
 */
const strongPullBudget = (clearanceMm: number): number =>
  clearanceMm + FLEXI_CAPTURE_MARGIN_MM;
/** How far past the tail face the bar buries itself so it fuses to the tail segment. */
const strongAnchor = (r: number): number => Math.max(2.0, 0.5 * r);
// Rounded-style joint: cup wall thickness and the constant bowl (outer) gap. The
// concentric dome-in-dish makes travel gap-independent, so the printed groove is
// just this fixed gap; faceGapMm carries it (see FlexiJointPlan JSDoc).
const ROUNDED_CUP_WALL_MM = FLEXI_MIN_SOCKET_WALL_MM;
const ROUNDED_MIN_BOWL_GAP_MM = 0.55;
// A cut is "vertical" when the spine tangent's horizontal (xz) magnitude is at
// least this; below it the raw tangent is kept and a 'cuts-not-vertical' warning
// is emitted for that plan.
const HORIZONTAL_TANGENT_MIN = 0.3;
// Weld/overlap margin kept between the ball and its own segment body so a wide
// bend-driven face gap can never sever ball-to-segment connectivity.
const BALL_CONNECTIVITY_MARGIN_MM = 0.2;
// User-dragged cut stations are clamped into this open fraction range.
const STATION_MIN_FRACTION = 0.02;
const STATION_MAX_FRACTION = 0.98;
// A dragged station that moves by more than this (fraction) during sanitization
// triggers the 'joint-positions-adjusted' warning.
const STATION_ADJUST_EPSILON = 1e-3;
// Above this arc-length / straight-extent ratio the binned centroid spine is
// wandering (curled or folded body); fall back to the straight PCA axis line.
const SPINE_FALLBACK_ARC_RATIO = 1.6;
const MIN_VALID_BINS = 3;

// --- Small vector helpers (flat arrays, no deps). ---
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (a: Vec3): number => Math.sqrt(dot(a, a));
const normalize = (a: Vec3): Vec3 => {
  const len = length(a);
  return len > 1e-12 ? [a[0] / len, a[1] / len, a[2] / len] : [0, 0, 0];
};

type SpineFrame = { e1: Vec3; e2: Vec3 };

type SpineData = {
  /** Smoothed centroid polyline, tail → head. */
  points: Vec3[];
  /** Cumulative arc length, same length as points; arc[0] = 0. */
  arc: number[];
  lengthMm: number;
  /** Unit tangent per point. */
  tangents: Vec3[];
  /** Parallel-transported cross-section frame per point. */
  frames: SpineFrame[];
  fellBackToStraight: boolean;
};

// --- Public API -----------------------------------------------------------

/**
 * Uniform scale that maps the input mesh so its spine measures
 * `settings.targetLengthMm`. Callers scale the positions with this before
 * planning/building so joint sizing operates in absolute millimetres.
 */
export function computeFlexiScale(
  input: FlexiMeshInput,
  settings: FlexiToySettings,
): number {
  const axis = computeAxis(input.positions, settings.axisOverride);
  const spine = buildSpine(input.positions, axis);
  if (!(spine.lengthMm > 1e-6) || !(settings.targetLengthMm > 0)) {
    return 1;
  }
  const scale = settings.targetLengthMm / spine.lengthMm;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** Return a scaled copy of a flat xyz position array. */
export function scaleFlexiPositions(
  positions: Float32Array,
  scale: number,
): Float32Array {
  const scaled = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 1) {
    scaled[i] = positions[i] * scale;
  }
  return scaled;
}

/**
 * Plan the spine, cut stations and joint sizing for an (already scaled) mesh.
 * Deterministic and pure.
 */
export function planFlexiToy(
  input: FlexiMeshInput,
  settings: FlexiToySettings,
): FlexiToyPlan {
  const warnings: FlexiToyWarning[] = [];
  const clearance = settings.clearanceMm;
  const jointScale = settings.jointScale;
  const bendAngleDeg = settings.bendAngleDeg;
  // Defensive default so a stale client without jointStyle still plans.
  const jointStyle = settings.jointStyle ?? FLEXI_DEFAULT_JOINT_STYLE;

  const axis = computeAxis(input.positions, settings.axisOverride);
  const spine = buildSpine(input.positions, axis);
  if (spine.fellBackToStraight) {
    warnings.push({
      code: 'spine-fallback-straight',
      message:
        'This shape curves too much to follow; joints are placed along a straight axis instead.',
    });
  }

  // Stations are either pinned by the user (dragged cuts) or evenly spaced with
  // the printable-pitch reduction loop.
  const pinned = resolvePinnedStations(
    settings,
    spine,
    input.positions,
    clearance,
    jointScale,
    bendAngleDeg,
    jointStyle,
  );

  let placed: PlacedJoints;
  let reduced = false;
  let positionsAdjusted = false;

  if (pinned) {
    positionsAdjusted = pinned.adjusted;
    placed = placeAndSizeJoints(
      pinned.fractions,
      spine,
      input.positions,
      clearance,
      jointScale,
      bendAngleDeg,
      jointStyle,
    );
  } else {
    if (settings.jointPositions && settings.jointPositions.length > 0) {
      // Present but malformed: fall back to even spacing and say so.
      positionsAdjusted = true;
    }
    const { initial, minSegments } = resolveSegmentCount(
      settings.segmentCount,
      spine.lengthMm,
    );
    let segmentCount = initial;
    // Reduce N while segments are shorter than the min printable pitch. Bounded:
    // segmentCount only ever decreases, floored at minSegments.
    for (;;) {
      placed = placeAndSizeJoints(
        evenFractions(segmentCount),
        spine,
        input.positions,
        clearance,
        jointScale,
        bendAngleDeg,
        jointStyle,
      );
      const minSegmentLength = minSegmentLengthFor(
        maxLiveRadius(placed.joints),
        clearance,
        jointStyle,
        bendAngleDeg,
        placed.maxStationExtentMm,
      );
      const pitch = spine.lengthMm / segmentCount;
      if (pitch >= minSegmentLength || segmentCount <= minSegments) {
        break;
      }
      segmentCount -= 1;
      reduced = true;
    }
  }

  let joints = placed.joints;
  if (reduced) {
    warnings.push({
      code: 'segment-count-reduced',
      message:
        'Fewer segments were used so each piece stays long enough to print.',
    });
  }

  // Overlap guard: when adjacent stations sit closer than a joint needs (short,
  // fat body, or dragged cuts pinned close together), adjacent joint solids —
  // tail socket / head ball (classic) or neighbouring cutters (rounded) — would
  // collide. Cap every ball so adjacent joints stay clear, re-checking capture
  // (fusing where the cap drops below the printable floor), and warn.
  const minAdjacentGap = minAdjacentStationGap(joints);
  const minSegmentLength = minSegmentLengthFor(
    maxLiveRadius(joints),
    clearance,
    jointStyle,
    bendAngleDeg,
    placed.maxStationExtentMm,
  );
  if (joints.length >= 2 && minAdjacentGap < minSegmentLength) {
    const cap = jointOverlapCap(
      joints,
      minAdjacentGap,
      clearance,
      jointStyle,
      bendAngleDeg,
    );
    let capped = false;
    joints = joints.map((joint) => {
      if (joint.fused || joint.ballRadiusMm <= cap + 1e-9) return joint;
      capped = true;
      return capJointBall(joint, cap, clearance, jointStyle);
    });
    if (capped) {
      warnings.push({
        code: 'joint-size-capped',
        message:
          'Joints were made smaller so neighbouring joints in this short, chunky body do not fuse together.',
      });
    }
  }

  if (placed.anyLiveTooVertical) {
    warnings.push({
      code: 'cuts-not-vertical',
      message:
        'Part of this model runs straight up, so a cut there could not be made vertical.',
    });
  }
  if (positionsAdjusted) {
    warnings.push({
      code: 'joint-positions-adjusted',
      message: 'A cut was nudged to keep every piece printable.',
    });
  }

  joints.forEach((joint, jointIndex) => {
    if (joint.fused) {
      warnings.push({
        code: 'joint-fused-too-thin',
        message:
          'This part is too thin to hold a joint, so it stays rigid there.',
        jointIndex,
      });
    }
  });

  return {
    joints,
    spine: spine.points.map((point) => [point[0], point[1], point[2]]),
    spineLengthMm: spine.lengthMm,
    warnings,
  };
}

function maxLiveRadius(joints: FlexiJointPlan[]): number {
  return joints.reduce(
    (max, joint) => (joint.fused ? max : Math.max(max, joint.ballRadiusMm)),
    0,
  );
}

// Minimum spine spacing a live joint needs so adjacent joints don't collide.
// Rounded cutters reach out to the cup + bowl gap, so they need more room than
// the classic ball-and-socket pair. Their visible gap band additionally
// reaches ±rho·tan((travel + seam overlap)/2) axially at cross-section radius
// rho (see the build's wedge/seam geometry), so on wide stations the pitch
// must also leave a solid slab between adjacent bands — otherwise two
// neighbouring cuts jointly shave a wide feature (a fin or wing) down to the
// groove floor between them.
function roundedFamilyMinSegmentLength(
  maxBallRadius: number,
  clearance: number,
  flareDeg: number,
  bendAngleDeg?: number,
  maxStationExtentMm?: number,
): number {
  const reach =
    maxBallRadius + clearance + ROUNDED_CUP_WALL_MM + roundedBowlGap(clearance);
  let floor = 2 * reach + OVERLAP_MARGIN_MM;
  if (
    bendAngleDeg !== undefined &&
    maxStationExtentMm !== undefined &&
    maxStationExtentMm > 0
  ) {
    const halfBand =
      ((bendAngleDeg + GAP_BAND_OVERLAP_DEG) * Math.PI) / 360 +
      (flareDeg * Math.PI) / 180;
    floor = Math.max(
      floor,
      2 * maxStationExtentMm * Math.tan(halfBand) + GAP_BAND_KEEP_MM,
    );
  }
  return floor;
}

/**
 * Minimum spine pitch a live joint of this style needs. Exported (like
 * `socketMouthRadius`) so the plan suite can pin the cross-style ordering that
 * makes the build's per-joint rounded fallback always fit; not part of the
 * frozen plan contract.
 */
export function minSegmentLengthFor(
  maxBallRadius: number,
  clearance: number,
  jointStyle: FlexiJointStyle,
  bendAngleDeg?: number,
  maxStationExtentMm?: number,
): number {
  switch (jointStyle) {
    // The shell's flared seam-lip walls widen the band's reach at the skin;
    // budget the (loft-derated) flare on top of the travel + seam overlap.
    case 'shell':
      return roundedFamilyMinSegmentLength(
        maxBallRadius,
        clearance,
        SHELL_FLARE_BAND_DEG,
        bendAngleDeg,
        maxStationExtentMm,
      );
    case 'rounded':
      return roundedFamilyMinSegmentLength(
        maxBallRadius,
        clearance,
        0,
        bendAngleDeg,
        maxStationExtentMm,
      );
    case 'strong': {
      // Strong pitches WIDER than `rounded`: its own footprint (pocket + wall
      // headward, land + bar anchor tailward) binds nearly everywhere. Swept
      // over r ∈ {2.5,3,4,5,6,8} × c ∈ {0.3,0.4,0.55,0.8} × bend ∈ {5,12,25} ×
      // station extent ∈ {5,10,20}, the strong term is strictly larger in 182
      // of 216 cells, by up to 1.16× (worst at r=8, c=0.3, bend=5: 23.90 vs
      // 20.60mm). The `max` is therefore usually the strong term; taking it
      // anyway is what keeps the build's per-joint rounded fallback guaranteed
      // to have room, and the plan suite pins only the one safe direction,
      // strong ≥ rounded.
      const rounded = roundedFamilyMinSegmentLength(
        maxBallRadius,
        clearance,
        0,
        bendAngleDeg,
        maxStationExtentMm,
      );
      const footprint = strongFootprintMm(
        maxBallRadius,
        clearance,
        bendAngleDeg,
        maxStationExtentMm,
      );
      return footprint === null ? rounded : Math.max(rounded, footprint);
    }
    case 'classic':
      return Math.max(8, 2.4 * maxBallRadius);
    default:
      return assertNever(jointStyle, 'minSegmentLengthFor');
  }
}

function minAdjacentStationGap(joints: FlexiJointPlan[]): number {
  let min = Infinity;
  for (let i = 1; i < joints.length; i += 1) {
    min = Math.min(min, length(sub(joints[i].center, joints[i - 1].center)));
  }
  return min;
}

// Resolve user-dragged cut stations into sanitized arc-length fractions, or null
// to fall back to even spacing (absent, or malformed — wrong length / non-finite
// / count not pinned to a number).
function resolvePinnedStations(
  settings: FlexiToySettings,
  spine: SpineData,
  positions: Float32Array,
  clearance: number,
  jointScale: number,
  bendAngleDeg: number,
  jointStyle: FlexiJointStyle,
): { fractions: number[]; adjusted: boolean } | null {
  const requested = settings.jointPositions;
  if (!requested || requested.length === 0) {
    return null;
  }
  const count = settings.segmentCount;
  const valid =
    typeof count === 'number' &&
    requested.length === count - 1 &&
    requested.every((fraction) => Number.isFinite(fraction));
  if (!valid) {
    return null;
  }
  return sanitizeStations(
    requested,
    spine,
    positions,
    clearance,
    jointScale,
    bendAngleDeg,
    jointStyle,
  );
}

// Deterministic station sanitization: clamp into range, sort, then spread to the
// minimum printable inter-station gap. Reports whether any station's value moved.
function sanitizeStations(
  requested: number[],
  spine: SpineData,
  positions: Float32Array,
  clearance: number,
  jointScale: number,
  bendAngleDeg: number,
  jointStyle: FlexiJointStyle,
): { fractions: number[]; adjusted: boolean } {
  const sortedOriginal = requested.slice().sort((a, b) => a - b);
  const clamped = sortedOriginal.map((fraction) =>
    clamp(fraction, STATION_MIN_FRACTION, STATION_MAX_FRACTION),
  );

  // Size at the clamped stations to learn the min printable gap, then spread.
  const probe = placeAndSizeJoints(
    clamped,
    spine,
    positions,
    clearance,
    jointScale,
    bendAngleDeg,
    jointStyle,
  );
  const minGapMm = minSegmentLengthFor(
    maxLiveRadius(probe.joints),
    clearance,
    jointStyle,
    bendAngleDeg,
    probe.maxStationExtentMm,
  );
  const minGapFraction = spine.lengthMm > 0 ? minGapMm / spine.lengthMm : 0.02;
  const fractions = spreadFractions(clamped, minGapFraction);

  const adjusted = fractions.some(
    (fraction, i) =>
      Math.abs(fraction - sortedOriginal[i]) > STATION_ADJUST_EPSILON,
  );
  return { fractions, adjusted };
}

// Spread sorted fractions to a minimum inter-station gap within the valid range,
// deterministically and always strictly increasing (an infeasible requested gap
// is reduced to the largest that still fits so no two stations coincide).
function spreadFractions(sorted: number[], gap: number): number[] {
  const n = sorted.length;
  if (n <= 1) {
    return sorted.map((fraction) =>
      clamp(fraction, STATION_MIN_FRACTION, STATION_MAX_FRACTION),
    );
  }
  const span = STATION_MAX_FRACTION - STATION_MIN_FRACTION;
  const gapUsed = Math.max(0.005, Math.min(gap, span / (n - 1)));

  const out = sorted.slice();
  out[0] = Math.max(out[0], STATION_MIN_FRACTION);
  for (let i = 1; i < n; i += 1) {
    out[i] = Math.max(out[i], out[i - 1] + gapUsed);
  }
  out[n - 1] = Math.min(out[n - 1], STATION_MAX_FRACTION);
  for (let i = n - 2; i >= 0; i -= 1) {
    out[i] = Math.min(out[i], out[i + 1] - gapUsed);
  }
  return out.map((fraction) =>
    clamp(fraction, STATION_MIN_FRACTION, STATION_MAX_FRACTION),
  );
}

// --- Principal axis (PCA) --------------------------------------------------

function computeAxis(
  positions: Float32Array,
  override: FlexiAxisOverride,
): Vec3 {
  if (override === 'x') return [1, 0, 0];
  if (override === 'y') return [0, 1, 0];
  if (override === 'z') return [0, 0, 1];

  const vertexCount = Math.floor(positions.length / 3);
  if (vertexCount < 2) return [1, 0, 0];

  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < vertexCount; i += 1) {
    cx += positions[i * 3];
    cy += positions[i * 3 + 1];
    cz += positions[i * 3 + 2];
  }
  cx /= vertexCount;
  cy /= vertexCount;
  cz /= vertexCount;

  let xx = 0;
  let xy = 0;
  let xz = 0;
  let yy = 0;
  let yz = 0;
  let zz = 0;
  for (let i = 0; i < vertexCount; i += 1) {
    const dx = positions[i * 3] - cx;
    const dy = positions[i * 3 + 1] - cy;
    const dz = positions[i * 3 + 2] - cz;
    xx += dx * dx;
    xy += dx * dy;
    xz += dx * dz;
    yy += dy * dy;
    yz += dy * dz;
    zz += dz * dz;
  }

  const axis = dominantEigenvector([xx, xy, xz, xy, yy, yz, xz, yz, zz]);
  // Deterministic orientation: make the largest-magnitude component positive.
  const largest = Math.max(
    Math.abs(axis[0]),
    Math.abs(axis[1]),
    Math.abs(axis[2]),
  );
  const sign =
    (Math.abs(axis[0]) === largest && axis[0] < 0) ||
    (Math.abs(axis[1]) === largest && axis[1] < 0) ||
    (Math.abs(axis[2]) === largest && axis[2] < 0)
      ? -1
      : 1;
  return normalize(mul(axis, sign));
}

// Largest-eigenvalue eigenvector of a symmetric 3x3 matrix (row-major length 9)
// via cyclic Jacobi rotations. Deterministic, fixed iteration budget.
function dominantEigenvector(matrix: number[]): Vec3 {
  const a = matrix.slice();
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];

  const rotate = (p: number, q: number): void => {
    const app = a[p * 3 + p];
    const aqq = a[q * 3 + q];
    const apq = a[p * 3 + q];
    if (Math.abs(apq) < 1e-15) return;
    const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    for (let k = 0; k < 3; k += 1) {
      const akp = a[k * 3 + p];
      const akq = a[k * 3 + q];
      a[k * 3 + p] = c * akp - s * akq;
      a[k * 3 + q] = s * akp + c * akq;
    }
    for (let k = 0; k < 3; k += 1) {
      const apk = a[p * 3 + k];
      const aqk = a[q * 3 + k];
      a[p * 3 + k] = c * apk - s * aqk;
      a[q * 3 + k] = s * apk + c * aqk;
    }
    for (let k = 0; k < 3; k += 1) {
      const vkp = v[k * 3 + p];
      const vkq = v[k * 3 + q];
      v[k * 3 + p] = c * vkp - s * vkq;
      v[k * 3 + q] = s * vkp + c * vkq;
    }
  };

  for (let sweep = 0; sweep < 12; sweep += 1) {
    rotate(0, 1);
    rotate(0, 2);
    rotate(1, 2);
  }

  const eigenvalues = [a[0], a[4], a[8]];
  let best = 0;
  if (eigenvalues[1] > eigenvalues[best]) best = 1;
  if (eigenvalues[2] > eigenvalues[best]) best = 2;
  return [v[best], v[3 + best], v[6 + best]];
}

// --- Spine construction ----------------------------------------------------

function buildSpine(positions: Float32Array, axis: Vec3): SpineData {
  const vertexCount = Math.floor(positions.length / 3);
  if (vertexCount < 2) {
    return straightSpine([0, 0, 0], axis, 0, 1);
  }

  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < vertexCount; i += 1) {
    cx += positions[i * 3];
    cy += positions[i * 3 + 1];
    cz += positions[i * 3 + 2];
  }
  const centroid: Vec3 = [cx / vertexCount, cy / vertexCount, cz / vertexCount];

  let tMin = Infinity;
  let tMax = -Infinity;
  const t = new Float64Array(vertexCount);
  for (let i = 0; i < vertexCount; i += 1) {
    const rel: Vec3 = [
      positions[i * 3] - centroid[0],
      positions[i * 3 + 1] - centroid[1],
      positions[i * 3 + 2] - centroid[2],
    ];
    const proj = dot(rel, axis);
    t[i] = proj;
    if (proj < tMin) tMin = proj;
    if (proj > tMax) tMax = proj;
  }
  const straightExtent = tMax - tMin;
  if (!(straightExtent > 1e-6)) {
    return straightSpine(centroid, axis, tMin, tMax);
  }

  // Per-bin centroid polyline.
  const binSum: Vec3[] = Array.from({ length: BIN_COUNT }, () => [0, 0, 0]);
  const binCount = new Int32Array(BIN_COUNT);
  const span = straightExtent / BIN_COUNT;
  for (let i = 0; i < vertexCount; i += 1) {
    let bin = Math.floor((t[i] - tMin) / span);
    if (bin < 0) bin = 0;
    if (bin >= BIN_COUNT) bin = BIN_COUNT - 1;
    binSum[bin][0] += positions[i * 3];
    binSum[bin][1] += positions[i * 3 + 1];
    binSum[bin][2] += positions[i * 3 + 2];
    binCount[bin] += 1;
  }

  const rawCentroids: Vec3[] = [];
  for (let bin = 0; bin < BIN_COUNT; bin += 1) {
    if (binCount[bin] > 0) {
      rawCentroids.push([
        binSum[bin][0] / binCount[bin],
        binSum[bin][1] / binCount[bin],
        binSum[bin][2] / binCount[bin],
      ]);
    }
  }

  if (rawCentroids.length < MIN_VALID_BINS) {
    return straightSpine(centroid, axis, tMin, tMax);
  }

  const rawArcLength = polylineLength(rawCentroids);
  if (rawArcLength > SPINE_FALLBACK_ARC_RATIO * straightExtent) {
    return straightSpine(centroid, axis, tMin, tMax);
  }

  const smoothed = smoothPolyline(rawCentroids);
  return finishSpine(smoothed, axis, false);
}

function straightSpine(
  centroid: Vec3,
  axis: Vec3,
  tMin: number,
  tMax: number,
): SpineData {
  const extent = Math.max(tMax - tMin, 1e-6);
  const start = add(centroid, mul(axis, tMin));
  const points: Vec3[] = [];
  for (let i = 0; i < BIN_COUNT; i += 1) {
    points.push(add(start, mul(axis, (extent * i) / (BIN_COUNT - 1))));
  }
  return finishSpine(points, axis, true);
}

function finishSpine(
  points: Vec3[],
  axisHint: Vec3,
  fellBack: boolean,
): SpineData {
  const arc: number[] = [0];
  for (let i = 1; i < points.length; i += 1) {
    arc.push(arc[i - 1] + length(sub(points[i], points[i - 1])));
  }
  const lengthMm = arc[arc.length - 1];

  const tangents: Vec3[] = points.map((_, i) => {
    if (points.length < 2) return normalize(axisHint);
    if (i === 0) return normalize(sub(points[1], points[0]));
    if (i === points.length - 1) {
      return normalize(sub(points[i], points[i - 1]));
    }
    return normalize(sub(points[i + 1], points[i - 1]));
  });

  // Parallel-transport a cross-section frame along the spine to keep it from
  // twisting between stations.
  const frames: SpineFrame[] = [];
  const reference: Vec3 =
    Math.abs(tangents[0][0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let e1 = normalize(
    sub(reference, mul(tangents[0], dot(reference, tangents[0]))),
  );
  frames.push({ e1, e2: normalize(cross(tangents[0], e1)) });
  for (let i = 1; i < points.length; i += 1) {
    const projected = sub(e1, mul(tangents[i], dot(e1, tangents[i])));
    e1 = normalize(projected);
    if (length(e1) < 1e-6) {
      const fallbackRef: Vec3 =
        Math.abs(tangents[i][0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      e1 = normalize(
        sub(fallbackRef, mul(tangents[i], dot(fallbackRef, tangents[i]))),
      );
    }
    frames.push({ e1, e2: normalize(cross(tangents[i], e1)) });
  }

  return {
    points,
    arc,
    lengthMm,
    tangents,
    frames,
    fellBackToStraight: fellBack,
  };
}

function polylineLength(points: Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += length(sub(points[i], points[i - 1]));
  }
  return total;
}

function smoothPolyline(points: Vec3[]): Vec3[] {
  const half = Math.floor(SMOOTH_TAPS / 2);
  return points.map((_, i) => {
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let n = 0;
    for (let k = -half; k <= half; k += 1) {
      const j = i + k;
      if (j < 0 || j >= points.length) continue;
      sx += points[j][0];
      sy += points[j][1];
      sz += points[j][2];
      n += 1;
    }
    return [sx / n, sy / n, sz / n] as Vec3;
  });
}

// --- Cut placement & joint sizing -----------------------------------------

function resolveSegmentCount(
  requested: number | 'auto',
  spineLengthMm: number,
): { initial: number; minSegments: number } {
  if (requested === 'auto') {
    const raw = Math.round(spineLengthMm / AUTO_SEGMENT_PITCH_MM);
    const initial = clamp(raw, AUTO_MIN_SEGMENTS, FLEXI_MAX_SEGMENTS);
    return { initial, minSegments: AUTO_MIN_SEGMENTS };
  }
  const initial = clamp(
    Math.round(requested),
    FLEXI_MIN_SEGMENTS,
    FLEXI_MAX_SEGMENTS,
  );
  return { initial, minSegments: FLEXI_MIN_SEGMENTS };
}

type PlacedJoints = {
  joints: FlexiJointPlan[];
  anyLiveTooVertical: boolean;
  /** Widest half-extent across all LIVE stations (0 when none) — feeds the
   * gap-band spacing budget in minSegmentLengthFor. */
  maxStationExtentMm: number;
};

function placeAndSizeJoints(
  fractions: number[],
  spine: SpineData,
  positions: Float32Array,
  clearance: number,
  jointScale: number,
  bendAngleDeg: number,
  jointStyle: FlexiJointStyle,
): PlacedJoints {
  const joints: FlexiJointPlan[] = [];
  let anyLiveTooVertical = false;
  let maxStationExtentMm = 0;
  for (const fraction of fractions) {
    const s = spine.lengthMm * fraction;
    const sample = sampleSpine(spine, s);
    const stationOut: { maxExtentMm?: number } = {};
    const joint = sizeJoint(
      sample.center,
      sample.axis,
      sample.frame,
      positions,
      clearance,
      jointScale,
      bendAngleDeg,
      fraction,
      jointStyle,
      stationOut,
    );
    if (!joint.fused) {
      if (sample.tooVertical) {
        anyLiveTooVertical = true;
      }
      maxStationExtentMm = Math.max(
        maxStationExtentMm,
        stationOut.maxExtentMm ?? 0,
      );
    }
    joints.push(joint);
  }
  return { joints, anyLiveTooVertical, maxStationExtentMm };
}

/** Constant bowl (outer) gap for the rounded style. */
function roundedBowlGap(clearanceMm: number): number {
  return Math.max(clearanceMm, ROUNDED_MIN_BOWL_GAP_MM);
}

function evenFractions(segmentCount: number): number[] {
  const fractions: number[] = [];
  for (let i = 1; i < segmentCount; i += 1) {
    fractions.push(i / segmentCount);
  }
  return fractions;
}

type SpineSample = {
  center: Vec3;
  /** Cut normal at this station: the spine tangent projected to horizontal. */
  axis: Vec3;
  frame: SpineFrame;
  /** True when the tangent was too vertical to project (raw tangent kept). */
  tooVertical: boolean;
};

function sampleSpine(spine: SpineData, s: number): SpineSample {
  const { points, arc, tangents } = spine;
  const rawTangent =
    points.length === 1
      ? tangents[0]
      : (() => {
          let i = 0;
          while (i < arc.length - 2 && arc[i + 1] < s) {
            i += 1;
          }
          return normalize(sub(points[i + 1], points[i]));
        })();
  const center = points.length === 1 ? points[0] : sampleCenter(points, arc, s);

  // VERTICAL-CUT RULE: the cut normal is the tangent projected onto the
  // horizontal (xz) plane so faces are perpendicular to the print bed. If the
  // spine runs (near-)vertically here the projection is unstable, so keep the
  // raw tangent and flag it.
  const horizontalMagnitude = Math.hypot(rawTangent[0], rawTangent[2]);
  const tooVertical = horizontalMagnitude < HORIZONTAL_TANGENT_MIN;
  const axis = tooVertical
    ? rawTangent
    : normalize([rawTangent[0], 0, rawTangent[2]]);

  return { center, axis, frame: buildAxisFrame(axis), tooVertical };
}

function sampleCenter(points: Vec3[], arc: number[], s: number): Vec3 {
  let i = 0;
  while (i < arc.length - 2 && arc[i + 1] < s) {
    i += 1;
  }
  const segmentLength = arc[i + 1] - arc[i];
  const alpha = segmentLength > 1e-9 ? (s - arc[i]) / segmentLength : 0;
  return add(points[i], mul(sub(points[i + 1], points[i]), alpha));
}

// Orthonormal cross-section frame perpendicular to a cut axis. For a horizontal
// axis (vertical cut) this naturally puts one basis vector straight up.
function buildAxisFrame(axis: Vec3): SpineFrame {
  const ref: Vec3 = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let e1 = sub(ref, mul(axis, dot(ref, axis)));
  if (length(e1) < 1e-6) {
    const alt: Vec3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
    e1 = sub(alt, mul(axis, dot(alt, axis)));
  }
  e1 = normalize(e1);
  return { e1, e2: normalize(cross(axis, e1)) };
}

function sizeJoint(
  center: Vec3,
  axis: Vec3,
  frame: SpineFrame,
  positions: Float32Array,
  clearance: number,
  jointScale: number,
  bendAngleDeg: number,
  spineFraction: number,
  jointStyle: FlexiJointStyle,
  stationOut?: { maxExtentMm?: number },
): FlexiJointPlan {
  const fused = (ballRadiusMm = 0): FlexiJointPlan => ({
    center,
    axis,
    ballRadiusMm,
    socketDepthMm: 0,
    faceGapMm: 0,
    spineFraction,
    fused: true,
  });

  const profile = buildCrossSectionProfile(positions, center, axis, frame);
  const rho0 = crossSectionAt(profile, 0);
  if (stationOut) {
    // Widest half-extent at this station (profile is already built) — used by
    // the caller for the gap-band spacing budget.
    stationOut.maxExtentMm = reduceCrossSectionAt(profile, 0, maxOfArray);
  }
  if (!(rho0 > 0)) {
    return fused();
  }

  // Start at the requested size (grown to the min printable ball, capped by the
  // on-axis clearance + wall budget), then shrink until the socket cavity is
  // contained along its whole axial reach — this is what stops a tapering body
  // from being pierced by the socket. For the shell style the shrink loop also
  // asks the lap shelf (seam ledge above the cup wall) to fit: a step-smaller
  // ball keeps the overlapping-scale look instead of the whole joint falling
  // back to a rounded groove in the build. If even the smallest printable ball
  // cannot host the shelf, the largest contained ball is kept (the build's
  // per-joint rounded fallback still applies) rather than fusing the joint.
  const finish = (ballRadiusMm: number): FlexiJointPlan => {
    const socketDepthMm = captureDepth(ballRadiusMm, clearance);
    // Capture only gets harder as the ball shrinks (clearance grows relative
    // to the ball), so a contained-but-uncaptive ball can never be rescued by
    // shrinking further — fuse instead.
    if (socketDepthMm === null) {
      return fused(ballRadiusMm);
    }
    // Rounded family and strong both carry the constant bowl gap; classic's is
    // the bend-driven flat ring gap.
    const faceGapMm = ((): number => {
      switch (jointStyle) {
        case 'shell':
        case 'rounded':
        case 'strong':
          return roundedBowlGap(clearance);
        case 'classic':
          return computeFaceGap(
            bendAngleDeg,
            rho0,
            ballRadiusMm,
            socketDepthMm,
            clearance,
          );
        default:
          return assertNever(jointStyle, 'sizeJoint faceGap');
      }
    })();
    return {
      center,
      axis,
      ballRadiusMm,
      socketDepthMm,
      faceGapMm,
      spineFraction,
      fused: false,
    };
  };
  const shellShelfFits = (ballRadiusMm: number): boolean => {
    switch (jointStyle) {
      case 'rounded':
      case 'classic':
      case 'strong':
        return true;
      case 'shell': {
        const cs = roundedBowlGap(clearance);
        const cupOuter = ballRadiusMm + clearance + ROUNDED_CUP_WALL_MM;
        // Mirror of the build's ledge estimate (thin-direction floor).
        const ledge = Math.min(
          SHELL_FLOOR_FACTOR * rho0,
          rho0 - cs - SHELL_MIN_FLAP_MM,
        );
        return ledge - cupOuter >= SHELL_LAP_SHELF_MM;
      }
      default:
        return assertNever(jointStyle, 'shellShelfFits');
    }
  };
  // Rounded family must keep the whole socket CUP (radius r+c+w) inside the
  // skin; classic keeps the ball's clearance shell (r+c) inside with a socket
  // wall; strong keeps its closed cavity AND its throat slot inside.
  const cavityContained = (ballRadiusMm: number): boolean => {
    switch (jointStyle) {
      case 'shell':
      case 'rounded':
        return socketContainedAlongReach(
          profile,
          ballRadiusMm + clearance + ROUNDED_CUP_WALL_MM,
          0,
        );
      case 'classic':
        return socketContainedAlongReach(
          profile,
          ballRadiusMm + clearance,
          FLEXI_MIN_SOCKET_WALL_MM,
        );
      case 'strong':
        // The strong SOLID is not realisable at every radius — its blade has a
        // hard width floor, so below roughly r = 3.2mm at loose clearance and
        // max bend the solver returns null. That is not a reason to fuse: such a
        // joint is still a perfectly good ROUNDED joint, and the build already
        // falls back to the rounded cutter per joint (reporting
        // 'strong-joint-fallback'). So judge containment by whichever cavity
        // will ACTUALLY be carved, exactly as the build will decide it.
        return solveStrongJointGeometry(ballRadiusMm, clearance, bendAngleDeg)
          ? strongCavityFits(profile, ballRadiusMm, clearance, bendAngleDeg)
          : socketContainedAlongReach(
              profile,
              ballRadiusMm + clearance + ROUNDED_CUP_WALL_MM,
              0,
            );
      default:
        return assertNever(jointStyle, 'sizeJoint containment');
    }
  };
  let ballRadiusMm = clamp(
    jointScale * BALL_SIZE_FACTOR * rho0,
    FLEXI_MIN_BALL_RADIUS_MM,
    rho0 - clearance - FLEXI_MIN_SOCKET_WALL_MM,
  );
  let containedFallback: number | null = null;
  while (ballRadiusMm >= FLEXI_MIN_BALL_RADIUS_MM) {
    const contained = cavityContained(ballRadiusMm);
    if (contained) {
      if (containedFallback === null) containedFallback = ballRadiusMm;
      if (shellShelfFits(ballRadiusMm)) {
        return finish(ballRadiusMm);
      }
    }
    ballRadiusMm -= SIZING_SHRINK_STEP_MM;
  }
  if (containedFallback !== null) {
    return finish(containedFallback);
  }
  return fused();
}

/**
 * Local cross-section extents of the mesh at a joint station: `minMm` is the
 * thinnest-direction half-extent (used for socket containment and the rounded
 * groove floor), `maxMm` is the widest-direction half-extent (used to size the
 * rounded gap wedge so it exits the skin even on a tall/eccentric
 * cross-section). `bandHalfWidthMm` widens the sampled slab to ±that many mm so
 * the caller can bound the body over the wedge's whole axial reach, not just
 * the cut plane. Exported for the rounded build; kept out of the frozen plan
 * contract. NB: the build re-measures with its own frame, so these can differ
 * from the planner's sizing pass by a small amount (different in-plane basis
 * angles) — harmless, both bound the same body.
 */
export function crossSectionExtentsAt(
  positions: Float32Array,
  center: [number, number, number],
  axis: [number, number, number],
  bandHalfWidthMm?: number,
): { minMm: number; maxMm: number } {
  return crossSectionExtentsSampler(positions, center, axis)(bandHalfWidthMm);
}

/**
 * Per-azimuth radial skin profile over an axial band centred on the cut plane:
 * `outer[j]` is the largest skin radius seen in signed azimuth sector j across
 * the band (the seam band must reach past it), `inner[j]` the smallest
 * per-slice skin radius across the band (the lofted seam ledge must stay a
 * flap thickness under it). 0 in either array ⇒ no vertex data for that
 * sector; callers fill by envelope from neighbouring sectors.
 */
export type FlexiSectionDirProfile = {
  inner: Float64Array;
  outer: Float64Array;
};

/**
 * Sampler over a joint's cross-section profile. Callable like
 * `crossSectionExtentsAt`; additionally exposes the in-plane frame its
 * azimuths are measured in (sector j spans angles
 * [j, j+1)·2π/sectorCount from e1 toward e2) and a per-direction band
 * sampler for the lofted shell seam.
 */
export type FlexiSectionSampler = {
  (bandHalfWidthMm?: number): { minMm: number; maxMm: number };
  frame: { e1: [number, number, number]; e2: [number, number, number] };
  sectorCount: number;
  /** Band widths either uniform or per sector, and asymmetric: `tail` reaches
   * toward −axis and `head` toward +axis (the lofted flap overlaps only the
   * head side, so a tail-side taper must not sink the ledge; and the tall
   * side's reach must not band the thin azimuths). `head` defaults to
   * `tail`. */
  dirProfile: (
    tailHalfWidthMm: number | Float64Array,
    headHalfWidthMm?: number | Float64Array,
  ) => FlexiSectionDirProfile;
};

/**
 * Same measurement as `crossSectionExtentsAt`, but the (expensive, one full
 * pass over every vertex) profile is built once and the returned sampler can
 * be queried at any number of band half-widths for the cost of a bin scan —
 * the rounded build iterates its wedge radii to a fixed point per joint.
 */
export function crossSectionExtentsSampler(
  positions: Float32Array,
  center: [number, number, number],
  axis: [number, number, number],
): FlexiSectionSampler {
  const frame = buildAxisFrame(axis as Vec3);
  const profile = buildCrossSectionProfile(
    positions,
    center as Vec3,
    axis as Vec3,
    frame,
  );
  const sampler = ((bandHalfWidthMm?: number) => {
    const halfWidths =
      bandHalfWidthMm !== undefined
        ? [Math.max(bandHalfWidthMm, SLAB_WIDEN_HALF_WIDTHS[0])]
        : undefined;
    return {
      minMm: reduceCrossSectionAt(profile, 0, minOfArray, halfWidths),
      maxMm: reduceCrossSectionAt(profile, 0, maxOfArray, halfWidths),
    };
  }) as FlexiSectionSampler;
  sampler.frame = {
    e1: [frame.e1[0], frame.e1[1], frame.e1[2]],
    e2: [frame.e2[0], frame.e2[1], frame.e2[2]],
  };
  sampler.sectorCount = CROSS_SECTION_SECTORS;
  sampler.dirProfile = (
    tailHalfWidthMm: number | Float64Array,
    headHalfWidthMm?: number | Float64Array,
  ) => {
    const headWidths = headHalfWidthMm ?? tailHalfWidthMm;
    const widthAt = (widths: number | Float64Array, j: number): number =>
      Math.max(
        typeof widths === 'number' ? widths : widths[j],
        SLAB_WIDEN_HALF_WIDTHS[0],
      );
    const inner = new Float64Array(CROSS_SECTION_SECTORS);
    const outer = new Float64Array(CROSS_SECTION_SECTORS);
    inner.fill(Infinity);
    for (let j = 0; j < CROSS_SECTION_SECTORS; j += 1) {
      const lo = Math.round(-widthAt(tailHalfWidthMm, j) / PROFILE_BIN_MM);
      const hi = Math.round(widthAt(headWidths, j) / PROFILE_BIN_MM);
      for (let binIndex = lo; binIndex <= hi; binIndex += 1) {
        const bin = profile.bins.get(binIndex);
        if (!bin) continue;
        const radius = bin.secMax[j];
        if (!(radius > 0)) continue;
        if (radius < inner[j]) inner[j] = radius;
        if (radius > outer[j]) outer[j] = radius;
      }
    }
    for (let j = 0; j < CROSS_SECTION_SECTORS; j += 1) {
      if (!Number.isFinite(inner[j])) inner[j] = 0;
    }
    return { inner, outer };
  };
  return sampler;
}

// Printed gap between a joint's two segment faces. It scales with the local body
// radius so the toy actually bends (a fixed clearance gap only bends ~2° on a
// chunky body), clamped to the clearance floor, the hard ceiling, AND — most
// importantly — the ball-connectivity budget: the ball (span ±r) must still
// bridge the gap into its own segment, whose body ends at −(h + g), so
// g ≤ r − h − margin. Never let the gap sever ball-to-segment connectivity.
function computeFaceGap(
  bendAngleDeg: number,
  rho0: number,
  ballRadiusMm: number,
  socketDepthMm: number,
  clearanceMm: number,
): number {
  const fromBend = Math.tan((bendAngleDeg * Math.PI) / 180) * rho0;
  const clamped = clamp(fromBend, clearanceMm, FLEXI_MAX_FACE_GAP_MM);
  const connectivityBudget =
    ballRadiusMm - socketDepthMm - BALL_CONNECTIVITY_MARGIN_MM;
  return Math.min(clamped, connectivityBudget);
}

// Re-size a joint's ball down to a hard cap (overlap guard), re-checking capture
// and fusing if the cap falls below the printable floor. Containment still holds
// because a smaller socket sphere fits wherever a larger one did.
function capJointBall(
  joint: FlexiJointPlan,
  cap: number,
  clearance: number,
  jointStyle: FlexiJointStyle,
): FlexiJointPlan {
  const fused: FlexiJointPlan = {
    center: joint.center,
    axis: joint.axis,
    ballRadiusMm: 0,
    socketDepthMm: 0,
    faceGapMm: 0,
    spineFraction: joint.spineFraction,
    fused: true,
  };
  if (cap < FLEXI_MIN_BALL_RADIUS_MM) {
    return fused;
  }
  const socketDepthMm = captureDepth(cap, clearance);
  if (socketDepthMm === null) {
    return fused;
  }
  // Rounded family and strong keep their constant bowl gap; classic's flat gap
  // shrinks with the ball (its bend-driven value is unchanged, so min() with
  // the connectivity budget is exact).
  const faceGapMm = ((): number => {
    switch (jointStyle) {
      case 'shell':
      case 'rounded':
      case 'strong':
        return roundedBowlGap(clearance);
      case 'classic':
        return Math.min(
          joint.faceGapMm,
          cap - socketDepthMm - BALL_CONNECTIVITY_MARGIN_MM,
        );
      default:
        return assertNever(jointStyle, 'capJointBall faceGap');
    }
  })();
  return {
    center: joint.center,
    axis: joint.axis,
    ballRadiusMm: cap,
    socketDepthMm,
    faceGapMm,
    spineFraction: joint.spineFraction,
    fused: false,
  };
}

// Largest ball radius that keeps adjacent joint solids clear along the spine.
// Classic: the tail-socket / head-ball pair inside a segment (reach ~ ball +
// clearance). Rounded: neighbouring cutters reach out to cup + bowl gap. Uses
// the smallest gap between consecutive stations, so live-adjacent joints (at
// least that far apart) are always satisfied.
function jointOverlapCap(
  joints: FlexiJointPlan[],
  pitch: number,
  clearance: number,
  jointStyle: FlexiJointStyle,
  bendAngleDeg: number,
): number {
  let minStationGap = Infinity;
  for (let i = 1; i < joints.length; i += 1) {
    minStationGap = Math.min(
      minStationGap,
      length(sub(joints[i].center, joints[i - 1].center)),
    );
  }
  if (!Number.isFinite(minStationGap)) {
    return Infinity;
  }
  // 2·(ball + clearance + wall + bowlGap) + margin ≤ gap.
  const roundedCap =
    (minStationGap - OVERLAP_MARGIN_MM) / 2 -
    clearance -
    ROUNDED_CUP_WALL_MM -
    roundedBowlGap(clearance);
  switch (jointStyle) {
    case 'shell':
    case 'rounded':
      return roundedCap;
    case 'strong': {
      // The strong footprint is monotone increasing in r, so bisect for the
      // largest ball whose cavity + land + anchor still fits the tightest
      // station gap. An INFEASIBLE radius counts as fitting purely to keep the
      // bisection well posed: feasibility is monotone in r, so the infeasible
      // set is a prefix and treating it as "fits" leaves the predicate
      // monotone, which is all the bisection needs. (It does NOT mean the joint
      // fuses — sizeJoint's strong arm plans a live joint judged by the rounded
      // cup when the strong solver is infeasible, and the build falls back per
      // joint.) The rounded cap is taken too, so the build's per-joint rounded
      // fallback always has room.
      const fits = (radius: number): boolean => {
        const geometry = solveStrongJointGeometry(
          radius,
          clearance,
          bendAngleDeg,
        );
        if (!geometry) return true;
        const footprint =
          geometry.cavityAxMm +
          FLEXI_MIN_SOCKET_WALL_MM +
          geometry.faceOffsetMm +
          strongAnchor(radius) +
          OVERLAP_MARGIN_MM;
        return footprint <= minStationGap;
      };
      let lo = FLEXI_MIN_BALL_RADIUS_MM;
      let hi = maxLiveRadius(joints);
      if (!(hi > lo)) {
        return Math.min(roundedCap, fits(lo) ? hi : 0);
      }
      if (fits(hi)) return Math.min(roundedCap, hi);
      if (!fits(lo)) return 0;
      for (let i = 0; i < 16; i += 1) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid;
        else hi = mid;
      }
      return Math.min(roundedCap, lo);
    }
    case 'classic': {
      const distanceCap = (minStationGap - clearance - OVERLAP_MARGIN_MM) / 2;
      return Math.min(pitch / 2.4, distanceCap);
    }
    default:
      return assertNever(jointStyle, 'jointOverlapCap');
  }
}

/** Socket face depth (h) that captures the ball, or null if none does. */
function captureDepth(
  ballRadiusMm: number,
  clearanceMm: number,
): number | null {
  const captureLimit = ballRadiusMm - FLEXI_CAPTURE_MARGIN_MM;
  for (const depthFactor of [SOCKET_DEPTH_FACTOR, SOCKET_DEPTH_FACTOR_MAX]) {
    const socketDepthMm = depthFactor * ballRadiusMm;
    if (
      socketMouthRadius(ballRadiusMm, clearanceMm, socketDepthMm) <=
      captureLimit
    ) {
      return socketDepthMm;
    }
  }
  return null;
}

// --- Strong ("strong joints") solved geometry ------------------------------

/**
 * Solved strong-joint geometry, in the joint frame
 * (`v` = lateral / e2, `u` = up / e1, `s` = axial / axis, tail negative).
 *
 * Male   = HEAD `Ball(rho)` at the pivot + BAR `{|v| ≤ bh, |u| ≤ Hb}` running
 *          tailward out of it, across the visible gap, into the tail segment.
 * Female = CAVITY `Ball(rho + c)`, CONCENTRIC with the head, behind a THROAT
 *          LAND of thickness `t` pierced by a tapered (bowtie) SLOT sized so the
 *          bar clears it through a ±bend rotation about the pivot.
 *
 * Containment is a one-liner rather than a swept-envelope calculation: the head
 * is a subset of `Ball(rho)`, a rotation about the pivot preserves every point's
 * radius, so the swept head grown by `c` is a subset of `Ball(rho + c)` — for
 * ANY bend angle, about ANY axis. That is law 2, and it is why this style's
 * clearance neither shrinks nor has to be budgeted against the travel.
 *
 * Three things are solved (all of them the BAR's half-width; the head is simply
 * the ball the plan already sized):
 *  1. CAPTURE — the throat, at its narrowest plane, must be narrower than the
 *     head by `FLEXI_CAPTURE_MARGIN_MM`. A ball of radius `rho` cannot cross a
 *     planar hole whose smaller half-extent is under `rho` (at the instant its
 *     centre is in the hole's plane its cross-section there is a disc of radius
 *     `rho`), so this blocks escape under any composition of roll, tilt and
 *     translation — not just the pure pull the previous design checked.
 *  2. RATTLE — pull-out slop is `√((rho+c)² − w²) − √(rho² − w²)` where `w` is
 *     the bearing radius, the smallest radius at which the cavity's spherical
 *     wall still has material (i.e. just outside the slot). It grows with `w`,
 *     so the bar is narrowed until the slop meets `strongPullBudget`.
 *  3. CONTAINMENT PARITY — the slot must never demand more room inside the skin
 *     than the cavity does, so `strongCavityFits` is bounded by the same
 *     `r + c + wall` the `rounded` cup needs and strong articulates a slim body
 *     exactly as far as rounded does.
 */
export type StrongJointGeometry = {
  /** Head sphere radius (= the plan's ball radius). */
  headRadiusMm: number;
  /** Bar half-width (lateral) and half-height. */
  bladeHalfMm: number;
  bladeHeightHalfMm: number;
  /** Cavity sphere radius, `rho + c`, concentric with the head. */
  cavityRadiusMm: number;
  /**
   * The cavity's three half-extents. All equal `cavityRadiusMm` — the pocket is
   * a ball — but the build and the containment gate read them by name, and
   * keeping them distinct documents which reach each caller means.
   */
  cavityLatMm: number;
  cavityUpMm: number;
  cavityAxMm: number;
  /** Land plate thickness, and the head segment's tail face at s = −faceOffsetMm. */
  throatLandMm: number;
  faceOffsetMm: number;
  /** Tapered slot half-sizes at the cavity wall (inner) and past the head face (outer). */
  throatInnerHalfMm: number;
  throatOuterHalfMm: number;
  slotInnerHalfMm: number;
  slotOuterHalfMm: number;
  /**
   * The slot is the affine bowtie `half(d) = base + taper·d` in the depth
   * `d = −s`. The build seeds its hull from these so the built slot IS that
   * envelope at every depth.
   */
  throatBaseHalfMm: number;
  slotBaseHalfMm: number;
  throatTaper: number;
  /**
   * How much wider the head is than the throat at the throat's narrowest plane.
   * At least `FLEXI_CAPTURE_MARGIN_MM` by construction — this is the number that
   * makes the joint captive, and the build suite measures it off the built
   * solids rather than trusting the solver.
   */
  captureMarginMm: number;
  /** Radius at which the head bears on the cavity wall when pulled tailward. */
  bearingRadiusMm: number;
  /**
   * Pure-translation free play before contact, per direction. The joint is
   * CAPTIVE in all six regardless — this is slop, never escape.
   *
   * Five of the six are exactly `clearanceMm`: a ball in a concentric ball has
   * that much room whichever way it is pushed. The sixth, pull-out, is the only
   * direction whose bearing surface is interrupted (by the throat slot the bar
   * passes through), so the head must travel out to the bearing radius before it
   * touches. That figure is solved and capped at `strongPullBudget(c)`.
   */
  axialFreePlayMm: number;
  verticalFreePlayMm: number;
  lateralFreePlayMm: number;
  /** `wide` = the bar is at its target width; `pinned` = a constraint narrowed it. */
  mode: 'wide' | 'pinned';
};

/**
 * Extra half-width the tapered slot needs beyond the per-axis bound
 * `w/cos β + d·tan β` so a RECTANGULAR bar clears it through an OBLIQUE bend.
 *
 * For a rotation of β about an axis at azimuth ψ in the `{e1, e2}` circle, the
 * bar corner `(a_v, a_u, s)` lands at
 *   `v' = a_v(cos²ψ + sin²ψ/cos β) − a_u sinψ cosψ (1−cos β)/cos β − d tanβ sinψ`
 * (exact — the `sinψ = 1` pure-yaw case collapses to `a_v/cos β − d tan β`,
 * which is what a naive formula assumes). Dropping the last, non-positive term
 * leaves an excess over that formula of at most
 *   `((1−cos β)/cos β) · max_t ( other·t·√(1−t²) − w·t² )`,  `t = |cos ψ|`.
 * That maximum is taken numerically here; it is a strict upper bound, so the
 * slot is a proven superset of the swept bar at every depth.
 */
function strongCornerPad(
  halfMm: number,
  otherHalfMm: number,
  bendRatio: number,
): number {
  if (!(bendRatio > 0)) return 0;
  let best = 0;
  for (let i = 1; i < STRONG_CORNER_SAMPLES; i += 1) {
    const t = i / STRONG_CORNER_SAMPLES;
    const value = otherHalfMm * t * Math.sqrt(1 - t * t) - halfMm * t * t;
    if (value > best) best = value;
  }
  return bendRatio * best;
}

/**
 * Radius at which a slot wall `half(d) = base + taper·d` crosses the cavity's
 * spherical wall of radius `A` — i.e. the smallest radius on that wall that
 * still has material behind it, which is where the head bears when pulled out.
 * `w = base + taper·√(A² − w²)` is a contraction for `taper < 1`, so a plain
 * fixed point converges geometrically.
 */
function strongBearingRadius(
  cavityRadiusMm: number,
  baseHalfMm: number,
  taper: number,
): number {
  let w = baseHalfMm;
  for (let i = 0; i < STRONG_BEARING_ITERATIONS; i += 1) {
    const depth = Math.sqrt(
      Math.max(0, cavityRadiusMm * cavityRadiusMm - w * w),
    );
    const next = baseHalfMm + taper * depth;
    if (Math.abs(next - w) < 1e-12) return next;
    w = next;
  }
  return w;
}

/**
 * The two radii the BUILT solids actually present to each other: the pocket's
 * widest point (a sphere vertex, since the pocket is inflated to contain its
 * ideal ball) and the head's narrowest (a facet plane). Pairing the two worst
 * cases is a bound, not an average — deliberately, so every play figure the
 * solver reports is one the built geometry cannot exceed.
 */
function strongBuiltRadii(
  headRadiusMm: number,
  clearanceMm: number,
): { outerMm: number; innerMm: number } {
  return {
    outerMm: (headRadiusMm + clearanceMm) * STRONG_SPHERE_INFLATION,
    innerMm: headRadiusMm * STRONG_SPHERE_INRADIUS_RATIO,
  };
}

/**
 * Pull-out slop for a head of radius `rho` in a concentric cavity of radius
 * `rho + c` whose tail wall is interrupted out to the bearing radius `w` — the
 * chord difference between the two spheres at that radius, taken on the BUILT
 * (faceted) radii.
 */
export function strongPullPlay(
  headRadiusMm: number,
  clearanceMm: number,
  bearingRadiusMm: number,
): number {
  const { outerMm, innerMm } = strongBuiltRadii(headRadiusMm, clearanceMm);
  const w = Math.min(bearingRadiusMm, innerMm);
  return (
    Math.sqrt(Math.max(0, outerMm * outerMm - w * w)) -
    Math.sqrt(Math.max(0, innerMm * innerMm - w * w))
  );
}

/**
 * Solve the strong joint's head / bar / cavity / throat for a ball radius,
 * clearance and bend angle. Pure — the plan and the build both call it, so they
 * cannot drift. Returns null when the joint is infeasible (the plan then judges
 * containment by the rounded cup and the build carves the rounded groove).
 *
 * There is no `clamp()` anywhere in the solve: an under-strength bar is an
 * explicit infeasibility, never a silently discarded floor.
 */
export function solveStrongJointGeometry(
  ballRadiusMm: number,
  clearanceMm: number,
  bendAngleDeg: number,
): StrongJointGeometry | null {
  const rho = ballRadiusMm;
  const c = clearanceMm;
  if (!(rho > 0) || !(c >= 0) || !Number.isFinite(bendAngleDeg)) return null;
  const bend = (bendAngleDeg * Math.PI) / 180;
  const cosB = Math.cos(bend);
  const tanB = Math.tan(bend);
  if (!(cosB > 1e-6) || bend < 0) return null;
  const bendRatio = (1 - cosB) / cosB;

  const cavityRadius = rho + c;
  const throatLand = strongThroatLand(rho);
  const faceOffset = cavityRadius + throatLand;

  // Largest bearing radius the pull-out budget allows. Slop
  // `√(A²−w²) − √(rho²−w²)` is increasing in `w`, so invert it once:
  // `√(rho²−w²) ≥ (A² − rho² − P²) / (2P)`, on the BUILT radii.
  const budget = strongPullBudget(c);
  const built = strongBuiltRadii(rho, c);
  const minChord =
    (built.outerMm * built.outerMm -
      built.innerMm * built.innerMm -
      budget * budget) /
    (2 * budget);
  const bearingCeiling =
    minChord >= built.innerMm
      ? 0
      : Math.sqrt(
          Math.max(
            0,
            built.innerMm * built.innerMm -
              Math.max(0, minChord) * Math.max(0, minChord),
          ),
        );
  const depthAtCeiling = Math.sqrt(
    Math.max(0, cavityRadius * cavityRadius - bearingCeiling * bearingCeiling),
  );

  const targetHalf = STRONG_BLADE_FRACTION * rho;
  const targetHeight = STRONG_BLADE_HEIGHT_FRACTION * rho;
  let bladeHalf = targetHalf;
  let bladeHeightHalf = targetHeight;
  for (let i = 0; i < STRONG_SOLVE_ITERATIONS; i += 1) {
    const padLat = strongCornerPad(bladeHalf, bladeHeightHalf, bendRatio);
    // (1) capture: the throat at the cavity wall stays a margin inside the head.
    const capCapture =
      (rho - FLEXI_CAPTURE_MARGIN_MM - c - cavityRadius * tanB - padLat) * cosB;
    // (2) rattle: the bearing radius stays within the pull-out budget.
    const capPlay =
      (bearingCeiling - c - padLat - tanB * depthAtCeiling) * cosB;
    // (3) containment parity: the slot never out-demands the cavity itself.
    const capFit = (rho - faceOffset * tanB - padLat) * cosB;
    bladeHalf = Math.min(targetHalf, capCapture, capPlay, capFit);
    if (!(bladeHalf > 0)) break;
    const padUp = strongCornerPad(bladeHeightHalf, bladeHalf, bendRatio);
    bladeHeightHalf = Math.min(
      targetHeight,
      (rho - faceOffset * tanB - padUp) * cosB,
    );
    if (!(bladeHeightHalf > 0)) break;
  }
  if (
    !(2 * bladeHalf >= STRONG_BLADE_MIN_MM) ||
    !(bladeHeightHalf >= STRONG_BLADE_MIN_HEIGHT_MM)
  ) {
    return null;
  }

  const padLat = strongCornerPad(bladeHalf, bladeHeightHalf, bendRatio);
  const padUp = strongCornerPad(bladeHeightHalf, bladeHalf, bendRatio);
  const throatBase = bladeHalf / cosB + padLat + c;
  const slotBase = bladeHeightHalf / cosB + padUp + c;
  const bearingRadius = Math.min(
    strongBearingRadius(cavityRadius, throatBase, tanB),
    strongBearingRadius(cavityRadius, slotBase, tanB),
  );

  return {
    headRadiusMm: rho,
    bladeHalfMm: bladeHalf,
    bladeHeightHalfMm: bladeHeightHalf,
    cavityRadiusMm: cavityRadius,
    cavityLatMm: cavityRadius,
    cavityUpMm: cavityRadius,
    cavityAxMm: cavityRadius,
    throatLandMm: throatLand,
    faceOffsetMm: faceOffset,
    throatInnerHalfMm: throatBase + cavityRadius * tanB,
    throatOuterHalfMm: throatBase + faceOffset * tanB,
    slotInnerHalfMm: slotBase + cavityRadius * tanB,
    slotOuterHalfMm: slotBase + faceOffset * tanB,
    throatBaseHalfMm: throatBase,
    slotBaseHalfMm: slotBase,
    throatTaper: tanB,
    captureMarginMm:
      rho -
      Math.min(
        throatBase + cavityRadius * tanB,
        slotBase + cavityRadius * tanB,
      ),
    bearingRadiusMm: bearingRadius,
    axialFreePlayMm: strongPullPlay(rho, c, bearingRadius),
    verticalFreePlayMm: built.outerMm - built.innerMm,
    lateralFreePlayMm: built.outerMm - built.innerMm,
    mode: bladeHalf >= targetHalf - 1e-9 ? 'wide' : 'pinned',
  };
}

/**
 * Lateral half-width of the strong cavity at axial offset `d` from the pivot —
 * the pocket is a ball, so this is just its chord.
 */
export function strongCavityHalfWidthAt(
  geometry: StrongJointGeometry,
  d: number,
): number {
  const radius = geometry.cavityRadiusMm;
  if (Math.abs(d) > radius) return 0;
  return Math.sqrt(Math.max(0, radius * radius - d * d));
}

/** Seam overlap (deg) added on top of the travel — exported for the build. */
export const STRONG_SEAM_OVERLAP_DEGREES = STRONG_SEAM_OVERLAP_DEG;
export const STRONG_SEAM_EXTRA_MAX_RADIANS = STRONG_SEAM_EXTRA_MAX_RAD;
export const STRONG_SEAM_EPS_MILLIMETRES = STRONG_SEAM_EPS_MM;
export const STRONG_SEAM_INNER_PAD_MILLIMETRES = STRONG_SEAM_INNER_PAD_MM;
export const STRONG_GEM_UNION_OVERLAP_MILLIMETRES = STRONG_GEM_UNION_OVERLAP_MM;
/** How far past the tail face the bar buries itself (build-side, mm). */
export function strongAnchorMm(ballRadiusMm: number): number {
  return strongAnchor(ballRadiusMm);
}

/**
 * Containment gate for the strong style. Conservative and ISOTROPIC: it reads
 * the same min-over-16-directions reducer `socketContainedAlongReach` uses, so
 * it can never be fooled by a thin fin the way a single support direction can.
 *
 * (1) the closed cavity, sampled across its own axial reach, and
 * (2) the land: the slot must not sever the head segment's tail face.
 */
function strongCavityFits(
  profile: CrossSectionProfile,
  ballRadiusMm: number,
  clearanceMm: number,
  bendAngleDeg: number,
  wallMm: number = FLEXI_MIN_SOCKET_WALL_MM,
): boolean {
  const geometry = solveStrongJointGeometry(
    ballRadiusMm,
    clearanceMm,
    bendAngleDeg,
  );
  if (!geometry) return false;
  for (let j = 0; j <= CONTAINMENT_SAMPLES; j += 1) {
    const d =
      -geometry.cavityAxMm +
      (2 * geometry.cavityAxMm * j) / CONTAINMENT_SAMPLES;
    const needed = strongCavityHalfWidthAt(geometry, d) + wallMm;
    if (needed > crossSectionAt(profile, d) + 1e-6) {
      return false;
    }
  }
  const slot =
    Math.max(geometry.throatOuterHalfMm, geometry.slotOuterHalfMm) + wallMm;
  for (const d of [-geometry.cavityAxMm, -geometry.faceOffsetMm]) {
    if (slot > crossSectionAt(profile, d) + 1e-6) {
      return false;
    }
  }
  return true;
}

/**
 * Axial footprint one strong joint claims along the spine: the head side needs
 * the cavity plus a wall, the tail side needs the land plus the bar's anchor,
 * and both must clear the seam band's reach at the widest station.
 */
function strongFootprintMm(
  maxBallRadius: number,
  clearance: number,
  bendAngleDeg: number | undefined,
  maxStationExtentMm: number | undefined,
): number | null {
  if (bendAngleDeg === undefined) return null;
  const geometry = solveStrongJointGeometry(
    maxBallRadius,
    clearance,
    bendAngleDeg,
  );
  if (!geometry) return null;
  const half = ((bendAngleDeg + GAP_BAND_OVERLAP_DEG) * Math.PI) / 360;
  const band = (maxStationExtentMm ?? 0) * Math.tan(half);
  const head = Math.max(geometry.cavityAxMm + FLEXI_MIN_SOCKET_WALL_MM, band);
  const tail = Math.max(
    geometry.faceOffsetMm + strongAnchor(maxBallRadius),
    band,
  );
  return head + tail + OVERLAP_MARGIN_MM;
}

/**
 * Socket mouth opening radius for a ball radius `r`, clearance `c` and socket
 * face depth `h`: the socket cavity has radius `r + c` centred on the joint and
 * its mouth is the circle where that sphere meets the face plane `h` behind the
 * centre — `sqrt((r + c)^2 - h^2)`.
 */
export function socketMouthRadius(
  ballRadiusMm: number,
  clearanceMm: number,
  socketDepthMm: number,
): number {
  const socketRadius = ballRadiusMm + clearanceMm;
  const inner = socketRadius * socketRadius - socketDepthMm * socketDepthMm;
  return inner > 0 ? Math.sqrt(inner) : 0;
}

// The socket cavity (a sphere of radius `reachRadius` centred on the joint) must
// stay `wallMm` inside the body across its whole axial reach ±reachRadius, not
// just at the cut plane — a socket carved through the skin of a tapering body
// would print a hole and let the ball escape. Classic uses reach r+c plus a
// socket wall; rounded uses reach r+c+w (the cup outer) which itself must sit
// inside the skin (bowl/brim beyond it exit the skin by design).
function socketContainedAlongReach(
  profile: CrossSectionProfile,
  reachRadius: number,
  wallMm: number,
): boolean {
  for (let j = 0; j <= CONTAINMENT_SAMPLES; j += 1) {
    const d = -reachRadius + (2 * reachRadius * j) / CONTAINMENT_SAMPLES;
    const needed =
      Math.sqrt(Math.max(0, reachRadius * reachRadius - d * d)) + wallMm;
    if (needed > crossSectionAt(profile, d) + 1e-6) {
      return false;
    }
  }
  return true;
}

type CrossSectionProfile = {
  // Axial bin index → per-direction max |projection|, per-sector max radial
  // distance (0 ⇒ no vertex fell in that sector for this slice), and the point
  // count.
  bins: Map<
    number,
    { dirMax: Float64Array; secMax: Float64Array; count: number }
  >;
  cos: Float64Array;
  sin: Float64Array;
};

// Bin every vertex by its axial offset from the joint, recording the maximum
// |projection| onto each of a fan of cross-section directions (a support
// function — bounds the body for containment / band sizing) plus, per signed
// azimuth sector, the maximum in-plane radial distance (the actual skin radius
// at that azimuth — the lofted shell seam follows this). Cheap to query at any
// offset afterwards (one pass over the vertices, O(V × directions)).
function buildCrossSectionProfile(
  positions: Float32Array,
  center: Vec3,
  tangent: Vec3,
  frame: SpineFrame,
): CrossSectionProfile {
  const cos = new Float64Array(CROSS_SECTION_DIRECTIONS);
  const sin = new Float64Array(CROSS_SECTION_DIRECTIONS);
  for (let k = 0; k < CROSS_SECTION_DIRECTIONS; k += 1) {
    const angle = (Math.PI * k) / CROSS_SECTION_DIRECTIONS;
    cos[k] = Math.cos(angle);
    sin[k] = Math.sin(angle);
  }

  const bins = new Map<
    number,
    { dirMax: Float64Array; secMax: Float64Array; count: number }
  >();
  const vertexCount = Math.floor(positions.length / 3);
  const sectorScale = CROSS_SECTION_SECTORS / (2 * Math.PI);
  for (let i = 0; i < vertexCount; i += 1) {
    const relX = positions[i * 3] - center[0];
    const relY = positions[i * 3 + 1] - center[1];
    const relZ = positions[i * 3 + 2] - center[2];
    const d = relX * tangent[0] + relY * tangent[1] + relZ * tangent[2];
    const x = relX * frame.e1[0] + relY * frame.e1[1] + relZ * frame.e1[2];
    const y = relX * frame.e2[0] + relY * frame.e2[1] + relZ * frame.e2[2];
    const binIndex = Math.round(d / PROFILE_BIN_MM);
    let bin = bins.get(binIndex);
    if (!bin) {
      bin = {
        dirMax: new Float64Array(CROSS_SECTION_DIRECTIONS),
        secMax: new Float64Array(CROSS_SECTION_SECTORS),
        count: 0,
      };
      bins.set(binIndex, bin);
    }
    for (let k = 0; k < CROSS_SECTION_DIRECTIONS; k += 1) {
      const projection = Math.abs(x * cos[k] + y * sin[k]);
      if (projection > bin.dirMax[k]) bin.dirMax[k] = projection;
    }
    const radius = Math.hypot(x, y);
    if (radius > 1e-9) {
      let sector = Math.floor((Math.atan2(y, x) + 2 * Math.PI) * sectorScale);
      sector %= CROSS_SECTION_SECTORS;
      if (radius > bin.secMax[sector]) bin.secMax[sector] = radius;
    }
    bin.count += 1;
  }
  return { bins, cos, sin };
}

// ρ(d): thinnest-direction half-extent of the cross-section in a slab centred at
// axial offset d. The slab widens (1→2→3mm) until it holds enough points so a
// coarse mesh cannot leave a mid-body slab spuriously empty; empty even at the
// widest ⇒ 0 (past the end of the body).
function crossSectionAt(profile: CrossSectionProfile, d: number): number {
  return reduceCrossSectionAt(profile, d, minOfArray);
}

// The per-direction max-projections of the cross-section slab at offset d,
// widening the slab until it holds enough points (empty at the widest ⇒ null).
function crossSectionDirMaxAt(
  profile: CrossSectionProfile,
  d: number,
  halfWidths: number[] = SLAB_WIDEN_HALF_WIDTHS,
): Float64Array | null {
  const { bins } = profile;
  let lastDirMax: Float64Array | null = null;
  let lastCount = 0;
  for (const halfWidth of halfWidths) {
    const lo = Math.round((d - halfWidth) / PROFILE_BIN_MM);
    const hi = Math.round((d + halfWidth) / PROFILE_BIN_MM);
    const dirMax = new Float64Array(CROSS_SECTION_DIRECTIONS);
    let count = 0;
    for (let binIndex = lo; binIndex <= hi; binIndex += 1) {
      const bin = bins.get(binIndex);
      if (!bin) continue;
      count += bin.count;
      for (let k = 0; k < CROSS_SECTION_DIRECTIONS; k += 1) {
        if (bin.dirMax[k] > dirMax[k]) dirMax[k] = bin.dirMax[k];
      }
    }
    lastDirMax = dirMax;
    lastCount = count;
    if (count >= MIN_SLAB_POINTS) return dirMax;
  }
  return lastCount > 0 ? lastDirMax : null;
}

function reduceCrossSectionAt(
  profile: CrossSectionProfile,
  d: number,
  reducer: (values: Float64Array) => number,
  halfWidths?: number[],
): number {
  const dirMax = crossSectionDirMaxAt(profile, d, halfWidths);
  return dirMax ? reducer(dirMax) : 0;
}

function minOfArray(values: Float64Array): number {
  let min = Infinity;
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] < min) min = values[i];
  }
  return Number.isFinite(min) ? min : 0;
}

function maxOfArray(values: Float64Array): number {
  let max = 0;
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] > max) max = values[i];
  }
  return max;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
