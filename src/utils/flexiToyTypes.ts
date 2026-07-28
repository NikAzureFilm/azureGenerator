/**
 * Shared contract for the Flexi Toy Maker feature.
 *
 * The UI (FlexiToyDialog) talks to the geometry core exclusively through these
 * types plus the two entry points in `flexiToyClient.ts`:
 *
 *   sceneToFlexiMeshInput(scene: THREE.Scene): FlexiMeshInput
 *   computeFlexiToy(input: FlexiMeshInput, settings: FlexiToySettings): Promise<FlexiToyOutcome>
 *
 * `computeFlexiToy` is latest-wins: a newer call supersedes an in-flight one and
 * the superseded promise resolves with `{ status: 'superseded' }`.
 */

export const FLEXI_CLEARANCE_PRESETS = {
  tight: 0.3,
  standard: 0.4,
  loose: 0.55,
} as const;

export type FlexiClearancePreset = keyof typeof FLEXI_CLEARANCE_PRESETS;

export const FLEXI_MIN_CLEARANCE_MM = 0.2;
export const FLEXI_MAX_CLEARANCE_MM = 0.8;
export const FLEXI_MIN_SEGMENTS = 3;
export const FLEXI_MAX_SEGMENTS = 20;
export const FLEXI_MIN_LENGTH_MM = 80;
export const FLEXI_MAX_LENGTH_MM = 400;
export const FLEXI_DEFAULT_LENGTH_MM = 150;
export const FLEXI_MIN_JOINT_SCALE = 0.6;
export const FLEXI_MAX_JOINT_SCALE = 1.4;
export const FLEXI_MIN_BEND_DEG = 5;
export const FLEXI_MAX_BEND_DEG = 25;
export const FLEXI_DEFAULT_BEND_DEG = 12;
/** Hard ceiling on the printed face gap between segments (mm). */
export const FLEXI_MAX_FACE_GAP_MM = 4;

/** Hard geometric floors (mm) — planning fuses a joint rather than violate these. */
export const FLEXI_MIN_BALL_RADIUS_MM = 2.5;
export const FLEXI_MIN_SOCKET_WALL_MM = 1.2;
export const FLEXI_CAPTURE_MARGIN_MM = 0.3;

export type FlexiAxisOverride = 'auto' | 'x' | 'y' | 'z';

/**
 * Articulation style:
 * - 'shell': overlapping-scale joints (articulated-dragon look) — the seam
 *   floor is a concentric sliding dome and the head-side skin laps over it,
 *   so you never see into the joint, bent or straight. Sizing follows the
 *   rounded family; falls back to the rounded wedge per joint where the body
 *   is too thin for the lap shelf.
 * - 'rounded': concentric dome-in-dish cut surfaces (flexi-cutter style) — the
 *   gap is invariant under joint rotation, so segments swing to the full
 *   bendAngleDeg; the cut shows as a narrow rounded groove.
 * - 'classic': flat ring cuts (fishing-lure look) — visible flat gaps between
 *   segments; bend is limited by the faces meeting, so travel is smaller.
 */
export type FlexiJointStyle = 'shell' | 'rounded' | 'classic';

export const FLEXI_DEFAULT_JOINT_STYLE: FlexiJointStyle = 'shell';

/** Styles that share the rounded family's sizing (cup containment, bowl gap). */
export function isRoundedFamilyJointStyle(style: FlexiJointStyle): boolean {
  return style === 'rounded' || style === 'shell';
}

export type FlexiToySettings = {
  /** 'auto' → round(spineLength / 22) clamped to [4, FLEXI_MAX_SEGMENTS]. */
  segmentCount: number | 'auto';
  /** Radial ball↔socket clearance AND face gap, in mm. */
  clearanceMm: number;
  /** Target length along the spine in mm; the model is uniformly scaled to this before planning. */
  targetLengthMm: number;
  /** Multiplier on the auto ball-radius sizing. */
  jointScale: number;
  axisOverride: FlexiAxisOverride;
  /** Articulation style — see FlexiJointStyle. */
  jointStyle: FlexiJointStyle;
  /**
   * Target per-joint bend angle in degrees.
   * - 'rounded': the actual target swing per joint — concentric mating faces
   *   never collide, so travel is limited only by the neck hitting the socket
   *   mouth (travel ≈ θ_mouth − α_neck), which this angle sets directly.
   * - 'classic': drives the printed flat face gap between segments:
   *   gap_i ≈ tan(bend) × local body radius, clamped to
   *   [clearanceMm, FLEXI_MAX_FACE_GAP_MM] and to the ball-connectivity budget
   *   ((1 − socketDepthFactor) × ballRadius − 0.2mm), so chunkier joints bend
   *   further before the flat faces meet.
   */
  bendAngleDeg: number;
  /**
   * Optional user-dragged cut stations as strictly increasing arc-length
   * fractions (0..1 exclusive), length segmentCount − 1. When present they
   * override even spacing; the planner clamps to valid spacing/order and echoes
   * the final positions in FlexiJointPlan.spineFraction (with a
   * 'joint-positions-adjusted' warning when it had to move one). When absent,
   * stations are evenly spaced. The UI pins segmentCount to a number (not
   * 'auto') whenever it supplies this.
   */
  jointPositions?: number[];
};

/** Mesh handed from the main thread to the core (transferable typed arrays, mm units). */
export type FlexiMeshInput = {
  /** xyz interleaved. */
  positions: Float32Array;
  /** Triangle vertex indices. */
  indices: Uint32Array;
  /** rgb interleaved, 0..1, one per vertex (baked from material/vertex color/albedo texture). */
  colors: Float32Array;
};

export type FlexiWarningCode =
  | 'joint-fused-too-thin'
  | 'segment-count-reduced'
  | 'joint-size-capped'
  | 'spine-fallback-straight'
  | 'cuts-not-vertical'
  | 'joint-positions-adjusted'
  | 'shell-joint-fallback'
  | 'mesh-repaired';

export type FlexiToyWarning = {
  code: FlexiWarningCode;
  message: string;
  /** Present for per-joint warnings. */
  jointIndex?: number;
};

export type FlexiJointPlan = {
  /** Joint pivot on the spine (mm, three.js y-up space of the scaled model). */
  center: [number, number, number];
  /**
   * Unit cut normal, tail → head. VERTICAL-CUT RULE: this is the spine tangent
   * projected to the horizontal plane (y = 0) and normalized, so cut faces are
   * perpendicular to the print bed; when the tangent is too vertical
   * (horizontal magnitude < 0.3) the raw tangent is used and a
   * 'cuts-not-vertical' warning is emitted.
   */
  axis: [number, number, number];
  /** Ball radius (mm). */
  ballRadiusMm: number;
  /** Socket-side face plane sits at `center − socketDepthMm × axis`. */
  socketDepthMm: number;
  /**
   * Printed gap between this joint's two segment faces (mm).
   * - 'classic': the flat ring gap; the ball-side face sits at
   *   `center − (socketDepthMm + faceGapMm) × axis`. Derived from bendAngleDeg.
   * - 'rounded': the constant bowl gap g_b (= max(clearanceMm, 0.55mm)) between
   *   the concentric shoulder and cup; travel is gap-independent by design.
   */
  faceGapMm: number;
  /** This joint's station along the spine as an arc-length fraction (0..1). */
  spineFraction: number;
  /** True → no cut at this station; the body stays rigid here. */
  fused: boolean;
};

export type FlexiToyPlan = {
  joints: FlexiJointPlan[];
  /** Smoothed spine polyline (mm). */
  spine: Array<[number, number, number]>;
  spineLengthMm: number;
  warnings: FlexiToyWarning[];
};

export type FlexiToyResult = {
  /** Final geometry: all segments as separate bodies in one buffer, floor-aligned (minY=0), mm. */
  positions: Float32Array;
  indices: Uint32Array;
  /** rgb 0..1 per vertex, colors carried through the boolean pipeline. */
  colors: Float32Array;
  /** Per-segment triangle ranges into `indices` (start/count in index entries, i.e. multiples of 3). */
  segmentTriangleRanges: Array<{ start: number; count: number }>;
  segmentCount: number;
  /** Articulating joints (excludes fused). */
  jointCount: number;
  fusedJointCount: number;
  lengthMm: number;
  plan: FlexiToyPlan;
  warnings: FlexiToyWarning[];
};

export type FlexiToyErrorCode =
  | 'not-watertight'
  | 'too-small'
  /**
   * The rounded cutter failed to fully separate the segments (typically a
   * pronounced off-axis feature bridging a cut). The classic style usually
   * handles these models — the UI should point the user there.
   */
  | 'rounded-uncut'
  | 'compute-failed';

export type FlexiToyOutcome =
  | { status: 'ok'; result: FlexiToyResult }
  | { status: 'error'; code: FlexiToyErrorCode; message: string }
  | { status: 'superseded' };

/** Worker protocol. */
export type FlexiWorkerRequest = {
  type: 'compute';
  requestId: number;
  input: FlexiMeshInput;
  settings: FlexiToySettings;
};

export type FlexiWorkerResponse = {
  type: 'result';
  requestId: number;
  outcome: Exclude<FlexiToyOutcome, { status: 'superseded' }>;
};
