import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
  geometryToTriangleMesh,
  triangleMeshToFacetedSTEP,
  triangleMeshToOBJ,
} from './cadMeshExport.ts';

const geometry = new THREE.BufferGeometry();
geometry.setAttribute(
  'position',
  new THREE.Float32BufferAttribute(
    [
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      0, 0, 0, 0, 1, 0, 0, 0, 1,
      0, 0, 0, 0, 0, 1, 1, 0, 0,
      1, 0, 0, 0, 0, 1, 0, 1, 0,
    ],
    3,
  ),
);

const mesh = geometryToTriangleMesh(geometry);

assert.equal(mesh.vertices.length, 4);
assert.equal(mesh.faces.length, 4);

const obj = triangleMeshToOBJ(mesh, 'tetra export');
assert.match(obj, /^o tetra_export/m);
assert.equal(obj.match(/^v /gm)?.length, 4);
assert.equal(obj.match(/^f /gm)?.length, 4);
assert.doesNotMatch(obj, /NaN|Infinity/);

const step = triangleMeshToFacetedSTEP(mesh, 'tetra export');
assert.match(step, /^ISO-10303-21;/);
assert.match(step, /FILE_SCHEMA\(\('AUTOMOTIVE_DESIGN_CC2'\)\)/);
assert.match(step, /MANIFOLD_SOLID_BREP\('tetra export'/);
assert.match(step, /ADVANCED_BREP_SHAPE_REPRESENTATION/);
assert.equal(step.match(/ADVANCED_FACE/g)?.length, 4);
assert.doesNotMatch(step, /NaN|Infinity/);

geometry.dispose();
