/**
 * Protocol tests for the flexi worker: register-once, per-scale body reuse,
 * preview/final body selection, and cancel reaching a running build at its
 * checkpoint. The manifold build itself is mocked — these pin the plumbing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlexiWorkerRequest } from '@/utils/flexiToyTypes';

const build = vi.hoisted(() => ({
  prepareFlexiBody: vi.fn(),
  disposeFlexiPreparedBody: vi.fn(),
  deriveFlexiPreviewBody: vi.fn(),
  clearFlexiSolidCache: vi.fn(),
  buildFlexiToy: vi.fn(),
  loadManifold: vi.fn(),
}));
const plan = vi.hoisted(() => ({
  computeFlexiScale: vi.fn(),
  scaleFlexiPositions: vi.fn(),
  planFlexiToy: vi.fn(),
}));

vi.mock('manifold-3d/manifold.wasm?url', () => ({ default: 'manifold.wasm' }));
vi.mock('@/utils/flexiToyBuild', () => build);
vi.mock('@/utils/flexiToyPlan', () => plan);

type Posted = { message: unknown; transfer?: Transferable[] };

const posted: Posted[] = [];
let onmessage: ((event: { data: FlexiWorkerRequest }) => void) | null = null;

const input = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
  colors: new Float32Array(9),
};
const settings = {
  segmentCount: 5,
  clearanceMm: 0.4,
  targetLengthMm: 400,
  jointScale: 1,
  axisOverride: 'auto' as const,
  jointStyle: 'link' as const,
  bendAngleDeg: 8,
};

function send(message: FlexiWorkerRequest): void {
  onmessage?.({ data: message });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function okResult(attemptSettings = settings) {
  return {
    status: 'ok' as const,
    result: {
      positions: new Float32Array(3),
      indices: new Uint32Array(3),
      colors: new Float32Array(3),
      segmentTriangleRanges: [],
      segmentCount: 1,
      jointCount: 0,
      fusedJointCount: 0,
      lengthMm: 1,
      plan: {
        joints: [],
        spine: [],
        spineLengthMm: 1,
        warnings: [],
        fit: {
          requestedSegmentCount: 1,
          resolvedSegmentCount: 1,
          maxSafeSegmentCount: 0,
          jointPositions: [],
          resolvedBendAngleDeg: attemptSettings.bendAngleDeg,
        },
      },
      warnings: [],
    },
  };
}

beforeEach(async () => {
  vi.resetModules();
  posted.length = 0;
  onmessage = null;
  vi.stubGlobal('self', {
    postMessage: (message: unknown, options?: { transfer?: Transferable[] }) =>
      posted.push({ message, transfer: options?.transfer }),
    set onmessage(handler: typeof onmessage) {
      onmessage = handler;
    },
  });
  build.loadManifold.mockResolvedValue({});
  build.prepareFlexiBody.mockImplementation(async () => ({
    manifold: { numTri: () => 100 },
    repaired: false,
    colorGrid: {},
  }));
  build.deriveFlexiPreviewBody.mockReturnValue(null);
  build.buildFlexiToy.mockImplementation(
    async (_wasm, _mesh, _plan, attemptSettings) => okResult(attemptSettings),
  );
  plan.computeFlexiScale.mockReturnValue(2);
  plan.scaleFlexiPositions.mockImplementation((p: Float32Array) => p);
  plan.planFlexiToy.mockReturnValue({
    joints: [],
    spine: [],
    spineLengthMm: 1,
    warnings: [],
  });
  for (const fn of Object.values(build)) fn.mockClear();
  for (const fn of Object.values(plan)) fn.mockClear();
  await import('./flexiToyWorker');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('flexiToyWorker protocol', () => {
  it('prepares the body once per scale and reuses it across computes', async () => {
    send({ type: 'register', meshId: 1, input });
    send({
      type: 'compute',
      requestId: 1,
      meshId: 1,
      settings,
      quality: 'preview',
    });
    send({
      type: 'compute',
      requestId: 2,
      meshId: 1,
      settings: { ...settings, bendAngleDeg: 20 },
      quality: 'preview',
    });
    await flush();

    expect(build.prepareFlexiBody).toHaveBeenCalledTimes(1);
    expect(build.buildFlexiToy).toHaveBeenCalledTimes(2);
    expect(
      posted.map((p) => (p.message as { requestId: number }).requestId),
    ).toEqual([1, 2]);
    // Results are transferred, not copied.
    expect(posted[0].transfer).toHaveLength(3);
  });

  it('plans and measures on the dense mesh but builds preview booleans on the simplified twin', async () => {
    const previewBody = {
      manifold: { numTri: () => 10 },
      repaired: false,
      colorGrid: {},
    };
    build.prepareFlexiBody.mockResolvedValue({
      manifold: { numTri: () => 50_000 },
      repaired: false,
      colorGrid: {},
    });
    build.deriveFlexiPreviewBody.mockReturnValue({
      body: previewBody,
      meshInput: { ...input, positions: new Float32Array(3) },
    });

    send({ type: 'register', meshId: 1, input });
    send({
      type: 'compute',
      requestId: 1,
      meshId: 1,
      settings,
      quality: 'preview',
    });
    send({
      type: 'compute',
      requestId: 2,
      meshId: 1,
      settings,
      quality: 'final',
    });
    await flush();

    const [previewCall, finalCall] = build.buildFlexiToy.mock.calls;
    // Preview: dense mesh input, simplified body.
    expect(previewCall[1].positions).toBe(input.positions);
    expect(previewCall[4].prepared).toBe(previewBody);
    expect(previewCall[4].quality).toBe('preview');
    // Final: dense mesh input, exact body.
    expect(finalCall[1].positions).toBe(input.positions);
    expect(finalCall[4].prepared).not.toBe(previewBody);
    expect(finalCall[4].quality).toBe('final');
    // The plan was computed from the dense mesh both times.
    for (const call of plan.planFlexiToy.mock.calls) {
      expect(call[0].positions).toBe(input.positions);
    }
  });

  it('aborts a running build at its checkpoint when cancelled, and still answers it', async () => {
    const checkpoints: number[] = [];
    build.buildFlexiToy.mockImplementation(async (_w, _m, _p, _s, options) => {
      // Simulate the per-joint loop: keep checking until told to stop.
      const index = checkpoints.push(0) - 1;
      for (let joint = 0; joint < 50; joint += 1) {
        checkpoints[index] += 1;
        if (await options.control.checkpoint()) return { status: 'aborted' };
      }
      return okResult();
    });

    send({ type: 'register', meshId: 1, input });
    send({
      type: 'compute',
      requestId: 1,
      meshId: 1,
      settings,
      quality: 'preview',
    });
    // Let the build reach its first checkpoint, then cancel it mid-flight.
    await new Promise((resolve) => setTimeout(resolve, 0));
    send({ type: 'cancel', requestId: 1 });
    send({
      type: 'compute',
      requestId: 2,
      meshId: 1,
      settings,
      quality: 'preview',
    });
    // The second build yields once per simulated joint; give it room to finish.
    for (let i = 0; i < 10; i += 1) await flush();

    // The cancelled build stopped early; the next one ran to completion.
    expect(checkpoints[0]).toBeLessThan(50);
    expect(checkpoints[1]).toBe(50);
    const answers = posted.map(
      (p) => p.message as { requestId: number; outcome: { status: string } },
    );
    expect(answers.map((a) => a.requestId)).toEqual([1, 2]);
    expect(answers[0].outcome.status).toBe('error');
    expect(answers[1].outcome.status).toBe('ok');
  });

  it('registering a new mesh disposes the old bodies and the solid cache', async () => {
    send({ type: 'register', meshId: 1, input });
    send({
      type: 'compute',
      requestId: 1,
      meshId: 1,
      settings,
      quality: 'preview',
    });
    await flush();
    send({ type: 'register', meshId: 2, input });
    send({
      type: 'compute',
      requestId: 2,
      meshId: 2,
      settings,
      quality: 'preview',
    });
    await flush();

    expect(build.disposeFlexiPreparedBody).toHaveBeenCalledTimes(1);
    expect(build.clearFlexiSolidCache).toHaveBeenCalled();
    expect(build.prepareFlexiBody).toHaveBeenCalledTimes(2);
  });

  it('answers a compute for an unknown mesh with an error', async () => {
    send({
      type: 'compute',
      requestId: 7,
      meshId: 99,
      settings,
      quality: 'preview',
    });
    await flush();
    const answer = posted[0].message as {
      outcome: { status: string; code: string };
    };
    expect(answer.outcome.status).toBe('error');
    expect(answer.outcome.code).toBe('compute-failed');
  });
});
