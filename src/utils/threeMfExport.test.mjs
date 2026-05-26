import assert from 'node:assert/strict';
import {
  BlobReader,
  BlobWriter,
  TextReader,
  TextWriter,
  ZipReader,
  ZipWriter,
} from '@zip.js/zip.js';
import * as THREE from 'three';
import {
  buildThreeMfContentTypesXml,
  buildThreeMfModelXml,
  buildThreeMfProjectSettingsConfig,
  buildThreeMfRelationshipsXml,
  clampThreeMfColorCount,
  createThreeMfBlobFromScene,
  analyzeThreeMfMeshTopology,
  validateThreeMfBlob,
} from './threeMfExport.ts';

async function getZipText(entries, filename) {
  const entry = entries.find((candidate) => candidate.filename === filename);
  assert.ok(entry, `${filename} is present`);
  return entry.getData(new TextWriter());
}

async function getMeshModelXml(entries) {
  return getZipText(entries, '3D/Objects/Object_1_1.model');
}

function getMaterialRegionStats(modelXml) {
  const triangles = [...modelXml.matchAll(/<triangle\b([^>]*)\/>/g)].map(
    (match) => {
      const attributes = Object.fromEntries(
        [...match[1].matchAll(/(\w+)="([^"]*)"/g)].map((attributeMatch) => [
          attributeMatch[1],
          attributeMatch[2],
        ]),
      );
      return {
        vertices: [
          Number(attributes.v1),
          Number(attributes.v2),
          Number(attributes.v3),
        ],
        colorIndex: Number(attributes.p1 ?? 0),
      };
    },
  );
  const edgeToTriangleIndexes = new Map();
  triangles.forEach((triangle, triangleIndex) => {
    for (const [a, b] of [
      [triangle.vertices[0], triangle.vertices[1]],
      [triangle.vertices[1], triangle.vertices[2]],
      [triangle.vertices[2], triangle.vertices[0]],
    ]) {
      const key = [a, b].sort((left, right) => left - right).join('-');
      const indexes = edgeToTriangleIndexes.get(key) ?? [];
      indexes.push(triangleIndex);
      edgeToTriangleIndexes.set(key, indexes);
    }
  });

  const adjacency = Array.from({ length: triangles.length }, () => []);
  let materialTransitionEdges = 0;
  for (const triangleIndexes of edgeToTriangleIndexes.values()) {
    const colors = new Set(
      triangleIndexes.map((triangleIndex) => triangles[triangleIndex].colorIndex),
    );
    if (colors.size > 1) {
      materialTransitionEdges += 1;
    }
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
  for (let triangleIndex = 0; triangleIndex < triangles.length; triangleIndex += 1) {
    if (visited.has(triangleIndex)) {
      continue;
    }
    componentCount += 1;
    const colorIndex = triangles[triangleIndex].colorIndex;
    const stack = [triangleIndex];
    visited.add(triangleIndex);
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

  return {
    componentCount,
    materialTransitionEdges,
    smallComponentCount,
  };
}

assert.equal(clampThreeMfColorCount(0), 1);
assert.equal(clampThreeMfColorCount(4), 4);
assert.equal(clampThreeMfColorCount(20), 16);
assert.equal(clampThreeMfColorCount(Number.NaN), 4);

const modelXml = buildThreeMfModelXml({
  modelName: 'Widget & Gear',
  vertices: [
    [0, 0, 0],
    [10, 0, 0],
    [0, 10, 0],
  ],
  triangles: [{ v1: 0, v2: 1, v3: 2, colorIndex: 1 }],
  palette: ['#112233', '#aabbcc'],
});

assert.match(modelXml, /<model[^>]+unit="millimeter"/);
assert.match(
  modelXml,
  /xmlns:m="http:\/\/schemas\.microsoft\.com\/3dmanufacturing\/material\/2015\/02"/,
);
assert.match(modelXml, /requiredextensions="m"/);
assert.match(modelXml, /<metadata name="Title">Widget &amp; Gear<\/metadata>/);
assert.match(modelXml, /<basematerials id="1">/);
assert.match(
  modelXml,
  /<base name="Generic PLA 2 \(#AABBCC\)" displaycolor="#AABBCCFF"\/>/,
);
assert.match(modelXml, /<m:colorgroup id="2">/);
assert.match(modelXml, /<m:color color="#112233FF"\/>/);
assert.doesNotMatch(modelXml, /<m:multiproperties/);
assert.match(
  modelXml,
  /<triangle v1="0" v2="1" v3="2" pid="1" p1="1" p2="1" p3="1" paint_color="8"\/>/,
);
assert.match(
  modelXml,
  /<object id="1"[^>]+type="model"[^>]+pid="1" pindex="0">/,
);
assert.doesNotMatch(modelXml, /<build>/);

const contentTypesXml = buildThreeMfContentTypesXml();
assert.match(
  contentTypesXml,
  /ContentType="application\/vnd\.ms-package\.3dmanufacturing-3dmodel\+xml"/,
);
assert.match(contentTypesXml, /Extension="rels"/);
assert.match(contentTypesXml, /Extension="config"/);

const projectSettings = JSON.parse(
  buildThreeMfProjectSettingsConfig(['#112233', '#AABBCC']),
);
assert.deepEqual(projectSettings.filament_colour, ['#112233', '#AABBCC']);
assert.deepEqual(projectSettings.default_filament_colour, [
  '#112233',
  '#AABBCC',
]);
assert.deepEqual(projectSettings.filament_type, ['PLA', 'PLA']);
assert.deepEqual(projectSettings.filament_settings_id, [
  'Generic PLA',
  'Generic PLA',
]);
assert.deepEqual(projectSettings.filament_is_support, ['0', '0']);
assert.deepEqual(projectSettings.filament_soluble, ['0', '0']);
assert.deepEqual(projectSettings.filament_minimal_purge_on_wipe_tower, [
  '15',
  '15',
]);
assert.equal(projectSettings.name, 'project_settings');
assert.equal(projectSettings.from, 'project');
assert.equal(projectSettings.single_extruder_multi_material, '1');
assert.deepEqual(projectSettings.filament_vendor, ['Generic', 'Generic']);
assert.deepEqual(projectSettings.filament_diameter, ['1.75', '1.75']);
assert.deepEqual(projectSettings.nozzle_temperature, ['220', '220']);
assert.deepEqual(projectSettings.nozzle_temperature_initial_layer, [
  '220',
  '220',
]);
assert.deepEqual(projectSettings.nozzle_diameter, ['0.4']);

const relationshipsXml = buildThreeMfRelationshipsXml();
assert.match(relationshipsXml, /Target="\/3D\/3dmodel\.model"/);
assert.match(
  relationshipsXml,
  /Type="http:\/\/schemas\.microsoft\.com\/3dmanufacturing\/2013\/01\/3dmodel"/,
);

const scene = new THREE.Scene();
scene.add(
  new THREE.Mesh(
    new THREE.BufferGeometry().setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 10, 0, 0, 0, 10, 0], 3),
    ),
    new THREE.MeshStandardMaterial({ color: '#ff0000' }),
  ),
);

const threeMfBlob = await createThreeMfBlobFromScene({
  scene,
  filename: 'red-part',
  colorCount: 1,
});
assert.equal(threeMfBlob.type, 'model/3mf');

const zipReader = new ZipReader(new BlobReader(threeMfBlob));
const entries = await zipReader.getEntries();
const entryNames = entries.map((entry) => entry.filename).sort();
assert.deepEqual(entryNames, [
  '3D/3dmodel.model',
  '3D/Objects/Object_1_1.model',
  '3D/_rels/3dmodel.model.rels',
  'Metadata/model_settings.config',
  'Metadata/project_settings.config',
  'Metadata/slice_info.config',
  '[Content_Types].xml',
  '_rels/.rels',
]);

const rootModelXml = await getZipText(entries, '3D/3dmodel.model');
assert.match(rootModelXml, /<metadata name="Title">red-part<\/metadata>/);
assert.match(
  rootModelXml,
  /<component p:path="\/3D\/Objects\/Object_1_1\.model" objectid="1"/,
);
assert.match(rootModelXml, /<item objectid="2"[^>]+printable="1"\/>/);
const modelRelationshipsXml = await getZipText(
  entries,
  '3D/_rels/3dmodel.model.rels',
);
assert.match(
  modelRelationshipsXml,
  /Target="\/3D\/Objects\/Object_1_1\.model"/,
);
const packagedModelXml = await getMeshModelXml(entries);
assert.match(packagedModelXml, /<metadata name="Title">red-part<\/metadata>/);
assert.match(packagedModelXml, /<base name="Generic PLA 1 \(#FF0000\)"/);
const settingsEntry = entries.find(
  (entry) => entry.filename === 'Metadata/project_settings.config',
);
assert.ok(settingsEntry);
const packagedSettings = JSON.parse(
  await settingsEntry.getData(new TextWriter()),
);
assert.deepEqual(packagedSettings.filament_colour, ['#FF0000']);
assert.deepEqual(packagedSettings.default_filament_colour, ['#FF0000']);
assert.deepEqual(packagedSettings.filament_is_support, ['0']);
assert.equal(packagedSettings.name, 'project_settings');
assert.match(
  await getZipText(entries, 'Metadata/model_settings.config'),
  /<mesh_stat edges_fixed="0" degenerate_facets="0"/,
);
assert.match(
  await getZipText(entries, 'Metadata/slice_info.config'),
  /X-BBL-Client-Version/,
);
await zipReader.close();

const areaWeightedScene = new THREE.Scene();
const largeRedGeometry = new THREE.BufferGeometry();
largeRedGeometry.setAttribute(
  'position',
  new THREE.Float32BufferAttribute(
    [0, 0, 0, 1000, 0, 0, 1000, 1000, 0, 0, 1000, 0],
    3,
  ),
);
largeRedGeometry.setIndex([0, 1, 2, 0, 2, 3]);
areaWeightedScene.add(
  new THREE.Mesh(
    largeRedGeometry,
    new THREE.MeshStandardMaterial({ color: '#ff0000' }),
  ),
);
const tinyBlueGeometry = new THREE.BufferGeometry();
const tinyBluePositions = [];
const tinyBlueIndexes = [];
for (let index = 0; index < 100; index += 1) {
  const base = tinyBluePositions.length / 3;
  const x = 2000 + index * 0.01;
  tinyBluePositions.push(x, 0, 0, x + 0.001, 0, 0, x, 0.001, 0);
  tinyBlueIndexes.push(base, base + 1, base + 2);
}
tinyBlueGeometry.setAttribute(
  'position',
  new THREE.Float32BufferAttribute(tinyBluePositions, 3),
);
tinyBlueGeometry.setIndex(tinyBlueIndexes);
areaWeightedScene.add(
  new THREE.Mesh(
    tinyBlueGeometry,
    new THREE.MeshStandardMaterial({ color: '#0000ff' }),
  ),
);
const areaWeightedBlob = await createThreeMfBlobFromScene({
  scene: areaWeightedScene,
  filename: 'area-weighted-palette',
  colorCount: 1,
});
const areaWeightedZipReader = new ZipReader(new BlobReader(areaWeightedBlob));
const areaWeightedSettings = JSON.parse(
  await getZipText(
    await areaWeightedZipReader.getEntries(),
    'Metadata/project_settings.config',
  ),
);
assert.deepEqual(areaWeightedSettings.filament_colour, ['#FF0000']);
await areaWeightedZipReader.close();

const squareScene = new THREE.Scene();
const squareGeometry = new THREE.BufferGeometry();
squareGeometry.setAttribute(
  'position',
  new THREE.Float32BufferAttribute([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0], 3),
);
squareGeometry.setIndex([0, 1, 2, 0, 2, 3]);
squareScene.add(
  new THREE.Mesh(
    squareGeometry,
    new THREE.MeshStandardMaterial({ color: '#00ff00' }),
  ),
);

const squareBlob = await createThreeMfBlobFromScene({
  scene: squareScene,
  filename: 'square',
  colorCount: 1,
});
const squareZipReader = new ZipReader(new BlobReader(squareBlob));
const squareModelXml = await getMeshModelXml(
  await squareZipReader.getEntries(),
);
assert.equal(squareModelXml.match(/<vertex /g)?.length, 4);
assert.equal(squareModelXml.match(/<triangle /g)?.length, 2);
assert.match(
  squareModelXml,
  /<triangle v1="0" v2="1" v3="2"[^>]+paint_color="4"\/>/,
);
assert.match(
  squareModelXml,
  /<triangle v1="0" v2="2" v3="3"[^>]+paint_color="4"\/>/,
);
await squareZipReader.close();

const splitSquareScene = new THREE.Scene();
for (const positions of [
  [0, 0, 0, 10, 0, 0, 10, 10, 0],
  [0, 0, 0, 10, 10, 0, 0, 10, 0],
]) {
  splitSquareScene.add(
    new THREE.Mesh(
      new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.Float32BufferAttribute(positions, 3),
      ),
      new THREE.MeshStandardMaterial({ color: '#00ff00' }),
    ),
  );
}

const splitSquareBlob = await createThreeMfBlobFromScene({
  scene: splitSquareScene,
  filename: 'split-square',
  colorCount: 1,
});
const splitSquareZipReader = new ZipReader(new BlobReader(splitSquareBlob));
const splitSquareModelXml = await getMeshModelXml(
  await splitSquareZipReader.getEntries(),
);
assert.equal(splitSquareModelXml.match(/<vertex /g)?.length, 4);
assert.match(splitSquareModelXml, /<triangle v1="0" v2="1" v3="2"/);
assert.match(splitSquareModelXml, /<triangle v1="0" v2="2" v3="3"/);
await splitSquareZipReader.close();

const noisySurfaceScene = new THREE.Scene();
const noisySurfaceGeometry = new THREE.BufferGeometry();
noisySurfaceGeometry.setAttribute(
  'position',
  new THREE.Float32BufferAttribute(
    [5, 5, 0, 0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0],
    3,
  ),
);
noisySurfaceGeometry.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1]);
noisySurfaceGeometry.clearGroups();
noisySurfaceGeometry.addGroup(0, 3, 0);
noisySurfaceGeometry.addGroup(3, 9, 1);
noisySurfaceScene.add(
  new THREE.Mesh(noisySurfaceGeometry, [
    new THREE.MeshStandardMaterial({ color: '#00ee00' }),
    new THREE.MeshStandardMaterial({ color: '#00ff00' }),
  ]),
);
const noisySurfaceBlob = await createThreeMfBlobFromScene({
  scene: noisySurfaceScene,
  filename: 'noisy-surface',
  colorCount: 2,
});
const noisySurfaceZipReader = new ZipReader(new BlobReader(noisySurfaceBlob));
const noisySurfaceEntries = await noisySurfaceZipReader.getEntries();
const noisySurfaceModelXml = await getMeshModelXml(noisySurfaceEntries);
const noisySurfaceMaterialIndexes = [
  ...noisySurfaceModelXml.matchAll(/\bp1="(\d+)"/g),
].map((match) => match[1]);
assert.deepEqual([...new Set(noisySurfaceMaterialIndexes)], ['0']);
const noisySurfaceSettings = JSON.parse(
  await getZipText(noisySurfaceEntries, 'Metadata/project_settings.config'),
);
assert.equal(noisySurfaceSettings.filament_colour.length, 1);
await noisySurfaceZipReader.close();

const noisySlotScene = new THREE.Scene();
const noisySlotGeometry = new THREE.BufferGeometry();
const noisySlotPositions = [];
const noisySlotIndexes = [];
const noisySlotGroups = [];
const noisyGridSize = 8;
for (let y = 0; y <= noisyGridSize; y += 1) {
  for (let x = 0; x <= noisyGridSize; x += 1) {
    noisySlotPositions.push(x, y, 0);
  }
}
const noisyVertexIndex = (x, y) => y * (noisyGridSize + 1) + x;
for (let y = 0; y < noisyGridSize; y += 1) {
  for (let x = 0; x < noisyGridSize; x += 1) {
    const firstTriangleOffset = noisySlotIndexes.length;
    const materialIndex = (x + y) % 5 === 0 ? ((x + y) % 3) + 1 : 0;
    noisySlotIndexes.push(
      noisyVertexIndex(x, y),
      noisyVertexIndex(x + 1, y),
      noisyVertexIndex(x + 1, y + 1),
      noisyVertexIndex(x, y),
      noisyVertexIndex(x + 1, y + 1),
      noisyVertexIndex(x, y + 1),
    );
    noisySlotGroups.push({
      start: firstTriangleOffset,
      count: 3,
      materialIndex,
    });
    noisySlotGroups.push({
      start: firstTriangleOffset + 3,
      count: 3,
      materialIndex: 0,
    });
  }
}
noisySlotGeometry.setAttribute(
  'position',
  new THREE.Float32BufferAttribute(noisySlotPositions, 3),
);
noisySlotGeometry.setIndex(noisySlotIndexes);
noisySlotGeometry.clearGroups();
for (const group of noisySlotGroups) {
  noisySlotGeometry.addGroup(group.start, group.count, group.materialIndex);
}
noisySlotScene.add(
  new THREE.Mesh(noisySlotGeometry, [
    new THREE.MeshStandardMaterial({ color: '#5b7f22' }),
    new THREE.MeshStandardMaterial({ color: '#ff0000' }),
    new THREE.MeshStandardMaterial({ color: '#0000ff' }),
    new THREE.MeshStandardMaterial({ color: '#ffff00' }),
  ]),
);
const noisySlotBlob = await createThreeMfBlobFromScene({
  scene: noisySlotScene,
  filename: 'noisy-bambu-slot-surface',
  colorCount: 4,
});
const noisySlotZipReader = new ZipReader(new BlobReader(noisySlotBlob));
const noisySlotEntries = await noisySlotZipReader.getEntries();
const noisySlotModelXml = await getMeshModelXml(noisySlotEntries);
const noisySlotStats = getMaterialRegionStats(noisySlotModelXml);
assert.equal(noisySlotStats.materialTransitionEdges, 0);
assert.equal(noisySlotStats.componentCount, 1);
assert.equal(noisySlotStats.smallComponentCount, 0);
const noisySlotSettings = JSON.parse(
  await getZipText(noisySlotEntries, 'Metadata/project_settings.config'),
);
assert.deepEqual(noisySlotSettings.filament_colour, ['#5B7F22']);
await noisySlotZipReader.close();

const semanticMapScene = new THREE.Scene();
const semanticMapGeometry = new THREE.BufferGeometry();
semanticMapGeometry.setAttribute(
  'position',
  new THREE.Float32BufferAttribute(
    [
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      2, 0, 0, 3, 0, 0, 2, 1, 0,
      4, 0, 0, 5, 0, 0, 4, 1, 0,
      6, 0, 0, 7, 0, 0, 6, 1, 0,
    ],
    3,
  ),
);
semanticMapGeometry.setIndex([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
semanticMapScene.add(
  new THREE.Mesh(
    semanticMapGeometry,
    new THREE.MeshStandardMaterial({ color: '#808080' }),
  ),
);
const semanticMapBlob = await createThreeMfBlobFromScene({
  scene: semanticMapScene,
  filename: 'semantic-map',
  colorCount: 4,
  semanticMaterialMap: {
    classes: [
      { id: 0, name: 'silver', color: '#B8B8B8' },
      { id: 1, name: 'green enamel', color: '#A9C83A' },
    ],
    triangleMaterialIds: [1, 0, 1, 0],
  },
});
const semanticMapZipReader = new ZipReader(new BlobReader(semanticMapBlob));
const semanticMapEntries = await semanticMapZipReader.getEntries();
const semanticMapModelXml = await getMeshModelXml(semanticMapEntries);
const semanticMaterialIndexes = [
  ...semanticMapModelXml.matchAll(/\bp1="(\d+)"/g),
].map((match) => Number(match[1]));
assert.deepEqual(semanticMaterialIndexes, [1, 0, 1, 0]);
const semanticMapSettings = JSON.parse(
  await getZipText(semanticMapEntries, 'Metadata/project_settings.config'),
);
assert.deepEqual(semanticMapSettings.filament_colour, ['#B8B8B8', '#A9C83A']);
await semanticMapZipReader.close();

const embeddedSemanticScene = new THREE.Scene();
const embeddedSemanticGeometry = semanticMapGeometry.clone();
embeddedSemanticGeometry.userData.semanticMaterialIds = [1, 0, 1, 0];
embeddedSemanticScene.add(
  new THREE.Mesh(
    embeddedSemanticGeometry,
    new THREE.MeshStandardMaterial({ color: '#808080' }),
  ),
);
const embeddedSemanticBlob = await createThreeMfBlobFromScene({
  scene: embeddedSemanticScene,
  filename: 'embedded-semantic-map',
  colorCount: 4,
  semanticMaterialMap: {
    classes: [
      { id: 0, name: 'silver', color: '#B8B8B8' },
      { id: 1, name: 'green enamel', color: '#A9C83A' },
    ],
  },
});
const embeddedSemanticZipReader = new ZipReader(
  new BlobReader(embeddedSemanticBlob),
);
const embeddedSemanticModelXml = await getMeshModelXml(
  await embeddedSemanticZipReader.getEntries(),
);
const embeddedSemanticIndexes = [
  ...embeddedSemanticModelXml.matchAll(/\bp1="(\d+)"/g),
].map((match) => Number(match[1]));
assert.deepEqual(embeddedSemanticIndexes, [1, 0, 1, 0]);
await embeddedSemanticZipReader.close();

const targetPaletteScene = new THREE.Scene();
[
  '#F2F2EE',
  '#E8E9E5',
  '#C7CF3D',
  '#728A18',
  '#070707',
  '#FEDB12',
].forEach((color, index) => {
  const targetPaletteGeometry = new THREE.BufferGeometry();
  const x = index * 2;
  targetPaletteGeometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([x, 0, 0, x + 1, 0, 0, x, 1, 0], 3),
  );
  targetPaletteScene.add(
    new THREE.Mesh(
      targetPaletteGeometry,
      new THREE.MeshStandardMaterial({ color }),
    ),
  );
});
const targetPaletteBlob = await createThreeMfBlobFromScene({
  scene: targetPaletteScene,
  filename: 'target-material-palette',
  colorCount: 4,
  targetMaterialPalette: ['#D8D8D2', '#111111', '#6E8E18', '#FFD600'],
});
const targetPaletteZipReader = new ZipReader(
  new BlobReader(targetPaletteBlob),
);
const targetPaletteEntries = await targetPaletteZipReader.getEntries();
const targetPaletteModelXml = await getMeshModelXml(targetPaletteEntries);
const targetPaletteSettings = JSON.parse(
  await getZipText(targetPaletteEntries, 'Metadata/project_settings.config'),
);
assert.deepEqual(targetPaletteSettings.filament_colour, [
  '#D8D8D2',
  '#111111',
  '#6E8E18',
  '#FFD600',
]);
const targetPaletteIndexes = [
  ...targetPaletteModelXml.matchAll(/\bp1="(\d+)"/g),
].map((match) => Number(match[1]));
assert.deepEqual(targetPaletteIndexes, [0, 0, 3, 2, 1, 3]);
await targetPaletteZipReader.close();

const cubeScene = new THREE.Scene();
cubeScene.add(
  new THREE.Mesh(
    new THREE.BoxGeometry(10, 10, 10),
    new THREE.MeshStandardMaterial({ color: '#0000ff' }),
  ),
);

const cubeBlob = await createThreeMfBlobFromScene({
  scene: cubeScene,
  filename: 'closed-cube',
  colorCount: 1,
});
const cubeZipReader = new ZipReader(new BlobReader(cubeBlob));
const cubeModelXml = await getMeshModelXml(await cubeZipReader.getEntries());
assert.equal(cubeModelXml.match(/<vertex /g)?.length, 8);
assert.equal(cubeModelXml.match(/<triangle /g)?.length, 12);

const edgeCounts = new Map();
for (const match of cubeModelXml.matchAll(
  /<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g,
)) {
  const [, v1, v2, v3] = match.map(Number);
  for (const [a, b] of [
    [v1, v2],
    [v2, v3],
    [v3, v1],
  ]) {
    const key = [a, b].sort((left, right) => left - right).join('-');
    edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
  }
}
assert.equal(
  [...edgeCounts.values()].every((count) => count === 2),
  true,
);
const cubeTopology = analyzeThreeMfMeshTopology(cubeModelXml);
assert.deepEqual(cubeTopology.edgeUseHistogram, { 2: 18 });
assert.equal(cubeTopology.boundaryEdges, 0);
assert.equal(cubeTopology.overSharedEdges, 0);
assert.equal(cubeTopology.degenerateTriangleCount, 0);
await cubeZipReader.close();

const closeVertexTopologyXml = buildThreeMfModelXml({
  modelName: 'close-vertex-topology',
  vertices: [
    [0, 0, 0],
    [10, 0, 0],
    [0, 10, 0],
    [0.05, 0, 0],
    [10, 10, 0],
  ],
  triangles: [
    { v1: 0, v2: 1, v3: 2, colorIndex: 0 },
    { v1: 3, v2: 1, v3: 4, colorIndex: 1 },
  ],
  palette: ['#FF0000', '#00FF00'],
});
const rawCloseVertexTopology = analyzeThreeMfMeshTopology(
  closeVertexTopologyXml,
);
assert.equal(rawCloseVertexTopology.degenerateTriangleCount, 0);
const weldedCloseVertexTopology = analyzeThreeMfMeshTopology(
  closeVertexTopologyXml,
  { weldTolerance: 0.09 },
);
assert.equal(weldedCloseVertexTopology.weldedVertexCount, 4);
assert.equal(weldedCloseVertexTopology.degenerateTriangleCount, 0);
assert.equal(weldedCloseVertexTopology.boundaryEdges, 4);

const nonManifoldScene = new THREE.Scene();
const nonManifoldGeometry = new THREE.BufferGeometry();
nonManifoldGeometry.setAttribute(
  'position',
  new THREE.Float32BufferAttribute(
    [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10, 10, 10, 0],
    3,
  ),
);
nonManifoldGeometry.setIndex([0, 1, 2, 1, 0, 3, 0, 1, 4]);
nonManifoldGeometry.clearGroups();
nonManifoldGeometry.addGroup(0, 3, 0);
nonManifoldGeometry.addGroup(3, 3, 1);
nonManifoldGeometry.addGroup(6, 3, 2);
nonManifoldScene.add(
  new THREE.Mesh(nonManifoldGeometry, [
    new THREE.MeshStandardMaterial({ color: '#ff0000' }),
    new THREE.MeshStandardMaterial({ color: '#00ff00' }),
    new THREE.MeshStandardMaterial({ color: '#0000ff' }),
  ]),
);

const repairedThreeMfBlob = await createThreeMfBlobFromScene({
  scene: nonManifoldScene,
  filename: 'repaired-color-model',
  colorCount: 3,
});
const repairedZipReader = new ZipReader(new BlobReader(repairedThreeMfBlob));
const repairedEntries = await repairedZipReader.getEntries();
const repairedModelXml = await getMeshModelXml(repairedEntries);
assert.equal(repairedModelXml.match(/<triangle /g)?.length, 2);
assert.match(repairedModelXml, /<m:color color="#FF0000FF"\/>/);
assert.match(repairedModelXml, /<m:color color="#00FF00FF"\/>/);
assert.doesNotMatch(repairedModelXml, /<m:color color="#0000FFFF"\/>/);
assert.match(
  repairedModelXml,
  /<triangle v1="0" v2="1" v3="2" pid="1" p1="0" p2="0" p3="0" paint_color="4"\/>/,
);
assert.match(
  repairedModelXml,
  /<triangle v1="1" v2="0" v3="3" pid="1" p1="1" p2="1" p3="1" paint_color="8"\/>/,
);
const repairedSettingsEntry = repairedEntries.find(
  (entry) => entry.filename === 'Metadata/project_settings.config',
);
assert.ok(repairedSettingsEntry);
const repairedSettings = JSON.parse(
  await repairedSettingsEntry.getData(new TextWriter()),
);
assert.deepEqual(repairedSettings.filament_colour, ['#FF0000', '#00FF00']);
await repairedZipReader.close();

const degenerateRepairScene = new THREE.Scene();
const degenerateRepairGeometry = new THREE.BufferGeometry();
degenerateRepairGeometry.setAttribute(
  'position',
  new THREE.Float32BufferAttribute([0, 0, 0, 10, 0, 0, 0, 10, 0, 20, 0, 0], 3),
);
degenerateRepairGeometry.setIndex([0, 1, 2, 0, 1, 3]);
degenerateRepairGeometry.clearGroups();
degenerateRepairGeometry.addGroup(0, 3, 0);
degenerateRepairGeometry.addGroup(3, 3, 1);
degenerateRepairScene.add(
  new THREE.Mesh(degenerateRepairGeometry, [
    new THREE.MeshStandardMaterial({ color: '#ff0000' }),
    new THREE.MeshStandardMaterial({ color: '#0000ff' }),
  ]),
);

const degenerateRepairBlob = await createThreeMfBlobFromScene({
  scene: degenerateRepairScene,
  filename: 'degenerate-repair-color-model',
  colorCount: 2,
});
const degenerateRepairZipReader = new ZipReader(
  new BlobReader(degenerateRepairBlob),
);
const degenerateRepairEntries = await degenerateRepairZipReader.getEntries();
const degenerateRepairModelXml = await getMeshModelXml(degenerateRepairEntries);
assert.equal(degenerateRepairModelXml.match(/<triangle /g)?.length, 1);
assert.match(degenerateRepairModelXml, /<m:color color="#FF0000FF"\/>/);
assert.doesNotMatch(degenerateRepairModelXml, /<m:color color="#0000FFFF"\/>/);
const degenerateRepairSettingsEntry = degenerateRepairEntries.find(
  (entry) => entry.filename === 'Metadata/project_settings.config',
);
assert.ok(degenerateRepairSettingsEntry);
const degenerateRepairSettings = JSON.parse(
  await degenerateRepairSettingsEntry.getData(new TextWriter()),
);
assert.deepEqual(degenerateRepairSettings.filament_colour, ['#FF0000']);
await degenerateRepairZipReader.close();

// Coincident-triangle dedup: two triangles sharing the same three vertices
// form a zero-volume sandwich (the typical "internal wall" pattern from CSG
// unions). Cancelling the pair removes the non-manifold edges Bambu Studio
// reports, and a third coincident triangle leaves an odd-parity survivor.
const coincidentTriangleScene = new THREE.Scene();
const coincidentTriangleGeometry = new THREE.BufferGeometry();
coincidentTriangleGeometry.setAttribute(
  'position',
  new THREE.Float32BufferAttribute([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10], 3),
);
// Tetra base triangle [0,1,2] appears twice (cancelling pair); the other
// three faces of the tetrahedron exist once each and must remain.
coincidentTriangleGeometry.setIndex([
  0, 1, 2, 0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3,
]);
coincidentTriangleScene.add(
  new THREE.Mesh(
    coincidentTriangleGeometry,
    new THREE.MeshStandardMaterial({ color: '#00ff00' }),
  ),
);

const coincidentTriangleBlob = await createThreeMfBlobFromScene({
  scene: coincidentTriangleScene,
  filename: 'coincident-triangles',
  colorCount: 1,
});
const coincidentTriangleZipReader = new ZipReader(
  new BlobReader(coincidentTriangleBlob),
);
const coincidentTriangleModelXml = await getMeshModelXml(
  await coincidentTriangleZipReader.getEntries(),
);
assert.equal(coincidentTriangleModelXml.match(/<triangle /g)?.length, 3);
await coincidentTriangleZipReader.close();

const recolorAfterRepairScene = new THREE.Scene();
const recolorAfterRepairGeometry = new THREE.BufferGeometry();
recolorAfterRepairGeometry.setAttribute(
  'position',
  new THREE.Float32BufferAttribute([0, 0, 0, 10, 0, 0, 0, 10, 0], 3),
);
recolorAfterRepairGeometry.setIndex([0, 1, 2, 0, 2, 1, 0, 1, 2]);
recolorAfterRepairGeometry.clearGroups();
recolorAfterRepairGeometry.addGroup(0, 3, 0);
recolorAfterRepairGeometry.addGroup(3, 3, 1);
recolorAfterRepairGeometry.addGroup(6, 3, 1);
recolorAfterRepairScene.add(
  new THREE.Mesh(recolorAfterRepairGeometry, [
    new THREE.MeshStandardMaterial({ color: '#ff0000' }),
    new THREE.MeshStandardMaterial({ color: '#00ff00' }),
  ]),
);

const recolorAfterRepairBlob = await createThreeMfBlobFromScene({
  scene: recolorAfterRepairScene,
  filename: 'recolor-after-repair',
  colorCount: 2,
});
const recolorAfterRepairZipReader = new ZipReader(
  new BlobReader(recolorAfterRepairBlob),
);
const recolorAfterRepairEntries =
  await recolorAfterRepairZipReader.getEntries();
const recolorAfterRepairModelXml = await getMeshModelXml(
  recolorAfterRepairEntries,
);
assert.equal(recolorAfterRepairModelXml.match(/<triangle /g)?.length, 1);
assert.match(recolorAfterRepairModelXml, /<m:color color="#00FF00FF"\/>/);
assert.doesNotMatch(
  recolorAfterRepairModelXml,
  /<m:color color="#FF0000FF"\/>/,
);
const recolorAfterRepairSettingsEntry = recolorAfterRepairEntries.find(
  (entry) => entry.filename === 'Metadata/project_settings.config',
);
assert.ok(recolorAfterRepairSettingsEntry);
const recolorAfterRepairSettings = JSON.parse(
  await recolorAfterRepairSettingsEntry.getData(new TextWriter()),
);
assert.deepEqual(recolorAfterRepairSettings.filament_colour, ['#00FF00']);
await recolorAfterRepairZipReader.close();

const invalidModelXml = buildThreeMfModelXml({
  modelName: 'invalid-color-index',
  vertices: [
    [0, 0, 0],
    [10, 0, 0],
    [0, 10, 0],
  ],
  triangles: [{ v1: 0, v2: 1, v3: 2, colorIndex: 0 }],
  palette: ['#FF0000'],
}).replace('p1="0" p2="0" p3="0"', 'p1="1" p2="0" p3="0"');

const invalidZipWriter = new ZipWriter(new BlobWriter('model/3mf'));
await invalidZipWriter.add(
  '[Content_Types].xml',
  new TextReader(buildThreeMfContentTypesXml()),
);
await invalidZipWriter.add(
  '_rels/.rels',
  new TextReader(buildThreeMfRelationshipsXml()),
);
await invalidZipWriter.add('3D/3dmodel.model', new TextReader(invalidModelXml));
await invalidZipWriter.add(
  'Metadata/project_settings.config',
  new TextReader(buildThreeMfProjectSettingsConfig(['#FF0000'])),
);
const invalidThreeMfBlob = await invalidZipWriter.close();
await assert.rejects(
  () => validateThreeMfBlob(invalidThreeMfBlob),
  /3MF triangle material index 1 exceeds 1 available materials/,
);
