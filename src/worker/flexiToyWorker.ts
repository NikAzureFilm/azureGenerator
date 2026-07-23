/**
 * Module worker for the Flexi Toy Maker.
 *
 * Receives a `FlexiWorkerRequest`, scales the mesh to the target length, plans
 * the spine/joints (`flexiToyPlan`) and runs the manifold boolean build
 * (`flexiToyBuild`) off the main thread, then posts a `FlexiWorkerResponse`,
 * transferring the result typed arrays back so the main thread owns them.
 */

import wasmUrl from 'manifold-3d/manifold.wasm?url';
import {
  computeFlexiScale,
  scaleFlexiPositions,
  planFlexiToy,
} from '@/utils/flexiToyPlan';
import { loadManifold, buildFlexiToy } from '@/utils/flexiToyBuild';
import type {
  FlexiMeshInput,
  FlexiWorkerRequest,
  FlexiWorkerResponse,
} from '@/utils/flexiToyTypes';

self.onmessage = async (event: MessageEvent<FlexiWorkerRequest>) => {
  const message = event.data;
  if (!message || message.type !== 'compute') {
    return;
  }
  const { requestId, input, settings } = message;

  let response: FlexiWorkerResponse;
  try {
    const wasm = await loadManifold(() => wasmUrl);

    const scale = computeFlexiScale(input, settings);
    const scaledInput: FlexiMeshInput = {
      positions: scaleFlexiPositions(input.positions, scale),
      indices: input.indices,
      colors: input.colors,
    };
    const plan = planFlexiToy(scaledInput, settings);
    const outcome = await buildFlexiToy(wasm, scaledInput, plan, settings);
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
            : 'The flexi toy could not be computed.',
      },
    };
  }

  if (response.outcome.status === 'ok') {
    const { positions, indices, colors } = response.outcome.result;
    self.postMessage(response, {
      transfer: [positions.buffer, indices.buffer, colors.buffer],
    });
  } else {
    self.postMessage(response);
  }
};
