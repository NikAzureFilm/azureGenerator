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
 * - 3MF: a single neutral color for the whole object (no per-triangle quantised
 *   colors — the user asked for no colors baked inside the print). Packaged with
 *   `createThreeMfBlobFromColoredMesh`, which takes precomputed data and does not
 *   re-repair. The packaging helper converts y-up→z-up internally, so we pass
 *   three.js-space coordinates. The live PREVIEW still uses the baked per-vertex
 *   colors carried on the result — only the exported 3MF is single-color.
 */

import * as THREE from 'three';
import {
  createThreeMfBlobFromColoredMesh,
  clampThreeMfColorCount,
  type ThreeMfColoredMesh,
  type ThreeMfTriangle,
} from './threeMfExport.ts';
import type { FlexiToyResult } from './flexiToyTypes.ts';

// Neutral light-grey printed for the whole object. Padded to the packaging
// palette floor if needed, but every triangle references slot 0.
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
 * Single-color 3MF blob for the result (no interior colors). Segments stay
 * separate — no body fusion.
 */
export function flexiResultToThreeMfBlob(
  result: FlexiToyResult,
  filename: string,
): Promise<Blob> {
  const { positions, indices } = result;
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

  // Every triangle references the single neutral slot; no quantization.
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
  // but keep all triangles on slot 0 so nothing colors the interior.
  const paletteLength = Math.max(1, clampThreeMfColorCount(1));
  const palette: string[] = new Array(paletteLength).fill(FLEXI_3MF_COLOR);

  const coloredMesh: ThreeMfColoredMesh = {
    vertices,
    triangles,
    palette,
  };
  return createThreeMfBlobFromColoredMesh({ coloredMesh, filename });
}
