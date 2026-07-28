import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import * as THREE from 'three';
import { GLTF } from 'three-stdlib';
import { Canvas, type ThreeEvent } from '@react-three/fiber';
import { Environment, OrbitControls, Stage } from '@react-three/drei';
import { AlertTriangle, Download, Loader2, Worm } from 'lucide-react';
import posthog from 'posthog-js';
import * as Sentry from '@sentry/react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Slider } from '../ui/slider';
import { Switch } from '../ui/switch';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { processUserModelForDownload } from '@/utils/meshPrintProcessUtils';
import {
  FLEXI_CLEARANCE_PRESETS,
  FLEXI_DEFAULT_BEND_DEG,
  FLEXI_DEFAULT_JOINT_STYLE,
  FLEXI_DEFAULT_LENGTH_MM,
  FLEXI_MAX_BEND_DEG,
  FLEXI_MAX_CLEARANCE_MM,
  FLEXI_MAX_JOINT_SCALE,
  FLEXI_MAX_LENGTH_MM,
  FLEXI_MAX_SEGMENTS,
  FLEXI_MIN_BEND_DEG,
  FLEXI_MIN_CLEARANCE_MM,
  FLEXI_MIN_JOINT_SCALE,
  FLEXI_MIN_LENGTH_MM,
  FLEXI_MIN_SEGMENTS,
  type FlexiAxisOverride,
  type FlexiClearancePreset,
  type FlexiJointStyle,
  type FlexiMeshInput,
  type FlexiToyErrorCode,
  type FlexiToyPlan,
  type FlexiToyResult,
  type FlexiToySettings,
} from '@/utils/flexiToyTypes';
import { computeFlexiToy, sceneToFlexiMeshInput } from '@/utils/flexiToyClient';
import {
  flexiResultToStlBlob,
  flexiResultToThreeMfBlob,
} from '@/utils/flexiToyExport';

const RECOMPUTE_DEBOUNCE_MS = 350;

// Each cached result holds full-toy typed arrays, so keep only the most
// recently used handful (insertion-order LRU over the Map).
const FLEXI_RESULT_CACHE_LIMIT = 12;

// Cut-ring palette: blue = a live articulating joint, amber = a fused (rigid)
// station; the *_HOVER variants light up under the cursor / while dragging.
const RING_BLUE = '#3B82F6';
const RING_BLUE_HOVER = '#7DB0FF';
const RING_AMBER = '#F59E0B';
const RING_AMBER_HOVER = '#FCD34D';

// Sample cap for the per-joint body-radius scan so huge meshes stay cheap.
const RING_RADIUS_SAMPLE_CAP = 20000;

const CLEARANCE_PRESET_ORDER: FlexiClearancePreset[] = [
  'tight',
  'standard',
  'loose',
];

const CLEARANCE_PRESET_LABELS: Record<FlexiClearancePreset, string> = {
  tight: 'Tight',
  standard: 'Standard',
  loose: 'Loose',
};

const AXIS_OPTIONS: Array<{ value: FlexiAxisOverride; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'x', label: 'X' },
  { value: 'y', label: 'Y' },
  { value: 'z', label: 'Z' },
];

// Friendly, non-technical copy for each hard failure the core can report.
const FLEXI_ERROR_COPY: Record<
  FlexiToyErrorCode,
  { title: string; body: string }
> = {
  'not-watertight': {
    title: "This model can't be made flexi",
    body: "It has holes or gaps we couldn't seal, so it can't be split into working joints. Solid, watertight models work best — try another one.",
  },
  'too-small': {
    title: 'This model is a little too small',
    body: 'There is not enough room to fit joints that actually move. Try increasing the toy length above.',
  },
  'rounded-uncut': {
    title: "Rounded joints don't fit this shape",
    body: 'A fin or limb is in the way of the rounded cuts. Switch Joint style to Classic — it handles shapes like this.',
  },
  'compute-failed': {
    title: 'Something went wrong',
    body: "We couldn't build the flexi toy this time. Adjust a setting or try again.",
  },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function disposeScene(scene: THREE.Scene | null | undefined): void {
  scene?.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      if (Array.isArray(child.material)) {
        child.material.forEach((mat) => mat.dispose());
      } else {
        child.material.dispose();
      }
    }
  });
}

// Longest bounding-box extent of the mm-scale mesh — a good stand-in for the
// model's current length so the default toy length starts near life size.
function deriveCurrentLengthMm(input: FlexiMeshInput): number {
  const p = input.positions;
  if (!p || p.length < 3) {
    return FLEXI_DEFAULT_LENGTH_MM;
  }
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i];
    const y = p[i + 1];
    const z = p[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  return Number.isFinite(extent) && extent > 0
    ? extent
    : FLEXI_DEFAULT_LENGTH_MM;
}

// Builds the preview geometry from the flat result arrays. Because segments are
// separate bodies (no vertex is shared across a cut), we can safely paint each
// segment's vertices without collisions. The default view alternates each
// segment lighter/darker so the articulation reads at a glance; the toggle
// paints the model's real baked colors instead.
function buildFlexiPreviewGeometry(
  result: FlexiToyResult,
  showOriginalColors: boolean,
): THREE.BufferGeometry {
  const { positions, indices, colors, segmentTriangleRanges } = result;
  const vertexCount = positions.length / 3;
  const hasColors = colors && colors.length === vertexCount * 3;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(positions.slice(), 3),
  );
  geometry.setIndex(new THREE.BufferAttribute(indices.slice(), 1));

  const colorArr = new Float32Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v += 1) {
    colorArr[v * 3] = hasColors ? colors[v * 3] : 0.85;
    colorArr[v * 3 + 1] = hasColors ? colors[v * 3 + 1] : 0.85;
    colorArr[v * 3 + 2] = hasColors ? colors[v * 3 + 2] : 0.85;
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
        colorArr[v * 3] = clamp01(baseR * factor);
        colorArr[v * 3 + 1] = clamp01(baseG * factor);
        colorArr[v * 3 + 2] = clamp01(baseB * factor);
      }
    });
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colorArr, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function FlexiToyPreview({
  result,
  showOriginalColors,
}: {
  result: FlexiToyResult;
  showOriginalColors: boolean;
}) {
  const geometry = useMemo(
    () => buildFlexiPreviewGeometry(result, showOriginalColors),
    [result, showOriginalColors],
  );

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial vertexColors roughness={0.62} metalness={0.04} />
    </mesh>
  );
}

// Arc-length parameterisation of the spine polyline so a 0..1 fraction maps to
// a 3D point and (by nearest-sample search) a ray maps back to a fraction.
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

function FlexiCutRings({
  plan,
  positions,
  groupRef,
  onDragStateChange,
  onCommit,
}: {
  plan: FlexiToyPlan;
  positions: Float32Array;
  groupRef: RefObject<THREE.Group | null>;
  onDragStateChange: (dragging: boolean) => void;
  onCommit: (fractions: number[]) => void;
}) {
  const { fractionToPoint } = useSpineArc(plan.spine);

  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dragFraction, setDragFraction] = useState<number | null>(null);
  const dragFractionRef = useRef<number | null>(null);
  // Mirror of draggingIndex readable from imperative handlers/listeners.
  const draggingIndexRef = useRef<number | null>(null);

  // Body silhouette radius at each cut station (max perpendicular distance of
  // nearby vertices from the joint centre) so the ring hugs the body outline.
  const ringRadii = useMemo(() => {
    const vertexCount = positions.length / 3;
    const step = Math.max(1, Math.floor(vertexCount / RING_RADIUS_SAMPLE_CAP));
    const slabHalf = 3;
    const v = new THREE.Vector3();
    return plan.joints.map((joint) => {
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
  }, [plan.joints, positions]);

  useEffect(
    () => () => {
      document.body.style.cursor = 'auto';
    },
    [],
  );

  const zAxis = useMemo(() => new THREE.Vector3(0, 0, 1), []);

  // Single commit/teardown path, safe to call more than once (the ref guard
  // makes the second call a no-op). Used by the ring's own pointerup AND by the
  // window fallback below, so a release anywhere still ends the drag.
  const commitDrag = useCallback(() => {
    const index = draggingIndexRef.current;
    if (index === null) return;
    draggingIndexRef.current = null;
    const fractions = plan.joints.map((joint) => joint.spineFraction);
    fractions[index] = dragFractionRef.current ?? fractions[index];
    dragFractionRef.current = null;
    setDraggingIndex(null);
    setDragFraction(null);
    onDragStateChange(false);
    document.body.style.cursor = 'auto';
    onCommit(fractions);
  }, [plan.joints, onCommit, onDragStateChange]);

  // r3f only dispatches onPointerUp when the ray is still over the (moving)
  // ring, so a release off the ring would otherwise leave the drag stuck with
  // OrbitControls disabled. A window listener guarantees the drag always ends.
  useEffect(() => {
    if (draggingIndex === null) return;
    const handle = () => commitDrag();
    window.addEventListener('pointerup', handle);
    window.addEventListener('pointercancel', handle);
    return () => {
      window.removeEventListener('pointerup', handle);
      window.removeEventListener('pointercancel', handle);
    };
  }, [draggingIndex, commitDrag]);

  const beginDrag = (index: number, e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    try {
      (
        e.target as unknown as { setPointerCapture?: (id: number) => void }
      ).setPointerCapture?.(e.pointerId);
    } catch {
      // Pointer capture is best-effort; ignore environments that reject it.
    }
    const start = plan.joints[index].spineFraction;
    dragFractionRef.current = start;
    draggingIndexRef.current = index;
    setDragFraction(start);
    setDraggingIndex(index);
    onDragStateChange(true);
    document.body.style.cursor = 'grabbing';
  };

  const moveDrag = (index: number, e: ThreeEvent<PointerEvent>) => {
    if (draggingIndex !== index || !groupRef.current) return;
    e.stopPropagation();
    // The ray is in world space; bring it into the (Stage-transformed) group's
    // local space so it lines up with the spine polyline coordinates.
    const inverse = new THREE.Matrix4()
      .copy(groupRef.current.matrixWorld)
      .invert();
    const localRay = e.ray.clone().applyMatrix4(inverse);

    const SAMPLES = 240;
    let best = Infinity;
    let bestF = plan.joints[index].spineFraction;
    for (let k = 0; k <= SAMPLES; k += 1) {
      const f = k / SAMPLES;
      const d = localRay.distanceToPoint(fractionToPoint(f));
      if (d < best) {
        best = d;
        bestF = f;
      }
    }

    // Keep the dragged cut ordered strictly between its neighbours.
    const margin = 0.01;
    const lower =
      (index > 0 ? plan.joints[index - 1].spineFraction : 0) + margin;
    const upper =
      (index < plan.joints.length - 1
        ? plan.joints[index + 1].spineFraction
        : 1) - margin;
    const clamped = clamp(bestF, Math.max(0.02, lower), Math.min(0.98, upper));
    dragFractionRef.current = clamped;
    setDragFraction(clamped);
  };

  const endDrag = (index: number, e: ThreeEvent<PointerEvent>) => {
    if (draggingIndexRef.current !== index) return;
    e.stopPropagation();
    try {
      (
        e.target as unknown as { releasePointerCapture?: (id: number) => void }
      ).releasePointerCapture?.(e.pointerId);
    } catch {
      // Best-effort release; ignore environments that reject it.
    }
    commitDrag();
  };

  return (
    <group ref={groupRef}>
      {plan.joints.map((joint, index) => {
        const isDragged = draggingIndex === index;
        const center =
          isDragged && dragFraction !== null
            ? fractionToPoint(dragFraction)
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
        const radius = ringRadii[index] ?? 6;
        const tube = clamp(radius * 0.05, 0.5, 1.6);
        const highlighted = isDragged || hoverIndex === index;
        const color = joint.fused
          ? highlighted
            ? RING_AMBER_HOVER
            : RING_AMBER
          : highlighted
            ? RING_BLUE_HOVER
            : RING_BLUE;

        return (
          <mesh
            key={index}
            name={`flexi-ring-${index}`}
            position={center}
            quaternion={quaternion}
            onPointerOver={(e) => {
              e.stopPropagation();
              setHoverIndex(index);
              if (draggingIndex === null) document.body.style.cursor = 'grab';
            }}
            onPointerOut={() => {
              if (draggingIndex === null) {
                setHoverIndex(null);
                document.body.style.cursor = 'auto';
              }
            }}
            onPointerDown={(e) => beginDrag(index, e)}
            onPointerMove={(e) => moveDrag(index, e)}
            onPointerUp={(e) => endDrag(index, e)}
          >
            <torusGeometry args={[radius, tube, 10, 44]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={highlighted ? 0.5 : 0.18}
              roughness={0.35}
              metalness={0.1}
            />
          </mesh>
        );
      })}
    </group>
  );
}

function PillButton({
  active,
  onClick,
  children,
  className,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-adam-blue bg-adam-blue/10 text-adam-blue'
          : 'border-adam-neutral-700 text-adam-text-secondary hover:border-adam-neutral-500',
        className,
      )}
    >
      {children}
    </button>
  );
}

function StyleCard({
  selected,
  title,
  description,
  onSelect,
}: {
  selected: boolean;
  title: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'flex flex-1 flex-col gap-1 rounded-lg border p-3 text-left transition-colors',
        selected
          ? 'border-adam-blue bg-adam-blue/10 ring-1 ring-adam-blue'
          : 'border-adam-neutral-700 hover:border-adam-neutral-500',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'flex h-4 w-4 items-center justify-center rounded-full border',
            selected
              ? 'border-adam-blue bg-adam-blue'
              : 'border-adam-neutral-500',
          )}
        >
          {selected ? (
            <span className="h-1.5 w-1.5 rounded-full bg-white" />
          ) : null}
        </span>
        <span className="text-sm font-medium">{title}</span>
      </div>
      <p className="text-xs text-adam-text-secondary">{description}</p>
    </button>
  );
}

function ControlLabel({ label, value }: { label: string; value?: ReactNode }) {
  return (
    <div className="mb-1 flex items-baseline justify-between gap-2">
      <label className="text-sm font-medium">{label}</label>
      {value !== undefined ? (
        <span className="text-xs text-adam-text-secondary">{value}</span>
      ) : null}
    </div>
  );
}

export function FlexiToyDialog({
  open,
  onOpenChange,
  gltf,
  filenameBase,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gltf: GLTF;
  filenameBase: string;
}) {
  const { toast } = useToast();

  const [segmentMode, setSegmentMode] = useState<'auto' | 'custom'>('auto');
  const [segmentCountCustom, setSegmentCountCustom] = useState(8);
  // Loose is the default fit — flexi toys read best with visibly free joints.
  const [clearanceMm, setClearanceMm] = useState<number>(
    FLEXI_CLEARANCE_PRESETS.loose,
  );
  const [showAdvancedFit, setShowAdvancedFit] = useState(false);
  const [targetLengthMm, setTargetLengthMm] = useState(FLEXI_DEFAULT_LENGTH_MM);
  const [lengthInitialized, setLengthInitialized] = useState(false);
  const [jointScale, setJointScale] = useState(1);
  const [bendAngleDeg, setBendAngleDeg] = useState(FLEXI_DEFAULT_BEND_DEG);
  const [jointStyle, setJointStyle] = useState<FlexiJointStyle>(
    FLEXI_DEFAULT_JOINT_STYLE,
  );
  const [axisOverride, setAxisOverride] = useState<FlexiAxisOverride>('auto');
  // User-dragged cut stations (arc-length fractions); null = even spacing.
  const [jointPositions, setJointPositions] = useState<number[] | null>(null);

  const [showOriginalColors, setShowOriginalColors] = useState(false);
  const [isRingDragging, setIsRingDragging] = useState(false);
  const ringGroupRef = useRef<THREE.Group | null>(null);
  const [result, setResult] = useState<FlexiToyResult | null>(null);
  const [isComputing, setIsComputing] = useState(false);
  const [errorInfo, setErrorInfo] = useState<{
    code: FlexiToyErrorCode;
    message: string;
  } | null>(null);
  const [isDownloading, setIsDownloading] = useState<'stl' | '3mf' | null>(
    null,
  );

  // The printable-processed scene and its derived mesh input are expensive, so
  // they are built once per gltf behind shared promises: overlapping computes
  // await the same work instead of each rebuilding (and leaking) their own.
  const processedSceneRef = useRef<{
    forGltf: GLTF;
    promise: Promise<THREE.Scene>;
  } | null>(null);
  const meshInputRef = useRef<{
    forGltf: GLTF;
    promise: Promise<FlexiMeshInput>;
  } | null>(null);
  const resultCacheRef = useRef(new Map<string, FlexiToyResult>());
  const computeTokenRef = useRef(0);

  const ensureMeshInput = useCallback((g: GLTF): Promise<FlexiMeshInput> => {
    if (meshInputRef.current?.forGltf !== g) {
      processedSceneRef.current?.promise.then(disposeScene).catch(() => {});
      const scenePromise = processUserModelForDownload(g);
      processedSceneRef.current = { forGltf: g, promise: scenePromise };
      meshInputRef.current = {
        forGltf: g,
        promise: scenePromise.then((scene) => sceneToFlexiMeshInput(scene)),
      };
    }
    return meshInputRef.current.promise;
  }, []);

  useEffect(
    () => () => {
      processedSceneRef.current?.promise.then(disposeScene).catch(() => {});
      processedSceneRef.current = null;
      meshInputRef.current = null;
    },
    [],
  );

  const settings = useMemo<FlexiToySettings>(() => {
    const base: FlexiToySettings = {
      segmentCount: segmentMode === 'auto' ? 'auto' : segmentCountCustom,
      clearanceMm,
      targetLengthMm,
      jointScale,
      axisOverride,
      jointStyle,
      bendAngleDeg,
    };
    // Only send dragged stations once the count is pinned to a number, per the
    // contract (jointPositions length must equal segmentCount − 1).
    if (jointPositions && segmentMode === 'custom') {
      return { ...base, jointPositions };
    }
    return base;
  }, [
    segmentMode,
    segmentCountCustom,
    clearanceMm,
    targetLengthMm,
    jointScale,
    axisOverride,
    jointStyle,
    bendAngleDeg,
    jointPositions,
  ]);

  const settingsKey = `${settings.segmentCount}|${settings.clearanceMm}|${settings.targetLengthMm}|${settings.jointScale}|${settings.axisOverride}|${settings.jointStyle}|${settings.bendAngleDeg}|${
    settings.jointPositions
      ? settings.jointPositions.map((f) => f.toFixed(3)).join(',')
      : ''
  }`;

  // Fresh session each time the dialog opens: reset the controls, derive the
  // suggested toy length from the model, then unblock the compute effect.
  useEffect(() => {
    if (!open || !gltf) {
      return;
    }

    setSegmentMode('auto');
    setSegmentCountCustom(8);
    setClearanceMm(FLEXI_CLEARANCE_PRESETS.loose);
    setShowAdvancedFit(false);
    setJointScale(1);
    setBendAngleDeg(FLEXI_DEFAULT_BEND_DEG);
    setJointStyle(FLEXI_DEFAULT_JOINT_STYLE);
    setAxisOverride('auto');
    setJointPositions(null);
    setShowOriginalColors(false);
    setIsRingDragging(false);
    setErrorInfo(null);

    if (meshInputRef.current?.forGltf !== gltf) {
      resultCacheRef.current.clear();
      setResult(null);
    }
    setLengthInitialized(false);

    let cancelled = false;
    ensureMeshInput(gltf)
      .then((input) => {
        if (cancelled) {
          return;
        }
        const current = deriveCurrentLengthMm(input);
        const suggested = clamp(
          Math.round(Math.max(current, FLEXI_DEFAULT_LENGTH_MM)),
          FLEXI_MIN_LENGTH_MM,
          FLEXI_MAX_LENGTH_MM,
        );
        setTargetLengthMm(suggested);
        setLengthInitialized(true);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        Sentry.captureException(error, {
          extra: { context: 'flexi toy length derivation' },
        });
        setTargetLengthMm(FLEXI_DEFAULT_LENGTH_MM);
        setLengthInitialized(true);
      });

    return () => {
      cancelled = true;
    };
  }, [open, gltf, ensureMeshInput]);

  // Debounced recompute. Rapid control changes collapse to a single compute
  // after the debounce; a compute token discards any stale result that lands
  // after a newer request, and a per-settings cache skips repeated work.
  useEffect(() => {
    if (!open || !gltf || !lengthInitialized) {
      return;
    }

    const cached = resultCacheRef.current.get(settingsKey);
    if (cached) {
      // Refresh recency (delete + re-insert moves the key to the newest slot).
      resultCacheRef.current.delete(settingsKey);
      resultCacheRef.current.set(settingsKey, cached);
      computeTokenRef.current += 1;
      setResult(cached);
      setIsComputing(false);
      setErrorInfo(null);
      return;
    }

    const token = ++computeTokenRef.current;
    setIsComputing(true);
    setErrorInfo(null);

    const timeout = window.setTimeout(async () => {
      try {
        const input = await ensureMeshInput(gltf);
        const outcome = await computeFlexiToy(input, settings);

        if (computeTokenRef.current !== token) {
          return;
        }
        if (outcome.status === 'superseded') {
          return;
        }
        if (outcome.status === 'error') {
          setErrorInfo({ code: outcome.code, message: outcome.message });
          return;
        }

        // Cache newest-last and evict the oldest entries beyond the cap — each
        // entry holds full-toy typed arrays (megabytes), so an unbounded cache
        // (e.g. scrubbing the length slider) would balloon memory.
        const cache = resultCacheRef.current;
        cache.delete(settingsKey);
        cache.set(settingsKey, outcome.result);
        while (cache.size > FLEXI_RESULT_CACHE_LIMIT) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) {
            break;
          }
          cache.delete(oldest);
        }
        setResult(outcome.result);
      } catch (error) {
        if (computeTokenRef.current !== token) {
          return;
        }
        Sentry.captureException(error, {
          extra: { context: 'flexi toy compute', settings },
        });
        setErrorInfo({
          code: 'compute-failed',
          message: FLEXI_ERROR_COPY['compute-failed'].body,
        });
      } finally {
        if (computeTokenRef.current === token) {
          setIsComputing(false);
        }
      }
    }, RECOMPUTE_DEBOUNCE_MS);

    return () => window.clearTimeout(timeout);
  }, [open, gltf, lengthInitialized, settingsKey, settings, ensureMeshInput]);

  const activePreset = useMemo<FlexiClearancePreset | null>(() => {
    const match = CLEARANCE_PRESET_ORDER.find(
      (preset) =>
        Math.abs(FLEXI_CLEARANCE_PRESETS[preset] - clearanceMm) < 1e-6,
    );
    return match ?? null;
  }, [clearanceMm]);

  // Dedup warnings by their rendered message so repeated per-joint codes read
  // as one friendly line.
  const warningMessages = useMemo(() => {
    const seen = new Set<string>();
    const messages: string[] = [];
    for (const warning of result?.warnings ?? []) {
      if (!seen.has(warning.message)) {
        seen.add(warning.message);
        messages.push(warning.message);
      }
    }
    return messages;
  }, [result]);

  const totalJoints = result ? result.jointCount + result.fusedJointCount : 0;

  // Changing where/how many cuts there are invalidates any dragged stations
  // (their count and spine placement no longer apply), so these clear them.
  const changeLength = (value: number) => {
    setTargetLengthMm(value);
    setJointPositions(null);
  };

  const handleLengthInput = (raw: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      return;
    }
    changeLength(
      clamp(Math.round(parsed), FLEXI_MIN_LENGTH_MM, FLEXI_MAX_LENGTH_MM),
    );
  };

  const changeAxis = (value: FlexiAxisOverride) => {
    setAxisOverride(value);
    setJointPositions(null);
  };

  const useAutoSegments = () => {
    setSegmentMode('auto');
    setJointPositions(null);
  };

  const useCustomSegments = () => {
    setSegmentCountCustom((count) =>
      clamp(
        result?.segmentCount ?? count,
        FLEXI_MIN_SEGMENTS,
        FLEXI_MAX_SEGMENTS,
      ),
    );
    setSegmentMode('custom');
  };

  const changeSegmentCount = (value: number) => {
    setSegmentCountCustom(value);
    setJointPositions(null);
  };

  // On drag release: pin the count (so the fractions array has a fixed length)
  // and store the dragged stations; the debounce then recomputes with them.
  // Pin from the committed array itself — the contract requires
  // jointPositions.length === segmentCount − 1, and stations = planned pieces −
  // 1 = fractions.length. (result.segmentCount is the BODY count, which is
  // smaller whenever a joint is fused, so it must not be used here.)
  const handleRingCommit = (fractions: number[]) => {
    if (segmentMode === 'auto') {
      setSegmentCountCustom(
        clamp(fractions.length + 1, FLEXI_MIN_SEGMENTS, FLEXI_MAX_SEGMENTS),
      );
      setSegmentMode('custom');
    }
    setJointPositions(fractions);
  };

  const handleDownload = async (format: 'stl' | '3mf') => {
    if (!result) {
      return;
    }

    posthog.capture('flexi_toy_downloaded', {
      format,
      segments: result.segmentCount,
      clearance_mm: clearanceMm,
      length_mm: result.lengthMm,
    });

    setIsDownloading(format);
    try {
      const blob =
        format === 'stl'
          ? await flexiResultToStlBlob(result)
          : await flexiResultToThreeMfBlob(result, filenameBase);

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${filenameBase}-flexi.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      Sentry.captureException(error, {
        extra: { context: 'flexi toy download', format },
      });
      toast({
        title: 'Error',
        description: `Failed to prepare the flexi toy ${format.toUpperCase()} file.`,
        variant: 'destructive',
      });
    } finally {
      setIsDownloading(null);
    }
  };

  // errorInfo must gate downloads too: a compute can fail while a previous
  // successful `result` is still held, and the buttons must not export that
  // stale geometry (nor log the current slider values against it).
  const downloadsDisabled =
    !result || isComputing || isDownloading !== null || errorInfo !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-3xl overflow-y-auto text-adam-text-primary">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Worm className="h-5 w-5 text-adam-blue" />
            Flexi Toy Maker
            <span className="rounded bg-adam-blue/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-adam-blue">
              Beta
            </span>
          </DialogTitle>
          <DialogDescription>
            Turn this model into a print-in-place bendy toy. We slice the body
            into segments linked by captive ball joints — preview it, then
            download ready to print.
          </DialogDescription>
        </DialogHeader>

        <div className="relative h-72 overflow-hidden rounded-md border border-adam-neutral-700 bg-adam-neutral-950 sm:h-96">
          {result && result.positions.length > 0 && !errorInfo ? (
            <Canvas dpr={[1, 2]} camera={{ fov: 45 }}>
              <Environment preset="city" />
              <Stage
                environment={null}
                adjustCamera={1.4}
                intensity={0.5}
                shadows={false}
              >
                <FlexiToyPreview
                  result={result}
                  showOriginalColors={showOriginalColors}
                />
                <FlexiCutRings
                  plan={result.plan}
                  positions={result.positions}
                  groupRef={ringGroupRef}
                  onDragStateChange={setIsRingDragging}
                  onCommit={handleRingCommit}
                />
              </Stage>
              <OrbitControls
                makeDefault
                enablePan
                enabled={!isRingDragging}
                mouseButtons={{
                  LEFT: THREE.MOUSE.ROTATE,
                  MIDDLE: THREE.MOUSE.PAN,
                  RIGHT: THREE.MOUSE.PAN,
                }}
              />
            </Canvas>
          ) : null}

          {result && !errorInfo ? (
            <label className="absolute right-2 top-2 flex cursor-pointer items-center gap-2 rounded-md bg-adam-neutral-950/70 px-2 py-1 text-xs text-adam-text-secondary backdrop-blur">
              Show original colors
              <Switch
                checked={showOriginalColors}
                onCheckedChange={setShowOriginalColors}
              />
            </label>
          ) : null}

          {isComputing ? (
            <div className="absolute inset-0 flex items-center justify-center gap-2 bg-adam-neutral-950/60 text-sm text-adam-text-secondary">
              <Loader2 className="h-4 w-4 animate-spin text-adam-blue" />
              Building your flexi toy…
            </div>
          ) : null}

          {errorInfo ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
              <AlertTriangle className="h-6 w-6 text-amber-400" />
              <p className="text-sm font-medium text-adam-text-primary">
                {FLEXI_ERROR_COPY[errorInfo.code].title}
              </p>
              <p className="max-w-md text-xs text-adam-text-secondary">
                {FLEXI_ERROR_COPY[errorInfo.code].body}
              </p>
              {errorInfo.code === 'rounded-uncut' ? (
                <Button
                  size="sm"
                  className="mt-1"
                  onClick={() => setJointStyle('classic')}
                >
                  Switch to Classic
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>

        {result && !errorInfo ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-adam-text-secondary/70">
              Drag a ring to move that cut.
            </span>
            {jointPositions ? (
              <button
                type="button"
                onClick={() => setJointPositions(null)}
                className="text-xs text-adam-blue hover:underline"
              >
                Even spacing
              </button>
            ) : null}
          </div>
        ) : null}

        <div>
          <label className="mb-1 block text-sm font-medium">Joint style</label>
          <div
            role="radiogroup"
            aria-label="Joint style"
            className="flex flex-col gap-2 sm:flex-row"
          >
            <StyleCard
              selected={jointStyle === 'shell'}
              title="Shell"
              description="Overlapping scales — joints stay hidden"
              onSelect={() => setJointStyle('shell')}
            />
            <StyleCard
              selected={jointStyle === 'rounded'}
              title="Rounded"
              description="Bends further — smooth, rounded grooves"
              onSelect={() => setJointStyle('rounded')}
            />
            <StyleCard
              selected={jointStyle === 'classic'}
              title="Classic"
              description="Flat ring gaps — classic lure look"
              onSelect={() => setJointStyle('classic')}
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <ControlLabel label="Segments" />
            <div
              role="radiogroup"
              aria-label="Segment count mode"
              className="flex items-center gap-2"
            >
              <PillButton
                active={segmentMode === 'auto'}
                onClick={useAutoSegments}
              >
                Auto
              </PillButton>
              <PillButton
                active={segmentMode === 'custom'}
                onClick={useCustomSegments}
              >
                Custom
              </PillButton>
              {segmentMode === 'custom' ? (
                <span className="ml-auto text-xs text-adam-text-secondary">
                  {segmentCountCustom} segments
                </span>
              ) : null}
            </div>
            {segmentMode === 'custom' ? (
              <Slider
                className="mt-2"
                value={[segmentCountCustom]}
                min={FLEXI_MIN_SEGMENTS}
                max={FLEXI_MAX_SEGMENTS}
                step={1}
                defaultValue={[8]}
                onValueChange={([value]) => changeSegmentCount(value)}
              />
            ) : (
              <p className="mt-2 text-xs text-adam-text-secondary/80">
                We pick the number of segments to fit the model.
              </p>
            )}
          </div>

          <div>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <label className="text-sm font-medium">Joint fit</label>
              <button
                type="button"
                onClick={() => setShowAdvancedFit((prev) => !prev)}
                className="text-xs text-adam-blue hover:underline"
              >
                {showAdvancedFit ? 'Hide advanced' : 'Advanced'}
              </button>
            </div>
            <div
              role="radiogroup"
              aria-label="Joint fit preset"
              className="flex items-center gap-2"
            >
              {CLEARANCE_PRESET_ORDER.map((preset) => (
                <PillButton
                  key={preset}
                  active={activePreset === preset}
                  onClick={() =>
                    setClearanceMm(FLEXI_CLEARANCE_PRESETS[preset])
                  }
                >
                  {CLEARANCE_PRESET_LABELS[preset]}
                </PillButton>
              ))}
            </div>
            {showAdvancedFit ? (
              <div className="mt-2">
                <div className="mb-1 flex items-baseline justify-between">
                  <span className="text-xs text-adam-text-secondary">
                    Joint gap
                  </span>
                  <span className="text-xs text-adam-text-secondary">
                    {clearanceMm.toFixed(2)} mm
                  </span>
                </div>
                <Slider
                  value={[clearanceMm]}
                  min={FLEXI_MIN_CLEARANCE_MM}
                  max={FLEXI_MAX_CLEARANCE_MM}
                  step={0.05}
                  defaultValue={[FLEXI_CLEARANCE_PRESETS.standard]}
                  onValueChange={([value]) =>
                    setClearanceMm(Number(value.toFixed(2)))
                  }
                />
              </div>
            ) : (
              <p className="mt-2 text-xs text-adam-text-secondary/80">
                Tighter grips firmly; looser moves more freely.
              </p>
            )}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <label className="text-sm font-medium">Toy length</label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min={FLEXI_MIN_LENGTH_MM}
                  max={FLEXI_MAX_LENGTH_MM}
                  value={targetLengthMm}
                  onChange={(event) => handleLengthInput(event.target.value)}
                  className="w-16 rounded-md border border-adam-neutral-700 bg-transparent px-2 py-1 text-right text-xs text-adam-text-primary focus:border-adam-blue focus:outline-none"
                />
                <span className="text-xs text-adam-text-secondary">mm</span>
              </div>
            </div>
            <Slider
              value={[targetLengthMm]}
              min={FLEXI_MIN_LENGTH_MM}
              max={FLEXI_MAX_LENGTH_MM}
              step={5}
              defaultValue={[FLEXI_DEFAULT_LENGTH_MM]}
              onValueChange={([value]) => changeLength(value)}
            />
          </div>

          <div>
            <ControlLabel
              label="Joint size"
              value={`${jointScale.toFixed(2)}×`}
            />
            <Slider
              value={[jointScale]}
              min={FLEXI_MIN_JOINT_SCALE}
              max={FLEXI_MAX_JOINT_SCALE}
              step={0.05}
              defaultValue={[1]}
              onValueChange={([value]) =>
                setJointScale(Number(value.toFixed(2)))
              }
            />
            <p className="mt-1 text-xs text-adam-text-secondary/80">
              Chunkier or slimmer joints.
            </p>
          </div>

          <div>
            <ControlLabel label="Flexibility" value={`${bendAngleDeg}°`} />
            <Slider
              value={[bendAngleDeg]}
              min={FLEXI_MIN_BEND_DEG}
              max={FLEXI_MAX_BEND_DEG}
              step={1}
              defaultValue={[FLEXI_DEFAULT_BEND_DEG]}
              onValueChange={([value]) => setBendAngleDeg(Math.round(value))}
            />
            <p className="mt-1 text-xs text-adam-text-secondary/80">
              {jointStyle === 'classic'
                ? 'How wide the gaps are — classic joints bend less.'
                : 'How far each joint can bend.'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-adam-text-secondary">Spine axis</span>
          <div
            role="radiogroup"
            aria-label="Spine axis"
            className="flex items-center gap-1.5"
          >
            {AXIS_OPTIONS.map((option) => (
              <PillButton
                key={option.value}
                active={axisOverride === option.value}
                onClick={() => changeAxis(option.value)}
                className="px-2 py-0.5"
              >
                {option.label}
              </PillButton>
            ))}
          </div>
          <span className="text-[11px] text-adam-text-secondary/70">
            Only change if the split runs the wrong way.
          </span>
        </div>

        {result && !errorInfo ? (
          <div className="text-xs text-adam-text-secondary">
            <span className="font-medium text-adam-text-primary">
              {result.segmentCount}
            </span>{' '}
            segments ·{' '}
            <span className="font-medium text-adam-text-primary">
              {totalJoints}
            </span>{' '}
            joints
            {result.fusedJointCount > 0
              ? ` (${result.fusedJointCount} fused)`
              : ''}{' '}
            · {Math.round(result.lengthMm)} mm
          </div>
        ) : null}

        {warningMessages.length > 0 && !errorInfo ? (
          <ul className="space-y-1">
            {warningMessages.map((message) => (
              <li
                key={message}
                className="flex items-start gap-1.5 text-xs text-amber-400"
              >
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{message}</span>
              </li>
            ))}
          </ul>
        ) : null}

        <p className="text-[11px] text-adam-text-secondary/70">
          Prints in place — no supports. 0.2 mm layers, 2–3 walls, no infill
          recommended.
        </p>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={isDownloading !== null}
          >
            Close
          </Button>
          <Button
            variant="outline"
            onClick={() => handleDownload('stl')}
            disabled={downloadsDisabled}
          >
            {isDownloading === 'stl' ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            .STL
          </Button>
          <Button
            onClick={() => handleDownload('3mf')}
            disabled={downloadsDisabled}
          >
            {isDownloading === '3mf' ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            .3MF
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
