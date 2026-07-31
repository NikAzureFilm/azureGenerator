import assert from 'node:assert/strict';
import {
  planFlexiToy,
  computeFlexiScale,
  scaleFlexiPositions,
  socketMouthRadius,
  minSegmentLengthFor,
  solveStrongJointGeometry,
  strongPullPlay,
} from './flexiToyPlan.ts';
import {
  FLEXI_MIN_BALL_RADIUS_MM,
  FLEXI_MIN_SOCKET_WALL_MM,
  FLEXI_CAPTURE_MARGIN_MM,
  FLEXI_MAX_SEGMENTS,
  FLEXI_MIN_SEGMENTS,
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

console.log('flexiToyPlan.test.mjs: all assertions passed');
