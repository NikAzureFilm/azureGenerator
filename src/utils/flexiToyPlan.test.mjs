import assert from 'node:assert/strict';
import {
  planFlexiToy,
  computeFlexiScale,
  scaleFlexiPositions,
  socketMouthRadius,
} from './flexiToyPlan.ts';
import {
  FLEXI_MIN_BALL_RADIUS_MM,
  FLEXI_MIN_SOCKET_WALL_MM,
  FLEXI_CAPTURE_MARGIN_MM,
  FLEXI_MAX_SEGMENTS,
  FLEXI_MIN_SEGMENTS,
} from './flexiToyTypes.ts';

// --- Synthetic fixtures (generated in-test) --------------------------------

// Closed surface of revolution ("tapered capsule" / spindle) along an axis, with
// poles at both ends so it is watertight. ~5k triangles by default.
function makeSpindle({
  length = 150,
  maxRadius = 12,
  taper = 0.35,
  radialSegments = 40,
  rings = 62,
  axis = 'x',
} = {}) {
  const positions = [];
  const push = (u, angle) => {
    const r = maxRadius * Math.sin(Math.PI * u) * (1 - taper * u);
    const along = length * u;
    if (axis === 'x')
      positions.push(along, r * Math.cos(angle), r * Math.sin(angle));
    else if (axis === 'y')
      positions.push(r * Math.cos(angle), along, r * Math.sin(angle));
    else positions.push(r * Math.cos(angle), r * Math.sin(angle), along);
  };
  if (axis === 'x') positions.push(0, 0, 0);
  else if (axis === 'y') positions.push(0, 0, 0);
  else positions.push(0, 0, 0);
  const ringStart = 1;
  for (let ri = 0; ri < rings; ri += 1) {
    const u = (ri + 1) / (rings + 1);
    for (let k = 0; k < radialSegments; k += 1) {
      push(u, (k / radialSegments) * Math.PI * 2);
    }
  }
  const head = positions.length / 3;
  if (axis === 'x') positions.push(length, 0, 0);
  else if (axis === 'y') positions.push(0, length, 0);
  else positions.push(0, 0, length);

  const indices = [];
  const ringVert = (ri, k) =>
    ringStart + ri * radialSegments + (k % radialSegments);
  for (let k = 0; k < radialSegments; k += 1) {
    indices.push(0, ringVert(0, k + 1), ringVert(0, k));
  }
  for (let ri = 0; ri < rings - 1; ri += 1) {
    for (let k = 0; k < radialSegments; k += 1) {
      const a = ringVert(ri, k);
      const b = ringVert(ri, k + 1);
      const c = ringVert(ri + 1, k + 1);
      const d = ringVert(ri + 1, k);
      indices.push(a, b, c, a, c, d);
    }
  }
  for (let k = 0; k < radialSegments; k += 1) {
    indices.push(head, ringVert(rings - 1, k), ringVert(rings - 1, k + 1));
  }
  return toInput(positions, indices);
}

function makeUvSphere({ radius = 40, segments = 24 } = {}) {
  const positions = [];
  positions.push(0, -radius, 0);
  const ringStart = 1;
  const rings = segments - 1;
  for (let ri = 0; ri < rings; ri += 1) {
    const phi = Math.PI * ((ri + 1) / segments);
    for (let k = 0; k < segments; k += 1) {
      const theta = (k / segments) * Math.PI * 2;
      positions.push(
        radius * Math.sin(phi) * Math.cos(theta),
        -radius * Math.cos(phi),
        radius * Math.sin(phi) * Math.sin(theta),
      );
    }
  }
  const top = positions.length / 3;
  positions.push(0, radius, 0);
  const indices = [];
  const ringVert = (ri, k) => ringStart + ri * segments + (k % segments);
  for (let k = 0; k < segments; k += 1) {
    indices.push(0, ringVert(0, k + 1), ringVert(0, k));
  }
  for (let ri = 0; ri < rings - 1; ri += 1) {
    for (let k = 0; k < segments; k += 1) {
      const a = ringVert(ri, k);
      const b = ringVert(ri, k + 1);
      const c = ringVert(ri + 1, k + 1);
      const d = ringVert(ri + 1, k);
      indices.push(a, b, c, a, c, d);
    }
  }
  for (let k = 0; k < segments; k += 1) {
    indices.push(top, ringVert(rings - 1, k), ringVert(rings - 1, k + 1));
  }
  return toInput(positions, indices);
}

function toInput(positions, indices) {
  const p = new Float32Array(positions);
  const colors = new Float32Array(p.length);
  colors.fill(1);
  return { positions: p, indices: new Uint32Array(indices), colors };
}

// Cone (surface of revolution) along +x: R(x) = baseRadius * (1 - x / length).
// Its exact radius at any axial position is known analytically, which lets the
// containment regression assert against the true skin.
function makeCone({ length, baseRadius, radialSegments = 56, rings = 140 }) {
  const positions = [];
  const radiusAt = (u) => baseRadius * (1 - u);
  positions.push(0, 0, 0);
  const ringStart = 1;
  for (let ri = 0; ri < rings; ri += 1) {
    const u = ri / rings;
    const r = radiusAt(u);
    const x = length * u;
    for (let k = 0; k < radialSegments; k += 1) {
      const a = (k / radialSegments) * Math.PI * 2;
      positions.push(x, r * Math.cos(a), r * Math.sin(a));
    }
  }
  const apex = positions.length / 3;
  positions.push(length, 0, 0);
  const indices = [];
  const rv = (ri, k) => ringStart + ri * radialSegments + (k % radialSegments);
  for (let k = 0; k < radialSegments; k += 1)
    indices.push(0, rv(0, k), rv(0, k + 1));
  for (let ri = 0; ri < rings - 1; ri += 1) {
    for (let k = 0; k < radialSegments; k += 1) {
      indices.push(
        rv(ri, k),
        rv(ri, k + 1),
        rv(ri + 1, k + 1),
        rv(ri, k),
        rv(ri + 1, k + 1),
        rv(ri + 1, k),
      );
    }
  }
  for (let k = 0; k < radialSegments; k += 1) {
    indices.push(apex, rv(rings - 1, k + 1), rv(rings - 1, k));
  }
  return toInput(positions, indices);
}

const DEFAULT_SETTINGS = {
  segmentCount: 'auto',
  clearanceMm: 0.4,
  targetLengthMm: 150,
  jointScale: 1.0,
  axisOverride: 'auto',
};

// Independent min cross-section half-extent measurement (mirrors the planner's
// approach) so the wall invariant can be checked against the mesh directly.
function measureHalfExtent(positions, center, axis) {
  const ref = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const dotv = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  let e1 = [
    ref[0] - axis[0] * dotv(ref, axis),
    ref[1] - axis[1] * dotv(ref, axis),
    ref[2] - axis[2] * dotv(ref, axis),
  ];
  const e1len = Math.hypot(e1[0], e1[1], e1[2]);
  e1 = [e1[0] / e1len, e1[1] / e1len, e1[2] / e1len];
  const e2 = [
    axis[1] * e1[2] - axis[2] * e1[1],
    axis[2] * e1[0] - axis[0] * e1[2],
    axis[0] * e1[1] - axis[1] * e1[0],
  ];
  const xs = [];
  const ys = [];
  for (let i = 0; i < positions.length / 3; i += 1) {
    const rel = [
      positions[i * 3] - center[0],
      positions[i * 3 + 1] - center[1],
      positions[i * 3 + 2] - center[2],
    ];
    if (Math.abs(dotv(rel, axis)) >= 2) continue;
    xs.push(dotv(rel, e1));
    ys.push(dotv(rel, e2));
  }
  let minMax = Infinity;
  for (let k = 0; k < 16; k += 1) {
    const angle = (Math.PI * k) / 16;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let maxProj = 0;
    for (let p = 0; p < xs.length; p += 1) {
      maxProj = Math.max(maxProj, Math.abs(xs[p] * dx + ys[p] * dy));
    }
    minMax = Math.min(minMax, maxProj);
  }
  return minMax;
}

// --- socketMouthRadius unit check ------------------------------------------

assert.ok(
  Math.abs(socketMouthRadius(5, 0.4, 3) - Math.sqrt(5.4 * 5.4 - 9)) < 1e-9,
  'socketMouthRadius matches sqrt((r+c)^2 - h^2)',
);
assert.equal(socketMouthRadius(2, 0.3, 10), 0, 'socketMouthRadius clamps at 0');

// --- Tapered capsule: spine, auto N, sizing invariants ---------------------

const capsule = makeSpindle({ length: 150, maxRadius: 14 });
assert.ok(
  capsule.indices.length / 3 > 4500 && capsule.indices.length / 3 < 5500,
  `capsule fixture is ~5k triangles (got ${capsule.indices.length / 3})`,
);

const capsulePlan = planFlexiToy(capsule, DEFAULT_SETTINGS);

// Spine ~ the principal (x) axis: centroid polyline hugs y=z=0.
let maxSpineOffset = 0;
for (const [, y, z] of capsulePlan.spine) {
  maxSpineOffset = Math.max(maxSpineOffset, Math.hypot(y, z));
}
assert.ok(
  maxSpineOffset < 1.0,
  `spine hugs the axis (offset ${maxSpineOffset})`,
);
assert.ok(
  capsulePlan.spineLengthMm > 120 && capsulePlan.spineLengthMm < 160,
  `spine length ~150mm (got ${capsulePlan.spineLengthMm})`,
);

const capsuleSegments = capsulePlan.joints.length + 1;
assert.ok(
  capsuleSegments >= 4 && capsuleSegments <= FLEXI_MAX_SEGMENTS,
  `auto segment count in range (got ${capsuleSegments})`,
);

let nonFusedCount = 0;
for (const joint of capsulePlan.joints) {
  if (joint.fused) continue;
  nonFusedCount += 1;
  const r = joint.ballRadiusMm;
  const c = DEFAULT_SETTINGS.clearanceMm;

  assert.ok(
    r >= FLEXI_MIN_BALL_RADIUS_MM - 1e-6,
    `ball radius >= ${FLEXI_MIN_BALL_RADIUS_MM} (got ${r})`,
  );

  // Capture margin: mouth radius <= r - 0.3 (and strictly below r).
  const mouth = socketMouthRadius(r, c, joint.socketDepthMm);
  assert.ok(
    mouth <= r - FLEXI_CAPTURE_MARGIN_MM + 1e-6,
    `mouth radius within capture margin (mouth ${mouth}, r ${r})`,
  );
  assert.ok(mouth < r, 'mouth radius strictly below ball radius');

  // Socket depth is one of the two allowed factors of r.
  const depthFactor = joint.socketDepthMm / r;
  assert.ok(
    Math.abs(depthFactor - 0.65) < 1e-6 || Math.abs(depthFactor - 0.75) < 1e-6,
    `socket depth factor is 0.65 or 0.75 (got ${depthFactor})`,
  );

  // Wall invariant measured independently against the mesh.
  const m = measureHalfExtent(capsule.positions, joint.center, joint.axis);
  assert.ok(
    m - (r + c) >= FLEXI_MIN_SOCKET_WALL_MM - 0.15,
    `socket wall >= ${FLEXI_MIN_SOCKET_WALL_MM}mm (m ${m}, r+c ${r + c})`,
  );
}
assert.ok(
  nonFusedCount >= 3,
  `capsule yields articulating joints (${nonFusedCount})`,
);

// --- Thin mesh: every joint fuses, warning emitted -------------------------

const thin = makeSpindle({ length: 150, maxRadius: 1.4 });
const thinPlan = planFlexiToy(thin, DEFAULT_SETTINGS);
assert.ok(
  thinPlan.joints.every((joint) => joint.fused),
  'thin mesh fuses every joint',
);
assert.ok(
  thinPlan.warnings.some((w) => w.code === 'joint-fused-too-thin'),
  'thin mesh emits joint-fused-too-thin warning',
);
for (const warning of thinPlan.warnings) {
  if (warning.code === 'joint-fused-too-thin') {
    assert.equal(
      typeof warning.jointIndex,
      'number',
      'fused warning carries a jointIndex',
    );
  }
}

// --- Sphere: sane fallback, no crash ---------------------------------------

const sphere = makeUvSphere({ radius: 40 });
const spherePlan = planFlexiToy(sphere, DEFAULT_SETTINGS);
assert.ok(Array.isArray(spherePlan.joints), 'sphere produces a joints array');
assert.ok(spherePlan.spineLengthMm > 0, 'sphere spine length is positive');
assert.ok(
  spherePlan.spine.length > 1,
  'sphere produces a spine polyline (no crash)',
);

// --- Settings clamping ------------------------------------------------------

const tooMany = planFlexiToy(capsule, {
  ...DEFAULT_SETTINGS,
  segmentCount: 50,
});
assert.ok(
  tooMany.joints.length + 1 <= FLEXI_MAX_SEGMENTS,
  'segmentCount clamps to FLEXI_MAX_SEGMENTS',
);

const tooFew = planFlexiToy(capsule, {
  ...DEFAULT_SETTINGS,
  segmentCount: 1,
});
assert.ok(
  tooFew.joints.length + 1 >= FLEXI_MIN_SEGMENTS,
  'segmentCount clamps to FLEXI_MIN_SEGMENTS',
);

// --- computeFlexiScale + scaleFlexiPositions -------------------------------

const bigCapsule = makeSpindle({ length: 300, maxRadius: 24 });
const scale = computeFlexiScale(bigCapsule, DEFAULT_SETTINGS);
assert.ok(
  scale > 0.4 && scale < 0.6,
  `scale ~0.5 for 300mm -> 150mm (got ${scale})`,
);
const scaledPositions = scaleFlexiPositions(bigCapsule.positions, scale);
const scaledPlan = planFlexiToy(
  {
    positions: scaledPositions,
    indices: bigCapsule.indices,
    colors: bigCapsule.colors,
  },
  DEFAULT_SETTINGS,
);
assert.ok(
  Math.abs(scaledPlan.spineLengthMm - 150) < 15,
  `scaled spine ~150mm (got ${scaledPlan.spineLengthMm})`,
);

// --- FINDING 1: containment-aware sizing on a steep taper ------------------

// A 45° cone: radius drops 1mm per 1mm of axial length, so R(x) = 150 - x.
const CONE_LENGTH = 150;
const CONE_BASE = 150;
const steepCone = makeCone({ length: CONE_LENGTH, baseRadius: CONE_BASE });
const coneTrueRadius = (x) =>
  Math.max(0, CONE_BASE * (1 - Math.min(1, Math.max(0, x / CONE_LENGTH))));
const coneSettings = {
  segmentCount: 'auto',
  clearanceMm: 0.4,
  targetLengthMm: CONE_LENGTH,
  jointScale: 1.0,
  // Pin the axis: on this equal base/length cone PCA is ambiguous, and the test
  // reasons about the taper along x explicitly.
  axisOverride: 'x',
};

// (b) Demonstrate the OLD flaw: a single ±2mm slab at the cut plane
// (measureHalfExtent) over-measures the thin taper — its ring on the fat side
// biases `m` upward — so the ball is oversized and the socket carves through the
// true skin. Point chosen where the true body radius is ~5mm.
const breachX = CONE_LENGTH - 5; // true radius ≈ 5mm here
const oldM = measureHalfExtent(steepCone.positions, [breachX, 0, 0], [1, 0, 0]);
assert.ok(
  oldM > coneTrueRadius(breachX) + 1,
  `old single-slab measure is inflated over the true radius (m=${oldM}, trueR=${coneTrueRadius(breachX)})`,
);
const oldClearance = coneSettings.clearanceMm;
const oldBallRadius = Math.min(
  Math.max(0.55 * oldM, FLEXI_MIN_BALL_RADIUS_MM),
  oldM - oldClearance - FLEXI_MIN_SOCKET_WALL_MM,
);
assert.ok(
  oldBallRadius >= FLEXI_MIN_BALL_RADIUS_MM,
  'old code sizes (not fuses) this cut',
);
let oldWouldBreach = false;
{
  const reach = oldBallRadius + oldClearance;
  for (let s = 0; s <= 40; s += 1) {
    const d = -reach + (2 * reach * s) / 40;
    const socket = Math.sqrt(Math.max(0, reach * reach - d * d));
    if (socket > coneTrueRadius(breachX + d) + 0.02) {
      oldWouldBreach = true;
      break;
    }
  }
}
assert.ok(
  oldWouldBreach,
  'old ±2mm-slab sizing drives the socket through the true skin (the bug being fixed)',
);

// (a) MANDATORY: the new plan never breaches. For every live joint and every
// sampled offset across the ball's reach, the socket sphere cross-section stays
// inside the true body radius.
const conePlan = planFlexiToy(steepCone, coneSettings);
let coneLiveJoints = 0;
for (const joint of conePlan.joints) {
  if (joint.fused) continue;
  coneLiveJoints += 1;
  const reach = joint.ballRadiusMm + coneSettings.clearanceMm;
  const x = joint.center[0];
  for (let s = 0; s <= 24; s += 1) {
    const d = -reach + (2 * reach * s) / 24;
    const socket = Math.sqrt(Math.max(0, reach * reach - d * d));
    assert.ok(
      socket <= coneTrueRadius(x + d) + 1e-6,
      `steep-cone joint contained: socket ${socket} <= trueR ${coneTrueRadius(x + d)} at x=${x + d}`,
    );
  }
}
assert.ok(coneLiveJoints >= 1, 'steep cone still articulates somewhere');

// (c) The new code avoids the demonstrated breach by never placing a live joint
// in the thin danger zone — it fuses there instead.
for (const joint of conePlan.joints) {
  if (joint.fused) continue;
  assert.ok(
    coneTrueRadius(joint.center[0]) > oldBallRadius + oldClearance,
    'no live joint sits where the body is too thin to contain its socket',
  );
}

// (d) Gentle taper: a slender cone must still get plenty of live joints (the fix
// must not over-fuse normal bodies), and each must stay contained.
const gentleCone = makeCone({ length: 150, baseRadius: 22 });
const gentleTrueRadius = (x) =>
  Math.max(0, 22 * (1 - Math.min(1, Math.max(0, x / 150))));
const gentlePlan = planFlexiToy(gentleCone, {
  segmentCount: 'auto',
  clearanceMm: 0.4,
  targetLengthMm: 150,
  jointScale: 1.0,
  axisOverride: 'x',
});
const gentleLive = gentlePlan.joints.filter((joint) => !joint.fused);
assert.ok(
  gentleLive.length >= 3,
  `gentle taper still places joints (got ${gentleLive.length})`,
);
for (const joint of gentleLive) {
  const reach = joint.ballRadiusMm + 0.4;
  const x = joint.center[0];
  for (let s = 0; s <= 24; s += 1) {
    const d = -reach + (2 * reach * s) / 24;
    const socket = Math.sqrt(Math.max(0, reach * reach - d * d));
    assert.ok(
      socket <= gentleTrueRadius(x + d) + 1e-6,
      'gentle-taper joint stays contained',
    );
  }
}

// --- FINDING 2: no silent overlapping joints on short, fat bodies -----------

const shortFat = makeSpindle({ length: 80, maxRadius: 30, taper: 0.15 });
const shortFatPlan = planFlexiToy(shortFat, {
  segmentCount: 'auto',
  clearanceMm: 0.4,
  targetLengthMm: 80,
  jointScale: 1.4,
  axisOverride: 'x',
});
assert.ok(
  shortFatPlan.warnings.some((w) => w.code === 'joint-size-capped'),
  'short fat body warns that joints were size-capped',
);
const shortFatLive = shortFatPlan.joints.filter((joint) => !joint.fused);
assert.ok(shortFatLive.length >= 2, 'short fat body keeps articulating joints');
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
for (let i = 1; i < shortFatLive.length; i += 1) {
  const previous = shortFatLive[i - 1];
  const current = shortFatLive[i];
  const required = previous.ballRadiusMm + 0.4 + current.ballRadiusMm + 0.5;
  assert.ok(
    distance(previous.center, current.center) >= required,
    `adjacent live joints do not overlap (dist ${distance(previous.center, current.center)} >= ${required})`,
  );
}

console.log('flexiToyPlan.test.mjs: all assertions passed');
