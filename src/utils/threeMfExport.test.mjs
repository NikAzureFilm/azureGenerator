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
  createThreeMfBlobFromColoredMesh,
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
      triangleIndexes.map(
        (triangleIndex) => triangles[triangleIndex].colorIndex,
      ),
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
  for (
    let triangleIndex = 0;
    triangleIndex < triangles.length;
    triangleIndex += 1
  ) {
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

function getModelBounds(modelXml) {
  const bounds = {
    min: [
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    ],
    max: [
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ],
  };

  for (const match of modelXml.matchAll(/<vertex\b([^>]*)\/>/g)) {
    const attributes = Object.fromEntries(
      [...match[1].matchAll(/(\w+)="([^"]*)"/g)].map((attributeMatch) => [
        attributeMatch[1],
        attributeMatch[2],
      ]),
    );
    [Number(attributes.x), Number(attributes.y), Number(attributes.z)].forEach(
      (value, index) => {
        bounds.min[index] = Math.min(bounds.min[index], value);
        bounds.max[index] = Math.max(bounds.max[index], value);
      },
    );
  }

  return bounds;
}

function getMaterialColors(modelXml) {
  return [
    ...modelXml.matchAll(/\bdisplaycolor="(#[0-9A-Fa-f]{6})[0-9A-Fa-f]{2}"/g),
  ].map((match) => match[1].toUpperCase());
}

function getTriangleMaterialColors(modelXml) {
  const materialColors = getMaterialColors(modelXml);
  return [...modelXml.matchAll(/<triangle\b([^>]*)\/>/g)].map((match) => {
    const attributes = Object.fromEntries(
      [...match[1].matchAll(/(\w+)="([^"]*)"/g)].map((attributeMatch) => [
        attributeMatch[1],
        attributeMatch[2],
      ]),
    );
    return materialColors[Number(attributes.p1 ?? 0)];
  });
}

function countSameDirectionSharedEdges(modelXml) {
  const edgeUses = new Map();
  for (const [triangleIndex, match] of [
    ...modelXml.matchAll(/<triangle\b([^>]*)\/>/g),
  ].entries()) {
    const attributes = Object.fromEntries(
      [...match[1].matchAll(/(\w+)="([^"]*)"/g)].map((attributeMatch) => [
        attributeMatch[1],
        attributeMatch[2],
      ]),
    );
    const vertices = [
      Number(attributes.v1),
      Number(attributes.v2),
      Number(attributes.v3),
    ];
    for (const [a, b] of [
      [vertices[0], vertices[1]],
      [vertices[1], vertices[2]],
      [vertices[2], vertices[0]],
    ]) {
      const key = [a, b].sort((left, right) => left - right).join('-');
      const uses = edgeUses.get(key) ?? [];
      uses.push({ triangleIndex, a, b });
      edgeUses.set(key, uses);
    }
  }

  return [...edgeUses.values()].filter(
    (uses) =>
      uses.length === 2 &&
      !(uses[0].a === uses[1].b && uses[0].b === uses[1].a),
  ).length;
}

function installFakeCanvasDocument() {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement(tagName) {
      assert.equal(tagName, 'canvas');
      let image = null;
      return {
        width: 0,
        height: 0,
        getContext(type) {
          assert.equal(type, '2d');
          return {
            drawImage(sourceImage) {
              image = sourceImage;
            },
            getImageData() {
              assert.ok(image?.data, 'fake texture image has pixel data');
              return {
                data: image.data,
              };
            },
          };
        },
      };
    },
  };

  return () => {
    if (previousDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previousDocument;
    }
  };
}

function createDataTexture(width, height, getPixelColor) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a = 255] = getPixelColor(x, y);
      const offset = (y * width + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = a;
    }
  }

  return new THREE.Texture({
    width,
    height,
    data,
  });
}

function assertBambuPrintableTopology(modelXml, message) {
  const topology = analyzeThreeMfMeshTopology(modelXml);
  assert.equal(
    topology.invalidVertexReferenceCount,
    0,
    `${message}: invalid vertex references`,
  );
  assert.equal(
    topology.degenerateTriangleCount,
    0,
    `${message}: degenerate triangles`,
  );
  assert.equal(topology.boundaryEdges, 0, `${message}: boundary edges`);
  assert.equal(topology.overSharedEdges, 0, `${message}: over-shared edges`);
  assert.equal(
    countSameDirectionSharedEdges(modelXml),
    0,
    `${message}: same-direction shared edges`,
  );
  return topology;
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
assert.deepEqual(projectSettings.default_filament_colour, ['', '']);
assert.deepEqual(projectSettings.filament_type, ['PLA', 'PLA']);
assert.deepEqual(projectSettings.filament_settings_id, [
  'Bambu PLA Basic @BBL P1P',
  'Bambu PLA Basic @BBL P1P',
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
assert.equal(projectSettings.printer_model, 'Bambu Lab P1P');
assert.equal(projectSettings.printer_settings_id, 'Bambu Lab P1P 0.4 nozzle');
assert.deepEqual(projectSettings.filament_vendor, ['Bambu Lab', 'Bambu Lab']);
assert.deepEqual(projectSettings.filament_diameter, ['1.75', '1.75']);
assert.deepEqual(projectSettings.nozzle_temperature, ['220', '220']);
assert.deepEqual(projectSettings.nozzle_temperature_initial_layer, [
  '220',
  '220',
]);
assert.deepEqual(projectSettings.nozzle_diameter, ['0.4']);
assert.deepEqual(projectSettings.flush_volumes_matrix, [
  '0',
  '140',
  '140',
  '0',
]);
assert.deepEqual(projectSettings.flush_volumes_vector, [
  '140',
  '140',
  '140',
  '140',
]);
// Real Bambu values (not empty strings) so Studio stops offering to "replace"
// them on load.
assert.equal(projectSettings.gcode_flavor, 'marlin');
assert.equal(projectSettings.gcode_add_line_number, '0');
assert.equal(projectSettings.version, '01.08.02.56');
// The override lists are [process, one per filament, printer]; the template
// ships 5 entries for 3 filaments, so they must resize to the real slot count
// (here 2 filaments -> 4 entries). Classic keeps every entry empty.
assert.deepEqual(projectSettings.different_settings_to_system, ['', '', '', '']);
assert.deepEqual(projectSettings.inherits_group, ['', '', '', '']);

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
  colorDetail: 50,
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
assert.match(
  rootModelXml,
  /<metadata name="Application">BambuStudio-01\.08\.02\.56<\/metadata>/,
);
assert.doesNotMatch(
  rootModelXml,
  /<metadata name="Application">AzureFilm Generator<\/metadata>/,
);
assert.match(
  rootModelXml,
  /<metadata name="BambuStudio:3mfVersion">1<\/metadata>/,
);
assert.match(rootModelXml, /<metadata name="Title">red-part<\/metadata>/);
assert.match(
  rootModelXml,
  /<metadata name="Designer">AzureFilm Generator<\/metadata>/,
);
assert.match(
  rootModelXml,
  /<component p:path="\/3D\/Objects\/Object_1_1\.model" objectid="1"/,
);
assert.match(rootModelXml, /<item objectid="2"[^>]+printable="1"\/>/);
assert.match(
  rootModelXml,
  /<item objectid="2"[^>]+transform="1 0 0 0 1 0 0 0 1 125 125 0"[^>]+printable="1"\/>/,
);
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
assert.deepEqual(packagedSettings.default_filament_colour, ['']);
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
  colorDetail: 50,
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
  colorDetail: 50,
});
const squareZipReader = new ZipReader(new BlobReader(squareBlob));
const squareModelXml = await getMeshModelXml(
  await squareZipReader.getEntries(),
);
assert.equal(squareModelXml.match(/<vertex /g)?.length, 4);
assert.equal(squareModelXml.match(/<triangle /g)?.length, 2);
const squareModelBounds = getModelBounds(squareModelXml);
assert.deepEqual(squareModelBounds.min, [0, 0, 0]);
assert.deepEqual(squareModelBounds.max, [10, 0, 10]);
assert.match(
  squareModelXml,
  /<triangle v1="0" v2="1" v3="2"[^>]+paint_color="4"\/>/,
);
assert.match(
  squareModelXml,
  /<triangle v1="0" v2="2" v3="3"[^>]+paint_color="4"\/>/,
);
assert.deepEqual(getTriangleMaterialColors(squareModelXml), [
  '#00FF00',
  '#00FF00',
]);
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
  colorDetail: 50,
});
const splitSquareZipReader = new ZipReader(new BlobReader(splitSquareBlob));
const splitSquareModelXml = await getMeshModelXml(
  await splitSquareZipReader.getEntries(),
);
assert.equal(splitSquareModelXml.match(/<vertex /g)?.length, 4);
assert.equal(splitSquareModelXml.match(/<triangle /g)?.length, 2);
assert.deepEqual(getTriangleMaterialColors(splitSquareModelXml), [
  '#00FF00',
  '#00FF00',
]);
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
  colorDetail: 50,
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
  colorDetail: 50,
});
const noisySlotZipReader = new ZipReader(new BlobReader(noisySlotBlob));
const noisySlotEntries = await noisySlotZipReader.getEntries();
const noisySlotModelXml = await getMeshModelXml(noisySlotEntries);
const noisySlotStats = getMaterialRegionStats(noisySlotModelXml);
assert.equal(noisySlotStats.materialTransitionEdges, 33);
assert.equal(noisySlotStats.componentCount, 13);
assert.equal(noisySlotStats.smallComponentCount, 12);
assert.deepEqual(
  new Set(getTriangleMaterialColors(noisySlotModelXml)),
  new Set(['#5B7F22', '#FF0000', '#0000FF', '#FFFF00']),
);
const noisySlotSettings = JSON.parse(
  await getZipText(noisySlotEntries, 'Metadata/project_settings.config'),
);
assert.deepEqual(
  new Set(noisySlotSettings.filament_colour),
  new Set(['#5B7F22', '#FF0000', '#0000FF', '#FFFF00']),
);
await noisySlotZipReader.close();

const faceColorPreservationScene = new THREE.Scene();
const faceColorPreservationGeometry = new THREE.BufferGeometry();
const faceColorPreservationPositions = [];
const faceColorPreservationIndexes = [];
const faceColorPreservationGroups = [];
const faceColorGridSize = 8;
const faceColorCells = new Map([
  ['1,1', 1],
  ['4,2', 2],
  ['6,6', 3],
]);
for (let y = 0; y <= faceColorGridSize; y += 1) {
  for (let x = 0; x <= faceColorGridSize; x += 1) {
    faceColorPreservationPositions.push(x, y, 0);
  }
}
const faceColorVertexIndex = (x, y) => y * (faceColorGridSize + 1) + x;
for (let y = 0; y < faceColorGridSize; y += 1) {
  for (let x = 0; x < faceColorGridSize; x += 1) {
    const start = faceColorPreservationIndexes.length;
    const materialIndex = faceColorCells.get(`${x},${y}`) ?? 0;
    faceColorPreservationIndexes.push(
      faceColorVertexIndex(x, y),
      faceColorVertexIndex(x + 1, y),
      faceColorVertexIndex(x + 1, y + 1),
      faceColorVertexIndex(x, y),
      faceColorVertexIndex(x + 1, y + 1),
      faceColorVertexIndex(x, y + 1),
    );
    faceColorPreservationGroups.push({
      start,
      count: 6,
      materialIndex,
    });
  }
}
faceColorPreservationGeometry.setAttribute(
  'position',
  new THREE.Float32BufferAttribute(faceColorPreservationPositions, 3),
);
faceColorPreservationGeometry.setIndex(faceColorPreservationIndexes);
faceColorPreservationGeometry.clearGroups();
for (const group of faceColorPreservationGroups) {
  faceColorPreservationGeometry.addGroup(
    group.start,
    group.count,
    group.materialIndex,
  );
}
faceColorPreservationScene.add(
  new THREE.Mesh(faceColorPreservationGeometry, [
    new THREE.MeshStandardMaterial({ color: '#2038ff' }),
    new THREE.MeshStandardMaterial({ color: '#ff2020' }),
    new THREE.MeshStandardMaterial({ color: '#20d850' }),
    new THREE.MeshStandardMaterial({ color: '#ffd200' }),
  ]),
);
const faceColorPreservationBlob = await createThreeMfBlobFromScene({
  scene: faceColorPreservationScene,
  filename: 'face-color-preservation',
  colorCount: 4,
  colorDetail: 50,
});
const faceColorPreservationZipReader = new ZipReader(
  new BlobReader(faceColorPreservationBlob),
);
const faceColorPreservationModelXml = await getMeshModelXml(
  await faceColorPreservationZipReader.getEntries(),
);
const faceColorPreservationTriangleColors = getTriangleMaterialColors(
  faceColorPreservationModelXml,
);
assert.deepEqual(
  new Set(faceColorPreservationTriangleColors),
  new Set(['#2038FF', '#FF2020', '#20D850', '#FFD200']),
);
for (const accentColor of ['#FF2020', '#20D850', '#FFD200']) {
  assert.equal(
    faceColorPreservationTriangleColors.filter((color) => color === accentColor)
      .length,
    2,
  );
}
await faceColorPreservationZipReader.close();

const semanticMapScene = new THREE.Scene();
const semanticMapGeometry = new THREE.BufferGeometry();
semanticMapGeometry.setAttribute(
  'position',
  new THREE.Float32BufferAttribute(
    [
      0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0, 4, 0, 0, 5, 0, 0, 4,
      1, 0, 6, 0, 0, 7, 0, 0, 6, 1, 0,
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
  colorDetail: 50,
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
  colorDetail: 50,
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
['#F2F2EE', '#E8E9E5', '#C7CF3D', '#728A18', '#070707', '#FEDB12'].forEach(
  (color, index) => {
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
  },
);
const targetPaletteBlob = await createThreeMfBlobFromScene({
  scene: targetPaletteScene,
  filename: 'target-material-palette',
  colorCount: 4,
  colorDetail: 50,
  targetMaterialPalette: ['#D8D8D2', '#111111', '#6E8E18', '#FFD600'],
});
const targetPaletteZipReader = new ZipReader(new BlobReader(targetPaletteBlob));
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

const restoreCanvasDocument = installFakeCanvasDocument();
try {
  const texturedTriangleScene = new THREE.Scene();
  const texturedTriangleGeometry = new THREE.BufferGeometry();
  texturedTriangleGeometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0, 10, 0, 0, 0, 10, 0], 3),
  );
  texturedTriangleGeometry.setAttribute(
    'uv',
    new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2),
  );
  const texture = createDataTexture(8, 8, (x, y) =>
    x === 2 && y === 5 ? [255, 0, 0] : [0, 255, 0],
  );
  texturedTriangleScene.add(
    new THREE.Mesh(
      texturedTriangleGeometry,
      new THREE.MeshStandardMaterial({ color: '#ffffff', map: texture }),
    ),
  );

  const texturedTriangleBlob = await createThreeMfBlobFromScene({
    scene: texturedTriangleScene,
    filename: 'textured-triangle-majority',
    colorCount: 2,
  colorDetail: 50,
    targetMaterialPalette: ['#00FF00', '#FF0000'],
  });
  const texturedTriangleZipReader = new ZipReader(
    new BlobReader(texturedTriangleBlob),
  );
  const texturedTriangleSettings = JSON.parse(
    await getZipText(
      await texturedTriangleZipReader.getEntries(),
      'Metadata/project_settings.config',
    ),
  );
  assert.deepEqual(texturedTriangleSettings.filament_colour, ['#00FF00']);
  await texturedTriangleZipReader.close();

  const flipYFalseTextureScene = new THREE.Scene();
  const flipYFalseTextureGeometry = new THREE.BufferGeometry();
  flipYFalseTextureGeometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0, 10, 0, 0, 0, 10, 0], 3),
  );
  flipYFalseTextureGeometry.setAttribute(
    'uv',
    new THREE.Float32BufferAttribute([0.25, 0.25, 0.25, 0.25, 0.25, 0.25], 2),
  );
  const flipYFalseTexture = createDataTexture(2, 2, (x, y) => {
    if (x === 0 && y === 0) return [255, 0, 0];
    if (x === 0 && y === 1) return [0, 255, 0];
    return [0, 0, 0];
  });
  flipYFalseTexture.flipY = false;
  flipYFalseTextureScene.add(
    new THREE.Mesh(
      flipYFalseTextureGeometry,
      new THREE.MeshStandardMaterial({
        color: '#ffffff',
        map: flipYFalseTexture,
      }),
    ),
  );

  const flipYFalseTextureBlob = await createThreeMfBlobFromScene({
    scene: flipYFalseTextureScene,
    filename: 'texture-flipy-false',
    colorCount: 2,
  colorDetail: 50,
    targetMaterialPalette: ['#FF0000', '#00FF00'],
  });
  const flipYFalseTextureZipReader = new ZipReader(
    new BlobReader(flipYFalseTextureBlob),
  );
  const flipYFalseTextureSettings = JSON.parse(
    await getZipText(
      await flipYFalseTextureZipReader.getEntries(),
      'Metadata/project_settings.config',
    ),
  );
  assert.deepEqual(flipYFalseTextureSettings.filament_colour, ['#FF0000']);
  await flipYFalseTextureZipReader.close();

  const textureDetailScene = new THREE.Scene();
  const textureDetailGeometry = new THREE.BufferGeometry();
  textureDetailGeometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0, 100, 0, 0, 0, 100, 0], 3),
  );
  textureDetailGeometry.setAttribute(
    'uv',
    new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2),
  );
  const textureDetailMap = createDataTexture(128, 128, (x, y) =>
    x >= 16 && x < 64 && y >= 16 && y < 64 ? [255, 255, 255] : [0, 255, 0],
  );
  textureDetailMap.flipY = false;
  textureDetailScene.add(
    new THREE.Mesh(
      textureDetailGeometry,
      new THREE.MeshStandardMaterial({
        color: '#ffffff',
        map: textureDetailMap,
      }),
    ),
  );

  const textureDetailBlob = await createThreeMfBlobFromScene({
    scene: textureDetailScene,
    filename: 'texture-detail-subdivision',
    colorCount: 2,
  colorDetail: 50,
    targetMaterialPalette: ['#00FF00', '#FFFFFF'],
  });
  const textureDetailZipReader = new ZipReader(
    new BlobReader(textureDetailBlob),
  );
  const textureDetailEntries = await textureDetailZipReader.getEntries();
  const textureDetailModelXml = await getMeshModelXml(textureDetailEntries);
  const textureDetailSettings = JSON.parse(
    await getZipText(textureDetailEntries, 'Metadata/project_settings.config'),
  );
  assert.deepEqual(textureDetailSettings.filament_colour, [
    '#00FF00',
    '#FFFFFF',
  ]);
  assert.deepEqual(
    new Set(getTriangleMaterialColors(textureDetailModelXml)),
    new Set(['#00FF00', '#FFFFFF']),
  );
  assert.ok(
    textureDetailModelXml.match(/<triangle /g).length > 1,
    'large textured triangles are subdivided before color assignment',
  );
  await textureDetailZipReader.close();

  const closedTextureDetailScene = new THREE.Scene();
  const closedTextureDetailGeometry = new THREE.BufferGeometry();
  closedTextureDetailGeometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [0, 0, 0, 12, 0, 0, 0, 12, 0, 0, 0, 12],
      3,
    ),
  );
  closedTextureDetailGeometry.setAttribute(
    'uv',
    new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 0.01, 0, 0.02], 2),
  );
  closedTextureDetailGeometry.setIndex([
    0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2,
  ]);
  const closedTextureDetailMap = createDataTexture(128, 128, (x) =>
    x < 64 ? [0, 255, 0] : [255, 255, 255],
  );
  closedTextureDetailMap.flipY = false;
  closedTextureDetailScene.add(
    new THREE.Mesh(
      closedTextureDetailGeometry,
      new THREE.MeshStandardMaterial({
        color: '#ffffff',
        map: closedTextureDetailMap,
      }),
    ),
  );

  const closedTextureDetailBlob = await createThreeMfBlobFromScene({
    scene: closedTextureDetailScene,
    filename: 'closed-texture-detail-topology',
    colorCount: 2,
  colorDetail: 50,
    targetMaterialPalette: ['#00FF00', '#FFFFFF'],
  });
  const closedTextureDetailZipReader = new ZipReader(
    new BlobReader(closedTextureDetailBlob),
  );
  const closedTextureDetailModelXml = await getMeshModelXml(
    await closedTextureDetailZipReader.getEntries(),
  );
  const closedTextureDetailTopology = assertBambuPrintableTopology(
    closedTextureDetailModelXml,
    'closed textured subdivision',
  );
  assert.ok(
    closedTextureDetailTopology.triangleCount > 4,
    'closed textured geometry is still subdivided for color detail',
  );
  assert.deepEqual(
    new Set(getTriangleMaterialColors(closedTextureDetailModelXml)),
    new Set(['#00FF00', '#FFFFFF']),
  );
  await closedTextureDetailZipReader.close();
} finally {
  restoreCanvasDocument();
}

const manifoldFilterColorScene = new THREE.Scene();
const manifoldFilterColorGeometry = new THREE.BoxGeometry(10, 12, 14, 12, 12, 12);
manifoldFilterColorScene.add(
  new THREE.Mesh(manifoldFilterColorGeometry, [
    new THREE.MeshStandardMaterial({ color: '#ff0000' }),
    new THREE.MeshStandardMaterial({ color: '#00ff00' }),
    new THREE.MeshStandardMaterial({ color: '#0000ff' }),
    new THREE.MeshStandardMaterial({ color: '#ffffff' }),
    new THREE.MeshStandardMaterial({ color: '#111111' }),
    new THREE.MeshStandardMaterial({ color: '#ffff00' }),
  ]),
);
const manifoldFilterColorBlob = await createThreeMfBlobFromScene({
  scene: manifoldFilterColorScene,
  filename: 'manifold-filter-color-box',
  colorCount: 6,
  colorDetail: 50,
});
const manifoldFilterColorZipReader = new ZipReader(
  new BlobReader(manifoldFilterColorBlob),
);
const manifoldFilterColorModelXml = await getMeshModelXml(
  await manifoldFilterColorZipReader.getEntries(),
);
const manifoldFilterColorTopology = assertBambuPrintableTopology(
  manifoldFilterColorModelXml,
  'manifold filter color box',
);
assert.ok(
  manifoldFilterColorTopology.triangleCount >= 512,
  'large color box exercises the async repair/color transfer path',
);
assert.deepEqual(
  new Set(getTriangleMaterialColors(manifoldFilterColorModelXml)),
  new Set(['#FF0000', '#00FF00', '#0000FF', '#FFFFFF', '#111111', '#FFFF00']),
);
await manifoldFilterColorZipReader.close();

const badgeRecoveryScene = new THREE.Scene();
const badgeRecoveryGeometry = new THREE.BufferGeometry();
badgeRecoveryGeometry.setAttribute(
  'position',
  new THREE.Float32BufferAttribute(
    [
      -0.2, -0.2, 0, 0.2, -0.2, 0, 0, 0.2, 0, -0.2, -0.2, 0.35, 0.2, -0.2, 0.35,
      0, 0.2, 0.35, -0.9, -0.9, 0, -0.7, -0.9, 0, -0.8, -0.7, 0, 0.35, -0.2, 0,
      0.55, -0.2, 0, 0.45, 0, 0, 0.6, -0.2, 0, 0.8, -0.2, 0, 0.7, 0, 0, 0.25, 0,
      0, -0.25, -0.15, 0.35, 0.25, -0.15, 0.35, 0, 0.1, 0.35, -0.22, -0.12,
      -0.35, 0.22, -0.12, -0.35, 0, 0.08, -0.35,
    ],
    3,
  ),
);
badgeRecoveryGeometry.setIndex([
  0, 1, 2, 3, 4, 5, 6, 8, 7, 9, 10, 11, 12, 13, 14, 9, 11, 15, 16, 17, 18, 19,
  20, 21,
]);
badgeRecoveryGeometry.addGroup(0, 3, 0);
badgeRecoveryGeometry.addGroup(3, 3, 0);
badgeRecoveryGeometry.addGroup(6, 3, 0);
badgeRecoveryGeometry.addGroup(9, 3, 1);
badgeRecoveryGeometry.addGroup(12, 3, 2);
badgeRecoveryGeometry.addGroup(15, 3, 0);
badgeRecoveryGeometry.addGroup(18, 3, 2);
badgeRecoveryGeometry.addGroup(21, 3, 2);
badgeRecoveryScene.add(
  new THREE.Mesh(badgeRecoveryGeometry, [
    new THREE.MeshStandardMaterial({ color: '#ECEDEC' }),
    new THREE.MeshStandardMaterial({ color: '#050505' }),
    new THREE.MeshStandardMaterial({ color: '#FEDB12' }),
  ]),
);
const badgeRecoveryBlob = await createThreeMfBlobFromScene({
  scene: badgeRecoveryScene,
  filename: 'badge-semantic-recovery',
  colorCount: 4,
  colorDetail: 50,
  targetMaterialPalette: ['#D8D8D2', '#111111', '#6E8E18', '#FFD600'],
});
const badgeRecoveryZipReader = new ZipReader(new BlobReader(badgeRecoveryBlob));
const badgeRecoveryModelXml = await getMeshModelXml(
  await badgeRecoveryZipReader.getEntries(),
);
const badgeRecoveryIndexes = [
  ...badgeRecoveryModelXml.matchAll(/\bp1="(\d+)"/g),
].map((match) => Number(match[1]));
assert.deepEqual(badgeRecoveryIndexes.slice(0, 8), [2, 0, 0, 1, 3, 0, 0, 0]);
assert.equal(badgeRecoveryIndexes.length, 10);
await badgeRecoveryZipReader.close();

const namedMaterialScene = new THREE.Scene();
[
  'green_enamel_field',
  'light_silver_raised_text',
  'black_ball_panels',
  'yellow_accent_stripe',
].forEach((name, index) => {
  const namedGeometry = new THREE.BufferGeometry();
  const x = index * 2;
  namedGeometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([x, 0, 0, x + 1, 0, 0, x, 1, 0], 3),
  );
  namedMaterialScene.add(
    new THREE.Mesh(
      namedGeometry,
      new THREE.MeshStandardMaterial({ color: '#ECEDEC', name }),
    ),
  );
});
const namedMaterialBlob = await createThreeMfBlobFromScene({
  scene: namedMaterialScene,
  filename: 'named-material-regions',
  colorCount: 4,
  colorDetail: 50,
  targetMaterialPalette: ['#D8D8D2', '#111111', '#6E8E18', '#FFD600'],
});
const namedMaterialZipReader = new ZipReader(new BlobReader(namedMaterialBlob));
const namedMaterialModelXml = await getMeshModelXml(
  await namedMaterialZipReader.getEntries(),
);
const namedMaterialIndexes = [
  ...namedMaterialModelXml.matchAll(/\bp1="(\d+)"/g),
].map((match) => Number(match[1]));
assert.deepEqual(namedMaterialIndexes, [2, 0, 1, 3]);
await namedMaterialZipReader.close();

const adjacentNamedMaterialScene = new THREE.Scene();
const adjacentNamedMaterialGeometry = new THREE.BufferGeometry();
const adjacentNamedMaterialVertices = [];
const adjacentNamedMaterialIndexesSource = [];
for (let x = 0; x <= 6; x += 1) {
  adjacentNamedMaterialVertices.push(x, 0, 0, x, 1, 0);
}
for (let x = 0; x < 5; x += 1) {
  const bottomLeft = x * 2;
  const topLeft = bottomLeft + 1;
  const bottomRight = bottomLeft + 2;
  const topRight = bottomLeft + 3;
  adjacentNamedMaterialIndexesSource.push(
    bottomLeft,
    bottomRight,
    topLeft,
    topLeft,
    bottomRight,
    topRight,
  );
}
const adjacentNamedMaterialGreenIndexCount =
  adjacentNamedMaterialIndexesSource.length;
adjacentNamedMaterialIndexesSource.push(10, 12, 11);
adjacentNamedMaterialGeometry.setAttribute(
  'position',
  new THREE.Float32BufferAttribute(adjacentNamedMaterialVertices, 3),
);
adjacentNamedMaterialGeometry.setIndex(adjacentNamedMaterialIndexesSource);
adjacentNamedMaterialGeometry.addGroup(
  0,
  adjacentNamedMaterialGreenIndexCount,
  0,
);
adjacentNamedMaterialGeometry.addGroup(
  adjacentNamedMaterialGreenIndexCount,
  3,
  1,
);
adjacentNamedMaterialScene.add(
  new THREE.Mesh(adjacentNamedMaterialGeometry, [
    new THREE.MeshStandardMaterial({
      color: '#ECEDEC',
      name: 'green_enamel_field',
    }),
    new THREE.MeshStandardMaterial({
      color: '#ECEDEC',
      name: 'black_ball_panel',
    }),
  ]),
);
const adjacentNamedMaterialBlob = await createThreeMfBlobFromScene({
  scene: adjacentNamedMaterialScene,
  filename: 'adjacent-named-material-regions',
  colorCount: 4,
  colorDetail: 50,
  targetMaterialPalette: ['#D8D8D2', '#111111', '#6E8E18', '#FFD600'],
});
const adjacentNamedMaterialZipReader = new ZipReader(
  new BlobReader(adjacentNamedMaterialBlob),
);
const adjacentNamedMaterialModelXml = await getMeshModelXml(
  await adjacentNamedMaterialZipReader.getEntries(),
);
const adjacentNamedMaterialIndexes = [
  ...adjacentNamedMaterialModelXml.matchAll(/\bp1="(\d+)"/g),
].map((match) => Number(match[1]));
assert.deepEqual(
  adjacentNamedMaterialIndexes,
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],
);
await adjacentNamedMaterialZipReader.close();

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
  colorDetail: 50,
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

const openTetraScene = new THREE.Scene();
const openTetraGeometry = new THREE.BufferGeometry();
openTetraGeometry.setAttribute(
  'position',
  new THREE.Float32BufferAttribute([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10], 3),
);
openTetraGeometry.setIndex([0, 1, 3, 1, 2, 3, 2, 0, 3]);
openTetraScene.add(
  new THREE.Mesh(
    openTetraGeometry,
    new THREE.MeshStandardMaterial({ color: '#00ff00' }),
  ),
);

const openTetraBlob = await createThreeMfBlobFromScene({
  scene: openTetraScene,
  filename: 'sealed-open-tetra',
  colorCount: 1,
  colorDetail: 50,
});
const openTetraZipReader = new ZipReader(new BlobReader(openTetraBlob));
const openTetraModelXml = await getMeshModelXml(
  await openTetraZipReader.getEntries(),
);
const openTetraTopology = assertBambuPrintableTopology(
  openTetraModelXml,
  'sealed open tetra',
);
assert.equal(openTetraTopology.triangleCount, 4);
await openTetraZipReader.close();

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
  colorDetail: 50,
});
const repairedZipReader = new ZipReader(new BlobReader(repairedThreeMfBlob));
const repairedEntries = await repairedZipReader.getEntries();
const repairedModelXml = await getMeshModelXml(repairedEntries);
const repairedTopology = assertBambuPrintableTopology(
  repairedModelXml,
  'repaired color model',
);
assert.equal(repairedTopology.triangleCount, 4);
assert.match(repairedModelXml, /<m:color color="#FF0000FF"\/>/);
assert.match(repairedModelXml, /<m:color color="#00FF00FF"\/>/);
assert.doesNotMatch(repairedModelXml, /<m:color color="#0000FFFF"\/>/);
const repairedSettingsEntry = repairedEntries.find(
  (entry) => entry.filename === 'Metadata/project_settings.config',
);
assert.ok(repairedSettingsEntry);
const repairedSettings = JSON.parse(
  await repairedSettingsEntry.getData(new TextWriter()),
);
assert.deepEqual(repairedSettings.filament_colour, ['#FF0000', '#00FF00']);
await repairedZipReader.close();

const nearDuplicateEdgeScene = new THREE.Scene();
const nearDuplicateEdgeGeometry = new THREE.BufferGeometry();
nearDuplicateEdgeGeometry.setAttribute(
  'position',
  new THREE.Float32BufferAttribute(
    [
      0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10, 0.004, 0, 0, 10.004, 0, 0, 10, 10,
      0,
    ],
    3,
  ),
);
nearDuplicateEdgeGeometry.setIndex([0, 1, 2, 1, 0, 3, 4, 5, 6]);
nearDuplicateEdgeGeometry.clearGroups();
nearDuplicateEdgeGeometry.addGroup(0, 3, 0);
nearDuplicateEdgeGeometry.addGroup(3, 3, 1);
nearDuplicateEdgeGeometry.addGroup(6, 3, 2);
nearDuplicateEdgeScene.add(
  new THREE.Mesh(nearDuplicateEdgeGeometry, [
    new THREE.MeshStandardMaterial({ color: '#ff0000' }),
    new THREE.MeshStandardMaterial({ color: '#00ff00' }),
    new THREE.MeshStandardMaterial({ color: '#0000ff' }),
  ]),
);

const nearDuplicateEdgeBlob = await createThreeMfBlobFromScene({
  scene: nearDuplicateEdgeScene,
  filename: 'near-duplicate-edge-repair',
  colorCount: 3,
  colorDetail: 50,
});
const nearDuplicateEdgeZipReader = new ZipReader(
  new BlobReader(nearDuplicateEdgeBlob),
);
const nearDuplicateEdgeEntries = await nearDuplicateEdgeZipReader.getEntries();
const nearDuplicateEdgeModelXml = await getMeshModelXml(
  nearDuplicateEdgeEntries,
);
const nearDuplicateEdgeTopology = assertBambuPrintableTopology(
  nearDuplicateEdgeModelXml,
  'near duplicate edge repair',
);
assert.equal(nearDuplicateEdgeTopology.triangleCount, 4);
assert.doesNotMatch(nearDuplicateEdgeModelXml, /<m:color color="#0000FFFF"\/>/);
const nearDuplicateEdgeSettings = JSON.parse(
  await getZipText(
    nearDuplicateEdgeEntries,
    'Metadata/project_settings.config',
  ),
);
assert.deepEqual(nearDuplicateEdgeSettings.filament_colour, [
  '#FF0000',
  '#00FF00',
]);
await nearDuplicateEdgeZipReader.close();

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
  colorDetail: 50,
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
  colorDetail: 50,
});
const coincidentTriangleZipReader = new ZipReader(
  new BlobReader(coincidentTriangleBlob),
);
const coincidentTriangleModelXml = await getMeshModelXml(
  await coincidentTriangleZipReader.getEntries(),
);
const coincidentTriangleTopology = assertBambuPrintableTopology(
  coincidentTriangleModelXml,
  'coincident triangle repair',
);
assert.equal(coincidentTriangleTopology.triangleCount, 4);
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
  colorDetail: 50,
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
})
  .replace(
    '<metadata name="Title">',
    '<metadata name="Application">BambuStudio-01.08.02.56</metadata>\n  <metadata name="Title">',
  )
  .replace('p1="0" p2="0" p3="0"', 'p1="1" p2="0" p3="0"');

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

// Full Spectrum export: the detected palette expands into physical filament
// slots plus a mixed slot per color the physical spools cannot print directly.
const fullSpectrumColoredMesh = {
  vertices: [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [2, 0, 0],
    [3, 0, 0],
    [2, 1, 0],
    [4, 0, 0],
    [5, 0, 0],
    [4, 1, 0],
  ],
  triangles: [
    { v1: 0, v2: 1, v3: 2, colorIndex: 0 },
    { v1: 3, v2: 4, v3: 5, colorIndex: 1 },
    { v1: 6, v2: 7, v3: 8, colorIndex: 2 },
  ],
  palette: ['#00AEEF', '#F58A2E', '#8A8A8A'],
};
const fullSpectrumPlan = {
  presetFilaments: [
    { name: 'Cyan', hex: '#00AEEF' },
    { name: 'Magenta', hex: '#EC008C' },
    { name: 'Yellow', hex: '#FFF200' },
    { name: 'White', hex: '#F2F2F2' },
    { name: 'Black', hex: '#1A1A1A' },
  ],
  recipes: [
    // Exact match to a physical spool: prints directly, no mixed slot.
    { achievedHex: '#00AEEF', layerFilamentIndexes: [0] },
    // Magenta + Yellow, even split.
    { achievedHex: '#F58A2E', layerFilamentIndexes: [1, 2] },
    // Yellow (2 layers) + White (1 layer): uneven ratios.
    { achievedHex: '#8A8A8A', layerFilamentIndexes: [2, 2, 3] },
  ],
};
const fullSpectrumBlob = await createThreeMfBlobFromColoredMesh({
  coloredMesh: fullSpectrumColoredMesh,
  filename: 'full-spectrum-mixed',
  fullSpectrum: fullSpectrumPlan,
});
const fullSpectrumZipReader = new ZipReader(new BlobReader(fullSpectrumBlob));
const fullSpectrumEntries = await fullSpectrumZipReader.getEntries();
const fullSpectrumModelXml = await getMeshModelXml(fullSpectrumEntries);
const fullSpectrumRootXml = await getZipText(
  fullSpectrumEntries,
  '3D/3dmodel.model',
);
const fullSpectrumSettings = JSON.parse(
  await getZipText(fullSpectrumEntries, 'Metadata/project_settings.config'),
);
// Physical slots (5) + a mixed slot per mixing color (2) = 7 slots.
assert.deepEqual(fullSpectrumSettings.filament_colour, [
  '#00AEEF',
  '#EC008C',
  '#FFF200',
  '#F2F2F2',
  '#1A1A1A',
  '#F58A2E',
  '#8A8A8A',
]);
assert.deepEqual(fullSpectrumSettings.filament_is_mixed, [
  '0',
  '0',
  '0',
  '0',
  '0',
  '1',
  '1',
]);
assert.deepEqual(fullSpectrumSettings.filament_mixed_components, [
  '',
  '',
  '',
  '',
  '',
  '2,3',
  '3,4',
]);
for (const components of ['2,3', '3,4']) {
  assert.match(components, /^\d(,\d)+$/);
}
assert.deepEqual(fullSpectrumSettings.filament_mixed_sublayer_ratios, [
  '',
  '',
  '',
  '',
  '',
  '0.50,0.50',
  '0.67,0.33',
]);
for (const ratios of ['0.50,0.50', '0.67,0.33']) {
  const sum = ratios.split(',').reduce((total, part) => total + Number(part), 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `mixed ratios ${ratios} sum to 1.0`);
}
assert.deepEqual(
  fullSpectrumSettings.filament_multi_colour,
  fullSpectrumSettings.filament_colour,
);
assert.deepEqual(fullSpectrumSettings.filament_colour_type, [
  '1',
  '1',
  '1',
  '1',
  '1',
  '1',
  '1',
]);
assert.equal(fullSpectrumSettings.enable_mixed_color_sublayer, '1');
// The sublayer flag only takes effect if it is declared as a process override
// from the system preset. different_settings_to_system is [process, one per
// slot, printer] = 1 + 7 + 1 = 9 entries, with the process diff first.
assert.equal(fullSpectrumSettings.different_settings_to_system.length, 9);
assert.equal(
  fullSpectrumSettings.different_settings_to_system[0],
  'enable_mixed_color_sublayer',
);
assert.deepEqual(
  fullSpectrumSettings.different_settings_to_system.slice(1),
  ['', '', '', '', '', '', '', ''],
);
assert.equal(fullSpectrumSettings.inherits_group.length, 9);
assert.ok(
  fullSpectrumSettings.inherits_group.every((entry) => entry === ''),
  'inherits_group is resized to slot count with empty entries',
);
assert.equal(fullSpectrumSettings.filament_map.length, 7);
// filament_map values MUST be strings: a numeric entry makes Bambu's JSON
// loader reject the array and silently drop every key sorted after it.
assert.deepEqual(fullSpectrumSettings.filament_map, [
  '1',
  '1',
  '1',
  '1',
  '1',
  '1',
  '1',
]);
// Whole-object invariant: every leaf Bambu reads must be a string (or a nested
// array of strings). A single non-string value truncates the config parse.
function assertAllProjectSettingValuesAreStrings(settings, label) {
  const isStringArray = (value) =>
    Array.isArray(value) && value.every((entry) => typeof entry === 'string');
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value === 'string') {
      continue;
    }
    const validArray =
      Array.isArray(value) &&
      value.every(
        (entry) => typeof entry === 'string' || isStringArray(entry),
      );
    assert.ok(
      validArray,
      `${label} ${key} must be a string or string array, got ${JSON.stringify(
        value,
      )}`,
    );
  }
}
assertAllProjectSettingValuesAreStrings(
  fullSpectrumSettings,
  'full-spectrum project settings',
);
assertAllProjectSettingValuesAreStrings(
  projectSettings,
  'classic project settings',
);
assert.equal(fullSpectrumSettings.version, '02.07.00.55');
assert.match(
  fullSpectrumRootXml,
  /<metadata name="Application">BambuStudio-02\.07\.00\.55<\/metadata>/,
);
assert.match(
  await getZipText(fullSpectrumEntries, 'Metadata/slice_info.config'),
  /X-BBL-Client-Version" value="02\.07\.00\.55"/,
);
// Triangles reference their slot: the single-filament color prints on its
// physical slot; the mixed colors print on the new slots (indexes > 5 physical).
const fullSpectrumMaterialIndexes = [
  ...fullSpectrumModelXml.matchAll(/\bp1="(\d+)"/g),
].map((match) => Number(match[1]));
assert.deepEqual(fullSpectrumMaterialIndexes, [0, 5, 6]);
assert.ok(
  fullSpectrumMaterialIndexes.some(
    (index) => index >= fullSpectrumPlan.presetFilaments.length,
  ),
  'mixed colors are packed into slots beyond the physical filaments',
);
await fullSpectrumZipReader.close();

// Sensitivity slider must affect semantic-mapped models: colorDetail 0 merges
// small color islands into their surroundings while colorDetail 100 keeps them,
// so the per-slot triangle distribution differs between the two extremes.
function buildSensitivityGridScene() {
  const grid = 8;
  const positions = [];
  for (let y = 0; y <= grid; y += 1) {
    for (let x = 0; x <= grid; x += 1) {
      positions.push(x, y, 0);
    }
  }
  const vertexIndex = (x, y) => y * (grid + 1) + x;
  const indexes = [];
  const triangleMaterialIds = [];
  for (let y = 0; y < grid; y += 1) {
    for (let x = 0; x < grid; x += 1) {
      indexes.push(
        vertexIndex(x, y),
        vertexIndex(x + 1, y),
        vertexIndex(x + 1, y + 1),
        vertexIndex(x, y),
        vertexIndex(x + 1, y + 1),
        vertexIndex(x, y + 1),
      );
      // Sparse single-triangle islands (colors 1-3) in a field of the base
      // color (0); the island hues sit near the base so island merging fires.
      const islandMaterial =
        (x * 3 + y * 5) % 7 === 0 ? ((x + y) % 3) + 1 : 0;
      triangleMaterialIds.push(islandMaterial, 0);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setIndex(indexes);
  const scene = new THREE.Scene();
  scene.add(
    new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: '#808080' }),
    ),
  );
  return { scene, triangleMaterialIds };
}

const sensitivitySemanticMaterialMap = {
  classes: [
    { id: 0, name: 'base', color: '#808080' },
    { id: 1, name: 'accent-a', color: '#A08080' },
    { id: 2, name: 'accent-b', color: '#80A080' },
    { id: 3, name: 'accent-c', color: '#8080A0' },
  ],
  triangleMaterialIds: buildSensitivityGridScene().triangleMaterialIds,
};

async function getSensitivityColorDistribution(colorDetail) {
  const blob = await createThreeMfBlobFromScene({
    scene: buildSensitivityGridScene().scene,
    filename: `sensitivity-${colorDetail}`,
    colorCount: 4,
  colorDetail: 50,
    colorDetail,
    semanticMaterialMap: sensitivitySemanticMaterialMap,
  });
  const zipReader = new ZipReader(new BlobReader(blob));
  const modelXml = await getMeshModelXml(await zipReader.getEntries());
  const distribution = {};
  for (const match of modelXml.matchAll(/\bp1="(\d+)"/g)) {
    distribution[match[1]] = (distribution[match[1]] ?? 0) + 1;
  }
  await zipReader.close();
  return distribution;
}

const sensitivityRoughDistribution = await getSensitivityColorDistribution(0);
const sensitivityFineDistribution = await getSensitivityColorDistribution(100);
assert.notDeepEqual(
  sensitivityRoughDistribution,
  sensitivityFineDistribution,
  'colorDetail must change the color distribution for semantic-mapped models',
);
// The fine setting keeps more distinct color slots than the rough setting.
assert.ok(
  Object.keys(sensitivityFineDistribution).length >
    Object.keys(sensitivityRoughDistribution).length,
  'higher sensitivity preserves more small color islands',
);

// --- Disconnected-body fusion: two separated solids must export as one piece ---

// Non-indexed closed box (12 triangles) with its min corner at (x0, y0, z0).
function closedBoxPositions(x0, y0, z0, size) {
  const s = size;
  const v = [
    [x0, y0, z0],
    [x0 + s, y0, z0],
    [x0 + s, y0 + s, z0],
    [x0, y0 + s, z0],
    [x0, y0, z0 + s],
    [x0 + s, y0, z0 + s],
    [x0 + s, y0 + s, z0 + s],
    [x0, y0 + s, z0 + s],
  ];
  const quads = [
    [0, 1, 2, 3],
    [5, 4, 7, 6],
    [4, 5, 1, 0],
    [1, 5, 6, 2],
    [2, 6, 7, 3],
    [4, 0, 3, 7],
  ];
  const positions = [];
  for (const [a, b, c, d] of quads) {
    for (const index of [a, b, c, a, c, d]) {
      positions.push(v[index][0], v[index][1], v[index][2]);
    }
  }
  return positions;
}

// Count connected components of a packaged 3MF mesh via union-find over the
// triangle vertex indices (the exporter has already welded coincident vertices,
// so shared indices reflect true adjacency).
function countPackagedMeshComponents(modelXml) {
  const vertexCount = [...modelXml.matchAll(/<vertex\b/g)].length;
  const parent = Array.from({ length: vertexCount }, (_unused, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const used = new Set();
  for (const match of modelXml.matchAll(/<triangle\b([^>]*)\/>/g)) {
    const attributes = Object.fromEntries(
      [...match[1].matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
    );
    const a = Number(attributes.v1);
    const b = Number(attributes.v2);
    const c = Number(attributes.v3);
    used.add(a);
    used.add(b);
    used.add(c);
    union(a, b);
    union(b, c);
  }
  const roots = new Set();
  for (const index of used) roots.add(find(index));
  return roots.size;
}

const twoBodyScene = new THREE.Scene();
twoBodyScene.add(
  new THREE.Mesh(
    new THREE.BufferGeometry().setAttribute(
      'position',
      new THREE.Float32BufferAttribute(closedBoxPositions(0, 0, 0, 10), 3),
    ),
    new THREE.MeshStandardMaterial({ color: '#ff0000' }),
  ),
);
twoBodyScene.add(
  new THREE.Mesh(
    new THREE.BufferGeometry().setAttribute(
      'position',
      new THREE.Float32BufferAttribute(closedBoxPositions(25, 0, 0, 10), 3),
    ),
    new THREE.MeshStandardMaterial({ color: '#0000ff' }),
  ),
);

const twoBodyBlob = await createThreeMfBlobFromScene({
  scene: twoBodyScene,
  filename: 'two-body',
  colorCount: 2,
});
const twoBodyReader = new ZipReader(new BlobReader(twoBodyBlob));
const twoBodyModelXml = await getMeshModelXml(await twoBodyReader.getEntries());
await twoBodyReader.close();

assert.equal(
  countPackagedMeshComponents(twoBodyModelXml),
  1,
  'two separated bodies must export as a single connected 3MF mesh',
);
