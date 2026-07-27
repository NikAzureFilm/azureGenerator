/**
 * Module worker for the flat-bottom cut.
 *
 * Receives the scene's meshes as plain typed arrays, runs the manifold planar
 * trim off the main thread (`flatBottomCut`), and posts the result back,
 * transferring the buffers so the main thread owns them.
 *
 * Mirrors flexiToyWorker.ts, and exists as its own worker so the manifold WASM
 * stays out of the main bundle and the flexi worker's single-in-flight contract
 * is left alone.
 */

import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { loadManifold } from '@/utils/flexiToyBuild';
import { computeFlatBottomForScene } from '@/utils/flatBottomCut';
import type {
  FlatBottomWorkerRequest,
  FlatBottomWorkerResponse,
} from '@/utils/flatBottomTypes';

self.onmessage = async (event: MessageEvent<FlatBottomWorkerRequest>) => {
  const message = event.data;
  if (!message || message.type !== 'compute') {
    return;
  }
  const { requestId, meshes } = message;

  let response: FlatBottomWorkerResponse;
  try {
    const wasm = await loadManifold(() => wasmUrl);
    const outcome = await computeFlatBottomForScene(wasm, meshes);
    response = { type: 'result', requestId, outcome };
  } catch (error) {
    response = {
      type: 'result',
      requestId,
      outcome: {
        status: 'error',
        code: 'compute-failed',
        message:
          error instanceof Error
            ? error.message
            : 'The flat bottom could not be computed.',
      },
    };
  }

  if (response.outcome.status === 'ok') {
    const transfer: ArrayBuffer[] = [];
    for (const mesh of response.outcome.meshes) {
      if (!mesh) continue;
      transfer.push(mesh.vertProperties.buffer, mesh.triVerts.buffer);
    }
    self.postMessage(response, { transfer });
  } else {
    self.postMessage(response);
  }
};
