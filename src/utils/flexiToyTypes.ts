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

/** Hard geometric floors (mm) — planning fuses a joint rather than violate these. */
export const FLEXI_MIN_BALL_RADIUS_MM = 2.5;
export const FLEXI_MIN_SOCKET_WALL_MM = 1.2;
export const FLEXI_CAPTURE_MARGIN_MM = 0.3;

export type FlexiAxisOverride = 'auto' | 'x' | 'y' | 'z';

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
  /** Unit tangent, tail → head. */
  axis: [number, number, number];
  /** Ball radius (mm). */
  ballRadiusMm: number;
  /** Socket-side face plane sits at `center − socketDepthMm × axis`. */
  socketDepthMm: number;
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
