/**
 * THREE ↔ flat-bottom-cut bridge.
 *
 * Converts a loaded model's meshes into the plain typed arrays the cut worker
 * takes, and writes the trimmed geometry back into the same meshes so their
 * materials, textures and place in the scene graph are untouched.
 *
 * Geometry is exchanged in WORLD space, because the cut plane is horizontal in
 * world space and a rotated mesh's local "up" is not. Each result is pushed
 * back through the mesh's own inverse world matrix, so the scene graph and
 * every node transform stay exactly as they were.
 *
 * Deliberately free of any manifold import: this module runs on the main
 * thread, and the WASM must stay in the worker chunk.
 */

import * as THREE from 'three';
import type { CutMeshInput } from './flatBottomCut';
import { computeFlatBottom } from './flatBottomClient';

/** A mesh in the scene plus the property layout used to encode it. */
export type CutTarget = {
  mesh: THREE.Mesh;
  /** Extra channels packed after xyz, in this order. */
  hasUv: boolean;
  hasColor: boolean;
};

export type SceneCutInput = {
  meshes: CutMeshInput[];
  targets: CutTarget[];
};

function toIndexArray(geometry: THREE.BufferGeometry): Uint32Array {
  const index = geometry.getIndex();
  if (index) {
    return index.array instanceof Uint32Array
      ? new Uint32Array(index.array)
      : Uint32Array.from(index.array as ArrayLike<number>);
  }
  // Non-indexed geometry: every three positions form a triangle.
  const count = geometry.getAttribute('position')?.count ?? 0;
  const indices = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) indices[i] = i;
  return indices;
}

/**
 * Collect every renderable mesh of `root` as world-space cut input.
 * Returns empty arrays when there is nothing with triangles to cut.
 */
export function sceneToCutInput(root: THREE.Object3D): SceneCutInput {
  root.updateMatrixWorld(true);

  const meshes: CutMeshInput[] = [];
  const targets: CutTarget[] = [];
  const vertex = new THREE.Vector3();

  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;

    const position = mesh.geometry.getAttribute('position');
    if (!position || position.count < 3) return;

    const uv = mesh.geometry.getAttribute('uv');
    const color = mesh.geometry.getAttribute('color');
    const hasUv = !!uv && uv.count === position.count;
    const hasColor = !!color && color.count === position.count;
    const numProp = 3 + (hasUv ? 2 : 0) + (hasColor ? 3 : 0);

    const vertProperties = new Float32Array(position.count * numProp);
    for (let v = 0; v < position.count; v += 1) {
      vertex.fromBufferAttribute(position, v).applyMatrix4(mesh.matrixWorld);
      const base = v * numProp;
      vertProperties[base] = vertex.x;
      vertProperties[base + 1] = vertex.y;
      vertProperties[base + 2] = vertex.z;
      let offset = 3;
      if (hasUv) {
        vertProperties[base + offset] = uv.getX(v);
        vertProperties[base + offset + 1] = uv.getY(v);
        offset += 2;
      }
      if (hasColor) {
        vertProperties[base + offset] = color.getX(v);
        vertProperties[base + offset + 1] = color.getY(v);
        vertProperties[base + offset + 2] = color.getZ(v);
      }
    }

    meshes.push({
      vertProperties,
      triVerts: toIndexArray(mesh.geometry),
      numProp,
    });
    targets.push({ mesh, hasUv, hasColor });
  });

  return { meshes, targets };
}

/**
 * Write one trimmed mesh back into its target.
 *
 * The repair fallbacks inside the cut drop extra channels, so the returned
 * stride is trusted over the requested one: a mesh that came back as bare
 * positions loses its uv (and with it its texture mapping) rather than
 * reading garbage out of the buffer.
 */
export function applyCutMeshToTarget(
  target: CutTarget,
  result: CutMeshInput,
): void {
  const { mesh } = target;
  const { vertProperties, triVerts, numProp } = result;
  const vertexCount = Math.floor(vertProperties.length / numProp);

  const positions = new Float32Array(vertexCount * 3);
  const hasUv = target.hasUv && numProp >= 5;
  const hasColor = target.hasColor && numProp >= 3 + (target.hasUv ? 2 : 0) + 3;
  const uvs = hasUv ? new Float32Array(vertexCount * 2) : null;
  const colors = hasColor ? new Float32Array(vertexCount * 3) : null;

  for (let v = 0; v < vertexCount; v += 1) {
    const base = v * numProp;
    positions[v * 3] = vertProperties[base];
    positions[v * 3 + 1] = vertProperties[base + 1];
    positions[v * 3 + 2] = vertProperties[base + 2];
    let offset = 3;
    if (uvs) {
      uvs[v * 2] = vertProperties[base + offset];
      uvs[v * 2 + 1] = vertProperties[base + offset + 1];
      offset += 2;
    }
    if (colors) {
      colors[v * 3] = vertProperties[base + offset];
      colors[v * 3 + 1] = vertProperties[base + offset + 1];
      colors[v * 3 + 2] = vertProperties[base + offset + 2];
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (colors) {
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  geometry.setIndex(new THREE.BufferAttribute(triVerts, 1));

  // Back from world space into this mesh's own frame, so its node transform
  // (and every parent transform) keeps working unchanged.
  mesh.updateWorldMatrix(true, false);
  geometry.applyMatrix4(mesh.matrixWorld.clone().invert());
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const previous = mesh.geometry;
  mesh.geometry = geometry;
  previous?.dispose();
}

export type FlatBottomApplyResult =
  /** The scene was trimmed; `cutFraction` of its height came off. */
  | { status: 'cut'; cutFraction: number; uncutCount: number }
  /** Already resting on a broad flat face — geometry untouched. */
  | { status: 'already-flat' }
  /** Superseded by a newer request; the scene was left alone. */
  | { status: 'superseded' }
  /** Could not be cut (not a solid, degenerate, worker unavailable). */
  | { status: 'failed'; message: string };

/**
 * Trim a loaded model flat along its underside, in place.
 *
 * On any failure the scene is left exactly as it was: an uncut model is a far
 * better outcome than a mangled one, so callers can render the result either
 * way and only need the return value to tell the user what happened.
 */
export async function applyFlatBottomToScene(
  root: THREE.Object3D,
): Promise<FlatBottomApplyResult> {
  const { meshes, targets } = sceneToCutInput(root);
  if (meshes.length === 0) {
    return { status: 'failed', message: 'The model has no geometry to cut.' };
  }

  const outcome = await computeFlatBottom(meshes);

  if (outcome.status === 'superseded') return { status: 'superseded' };
  if (outcome.status === 'already-flat') return { status: 'already-flat' };
  if (outcome.status === 'error') {
    return { status: 'failed', message: outcome.message };
  }

  outcome.meshes.forEach((result, index) => {
    // null means "keep the original geometry" — either the part sits entirely
    // above the cut, or it could not be turned into a solid.
    if (!result) return;
    applyCutMeshToTarget(targets[index], result);
  });

  return {
    status: 'cut',
    cutFraction: outcome.cutFraction,
    uncutCount: outcome.uncutCount,
  };
}
