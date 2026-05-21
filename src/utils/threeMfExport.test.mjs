import assert from 'node:assert/strict';
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';
import * as THREE from 'three';
import {
  buildThreeMfContentTypesXml,
  buildThreeMfModelXml,
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
assert.match(modelXml, /<m:multiproperties id="3" pids="1 2">/);
assert.match(modelXml, /<m:multi pindices="1 1"\/>/);
assert.match(
  modelXml,
  /<triangle v1="0" v2="1" v3="2" pid="3" p1="1" p2="1" p3="1"\/>/,
);
assert.match(modelXml, /<item objectid="4"\/>/);

const contentTypesXml = buildThreeMfContentTypesXml();
assert.match(
  contentTypesXml,
  /ContentType="application\/vnd\.ms-package\.3dmanufacturing-3dmodel\+xml"/,
);
assert.match(contentTypesXml, /Extension="rels"/);

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
await zipReader.close();
