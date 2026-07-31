import assert from 'node:assert/strict';
import {
  planFlexiToy,
  computeFlexiScale,
  scaleFlexiPositions,
  socketMouthRadius,
  solveStrongJointGeometry,
} from './flexiToyPlan.ts';
import { buildFlexiToy, loadManifold } from './flexiToyBuild.ts';
import { FLEXI_CAPTURE_MARGIN_MM } from './flexiToyTypes.ts';
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

// Orthonormal cross-section frame for a cut axis — mirrors the planner's
// buildAxisFrame, so a probe can name a strong joint's "up" (e1) and "lateral"
// (e2) directions. The build's orientationMatrix puts native +Y on e1 and
// native ±X on e2, so these are the axes the solved free play is stated in.
function axisFrame(axis) {
  const ref = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const d = ref[0] * axis[0] + ref[1] * axis[1] + ref[2] * axis[2];
  const raw = [
    ref[0] - axis[0] * d,
    ref[1] - axis[1] * d,
    ref[2] - axis[2] * d,
  ];
  const len = Math.hypot(raw[0], raw[1], raw[2]);
  const e1 = [raw[0] / len, raw[1] / len, raw[2] / len];
  const e2 = [
    axis[1] * e1[2] - axis[2] * e1[1],
    axis[2] * e1[0] - axis[0] * e1[2],
    axis[0] * e1[1] - axis[1] * e1[0],
  ];
  return { e1, e2 };
}

// Smallest translation of `mover` along `dir` at which it first intersects
// `other`, or null if it never does within maxDist. Scanned upward, NOT
// bisected: blocking is not monotone in the distance (slide far enough and two
// finite bodies simply separate again), so a bisection would report "free".
function firstContactDistance(mover, other, dir, maxDist, step = 0.05) {
  const hits = (dist) => {
    const moved = mover.translate([
      dir[0] * dist,
      dir[1] * dist,
      dir[2] * dist,
    ]);
    const overlap = moved.intersect(other);
    const empty = overlap.isEmpty();
    overlap.delete();
    moved.delete();
    return !empty;
  };
  let bracket = null;
  for (let d = step; d <= maxDist + 1e-9; d += step) {
    if (hits(d)) {
      bracket = d;
      break;
    }
  }
  if (bracket === null) return null;
  let lo = bracket - step;
  let hi = bracket;
  for (let i = 0; i < 8; i += 1) {
    const mid = (lo + hi) / 2;
    if (hits(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

// Volume of the overlap after translating `mover` by `dir · dist`.
function overlapVolumeAfterShift(mover, other, dir, dist) {
  const moved = mover.translate([dir[0] * dist, dir[1] * dist, dir[2] * dist]);
  const overlap = moved.intersect(other);
  const volume = overlap.isEmpty() ? 0 : overlap.volume();
  overlap.delete();
  moved.delete();
  return volume;
}

// Is a tiny cube at `point` inside `solid`? The measurement primitive the
// capture-ring probe is built from.
function solidCoversPoint(wasm, solid, point, size = 0.05) {
  const probe = wasm.Manifold.cube([size, size, size], true).translate(point);
  const overlap = solid.intersect(probe);
  const hit = !overlap.isEmpty();
  overlap.delete();
  probe.delete();
  return hit;
}

// Walk out from `origin` along `dir` and return the FIRST offset where `solid`
// stops covering the ray (`edge: 'outer'`, material contiguous from 0) or the
// first where it starts (`edge: 'inner'`, a void at 0). Scanned coarsely and
// then refined, NOT bisected over the whole span: the head segment's land plate
// is an ANNULUS (slot void, then plate, then the seam wedge's void again), so a
// plain bisection on "is it covered" has no bracket. Returns null if the state
// never flips.
//
// This measures the BUILT solid and nothing else — no solver output is read —
// which is what gives the capture probe teeth. Probes that compare a built
// distance against a value the same solver produced move together under any
// solver change and can assert nothing (law 5).
function materialEdgeAlong(wasm, solid, origin, dir, span, edge, step = 0.05) {
  const at = (t) =>
    solidCoversPoint(wasm, solid, [
      origin[0] + dir[0] * t,
      origin[1] + dir[1] * t,
      origin[2] + dir[2] * t,
    ]);
  const want = edge === 'outer' ? false : true;
  if (at(0) === want) return null;
  let bracket = null;
  for (let t = step; t <= span + 1e-9; t += step) {
    if (at(t) === want) {
      bracket = t;
      break;
    }
  }
  if (bracket === null) return null;
  let lo = bracket - step;
  let hi = bracket;
  for (let i = 0; i < 10; i += 1) {
    const mid = (lo + hi) / 2;
    if (at(mid) === want) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

// (S8) The strong joint's ANNULAR AXIAL STOP, measured off the BUILT solids.
//
// Spec §3.6 pins `rearHalf - throatInner` at the capture margin "by
// construction". Nothing measured it: S1 and R6 compare the built solid against
// `geometry.*FreePlayMm`, which the SAME solver produced, so zeroing the margin
// moved the geometry and the expectation together and the whole suite stayed
// green.
//
// This reads two lengths off the built solids and compares their difference to
// the CONTRACT CONSTANT:
//   · how far the tail segment's HEAD BALL reaches laterally at the pivot
//     plane — its widest section, the one that has to get through;
//   · where the head segment's land plate begins at the throat, measured in the
//     pocket's tail-pole plane where the opening is narrowest.
// A ball of radius `rho` cannot cross a planar hole of half-extent under
// `rho`, so this difference being positive is exactly what makes the joint
// captive — under roll, tilt, pull, or any composition of them. The round-2
// verifier's escape was this quantity going NEGATIVE on the `u` axis while the
// old solver only pinned it on `v`.
//
// Run at MORE THAN ONE bend angle. `capCapture` is only the binding cap on the
// bar's half-width near the top of the bend range (at bend 25 the solved margin
// sits exactly on 0.300 for r in [3, 6]); at bend 12 another cap binds, so a
// zeroed FLEXI_CAPTURE_MARGIN_MM there still leaves a captive joint and the
// mutation survives.
function assertStrongCaptureMargin(
  wasm,
  tail,
  head,
  joint,
  jc,
  e2,
  geometry,
  label,
) {
  const PROBE_OFFSET_MM = 0.06;
  const along = (s, v) => [
    jc[0] + joint.axis[0] * s + e2[0] * v,
    jc[1] + joint.axis[1] * s + e2[1] * v,
    jc[2] + joint.axis[2] * s + e2[2] * v,
  ];
  const headBallHalf = materialEdgeAlong(
    wasm,
    tail,
    along(0, 0),
    e2,
    geometry.cavityRadiusMm + 1,
    'outer',
  );
  const throatHalf = materialEdgeAlong(
    wasm,
    head,
    along(-geometry.cavityRadiusMm - PROBE_OFFSET_MM, 0),
    e2,
    geometry.cavityRadiusMm + 1,
    'inner',
  );
  assert.ok(
    headBallHalf !== null,
    `${label}: head ball has a measurable lateral edge`,
  );
  assert.ok(
    throatHalf !== null,
    `${label}: throat slot has a measurable lateral wall`,
  );
  // The throat probe is taken PROBE_OFFSET_MM BEYOND the pocket's tail pole,
  // where the bowtie has already flared a little, so the measurement is a
  // lower bound on the built margin up to the probe's own 0.05mm blur.
  const measuredCapture = headBallHalf - throatHalf;
  assert.ok(
    measuredCapture >= FLEXI_CAPTURE_MARGIN_MM - 0.1,
    `${label}: head overhangs the throat by the capture margin ` +
      `(measured ${measuredCapture.toFixed(3)}mm, contract ${FLEXI_CAPTURE_MARGIN_MM}mm; ` +
      `head ball ${headBallHalf.toFixed(3)}, throat ${throatHalf.toFixed(3)})`,
  );
  return measuredCapture;
}

// Which segments a small axis-aligned cube at `point` touches.
function segmentsTouching(wasm, manifolds, point, size = 0.4) {
  const probe = wasm.Manifold.cube([size, size, size], true).translate(point);
  const hit = [];
  manifolds.forEach((segment, index) => {
    const overlap = segment.intersect(probe);
    if (!overlap.isEmpty()) hit.push(index);
    overlap.delete();
  });
  probe.delete();
  return hit;
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
for (const style of ['classic', 'rounded', 'shell', 'strong']) {
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

  if (style === 'rounded' || style === 'shell' || style === 'strong') {
    if (style === 'rounded') roundedResult = result;

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

    const probeJoint = liveJoints[Math.floor(liveJoints.length / 2)];
    const pk = capsulePlan.joints.filter((j) => !j.fused).indexOf(probeJoint);
    const jc = [
      probeJoint.center[0],
      probeJoint.center[1] - shiftY,
      probeJoint.center[2],
    ];

    if (style !== 'strong') {
      // Geometric travel probe: swing one live joint's head segment about the
      // joint centre by the claimed travel (θ_mouth − α_neck) around a
      // horizontal axis ⊥ the joint axis, and assert the rotated segment does
      // not interpenetrate its tail neighbour (intersect volume ≈ 0).
      const r = probeJoint.ballRadiusMm;
      const c = settings.clearanceMm;
      const thetaMouth = Math.acos(
        Math.min(1, probeJoint.socketDepthMm / (r + c)),
      );
      const travelRad =
        thetaMouth -
        Math.max(Math.asin(0.35), thetaMouth - (12 * Math.PI) / 180);
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
    } else {
      const geometry = solveStrongJointGeometry(
        probeJoint.ballRadiusMm,
        settings.clearanceMm,
        settings.bendAngleDeg,
      );
      assert.ok(geometry, 'strong: the probe joint has a solved geometry');
      const { e1, e2 } = axisFrame(probeJoint.axis);
      const tail = segmentManifolds[pk];
      const head = segmentManifolds[pk + 1];

      // --- S2: travel is EXACTLY bendAngleDeg, in all four bend directions ---
      for (const [name, ax] of [
        ['+e1', e1],
        ['-e1', e1.map((v) => -v)],
        ['+e2', e2],
        ['-e2', e2.map((v) => -v)],
      ]) {
        const rotated = head.transform(
          rodriguesAbout(ax, (settings.bendAngleDeg * Math.PI) / 180, jc),
        );
        const overlap = tail.intersect(rotated);
        const volume = overlap.isEmpty() ? 0 : overlap.volume();
        assert.ok(
          volume < 1e-3,
          `strong: joint ${pk} swings the full ${settings.bendAngleDeg}° about ${name} (overlap ${volume.toFixed(4)})`,
        );
        overlap.delete();
        rotated.delete();
      }

      // --- S1: the axial / vertical / lateral stops are where the solver says,
      // and the joint is CAPTIVE (a real barrier, not a tangency) ---
      const stops = [
        ['+a', probeJoint.axis, geometry.axialFreePlayMm],
        ['-a', probeJoint.axis.map((v) => -v), geometry.axialFreePlayMm],
        ['+e1', e1, geometry.verticalFreePlayMm],
        ['-e1', e1.map((v) => -v), geometry.verticalFreePlayMm],
        ['+e2', e2, geometry.lateralFreePlayMm],
        ['-e2', e2.map((v) => -v), geometry.lateralFreePlayMm],
      ];
      for (const [name, dir, expected] of stops) {
        const contact = firstContactDistance(
          tail,
          head,
          dir,
          3 * probeJoint.ballRadiusMm,
        );
        assert.ok(
          contact !== null,
          `strong: joint ${pk} is captive in ${name} (a stop exists)`,
        );
        assert.ok(
          contact <= expected + 0.2,
          `strong: joint ${pk} stop in ${name} at ${contact.toFixed(3)} ≤ ${(expected + 0.2).toFixed(3)}mm`,
        );
        const barrier = overlapVolumeAfterShift(
          tail,
          head,
          dir,
          Math.min(contact + 1, 3 * probeJoint.ballRadiusMm),
        );
        assert.ok(
          barrier > 0,
          `strong: joint ${pk} stop in ${name} is a real barrier, not a graze`,
        );
      }

      // --- S3: twist is keyed but not seized ---
      const twistFree = head.transform(
        rodriguesAbout(probeJoint.axis, (5 * Math.PI) / 180, jc),
      );
      const twistFreeOverlap = tail.intersect(twistFree);
      const twistFreeVolume = twistFreeOverlap.isEmpty()
        ? 0
        : twistFreeOverlap.volume();
      assert.ok(
        twistFreeVolume < 1e-3,
        `strong: joint ${pk} rolls freely at 5° (overlap ${twistFreeVolume.toFixed(4)})`,
      );
      twistFreeOverlap.delete();
      twistFree.delete();
      const twistBlocked = head.transform(
        rodriguesAbout(probeJoint.axis, (70 * Math.PI) / 180, jc),
      );
      const twistBlockedOverlap = tail.intersect(twistBlocked);
      assert.ok(
        !twistBlockedOverlap.isEmpty(),
        `strong: joint ${pk} is keyed against a 70° roll`,
      );
      twistBlockedOverlap.delete();
      twistBlocked.delete();

      // --- S4: the gap is open and the bar crosses it ---
      //
      // Walk the joint axis at a LATERAL offset clear of the throat slot, from
      // deep in the tail segment up to the pocket's tail pole. A joint that
      // works reads: tail material · nothing · head material — a real, visible
      // separation with the land plate on the far side of it. (Fixing the probe
      // height to `bar + 1.2mm` cannot express this: the slot has to flare by
      // the bend swing on its way out, so on a big joint that height is still
      // inside the opening, and any fixed axial station eventually falls outside
      // the wedge once the seam's ramp lifts the face headward.)
      const at = (along, up) => [
        jc[0] + probeJoint.axis[0] * along + e1[0] * up,
        jc[1] + probeJoint.axis[1] * along + e1[1] * up,
        jc[2] + probeJoint.axis[2] * along + e1[2] * up,
      ];
      const beside = (along, lateralMm) => [
        jc[0] + probeJoint.axis[0] * along + e2[0] * lateralMm,
        jc[1] + probeJoint.axis[1] * along + e2[1] * lateralMm,
        jc[2] + probeJoint.axis[2] * along + e2[2] * lateralMm,
      ];
      const gapStation = -geometry.faceOffsetMm - 0.25;
      const besideSlot = geometry.throatOuterHalfMm + 0.6;
      let sawTail = false;
      let sawVoidAfterTail = false;
      let sawHeadAfterVoid = false;
      for (
        let s = -geometry.faceOffsetMm - 3;
        s <= -geometry.cavityRadiusMm + 1e-9;
        s += 0.1
      ) {
        const hit = segmentsTouching(
          wasm,
          segmentManifolds,
          beside(s, besideSlot),
          0.2,
        );
        if (!sawTail) {
          if (hit.length === 1 && hit[0] === pk) sawTail = true;
          continue;
        }
        if (!sawVoidAfterTail) {
          if (hit.length === 0) sawVoidAfterTail = true;
          continue;
        }
        if (hit.length === 1 && hit[0] === pk + 1) {
          sawHeadAfterVoid = true;
          break;
        }
      }
      assert.ok(
        sawTail && sawVoidAfterTail && sawHeadAfterVoid,
        `strong: joint ${pk} shows an OPEN gap beside the bar, with the land ` +
          `plate behind it (tail=${sawTail} void=${sawVoidAfterTail} land=${sawHeadAfterVoid})`,
      );
      assert.deepEqual(
        segmentsTouching(wasm, segmentManifolds, at(gapStation, 0)),
        [pk],
        `strong: joint ${pk}'s bar crosses the gap and belongs to the tail segment`,
      );

      // --- S6: the male landed on the tail side and fused to it ---
      assert.deepEqual(
        segmentsTouching(wasm, segmentManifolds, jc),
        [pk],
        `strong: joint ${pk}'s gem sits at the pivot and belongs to the tail segment`,
      );
      const tailComponents = tail.decompose();
      assert.equal(
        tailComponents.length,
        1,
        `strong: segment ${pk} is a single connected body (the bar fused)`,
      );
      for (const component of tailComponents) component.delete();

      // --- S8: the ANNULAR AXIAL STOP is physically there, and it is
      // FLEXI_CAPTURE_MARGIN_MM wide (see assertStrongCaptureMargin; the
      // bend-25 run, where capCapture is the binding cap, is below) ---
      assertStrongCaptureMargin(
        wasm,
        tail,
        head,
        probeJoint,
        jc,
        e2,
        geometry,
        `strong: joint ${pk} at bend ${settings.bendAngleDeg}°`,
      );
    }
  }

  for (const manifold of segmentManifolds) manifold.delete();
}

// (S8 at the TOP of the bend range) The capture-margin measurement above runs
// at the default 12°, where `capCapture` is NOT the cap that binds the bar's
// half-width — so zeroing FLEXI_CAPTURE_MARGIN_MM left every geometric build
// assertion green and only a plan-suite formula assertion caught it. Near 25°
// capCapture IS the binding cap (the solved margin sits exactly on 0.300 for
// r in [3, 6]), so repeating the built-solid measurement here is what makes the
// mutation visible to the build suite. One fixture is enough.
{
  const settings = { ...baseSettings('strong'), bendAngleDeg: 25 };
  const capsule = scaleForSettings(capsuleRaw, settings);
  const plan = planFlexiToy(capsule, settings);
  const outcome = await buildFlexiToy(wasm, capsule, plan, settings);
  assert.equal(outcome.status, 'ok', 'strong at 25°: capsule build succeeds');
  const manifolds = outcome.result.segmentTriangleRanges.map((range) =>
    segmentManifold(
      wasm,
      outcome.result.positions,
      outcome.result.indices,
      range,
    ),
  );
  let shiftY = Infinity;
  for (let i = 1; i < capsule.positions.length; i += 3) {
    shiftY = Math.min(shiftY, capsule.positions[i]);
  }
  // EVERY live joint, not just the middle one: at bend 25 the capture cap only
  // binds over r ≈ 3.4 … 5, and the middle joint of this fixture sits at 5.4
  // where a different cap sets the bar width — so probing one joint lets the
  // mutation through. (Verified by applying it: with the margin zeroed the
  // solved margin falls to 0.076 … 0.230 over that band, and the r ≈ 4.1 joint
  // is what trips this assertion.)
  const liveJoints = plan.joints.filter((j) => !j.fused);
  liveJoints.forEach((probeJoint, pk) => {
    const geometry = solveStrongJointGeometry(
      probeJoint.ballRadiusMm,
      settings.clearanceMm,
      settings.bendAngleDeg,
    );
    assert.ok(geometry, `strong at 25°: joint ${pk} has a solved geometry`);
    const { e2 } = axisFrame(probeJoint.axis);
    assertStrongCaptureMargin(
      wasm,
      manifolds[pk],
      manifolds[pk + 1],
      probeJoint,
      [
        probeJoint.center[0],
        probeJoint.center[1] - shiftY,
        probeJoint.center[2],
      ],
      e2,
      geometry,
      `strong: joint ${pk} (r=${probeJoint.ballRadiusMm.toFixed(2)}) at bend 25°`,
    );
  });
  for (const manifold of manifolds) manifold.delete();
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
for (const style of ['classic', 'rounded', 'shell', 'strong']) {
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

// Band-overlap regression: a thin tube with a tall mid-body wing, at max bend
// and a segment count that pushes pitch to the plan floor. Each rounded-family
// gap band reaches ±rho·tan(gapAngle/2) axially at cross-section radius rho,
// so the spacing floor must budget the WIDEST station extent — otherwise two
// adjacent bands jointly cover the wing's whole axial span and silently shave
// it to the groove floor between cuts.
function makeWingedTube({
  length = 230,
  radius = 6,
  wingHalfHeight = 25,
  wingStart = 0.38,
  wingEnd = 0.62,
  radialSegments = 48,
  rings = 230,
} = {}) {
  const positions = [];
  positions.push(0, 0, 0);
  const ringStart = 1;
  const wing = (u) => {
    if (u <= wingStart || u >= wingEnd) return 0;
    const t = (u - wingStart) / (wingEnd - wingStart);
    return Math.sin(Math.PI * t) ** 2;
  };
  for (let ri = 0; ri < rings; ri += 1) {
    const u = (ri + 1) / (rings + 1);
    const end = Math.min(1, 14 * Math.min(u, 1 - u)) ** 0.5;
    const ry = end * radius;
    const rz = end * (radius + (wingHalfHeight - radius) * wing(u));
    for (let k = 0; k < radialSegments; k += 1) {
      const a = (k / radialSegments) * Math.PI * 2;
      positions.push(length * u, ry * Math.cos(a), rz * Math.sin(a));
    }
  }
  const head = positions.length / 3;
  positions.push(length, 0, 0);
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

const wingSettings = {
  ...baseSettings('rounded'),
  segmentCount: 20,
  clearanceMm: 0.4,
  bendAngleDeg: 25,
  targetLengthMm: 230,
};
const wingRaw = toInput(makeWingedTube());
const wingInput = scaleForSettings(wingRaw, wingSettings);
const wingPlan = planFlexiToy(wingInput, wingSettings);
const wingOutcome = await buildFlexiToy(
  wasm,
  wingInput,
  wingPlan,
  wingSettings,
);
assert.equal(
  wingOutcome.status,
  'ok',
  `winged tube builds (got ${wingOutcome.code ?? 'ok'})`,
);
assert.ok(
  wingOutcome.result.segmentCount < 20,
  `winged tube at max bend: the band floor reduces the segment count (got ${wingOutcome.result.segmentCount})`,
);
{
  // Measure the wing's half-extent between the two cuts nearest the crest —
  // it must match the input there (the fin is grooved AT stations, never
  // shaved BETWEEN them).
  const crestX = 115;
  const liveX = wingPlan.joints
    .filter((j) => !j.fused)
    .map((j) => j.center[0])
    .sort((a, b) => a - b);
  let midX = crestX;
  let bestDistance = Infinity;
  for (let i = 0; i + 1 < liveX.length; i += 1) {
    const mid = (liveX[i] + liveX[i + 1]) / 2;
    if (Math.abs(mid - crestX) < bestDistance) {
      bestDistance = Math.abs(mid - crestX);
      midX = mid;
    }
  }
  const maxAbsZNear = (positions, cx) => {
    let max = 0;
    for (let v = 0; v < positions.length / 3; v += 1) {
      if (Math.abs(positions[v * 3] - cx) > 0.75) continue;
      max = Math.max(max, Math.abs(positions[v * 3 + 2]));
    }
    return max;
  };
  const inputWing = maxAbsZNear(wingInput.positions, midX);
  const outputWing = maxAbsZNear(wingOutcome.result.positions, midX);
  assert.ok(
    inputWing > 15,
    `winged tube: probe sits on the wing (input extent ${inputWing.toFixed(1)}mm)`,
  );
  assert.ok(
    outputWing >= inputWing - 1.2,
    `winged tube: wing survives between cuts (${outputWing.toFixed(1)} vs input ${inputWing.toFixed(1)}mm at x=${midX.toFixed(1)})`,
  );
}

// --- Shell engagement + skin-lofted seam regressions ------------------------

// Fish-proportioned bodies: an elliptical cross-section (tall > wide), slowly
// varying along x — the shape class where the shell style used to fall back
// to the rounded groove on every joint (slope cap) and, when it did engage,
// cut a deep trench on the tall side (support-extent ledge).
function makeEllipticalFish({
  length = 380,
  halfHeight = 38,
  halfWidth = 22,
  radialSegments = 96,
  rings = 140,
} = {}) {
  const positions = [];
  const profile = (u) => Math.sin(Math.PI * (0.08 + 0.84 * u)) ** 0.6;
  positions.push(0, 0, 0);
  const ringStart = 1;
  for (let ri = 0; ri < rings; ri += 1) {
    const u = (ri + 1) / (rings + 1);
    const s = profile(u);
    for (let k = 0; k < radialSegments; k += 1) {
      const a = (k / radialSegments) * Math.PI * 2;
      positions.push(
        length * u,
        s * halfHeight * Math.cos(a),
        s * halfWidth * Math.sin(a),
      );
    }
  }
  const head = positions.length / 3;
  positions.push(length, 0, 0);
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
  for (let k = 0; k < radialSegments; k += 1)
    indices.push(head, rv(rings - 1, k), rv(rings - 1, k + 1));
  return toInput({ positions, indices });
}

// (a) Flat-fish proportions at the defaults the design review ran (loose
// clearance, 12° bend): every live joint must host an overlapping shell — no
// shell-joint-fallback — and every cut must sever.
{
  const settings = {
    segmentCount: 5,
    clearanceMm: 0.55,
    targetLengthMm: 260,
    jointScale: 1.0,
    axisOverride: 'auto',
    bendAngleDeg: 12,
    jointStyle: 'shell',
  };
  const fishRaw = makeEllipticalFish();
  const fish = scaleForSettings(fishRaw, settings);
  const fishPlan = planFlexiToy(fish, settings);
  const liveCount = fishPlan.joints.filter((j) => !j.fused).length;
  assert.ok(liveCount >= 4, `flat fish plans live joints (got ${liveCount})`);
  const fishOutcome = await buildFlexiToy(wasm, fish, fishPlan, settings);
  assert.equal(
    fishOutcome.status,
    'ok',
    `flat fish shell builds (got ${fishOutcome.code ?? 'ok'})`,
  );
  assert.ok(
    !fishOutcome.result.warnings.some((w) => w.code === 'shell-joint-fallback'),
    'flat fish at defaults: shell joints ENGAGE on every live joint (no fallback)',
  );
  assert.equal(
    countBodies(fishOutcome.result.positions, fishOutcome.result.indices),
    fishOutcome.result.segmentCount,
    'flat fish shell: every cut fully severs',
  );
}

// (b) 2:1 elliptical body: the lofted seam keeps adjacent segments a
// clearance-scale gap apart, its floor stays within ~3mm of the skin in BOTH
// the tall and thin directions (no tall-side trench), and (4) a segment
// rotated by the claimed travel about a horizontal bend axis does not
// intersect its neighbour (the lofted, θ-invariant seam slides).
{
  const settings = {
    segmentCount: 5,
    clearanceMm: 0.55,
    targetLengthMm: 260,
    jointScale: 1.0,
    axisOverride: 'x',
    bendAngleDeg: 12,
    jointStyle: 'shell',
  };
  const raw = makeEllipticalFish({ halfHeight: 40, halfWidth: 20 });
  const input = scaleForSettings(raw, settings);
  const plan = planFlexiToy(input, settings);
  const outcome = await buildFlexiToy(wasm, input, plan, settings);
  assert.equal(
    outcome.status,
    'ok',
    `2:1 elliptical shell builds (got ${outcome.code ?? 'ok'})`,
  );
  const result = outcome.result;
  assert.ok(
    !result.warnings.some((w) => w.code === 'shell-joint-fallback'),
    '2:1 elliptical: shell joints engage',
  );

  const manifolds = result.segmentTriangleRanges.map((range) =>
    segmentManifold(wasm, result.positions, result.indices, range),
  );
  const minShellGap = 0.9 * Math.min(settings.clearanceMm, 0.55);
  for (let i = 1; i < manifolds.length; i += 1) {
    const gap = manifolds[i - 1].minGap(manifolds[i], 5);
    assert.ok(
      gap >= minShellGap,
      `2:1 elliptical: adjacent segments ${i - 1}/${i} keep ${gap.toFixed(3)} ≥ ${minShellGap.toFixed(3)}mm`,
    );
  }

  // Result is floor-aligned; joints are in input space.
  let shiftY = Infinity;
  for (let i = 1; i < input.positions.length; i += 3) {
    shiftY = Math.min(shiftY, input.positions[i]);
  }
  const liveJoints = plan.joints.filter((j) => !j.fused);
  const probeJoint = liveJoints[Math.floor(liveJoints.length / 2)];
  const cx = probeJoint.center[0];
  const cy = probeJoint.center[1] - shiftY;
  const cz = probeJoint.center[2];

  // Seam floor vs skin, per direction, within a ±20° azimuth cone about the
  // tall (+y) / thin (+z) direction. AT the cut plane the seam gap is open
  // from the ledge outward — the skin is severed and the band walls sit
  // axially clear of the plane — so the LARGEST result radius in a thin slab
  // on the plane is the exposed seam floor (internal rise/cup faces sit at
  // smaller radii and cannot raise a max). The lofted ledge must keep that
  // floor within ~3mm of the skin in the TALL direction too (the old
  // support-extent ledge left a >8mm trench there).
  const coneRadius = (positions, centerY, isTall, axialTol) => {
    let best = 0;
    for (let v = 0; v < positions.length / 3; v += 1) {
      const x = positions[v * 3];
      if (Math.abs(x - cx) > axialTol) continue;
      const y = positions[v * 3 + 1] - centerY;
      const z = positions[v * 3 + 2] - cz;
      const major = isTall ? Math.abs(y) : Math.abs(z);
      const minor = isTall ? Math.abs(z) : Math.abs(y);
      if (minor > Math.tan((20 * Math.PI) / 180) * major) continue;
      const radius = Math.hypot(y, z);
      if (radius > best) best = radius;
    }
    return best;
  };
  // The physical floor sits flap (1.6) + sliding gap (clearance + the
  // azimuth-slip allowance, ~1.0 here) under the skin; sector envelopes and
  // the flap's headward taper band add a bounded safety margin on top.
  // 4.5mm therefore pins "uniform shallow seam" (the pre-loft support-extent
  // ledge left a 13mm tall-side trench here) without asserting away the
  // deliberate bend-safety margins.
  const depths = {};
  for (const isTall of [true, false]) {
    const skin = coneRadius(input.positions, probeJoint.center[1], isTall, 1.5);
    assert.ok(skin > 10, `2:1 skin radius sane (${skin.toFixed(1)}mm)`);
    const floor = coneRadius(result.positions, cy, isTall, 0.75);
    assert.ok(floor > 0, `2:1 ${isTall ? 'tall' : 'thin'}: seam floor found`);
    const depth = skin - floor;
    depths[isTall ? 'tall' : 'thin'] = depth;
    assert.ok(
      depth >= 0.3,
      `2:1 ${isTall ? 'tall' : 'thin'}: a seam exists (depth ${depth.toFixed(2)}mm)`,
    );
    assert.ok(
      depth <= 4.5,
      `2:1 ${isTall ? 'tall' : 'thin'}: seam floor stays near the skin (depth ${depth.toFixed(2)}mm)`,
    );
  }
  assert.ok(
    Math.abs(depths.tall - depths.thin) <= 2.0,
    `2:1: seam depth is uniform around the ring (tall ${depths.tall.toFixed(2)} vs thin ${depths.thin.toFixed(2)}mm)`,
  );

  // (4) Bend-safety numeric probe: rotate the head segment about a
  // horizontal axis ⊥ the joint axis by the claimed travel — the lofted,
  // θ-invariant seam must slide without interpenetration.
  const pk = liveJoints.indexOf(probeJoint);
  const rc = probeJoint.ballRadiusMm + settings.clearanceMm;
  const thetaMouth = Math.acos(Math.min(1, probeJoint.socketDepthMm / rc));
  const travelRad =
    thetaMouth -
    Math.max(
      Math.asin(0.35),
      thetaMouth - (settings.bendAngleDeg * Math.PI) / 180,
    );
  const ax = [-probeJoint.axis[2], 0, probeJoint.axis[0]];
  const axLen = Math.hypot(ax[0], ax[1], ax[2]) || 1;
  const rotationMatrix = rodriguesAbout(
    [ax[0] / axLen, ax[1] / axLen, ax[2] / axLen],
    travelRad,
    [cx, cy, cz],
  );
  const head = manifolds[pk + 1].transform(rotationMatrix);
  const overlap = manifolds[pk].intersect(head);
  const overlapVolume = overlap.isEmpty() ? 0 : overlap.volume();
  assert.ok(
    overlapVolume < 1e-3,
    `2:1 elliptical: joint ${pk} swings ${((travelRad * 180) / Math.PI).toFixed(1)}° without collision (overlap ${overlapVolume.toFixed(4)})`,
  );
  overlap.delete();
  head.delete();
  for (const manifold of manifolds) manifold.delete();
}

// --- STRONG style: travel envelope, clearance presets, tapering tail --------

// (S2, whole envelope) The strong seam's angular gap is ≥ bend + 3° at every
// radius, so the seam never limits the swing and a full-bend swing must clear
// at 5°, 12° AND 25° — the probe that catches a wrong Δθ, a wrong slot taper or
// a wrong cavity sweep. The seam's cushion is NOT the joint's margin: first
// contact is set by the bar in its slot and the ball in its pocket, and lands
// at bend + 2.6° … + 5° on the fixtures measured, so this probe asserts
// clearance AT the bend rather than any particular overshoot.
for (const bendAngleDeg of [5, 12, 25]) {
  const settings = { ...baseSettings('strong'), bendAngleDeg };
  const capsule = scaleForSettings(capsuleRaw, settings);
  const plan = planFlexiToy(capsule, settings);
  const outcome = await buildFlexiToy(wasm, capsule, plan, settings);
  assert.equal(
    outcome.status,
    'ok',
    `strong at ${bendAngleDeg}°: builds (got ${outcome.code ?? 'ok'})`,
  );
  const result = outcome.result;
  assert.equal(
    countBodies(result.positions, result.indices),
    result.segmentCount,
    `strong at ${bendAngleDeg}°: every cut fully severs`,
  );
  const manifolds = result.segmentTriangleRanges.map((range) =>
    segmentManifold(wasm, result.positions, result.indices, range),
  );
  let shiftY = Infinity;
  for (let i = 1; i < capsule.positions.length; i += 3) {
    shiftY = Math.min(shiftY, capsule.positions[i]);
  }
  const liveJoints = plan.joints.filter((j) => !j.fused);
  liveJoints.forEach((joint, k) => {
    const { e1, e2 } = axisFrame(joint.axis);
    const jc = [joint.center[0], joint.center[1] - shiftY, joint.center[2]];
    for (const [name, ax] of [
      ['+e1', e1],
      ['-e1', e1.map((v) => -v)],
      ['+e2', e2],
      ['-e2', e2.map((v) => -v)],
    ]) {
      const rotated = manifolds[k + 1].transform(
        rodriguesAbout(ax, (bendAngleDeg * Math.PI) / 180, jc),
      );
      const overlap = manifolds[k].intersect(rotated);
      const volume = overlap.isEmpty() ? 0 : overlap.volume();
      assert.ok(
        volume < 1e-3,
        `strong at ${bendAngleDeg}°: joint ${k} swings the full angle about ${name} (overlap ${volume.toFixed(4)})`,
      );
      overlap.delete();
      rotated.delete();
    }
  });
  for (const manifold of manifolds) manifold.delete();
}

// (S5) Clearance presets: the printed gap between adjacent segments tracks the
// requested clearance at all three presets.
for (const clearanceMm of [0.3, 0.4, 0.55]) {
  const settings = { ...baseSettings('strong'), clearanceMm };
  const capsule = scaleForSettings(capsuleRaw, settings);
  const plan = planFlexiToy(capsule, settings);
  const outcome = await buildFlexiToy(wasm, capsule, plan, settings);
  assert.equal(
    outcome.status,
    'ok',
    `strong at clearance ${clearanceMm}: builds (got ${outcome.code ?? 'ok'})`,
  );
  const result = outcome.result;
  const manifolds = result.segmentTriangleRanges.map((range) =>
    segmentManifold(wasm, result.positions, result.indices, range),
  );
  for (let i = 1; i < manifolds.length; i += 1) {
    const gap = manifolds[i - 1].minGap(manifolds[i], 5);
    assert.ok(
      gap >= 0.9 * clearanceMm,
      `strong at clearance ${clearanceMm}: adjacent segments ${i - 1}/${i} keep ${gap.toFixed(3)} ≥ ${(0.9 * clearanceMm).toFixed(3)}mm`,
    );
  }
  for (const manifold of manifolds) manifold.delete();
}

// --- STRONG style: round-1 verifier regressions ----------------------------

// (R1) Sliver shards. With BOTH UI sliders at maximum on a fat body, the seam's
// ramp used to climb steeply enough that the land plate never reached past the
// cavity; the plate was then pinched off between the cavity, the throat slot and
// the seam, and the orphan survived decompose() as an extra, SILENT body that
// even made it into the exported 3MF. Boundary measured at the time: clean at
// every bend up to 22° and at every joint scale up to 1.3, +4 bodies at
// (1.4, 25°), growing to +8 as the body got fatter.
for (const maxRadius of [16, 18, 20, 22, 26]) {
  const settings = {
    ...baseSettings('strong'),
    jointScale: 1.4,
    bendAngleDeg: 25,
  };
  const fat = scaleForSettings(
    toInput(makeSpindle({ length: 200, maxRadius, taper: 0.2 })),
    settings,
  );
  const plan = planFlexiToy(fat, settings);
  const outcome = await buildFlexiToy(wasm, fat, plan, settings);
  assert.equal(
    outcome.status,
    'ok',
    `strong fat r${maxRadius} at max sliders: builds (got ${outcome.code ?? 'ok'})`,
  );
  assert.equal(
    countBodies(outcome.result.positions, outcome.result.indices),
    outcome.result.segmentCount,
    `strong fat r${maxRadius} at max sliders: no stray sliver bodies`,
  );
}

// (R2) OBLIQUE travel. The bar is a rectangle, so sizing its slot per axis
// (|v'| and |u'| bounded independently) is exact only for a pure yaw — under a
// bend about a 45° azimuth the bar's CORNER swings further than either bound,
// and between the gem and the land it was covered only by the cavity, whose
// octahedral faces are sized for the swept GEM. Measured before the fix: first
// collision at 21.6° against a claimed 25°. S2 only probes ±e1/±e2, so it
// cannot see this — sweep the whole azimuth circle.
for (const [name, raw, clearanceMm] of [
  ['spindle', capsuleRaw, 0.3],
  ['spindle loose', capsuleRaw, 0.55],
  ['winged', toInput(makeWingedTube()), 0.3],
]) {
  const settings = {
    ...baseSettings('strong'),
    bendAngleDeg: 25,
    clearanceMm,
    segmentCount: name === 'winged' ? 8 : 5,
    targetLengthMm: name === 'winged' ? 230 : 150,
  };
  const input = scaleForSettings(raw, settings);
  const plan = planFlexiToy(input, settings);
  const outcome = await buildFlexiToy(wasm, input, plan, settings);
  assert.equal(
    outcome.status,
    'ok',
    `strong oblique ${name}: builds (got ${outcome.code ?? 'ok'})`,
  );
  const result = outcome.result;
  const manifolds = result.segmentTriangleRanges.map((range) =>
    segmentManifold(wasm, result.positions, result.indices, range),
  );
  let shiftY = Infinity;
  for (let i = 1; i < input.positions.length; i += 3) {
    shiftY = Math.min(shiftY, input.positions[i]);
  }
  plan.joints
    .filter((joint) => !joint.fused)
    .forEach((joint, k) => {
      const { e1, e2 } = axisFrame(joint.axis);
      const jc = [joint.center[0], joint.center[1] - shiftY, joint.center[2]];
      for (let step = 0; step < 12; step += 1) {
        const psi = (step / 12) * Math.PI;
        const ax = [0, 1, 2].map(
          (i) => e1[i] * Math.cos(psi) + e2[i] * Math.sin(psi),
        );
        for (const sign of [1, -1]) {
          const rotated = manifolds[k + 1].transform(
            rodriguesAbout(
              ax,
              (sign * settings.bendAngleDeg * Math.PI) / 180,
              jc,
            ),
          );
          const overlap = manifolds[k].intersect(rotated);
          const volume = overlap.isEmpty() ? 0 : overlap.volume();
          assert.ok(
            volume < 1e-3,
            `strong oblique ${name}: joint ${k} clears 25° about azimuth ${((psi * 180) / Math.PI).toFixed(0)}° sign ${sign} (overlap ${volume.toFixed(4)})`,
          );
          overlap.delete();
          rotated.delete();
        }
      }
    });
  for (const manifold of manifolds) manifold.delete();
}

// (R3) The seam must DELIVER the requested clearance preset. The shipped slope
// cap pinned the law-3 normal gap to exactly the clearance at the single radius
// r1 and assumed the two faces stayed parallel, but the head face KINKS at r1
// and Δθ(R) shrinks with radius, so the real minimum sat just outside r1:
// measured 0.432 mm against a 0.55 mm preset on a winged body at 5° bend, on
// every joint. Worst at loose clearance + low bend, so probe exactly there.
//
// The last two rows cover the OPPOSITE corner — both UI sliders at maximum
// (jointScale 1.4, bend 25°) on an ECCENTRIC body. There the ramp climbs its
// whole rise inside r2 − r1 = 0.75 mm while the gap solver's sampling span runs
// out to 1.15 × the widest extent (34 mm on this body against a 13 mm min
// extent). Sampling that span uniformly in radius put barely one vertex on the
// ramp, so the solver measured 0.730 mm where the built seam was 0.262 mm and
// kept the full slope ceiling: 48 % of a 0.55 mm preset, silently, on the
// largest joint only. The two faces are near-concentric arcs at the ceiling, so
// the shortfall barely moved with the preset — raising the clearance did not
// help. Every other style delivered the full preset on the same body.
for (const [name, raw, segmentCount, targetLengthMm, jointScale, bends] of [
  ['winged', toInput(makeWingedTube()), 12, 230, 1.0, [5, 12]],
  ['spindle', capsuleRaw, 7, 190, 1.0, [5, 12]],
  [
    'eccentric max-sliders',
    toInput(
      makeSpindle({ length: 200, maxRadius: 14, taper: 0.2, zBulge: 1.6 }),
    ),
    20,
    200,
    1.4,
    [25],
  ],
  [
    'eccentric mid-bend',
    toInput(
      makeSpindle({ length: 200, maxRadius: 14, taper: 0.2, zBulge: 1.6 }),
    ),
    20,
    200,
    1.4,
    [12],
  ],
]) {
  for (const clearanceMm of [0.3, 0.55]) {
    for (const bendAngleDeg of bends) {
      const settings = {
        ...baseSettings('strong'),
        segmentCount,
        targetLengthMm,
        clearanceMm,
        bendAngleDeg,
        jointScale,
      };
      const input = scaleForSettings(raw, settings);
      const plan = planFlexiToy(input, settings);
      const outcome = await buildFlexiToy(wasm, input, plan, settings);
      assert.equal(
        outcome.status,
        'ok',
        `strong seam gap ${name} c${clearanceMm} b${bendAngleDeg}: builds`,
      );
      const result = outcome.result;
      const manifolds = result.segmentTriangleRanges.map((range) =>
        segmentManifold(wasm, result.positions, result.indices, range),
      );
      for (let i = 1; i < manifolds.length; i += 1) {
        const gap = manifolds[i - 1].minGap(manifolds[i], 5);
        assert.ok(
          gap >= clearanceMm - 0.02,
          `strong seam gap ${name} c${clearanceMm} b${bendAngleDeg}: pair ${i - 1}/${i} keeps ${gap.toFixed(4)} ≥ ${(clearanceMm - 0.02).toFixed(2)}mm`,
        );
      }
      for (const manifold of manifolds) manifold.delete();
    }
  }
}

// (R4) Strong-only severance dead end. The neighbour clamp floored the wedge's
// exit cosine at 0.2, but on the seam's near-90° plane branch cos(θ_tail) is
// ~0.08, so the outer radius was capped at 5× the neighbour budget and landed
// short of a FLATTENED body's widest radius: 'rounded-uncut' from a plan that
// classic, rounded and shell all built. Strong must not be the odd one out.
{
  const spindle = makeSpindle({ length: 150, maxRadius: 10, taper: 0.3 });
  const flattened = toInput({
    positions: spindle.positions.map((v, i) => (i % 3 === 2 ? v * 3.2 : v)),
    indices: spindle.indices,
  });
  for (const [segmentCount, bendAngleDeg, clearanceMm] of [
    [16, 5, 0.3],
    [16, 5, 0.55],
    [16, 12, 0.55],
    [20, 12, 0.55],
  ]) {
    const statuses = {};
    for (const jointStyle of ['classic', 'rounded', 'shell', 'strong']) {
      const settings = {
        ...baseSettings(jointStyle),
        segmentCount,
        bendAngleDeg,
        clearanceMm,
        targetLengthMm: 180,
        jointScale: 0.6,
        axisOverride: 'x',
      };
      const input = scaleForSettings(flattened, settings);
      const plan = planFlexiToy(input, settings);
      const outcome = await buildFlexiToy(wasm, input, plan, settings);
      statuses[jointStyle] = outcome.status === 'ok' ? 'ok' : outcome.code;
    }
    assert.equal(
      statuses.strong,
      'ok',
      `strong flattened n${segmentCount} b${bendAngleDeg} c${clearanceMm}: severs where the others do (${JSON.stringify(statuses)})`,
    );
  }
}

// (R5) The build-side rounded fallback ladder. Nothing in a normal settings
// sweep reaches it — the planner's jointOverlapCap shrinks the ball until the
// strong footprint fits, so the branch is purely defensive. Drive it directly
// by handing buildFlexiToy a plan whose stations sit closer than the strong
// solid needs (buildFlexiToy takes the plan as an argument, so this is the same
// entry point the worker uses). Without the dense-station travel clamp this
// path inherited the FULL bend, which is exactly wrong for the one case it
// exists to serve.
{
  const settings = {
    ...baseSettings('strong'),
    segmentCount: 4,
    targetLengthMm: 160,
  };
  const input = scaleForSettings(
    toInput(makeSpindle({ length: 160, maxRadius: 14, taper: 0.25 })),
    settings,
  );
  const plan = planFlexiToy(input, settings);
  const live = plan.joints.filter((joint) => !joint.fused);
  assert.ok(live.length >= 2, 'fallback fixture has joints to squeeze');
  const mid = live[Math.floor(live.length / 2)].center.slice();
  for (const joint of plan.joints) {
    for (let k = 0; k < 3; k += 1) {
      joint.center[k] = mid[k] + (joint.center[k] - mid[k]) * 0.3;
    }
  }
  const outcome = await buildFlexiToy(wasm, input, plan, settings);
  assert.equal(
    outcome.status,
    'ok',
    `strong fallback: dense plan still builds (got ${outcome.code ?? 'ok'})`,
  );
  const fallbackWarnings = outcome.result.warnings.filter(
    (warning) => warning.code === 'strong-joint-fallback',
  );
  assert.equal(
    fallbackWarnings.length,
    1,
    'strong fallback: reported as ONE aggregated warning, not one per joint',
  );
  assert.match(
    fallbackWarnings[0].message,
    /rounded grooves? instead/,
    'strong fallback: warning names the rounded groove it substituted',
  );
  const fellBack = Number(
    fallbackWarnings[0].message.match(/^(\d+)/)?.[1] ?? 1,
  );
  assert.ok(
    fellBack >= 1 && fellBack <= live.length,
    `strong fallback: the count (${fellBack}) is a real subset of the ${live.length} live joints`,
  );
  assert.equal(
    countBodies(outcome.result.positions, outcome.result.indices),
    outcome.result.segmentCount,
    'strong fallback: the rounded cutter still severs every segment',
  );
}

// (R6) Round-2 verifier regression: pull-out slop, MEASURED on the built solids
// and compared to the CONTRACT, not to whatever the solver produced.
//
// The flat-rear gem let the male slide 1.17–2.92mm back at bend 25° — 4× the
// reference toy — and the old version of this probe missed it twice over: it
// compared the built solid only against `geometry.axialFreePlayMm` (same solver,
// so drift was invisible), and it pushed the HEAD along −a, which is the
// push-IN direction. Both are fixed here: the head is pulled along +a, and the
// ceiling is `clearance + FLEXI_CAPTURE_MARGIN_MM`, a constant the geometry
// cannot move.
for (const bendAngleDeg of [12, 25]) {
  const settings = { ...baseSettings('strong'), bendAngleDeg };
  const capsule = scaleForSettings(capsuleRaw, settings);
  const plan = planFlexiToy(capsule, settings);
  const outcome = await buildFlexiToy(wasm, capsule, plan, settings);
  assert.equal(outcome.status, 'ok', `strong play at ${bendAngleDeg}°: builds`);
  const result = outcome.result;
  const manifolds = result.segmentTriangleRanges.map((range) =>
    segmentManifold(wasm, result.positions, result.indices, range),
  );
  let shiftY = Infinity;
  for (let i = 1; i < capsule.positions.length; i += 3) {
    shiftY = Math.min(shiftY, capsule.positions[i]);
  }
  plan.joints
    .filter((joint) => !joint.fused)
    .forEach((joint, k) => {
      const geometry = solveStrongJointGeometry(
        joint.ballRadiusMm,
        settings.clearanceMm,
        bendAngleDeg,
      );
      const ceiling = settings.clearanceMm + FLEXI_CAPTURE_MARGIN_MM;
      assert.ok(
        geometry.axialFreePlayMm <= ceiling + 1e-9,
        `strong play joint ${k} at ${bendAngleDeg}°: solved pull-out ${geometry.axialFreePlayMm.toFixed(3)} ≤ c + capture margin = ${ceiling.toFixed(3)}`,
      );
      const { e1, e2 } = axisFrame(joint.axis);
      const tail = manifolds[k];
      const head = manifolds[k + 1];
      // The male ball rides on the TAIL segment, so pulling the joint apart is
      // the HEAD moving +a. Every direction is checked against the solver AND
      // against the contract ceiling.
      for (const [name, dir, expected] of [
        ['+a (pull out)', joint.axis, geometry.axialFreePlayMm],
        ['-a (push in)', joint.axis.map((v) => -v), geometry.lateralFreePlayMm],
        ['+e1', e1, geometry.verticalFreePlayMm],
        ['-e1', e1.map((v) => -v), geometry.verticalFreePlayMm],
        ['+e2', e2, geometry.lateralFreePlayMm],
        ['-e2', e2.map((v) => -v), geometry.lateralFreePlayMm],
      ]) {
        const contact = firstContactDistance(
          head,
          tail,
          dir,
          3 * joint.ballRadiusMm + 6,
        );
        assert.ok(
          contact !== null && Number.isFinite(contact),
          `strong play joint ${k} at ${bendAngleDeg}°: captive along ${name}`,
        );
        assert.ok(
          contact <= expected + 0.05,
          `strong play joint ${k} at ${bendAngleDeg}°: ${name} contacts at ${contact.toFixed(3)} ≤ solved ${expected.toFixed(3)} + 0.05`,
        );
        assert.ok(
          contact <= ceiling + 0.05,
          `strong play joint ${k} at ${bendAngleDeg}°: ${name} contacts at ${contact.toFixed(3)} ≤ contract ${ceiling.toFixed(2)} + 0.05`,
        );
      }
    });
  for (const manifold of manifolds) manifold.delete();
}

// (R7) Round-2 verifier BLOCKER regression: ROLL, THEN PULL.
//
// The flat-rear gem was a plate 2·S thick and 2·q wide, and the solver only ever
// compared its width against the throat's WIDTH. At bend ≳ 22° the slot's HEIGHT
// outran the gem — `rearHalfMm ≤ slotInnerHalfMm` in 18 of 72 solved cells — so
// rolling the head segment ~50° about the joint axis turned the gem edge-on and
// it slid straight out, silently, with `warnings: []` and a UI card promising a
// "captive joint". S1 (pure translation, six axes) and S3 (pure roll) both
// stayed green because neither COMPOSED the two.
//
// This probe composes them, on the exact cases the verifier reported. It is
// cheap on a captive joint (contact is found within a few steps) and only walks
// the whole slide when something is genuinely loose.
{
  const escapeCases = [
    ['capsule c0.55 b25', capsuleRaw, 0.55, 25],
    ['capsule c0.40 b25', capsuleRaw, 0.4, 25],
    ['capsule c0.55 b22', capsuleRaw, 0.55, 22],
    [
      'tapered spindle c0.55 b25',
      toInput(makeSpindle({ length: 200, maxRadius: 16, taper: 0.75 })),
      0.55,
      25,
    ],
  ];
  for (const [name, raw, clearanceMm, bendAngleDeg] of escapeCases) {
    const settings = {
      ...baseSettings('strong'),
      clearanceMm,
      bendAngleDeg,
    };
    const input = scaleForSettings(raw, settings);
    const plan = planFlexiToy(input, settings);
    const outcome = await buildFlexiToy(wasm, input, plan, settings);
    assert.equal(
      outcome.status,
      'ok',
      `strong escape ${name}: builds (got ${outcome.code ?? 'ok'})`,
    );
    const result = outcome.result;
    const manifolds = result.segmentTriangleRanges.map((range) =>
      segmentManifold(wasm, result.positions, result.indices, range),
    );
    let shiftY = Infinity;
    for (let i = 1; i < input.positions.length; i += 3) {
      shiftY = Math.min(shiftY, input.positions[i]);
    }
    plan.joints
      .filter((joint) => !joint.fused)
      .forEach((joint, k) => {
        const jc = [joint.center[0], joint.center[1] - shiftY, joint.center[2]];
        const tail = manifolds[k];
        const head = manifolds[k + 1];
        const maxSlide = 3 * joint.ballRadiusMm + 6;
        for (let deg = 0; deg <= 90; deg += 5) {
          const rolled = head.transform(
            rodriguesAbout(joint.axis, (deg * Math.PI) / 180, jc),
          );
          let blocked = false;
          for (let d = 0.25; d <= maxSlide + 1e-9; d += 0.25) {
            const moved = rolled.translate([
              joint.axis[0] * d,
              joint.axis[1] * d,
              joint.axis[2] * d,
            ]);
            const overlap = tail.intersect(moved);
            blocked = !overlap.isEmpty();
            overlap.delete();
            moved.delete();
            if (blocked) break;
          }
          rolled.delete();
          assert.ok(
            blocked,
            `strong escape ${name}: joint ${k} (r=${joint.ballRadiusMm.toFixed(2)}) ` +
              `stays captive after a ${deg}° roll`,
          );
        }
      });
    for (const manifold of manifolds) manifold.delete();
  }
}

// (S7) Fallback accounting. The plan must never hand the build a live strong
// joint the solver cannot realise, so every 'strong-joint-fallback' has to come
// from a dense-station clamp or a boolean failure — never from a solver gap.
// Checked on the shapes most likely to provoke one.
{
  const cases = [
    [
      'flat fish',
      makeEllipticalFish(),
      {
        segmentCount: 5,
        clearanceMm: 0.55,
        targetLengthMm: 260,
        jointScale: 1.0,
        axisOverride: 'auto',
        bendAngleDeg: 12,
        jointStyle: 'strong',
      },
    ],
    [
      'eccentric spindle',
      toInput(
        makeSpindle({
          length: 180,
          maxRadius: 12,
          taper: 0.3,
          zBulge: 0.9,
          zBulgeAt: 0.6,
        }),
      ),
      baseSettings('strong'),
    ],
    [
      'winged tube',
      toInput(makeWingedTube()),
      {
        ...baseSettings('strong'),
        segmentCount: 20,
        bendAngleDeg: 25,
        targetLengthMm: 230,
      },
    ],
  ];
  for (const [name, raw, settings] of cases) {
    const input = scaleForSettings(raw, settings);
    const plan = planFlexiToy(input, settings);
    // A live joint the solver cannot realise is legal since round 2 (it becomes
    // a rounded joint rather than fusing — see the slim-tube regression below),
    // so what has to hold is that the BUILD reports exactly those joints.
    const unsolvable = plan.joints.filter(
      (joint) =>
        !joint.fused &&
        solveStrongJointGeometry(
          joint.ballRadiusMm,
          settings.clearanceMm,
          settings.bendAngleDeg,
        ) === null,
    ).length;
    const outcome = await buildFlexiToy(wasm, input, plan, settings);
    assert.equal(
      outcome.status,
      'ok',
      `strong ${name}: builds (got ${outcome.code ?? 'ok'})`,
    );
    assert.equal(
      countBodies(outcome.result.positions, outcome.result.indices),
      outcome.result.segmentCount,
      `strong ${name}: every cut fully severs`,
    );
    const fallback = outcome.result.warnings.filter(
      (w) => w.code === 'strong-joint-fallback',
    );
    assert.ok(
      fallback.length <= 1,
      `strong ${name}: the fallback warning is aggregated into one message`,
    );
    if (fallback.length === 1) {
      const reported = /^(\d+|One)/.exec(fallback[0].message);
      const count = reported[1] === 'One' ? 1 : Number(reported[1]);
      assert.ok(
        count >= 1 && count <= outcome.result.jointCount,
        `strong ${name}: the fallback count (${count}) is within the live joint count (${outcome.result.jointCount})`,
      );
      assert.ok(
        count >= unsolvable,
        `strong ${name}: every unsolvable live joint (${unsolvable}) is reported as a fallback (${count})`,
      );
    } else {
      assert.equal(
        unsolvable,
        0,
        `strong ${name}: no fallback warning, so no live joint may be unsolvable`,
      );
    }
  }
}

// --- STRONG style: round-2 verifier regressions ----------------------------

// (V2-1) A SLENDER body keeps all of its articulation. The gem/bar solver has a
// hard blade-width floor (r ≳ 3.194mm at clearance 0.55 / bend 25°), and
// `sizeJoint` used to FUSE every joint under it: a 170mm slim tube exported as
// ONE rigid body while shell, rounded and classic each delivered six articulated
// bodies from the identical mesh and settings. Strong must never articulate less
// than rounded on the same input — it falls back to the rounded groove per joint
// instead. This is also the only fixture that exercises the build's per-joint
// rounded fallback end to end.
{
  const slimSettings = {
    segmentCount: 6,
    clearanceMm: 0.55,
    targetLengthMm: 170,
    jointScale: 1.0,
    axisOverride: 'auto',
    bendAngleDeg: 25,
    jointStyle: 'strong',
  };
  const slimRaw = toInput(
    makeSpindle({ length: 170, maxRadius: 11, taper: 0.3 }),
  );
  const slimInput = scaleForSettings(slimRaw, slimSettings);
  const strongPlan = planFlexiToy(slimInput, slimSettings);
  const roundedPlan = planFlexiToy(slimInput, {
    ...slimSettings,
    jointStyle: 'rounded',
  });
  const liveStrong = strongPlan.joints.filter((j) => !j.fused);
  const liveRounded = roundedPlan.joints.filter((j) => !j.fused);
  assert.ok(
    liveRounded.length > 0,
    'slim strong: the rounded baseline articulates (else the case proves nothing)',
  );
  assert.equal(
    liveStrong.length,
    liveRounded.length,
    `slim strong: articulates as much as rounded (${liveStrong.length} vs ${liveRounded.length})`,
  );
  const belowFloor = liveStrong.filter(
    (j) =>
      solveStrongJointGeometry(
        j.ballRadiusMm,
        slimSettings.clearanceMm,
        slimSettings.bendAngleDeg,
      ) === null,
  ).length;
  assert.ok(
    belowFloor > 0,
    'slim strong: at least one live joint is below the strong solver floor ' +
      '(so the rounded fallback is genuinely exercised)',
  );
  const slimOutcome = await buildFlexiToy(
    wasm,
    slimInput,
    strongPlan,
    slimSettings,
  );
  assert.equal(
    slimOutcome.status,
    'ok',
    `slim strong: builds (got ${slimOutcome.code ?? 'ok'})`,
  );
  assert.equal(
    countBodies(slimOutcome.result.positions, slimOutcome.result.indices),
    slimOutcome.result.segmentCount,
    'slim strong: every cut severs and bodies == segments',
  );
  assert.ok(
    slimOutcome.result.segmentCount > 1,
    'slim strong: the export is NOT one rigid body',
  );
  const slimFallback = slimOutcome.result.warnings.filter(
    (w) => w.code === 'strong-joint-fallback',
  );
  assert.equal(
    slimFallback.length,
    1,
    'slim strong: the per-joint rounded fallback is reported, once',
  );
}

// (V2-2) The build's travel clamp is NEVER SILENT — asserted as an IMPLICATION
// over a battery of demanding cases rather than by pinning one witness.
//
// Reducing a joint's bend is a legitimate trade (the alternative is a cut that
// fails to separate), but the user asked for an angle and must be told they got
// less, and probe S2's `bend + STRONG_SEAM_OVERLAP_DEG` cushion hides
// reductions up to 3°.
//
// The witness this test used to pin moved when the pocket became a CONCENTRIC
// BALL, and the reason is worth recording: the pocket is now sized by the ball
// radius and clearance alone, so the dense-station SOLID-footprint gate no
// longer moves with the bend angle. A joint that does not fit its neighbours
// cannot be rescued by walking the travel down — it goes straight to the
// rounded fallback. Only the two bend-dependent gates (seam band reach,
// predictive severance) can still clamp, which needs a dense station count on a
// body that flares between the cuts; the first case below is a 528-case sweep's
// witness, reached with NO station dragging at all.
//
// The other two cases pin the property rather than a witness, which is what
// "never silent" actually means: a build either says it reduced the travel, or
// delivers the requested bend on the built solids.
for (const [name, raw, clampSettings] of [
  [
    'dense flaring spindle (measured clamp witness)',
    toInput(
      makeSpindle({ length: 150, maxRadius: 14, taper: 0.3, zBulge: 1.4 }),
    ),
    {
      segmentCount: 10,
      clearanceMm: 0.3,
      jointScale: 0.6,
      bendAngleDeg: 25,
      targetLengthMm: 200,
      expectClamp: true,
    },
  ],
  [
    'fat capsule, max sliders',
    capsuleRaw,
    { segmentCount: 4, clearanceMm: 0.55, jointScale: 1.4, bendAngleDeg: 25 },
  ],
  [
    'tall-finned tube',
    toInput(makeWingedTube()),
    { segmentCount: 6, clearanceMm: 0.55, jointScale: 1.2, bendAngleDeg: 25 },
  ],
]) {
  const settings = { ...baseSettings('strong'), ...clampSettings };
  const input = scaleForSettings(raw, settings);
  const plan = planFlexiToy(input, settings);
  const outcome = await buildFlexiToy(wasm, input, plan, settings);
  assert.equal(
    outcome.status,
    'ok',
    `strong clamp ${name}: builds (got ${outcome.code ?? 'ok'})`,
  );
  const reduced = outcome.result.warnings.filter(
    (w) => w.code === 'strong-travel-reduced',
  );
  assert.ok(
    reduced.length <= 1,
    `strong clamp ${name}: the reduced-travel warning is aggregated to one`,
  );
  if (reduced.length === 1) {
    assert.ok(
      new RegExp(`instead of ${settings.bendAngleDeg}°`).test(
        reduced[0].message,
      ),
      `strong clamp ${name}: the warning names the requested angle (got "${reduced[0].message}")`,
    );
    continue;
  }
  // No warning ⇒ the requested bend must actually be there. Measured, not
  // assumed: swing each live joint's head segment by the full angle about both
  // frame axes and require no interpenetration.
  const result = outcome.result;
  const manifolds = result.segmentTriangleRanges.map((range) =>
    segmentManifold(wasm, result.positions, result.indices, range),
  );
  let clampShiftY = Infinity;
  for (let i = 1; i < input.positions.length; i += 3) {
    clampShiftY = Math.min(clampShiftY, input.positions[i]);
  }
  plan.joints
    .filter((joint) => !joint.fused)
    .forEach((joint, k) => {
      const jc = [
        joint.center[0],
        joint.center[1] - clampShiftY,
        joint.center[2],
      ];
      const { e1, e2 } = axisFrame(joint.axis);
      for (const ax of [e1, e2]) {
        for (const sign of [1, -1]) {
          const rotated = manifolds[k + 1].transform(
            rodriguesAbout(
              ax.map((v) => v * sign),
              (settings.bendAngleDeg * Math.PI) / 180,
              jc,
            ),
          );
          const overlap = manifolds[k].intersect(rotated);
          const volume = overlap.isEmpty() ? 0 : overlap.volume();
          assert.ok(
            volume < 1e-3,
            `strong clamp ${name}: joint ${k} was NOT reported as reduced, so it must ` +
              `swing the full ${settings.bendAngleDeg}° (overlap ${volume.toFixed(4)})`,
          );
          overlap.delete();
          rotated.delete();
        }
      }
    });
  for (const manifold of manifolds) manifold.delete();
}

{
  // ...and the ordinary defaults must NOT be clamped: a style that quietly
  // under-delivers on every build would also "never be silent" vacuously.
  const plainSettings = baseSettings('strong');
  const plainInput = scaleForSettings(capsuleRaw, plainSettings);
  const plainPlan = planFlexiToy(plainInput, plainSettings);
  const plainOutcome = await buildFlexiToy(
    wasm,
    plainInput,
    plainPlan,
    plainSettings,
  );
  assert.equal(plainOutcome.status, 'ok', 'strong defaults: builds');
  assert.equal(
    plainOutcome.result.warnings.filter(
      (w) => w.code === 'strong-travel-reduced',
    ).length,
    0,
    'strong defaults: the full bend angle is delivered on an ordinary body',
  );
}

// (V2-3) On the TORUS — a closed loop no vertical cut can sever — strong must
// report the clean uncut error, NOT 'ok' with loose parts.
//
// Before the orphaned-male guard it returned 'ok' with 10 bodies, three of which
// were free gem+bar males (617/714/714 mm³) sitting on their own pivots: the bar
// anchored into the void the failed seam had carved, so the male fused to
// nothing and would drop off the plate. The severance guard cannot see that (an
// orphan is its own component and still lands in a segment group, so every group
// is non-empty). `rounded` errors on this fixture; strong now matches it.
{
  const torusStrongSettings = { ...baseSettings('strong'), segmentCount: 5 };
  const torusStrongInput = scaleForSettings(makeTorus(), torusStrongSettings);
  const torusStrongPlan = planFlexiToy(torusStrongInput, torusStrongSettings);
  const torusStrongOutcome = await buildFlexiToy(
    wasm,
    torusStrongInput,
    torusStrongPlan,
    torusStrongSettings,
  );
  assert.equal(
    torusStrongOutcome.status,
    'error',
    'torus strong: does not claim success on a body it cannot sever',
  );
  assert.equal(
    torusStrongOutcome.code,
    'rounded-uncut',
    `torus strong: reports the clean uncut error (got ${torusStrongOutcome.code})`,
  );
}

// (Tapering tail) Joint radii shrink toward the tip; the thin end fuses rather
// than falling back, every remaining cut severs, and bodies == segments.
{
  const settings = { ...baseSettings('strong'), segmentCount: 8 };
  const raw = toInput(makeSpindle({ length: 200, maxRadius: 16, taper: 0.75 }));
  const input = scaleForSettings(raw, settings);
  const plan = planFlexiToy(input, settings);
  const live = plan.joints.filter((j) => !j.fused);
  assert.ok(
    live.length >= 2,
    `tapered tail: still articulates (got ${live.length} live joints)`,
  );
  for (let i = 1; i < live.length; i += 1) {
    assert.ok(
      solveStrongJointGeometry(
        live[i].ballRadiusMm,
        settings.clearanceMm,
        settings.bendAngleDeg,
      ) !== null,
      'tapered tail: every live joint is solvable',
    );
  }
  // The fixture is a tapered spindle: radii rise to the crest then fall away,
  // and the thin tail FUSES (it never falls back to a rounded groove).
  const radii = live.map((joint) => joint.ballRadiusMm);
  const crest = radii.indexOf(Math.max(...radii));
  for (let i = crest + 1; i < radii.length; i += 1) {
    assert.ok(
      radii[i] < radii[i - 1] + 1e-9,
      `tapered tail: joints shrink toward the tip (${radii[i].toFixed(2)} after ${radii[i - 1].toFixed(2)})`,
    );
  }
  assert.ok(
    plan.joints[plan.joints.length - 1].fused,
    'tapered tail: the last station is too thin and fuses',
  );
  assert.ok(
    plan.warnings.some((w) => w.code === 'joint-fused-too-thin'),
    'tapered tail: the fused station is reported',
  );
  const outcome = await buildFlexiToy(wasm, input, plan, settings);
  assert.equal(
    outcome.status,
    'ok',
    `tapered tail: builds (got ${outcome.code ?? 'ok'})`,
  );
  assert.equal(
    countBodies(outcome.result.positions, outcome.result.indices),
    outcome.result.segmentCount,
    'tapered tail: every cut fully severs and bodies == segments',
  );
}

// (Strong severance regressions) Three failure modes found by probing, each of
// which produced a silent 'rounded-uncut' on a shape the other styles cut fine:
//
//  1. SHORT FAT body — the seam's ramp is gentler than the land plane's own
//     rise out there, so the head face used to dip TAILWARD past the land and
//     wrap head material around the bar, outside the throat slot. The bar then
//     fused to the head segment.
//  2. Same body, low bend — the tapering tip piece carries most of its VERTICES
//     right at the cut, so the old vertex-average centroid landed on the wrong
//     side of the cut plane and the piece was filed under the wrong segment.
//  3. ECCENTRIC bulge at a large joint scale — the seam profile was sampled
//     uniformly in radius, so the chord across the ramp's knee fell inside the
//     true face and missed the (slim) skin entirely.
{
  const shortFat = toInput(
    makeSpindle({ length: 90, maxRadius: 22, taper: 0.15 }),
  );
  const eccentric = toInput(
    makeSpindle({
      length: 200,
      maxRadius: 12,
      taper: 0.3,
      zBulge: 0.9,
      zBulgeAt: 0.6,
    }),
  );
  const cases = [
    ['short fat, max bend', shortFat, 5, 0.55, 25, 0.6],
    ['short fat, low bend', shortFat, 5, 0.3, 5, 0.6],
    ['short fat, many cuts', shortFat, 12, 0.3, 25, 0.6],
    ['eccentric bulge, big joints', eccentric, 5, 0.3, 12, 1.4],
    ['eccentric bulge, many cuts', eccentric, 12, 0.3, 12, 1.4],
  ];
  for (const [
    name,
    raw,
    segmentCount,
    clearanceMm,
    bendAngleDeg,
    jointScale,
  ] of cases) {
    const settings = {
      ...baseSettings('strong'),
      segmentCount,
      clearanceMm,
      bendAngleDeg,
      jointScale,
    };
    const input = scaleForSettings(raw, settings);
    const plan = planFlexiToy(input, settings);
    const outcome = await buildFlexiToy(wasm, input, plan, settings);
    assert.equal(
      outcome.status,
      'ok',
      `strong ${name}: severs (got ${outcome.code ?? 'ok'})`,
    );
    assert.equal(
      countBodies(outcome.result.positions, outcome.result.indices),
      outcome.result.segmentCount,
      `strong ${name}: body count equals segment count`,
    );
    // Each male must still own its own tail segment, not have fused across.
    let shiftY = Infinity;
    for (let i = 1; i < input.positions.length; i += 3) {
      shiftY = Math.min(shiftY, input.positions[i]);
    }
    const manifolds = outcome.result.segmentTriangleRanges.map((range) =>
      segmentManifold(
        wasm,
        outcome.result.positions,
        outcome.result.indices,
        range,
      ),
    );
    plan.joints
      .filter((j) => !j.fused)
      .forEach((joint, k) => {
        assert.deepEqual(
          segmentsTouching(wasm, manifolds, [
            joint.center[0],
            joint.center[1] - shiftY,
            joint.center[2],
          ]),
          [k],
          `strong ${name}: joint ${k}'s gem belongs to its tail segment only`,
        );
      });
    for (const manifold of manifolds) manifold.delete();
  }
}

// --- STRONG style: round-3 verifier regressions ----------------------------

// (R7) The VISIBLE OPEN GAP — the thing the style's name, its card copy and its
// reference model are all about.
//
// Keeping the running clearance is NOT the same as reading as an open seam: the
// clearance is a NORMAL separation and the seam faces are steeply inclined
// cones, so the AXIAL void a printed part shows can be a small fraction of it.
// Measured before this probe existed, on the standard 16mm spindle at the
// default sliders: 0.47–0.62mm — NARROWER than classic (1.25–1.82) and rounded
// (0.54–1.45) on the same settings, and a quarter of the reference toy's
// 2.21–2.27mm printed skin gap. Every other strong probe stayed green, because
// every other strong probe measures clearance, travel or capture.
//
// Method (the reviewer's): move both segments into the joint frame, drop a thin
// axial needle at 0.85 of the LOCAL per-azimuth skin radius, and read
// (head's tailmost material) − (tail's headmost material). Report the worst
// azimuth.
function visibleSkinGaps(wasm, result, plan, input, azimuths = 12) {
  const needle = 0.06;
  const halfSpan = 11;
  let shiftY = Infinity;
  for (let i = 1; i < input.positions.length; i += 3) {
    shiftY = Math.min(shiftY, input.positions[i]);
  }
  const segments = result.segmentTriangleRanges.map((range) =>
    segmentManifold(wasm, result.positions, result.indices, range),
  );
  const live = plan.joints.filter((j) => !j.fused);
  const out = [];
  for (let k = 0; k < live.length; k += 1) {
    const joint = live[k];
    const { e1, e2 } = axisFrame(joint.axis);
    // Per-azimuth skin radius AT the cut plane, interpolated between the rings
    // either side of it: a lathe fixture's rings sit ~3mm apart, so any fixed
    // window either misses the plane or drags in a fatter ring.
    const neg = new Array(azimuths).fill(null);
    const pos = new Array(azimuths).fill(null);
    for (let i = 0; i < input.positions.length; i += 3) {
      const p = [
        input.positions[i] - joint.center[0],
        input.positions[i + 1] - joint.center[1],
        input.positions[i + 2] - joint.center[2],
      ];
      const s =
        p[0] * joint.axis[0] + p[1] * joint.axis[1] + p[2] * joint.axis[2];
      if (Math.abs(s) > 12) continue;
      const x = p[0] * e2[0] + p[1] * e2[1] + p[2] * e2[2];
      const y = p[0] * e1[0] + p[1] * e1[1] + p[2] * e1[2];
      const rho = Math.hypot(x, y);
      if (rho < 1e-6) continue;
      let phi = Math.atan2(y, x);
      if (phi < 0) phi += Math.PI * 2;
      const bin = Math.min(
        azimuths - 1,
        Math.floor((phi / (Math.PI * 2)) * azimuths),
      );
      const side = s <= 0 ? neg : pos;
      if (!side[bin] || Math.abs(s) < Math.abs(side[bin].s) - 1e-9) {
        side[bin] = { s, rho };
      } else if (Math.abs(Math.abs(s) - Math.abs(side[bin].s)) < 1e-9) {
        side[bin].rho = Math.max(side[bin].rho, rho);
      }
    }
    const skin = neg.map((a, j) => {
      const b = pos[j];
      if (a && b && b.s - a.s > 1e-9)
        return a.rho + ((b.rho - a.rho) * (0 - a.s)) / (b.s - a.s);
      return a ? a.rho : b ? b.rho : 0;
    });
    const centre = [joint.center[0], joint.center[1] - shiftY, joint.center[2]];
    const toLocal = [
      e2[0],
      e1[0],
      joint.axis[0],
      0,
      e2[1],
      e1[1],
      joint.axis[1],
      0,
      e2[2],
      e1[2],
      joint.axis[2],
      0,
      -(e2[0] * centre[0] + e2[1] * centre[1] + e2[2] * centre[2]),
      -(e1[0] * centre[0] + e1[1] * centre[1] + e1[2] * centre[2]),
      -(
        joint.axis[0] * centre[0] +
        joint.axis[1] * centre[1] +
        joint.axis[2] * centre[2]
      ),
      1,
    ];
    const tail = segments[k].transform(toLocal);
    const head = segments[k + 1].transform(toLocal);
    // Never judge the skin gap at a radius still inside the joint's own
    // mechanism (pocket, land plate, slot): there the two segments interleave
    // by design and "the axial void" means nothing.
    const minRadius = joint.ballRadiusMm + 1.5;
    let worst = Infinity;
    let hits = 0;
    for (let i = 0; i < azimuths; i += 1) {
      const phi = ((i + 0.5) / azimuths) * Math.PI * 2;
      if (!(skin[i] > 0)) continue;
      // Walk inward if a segment has no material at the nominal radius: near a
      // tapering tip the tail piece ends several mm behind the cut plane, where
      // the body is already narrower than the plane's own skin. A smaller
      // radius only ever reads a SMALLER gap, so this stays conservative.
      for (let back = 0; back <= 8; back += 1) {
        const radius = (0.85 - 0.05 * back) * skin[i];
        if (!(radius > minRadius)) break;
        const probe = wasm.Manifold.cube(
          [needle, needle, 2 * halfSpan],
          true,
        ).translate([radius * Math.cos(phi), radius * Math.sin(phi), 0]);
        const tp = tail.intersect(probe);
        const hp = head.intersect(probe);
        const both = !tp.isEmpty() && !hp.isEmpty();
        if (both) {
          const gap = hp.boundingBox().min[2] - tp.boundingBox().max[2];
          if (gap < worst) worst = gap;
          hits += 1;
        }
        tp.delete();
        hp.delete();
        probe.delete();
        if (both) break;
      }
    }
    tail.delete();
    head.delete();
    out.push(hits > 0 ? worst : null);
  }
  for (const segment of segments) segment.delete();
  return out;
}

// The floor a NON-DEGRADED strong joint must read at. Deliberately well under
// what the solver targets (0.65 of the physical maximum, ≈1.1–1.8mm at bend 12
// on these fixtures) so this is a contract, not a snapshot.
const VISIBLE_GAP_FLOOR_MM = 0.9;
{
  const eccentricRaw = toInput(
    makeSpindle({ length: 200, maxRadius: 14, taper: 0.2, zBulge: 1.6 }),
  );
  for (const [name, raw, targetLengthMm] of [
    ['spindle', capsuleRaw, 150],
    ['eccentric', eccentricRaw, 190],
  ]) {
    const byBend = new Map();
    for (const bendAngleDeg of [12, 25]) {
      const settings = {
        ...baseSettings('strong'),
        bendAngleDeg,
        targetLengthMm,
      };
      const input = scaleForSettings(raw, settings);
      const plan = planFlexiToy(input, settings);
      const outcome = await buildFlexiToy(wasm, input, plan, settings);
      assert.equal(
        outcome.status,
        'ok',
        `strong visible gap ${name} b${bendAngleDeg}: builds (got ${outcome.code ?? 'ok'})`,
      );
      const gaps = visibleSkinGaps(wasm, outcome.result, plan, input);
      gaps.forEach((gap, k) => {
        assert.ok(
          gap !== null,
          `strong visible gap ${name} b${bendAngleDeg}: joint ${k} is measurable`,
        );
        assert.ok(
          gap >= VISIBLE_GAP_FLOOR_MM,
          `strong visible gap ${name} b${bendAngleDeg}: joint ${k} reads ` +
            `${gap.toFixed(2)}mm ≥ ${VISIBLE_GAP_FLOOR_MM}mm at 0.85·skin`,
        );
      });
      byBend.set(bendAngleDeg, gaps);
    }
    // The style card promises "bigger bends open the gap between segments
    // wider". The joint list is the same at both bends (the plan does not move
    // stations with the bend on these fixtures), so compare per joint.
    const narrow = byBend.get(12);
    const opened = byBend.get(25);
    assert.equal(
      narrow.length,
      opened.length,
      `strong visible gap ${name}: same joint count at both bends`,
    );
    narrow.forEach((small, k) => {
      assert.ok(
        opened[k] > small,
        `strong visible gap ${name}: joint ${k} opens wider at 25° than 12° ` +
          `(${opened[k].toFixed(2)} > ${small.toFixed(2)})`,
      );
    });
  }
}

// (R8) Graceful degradation. On a DENSELY pinned body the seam band budget
// cannot afford the full visible target, and the joint must fall back to a
// narrower seam at FULL travel rather than to the rounded cutter or a reduced
// bend. This is the path that keeps the gap cosmetic and the travel functional.
{
  const settings = {
    ...baseSettings('strong'),
    bendAngleDeg: 25,
    // Four cuts crowded into the middle third of the body: the planner pushes
    // them apart to its own floor, which still leaves ~19mm of pitch against a
    // seam that wants ~9.5mm of tail reach per side at the full target.
    jointPositions: [0.38, 0.46, 0.54, 0.62],
  };
  const input = scaleForSettings(capsuleRaw, settings);
  const plan = planFlexiToy(input, settings);
  const outcome = await buildFlexiToy(wasm, input, plan, settings);
  assert.equal(
    outcome.status,
    'ok',
    `strong dense pins: builds (got ${outcome.code ?? 'ok'})`,
  );
  assert.equal(
    countBodies(outcome.result.positions, outcome.result.indices),
    outcome.result.segmentCount,
    'strong dense pins: every cut still severs',
  );
  const gaps = visibleSkinGaps(wasm, outcome.result, plan, input).filter(
    (g) => g !== null,
  );
  assert.ok(gaps.length > 0, 'strong dense pins: some joint is measurable');
  assert.ok(
    gaps.some((g) => g < VISIBLE_GAP_FLOOR_MM),
    `strong dense pins: the degraded-seam path is exercised ` +
      `(gaps ${gaps.map((g) => g.toFixed(2)).join(', ')})`,
  );
  // …and it degraded the GAP, not the mechanism: no joint dropped to the
  // rounded cutter and none had its travel clamped.
  const codes = outcome.result.warnings.map((w) => w.code);
  assert.ok(
    !codes.includes('strong-joint-fallback'),
    'strong dense pins: no joint fell back to the rounded cutter',
  );
  assert.ok(
    !codes.includes('strong-travel-reduced'),
    'strong dense pins: no joint gave up travel to fit the seam',
  );
  // Degrading the gap must not have cost the running clearance.
  const manifolds = outcome.result.segmentTriangleRanges.map((range) =>
    segmentManifold(
      wasm,
      outcome.result.positions,
      outcome.result.indices,
      range,
    ),
  );
  for (let i = 1; i < manifolds.length; i += 1) {
    const gap = manifolds[i - 1].minGap(manifolds[i], 5);
    assert.ok(
      gap >= settings.clearanceMm - 0.02,
      `strong dense pins: adjacent segments ${i - 1}/${i} keep ${gap.toFixed(3)}mm`,
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
