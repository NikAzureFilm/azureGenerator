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
 * - 3MF: build the ThreeMfColoredMesh here (quantised palette) and package it
 *   with `createThreeMfBlobFromColoredMesh`, which takes precomputed data and
 *   does not re-repair. The packaging helper converts y-up→z-up internally, so
 *   we pass three.js-space coordinates.
 */

import * as THREE from 'three';
import {
  quantizeTriangleColors,
  createThreeMfBlobFromColoredMesh,
  clampThreeMfColorCount,
  type ThreeMfColoredMesh,
  type ThreeMfTriangle,
} from './threeMfExport.ts';
import type { FlexiToyResult } from './flexiToyTypes.ts';

const THREE_MF_COLOR_COUNT = 8;

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
 * 3MF blob for the result, with a quantised palette baked from the carried
 * per-vertex colours. Segments stay separate — no body fusion.
 */
export function flexiResultToThreeMfBlob(
  result: FlexiToyResult,
  filename: string,
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

  // Per-triangle average colour + area weight → quantised palette.
  const triangleColors: THREE.Color[] = new Array(triangleCount);
  const samples: { color: THREE.Color; weight: number }[] = new Array(
    triangleCount,
  );
  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  for (let t = 0; t < triangleCount; t += 1) {
    const ia = indices[t * 3];
    const ib = indices[t * 3 + 1];
    const ic = indices[t * 3 + 2];
    const color = new THREE.Color(
      (colors[ia * 3] + colors[ib * 3] + colors[ic * 3]) / 3,
      (colors[ia * 3 + 1] + colors[ib * 3 + 1] + colors[ic * 3 + 1]) / 3,
      (colors[ia * 3 + 2] + colors[ib * 3 + 2] + colors[ic * 3 + 2]) / 3,
    );
    triangleColors[t] = color;
    va.set(positions[ia * 3], positions[ia * 3 + 1], positions[ia * 3 + 2]);
    vb.set(positions[ib * 3], positions[ib * 3 + 1], positions[ib * 3 + 2]);
    vc.set(positions[ic * 3], positions[ic * 3 + 1], positions[ic * 3 + 2]);
    const area = vb.clone().sub(va).cross(vc.clone().sub(va)).length() * 0.5;
    samples[t] = { color, weight: area };
  }

  const palette = quantizeTriangleColors(
    samples,
    clampThreeMfColorCount(THREE_MF_COLOR_COUNT),
  );
  const paletteHex = palette.map(
    (color) => `#${color.getHexString().toUpperCase()}`,
  );

  const triangles: ThreeMfTriangle[] = new Array(triangleCount);
  for (let t = 0; t < triangleCount; t += 1) {
    triangles[t] = {
      v1: indices[t * 3],
      v2: indices[t * 3 + 1],
      v3: indices[t * 3 + 2],
      colorIndex: nearestPaletteIndex(triangleColors[t], palette),
    };
  }

  const coloredMesh: ThreeMfColoredMesh = {
    vertices,
    triangles,
    palette: paletteHex,
  };
  return createThreeMfBlobFromColoredMesh({ coloredMesh, filename });
}

function nearestPaletteIndex(
  color: THREE.Color,
  palette: THREE.Color[],
): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < palette.length; i += 1) {
    const dr = color.r - palette[i].r;
    const dg = color.g - palette[i].g;
    const db = color.b - palette[i].b;
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}
