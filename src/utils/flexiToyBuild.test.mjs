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
  // Local z-bulge: scales the z half-extent near `zBulgeAt` (arc fraction) by
  // up to (1 + zBulge), giving an eccentric (tall) cross-section crossing a cut
  // while staying a single connected body.
  zBulge = 0,
  zBulgeAt = 0.5,
} = {}) {
  const [ox, oy, oz] = offset;
  const positions = [];
  const push = (u, angle) => {
    const r = maxRadius * Math.sin(Math.PI * u) * (1 - taper * u);
    const along = length * u;
    const bell =
      zBulge > 0
        ? 1 + zBulge * Math.exp(-((u - zBulgeAt) ** 2) / (2 * 0.02 ** 2 * 25))
        : 1;
    if (axis === 'x')
      positions.push(
        ox + along,
        oy + r * Math.cos(angle),
        oz + bell * r * Math.sin(angle),
      );
    else
      positions.push(
        ox + r * Math.cos(angle),
        oy + along,
        oz + bell * r * Math.sin(angle),
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

// Column-major 4×4 (manifold transform) for a rotation of `theta` radians about
// a unit `axis` passing through `point`: x → point + R·(x − point).
function rodriguesAbout(axis, theta, point) {
  const [x, y, z] = axis;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const C = 1 - c;
  const r00 = c + x * x * C;
  const r01 = x * y * C - z * s;
  const r02 = x * z * C + y * s;
  const r10 = y * x * C + z * s;
  const r11 = c + y * y * C;
  const r12 = y * z * C - x * s;
  const r20 = z * x * C - y * s;
  const r21 = z * y * C + x * s;
  const r22 = c + z * z * C;
  const [px, py, pz] = point;
  const tx = px - (r00 * px + r01 * py + r02 * pz);
  const ty = py - (r10 * px + r11 * py + r12 * pz);
  const tz = pz - (r20 * px + r21 * py + r22 * pz);
  // Columns: R[:,0], R[:,1], R[:,2], translation.
  return [r00, r10, r20, 0, r01, r11, r21, 0, r02, r12, r22, 0, tx, ty, tz, 1];
}

// Torus (closed loop → a single rounded cut can never sever it): the canonical
// 'rounded-uncut' case.
function makeTorus({ major = 40, minor = 10, nu = 48, nv = 20 } = {}) {
  const positions = [];
  const indices = [];
  for (let i = 0; i < nu; i += 1) {
    const u = (i / nu) * Math.PI * 2;
    for (let j = 0; j < nv; j += 1) {
      const v = (j / nv) * Math.PI * 2;
      positions.push(
        (major + minor * Math.cos(v)) * Math.cos(u),
        (major + minor * Math.cos(v)) * Math.sin(u),
        minor * Math.sin(v),
      );
    }
  }
  const idx = (i, j) => (i % nu) * nv + (j % nv);
  for (let i = 0; i < nu; i += 1) {
    for (let j = 0; j < nv; j += 1) {
      const a = idx(i, j);
      const b = idx(i + 1, j);
      const cc = idx(i + 1, j + 1);
      const d = idx(i, j + 1);
      indices.push(a, b, cc, a, cc, d);
    }
  }
  return toInput({ positions, indices });
}

// --- Test run --------------------------------------------------------------

const wasm = await loadManifold();
const baseSettings = (jointStyle) => ({
  segmentCount: 5,
  clearanceMm: 0.4,
  targetLengthMm: 150,
  jointScale: 1.0,
  axisOverride: 'auto',
  bendAngleDeg: 12,
  jointStyle,
});

const capsuleRaw = toInput(
  makeSpindle({ length: 200, maxRadius: 16, taper: 0.3 }),
);

// Core invariants adapted to run for BOTH articulation styles. Returns the
// rounded-style result so the 3MF export test can reuse it.
let roundedResult = null;
for (const style of ['classic', 'rounded']) {
  const settings = baseSettings(style);
  const capsule = scaleForSettings(capsuleRaw, settings);
  const capsulePlan = planFlexiToy(capsule, settings);
  assert.equal(
    capsulePlan.joints.filter((j) => !j.fused).length,
    4,
    `${style}: capsule N=5 plans 4 articulating joints`,
  );

  const outcome = await buildFlexiToy(wasm, capsule, capsulePlan, settings);
  assert.equal(outcome.status, 'ok', `${style}: capsule build succeeds`);
  const result = outcome.result;

  assert.equal(result.segmentCount, 5, `${style}: reports 5 segments`);
  assert.equal(
    result.segmentTriangleRanges.length,
    5,
    `${style}: 5 per-segment triangle ranges`,
  );
  // Body count == live + 1 (rounded groups its decompose() components per
  // interval, so a brim sliver still counts within its segment).
  assert.equal(
    countBodies(result.positions, result.indices),
    5,
    `${style}: exactly 5 disconnected bodies via union-find`,
  );

  // Every segment watertight per Manifold; collect the total volume.
  const segmentManifolds = result.segmentTriangleRanges.map((range) =>
    segmentManifold(wasm, result.positions, result.indices, range),
  );
  let outputVolume = 0;
  for (const manifold of segmentManifolds) {
    assert.equal(
      manifold.status(),
      'NoError',
      `${style}: segment is a valid manifold`,
    );
    assert.ok(!manifold.isEmpty(), `${style}: segment is non-empty`);
    outputVolume += manifold.volume();
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
    `${style}: output volume < input (${outputVolume.toFixed(1)} < ${inputVolume.toFixed(1)})`,
  );

  // No NaNs / non-finite output.
  for (let i = 0; i < result.positions.length; i += 1) {
    assert.ok(
      Number.isFinite(result.positions[i]),
      `${style}: position finite`,
    );
  }
  for (let i = 0; i < result.colors.length; i += 1) {
    assert.ok(Number.isFinite(result.colors[i]), `${style}: colour finite`);
  }

  // Floor-aligned: min-Y ≈ 0.
  let minY = Infinity;
  for (let i = 1; i < result.positions.length; i += 3) {
    minY = Math.min(minY, result.positions[i]);
  }
  assert.ok(
    Math.abs(minY) < 1e-3,
    `${style}: floor-aligned minY≈0 (got ${minY})`,
  );

  // Per joint: socket mouth radius < ball radius (capture holds either style).
  for (const joint of capsulePlan.joints) {
    if (joint.fused) continue;
    const mouth = socketMouthRadius(
      joint.ballRadiusMm,
      settings.clearanceMm,
      joint.socketDepthMm,
    );
    assert.ok(
      mouth < joint.ballRadiusMm,
      `${style}: socket mouth (${mouth.toFixed(2)}) < ball radius (${joint.ballRadiusMm.toFixed(2)})`,
    );
  }

  if (style === 'rounded') {
    roundedResult = result;

    // Concentricity / no-collision: adjacent segments stay apart by ~min(c, gb).
    const bowlGap = Math.max(settings.clearanceMm, 0.55);
    const minSurfaceGap = 0.9 * Math.min(settings.clearanceMm, bowlGap);
    for (let i = 1; i < segmentManifolds.length; i += 1) {
      const gap = segmentManifolds[i - 1].minGap(segmentManifolds[i], 5);
      assert.ok(
        gap >= minSurfaceGap,
        `rounded: adjacent segments ${i - 1}/${i} keep ${gap.toFixed(3)} ≥ ${minSurfaceGap.toFixed(3)}mm`,
      );
    }

    // Neck integrity: each live joint's ball center lies inside exactly its tail
    // segment's component. Rounded cut ⊆ input, so the floor shift is the input
    // min-Y.
    let shiftY = Infinity;
    for (let i = 1; i < capsule.positions.length; i += 3) {
      shiftY = Math.min(shiftY, capsule.positions[i]);
    }
    const liveJoints = capsulePlan.joints.filter((j) => !j.fused);
    liveJoints.forEach((joint, k) => {
      const center = [
        joint.center[0],
        joint.center[1] - shiftY,
        joint.center[2],
      ];
      const probe = wasm.Manifold.cube([0.6, 0.6, 0.6], true).translate(center);
      const inside = segmentManifolds.filter((seg) => {
        const it = seg.intersect(probe);
        const empty = it.isEmpty();
        it.delete();
        return !empty;
      });
      probe.delete();
      assert.equal(
        inside.length,
        1,
        `rounded: ball center of joint ${k} is inside exactly one segment`,
      );
      assert.equal(
        segmentManifolds.indexOf(inside[0]),
        k,
        `rounded: ball of joint ${k} belongs to its tail segment ${k}`,
      );
    });

    // Geometric travel probe: swing one live joint's head segment about the
    // joint centre by the claimed travel (θ_mouth − α_neck) around a horizontal
    // axis ⊥ the joint axis, and assert the rotated segment does not
    // interpenetrate its tail neighbour (intersect volume ≈ 0).
    const probeJoint = liveJoints[Math.floor(liveJoints.length / 2)];
    const pk = capsulePlan.joints.filter((j) => !j.fused).indexOf(probeJoint);
    const r = probeJoint.ballRadiusMm;
    const c = settings.clearanceMm;
    const thetaMouth = Math.acos(
      Math.min(1, probeJoint.socketDepthMm / (r + c)),
    );
    const travelRad =
      thetaMouth - Math.max(Math.asin(0.35), thetaMouth - (12 * Math.PI) / 180);
    const jc = [
      probeJoint.center[0],
      probeJoint.center[1] - shiftY,
      probeJoint.center[2],
    ];
    // Horizontal rotation axis perpendicular to the (horizontal) joint axis.
    const ax = [-probeJoint.axis[2], 0, probeJoint.axis[0]];
    const axLen = Math.hypot(ax[0], ax[1], ax[2]) || 1;
    const rotationMatrix = rodriguesAbout(
      [ax[0] / axLen, ax[1] / axLen, ax[2] / axLen],
      travelRad,
      jc,
    );
    const head = segmentManifolds[pk + 1].transform(rotationMatrix);
    const overlap = segmentManifolds[pk].intersect(head);
    const overlapVolume = overlap.isEmpty() ? 0 : overlap.volume();
    assert.ok(
      overlapVolume < 1e-3,
      `rounded: joint ${pk} swings ${((travelRad * 180) / Math.PI).toFixed(1)}° without segments colliding (overlap ${overlapVolume.toFixed(4)})`,
    );
    overlap.delete();
    head.delete();
  }

  for (const manifold of segmentManifolds) manifold.delete();
}

const result = roundedResult;

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
const roundedSettings = baseSettings('rounded');
const boxRaw = makeOpenBox();
const box = scaleForSettings(boxRaw, roundedSettings);
const boxPlan = planFlexiToy(box, roundedSettings);
const boxOutcome = await buildFlexiToy(wasm, box, boxPlan, roundedSettings);
assert.equal(boxOutcome.status, 'error', 'open box does not build');
assert.equal(
  boxOutcome.code,
  'not-watertight',
  'open box reports a clean not-watertight error',
);

// Two-body input (capsule + a substantial detached fin sphere) → both styles.
// If the rounded style genuinely cannot sever it, it must surface 'rounded-uncut'
// (never a silent compute-failed); it must never throw.
for (const style of ['classic', 'rounded']) {
  const settings = baseSettings(style);
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
  if (style === 'classic') {
    assert.equal(
      twoBodyOutcome.status,
      'ok',
      'classic: two-body input succeeds',
    );
  } else {
    assert.ok(
      twoBodyOutcome.status === 'ok' ||
        (twoBodyOutcome.status === 'error' &&
          twoBodyOutcome.code === 'rounded-uncut'),
      `rounded: two-body is ok or a clean rounded-uncut (got ${twoBodyOutcome.status}/${twoBodyOutcome.code})`,
    );
  }
}

// Eccentric fixture: a single body with a tall (aspect ~1.9) cross-section
// crossing a cut. Sizing uses the MIN direction, so the brim MUST come from the
// MAX direction to exit the skin — otherwise this deterministically fails to
// sever (the pre-fix BLOCKER). One body ⇒ body count == segment count.
const eccentricRaw = toInput(
  makeSpindle({
    length: 180,
    maxRadius: 12,
    taper: 0.3,
    zBulge: 0.9,
    zBulgeAt: 0.6,
  }),
);
const eccentricSettings = baseSettings('rounded');
const eccentric = scaleForSettings(eccentricRaw, eccentricSettings);
const eccentricPlan = planFlexiToy(eccentric, eccentricSettings);
const eccentricOutcome = await buildFlexiToy(
  wasm,
  eccentric,
  eccentricPlan,
  eccentricSettings,
);
assert.equal(
  eccentricOutcome.status,
  'ok',
  `rounded: eccentric off-axis fin still severs (got ${eccentricOutcome.code ?? 'ok'})`,
);
assert.ok(
  countBodies(
    eccentricOutcome.result.positions,
    eccentricOutcome.result.indices,
  ) === eccentricOutcome.result.segmentCount,
  'rounded eccentric: body count equals segment count',
);

// Truncated-band regression: a slim body at LOW bend with loose clearance makes
// the rise slope cap bite (r1·gapAngle barely exceeds the clearance), so the
// gap band cannot reach the cut plane inside the body. The wedge must still
// punch through the skin along its tilted exit — before the fix this sealed
// inside the body on export (segments looked cut but printed fused) — and the
// printed gap between neighbours must stay at clearance scale.
const slimSettings = {
  ...baseSettings('rounded'),
  segmentCount: 4,
  clearanceMm: 0.55,
  bendAngleDeg: 5,
  targetLengthMm: 200,
};
const slimRaw = toInput(makeSpindle({ length: 200, maxRadius: 8, taper: 0.3 }));
const slim = scaleForSettings(slimRaw, slimSettings);
const slimPlan = planFlexiToy(slim, slimSettings);
assert.ok(
  slimPlan.joints.some((j) => !j.fused),
  'slim low-bend: at least one live joint',
);
const slimOutcome = await buildFlexiToy(wasm, slim, slimPlan, slimSettings);
assert.equal(
  slimOutcome.status,
  'ok',
  `slim low-bend: builds ok (got ${slimOutcome.code ?? 'ok'})`,
);
assert.equal(
  countBodies(slimOutcome.result.positions, slimOutcome.result.indices),
  slimOutcome.result.segmentCount,
  'slim low-bend: every cut fully severs (no skin bridge)',
);
{
  const ranges = slimOutcome.result.segmentTriangleRanges;
  const manifolds = ranges.map((range) =>
    segmentManifold(
      wasm,
      slimOutcome.result.positions,
      slimOutcome.result.indices,
      range,
    ),
  );
  const minSlimGap = 0.9 * Math.min(slimSettings.clearanceMm, 0.55);
  for (let i = 1; i < manifolds.length; i += 1) {
    const gap = manifolds[i - 1].minGap(manifolds[i], 5);
    assert.ok(
      gap >= minSlimGap,
      `slim low-bend: adjacent segments ${i - 1}/${i} keep ${gap.toFixed(3)} ≥ ${minSlimGap.toFixed(3)}mm`,
    );
  }
  for (const manifold of manifolds) manifold.delete();
}

// A closed loop (torus) cannot be severed by a single cut → clean rounded-uncut.
const torusSettings = baseSettings('rounded');
const torusRaw = makeTorus();
const torusInput = scaleForSettings(torusRaw, torusSettings);
const torusPlan = planFlexiToy(torusInput, torusSettings);
const torusOutcome = await buildFlexiToy(
  wasm,
  torusInput,
  torusPlan,
  torusSettings,
);
assert.equal(torusOutcome.status, 'error', 'torus does not build on rounded');
assert.equal(
  torusOutcome.code,
  'rounded-uncut',
  'torus reports a clean rounded-uncut error',
);

// --- Part D: colored 3MF export (matches the preview colors) ---------------

// Read the packaged object model out of a flexi 3MF blob.
const readObjectModelXml = async (blob) => {
  const reader = new ZipReader(new BlobReader(blob));
  const entries = await reader.getEntries();
  const entry = entries.find(
    (item) => item.filename === '3D/Objects/Object_1_1.model',
  );
  assert.ok(entry, 'packaged object model is present');
  const xml = await entry.getData(new TextWriter());
  await reader.close();
  return xml;
};

const paletteOf = (xml) =>
  [...xml.matchAll(/\bdisplaycolor="(#[0-9A-Fa-f]{6})[0-9A-Fa-f]{2}"/g)].map(
    (m) => m[1].toUpperCase(),
  );
const slotsOf = (xml) =>
  [...xml.matchAll(/<triangle\b[^>]*\bp1="(\d+)"/g)].map((m) => Number(m[1]));
const rgbOf = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

// Paint the capsule result in two clearly distinct halves (red tail / blue head)
// along its widest axis; the export must carry both into filament slots.
const vertexCount = result.positions.length / 3;
let widestAxis = 0;
let widestSpan = -Infinity;
for (let axis = 0; axis < 3; axis += 1) {
  let min = Infinity;
  let max = -Infinity;
  for (let v = 0; v < vertexCount; v += 1) {
    const value = result.positions[v * 3 + axis];
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (max - min > widestSpan) {
    widestSpan = max - min;
    widestAxis = axis;
  }
}
let axisMin = Infinity;
let axisMax = -Infinity;
for (let v = 0; v < vertexCount; v += 1) {
  const value = result.positions[v * 3 + widestAxis];
  if (value < axisMin) axisMin = value;
  if (value > axisMax) axisMax = value;
}
const axisMid = (axisMin + axisMax) / 2;

const coloredResult = {
  ...result,
  colors: (() => {
    const c = new Float32Array(result.colors.length);
    for (let v = 0; v < vertexCount; v += 1) {
      const head = result.positions[v * 3 + widestAxis] >= axisMid;
      c[v * 3] = head ? 0 : 1;
      c[v * 3 + 1] = 0;
      c[v * 3 + 2] = head ? 1 : 0;
    }
    return c;
  })(),
};
const threeMfBlob = await flexiResultToThreeMfBlob(coloredResult, 'flexi-toy');
assert.equal(threeMfBlob.type, 'model/3mf', '3MF blob has the right MIME type');

const objectXml = await readObjectModelXml(threeMfBlob);
const palette = paletteOf(objectXml);
assert.ok(
  palette.length >= 2 && palette.length <= 4,
  `colored export quantizes to 2..4 filament slots (got ${palette.length})`,
);
assert.ok(
  palette.some((hex) => {
    const [r, g, b] = rgbOf(hex);
    return r > 180 && g < 90 && b < 90;
  }),
  'the red half reaches the exported palette',
);
assert.ok(
  palette.some((hex) => {
    const [r, g, b] = rgbOf(hex);
    return b > 180 && r < 90 && g < 90;
  }),
  'the blue half reaches the exported palette',
);

const colorIndexes = slotsOf(objectXml);
assert.equal(
  colorIndexes.length,
  result.indices.length / 3,
  'export keeps every triangle — no fusion struts were added',
);
assert.ok(
  new Set(colorIndexes).size >= 2,
  'triangles are spread across more than one filament slot',
);
assert.ok(
  colorIndexes.every((index) => index < palette.length),
  'every triangle references a real palette slot',
);

// A result with no usable color data still exports as one neutral grey slot.
const uncoloredXml = await readObjectModelXml(
  await flexiResultToThreeMfBlob(
    { ...result, colors: new Float32Array(0) },
    'flexi-toy',
  ),
);
assert.deepEqual(
  paletteOf(uncoloredXml),
  ['#D8D8D8'],
  'colorless result falls back to a single neutral palette color',
);
assert.ok(
  slotsOf(uncoloredXml).every((index) => index === 0),
  'colorless fallback puts every triangle on slot 0',
);

console.log('flexiToyBuild.test.mjs: all assertions passed');
