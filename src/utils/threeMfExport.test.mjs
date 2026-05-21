import assert from 'node:assert/strict';
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';
import * as THREE from 'three';
import {
  buildThreeMfContentTypesXml,
  buildThreeMfModelXml,
  buildThreeMfProjectSettingsConfig,
  buildThreeMfRelationshipsXml,
  clampThreeMfColorCount,
  createThreeMfBlobFromScene,
} from './threeMfExport.ts';

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
  /<triangle v1="0" v2="1" v3="2" pid="2" p1="1" p2="1" p3="1" paint_color="8"\/>/,
);
assert.match(modelXml, /<item objectid="4"\/>/);

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
assert.deepEqual(projectSettings.filament_type, ['PLA', 'PLA']);
assert.deepEqual(projectSettings.filament_settings_id, [
  'Generic PLA',
  'Generic PLA',
]);

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
  'Metadata/project_settings.config',
  '[Content_Types].xml',
  '_rels/.rels',
]);

const modelEntry = entries.find(
  (entry) => entry.filename === '3D/3dmodel.model',
);
assert.ok(modelEntry);
const packagedModelXml = await modelEntry.getData(new TextWriter());
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
await zipReader.close();

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
const squareModelEntry = (await squareZipReader.getEntries()).find(
  (entry) => entry.filename === '3D/3dmodel.model',
);
assert.ok(squareModelEntry);
const squareModelXml = await squareModelEntry.getData(new TextWriter());
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
const cubeModelEntry = (await cubeZipReader.getEntries()).find(
  (entry) => entry.filename === '3D/3dmodel.model',
);
assert.ok(cubeModelEntry);
const cubeModelXml = await cubeModelEntry.getData(new TextWriter());
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
await cubeZipReader.close();
