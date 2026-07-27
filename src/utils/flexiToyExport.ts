/**
 * Export helpers for the Flexi Toy Maker result.
 *
 * The result is already mm-scale, floor-aligned, and holds its segments as
 * SEPARATE bodies in one buffer. These exporters must preserve that separation:
 * they NEVER route the result through `computeThreeMfColoredMesh`,
 * `processUserModelForPrint`, or `connectMeshComponents`, all of which fuse
 * disconnected bodies (adding struts) and would weld the joints solid (spec §6).
 *
 * - STL: binary, written directly from the arrays in three.js (y-up) space,
 *   matching the app's existing STLExporter orientation. No re-repair/re-scale.
 * - 3MF: the model's baked colors, quantised to filament slots exactly the way
 *   the main 3MF export does, so the download matches what the preview shows.
 *   Packaged with `createThreeMfBlobFromColoredMesh`, which takes precomputed
 *   data and does not re-repair; the palette work runs through
 *   `buildThreeMfColoredMeshFromTriangleColors`, the body-preserving sibling of
 *   `computeThreeMfColoredMesh`. The packaging helper converts y-up→z-up
 *   internally, so we pass three.js-space coordinates. A result with no usable
 *   color data falls back to a single neutral grey.
 */

import * as THREE from 'three';
import {
  buildThreeMfColoredMeshFromTriangleColors,
  createThreeMfBlobFromColoredMesh,
  clampThreeMfColorCount,
  DEFAULT_THREE_MF_COLOR_COUNT,
  type ThreeMfColoredMesh,
  type ThreeMfTriangle,
} from './threeMfExport.ts';
import type { FlexiToyResult } from './flexiToyTypes.ts';

// Fallback for a result that carries no per-vertex colors: one neutral
// light-grey slot with every triangle on it.
const FLEXI_3MF_COLOR = '#D8D8D8';

/** Binary STL blob written directly from the result arrays (three.js y-up, mm). */
export function flexiResultToStlBlob(result: FlexiToyResult): Blob {
  const { positions, indices } = result;
  const triangleCount = Math.floor(indices.length / 3);
  const buffer = new ArrayBuffer(84 + triangleCount * 50);
  const view = new DataView(buffer);

  const header = 'AzureFilm Flexi Toy (binary STL)';
  for (let i = 0; i < header.length && i < 80; i += 1) {
    view.setUint8(i, header.charCodeAt(i));
  }
  view.setUint32(80, triangleCount, true);

  let offset = 84;
  const ax = new THREE.Vector3();
  const bx = new THREE.Vector3();
  const cx = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const normal = new THREE.Vector3();

  for (let t = 0; t < triangleCount; t += 1) {
    const ia = indices[t * 3];
    const ib = indices[t * 3 + 1];
    const ic = indices[t * 3 + 2];
    ax.set(positions[ia * 3], positions[ia * 3 + 1], positions[ia * 3 + 2]);
    bx.set(positions[ib * 3], positions[ib * 3 + 1], positions[ib * 3 + 2]);
    cx.set(positions[ic * 3], positions[ic * 3 + 1], positions[ic * 3 + 2]);
    edge1.subVectors(bx, ax);
    edge2.subVectors(cx, ax);
    normal.crossVectors(edge1, edge2);
    if (normal.lengthSq() > 0) normal.normalize();

    view.setFloat32(offset, normal.x, true);
    view.setFloat32(offset + 4, normal.y, true);
    view.setFloat32(offset + 8, normal.z, true);
    view.setFloat32(offset + 12, ax.x, true);
    view.setFloat32(offset + 16, ax.y, true);
    view.setFloat32(offset + 20, ax.z, true);
    view.setFloat32(offset + 24, bx.x, true);
    view.setFloat32(offset + 28, bx.y, true);
    view.setFloat32(offset + 32, bx.z, true);
    view.setFloat32(offset + 36, cx.x, true);
    view.setFloat32(offset + 40, cx.y, true);
    view.setFloat32(offset + 44, cx.z, true);
    view.setUint16(offset + 48, 0, true);
    offset += 50;
  }

  return new Blob([buffer], { type: 'application/octet-stream' });
}

/**
 * Colored 3MF blob for the result: the baked per-vertex colors the preview
 * shows, quantised to at most `colorCount` filament slots. Segments stay
 * separate — no body fusion.
 */
export function flexiResultToThreeMfBlob(
  result: FlexiToyResult,
  filename: string,
  colorCount: number = DEFAULT_THREE_MF_COLOR_COUNT,
): Promise<Blob> {
  const { positions, indices, colors } = result;
  const vertexCount = Math.floor(positions.length / 3);
  const triangleCount = Math.floor(indices.length / 3);

  const vertices: [number, number, number][] = new Array(vertexCount);
  for (let v = 0; v < vertexCount; v += 1) {
    vertices[v] = [
      positions[v * 3],
      positions[v * 3 + 1],
      positions[v * 3 + 2],
    ];
  }

  const hasColors = Boolean(colors) && colors.length === vertexCount * 3;
  const coloredMesh = hasColors
    ? buildThreeMfColoredMeshFromTriangleColors({
        vertices,
        triangles: buildTriangleColors(indices, colors, triangleCount),
        colorCount,
      })
    : buildNeutralColoredMesh(vertices, indices, triangleCount);

  return createThreeMfBlobFromColoredMesh({ coloredMesh, filename });
}

/**
 * One color per triangle, averaged from its three corners — the same value the
 * preview shades that face with. Cut faces carry the colors manifold
 * interpolated onto them during the boolean, so joints blend with their segment.
 */
function buildTriangleColors(
  indices: Uint32Array,
  colors: Float32Array,
  triangleCount: number,
): Array<Omit<ThreeMfTriangle, 'colorIndex'> & { color: THREE.Color }> {
  const triangles: Array<
    Omit<ThreeMfTriangle, 'colorIndex'> & { color: THREE.Color }
  > = new Array(triangleCount);

  for (let t = 0; t < triangleCount; t += 1) {
    const v1 = indices[t * 3];
    const v2 = indices[t * 3 + 1];
    const v3 = indices[t * 3 + 2];
    triangles[t] = {
      v1,
      v2,
      v3,
      color: new THREE.Color(
        (colors[v1 * 3] + colors[v2 * 3] + colors[v3 * 3]) / 3,
        (colors[v1 * 3 + 1] + colors[v2 * 3 + 1] + colors[v3 * 3 + 1]) / 3,
        (colors[v1 * 3 + 2] + colors[v2 * 3 + 2] + colors[v3 * 3 + 2]) / 3,
      ),
    };
  }

  return triangles;
}

/** Fallback mesh for a result without usable colors: one neutral grey slot. */
function buildNeutralColoredMesh(
  vertices: [number, number, number][],
  indices: Uint32Array,
  triangleCount: number,
): ThreeMfColoredMesh {
  const triangles: ThreeMfTriangle[] = new Array(triangleCount);
  for (let t = 0; t < triangleCount; t += 1) {
    triangles[t] = {
      v1: indices[t * 3],
      v2: indices[t * 3 + 1],
      v3: indices[t * 3 + 2],
      colorIndex: 0,
    };
  }

  // Pad the palette to the packaging floor if it requires ≥1 (it clamps to 1),
  // but keep all triangles on slot 0.
  const paletteLength = Math.max(1, clampThreeMfColorCount(1));
  return {
    vertices,
    triangles,
    palette: new Array(paletteLength).fill(FLEXI_3MF_COLOR),
  };
}
