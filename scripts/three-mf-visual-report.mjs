import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';
import * as THREE from 'three';
import {
  analyzeThreeMfMeshTopology,
  createThreeMfBlobFromScene,
} from '../src/utils/threeMfExport.ts';

const DEFAULT_SLOT_COLORS = ['#87CEEB', '#FFFF00', '#FF0000', '#0000FF'];
const BAMBU_ORCA_FILAMENT_SLOT_CODES = [
  '4',
  '8',
  '0C',
  '1C',
  '2C',
  '3C',
  '4C',
  '5C',
  '6C',
  '7C',
  '8C',
  '9C',
  'AC',
  'BC',
  'CC',
  'DC',
];

const args = parseArgs(process.argv.slice(2));
const outPath = resolve(args.out ?? 'tmp/3mf-visual-report.html');
const slotColors = (args.slotColors ?? DEFAULT_SLOT_COLORS.join(','))
  .split(',')
  .map((color) => normalizeHexColor(color.trim()))
  .filter(Boolean);
const selfTestFixture = args.selfTest ? buildVisualSelfTestFixture() : null;

const blob = selfTestFixture
  ? await createThreeMfBlobFromScene({
      scene: selfTestFixture.scene,
      filename: '3mf-visual-self-test',
      colorCount: 4,
    })
  : new Blob([await readFile(requiredInputPath(args))], {
      type: 'model/3mf',
    });

const report = await buildReport(
  blob,
  slotColors,
  selfTestFixture?.sourceModel ?? null,
);
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, renderHtmlReport(report), 'utf8');

if (args.selfTest) {
  const failures = [];
  if (report.materialTransitionEdges !== 33) {
    failures.push(
      `expected 33 material transition edges, got ${report.materialTransitionEdges}`,
    );
  }
  if (report.componentStats.componentCount !== 13) {
    failures.push(
      `expected 13 material components, got ${report.componentStats.componentCount}`,
    );
  }
  if (report.materialColors.length !== 4) {
    failures.push(
      `expected four preserved material colors, got ${report.materialColors.length}`,
    );
  }
  if (!report.rootApplication.startsWith('BambuStudio-')) {
    failures.push(
      `expected BambuStudio application metadata, got ${report.rootApplication || 'empty'}`,
    );
  }

  if (failures.length > 0) {
    console.error(`3MF visual self-test failed. Report: ${outPath}`);
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }
}

console.log(`3MF visual report written to ${outPath}`);
console.log(
  JSON.stringify(
    {
      triangles: report.triangles.length,
      boundaryEdges: report.topology.boundaryEdges,
      materialTransitionEdges: report.materialTransitionEdges,
      materialCounts: report.materialCounts,
      componentCount: report.componentStats.componentCount,
      smallComponentCount: report.componentStats.smallComponentCount,
    },
    null,
    2,
  ),
);

async function buildReport(blob, slotColors, sourceModel) {
  const { entries, rootApplication, modelXml, settings } = await readThreeMf(blob);
  const model = parseModelXml(modelXml, settings);
  const topology = analyzeThreeMfMeshTopology(modelXml);
  const componentStats = getComponentStats(model.triangles);
  const materialTransitionEdges = getMaterialTransitionEdges(model.triangles);
  const materialCounts = {};
  for (const triangle of model.triangles) {
    materialCounts[triangle.colorIndex] =
      (materialCounts[triangle.colorIndex] ?? 0) + 1;
  }

  return {
    entries,
    rootApplication,
    materialColors: model.materialColors,
    slotColors,
    vertices: model.vertices,
    triangles: model.triangles,
    topology,
    materialCounts,
    materialTransitionEdges,
    componentStats,
    sourceSvg: sourceModel
      ? renderModelSvg(sourceModel, sourceModel.materialColors)
      : null,
    materialSvg: renderModelSvg(model, model.materialColors),
    slotSvg: renderModelSvg(model, slotColors),
    settingsColors: settings?.filament_colour ?? [],
  };
}

async function readThreeMf(blob) {
  const zipReader = new ZipReader(new BlobReader(blob));
  try {
    const entries = await zipReader.getEntries();
    const entryNames = entries.map((entry) => entry.filename);
    const modelEntry =
      entries.find(
        (entry) => entry.filename === '3D/Objects/Object_1_1.model',
      ) ??
      entries.find(
        (entry) =>
          entry.filename.startsWith('3D/Objects/') &&
          entry.filename.endsWith('.model'),
      ) ??
      entries.find((entry) => entry.filename === '3D/3dmodel.model');
    if (!modelEntry) {
      throw new Error('3MF package does not contain a readable model file');
    }

    const settingsEntry = entries.find(
      (entry) => entry.filename === 'Metadata/project_settings.config',
    );
    const settings = settingsEntry
      ? JSON.parse(await settingsEntry.getData(new TextWriter()))
      : null;
    const rootEntry = entries.find(
      (entry) => entry.filename === '3D/3dmodel.model',
    );
    const rootXml = rootEntry
      ? await rootEntry.getData(new TextWriter())
      : '';
    const rootApplication =
      rootXml.match(/<metadata\s+name="Application">([^<]*)<\/metadata>/)?.[1] ??
      '';

    return {
      entries: entryNames,
      rootApplication,
      modelXml: await modelEntry.getData(new TextWriter()),
      settings,
    };
  } finally {
    await zipReader.close();
  }
}

function parseModelXml(modelXml, settings) {
  const vertices = [...modelXml.matchAll(/<vertex\b([^>]*)\/>/g)].map(
    (match) => {
      const attributes = getXmlAttributes(match[1]);
      return {
        x: Number(attributes.x),
        y: Number(attributes.y),
        z: Number(attributes.z),
      };
    },
  );
  const materialColorsFromModel = [
    ...modelXml.matchAll(/\bdisplaycolor="(#[0-9A-Fa-f]{6})[0-9A-Fa-f]{2}"/g),
  ].map((match) => normalizeHexColor(match[1]));
  const materialColors =
    materialColorsFromModel.length > 0
      ? materialColorsFromModel
      : (settings?.filament_colour ?? []).map((color) =>
          normalizeHexColor(color),
        );
  const triangles = [...modelXml.matchAll(/<triangle\b([^>]*)\/>/g)].map(
    (match) => {
      const attributes = getXmlAttributes(match[1]);
      const paintColorIndex = decodeBambuPaintColor(attributes.paint_color);
      return {
        v1: Number(attributes.v1),
        v2: Number(attributes.v2),
        v3: Number(attributes.v3),
        colorIndex: Number(attributes.p1 ?? paintColorIndex ?? 0),
      };
    },
  );

  return { vertices, materialColors, triangles };
}

function decodeBambuPaintColor(paintColor) {
  if (!paintColor) {
    return null;
  }

  const normalizedPaintColor = paintColor.toUpperCase();
  const slotIndex = BAMBU_ORCA_FILAMENT_SLOT_CODES.findIndex(
    (code) => normalizedPaintColor === code,
  );

  return slotIndex >= 0 ? slotIndex : null;
}

function renderModelSvg(model, colors) {
  const width = 520;
  const height = 420;
  const projection = getProjectionAxes(model.vertices);
  const bounds = getBounds(model.vertices, projection);
  const boundsWidth = Math.max(1, bounds.maxX - bounds.minX);
  const boundsHeight = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min(
    (width - 48) / boundsWidth,
    (height - 48) / boundsHeight,
  );
  const offsetX = (width - boundsWidth * scale) / 2;
  const offsetY = (height - boundsHeight * scale) / 2;
  const sortedTriangles = model.triangles
    .slice()
    .sort(
      (a, b) => getAverageZ(model.vertices, a) - getAverageZ(model.vertices, b),
    );

  const polygons = sortedTriangles
    .map((triangle) => {
      const points = [triangle.v1, triangle.v2, triangle.v3]
        .map((vertexIndex) => {
          const vertex = model.vertices[vertexIndex];
          const x =
            offsetX + (vertex[projection.horizontal] - bounds.minX) * scale;
          const y =
            height -
            (offsetY + (vertex[projection.vertical] - bounds.minY) * scale);
          return `${formatSvgNumber(x)},${formatSvgNumber(y)}`;
        })
        .join(' ');
      const color = colors[triangle.colorIndex % colors.length] ?? '#CCCCCC';
      return `<polygon points="${points}" fill="${color}" stroke="${color}" stroke-width="0.18"/>`;
    })
    .join('\n');

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="3MF render" xmlns="http://www.w3.org/2000/svg">
  <rect width="${width}" height="${height}" fill="#363636"/>
  ${polygons}
</svg>`;
}

function getProjectionAxes(vertices) {
  const axes = ['x', 'y', 'z'];
  const ranges = axes
    .map((axis) => {
      const values = vertices.map((vertex) => vertex[axis]);
      return {
        axis,
        range: Math.max(...values) - Math.min(...values),
      };
    })
    .sort((a, b) => b.range - a.range);
  const selectedAxes = ranges.slice(0, 2).map((entry) => entry.axis);

  return {
    horizontal: selectedAxes.includes('x') ? 'x' : selectedAxes[0],
    vertical: selectedAxes.includes('x')
      ? (selectedAxes.find((axis) => axis !== 'x') ?? 'y')
      : selectedAxes[1],
  };
}

function renderHtmlReport(report) {
  const materialLegend = renderLegend(report.materialColors, '3MF colors');
  const slotLegend = renderLegend(report.slotColors, 'Bambu-like slots');
  const hasSource = report.sourceSvg !== null;
  const application = escapeHtml(report.rootApplication || 'unknown');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Actual exported 3MF visual check</title>
  <style>
    body { margin: 0; background: #101010; color: #f6f6f6; font: 14px/1.4 system-ui, sans-serif; }
    main { max-width: 1180px; margin: 0 auto; padding: 20px; }
    h1 { font-size: 24px; margin: 0 0 4px; }
    p { color: #b8b8b8; margin: 0 0 16px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .panel, .metric, .legend { background: #1c1c1c; border: 1px solid #2c2c2c; border-radius: 8px; overflow: hidden; }
    .panel h2 { font-size: 14px; margin: 0; padding: 12px 14px; background: #202020; }
    .panel svg { display: block; width: 100%; height: auto; }
    .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 14px 0 10px; }
    .metric { padding: 12px; }
    .metric strong { display: block; font-size: 18px; }
    .metric span { color: #aaa; font-size: 12px; }
    .legend { padding: 12px; }
    .legend-row { display: flex; flex-wrap: wrap; gap: 10px 16px; margin-top: 8px; }
    .swatch { display: inline-flex; align-items: center; gap: 6px; color: #cfcfcf; font-size: 12px; }
    .chip { width: 16px; height: 16px; border-radius: 3px; border: 1px solid #666; }
  </style>
</head>
<body>
  <main>
    <h1>Actual exported 3MF visual check</h1>
    <p>${
      hasSource
        ? 'Left shows the source scene colors used by the web viewer. Middle reopens the exported 3MF material colors. Right uses approximate Bambu slot colors to reveal triangle-by-triangle assignment patterns.'
        : 'Left uses the 3MF material colors. Right uses approximate Bambu slot colors, which reveals triangle-by-triangle assignment patterns.'
    }</p>
    <section class="grid${hasSource ? ' three' : ''}">
      ${
        hasSource
          ? `<article class="panel"><h2>Source web viewer colors</h2>${report.sourceSvg}</article>`
          : ''
      }
      <article class="panel"><h2>3MF material colors</h2>${report.materialSvg}</article>
      <article class="panel"><h2>Bambu-like slot colors</h2>${report.slotSvg}</article>
    </section>
    <section class="metrics">
      <div class="metric"><strong>${report.triangles.length.toLocaleString()}</strong><span>Triangles</span></div>
      <div class="metric"><strong>${report.topology.boundaryEdges.toLocaleString()}</strong><span>Boundary edges</span></div>
      <div class="metric"><strong>${report.materialTransitionEdges.toLocaleString()}</strong><span>Edges crossing material</span></div>
      <div class="metric"><strong>${Object.entries(report.materialCounts)
        .map(([key, value]) => `${key}:${value}`)
        .join(' ')}</strong><span>Material counts</span></div>
    </section>
    <section class="metrics">
      <div class="metric"><strong>${report.componentStats.componentCount.toLocaleString()}</strong><span>Material components</span></div>
      <div class="metric"><strong>${report.componentStats.smallComponentCount.toLocaleString()}</strong><span>Small components &lt;= 8 tris</span></div>
      <div class="metric"><strong>${report.topology.edgeUseHistogram[2] ?? 0}</strong><span>Manifold edges</span></div>
      <div class="metric"><strong>${report.topology.overSharedEdges}</strong><span>Over-shared edges</span></div>
    </section>
    <section class="metrics">
      <div class="metric"><strong>${application}</strong><span>3MF application metadata</span></div>
      <div class="metric"><strong>${report.settingsColors.length.toLocaleString()}</strong><span>Project filament colors</span></div>
      <div class="metric"><strong>${report.materialColors.length.toLocaleString()}</strong><span>Renderable material colors</span></div>
      <div class="metric"><strong>${report.entries.length.toLocaleString()}</strong><span>Package entries</span></div>
    </section>
    <section class="legend">
      ${materialLegend}
      ${slotLegend}
    </section>
  </main>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function getMaterialTransitionEdges(triangles) {
  const edgeToTriangleIndexes = new Map();
  triangles.forEach((triangle, triangleIndex) => {
    for (const [a, b] of [
      [triangle.v1, triangle.v2],
      [triangle.v2, triangle.v3],
      [triangle.v3, triangle.v1],
    ]) {
      const key = [a, b].sort((left, right) => left - right).join('-');
      const indexes = edgeToTriangleIndexes.get(key) ?? [];
      indexes.push(triangleIndex);
      edgeToTriangleIndexes.set(key, indexes);
    }
  });

  let materialTransitionEdges = 0;
  for (const triangleIndexes of edgeToTriangleIndexes.values()) {
    const colors = new Set(
      triangleIndexes.map(
        (triangleIndex) => triangles[triangleIndex].colorIndex,
      ),
    );
    if (colors.size > 1) {
      materialTransitionEdges += 1;
    }
  }

  return materialTransitionEdges;
}

function getComponentStats(triangles) {
  const edgeToTriangleIndexes = new Map();
  triangles.forEach((triangle, triangleIndex) => {
    for (const [a, b] of [
      [triangle.v1, triangle.v2],
      [triangle.v2, triangle.v3],
      [triangle.v3, triangle.v1],
    ]) {
      const key = [a, b].sort((left, right) => left - right).join('-');
      const indexes = edgeToTriangleIndexes.get(key) ?? [];
      indexes.push(triangleIndex);
      edgeToTriangleIndexes.set(key, indexes);
    }
  });

  const adjacency = Array.from({ length: triangles.length }, () => []);
  for (const triangleIndexes of edgeToTriangleIndexes.values()) {
    for (const triangleIndex of triangleIndexes) {
      for (const neighborIndex of triangleIndexes) {
        if (triangleIndex !== neighborIndex) {
          adjacency[triangleIndex].push(neighborIndex);
        }
      }
    }
  }

  const visited = new Set();
  let componentCount = 0;
  let smallComponentCount = 0;
  for (
    let triangleIndex = 0;
    triangleIndex < triangles.length;
    triangleIndex += 1
  ) {
    if (visited.has(triangleIndex)) {
      continue;
    }
    const colorIndex = triangles[triangleIndex].colorIndex;
    const stack = [triangleIndex];
    visited.add(triangleIndex);
    componentCount += 1;
    let size = 0;
    while (stack.length > 0) {
      const currentIndex = stack.pop();
      size += 1;
      for (const neighborIndex of adjacency[currentIndex]) {
        if (
          !visited.has(neighborIndex) &&
          triangles[neighborIndex].colorIndex === colorIndex
        ) {
          visited.add(neighborIndex);
          stack.push(neighborIndex);
        }
      }
    }
    if (size <= 8) {
      smallComponentCount += 1;
    }
  }

  return { componentCount, smallComponentCount };
}

function buildVisualSelfTestFixture() {
  const scene = new THREE.Scene();
  const geometry = new THREE.BufferGeometry();
  const positions = [];
  const indexes = [];
  const groups = [];
  const sourceVertices = [];
  const sourceTriangles = [];
  const materialColors = ['#5B7F22', '#FF0000', '#0000FF', '#FFFF00'];
  const gridSize = 8;
  for (let y = 0; y <= gridSize; y += 1) {
    for (let x = 0; x <= gridSize; x += 1) {
      positions.push(x, y, 0);
      sourceVertices.push({ x, y, z: 0 });
    }
  }
  const vertexIndex = (x, y) => y * (gridSize + 1) + x;
  for (let y = 0; y < gridSize; y += 1) {
    for (let x = 0; x < gridSize; x += 1) {
      const start = indexes.length;
      const materialIndex = (x + y) % 5 === 0 ? ((x + y) % 3) + 1 : 0;
      indexes.push(
        vertexIndex(x, y),
        vertexIndex(x + 1, y),
        vertexIndex(x + 1, y + 1),
        vertexIndex(x, y),
        vertexIndex(x + 1, y + 1),
        vertexIndex(x, y + 1),
      );
      sourceTriangles.push(
        {
          v1: vertexIndex(x, y),
          v2: vertexIndex(x + 1, y),
          v3: vertexIndex(x + 1, y + 1),
          colorIndex: materialIndex,
        },
        {
          v1: vertexIndex(x, y),
          v2: vertexIndex(x + 1, y + 1),
          v3: vertexIndex(x, y + 1),
          colorIndex: 0,
        },
      );
      groups.push({ start, count: 3, materialIndex });
      groups.push({ start: start + 3, count: 3, materialIndex: 0 });
    }
  }
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setIndex(indexes);
  for (const group of groups) {
    geometry.addGroup(group.start, group.count, group.materialIndex);
  }

  scene.add(
    new THREE.Mesh(geometry, [
      new THREE.MeshStandardMaterial({ color: '#5b7f22' }),
      new THREE.MeshStandardMaterial({ color: '#ff0000' }),
      new THREE.MeshStandardMaterial({ color: '#0000ff' }),
      new THREE.MeshStandardMaterial({ color: '#ffff00' }),
    ]),
  );
  return {
    scene,
    sourceModel: {
      vertices: sourceVertices,
      materialColors,
      triangles: sourceTriangles,
    },
  };
}

function getBounds(vertices, projection) {
  return vertices.reduce(
    (bounds, vertex) => ({
      minX: Math.min(bounds.minX, vertex[projection.horizontal]),
      maxX: Math.max(bounds.maxX, vertex[projection.horizontal]),
      minY: Math.min(bounds.minY, vertex[projection.vertical]),
      maxY: Math.max(bounds.maxY, vertex[projection.vertical]),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    },
  );
}

function getAverageZ(vertices, triangle) {
  return (
    ((vertices[triangle.v1]?.z ?? 0) +
      (vertices[triangle.v2]?.z ?? 0) +
      (vertices[triangle.v3]?.z ?? 0)) /
    3
  );
}

function renderLegend(colors, label) {
  return `<div><strong>${label}</strong><div class="legend-row">${colors
    .map(
      (color, index) =>
        `<span class="swatch"><span class="chip" style="background:${color}"></span>${index} ${color}</span>`,
    )
    .join('')}</div></div>`;
}

function getXmlAttributes(text) {
  return Object.fromEntries(
    [...text.matchAll(/([\w:]+)="([^"]*)"/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
}

function normalizeHexColor(color) {
  const match = color.match(/^#?([0-9a-fA-F]{6})/);
  return match ? `#${match[1].toUpperCase()}` : null;
}

function formatSvgNumber(value) {
  return Number(value.toFixed(2));
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--self-test') {
      parsed.selfTest = true;
    } else if (value === '--input') {
      parsed.input = argv[++index];
    } else if (value === '--out') {
      parsed.out = argv[++index];
    } else if (value === '--slot-colors') {
      parsed.slotColors = argv[++index];
    }
  }
  return parsed;
}

function requiredInputPath(parsedArgs) {
  if (!parsedArgs.input) {
    const scriptName = fileURLToPath(import.meta.url);
    throw new Error(
      `Usage: node --experimental-strip-types ${scriptName} --input model.3mf --out report.html`,
    );
  }
  return resolve(parsedArgs.input);
}
