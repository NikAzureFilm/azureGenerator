/**
 * Main-thread client for the flat-bottom cut worker.
 *
 * Latest-wins with a single in-flight request, mirroring `flexiToyClient.ts`:
 * switching meshes quickly must never leave an older cut racing a newer one.
 * The manifold WASM lives entirely in the worker chunk — this module never
 * imports the cut implementation, only its types.
 *
 * Every request is guaranteed to settle. The cut sits on the viewer's critical
 * path (the model is not shown until it resolves), so a worker that fails to
 * load, throws on startup or dies mid-cut must surface as an error outcome
 * rather than a promise that never settles — otherwise the viewer would hang
 * with no model, no error and no way back.
 */

import type { CutMeshInput } from './flatBottomCut';
import type {
  FlatBottomOutcome,
  FlatBottomWorkerRequest,
  FlatBottomWorkerResponse,
} from './flatBottomTypes';

/**
 * Ceiling for one cut. Generous: a dense mesh runs several manifold trims, and
 * the WASM has to load on the first call. This exists to break a wedged worker,
 * not to bound normal work.
 */
const CUT_TIMEOUT_MS = 120_000;

let worker: Worker | null = null;
let nextRequestId = 1;

let inFlightRequestId: number | null = null;
let inFlightTimeout: ReturnType<typeof setTimeout> | null = null;
let latest: {
  requestId: number;
  resolve: (outcome: FlatBottomOutcome) => void;
} | null = null;
let queued: { requestId: number; meshes: CutMeshInput[] } | null = null;

function clearInFlight(): void {
  inFlightRequestId = null;
  if (inFlightTimeout !== null) {
    clearTimeout(inFlightTimeout);
    inFlightTimeout = null;
  }
}

/** Settle the pending caller (if it is still the latest) with `outcome`. */
function settleLatest(requestId: number, outcome: FlatBottomOutcome): void {
  if (!latest || latest.requestId !== requestId) return;
  const resolve = latest.resolve;
  latest = null;
  resolve(outcome);
}

function drainQueue(): void {
  if (queued && inFlightRequestId === null) {
    const next = queued;
    queued = null;
    postToWorker(next.requestId, next.meshes);
  }
}

/**
 * Tear the worker down so the next request starts a fresh one. Called whenever
 * the worker is presumed broken (load error, uncaught throw, timeout) — without
 * this, a single failure would park every later cut in the queue forever.
 */
function discardWorker(): void {
  const dying = worker;
  worker = null;
  clearInFlight();
  try {
    dying?.terminate();
  } catch {
    // Already gone.
  }
}

function failInFlight(message: string): void {
  const requestId = inFlightRequestId;
  discardWorker();
  if (requestId !== null) {
    settleLatest(requestId, {
      status: 'error',
      code: 'compute-failed',
      message,
    });
  }
  // A queued request would have to run on a new worker; let it try.
  if (queued) {
    const next = queued;
    queued = null;
    postToWorker(next.requestId, next.meshes);
  }
}

function postToWorker(requestId: number, meshes: CutMeshInput[]): void {
  const activeWorker = getWorker();
  if (!activeWorker) {
    settleLatest(requestId, {
      status: 'error',
      code: 'compute-failed',
      message: 'Flat-bottom trimming is not available in this environment.',
    });
    return;
  }

  inFlightRequestId = requestId;
  inFlightTimeout = setTimeout(() => {
    failInFlight('Cutting the bottom flat timed out.');
  }, CUT_TIMEOUT_MS);

  const request: FlatBottomWorkerRequest = {
    type: 'compute',
    requestId,
    meshes,
  };
  try {
    activeWorker.postMessage(request);
  } catch (error) {
    failInFlight(
      error instanceof Error
        ? error.message
        : 'The flat-bottom worker could not be reached.',
    );
  }
}

function getWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (!worker) {
    try {
      worker = new Worker(
        new URL('../worker/flatBottomWorker.ts', import.meta.url),
        { type: 'module' },
      );
    } catch {
      return null;
    }
    worker.addEventListener(
      'message',
      (event: MessageEvent<FlatBottomWorkerResponse>) => {
        const data = event.data;
        if (!data || data.type !== 'result') return;
        if (data.requestId === inFlightRequestId) {
          clearInFlight();
        }
        // Only the current latest request receives a real result; responses to
        // already-superseded requests are dropped.
        settleLatest(data.requestId, data.outcome);
        drainQueue();
      },
    );
    // A worker that 404s (stale index.html after a deploy), throws on startup,
    // or dies mid-cut fires here and never posts a result.
    worker.addEventListener('error', (event: ErrorEvent) => {
      failInFlight(event.message || 'The flat-bottom worker failed to start.');
    });
    worker.addEventListener('messageerror', () => {
      failInFlight('The flat-bottom worker sent an unreadable result.');
    });
  }
  return worker;
}

/**
 * Cut the given world-space meshes flat along a shared plane near their
 * underside. A newer call supersedes any in-flight one, whose promise resolves
 * `{ status: 'superseded' }`. Always settles.
 */
export function computeFlatBottom(
  meshes: CutMeshInput[],
): Promise<FlatBottomOutcome> {
  if (typeof Worker === 'undefined') {
    return Promise.resolve({
      status: 'error',
      code: 'compute-failed',
      message: 'Flat-bottom trimming is not available in this environment.',
    });
  }

  if (latest) {
    const superseded = latest.resolve;
    latest = null;
    superseded({ status: 'superseded' });
  }
  queued = null;

  const requestId = nextRequestId++;
  return new Promise<FlatBottomOutcome>((resolve) => {
    latest = { requestId, resolve };
    if (inFlightRequestId === null) {
      postToWorker(requestId, meshes);
    } else {
      queued = { requestId, meshes };
    }
  });
}
