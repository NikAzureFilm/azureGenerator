/**
 * Module worker for the Flexi Toy Maker.
 *
 * The mesh is REGISTERED once (`{ type: 'register' }`): one structured clone of
 * the megabyte-scale typed arrays for the whole session. Every later
 * `{ type: 'compute' }` names it by `meshId` and carries only settings, so a
 * slider tweak costs a few hundred bytes on the wire instead of the entire body.
 *
 * The expensive part of a build is turning that mesh into a watertight manifold,
 * and only the target-length slider changes it (it is the only setting that
 * scales the model). So prepared bodies are cached PER SCALE — an LRU of three,
 * enough to flick between a couple of lengths — and every other slider reuses
 * one. Bodies above `PREVIEW_SIMPLIFY_MIN_TRIANGLES` also get a simplified twin
 * that `quality: 'preview'` builds against; downloads ask for `'final'` and get
 * the exact body.
 *
 * `{ type: 'cancel' }` is handled synchronously in `onmessage` (see the note
 * there) and abandons a running build at its next checkpoint — between joints.
 * The cancelled request is still answered, so the client's back-pressure
 * bookkeeping stays balanced.
 *
 * Results are posted back with their typed arrays transferred, so the main
 * thread owns them.
 */

import wasmUrl from 'manifold-3d/manifold.wasm?url';
import type { ManifoldToplevel } from 'manifold-3d';
import {
  computeFlexiScale,
  scaleFlexiPositions,
  planFlexiToy,
} from '@/utils/flexiToyPlan';
import {
  loadManifold,
  buildFlexiToy,
  prepareFlexiBody,
  disposeFlexiPreparedBody,
  deriveFlexiPreviewBody,
  clearFlexiSolidCache,
  type FlexiBuildControl,
  type FlexiPreparedBody,
} from '@/utils/flexiToyBuild';
import { FLEXI_DEFAULT_JOINT_STYLE } from '@/utils/flexiToyTypes';
import type {
  FlexiMeshInput,
  FlexiToyErrorCode,
  FlexiToySettings,
  FlexiWorkerRequest,
  FlexiWorkerResponse,
} from '@/utils/flexiToyTypes';

/** Prepared bodies are megabytes of manifold each; three lengths is plenty. */
const SCALE_CACHE_LIMIT = 3;
/**
 * Below this triangle count the full body is already cheap enough to build
 * against, and simplifying it would cost more than it saves.
 */
const PREVIEW_SIMPLIFY_MIN_TRIANGLES = 20000;
/** Preview simplification tolerance (mm) — invisible at preview zoom. */
const PREVIEW_TOLERANCE_MM = 0.05;

type ScaleEntry = {
  /**
   * The registered mesh scaled to this entry's scale. BOTH qualities plan and
   * measure against this dense mesh — see `runCompute` for why — so the preview
   * and the download always agree on stations, joint sizes and warnings.
   */
  scaledInput: FlexiMeshInput;
  full: FlexiPreparedBody;
  /**
   * The simplified twin the booleans run against at preview quality; null →
   * the body is small enough that previews use `full` directly.
   */
  preview: FlexiPreparedBody | null;
};

type RegisteredMesh = {
  meshId: number;
  input: FlexiMeshInput;
  /** key = `scale.toFixed(6)`; insertion order is the LRU order. */
  bodies: Map<string, ScaleEntry>;
};

let registered: RegisteredMesh | null = null;

/**
 * Ids the client has asked us to abandon. Written synchronously from
 * `onmessage`, read by the running build at every checkpoint.
 */
const cancelled = new Set<number>();

/**
 * Serial task queue. `register` and `compute` run one after another so a
 * register can never dispose a body the build that is currently yielding at a
 * checkpoint still holds, and so requests keep the order the client sent them.
 */
let queue: Promise<void> = Promise.resolve();

function enqueue(task: () => Promise<void>): void {
  // Each task answers its own failures; the catch here only keeps one thrown
  // error from poisoning the chain for every later request.
  queue = queue.then(task).catch(() => {});
}

self.onmessage = (event: MessageEvent<FlexiWorkerRequest>) => {
  const message = event.data;
  if (!message) {
    return;
  }

  if (message.type === 'cancel') {
    // Handled HERE rather than on the queue: a cancel exists to reach a build
    // that is already running, and anything queued behind that build would only
    // be read once it had finished — which is exactly what we are trying to
    // avoid paying for.
    cancelled.add(message.requestId);
    return;
  }

  if (message.type === 'register') {
    const { meshId, input } = message;
    enqueue(() => registerMesh(meshId, input));
    return;
  }

  if (message.type === 'compute') {
    enqueue(() => runCompute(message));
  }
};

async function registerMesh(
  meshId: number,
  input: FlexiMeshInput,
): Promise<void> {
  disposeRegistered();
  registered = { meshId, input, bodies: new Map() };
}

function disposeScaleEntry(entry: ScaleEntry): void {
  // Preview first: it is derived from `full` and only owns its own manifold.
  if (entry.preview) {
    disposeFlexiPreparedBody(entry.preview);
  }
  disposeFlexiPreparedBody(entry.full);
}

function disposeRegistered(): void {
  if (registered) {
    for (const entry of registered.bodies.values()) {
      disposeScaleEntry(entry);
    }
    registered.bodies.clear();
    registered = null;
  }
  // The build's own solid cache is keyed against the mesh we just dropped, so
  // it has to go with it rather than linger against a body that no longer
  // exists.
  clearFlexiSolidCache();
}

/**
 * The prepared bodies for `settings`' scale, building (and caching) them on
 * first use. `null` → the mesh could not be sealed into a manifold.
 */
async function ensureScaleEntry(
  wasm: ManifoldToplevel,
  mesh: RegisteredMesh,
  settings: FlexiToySettings,
): Promise<ScaleEntry | null> {
  const scale = computeFlexiScale(mesh.input, settings);
  // Six decimals: far finer than any length the slider can produce, so two
  // genuinely different lengths never collide on one key.
  const key = scale.toFixed(6);

  const cached = mesh.bodies.get(key);
  if (cached) {
    // Refresh recency (delete + re-insert moves the key to the newest slot).
    mesh.bodies.delete(key);
    mesh.bodies.set(key, cached);
    return cached;
  }

  const scaledInput: FlexiMeshInput = {
    positions: scaleFlexiPositions(mesh.input.positions, scale),
    indices: mesh.input.indices,
    colors: mesh.input.colors,
  };
  const full = await prepareFlexiBody(wasm, scaledInput);
  if (!full) {
    return null;
  }

  // A simplified twin only earns its memory on bodies heavy enough for the
  // boolean cost to dominate; below the threshold previews use `full`.
  const preview =
    full.manifold.numTri() > PREVIEW_SIMPLIFY_MIN_TRIANGLES
      ? (deriveFlexiPreviewBody(wasm, full, PREVIEW_TOLERANCE_MM)?.body ?? null)
      : null;

  const entry: ScaleEntry = { scaledInput, full, preview };
  mesh.bodies.set(key, entry);
  while (mesh.bodies.size > SCALE_CACHE_LIMIT) {
    const oldestKey = mesh.bodies.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    const oldest = mesh.bodies.get(oldestKey);
    mesh.bodies.delete(oldestKey);
    if (oldest) {
      // Safe to free here: computes are serialised, so no build is holding it.
      disposeScaleEntry(oldest);
    }
  }
  return entry;
}

function errorResponse(
  requestId: number,
  code: FlexiToyErrorCode,
  message: string,
): FlexiWorkerResponse {
  return {
    type: 'result',
    requestId,
    outcome: { status: 'error', code, message },
  };
}

function respond(response: FlexiWorkerResponse): void {
  if (response.outcome.status === 'ok') {
    const { positions, indices, colors } = response.outcome.result;
    self.postMessage(response, {
      transfer: [positions.buffer, indices.buffer, colors.buffer],
    });
  } else {
    self.postMessage(response);
  }
}

async function runCompute(
  message: Extract<FlexiWorkerRequest, { type: 'compute' }>,
): Promise<void> {
  const { requestId, meshId, quality } = message;
  // Defensive default so a stale client without jointStyle still computes.
  const settings: FlexiToySettings = {
    ...message.settings,
    jointStyle: message.settings.jointStyle ?? FLEXI_DEFAULT_JOINT_STYLE,
  };

  let response: FlexiWorkerResponse;
  try {
    const mesh = registered;
    if (!mesh || mesh.meshId !== meshId) {
      response = errorResponse(
        requestId,
        'compute-failed',
        'The model is no longer available to the flexi toy builder. Reopen the dialog and try again.',
      );
    } else {
      const wasm = await loadManifold(() => wasmUrl);
      const entry = await ensureScaleEntry(wasm, mesh, settings);
      if (!entry) {
        response = errorResponse(
          requestId,
          'not-watertight',
          'This model has holes or overlaps we could not seal, so it cannot be turned into a flexi toy. Try a different model.',
        );
      } else {
        // A preview build runs its BOOLEANS against the simplified twin when
        // there is one; a final build (what downloads are made from) always
        // uses the exact body. Everything NUMERIC — the plan's spine, station
        // profiles and joint sizing, and the build's own skin measurements —
        // reads the dense `scaledInput` at BOTH qualities. The planner and the
        // gates sample VERTICES, and a simplified mesh keeps its surface within
        // the tolerance but throws most of its vertices away: measured on an
        // already-coarse body, planning on the twin collapsed five live joints
        // to one. Planning on the dense mesh keeps the preview's plan
        // identical to the download's; the twin's surface sits within 0.05mm
        // of where those measurements put it, far inside every clearance.
        const body =
          quality === 'preview' && entry.preview ? entry.preview : entry.full;
        const meshInput = entry.scaledInput;

        const control: FlexiBuildControl = {
          checkpoint: async () => {
            // The yield is the point: `onmessage` only runs between tasks, so
            // without handing the event loop a turn here a `cancel` posted
            // mid-build would not be delivered until the build had finished.
            await new Promise((resolve) => setTimeout(resolve, 0));
            return cancelled.has(requestId);
          },
        };

        const plan = planFlexiToy(meshInput, settings);
        const outcome = await buildFlexiToy(wasm, meshInput, plan, settings, {
          prepared: body,
          control,
          quality,
        });

        response =
          outcome.status === 'aborted'
            ? // The client drops results for anything but its latest request,
              // so this answer only balances its in-flight bookkeeping — it is
              // never rendered.
              errorResponse(
                requestId,
                'compute-failed',
                'Superseded by a newer request.',
              )
            : { type: 'result', requestId, outcome };
      }
    }
  } catch (error) {
    response = errorResponse(
      requestId,
      'compute-failed',
      error instanceof Error
        ? error.message
        : 'The flexi toy could not be computed.',
    );
  }

  // Request ids only increase, so once this one is answered every cancelled id
  // at or below it is moot. Pruning them keeps the set from growing when a
  // cancel lands just after its target finished.
  for (const id of cancelled) {
    if (id <= requestId) {
      cancelled.delete(id);
    }
  }

  respond(response);
}
