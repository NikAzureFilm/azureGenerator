/**
 * Style-certification recovery tests. The geometry modules are mocked so these
 * pin only the worker's invisible retry policy and honest exhaustion behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FlexiToySettings,
  FlexiToyWarning,
  FlexiWorkerRequest,
} from '@/utils/flexiToyTypes';

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
const settings: FlexiToySettings = {
  segmentCount: 5,
  clearanceMm: 0.4,
  targetLengthMm: 400,
  jointScale: 1,
  axisOverride: 'auto',
  jointStyle: 'link',
  bendAngleDeg: 8,
  jointPositions: [0.2, 0.4, 0.6, 0.8],
};

function send(message: FlexiWorkerRequest): void {
  onmessage?.({ data: message });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function segmentCountFor(value: FlexiToySettings['segmentCount']): number {
  return value === 'auto' ? 5 : value;
}

function okResult(
  attemptSettings: FlexiToySettings,
  warnings: FlexiToyWarning[],
  fusedJointCount = 0,
  resolvedBendAngleDeg: number | null = attemptSettings.bendAngleDeg,
  maxSafeSegmentCount: number | null = null,
) {
  const segmentCount = segmentCountFor(attemptSettings.segmentCount);
  return {
    status: 'ok' as const,
    result: {
      positions: new Float32Array(3),
      indices: new Uint32Array(3),
      colors: new Float32Array(3),
      segmentTriangleRanges: [],
      segmentCount,
      jointCount: segmentCount - 1 - fusedJointCount,
      fusedJointCount,
      lengthMm: attemptSettings.targetLengthMm,
      plan: {
        joints: Array.from({ length: segmentCount - 1 }, () => ({})),
        spine: [],
        spineLengthMm: attemptSettings.targetLengthMm,
        warnings: [],
        fit: {
          requestedSegmentCount: segmentCount,
          resolvedSegmentCount: segmentCount,
          maxSafeSegmentCount: maxSafeSegmentCount ?? segmentCount,
          jointPositions: Array.from(
            { length: segmentCount - 1 },
            (_, index) => (index + 1) / segmentCount,
          ),
          ...(resolvedBendAngleDeg === null ? {} : { resolvedBendAngleDeg }),
        },
      },
      warnings,
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
  build.prepareFlexiBody.mockResolvedValue({
    manifold: { numTri: () => 100 },
    repaired: false,
    colorGrid: {},
  });
  build.deriveFlexiPreviewBody.mockReturnValue(null);
  plan.computeFlexiScale.mockReturnValue(1);
  plan.scaleFlexiPositions.mockImplementation(
    (positions: Float32Array) => positions,
  );
  plan.planFlexiToy.mockImplementation(
    (_mesh: unknown, attemptSettings: FlexiToySettings) => {
      const segmentCount = segmentCountFor(attemptSettings.segmentCount);
      return {
        joints: Array.from({ length: segmentCount - 1 }, () => ({})),
        spine: [],
        spineLengthMm: attemptSettings.targetLengthMm,
        warnings: [],
      };
    },
  );
  for (const fn of Object.values(build)) fn.mockClear();
  for (const fn of Object.values(plan)) fn.mockClear();
  await import('./flexiToyWorker');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('flexiToyWorker style certification', () => {
  it('retries a style fallback with fewer unpinned segments and returns the first certified build', async () => {
    build.buildFlexiToy.mockImplementation(
      async (
        _wasm: unknown,
        _mesh: unknown,
        _plan: unknown,
        attemptSettings: FlexiToySettings,
      ) => {
        const count = segmentCountFor(attemptSettings.segmentCount);
        return okResult(
          attemptSettings,
          count > 3
            ? [
                {
                  code: 'link-joint-fallback',
                  message: 'A Link joint used a rounded groove.',
                },
              ]
            : [],
        );
      },
    );

    send({ type: 'register', meshId: 1, input });
    send({
      type: 'compute',
      requestId: 1,
      meshId: 1,
      settings,
      quality: 'preview',
    });
    await flush();

    const attempted = build.buildFlexiToy.mock.calls.map(
      (call) => call[3] as FlexiToySettings,
    );
    expect(attempted.map((value) => value.segmentCount)).toEqual([5, 4, 3]);
    expect(attempted[0].jointPositions).toEqual(settings.jointPositions);
    expect(attempted.slice(1).every((value) => !value.jointPositions)).toBe(
      true,
    );
    for (const value of attempted) {
      expect(value.jointStyle).toBe('link');
      expect(value.bendAngleDeg).toBe(settings.bendAngleDeg);
      expect(value.targetLengthMm).toBe(settings.targetLengthMm);
    }

    const answer = posted[0].message as {
      outcome: {
        status: string;
        result: {
          segmentCount: number;
          warnings: FlexiToyWarning[];
          plan: {
            fit: {
              requestedSegmentCount: number;
              resolvedSegmentCount: number;
              maxSafeSegmentCount: number;
            };
          };
        };
      };
    };
    expect(answer.outcome.status).toBe('ok');
    expect(answer.outcome.result.segmentCount).toBe(3);
    expect(answer.outcome.result.warnings).toEqual([]);
    expect(answer.outcome.result.plan.fit).toMatchObject({
      requestedSegmentCount: 5,
      resolvedSegmentCount: 3,
      maxSafeSegmentCount: 3,
    });
  });

  it('returns an honest error if every bounded recovery attempt falls back', async () => {
    build.buildFlexiToy.mockImplementation(
      async (
        _wasm: unknown,
        _mesh: unknown,
        _plan: unknown,
        attemptSettings: FlexiToySettings,
      ) =>
        okResult(attemptSettings, [
          {
            code: 'link-joint-fallback',
            message: 'A Link joint used a rounded groove.',
          },
        ]),
    );

    send({ type: 'register', meshId: 1, input });
    send({
      type: 'compute',
      requestId: 1,
      meshId: 1,
      settings,
      quality: 'preview',
    });
    await flush();

    const attemptedCounts = build.buildFlexiToy.mock.calls.map(
      (call) => (call[3] as FlexiToySettings).segmentCount,
    );
    expect(attemptedCounts).toEqual([5, 4, 3]);
    const answer = posted[0].message as {
      outcome: {
        status: string;
        code: string;
        message: string;
      };
    };
    expect(answer.outcome.status).toBe('error');
    expect(answer.outcome.code).toBe('too-small');
    expect(answer.outcome.message).toContain('Link');
  });

  it('accepts reduced travel when the build returns a representable lower applied bend', async () => {
    build.buildFlexiToy.mockImplementation(
      async (
        _wasm: unknown,
        _mesh: unknown,
        _plan: unknown,
        attemptSettings: FlexiToySettings,
      ) =>
        okResult(
          attemptSettings,
          [
            {
              code: 'link-travel-reduced',
              message: 'One joint bends less than requested.',
            },
          ],
          0,
          6,
          20,
        ),
    );

    send({ type: 'register', meshId: 1, input });
    send({
      type: 'compute',
      requestId: 1,
      meshId: 1,
      settings,
      quality: 'preview',
    });
    await flush();

    expect(build.buildFlexiToy).toHaveBeenCalledTimes(1);
    const answer = posted[0].message as {
      outcome: {
        status: string;
        result: {
          plan: {
            fit: {
              resolvedBendAngleDeg: number;
              maxSafeSegmentCount: number;
            };
          };
        };
      };
    };
    expect(answer.outcome.status).toBe('ok');
    expect(answer.outcome.result.plan.fit.resolvedBendAngleDeg).toBe(6);
    expect(answer.outcome.result.plan.fit.maxSafeSegmentCount).toBe(20);
  });

  it('retries reduced travel that falls below the representable slider range', async () => {
    build.buildFlexiToy.mockImplementation(
      async (
        _wasm: unknown,
        _mesh: unknown,
        _plan: unknown,
        attemptSettings: FlexiToySettings,
      ) => {
        const count = segmentCountFor(attemptSettings.segmentCount);
        return count === 5
          ? okResult(
              attemptSettings,
              [
                {
                  code: 'link-travel-reduced',
                  message: 'One joint bends less than requested.',
                },
              ],
              0,
              null,
            )
          : okResult(attemptSettings, []);
      },
    );

    send({ type: 'register', meshId: 1, input });
    send({
      type: 'compute',
      requestId: 1,
      meshId: 1,
      settings,
      quality: 'preview',
    });
    await flush();

    const attemptedCounts = build.buildFlexiToy.mock.calls.map(
      (call) => (call[3] as FlexiToySettings).segmentCount,
    );
    expect(attemptedCounts).toEqual([5, 4]);
    const answer = posted[0].message as {
      outcome: {
        status: string;
        result: {
          segmentCount: number;
          plan: {
            fit: {
              requestedSegmentCount: number;
              resolvedBendAngleDeg: number;
            };
          };
        };
      };
    };
    expect(answer.outcome.status).toBe('ok');
    expect(answer.outcome.result.segmentCount).toBe(4);
    expect(answer.outcome.result.plan.fit.requestedSegmentCount).toBe(5);
    expect(answer.outcome.result.plan.fit.resolvedBendAngleDeg).toBe(8);
  });

  it('retries warning-free fused stations until every station articulates', async () => {
    build.buildFlexiToy.mockImplementation(
      async (
        _wasm: unknown,
        _mesh: unknown,
        _plan: unknown,
        attemptSettings: FlexiToySettings,
      ) => {
        const count = segmentCountFor(attemptSettings.segmentCount);
        return okResult(attemptSettings, [], count > 3 ? 1 : 0);
      },
    );

    send({ type: 'register', meshId: 1, input });
    send({
      type: 'compute',
      requestId: 1,
      meshId: 1,
      settings,
      quality: 'preview',
    });
    await flush();

    const attemptedCounts = build.buildFlexiToy.mock.calls.map(
      (call) => (call[3] as FlexiToySettings).segmentCount,
    );
    expect(attemptedCounts).toEqual([5, 4, 3]);
    const answer = posted[0].message as {
      outcome: {
        status: string;
        result: { fusedJointCount: number; warnings: FlexiToyWarning[] };
      };
    };
    expect(answer.outcome.status).toBe('ok');
    expect(answer.outcome.result.fusedJointCount).toBe(0);
    expect(answer.outcome.result.warnings).toEqual([]);
  });
});
