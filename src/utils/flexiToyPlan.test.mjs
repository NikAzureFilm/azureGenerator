import assert from 'node:assert/strict';
import {
  planFlexiToy,
  computeFlexiScale,
  scaleFlexiPositions,
  socketMouthRadius,
  minSegmentLengthFor,
  solveStrongJointGeometry,
  strongPullPlay,
  solveLinkJointGeometry,
  solveLinkSeam,
  linkHoopPolyline,
  linkHoopOuterMm,
  linkKerfAtMm,
  linkBladeCapFits,
  linkBladeHeadCapMm,
  linkTravelSearch,
  LINK_SECONDARY_MAX_DEG,
  LINK_RING_WALL_MM,
  LINK_ENGAGE_MIN_MM,
  LINK_TILT_DEG,
  LINK_ARC_SEGMENTS,
  LINK_SECONDARY_INFLATE_MAX_MM,
  LINK_KERF_ALLOWANCE_MM,
  LINK_KERF_MAX_FRACTION,
  LINK_CLAMP_STEPS,
  LINK_TRAVEL_STEP_DEG,
  LINK_TRAVEL_MIN_DEG,
  LINK_BLADE_CAP_MARGIN_MM,
  LINK_BURY_MM,
  LINK_NEIGHBOUR_CLEAR_MM,
  LINK_CLIP_MARGIN_MM,
} from './flexiToyPlan.ts';
import {
  FLEXI_MIN_BALL_RADIUS_MM,
  FLEXI_MIN_SOCKET_WALL_MM,
  FLEXI_CAPTURE_MARGIN_MM,
  FLEXI_MAX_SEGMENTS,
  FLEXI_MIN_SEGMENTS,
  FLEXI_MAX_BEND_DEG,
  FLEXI_MAX_FACE_GAP_MM,
  isRoundedFamilyJointStyle,
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
  bendAngleDeg: 12,
  jointStyle: 'classic',
};

// Rotate a fixture around the z-axis so its spine tilts out of the x-axis (used
// to exercise the vertical-cut projection).
function rotateAroundZ(input, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const positions = new Float32Array(input.positions.length);
  for (let i = 0; i < input.positions.length; i += 3) {
    const x = input.positions[i];
    const y = input.positions[i + 1];
    positions[i] = x * c - y * s;
    positions[i + 1] = x * s + y * c;
    positions[i + 2] = input.positions[i + 2];
  }
  return { positions, indices: input.indices, colors: input.colors };
}

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
  bendAngleDeg: 12,
  jointStyle: 'classic',
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
  bendAngleDeg: 12,
  jointStyle: 'classic',
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
  bendAngleDeg: 12,
  jointStyle: 'classic',
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

// --- A: vertical cuts ------------------------------------------------------

// A gently tilted spine (30° up): the tangent has a real y-component, but the
// cut axis must be its horizontal projection, so axis.y ≈ 0.
const tiltedCapsule = rotateAroundZ(
  makeSpindle({ length: 150, maxRadius: 14 }),
  Math.PI / 6,
);
const tiltedPlan = planFlexiToy(tiltedCapsule, {
  ...DEFAULT_SETTINGS,
  axisOverride: 'auto',
});
const tiltedLive = tiltedPlan.joints.filter((joint) => !joint.fused);
assert.ok(tiltedLive.length >= 2, 'tilted spine still articulates');
for (const joint of tiltedLive) {
  assert.ok(
    Math.abs(joint.axis[1]) < 1e-6,
    `cut axis is vertical (axis.y≈0), got ${joint.axis[1]}`,
  );
  const magnitude = Math.hypot(joint.axis[0], joint.axis[1], joint.axis[2]);
  assert.ok(Math.abs(magnitude - 1) < 1e-6, 'cut axis is unit length');
}
assert.ok(
  !tiltedPlan.warnings.some((w) => w.code === 'cuts-not-vertical'),
  'a gently tilted spine does not warn',
);

// A body whose spine runs straight up (y axis): projection is unstable, so the
// raw tangent is kept and 'cuts-not-vertical' is emitted once.
const verticalBody = makeSpindle({ length: 150, maxRadius: 14, axis: 'y' });
const verticalPlan = planFlexiToy(verticalBody, {
  ...DEFAULT_SETTINGS,
  axisOverride: 'y',
});
const verticalLive = verticalPlan.joints.filter((joint) => !joint.fused);
assert.ok(verticalLive.length >= 1, 'vertical body still articulates');
assert.ok(
  verticalPlan.warnings.some((w) => w.code === 'cuts-not-vertical'),
  'a steeply vertical spine warns',
);
assert.equal(
  verticalPlan.warnings.filter((w) => w.code === 'cuts-not-vertical').length,
  1,
  'cuts-not-vertical is emitted once, not per joint',
);
for (const joint of verticalLive) {
  assert.ok(
    Math.abs(joint.axis[1]) > 0.9,
    'raw vertical axis kept when the projection is unstable',
  );
}

// --- B: bend-angle-driven face gaps ----------------------------------------

const bendCapsule = makeSpindle({ length: 150, maxRadius: 14 });
for (const bendAngleDeg of [5, 12, 25]) {
  for (const jointScale of [0.6, 1.0, 1.4]) {
    const plan = planFlexiToy(bendCapsule, {
      ...DEFAULT_SETTINGS,
      axisOverride: 'x',
      bendAngleDeg,
      jointScale,
    });
    for (const joint of plan.joints) {
      if (joint.fused) {
        assert.equal(joint.faceGapMm, 0, 'fused joint has zero face gap');
        continue;
      }
      const r = joint.ballRadiusMm;
      const h = joint.socketDepthMm;
      const g = joint.faceGapMm;
      assert.ok(g > 0, 'face gap is positive');
      assert.ok(
        g <= FLEXI_MAX_FACE_GAP_MM + 1e-9,
        'face gap under the ceiling',
      );
      assert.ok(
        g <= r - h - 0.2 + 1e-9,
        'face gap within the ball-connectivity budget',
      );
      // MANDATORY connectivity invariant: the ball still bridges the gap into
      // its own segment.
      assert.ok(
        r > h + g + 0.15,
        `ball bridges the face gap (r ${r} > h+g ${h + g} @ bend ${bendAngleDeg}, scale ${jointScale})`,
      );
    }
  }
}

// The gap is genuinely bend-driven: a wider bend opens a wider groove (until the
// connectivity budget caps it), so the max live gap grows from 5° to 25°.
const maxGapAt = (bendAngleDeg) => {
  const plan = planFlexiToy(bendCapsule, {
    ...DEFAULT_SETTINGS,
    axisOverride: 'x',
    bendAngleDeg,
  });
  return plan.joints.reduce(
    (max, joint) => (joint.fused ? max : Math.max(max, joint.faceGapMm)),
    0,
  );
};
assert.ok(
  maxGapAt(25) > maxGapAt(5) + 0.2,
  'a bigger bend angle opens a visibly wider face gap',
);

// --- C: explicit joint positions (draggable cuts) --------------------------

const positionCapsule = makeSpindle({ length: 150, maxRadius: 14 });

// Out-of-order + out-of-range + too-close input is sanitized into a strictly
// increasing, in-range, well-spaced set, and warns that it moved a cut.
const messyPositions = [0.8, 0.1, 0.82, 1.5, -0.2]; // 5 stations → segmentCount 6
const sanitizedPlan = planFlexiToy(positionCapsule, {
  ...DEFAULT_SETTINGS,
  segmentCount: 6,
  axisOverride: 'x',
  jointPositions: messyPositions,
});
assert.equal(
  sanitizedPlan.joints.length,
  5,
  'pinned positions keep the segment count (6 → 5 joints), no reduction',
);
const sanitizedFractions = sanitizedPlan.joints.map((j) => j.spineFraction);
for (let i = 1; i < sanitizedFractions.length; i += 1) {
  assert.ok(
    sanitizedFractions[i] > sanitizedFractions[i - 1],
    'sanitized stations are strictly increasing',
  );
}
for (const fraction of sanitizedFractions) {
  assert.ok(
    fraction >= 0.02 - 1e-9 && fraction <= 0.98 + 1e-9,
    `station clamped into range (got ${fraction})`,
  );
}
assert.ok(
  sanitizedPlan.warnings.some((w) => w.code === 'joint-positions-adjusted'),
  'sanitized positions emit joint-positions-adjusted',
);

// No jointPositions → even spacing, and spineFraction is echoed as i/N.
const evenPlan = planFlexiToy(positionCapsule, {
  ...DEFAULT_SETTINGS,
  segmentCount: 6,
  axisOverride: 'x',
});
const evenN = evenPlan.joints.length + 1;
evenPlan.joints.forEach((joint, i) => {
  assert.ok(
    Math.abs(joint.spineFraction - (i + 1) / evenN) < 1e-9,
    'even spacing echoes i/N in spineFraction',
  );
});

// Malformed jointPositions (wrong length) → ignored, even spacing + warning.
const malformedPlan = planFlexiToy(positionCapsule, {
  ...DEFAULT_SETTINGS,
  segmentCount: 6,
  axisOverride: 'x',
  jointPositions: [0.3, 0.6], // length 2 ≠ segmentCount − 1 = 5
});
assert.ok(
  malformedPlan.warnings.some((w) => w.code === 'joint-positions-adjusted'),
  'malformed positions warn',
);
const malformedN = malformedPlan.joints.length + 1;
malformedPlan.joints.forEach((joint, i) => {
  assert.ok(
    Math.abs(joint.spineFraction - (i + 1) / malformedN) < 1e-9,
    'malformed positions fall back to even spacing',
  );
});

// A station dragged onto a thin part fuses; the same count with the station on a
// thick part is live.
const taperForDrag = makeCone({ length: 150, baseRadius: 32 });
const draggedThin = planFlexiToy(taperForDrag, {
  ...DEFAULT_SETTINGS,
  segmentCount: 2,
  axisOverride: 'x',
  jointPositions: [0.9], // near the apex → thin
});
const draggedThick = planFlexiToy(taperForDrag, {
  ...DEFAULT_SETTINGS,
  segmentCount: 2,
  axisOverride: 'x',
  jointPositions: [0.3], // near the base → thick
});
assert.equal(draggedThin.joints.length, 1, 'one pinned station → one joint');
assert.equal(draggedThick.joints.length, 1, 'one pinned station → one joint');
assert.ok(draggedThin.joints[0].fused, 'a station on a thin part fuses');
assert.ok(
  !draggedThick.joints[0].fused,
  'the same station moved to a thick part becomes live',
);

// --- ROUNDED style: capture, travel, constant bowl gap --------------------

const roundedCapsule = makeSpindle({ length: 150, maxRadius: 14 });
const NECK_FLOOR_RAD = Math.asin(0.35);
const roundedPlanFor = (bendAngleDeg, jointScale = 1.0) =>
  planFlexiToy(roundedCapsule, {
    ...DEFAULT_SETTINGS,
    jointStyle: 'rounded',
    axisOverride: 'x',
    clearanceMm: 0.4,
    bendAngleDeg,
    jointScale,
  });

const jointTravelDeg = (joint, bendAngleDeg) => {
  const thetaMouth = Math.acos(
    Math.min(1, joint.socketDepthMm / (joint.ballRadiusMm + 0.4)),
  );
  const alpha = Math.max(
    NECK_FLOOR_RAD,
    thetaMouth - (bendAngleDeg * Math.PI) / 180,
  );
  return ((thetaMouth - alpha) * 180) / Math.PI;
};

for (const bendAngleDeg of [5, 12, 25]) {
  for (const jointScale of [0.6, 1.0, 1.4]) {
    const plan = roundedPlanFor(bendAngleDeg, jointScale);
    const live = plan.joints.filter((joint) => !joint.fused);
    assert.ok(live.length >= 1, 'rounded style articulates');
    for (const joint of live) {
      const r = joint.ballRadiusMm;
      const c = 0.4;
      const h = joint.socketDepthMm;
      assert.ok(
        r >= FLEXI_MIN_BALL_RADIUS_MM - 1e-6,
        `rounded ball >= floor (${r})`,
      );
      // Capture: the socket mouth stays inside the ball equator.
      const mouth = socketMouthRadius(r, c, h);
      assert.ok(
        mouth < r - FLEXI_CAPTURE_MARGIN_MM + 1e-6,
        'rounded capture margin holds',
      );
      assert.ok(mouth < r, 'rounded mouth radius below ball radius');
      // The 3° seam overlap widens the mouth shell slightly past θ_mouth; the
      // effective mouth must still stay captive (< r) across the envelope.
      const thetaMouth = Math.acos(Math.min(1, h / (r + c)));
      const seamMouth = (r + c) * Math.sin(thetaMouth + (3 * Math.PI) / 180);
      assert.ok(
        seamMouth < r,
        `rounded seam-widened mouth stays captive (${seamMouth.toFixed(2)} < ${r.toFixed(2)})`,
      );
      // Face gap now carries the constant bowl gap (concentric design).
      assert.ok(
        Math.abs(joint.faceGapMm - Math.max(c, 0.55)) < 1e-9,
        `rounded faceGapMm is the constant bowl gap (${joint.faceGapMm})`,
      );
      // Travel = θ_mouth − α_neck meets the requested bend until the neck floor.
      const thetaMouthDeg =
        (Math.acos(Math.min(1, h / (r + c))) * 180) / Math.PI;
      const achievable = Math.min(
        bendAngleDeg,
        thetaMouthDeg - (NECK_FLOOR_RAD * 180) / Math.PI,
      );
      assert.ok(
        jointTravelDeg(joint, bendAngleDeg) >= achievable - 1e-6,
        'rounded travel meets the requested bend (until the neck floor)',
      );
      // The whole cup (r + c + wall) stays inside the local skin.
      const m = measureHalfExtent(
        roundedCapsule.positions,
        joint.center,
        joint.axis,
      );
      assert.ok(
        m - (r + c + FLEXI_MIN_SOCKET_WALL_MM) >= -0.2,
        `rounded cup fits inside the skin (m ${m}, cup ${r + c + FLEXI_MIN_SOCKET_WALL_MM})`,
      );
    }
  }
}

// The actual achievable swing is proven geometrically in flexiToyBuild.test.mjs
// (rotate a built segment by the claimed travel and check it does not collide
// with its neighbour) rather than by re-deriving θ_mouth − α_neck here.

// --- STRONG style: solver invariants --------------------------------------

// The strong joint is NOT a cup/dome, so it must not inherit rounded sizing.
assert.equal(
  isRoundedFamilyJointStyle('strong'),
  false,
  'strong is not a rounded-family style',
);

const STRONG_RADII = [2.5, 3, 4, 5, 6, 8];
const STRONG_CLEARANCES = [0.3, 0.4, 0.55, 0.8];
const STRONG_BENDS = [5, 12, 25];

// (1) The solved joint honours all three contracts the head/bar solve exists to
// enforce, over the whole legal settings box:
//   · CAPTURE — the throat, at its narrowest plane, is at least
//     FLEXI_CAPTURE_MARGIN_MM narrower than the head. A ball of radius `rho`
//     cannot cross a planar hole whose smaller half-extent is under `rho`, so
//     this is what makes the joint captive under ANY rigid motion, not just the
//     pure axial pull the first design checked.
//   · RATTLE — pull-out slop stays inside `clearance + capture margin`. The
//     round-2 verifier measured 2.92mm here on the flat-rear gem; that gem is
//     gone and this is the assertion that keeps it gone.
//   · CONCENTRICITY — the pocket is a BALL of radius exactly `r + c`, which is
//     what makes travel clearance-preserving for free (law 2) and keeps the
//     isotropic containment gate honest.
let strongWideSeen = 0;
let strongPinnedSeen = 0;
for (const r of STRONG_RADII) {
  for (const c of STRONG_CLEARANCES) {
    for (const bendAngleDeg of STRONG_BENDS) {
      const geometry = solveStrongJointGeometry(r, c, bendAngleDeg);
      if (!geometry) continue;
      const throatMin = Math.min(
        geometry.throatInnerHalfMm,
        geometry.slotInnerHalfMm,
      );
      assert.ok(
        Math.abs(geometry.captureMarginMm - (r - throatMin)) < 1e-12,
        'the reported capture margin is head radius − narrowest throat half-extent',
      );
      assert.ok(
        geometry.captureMarginMm >= FLEXI_CAPTURE_MARGIN_MM - 1e-9,
        `strong keeps the capture margin (r=${r} c=${c} b=${bendAngleDeg}: ${geometry.captureMarginMm.toFixed(4)})`,
      );
      assert.ok(
        geometry.axialFreePlayMm <= c + FLEXI_CAPTURE_MARGIN_MM + 1e-9,
        `strong pull-out slop stays inside the budget (r=${r} c=${c} b=${bendAngleDeg}: ${geometry.axialFreePlayMm.toFixed(4)} vs ${(c + FLEXI_CAPTURE_MARGIN_MM).toFixed(2)})`,
      );
      assert.equal(
        geometry.headRadiusMm,
        r,
        'the head sphere IS the planned ball',
      );
      for (const reach of [
        geometry.cavityRadiusMm,
        geometry.cavityLatMm,
        geometry.cavityUpMm,
        geometry.cavityAxMm,
      ]) {
        assert.ok(
          Math.abs(reach - (r + c)) < 1e-12,
          `the pocket is concentric and isotropic (r=${r} c=${c} b=${bendAngleDeg})`,
        );
      }
      if (geometry.mode === 'pinned') {
        strongPinnedSeen += 1;
        assert.ok(
          geometry.bladeHalfMm < 0.35 * r - 1e-12,
          `pinned mode narrowed the bar (r=${r} c=${c} b=${bendAngleDeg})`,
        );
      } else {
        strongWideSeen += 1;
        assert.ok(
          Math.abs(geometry.bladeHalfMm - 0.35 * r) < 1e-12,
          `wide mode keeps the target bar width (r=${r} c=${c} b=${bendAngleDeg})`,
        );
      }
      assert.ok(
        2 * geometry.bladeHalfMm >= 1.4 - 1e-12,
        'a solved bar is at least the printable minimum width',
      );
      // Containment parity with `rounded`: the slot never out-demands the
      // pocket, so `strongCavityFits` can never be stricter than the cup gate.
      assert.ok(
        Math.max(geometry.throatOuterHalfMm, geometry.slotOuterHalfMm) <=
          geometry.cavityRadiusMm + 1e-9,
        `the throat slot never demands more room than the pocket (r=${r} c=${c} b=${bendAngleDeg})`,
      );
    }
  }
}
assert.ok(strongWideSeen > 0 && strongPinnedSeen > 0, 'both solve modes occur');

// (2) The pocket really does contain the swept head grown by the clearance —
// checked by SAMPLING actual rotated head-surface points, not by re-deriving the
// algebra that produced the pocket. This is the containment claim the whole
// travel guarantee rests on: rotation about the pivot preserves every radius, so
// a concentric ball `r + c` clears a head `r` by `c` at every bend and azimuth.
for (const r of [2.5, 4, 8]) {
  for (const c of [0.3, 0.55, 0.8]) {
    for (const bendAngleDeg of STRONG_BENDS) {
      const geometry = solveStrongJointGeometry(r, c, bendAngleDeg);
      if (!geometry) continue;
      const bend = (bendAngleDeg * Math.PI) / 180;
      const rodrigues = (p, m, phi) => {
        const cs = Math.cos(phi);
        const sn = Math.sin(phi);
        const d = m[0] * p[0] + m[1] * p[1] + m[2] * p[2];
        const x = [
          m[1] * p[2] - m[2] * p[1],
          m[2] * p[0] - m[0] * p[2],
          m[0] * p[1] - m[1] * p[0],
        ];
        return [0, 1, 2].map(
          (i) => p[i] * cs + x[i] * sn + m[i] * d * (1 - cs),
        );
      };
      let worst = 0;
      for (let i = 0; i <= 24; i += 1) {
        const polar = (Math.PI * i) / 24;
        for (let j = 0; j < 24; j += 1) {
          const azim = (2 * Math.PI * j) / 24;
          const p = [
            r * Math.sin(polar) * Math.cos(azim),
            r * Math.sin(polar) * Math.sin(azim),
            r * Math.cos(polar),
          ];
          for (let k = 0; k < 16; k += 1) {
            const psi = (2 * Math.PI * k) / 16;
            for (const phi of [bend, -bend, bend / 2]) {
              const q = rodrigues(p, [Math.cos(psi), Math.sin(psi), 0], phi);
              // grown by the clearance in the worst (radial) direction
              worst = Math.max(worst, Math.hypot(q[0], q[1], q[2]) + c);
            }
          }
        }
      }
      assert.ok(
        worst <= geometry.cavityRadiusMm + 1e-9,
        `the pocket contains the swept head + clearance (r=${r} c=${c} b=${bendAngleDeg}: ${worst.toFixed(6)} vs ${geometry.cavityRadiusMm})`,
      );
    }
  }
}

// (3) Feasibility is MONOTONE INCREASING in the ball radius — this is what
// licenses sizeJoint's "hard stop, do not keep shrinking" rule.
for (const c of STRONG_CLEARANCES) {
  for (const bendAngleDeg of STRONG_BENDS) {
    for (let r = 2.5; r <= 8.0001; r += 0.05) {
      if (!solveStrongJointGeometry(r, c, bendAngleDeg)) continue;
      assert.ok(
        solveStrongJointGeometry(r + 0.2, c, bendAngleDeg) !== null,
        `strong feasibility is monotone in r (r=${r.toFixed(2)} c=${c} b=${bendAngleDeg})`,
      );
    }
  }
}

// (4) Strong never spaces TIGHTER than rounded — the invariant that makes the
// build's per-joint rounded fallback always fit. No claim is made the other way.
for (const r of STRONG_RADII) {
  for (const c of STRONG_CLEARANCES) {
    for (const bendAngleDeg of STRONG_BENDS) {
      for (const extent of [0, 6, 10, 26]) {
        const strong = minSegmentLengthFor(
          r,
          c,
          'strong',
          bendAngleDeg,
          extent,
        );
        const rounded = minSegmentLengthFor(
          r,
          c,
          'rounded',
          bendAngleDeg,
          extent,
        );
        assert.ok(
          strong >= rounded - 1e-9,
          `strong pitch floor >= rounded (r=${r} c=${c} b=${bendAngleDeg} rho=${extent}: ${strong} vs ${rounded})`,
        );
      }
    }
  }
}

// (5) Containment: on the steep 45° cone the strong cavity is driven down by
// the same skin the rounded cup is, and never ends up LARGER than the rounded
// radius by more than one shrink step.
{
  const strongCone = planFlexiToy(steepCone, {
    ...coneSettings,
    jointStyle: 'strong',
  });
  const roundedCone = planFlexiToy(steepCone, {
    ...coneSettings,
    jointStyle: 'rounded',
  });
  const strongLive = strongCone.joints.filter((joint) => !joint.fused);
  assert.ok(
    strongLive.length >= 1,
    `strong still articulates the steep cone (got ${strongLive.length})`,
  );
  strongCone.joints.forEach((joint, index) => {
    if (joint.fused) return;
    const rounded = roundedCone.joints[index];
    if (rounded.fused) return;
    assert.ok(
      joint.ballRadiusMm <= rounded.ballRadiusMm + 0.2 + 1e-6,
      `strong ball is not larger than the rounded ball (joint ${index}: ${joint.ballRadiusMm} vs ${rounded.ballRadiusMm})`,
    );
  });
  for (const joint of strongLive) {
    // The whole cavity slab must stay a wall inside the true cone radius.
    const geometry = solveStrongJointGeometry(
      joint.ballRadiusMm,
      coneSettings.clearanceMm,
      coneSettings.bendAngleDeg,
    );
    assert.ok(geometry, 'a live strong joint always has a solved geometry');
    const x = joint.center[0];
    for (let s = 0; s <= 8; s += 1) {
      const d = -geometry.cavityAxMm + (2 * geometry.cavityAxMm * s) / 8;
      const need =
        Math.sqrt(
          Math.max(
            0,
            geometry.cavityRadiusMm * geometry.cavityRadiusMm - d * d,
          ),
        ) + FLEXI_MIN_SOCKET_WALL_MM;
      assert.ok(
        need <= coneTrueRadius(x + d) + 1e-6,
        `strong cavity stays a wall inside the cone (x=${x.toFixed(1)}, d=${d.toFixed(2)}: need ${need.toFixed(2)} vs ${coneTrueRadius(x + d).toFixed(2)})`,
      );
    }
  }
}

// (6) Every live strong joint is BUILDABLE — by whichever cutter the build will
// actually reach for.
//
// This is deliberately NOT "the solver can always realise the strong solid".
// The gem/bar solver returns null below roughly r = 3.2mm at loose clearance and
// max bend (the blade's hard width floor), and `sizeJoint` used to FUSE there.
// Measured cost of that rule: a 170mm slim tube at clearance 0.55 / bend 25°
// lost EVERY joint and exported one rigid body, while shell, rounded and classic
// all delivered six articulated bodies from the identical mesh. Such a joint is
// now planned as a live ROUNDED joint and the build falls back per joint,
// reporting 'strong-joint-fallback'. The invariant that keeps that safe is that
// the plan entry supports the rounded cutter, which is what is asserted here.
{
  const strongCapsule = makeSpindle({ length: 150, maxRadius: 14 });
  let solvable = 0;
  let fallback = 0;
  for (const bendAngleDeg of [5, 12, 25]) {
    for (const clearanceMm of [0.3, 0.4, 0.55]) {
      for (const jointScale of [0.6, 1.0, 1.4]) {
        const plan = planFlexiToy(strongCapsule, {
          ...DEFAULT_SETTINGS,
          jointStyle: 'strong',
          axisOverride: 'x',
          clearanceMm,
          bendAngleDeg,
          jointScale,
        });
        for (const joint of plan.joints) {
          if (joint.fused) continue;
          if (
            solveStrongJointGeometry(
              joint.ballRadiusMm,
              clearanceMm,
              bendAngleDeg,
            ) === null
          ) {
            fallback += 1;
          } else {
            solvable += 1;
          }
          assert.ok(
            Math.abs(joint.faceGapMm - Math.max(clearanceMm, 0.55)) < 1e-9,
            'strong carries the constant bowl gap in faceGapMm',
          );
          assert.ok(
            joint.socketDepthMm > 0,
            'strong keeps socketDepthMm meaningful for the rounded fallback',
          );
          assert.ok(
            minSegmentLengthFor(
              joint.ballRadiusMm,
              clearanceMm,
              'strong',
              bendAngleDeg,
              14,
            ) >=
              minSegmentLengthFor(
                joint.ballRadiusMm,
                clearanceMm,
                'rounded',
                bendAngleDeg,
                14,
              ) -
                1e-9,
            'a live strong joint always has at least the rounded pitch budget',
          );
        }
      }
    }
  }
  assert.ok(
    solvable > 0,
    'strong is still a strong joint on ordinary bodies (guard against the ' +
      'fallback quietly swallowing every case)',
  );
  assert.ok(
    solvable + fallback > 0,
    'the strong sweep planned at least one live joint',
  );
}

// (6b) Fix for the round-2 blocker: a body too slim for the strong SOLID keeps
// its articulation instead of going rigid. At clearance 0.55 / bend 25° the
// solver's floor is r ≈ 3.194mm, so a station whose ball lands just under that
// used to fuse; every joint fusing meant a single rigid export where the other
// three styles all articulated.
{
  // Sweep body width rather than pinning one magic radius: the assertion is
  // "wherever a live joint falls below the strong solver's floor, strong still
  // articulates exactly as much as rounded", and the sweep locates such joints
  // itself so the fixture cannot silently stop exercising the path.
  let belowFloorCases = 0;
  for (const maxRadius of [7, 8, 9, 10, 11, 12, 13, 14]) {
    const body = makeSpindle({ length: 170, maxRadius, axis: 'x' });
    const base = {
      ...DEFAULT_SETTINGS,
      axisOverride: 'x',
      segmentCount: 6,
      targetLengthMm: 170,
      clearanceMm: 0.55,
      bendAngleDeg: 25,
    };
    const strongPlan = planFlexiToy(body, { ...base, jointStyle: 'strong' });
    const roundedPlan = planFlexiToy(body, { ...base, jointStyle: 'rounded' });
    const liveStrong = strongPlan.joints.filter((j) => !j.fused);
    const liveRounded = roundedPlan.joints.filter((j) => !j.fused);
    const belowFloor = liveStrong.filter(
      (j) => solveStrongJointGeometry(j.ballRadiusMm, 0.55, 25) === null,
    );
    if (belowFloor.length === 0) continue;
    belowFloorCases += 1;
    assert.equal(
      liveStrong.length,
      liveRounded.length,
      `maxRadius ${maxRadius}: strong articulates exactly as much as rounded ` +
        `(${belowFloor.length} of its live joints are below the strong solver floor)`,
    );
  }
  assert.ok(
    belowFloorCases > 0,
    'the slim sweep found at least one body below the strong solver floor ' +
      '(otherwise this block asserts nothing)',
  );
}

// (7) Dragged stations survive on the strong style and spread to its floor.
{
  const dragCapsule = makeSpindle({ length: 150, maxRadius: 14 });
  const dragged = planFlexiToy(dragCapsule, {
    ...DEFAULT_SETTINGS,
    jointStyle: 'strong',
    segmentCount: 5,
    axisOverride: 'x',
    jointPositions: [0.2, 0.22, 0.6, 0.9],
  });
  assert.equal(
    dragged.joints.length,
    4,
    'strong keeps the pinned station count (5 segments → 4 joints)',
  );
  const fractions = dragged.joints.map((joint) => joint.spineFraction);
  for (let i = 1; i < fractions.length; i += 1) {
    assert.ok(
      fractions[i] > fractions[i - 1],
      'strong dragged stations stay strictly increasing',
    );
  }
  const live = dragged.joints.filter((joint) => !joint.fused);
  if (live.length >= 2) {
    const floor = minSegmentLengthFor(
      live.reduce((max, joint) => Math.max(max, joint.ballRadiusMm), 0),
      DEFAULT_SETTINGS.clearanceMm,
      'strong',
      DEFAULT_SETTINGS.bendAngleDeg,
      undefined,
    );
    assert.ok(floor > 0, 'strong reports a positive spacing floor');
  }
  assert.ok(
    dragged.warnings.some((w) => w.code === 'joint-positions-adjusted'),
    'strong reports that the too-close dragged cuts were nudged',
  );
}

// (8) Round-1 verifier regression: the tapered THROAT SLOT must contain the
// swept BAR, not just the swept gem.
//
// The spec proves the cavity is a superset of the gem's swept envelope and then
// sizes the slot per axis — `|v'| ≤ bh/cosβ + d·tanβ`, exact for a pure yaw. It
// is NOT exact for a rectangle bending about an oblique azimuth: the other
// half-extent leaks in through the corner. And between the gem's rear face and
// the cavity's tail wall the bar used to be covered only by the CAVITY, whose
// octahedral faces know nothing about it. Measured before the fix: 0.83 mm of
// interference at bend 25°, costing 3.4° of the contracted travel.
//
// This is the same check the build's cutter realises: slot half-extents
// `base + taper·depth` from the pivot plane out past the head segment's face.
{
  const rodrigues = (p, m, phi) => {
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    const d = m[0] * p[0] + m[1] * p[1] + m[2] * p[2];
    const x = [
      m[1] * p[2] - m[2] * p[1],
      m[2] * p[0] - m[0] * p[2],
      m[0] * p[1] - m[1] * p[0],
    ];
    return [0, 1, 2].map((i) => p[i] * c + x[i] * s + m[i] * d * (1 - c));
  };
  // How far the point pokes OUT of (cavity ∪ slot ∪ the seam void); ≤ 0 is safe.
  const intrusion = (q, g) => {
    const [v, u, s] = q;
    const depth = -s;
    if (depth > g.faceOffsetMm) return -Infinity;
    const cavity = Math.hypot(v, u, s) - g.cavityRadiusMm;
    let slot = Infinity;
    if (depth >= 0) {
      slot = Math.max(
        Math.abs(v) - (g.throatBaseHalfMm + g.throatTaper * depth),
        Math.abs(u) - (g.slotBaseHalfMm + g.throatTaper * depth),
      );
    }
    return Math.min(cavity, slot);
  };
  let worst = -Infinity;
  let worstCell = '';
  for (const r of [2.5, 3, 4, 5, 6, 8]) {
    for (const c of [0.3, 0.4, 0.55, 0.8]) {
      for (const bendAngleDeg of [5, 12, 25]) {
        const g = solveStrongJointGeometry(r, c, bendAngleDeg);
        if (!g) continue;
        const bend = (bendAngleDeg * Math.PI) / 180;
        const sTop = 0.2;
        const sRoot = -g.faceOffsetMm - Math.max(2, 0.5 * r);
        for (let i = 0; i <= 48; i += 1) {
          const s = sRoot + ((sTop - sRoot) * i) / 48;
          for (const sv of [1, -1]) {
            for (const su of [1, -1]) {
              const p = [sv * g.bladeHalfMm, su * g.bladeHeightHalfMm, s];
              for (let k = 0; k < 48; k += 1) {
                const psi = (k / 48) * 2 * Math.PI;
                const value = intrusion(
                  rodrigues(p, [Math.cos(psi), Math.sin(psi), 0], bend),
                  g,
                );
                if (value > worst) {
                  worst = value;
                  worstCell = `r=${r} c=${c} b=${bendAngleDeg}`;
                }
              }
            }
          }
        }
      }
    }
  }
  assert.ok(
    worst <= 0,
    `the swept bar stays inside cavity ∪ slot at every bend azimuth (worst ${worst.toFixed(4)}mm at ${worstCell})`,
  );
}

// (9) Round-2 verifier regression: free play is bounded, and by the CONTRACT
// rather than by whatever the solver happens to produce.
//
// The flat-rear gem gave `r·sinβ + c − S(1 + sinβ − cosβ)` of pull-out — up to
// 2.92mm measured on a 200mm toy, 4× the reference model's 0.72mm — because a
// flat face is not rotation-invariant and the pocket had to clear its swept
// corner. The spherical head has no swept corner: five directions give exactly
// the clearance, and the sixth is limited only by how far out the throat slot
// interrupts the bearing surface.
{
  let maxAxial = 0;
  for (const r of [2.5, 3, 4, 5, 6, 8]) {
    for (const c of [0.3, 0.4, 0.55, 0.8]) {
      for (const bendAngleDeg of [5, 12, 25]) {
        const g = solveStrongJointGeometry(r, c, bendAngleDeg);
        if (!g) continue;
        assert.ok(
          Math.abs(
            g.axialFreePlayMm - strongPullPlay(r, c, g.bearingRadiusMm),
          ) < 1e-12,
          `pull-out slop is the concentric-ball chord at the bearing radius (r=${r} c=${c} b=${bendAngleDeg})`,
        );
        assert.ok(
          g.axialFreePlayMm <= c + FLEXI_CAPTURE_MARGIN_MM + 1e-9,
          `pull-out slop stays inside clearance + capture margin (r=${r} c=${c} b=${bendAngleDeg}: ${g.axialFreePlayMm.toFixed(4)})`,
        );
        assert.ok(
          g.axialFreePlayMm >= c - 1e-9,
          `pull-out slop is never LESS than the clearance (r=${r} c=${c} b=${bendAngleDeg})`,
        );
        // The five uninterrupted directions give the clearance, plus only the
        // facet allowance of the built spheres (a couple of hundredths).
        assert.ok(
          g.verticalFreePlayMm === g.lateralFreePlayMm &&
            g.lateralFreePlayMm >= c - 1e-12 &&
            g.lateralFreePlayMm <= c + 0.05,
          `the five uninterrupted directions give the clearance (r=${r} c=${c} b=${bendAngleDeg}: ${g.lateralFreePlayMm.toFixed(4)} vs ${c})`,
        );
        maxAxial = Math.max(maxAxial, g.axialFreePlayMm);
      }
    }
  }
  // The documented envelope, not a wish: these are the numbers the style ships.
  assert.ok(
    maxAxial < 1.11,
    `pull-out slop over the legal box tops out at the loosest budget (got ${maxAxial.toFixed(3)})`,
  );
}

// --- LINK style: solver invariants ----------------------------------------

// (P0) Link shares neither the rounded cup-containment gate nor the bowl gap
// (its faceGapMm is only the fallback's carrier), so the decision that it is not
// a rounded-family style is RECORDED here rather than inherited by accident.
assert.equal(
  isRoundedFamilyJointStyle('link'),
  false,
  'link is not a rounded-family style',
);

const LINK_RADII = [3.2, 3.5, 4, 5, 6, 8, 10, 12];
const LINK_CLEARANCES = [0.3, 0.4, 0.55, 0.8];
const LINK_BENDS = [5, 8, 12, 25];
const LINK_KEY_PAD_MIN_MM = 0.5;
const LINK_BLADE_MIN_MM = 1.6;
// The DELIVERED ring wall is checked against this hard-coded literal, never
// against the imported `LINK_RING_WALL_MM`. Comparing solver output to the
// constant that produced it moves together under mutation: zeroing the constant
// zeroes the threshold and the assertion passes vacuously. That is not
// hypothetical here — `bladeReachMm = max(eyeOuter + wall + slack, 0.95·r)`, and
// the 0.95·r floor dominates everywhere EXCEPT r ≈ 3.2–3.5, so the constant is
// the only thing holding the contract in exactly the band this sweep visits
// first. With the constant zeroed the delivered wall falls to 1.188mm at
// r = 3.2, c = 0.55 — under the published 1.2mm — and every imported-constant
// assertion still passes. This literal is what actually catches that.
const LINK_RING_WALL_CONTRACT_MM = 1.2;
const LINK_TUBE_MIN_MM = 0.8;
const LINK_LEG_SLAB_MARGIN_MM = 0.05;
const LINK_MIN_HEAD_RADIUS_CONTRACT_MM = 3.2;
const LINK_KERF_MIN_CONTRACT_MM = 0.8;
const LINK_KERF_CLEAR_CONTRACT_MM = 0.25;
const LINK_ENGAGE_CONTRACT_MM = 1;
// The four acceptance-body stations, as `[r, rhoSkin, rhoMax]`. Measured on
// `tmp/trout-source.stl` (the union of the five welded components of the user's
// own export) at SHELL_DEFAULTS + link: 400mm, 5 segments, jointScale 1.
const TROUT_STATIONS = [
  [4.679, 9.828, 43.197],
  [6.698, 13.75, 37.034],
  [7.236, 15.096, 39.23],
  [6.819, 14.191, 31.938],
];

// The published contract constants, pinned to LITERALS. Every other assertion
// below (and every built-solid probe in the build suite) compares against the
// IMPORTED constants — which is right, because a solver-vs-solver comparison
// moves together and would survive gutting the geometry. But it leaves one hole:
// zeroing a constant makes every assertion that reads it VACUOUSLY true. These
// three literals close it, so a mutation to any of them fails here in one second
// rather than passing a seven-minute build suite unnoticed.
assert.equal(LINK_RING_WALL_MM, 1.2, 'link ring wall contract is 1.2mm');
assert.equal(
  LINK_RING_WALL_MM,
  FLEXI_MIN_SOCKET_WALL_MM,
  'link ring wall tracks the shared printable wall floor',
);
assert.equal(LINK_ENGAGE_MIN_MM, 1, 'link engagement floor contract is 1.0mm');
assert.equal(
  LINK_TILT_DEG,
  38,
  'link hoop tilt contract is 38° (52° overhang)',
);
assert.equal(
  LINK_SECONDARY_INFLATE_MAX_MM,
  0.45,
  'link secondary allowance cap contract is 0.45mm',
);
assert.equal(
  LINK_KERF_ALLOWANCE_MM,
  4.5,
  'link kerf allowance contract is 4.5mm',
);
assert.equal(
  LINK_KERF_MAX_FRACTION,
  0.3,
  'link kerf share of the local radius contract is 0.30',
);
// (L-CONTRACT) The rest of the published numbers, as LITERALS. Zeroing any of
// them must fail in one second here rather than pass a seven-minute build suite
// by making every assertion that reads them vacuously true.
assert.equal(
  LINK_MIN_HEAD_RADIUS_CONTRACT_MM,
  3.2,
  'contract table is self-consistent',
);
assert.equal(LINK_TRAVEL_STEP_DEG, 0.05, 'link travel grid contract is 0.05°');
assert.equal(
  LINK_CLAMP_STEPS,
  9,
  'link ladder bisection budget contract is 9 = ceil(log2(481))',
);
assert.equal(LINK_TRAVEL_MIN_DEG, 1, 'link travel floor contract is 1°');
// Derived from the SLIDER's own maximum, not from a literal 25. The budget is
// `ceil(log2(gridPoints))`, so raising `FLEXI_MAX_BEND_DEG` or shrinking
// `LINK_TRAVEL_STEP_DEG` without raising the budget would silently truncate the
// bisection — the result would stay feasible and safe, but would no longer be
// provably the largest feasible grid point, which is the property the constant
// exists to guarantee. Written as `>=` on the count so it fails from BOTH sides:
// lowering the budget (9 → 8) and refining the grid both break it.
assert.ok(
  Math.pow(2, LINK_CLAMP_STEPS) >=
    (FLEXI_MAX_BEND_DEG - LINK_TRAVEL_MIN_DEG) / LINK_TRAVEL_STEP_DEG + 1,
  `the bisection budget (${LINK_CLAMP_STEPS} steps) really does cover the whole ${FLEXI_MAX_BEND_DEG}° grid`,
);
assert.equal(
  LINK_BLADE_CAP_MARGIN_MM,
  0.2,
  'link blade head-cap margin contract is 0.2mm',
);
assert.equal(LINK_BURY_MM, 0.6, 'link leg bury contract is 0.6mm');
// Declared in the plan module but READ only by the build, so nothing in this
// one-second suite could see either of them being zeroed — a mutation sweep
// found both silently survivable. They are safety margins (a neighbour's kerf
// must not touch mine; the skin clip must stand off the measured rim), so
// zeroing them is a deliberate two-file edit from here on.
assert.equal(
  LINK_NEIGHBOUR_CLEAR_MM,
  0.3,
  'link neighbour clearance contract is 0.3mm',
);
assert.equal(
  LINK_CLIP_MARGIN_MM,
  0.3,
  'link skin-clip margin contract is 0.3mm',
);
// The `rhoClip` probe band the build reads is derived from the ALLOWANCE, never
// from the solved kerf. Pinned here because widening it would loosen the clip on
// exactly the fins it exists to keep the hoop clear of.
assert.equal(
  LINK_KERF_ALLOWANCE_MM / 2 + 1,
  3.25,
  'link skin-clip probe band contract is 3.25mm',
);
// `legSlabClearMm ≥ 0` is a knife edge BY CONSTRUCTION, and this identity is
// what makes it one. A reassociation that flips the sign is caught here.
assert.equal(
  LINK_KEY_PAD_MIN_MM,
  LINK_SECONDARY_INFLATE_MAX_MM + LINK_LEG_SLAB_MARGIN_MM,
  'link key pad is exactly the secondary allowance plus the slab margin',
);

// (P1) The solver's own contracts, over the whole legal box. Every one of these
// is a property the CARVED eye and the ladder's monotonicity rest on.
for (const r of LINK_RADII) {
  for (const c of LINK_CLEARANCES) {
    for (const bendAngleDeg of LINK_BENDS) {
      const g = solveLinkJointGeometry(r, c, bendAngleDeg);
      assert.ok(
        g,
        `link solves inside the box (r=${r} c=${c} b=${bendAngleDeg})`,
      );
      const where = `r=${r} c=${c} b=${bendAngleDeg}`;
      assert.ok(
        g.ringWallMm >= LINK_RING_WALL_CONTRACT_MM - 1e-9,
        `link keeps blade material round the eye (${where}: ${g.ringWallMm.toFixed(4)} < ${LINK_RING_WALL_CONTRACT_MM})`,
      );
      assert.ok(
        g.legSlabClearMm >= -1e-9,
        `link legs stay out of the blade slab (${where}: ${g.legSlabClearMm.toFixed(4)})`,
      );
      assert.ok(
        g.bladeThicknessMm >= LINK_BLADE_MIN_MM - 1e-9,
        `link blade is printable (${where}: ${g.bladeThicknessMm.toFixed(3)})`,
      );
      assert.ok(
        g.tubeRadiusMm >= LINK_TUBE_MIN_MM - 1e-9,
        `link rod is printable (${where}: ${g.tubeRadiusMm.toFixed(3)})`,
      );
      assert.ok(
        g.pivotOffsetMm > 0,
        `link pivot sits head-ward of the cut plane (${where})`,
      );
      assert.ok(
        g.keyGapMm >= c + LINK_KEY_PAD_MIN_MM - 1e-9,
        `link key gap keeps its floor (${where}: ${g.keyGapMm.toFixed(4)})`,
      );
      // The eye-open inequality: the FAT arc's inner face clears the FAT blade
      // slab, which is why the ring can never close across the plate.
      assert.ok(
        g.hoopRadiusMm - (g.tubeRadiusMm + c) >
          g.bladeThicknessMm / 2 + c + 1e-9,
        `link arc clears the fat blade slab (${where})`,
      );
      // Every ARC point lies within the blade's own reach of the pin axis (an
      // arc point at φ sits exactly `Rm·(1 − cos φ)` from it), which is what
      // licenses `linkHoopPolyline` to cap the pitch sagitta at that radius: the
      // cap then provably only ever touches the LEGS, which are buried in tail
      // material where there is no head material to collide with.
      const arcAxisMax = g.hoopRadiusMm * (1 - Math.cos(g.arcHalfAngleRad));
      assert.ok(
        arcAxisMax < g.bladeReachMm,
        `link arc lies inside the blade reach (${where}: ${arcAxisMax.toFixed(3)} vs ${g.bladeReachMm.toFixed(3)})`,
      );
    }
  }
}

// (P2) The build's travel ladder solves the GEOMETRY once and then walks only
// the seam, so what the ladder's monotonicity actually needs is:
//   (a) `solveLinkSeam` never moves the pivot offset (or any other geometry
//       field) — it is a pure function of a frozen geometry, and
//   (b) with the geometry frozen, the kerf is MONOTONE NON-DECREASING in the
//       travel, which is what makes every gated quantity (engagement, envelope
//       radius, both neighbour reaches, the anchor depth) move the right way as
//       the ladder steps down.
//
// SPEC DEVIATION, recorded here rather than hidden: the design also claimed
// `pivotOffsetMm` is identical for every bend angle. It is not — `eyeOuterMm`
// carries a bend-driven sagitta term and, on small joints, that term is what
// binds `bladeReachMm` (measured: r=3.2, c=0.3 gives q = 1.1415 at bend 5 and
// 1.1625 at bend 8). Nothing depends on the stronger claim; the ladder holds the
// geometry FIXED, which is the property asserted below.
for (const r of LINK_RADII) {
  for (const c of LINK_CLEARANCES) {
    for (const bendAngleDeg of LINK_BENDS) {
      const g = solveLinkJointGeometry(r, c, bendAngleDeg);
      const frozen = JSON.stringify(g);
      for (const rho of [0, 1.5, 4, 12, 30]) {
        let previous = null;
        // (L-KERF-MONO-T) Walked on the ABSOLUTE grid the ladder now searches,
        // not on a ladder whose rungs move with the request. Every quantity the
        // bisection gates on has to move the same way, at 40 radii — that is the
        // whole precondition for the search being EXACT rather than a sample.
        for (
          let travel = 1;
          travel <= bendAngleDeg + 1e-9;
          travel += LINK_TRAVEL_STEP_DEG * 20
        ) {
          const seam = solveLinkSeam(g, rho, c, travel);
          const where = `r=${r} c=${c} rho=${rho} travel=${travel.toFixed(2)}`;
          assert.ok(
            Number.isFinite(seam.kerfMm) && seam.kerfMm > 0,
            `link seam is finite (${where})`,
          );
          if (previous) {
            assert.ok(
              seam.kerfMm >= previous.kerfMm - 1e-12 &&
                seam.legKerfMm >= previous.legKerfMm - 1e-12 &&
                seam.kneeDepthMm >= previous.kneeDepthMm - 1e-12,
              `link kerf, leg kerf and knee are monotone in travel (${where})`,
            );
            for (let j = 0; j <= 40; j += 1) {
              const probe = (60 * j) / 40;
              assert.ok(
                linkKerfAtMm(seam, probe) >=
                  linkKerfAtMm(previous, probe) - 1e-12,
                `link kerf law is monotone in travel at rho=${probe.toFixed(1)} (${where})`,
              );
            }
          }
          previous = seam;
          assert.equal(
            JSON.stringify(g),
            frozen,
            'solveLinkSeam never mutates the geometry it is handed',
          );
        }
      }
    }
  }
}

// (P3) Feasibility is MONOTONE INCREASING in r — same obligation as strong's.
for (const c of LINK_CLEARANCES) {
  for (const bendAngleDeg of LINK_BENDS) {
    for (let r = 2.5; r <= 12.0001; r += 0.05) {
      if (!solveLinkJointGeometry(r, c, bendAngleDeg)) continue;
      assert.ok(
        solveLinkJointGeometry(r + 0.2, c, bendAngleDeg) !== null,
        `link feasibility is monotone in r (r=${r.toFixed(2)} c=${c} b=${bendAngleDeg})`,
      );
    }
  }
}

// (P4) Link never spaces TIGHTER than rounded — what makes the build's per-joint
// rounded fallback always fit. (Measured: link's own footprint essentially never
// binds for r ≤ 12; the `max` is kept as the safety net this pins.)
for (const r of [2.5, 3, 4, 5, 6, 8, 10, 12]) {
  for (const c of LINK_CLEARANCES) {
    for (const bendAngleDeg of LINK_BENDS) {
      for (const extent of [0, 6, 10, 26]) {
        const link = minSegmentLengthFor(r, c, 'link', bendAngleDeg, extent);
        const rounded = minSegmentLengthFor(
          r,
          c,
          'rounded',
          bendAngleDeg,
          extent,
        );
        assert.ok(
          link >= rounded - 1e-9,
          `link pitch floor >= rounded (r=${r} c=${c} b=${bendAngleDeg} rho=${extent}: ${link} vs ${rounded})`,
        );
      }
    }
  }
}

// (P5) The footprint is MONOTONE NON-DECREASING in r. `jointOverlapCap`'s
// bisection is only well posed because of this; a V-shaped footprint would make
// the cap it returns meaningless.
for (const c of LINK_CLEARANCES) {
  for (const bendAngleDeg of LINK_BENDS) {
    for (const extent of [0, 6, 12, 26]) {
      let previous = -Infinity;
      for (let r = 3.2; r <= 12.0001; r += 0.05) {
        const floor = minSegmentLengthFor(r, c, 'link', bendAngleDeg, extent);
        assert.ok(
          floor >= previous - 1e-9,
          `link pitch floor is monotone in r (r=${r.toFixed(2)} c=${c} b=${bendAngleDeg} rho=${extent}: ${floor} < ${previous})`,
        );
        previous = floor;
      }
    }
  }
}

// (P6) The eye estimate is CONSERVATIVE, and — the claim it rests on — the LEGS
// never reach the blade slab at all, so maximising over the ARC alone is sound.
// Walked on the very polyline the build emits, at every kerf from the floor to
// the ceiling (the legs move with the kerf; the arc does not).
//
// A wrong estimate here can only cost a rounded fallback, never a fused part —
// but if it were OPTIMISTIC the ring-wall contract would be a fiction, and
// nothing downstream would notice.
for (const r of LINK_RADII) {
  for (const c of LINK_CLEARANCES) {
    for (const bendAngleDeg of LINK_BENDS) {
      const g = solveLinkJointGeometry(r, c, bendAngleDeg);
      for (const rho of [1, 4, 10, 30]) {
        const seam = solveLinkSeam(g, rho, c, bendAngleDeg);
        const poly = linkHoopPolyline(g, seam, c);
        let worst = 0;
        for (let i = 0; i < poly.points.length; i += 1) {
          const [v, u, s] = poly.points[i];
          const radius = poly.envRadiusMm[i];
          const excess = Math.max(0, Math.abs(v) - g.bladeThicknessMm / 2);
          const arc = i >= 2 && i < poly.points.length - 2;
          if (!arc) {
            // A LEG sphere. It must miss the blade slab outright — that is the
            // hypothesis `eyeOuterMm` is computed under.
            assert.ok(
              excess >= radius - 1e-9,
              `link legs never reach the blade slab (r=${r} c=${c} b=${bendAngleDeg} rho=${rho} i=${i}: excess ${excess.toFixed(4)} < radius ${radius.toFixed(4)})`,
            );
            continue;
          }
          if (excess >= radius) continue;
          const d = Math.hypot(u, s - g.pivotOffsetMm);
          worst = Math.max(
            worst,
            d + Math.sqrt(radius * radius - excess * excess),
          );
        }
        assert.ok(
          worst <= g.eyeOuterMm + 1e-9,
          `link eye estimate is conservative (r=${r} c=${c} b=${bendAngleDeg} rho=${rho}: ${worst.toFixed(4)} vs ${g.eyeOuterMm.toFixed(4)})`,
        );
      }
    }
  }
}

// (P7 / P-CLIMB) Printability of the hoop centreline. Every span outside the two
// buried anchor runs either climbs at the tilt angle (a 52° overhang, inside the
// normal FDM window) or is in the arch-apex window near the crown, where the
// feature is geometrically the top of a horizontal hole; and that hole never
// exceeds 15mm across on the largest body the sizing can produce.
for (const r of LINK_RADII) {
  for (const c of LINK_CLEARANCES) {
    for (const bendAngleDeg of LINK_BENDS) {
      const g = solveLinkJointGeometry(r, c, bendAngleDeg);
      const seam = solveLinkSeam(g, 10, c, bendAngleDeg);
      const poly = linkHoopPolyline(g, seam, c);
      const points = poly.points;
      const n = LINK_ARC_SEGMENTS;
      const climbOf = (i) => {
        const previous = points[i - 1];
        const current = points[i];
        const rise = Math.abs(current[1] - previous[1]);
        const run = Math.hypot(
          current[0] - previous[0],
          current[2] - previous[2],
        );
        return (Math.atan2(rise, run) * 180) / Math.PI;
      };
      const where = `r=${r} c=${c} b=${bendAngleDeg}`;
      // The two buried anchors run horizontally: they union with solid tail
      // material and are not an unsupported feature at all.
      for (const i of [1, points.length - 1]) {
        assert.ok(
          climbOf(i) < 1e-6,
          `link anchor runs horizontal (${where} i=${i}: ${climbOf(i).toFixed(3)}°)`,
        );
      }
      // The two legs descend at EXACTLY the tilt angle — a 52° overhang, inside
      // the normal FDM window.
      for (const i of [2, points.length - 2]) {
        assert.ok(
          Math.abs(climbOf(i) - LINK_TILT_DEG) < 0.5,
          `link leg descends at the tilt angle (${where} i=${i}: ${climbOf(i).toFixed(2)}° vs ${LINK_TILT_DEG})`,
        );
      }
      // SPEC DEVIATION, recorded: the design asserted every non-anchor span
      // climbs at ≥ tilt unless it is in an arch-apex window. That is false — the
      // arc's climb rises smoothly from 0° at the crown to ~33° at its ends (it
      // only approaches the tilt as φ → 90°), so at r=3.2 span 3 measures 31.2°.
      // The statement that is both TRUE and the one printability actually cares
      // about is asserted instead: NO span is steeper than the legs, i.e. the
      // hoop never presents an overhang worse than the 52° the legs already do,
      // and the arch is a plain horizontal-hole roof whose span stays printable.
      for (let i = 3; i <= 2 + 2 * n; i += 1) {
        assert.ok(
          climbOf(i) <= LINK_TILT_DEG + 0.5,
          `link arc is never steeper than the legs (${where} i=${i}: ${climbOf(i).toFixed(2)}°)`,
        );
      }
      assert.ok(
        climbOf(2 + n) < 12,
        `link arc is near-flat at the crown, i.e. a bridged arch (${where}: ${climbOf(2 + n).toFixed(2)}°)`,
      );
      assert.ok(
        2 * g.legOffsetMm <= 15,
        `link arch span stays printable (r=${r} c=${c} b=${bendAngleDeg}: ${(2 * g.legOffsetMm).toFixed(2)}mm)`,
      );
      assert.equal(
        points.length,
        2 * LINK_ARC_SEGMENTS + 5,
        'link polyline has 2n+5 points',
      );
    }
  }
}

// (P8) `solveLinkSeam` is TOTAL. The degenerate station (`maxStationExtentMm`
// documents 0 as reachable) must not produce a negative or infinite travel.
for (const c of LINK_CLEARANCES) {
  const g = solveLinkJointGeometry(5, c, 12);
  const seam = solveLinkSeam(g, 0, c, 12);
  assert.equal(
    seam.kerfMm,
    seam.kerfFloorMm,
    `link kerf falls back to its floor at rho = 0 (c=${c})`,
  );
  assert.ok(
    seam.kerfFloorMm >=
      Math.max(LINK_KERF_MIN_CONTRACT_MM, c + LINK_KERF_CLEAR_CONTRACT_MM) -
        1e-12,
    `link kerf floor keeps the printable minimum at rho = 0 (c=${c}: ${seam.kerfFloorMm})`,
  );
  assert.ok(
    Number.isFinite(seam.travelDeg) &&
      seam.travelDeg > 0 &&
      seam.travelDeg <= 12,
    `link travel stays finite and positive at rho = 0 (c=${c}: ${seam.travelDeg})`,
  );
  assert.ok(
    Number.isFinite(seam.engagementMm) && Number.isFinite(seam.outerRadiusMm),
    'link seam reports finite engagement and outer radius at rho = 0',
  );
  // And the look ceiling really does bind on a chunky body — as a TRAVEL cap,
  // never as a clamp on the profile.
  const chunky = solveLinkSeam(g, 40, c, 25);
  assert.ok(
    chunky.travelDeg < 25 - 1e-9 &&
      Math.abs(chunky.travelDeg - chunky.travelCapDeg) < 1e-9,
    'link reports a REDUCED travel when the ceiling binds (never silently full)',
  );
  assert.ok(
    linkKerfAtMm(chunky, LINK_KERF_ALLOWANCE_MM / LINK_KERF_MAX_FRACTION) <=
      LINK_KERF_ALLOWANCE_MM + 1e-9,
    'link kerf respects the allowance at the ceiling breakpoint radius',
  );
  assert.ok(
    linkKerfAtMm(chunky, 40) <= LINK_KERF_MAX_FRACTION * 40 + 1e-9,
    'link kerf respects its share of the local radius out at the skin',
  );
}

// (L-KERF-LAW) The law itself, over the whole box: non-decreasing, convex,
// above the graded line at every interior radius, exactly the floor on the axis,
// and a slope that is EXACTLY `2·tan(T/2)`.
//
// The last identity is the one that kills the two mutations this design exists
// to prevent: the `−q·y²` pivot-relief term of a FLAT face (which interferes —
// see L-GAP) and any regrading that makes the slope a function of the station.
for (const r of [3.2, 4.679, 6.698, 7.236, 10.13, 15]) {
  for (const c of [0.2, 0.3, 0.4, 0.55, 0.8]) {
    for (const bendAngleDeg of [5, 8, 12, 18, 25]) {
      const g = solveLinkJointGeometry(r, c, bendAngleDeg);
      if (!g) continue;
      for (const rhoMax of [6, 9.8, 20, 43.25]) {
        const seam = solveLinkSeam(g, rhoMax, c, bendAngleDeg);
        const where = `r=${r} c=${c} b=${bendAngleDeg} rhoMax=${rhoMax}`;
        assert.ok(
          Math.abs(
            seam.kerfSlope - 2 * Math.tan((seam.travelDeg * Math.PI) / 360),
          ) < 1e-12,
          `link kerf slope is exactly 2·tan(T/2) (${where}: ${seam.kerfSlope})`,
        );
        assert.equal(
          linkKerfAtMm(seam, 0),
          seam.kerfFloorMm,
          `link kerf is its floor on the axis (${where})`,
        );
        assert.ok(
          seam.kerfFloorMm >=
            Math.max(
              LINK_KERF_MIN_CONTRACT_MM,
              c + LINK_KERF_CLEAR_CONTRACT_MM,
            ) -
              1e-12,
          `link kerf floor keeps the printable minimum (${where})`,
        );
        let previous = -Infinity;
        for (let j = 0; j <= 50; j += 1) {
          const rho = (60 * j) / 50;
          const k = linkKerfAtMm(seam, rho);
          assert.ok(
            k >= previous - 1e-12,
            `link kerf is non-decreasing in rho (${where} rho=${rho.toFixed(2)})`,
          );
          assert.ok(
            k >= seam.kerfSlope * rho + c - 1e-12,
            `link kerf is at least the graded line — no pivot-relief term (${where} rho=${rho.toFixed(2)}: ${k})`,
          );
          previous = k;
          // Convexity: the max of two affine functions, checked as a midpoint
          // inequality against a neighbouring pair.
          if (j > 0 && j < 50) {
            const lo = linkKerfAtMm(seam, rho - 60 / 50);
            const hi = linkKerfAtMm(seam, rho + 60 / 50);
            assert.ok(
              k <= (lo + hi) / 2 + 1e-9,
              `link kerf law is convex (${where} rho=${rho.toFixed(2)})`,
            );
          }
        }
      }
    }
  }
}

// (L-GAP) THE running-clearance property, by EXACT 2-D rotation rather than by
// re-running the same algebra the law was written with.
//
// Head solid `{s ≥ k(|x|)/2}` rotated by θ about `(0, q)` must stay clear of the
// tail solid `{s ≤ −k(|x|)/2}` for every θ in [0, T], and the closest approach
// must be `c·cos(T/2)` — 97.6–99.8% of the clearance the user chose, INDEPENDENT
// of the pivot offset. The D1 design graded the FLAT law instead
// (`k = 2y(ρ − q·y) + c`); at the third cell below that gives −0.062mm, i.e. the
// joint jams at 22.8° of a requested 25°.
{
  const kerfOf = (c, T) => {
    const y = Math.tan((T * Math.PI) / 360);
    const floor = Math.max(
      LINK_KERF_MIN_CONTRACT_MM,
      c + LINK_KERF_CLEAR_CONTRACT_MM,
    );
    return (rho) => Math.max(floor, 2 * y * Math.abs(rho) + c);
  };
  // Minimum EUCLIDEAN distance from the rotated head face to the tail face. The
  // profile is EXACTLY piecewise-linear with one breakpoint per side (the radius
  // where the graded law overtakes the floor), so the tail face is three
  // segments and nothing here is an approximation of the shape — only the head
  // face and the angle are sampled.
  const minGap = (q, c, T, kIn, floorIn) => {
    const k = kIn ?? kerfOf(c, T);
    const y = Math.tan((T * Math.PI) / 360);
    const floor =
      floorIn ??
      Math.max(LINK_KERF_MIN_CONTRACT_MM, c + LINK_KERF_CLEAR_CONTRACT_MM);
    const knee = y > 0 ? Math.min(40, (floor - c) / (2 * y)) : 40;
    const tail = [
      [-40, -k(40) / 2],
      [-knee, -floor / 2],
      [knee, -floor / 2],
      [40, -k(40) / 2],
    ];
    let worst = Infinity;
    for (let step = 0; step <= 120; step += 1) {
      const a = ((T * step) / 120) * (Math.PI / 180);
      const cosA = Math.cos(a);
      const sinA = Math.sin(a);
      for (let j = 0; j <= 3000; j += 1) {
        const x = (40 * j) / 3000;
        const dy = k(x) / 2 - q;
        const px = x * cosA + dy * sinA;
        const py = -x * sinA + dy * cosA + q;
        for (let i = 0; i < tail.length - 1; i += 1) {
          const [ax, ay] = tail[i];
          const [bx, by] = tail[i + 1];
          const ex = bx - ax;
          const ey = by - ay;
          const t = Math.max(
            0,
            Math.min(
              1,
              ((px - ax) * ex + (py - ay) * ey) / (ex * ex + ey * ey),
            ),
          );
          worst = Math.min(
            worst,
            Math.hypot(px - ax - t * ex, py - ay - t * ey),
          );
        }
      }
    }
    return worst;
  };
  for (const [q, c, T, want] of [
    [1.71, 0.3, 8, 0.2993],
    [3.7, 0.3, 25, 0.2929],
    [1.71, 0.55, 15, 0.5453],
  ]) {
    const measured = minGap(q, c, T);
    assert.ok(
      Math.abs(measured - want) < 1e-3,
      `link running gap is c·cos(T/2) (q=${q} c=${c} T=${T}: measured ${measured.toFixed(4)}, want ${want})`,
    );
    assert.ok(
      measured >= 0.976 * c,
      `link running gap keeps at least 97.6% of the clearance (q=${q} c=${c} T=${T}: ${measured.toFixed(4)})`,
    );
  }
  // ...and the same rotation against the profile `solveLinkSeam` ACTUALLY
  // returns — its own floor (crown included), its own slope, its own pivot —
  // rather than against the algebra above. The three cells above pin the law and
  // the D1 counterexample; these pin the SHIPPED object, which is what the
  // cutter is revolved from.
  for (const [r, c, bendAngleDeg, rhoMax] of [
    [4.679, 0.3, 8, 9.8],
    [7.236, 0.3, 12, 12],
    [5, 0.55, 15, 6],
    [10.13, 0.4, 10, 15],
  ]) {
    const g = solveLinkJointGeometry(r, c, bendAngleDeg);
    const seam = solveLinkSeam(g, rhoMax, c, bendAngleDeg);
    const where = `r=${r} c=${c} b=${bendAngleDeg} rhoMax=${rhoMax}`;
    // Only meaningful where the request was actually delivered, and where the
    // graded law overtakes the floor inside the sampled band (otherwise the
    // face is a flat slab over the whole band and the gap is trivially `c`).
    assert.ok(
      Math.abs(seam.travelDeg - bendAngleDeg) < 1e-9,
      `the shipped-profile L-GAP cells are un-capped by construction (${where})`,
    );
    const knee = (seam.kerfFloorMm - c) / seam.kerfSlope;
    assert.ok(knee < 30, `the graded band is inside the probe (${where})`);
    const measured = minGap(
      g.pivotOffsetMm,
      c,
      seam.travelDeg,
      (rho) => linkKerfAtMm(seam, Math.abs(rho)),
      seam.kerfFloorMm,
    );
    const want = c * Math.cos((seam.travelDeg * Math.PI) / 360);
    assert.ok(
      Math.abs(measured - want) < 2e-3,
      `the SHIPPED seam's running gap is c·cos(T/2) (${where}: measured ${measured.toFixed(4)}, want ${want.toFixed(4)})`,
    );
    assert.ok(
      measured >= 0.976 * c,
      `the SHIPPED seam keeps at least 97.6% of the clearance (${where}: ${measured.toFixed(4)})`,
    );
  }
}

// (L-CAP) The look ceiling, inverted in closed form. `travelDeg` is EXACTLY
// `min(requested, cap)` — the profile is never clamped, so the reported angle is
// the angle the solid delivers and there is no migration correction to get wrong.
{
  const rhoA = LINK_KERF_ALLOWANCE_MM / LINK_KERF_MAX_FRACTION;
  assert.equal(rhoA, 15, 'link ceiling breakpoint radius contract is 15mm');
  for (const [c, want] of [
    [0.3, 15.939],
    [0.4, 15.564],
    [0.55, 15.002],
  ]) {
    const caps = TROUT_STATIONS.map(([r, , rhoMax]) => {
      const g = solveLinkJointGeometry(r, c, 25);
      return solveLinkSeam(g, rhoMax, c, 25).travelCapDeg;
    });
    for (const cap of caps) {
      assert.ok(
        Math.abs(cap - want) < 5e-3,
        `link travel cap on the acceptance body is ${want}° at c=${c} (got ${cap.toFixed(3)})`,
      );
    }
    assert.ok(
      Math.max(...caps) - Math.min(...caps) < 5e-3,
      `link travel cap is UNIFORM across the acceptance body's stations at c=${c} — the property that lets the warning name one number`,
    );
  }
  for (const r of LINK_RADII) {
    for (const c of LINK_CLEARANCES) {
      for (const bendAngleDeg of LINK_BENDS) {
        for (const rhoMax of [0, 6, 15, 43.25]) {
          const g = solveLinkJointGeometry(r, c, bendAngleDeg);
          const seam = solveLinkSeam(g, rhoMax, c, bendAngleDeg);
          assert.equal(
            seam.travelDeg,
            Math.min(bendAngleDeg, seam.travelCapDeg),
            `link delivers exactly min(requested, cap) (r=${r} c=${c} b=${bendAngleDeg} rhoMax=${rhoMax})`,
          );
          // The binding radius really is `max(hoop bound, min(rhoMax, rhoA))`.
          const yCeil = Math.tan((seam.travelCapDeg * Math.PI) / 360);
          const rhoBind = (LINK_KERF_ALLOWANCE_MM - c) / (2 * yCeil);
          assert.ok(
            rhoBind >= Math.min(rhoMax, rhoA) - 1e-6,
            `link ceiling binds no closer in than min(rhoMax, rhoA) (r=${r} c=${c} b=${bendAngleDeg} rhoMax=${rhoMax}: ${rhoBind.toFixed(3)})`,
          );
          assert.ok(
            linkKerfAtMm(seam, rhoBind) <= LINK_KERF_ALLOWANCE_MM + 1e-6,
            'link kerf never exceeds the allowance at the binding radius',
          );
        }
      }
    }
  }
}

// (L-CROWN) The crown-clearance floor. A polyline point whose whole envelope
// sits ABOVE the cut plane leaves an annular lip of head material at the tunnel
// mouth; if the kerf were narrower than twice that clearance the lip would print
// as a sub-0.8mm rim. Measured without the floor: 1108 of 2664 head-side points
// violate, thinnest 0.007mm.
//
// Legs (s < 0) are tail material and never make a lip, so they are excluded —
// including them drives the maximum to zero and the floor becomes dead code,
// which is exactly what an earlier probe for this did.
for (const r of [3.2, 5, 7.236, 10, 15]) {
  for (const c of [0.2, 0.3, 0.4, 0.55, 0.8]) {
    for (const bendAngleDeg of [5, 8, 12, 18, 25]) {
      const g = solveLinkJointGeometry(r, c, bendAngleDeg);
      if (!g) continue;
      for (const rhoMax of [6, 12, 20, 43.25]) {
        const seam = solveLinkSeam(g, rhoMax, c, bendAngleDeg);
        const poly = linkHoopPolyline(g, seam, c);
        let crown = 0;
        for (let i = 0; i < poly.points.length; i += 1) {
          crown = Math.max(crown, poly.points[i][2] - poly.envRadiusMm[i]);
        }
        if (2 * crown > LINK_KERF_ALLOWANCE_MM) continue; // clamped corner
        const lip = crown - seam.kerfFloorMm / 2;
        assert.ok(
          lip <= 1e-9 || lip >= LINK_KERF_MIN_CONTRACT_MM - 1e-9,
          `link leaves no knife-thin head lip at the tunnel mouth (r=${r} c=${c} b=${bendAngleDeg} rhoMax=${rhoMax}: ${lip.toFixed(4)}mm)`,
        );
      }
    }
  }
}

// (L-KNEE) The knee is derived from the LEG kerf, which is bounded by the
// allowance BY CONSTRUCTION (the hoop's own outer bound is folded into the
// travel cap). That is what keeps `solveLinkJointGeometry`'s hard-coded
// `kneeS = −(ALLOWANCE/2 + BURY)` conservative without the solver being edited.
{
  const deepest = LINK_KERF_ALLOWANCE_MM / 2 + LINK_BURY_MM;
  for (const r of LINK_RADII) {
    for (const c of LINK_CLEARANCES) {
      for (const bendAngleDeg of LINK_BENDS) {
        for (const rhoMax of [0, 6, 20, 43.25]) {
          const g = solveLinkJointGeometry(r, c, bendAngleDeg);
          const seam = solveLinkSeam(g, rhoMax, c, bendAngleDeg);
          const where = `r=${r} c=${c} b=${bendAngleDeg} rhoMax=${rhoMax}`;
          assert.ok(
            Math.abs(seam.kneeDepthMm - (seam.legKerfMm / 2 + LINK_BURY_MM)) <
              1e-12,
            `link knee depth is legKerf/2 + bury (${where})`,
          );
          assert.ok(
            seam.legKerfMm <= LINK_KERF_ALLOWANCE_MM + 1e-9,
            `link leg kerf never exceeds the allowance (${where}: ${seam.legKerfMm.toFixed(4)})`,
          );
          assert.ok(
            seam.kneeDepthMm <= deepest + 1e-9,
            `link knee is never deeper than the solver's own estimate (${where}: ${seam.kneeDepthMm.toFixed(4)} vs ${deepest})`,
          );
          const poly = linkHoopPolyline(g, seam, c);
          let low = Infinity;
          for (const point of poly.points) low = Math.min(low, point[2]);
          assert.ok(
            low <= -seam.kneeDepthMm + 1e-9,
            `link legs really do reach the knee depth (${where})`,
          );
        }
      }
    }
  }
  // Pinned on the acceptance body at bend 8, c 0.30.
  const legs = [1.198, 1.423, 1.484, 1.437];
  const knees = [1.199, 1.312, 1.342, 1.318];
  TROUT_STATIONS.forEach(([r, , rhoMax], i) => {
    const g = solveLinkJointGeometry(r, 0.3, 8);
    const seam = solveLinkSeam(g, rhoMax, 0.3, 8);
    assert.ok(
      Math.abs(seam.legKerfMm - legs[i]) < 5e-3 &&
        Math.abs(seam.kneeDepthMm - knees[i]) < 5e-3,
      `link leg kerf / knee on acceptance station ${i} are ${legs[i]} / ${knees[i]} (got ${seam.legKerfMm.toFixed(3)} / ${seam.kneeDepthMm.toFixed(3)})`,
    );
  });
}

// (L-ENGAGE) The engagement is read at the LEG kerf — what the hoop actually has
// to cross — not at the kerf out by a dorsal fin. Charging a joint the fin's
// slot is what drove joint 0 of the acceptance body to 0.488mm of engagement,
// below the 1.0mm floor, and cost it four consecutive rungs of the old ladder
// for a body that never needed a wide slot at all.
{
  const at = (c, bend) =>
    TROUT_STATIONS.map(([r, , rhoMax]) => {
      const g = solveLinkJointGeometry(r, c, bend);
      return solveLinkSeam(g, rhoMax, c, bend).engagementMm;
    });
  const bend8 = at(0.3, 8);
  const bend25 = at(0.3, 25);
  [2.138, 3.207, 3.491, 3.271].forEach((want, i) => {
    assert.ok(
      Math.abs(bend8[i] - want) < 5e-3,
      `link engagement on acceptance station ${i} at bend 8 is ${want}mm (got ${bend8[i].toFixed(3)})`,
    );
  });
  [1.683, 2.644, 2.898, 2.701].forEach((want, i) => {
    assert.ok(
      Math.abs(bend25[i] - want) < 5e-3,
      `link engagement on acceptance station ${i} at bend 25 is ${want}mm (got ${bend25[i].toFixed(3)})`,
    );
  });
  for (const value of [...bend8, ...bend25]) {
    assert.ok(
      value >= LINK_ENGAGE_CONTRACT_MM,
      `link keeps its ${LINK_ENGAGE_CONTRACT_MM}mm engagement floor on the acceptance body (got ${value.toFixed(3)})`,
    );
  }
  // …and it is non-increasing in the travel, which is what makes g1 monotone.
  for (const r of LINK_RADII) {
    for (const c of LINK_CLEARANCES) {
      let previous = Infinity;
      for (let travel = 1; travel <= 25; travel += 1) {
        const g = solveLinkJointGeometry(r, c, 25);
        const seam = solveLinkSeam(g, 20, c, travel);
        assert.ok(
          Math.abs(
            seam.engagementMm -
              (g.pivotOffsetMm + g.tubeRadiusMm - seam.legKerfMm / 2),
          ) < 1e-12,
          'link engagement is q + a − legKerf/2',
        );
        assert.ok(
          seam.engagementMm <= previous + 1e-12,
          `link engagement is non-increasing in the travel (r=${r} c=${c} travel=${travel})`,
        );
        previous = seam.engagementMm;
      }
    }
  }
}

// (L-SEC) The seam is DIRECTION-FREE, so the sideways travel is an IDENTITY, not
// a measurement. `k` depends on the radius alone, so a rotation by θ about
// `lat·cosψ + up·sinψ` drops a skin point at `(ρ, φ)` by `|sin(φ − ψ)|` of the
// pitch drop into a slot that is the same at every azimuth — pitch, yaw and every
// oblique axis deliver exactly the same angle.
//
// This REPLACES the whole lateral-budget probe family (the old P12/P13/P14). Those
// asserted a mechanism — a second, lateral kerf budget with its own floor — that
// no longer exists, and the thing they were protecting (a finned body yawing 3.34°
// against a 5° slider with nothing said) is now impossible by construction rather
// than by fixture selection. 'link-sideways-reduced' is therefore unreachable, and
// this identity is what proves it — an assertion on the LAW, not a negative
// observation on chosen bodies.
assert.equal(
  LINK_SECONDARY_MAX_DEG,
  6,
  'link secondary-travel cap contract is 6°',
);
for (const r of LINK_RADII) {
  for (const c of LINK_CLEARANCES) {
    for (const bendAngleDeg of LINK_BENDS) {
      const g = solveLinkJointGeometry(r, c, bendAngleDeg);
      if (!g) continue;
      for (const rhoMax of [0, 1.5, 6, 12, 30, 43.25, 120]) {
        const seam = solveLinkSeam(g, rhoMax, c, bendAngleDeg);
        const where = `r=${r} c=${c} b=${bendAngleDeg} rhoMax=${rhoMax}`;
        assert.equal(
          seam.secondaryTravelDeg,
          seam.secondaryTargetDeg,
          `link sideways travel equals its own budget IDENTICALLY (${where})`,
        );
        assert.equal(
          seam.secondaryTravelDeg,
          Math.min(g.secondaryTravelDeg, seam.travelDeg),
          `link sideways travel is min(carved cap, delivered) (${where})`,
        );
        assert.ok(
          seam.secondaryTravelDeg > 0 &&
            seam.secondaryTravelDeg <= LINK_SECONDARY_MAX_DEG + 1e-9,
          `link sideways travel is a positive angle inside the cap (${where})`,
        );
        // The kerf law is what makes it direction-free: one radius in, one
        // thickness out, with no azimuth anywhere in the call.
        assert.equal(
          linkKerfAtMm(seam, rhoMax),
          seam.kerfMm,
          `link kerf at the widest radius IS the reported kerf (${where})`,
        );
      }
    }
  }
}

// (L-ENVELOPE) The one number the whole clearance contract reduces to: every
// point of the hoop is fattened by AT LEAST the clearance the user chose, and by
// at most that plus the two named allowances. The eye is `plate − envelope`, so
// this inequality is what makes `dist(blade, hoop) ≥ c` a property of a boolean
// subtraction rather than of any algebra downstream.
for (const r of LINK_RADII) {
  for (const c of LINK_CLEARANCES) {
    for (const bendAngleDeg of LINK_BENDS) {
      const g = solveLinkJointGeometry(r, c, bendAngleDeg);
      if (!g) continue;
      const seam = solveLinkSeam(g, 43.25, c, bendAngleDeg);
      const poly = linkHoopPolyline(g, seam, c);
      const where = `r=${r} c=${c} b=${bendAngleDeg}`;
      assert.equal(
        poly.coreRadiusMm,
        g.tubeRadiusMm,
        `the hoop's core IS the solved rod (${where})`,
      );
      for (let i = 0; i < poly.envRadiusMm.length; i += 1) {
        assert.ok(
          poly.envRadiusMm[i] >= poly.coreRadiusMm + c - 1e-12,
          `link envelope is at least core + clearance (${where} i=${i}: ${poly.envRadiusMm[i]})`,
        );
        assert.ok(
          poly.envRadiusMm[i] <=
            poly.coreRadiusMm + c + LINK_SECONDARY_INFLATE_MAX_MM + 2,
          `link envelope stays inside its two allowances (${where} i=${i}: ${poly.envRadiusMm[i]})`,
        );
      }
      assert.ok(
        linkHoopOuterMm(poly) > 0,
        `the hoop has a positive outer bound (${where})`,
      );
    }
  }
}

// (L-PLANBUILD) The plan is CONSERVATIVE, not exact — and the reason is a pair of
// MONOTONICITIES, not the ρ-independence an earlier revision of this probe
// claimed (and asserted with `Math.abs(x − y) >= 0`, which cannot fail).
// `legKerfMm` DOES read the station, through
// `rhoPlain = max(min(ρ_max, ρ_A), bladeReach)`. What is true, and is what the
// plan/build agreement actually rests on, is:
//
//   1. `legKerfMm` (and so the knee, and so every envelope radius) is
//      NON-INCREASING in ρ_max, and CONSTANT once ρ_max ≥ ρ_A — measured
//      1.5165 → 1.4838mm at r = 7.236, c = 0.30, bend 8 over ρ_max = 0 … 120;
//   2. all three are NON-DECREASING in the travel.
//
// The plan solves at the FULL request and at a station radius no larger than the
// build's, so it walks the deeper, fatter polyline in both arguments at once —
// which is why a gate the plan clears the build clears too.
{
  const rhoA = LINK_KERF_ALLOWANCE_MM / LINK_KERF_MAX_FRACTION;
  for (const r of [3.2, 5, 7.236, 12]) {
    for (const c of LINK_CLEARANCES) {
      for (const bendAngleDeg of [8, 18, 25]) {
        const g = solveLinkJointGeometry(r, c, bendAngleDeg);
        const where = `r=${r} c=${c} b=${bendAngleDeg}`;
        // (1) monotone in ρ_max, and flat above ρ_A.
        let previousLeg = Infinity;
        let previousKnee = Infinity;
        for (const rhoMax of [0, 3, 6, 9.8, 12, 15, 20, 43.25, 120]) {
          const seam = solveLinkSeam(g, rhoMax, c, bendAngleDeg);
          assert.ok(
            seam.legKerfMm <= previousLeg + 1e-12,
            `link leg kerf is non-increasing in the station radius (${where} rhoMax=${rhoMax}: ${seam.legKerfMm} > ${previousLeg})`,
          );
          assert.ok(
            seam.kneeDepthMm <= previousKnee + 1e-12,
            `link knee depth is non-increasing in the station radius (${where} rhoMax=${rhoMax})`,
          );
          previousLeg = seam.legKerfMm;
          previousKnee = seam.kneeDepthMm;
        }
        const atRhoA = solveLinkSeam(g, rhoA, c, bendAngleDeg);
        for (const rhoMax of [rhoA, 20, 43.25, 120, 1e4]) {
          const seam = solveLinkSeam(g, rhoMax, c, bendAngleDeg);
          assert.equal(
            seam.legKerfMm,
            atRhoA.legKerfMm,
            `link leg kerf is CONSTANT above ρ_A (${where} rhoMax=${rhoMax})`,
          );
          assert.equal(
            seam.travelCapDeg,
            atRhoA.travelCapDeg,
            `link travel cap is CONSTANT above ρ_A (${where} rhoMax=${rhoMax})`,
          );
        }
        // (2) the plan (full request, smaller-or-equal station) dominates the
        // build (clamped travel, larger-or-equal station) pointwise.
        const plan = solveLinkSeam(g, 43.25, c, bendAngleDeg);
        const planPoly = linkHoopPolyline(g, plan, c);
        for (const rhoBuild of [43.25, 60, 120]) {
          for (let travel = 1; travel <= plan.travelDeg + 1e-9; travel += 0.5) {
            const build = solveLinkSeam(g, rhoBuild, c, travel);
            const buildPoly = linkHoopPolyline(g, build, c);
            const cell = `${where} rhoBuild=${rhoBuild} travel=${travel.toFixed(2)}`;
            assert.ok(
              plan.kneeDepthMm >= build.kneeDepthMm - 1e-12,
              `link plan knee is at least the build's (${cell})`,
            );
            assert.ok(
              plan.legKerfMm >= build.legKerfMm - 1e-12,
              `link plan leg kerf is at least the build's (${cell})`,
            );
            for (let i = 0; i < planPoly.envRadiusMm.length; i += 1) {
              assert.ok(
                planPoly.envRadiusMm[i] >= buildPoly.envRadiusMm[i] - 1e-12,
                `link plan envelope is at least the build's (${cell} i=${i})`,
              );
            }
          }
        }
      }
    }
  }
}

// (L-MINR / L-RMAX) Feasibility is an INTERVAL in `r`, over the FULL advanced
// Joint-gap range — not just the three presets. The lower bound at c = 0.20 is
// the solver's own `legOffset < 0.95·hoopRadius` gate, not the 3.2 pre-gate, so
// lowering `LINK_MIN_HEAD_RADIUS_MM` would loosen only the loose end.
{
  const bounds = new Map([
    [0.2, [4.95, 10.25]],
    [0.25, [3.2, 12.85]],
    [0.3, [3.2, 15.4]],
    [0.35, [3.2, 17.95]],
    [0.4, [3.2, 20.55]],
    [0.45, [3.2, 23.1]],
    [0.5, [3.2, 25.7]],
    [0.55, [3.2, 28.25]],
    [0.6, [3.2, 30.85]],
    [0.65, [3.2, 33.4]],
    [0.7, [3.2, 35.95]],
    [0.75, [3.2, 38.55]],
    [0.8, [3.2, 41.1]],
  ]);
  for (const [c, [wantLo, wantHi]] of bounds) {
    let lo = null;
    let hi = null;
    for (let step = 50; step <= 1000; step += 1) {
      const r = step / 20; // 2.50 … 50.00 in 0.05 steps
      const ok = [5, 12, 25].every((b) => solveLinkJointGeometry(r, c, b));
      if (ok && lo === null) lo = r;
      if (ok) hi = r;
    }
    assert.ok(
      Math.abs(lo - wantLo) < 0.051 && Math.abs(hi - wantHi) < 0.051,
      `link feasible interval at c=${c} is [${wantLo}, ${wantHi}] (got [${lo}, ${hi}])`,
    );
    assert.ok(
      lo >= LINK_MIN_HEAD_RADIUS_CONTRACT_MM - 1e-9,
      `link never solves below the published minimum head radius (c=${c})`,
    );
  }
  // The printable floors hold across the WHOLE interval, at every bend.
  for (const c of [0.2, 0.25, 0.3, 0.4, 0.55, 0.8]) {
    for (let bendAngleDeg = 5; bendAngleDeg <= 25; bendAngleDeg += 1) {
      for (const r of [3.2, 4, 6, 9, 10.2]) {
        const g = solveLinkJointGeometry(r, c, bendAngleDeg);
        if (!g) continue;
        const where = `r=${r} c=${c} b=${bendAngleDeg}`;
        assert.ok(
          g.tubeRadiusMm >= LINK_TUBE_MIN_MM - 1e-9 &&
            g.bladeThicknessMm >= LINK_BLADE_MIN_MM - 1e-9 &&
            g.ringWallMm >= LINK_RING_WALL_CONTRACT_MM - 1e-9,
          `link keeps every printable floor across the interval (${where})`,
        );
        assert.ok(
          g.legSlabClearMm >= -1e-9,
          `link legs stay out of the blade slab across the interval (${where}: ${g.legSlabClearMm})`,
        );
        assert.ok(
          g.hoopRadiusMm * (1 - Math.cos(g.arcHalfAngleRad)) < g.bladeReachMm,
          `link arc lies inside the blade reach across the interval (${where})`,
        );
      }
    }
  }
}

// (L-BISECT) The SHIPPED ladder search — `linkTravelSearch`, the same function
// `buildLinkSegments` calls — against a synthetic monotone predicate: the result
// is feasible, is a multiple of the ABSOLUTE grid, and is the LARGEST feasible
// grid point at or below `min(bend, cap)`. This is what pins the off-by-one and
// the budget; a proportional ladder or a `[1, bend]` bisection cannot satisfy it.
// Exercising the shipped function rather than a replica is the point: a replica
// passes happily while the real loop rots.
{
  const step = LINK_TRAVEL_STEP_DEG;
  const search = (top, feasible) => {
    let evaluations = 0;
    const got = linkTravelSearch(top, (travel) => {
      evaluations += 1;
      return feasible(travel) ? { travel } : null;
    });
    // ≤ 2 seeds (the top of the range and the floor) plus the bisection budget.
    assert.ok(
      evaluations <= LINK_CLAMP_STEPS + 2,
      `link bisection stays inside its ${LINK_CLAMP_STEPS}-step budget (spent ${evaluations})`,
    );
    return got === null ? null : got.travel;
  };
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  // THE FLOOR IS A GATE, not a formality: below it a link joint is a slot too
  // narrow to free after printing, so it is abandoned to the rounded fallback
  // (which warns) rather than shipped. Both angles here are deliberate LITERALS
  // — writing them as `LINK_TRAVEL_MIN_DEG − step` would move with the constant
  // and make the assertion survive zeroing it, which is exactly how this guard
  // went uncovered. No fixture in the repo reaches a cap this low, so nothing
  // else in either suite can catch that mutation.
  assert.equal(
    search(0.95, () => true),
    null,
    'the ladder refuses a range whose TOP is below the 1° travel floor',
  );
  assert.equal(
    search(25, (travel) => travel <= 0.9),
    null,
    'the ladder refuses a joint whose only feasible travels are below 1°',
  );
  const atFloor = search(25, (travel) => travel <= LINK_TRAVEL_MIN_DEG + 1e-9);
  assert.ok(
    atFloor !== null && Math.abs(atFloor - LINK_TRAVEL_MIN_DEG) < 1e-9,
    `the ladder ships exactly the floor when that is all that fits (got ${atFloor})`,
  );
  for (let trial = 0; trial < 200; trial += 1) {
    const bend = 5 + random() * 20;
    const supremum = 0.5 + random() * 26;
    const feasible = (travel) => travel <= supremum;
    const got = search(bend, feasible);
    if (supremum < LINK_TRAVEL_MIN_DEG) {
      assert.equal(got, null, 'link bisection refuses a joint under the floor');
      continue;
    }
    assert.ok(got !== null, 'link bisection finds the feasible band');
    assert.ok(feasible(got), 'link bisection returns a FEASIBLE travel');
    const onGrid =
      Math.abs(got - bend) < 1e-12 ||
      Math.abs(got / step - Math.round(got / step)) < 1e-6;
    assert.ok(onGrid, `link bisection returns a grid multiple (got ${got})`);
    // EXACT, not "within a grid step". The old `>= best − step` bound tolerated
    // a whole rung, which meant an off-by-one in the search and a coarsened grid
    // both slipped through. The shipped contract is: the top of the range if it
    // is feasible, otherwise the largest grid multiple at or below it.
    const exact = feasible(bend)
      ? bend
      : Math.floor(Math.min(bend, supremum) / step + 1e-9) * step;
    assert.ok(
      Math.abs(got - exact) < 1e-9,
      `link bisection returns the LARGEST feasible grid point (got ${got}, expected ${exact})`,
    );
    // …and the grid must be FINE enough for that to mean something. This bound
    // is an absolute LITERAL, deliberately: every expectation above is written
    // in terms of `step`, so they all move with the constant and a ladder that
    // threw away half a degree of the user's bend to grid coarseness would pass
    // them unchanged. A tenth of a degree is the resolution the Flexibility
    // slider is entitled to.
    assert.ok(
      got >= Math.min(bend, supremum) - 0.1,
      `link bisection loses at most 0.1° to the grid (got ${got}, could have had ${Math.min(bend, supremum)})`,
    );
  }
}

// (L-BLADECAP) Gate g6 and the builder's truncation must read the SAME number,
// and the margin must actually be charged. `buildLinkBlade` cuts the plate off at
// `linkBladeHeadCapMm`; the ladder decides whether that cut would open the eye
// with `linkBladeCapFits`. Both live in the plan module so they cannot drift, and
// both are pinned AT THE BOUNDARY: a joint with only half the margin to spare must
// be refused, because the plate would otherwise be truncated flush against its
// neighbour with none of the slack the margin exists to reserve. The half-margin
// is a LITERAL for the same reason as the travel floor above — zeroing the
// constant has to fail here, and no fixture in the repo sits inside 0.2mm of this
// boundary, so nothing else can see it.
for (const r of LINK_RADII) {
  for (const c of LINK_CLEARANCES) {
    for (const bendAngleDeg of LINK_BENDS) {
      const g = solveLinkJointGeometry(r, c, bendAngleDeg);
      if (!g) continue;
      const where = `r=${r} c=${c} b=${bendAngleDeg}`;
      const reach = g.pivotOffsetMm + g.bladeReachMm;
      const need = g.pivotOffsetMm + g.eyeOuterMm + LINK_RING_WALL_MM;
      assert.equal(
        linkBladeHeadCapMm(g, Infinity),
        reach,
        `no neighbour leaves the blade at its own reach (${where})`,
      );
      assert.ok(
        linkBladeCapFits(g, Infinity),
        `an unbounded head room always keeps the whole eye (${where})`,
      );
      assert.ok(
        !linkBladeCapFits(g, need + 0.1),
        `half the head-cap margin is NOT enough room (${where})`,
      );
      assert.ok(
        linkBladeCapFits(g, need + LINK_BLADE_CAP_MARGIN_MM),
        `exactly the head-cap margin IS enough room (${where})`,
      );
      // A neighbour inside the plate's own reach truncates it EXACTLY the margin
      // short — the number the builder cuts with.
      assert.equal(
        linkBladeHeadCapMm(g, reach),
        reach - LINK_BLADE_CAP_MARGIN_MM,
        `the blade stops one margin short of a neighbour inside its reach (${where})`,
      );
      // The gate is the truncation: same number, one predicate.
      for (const room of [need - 1, need, need + 0.1, need + 0.3, reach + 5]) {
        assert.equal(
          linkBladeCapFits(g, room),
          linkBladeHeadCapMm(g, room) >= need,
          `the g6 gate is exactly "the truncation keeps the eye" (${where} room=${room.toFixed(3)})`,
        );
      }
    }
  }
}

// (L-TRAVEL-MONO) Delivered travel is NON-DECREASING in `bendAngleDeg`, swept at
// 0.01°, on the acceptance body's own four tuples. The `q` values are the ones
// `solveLinkJointGeometry` actually produces (1.708 / 2.445 / 2.641 / 2.489), not
// the station radii. Master's proportional ladder gives 3–5 decreases here and a
// `[1, bend]` bisection gives 94; the absolute grid gives 0.
for (const [r, , rhoMax] of TROUT_STATIONS) {
  for (const c of [0.3, 0.55]) {
    let previous = -Infinity;
    for (let bend = 5; bend <= 25.0001; bend += 0.01) {
      const g = solveLinkJointGeometry(r, c, bend);
      const delivered = solveLinkSeam(g, rhoMax, c, bend).travelDeg;
      assert.ok(
        delivered >= previous - 1e-9,
        `link delivered travel is monotone in the slider (r=${r} c=${c} bend=${bend.toFixed(2)}: ${delivered} < ${previous})`,
      );
      previous = delivered;
    }
  }
}

// (L-FOOT) The footprint's kerf term is capped at the allowance, so the whole
// footprint is `max(const, affine-in-r) + max(const, affine-in-r)` — the
// bisection precondition `jointOverlapCap` needs is STRENGTHENED, not merely
// preserved. Zero decreasing steps over r ∈ [2.5, 20] at 0.05.
for (const c of [0.2, 0.3, 0.4, 0.55, 0.8]) {
  for (const bendAngleDeg of [5, 12, 25]) {
    for (const extent of [0, 6, 9.8, 20, 43.25]) {
      let previous = -Infinity;
      for (let step = 50; step <= 400; step += 1) {
        const r = step / 20;
        const floor = minSegmentLengthFor(r, c, 'link', bendAngleDeg, extent);
        assert.ok(
          floor >= previous - 1e-9,
          `link footprint is monotone in r over the widened range (r=${r.toFixed(2)} c=${c} b=${bendAngleDeg} rho=${extent}: ${floor} < ${previous})`,
        );
        previous = floor;
      }
    }
  }
}
// Re-recorded baseline, pinned as a LITERAL. It is exactly `rounded`'s here (the
// rounded floor dominates), which is also what keeps the `link ≥ rounded` probe
// above true — a change that lowers link's footprint below rounded's breaks the
// build's per-joint rounded fallback, which is the whole reason that probe exists.
assert.ok(
  Math.abs(minSegmentLengthFor(7.24, 0.3, 'link', 8, 43.25) - 19.08) < 1e-6,
  `link segment floor on the acceptance body is 19.08mm (got ${minSegmentLengthFor(7.24, 0.3, 'link', 8, 43.25)})`,
);
assert.equal(
  minSegmentLengthFor(7.24, 0.3, 'link', 8, 43.25),
  minSegmentLengthFor(7.24, 0.3, 'rounded', 8, 43.25),
  'link and rounded agree on the acceptance body: the rounded floor dominates',
);

// (P9) Containment on the steep 45° cone: link sizes DOWN rather than piercing
// the skin, and never ends up larger than the rounded radius by more than a
// shrink step.
{
  const linkCone = planFlexiToy(steepCone, {
    ...coneSettings,
    jointStyle: 'link',
  });
  const roundedCone = planFlexiToy(steepCone, {
    ...coneSettings,
    jointStyle: 'rounded',
  });
  assert.equal(
    linkCone.joints.length,
    roundedCone.joints.length,
    'link plans the same station count on the cone as rounded',
  );
  for (let i = 0; i < linkCone.joints.length; i += 1) {
    const link = linkCone.joints[i];
    const rounded = roundedCone.joints[i];
    if (link.fused || rounded.fused) continue;
    assert.ok(
      link.ballRadiusMm <= rounded.ballRadiusMm + 0.201,
      `link cone joint ${i} is not larger than the rounded one (${link.ballRadiusMm} vs ${rounded.ballRadiusMm})`,
    );
  }
}

// (P10) Dragged stations survive on link and raise the adjustment warning.
{
  const dragCapsule = makeSpindle({ length: 150, maxRadius: 14 });
  const dragged = planFlexiToy(dragCapsule, {
    ...DEFAULT_SETTINGS,
    jointStyle: 'link',
    segmentCount: 5,
    axisOverride: 'x',
    jointPositions: [0.2, 0.22, 0.6, 0.9],
  });
  assert.equal(
    dragged.joints.length,
    4,
    'link keeps the pinned station count (5 segments → 4 joints)',
  );
  const fractions = dragged.joints.map((joint) => joint.spineFraction);
  for (let i = 1; i < fractions.length; i += 1) {
    assert.ok(
      fractions[i] > fractions[i - 1],
      'link dragged stations stay strictly increasing',
    );
  }
  assert.ok(
    dragged.warnings.some((w) => w.code === 'joint-positions-adjusted'),
    'link reports that the too-close dragged cuts were nudged',
  );
}

// (P11) Every live link joint the planner emits is buildable by whichever cutter
// the build will actually reach for — the solved hoop/blade, or (when the solver
// is infeasible at that radius) the rounded groove. A live joint the build can
// realise NEITHER way is the plan handing the build an impossible station.
{
  const bodies = [
    makeSpindle({ length: 150, maxRadius: 12 }),
    makeSpindle({ length: 170, maxRadius: 4.2 }),
    makeSpindle({ length: 150, maxRadius: 18, taper: 0.6 }),
  ];
  for (const body of bodies) {
    for (const c of [0.3, 0.4, 0.55]) {
      for (const bendAngleDeg of [5, 12, 25]) {
        const plan = planFlexiToy(body, {
          ...DEFAULT_SETTINGS,
          jointStyle: 'link',
          clearanceMm: c,
          bendAngleDeg,
          axisOverride: 'x',
        });
        for (const joint of plan.joints) {
          if (joint.fused) continue;
          const solved = solveLinkJointGeometry(
            joint.ballRadiusMm,
            c,
            bendAngleDeg,
          );
          const roundedFallback =
            joint.socketDepthMm > 0 && joint.faceGapMm > 0;
          assert.ok(
            solved !== null || roundedFallback,
            `every live link joint is buildable one way or the other (r=${joint.ballRadiusMm})`,
          );
        }
      }
    }
  }
}

// (P12) Link never sizes a joint DOWN into a radius it cannot even build.
//
// `sizeJoint`'s shrink loop takes the FIRST — i.e. largest — radius its
// containment predicate accepts, which is only the best answer if the accepted
// set is an interval. Link's link-cavity criterion is strictly more demanding
// than the rounded cup (its legs run off-axis AND tail-ward), so if the
// criterion were allowed to flip to the looser rounded cup partway down the
// ladder, the loop would walk straight past the band link rejects and settle
// just under the flip point — planning a ball it cannot build a hoop in AND
// that is smaller than the one Rounded would have used, then taking the rounded
// fallback anyway. Pure loss: measured 3.03mm against rounded's 3.63mm (-17%)
// on joint 0 of a 150mm spindle before the criterion was hoisted out of the loop.
//
// So: link may legitimately size DOWN to fit a real hoop, but a smaller ball
// than rounded's is only ever justified by actually getting a hoop for it.
{
  const bodies = [
    ['spindle-12', makeSpindle({ length: 150, maxRadius: 12 })],
    [
      'spindle-18-taper',
      makeSpindle({ length: 150, maxRadius: 18, taper: 0.6 }),
    ],
    ['spindle-thin', makeSpindle({ length: 170, maxRadius: 4.2 })],
  ];
  for (const [name, body] of bodies) {
    for (const c of [0.3, 0.4, 0.55]) {
      for (const bendAngleDeg of [5, 12, 25]) {
        const common = {
          ...DEFAULT_SETTINGS,
          segmentCount: 5,
          clearanceMm: c,
          bendAngleDeg,
          axisOverride: 'x',
        };
        const linkPlan = planFlexiToy(body, { ...common, jointStyle: 'link' });
        const roundedPlan = planFlexiToy(body, {
          ...common,
          jointStyle: 'rounded',
        });
        assert.equal(
          linkPlan.joints.length,
          roundedPlan.joints.length,
          `link and rounded station counts match (${name} c=${c} b=${bendAngleDeg})`,
        );
        for (let i = 0; i < linkPlan.joints.length; i += 1) {
          const lj = linkPlan.joints[i];
          const rj = roundedPlan.joints[i];
          if (lj.fused || rj.fused) continue;
          if (!(lj.ballRadiusMm < rj.ballRadiusMm - 1e-9)) continue;
          assert.ok(
            solveLinkJointGeometry(lj.ballRadiusMm, c, bendAngleDeg) !== null,
            `link only sizes below rounded to WIN a hoop (${name} c=${c} b=${bendAngleDeg} joint ${i}: link ${lj.ballRadiusMm.toFixed(2)} < rounded ${rj.ballRadiusMm.toFixed(2)}, and the link solver is infeasible there)`,
          );
        }
      }
    }
  }
}

console.log('flexiToyPlan.test.mjs: all assertions passed');
