import {
  AmbientLight,
  Box3,
  BufferAttribute,
  Color,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { analyze } from './meshTopology';

// A labeled multi-view render of a compiled model, used by the premium visual
// inspection loop as the image the reviewer LLM judges. Written from scratch
// (no third-party sheet code) and careful to release every GL resource it
// allocates so repeated inspection rounds don't leak WebGL contexts.

// 4x2 grid of square-ish cells → ~1568x800 total.
const CELL_W = 392;
const CELL_H = 400;
const COLS = 4;
const ROWS = 2;
const SHEET_W = CELL_W * COLS; // 1568
const SHEET_H = CELL_H * ROWS; // 800

type ViewSpec = { name: string; dir: Vector3; up: Vector3 };

// Z-up (OpenSCAD convention). Side views keep +Z up; TOP/BOTTOM look down/up
// the Z axis so their "up" must be a horizontal axis instead.
const VIEWS: ViewSpec[] = [
  { name: 'ISO', dir: new Vector3(1, 1, 1), up: new Vector3(0, 0, 1) },
  { name: 'FRONT', dir: new Vector3(0, -1, 0), up: new Vector3(0, 0, 1) },
  { name: 'BACK', dir: new Vector3(0, 1, 0), up: new Vector3(0, 0, 1) },
  { name: 'LEFT', dir: new Vector3(-1, 0, 0), up: new Vector3(0, 0, 1) },
  { name: 'RIGHT', dir: new Vector3(1, 0, 0), up: new Vector3(0, 0, 1) },
  { name: 'TOP', dir: new Vector3(0, 0, 1), up: new Vector3(0, 1, 0) },
  { name: 'BOTTOM', dir: new Vector3(0, 0, -1), up: new Vector3(0, -1, 0) },
];

const BG = '#f3f4f6';

// The largest body keeps the original neutral grey; extra (disconnected) bodies
// get distinct saturated colors so a floating part is obvious to the reviewer.
const BODY_GREY = 0x9aa4b2;
const EXTRA_BODY_COLORS = [
  0xef4444, // red
  0x3b82f6, // blue
  0x22c55e, // green
  0xf59e0b, // amber
  0xa855f7, // purple
  0x14b8a6, // teal
  0xec4899, // pink
];

function hexToCss(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

type BodyLegendEntry = { label: string; css: string };

function formatDim(n: number): string {
  return Number.isFinite(n) ? (Math.round(n * 10) / 10).toString() : '?';
}

/**
 * Render a compiled STL blob into a labeled 7-view PNG sheet.
 *
 * Runs off the interactive viewer's render loop on a throwaway renderer, and
 * disposes the geometry, material, renderer, and WebGL context before
 * returning so no GPU resources are held past this call.
 */
export async function renderInspectionSheet(stl: Blob): Promise<Blob> {
  const buffer = await stl.arrayBuffer();
  const geometry = new STLLoader().parse(buffer);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();

  const box = geometry.boundingBox ?? new Box3();
  const size = new Vector3();
  box.getSize(size);

  // Center the geometry at the origin so every camera can simply look at (0,0,0).
  geometry.center();
  geometry.computeBoundingSphere();
  const radius =
    geometry.boundingSphere?.radius || Math.max(...size.toArray(), 1);

  // Count distinct solid bodies so disconnected parts can be colored apart.
  // Never throws (falls back to one body); adds no model calls.
  const topology = analyze(geometry);
  const multiBody = topology.bodyCount > 1;

  // Assign colors by body size: largest body → neutral grey (current look),
  // each additional body → a distinct saturated color, cycled if needed.
  const bodyOrder = [...topology.bodyTriangleCounts.keys()].sort(
    (a, b) => topology.bodyTriangleCounts[b] - topology.bodyTriangleCounts[a],
  );
  const colorForBody = new Array<number>(topology.bodyCount);
  const legend: BodyLegendEntry[] = [];
  bodyOrder.forEach((bodyIndex, rank) => {
    const hex =
      rank === 0
        ? BODY_GREY
        : EXTRA_BODY_COLORS[(rank - 1) % EXTRA_BODY_COLORS.length];
    colorForBody[bodyIndex] = hex;
    legend.push({ label: `${rank + 1}`, css: hexToCss(hex) });
  });

  // With more than one body, drive color from a per-vertex color attribute and
  // keep the material white (it multiplies vertex colors). A single body keeps
  // the original solid-grey material untouched.
  if (multiBody) {
    const vertexCount = geometry.getAttribute('position').count;
    const colors = new Float32Array(vertexCount * 3);
    const colorObjs = colorForBody.map((hex) => new Color(hex));
    for (let t = 0; t < topology.triangleBodies.length; t++) {
      const c = colorObjs[topology.triangleBodies[t]];
      for (let k = 0; k < 3; k++) {
        const vi = (t * 3 + k) * 3;
        colors[vi] = c.r;
        colors[vi + 1] = c.g;
        colors[vi + 2] = c.b;
      }
    }
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
  }

  const material = new MeshStandardMaterial({
    color: multiBody ? 0xffffff : BODY_GREY,
    vertexColors: multiBody,
    metalness: 0.1,
    roughness: 0.75,
  });
  const mesh = new Mesh(geometry, material);

  const scene = new Scene();
  scene.add(mesh);
  scene.add(new AmbientLight(0xffffff, 0.85));
  const key = new DirectionalLight(0xffffff, 0.7);
  key.position.set(1, 1, 1);
  scene.add(key);
  const fill = new DirectionalLight(0xffffff, 0.35);
  fill.position.set(-1, -1, 0.5);
  scene.add(fill);

  const rendererCanvas = document.createElement('canvas');
  const renderer = new WebGLRenderer({
    canvas: rendererCanvas,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(CELL_W, CELL_H, false);
  renderer.setClearColor(BG, 1);

  const composite = document.createElement('canvas');
  composite.width = SHEET_W;
  composite.height = SHEET_H;
  const ctx = composite.getContext('2d');
  if (!ctx) {
    renderer.dispose();
    geometry.dispose();
    material.dispose();
    throw new Error('Failed to acquire 2D context for inspection sheet');
  }
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, SHEET_W, SHEET_H);

  // Orthographic frustum sized to the bounding sphere so the whole model fits
  // in every view (including the diagonal ISO view). Widen horizontally for
  // the cell aspect ratio.
  const aspect = CELL_W / CELL_H;
  const halfH = radius * 1.15;
  const halfW = halfH * aspect;
  const distance = radius * 4;

  try {
    for (let i = 0; i < VIEWS.length; i++) {
      const view = VIEWS[i];
      const camera = new OrthographicCamera(
        -halfW,
        halfW,
        halfH,
        -halfH,
        0.01,
        distance * 4,
      );
      const dir = view.dir.clone().normalize();
      camera.position.copy(dir.multiplyScalar(distance));
      camera.up.copy(view.up);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();

      renderer.render(scene, camera);

      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const x = col * CELL_W;
      const y = row * CELL_H;
      ctx.drawImage(rendererCanvas, x, y, CELL_W, CELL_H);
      drawLabel(ctx, view.name, x, y);
    }

    // Final cell: title + overall dimensions + body count.
    const tx = (VIEWS.length % COLS) * CELL_W;
    const ty = Math.floor(VIEWS.length / COLS) * CELL_H;
    drawInfoCell(ctx, tx, ty, size, topology.bodyCount, legend);
  } finally {
    // Release everything. forceContextLoss frees the underlying WebGL context
    // eagerly instead of waiting for GC — important because browsers cap the
    // number of live contexts and each inspection round makes a new one.
    renderer.dispose();
    renderer.forceContextLoss();
    geometry.dispose();
    material.dispose();
  }

  return await new Promise<Blob>((resolve, reject) => {
    composite.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Failed to encode inspection sheet PNG'));
    }, 'image/png');
  });
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  name: string,
  x: number,
  y: number,
): void {
  ctx.save();
  ctx.font = '600 18px system-ui, sans-serif';
  const paddingX = 10;
  const textW = ctx.measureText(name).width;
  ctx.fillStyle = 'rgba(17, 24, 39, 0.72)';
  ctx.fillRect(x + 8, y + CELL_H - 34, textW + paddingX * 2, 26);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, x + 8 + paddingX, y + CELL_H - 34 + 13);
  ctx.restore();
}

function drawInfoCell(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: Vector3,
  bodyCount: number,
  legend: BodyLegendEntry[],
): void {
  const cx = x + CELL_W / 2;
  ctx.save();
  ctx.fillStyle = '#111827';
  ctx.fillRect(x, y, CELL_W, CELL_H);
  ctx.fillStyle = '#e5e7eb';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 22px system-ui, sans-serif';
  ctx.fillText('Model', cx, y + CELL_H / 2 - 44);
  ctx.font = '500 18px system-ui, sans-serif';
  const dims = `${formatDim(size.x)} × ${formatDim(size.y)} × ${formatDim(size.z)} mm`;
  ctx.fillText(dims, cx, y + CELL_H / 2 - 10);
  ctx.font = '400 13px system-ui, sans-serif';
  ctx.fillStyle = '#9ca3af';
  ctx.fillText('W × D × H', cx, y + CELL_H / 2 + 14);

  // Body count — 1 for a clean single/kit-welded solid, >1 flags separate
  // (possibly disconnected) bodies, which the render colors distinctly.
  ctx.font = '600 15px system-ui, sans-serif';
  ctx.fillStyle = bodyCount > 1 ? '#fca5a5' : '#9ca3af';
  ctx.fillText(`Bodies: ${bodyCount}`, cx, y + CELL_H / 2 + 44);

  // Tiny legend when the bodies are colored apart: a swatch + index per body.
  if (bodyCount > 1) {
    const swatch = 12;
    const gap = 6;
    const spacing = 34;
    const entries = legend.slice(0, 8);
    const totalW = entries.length * spacing - (spacing - (swatch + gap + 10));
    let lx = cx - totalW / 2;
    const ly = y + CELL_H / 2 + 74;
    ctx.textAlign = 'left';
    ctx.font = '500 13px system-ui, sans-serif';
    for (const entry of entries) {
      ctx.fillStyle = entry.css;
      ctx.fillRect(lx, ly - swatch / 2, swatch, swatch);
      ctx.fillStyle = '#e5e7eb';
      ctx.fillText(entry.label, lx + swatch + gap, ly);
      lx += spacing;
    }
  }
  ctx.restore();
}
