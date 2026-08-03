import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTF } from 'three-stdlib';
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
import {
  FlexiPreviewCanvas,
  type FlexiDragState,
} from './flexiToy/FlexiPreviewCanvas';
import { FlexiJointStrip } from './flexiToy/FlexiJointStrip';
import {
  ControlLabel,
  PillButton,
  StyleCard,
} from './flexiToy/FlexiControlPrimitives';
import {
  AXIS_OPTIONS,
  CLEARANCE_PRESET_LABELS,
  CLEARANCE_PRESET_ORDER,
  DEFAULT_JOINT_STYLE,
  FLEXI_ERROR_COPY,
  SHELL_DEFAULTS,
  clamp,
  type FlexiUiJointStyle,
} from './flexiToy/flexiToyUi';

const RECOMPUTE_DEBOUNCE_MS = 350;

// Each cached result holds full-toy typed arrays, so keep only the most
// recently used handful (insertion-order LRU over the Map).
const FLEXI_RESULT_CACHE_LIMIT = 12;

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

  const [segmentMode, setSegmentMode] = useState<'auto' | 'custom'>(
    SHELL_DEFAULTS.segmentMode,
  );
  const [segmentCountCustom, setSegmentCountCustom] = useState(
    SHELL_DEFAULTS.segmentCountCustom,
  );
  const [clearanceMm, setClearanceMm] = useState<number>(
    SHELL_DEFAULTS.clearanceMm,
  );
  const [showAdvancedFit, setShowAdvancedFit] = useState(false);
  const [targetLengthMm, setTargetLengthMm] = useState(
    SHELL_DEFAULTS.targetLengthMm,
  );
  const [jointScale, setJointScale] = useState(SHELL_DEFAULTS.jointScale);
  const [bendAngleDeg, setBendAngleDeg] = useState(SHELL_DEFAULTS.bendAngleDeg);
  const [jointStyle, setJointStyle] =
    useState<FlexiUiJointStyle>(DEFAULT_JOINT_STYLE);
  const [axisOverride, setAxisOverride] = useState<FlexiAxisOverride>(
    SHELL_DEFAULTS.axisOverride,
  );
  // User-dragged cut stations (arc-length fractions); null = even spacing.
  const [jointPositions, setJointPositions] = useState<number[] | null>(
    SHELL_DEFAULTS.jointPositions,
  );
  // Incremented whenever the dialog itself rewrites the stations, so the strip
  // can discard a keyboard commit that is still waiting on its debounce.
  const [stationEditToken, setStationEditToken] = useState(0);

  const [showOriginalColors, setShowOriginalColors] = useState(
    SHELL_DEFAULTS.showOriginalColors,
  );
  // Strip interaction state. `dragState` doubles as the live position of the
  // matching 3D ring while a handle is being moved.
  const [hoverJointIndex, setHoverJointIndex] = useState<number | null>(null);
  const [dragState, setDragState] = useState<FlexiDragState>(null);

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

  // Fresh session each time the dialog opens: every control goes back to the
  // shell defaults (no length derivation — the defaults are constants), and the
  // expensive mesh input is warmed in the background so the first compute does
  // not pay for it.
  useEffect(() => {
    if (!open || !gltf) {
      return;
    }

    setSegmentMode(SHELL_DEFAULTS.segmentMode);
    setSegmentCountCustom(SHELL_DEFAULTS.segmentCountCustom);
    setClearanceMm(SHELL_DEFAULTS.clearanceMm);
    setShowAdvancedFit(false);
    setTargetLengthMm(SHELL_DEFAULTS.targetLengthMm);
    setJointScale(SHELL_DEFAULTS.jointScale);
    setBendAngleDeg(SHELL_DEFAULTS.bendAngleDeg);
    setJointStyle(DEFAULT_JOINT_STYLE);
    setAxisOverride(SHELL_DEFAULTS.axisOverride);
    setJointPositions(SHELL_DEFAULTS.jointPositions);
    setStationEditToken((token) => token + 1);
    setShowOriginalColors(SHELL_DEFAULTS.showOriginalColors);
    setHoverJointIndex(null);
    setDragState(null);
    setErrorInfo(null);

    if (meshInputRef.current?.forGltf !== gltf) {
      resultCacheRef.current.clear();
      setResult(null);
    }

    // Fire-and-forget warm-up: failures surface through the compute effect,
    // which awaits the same shared promise.
    ensureMeshInput(gltf).catch(() => {});
  }, [open, gltf, ensureMeshInput]);

  // Debounced recompute. Rapid control changes collapse to a single compute
  // after the debounce; a compute token discards any stale result that lands
  // after a newer request, and a per-settings cache skips repeated work.
  useEffect(() => {
    if (!open || !gltf) {
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
  }, [open, gltf, settingsKey, settings, ensureMeshInput]);

  // A landed result carries the planner's own station placement, so any live
  // drag offset has served its purpose.
  useEffect(() => {
    setDragState(null);
  }, [result]);

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
  const highlightIndex = dragState ? dragState.index : hoverJointIndex;

  // Changing where/how many cuts there are invalidates any dragged stations
  // (their count and spine placement no longer apply), so these clear them.
  // The token bump tells the strip to drop a keyboard commit still waiting on
  // its debounce — otherwise it would land afterwards and re-pin the stations
  // we just cleared.
  const clearPinnedPositions = useCallback(() => {
    setJointPositions(null);
    setStationEditToken((token) => token + 1);
  }, []);

  const changeLength = (value: number) => {
    setTargetLengthMm(value);
    clearPinnedPositions();
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
    clearPinnedPositions();
  };

  const useAutoSegments = () => {
    setSegmentMode('auto');
    clearPinnedPositions();
  };

  const useCustomSegments = () => {
    // Already the active mode: re-clicking the pill must not disturb the
    // pinned count or the user's dragged stations.
    if (segmentMode === 'custom') {
      return;
    }
    setSegmentCountCustom((count) =>
      clamp(
        // Seed from the pieces the PLANNER laid out, never from
        // result.segmentCount — that is the built BODY count, which is smaller
        // whenever a joint is fused, and using it would break the
        // jointPositions.length === segmentCount − 1 contract.
        result ? result.plan.joints.length + 1 : count,
        FLEXI_MIN_SEGMENTS,
        FLEXI_MAX_SEGMENTS,
      ),
    );
    setSegmentMode('custom');
    clearPinnedPositions();
  };

  const changeSegmentCount = (value: number) => {
    setSegmentCountCustom(value);
    clearPinnedPositions();
  };

  // On strip release: pin the count (so the fractions array has a fixed length)
  // and store the dragged stations; the debounce then recomputes with them.
  // Pin from the committed array itself — the contract requires
  // jointPositions.length === segmentCount − 1, and stations = planned pieces −
  // 1 = fractions.length. (result.segmentCount is the BODY count, which is
  // smaller whenever a joint is fused, so it must not be used here.) The pin
  // runs on every commit, not just from 'auto': the dialog now opens in custom
  // mode, and leaving a stale count would break the length contract whenever
  // the planner placed a different number of stations.
  const handleRingCommit = useCallback((fractions: number[]) => {
    setSegmentCountCustom(
      clamp(fractions.length + 1, FLEXI_MIN_SEGMENTS, FLEXI_MAX_SEGMENTS),
    );
    setSegmentMode('custom');
    setJointPositions(fractions);
  }, []);

  const handleStripReset = clearPinnedPositions;

  const handleDownload = async (format: 'stl' | '3mf') => {
    if (!result) {
      return;
    }

    posthog.capture('flexi_toy_downloaded', {
      format,
      segments: result.segmentCount,
      clearance_mm: clearanceMm,
      length_mm: result.lengthMm,
      joint_style: jointStyle,
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

  const hasPreviewResult = Boolean(result) && !errorInfo;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          // Mobile: a full-screen sheet that owns its own internal layout.
          'inset-0 h-[100dvh] max-h-[100dvh] w-screen max-w-none translate-x-0 translate-y-0',
          'flex flex-col gap-0 overflow-hidden rounded-none border-0 p-0',
          // sm+: back to a centred panel; lg+: wide enough for two columns.
          'sm:inset-auto sm:left-[50%] sm:top-[50%] sm:h-[min(92vh,46rem)] sm:max-h-[92vh] sm:w-[calc(100vw-3rem)] sm:max-w-2xl sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-xl sm:border sm:border-adam-neutral-700',
          'lg:max-w-5xl',
          'text-adam-text-primary',
          // The built-in close button sits over a full-bleed preview.
          '[&>button>svg]:h-5 [&>button>svg]:w-5 [&>button]:absolute [&>button]:right-3 [&>button]:top-3 [&>button]:z-30 [&>button]:flex [&>button]:h-9 [&>button]:w-9 [&>button]:items-center [&>button]:justify-center [&>button]:rounded-full [&>button]:bg-adam-neutral-900/80 [&>button]:backdrop-blur',
        )}
      >
        <DialogHeader className="shrink-0 space-y-1 border-b border-adam-neutral-800 px-4 py-3 pr-14 text-left sm:text-left">
          <DialogTitle className="flex items-center gap-2 text-base sm:text-lg">
            <Worm className="h-5 w-5 shrink-0 text-adam-blue" />
            Flexi Toy Maker
            <span className="rounded bg-adam-blue/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-adam-blue">
              Beta
            </span>
          </DialogTitle>
          <DialogDescription className="text-xs leading-snug text-adam-text-secondary sm:text-sm">
            Turn this model into a print-in-place bendy toy — preview it, then
            download ready to print.
          </DialogDescription>
        </DialogHeader>

        {/* Below lg the body is ONE scrolling column: the preview block's
            height is content-driven (preview + strip + stats + a variable
            number of warning lines), so if it could not scroll away it would
            squeeze the controls to nothing on a phone. From lg the two columns
            split and only the right one scrolls. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain lg:grid lg:grid-cols-5 lg:grid-rows-1 lg:overflow-hidden">
          {/* LEFT — preview + joints strip. Fixed on desktop; the controls
              column is the only thing that scrolls. */}
          <div className="flex shrink-0 flex-col gap-2 px-3 pt-3 lg:col-span-3 lg:min-h-0 lg:shrink lg:overflow-hidden lg:border-r lg:border-adam-neutral-800 lg:p-4">
            <div className="relative h-[40dvh] shrink-0 overflow-hidden rounded-lg border border-adam-neutral-700 bg-adam-neutral-950 lg:h-auto lg:min-h-[18rem] lg:flex-1">
              {/* Mounted once per dialog open: the WebGL context survives every
                  recompute, error and style switch. */}
              <FlexiPreviewCanvas
                result={result}
                showOriginalColors={showOriginalColors}
                highlightIndex={highlightIndex}
                dragState={dragState}
              />

              {hasPreviewResult ? (
                <label className="absolute left-2 top-2 z-20 flex min-h-[36px] cursor-pointer items-center gap-2 rounded-md bg-adam-neutral-950/70 px-2 py-1 text-xs text-adam-text-secondary backdrop-blur">
                  Show original colors
                  <Switch
                    checked={showOriginalColors}
                    onCheckedChange={setShowOriginalColors}
                  />
                </label>
              ) : null}

              {!result && !errorInfo ? (
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 text-sm text-adam-text-secondary">
                  <Loader2 className="h-4 w-4 animate-spin text-adam-blue" />
                  Building your flexi toy…
                </div>
              ) : null}

              {/* Recomputing over a live result: never dim the viewport. */}
              {result && isComputing && !errorInfo ? (
                <div className="pointer-events-none absolute bottom-2 left-2 z-20 flex items-center gap-1.5 rounded-full bg-adam-neutral-950/80 px-2.5 py-1 text-[11px] text-adam-text-secondary backdrop-blur">
                  <Loader2 className="h-3 w-3 animate-spin text-adam-blue" />
                  Updating…
                </div>
              ) : null}

              {errorInfo ? (
                <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-adam-neutral-950/95 px-6 text-center">
                  <AlertTriangle className="h-6 w-6 text-amber-400" />
                  <p className="text-sm font-medium text-adam-text-primary">
                    {FLEXI_ERROR_COPY[errorInfo.code].title}
                  </p>
                  <p className="max-w-md text-xs text-adam-text-secondary">
                    {FLEXI_ERROR_COPY[errorInfo.code].body}
                  </p>
                  {errorInfo.code === 'rounded-uncut' &&
                  jointStyle !== 'strong' ? (
                    <Button
                      size="sm"
                      className="mt-1"
                      onClick={() => setJointStyle('strong')}
                    >
                      Switch to Strong
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>

            {hasPreviewResult && result ? (
              <FlexiJointStrip
                joints={result.plan.joints}
                dragState={dragState}
                highlightIndex={highlightIndex}
                hasCustomPositions={jointPositions !== null}
                cancelToken={stationEditToken}
                onHoverChange={setHoverJointIndex}
                onDragChange={setDragState}
                onCommit={handleRingCommit}
                onReset={handleStripReset}
              />
            ) : null}

            {hasPreviewResult && result ? (
              <div className="shrink-0 text-xs text-adam-text-secondary">
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
              <ul className="max-h-24 shrink-0 space-y-1 overflow-y-auto">
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
          </div>

          {/* RIGHT — the controls. Below lg it is sized by its content and
              scrolls with the body; at lg it becomes the only scroll area. */}
          <div className="shrink-0 space-y-4 px-3 pb-4 pt-3 lg:col-span-2 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain lg:p-4">
            <div>
              <label className="mb-1 block text-sm font-medium">
                Joint style
              </label>
              <div
                role="radiogroup"
                aria-label="Joint style"
                className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-2"
              >
                <StyleCard
                  selected={jointStyle === 'shell'}
                  title="Shell"
                  description="Overlapping scales — joints stay hidden"
                  onSelect={() => setJointStyle('shell')}
                />
                <StyleCard
                  selected={jointStyle === 'strong'}
                  title="Strong"
                  description="Open gaps and a hinge bar — captive joint"
                  onSelect={() => setJointStyle('strong')}
                />
              </div>
            </div>

            <div>
              <ControlLabel label="Segments" />
              <div
                role="radiogroup"
                aria-label="Segment count mode"
                className="flex flex-wrap items-center gap-2"
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
                  className="mt-2 h-11 sm:h-8"
                  value={[segmentCountCustom]}
                  min={FLEXI_MIN_SEGMENTS}
                  max={FLEXI_MAX_SEGMENTS}
                  step={1}
                  defaultValue={[SHELL_DEFAULTS.segmentCountCustom]}
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
                className="flex flex-wrap items-center gap-2"
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
                    className="h-11 sm:h-8"
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
                className="h-11 sm:h-8"
                value={[targetLengthMm]}
                min={FLEXI_MIN_LENGTH_MM}
                max={FLEXI_MAX_LENGTH_MM}
                step={5}
                defaultValue={[SHELL_DEFAULTS.targetLengthMm]}
                onValueChange={([value]) => changeLength(value)}
              />
            </div>

            <div>
              <ControlLabel
                label="Joint size"
                value={`${jointScale.toFixed(2)}×`}
              />
              <Slider
                className="h-11 sm:h-8"
                value={[jointScale]}
                min={FLEXI_MIN_JOINT_SCALE}
                max={FLEXI_MAX_JOINT_SCALE}
                step={0.05}
                defaultValue={[SHELL_DEFAULTS.jointScale]}
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
                className="h-11 sm:h-8"
                value={[bendAngleDeg]}
                min={FLEXI_MIN_BEND_DEG}
                max={FLEXI_MAX_BEND_DEG}
                step={1}
                defaultValue={[SHELL_DEFAULTS.bendAngleDeg]}
                onValueChange={([value]) => setBendAngleDeg(Math.round(value))}
              />
              <p className="mt-1 text-xs text-adam-text-secondary/80">
                {jointStyle === 'strong'
                  ? 'How far each joint can bend. Bigger bends open the gap between segments wider.'
                  : 'How far each joint can bend.'}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-adam-text-secondary">
                Spine axis
              </span>
              <div
                role="radiogroup"
                aria-label="Spine axis"
                className="flex flex-wrap items-center gap-1.5"
              >
                {AXIS_OPTIONS.map((option) => (
                  <PillButton
                    key={option.value}
                    active={axisOverride === option.value}
                    onClick={() => changeAxis(option.value)}
                    className="px-3 sm:px-2 sm:py-0.5"
                  >
                    {option.label}
                  </PillButton>
                ))}
              </div>
              <span className="w-full text-[11px] text-adam-text-secondary/70">
                Only change if the split runs the wrong way.
              </span>
            </div>
          </div>
        </div>

        <div className="sticky bottom-0 z-10 flex shrink-0 flex-col gap-2 border-t border-adam-neutral-800 bg-background-color/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11px] leading-snug text-adam-text-secondary/70 sm:max-w-sm">
            Prints in place — no supports. 0.2 mm layers, 2–3 walls, no infill
            recommended.
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              className="h-11 flex-1 sm:h-9 sm:flex-none"
              onClick={() => onOpenChange(false)}
              disabled={isDownloading !== null}
            >
              Close
            </Button>
            <Button
              variant="outline"
              className="h-11 flex-1 sm:h-9 sm:flex-none"
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
              className="h-11 flex-1 sm:h-9 sm:flex-none"
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
