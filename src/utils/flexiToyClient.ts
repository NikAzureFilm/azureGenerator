/**
 * Main-thread API for the Flexi Toy Maker.
 *
 *   sceneToFlexiMeshInput(scene) — three.js scene → transferable typed arrays
 *     (world-space, welded, per-vertex colours baked from material / vertex
 *     colour / albedo texture).
 *   computeFlexiToy(input, settings, quality) — latest-wins worker call. A newer
 *     call supersedes an in-flight one; the superseded promise resolves
 *     'superseded'. `quality` is 'preview' (what the dialog shows while you
 *     adjust) or 'final' (the exact build downloads are made from).
 *
 * A mesh is REGISTERED with the worker the first time it is computed and is
 * referred to by id afterwards, so only the first call pays the megabyte
 * structured clone and every slider tweak posts a few hundred bytes of
 * settings. The registration is a plain clone, never a transfer: the main
 * thread keeps its own copy for later computes and for the exporters.
 *
 * Multi-body inputs are NOT strut-fused here: welding by position already unifies
 * a single intended body split across meshes/materials, and genuinely disjoint
 * CLOSED shells are a valid multi-component manifold that the build cuts directly.
 * (connectMeshComponents' overlap struts are intentionally non-manifold — they
 * target the slicer, not manifold-3d — so fusing here would break construction;
 * the build's repair chain is the backstop, per spec §4.1.)
 *
 * The manifold WASM lives entirely in the worker chunk; this module never
 * imports flexiToyBuild, keeping manifold out of the main bundle.
 */

import * as THREE from 'three';
import type {
  FlexiBuildQuality,
  FlexiMeshInput,
  FlexiToySettings,
  FlexiToyOutcome,
  FlexiWorkerRequest,
  FlexiWorkerResponse,
} from './flexiToyTypes.ts';

const WELD_TOLERANCE_MM = 0.01;

type WeldVertex = { position: [number, number, number] };

/**
 * Convert a processed (mm-scale, world-space) three.js scene into a
 * `FlexiMeshInput`: welded positions, triangle indices, and one baked rgb colour
 * per vertex. Disconnected bodies are fused so the core sees a single solid.
 */
export function sceneToFlexiMeshInput(scene: THREE.Scene): FlexiMeshInput {
  scene.updateMatrixWorld(true);

  const weldVertices: WeldVertex[] = [];
  const weldIndexByKey = new Map<string, number>();
  const colorSum = new Map<number, { color: THREE.Color; count: number }>();
  const triangles: { v1: number; v2: number; v3: number }[] = [];

  const worldVertex = new THREE.Vector3();
  const tempColor = new THREE.Color();

  const getWeldIndex = (
    position: THREE.Vector3,
    color: THREE.Color,
  ): number => {
    const key = `${Math.round(position.x / WELD_TOLERANCE_MM)},${Math.round(
      position.y / WELD_TOLERANCE_MM,
    )},${Math.round(position.z / WELD_TOLERANCE_MM)}`;
    let index = weldIndexByKey.get(key);
    if (index === undefined) {
      index = weldVertices.length;
      weldVertices.push({ position: [position.x, position.y, position.z] });
      weldIndexByKey.set(key, index);
      colorSum.set(index, { color: color.clone(), count: 1 });
    } else {
      const entry = colorSum.get(index);
      if (entry) {
        entry.color.add(color);
        entry.count += 1;
      }
    }
    return index;
  };

  scene.traverse((node) => {
    if (!(node instanceof THREE.Mesh) || !node.geometry?.attributes.position) {
      return;
    }
    const geometry = node.geometry;
    const position = geometry.attributes.position;
    const colorAttribute = geometry.attributes.color;
    const uvAttribute = geometry.attributes.uv;
    const material = Array.isArray(node.material)
      ? node.material[0]
      : node.material;
    const sampleTexture = createTextureSampler(material);
    const baseColor = getMaterialColor(material);

    const index = geometry.index;
    const triangleCount = index
      ? Math.floor(index.count / 3)
      : Math.floor(position.count / 3);

    const cornerColor = (vertexIndex: number): THREE.Color => {
      tempColor.copy(baseColor);
      if (colorAttribute) {
        tempColor.multiply(
          new THREE.Color(
            colorAttribute.getX(vertexIndex),
            colorAttribute.getY(vertexIndex),
            colorAttribute.getZ(vertexIndex),
          ),
        );
      }
      if (sampleTexture && uvAttribute) {
        const sampled = sampleTexture(
          uvAttribute.getX(vertexIndex),
          uvAttribute.getY(vertexIndex),
        );
        if (sampled) {
          tempColor.multiply(sampled);
        }
      }
      return tempColor;
    };

    for (let t = 0; t < triangleCount; t += 1) {
      const ia = index ? index.getX(t * 3) : t * 3;
      const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;

      worldVertex
        .fromBufferAttribute(position, ia)
        .applyMatrix4(node.matrixWorld);
      const v1 = getWeldIndex(worldVertex, cornerColor(ia));
      worldVertex
        .fromBufferAttribute(position, ib)
        .applyMatrix4(node.matrixWorld);
      const v2 = getWeldIndex(worldVertex, cornerColor(ib));
      worldVertex
        .fromBufferAttribute(position, ic)
        .applyMatrix4(node.matrixWorld);
      const v3 = getWeldIndex(worldVertex, cornerColor(ic));

      if (v1 === v2 || v2 === v3 || v1 === v3) continue;
      triangles.push({ v1, v2, v3 });
    }
  });

  const vertexCount = weldVertices.length;
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v += 1) {
    const [x, y, z] = weldVertices[v].position;
    positions[v * 3] = x;
    positions[v * 3 + 1] = y;
    positions[v * 3 + 2] = z;
    const entry = colorSum.get(v);
    if (entry) {
      colors[v * 3] = entry.color.r / entry.count;
      colors[v * 3 + 1] = entry.color.g / entry.count;
      colors[v * 3 + 2] = entry.color.b / entry.count;
    } else {
      colors[v * 3] = 1;
      colors[v * 3 + 1] = 1;
      colors[v * 3 + 2] = 1;
    }
  }

  const indices = new Uint32Array(triangles.length * 3);
  triangles.forEach((triangle, t) => {
    indices[t * 3] = triangle.v1;
    indices[t * 3 + 1] = triangle.v2;
    indices[t * 3 + 2] = triangle.v3;
  });

  return { positions, indices, colors };
}

function getMaterialColor(material: THREE.Material | undefined): THREE.Color {
  if (material && 'color' in material) {
    const color = (material as { color?: THREE.Color }).color;
    if (color instanceof THREE.Color) {
      return color.clone();
    }
  }
  return new THREE.Color(1, 1, 1);
}

type TextureSampler = (u: number, v: number) => THREE.Color | null;

// Nearest-texel albedo sampler. Draws the texture image to a canvas once and
// reads pixels; returns null when no canvas/texture is available (e.g. SSR).
function createTextureSampler(
  material: THREE.Material | undefined,
): TextureSampler | null {
  const map =
    material && 'map' in material
      ? (material as { map?: THREE.Texture | null }).map
      : null;
  const image = map?.image as
    | { width?: number; height?: number; data?: ArrayLike<number> }
    | undefined;
  if (!map || !image) return null;

  const width = image.width ?? 0;
  const height = image.height ?? 0;
  if (!width || !height) return null;

  let data: ArrayLike<number> | null = null;
  if (image.data) {
    data = image.data;
  } else if (typeof document !== 'undefined') {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (context) {
        context.drawImage(image as unknown as CanvasImageSource, 0, 0);
        data = context.getImageData(0, 0, width, height).data;
      }
    } catch {
      data = null;
    }
  }
  if (!data) return null;

  const flipY = map.flipY !== false;
  return (u: number, v: number): THREE.Color | null => {
    const wrappedU = u - Math.floor(u);
    const wrappedV = v - Math.floor(v);
    const sampleV = flipY ? 1 - wrappedV : wrappedV;
    const px = Math.min(
      width - 1,
      Math.max(0, Math.round(wrappedU * (width - 1))),
    );
    const py = Math.min(
      height - 1,
      Math.max(0, Math.round(sampleV * (height - 1))),
    );
    const offset = (py * width + px) * 4;
    return new THREE.Color(
      (data![offset] ?? 255) / 255,
      (data![offset + 1] ?? 255) / 255,
      (data![offset + 2] ?? 255) / 255,
    );
  };
}

// --- Worker lifecycle (register-once, latest-wins + back-pressure) --------
//
// At most one compute message is ever outstanding in the worker. A call made
// while one is running stashes the newest {meshId, settings, quality} and is
// posted only once the running request's response returns — and it asks the
// worker to abandon that running build at its next checkpoint, so the machine
// is not spent finishing a toy nobody will see. Latest-wins is unchanged: every
// superseded call — the older stash and the previous latest — resolves
// `{ status: 'superseded' }`, and only the most recent call resolves with a
// real outcome.
//
// The mesh itself is never re-sent: `registeredMeshIds` remembers which inputs
// the live worker already holds. It is tied to the worker instance (rebuilt
// whenever the worker is), because ids only mean anything to the worker that
// received the matching register.

let worker: Worker | null = null;
let nextRequestId = 1;
let nextMeshId = 1;
let registeredMeshIds = new WeakMap<FlexiMeshInput, number>();
// Request id currently posted to (and running in) the worker.
let inFlightRequestId: number | null = null;
// The in-flight id we have already asked the worker to abandon, so a burst of
// calls posts one cancel rather than one per call.
let cancelledRequestId: number | null = null;
// The most recent call's id + resolver; the only one that receives a real result.
let latest: {
  requestId: number;
  resolve: (outcome: FlexiToyOutcome) => void;
} | null = null;
// A newer call waiting for the worker to free up. It holds no mesh — the worker
// already has it — so stashing is free.
let queued: {
  requestId: number;
  meshId: number;
  settings: FlexiToySettings;
  quality: FlexiBuildQuality;
} | null = null;

function getWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (!worker) {
    worker = new Worker(
      new URL('../worker/flexiToyWorker.ts', import.meta.url),
      {
        type: 'module',
      },
    );
    // A fresh worker holds no registrations, so the id map starts empty too.
    registeredMeshIds = new WeakMap<FlexiMeshInput, number>();
    worker.addEventListener(
      'message',
      (event: MessageEvent<FlexiWorkerResponse>) => {
        const data = event.data;
        if (!data || data.type !== 'result') return;
        if (data.requestId === inFlightRequestId) {
          inFlightRequestId = null;
          cancelledRequestId = null;
        }
        // Only the current latest request receives a real result; responses to
        // already-superseded requests are dropped.
        if (latest && latest.requestId === data.requestId) {
          const resolve = latest.resolve;
          latest = null;
          resolve(data.outcome);
        }
        // Worker is free now; post the newest queued request if there is one.
        if (queued && inFlightRequestId === null) {
          postToWorker(
            queued.requestId,
            queued.meshId,
            queued.settings,
            queued.quality,
          );
          queued = null;
        }
      },
    );
  }
  return worker;
}

/**
 * The worker's id for this mesh, registering it (one structured clone) the
 * first time we see it. Posted immediately, so it is always ahead of the
 * compute that names it — the worker processes registers and computes on one
 * serial queue.
 */
function ensureRegisteredMesh(
  activeWorker: Worker,
  input: FlexiMeshInput,
): number {
  const known = registeredMeshIds.get(input);
  if (known !== undefined) return known;

  const meshId = nextMeshId++;
  registeredMeshIds.set(input, meshId);
  const request: FlexiWorkerRequest = { type: 'register', meshId, input };
  // Deliberately NOT transferred: the main thread keeps its copy for later
  // computes (and for the download path) — a transfer would detach it here.
  activeWorker.postMessage(request);
  return meshId;
}

function postToWorker(
  requestId: number,
  meshId: number,
  settings: FlexiToySettings,
  quality: FlexiBuildQuality,
): void {
  inFlightRequestId = requestId;
  const request: FlexiWorkerRequest = {
    type: 'compute',
    requestId,
    meshId,
    settings,
    quality,
  };
  worker?.postMessage(request);
}

/**
 * Compute a flexi toy for the given input + settings. Latest-wins: a newer call
 * supersedes any in-flight one, whose promise resolves `{ status: 'superseded' }`.
 * `quality` defaults to 'preview'; downloads pass 'final'.
 */
export function computeFlexiToy(
  input: FlexiMeshInput,
  settings: FlexiToySettings,
  quality: FlexiBuildQuality = 'preview',
): Promise<FlexiToyOutcome> {
  const activeWorker = getWorker();
  if (!activeWorker) {
    return Promise.resolve({
      status: 'error',
      code: 'compute-failed',
      message: 'Flexi toy computation is not available in this environment.',
    });
  }

  // Supersede the previous latest immediately (it will never get a real result).
  if (latest) {
    const superseded = latest.resolve;
    latest = null;
    superseded({ status: 'superseded' });
  }
  // Drop any older queued request in favour of this newer one.
  queued = null;

  const meshId = ensureRegisteredMesh(activeWorker, input);
  const requestId = nextRequestId++;
  return new Promise<FlexiToyOutcome>((resolve) => {
    latest = { requestId, resolve };
    if (inFlightRequestId === null) {
      postToWorker(requestId, meshId, settings, quality);
    } else {
      // Worker busy: stash; posted when the running response returns.
      queued = { requestId, meshId, settings, quality };
      // ...and stop the running build, which nobody is waiting on any more.
      if (cancelledRequestId !== inFlightRequestId) {
        cancelledRequestId = inFlightRequestId;
        const cancel: FlexiWorkerRequest = {
          type: 'cancel',
          requestId: inFlightRequestId,
        };
        activeWorker.postMessage(cancel);
      }
    }
  });
}
