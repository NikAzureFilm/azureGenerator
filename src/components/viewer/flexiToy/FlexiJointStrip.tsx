/**
 * The joints strip — a DOM track under the preview that represents the spine
 * from 0 to 1, with one handle per planned cut. It replaces the old in-canvas
 * ring dragging: the rings are now passive, so orbiting the model and moving a
 * cut can never fight each other.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type PointerEvent,
} from 'react';

import { cn } from '@/lib/utils';
import type { FlexiToyPlan } from '@/utils/flexiToyTypes';
import type { FlexiDragState } from './FlexiPreviewCanvas';
import {
  JOINT_FRACTION_MARGIN,
  JOINT_FRACTION_MAX,
  JOINT_FRACTION_MIN,
  JOINT_KEY_COMMIT_MS,
  JOINT_KEY_STEP,
  RING_AMBER,
  RING_BLUE,
  clamp,
} from './flexiToyUi';

type FlexiJoints = FlexiToyPlan['joints'];

/**
 * A pointer must travel this far before the press counts as a drag. Without it
 * a plain tap on a handle would commit the stations, pin the segment count and
 * kick off a multi-second recompute the user never asked for.
 */
const DRAG_THRESHOLD_PX = 4;

/** Keeps a cut inside the spine and strictly between its neighbours. */
function clampFraction(
  joints: FlexiJoints,
  index: number,
  value: number,
): number {
  const lower =
    (index > 0 ? joints[index - 1].spineFraction : 0) + JOINT_FRACTION_MARGIN;
  const upper =
    (index < joints.length - 1 ? joints[index + 1].spineFraction : 1) -
    JOINT_FRACTION_MARGIN;
  return clamp(
    value,
    Math.max(JOINT_FRACTION_MIN, lower),
    Math.min(JOINT_FRACTION_MAX, upper),
  );
}

export function FlexiJointStrip({
  joints,
  dragState,
  highlightIndex,
  hasCustomPositions,
  cancelToken,
  onHoverChange,
  onDragChange,
  onCommit,
  onReset,
}: {
  joints: FlexiJoints;
  dragState: FlexiDragState;
  highlightIndex: number | null;
  hasCustomPositions: boolean;
  /**
   * Bumped by the parent whenever it changes the stations itself (length,
   * axis, segment count, "Even spacing"). Any keyboard commit still waiting on
   * its debounce is stale at that point and must be dropped.
   */
  cancelToken: number;
  onHoverChange: (index: number | null) => void;
  onDragChange: (state: FlexiDragState) => void;
  onCommit: (fractions: number[]) => void;
  onReset: () => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  const dragStartRef = useRef<{ fraction: number; clientX: number } | null>(
    null,
  );
  const dragFractionRef = useRef<number | null>(null);
  const dragMovedRef = useRef(false);
  const keyTimerRef = useRef<number | null>(null);
  // The fractions array a pending keyboard commit will send. Holding the whole
  // array (not just one index) means nudging handle A and then handle B inside
  // the same debounce window keeps BOTH moves.
  const pendingFractionsRef = useRef<number[] | null>(null);

  const clearPendingCommit = useCallback(() => {
    if (keyTimerRef.current !== null) {
      window.clearTimeout(keyTimerRef.current);
      keyTimerRef.current = null;
    }
    pendingFractionsRef.current = null;
  }, []);

  useEffect(() => () => clearPendingCommit(), [clearPendingCommit]);

  // The parent edited the stations from outside the strip: drop any pending
  // keyboard commit so it cannot resurrect the old array 400 ms later.
  useEffect(() => {
    clearPendingCommit();
  }, [cancelToken, clearPendingCommit]);

  const liveCount = useMemo(
    () => joints.filter((joint) => !joint.fused).length,
    [joints],
  );
  const fusedCount = joints.length - liveCount;

  // Evenly spread cuts sit 1/(joints+1) of the track apart, so cap the handle
  // at that width (with a floor so it stays grabbable).
  const handleWidth = `clamp(0.75rem, ${(100 / (joints.length + 1)).toFixed(
    2,
  )}%, 2rem)`;

  // One fractions array per commit — the planner's contract is that its length
  // equals segmentCount − 1, and stations come from the plan (all of them,
  // including fused ones), never from the body count.
  const commit = useCallback(
    (index: number, fraction: number) => {
      const fractions = joints.map((joint) => joint.spineFraction);
      fractions[index] = fraction;
      onCommit(fractions);
    },
    [joints, onCommit],
  );

  const fractionFromClientX = useCallback((clientX: number): number | null => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) {
      return null;
    }
    return (clientX - rect.left) / rect.width;
  }, []);

  const handlePointerDown = (
    index: number,
    event: PointerEvent<HTMLElement>,
  ) => {
    const target = event.currentTarget;
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is best-effort; the handle's own pointerup still ends
      // the drag in environments that reject it.
    }
    // A pointer edit supersedes anything the keyboard left pending.
    clearPendingCommit();
    const start = joints[index].spineFraction;
    dragIndexRef.current = index;
    dragStartRef.current = { fraction: start, clientX: event.clientX };
    dragFractionRef.current = start;
    dragMovedRef.current = false;
    onDragChange({ index, fraction: start });
  };

  const handlePointerMove = (
    index: number,
    event: PointerEvent<HTMLElement>,
  ) => {
    if (dragIndexRef.current !== index) {
      return;
    }
    const start = dragStartRef.current;
    if (!start) {
      return;
    }
    // Ignore the jitter of a tap: only past the threshold is this a drag.
    if (
      !dragMovedRef.current &&
      Math.abs(event.clientX - start.clientX) < DRAG_THRESHOLD_PX
    ) {
      return;
    }
    const raw = fractionFromClientX(event.clientX);
    if (raw === null) {
      return;
    }
    dragMovedRef.current = true;
    const next = clampFraction(joints, index, raw);
    dragFractionRef.current = next;
    onDragChange({ index, fraction: next });
  };

  const handlePointerEnd = (
    index: number,
    event: PointerEvent<HTMLElement>,
  ) => {
    if (dragIndexRef.current !== index) {
      return;
    }
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Best-effort release.
    }
    dragIndexRef.current = null;
    const start = dragStartRef.current?.fraction ?? joints[index].spineFraction;
    const fraction = dragFractionRef.current ?? start;
    const moved = dragMovedRef.current;
    dragStartRef.current = null;
    dragFractionRef.current = null;
    dragMovedRef.current = false;

    // A tap, or a drag that was clamped back to where it started, is not an
    // edit. Committing it would pin the segment count and run a full recompute
    // for nothing — and because the recompute would produce an identical
    // settings key, no new result would land to clear `dragState`, leaving the
    // handle and its 3D ring stuck in the highlighted state.
    if (!moved || fraction === start) {
      onDragChange(null);
      return;
    }
    commit(index, fraction);
  };

  const nudge = (index: number, direction: -1 | 1) => {
    const pending = pendingFractionsRef.current;
    const current =
      dragState?.index === index
        ? dragState.fraction
        : (pending?.[index] ?? joints[index].spineFraction);
    const next = clampFraction(
      joints,
      index,
      current + direction * JOINT_KEY_STEP,
    );
    const fractions = pending
      ? [...pending]
      : joints.map((joint) => joint.spineFraction);
    fractions[index] = next;
    pendingFractionsRef.current = fractions;
    onDragChange({ index, fraction: next });
    if (keyTimerRef.current !== null) {
      window.clearTimeout(keyTimerRef.current);
    }
    keyTimerRef.current = window.setTimeout(() => {
      keyTimerRef.current = null;
      const queued = pendingFractionsRef.current;
      pendingFractionsRef.current = null;
      if (queued) {
        onCommit(queued);
      }
    }, JOINT_KEY_COMMIT_MS);
  };

  return (
    <div className="shrink-0">
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-xs font-medium text-adam-text-primary">
          Joints
        </span>
        <span className="flex items-center gap-1 text-[11px] text-adam-text-secondary">
          <span
            aria-hidden
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: RING_BLUE }}
          />
          {liveCount} live
        </span>
        {fusedCount > 0 ? (
          <span className="flex items-center gap-1 text-[11px] text-adam-text-secondary">
            <span
              aria-hidden
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: RING_AMBER }}
            />
            {fusedCount} fused
          </span>
        ) : null}
        <span className="hidden text-[11px] text-adam-text-secondary/70 sm:inline">
          Drag a handle to move a cut
        </span>
        {hasCustomPositions ? (
          <button
            type="button"
            onClick={onReset}
            className="ml-auto rounded px-1 text-xs text-adam-blue hover:underline"
          >
            Even spacing
          </button>
        ) : null}
      </div>

      <div
        ref={trackRef}
        className="relative h-10 rounded-full border border-adam-neutral-800 bg-adam-neutral-900"
      >
        <div
          aria-hidden
          className="absolute left-3 right-3 top-1/2 h-px -translate-y-1/2 bg-adam-neutral-700"
        />
        {joints.map((joint, index) => {
          const fraction =
            dragState?.index === index
              ? dragState.fraction
              : joint.spineFraction;
          const active = dragState?.index === index || highlightIndex === index;
          return (
            <button
              key={index}
              type="button"
              role="slider"
              data-testid={`flexi-joint-handle-${index}`}
              aria-label={`Cut ${index + 1} of ${joints.length}${
                joint.fused ? ' (fused)' : ''
              }`}
              aria-valuemin={0}
              aria-valuemax={1}
              aria-valuenow={Number(fraction.toFixed(3))}
              style={{
                left: `${fraction * 100}%`,
                // Never wider than the spacing between two evenly spread cuts,
                // otherwise at high segment counts the handles overlap and the
                // later sibling steals every hit test from its left neighbour.
                width: handleWidth,
                // The handle being moved (or highlighted) wins any remaining
                // overlap.
                zIndex: active ? 2 : 1,
              }}
              className={cn(
                'absolute top-1/2 flex h-10 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none items-center justify-center rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-adam-blue active:cursor-grabbing',
                active && 'bg-white/5',
              )}
              onPointerDown={(event) => handlePointerDown(index, event)}
              onPointerMove={(event) => handlePointerMove(index, event)}
              onPointerUp={(event) => handlePointerEnd(index, event)}
              onPointerCancel={(event) => handlePointerEnd(index, event)}
              onPointerEnter={() => onHoverChange(index)}
              onPointerLeave={() => onHoverChange(null)}
              onFocus={() => onHoverChange(index)}
              onBlur={() => onHoverChange(null)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft') {
                  event.preventDefault();
                  nudge(index, -1);
                } else if (event.key === 'ArrowRight') {
                  event.preventDefault();
                  nudge(index, 1);
                }
              }}
            >
              <span
                aria-hidden
                className={cn(
                  'h-7 w-2.5 rounded-full transition-transform',
                  active && 'scale-y-110',
                )}
                style={{
                  backgroundColor: joint.fused ? RING_AMBER : RING_BLUE,
                }}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
