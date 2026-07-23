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
// jsdom): the mesh + cut-ring subtree mounts so the ring handles are queryable,
// while OrbitControls/Environment are inert.
vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="flexi-canvas">{children}</div>
  ),
}));
vi.mock('@react-three/drei', () => ({
  Environment: () => null,
  OrbitControls: () => null,
  Stage: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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

// Advances the debounce + flushes the async derive/compute microtasks. Called
// a couple times because the length-derivation promise and the compute timer
// resolve across separate ticks.
async function settle() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
  }
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

  it('sends the flexibility angle and loose default in the compute settings', async () => {
    renderDialog();
    await settle();

    expect(computeFlexiToy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ bendAngleDeg: 12, clearanceMm: 0.55 }),
    );
  });

  it('collapses rapid setting changes into a single compute after the debounce', async () => {
    renderDialog();
    await settle();

    // The initial compute for the default settings has run once.
    expect(computeFlexiToy).toHaveBeenCalledTimes(1);
    (computeFlexiToy as Mock).mockClear();

    // Three quick changes with no timer advance between them.
    fireEvent.click(screen.getByRole('radio', { name: 'Tight' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Loose' }));
    fireEvent.click(screen.getByRole('radio', { name: 'X' }));

    expect(computeFlexiToy).toHaveBeenCalledTimes(0);

    await settle();

    expect(computeFlexiToy).toHaveBeenCalledTimes(1);
  });

  it('renders one draggable cut ring per joint in the plan', async () => {
    renderDialog();
    await settle();

    // The dialog content is portaled to document.body, so query the document.
    const rings = document.querySelectorAll('[name^="flexi-ring-"]');
    expect(rings).toHaveLength(fakeResult.plan.joints.length);
  });

  it('pins positions on ring drag and the reset button restores even spacing', async () => {
    renderDialog();
    await settle();

    // A drag (down then up) commits the current stations as explicit positions.
    const ring = document.querySelector('[name="flexi-ring-0"]');
    expect(ring).not.toBeNull();
    fireEvent.pointerDown(ring as Element);
    fireEvent.pointerUp(ring as Element);
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
    const resetButton = screen.getByRole('button', { name: 'Even spacing' });

    fireEvent.click(resetButton);
    await settle();

    expect(
      screen.queryByRole('button', { name: 'Even spacing' }),
    ).not.toBeInTheDocument();
  });

  it('renders warnings returned by the core as amber helper text', async () => {
    renderDialog();
    await settle();

    expect(
      screen.getByText('1 joint is too thin to move — it stays rigid.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 fused/)).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('radio', { name: 'Tight' }));
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
});
