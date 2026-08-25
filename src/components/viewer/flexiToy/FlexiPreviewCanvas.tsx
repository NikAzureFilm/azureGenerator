/**
 * The flexi preview viewport.
 *
 * Design goals (in order):
 *  1. The WebGL context is created ONCE per dialog open — the Canvas mounts
 *     unconditionally and only the geometry inside it comes and goes.
 *  2. A new result must swap the mesh in place: no camera re-fit, no
 *     re-framing, no environment reload. The user's orbit angle and zoom
 *     survive every recompute.
 *  3. Nothing but a real visual change costs a frame — `frameloop="demand"`
 *     plus explicit `invalidate()` calls.
 *  4. The slicer-style layer view is a GPU CLIPPING PLANE, not a geometry
 *     operation: scrubbing it changes one plane constant and requests a frame,
 *     so it costs nothing on the CPU however large the mesh is. While the model
 *     is clipped the body renders double-sided so the joint internals (balls,
 *     sockets, hoops, rings) read as solid surfaces through the cut.
 */
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ComponentProps,
} from 'react';
import * as THREE from 'three';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';

import type {
  FlexiAxisOverride,
  FlexiJointPlan,
  FlexiToyPlan,
  FlexiToyResult,
  FlexiToySettings,
} from '@/utils/flexiToyTypes';
import {
  RING_AMBER,
  RING_AMBER_HOVER,
  RING_BLUE,
  RING_BLUE_HOVER,
  clamp,
  clamp01,
} from './flexiToyUi';

/** Live position of the handle the user is currently moving on the strip. */
export type FlexiDragState = { index: number; fraction: number } | null;

// Sample cap for the per-joint body-radius scan so huge meshes stay cheap.
const RING_RADIUS_SAMPLE_CAP = 20000;

// The content is normalised into a fixed view volume (see `computeFit`), so
// the camera never has to move to frame a new result.
const FIT_RADIUS = 1;
// Near-identical results must not make the model "breathe" — ignore radius
// changes under this ratio and keep the previous scale.
const FIT_HYSTERESIS = 0.1;
// Mostly side-on with a little elevation, close enough that a unit-radius
// fit nearly fills the frame (flexi toys are elongated, and `computeFit`
// yaws the spine onto +X, so the long axis spans the viewport width).
const CAMERA_POSITION: [number, number, number] = [0.9, 0.55, 2.55];

// Device profile, resolved once at module scope. `deviceMemory` is
// Chromium-only and absent from lib.dom, so it is read defensively.
const IS_LOW_END_DEVICE = (() => {
  if (typeof navigator === 'undefined') {
    return false;
  }
  const memory =
    (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 8;
  return memory <= 4 || cores <= 4;
})();

const PREVIEW_DPR = IS_LOW_END_DEVICE
  ? 1
  : Math.min(
      typeof window === 'undefined' ? 1 : (window.devicePixelRatio ?? 1),
      1.75,
    );

const PREVIEW_GL = {
  antialias: !IS_LOW_END_DEVICE,
  powerPreference: IS_LOW_END_DEVICE
    ? ('low-power' as const)
    : ('high-performance' as const),
  alpha: false,
  stencil: false,
};

const PREVIEW_CAMERA = {
  fov: 45,
  near: 0.1,
  far: 100,
  position: CAMERA_POSITION,
};

const ORBIT_MOUSE_BUTTONS = {
  LEFT: THREE.MOUSE.ROTATE,
  MIDDLE: THREE.MOUSE.PAN,
  RIGHT: THREE.MOUSE.PAN,
};

function requestFirstFrame(state: {
  invalidate: () => void;
  gl: THREE.WebGLRenderer;
}) {
  // Per-material clipping planes are ignored unless the renderer opts in.
  state.gl.localClippingEnabled = true;
  state.invalidate();
}

/**
 * Positions, index and normals are a pure function of the result, so they are
 * built once per result and never rebuilt for a colour change. The colour
 * attribute is allocated here and filled by `writeFlexiColors`.
 */
function buildFlexiGeometry(result: FlexiToyResult): THREE.BufferGeometry {
  const { positions, indices } = result;
  const vertexCount = positions.length / 3;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(positions.slice(), 3),
  );
  geometry.setIndex(new THREE.BufferAttribute(indices.slice(), 1));
  geometry.setAttribute(
    'color',
    new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3),
  );
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Writes the vertex colours in place. Because segments are separate bodies (no
 * vertex is shared across a cut), each segment's vertices can be painted
 * without collisions. The default view alternates each segment lighter/darker
 * so the articulation reads at a glance; the toggle paints the model's real
 * baked colours instead.
 */
function writeFlexiColors(
  geometry: THREE.BufferGeometry,
  result: FlexiToyResult,
  showOriginalColors: boolean,
): void {
  const attribute = geometry.getAttribute('color') as
    | THREE.BufferAttribute
    | undefined;
  if (!attribute) {
    return;
  }
  const target = attribute.array as Float32Array;
  const { positions, indices, colors, segmentTriangleRanges } = result;
  const vertexCount = positions.length / 3;
  const hasColors = colors && colors.length === vertexCount * 3;

  for (let v = 0; v < vertexCount; v += 1) {
    target[v * 3] = hasColors ? colors[v * 3] : 0.85;
    target[v * 3 + 1] = hasColors ? colors[v * 3 + 1] : 0.85;
    target[v * 3 + 2] = hasColors ? colors[v * 3 + 2] : 0.85;
  }

  if (!showOriginalColors) {
    segmentTriangleRanges.forEach((range, segIndex) => {
      const factor = segIndex % 2 === 0 ? 1.15 : 0.62;
      const end = range.start + range.count;
      for (let i = range.start; i < end; i += 1) {
        const v = indices[i];
        const baseR = hasColors ? colors[v * 3] : 0.85;
        const baseG = hasColors ? colors[v * 3 + 1] : 0.85;
        const baseB = hasColors ? colors[v * 3 + 2] : 0.85;
        // Assign (never accumulate) so revisiting a vertex is idempotent.
        target[v * 3] = clamp01(baseR * factor);
        target[v * 3 + 1] = clamp01(baseG * factor);
        target[v * 3 + 2] = clamp01(baseB * factor);
      }
    });
  }

  attribute.needsUpdate = true;
}

/**
 * Single pass over the vertices: the bounding box gives the centre, and half
 * its diagonal is a safe bounding-sphere radius. Scaling by FIT_RADIUS/radius
 * and offsetting by −centre×scale drops any result into the same view volume,
 * so the camera never needs to move. The yaw turns the spine's horizontal
 * component onto +X so the toy reads side-on, running left→right like the
 * joints strip under the preview (yaw-only, so the model stays upright).
 */
function computeFit(
  positions: Float32Array,
  spine: FlexiToyPlan['spine'],
): {
  center: [number, number, number];
  radius: number;
  yaw: number;
} {
  let yaw = 0;
  if (spine.length >= 2) {
    const tail = spine[0];
    const head = spine[spine.length - 1];
    const dirX = head[0] - tail[0];
    const dirZ = head[2] - tail[2];
    if (Math.hypot(dirX, dirZ) > 1e-6) {
      yaw = Math.atan2(dirZ, dirX);
    }
  }
  if (positions.length < 3) {
    return { center: [0, 0, 0], radius: 1, yaw };
  }
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
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
  const radius = Math.sqrt(dx * dx + dy * dy + dz * dz) / 2;
  return {
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    radius: Number.isFinite(radius) && radius > 0 ? radius : 1,
    yaw,
  };
}

// Arc-length parameterisation of the spine polyline so a 0..1 fraction maps to
// a 3D point (used to place a handle's ring while it is being dragged).
function useSpineArc(spine: FlexiToyPlan['spine']) {
  return useMemo(() => {
    const pts = spine.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    const cum = [0];
    for (let i = 1; i < pts.length; i += 1) {
      cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    }
    const total = cum[cum.length - 1] || 1;

    const fractionToPoint = (f: number): THREE.Vector3 => {
      if (pts.length === 0) return new THREE.Vector3();
      if (pts.length === 1) return pts[0].clone();
      const target = clamp01(f) * total;
      let i = 1;
      while (i < cum.length && cum[i] < target) i += 1;
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(i, pts.length - 1);
      const segLen = cum[i1] - cum[i0] || 1;
      const t = clamp01((target - cum[i0]) / segLen);
      return pts[i0].clone().lerp(pts[i1], t);
    };

    return { fractionToPoint };
  }, [spine]);
}

/**
 * Passive cut rings. All interaction now lives in the DOM strip below the
 * canvas, so these carry no pointer handlers, never change the cursor and
 * never disable OrbitControls.
 */
function FlexiCutRings({
  plan,
  positions,
  highlightIndex,
  dragState,
  clippingPlanes,
  settings,
  previewingIntent,
}: {
  plan: FlexiToyPlan;
  positions: Float32Array;
  highlightIndex: number | null;
  dragState: FlexiDragState;
  clippingPlanes: THREE.Plane[];
  settings: FlexiToySettings;
  previewingIntent: boolean;
}) {
  const { fractionToPoint } = useSpineArc(plan.spine);

  // Boolean geometry cannot land in one frame, so show the user's newest cut
  // intent on top of the last certified body while the worker catches up.
  const displayJoints = useMemo<FlexiJointPlan[]>(() => {
    if (!previewingIntent) return plan.joints;

    const requestedSegments =
      typeof settings.segmentCount === 'number'
        ? settings.segmentCount
        : plan.joints.length + 1;
    const requestedJointCount = Math.max(0, requestedSegments - 1);
    const explicit = settings.jointPositions;
    const fractions =
      explicit?.length === requestedJointCount
        ? explicit
        : requestedJointCount === plan.joints.length
          ? plan.joints.map((joint) => joint.spineFraction)
          : Array.from(
              { length: requestedJointCount },
              (_, index) => (index + 1) / requestedSegments,
            );

    const overrideAxis = (
      override: FlexiAxisOverride,
    ): [number, number, number] | null => {
      switch (override) {
        case 'x':
          return [1, 0, 0];
        case 'y':
          return [0, 1, 0];
        case 'z':
          return [0, 0, 1];
        case 'auto':
          return null;
      }
    };
    const explicitAxis = overrideAxis(settings.axisOverride);

    return fractions.map((fraction) => {
      const source = plan.joints.reduce<FlexiJointPlan | null>(
        (nearest, joint) =>
          nearest === null ||
          Math.abs(joint.spineFraction - fraction) <
            Math.abs(nearest.spineFraction - fraction)
            ? joint
            : nearest,
        null,
      );
      const center = fractionToPoint(fraction);
      return {
        center: [center.x, center.y, center.z],
        axis: explicitAxis ?? source?.axis ?? [1, 0, 0],
        ballRadiusMm: source?.ballRadiusMm ?? 4,
        socketDepthMm: source?.socketDepthMm ?? 0,
        faceGapMm: source?.faceGapMm ?? 0,
        spineFraction: fraction,
        fused: false,
        supportsRequestedStyle: true,
      };
    });
  }, [
    fractionToPoint,
    plan.joints,
    previewingIntent,
    settings.axisOverride,
    settings.jointPositions,
    settings.segmentCount,
  ]);

  // Body silhouette radius at each cut station (max perpendicular distance of
  // nearby vertices from the joint centre) so the ring hugs the body outline.
  const ringRadii = useMemo(() => {
    const vertexCount = positions.length / 3;
    const step = Math.max(1, Math.floor(vertexCount / RING_RADIUS_SAMPLE_CAP));
    const slabHalf = 3;
    const v = new THREE.Vector3();
    return displayJoints.map((joint) => {
      const c = new THREE.Vector3(
        joint.center[0],
        joint.center[1],
        joint.center[2],
      );
      const ax = new THREE.Vector3(
        joint.axis[0],
        joint.axis[1],
        joint.axis[2],
      ).normalize();
      let maxPerp = 0;
      for (let i = 0; i < vertexCount; i += step) {
        v.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]).sub(
          c,
        );
        const along = v.dot(ax);
        if (Math.abs(along) > slabHalf) continue;
        const perp = Math.sqrt(Math.max(0, v.lengthSq() - along * along));
        if (perp > maxPerp) maxPerp = perp;
      }
      const base =
        maxPerp > 0 ? maxPerp : Math.max(joint.ballRadiusMm * 1.8, 4);
      return base * 1.12 + 0.8;
    });
  }, [displayJoints, positions]);

  const zAxis = useMemo(() => new THREE.Vector3(0, 0, 1), []);

  return (
    <group name={previewingIntent ? 'flexi-live-intent' : 'flexi-cut-rings'}>
      {displayJoints.map((joint, index) => {
        const isDragged = dragState?.index === index;
        const center = isDragged
          ? fractionToPoint(dragState.fraction)
          : new THREE.Vector3(
              joint.center[0],
              joint.center[1],
              joint.center[2],
            );
        const axis = new THREE.Vector3(
          joint.axis[0],
          joint.axis[1],
          joint.axis[2],
        );
        if (axis.lengthSq() === 0) axis.set(1, 0, 0);
        axis.normalize();
        const quaternion = new THREE.Quaternion().setFromUnitVectors(
          zAxis,
          axis,
        );
        const roomScale =
          settings.jointStyle === 'link' ? (settings.linkRoomScale ?? 1) : 1;
        const thicknessScale =
          settings.jointStyle === 'link'
            ? (settings.linkThicknessScale ?? 1)
            : 1;
        const jointScaleFactor =
          0.85 + (clamp(settings.jointScale, 0.6, 1.4) - 0.6) * 0.375;
        const clearanceFactor =
          0.85 + (clamp(settings.clearanceMm, 0.2, 0.8) - 0.2) * 0.5;
        const radius =
          (ringRadii[index] ?? 6) *
          (previewingIntent ? roomScale * jointScaleFactor : 1);
        const tube =
          clamp(radius * 0.05, 0.5, 1.6) *
          (previewingIntent ? thicknessScale * clearanceFactor : 1);
        const highlighted = isDragged || highlightIndex === index;
        const intentColor =
          settings.jointStyle === 'link'
            ? '#22C55E'
            : settings.jointStyle === 'strong'
              ? '#A78BFA'
              : RING_BLUE;
        const color = joint.fused
          ? highlighted
            ? RING_AMBER_HOVER
            : RING_AMBER
          : highlighted
            ? RING_BLUE_HOVER
            : previewingIntent
              ? intentColor
              : RING_BLUE;

        return (
          <mesh
            key={index}
            name={`flexi-ring-${index}`}
            position={center}
            quaternion={quaternion}
          >
            <torusGeometry args={[radius, tube, 8, 44]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={
                highlighted
                  ? 0.6
                  : 0.18 +
                    (previewingIntent
                      ? clamp(settings.bendAngleDeg / 90, 0, 1) * 0.22
                      : 0)
              }
              roughness={0.35}
              metalness={0.1}
              clippingPlanes={clippingPlanes}
            />
          </mesh>
        );
      })}
    </group>
  );
}

function FlexiScene({
  result,
  showOriginalColors,
  highlightIndex,
  dragState,
  layerFraction,
  heightMm,
  settings,
  previewingIntent,
}: {
  result: FlexiToyResult;
  showOriginalColors: boolean;
  highlightIndex: number | null;
  dragState: FlexiDragState;
  layerFraction: number;
  heightMm: number;
  settings: FlexiToySettings;
  previewingIntent: boolean;
}) {
  const invalidate = useThree((state) => state.invalidate);

  const geometry = useMemo(() => buildFlexiGeometry(result), [result]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const fitRadiusRef = useRef<number | null>(null);
  const fit = useMemo(() => {
    const raw = computeFit(result.positions, result.plan.spine);
    const previous = fitRadiusRef.current;
    const radius =
      previous !== null &&
      Math.abs(raw.radius - previous) <= previous * FIT_HYSTERESIS
        ? previous
        : raw.radius;
    fitRadiusRef.current = radius;
    const scale = FIT_RADIUS / radius;
    // The group applies position·rotation·scale, so the centre offset must be
    // expressed in the already-yawed frame for the centre to land at origin.
    const cos = Math.cos(raw.yaw);
    const sin = Math.sin(raw.yaw);
    const rotatedCx = raw.center[0] * cos + raw.center[2] * sin;
    const rotatedCz = -raw.center[0] * sin + raw.center[2] * cos;
    return {
      scale,
      rotation: [0, raw.yaw, 0] as [number, number, number],
      position: [
        -rotatedCx * scale,
        -raw.center[1] * scale,
        -rotatedCz * scale,
      ] as [number, number, number],
    };
  }, [result]);

  // Layout effect so the colours are in place before the first frame of a new
  // result, and so the toggle never rebuilds geometry.
  useLayoutEffect(() => {
    writeFlexiColors(geometry, result, showOriginalColors);
    invalidate();
  }, [geometry, result, showOriginalColors, invalidate]);

  // Highlight, live drag and optimistic controls are visual-only changes, so
  // they need an explicit frame request under `frameloop="demand"`.
  useEffect(() => {
    invalidate();
  }, [
    invalidate,
    highlightIndex,
    dragState,
    previewingIntent,
    settings.axisOverride,
    settings.bendAngleDeg,
    settings.clearanceMm,
    settings.jointPositions,
    settings.jointScale,
    settings.jointStyle,
    settings.linkRoomScale,
    settings.linkThicknessScale,
    settings.segmentCount,
    settings.targetLengthMm,
  ]);

  // Layer view. ONE world-space plane, allocated once and mutated in place:
  // `n·p + d ≥ 0` is kept, so with n = −Y and d = worldY(h) everything above
  // the print height `h` is clipped. The result is floor-aligned (min Y = 0)
  // and the fit only yaws about Y, so world Y = mm·scale + group.y exactly.
  const clipPlane = useMemo(
    () => new THREE.Plane(new THREE.Vector3(0, -1, 0), 0),
    [],
  );
  const clipActive = layerFraction < 1;
  useLayoutEffect(() => {
    if (!clipActive) return;
    // Nudge a hair above the exact height so a fully raised slider position
    // that still rounds below 1 never shaves the top skin.
    const cutMm = Math.max(0, layerFraction) * heightMm + 1e-3;
    clipPlane.constant = cutMm * fit.scale + fit.position[1];
    invalidate();
  }, [clipActive, layerFraction, heightMm, fit, clipPlane, invalidate]);
  const clippingPlanes = useMemo(
    () => (clipActive ? [clipPlane] : []),
    [clipActive, clipPlane],
  );
  useEffect(() => {
    invalidate();
  }, [invalidate, clippingPlanes]);

  return (
    <group scale={fit.scale} rotation={fit.rotation} position={fit.position}>
      <mesh geometry={geometry}>
        <meshStandardMaterial
          vertexColors
          roughness={0.62}
          metalness={0.04}
          // Double-sided only while cut open, so the interior surfaces are
          // lit and visible through the slice; the uncut model keeps the
          // cheaper single-sided draw.
          side={clipActive ? THREE.DoubleSide : THREE.FrontSide}
          clippingPlanes={clippingPlanes}
        />
      </mesh>
      <FlexiCutRings
        plan={result.plan}
        positions={result.positions}
        highlightIndex={highlightIndex}
        dragState={dragState}
        clippingPlanes={clippingPlanes}
        settings={settings}
        previewingIntent={previewingIntent}
      />
    </group>
  );
}

export type FlexiPreviewCanvasProps = {
  result: FlexiToyResult | null;
  showOriginalColors: boolean;
  highlightIndex: number | null;
  dragState: FlexiDragState;
  /** Slicer-style layer view: fraction of the print height shown (1 = all). */
  layerFraction: number;
  /** Print height of `result` in mm (`flexiPrintHeightMm`), computed once by
   *  the dialog so the slider read-out and the clip plane share one pass. */
  heightMm: number;
  /** Current controls for the immediate joint-intent overlay. */
  settings: FlexiToySettings;
  /** True while exact worker geometry for `settings` is still pending. */
  previewingIntent: boolean;
};

/**
 * Memoised so unrelated dialog state never reconciles the r3f tree. Current
 * controls intentionally do: only the lightweight ring overlay changes, while
 * the expensive BufferGeometry remains memoised by `result`.
 */
export const FlexiPreviewCanvas = memo(function FlexiPreviewCanvas({
  result,
  showOriginalColors,
  highlightIndex,
  dragState,
  layerFraction,
  heightMm,
  settings,
  previewingIntent,
}: FlexiPreviewCanvasProps) {
  return (
    <Canvas
      frameloop="demand"
      dpr={PREVIEW_DPR}
      gl={PREVIEW_GL}
      camera={PREVIEW_CAMERA as ComponentProps<typeof Canvas>['camera']}
      onCreated={requestFirstFrame}
    >
      <hemisphereLight intensity={0.85} color="#ffffff" groundColor="#3c3f45" />
      <directionalLight position={[4, 6, 5]} intensity={1.1} />
      <directionalLight position={[-5, 2, -4]} intensity={0.35} />
      {result && result.positions.length > 0 ? (
        <FlexiScene
          result={result}
          showOriginalColors={showOriginalColors}
          highlightIndex={highlightIndex}
          dragState={dragState}
          layerFraction={layerFraction}
          heightMm={heightMm}
          settings={settings}
          previewingIntent={previewingIntent}
        />
      ) : null}
      <OrbitControls
        makeDefault
        enablePan
        enableDamping
        target={[0, 0, 0]}
        mouseButtons={ORBIT_MOUSE_BUTTONS}
      />
    </Canvas>
  );
});
