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
  assertNever,
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
  FlexiBuildQuality,
} from './flexiToyTypes.ts';
import {
  crossSectionExtentsSampler,
  solveStrongJointGeometry,
  strongAnchorMm,
  STRONG_SEAM_OVERLAP_DEGREES,
  STRONG_SEAM_EXTRA_MAX_RADIANS,
  STRONG_SEAM_EPS_MILLIMETRES,
  STRONG_SEAM_INNER_PAD_MILLIMETRES,
  STRONG_GEM_UNION_OVERLAP_MILLIMETRES,
  STRONG_SPHERE_SEGMENTS,
  STRONG_SPHERE_INFLATION,
  strongCavityHalfWidthAt,
  solveLinkJointGeometry,
  resolveLinkTuning,
  type LinkTuning,
  solveLinkSeam,
  linkHoopPolyline,
  linkHoopOuterMm,
  linkPocketBoundsMm,
  linkKerfAtMm,
  linkPitchSweepAnglesDeg,
  linkBladeCapFits,
  linkBladeHeadCapMm,
  linkTravelSearch,
  LINK_SPHERE_SEGMENTS,
  LINK_SPHERE_INFLATION,
  LINK_BLADE_SEGMENTS,
  LINK_KERF_SEGMENTS,
  LINK_KERF_ALLOWANCE_MM,
  LINK_SECONDARY_INFLATE_MAX_MM,
  LINK_ENGAGE_MIN_MM,
  LINK_NEIGHBOUR_CLEAR_MM,
  LINK_CLIP_MARGIN_MM,
  LINK_TRAVEL_MIN_DEG,
} from './flexiToyPlan.ts';
import type {
  FlexiSectionSampler,
  StrongJointGeometry,
  LinkJointGeometry,
  LinkSeamProfile,
  LinkHoopPolyline,
} from './flexiToyPlan.ts';

/**
 * Non-superseded outcome the worker forwards to the main thread, plus the
 * build's own `aborted`: a build the caller cancelled at a joint checkpoint has
 * no result and is NOT an error — the UI simply has nothing new to show.
 */
export type FlexiBuildOutcome =
  | Exclude<FlexiToyOutcome, { status: 'superseded' }>
  | { status: 'aborted' };

/**
 * Cancellation hook. `buildFlexiToy` calls `checkpoint()` between joints; a
 * resolved `true` means "a newer request has arrived, stop now" and the build
 * returns `{ status: 'aborted' }` having freed everything it allocated.
 *
 * It is a PROMISE so the worker can yield to its message loop there (that is
 * the only way a `cancel` message can be seen at all in a single-threaded
 * worker). The default never yields and never aborts, so existing callers keep
 * today's timing to within one microtask per joint.
 */
export type FlexiBuildControl = {
  /** Called between joints. Resolves true if the build must abort now. May yield to the event loop. */
  checkpoint: () => Promise<boolean>;
};

const NEVER_ABORT: FlexiBuildControl = { checkpoint: async () => false };

/**
 * The nearest-input-vertex colour lookup, opaque to callers: it is built once
 * per registered mesh and handed back to every build of that mesh so the
 * O(vertices) grid construction is not repeated per slider tweak.
 */
export type FlexiColorGrid = ColorGrid;

/**
 * A base manifold the CALLER owns, so a worker can build it once per mesh and
 * reuse it across the many builds a slider drag produces. `buildFlexiToy` never
 * deletes it and never registers it in its garbage sweep.
 */
export type FlexiPreparedBody = {
  manifold: Manifold;
  /** True if the ITK repair chain was needed (drives the 'mesh-repaired' warning). */
  repaired: boolean;
  /** Built from the FULL-resolution coloured input, shared with preview bodies. */
  colorGrid: FlexiColorGrid;
};

export type FlexiBuildOptions = {
  /**
   * Use this body instead of constructing one. The `meshInput` passed to
   * `buildFlexiToy` MUST be the mesh this body was made from — the plan's
   * samplers and the fallback colour grid both read it — so a preview build
   * passes the `meshInput` `deriveFlexiPreviewBody` returned, not the original.
   */
  prepared?: FlexiPreparedBody;
  /** Defaults to a control that never aborts and never yields. */
  control?: FlexiBuildControl;
  /** Defaults to 'final': existing callers and the tests get today's geometry. */
  quality?: FlexiBuildQuality;
};

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

/** Facets of the ring rod's circular cross-section. 32 keeps the envelope's
 *  inscription inflation (`1/cos(π/32) ≈ 1.005`) inside the key-gap margin.
 *  Declared up here beside the other tessellation counts because `RES` seeds
 *  from it (a `const` referenced before its line is a TDZ throw at load). */
const LINK_RING_TUBE_SEGMENTS = 32;

// --- Tessellation resolution profile ---------------------------------------
//
// The six counts below are how finely the per-joint solids are faceted. They
// are the ONLY tessellation knobs a preview may coarsen, and the two properties
// that let it are different for the two groups:
//
//  · The link envelopes are SELF-CONSISTENT: each derives its inscription
//    inflation from the same count it is built and revolved with (see
//    `RES.linkRingTubeSegments` / `RES.linkBladeSegments` in
//    `buildLinkRingEnvelope`), so a coarse envelope inflates further and stays
//    a superset of the swept solid exactly as the fine one does.
//  · The revolved cutters (rounded, shell, strong seam) inscribe their profile,
//    so a coarser revolve carves marginally LESS in the facet valleys and a
//    preview joint's running clearance is a hair tighter than the final's. That
//    is acceptable precisely because a preview is never printed: the download
//    always comes from a `final` build, which rebuilds every solid at the fine
//    profile.
//
// Deliberately NOT here: LINK_SPHERE_SEGMENTS / LINK_SPHERE_INFLATION and
// STRONG_SPHERE_SEGMENTS / STRONG_SPHERE_INFLATION. The PLAN solves against
// those, so changing them per quality would make a preview's mechanism a
// different mechanism from the final's — the preview would stop predicting the
// thing it is previewing.
//
// `RES` is mutable module state, set at `buildFlexiToy` entry and restored to
// the final profile in its `finally`. INVARIANT: one build at a time per worker
// — the only `await` inside a build is the caller's checkpoint, and a caller
// that starts a second build before the first has returned would see the two
// profiles interleave.
const RES = {
  sphereSegments: SPHERE_SEGMENTS,
  cutterRevolveSegments: CUTTER_REVOLVE_SEGMENTS,
  shellRevolveSegments: SHELL_REVOLVE_SEGMENTS,
  linkBladeSegments: LINK_BLADE_SEGMENTS,
  linkKerfSegments: LINK_KERF_SEGMENTS,
  linkRingTubeSegments: LINK_RING_TUBE_SEGMENTS,
};

type ResolutionProfile = typeof RES;

const FINAL_RESOLUTION: ResolutionProfile = { ...RES };

// Roughly two-thirds of the final counts: coarse enough to halve the boolean
// cost of the per-joint solids, fine enough that the preview still reads as the
// shape the final build will produce.
const PREVIEW_RESOLUTION: ResolutionProfile = {
  sphereSegments: 32,
  cutterRevolveSegments: 64,
  shellRevolveSegments: 48,
  linkBladeSegments: 32,
  linkKerfSegments: 48,
  linkRingTubeSegments: 20,
};

function applyResolutionProfile(quality: FlexiBuildQuality): void {
  Object.assign(
    RES,
    quality === 'preview' ? PREVIEW_RESOLUTION : FINAL_RESOLUTION,
  );
}

// --- Per-joint solid cache -------------------------------------------------
//
// Every per-joint SOLID (the link cutter/hoop/ring, the strong cutter/male, the
// rounded and shell cutters) is a pure function of a handful of numbers: the
// joint's pose and radius, the solved geometry/seam, the clearance and the
// tessellation profile. Nothing about the BODY enters them. Dragging a slider
// therefore rebuilds a great many solids that are bit-identical to ones the
// previous build already paid for — measured at 850–970ms of a ~1350ms link
// build, and independent of the mesh size.
//
// So they are cached for the life of the worker, keyed on an exact serialisation
// (see `cacheKey`) of EVERY input, the quality profile included. Manifold
// results are deterministic for identical inputs, so a hit is bit-identical to a
// rebuild; there is no tolerance and no approximation here.
//
// OWNERSHIP. A cached solid is BORROWED by the loop that uses it: it must be
// passed to booleans (which never consume their inputs) and then dropped, never
// deleted. `release()` is the one place that knows the difference. Entries are
// PINNED while a loop holds them so eviction can never free a handle that is
// still in a `males` array waiting for the final union.
const SOLID_CACHE_MAX = 32;

type SolidCacheEntry = {
  solids: Manifold[];
  /** Live borrows. An entry with pins > 0 is never evicted. */
  pins: number;
};

// Insertion-ordered, so the first key is the least recently used (a hit
// re-inserts).
const solidCache = new Map<string, SolidCacheEntry>();

function trimSolidCache(): void {
  if (solidCache.size <= SOLID_CACHE_MAX) return;
  for (const [key, entry] of solidCache) {
    if (solidCache.size <= SOLID_CACHE_MAX) break;
    if (entry.pins > 0) continue;
    solidCache.delete(key);
    for (const solid of entry.solids) {
      try {
        solid.delete();
      } catch {
        // Already freed or invalid handle; nothing to do.
      }
    }
  }
}

/**
 * Drop every cached solid (worker teardown, or a test wanting a cold build).
 * Frees PINNED entries too, so it must not be called while a build is running —
 * that would pull the solids out from under it.
 */
export function clearFlexiSolidCache(): void {
  for (const entry of solidCache.values()) {
    for (const solid of entry.solids) {
      try {
        solid.delete();
      } catch {
        // Already freed or invalid handle; nothing to do.
      }
    }
  }
  solidCache.clear();
}

/**
 * Per-build borrow bookkeeping. Created by `buildFlexiToy` and released in its
 * `finally`, so every exit path — success, error, abort, throw — unpins.
 */
type SolidBorrow = {
  /** Cached solids for `key`, borrowed for the life of this build, or null. */
  take: (key: string) => Manifold[] | null;
  /** Take ownership of freshly built solids and borrow them back. */
  store: (key: string, solids: Manifold[]) => void;
  /** Delete `manifold` unless it is a borrowed cache handle. */
  release: (manifold: Manifold | null | undefined) => void;
  /** Unpin everything this build borrowed, then evict down to the cap. */
  done: () => void;
};

function createSolidBorrow(): SolidBorrow {
  const borrowed = new Set<Manifold>();
  const pinned: SolidCacheEntry[] = [];
  const pin = (entry: SolidCacheEntry): Manifold[] => {
    entry.pins += 1;
    pinned.push(entry);
    for (const solid of entry.solids) borrowed.add(solid);
    return entry.solids;
  };
  return {
    take: (key) => {
      const entry = solidCache.get(key);
      if (!entry) return null;
      // Re-insert so the map's iteration order stays least-recently-used first.
      solidCache.delete(key);
      solidCache.set(key, entry);
      return pin(entry);
    },
    store: (key, solids) => {
      // NO EXPLICIT EVALUATION HERE, and that is deliberate — measured, not
      // assumed.
      //
      // The worry a cache has to answer is that manifold booleans are lazy, so
      // an unevaluated node would drag its whole boolean tree into every later
      // build that reuses it. It does not arise: every builder already forces
      // its solid with a `status()` check before returning (see
      // `buildLinkCutter`, `buildLinkRing`, `buildStrongCutter`,
      // `buildStrongMale`, `buildRoundedCutter`, `buildShellCutter`), so the
      // only lazy residue is the trailing `transform` onto the joint frame — a
      // leaf transform, not a boolean.
      //
      // Baking that residue with a `numTri()` here is not free: link's males go
      // into ONE n-ary `Manifold.union(males)`, and manifold flattens an
      // unevaluated child into that batch but treats a baked one as an opaque
      // leaf. The two routes give equally valid but DIFFERENT tessellations
      // (measured: 36834 triangles against the reference 36706 on the profiling
      // spindle) — a silent change to shipped geometry, and it was also 10%
      // slower on the second build. So the solids are stored exactly as their
      // builders returned them.
      const entry: SolidCacheEntry = { solids, pins: 0 };
      solidCache.set(key, entry);
      pin(entry);
      trimSolidCache();
    },
    release: (manifold) => {
      if (!manifold) return;
      if (borrowed.has(manifold)) return;
      try {
        manifold.delete();
      } catch {
        // Already freed or invalid handle; nothing to do.
      }
    },
    done: () => {
      for (const entry of pinned) entry.pins -= 1;
      pinned.length = 0;
      borrowed.clear();
      trimSolidCache();
    },
  };
}

/**
 * The pose-and-size fields every per-joint solid reads. Kept as one helper so
 * the three cache keys cannot drift from each other, and deliberately a WHITELIST
 * rather than the whole plan object: a field the solids do not read (the plan's
 * own bookkeeping) would only lower the hit rate.
 */
function jointCacheKeyPart(joint: FlexiJointPlan): unknown {
  return [
    joint.center,
    joint.axis,
    joint.ballRadiusMm,
    joint.socketDepthMm,
    joint.faceGapMm,
  ];
}

/**
 * `JSON.stringify` for a cache key. The replacer exists because plain
 * stringify writes `null` for Infinity, -Infinity AND NaN alike, and the link
 * inputs legitimately carry Infinity (an end joint has no neighbour, so its
 * head or tail room is unbounded). Three different inputs sharing one key would
 * be a silent wrong-solid bug; tagging them keeps the key injective.
 */
function cacheKey(parts: unknown[]): string {
  return JSON.stringify(parts, (_k, value) =>
    typeof value === 'number' && !Number.isFinite(value)
      ? `#${String(value)}`
      : value,
  );
}

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
  options?: FlexiBuildOptions,
): Promise<FlexiBuildOutcome> {
  const garbage: Manifold[] = [];
  const keep = (manifold: Manifold): Manifold => {
    garbage.push(manifold);
    return manifold;
  };
  const quality: FlexiBuildQuality = options?.quality ?? 'final';
  const control = options?.control ?? NEVER_ABORT;
  const prepared = options?.prepared;
  // Both are undone in the `finally`: the profile because it is module state
  // every other build reads, the borrows because a cached solid pinned by a
  // build that has returned would never be evictable again.
  applyResolutionProfile(quality);
  const borrow = createSolidBorrow();

  try {
    // A caller-owned prepared body is used AS IS and never `keep`ed: the
    // garbage sweep below would free a manifold the caller still holds for its
    // next build.
    const base: BaseManifold | null = prepared
      ? { manifold: prepared.manifold, repaired: prepared.repaired }
      : await buildBaseManifold(wasm, meshInput, keep);
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
    let strongFallbackJoints = 0;
    let strongTravelClampedJoints = 0;
    let strongMinTravelDeg = settings.bendAngleDeg;
    let linkFallbackJoints = 0;
    let linkFallbackReasons: FlexiLinkNotes['fallbackReasons'] = {
      mechanism: 0,
      body: 0,
      neighbours: 0,
      boolean: 0,
    };
    let linkTravelClampedJoints = 0;
    let linkMinTravelDeg = settings.bendAngleDeg;
    let linkMaxTravelDeg = 0;
    let linkSidewaysClampedJoints = 0;
    let linkMinSidewaysDeg = Infinity;

    // Exhaustive over FlexiJointStyle, the same `switch` + `assertNever` shape
    // the plan uses at its six dispatch sites. A chained `else` here would send
    // a future fifth style silently down the rounded path and build the wrong
    // thing; this way the compiler flags the omission and, if one is ever
    // constructed at runtime, the build reports a failure instead of lying.
    if (cutJoints.length === 0) {
      segments = [[base.manifold]];
    } else {
      switch (jointStyle) {
        case 'strong': {
          // A top-level arm, NOT a branch inside buildRoundedSegments: the
          // strong joint has no rounded gap angles (whose null return would
          // abort the whole build) and its own male solid has to survive past
          // the subtract chain, so it owns its loop scaffold.
          const notes = {
            strongFallbackJoints: 0,
            travelClampedJoints: 0,
            minTravelDeg: settings.bendAngleDeg,
          };
          const grouped = await buildStrongSegments(
            wasm,
            keep,
            borrow,
            control,
            quality,
            base.manifold,
            cutJoints,
            meshInput,
            clearance,
            settings.bendAngleDeg,
            notes,
          );
          if (grouped === 'aborted') return { status: 'aborted' };
          if (grouped === 'uncut') {
            return {
              status: 'error',
              code: 'rounded-uncut',
              message:
                'The strong joints could not fully separate this model (usually a strong off-axis feature crossing a cut). Try the Classic joint style.',
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
          strongFallbackJoints = notes.strongFallbackJoints;
          strongTravelClampedJoints = notes.travelClampedJoints;
          strongMinTravelDeg = notes.minTravelDeg;
          break;
        }
        case 'link': {
          // A top-level arm for the same reason `strong` is one, plus one more:
          // link adds TWO male solids per joint (the hoop and the ring) and so
          // owns two orphan guards of its own.
          const notes: FlexiLinkNotes = {
            linkFallbackJoints: 0,
            fallbackReasons: {
              mechanism: 0,
              body: 0,
              neighbours: 0,
              boolean: 0,
            },
            travelClampedJoints: 0,
            minTravelDeg: settings.bendAngleDeg,
            maxTravelDeg: 0,
            sidewaysClampedJoints: 0,
            minSidewaysDeg: Infinity,
          };
          const grouped = await buildLinkSegments(
            wasm,
            keep,
            borrow,
            control,
            quality,
            base.manifold,
            cutJoints,
            meshInput,
            clearance,
            settings.bendAngleDeg,
            resolveLinkTuning(settings),
            notes,
          );
          if (grouped === 'aborted') return { status: 'aborted' };
          if (grouped === 'uncut') {
            return {
              status: 'error',
              code: 'rounded-uncut',
              message:
                'The link joints could not fully separate this model — try fewer joints or a simpler shape.',
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
          linkFallbackJoints = notes.linkFallbackJoints;
          linkFallbackReasons = notes.fallbackReasons;
          linkTravelClampedJoints = notes.travelClampedJoints;
          linkMinTravelDeg = notes.minTravelDeg;
          linkMaxTravelDeg = notes.maxTravelDeg;
          linkSidewaysClampedJoints = notes.sidewaysClampedJoints;
          linkMinSidewaysDeg = notes.minSidewaysDeg;
          break;
        }
        case 'classic': {
          const pieces = await buildClassicSegments(
            wasm,
            keep,
            control,
            base.manifold,
            cutJoints,
            clearance,
          );
          if (pieces === 'aborted') return { status: 'aborted' };
          if (!pieces) {
            return {
              status: 'error',
              code: 'compute-failed',
              message: 'The flexi toy could not be built from this model.',
            };
          }
          segments = pieces.map((piece) => [piece]);
          break;
        }
        case 'shell':
        case 'rounded': {
          const notes = { shellFallbackJoints: 0 };
          const grouped = await buildRoundedSegments(
            wasm,
            keep,
            borrow,
            control,
            quality,
            base.manifold,
            cutJoints,
            meshInput,
            clearance,
            settings.bendAngleDeg,
            jointStyle,
            notes,
          );
          if (grouped === 'aborted') return { status: 'aborted' };
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
          break;
        }
        default:
          return assertNever(jointStyle, 'buildFlexiToy joint style');
      }
    }

    const assembled = assemblePieces(segments, meshInput, prepared?.colorGrid);

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
    if (strongFallbackJoints > 0) {
      warnings.push({
        code: 'strong-joint-fallback',
        message:
          strongFallbackJoints === 1
            ? 'One joint was too small for a strong hinge and uses a rounded groove instead.'
            : `${strongFallbackJoints} joints were too small for strong hinges and use rounded grooves instead.`,
      });
    }
    // Reducing a strong joint's travel is a legitimate trade (the alternative is
    // a cut that does not separate), but it must never be SILENT: the user asked
    // for a bend angle and got less. One aggregated line, like the fallbacks.
    if (strongTravelClampedJoints > 0) {
      const rounded = Math.round(strongMinTravelDeg);
      warnings.push({
        code: 'strong-travel-reduced',
        message:
          strongTravelClampedJoints === 1
            ? `One joint bends about ${rounded}° instead of ${settings.bendAngleDeg}° so its cut still separates cleanly.`
            : `${strongTravelClampedJoints} joints bend about ${rounded}° instead of ${settings.bendAngleDeg}° so their cuts still separate cleanly.`,
      });
    }
    // A link joint can abandon its mechanism for four quite different reasons,
    // and the remedy differs in each. "Too small" was the only line this ever
    // said, and it is FALSE on a 400mm fish whose joint balls are 4.7–7.2mm —
    // the user was told to enlarge joints that were already too large for the
    // room they had. The dominant reason wins; ties break in declaration order.
    //
    // 'mechanism' says "too small" because the solver's refusal is only ever
    // reachable from BELOW here: the plan hands the build a radius it has
    // already shrunk into the feasible interval, which is now unbounded above
    // (see `solveLinkJointGeometry`) — `sizeJoint` only ever shrinks, so a
    // too-BIG radius cannot arrive here.
    //
    // Body width is already converted into axial spacing by the Link footprint,
    // so fallbacks name the concrete local failure: mechanism, thin skin,
    // neighbour truncation, or boolean failure.
    if (linkFallbackJoints > 0) {
      const reasons = linkFallbackReasons;
      const dominant = (
        ['mechanism', 'body', 'neighbours', 'boolean'] as const
      ).reduce((best, key) => (reasons[key] > reasons[best] ? key : best));
      const one = linkFallbackJoints === 1;
      const count = one ? 'One joint' : `${linkFallbackJoints} joints`;
      const verb = one ? 'uses' : 'use';
      const groove = one ? 'a rounded groove' : 'rounded grooves';
      warnings.push({
        code: 'link-joint-fallback',
        message: ((): string => {
          switch (dominant) {
            case 'mechanism':
              return `${count} ${one ? 'is' : 'are'} too small for a link hinge and ${verb} ${groove} instead. Try a larger Joint size, or fewer segments.`;
            case 'body':
              return `${count} ${one ? 'sits' : 'sit'} where the model is too thin for the link ring and ${verb} ${groove} instead. Try a smaller Joint size, or a longer toy.`;
            // Singular gets its OWN sentence rather than a pluralised template:
            // "One joint is too close together for link hinges" is the kind of
            // line that reads as a bug even when the geometry behind it is right.
            case 'neighbours':
              return one
                ? `One joint is too close to its neighbour for a link hinge and uses a rounded groove instead. Try fewer segments.`
                : `${linkFallbackJoints} joints are too close together for link hinges and use rounded grooves instead. Try fewer segments.`;
            case 'boolean':
              return `${count} could not be cut as a link hinge on this shape and ${verb} ${groove} instead.`;
            default:
              return assertNever(dominant, 'link fallback reason');
          }
        })(),
      });
    }
    // A joint can still lose travel when its local skin or neighbouring cuts do
    // not leave enough axial room. That must never be silent: this line names the
    // delivered range and gives the spacing remedies. "up and down" is retained
    // because it really is the pitch
    // angle: the carved key caps the sideways sweep at LINK_SECONDARY_MAX_DEG
    // independently of this, which the style's own documentation states.
    //
    if (linkTravelClampedJoints > 0) {
      const low = linkMinTravelDeg.toFixed(1);
      const high = linkMaxTravelDeg.toFixed(1);
      const span =
        linkTravelClampedJoints === 1 || low === high ? low : `${low}–${high}`;
      const liveJointCount = plan.joints.filter((joint) => !joint.fused).length;
      const subject =
        linkTravelClampedJoints === 1
          ? `One of ${liveJointCount} joints bends`
          : `${linkTravelClampedJoints} of ${liveJointCount} joints bend`;
      warnings.push({
        code: 'link-travel-reduced',
        message: `${subject} about ${span}° up and down instead of ${settings.bendAngleDeg}° — there is no room here for a bigger ring gap. Try fewer segments, or a smaller Joint size.`,
      });
    }
    // UNREACHABLE BY CONSTRUCTION, and deliberately kept — see the emit-site
    // comment in `buildLinkSegments` and plan probe L-SEC. A conical kerf reads
    // the radius and nothing else, so it is direction-free and cannot fall short
    // sideways; `secondaryTravelDeg` and `secondaryTargetDeg` are the same
    // expression. What DOES limit sideways travel is the carved key
    // (`LINK_SECONDARY_MAX_DEG`), which is a deliberate mechanism decision the
    // style documents rather than a shortfall to warn about — so this line must
    // never blame the BODY. It survives so that a future direction-dependent
    // kerf cannot reintroduce the silent 3.3°-against-a-5°-slider defect.
    if (linkSidewaysClampedJoints > 0 && Number.isFinite(linkMinSidewaysDeg)) {
      const rounded = Math.round(linkMinSidewaysDeg);
      warnings.push({
        code: 'link-sideways-reduced',
        message:
          linkSidewaysClampedJoints === 1
            ? `One joint only twists about ${rounded}° side to side — the ring gap closes before the joint does.`
            : `${linkSidewaysClampedJoints} joints only twist about ${rounded}° side to side — the ring gap closes before the joints do.`,
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
    // Unpin first: the trim inside `done()` is what actually evicts, and it
    // must not run while this build's handles are still borrowed.
    borrow.done();
    applyResolutionProfile('final');
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

/**
 * Build the base body ONCE, for a caller that will run many builds against it.
 * Same direct → weld → ITK ladder `buildBaseManifold` uses, plus the colour grid
 * — both are O(vertices) and neither depends on the settings, so re-paying them
 * on every slider tweak is pure waste (25–270ms of base construction and, on a
 * dense body, the larger share of assembly).
 *
 * The CALLER owns the returned manifold: `buildFlexiToy` neither deletes it nor
 * registers it in its garbage sweep. Free it with `disposeFlexiPreparedBody`.
 * Returns null when the mesh cannot be made manifold (the caller reports the
 * same 'not-watertight' error `buildFlexiToy` would have).
 */
export async function prepareFlexiBody(
  wasm: ManifoldToplevel,
  meshInput: FlexiMeshInput,
): Promise<FlexiPreparedBody | null> {
  // An identity `keep`: the ladder only ever hands `keep` the ONE manifold it
  // returns (every failed attempt is deleted inside `tryManifoldFromProperties`),
  // so there is nothing here to sweep and the survivor belongs to the caller.
  const base = await buildBaseManifold(wasm, meshInput, (manifold) => manifold);
  if (!base) return null;
  return {
    manifold: base.manifold,
    repaired: base.repaired,
    // From the FULL-resolution coloured input, always: a preview body shares
    // this grid, so colours must never be sampled from a simplified mesh.
    colorGrid: buildColorGrid(meshInput),
  };
}

/** Free a prepared body's manifold. Safe to call twice. */
export function disposeFlexiPreparedBody(body: FlexiPreparedBody): void {
  try {
    body.manifold.delete();
  } catch {
    // Already freed or invalid handle; nothing to do.
  }
}

/**
 * Derive a cheap preview body from a full one by decimating it to `toleranceMm`
 * (measured: 128k tris → 16.5k at 0.05mm in ~130ms, 15k → 4.5k), and rebuild the
 * `FlexiMeshInput` that goes with it — the plan's cross-section samplers and the
 * build's own band measurements read the mesh, not the manifold, so handing
 * `buildFlexiToy` the ORIGINAL input beside a simplified body would measure one
 * shape and cut another.
 *
 * The returned body owns its manifold (dispose it) but SHARES `full.colorGrid`,
 * which is why the preview's per-vertex colours are still the full-resolution
 * ones. Returns null if the decimation fails or collapses the body.
 *
 * `_wasm` completes the `(wasm, …)` shape every other entry point takes;
 * `simplify` is a method on the manifold itself, so nothing here needs it.
 */
export function deriveFlexiPreviewBody(
  _wasm: ManifoldToplevel,
  full: FlexiPreparedBody,
  toleranceMm: number,
): { body: FlexiPreparedBody; meshInput: FlexiMeshInput } | null {
  let simplified: Manifold | null = null;
  try {
    simplified = full.manifold.simplify(toleranceMm);
    if (simplified.status() !== 'NoError' || simplified.isEmpty()) {
      simplified.delete();
      return null;
    }
    const mesh = simplified.getMesh();
    const numProp = mesh.numProp;
    const vertexCount = Math.floor(mesh.vertProperties.length / numProp);
    if (vertexCount === 0 || mesh.triVerts.length === 0) {
      simplified.delete();
      return null;
    }
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    for (let v = 0; v < vertexCount; v += 1) {
      const x = mesh.vertProperties[v * numProp];
      const y = mesh.vertProperties[v * numProp + 1];
      const z = mesh.vertProperties[v * numProp + 2];
      positions[v * 3] = x;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = z;
      full.colorGrid.fillNearest(x, y, z, colors, v * 3);
    }
    return {
      body: {
        manifold: simplified,
        repaired: full.repaired,
        colorGrid: full.colorGrid,
      },
      meshInput: {
        positions,
        indices: new Uint32Array(mesh.triVerts),
        colors,
      },
    };
  } catch {
    if (simplified) {
      try {
        simplified.delete();
      } catch {
        // Already freed or invalid handle; nothing to do.
      }
    }
    return null;
  }
}

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

/**
 * Concatenate the component meshes into one buffer set.
 *
 * Two passes over PRE-SIZED typed arrays rather than one pass pushing onto
 * `number[]`: at 100k+ output triangles the JS arrays were the whole cost here
 * (three boxed doubles per vertex, an index push per triangle corner, then a
 * full copy into the Float32Array). `getMesh()` is called exactly ONCE per
 * component — it copies out of wasm memory, so a counting pass that called it
 * again would cost more than it saved.
 *
 * `colorGrid` is the prepared body's grid when there is one; without it the grid
 * is built here from `meshInput`, exactly as before.
 */
function assemblePieces(
  segments: Manifold[][],
  meshInput: FlexiMeshInput,
  colorGrid?: FlexiColorGrid,
): AssembledGeometry {
  const grid = colorGrid ?? buildColorGrid(meshInput);
  const meshes = segments.map((components) =>
    components.map((component) => component.getMesh()),
  );

  let totalVertices = 0;
  let totalIndices = 0;
  for (const group of meshes) {
    for (const mesh of group) {
      totalVertices += mesh.vertProperties.length / mesh.numProp;
      totalIndices += mesh.triVerts.length;
    }
  }

  const positionArray = new Float32Array(totalVertices * 3);
  const indexArray = new Uint32Array(totalIndices);
  const segmentTriangleRanges: Array<{ start: number; count: number }> = [];

  let vertexCursor = 0;
  let indexCursor = 0;
  let minY = Infinity;
  for (const group of meshes) {
    // One triangle range per SEGMENT — its components are concatenated so the UI
    // can tint a fin sliver together with the piece it belongs to.
    const start = indexCursor;
    for (const mesh of group) {
      const numProp = mesh.numProp;
      const vertexOffset = vertexCursor;
      const vertexCount = mesh.vertProperties.length / numProp;

      for (let v = 0; v < vertexCount; v += 1) {
        const at = (vertexOffset + v) * 3;
        const y = mesh.vertProperties[v * numProp + 1];
        positionArray[at] = mesh.vertProperties[v * numProp];
        positionArray[at + 1] = y;
        positionArray[at + 2] = mesh.vertProperties[v * numProp + 2];
        if (y < minY) minY = y;
      }
      vertexCursor += vertexCount;

      for (let i = 0; i < mesh.triVerts.length; i += 1) {
        indexArray[indexCursor + i] = mesh.triVerts[i] + vertexOffset;
      }
      indexCursor += mesh.triVerts.length;
    }
    segmentTriangleRanges.push({ start, count: indexCursor - start });
  }

  // Per-vertex colour by nearest input vertex (carries the body's colours onto
  // cut and ball faces without routing colour through the boolean ops).
  // BEFORE the floor shift, because the grid is indexed in the input's own
  // (unshifted) space.
  const colors = new Float32Array(positionArray.length);
  for (let v = 0; v < totalVertices; v += 1) {
    grid.fillNearest(
      positionArray[v * 3],
      positionArray[v * 3 + 1],
      positionArray[v * 3 + 2],
      colors,
      v * 3,
    );
  }

  // Floor-align: min-Y to 0.
  const shift = Number.isFinite(minY) ? minY : 0;
  if (shift !== 0) {
    for (let i = 1; i < positionArray.length; i += 3) {
      positionArray[i] -= shift;
    }
  }

  return {
    positions: positionArray,
    indices: indexArray,
    colors,
    segmentTriangleRanges,
  };
}

// --- Classic segments (round-2 plane-trim + ball/socket) -------------------

// Cut the body into segments with flat ring faces: trim each end plane, subtract
// the tail socket cavity, add the head ball. Returns one manifold per segment,
// or null on a degenerate/empty piece.
async function buildClassicSegments(
  wasm: ManifoldToplevel,
  keep: (manifold: Manifold) => Manifold,
  control: FlexiBuildControl,
  body: Manifold,
  cutJoints: FlexiJointPlan[],
  clearance: number,
): Promise<Manifold[] | 'aborted' | null> {
  const pieceCount = cutJoints.length + 1;
  const pieces: Manifold[] = [];
  for (let p = 0; p < pieceCount; p += 1) {
    // Nothing transient to free: every intermediate here is `keep`ed, so the
    // caller's garbage sweep collects them on the abort path too.
    if (await control.checkpoint()) return 'aborted';
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
async function buildRoundedSegments(
  wasm: ManifoldToplevel,
  keep: (manifold: Manifold) => Manifold,
  borrow: SolidBorrow,
  control: FlexiBuildControl,
  quality: FlexiBuildQuality,
  body: Manifold,
  cutJoints: FlexiJointPlan[],
  meshInput: FlexiMeshInput,
  clearance: number,
  bendAngleDeg: number,
  jointStyle: FlexiJointStyle = 'rounded',
  notes: { shellFallbackJoints: number } = { shellFallbackJoints: 0 },
): Promise<Manifold[][] | 'uncut' | 'aborted' | null> {
  // Sequential subtract, freeing each intermediate immediately so a 19-joint
  // body doesn't pile up full-body copies (only the running cut is retained).
  let cut = body;
  for (const joint of cutJoints) {
    // The only transient at the top of an iteration is the running cut.
    if (await control.checkpoint()) {
      if (cut !== body) cut.delete();
      return 'aborted';
    }
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
    // The cutter is a pure function of the pose, the clearance, the solved
    // angles and the solved wedge/shell (plus the loft's radial map) — nothing
    // about the body reaches past the solve — so an identical solve yields an
    // identical solid and the cache can return the previous build's.
    const cutterKey = (shape: unknown, loft?: ShellLoft | null): string =>
      cacheKey([
        'rounded',
        jointStyle,
        quality,
        jointCacheKeyPart(joint),
        clearance,
        angles,
        shape,
        loft ?? null,
      ]);
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
          const key = cutterKey(lofted, loft);
          const cached = borrow.take(key);
          if (cached) {
            cutter = cached[0];
          } else {
            cutter = buildShellCutter(
              wasm,
              joint,
              clearance,
              angles,
              lofted,
              loft,
            );
            // Never cache a null: a refusal is cheap to re-derive and caching it
            // would pin a "this cannot be built" verdict past a code change.
            if (cutter) borrow.store(key, [cutter]);
          }
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
          const key = cutterKey(shell);
          const cached = borrow.take(key);
          if (cached) {
            cutter = cached[0];
          } else {
            cutter = buildShellCutter(wasm, joint, clearance, angles, shell);
            if (cutter) borrow.store(key, [cutter]);
          }
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
      const key = cutterKey(wedge);
      const cached = borrow.take(key);
      if (cached) {
        cutter = cached[0];
      } else {
        cutter = buildRoundedCutter(wasm, joint, clearance, angles, wedge);
        if (cutter) borrow.store(key, [cutter]);
      }
    }
    if (!cutter) {
      if (cut !== body) cut.delete();
      return null;
    }
    const next = cut.subtract(cutter);
    // A cached cutter is BORROWED — `release` deletes only handles this loop
    // owns. (`subtract` does not consume its argument either way.)
    borrow.release(cutter);
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
    const solid = section.revolve(RES.cutterRevolveSegments);
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

// --- Strong ("strong joints") segments --------------------------------------

// Sampled radii used by the reach probes and the dense-station clamp.
const STRONG_REACH_SAMPLES = 48;
// Number of travel steps the dense-station clamp walks down before giving up
// on the strong joint and handing it to the rounded cutter.
const STRONG_CLAMP_STEPS = 8;
// Half-thickness of the two seed slabs the tapered throat slot is hulled from.
const STRONG_SLOT_SEED_MM = 0.05;
// How far past the head segment's tail face the slot's outer seed sits. The
// headward end sits on the PIVOT plane (s = 0) — never past it, or it would
// notch the cavity's nose wall and kill the push-in stop.
const STRONG_SLOT_OUTSET_MM = 0.5;
// Mirror of the plan's OVERLAP_MARGIN_MM — the clear space two adjacent joints'
// solids must keep between them (the plan cannot be a build dependency).
const STRONG_OVERLAP_MARGIN_MM = 0.5;
// The seam band's reach is only measured over the OUTER part of the section
// (from this fraction of the widest local extent out to it) — that is where two
// neighbouring bands could jointly shave a feature.
const STRONG_BAND_REACH_INNER_FRACTION = 0.6;
// Adaptive seam-profile sampling: the radial probe used to estimate the local
// angular rate, the floor on a radial step, and the hard trip count.
const STRONG_SEAM_PROBE_MM = 0.05;
const STRONG_SEAM_MIN_STEP_MM = 0.05;
const STRONG_SEAM_MAX_STEPS = 400;
// Absolute ceiling on that walk. Past it the seam is not sampled at all and the
// joint takes the rounded fallback — a wedge this large belongs to a body no
// strong joint was scaled for.
const STRONG_SEAM_MAX_STEPS_HARD = 1200;
// Bisection depth of the rise-slope solve. (The gap between the two seam faces
// is MEASURED at the same angle-bounded radii the cutter polygon is built from
// — see strongSeamCurves — so the solve sees the geometry that actually ships.)
const STRONG_SLOPE_STEPS = 14;
// A tail-face point this close to the axis carries no material worth speaking
// of (the revolve of a sub-millimetre radius), so it is not counted when the
// wedge's reach into a neighbouring joint is measured.
const STRONG_REACH_RHO_GATE_MM = 0.5;

// --- The VISIBLE gap -------------------------------------------------------
//
// This style's whole point is that you SEE the joint. Keeping the running
// clearance is not enough for that: the clearance is a NORMAL separation, and
// the seam faces are steeply inclined cones, so the axial void a printed part
// actually reads is a different (much smaller) number. Left to the clearance
// fit alone the seam collapses to a hairline — measured 0.5mm on the standard
// spindle, narrower than the classic and rounded styles on the same settings
// and a fifth of the reference toy's.
//
// Reference grounding (tmp/axo-dissection.md §5.3, §11): adjacent segment skins
// stand 2.21–2.27mm apart printed, on a body ~26mm across at those joints, at
// ±12° of yaw travel. The physical maximum a revolved wedge can open at
// cylindrical radius `rho` is `rho·Δθ` (flat faces, no ramp) = 3.46mm there, so
// the reference spends this share of the available angle on the visible gap and
// the rest on contouring. Targeting the same share makes the gap scale with the
// local cross-section AND grow with the bend angle, since Δθ is
// `bend + overlap + a clearance term`.
const STRONG_VISIBLE_GAP_SHARE = 0.65;
// Where the gap is judged: just inside the narrowest local skin radius, i.e.
// inside the silhouette all the way round — where the eye reads the seam, and
// where the build suite's probe measures it.
const STRONG_VISIBLE_PROBE_FRACTION = 0.85;
// Floor and ceiling on the target. The floor stops a small joint reading as a
// hairline; the ceiling stops a fat body spending its whole segment pitch on
// air.
const STRONG_VISIBLE_GAP_MIN_MM = 0.9;
const STRONG_VISIBLE_GAP_MAX_MM = 3.5;
// The target never asks for more than this share of the physical maximum, so
// the flattest seam the profile allows (slope 0) always clears it and the
// bisection cannot chase an unreachable number.
const STRONG_VISIBLE_HEADROOM = 0.85;
// Bisection depths for the visible-gap slope fit and for the radius-at-rho
// solve it is measured through.
const STRONG_VISIBLE_SLOPE_STEPS = 16;
const STRONG_VISIBLE_RADIUS_STEPS = 28;
// Opening the seam costs AXIAL room, and a dense or pinned cut may have none.
// The gap is cosmetic and the travel is not, so the target is walked down these
// scales first — all the way back to 0, the narrow clearance-only seam — and
// only then is the travel touched.
const STRONG_VISIBLE_SCALES = [1, 0.6, 0.3, 0];
// Passes of the seam's outer-radius fixed point (see `settleOuterRadius`).
const STRONG_OUTER_PASSES = 6;
// Slack on top of the running clearance between a joint's bar root and the gem
// of the joint behind it, so the pair keeps its preset with room for the
// spheres' faceting and for a spine that curves between the two pivots.
const STRONG_BAR_CLEAR_MM = 0.3;

/**
 * The strong seam: a revolved wedge between two profile curves about the joint
 * centre whose PER-RADIUS angular gap is ≥ bend + 3° everywhere (law 1), so the
 * seam never limits the swing at any body width — no millimetre face gap is
 * involved and `FLEXI_MAX_FACE_GAP_MM` never clips it. (What DOES set the first
 * contact is the bar in its slot and the ball in its pocket: measured
 * bend + 2.6° … + 5°.) The ramp slope is then eased back until the seam reads
 * as an open gap at the skin — see the visible-gap constants above.
 */
type StrongSeamProfile = {
  /** Head segment's tail face on the axis, at s = −faceOffset. */
  faceOffset: number;
  /** Radius where the head face leaves the flat land and starts to ramp. */
  r1: number;
  /** Outer radius (past the skin along the wedge's exit direction). */
  r3: number;
  /** Travel + seam overlap, radians. */
  gap: number;
  /** Rise slope dθ/dR of the ramp branch, rad/mm. */
  slope: number;
  clearance: number;
  /** Ceiling on the head face angle (π/2 + gap/2). */
  thetaCap: number;
  /** Head face angle at r1 (the acos branch's end). */
  headAtR1: number;
  /** How deep the bar buries itself in the tail segment (s, negative). */
  bladeRoot: number;
};

// Head face angle at radius R: the flat land plane s = −faceOffset near the
// axis (so the seam can never cut into the socket), then a ramp toward the cut
// plane so the visible band is centred on the station at the skin.
//
// The ramp is taken as a MAX against the plane, never a plain replacement. A
// ramp gentler than the plane's own rise (which happens on a fat body, where r2
// is far out) would let the head face dip TAILWARD of the land, wrapping head
// material around the bar beyond the throat slot's reach — the bar then fuses to
// the head segment and the cut silently fails to sever. Clamping to the plane
// also keeps the face's tail-most depth exactly faceOffset, which is what the
// slot is sized to clear. On the plane branch the normal gap between the two
// faces works out to exactly rho·gap + clearance, so this never tightens travel.
function strongHeadAngle(seam: StrongSeamProfile, radius: number): number {
  const plane = Math.acos(
    Math.min(1, seam.faceOffset / Math.max(radius, 1e-9)),
  );
  if (radius <= seam.r1) {
    return plane;
  }
  const ramp = Math.min(
    seam.thetaCap,
    seam.headAtR1 + seam.slope * (radius - seam.r1),
  );
  return Math.max(plane, ramp);
}

// Angular gap between the two faces at radius R: the travel + seam overlap,
// plus a term worth a full clearance of ARC at the head face's own cylindrical
// radius, so the two faces are never closer than the clearance anywhere they
// actually face each other. Extra angle only widens the gap, so travel (which
// needs gap ≥ bend, not = bend) is unaffected.
function strongGapAngle(seam: StrongSeamProfile, radius: number): number {
  const head = strongHeadAngle(seam, radius);
  const rho = Math.max(STRONG_SEAM_EPS_MILLIMETRES, radius * Math.sin(head));
  return (
    seam.gap + Math.min(STRONG_SEAM_EXTRA_MAX_RADIANS, seam.clearance / rho)
  );
}

function strongTailAngle(seam: StrongSeamProfile, radius: number): number {
  return Math.max(
    0,
    strongHeadAngle(seam, radius) - strongGapAngle(seam, radius),
  );
}

// Axial reach of the seam BAND on each side of the cut plane, over the OUTER
// radii only (cylindrical radius in [rhoLo, rhoHi]). That is the reach two
// neighbouring joints could jointly use to shave a wide feature between them —
// exactly what the rounded family's capRad clamp bounds. The wedge's deep
// near-axis reach is not measured here: it is the land + anchor, which the
// asymmetric footprint check budgets separately.
function strongSeamBandReach(
  seam: StrongSeamProfile,
  rhoLo: number,
  rhoHi: number,
): { head: number; tail: number } {
  let head = 0;
  let tail = 0;
  for (let i = 0; i <= STRONG_REACH_SAMPLES; i += 1) {
    const radius =
      seam.faceOffset +
      ((seam.r3 - seam.faceOffset) * i) / STRONG_REACH_SAMPLES;
    const thetaHead = strongHeadAngle(seam, radius);
    const rhoHead = radius * Math.sin(thetaHead);
    if (rhoHead >= rhoLo && rhoHead <= rhoHi) {
      head = Math.max(head, -radius * Math.cos(thetaHead));
    }
    const thetaTail = strongTailAngle(seam, radius);
    const rhoTail = radius * Math.sin(thetaTail);
    if (rhoTail >= rhoLo && rhoTail <= rhoHi) {
      tail = Math.max(tail, radius * Math.cos(thetaTail));
    }
  }
  return { head, tail };
}

// The two seam faces sampled as (ρ, s) polylines, with each vertex flagged
// `live` when the two segments actually face each other there. Inside the
// slot's own footprint they do not: near the axis the head face IS the slot's
// interior, and what the tail side sees there is the slot wall (a separate,
// already-budgeted clearance), not the head face.
type StrongSeamCurves = {
  head: { rho: number; s: number; live: boolean }[];
  tail: { rho: number; s: number; live: boolean }[];
};

function strongSeamCurves(
  seam: StrongSeamProfile,
  geometry: StrongJointGeometry,
  rMax: number,
): StrongSeamCurves | null {
  // Sample at EXACTLY the radii the cutter polygon is built from (angle-bounded
  // by CUTTER_ARC_STEP_DEG), so what is measured here is the gap of the solid
  // that actually gets built.
  //
  // Sampling uniformly in radius instead — which is what shipped — silently
  // fails whenever the ramp is steep relative to the span being sampled. The
  // ramp climbs the whole way from headAtR1 to thetaCap inside r2 − r1 (0.75 mm
  // when the body's own min extent is small next to the joint), while the outer
  // sampling span runs out to ~1.15·maxExtent. On an eccentric body those are
  // wildly different scales: at r = 10.17 on a bulged spindle (min extent 13.2,
  // max extent 34.2) a 64-step uniform walk lands ~0.4 mm apart and puts barely
  // one vertex on a 0.75 mm ramp. The chords then bear no relation to the real
  // faces and the measured gap came back 0.730 mm where the built seam is
  // 0.262 mm — so fitSlope kept the full slope ceiling and the printed joint
  // shipped at 48 % of the requested clearance with no warning.
  //
  // At the ceiling the two faces are nearly concentric arcs (R·dθ/dR ≈ 26), so
  // their separation is ≈ Δθ / slope and barely moves with the clearance preset
  // — which is why raising the preset did not help either.
  const radii = strongSeamRadii(seam, Math.max(seam.r1 + 0.5, rMax));
  if (!radii) return null;
  const gateBase = Math.min(geometry.throatBaseHalfMm, geometry.slotBaseHalfMm);
  const sample = (
    angleAt: (s: StrongSeamProfile, radius: number) => number,
  ): { rho: number; s: number; live: boolean }[] =>
    radii.map((radius) => {
      const theta = angleAt(seam, radius);
      const rho = radius * Math.sin(theta);
      const s = -radius * Math.cos(theta);
      const gate = gateBase + geometry.throatTaper * Math.max(0, -s);
      return { rho, s, live: rho >= gate };
    });
  return { head: sample(strongHeadAngle), tail: sample(strongTailAngle) };
}

function pointSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len > 1e-18 ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Smallest surface-to-surface separation between the two seam faces, over the
// radii where both actually carry material.
//
// This REPLACES the shipped single-radius `slopeCap`. That cap set the law-3
// normal gap to exactly the clearance at r1 and assumed the faces stayed
// parallel — but the head face has a slope KINK at r1 (plane branch → ramp) and
// Δθ(R) shrinks with radius, so the true minimum lands just OUTSIDE r1 and dips
// below the requested preset (measured: 0.432 mm against a 0.55 mm preset).
function strongSeamGap(
  seam: StrongSeamProfile,
  geometry: StrongJointGeometry,
  rMax: number,
): number {
  const curves = strongSeamCurves(seam, geometry, rMax);
  // Unsamplable seam ⇒ report zero clearance, so the slope fit backs off
  // instead of trusting a cutter it could not measure.
  if (!curves) return 0;
  const { head, tail } = curves;
  let best = Infinity;
  const scan = (
    from: { rho: number; s: number; live: boolean }[],
    to: { rho: number; s: number; live: boolean }[],
  ): void => {
    for (const p of from) {
      if (!p.live) continue;
      for (let i = 1; i < to.length; i += 1) {
        const a = to[i - 1];
        const b = to[i];
        if (!a.live || !b.live) continue;
        const d = pointSegmentDistance(p.rho, p.s, a.rho, a.s, b.rho, b.s);
        if (d < best) best = d;
      }
    }
  };
  scan(head, tail);
  scan(tail, head);
  return best;
}

// Radius R at which a seam face reaches cylindrical radius `rho`. Both faces
// are monotone in rho — θ only ever climbs with R, and never past `thetaCap`,
// whose sine is still ≈ 0.99 — so a bisection is exact. The faces are treated
// as mathematical curves here (extended past r3 if need be); whether the built
// wedge actually reaches the skin is the separate severance question the
// caller checks.
function strongFaceRadiusAt(
  seam: StrongSeamProfile,
  rho: number,
  angleAt: (s: StrongSeamProfile, radius: number) => number,
): number {
  const rhoAt = (radius: number): number =>
    radius * Math.sin(angleAt(seam, radius));
  let lo = seam.faceOffset;
  let hi = Math.max(lo + 1, 2 * (rho + seam.faceOffset));
  for (let i = 0; i < 8 && rhoAt(hi) < rho; i += 1) hi *= 2;
  for (let i = 0; i < STRONG_VISIBLE_RADIUS_STEPS; i += 1) {
    const mid = (lo + hi) / 2;
    if (rhoAt(mid) < rho) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// The AXIAL void between the two seam faces at cylindrical radius `rho` — what
// a printed part reads as "the gap between the segments", and what the build
// suite's visible-gap probe measures. Monotone decreasing in the ramp slope
// (steeper faces trade axial void for normal clearance), which is what licenses
// the bisection in `solveStrongSeam`.
function strongVisibleGap(seam: StrongSeamProfile, rho: number): number {
  const depth = (
    angleAt: (s: StrongSeamProfile, radius: number) => number,
  ): number => {
    const radius = strongFaceRadiusAt(seam, rho, angleAt);
    return -radius * Math.cos(angleAt(seam, radius));
  };
  return depth(strongHeadAngle) - depth(strongTailAngle);
}

// How wide the seam should READ at the probe radius (see the constants above).
// `scale` is the caller's degradation knob: 1 asks for the full reference-share
// gap, 0 asks for nothing and leaves the clearance-only seam alone.
function strongVisibleTarget(
  seam: StrongSeamProfile,
  rho: number,
  scale: number,
): number {
  if (!(rho > 0) || !(scale > 0)) return 0;
  // The head face's own cylindrical radius at the probe IS rho, so this is
  // exactly `strongGapAngle` there — without needing to solve for the radius.
  const delta =
    seam.gap +
    Math.min(
      STRONG_SEAM_EXTRA_MAX_RADIANS,
      seam.clearance / Math.max(STRONG_SEAM_EPS_MILLIMETRES, rho),
    );
  const full = rho * delta;
  const wanted = Math.min(
    STRONG_VISIBLE_GAP_MAX_MM,
    Math.max(STRONG_VISIBLE_GAP_MIN_MM, STRONG_VISIBLE_GAP_SHARE * full),
  );
  return scale * Math.min(wanted, STRONG_VISIBLE_HEADROOM * full);
}

// Deepest the tail face reaches on the tail side, counting only radii where it
// carries real cylindrical radius. The wedge's near-axis stretch sits at ρ = 0
// (θ_tail is clamped at 0 there) and removes nothing when revolved, so it must
// not be allowed to dominate the neighbour clamp.
function strongTailReach(
  seam: StrongSeamProfile,
  rMax: number,
  rhoGate: number,
): number {
  let reach = 0;
  for (let i = 0; i <= STRONG_REACH_SAMPLES; i += 1) {
    const radius =
      seam.faceOffset + ((rMax - seam.faceOffset) * i) / STRONG_REACH_SAMPLES;
    const theta = strongTailAngle(seam, radius);
    if (radius * Math.sin(theta) < rhoGate) continue;
    const depth = radius * Math.cos(theta);
    if (depth > reach) reach = depth;
  }
  return reach;
}

// Solve the seam profile for one joint. The outer radius uses the SAME 4-pass
// fixed point as solveRoundedWedge: a body flaring steeply next to the cut can
// otherwise outgrow a one-pass band, the cut fails to sever and the build has
// to report 'uncut'.
function solveStrongSeam(
  geometry: StrongJointGeometry,
  joint: FlexiJointPlan,
  clearance: number,
  bendAngleDeg: number,
  measure: FlexiSectionSampler,
  planeExtents: { minMm: number; maxMm: number },
  maxTailReachMm: number,
  visibleScale: number,
): StrongSeamProfile {
  const gap = ((bendAngleDeg + STRONG_SEAM_OVERLAP_DEGREES) * Math.PI) / 180;
  const faceOffset = geometry.faceOffsetMm;
  const r1 = faceOffset + STRONG_SEAM_INNER_PAD_MILLIMETRES;
  const thetaCap = Math.PI / 2 + gap / 2;
  const headAtR1 = Math.acos(Math.min(1, faceOffset / r1));
  const seam: StrongSeamProfile = {
    faceOffset,
    r1,
    r3: r1 + 2,
    gap,
    slope: 0,
    clearance,
    thetaCap,
    headAtR1,
    bladeRoot: -faceOffset,
  };

  // Ceiling 1 — the LAND PLATE must survive. Head material inside R ≤ r1 is
  // exactly {s ≥ −faceOffset}; past r1 the ramp lifts the face headward and eats
  // into the plate from the outside. The plate is only attached to the head
  // segment if it reaches radially PAST the cavity, so require head material at
  // the cavity's tail plane out to the cavity's own lateral extent plus a wall.
  // A ramp steeper than this pinches the plate off between the cavity, the slot
  // and the seam, and the orphan survives decompose() as a stray sliver body
  // (measured: 4 extra bodies at jointScale 1.4 + bend 25° on a fat spindle).
  //
  // acos(cavityAx/R) is concave, and the ramp is a straight line starting BELOW
  // it at r1, so pinning the line at R_plate keeps it below over the whole span.
  //
  // Read the pocket's OWN lateral reach at that plane rather than assuming it
  // is a slab. The flat-rear gem's pocket flared to `r + c` sideways — well past
  // the seam's inner radius — which is what let the ramp isolate a sliver. The
  // concentric ball pocket closes to a point at its tail plane and sits entirely
  // inside `faceOffset`, so nothing the ramp does can reach it and this ceiling
  // correctly self-disables. Hard-coding the old slab reach here instead throttled
  // the ramp so hard that every short-fat build at jointScale 1.4 came back
  // 'rounded-uncut' while classic, rounded and shell all severed.
  const plateRho =
    strongCavityHalfWidthAt(geometry, geometry.cavityAxMm) +
    FLEXI_MIN_SOCKET_WALL_MM;
  const plateR = Math.hypot(geometry.cavityAxMm, plateRho);
  const plateSlope =
    plateR > r1 + 1e-6
      ? Math.max(0, Math.atan2(plateRho, geometry.cavityAxMm) - headAtR1) /
        (plateR - r1)
      : Infinity;
  // Ceiling 2 — the rise only has to reach the cut-plane band by the groove
  // floor radius; climbing faster buys nothing and only steepens the seam.
  const r2 = Math.max(r1 + 0.75, GROOVE_FLOOR_FACTOR * planeExtents.minMm);
  const rampSlope = (thetaCap - headAtR1) / Math.max(0.01, r2 - r1);
  const slopeCeiling = Math.min(plateSlope, rampSlope);

  // Ceiling 3 — the printed gap. Solved by MEASURING the face-to-face distance
  // (see strongSeamGap) and bisecting the slope down until it clears the
  // requested clearance, rather than trusting a closed form at one radius.
  const gapProbeRadius = Math.max(
    r1 + 2,
    GROOVE_OUT_FACTOR * planeExtents.maxMm + joint.faceGapMm,
  );
  const fitSlope = (probeRadius: number): number => {
    seam.slope = slopeCeiling;
    if (strongSeamGap(seam, geometry, probeRadius) >= clearance) {
      return slopeCeiling;
    }
    let lo = 0;
    let hi = slopeCeiling;
    for (let i = 0; i < STRONG_SLOPE_STEPS; i += 1) {
      const mid = (lo + hi) / 2;
      seam.slope = mid;
      if (strongSeamGap(seam, geometry, probeRadius) >= clearance) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  seam.slope = fitSlope(gapProbeRadius);

  // Ceiling 4 — the VISIBLE gap. `fitSlope` returns the STEEPEST slope the
  // running clearance allows, and at that slope the two faces are near
  // concentric arcs: their NORMAL separation is the clearance, but the AXIAL
  // void the eye reads is only about `clearance / cos θ`. Ease the slope back
  // until the seam reads as the open gap this style promises.
  //
  // Lowering the slope only ever WIDENS both separations, so the clearance
  // floor, law 1 (travel needs Δθ ≥ bend, and Δθ is untouched here) and the
  // containment proof are all monotone-safe. What it costs is axial room — a
  // flatter head face stays near the land plane further out, so the band
  // reaches deeper on the tail side — which is why the caller walks
  // `visibleScale` down before it ever touches the travel.
  const rhoVisible = STRONG_VISIBLE_PROBE_FRACTION * planeExtents.minMm;
  const openSeam = (): void => {
    const target = strongVisibleTarget(seam, rhoVisible, visibleScale);
    if (!(target > 0) || strongVisibleGap(seam, rhoVisible) >= target) return;
    let lo = 0;
    let hi = seam.slope;
    for (let i = 0; i < STRONG_VISIBLE_SLOPE_STEPS; i += 1) {
      const mid = (lo + hi) / 2;
      seam.slope = mid;
      if (strongVisibleGap(seam, rhoVisible) >= target) lo = mid;
      else hi = mid;
    }
    seam.slope = lo;
  };
  openSeam();

  const outerBase = GROOVE_OUT_FACTOR * planeExtents.maxMm + joint.faceGapMm;
  // A shallower face exits the skin at a shallower angle, so the outer radius
  // has to be settled AFTER every slope decision or the wedge stops short of
  // the skin and the cut silently fails to sever.
  // The iteration takes the RUNNING MAXIMUM rather than the last value. The
  // band half-width it samples the body over is `r3·cos θ_tail`, so a shallow
  // exit angle pulls in a much wider slice of a tapering body, which demands a
  // bigger r3, which steepens the exit, which shrinks the slice again: plain
  // substitution oscillates and lands wherever pass 4 happens to leave it
  // (measured on the standard spindle at the opened seam: 12.88 against the
  // 14.6 the cut actually needed, so the wedge sealed inside the body and the
  // joint fell back). Growing only is safe — past the skin the wedge removes
  // nothing — and the neighbour clamp below is what bounds it from above.
  const settleOuterRadius = (): void => {
    seam.r3 = Math.max(r1 + 2, outerBase);
    for (let pass = 0; pass < STRONG_OUTER_PASSES; pass += 1) {
      const bandHalfWidth =
        seam.r3 * Math.cos(strongTailAngle(seam, seam.r3)) + 2;
      const bandExtents = measure(bandHalfWidth);
      const exit = Math.max(0.05, strongTailAngle(seam, seam.r3));
      const next = Math.max(
        r1 + 2,
        GROOVE_OUT_FACTOR * Math.max(planeExtents.maxMm, bandExtents.maxMm) +
          joint.faceGapMm,
        (1.05 * bandExtents.maxMm) / Math.sin(exit),
      );
      if (next <= seam.r3 + 0.25) break;
      seam.r3 = next;
    }
  };
  settleOuterRadius();
  // Re-fit the slope against the settled outer radius (the gap's tight spot can
  // sit outside the first probe radius on a body that flares next to the cut).
  // Only ever a reduction, so the visible target stays met. `fitSlope` leaves
  // `seam.slope` on its last bisection probe, so the pre-refit value has to be
  // captured before it is called.
  const opened = seam.slope;
  const refit = Math.min(opened, fitSlope(seam.r3));
  seam.slope = refit;
  if (refit < opened) settleOuterRadius();

  // Never let the wedge reach into a neighbouring joint's cavity. Measure the
  // tail face's ACTUAL axial reach rather than reading cos(θ_tail) at r3 through
  // a 0.2 floor: on the near-90° plane branch that floor caps r3 at 5× the
  // neighbour budget, the wedge lands short of a flattened body's widest radius
  // and the cut silently fails to sever ('rounded-uncut' on inputs the other
  // three styles all build).
  if (Number.isFinite(maxTailReachMm)) {
    const floorR3 = Math.max(r1 + 2, faceOffset + 0.5);
    if (
      strongTailReach(seam, seam.r3, STRONG_REACH_RHO_GATE_MM) > maxTailReachMm
    ) {
      let lo = floorR3;
      let hi = Math.max(floorR3, seam.r3);
      for (let i = 0; i < 12; i += 1) {
        const mid = (lo + hi) / 2;
        if (
          strongTailReach(seam, mid, STRONG_REACH_RHO_GATE_MM) > maxTailReachMm
        ) {
          hi = mid;
        } else {
          lo = mid;
        }
      }
      seam.r3 = Math.max(floorR3, lo);
    }
  }

  // How deep the bar must go to fuse to the tail segment: the tail face at the
  // bar's own cylindrical radius, plus the anchor. Four iterations, converging
  // monotonically from the land plane outward; the anchor covers the residual,
  // and probe S6 verifies the bar actually landed on the tail side.
  const rhoBlade = Math.hypot(geometry.bladeHalfMm, geometry.bladeHeightHalfMm);
  let s = -faceOffset;
  for (let i = 0; i < 4; i += 1) {
    const radius = Math.hypot(rhoBlade, s);
    s = Math.min(
      -faceOffset,
      -radius * Math.cos(strongTailAngle(seam, radius)),
    );
  }
  seam.bladeRoot = s - strongAnchorMm(joint.ballRadiusMm);
  return seam;
}

// Radii the two seam faces are sampled at, chosen so NO chord ever spans more
// than CUTTER_ARC_STEP_DEG of either face.
//
// The inner branch is parameterised by ANGLE (its dθ/dR is unbounded at the
// apex). The outer branch steps by radius, but each step is sized from the
// LOCAL angular rate of both faces: a uniform radial sampling is not enough,
// because the ramp can climb 30°+ per millimetre just past r1 and then sit flat
// at its cap. A chord across that knee falls INSIDE the true face, and on a
// slim body it can miss the skin altogether — the cut then silently fails to
// sever and the build has to report 'uncut'.
//
// The step budget is ADAPTIVE, and running out of it is a hard failure rather
// than something to paper over. Every step is at least STRONG_SEAM_MIN_STEP_MM,
// so `span / minStep` steps always suffice; a fixed 400 only covered a 20mm
// span, and past that the walk stopped short and one long chord was pushed
// straight to rOuter — a chord that can fall inside the true face and, on a
// slim body, miss the skin entirely, which shows up as a silent
// 'rounded-uncut'. Returning null instead routes the joint to the per-joint
// rounded fallback (with its 'strong-joint-fallback' warning), and makes the
// measured seam gap 0 so the slope fit backs off rather than trusting a
// cutter it could not sample.
function strongSeamRadii(
  seam: StrongSeamProfile,
  rOuter: number = seam.r3,
): number[] | null {
  const stepRad = (CUTTER_ARC_STEP_DEG * Math.PI) / 180;
  const radii: number[] = [];
  const innerSteps = Math.max(2, Math.ceil(seam.headAtR1 / stepRad));
  for (let i = 0; i <= innerSteps; i += 1) {
    const theta = (seam.headAtR1 * i) / innerSteps;
    radii.push(seam.faceOffset / Math.cos(theta));
  }
  radii[radii.length - 1] = seam.r1;

  const budget = Math.min(
    STRONG_SEAM_MAX_STEPS_HARD,
    Math.max(
      STRONG_SEAM_MAX_STEPS,
      Math.ceil((rOuter - seam.r1) / STRONG_SEAM_MIN_STEP_MM) + 16,
    ),
  );
  let radius = seam.r1;
  let guard = 0;
  for (; guard < budget && radius < rOuter - 1e-9; guard += 1) {
    const probe = Math.min(rOuter, radius + STRONG_SEAM_PROBE_MM);
    const span = probe - radius;
    const rate =
      span > 1e-9
        ? Math.max(
            Math.abs(
              strongHeadAngle(seam, probe) - strongHeadAngle(seam, radius),
            ),
            Math.abs(
              strongTailAngle(seam, probe) - strongTailAngle(seam, radius),
            ),
          ) / span
        : 0;
    const step =
      rate > 1e-6
        ? Math.max(STRONG_SEAM_MIN_STEP_MM, stepRad / rate)
        : rOuter - radius;
    radius = Math.min(rOuter, radius + Math.max(step, STRONG_SEAM_MIN_STEP_MM));
    radii.push(radius);
  }
  if (radius < rOuter - 1e-9) return null;
  if (radii[radii.length - 1] < rOuter) radii.push(rOuter);
  return radii;
}

// Closed CCW profile polygon of the seam wedge, in (ρ, s).
function strongSeamPolygon(seam: StrongSeamProfile): number[][] {
  const stepRad = (CUTTER_ARC_STEP_DEG * Math.PI) / 180;
  const point = (radius: number, theta: number): number[] => [
    radius * Math.sin(theta),
    -radius * Math.cos(theta),
  ];
  const radii = strongSeamRadii(seam);
  if (!radii) return [];

  const polygon: number[][] = [];
  const push = (p: number[]): void => {
    const last = polygon[polygon.length - 1];
    if (
      last &&
      Math.abs(last[0] - p[0]) < 1e-9 &&
      Math.abs(last[1] - p[1]) < 1e-9
    ) {
      return;
    }
    polygon.push(p);
  };
  for (const radius of radii) {
    push(point(radius, strongHeadAngle(seam, radius)));
  }
  const thetaHeadOut = strongHeadAngle(seam, seam.r3);
  const thetaTailOut = strongTailAngle(seam, seam.r3);
  const arcSteps = Math.max(
    1,
    Math.ceil((thetaHeadOut - thetaTailOut) / stepRad),
  );
  for (let i = 1; i < arcSteps; i += 1) {
    push(
      point(
        seam.r3,
        thetaHeadOut + ((thetaTailOut - thetaHeadOut) * i) / arcSteps,
      ),
    );
  }
  for (let i = radii.length - 1; i >= 0; i -= 1) {
    const radius = radii[i];
    push(point(radius, strongTailAngle(seam, radius)));
  }
  // Drop a duplicated closing vertex (the apex is shared by both faces).
  const first = polygon[0];
  const last = polygon[polygon.length - 1];
  if (
    polygon.length > 2 &&
    Math.abs(first[0] - last[0]) < 1e-9 &&
    Math.abs(first[1] - last[1]) < 1e-9
  ) {
    polygon.pop();
  }
  for (const p of polygon) {
    if (p[0] < 0) p[0] = 0;
  }
  fixWinding(polygon);
  return polygon;
}

// Three-part cutter (native axis +Z = joint axis, +Y = frame e1, ±X = frame e2):
// the revolved seam wedge, the concentric spherical pocket, and the tapered
// throat slot through the land.
function buildStrongCutter(
  wasm: ManifoldToplevel,
  joint: FlexiJointPlan,
  geometry: StrongJointGeometry,
  seam: StrongSeamProfile,
): Manifold | null {
  const { CrossSection, Manifold: ManifoldClass } = wasm;
  const polygon = strongSeamPolygon(seam);
  if (polygon.length < 3) return null;

  const section = new CrossSection(polygon as [number, number][]);
  const seamSolid = section.revolve(RES.shellRevolveSegments);
  section.delete();

  // The pocket is a ball CONCENTRIC with the head, so a bend about the pivot
  // slides the two surfaces over each other at a constant gap (law 2) and no
  // swept-envelope budget is needed at all. It is inflated because manifold's
  // geodesic sphere inscribes its facets and the pocket must be a superset.
  const cavity = ManifoldClass.sphere(
    geometry.cavityRadiusMm * STRONG_SPHERE_INFLATION,
    STRONG_SPHERE_SEGMENTS,
  );

  // The slot runs from the PIVOT plane (not from just inside the cavity's tail
  // wall) out past the head segment's tail face, and each seed is sized by the
  // affine envelope AT ITS OWN DEPTH so the hull is exactly
  // `base + taper·depth` everywhere.
  //
  // Anchoring it at the pivot is what makes the joint reach its full travel on
  // an oblique bend: the pocket is sized for the swept HEAD and knows nothing
  // about the bar, so wherever the bar leaves the pocket its own swept envelope
  // has to be carved (measured on the earlier faceted pocket: up to 0.83 mm of
  // interference at bend 25°, costing ~3.4° of travel at a 45° bend azimuth).
  const slotOuterDepth = geometry.faceOffsetMm + STRONG_SLOT_OUTSET_MM;
  const innerSeed = ManifoldClass.cube(
    [
      2 * geometry.throatBaseHalfMm,
      2 * geometry.slotBaseHalfMm,
      STRONG_SLOT_SEED_MM,
    ],
    true,
  );
  const innerAt = innerSeed.translate([0, 0, 0]);
  innerSeed.delete();
  const outerSeed = ManifoldClass.cube(
    [
      2 * (geometry.throatBaseHalfMm + geometry.throatTaper * slotOuterDepth),
      2 * (geometry.slotBaseHalfMm + geometry.throatTaper * slotOuterDepth),
      STRONG_SLOT_SEED_MM,
    ],
    true,
  );
  const outerAt = outerSeed.translate([0, 0, -slotOuterDepth]);
  outerSeed.delete();
  const slot = ManifoldClass.hull([innerAt, outerAt]);
  innerAt.delete();
  outerAt.delete();

  const withCavity = seamSolid.add(cavity);
  seamSolid.delete();
  cavity.delete();
  const cutter = withCavity.add(slot);
  withCavity.delete();
  slot.delete();
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

// The male: a spherical bearing head at the pivot plus the rectangular bar that
// crosses the visible gap into the tail segment. The head is left INSCRIBED in
// its ideal ball (manifold's geodesic sphere puts its vertices on the sphere),
// which only ever widens the running clearance — the conservative direction.
function buildStrongMale(
  wasm: ManifoldToplevel,
  joint: FlexiJointPlan,
  geometry: StrongJointGeometry,
  seam: StrongSeamProfile,
): Manifold | null {
  const { Manifold: ManifoldClass } = wasm;
  const gem = ManifoldClass.sphere(
    geometry.headRadiusMm,
    STRONG_SPHERE_SEGMENTS,
  );

  // The bar runs from just past the pivot (well inside the head, so the union is
  // solid) out to its anchor in the tail segment.
  const barHead = STRONG_GEM_UNION_OVERLAP_MILLIMETRES;
  const barLength = barHead - seam.bladeRoot;
  if (!(barLength > 0)) {
    gem.delete();
    return null;
  }
  const barBox = ManifoldClass.cube(
    [2 * geometry.bladeHalfMm, 2 * geometry.bladeHeightHalfMm, barLength],
    true,
  );
  const bar = barBox.translate([0, 0, (barHead + seam.bladeRoot) / 2]);
  barBox.delete();
  const male = gem.add(bar);
  gem.delete();
  bar.delete();
  if (male.status() !== 'NoError' || male.isEmpty()) {
    male.delete();
    return null;
  }
  const oriented = male.transform(orientationMatrix(joint.axis, joint.center));
  male.delete();
  return oriented;
}

// Per-joint rounded fallback (§8), SHARED by every style that has its own male
// solid (strong and link): identical to the plain-rounded path in
// buildRoundedSegments, including BOTH its dense-station travel clamp and its
// 4-pass outer-radius fixed point. It is entirely style-agnostic — it reads only
// `joint.socketDepthMm` and `joint.faceGapMm`, and both strong and link leave
// those exactly as rounded needs them — and it always has room because
// `minSegmentLengthFor` is at least the rounded floor for both.
//
// The clamp is not optional here: the only thing that sends a joint down this
// path is a station too dense for the style's own solid, which is precisely the
// case where two neighbouring bands would otherwise jointly shave a wide
// feature. Both callers must therefore pass their OWN `maxTailReach` and
// `minNeighborDist` — dropping either lets the fallback wedge reach into the
// neighbour that sent the joint here in the first place.
function buildRoundedFallbackCutter(
  wasm: ManifoldToplevel,
  joint: FlexiJointPlan,
  clearance: number,
  bendAngleDeg: number,
  measure: FlexiSectionSampler,
  planeExtents: { minMm: number; maxMm: number },
  maxTailReach: number,
  minNeighborDist: number,
): Manifold | null {
  let angles = roundedGapAngles(joint, clearance, bendAngleDeg);
  if (!angles) return null;
  if (Number.isFinite(minNeighborDist)) {
    const outEstimate =
      GROOVE_OUT_FACTOR * planeExtents.maxMm + joint.faceGapMm;
    const halfWidthEstimate =
      outEstimate * Math.sin(angles.gapAngle / 2 + SHELL_OVERLAP_RAD) + 2;
    const bandMax = Math.max(
      planeExtents.maxMm,
      measure(halfWidthEstimate).maxMm,
    );
    const budget = Math.max(0.05, (minNeighborDist - GAP_BAND_KEEP_MM) / 2);
    const capDeg =
      ((2 * Math.atan2(budget, bandMax) - SHELL_OVERLAP_RAD) * 180) / Math.PI;
    if (capDeg < bendAngleDeg) {
      const capped = roundedGapAngles(joint, clearance, Math.max(1, capDeg));
      if (capped) angles = capped;
    }
  }
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
  return buildRoundedCutter(wasm, joint, clearance, angles, wedge);
}

// Subtract one strong cutter per live joint, then add every joint's male solid
// back in ONE whole-body union, decompose, and group components into segment
// intervals exactly as the rounded family does. The male fuses to its TAIL
// segment (its bar is anchored there), so bodies == segments still holds.
async function buildStrongSegments(
  wasm: ManifoldToplevel,
  keep: (manifold: Manifold) => Manifold,
  borrow: SolidBorrow,
  control: FlexiBuildControl,
  quality: FlexiBuildQuality,
  body: Manifold,
  cutJoints: FlexiJointPlan[],
  meshInput: FlexiMeshInput,
  clearance: number,
  bendAngleDeg: number,
  notes: {
    strongFallbackJoints: number;
    travelClampedJoints: number;
    minTravelDeg: number;
  },
): Promise<Manifold[][] | 'uncut' | 'aborted' | null> {
  let cut = body;
  const males: Manifold[] = [];
  // The running cut plus every male still waiting for the final union — the
  // full transient set at any point in the loop. `release` skips borrowed cache
  // handles, so a male that came from the cache is dropped, not freed.
  const freeTransient = (): void => {
    if (cut !== body) cut.delete();
    for (const male of males) borrow.release(male);
  };
  const abandon = (): null => {
    freeTransient();
    return null;
  };

  for (let index = 0; index < cutJoints.length; index += 1) {
    if (await control.checkpoint()) {
      freeTransient();
      return 'aborted';
    }
    const joint = cutJoints[index];
    // One profile pass per joint; every later query is a bin scan.
    const measure = crossSectionExtentsSampler(
      meshInput.positions,
      joint.center,
      joint.axis,
    );
    const planeExtents = measure();
    if (!(planeExtents.maxMm > 0)) {
      return abandon();
    }

    let maxTailReach = Infinity;
    let minNeighborDist = Infinity;
    for (const other of [cutJoints[index - 1], cutJoints[index + 1]]) {
      if (!other) continue;
      const dx = other.center[0] - joint.center[0];
      const dy = other.center[1] - joint.center[1];
      const dz = other.center[2] - joint.center[2];
      const distance = Math.hypot(dx, dy, dz);
      // What the neighbour needs kept clear is its own AXIAL footprint (the
      // closed cavity plus a wall), not the rounded family's cup RADIUS: the
      // strong cavity is wide (r + c) but short (≈0.6·r), so borrowing the
      // lateral figure over-reserves by several millimetres and stops the wedge
      // short of a fat body's skin.
      const otherGeometry = solveStrongJointGeometry(
        other.ballRadiusMm,
        clearance,
        bendAngleDeg,
      );
      const otherReach = otherGeometry
        ? otherGeometry.cavityAxMm + FLEXI_MIN_SOCKET_WALL_MM
        : other.ballRadiusMm + clearance + FLEXI_MIN_SOCKET_WALL_MM;
      maxTailReach = Math.min(maxTailReach, distance - otherReach - 1);
      minNeighborDist = Math.min(minNeighborDist, distance);
    }

    // How deep this joint's BAR may root before it runs into the previous
    // joint's gem. The bar anchors in the tail segment at the seam's own tail
    // face, so it gets deeper as the seam opens — and the gem of the joint
    // behind sits on ITS pivot, a whole ball radius proud on this side, owned
    // by the segment BEFORE this one. Two adjacent mechanisms therefore have to
    // share the pitch, which nothing else budgets: the solid-footprint check
    // below reserves `faceOffset + anchor` tailward, but the real root is the
    // tail FACE at the bar's radius, which the opened seam pushes well past
    // that. Measured without this: bar root 14.9mm back against a 22.2mm pitch
    // with a 7.23mm gem behind it, leaving 0.07mm where the preset asked 0.40.
    const behind = cutJoints[index - 1];
    const barBudget = behind
      ? Math.hypot(
          behind.center[0] - joint.center[0],
          behind.center[1] - joint.center[1],
          behind.center[2] - joint.center[2],
        ) -
        behind.ballRadiusMm -
        clearance -
        STRONG_BAR_CLEAR_MM
      : Infinity;

    // Dense-station clamp: dragged cuts can sit tighter than any plan floor, so
    // walk the travel down until this joint fits its neighbours. Two separate
    // budgets, because the strong joint's footprint is ASYMMETRIC:
    //  · the SOLID footprint (pocket + wall headward, land + bar anchor
    //    tailward) — the same expression minSegmentLengthFor('strong') budgets,
    //    checked against the WHOLE neighbour distance. The pocket is a
    //    concentric ball sized by the radius and clearance ALONE, so this
    //    budget does not move with the bend angle: it is a straight
    //    fits/does-not-fit decision, hoisted out of the travel walk below
    //    rather than re-tested at every step it cannot change.
    //  · the seam BAND at the widest feature is checked against HALF the pitch
    //    minus a keep slab, mirroring the rounded family's capRad, because both
    //    neighbours claim their own half there. This one DOES move with the
    //    bend, and is what the walk exists for (together with the predictive
    //    severance check).
    // The VISIBLE-gap target is walked down INSIDE each travel step, because a
    // narrower seam is a cosmetic loss and a shorter swing is a functional one:
    // a joint whose band budget cannot afford the open gap degrades to the
    // narrow clearance-only seam at full travel rather than the other way
    // round, and only falls back to the rounded cutter if even that will not
    // fit. If even 1° does not fit, hand the joint to the rounded cutter (whose
    // own capRad clamp then takes over).
    const footprintGeometry = solveStrongJointGeometry(
      joint.ballRadiusMm,
      clearance,
      bendAngleDeg,
    );
    const solidFootprint = footprintGeometry
      ? footprintGeometry.cavityAxMm +
        FLEXI_MIN_SOCKET_WALL_MM +
        footprintGeometry.faceOffsetMm +
        strongAnchorMm(joint.ballRadiusMm) +
        STRONG_OVERLAP_MARGIN_MM
      : Infinity;
    const footprintFits =
      footprintGeometry !== null &&
      (!Number.isFinite(minNeighborDist) || solidFootprint <= minNeighborDist);
    const bandBudget = Number.isFinite(minNeighborDist)
      ? Math.max(0.05, (minNeighborDist - GAP_BAND_KEEP_MM) / 2)
      : Infinity;
    const bandMax = Number.isFinite(bandBudget)
      ? Math.max(planeExtents.maxMm, measure(bandBudget + 2).maxMm)
      : planeExtents.maxMm;

    let solved: {
      geometry: StrongJointGeometry;
      seam: StrongSeamProfile;
      travelDeg: number;
    } | null = null;
    for (let step = 0; footprintFits && step < STRONG_CLAMP_STEPS; step += 1) {
      const travelDeg =
        bendAngleDeg - ((bendAngleDeg - 1) * step) / (STRONG_CLAMP_STEPS - 1);
      if (travelDeg < 1) break;
      const stepGeometry = solveStrongJointGeometry(
        joint.ballRadiusMm,
        clearance,
        travelDeg,
      );
      if (!stepGeometry) break;
      for (const visibleScale of STRONG_VISIBLE_SCALES) {
        const seam = solveStrongSeam(
          stepGeometry,
          joint,
          clearance,
          travelDeg,
          measure,
          planeExtents,
          maxTailReach,
          visibleScale,
        );
        if (Number.isFinite(bandBudget)) {
          const reach = strongSeamBandReach(
            seam,
            STRONG_BAND_REACH_INNER_FRACTION * bandMax,
            bandMax,
          );
          if (Math.max(reach.head, reach.tail) > bandBudget) continue;
        }
        // Predictive severance check: both seam faces must clear the skin over
        // the band the wedge actually crosses. When the neighbour clamp has
        // held the outer radius in, the wedge seals inside the body, the cut
        // does not separate and the build can only report the hard
        // 'rounded-uncut' error. Narrowing the seam (and ultimately dropping
        // the travel, and ultimately falling back to the rounded cutter) is a
        // far better answer than a dead end.
        const exitAngle = strongTailAngle(seam, seam.r3);
        const skin = measure(seam.r3 * Math.cos(exitAngle) + 2).maxMm;
        const faceReach = Math.min(
          seam.r3 * Math.sin(strongHeadAngle(seam, seam.r3)),
          seam.r3 * Math.sin(exitAngle),
        );
        if (faceReach < skin) continue;
        if (-seam.bladeRoot > barBudget) continue;
        solved = { geometry: stepGeometry, seam, travelDeg };
        break;
      }
      if (solved) break;
    }
    // A joint built below the requested bend still articulates, but it does NOT
    // deliver what the user asked for. Record it so the caller can say so —
    // probe S2's `bendAngleDeg + STRONG_SEAM_OVERLAP_DEG` cushion hides
    // reductions up to 3°, so a silent clamp here is invisible to every test.
    if (solved && solved.travelDeg < bendAngleDeg - 1e-9) {
      notes.travelClampedJoints += 1;
      notes.minTravelDeg = Math.min(notes.minTravelDeg, solved.travelDeg);
    }

    let cutter: Manifold | null = null;
    let male: Manifold | null = null;
    if (solved) {
      // Both solids are pure functions of the pose, the solved geometry and the
      // solved seam, so they are cached as ONE entry: they are always wanted
      // together and a half-hit would be useless.
      const key = cacheKey([
        'strong',
        quality,
        jointCacheKeyPart(joint),
        solved.geometry,
        solved.seam,
      ]);
      const cached = borrow.take(key);
      if (cached) {
        cutter = cached[0];
        male = cached[1];
      } else {
        cutter = buildStrongCutter(wasm, joint, solved.geometry, solved.seam);
        if (cutter) {
          male = buildStrongMale(wasm, joint, solved.geometry, solved.seam);
        }
        if (!cutter || !male) {
          // Freshly built and never stored, so a plain delete is right here.
          if (cutter) cutter.delete();
          if (male) male.delete();
          cutter = null;
          male = null;
        } else {
          borrow.store(key, [cutter, male]);
        }
      }
    }
    if (!cutter) {
      notes.strongFallbackJoints += 1;
      cutter = buildRoundedFallbackCutter(
        wasm,
        joint,
        clearance,
        bendAngleDeg,
        measure,
        planeExtents,
        maxTailReach,
        minNeighborDist,
      );
    }
    if (!cutter) {
      return abandon();
    }

    const next = cut.subtract(cutter);
    // Borrowed when it came from the cache, owned when the rounded fallback
    // built it — `release` tells them apart.
    borrow.release(cutter);
    if (cut !== body) cut.delete();
    cut = next;
    if (male) males.push(male);
  }

  // ORPHANED-MALE GUARD. A male is only a joint if its bar reaches live tail
  // material; if the seam failed to sever, the bar's anchor can land in the void
  // the wedge carved and the head drops out of the print as a LOOSE PART. The
  // severance guard below cannot see this — an orphan is its own component and
  // lands in some segment group, so every group stays non-empty and the build
  // reports 'ok'. Measured on the torus fixture (a closed loop no vertical cut
  // can sever): three free males, ~617–714mm³ each, sitting on their pivots.
  //
  // Checked against the FINAL cut solid, not the intermediate one: a later
  // joint's cutter can still remove an earlier male's anchor. Costs one boolean
  // per joint against an already-evaluated tree.
  for (const male of males) {
    const anchored = male.intersect(cut);
    const orphan = anchored.isEmpty();
    anchored.delete();
    if (orphan) {
      freeTransient();
      return 'uncut';
    }
  }

  // ORDER MATTERS: the pocket is by construction a superset of the head's swept
  // envelope, so the males can only be added AFTER the whole subtract chain.
  // One whole-body union for the entire build, not one per joint.
  if (males.length > 0) {
    let union = males[0];
    for (let i = 1; i < males.length; i += 1) {
      const merged = union.add(males[i]);
      // `union` is males[0] (possibly borrowed) on the first pass and an owned
      // intermediate after that; `release` covers both.
      borrow.release(union);
      borrow.release(males[i]);
      union = merged;
    }
    const joined = cut.add(union);
    borrow.release(union);
    if (cut !== body) cut.delete();
    cut = joined;
  }

  // Manifold booleans are lazy — one status check evaluates the whole tree.
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

  const segmentCount = cutJoints.length + 1;
  const groups: Manifold[][] = Array.from({ length: segmentCount }, () => []);
  for (const component of components) {
    const centroid = componentVolumeCentroid(component);
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
  if (groups.some((group) => group.length === 0)) {
    return 'uncut';
  }
  return groups;
}

/**
 * Why a link joint abandoned its mechanism, counted at the point of abandonment
 * so the warning can name a remedy the user can act on. Ties break in the order
 * listed here.
 */
export type FlexiLinkFallbackReason =
  /** The solver refused this radius outright, or the hoop cannot engage. */
  | 'mechanism'
  /** The body is too thin here for the ring (g1 clip gates g2/g3). */
  | 'body'
  /** The neighbouring joints leave no room (g4, g6). */
  | 'neighbours'
  /** Every solid solved and the booleans still failed. */
  | 'boolean';

export type FlexiLinkNotes = {
  linkFallbackJoints: number;
  fallbackReasons: Record<FlexiLinkFallbackReason, number>;
  travelClampedJoints: number;
  minTravelDeg: number;
  maxTravelDeg: number;
  sidewaysClampedJoints: number;
  minSidewaysDeg: number;
};

// Subtract one link cutter per live joint, then add every joint's TWO male
// solids (hoop and ring) back in ONE whole-body union, decompose, and group
// components into segment intervals. A top-level arm rather than a branch inside
// buildRoundedSegments for the same reasons `strong` is one, plus one more: link
// adds two males per joint and so needs two orphan guards of its own.
async function buildLinkSegments(
  wasm: ManifoldToplevel,
  keep: (manifold: Manifold) => Manifold,
  borrow: SolidBorrow,
  control: FlexiBuildControl,
  quality: FlexiBuildQuality,
  body: Manifold,
  cutJoints: FlexiJointPlan[],
  meshInput: FlexiMeshInput,
  clearance: number,
  bendAngleDeg: number,
  linkTuning: LinkTuning,
  notes: FlexiLinkNotes,
): Promise<Manifold[][] | 'uncut' | 'aborted' | null> {
  let cut = body;
  const males: Manifold[] = [];
  // The running cut plus every hoop/ring still waiting for the final union.
  // `release` skips borrowed cache handles, so a cached male is dropped here
  // rather than freed.
  const freeTransient = (): void => {
    if (cut !== body) cut.delete();
    for (const male of males) borrow.release(male);
  };
  const abandon = (): null => {
    freeTransient();
    return null;
  };

  for (let index = 0; index < cutJoints.length; index += 1) {
    if (await control.checkpoint()) {
      freeTransient();
      return 'aborted';
    }
    const joint = cutJoints[index];
    // ONE profile pass per joint; every later query is a bin scan.
    const measure = crossSectionExtentsSampler(
      meshInput.positions,
      joint.center,
      joint.axis,
    );
    const planeExtents = measure();
    if (!(planeExtents.maxMm > 0)) {
      return abandon();
    }
    const geometry = solveLinkJointGeometry(
      joint.ballRadiusMm,
      clearance,
      bendAngleDeg,
      linkTuning,
    );

    // TWO band passes, and they do different jobs.
    //
    // Band 1 is derived from the CEILING CONSTANT, never from the solved kerf:
    // using an output of the seam solve to define the band it is measured over
    // would be a fixed point with nothing pinning it. `rhoClip` is read off THIS
    // band alone — widening it would loosen the clip on the very fins it exists
    // to keep the hoop clear of.
    //
    // Band 2 exists because a conical kerf at a large radius is thicker than the
    // allowance by design (`k(ρ_max)` at the trout's dorsal fin is 6.6mm against
    // a 4.5mm allowance), so a single 3.25mm band would stop measuring exactly
    // where the cutter still has to punch through. It only ever widens, and the
    // travel is capped so the cutter never asks for more than band 2 measured.
    const band1 = LINK_KERF_ALLOWANCE_MM / 2 + 1;
    const banded1 = measure(band1);
    const rhoClip =
      Math.min(planeExtents.minMm, banded1.minMm) - LINK_CLIP_MARGIN_MM;
    const rho1 = Math.max(planeExtents.maxMm, banded1.maxMm);
    let rhoMax = rho1;
    let requestedTravelDeg = bendAngleDeg;
    if (geometry) {
      const first = solveLinkSeam(geometry, rho1, clearance, bendAngleDeg);
      // Measured at the CUTTER's own rim, not at the skin: that is where the
      // cone is thickest, and it leaves the band room for `rhoMax` to grow on
      // the second scan. Sizing band 2 from `rho1` instead makes the cap below
      // bite by ~0.03° on a finned body — enough to fire a travel warning on a
      // joint that met its request.
      const band2 = Math.max(
        band1,
        linkKerfAtMm(first, first.outerRadiusMm) / 2 + 1,
      );
      if (band2 > band1) {
        rhoMax = Math.max(planeExtents.maxMm, measure(band2).maxMm);
      }
      // Never cut wider than the band that was measured: a cutter thicker than
      // the slab the skin was sampled over could stop short of a fin and leave
      // the cut unsevered.
      //
      // It folds into `topDeg` below, so a joint it clamped would report as a
      // LOOK-CEILING clamp. That is not a mis-attribution in practice: swept
      // over the whole legal box (2.9M cells, r 2.5–80mm × c 0.20–0.80 × bend
      // 5–25 × ρ 0–20000mm) it binds below the ceiling in ZERO of them, because
      // band 2 is itself sized from the cone at the cutter's rim and so grows
      // with the very radius it is divided by. It bites only where band 2's scan
      // finds a radius ≥ 6.9× band 1's — a razor flange beginning just outside
      // the first slab — and there the ceiling clause ("a ring gap wider than
      // this model can hide where the joints cut") is the true sentence anyway.
      const bandCapDeg =
        rhoMax > 1e-9
          ? (2 *
              Math.atan(
                Math.max(0, 2 * (band2 - 1) - clearance) / (2 * rhoMax),
              ) *
              180) /
            Math.PI
          : bendAngleDeg;
      requestedTravelDeg = Math.min(bendAngleDeg, bandCapDeg);
    }

    // Law 7, explicitly. Three link features reach axially, and each gets a
    // named budget checked against the NEIGHBOUR's own solved reach — never
    // against a radius borrowed from another style. Zero extra vertex passes:
    // the neighbour's kerf ceiling is bounded with OUR sampler over a band that
    // already covers the neighbour's station.
    let headRoom = Infinity;
    let tailRoom = Infinity;
    let maxTailReach = Infinity;
    let minNeighborDist = Infinity;
    // The neighbour's own skin radius, kept per side: it bounds BOTH the reserve
    // the neighbour makes and the reach this joint's cone is CHARGED for out
    // there, and the two must be read at the SAME radius or the budget is
    // asymmetric. Deliberately an upper bound rather than the truth: this band is
    // up to a whole neighbour-distance wide, so `rhoNb` can land outside
    // `seam.outerRadiusMm`, where the cutter has no material at all and
    // `linkKerfAtMm` extrapolates the cone past its own rim. That direction is
    // safe (it can only lose travel, never clearance) and it is what keeps the
    // two sides of the budget comparable; clamping it to the rim would be
    // tighter but would make my charge and the neighbour's reserve two different
    // quantities again, which is the asymmetry law 7 exists to close.
    let headNbRho = 0;
    let tailNbRho = 0;
    for (const side of [-1, 1]) {
      const other = cutJoints[index + side];
      if (!other) continue;
      const distance = Math.hypot(
        other.center[0] - joint.center[0],
        other.center[1] - joint.center[1],
        other.center[2] - joint.center[2],
      );
      const otherGeometry = solveLinkJointGeometry(
        other.ballRadiusMm,
        clearance,
        bendAngleDeg,
        linkTuning,
      );
      const rhoNb = measure(distance + 2).maxMm;
      if (side > 0) headNbRho = rhoNb;
      else tailNbRho = rhoNb;
      // Reserve the neighbour's full requested conical gap at its own radius,
      // so this joint cannot carve away space the adjacent link needs. The
      // tail reserve is a MAX of real reaches, mirroring the plan footprint:
      // the knee sits below the LEG kerf (`kneeDepthMm`), not below the rim
      // kerf at the widest fin, so summing the rim kerf with the buried run
      // double-charges at high bends.
      const otherSeam = otherGeometry
        ? solveLinkSeam(otherGeometry, rhoNb, clearance, bendAngleDeg)
        : null;
      const otherKerfMax =
        otherGeometry && otherSeam
          ? linkKerfAtMm(otherSeam, rhoNb)
          : LINK_KERF_ALLOWANCE_MM;
      const otherHead = otherGeometry
        ? otherGeometry.pivotOffsetMm +
          otherGeometry.tubeRadiusMm +
          clearance +
          LINK_SECONDARY_INFLATE_MAX_MM
        : other.ballRadiusMm + clearance;
      const otherTail =
        otherGeometry && otherSeam
          ? Math.max(
              otherKerfMax / 2,
              otherSeam.kneeDepthMm + otherGeometry.anchorMm,
              otherGeometry.bladeReachMm -
                otherGeometry.pivotOffsetMm +
                clearance,
            )
          : other.ballRadiusMm + clearance;
      if (side > 0) {
        headRoom = Math.min(
          headRoom,
          distance - otherTail - LINK_NEIGHBOUR_CLEAR_MM,
        );
      } else {
        tailRoom = Math.min(
          tailRoom,
          distance - otherHead - LINK_NEIGHBOUR_CLEAR_MM,
        );
      }
      maxTailReach = Math.min(
        maxTailReach,
        distance -
          Math.max(otherHead, otherTail) -
          FLEXI_MIN_SOCKET_WALL_MM -
          1,
      );
      minNeighborDist = Math.min(minNeighborDist, distance);
    }

    // The per-joint ladder. ONE axis — the travel — because every gated quantity
    // is monotone in it once the geometry is frozen:
    //   g1 engagement `q + a − legKerf/2`     INCREASES as travel drops
    //   g2 envelope radius (sagitta ∝ 1−cos)  decreases, and so does the knee
    //   g4 both neighbour reaches (k(ρ_nb))   decrease
    // so `feasible` is monotone decreasing and the search below is exact. That
    // is what makes this a genuine relief mechanism rather than a lottery, and
    // why the suite can assert that a dense station degrades by LOSING TRAVEL
    // rather than by falling back. There is deliberately no second (engagement)
    // ladder axis: reducing travel IMPROVES engagement, so the two never
    // conflict.
    //
    // The GRID IS ABSOLUTE. A ladder whose rungs are a fraction of the request
    // (or a bisection of `[1, bend]`) has a grid that moves with `bendAngleDeg`,
    // which makes the delivered travel a SAWTOOTH in the slider — measured 3 and
    // 94 decreases respectively against a gate saturating at 16.2°, and it is
    // why joint 0 of the acceptance body delivered 4.0° at bend 8 but 1.0° at
    // bend 25. On an absolute grid the candidate set only grows with the
    // request, so the delivered travel is non-decreasing: 0 decreases.
    //
    // Two gates are hoisted OUT because nothing in them moves with the travel;
    // leaving them in the loop would spend the whole ladder re-deciding a fixed
    // fact and then report the wrong reason for the fallback.
    //
    // No manifold operation happens in here — this is pure arithmetic over ≤ 15
    // points, the same side of the line the strong ladder stays on.
    let solved: { seam: LinkSeamProfile; poly: LinkHoopPolyline } | null = null;
    let reason: FlexiLinkFallbackReason = 'mechanism';
    if (geometry) {
      // g3 (travel-free) — the WHOLE ring survives the skin clip: a clip
      // cylinder inside the ring's outer radius would shave or sever the loop
      // (the old blade plate only needed the eye ring to survive).
      const ringFits = rhoClip >= geometry.bladeReachMm;
      // g6 (travel-free) — the whole ring must fit in the head-ward room.
      // Shared with the builder (`linkBladeHeadCapMm`) so the gate and the
      // builder's refusal cannot drift.
      const bladeCapFits = linkBladeCapFits(geometry, headRoom);
      const attempt = (
        travelDeg: number,
      ): { seam: LinkSeamProfile; poly: LinkHoopPolyline } | null => {
        const seam = solveLinkSeam(geometry, rhoMax, clearance, travelDeg);
        const poly = linkHoopPolyline(geometry, seam, clearance);
        // Preserve the original extra body-rim overlap in the low-angle range.
        // Above 25°, the intentionally wider gap supplies the requested swing;
        // captivity comes from the two closed, threaded loops instead.
        if (
          bendAngleDeg <= 25 &&
          geometry.pivotOffsetMm + geometry.tubeRadiusMm - seam.legKerfMm / 2 <
            LINK_ENGAGE_MIN_MM
        ) {
          reason = 'mechanism';
          return null;
        }
        // g2 — the skin clip must be a NO-OP on the hoop. The clip is not a
        // sizing device: a clip that actually bites the hoop would leave a
        // knife-edged or severed ring, which every other probe can survive.
        if (linkHoopOuterMm(poly) > rhoClip) {
          reason = 'body';
          return null;
        }
        // g4 — law 7, both directions, each read at ITS OWN neighbour's radius
        // so my reach and the reserve that neighbour made are the same quantity.
        const kerfHead = linkKerfAtMm(seam, headNbRho);
        const kerfTail = linkKerfAtMm(seam, tailNbRho);
        const myHeadReach = Math.max(
          kerfHead / 2,
          geometry.pivotOffsetMm +
            geometry.tubeRadiusMm +
            clearance +
            LINK_SECONDARY_INFLATE_MAX_MM,
        );
        // Same max-form as the reserve above: each term is a real reach (rim
        // cone at the neighbour's radius; knee + buried run; ring's tail
        // crown), and the knee is monotone in the travel so g4 stays monotone.
        const myTailReach = Math.max(
          kerfTail / 2,
          seam.kneeDepthMm + geometry.anchorMm,
          geometry.bladeReachMm - geometry.pivotOffsetMm + clearance,
        );
        if (myHeadReach > headRoom || myTailReach > tailRoom) {
          reason = 'neighbours';
          return null;
        }
        return { seam, poly };
      };
      if (!ringFits) {
        reason = 'body';
      } else if (!bladeCapFits) {
        reason = 'neighbours';
      } else {
        // The top of the range: the request, capped at Link's 90° product limit.
        const top = solveLinkSeam(
          geometry,
          rhoMax,
          clearance,
          requestedTravelDeg,
        ).travelDeg;
        // Defensive for malformed or future settings below the travel floor.
        if (top < LINK_TRAVEL_MIN_DEG) reason = 'boolean';
        // Largest feasible ABSOLUTE grid point ≤ top, by binary search over a
        // monotone predicate — exact rather than a sample. The search itself
        // lives in the plan module beside the grid constants that define it, so
        // the plan suite pins the SHIPPED loop instead of a replica.
        solved = linkTravelSearch(top, attempt);
      }
    }
    if (solved && solved.seam.travelDeg < bendAngleDeg - 1e-9) {
      notes.travelClampedJoints += 1;
      notes.minTravelDeg = Math.min(notes.minTravelDeg, solved.seam.travelDeg);
      notes.maxTravelDeg = Math.max(notes.maxTravelDeg, solved.seam.travelDeg);
    }
    // DEFENSIVE ONLY, and deliberately kept. A kerf that depends on the radius
    // alone is direction-free (see `solveLinkSeam`), so `secondaryTravelDeg` and
    // `secondaryTargetDeg` are the same expression and this can never fire —
    // which is a property of the LAW, proven and pinned by a plan probe, not of
    // the fixtures. Deleting the site would mean a future direction-dependent
    // kerf reintroduced the silent 3.34°-against-a-5°-slider defect.
    if (
      geometry &&
      solved &&
      solved.seam.secondaryTravelDeg < solved.seam.secondaryTargetDeg - 1e-9
    ) {
      notes.sidewaysClampedJoints += 1;
      notes.minSidewaysDeg = Math.min(
        notes.minSidewaysDeg,
        solved.seam.secondaryTravelDeg,
      );
    }

    let cutter: Manifold | null = null;
    let hoop: Manifold | null = null;
    let ring: Manifold | null = null;
    if (geometry && solved) {
      // The OPEN POCKET, sized here because it needs the measured skin and the
      // law-7 rooms. It only ever shrinks under its caps (anchoring, skin wall,
      // neighbour rooms) and is skipped outright when it could not even bare
      // the hoop's crown — never load-bearing, so no warning and no fallback.
      const bounds = linkPocketBoundsMm(geometry, solved.poly);
      let pocket = Math.min(
        bounds.desiredMm,
        bounds.capMm,
        headRoom - LINK_NEIGHBOUR_CLEAR_MM,
        tailRoom - LINK_NEIGHBOUR_CLEAR_MM,
      );
      // Two passes: the band the skin is measured over must contain the final
      // sphere, so the first pass's (wider) band makes the second conservative.
      // Capped at LINK_POCKET_SKIN_FRACTION of the thinnest local half-extent
      // as well as wall-inside-skin: the bowl should read like the reference
      // toy's (a solid rim around it), and the seam-rim probes read the kerf at
      // 0.75·ρ_min, which must stay outside the bowl.
      for (let pass = 0; pass < 2 && pocket > 0; pass += 1) {
        const skin = Math.min(planeExtents.minMm, measure(pocket).minMm);
        pocket = Math.min(
          pocket,
          skin - FLEXI_MIN_SOCKET_WALL_MM,
          LINK_POCKET_SKIN_FRACTION * skin,
        );
      }
      const pocketRadiusMm =
        pocket >=
        geometry.pivotOffsetMm + geometry.tubeRadiusMm + clearance + 0.5
          ? pocket
          : 0;
      // All three solids come out of ONE pure function of the pose, the solved
      // geometry/seam and the four measured scalars below, so they cache as one
      // entry. `poly` is omitted from the key on purpose: it is derived from
      // (geometry, seam, clearance), all three of which are in it already.
      const key = cacheKey([
        'link',
        quality,
        jointCacheKeyPart(joint),
        geometry,
        solved.seam,
        clearance,
        rhoClip,
        headRoom,
        pocketRadiusMm,
      ]);
      const cached = borrow.take(key);
      if (cached) {
        cutter = cached[0];
        hoop = cached[1];
        ring = cached[2];
      } else {
        const built = buildLinkJoint(
          wasm,
          joint,
          geometry,
          solved.seam,
          solved.poly,
          clearance,
          rhoClip,
          headRoom,
          pocketRadiusMm,
        );
        if (built) {
          cutter = built.cutter;
          hoop = built.hoop;
          ring = built.ring;
          borrow.store(key, [cutter, hoop, ring]);
        } else {
          // Every solid was solvable and the booleans still refused.
          reason = 'boolean';
        }
      }
    }
    if (!cutter) {
      notes.linkFallbackJoints += 1;
      notes.fallbackReasons[reason] += 1;
      cutter = buildRoundedFallbackCutter(
        wasm,
        joint,
        clearance,
        bendAngleDeg,
        measure,
        planeExtents,
        maxTailReach,
        minNeighborDist,
      );
    }
    if (!cutter) {
      // Unreachable in practice (a null cutter means `buildLinkJoint` refused,
      // which leaves both males null too) but kept exact: the two males are
      // dropped here rather than deleted when they are cache handles.
      borrow.release(hoop);
      borrow.release(ring);
      return abandon();
    }

    const next = cut.subtract(cutter);
    // Borrowed when it came from the cache, owned when the rounded fallback
    // built it.
    borrow.release(cutter);
    if (cut !== body) cut.delete();
    cut = next;
    if (hoop) males.push(hoop);
    if (ring) males.push(ring);
  }

  // TWO orphan guards, against the FINAL cut solid — a hoop whose leg anchor
  // landed in a neighbour's cavity and a ring whose crown the next joint's
  // cutter carved away are different bugs with the same symptom, and neither is
  // visible to the severance guard below: an orphan is its own component,
  // `decompose()` happily assigns it to some segment group, every group stays
  // non-empty and the build reports 'ok' with a loose part in the print.
  for (const male of males) {
    const anchored = male.intersect(cut);
    const orphan = anchored.isEmpty();
    anchored.delete();
    if (orphan) {
      freeTransient();
      return 'uncut';
    }
  }

  // ORDER MATTERS: the carved cavity is by construction a superset of each
  // male's swept envelope, so the males can only be added AFTER the whole
  // subtract chain. One whole-body union for the entire build.
  if (males.length > 0) {
    // `union` does not consume its inputs, so passing borrowed cache handles is
    // safe; `release` then drops the borrowed ones and frees the owned ones.
    const union = wasm.Manifold.union(males);
    for (const male of males) borrow.release(male);
    const joined = cut.add(union);
    union.delete();
    if (cut !== body) cut.delete();
    cut = joined;
  }

  // Manifold booleans are lazy — one status check evaluates the whole tree.
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

  const segmentCount = cutJoints.length + 1;
  const groups: Manifold[][] = Array.from({ length: segmentCount }, () => []);
  for (const component of components) {
    // The VOLUME centroid, not the vertex average: link's cutter tessellates
    // densely right at the cut, which is exactly the case that drags a vertex
    // average onto the wrong side of a short tapering tip.
    const centroid = componentVolumeCentroid(component);
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
  if (groups.some((group) => group.length === 0)) {
    return 'uncut';
  }
  return groups;
}

/**
 * Build one link joint's cutter and its two males, or null if any part fails.
 * Deletes everything transient by hand, including on every failure path — the
 * three results are deleted TOGETHER if any of them is missing.
 */
function buildLinkJoint(
  wasm: ManifoldToplevel,
  joint: FlexiJointPlan,
  geometry: LinkJointGeometry,
  seam: LinkSeamProfile,
  poly: LinkHoopPolyline,
  clearance: number,
  rhoClipMm: number,
  headRoomMm: number,
  pocketRadiusMm: number,
): { cutter: Manifold; hoop: Manifold; ring: Manifold } | null {
  const { Manifold: ManifoldClass } = wasm;
  let clip: Manifold | null = null;
  let hoopCore: Manifold | null = null;
  let hoopEnvelope: Manifold | null = null;
  let ringEnvelope: Manifold | null = null;
  let ring: Manifold | null = null;
  let cutter: Manifold | null = null;
  try {
    // Belt and braces only: ladder gate g2 already requires this clip to be a
    // NO-OP on the hoop, and g3 keeps the whole ring inside it. Truncating
    // either loop would open or knife-edge it, which is why the gates exist
    // rather than the clip being a sizing device.
    if (Number.isFinite(rhoClipMm) && rhoClipMm > 0) {
      const height = 4 * (geometry.bladeReachMm + geometry.anchorMm + 4);
      clip = ManifoldClass.cylinder(height, rhoClipMm, rhoClipMm, 64, true);
    }
    hoopCore = buildLinkHoopCore(wasm, poly);
    hoopEnvelope = buildLinkHoopEnvelope(wasm, poly, seam.travelDeg);
    ringEnvelope = buildLinkRingEnvelope(wasm, geometry, clearance);
    if (!hoopCore || !hoopEnvelope || !ringEnvelope) return null;
    ring = buildLinkRing(
      wasm,
      geometry,
      hoopEnvelope,
      clip,
      linkBladeHeadCapMm(geometry, headRoomMm),
    );
    if (!ring) return null;
    cutter = buildLinkCutter(
      wasm,
      seam,
      hoopEnvelope,
      ringEnvelope,
      geometry.bladeReachMm + geometry.anchorMm,
      pocketRadiusMm,
    );
    if (!cutter) return null;
    let hoop = hoopCore;
    if (clip) {
      hoop = hoopCore.intersect(clip);
      hoopCore.delete();
      hoopCore = hoop;
    }
    if (hoop.status() !== 'NoError' || hoop.isEmpty()) return null;

    const matrix = orientationMatrix(joint.axis, joint.center);
    const orientedCutter = cutter.transform(matrix);
    const orientedHoop = hoop.transform(matrix);
    const orientedRing = ring.transform(matrix);
    cutter.delete();
    cutter = null;
    hoopCore = null;
    hoop.delete();
    ring.delete();
    ring = null;
    return {
      cutter: orientedCutter,
      hoop: orientedHoop,
      ring: orientedRing,
    };
  } finally {
    if (clip) clip.delete();
    if (hoopCore) hoopCore.delete();
    if (hoopEnvelope) hoopEnvelope.delete();
    if (ringEnvelope) ringEnvelope.delete();
    if (ring) ring.delete();
    if (cutter) cutter.delete();
  }
}

// --- Link ("chain link") solids --------------------------------------------
//
// All four builders work in the NATIVE frame (+X lateral `v`, +Y up `u`,
// +Z the joint axis `s`) and are oriented at the end by `orientationMatrix`,
// which puts native +Y on world up for every horizontal axis. Every link solid
// is mirror-symmetric in native X, so the sign ambiguity between that matrix's X
// column and `buildAxisFrame`'s `e2` is harmless.

/** A sphere whose FACET PLANES sit at `radius` (manifold's geodesic sphere puts
 *  its vertices there instead, so the envelope must be inflated to contain its
 *  ideal ball). Used for the envelope only — the CORE is left nominal, i.e.
 *  inscribed, which only ever widens the running clearance. */
function linkSphere(
  ManifoldClass: ManifoldToplevel['Manifold'],
  radiusMm: number,
  center: [number, number, number],
  inflate: boolean,
): Manifold {
  const sphere = ManifoldClass.sphere(
    radiusMm * (inflate ? LINK_SPHERE_INFLATION : 1),
    LINK_SPHERE_SEGMENTS,
  );
  const moved = sphere.translate(center);
  sphere.delete();
  return moved;
}

/** Rotate a native-frame point about the PIN AXIS (native X through the pivot). */
function linkRotateAboutPin(
  p: [number, number, number],
  angleRad: number,
  pivotOffsetMm: number,
): [number, number, number] {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const u = p[1];
  const s = p[2] - pivotOffsetMm;
  return [p[0], u * cos - s * sin, pivotOffsetMm + u * sin + s * cos];
}

// The hoop itself: a chain of capsules along the shared centreline. Hull of two
// spheres, not a revolve — exact for a capsule, no basis mapping at the arc→leg
// knee, and no partial-sweep arithmetic to get wrong.
function buildLinkHoopCore(
  wasm: ManifoldToplevel,
  poly: LinkHoopPolyline,
): Manifold | null {
  const { Manifold: ManifoldClass } = wasm;
  const parts: Manifold[] = [];
  for (let i = 0; i + 1 < poly.points.length; i += 1) {
    const a = linkSphere(
      ManifoldClass,
      poly.coreRadiusMm,
      poly.points[i],
      false,
    );
    const b = linkSphere(
      ManifoldClass,
      poly.coreRadiusMm,
      poly.points[i + 1],
      false,
    );
    parts.push(ManifoldClass.hull([a, b]));
    a.delete();
    b.delete();
  }
  const hoop = ManifoldClass.union(parts);
  for (const part of parts) part.delete();
  return hoop;
}

// The hoop's swept FAT envelope — the solid whose carve radius the ring's hole
// is sized past, and which carves the swing relief out of the head. Pitch samples stay at most 15° apart;
// the per-point sagitta covers the small chord error between adjacent samples,
// so their hull union conservatively contains the continuously swept fat hoop.
function buildLinkHoopEnvelope(
  wasm: ManifoldToplevel,
  poly: LinkHoopPolyline,
  travelDeg: number,
): Manifold | null {
  const { Manifold: ManifoldClass } = wasm;
  const parts: Manifold[] = [];
  for (let i = 0; i + 1 < poly.points.length; i += 1) {
    const seeds: Manifold[] = [];
    for (const angleDeg of linkPitchSweepAnglesDeg(travelDeg)) {
      const angle = (angleDeg * Math.PI) / 180;
      seeds.push(
        linkSphere(
          ManifoldClass,
          poly.envRadiusMm[i],
          linkRotateAboutPin(poly.points[i], angle, poly.pivotOffsetMm),
          true,
        ),
      );
      seeds.push(
        linkSphere(
          ManifoldClass,
          poly.envRadiusMm[i + 1],
          linkRotateAboutPin(poly.points[i + 1], angle, poly.pivotOffsetMm),
          true,
        ),
      );
    }
    parts.push(ManifoldClass.hull(seeds));
    for (const seed of seeds) seed.delete();
  }
  const envelope = ManifoldClass.union(parts);
  for (const part of parts) part.delete();
  return envelope;
}

/** The open pocket never exceeds this fraction of the thinnest local skin
 *  half-extent: the bowl keeps a solid rim (the reference-toy look) and stays
 *  clear of the 0.75·ρ_min radius the seam-rim probes measure the kerf at. */
const LINK_POCKET_SKIN_FRACTION = 0.6;

// The ring: a slender TORUS revolved about the pin axis, whose hole IS the eye.
// Its solid stays at least `LINK_RING_SLACK_MM` outside the hoop envelope's
// carve radius by construction (`centreline − tube = eyeOuterMm + slack`), and
// because `hoopEnvelope ⊇ hoop ⊕ ball(c)` at every reachable pose,
// `dist(ring, hoop) ≥ clearanceMm` at rest AND through the travel. The subtract
// below is belt and braces on that argument — the worst a wrong estimate can do
// is send the joint to the rounded fallback.
//
// Unlike the old blade plate there is NO head-ward truncation branch: a plane
// pushed past a torus's outer edge first thins the crown to a knife edge and
// then opens the loop, so the ring either fits whole (gate g6) or the joint
// falls back.
function buildLinkRing(
  wasm: ManifoldToplevel,
  geometry: LinkJointGeometry,
  hoopEnvelope: Manifold,
  clip: Manifold | null,
  headCapMm: number,
): Manifold | null {
  const { CrossSection } = wasm;
  const q = geometry.pivotOffsetMm;
  // Belt and braces on the ladder's hoisted g6: the WHOLE ring must fit.
  if (headCapMm < q + geometry.bladeReachMm) return null;
  const tube = geometry.bladeThicknessMm / 2;
  const centre = geometry.bladeReachMm - tube;
  // The rod's cross-section, inscribed (vertices nominal) like the hoop's core
  // spheres — a hair slimmer only ever widens the running clearance.
  const tubeSegments = RES.linkRingTubeSegments;
  const pts: [number, number][] = [];
  for (let k = 0; k < tubeSegments; k += 1) {
    const phi = (2 * Math.PI * k) / tubeSegments;
    pts.push([centre + tube * Math.cos(phi), tube * Math.sin(phi)]);
  }
  let ring: Manifold;
  let profile: InstanceType<typeof CrossSection> | null = null;
  try {
    profile = new CrossSection([pts]);
    ring = profile.revolve(RES.linkBladeSegments);
  } finally {
    if (profile) profile.delete();
  }
  // The revolve's symmetry axis is local +Z; rotate it onto the pin axis
  // (native +X) so the ring lies in the sagittal (u, s) plane, then centre it
  // on the pivot.
  const oriented = ring.rotate([0, 90, 0]).translate([0, 0, q]);
  ring.delete();
  let clipped = oriented;
  if (clip) {
    clipped = oriented.intersect(clip);
    oriented.delete();
  }
  const result = clipped.subtract(hoopEnvelope);
  clipped.delete();
  if (result.status() !== 'NoError' || result.isEmpty()) {
    result.delete();
    return null;
  }
  return result;
}

// The ring's own swept envelope, which relieves TAIL material so the ring can
// swing. A torus centred on the pivot and revolved about the pin axis is
// INVARIANT under the pitch rotation (its centreline circle lies in the plane
// normal to the pin axis and rotates onto itself), so — exactly like the old
// blade disc — only the secondary yaw/roll has to be swept: a rotation by `sec`
// about any in-plane axis through the pivot moves a point at distance `L` by at
// most `2L·sin(sec/2)`, and every point of the fat ring has
// `L ≤ bladeReachMm + c`. So a fat torus whose tube gains that sway is the
// continuous envelope, with two facet corrections: the tube polygon's own
// inscription (divide by `cos(π/n_tube)`) and the revolve chords' radial dip
// (scale the whole profile out by `1/cos(π/N)` — outward-safe on the inner
// edge, where chords dip INTO the hole and only over-cover).
function buildLinkRingEnvelope(
  wasm: ManifoldToplevel,
  geometry: LinkJointGeometry,
  clearanceMm: number,
): Manifold | null {
  const { CrossSection } = wasm;
  const secRad = (geometry.secondaryTravelDeg * Math.PI) / 180;
  const tube = geometry.bladeThicknessMm / 2;
  const centre = geometry.bladeReachMm - tube;
  const sway = 2 * (geometry.bladeReachMm + clearanceMm) * Math.sin(secRad / 2);
  // BOTH facet corrections read the SAME counts the profile below is built and
  // revolved with, so a coarser preview profile inflates further and the
  // envelope stays a superset of the swept ring at either quality.
  const tubeSegments = RES.linkRingTubeSegments;
  const revolveSegments = RES.linkBladeSegments;
  const fat = (tube + clearanceMm + sway) / Math.cos(Math.PI / tubeSegments);
  const radialInflate = 1 / Math.cos(Math.PI / revolveSegments);
  const pts: [number, number][] = [];
  for (let k = 0; k < tubeSegments; k += 1) {
    const phi = (2 * Math.PI * k) / tubeSegments;
    pts.push([
      Math.max(0.01, (centre + fat * Math.cos(phi)) * radialInflate),
      fat * Math.sin(phi),
    ]);
  }
  let envelope: Manifold;
  let profile: InstanceType<typeof CrossSection> | null = null;
  try {
    profile = new CrossSection([pts]);
    envelope = profile.revolve(revolveSegments);
  } finally {
    if (profile) profile.delete();
  }
  const oriented = envelope
    .rotate([0, 90, 0])
    .translate([0, 0, geometry.pivotOffsetMm]);
  envelope.delete();
  return oriented;
}

// The cutter: a CONICAL ANNULAR KERF — a solid of revolution whose axial
// thickness grows linearly with the radius — plus the two swing reliefs, each
// HALF-SPACED to the side it must relieve, plus the OPEN POCKET (a sphere on
// the joint centre that bares the interlocked loops; zero radius skips it).
//
//   cutter = kerfCone ∪ (hoopEnvelope ∩ {s ≥ 0}) ∪ (ringEnvelope ∩ {s ≤ 0})
//            ∪ pocketSphere
//
// The pocket needs NO half-spacing: it is body material on both sides, the
// males are re-added after the whole subtract chain, and `linkPocketBoundsMm`'s
// caps guarantee each male still lands anchored in its own segment. It is
// deliberately INSCRIBED (facet vertices at the nominal radius) so it can only
// carve less than the wall budget assumed.
//
// The half-spacing is what keeps each male attached to its own body: the hoop's
// legs at s < 0 ARE tail material and need no relief, the ring's crown at s > 0
// IS head material and needs none either, and an un-split envelope would cut
// both males free.
//
// SEVERANCE (property L2) survives the grading: the profile is non-decreasing in
// the radius and at least `LINK_KERF_MIN_MM` on the axis, and the outer radius
// is unchanged, so it is a through-slot everywhere — a wedge that only ever gets
// THICKER outward cannot seal inside a flaring body, which is exactly the
// failure mode the old revolved wedges had.
//
// NO FACET CORRECTION. For a non-decreasing profile a point of true radius ρ on
// a revolve facet carries the axial half-height of a NOMINAL radius ρ/cos θ ≥ ρ,
// so the faceted cutter over-cuts and can only add clearance. The only
// inscription risk is the outer radius, already covered by
// `LINK_KERF_OUT_FACTOR = 1.15 ≥ 1/cos(π/N)` at every profile's N (1.0012 at
// the final 64, 1.0021 at the preview 48).
function buildLinkCutter(
  wasm: ManifoldToplevel,
  seam: LinkSeamProfile,
  hoopEnvelope: Manifold,
  ringEnvelope: Manifold,
  reachMm: number,
  pocketRadiusMm: number,
): Manifold | null {
  const { Manifold: ManifoldClass, CrossSection } = wasm;
  const outer = seam.outerRadiusMm;
  const floor = seam.kerfFloorMm;
  const rim = Math.max(floor, seam.kerfSlope * outer + seam.clearanceMm);
  // Radius at which the graded law overtakes the floor.
  const knee =
    seam.kerfSlope > 1e-12
      ? Math.max(
          0,
          Math.min(outer, (floor - seam.clearanceMm) / seam.kerfSlope),
        )
      : outer;
  let kerf: Manifold;
  if (rim <= floor + 1e-9) {
    // Degenerate cone == the plain right cylinder; keep the cheap solid.
    kerf = ManifoldClass.cylinder(
      floor,
      outer,
      outer,
      RES.linkKerfSegments,
      true,
    );
  } else {
    // `revolve` spins the (x, y) section about ITS y-axis and lands the result
    // on +Z, so x is the radius and y the axial coordinate. Same CCW winding as
    // `buildLinkRingEnvelope`.
    const pts: [number, number][] = [[0, -floor / 2]];
    if (knee > 1e-6) pts.push([knee, -floor / 2]);
    pts.push([outer, -rim / 2], [outer, rim / 2]);
    if (knee > 1e-6) pts.push([knee, floor / 2]);
    pts.push([0, floor / 2]);
    let section: InstanceType<typeof CrossSection> | null = null;
    try {
      section = new CrossSection([pts]);
      kerf = section.revolve(RES.linkKerfSegments);
    } finally {
      if (section) section.delete();
    }
  }
  // Boxes, not cylinders: the half-space only has to cut at s = 0, and a
  // 12-triangle box does that far more cheaply than a faceted cylinder.
  const span = 4 * (outer + reachMm + 2);
  // The seeds are bound and freed: `cube(...).translate(...)` returns a NEW
  // manifold and leaves the cube behind, which leaked one box per half-space per
  // joint on every build.
  const halfSeed = ManifoldClass.cube([span, span, span], true);
  const headHalf = halfSeed.translate([0, 0, span / 2]);
  const tailHalf = halfSeed.translate([0, 0, -span / 2]);
  halfSeed.delete();
  const hoopRelief = hoopEnvelope.intersect(headHalf);
  const ringRelief = ringEnvelope.intersect(tailHalf);
  headHalf.delete();
  tailHalf.delete();
  const parts: Manifold[] = [kerf, hoopRelief, ringRelief];
  if (pocketRadiusMm > 0) {
    parts.push(ManifoldClass.sphere(pocketRadiusMm, RES.linkRingTubeSegments));
  }
  const cutter = ManifoldClass.union(parts);
  for (const part of parts) part.delete();
  if (cutter.status() !== 'NoError' || cutter.isEmpty()) {
    cutter.delete();
    return null;
  }
  return cutter;
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
    const solid = section.revolve(RES.shellRevolveSegments);
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

// True VOLUME centroid of a closed component (divergence theorem over the
// triangles), as opposed to `componentCentroid`'s vertex average. The strong
// cutter tessellates its seam, cavity and slot densely right at the cut, so on
// a short tapering piece the vertex average is dragged to the cut plane and can
// land on the wrong side of it — which silently misgroups the piece and trips
// the severance guard. Volume weighting cannot be fooled by tessellation
// density. Falls back to the vertex average on a degenerate (zero-volume) mesh.
function componentVolumeCentroid(
  component: Manifold,
): [number, number, number] {
  const mesh = component.getMesh();
  const numProp = mesh.numProp;
  const properties = mesh.vertProperties;
  const triangles = mesh.triVerts;
  let total = 0;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (let t = 0; t < triangles.length; t += 3) {
    const ia = triangles[t] * numProp;
    const ib = triangles[t + 1] * numProp;
    const ic = triangles[t + 2] * numProp;
    const ax = properties[ia];
    const ay = properties[ia + 1];
    const az = properties[ia + 2];
    const bx = properties[ib];
    const by = properties[ib + 1];
    const bz = properties[ib + 2];
    const cx = properties[ic];
    const cy = properties[ic + 1];
    const cz = properties[ic + 2];
    // Signed volume of the tetrahedron (origin, a, b, c), times 6.
    const v =
      ax * (by * cz - bz * cy) -
      ay * (bx * cz - bz * cx) +
      az * (bx * cy - by * cx);
    total += v;
    sx += v * (ax + bx + cx);
    sy += v * (ay + by + cy);
    sz += v * (az + bz + cz);
  }
  if (!(Math.abs(total) > 1e-12)) {
    return componentCentroid(component);
  }
  return [sx / (4 * total), sy / (4 * total), sz / (4 * total)];
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
  const sphere = keep(wasm.Manifold.sphere(radius, RES.sphereSegments));
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

type ColorGrid = {
  /** Colour of the nearest input vertex. */
  nearest: (x: number, y: number, z: number) => Vec3;
  /** The same lookup, written straight into `out` — no array per vertex. */
  fillNearest: (
    x: number,
    y: number,
    z: number,
    out: Float32Array,
    at: number,
  ) => void;
};

// Cell coordinates are packed into ONE number instead of a `${cx},${cy},${cz}`
// string: at 100k+ output vertices the string keys were the dominant cost of
// the colour pass (a fresh string per bucket probe, and up to 27 probes per
// vertex).
//
// Inserted vertices land in 0…64 on every axis by construction (`cell` is
// diag/64, and no extent exceeds the diagonal), and `nearest` only ever probes
// ±64 cells around its query, so a query further than CELL_KEY_LIMIT cells from
// the origin cannot reach a populated bucket at any packing. Clamping to that
// range is therefore invisible to the result, and it bounds the key at
// 3 × 17 bits ≈ 2.3e15 — comfortably inside Number.MAX_SAFE_INTEGER, so two
// distinct in-range cells can never collide.
const CELL_KEY_LIMIT = 1 << 16;
const CELL_KEY_BASE = 1 << 17;

function packCellKey(cx: number, cy: number, cz: number): number {
  const bx = Math.min(CELL_KEY_LIMIT - 1, Math.max(-CELL_KEY_LIMIT, cx));
  const by = Math.min(CELL_KEY_LIMIT - 1, Math.max(-CELL_KEY_LIMIT, cy));
  const bz = Math.min(CELL_KEY_LIMIT - 1, Math.max(-CELL_KEY_LIMIT, cz));
  return (
    ((bx + CELL_KEY_LIMIT) * CELL_KEY_BASE + (by + CELL_KEY_LIMIT)) *
      CELL_KEY_BASE +
    (bz + CELL_KEY_LIMIT)
  );
}

function buildColorGrid(meshInput: FlexiMeshInput): ColorGrid {
  const { positions, colors } = meshInput;
  const vertexCount = Math.floor(positions.length / 3);
  if (vertexCount === 0) {
    return {
      nearest: () => [1, 1, 1],
      fillNearest: (_x, _y, _z, out, at) => {
        out[at] = 1;
        out[at + 1] = 1;
        out[at + 2] = 1;
      },
    };
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

  const grid = new Map<number, number[]>();
  for (let v = 0; v < vertexCount; v += 1) {
    const key = packCellKey(
      Math.floor((positions[v * 3] - minX) / cell),
      Math.floor((positions[v * 3 + 1] - minY) / cell),
      Math.floor((positions[v * 3 + 2] - minZ) / cell),
    );
    const bucket = grid.get(key);
    if (bucket) bucket.push(v);
    else grid.set(key, [v]);
  }

  /** Index of the nearest input vertex, or -1 when the grid holds nothing near. */
  const nearestIndex = (x: number, y: number, z: number): number => {
    const cx = Math.floor((x - minX) / cell);
    const cy = Math.floor((y - minY) / cell);
    const cz = Math.floor((z - minZ) / cell);
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
            const bucket = grid.get(packCellKey(cx + ox, cy + oy, cz + oz));
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
    return best;
  };

  return {
    nearest: (x, y, z) => {
      const best = nearestIndex(x, y, z);
      if (best < 0) return [1, 1, 1];
      return [colors[best * 3], colors[best * 3 + 1], colors[best * 3 + 2]];
    },
    fillNearest: (x, y, z, out, at) => {
      const best = nearestIndex(x, y, z);
      if (best < 0) {
        out[at] = 1;
        out[at + 1] = 1;
        out[at + 2] = 1;
        return;
      }
      out[at] = colors[best * 3];
      out[at + 1] = colors[best * 3 + 1];
      out[at + 2] = colors[best * 3 + 2];
    },
  };
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
