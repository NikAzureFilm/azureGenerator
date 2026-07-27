/**
 * Worker protocol for the flat-bottom cut.
 *
 * Kept in its own module (no manifold import) so the main thread can talk about
 * requests and responses without pulling the WASM into the main bundle.
 */

import type { CutMeshInput, FlatBottomSceneOutcome } from './flatBottomCut';

export type FlatBottomWorkerRequest = {
  type: 'compute';
  requestId: number;
  meshes: CutMeshInput[];
};

export type FlatBottomWorkerResponse = {
  type: 'result';
  requestId: number;
  outcome: FlatBottomSceneOutcome;
};

/** What the client resolves with; 'superseded' never comes from the worker. */
export type FlatBottomOutcome =
  | FlatBottomSceneOutcome
  | { status: 'superseded' };
