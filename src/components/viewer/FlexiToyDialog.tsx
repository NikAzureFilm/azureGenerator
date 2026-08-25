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
  FLEXI_MAX_LINK_BEND_DEG,
  FLEXI_MAX_LINK_ROOM_SCALE,
  FLEXI_MAX_LINK_THICKNESS_SCALE,
  FLEXI_MAX_SEGMENTS,
  FLEXI_MIN_BEND_DEG,
  FLEXI_MIN_CLEARANCE_MM,
  FLEXI_MIN_JOINT_SCALE,
  FLEXI_MIN_LENGTH_MM,
  FLEXI_MIN_LINK_ROOM_SCALE,
  FLEXI_MIN_LINK_THICKNESS_SCALE,
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
import { FlexiLayerSlider } from './flexiToy/FlexiLayerSlider';
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
  flexiPrintHeightMm,
  FLEXI_ERROR_COPY,
  LINK_DEFAULTS,
  clamp,
  type FlexiUiJointStyle,
} from './flexiToy/flexiToyUi';

// Each cached result holds full-toy typed arrays, so keep only the most
// recently used handful (insertion-order LRU over the Map).
const FLEXI_RESULT_CACHE_LIMIT = 12;
// Final-quality results are the exact, unsimplified build — heavier than a
// preview and only ever asked for by a download, so a much smaller LRU.
const FLEXI_FINAL_CACHE_LIMIT = 3;

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

function sameJointPositions(a: number[], b: number[]): boolean {
  return (
    a.length === b.length &&
    a.every((fraction, index) => Math.abs(fraction - b[index]) < 1e-9)
  );
}

function isTooSmallRecoverySettings(settings: FlexiToySettings): boolean {
  return (
    settings.segmentCount === FLEXI_MIN_SEGMENTS &&
    settings.targetLengthMm === FLEXI_MAX_LENGTH_MM &&
    settings.bendAngleDeg === FLEXI_MIN_BEND_DEG &&
    settings.clearanceMm === FLEXI_MIN_CLEARANCE_MM &&
    !settings.jointPositions &&
    (settings.jointStyle !== 'link' ||
      (settings.linkThicknessScale === FLEXI_MIN_LINK_THICKNESS_SCALE &&
        settings.linkRoomScale === FLEXI_MIN_LINK_ROOM_SCALE))
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

  const [segmentMode, setSegmentMode] = useState<'auto' | 'custom'>(
    LINK_DEFAULTS.segmentMode,
  );
  const [segmentCountCustom, setSegmentCountCustom] = useState(
    LINK_DEFAULTS.segmentCountCustom,
  );
  // The slider follows the last certified fit. Keep the user's larger request
  // separately so another fit-affecting change can reopen and retry it.
  const requestedSegmentCountRef = useRef(LINK_DEFAULTS.segmentCountCustom);
  const [maxSafeSegmentCount, setMaxSafeSegmentCount] =
    useState(FLEXI_MAX_SEGMENTS);
  const [clearanceMm, setClearanceMm] = useState<number>(
    LINK_DEFAULTS.clearanceMm,
  );
  const [showAdvancedFit, setShowAdvancedFit] = useState(false);
  const [targetLengthMm, setTargetLengthMm] = useState(
    LINK_DEFAULTS.targetLengthMm,
  );
  const [jointScale, setJointScale] = useState(LINK_DEFAULTS.jointScale);
  const [bendAngleDeg, setBendAngleDeg] = useState(LINK_DEFAULTS.bendAngleDeg);
  // As with segment count, show the certified value without forgetting what
  // the user asked for. A different fit can then retry the original bend.
  const requestedBendAngleDegRef = useRef(LINK_DEFAULTS.bendAngleDeg);
  const [linkThicknessScale, setLinkThicknessScale] = useState(
    LINK_DEFAULTS.linkThicknessScale,
  );
  const [linkRoomScale, setLinkRoomScale] = useState(
    LINK_DEFAULTS.linkRoomScale,
  );
  const [jointStyle, setJointStyle] =
    useState<FlexiUiJointStyle>(DEFAULT_JOINT_STYLE);
  const [axisOverride, setAxisOverride] = useState<FlexiAxisOverride>(
    LINK_DEFAULTS.axisOverride,
  );
  // User-dragged cut stations (arc-length fractions); null = even spacing.
  const [jointPositions, setJointPositions] = useState<number[] | null>(
    LINK_DEFAULTS.jointPositions,
  );
  // Incremented whenever the dialog itself rewrites the stations, so the strip
  // can discard a keyboard commit that is still waiting on its debounce.
  const [stationEditToken, setStationEditToken] = useState(0);

  const [showOriginalColors, setShowOriginalColors] = useState(
    LINK_DEFAULTS.showOriginalColors,
  );
  // Slicer-style layer view: fraction of the print height shown. 1 = whole
  // model (no clipping cost at all). Survives recomputes so the user can keep
  // a cut open while tuning joints; reset when the dialog opens.
  const [layerFraction, setLayerFraction] = useState(1);
  // Strip interaction state. `dragState` doubles as the live position of the
  // matching 3D ring while a handle is being moved.
  const [hoverJointIndex, setHoverJointIndex] = useState<number | null>(null);
  const [dragState, setDragState] = useState<FlexiDragState>(null);

  const [result, setResult] = useState<FlexiToyResult | null>(null);
  // Associates the landed result with the settings that produced it. Two
  // different settings can resolve to the same fit numbers, so the fit effect
  // cannot use those numbers alone to detect a newly certified result.
  const [resultSettingsKey, setResultSettingsKey] = useState<string | null>(
    null,
  );
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
  // Kept apart from the preview cache: same keys, different geometry (exact vs
  // simplified), and mixing them would let a download export a preview.
  const finalCacheRef = useRef(new Map<string, FlexiToyResult>());
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
    // Link is the only style that reads the loop thickness; leaving it off the
    // other styles' settings keeps their result-cache keys and worker requests
    // exactly as they were.
    if (jointStyle === 'link') {
      base.linkThicknessScale = linkThicknessScale;
      base.linkRoomScale = linkRoomScale;
    }
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
    linkThicknessScale,
    linkRoomScale,
    jointPositions,
  ]);

  const settingsKey = `${settings.segmentCount}|${settings.clearanceMm}|${settings.targetLengthMm}|${settings.jointScale}|${settings.axisOverride}|${settings.jointStyle}|${settings.bendAngleDeg}|${settings.linkThicknessScale ?? ''}|${settings.linkRoomScale ?? ''}|${
    settings.jointPositions
      ? settings.jointPositions.map((f) => f.toFixed(3)).join(',')
      : ''
  }`;

  const flexibilityMaxDeg =
    jointStyle === 'link' ? FLEXI_MAX_LINK_BEND_DEG : FLEXI_MAX_BEND_DEG;

  // Changing where/how many cuts there are invalidates any dragged stations
  // (their count and spine placement no longer apply), so these clear them.
  // The token bump tells the strip to drop a keyboard commit still waiting on
  // its debounce — otherwise it would land afterwards and re-pin the stations
  // we just cleared.
  const clearPinnedPositions = useCallback(() => {
    setJointPositions(null);
    setStationEditToken((token) => token + 1);
  }, []);

  // A certified cap only applies to the settings that produced it. Restore the
  // user's pre-fit count and the product-wide ceiling before another setting is
  // evaluated. If the count changes, old dragged positions no longer satisfy
  // jointPositions.length === segmentCount - 1 and must be cleared together.
  const reopenSegmentFit = useCallback(() => {
    setMaxSafeSegmentCount(FLEXI_MAX_SEGMENTS);
    const requested = requestedSegmentCountRef.current;
    if (segmentCountCustom !== requested) {
      setSegmentCountCustom(requested);
      clearPinnedPositions();
    }
  }, [clearPinnedPositions, segmentCountCustom]);

  const reopenBendFit = useCallback(() => {
    const styleMax =
      jointStyle === 'link' ? FLEXI_MAX_LINK_BEND_DEG : FLEXI_MAX_BEND_DEG;
    const requested = clamp(
      requestedBendAngleDegRef.current,
      FLEXI_MIN_BEND_DEG,
      styleMax,
    );
    setBendAngleDeg((current) => (current === requested ? current : requested));
  }, [jointStyle]);

  const recoverTooSmall = useCallback(() => {
    requestedSegmentCountRef.current = FLEXI_MIN_SEGMENTS;
    requestedBendAngleDegRef.current = FLEXI_MIN_BEND_DEG;
    setMaxSafeSegmentCount(FLEXI_MAX_SEGMENTS);
    setSegmentMode('custom');
    setSegmentCountCustom(FLEXI_MIN_SEGMENTS);
    setTargetLengthMm(FLEXI_MAX_LENGTH_MM);
    setBendAngleDeg(FLEXI_MIN_BEND_DEG);
    setClearanceMm(FLEXI_MIN_CLEARANCE_MM);
    setLinkThicknessScale(FLEXI_MIN_LINK_THICKNESS_SCALE);
    setLinkRoomScale(FLEXI_MIN_LINK_ROOM_SCALE);
    setJointPositions(null);
    setStationEditToken((token) => token + 1);
    setResult(null);
    setResultSettingsKey(null);
    setErrorInfo(null);
  }, []);

  const selectJointStyle = (style: FlexiUiJointStyle): void => {
    reopenSegmentFit();
    const styleMax =
      style === 'link' ? FLEXI_MAX_LINK_BEND_DEG : FLEXI_MAX_BEND_DEG;
    const requested = clamp(
      requestedBendAngleDegRef.current,
      FLEXI_MIN_BEND_DEG,
      styleMax,
    );
    requestedBendAngleDegRef.current = requested;
    setBendAngleDeg(requested);
    setJointStyle(style);
  };

  // Fresh session each time the dialog opens: every control goes back to the
  // Link defaults (no length derivation — the defaults are constants), and the
  // expensive mesh input is warmed in the background so the first compute does
  // not pay for it.
  useEffect(() => {
    if (!open || !gltf) {
      return;
    }

    setSegmentMode(LINK_DEFAULTS.segmentMode);
    setSegmentCountCustom(LINK_DEFAULTS.segmentCountCustom);
    requestedSegmentCountRef.current = LINK_DEFAULTS.segmentCountCustom;
    setMaxSafeSegmentCount(FLEXI_MAX_SEGMENTS);
    setClearanceMm(LINK_DEFAULTS.clearanceMm);
    setShowAdvancedFit(false);
    setTargetLengthMm(LINK_DEFAULTS.targetLengthMm);
    setJointScale(LINK_DEFAULTS.jointScale);
    setBendAngleDeg(LINK_DEFAULTS.bendAngleDeg);
    requestedBendAngleDegRef.current = LINK_DEFAULTS.bendAngleDeg;
    setLinkThicknessScale(LINK_DEFAULTS.linkThicknessScale);
    setLinkRoomScale(LINK_DEFAULTS.linkRoomScale);
    setJointStyle(DEFAULT_JOINT_STYLE);
    setAxisOverride(LINK_DEFAULTS.axisOverride);
    setJointPositions(LINK_DEFAULTS.jointPositions);
    setStationEditToken((token) => token + 1);
    setShowOriginalColors(LINK_DEFAULTS.showOriginalColors);
    setLayerFraction(1);
    setHoverJointIndex(null);
    setDragState(null);
    setErrorInfo(null);

    if (meshInputRef.current?.forGltf !== gltf) {
      resultCacheRef.current.clear();
      finalCacheRef.current.clear();
      setResult(null);
      setResultSettingsKey(null);
    }

    // Fire-and-forget warm-up: failures surface through the compute effect,
    // which awaits the same shared promise.
    ensureMeshInput(gltf).catch(() => {});
  }, [open, gltf, ensureMeshInput]);

  // Recompute immediately after a setting commits. Awaiting the already-warmed
  // mesh promise gives React one microtask to collapse same-tick state bursts,
  // while the client/worker's latest-wins protocol cancels genuinely older
  // builds. There is intentionally no timer or pointer-up gate: the preview
  // pipeline starts during the interaction instead of after it.
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
      setResultSettingsKey(settingsKey);
      setIsComputing(false);
      setErrorInfo(null);
      return;
    }

    const token = ++computeTokenRef.current;
    setIsComputing(true);
    setErrorInfo(null);

    void (async () => {
      try {
        const input = await ensureMeshInput(gltf);
        // A newer state landed while the shared mesh promise was yielding.
        // Only start the newest build; this is zero-delay coalescing rather
        // than a time-based debounce.
        if (computeTokenRef.current !== token) {
          return;
        }
        // Preview quality: the simplified body and coarser joint solids are
        // several times cheaper and indistinguishable at preview size. The
        // downloads re-run this at 'final'.
        const outcome = await computeFlexiToy(input, settings, 'preview');

        if (computeTokenRef.current !== token) {
          return;
        }
        // Superseded by a newer request — either another settings change or a
        // download's final build. Its own effect run owns the outcome; this one
        // just steps aside without touching the result or the error state.
        if (outcome.status === 'superseded') {
          return;
        }
        if (outcome.status === 'error') {
          if (
            outcome.code === 'too-small' &&
            !isTooSmallRecoverySettings(settings)
          ) {
            // There is one useful automatic fallback for this error: make the
            // body as long as allowed and every fit control as conservative as
            // allowed, while preserving the style the user chose. Because the
            // next settings object already matches this predicate, a second
            // failure lands normally instead of retrying forever.
            recoverTooSmall();
            return;
          }
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
        setResultSettingsKey(settingsKey);
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
    })();
  }, [open, gltf, settingsKey, settings, ensureMeshInput, recoverTooSmall]);

  // A landed result carries the planner's own station placement, so any live
  // drag offset has served its purpose.
  useEffect(() => {
    setDragState(null);
  }, [result]);

  const fitResolvedSegmentCount =
    result?.plan.fit?.resolvedSegmentCount ?? null;
  const fitMaxSafeSegmentCount = result?.plan.fit?.maxSafeSegmentCount ?? null;
  const fitJointPositionsKey =
    result?.plan.fit?.jointPositions.join(',') ?? null;
  const fitResolvedBendAngleDeg =
    result?.plan.fit?.resolvedBendAngleDeg ?? null;

  // Reflect the planner's certified result once. Dependencies are primitive and
  // every setter returns its previous state when nothing changed, so the
  // corrective compute caused by 20 -> 5 settles after that one follow-up.
  useEffect(() => {
    const hasResolvedSegmentFit = !(
      fitResolvedSegmentCount === null ||
      fitMaxSafeSegmentCount === null ||
      fitJointPositionsKey === null
    );

    if (!hasResolvedSegmentFit) {
      // A missing fit is a legacy payload. It cannot constrain the slider, so
      // leave the normal product range open.
      setMaxSafeSegmentCount((current) =>
        current === FLEXI_MAX_SEGMENTS ? current : FLEXI_MAX_SEGMENTS,
      );
    } else {
      // Zero is the planner's explicit "no conditional cap" value. The fit is
      // still authoritative for count and relocated stations; only its slider
      // ceiling stays at the product maximum.
      const safeMax =
        fitMaxSafeSegmentCount >= FLEXI_MIN_SEGMENTS
          ? clamp(
              Math.round(fitMaxSafeSegmentCount),
              FLEXI_MIN_SEGMENTS,
              FLEXI_MAX_SEGMENTS,
            )
          : FLEXI_MAX_SEGMENTS;
      const resolved = clamp(
        Math.round(fitResolvedSegmentCount),
        FLEXI_MIN_SEGMENTS,
        safeMax,
      );
      setMaxSafeSegmentCount((current) =>
        current === safeMax ? current : safeMax,
      );

      if (segmentMode === 'custom') {
        setSegmentCountCustom((current) =>
          current === resolved ? current : resolved,
        );
        setJointPositions((current) => {
          if (current === null) {
            return current;
          }
          const resolvedPositions = fitJointPositionsKey
            ? fitJointPositionsKey.split(',').map(Number)
            : [];
          if (resolvedPositions.length !== resolved - 1) {
            return null;
          }
          return sameJointPositions(current, resolvedPositions)
            ? current
            : resolvedPositions;
        });
      }
    }

    if (fitResolvedBendAngleDeg !== null) {
      const resolvedBend = clamp(
        Math.round(fitResolvedBendAngleDeg),
        FLEXI_MIN_BEND_DEG,
        flexibilityMaxDeg,
      );
      setBendAngleDeg((current) =>
        current === resolvedBend ? current : resolvedBend,
      );
    }
  }, [
    fitJointPositionsKey,
    fitMaxSafeSegmentCount,
    fitResolvedBendAngleDeg,
    fitResolvedSegmentCount,
    flexibilityMaxDeg,
    resultSettingsKey,
    segmentMode,
  ]);

  const activePreset = useMemo<FlexiClearancePreset | null>(() => {
    const match = CLEARANCE_PRESET_ORDER.find(
      (preset) =>
        Math.abs(FLEXI_CLEARANCE_PRESETS[preset] - clearanceMm) < 1e-6,
    );
    return match ?? null;
  }, [clearanceMm]);

  const totalJoints = result?.jointCount ?? 0;
  const highlightIndex = dragState ? dragState.index : hoverJointIndex;

  const changeLength = (value: number) => {
    reopenSegmentFit();
    reopenBendFit();
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
    reopenSegmentFit();
    reopenBendFit();
    setAxisOverride(value);
    clearPinnedPositions();
  };

  const changeClearance = (value: number) => {
    reopenSegmentFit();
    reopenBendFit();
    setClearanceMm(value);
  };

  const changeJointScale = (value: number) => {
    reopenSegmentFit();
    reopenBendFit();
    setJointScale(value);
  };

  const changeLinkThickness = (value: number) => {
    reopenSegmentFit();
    reopenBendFit();
    setLinkThicknessScale(value);
  };

  const changeLinkRoom = (value: number) => {
    reopenSegmentFit();
    reopenBendFit();
    setLinkRoomScale(value);
  };

  const changeBendAngle = (value: number) => {
    reopenSegmentFit();
    requestedBendAngleDegRef.current = value;
    setBendAngleDeg(value);
  };

  const useAutoSegments = () => {
    reopenBendFit();
    setMaxSafeSegmentCount(FLEXI_MAX_SEGMENTS);
    setSegmentMode('auto');
    clearPinnedPositions();
  };

  const useCustomSegments = () => {
    // Already the active mode: re-clicking the pill must not disturb the
    // pinned count or the user's dragged stations.
    if (segmentMode === 'custom') {
      return;
    }
    reopenBendFit();
    const seededCount = clamp(
      // Seed from the pieces the PLANNER laid out, never from
      // result.segmentCount — that is the built BODY count, which is smaller
      // whenever a joint is fused, and using it would break the
      // jointPositions.length === segmentCount − 1 contract.
      result ? result.plan.joints.length + 1 : segmentCountCustom,
      FLEXI_MIN_SEGMENTS,
      FLEXI_MAX_SEGMENTS,
    );
    requestedSegmentCountRef.current = seededCount;
    setSegmentCountCustom(seededCount);
    setSegmentMode('custom');
    clearPinnedPositions();
  };

  const changeSegmentCount = (value: number) => {
    reopenBendFit();
    requestedSegmentCountRef.current = value;
    setSegmentCountCustom(value);
    clearPinnedPositions();
  };

  // On strip release: pin the count (so the fractions array has a fixed length)
  // and store the dragged stations; the preview recomputes immediately.
  // Pin from the committed array itself — the contract requires
  // jointPositions.length === segmentCount − 1, and stations = planned pieces −
  // 1 = fractions.length. (result.segmentCount is the BODY count, which is
  // smaller whenever a joint is fused, so it must not be used here.) The pin
  // runs on every commit, not just from 'auto': the dialog now opens in custom
  // mode, and leaving a stale count would break the length contract whenever
  // the planner placed a different number of stations.
  const handleRingCommit = useCallback(
    (fractions: number[]) => {
      reopenBendFit();
      const count = clamp(
        fractions.length + 1,
        FLEXI_MIN_SEGMENTS,
        FLEXI_MAX_SEGMENTS,
      );
      requestedSegmentCountRef.current = count;
      setMaxSafeSegmentCount(FLEXI_MAX_SEGMENTS);
      setSegmentCountCustom(count);
      setSegmentMode('custom');
      setJointPositions(fractions);
    },
    [reopenBendFit],
  );

  const handleStripReset = useCallback(() => {
    reopenSegmentFit();
    reopenBendFit();
    clearPinnedPositions();
  }, [clearPinnedPositions, reopenBendFit, reopenSegmentFit]);

  // The toy on screen is a PREVIEW build (simplified body, coarser joint
  // solids). A file has to be the exact geometry, so a download re-runs the
  // same settings at 'final' quality and exports that. Results are cached by
  // the same settings key as the preview, so downloading both formats of an
  // unchanged toy only builds once.
  const ensureFinalResult = async (): Promise<
    | { status: 'ok'; result: FlexiToyResult }
    | { status: 'superseded' }
    | { status: 'error' }
  > => {
    const cache = finalCacheRef.current;
    const cached = cache.get(settingsKey);
    if (cached) {
      // Refresh recency (delete + re-insert moves the key to the newest slot).
      cache.delete(settingsKey);
      cache.set(settingsKey, cached);
      return { status: 'ok', result: cached };
    }

    const input = await ensureMeshInput(gltf);
    const outcome = await computeFlexiToy(input, settings, 'final');
    if (outcome.status !== 'ok') {
      return outcome.status === 'superseded'
        ? { status: 'superseded' }
        : { status: 'error' };
    }

    cache.set(settingsKey, outcome.result);
    while (cache.size > FLEXI_FINAL_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      cache.delete(oldest);
    }
    return { status: 'ok', result: outcome.result };
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
      joint_style: jointStyle,
    });

    setIsDownloading(format);
    try {
      let final: Awaited<ReturnType<typeof ensureFinalResult>>;
      try {
        final = await ensureFinalResult();
      } catch (error) {
        Sentry.captureException(error, {
          extra: { context: 'flexi toy final build', format },
        });
        final = { status: 'error' };
      }

      if (final.status === 'superseded') {
        // A settings change (the user kept tuning) took the worker while the
        // file was being built. Exporting the old preview would hand them a
        // file that no longer matches the screen, so stop and say so.
        toast({
          title: 'Download cancelled',
          description:
            'Settings changed while preparing the file — click download again.',
        });
        return;
      }

      // A failed final build must not lose the user their download: the preview
      // geometry is the same toy, just coarser, so export it and be honest.
      if (final.status === 'error') {
        toast({
          title: 'Downloaded a preview-quality file',
          description:
            'The full-quality build failed, so the preview-quality version was downloaded.',
        });
      }
      if (final.status === 'ok') {
        // Final-quality booleans can certify a slightly safer count, station,
        // or bend than the preview. Land that exact result before handing it
        // to the exporter; the normal fit effect then brings every visible
        // control to the same certificate instead of leaving the screen and
        // downloaded file on two different toy layouts.
        setResult(final.result);
        setResultSettingsKey(settingsKey);
        setErrorInfo(null);
      }
      const exported = final.status === 'ok' ? final.result : result;

      const blob =
        format === 'stl'
          ? await flexiResultToStlBlob(exported)
          : await flexiResultToThreeMfBlob(exported, filenameBase);

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
  // One pass per result, shared by the layer slider's read-out and the
  // preview's clip plane.
  const printHeightMm = useMemo(
    () => (result ? flexiPrintHeightMm(result.positions) : 0),
    [result],
  );

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
            content-driven height must be able to scroll away rather than
            squeeze the controls on a phone. From lg the two columns split and
            only the right one scrolls. */}
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
                layerFraction={layerFraction}
                heightMm={printHeightMm}
                settings={settings}
                previewingIntent={resultSettingsKey !== settingsKey}
              />

              {hasPreviewResult ? (
                <FlexiLayerSlider
                  className="absolute bottom-2 right-2 top-2 z-20"
                  fraction={layerFraction}
                  heightMm={printHeightMm}
                  onFractionChange={setLayerFraction}
                />
              ) : null}

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
                      onClick={() => selectJointStyle('strong')}
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
                joints · {Math.round(result.lengthMm)} mm
              </div>
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
                className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-2 min-[560px]:grid-cols-3"
              >
                <StyleCard
                  selected={jointStyle === 'shell'}
                  title="Shell"
                  description="Overlapping scales — joints stay hidden"
                  onSelect={() => selectJointStyle('shell')}
                />
                <StyleCard
                  selected={jointStyle === 'strong'}
                  title="Strong"
                  description="Open gaps and a hinge bar — captive joint"
                  onSelect={() => selectJointStyle('strong')}
                />
                <StyleCard
                  selected={jointStyle === 'link'}
                  title="Link"
                  description="Chain links — two slim loops in an open pocket, free to swing"
                  onSelect={() => selectJointStyle('link')}
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
                maxSafeSegmentCount === FLEXI_MIN_SEGMENTS ? (
                  // Radix computes a percentage from (value-min)/(max-min), so
                  // its track cannot represent a zero-width range. A disabled
                  // native range preserves the truthful min=max accessibility
                  // contract when auto-fit proves only the minimum is safe.
                  <input
                    aria-label="Segments"
                    className="mt-2 h-11 w-full accent-sky-300 sm:h-8"
                    type="range"
                    value={FLEXI_MIN_SEGMENTS}
                    min={FLEXI_MIN_SEGMENTS}
                    max={FLEXI_MIN_SEGMENTS}
                    step={1}
                    disabled
                    readOnly
                  />
                ) : (
                  <Slider
                    aria-label="Segments"
                    className="mt-2 h-11 sm:h-8"
                    value={[segmentCountCustom]}
                    min={FLEXI_MIN_SEGMENTS}
                    max={maxSafeSegmentCount}
                    step={1}
                    defaultValue={[
                      Math.min(
                        LINK_DEFAULTS.segmentCountCustom,
                        maxSafeSegmentCount,
                      ),
                    ]}
                    onValueChange={([value]) => changeSegmentCount(value)}
                  />
                )
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
                      changeClearance(FLEXI_CLEARANCE_PRESETS[preset])
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
                    aria-label="Joint gap"
                    className="h-11 sm:h-8"
                    value={[clearanceMm]}
                    min={FLEXI_MIN_CLEARANCE_MM}
                    max={FLEXI_MAX_CLEARANCE_MM}
                    step={0.05}
                    defaultValue={[FLEXI_CLEARANCE_PRESETS.standard]}
                    onValueChange={([value]) =>
                      changeClearance(Number(value.toFixed(2)))
                    }
                  />
                </div>
              ) : (
                <p className="mt-2 text-xs text-adam-text-secondary/80">
                  Tighter grips firmly; looser leaves more play between the
                  parts and is easier to free after printing.
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
                aria-label="Toy length"
                className="h-11 sm:h-8"
                value={[targetLengthMm]}
                min={FLEXI_MIN_LENGTH_MM}
                max={FLEXI_MAX_LENGTH_MM}
                step={5}
                defaultValue={[LINK_DEFAULTS.targetLengthMm]}
                onValueChange={([value]) => changeLength(value)}
              />
            </div>

            <div>
              <ControlLabel
                label="Joint size"
                value={`${jointScale.toFixed(2)}×`}
              />
              <Slider
                aria-label="Joint size"
                className="h-11 sm:h-8"
                value={[jointScale]}
                min={FLEXI_MIN_JOINT_SCALE}
                max={FLEXI_MAX_JOINT_SCALE}
                step={0.05}
                defaultValue={[LINK_DEFAULTS.jointScale]}
                onValueChange={([value]) =>
                  changeJointScale(Number(value.toFixed(2)))
                }
              />
              <p className="mt-1 text-xs text-adam-text-secondary/80">
                Chunkier or slimmer joints.
              </p>
            </div>

            {jointStyle === 'link' && (
              <div>
                <ControlLabel
                  label="Link thickness"
                  value={`${linkThicknessScale.toFixed(2)}×`}
                />
                <Slider
                  aria-label="Link thickness"
                  className="h-11 sm:h-8"
                  value={[linkThicknessScale]}
                  min={FLEXI_MIN_LINK_THICKNESS_SCALE}
                  max={FLEXI_MAX_LINK_THICKNESS_SCALE}
                  step={0.05}
                  defaultValue={[LINK_DEFAULTS.linkThicknessScale]}
                  onValueChange={([value]) =>
                    changeLinkThickness(Number(value.toFixed(2)))
                  }
                />
                <p className="mt-1 text-xs text-adam-text-secondary/80">
                  Thicker or thinner chain loops. Thicker loops are sturdier but
                  need more room, so a joint that runs out of space falls back
                  and tells you.
                </p>
              </div>
            )}

            {jointStyle === 'link' && (
              <div>
                <ControlLabel
                  label="Joint room"
                  value={`${linkRoomScale.toFixed(2)}×`}
                />
                <Slider
                  aria-label="Joint room"
                  className="h-11 sm:h-8"
                  value={[linkRoomScale]}
                  min={FLEXI_MIN_LINK_ROOM_SCALE}
                  max={FLEXI_MAX_LINK_ROOM_SCALE}
                  step={0.05}
                  defaultValue={[LINK_DEFAULTS.linkRoomScale]}
                  onValueChange={([value]) =>
                    changeLinkRoom(Number(value.toFixed(2)))
                  }
                />
                <p className="mt-1 text-xs text-adam-text-secondary/80">
                  How much space the links have to move: less keeps the loops
                  snug in a tight pocket, more lets them hang loose in a bigger
                  one. The body's own walls always cap it.
                </p>
              </div>
            )}

            <div>
              <ControlLabel label="Flexibility" value={`${bendAngleDeg}°`} />
              <Slider
                aria-label="Flexibility"
                className="h-11 sm:h-8"
                value={[bendAngleDeg]}
                min={FLEXI_MIN_BEND_DEG}
                max={flexibilityMaxDeg}
                step={1}
                defaultValue={[LINK_DEFAULTS.bendAngleDeg]}
                onValueChange={([value]) => changeBendAngle(Math.round(value))}
              />
              {/* A switch, not a ternary, so a fourth style is a
                  compile-visible edit rather than a silent fall-through. */}
              <p className="mt-1 text-xs text-adam-text-secondary/80">
                {((): string => {
                  switch (jointStyle) {
                    case 'strong':
                      return 'How far each joint can bend. Bigger bends open the gap between segments wider.';
                    case 'link':
                      return 'How far each joint bends up and down, up to 90°. Sideways twist stays small whatever you pick, so the links stay hooked together. If the model has less room than the selected bend needs, the toy tells you the angle it settled on.';
                    case 'shell':
                      return 'How far each joint can bend.';
                  }
                })()}
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
          {/* While a download runs this line says what the wait is for — the
              file is built at full quality, which takes longer than the
              preview the user has been adjusting. */}
          <p
            className="text-[11px] leading-snug text-adam-text-secondary/70 sm:max-w-sm"
            aria-live="polite"
          >
            {isDownloading
              ? 'Preparing full-quality file…'
              : 'Prints in place — no supports. 0.2 mm layers, 2–3 walls, no infill recommended.'}
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
