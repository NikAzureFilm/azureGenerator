/**
 * UI-only constants and helpers shared by the Flexi Toy dialog, its preview
 * canvas and its joints strip. Nothing here touches the geometry core — the
 * exported values in `@/utils/flexiToyTypes` stay exactly as the core defines
 * them; this module only decides what the dialog *shows* and *opens with*.
 */
import {
  FLEXI_CLEARANCE_PRESETS,
  FLEXI_MAX_LENGTH_MM,
  type FlexiAxisOverride,
  type FlexiClearancePreset,
  type FlexiJointStyle,
  type FlexiToyErrorCode,
} from '@/utils/flexiToyTypes';

/**
 * The joint styles the dialog exposes. The core union keeps all four members
 * (the worker still builds 'rounded'/'classic', and 'shell' falls back to the
 * rounded wedge per joint), but narrowing the dialog's own state to this type
 * makes any stray reference to a hidden style a compile error rather than a
 * silently dead branch.
 */
export type FlexiUiJointStyle = Extract<
  FlexiJointStyle,
  'shell' | 'strong' | 'link'
>;

/** The style the dialog opens with. */
export const DEFAULT_JOINT_STYLE: FlexiUiJointStyle = 'strong';

// Cut-station palette: blue = a live articulating joint, amber = a fused
// (rigid) station; the *_HOVER variants light up under the cursor / drag.
export const RING_BLUE = '#3B82F6';
export const RING_BLUE_HOVER = '#7DB0FF';
export const RING_AMBER = '#F59E0B';
export const RING_AMBER_HOVER = '#FCD34D';

// A cut may never sit on the very tip of the spine, nor closer than this to a
// neighbouring cut — the same rules the old in-canvas ring drag enforced.
export const JOINT_FRACTION_MIN = 0.02;
export const JOINT_FRACTION_MAX = 0.98;
export const JOINT_FRACTION_MARGIN = 0.01;
/** Keyboard nudge step and how long we wait after the last key before committing. */
export const JOINT_KEY_STEP = 0.01;
export const JOINT_KEY_COMMIT_MS = 400;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export const CLEARANCE_PRESET_ORDER: FlexiClearancePreset[] = [
  'tight',
  'standard',
  'loose',
];

export const CLEARANCE_PRESET_LABELS: Record<FlexiClearancePreset, string> = {
  tight: 'Tight',
  standard: 'Standard',
  loose: 'Loose',
};

export const AXIS_OPTIONS: Array<{ value: FlexiAxisOverride; label: string }> =
  [
    { value: 'auto', label: 'Auto' },
    { value: 'x', label: 'X' },
    { value: 'y', label: 'Y' },
    { value: 'z', label: 'Z' },
  ];

/**
 * Everything the dialog resets when it opens. Keeping it as one object per
 * style means a STRONG_DEFAULTS can be added later as a single literal (and
 * applied wherever we decide styles should re-seed the controls) without
 * touching the reset code. Today only the open defaults are applied: switching
 * styles deliberately leaves the other controls alone.
 */
export type FlexiStyleDefaults = {
  segmentMode: 'auto' | 'custom';
  segmentCountCustom: number;
  clearanceMm: number;
  targetLengthMm: number;
  jointScale: number;
  bendAngleDeg: number;
  axisOverride: FlexiAxisOverride;
  jointPositions: number[] | null;
  showOriginalColors: boolean;
};

/**
 * NB no LINK_DEFAULTS, and the arithmetic behind that rather than an assertion.
 * Link's ring gap is a CONE, `k(ρ) = 2·tan(bend/2)·ρ + c`, so its ratio to the
 * local body radius at the skin is `2·tan(bend/2) + c/ρ` — the reference
 * chain-link look (0.10–0.13 of the radius) therefore lands at `bend ≈ 5.2–6.9°`
 * at a 15mm skin radius, not at 8. Eight is a deliberate half-notch-wide choice:
 * it keeps ONE opening default across every style, and after the cone law it
 * delivers the full 8° at every joint of the acceptance body with a 1.7–2.4mm
 * slot and no travel warning.
 *
 * Re-seeding on a style switch would also throw away the user's dragged
 * stations, which `FlexiStyleDefaults`' own JSDoc and the dialog spec's
 * 'keeps dragged positions' test both forbid in substance.
 */
export const SHELL_DEFAULTS: FlexiStyleDefaults = {
  segmentMode: 'custom',
  segmentCountCustom: 5,
  clearanceMm: FLEXI_CLEARANCE_PRESETS.tight,
  targetLengthMm: FLEXI_MAX_LENGTH_MM,
  jointScale: 1,
  bendAngleDeg: 8,
  axisOverride: 'auto',
  jointPositions: null,
  showOriginalColors: true,
};

// Friendly, non-technical copy for each hard failure the core can report.
export const FLEXI_ERROR_COPY: Record<
  FlexiToyErrorCode,
  { title: string; body: string }
> = {
  'not-watertight': {
    title: "This model can't be made flexi",
    body: "It has holes or gaps we couldn't seal, so it can't be split into working joints. Solid, watertight models work best — try another one.",
  },
  'too-small': {
    title: 'This model is a little too small',
    body: 'There is not enough room to fit joints that actually move. Try fewer segments, or a model with a longer body.',
  },
  'rounded-uncut': {
    // Style-neutral on purpose: the core raises this code from both the shell
    // and the strong build paths.
    title: "These joints don't fit this shape",
    body: 'A fin or limb is in the way of the cuts. The Strong style uses open gaps and a hinge bar, which handles shapes like this.',
  },
  'compute-failed': {
    title: 'Something went wrong',
    body: "We couldn't build the flexi toy this time. Adjust a setting or try again.",
  },
};
