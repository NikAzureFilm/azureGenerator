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

// Advances the debounce + flushes the async mesh-input/compute microtasks.
// Looped because the warm-up promise and the compute timer resolve across
// separate ticks.
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

  it('collapses rapid setting changes into a single compute after the debounce', async () => {
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

  it('renders warnings returned by the core as amber helper text', async () => {
    renderDialog();
    await settle();

    expect(
      screen.getByText('1 joint is too thin to move — it stays rigid.'),
    ).toBeInTheDocument();
    // The stats line (segments · joints · mm) sits with the joints strip.
    expect(screen.getByText(/\(1 fused\)/)).toBeInTheDocument();
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
