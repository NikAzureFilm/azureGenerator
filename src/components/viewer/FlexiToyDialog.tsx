import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import * as THREE from 'three';
import { GLTF } from 'three-stdlib';
import { Canvas } from '@react-three/fiber';
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
  FLEXI_DEFAULT_LENGTH_MM,
  FLEXI_MAX_CLEARANCE_MM,
  FLEXI_MAX_JOINT_SCALE,
  FLEXI_MAX_LENGTH_MM,
  FLEXI_MAX_SEGMENTS,
  FLEXI_MIN_CLEARANCE_MM,
  FLEXI_MIN_JOINT_SCALE,
  FLEXI_MIN_LENGTH_MM,
  FLEXI_MIN_SEGMENTS,
  type FlexiAxisOverride,
  type FlexiClearancePreset,
  type FlexiMeshInput,
  type FlexiToyErrorCode,
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
  const [clearanceMm, setClearanceMm] = useState<number>(
    FLEXI_CLEARANCE_PRESETS.standard,
  );
  const [showAdvancedFit, setShowAdvancedFit] = useState(false);
  const [targetLengthMm, setTargetLengthMm] = useState(FLEXI_DEFAULT_LENGTH_MM);
  const [lengthInitialized, setLengthInitialized] = useState(false);
  const [jointScale, setJointScale] = useState(1);
  const [axisOverride, setAxisOverride] = useState<FlexiAxisOverride>('auto');

  const [showOriginalColors, setShowOriginalColors] = useState(false);
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

  const settings = useMemo<FlexiToySettings>(
    () => ({
      segmentCount: segmentMode === 'auto' ? 'auto' : segmentCountCustom,
      clearanceMm,
      targetLengthMm,
      jointScale,
      axisOverride,
    }),
    [
      segmentMode,
      segmentCountCustom,
      clearanceMm,
      targetLengthMm,
      jointScale,
      axisOverride,
    ],
  );

  const settingsKey = `${settings.segmentCount}|${settings.clearanceMm}|${settings.targetLengthMm}|${settings.jointScale}|${settings.axisOverride}`;

  // Fresh session each time the dialog opens: reset the controls, derive the
  // suggested toy length from the model, then unblock the compute effect.
  useEffect(() => {
    if (!open || !gltf) {
      return;
    }

    setSegmentMode('auto');
    setSegmentCountCustom(8);
    setClearanceMm(FLEXI_CLEARANCE_PRESETS.standard);
    setShowAdvancedFit(false);
    setJointScale(1);
    setAxisOverride('auto');
    setShowOriginalColors(false);
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

  const handleLengthInput = (raw: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      return;
    }
    setTargetLengthMm(
      clamp(Math.round(parsed), FLEXI_MIN_LENGTH_MM, FLEXI_MAX_LENGTH_MM),
    );
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
              </Stage>
              <OrbitControls
                makeDefault
                enablePan
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
            </div>
          ) : null}
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
                onClick={() => setSegmentMode('auto')}
              >
                Auto
              </PillButton>
              <PillButton
                active={segmentMode === 'custom'}
                onClick={() => {
                  setSegmentCountCustom((count) =>
                    clamp(
                      result?.segmentCount ?? count,
                      FLEXI_MIN_SEGMENTS,
                      FLEXI_MAX_SEGMENTS,
                    ),
                  );
                  setSegmentMode('custom');
                }}
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
                onValueChange={([value]) => setSegmentCountCustom(value)}
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

        <div className="grid gap-4 sm:grid-cols-2">
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
              onValueChange={([value]) => setTargetLengthMm(value)}
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
                onClick={() => setAxisOverride(option.value)}
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
