import assert from 'node:assert/strict';
import {
  planFlexiToy,
  computeFlexiScale,
  scaleFlexiPositions,
  socketMouthRadius,
} from './flexiToyPlan.ts';
import { buildFlexiToy, loadManifold } from './flexiToyBuild.ts';
import { flexiResultToThreeMfBlob } from './flexiToyExport.ts';
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';

// --- Synthetic fixtures ----------------------------------------------------

function makeSpindle({
  length = 150,
  maxRadius = 14,
  taper = 0.3,
  radialSegments = 32,
  rings = 44,
  axis = 'x',
  offset = [0, 0, 0],
} = {}) {
  const [ox, oy, oz] = offset;
  const positions = [];
  const push = (u, angle) => {
    const r = maxRadius * Math.sin(Math.PI * u) * (1 - taper * u);
    const along = length * u;
    if (axis === 'x')
      positions.push(
        ox + along,
        oy + r * Math.cos(angle),
        oz + r * Math.sin(angle),
      );
    else
      positions.push(
        ox + r * Math.cos(angle),
        oy + along,
        oz + r * Math.sin(angle),
      );
  };
  positions.push(ox, oy, oz);
  const ringStart = 1;
  for (let ri = 0; ri < rings; ri += 1) {
    const u = (ri + 1) / (rings + 1);
    for (let k = 0; k < radialSegments; k += 1) {
      push(u, (k / radialSegments) * Math.PI * 2);
    }
  }
  const head = positions.length / 3;
  if (axis === 'x') positions.push(ox + length, oy, oz);
  else positions.push(ox, oy + length, oz);

  const indices = [];
  const rv = (ri, k) => ringStart + ri * radialSegments + (k % radialSegments);
  for (let k = 0; k < radialSegments; k += 1)
    indices.push(0, rv(0, k + 1), rv(0, k));
  for (let ri = 0; ri < rings - 1; ri += 1) {
    for (let k = 0; k < radialSegments; k += 1) {
      const a = rv(ri, k);
      const b = rv(ri, k + 1);
      const c = rv(ri + 1, k + 1);
      const d = rv(ri + 1, k);
      indices.push(a, b, c, a, c, d);
    }
  }
  for (let k = 0; k < radialSegments; k += 1) {
    indices.push(head, rv(rings - 1, k), rv(rings - 1, k + 1));
  }
  return { positions, indices };
}

function makeUvSphere({ radius = 10, segments = 16, offset = [0, 0, 0] } = {}) {
  const [ox, oy, oz] = offset;
  const positions = [];
  positions.push(ox, oy - radius, oz);
  const ringStart = 1;
  const rings = segments - 1;
  for (let ri = 0; ri < rings; ri += 1) {
    const phi = Math.PI * ((ri + 1) / segments);
    for (let k = 0; k < segments; k += 1) {
      const theta = (k / segments) * Math.PI * 2;
      positions.push(
        ox + radius * Math.sin(phi) * Math.cos(theta),
        oy - radius * Math.cos(phi),
        oz + radius * Math.sin(phi) * Math.sin(theta),
      );
    }
  }
  const top = positions.length / 3;
  positions.push(ox, oy + radius, oz);
  const indices = [];
  const rv = (ri, k) => ringStart + ri * segments + (k % segments);
  for (let k = 0; k < segments; k += 1) indices.push(0, rv(0, k + 1), rv(0, k));
  for (let ri = 0; ri < rings - 1; ri += 1) {
    for (let k = 0; k < segments; k += 1) {
      const a = rv(ri, k);
      const b = rv(ri, k + 1);
      const c = rv(ri + 1, k + 1);
      const d = rv(ri + 1, k);
      indices.push(a, b, c, a, c, d);
    }
  }
  for (let k = 0; k < segments; k += 1) {
    indices.push(top, rv(rings - 1, k), rv(rings - 1, k + 1));
  }
  return { positions, indices };
}

function combine(...meshes) {
  const positions = [];
  const indices = [];
  let vertexOffset = 0;
  for (const mesh of meshes) {
    positions.push(...mesh.positions);
    for (const index of mesh.indices) indices.push(index + vertexOffset);
    vertexOffset += mesh.positions.length / 3;
  }
  return { positions, indices };
}

function toInput({ positions, indices }) {
  const p = new Float32Array(positions);
  const colors = new Float32Array(p.length);
  colors.fill(1);
  return { positions: p, indices: new Uint32Array(indices), colors };
}

function scaleForSettings(input, settings) {
  const scale = computeFlexiScale(input, settings);
  return {
    positions: scaleFlexiPositions(input.positions, scale),
    indices: input.indices,
    colors: input.colors,
  };
}

// --- Topology helpers ------------------------------------------------------

// Count physically disconnected bodies by welding coincident output vertices
// and running union-find over the triangles (mirrors meshTopology's approach).
function countBodies(positions, indices) {
  const tol = 1e-3;
  const weldOf = new Int32Array(positions.length / 3);
  const map = new Map();
  let weldCount = 0;
  for (let v = 0; v < positions.length / 3; v += 1) {
    const key = `${Math.round(positions[v * 3] / tol)},${Math.round(
      positions[v * 3 + 1] / tol,
    )},${Math.round(positions[v * 3 + 2] / tol)}`;
    let w = map.get(key);
    if (w === undefined) {
      w = weldCount++;
      map.set(key, w);
    }
    weldOf[v] = w;
  }
  const parent = new Int32Array(weldCount);
  for (let i = 0; i < weldCount; i += 1) parent[i] = i;
  const find = (x) => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let i = 0; i < indices.length; i += 3) {
    union(weldOf[indices[i]], weldOf[indices[i + 1]]);
    union(weldOf[indices[i + 1]], weldOf[indices[i + 2]]);
  }
  const roots = new Set();
  for (let i = 0; i < indices.length; i += 1)
    roots.add(find(weldOf[indices[i]]));
  return roots.size;
}

// Reconstruct a single segment's sub-mesh as a Manifold to check watertightness.
function segmentManifold(wasm, positions, indices, range) {
  const { Manifold, Mesh } = wasm;
  const used = new Map();
  const vertProps = [];
  const triVerts = [];
  const remap = (globalIndex) => {
    let local = used.get(globalIndex);
    if (local === undefined) {
      local = vertProps.length / 3;
      vertProps.push(
        positions[globalIndex * 3],
        positions[globalIndex * 3 + 1],
        positions[globalIndex * 3 + 2],
      );
      used.set(globalIndex, local);
    }
    return local;
  };
  for (let i = range.start; i < range.start + range.count; i += 3) {
    triVerts.push(
      remap(indices[i]),
      remap(indices[i + 1]),
      remap(indices[i + 2]),
    );
  }
  const mesh = new Mesh({
    numProp: 3,
    vertProperties: new Float32Array(vertProps),
    triVerts: new Uint32Array(triVerts),
  });
  mesh.merge();
  return Manifold.ofMesh(mesh);
}

// --- Test run --------------------------------------------------------------

const wasm = await loadManifold();
const settings = {
  segmentCount: 5,
  clearanceMm: 0.4,
  targetLengthMm: 150,
  jointScale: 1.0,
  axisOverride: 'auto',
  bendAngleDeg: 12,
};

// Capsule, N=5 → exactly 5 disconnected bodies.
const capsuleRaw = toInput(
  makeSpindle({ length: 200, maxRadius: 16, taper: 0.3 }),
);
const capsule = scaleForSettings(capsuleRaw, settings);
const capsulePlan = planFlexiToy(capsule, settings);
assert.equal(
  capsulePlan.joints.filter((j) => !j.fused).length,
  4,
  'capsule N=5 plans 4 articulating joints',
);

const outcome = await buildFlexiToy(wasm, capsule, capsulePlan, settings);
assert.equal(outcome.status, 'ok', 'capsule build succeeds');
const result = outcome.result;

assert.equal(result.segmentCount, 5, 'result reports 5 segments');
assert.equal(
  result.segmentTriangleRanges.length,
  5,
  '5 per-segment triangle ranges',
);
assert.equal(
  countBodies(result.positions, result.indices),
  5,
  'exactly 5 disconnected bodies via union-find',
);

// Every body watertight per Manifold; collect the total volume.
let outputVolume = 0;
for (const range of result.segmentTriangleRanges) {
  const manifold = segmentManifold(
    wasm,
    result.positions,
    result.indices,
    range,
  );
  assert.equal(manifold.status(), 'NoError', 'segment is a valid manifold');
  assert.ok(!manifold.isEmpty(), 'segment is non-empty');
  outputVolume += manifold.volume();
  manifold.delete();
}

// Total output volume strictly less than the input volume.
const inputMesh = new wasm.Mesh({
  numProp: 3,
  vertProperties: new Float32Array(capsule.positions),
  triVerts: new Uint32Array(capsule.indices),
});
inputMesh.merge();
const inputManifold = wasm.Manifold.ofMesh(inputMesh);
const inputVolume = inputManifold.volume();
inputManifold.delete();
assert.ok(
  outputVolume < inputVolume,
  `output volume < input (${outputVolume.toFixed(1)} < ${inputVolume.toFixed(1)})`,
);

// No NaNs / non-finite output.
for (let i = 0; i < result.positions.length; i += 1) {
  assert.ok(Number.isFinite(result.positions[i]), 'position is finite');
}
for (let i = 0; i < result.colors.length; i += 1) {
  assert.ok(Number.isFinite(result.colors[i]), 'colour is finite');
}

// Floor-aligned: min-Y ≈ 0.
let minY = Infinity;
for (let i = 1; i < result.positions.length; i += 3) {
  minY = Math.min(minY, result.positions[i]);
}
assert.ok(Math.abs(minY) < 1e-3, `floor-aligned minY≈0 (got ${minY})`);

// Per joint: socket mouth radius < ball radius.
for (const joint of capsulePlan.joints) {
  if (joint.fused) continue;
  const mouth = socketMouthRadius(
    joint.ballRadiusMm,
    settings.clearanceMm,
    joint.socketDepthMm,
  );
  assert.ok(
    mouth < joint.ballRadiusMm,
    `socket mouth (${mouth.toFixed(2)}) < ball radius (${joint.ballRadiusMm.toFixed(2)})`,
  );
}

// Non-watertight input (open box) → clean error, never a throw.
function makeOpenBox() {
  const positions = [
    0, 0, 0, 20, 0, 0, 20, 0, 20, 0, 0, 20, 0, 20, 0, 20, 20, 0, 20, 20, 20, 0,
    20, 20,
  ];
  const faces = [
    [0, 1, 2, 3],
    [4, 7, 6, 5],
    [0, 4, 5, 1],
    [3, 2, 6, 7],
    [0, 3, 7, 4],
  ]; // +y top face omitted → open
  const indices = [];
  for (const f of faces) indices.push(f[0], f[1], f[2], f[0], f[2], f[3]);
  return toInput({ positions, indices });
}
const boxRaw = makeOpenBox();
const box = scaleForSettings(boxRaw, settings);
const boxPlan = planFlexiToy(box, settings);
const boxOutcome = await buildFlexiToy(wasm, box, boxPlan, settings);
assert.equal(boxOutcome.status, 'error', 'open box does not build');
assert.equal(
  boxOutcome.code,
  'not-watertight',
  'open box reports a clean not-watertight error',
);

// Two-body input (capsule + floating fin sphere) → still succeeds.
const twoBodyRaw = toInput(
  combine(
    makeSpindle({ length: 180, maxRadius: 14 }),
    makeUvSphere({ radius: 10, offset: [90, 0, 20] }),
  ),
);
const twoBody = scaleForSettings(twoBodyRaw, settings);
const twoBodyPlan = planFlexiToy(twoBody, settings);
const twoBodyOutcome = await buildFlexiToy(
  wasm,
  twoBody,
  twoBodyPlan,
  settings,
);
assert.equal(twoBodyOutcome.status, 'ok', 'two-body input still succeeds');

// --- Part D: single-color 3MF export (no interior colors) ------------------

// Give the capsule result deliberately varied vertex colors; the 3MF must still
// be a single neutral color with every triangle on slot 0 (preview keeps colors,
// export does not).
const coloredResult = {
  ...result,
  colors: (() => {
    const c = new Float32Array(result.colors.length);
    for (let v = 0; v < c.length / 3; v += 1) {
      c[v * 3] = (v % 3) / 2;
      c[v * 3 + 1] = ((v + 1) % 3) / 2;
      c[v * 3 + 2] = ((v + 2) % 3) / 2;
    }
    return c;
  })(),
};
const threeMfBlob = await flexiResultToThreeMfBlob(coloredResult, 'flexi-toy');
assert.equal(threeMfBlob.type, 'model/3mf', '3MF blob has the right MIME type');

const zipReader = new ZipReader(new BlobReader(threeMfBlob));
const zipEntries = await zipReader.getEntries();
const objectEntry = zipEntries.find(
  (entry) => entry.filename === '3D/Objects/Object_1_1.model',
);
assert.ok(objectEntry, 'packaged object model is present');
const objectXml = await objectEntry.getData(new TextWriter());

// Exactly one material color, and it is the neutral grey.
const baseColors = [
  ...objectXml.matchAll(/\bdisplaycolor="(#[0-9A-Fa-f]{6})[0-9A-Fa-f]{2}"/g),
].map((m) => m[1].toUpperCase());
assert.deepEqual(baseColors, ['#D8D8D8'], 'single neutral palette color');

// Every triangle references color slot 0.
const colorIndexes = [
  ...objectXml.matchAll(/<triangle\b[^>]*\bp1="(\d+)"/g),
].map((m) => Number(m[1]));
assert.ok(colorIndexes.length > 0, '3MF has triangles');
assert.ok(
  colorIndexes.every((index) => index === 0),
  'every triangle is on the single color slot 0',
);
await zipReader.close();

console.log('flexiToyBuild.test.mjs: all assertions passed');
