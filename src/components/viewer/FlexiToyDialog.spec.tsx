import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { GLTF } from 'three-stdlib';
import type {
  FlexiJointPlan,
  FlexiMeshInput,
  FlexiToyResult,
} from '@/utils/flexiToyTypes';
import { FlexiToyDialog } from './FlexiToyDialog';
import { computeFlexiToy, sceneToFlexiMeshInput } from '@/utils/flexiToyClient';
import {
  flexiResultToStlBlob,
  flexiResultToThreeMfBlob,
} from '@/utils/flexiToyExport';
import { processUserModelForDownload } from '@/utils/meshPrintProcessUtils';

// The r3f Canvas renders its children into plain DOM (no WebGL context in
// jsdom): the mesh + cut-ring subtree mounts so the rings are queryable, while
// OrbitControls is inert. `useThree` only ever feeds the invalidate bridge.
vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="flexi-canvas">{children}</div>
  ),
  useThree: (selector: (state: { invalidate: () => void }) => unknown) =>
    selector({ invalidate: () => {} }),
}));
vi.mock('@react-three/drei', () => ({
  OrbitControls: () => null,
}));

vi.mock('@/utils/flexiToyClient', () => ({
  computeFlexiToy: vi.fn(),
  sceneToFlexiMeshInput: vi.fn(),
}));
vi.mock('@/utils/flexiToyExport', () => ({
  flexiResultToStlBlob: vi.fn(),
  flexiResultToThreeMfBlob: vi.fn(),
}));
vi.mock('@/utils/meshPrintProcessUtils', () => ({
  processUserModelForDownload: vi.fn(),
}));
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

// Radix Slider/Dialog reach for browser APIs jsdom does not ship.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver =
  globalThis.ResizeObserver ?? (ResizeObserverStub as typeof ResizeObserver);
// jsdom ships no PointerEvent, so testing-library would fall back to a plain
// Event and drop `clientX` — which the strip's drag maths depends on.
class PointerEventStub extends window.MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}
globalThis.PointerEvent =
  globalThis.PointerEvent ??
  (PointerEventStub as unknown as typeof PointerEvent);
// jsdom implements none of the pointer-capture methods. Our Slider calls two of
// them (press captures, release frees) and Radix's own track handler asks
// `hasPointerCapture`, so without these a scrub throws before it can report
// itself.
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function joint(spineFraction: number, fused: boolean): FlexiJointPlan {
  return {
    center: [spineFraction * 20, 0, 0],
    axis: [1, 0, 0],
    ballRadiusMm: 4,
    socketDepthMm: 2,
    faceGapMm: fused ? 0 : 1,
    spineFraction,
    fused,
  };
}

const fakeInput: FlexiMeshInput = {
  positions: new Float32Array([0, 0, 0, 100, 0, 0, 0, 20, 0]),
  indices: new Uint32Array([0, 1, 2]),
  colors: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]),
};

const fakeResult: FlexiToyResult = {
  positions: new Float32Array([0, 0, 0, 20, 0, 0, 10, 10, 0]),
  indices: new Uint32Array([0, 1, 2]),
  colors: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]),
  segmentTriangleRanges: [{ start: 0, count: 3 }],
  // Realistic: [live, fused, live] → 2 live joints → BODY count = live + 1 = 3
  // (the fused station merges two pieces). plan.joints.length stays 3.
  segmentCount: 3,
  jointCount: 2,
  fusedJointCount: 1,
  lengthMm: 148,
  plan: {
    joints: [joint(0.25, false), joint(0.5, true), joint(0.75, false)],
    spine: [
      [0, 0, 0],
      [10, 0, 0],
      [20, 0, 0],
    ],
    spineLengthMm: 20,
    warnings: [],
  },
  warnings: [
    {
      code: 'joint-fused-too-thin',
      message: '1 joint is too thin to move — it stays rigid.',
      jointIndex: 1,
    },
  ],
};

const gltf = {} as GLTF;

function renderDialog() {
  return render(
    <FlexiToyDialog
      open
      onOpenChange={() => {}}
      gltf={gltf}
      filenameBase="test-model"
    />,
  );
}

// Flushes async mesh-input/compute work plus any UI animation timers.
async function settle() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
  }
}

function jointHandle(index: number): HTMLElement {
  return screen.getByTestId(`flexi-joint-handle-${index}`);
}

// jsdom gives every element a zero-sized rect, so the track has to be stubbed
// before a drag can map a clientX onto a spine fraction.
const TRACK_WIDTH = 1000;

function stubTrackRect(handle: HTMLElement): void {
  const track = handle.parentElement;
  if (!track) {
    throw new Error('joint handle is not inside a track');
  }
  track.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: TRACK_WIDTH,
      bottom: 40,
      width: TRACK_WIDTH,
      height: 40,
      toJSON: () => ({}),
    }) as DOMRect;
}

/**
 * The TRACK of a settings slider. `getByRole('slider')` finds Radix's hidden
 * thumb, but our Slider hangs its pointer handlers on the Track, so that is the
 * element a scrub has to be fired on. The slider is identified by its
 * accessible name (a test id would have to be repeated across half a dozen
 * structurally identical sliders), then: every Radix slider part carries
 * `data-orientation`, and the thumb sits inside an unmarked positioning
 * wrapper — so climbing from that wrapper lands on the Root, whose only direct
 * `data-orientation` child is the Track.
 */
function settingsSliderTrack(name: string): HTMLElement {
  const thumb = screen.getByRole('slider', { name });
  const root = thumb.parentElement?.closest('[data-orientation]');
  const track = root?.querySelector(':scope > [data-orientation]');
  if (!(track instanceof HTMLElement)) {
    throw new Error(`could not find the track of the "${name}" slider`);
  }
  // jsdom gives every element a zero-sized rect, so a press would map to the
  // slider's minimum; a real width lets the press land where it was aimed.
  track.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: TRACK_WIDTH,
      bottom: 28,
      width: TRACK_WIDTH,
      height: 28,
      toJSON: () => ({}),
    }) as DOMRect;
  return track;
}

/** Press, move past the drag threshold to `fraction`, release. */
function dragHandleTo(index: number, fraction: number): void {
  const handle = jointHandle(index);
  stubTrackRect(handle);
  const clientX = fraction * TRACK_WIDTH;
  fireEvent.pointerDown(handle, { pointerId: 1, clientX: 0 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX });
  fireEvent.pointerUp(handle, { pointerId: 1, clientX });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();

  (processUserModelForDownload as Mock).mockResolvedValue({});
  (sceneToFlexiMeshInput as Mock).mockReturnValue(fakeInput);
  (computeFlexiToy as Mock).mockResolvedValue({
    status: 'ok',
    result: fakeResult,
  });
  (flexiResultToStlBlob as Mock).mockResolvedValue(new Blob(['stl']));
  (flexiResultToThreeMfBlob as Mock).mockResolvedValue(new Blob(['3mf']));

  URL.createObjectURL = vi.fn(() => 'blob:mock');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FlexiToyDialog', () => {
  it('renders the flexi controls and download actions', async () => {
    renderDialog();
    await settle();

    expect(screen.getByText('Joint style')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Shell/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Strong/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Link/ })).toBeInTheDocument();
    expect(screen.getByText('Segments')).toBeInTheDocument();
    expect(screen.getByText('Joint fit')).toBeInTheDocument();
    expect(screen.getByText('Toy length')).toBeInTheDocument();
    expect(screen.getByText('Joint size')).toBeInTheDocument();
    expect(screen.getByText('Flexibility')).toBeInTheDocument();
    expect(screen.getByText('Spine axis')).toBeInTheDocument();

    expect(screen.getByRole('radio', { name: 'Tight' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Standard' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Loose' })).toBeInTheDocument();

    expect(screen.getByRole('button', { name: '.STL' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '.3MF' })).toBeInTheDocument();
  });

  it('offers the Shell, Strong and Link joint styles', async () => {
    renderDialog();
    await settle();

    expect(
      screen.getAllByRole('radio', { name: /Shell|Strong|Link/ }),
    ).toHaveLength(3);
    expect(
      screen.queryByRole('radio', { name: /Rounded/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('radio', { name: /Classic/ }),
    ).not.toBeInTheDocument();
  });

  it('opens with the Link style and its default settings', async () => {
    renderDialog();
    await settle();

    expect(computeFlexiToy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        jointStyle: 'link',
        segmentCount: 5,
        clearanceMm: 0.4,
        targetLengthMm: 400,
        bendAngleDeg: 8,
        jointScale: 1,
        axisOverride: 'auto',
      }),
      // What the dialog shows is the cheap build; only downloads ask for the
      // exact one.
      'preview',
    );
    // Even spacing on open: no pinned stations are sent.
    const settingsArg = (computeFlexiToy as Mock).mock.calls.at(-1)?.[1];
    expect(settingsArg.jointPositions).toBeUndefined();
    expect(screen.getByRole('radio', { name: /Link/ })).toBeChecked();
  });

  it('opens with original colors shown', async () => {
    renderDialog();
    await settle();

    expect(screen.getByRole('switch')).toBeChecked();
  });

  it('switches to the shell joint style with one recompute and keeps dragged positions', async () => {
    renderDialog();
    await settle();

    dragHandleTo(0, 0.4);
    await settle();
    (computeFlexiToy as Mock).mockClear();

    fireEvent.click(screen.getByRole('radio', { name: /Shell/ }));
    await settle();

    expect(computeFlexiToy).toHaveBeenCalledTimes(1);
    const settingsArg = (computeFlexiToy as Mock).mock.calls.at(-1)?.[1];
    expect(settingsArg.jointStyle).toBe('shell');
    expect(settingsArg.jointPositions).toHaveLength(
      fakeResult.plan.joints.length,
    );
  });

  it('switches to the link joint style with one recompute and keeps dragged positions', async () => {
    renderDialog();
    await settle();

    fireEvent.click(screen.getByRole('radio', { name: /Strong/ }));
    await settle();

    dragHandleTo(0, 0.4);
    await settle();
    (computeFlexiToy as Mock).mockClear();

    fireEvent.click(screen.getByRole('radio', { name: /Link/ }));
    await settle();

    expect(computeFlexiToy).toHaveBeenCalledTimes(1);
    const settingsArg = (computeFlexiToy as Mock).mock.calls.at(-1)?.[1];
    expect(settingsArg.jointStyle).toBe('link');
    expect(settingsArg.jointPositions).toHaveLength(
      fakeResult.plan.joints.length,
    );
  });

  // The two helper strings the link style's honesty rests on. Both were WRONG
  // before the conical kerf landed — "looser moves more freely" is backwards for
  // a joint whose clearance is additive in the ring gap, and the old Flexibility
  // line promised a side-to-side sweep the carved key never delivered — and
  // nothing in this spec pinned either of them, so a later edit could quietly
  // put the false version back. The rewritten copy is a deliverable, so it is
  // asserted like one.
  it('lets Link flexibility reach 90 degrees and explains geometric reductions', async () => {
    renderDialog();
    await settle();

    fireEvent.click(screen.getByRole('radio', { name: /Link/ }));
    await settle();

    expect(screen.getByRole('slider', { name: 'Flexibility' })).toHaveAttribute(
      'aria-valuemax',
      '90',
    );
    const flexibilitySlider = screen.getByRole('slider', {
      name: 'Flexibility',
    });
    (computeFlexiToy as Mock).mockClear();
    fireEvent.keyDown(flexibilitySlider, { key: 'End' });
    await settle();

    expect(flexibilitySlider).toHaveAttribute('aria-valuenow', '90');
    expect((computeFlexiToy as Mock).mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({ jointStyle: 'link', bendAngleDeg: 90 }),
    );

    expect(
      screen.getByText(/Tighter grips firmly; looser leaves more play/),
    ).toBeInTheDocument();
    // The pre-fix line said the opposite of what the mechanism does.
    expect(screen.queryByText(/looser moves more freely/)).toBeNull();

    const bendHelp = screen.getByText(/How far each joint bends up and down/);
    // It must disclose the sideways cap...
    expect(bendHelp).toHaveTextContent(/Sideways twist stays small/);
    // ...the full control range and honest geometric fallback.
    expect(bendHelp).toHaveTextContent(/up to 90°/);
    expect(bendHelp).toHaveTextContent(/the angle it settled on/);
    // ...and it must not promise a side-to-side sweep that scales with it.
    expect(bendHelp).not.toHaveTextContent(
      /twists? a few degrees side to side/,
    );
  });

  // The Link thickness slider is a Link-only control: it must ship in Link's
  // settings (default 1×), leave the other styles' settings untouched (their
  // cache keys and worker requests are unchanged), and drive a recompute.
  it('offers a Link-only thickness slider that flows into the settings', async () => {
    renderDialog();
    await settle();

    // Link is the default style, so the control is present from the start and
    // the first compute already carries the default multiplier.
    const thicknessSlider = screen.getByRole('slider', {
      name: 'Link thickness',
    });
    expect(thicknessSlider).toHaveAttribute('aria-valuenow', '1');
    expect((computeFlexiToy as Mock).mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({ jointStyle: 'link', linkThicknessScale: 1 }),
    );

    (computeFlexiToy as Mock).mockClear();
    fireEvent.keyDown(thicknessSlider, { key: 'End' });
    await settle();

    expect(thicknessSlider).toHaveAttribute('aria-valuenow', '1.6');
    expect(computeFlexiToy).toHaveBeenCalledTimes(1);
    expect((computeFlexiToy as Mock).mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({ jointStyle: 'link', linkThicknessScale: 1.6 }),
    );

    // The Joint room slider follows the same contract (default 1x, Link-only,
    // recompute on change).
    const roomSlider = screen.getByRole('slider', { name: 'Joint room' });
    expect(roomSlider).toHaveAttribute('aria-valuenow', '1');
    (computeFlexiToy as Mock).mockClear();
    fireEvent.keyDown(roomSlider, { key: 'End' });
    await settle();
    expect(roomSlider).toHaveAttribute('aria-valuenow', '2');
    expect(computeFlexiToy).toHaveBeenCalledTimes(1);
    expect((computeFlexiToy as Mock).mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({ jointStyle: 'link', linkRoomScale: 2 }),
    );

    // Other styles neither show the controls nor send the fields.
    fireEvent.click(screen.getByRole('radio', { name: /Strong/ }));
    await settle();
    expect(screen.queryByRole('slider', { name: 'Link thickness' })).toBeNull();
    expect(screen.queryByRole('slider', { name: 'Joint room' })).toBeNull();
    const strongSettings = (computeFlexiToy as Mock).mock.calls.at(-1)?.[1];
    expect(strongSettings).not.toHaveProperty('linkThicknessScale');
    expect(strongSettings).not.toHaveProperty('linkRoomScale');
  });

  it('starts updating the preview while a slider is still being scrubbed', async () => {
    renderDialog();
    await settle();
    (computeFlexiToy as Mock).mockClear();

    // The Slider applies pointer values inside a rAF; running it synchronously
    // keeps the test about the gate rather than about frame timing.
    const raf = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 0;
      });

    try {
      const track = settingsSliderTrack('Joint size');
      fireEvent.pointerDown(track, { pointerId: 1, clientX: TRACK_WIDTH });
      await settle();

      // The read-out follows the pointer (0.6…1.4× range, pressed at the end)…
      expect(screen.getByText('1.40×')).toBeInTheDocument();
      // …and the matching preview starts without waiting for pointer-up or the
      // old fixed 200 ms delay.
      await act(async () => {
        await Promise.resolve();
      });
      expect(computeFlexiToy).toHaveBeenCalledTimes(1);
      expect((computeFlexiToy as Mock).mock.calls.at(-1)?.[1]).toEqual(
        expect.objectContaining({ jointScale: 1.4 }),
      );

      fireEvent.pointerUp(track, { pointerId: 1, clientX: TRACK_WIDTH });
      await act(async () => {
        await Promise.resolve();
      });
      expect(computeFlexiToy).toHaveBeenCalledTimes(1);
    } finally {
      raf.mockRestore();
    }
  });

  it('shows the newest cut intent immediately while certified geometry is pending', async () => {
    renderDialog();
    await settle();

    (computeFlexiToy as Mock).mockClear();
    (computeFlexiToy as Mock).mockImplementation(() => new Promise(() => {}));

    const pieces = screen.getByRole('slider', { name: 'Segments' });
    fireEvent.keyDown(pieces, { key: 'End' });
    await act(async () => {
      await Promise.resolve();
    });

    expect(pieces).toHaveAttribute('aria-valuenow', '20');
    expect(document.querySelector('[name="flexi-live-intent"]')).not.toBeNull();
    expect(document.querySelectorAll('[name^="flexi-ring-"]')).toHaveLength(19);
    expect(computeFlexiToy).toHaveBeenCalledTimes(1);
  });

  it('collapses same-tick setting changes into one zero-delay compute', async () => {
    renderDialog();
    await settle();

    // The initial compute for the default settings has run once.
    expect(computeFlexiToy).toHaveBeenCalledTimes(1);
    (computeFlexiToy as Mock).mockClear();

    // Three quick changes with no timer advance between them (Tight is the
    // open default, so it would be a no-op — use the other two presets).
    fireEvent.click(screen.getByRole('radio', { name: 'Standard' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Loose' }));
    fireEvent.click(screen.getByRole('radio', { name: 'X' }));

    expect(computeFlexiToy).toHaveBeenCalledTimes(0);

    await settle();

    expect(computeFlexiToy).toHaveBeenCalledTimes(1);
  });

  // The slicer-style layer view. It is a preview-only control (no recompute,
  // no settings change): scrubbing it must update the mm / layer read-out from
  // the result's print height and switch the body to the double-sided,
  // clipped draw; fully raised it must cost nothing (single-sided, no planes).
  it('scrubs a layer view over the print height without recomputing', async () => {
    renderDialog();
    await settle();
    (computeFlexiToy as Mock).mockClear();

    // fakeResult's tallest vertex is at y = 10 → 10.0 mm, 50 nominal layers.
    const slider = screen.getByRole('slider', { name: 'Layer view' });
    expect(slider).toHaveAttribute('aria-valuenow', '1');
    expect(screen.getByText('10.0')).toBeInTheDocument();
    expect(screen.getByText('50/50')).toBeInTheDocument();
    // Whole model shown → the plain single-sided draw, no clip planes.
    expect(
      document.querySelector('meshstandardmaterial[side="0"]'),
    ).not.toBeNull();

    fireEvent.keyDown(slider, { key: 'Home' });
    await settle();
    expect(slider).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByText('0.0')).toBeInTheDocument();
    expect(screen.getByText('0/50')).toBeInTheDocument();
    // Cut open → double-sided so the interior reads as solid through the slice.
    expect(
      document.querySelector('meshstandardmaterial[side="2"]'),
    ).not.toBeNull();

    // Preview-only: the layer view never triggers a compute.
    expect(computeFlexiToy).not.toHaveBeenCalled();
  });

  it('renders one cut ring and one strip handle per joint in the plan', async () => {
    renderDialog();
    await settle();

    // The dialog content is portaled to document.body, so query the document.
    const rings = document.querySelectorAll('[name^="flexi-ring-"]');
    expect(rings).toHaveLength(fakeResult.plan.joints.length);
    expect(
      document.querySelectorAll('[data-testid^="flexi-joint-handle-"]'),
    ).toHaveLength(fakeResult.plan.joints.length);
  });

  it('pins positions on a strip drag and the reset button restores even spacing', async () => {
    renderDialog();
    await settle();

    // A real drag commits the moved station as an explicit position.
    dragHandleTo(0, 0.4);
    await settle();

    // Positions are now explicit → the recompute must carry jointPositions with
    // a PINNED NUMERIC count satisfying the contract invariant
    // (jointPositions.length === segmentCount − 1). With 1 fused joint this only
    // holds if the pin came from fractions.length + 1, not result.segmentCount.
    const settingsArg = (computeFlexiToy as Mock).mock.calls.at(-1)?.[1];
    expect(typeof settingsArg.segmentCount).toBe('number');
    expect(settingsArg.jointPositions).toHaveLength(
      settingsArg.segmentCount - 1,
    );
    expect(settingsArg.jointPositions).toHaveLength(
      fakeResult.plan.joints.length,
    );
    expect(settingsArg.jointPositions[0]).toBeCloseTo(0.4, 5);

    const resetButton = screen.getByRole('button', { name: 'Even spacing' });
    fireEvent.click(resetButton);
    await settle();

    expect(
      screen.queryByRole('button', { name: 'Even spacing' }),
    ).not.toBeInTheDocument();
  });

  it('clamps a dragged cut inside the spine and between its neighbours', async () => {
    renderDialog();
    await settle();

    // Cut 0 sits at 0.25 and cut 1 at 0.5, so dragging past its neighbour stops
    // one margin (0.01) short of it.
    dragHandleTo(0, 0.9);
    await settle();
    let settingsArg = (computeFlexiToy as Mock).mock.calls.at(-1)?.[1];
    expect(settingsArg.jointPositions[0]).toBeCloseTo(0.49, 5);
    expect(settingsArg.jointPositions).toHaveLength(
      settingsArg.segmentCount - 1,
    );

    // Dragging off the head end stops at the spine-tip bound instead.
    dragHandleTo(0, -0.1);
    await settle();
    settingsArg = (computeFlexiToy as Mock).mock.calls.at(-1)?.[1];
    expect(settingsArg.jointPositions[0]).toBeCloseTo(0.02, 5);
  });

  it('does not commit or recompute when a strip handle is only tapped', async () => {
    renderDialog();
    await settle();
    (computeFlexiToy as Mock).mockClear();

    // Press and release without moving: not an edit.
    const handle = jointHandle(0);
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 250 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 250 });
    await settle();

    expect(computeFlexiToy).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'Even spacing' }),
    ).not.toBeInTheDocument();
  });

  it('commits a keyboard nudge of a strip handle after the key debounce', async () => {
    renderDialog();
    await settle();
    (computeFlexiToy as Mock).mockClear();

    fireEvent.keyDown(jointHandle(1), { key: 'ArrowLeft' });
    await settle();

    const settingsArg = (computeFlexiToy as Mock).mock.calls.at(-1)?.[1];
    expect(settingsArg.jointPositions).toHaveLength(
      settingsArg.segmentCount - 1,
    );
    // The nudged station moved one step towards the head, clamped between its
    // neighbours.
    expect(settingsArg.jointPositions[1]).toBeCloseTo(0.49, 5);
  });

  it('keeps automatic core warnings and fused counts out of the UI', async () => {
    renderDialog();
    await settle();

    expect(
      screen.queryByText('1 joint is too thin to move — it stays rigid.'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/\(1 fused\)/)).not.toBeInTheDocument();
  });

  it('keeps the full segment range open after a safe unreduced fit', async () => {
    renderDialog();
    await settle();

    const safeResult: FlexiToyResult = {
      ...fakeResult,
      segmentCount: 4,
      jointCount: 3,
      fusedJointCount: 0,
      plan: {
        ...fakeResult.plan,
        joints: [joint(0.25, false), joint(0.5, false), joint(0.75, false)],
        fit: {
          requestedSegmentCount: 4,
          resolvedSegmentCount: 4,
          maxSafeSegmentCount: 0,
          jointPositions: [0.25, 0.5, 0.75],
        },
      },
    };
    (computeFlexiToy as Mock).mockResolvedValue({
      status: 'ok',
      result: safeResult,
    });

    fireEvent.keyDown(screen.getByRole('slider', { name: 'Segments' }), {
      key: 'ArrowLeft',
    });
    await settle();

    const segments = screen.getByRole('slider', { name: 'Segments' });
    expect(segments).toHaveValue(4);
    expect(segments).toHaveAttribute('aria-valuemax', '20');
  });

  it('snaps an unsafe custom segment choice to the certified count without looping', async () => {
    renderDialog();
    await settle();

    const fittedResult: FlexiToyResult = {
      ...fakeResult,
      segmentCount: 3,
      jointCount: 2,
      fusedJointCount: 0,
      plan: {
        ...fakeResult.plan,
        joints: [joint(1 / 3, false), joint(2 / 3, false)],
        fit: {
          requestedSegmentCount: 20,
          resolvedSegmentCount: 3,
          maxSafeSegmentCount: 3,
          jointPositions: [1 / 3, 2 / 3],
        },
      },
    };
    (computeFlexiToy as Mock).mockClear();
    (computeFlexiToy as Mock).mockResolvedValue({
      status: 'ok',
      result: fittedResult,
    });

    const segments = screen.getByRole('slider', { name: 'Segments' });
    fireEvent.keyDown(segments, { key: 'End' });
    await settle();

    let fittedSegments = screen.getByRole('slider', { name: 'Segments' });
    expect(fittedSegments).toHaveValue('3');
    expect(fittedSegments).toHaveAttribute('max', '3');
    expect(computeFlexiToy).toHaveBeenCalledTimes(2);
    expect((computeFlexiToy as Mock).mock.calls[0][1].segmentCount).toBe(20);
    expect((computeFlexiToy as Mock).mock.calls[1][1].segmentCount).toBe(3);

    // More time cannot trigger another corrective compute from the same fit.
    await settle();
    expect(computeFlexiToy).toHaveBeenCalledTimes(2);

    // A different fit-affecting setting retries the user's original request and
    // reopens the product-wide cap until the next certified result lands.
    fireEvent.click(screen.getByRole('radio', { name: 'Loose' }));
    fittedSegments = screen.getByRole('slider', { name: 'Segments' });
    expect(fittedSegments).toHaveAttribute('aria-valuenow', '20');
    expect(fittedSegments).toHaveAttribute('aria-valuemax', '20');

    // Even when the new setting resolves to the exact same fit values (and the
    // mock returns the same result object), the newly landed certificate must
    // reapply its cap and settle after one corrective compute.
    await settle();
    fittedSegments = screen.getByRole('slider', { name: 'Segments' });
    expect(fittedSegments).toHaveValue('3');
    expect(fittedSegments).toHaveAttribute('max', '3');
    expect(computeFlexiToy).toHaveBeenCalledTimes(4);
    expect((computeFlexiToy as Mock).mock.calls[2][1].segmentCount).toBe(20);
    expect((computeFlexiToy as Mock).mock.calls[3][1].segmentCount).toBe(3);
  });

  it('shows the certified bend and retries the requested bend on a different fit', async () => {
    renderDialog();
    await settle();

    const fittedResult: FlexiToyResult = {
      ...fakeResult,
      plan: {
        ...fakeResult.plan,
        fit: {
          requestedSegmentCount: 5,
          resolvedSegmentCount: 5,
          maxSafeSegmentCount: 5,
          jointPositions: [0.2, 0.4, 0.6, 0.8],
          resolvedBendAngleDeg: 12,
        },
      },
    };
    (computeFlexiToy as Mock).mockClear();
    (computeFlexiToy as Mock).mockResolvedValue({
      status: 'ok',
      result: fittedResult,
    });

    const flexibility = screen.getByRole('slider', { name: 'Flexibility' });
    fireEvent.keyDown(flexibility, { key: 'End' });
    await settle();

    expect(flexibility).toHaveAttribute('aria-valuenow', '12');
    expect(computeFlexiToy).toHaveBeenCalledTimes(2);
    expect((computeFlexiToy as Mock).mock.calls[0][1].bendAngleDeg).toBe(90);
    expect((computeFlexiToy as Mock).mock.calls[1][1].bendAngleDeg).toBe(12);

    await settle();
    expect(computeFlexiToy).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('radio', { name: 'Loose' }));
    expect(flexibility).toHaveAttribute('aria-valuenow', '90');
    await settle();

    expect(flexibility).toHaveAttribute('aria-valuenow', '12');
    expect(computeFlexiToy).toHaveBeenCalledTimes(4);
    expect((computeFlexiToy as Mock).mock.calls[2][1].bendAngleDeg).toBe(90);
    expect((computeFlexiToy as Mock).mock.calls[3][1].bendAngleDeg).toBe(12);
  });

  it('keeps dragged positions coherent when auto-fit reduces their count', async () => {
    renderDialog();
    await settle();

    dragHandleTo(0, 0.4);
    await settle();

    const fittedResult: FlexiToyResult = {
      ...fakeResult,
      segmentCount: 3,
      jointCount: 2,
      fusedJointCount: 0,
      plan: {
        ...fakeResult.plan,
        joints: [joint(0.33, false), joint(0.67, false)],
        fit: {
          requestedSegmentCount: 4,
          resolvedSegmentCount: 3,
          maxSafeSegmentCount: 3,
          jointPositions: [0.33, 0.67],
        },
      },
    };
    (computeFlexiToy as Mock).mockClear();
    (computeFlexiToy as Mock).mockResolvedValue({
      status: 'ok',
      result: fittedResult,
    });

    fireEvent.click(screen.getByRole('radio', { name: 'Loose' }));
    await settle();

    expect(computeFlexiToy).toHaveBeenCalledTimes(2);
    const firstSettings = (computeFlexiToy as Mock).mock.calls[0][1];
    const resolvedSettings = (computeFlexiToy as Mock).mock.calls[1][1];
    expect(firstSettings.segmentCount).toBe(4);
    expect(firstSettings.jointPositions).toHaveLength(3);
    expect(resolvedSettings.segmentCount).toBe(3);
    expect(resolvedSettings.jointPositions).toEqual([0.33, 0.67]);
    expect(resolvedSettings.jointPositions).toHaveLength(
      resolvedSettings.segmentCount - 1,
    );
  });

  it('invokes the export helpers when the download buttons are clicked', async () => {
    renderDialog();
    await settle();

    fireEvent.click(screen.getByRole('button', { name: '.3MF' }));
    await settle();
    expect(flexiResultToThreeMfBlob).toHaveBeenCalledWith(
      fakeResult,
      'test-model',
    );

    fireEvent.click(screen.getByRole('button', { name: '.STL' }));
    await settle();
    expect(flexiResultToStlBlob).toHaveBeenCalledWith(fakeResult);
  });

  it('lands a stricter final fit on screen before exporting it', async () => {
    renderDialog();
    await settle();

    const finalResult: FlexiToyResult = {
      ...fakeResult,
      segmentCount: 3,
      jointCount: 2,
      fusedJointCount: 0,
      lengthMm: 149,
      plan: {
        ...fakeResult.plan,
        joints: [joint(0.33, false), joint(0.67, false)],
        fit: {
          requestedSegmentCount: 5,
          resolvedSegmentCount: 3,
          maxSafeSegmentCount: 3,
          jointPositions: [0.33, 0.67],
          resolvedBendAngleDeg: 5,
        },
      },
    };
    (computeFlexiToy as Mock).mockClear();
    (computeFlexiToy as Mock).mockResolvedValue({
      status: 'ok',
      result: finalResult,
    });

    fireEvent.click(screen.getByRole('button', { name: '.STL' }));
    await settle();

    expect(flexiResultToStlBlob).toHaveBeenCalledWith(finalResult);
    expect(screen.getByRole('slider', { name: 'Segments' })).toHaveValue('3');
    expect(screen.getByRole('slider', { name: 'Segments' })).toHaveAttribute(
      'max',
      '3',
    );
    expect(screen.getByRole('slider', { name: 'Flexibility' })).toHaveAttribute(
      'aria-valuenow',
      '5',
    );
    expect(screen.getAllByTestId(/flexi-joint-handle-/)).toHaveLength(2);
  });

  // The preview on screen is built at 'preview' quality (simplified body), so a
  // download has to re-run the same settings at 'final' and export THAT — the
  // file is the thing that gets printed.
  it('downloads a full-quality build', async () => {
    renderDialog();
    await settle();

    // A distinct object so "which result was exported" is unambiguous.
    const finalResult: FlexiToyResult = { ...fakeResult, lengthMm: 149 };
    (computeFlexiToy as Mock).mockClear();
    (computeFlexiToy as Mock).mockResolvedValue({
      status: 'ok',
      result: finalResult,
    });

    fireEvent.click(screen.getByRole('button', { name: '.STL' }));
    await settle();

    expect((computeFlexiToy as Mock).mock.calls.at(-1)?.[2]).toBe('final');
    expect(flexiResultToStlBlob).toHaveBeenCalledWith(finalResult);
    expect(flexiResultToStlBlob).not.toHaveBeenCalledWith(fakeResult);

    // A final build the user supersedes by changing a setting mid-build must
    // NOT fall back to exporting the on-screen preview — the file would not
    // match what they are looking at. (The preset click also moves the settings
    // key, so the cached final result above cannot answer the second click.)
    (computeFlexiToy as Mock).mockResolvedValue({ status: 'superseded' });
    fireEvent.click(screen.getByRole('radio', { name: 'Loose' }));
    await settle();
    (flexiResultToThreeMfBlob as Mock).mockClear();

    fireEvent.click(screen.getByRole('button', { name: '.3MF' }));
    await settle();

    expect((computeFlexiToy as Mock).mock.calls.at(-1)?.[2]).toBe('final');
    expect(flexiResultToThreeMfBlob).not.toHaveBeenCalled();
  });

  it('disables downloads when a later compute errors over a previous result', async () => {
    renderDialog();
    await settle();

    // First compute succeeded, so the buttons export a real result.
    expect(screen.getByRole('button', { name: '.STL' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '.3MF' })).toBeEnabled();

    // A settings change triggers a recompute that fails while the previous
    // (now stale) result is still held in state.
    (computeFlexiToy as Mock).mockResolvedValue({
      status: 'error',
      code: 'not-watertight',
      message: 'open mesh',
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Loose' }));
    await settle();

    expect(
      screen.getByText("This model can't be made flexi"),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '.STL' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '.3MF' })).toBeDisabled();
  });

  it('recovers a too-small build once with the safest settings and keeps the style', async () => {
    (computeFlexiToy as Mock)
      .mockResolvedValueOnce({
        status: 'error',
        code: 'too-small',
        message: 'not enough room',
      })
      .mockResolvedValueOnce({ status: 'ok', result: fakeResult });

    renderDialog();
    await settle();

    expect(computeFlexiToy).toHaveBeenCalledTimes(2);
    expect((computeFlexiToy as Mock).mock.calls[1][1]).toEqual(
      expect.objectContaining({
        jointStyle: 'link',
        segmentCount: 3,
        targetLengthMm: 400,
        bendAngleDeg: 5,
        clearanceMm: 0.2,
        linkThicknessScale: 0.6,
        linkRoomScale: 0.5,
      }),
    );
    expect(
      (computeFlexiToy as Mock).mock.calls[1][1].jointPositions,
    ).toBeUndefined();
    expect(
      screen.queryByText('This model is a little too small'),
    ).not.toBeInTheDocument();
  });

  it('shows too-small only after the safest retry also fails', async () => {
    (computeFlexiToy as Mock).mockResolvedValue({
      status: 'error',
      code: 'too-small',
      message: 'not enough room',
    });

    renderDialog();
    await settle();

    expect(computeFlexiToy).toHaveBeenCalledTimes(2);
    expect(
      screen.getByText('This model is a little too small'),
    ).toBeInTheDocument();

    await settle();
    expect(computeFlexiToy).toHaveBeenCalledTimes(2);
  });

  it('shows a friendly error state when the core cannot build the toy', async () => {
    (computeFlexiToy as Mock).mockResolvedValue({
      status: 'error',
      code: 'not-watertight',
      message: 'open mesh',
    });

    renderDialog();
    await settle();

    expect(
      screen.getByText("This model can't be made flexi"),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '.3MF' })).toBeDisabled();
  });

  it('offers a Strong recovery path when the cut fails on the shell style', async () => {
    renderDialog();
    await settle();

    // Switching to shell fails with the uncut error; later computes (after the
    // user recovers back to strong) fall back to the default ok mock.
    (computeFlexiToy as Mock).mockResolvedValueOnce({
      status: 'error',
      code: 'rounded-uncut',
      message: 'off-axis feature',
    });
    fireEvent.click(screen.getByRole('radio', { name: /Shell/ }));
    await settle();

    expect(
      screen.getByText("These joints don't fit this shape"),
    ).toBeInTheDocument();

    const recover = screen.getByRole('button', { name: 'Switch to Strong' });
    (computeFlexiToy as Mock).mockClear();
    fireEvent.click(recover);
    await settle();

    // Strong is no longer the opening default, so recovery computes it once and
    // clears the error.
    expect(computeFlexiToy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('radio', { name: /Strong/ })).toBeChecked();
    expect(
      screen.queryByText("These joints don't fit this shape"),
    ).not.toBeInTheDocument();
  });
});
