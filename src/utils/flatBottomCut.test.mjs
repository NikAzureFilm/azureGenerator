/**
 * Node test for the planar flat-bottom cut. Runs the real manifold-3d WASM
 * (node resolves it from the package, no locateFile needed), the same way
 * flexiToyBuild.test.mjs does.
 *
 * Run: node --experimental-strip-types src/utils/flatBottomCut.test.mjs
 */

import assert from 'node:assert/strict';

import { loadManifold } from './flexiToyBuild.ts';
import {
  FLAT_BOTTOM,
  computeFlatBottomForScene,
  flatBottomCut,
  measureBounds,
  measurePlanarFaceArea,
  mergeCutMeshes,
} from './flatBottomCut.ts';

// --- Synthetic fixtures (generated in-test) ---

/** Axis-aligned box centred on x/z, spanning y in [minY, minY + height]. */
function makeBox({
  width = 10,
  depth = 10,
  height = 10,
  minY = 0,
  numProp = 3,
} = {}) {
  const hx = width / 2;
  const hz = depth / 2;
  const y0 = minY;
  const y1 = minY + height;
  const corners = [
    [-hx, y0, -hz],
    [hx, y0, -hz],
    [hx, y0, hz],
    [-hx, y0, hz],
    [-hx, y1, -hz],
    [hx, y1, -hz],
    [hx, y1, hz],
    [-hx, y1, hz],
  ];
  const vertProperties = new Float32Array(corners.length * numProp);
  corners.forEach((corner, index) => {
    const base = index * numProp;
    vertProperties[base] = corner[0];
    vertProperties[base + 1] = corner[1];
    vertProperties[base + 2] = corner[2];
    // Extra channels get a recognisable ramp so interpolation is visible.
    for (let p = 3; p < numProp; p += 1) {
      vertProperties[base + p] = index / corners.length;
    }
  });
  // Outward-facing winding.
  const triVerts = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2,
    3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]);
  return { vertProperties, triVerts, numProp };
}

/** UV-sphere of radius r centred at the origin — a fully rounded underside. */
function makeSphere({ radius = 10, segments = 32, rings = 24 } = {}) {
  const positions = [];
  const triangles = [];
  for (let ring = 0; ring <= rings; ring += 1) {
    const phi = (ring / rings) * Math.PI;
    for (let seg = 0; seg <= segments; seg += 1) {
      const theta = (seg / segments) * Math.PI * 2;
      positions.push(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.cos(phi),
        radius * Math.sin(phi) * Math.sin(theta),
      );
    }
  }
  const stride = segments + 1;
  for (let ring = 0; ring < rings; ring += 1) {
    for (let seg = 0; seg < segments; seg += 1) {
      const a = ring * stride + seg;
      const b = a + stride;
      triangles.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return {
    vertProperties: new Float32Array(positions),
    triVerts: new Uint32Array(triangles),
    numProp: 3,
  };
}

/** Ellipsoid with independent radii — a fish lying on its side, etc. */
function makeEllipsoid({ rx, ry, rz, segments = 64, rings = 48 }) {
  const positions = [];
  const triangles = [];
  for (let ring = 0; ring <= rings; ring += 1) {
    const phi = (ring / rings) * Math.PI;
    for (let seg = 0; seg <= segments; seg += 1) {
      const theta = (seg / segments) * Math.PI * 2;
      positions.push(
        rx * Math.sin(phi) * Math.cos(theta),
        ry * Math.cos(phi),
        rz * Math.sin(phi) * Math.sin(theta),
      );
    }
  }
  const stride = segments + 1;
  for (let ring = 0; ring < rings; ring += 1) {
    for (let seg = 0; seg < segments; seg += 1) {
      const a = ring * stride + seg;
      const b = a + stride;
      triangles.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return {
    vertProperties: new Float32Array(positions),
    triVerts: new Uint32Array(triangles),
    numProp: 3,
  };
}

const wasm = await loadManifold();

// measureBounds reports height, footprint and diagonal of the bounding box.
{
  const bounds = measureBounds(makeBox({ width: 4, depth: 6, height: 8 }));
  assert.equal(bounds.minY, 0);
  assert.equal(bounds.maxY, 8);
  assert.equal(bounds.height, 8);
  assert.equal(bounds.footprintArea, 24);
  assert.ok(Math.abs(bounds.diagonal - Math.sqrt(16 + 64 + 36)) < 1e-4);
}

// measurePlanarFaceArea only counts triangles lying in the plane.
{
  const box = makeBox({ width: 10, depth: 10, height: 10 });
  assert.equal(measurePlanarFaceArea(box, 0, 1e-4), 100);
  assert.equal(measurePlanarFaceArea(box, 10, 1e-4), 100);
  assert.equal(measurePlanarFaceArea(box, 5, 1e-4), 0);
}

// A box already rests on a full flat face: the cut is skipped entirely.
{
  const outcome = await flatBottomCut(wasm, makeBox());
  assert.equal(outcome.status, 'already-flat', JSON.stringify(outcome));
  assert.equal(outcome.contactArea, 100);
}

// A sphere has no flat underside, so it gets cut and gains a real contact face.
{
  const sphere = makeSphere({ radius: 10 });
  const outcome = await flatBottomCut(wasm, sphere);
  assert.equal(outcome.status, 'ok', JSON.stringify(outcome));

  const bounds = measureBounds(outcome.mesh);
  const originalBounds = measureBounds(sphere);

  // The new bottom is the cut plane, within a hair of it.
  assert.ok(
    Math.abs(bounds.minY - outcome.cutY) < originalBounds.height * 1e-3,
    `expected the cut model to start at the cut plane, got ${bounds.minY} vs ${outcome.cutY}`,
  );
  // The top is untouched.
  assert.ok(
    Math.abs(bounds.maxY - originalBounds.maxY) < 1e-3,
    `expected the top to be untouched, got ${bounds.maxY}`,
  );
  // The cut is bounded — never amputate the model.
  assert.ok(
    outcome.cutFraction <= FLAT_BOTTOM.MAX_CUT_FRACTION,
    `cut fraction ${outcome.cutFraction} exceeded the cap`,
  );
  // The flat face actually exists and is broad enough to stand on.
  const epsilon = originalBounds.height * FLAT_BOTTOM.PLANE_EPSILON_FRACTION;
  const capArea = measurePlanarFaceArea(outcome.mesh, outcome.cutY, epsilon);
  assert.ok(capArea > 0, 'expected a flat cap on the cut model');
  assert.ok(
    capArea >=
      originalBounds.footprintArea * FLAT_BOTTOM.TARGET_CONTACT_FRACTION,
    `cap area ${capArea} is below the contact target`,
  );
}

// The result is a closed solid, not an open shell: every edge is shared by
// exactly two triangles.
{
  const outcome = await flatBottomCut(wasm, makeSphere({ radius: 10 }));
  assert.equal(outcome.status, 'ok');
  const counts = new Map();
  const { triVerts } = outcome.mesh;
  for (let t = 0; t + 2 < triVerts.length; t += 3) {
    const tri = [triVerts[t], triVerts[t + 1], triVerts[t + 2]];
    for (let e = 0; e < 3; e += 1) {
      const a = tri[e];
      const b = tri[(e + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const openEdges = [...counts.values()].filter((count) => count !== 2).length;
  assert.equal(openEdges, 0, `expected a watertight result, ${openEdges} open`);
}

// Scale invariance: the same shape at 1/1000th the size gets the same relative
// cut (this is what makes the cut safe on raw viewer units as well as mm).
{
  const big = await flatBottomCut(wasm, makeSphere({ radius: 10 }));
  const small = await flatBottomCut(wasm, makeSphere({ radius: 0.01 }));
  assert.equal(big.status, 'ok');
  assert.equal(small.status, 'ok', JSON.stringify(small));
  assert.equal(
    big.cutFraction,
    small.cutFraction,
    'the cut depth should be scale-invariant',
  );
  const smallBounds = measureBounds(small.mesh);
  assert.ok(
    Math.abs(smallBounds.minY - small.cutY) < 0.01 * 1e-3,
    'the tiny model should also start exactly at its cut plane',
  );
}

// Vertex properties beyond xyz survive the trim, so textured meshes keep their
// uv channel. (If manifold ever stops interpolating properties this fails.)
{
  const sphere = makeSphere({ radius: 10 });
  const withUv = {
    numProp: 5,
    triVerts: sphere.triVerts,
    vertProperties: new Float32Array(
      (sphere.vertProperties.length / 3) * 5,
    ).map((_, index) => {
      const vertex = Math.floor(index / 5);
      const channel = index % 5;
      if (channel < 3) return sphere.vertProperties[vertex * 3 + channel];
      // u = normalized x, v = normalized z, both in [0, 1].
      return (sphere.vertProperties[vertex * 3 + (channel === 3 ? 0 : 2)] +
        10) /
        20;
    }),
  };

  const outcome = await flatBottomCut(wasm, withUv);
  assert.equal(outcome.status, 'ok', JSON.stringify(outcome));
  assert.equal(
    outcome.mesh.numProp,
    5,
    'the uv channel should survive the trim',
  );

  let minU = Infinity;
  let maxU = -Infinity;
  for (let i = 3; i < outcome.mesh.vertProperties.length; i += 5) {
    minU = Math.min(minU, outcome.mesh.vertProperties[i]);
    maxU = Math.max(maxU, outcome.mesh.vertProperties[i + 1]);
  }
  assert.ok(
    minU >= -0.01 && maxU <= 1.01,
    `interpolated uvs left their range: ${minU}..${maxU}`,
  );
}

// Tuning regression: a rounded body must lose enough material to actually read
// as flat-bottomed. Measured against an ellipsoid the proportions of the fish
// reference (long, thin vertically, tall horizontally) — an earlier, more
// timid target stopped at 0.5% of height, which is a knife edge, not a base.
{
  const pike = makeEllipsoid({ rx: 500, ry: 30, rz: 75 });
  const outcome = await flatBottomCut(wasm, pike);
  assert.equal(outcome.status, 'ok', JSON.stringify(outcome));

  const bounds = measureBounds(pike);
  assert.ok(
    outcome.cutFraction >= 0.03,
    `a rounded belly should be cut at least 3% deep, got ${outcome.cutFraction}`,
  );
  assert.ok(
    outcome.contactArea >=
      bounds.footprintArea * FLAT_BOTTOM.TARGET_CONTACT_FRACTION,
    `contact face ${outcome.contactArea} is below the target`,
  );
}

// ...and the opposite guard: a model already standing on small flat feet must
// NOT be sawn through at the depth cap just because its contact area is small
// relative to its bounding box.
{
  const { Manifold } = wasm;
  const ball = (rx, ry, rz, tx, ty) => {
    const unit = Manifold.sphere(1, 64);
    const scaled = unit.scale([rx, ry, rz]);
    unit.delete();
    const moved = scaled.translate([tx, ty, 0]);
    scaled.delete();
    return moved;
  };
  const left = ball(12, 10, 16, -20, 10);
  const right = ball(12, 10, 16, 20, 10);
  const body = ball(30, 60, 22, 0, 75);
  const legsRaw = Manifold.cylinder(50, 8, 8, 32, false);
  const legs = legsRaw.rotate([-90, 0, 0]).translate([0, 20, 0]);
  legsRaw.delete();
  const figure = left.add(right).add(body).add(legs);
  for (const part of [left, right, body, legs]) part.delete();

  const raw = figure.getMesh();
  const outcome = await flatBottomCut(wasm, {
    vertProperties: new Float32Array(raw.vertProperties),
    triVerts: new Uint32Array(raw.triVerts),
    numProp: raw.numProp,
  });
  figure.delete();

  assert.equal(outcome.status, 'ok', JSON.stringify(outcome));
  assert.ok(
    outcome.cutFraction <= 0.03,
    `a figurine on feet should keep its legs, but ${outcome.cutFraction} of its height was cut`,
  );
}

// A degenerate (flat, zero-height) input is reported, never crashed on.
{
  const flat = makeBox({ height: 0 });
  const outcome = await flatBottomCut(wasm, flat);
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.code, 'degenerate');
}

// A multi-part scene shares ONE cut plane across its parts, and each part is
// returned separately so it can keep its own material.
{
  const lower = makeSphere({ radius: 10 });
  // A second part sitting well above the cut: it must come back untouched.
  const upper = makeBox({ width: 4, depth: 4, height: 4, minY: 12 });
  const outcome = await computeFlatBottomForScene(wasm, [lower, upper]);

  assert.equal(outcome.status, 'ok', JSON.stringify(outcome));
  assert.equal(outcome.meshes.length, 2);
  assert.equal(outcome.uncutCount, 0);
  assert.ok(outcome.meshes[0], 'the bottom part should have been trimmed');
  assert.equal(
    outcome.meshes[1],
    null,
    'a part above the plane keeps its original geometry',
  );

  const cutBounds = measureBounds(outcome.meshes[0]);
  assert.ok(
    Math.abs(cutBounds.minY - outcome.cutY) < 0.05,
    `trimmed part should start at the shared plane, got ${cutBounds.minY} vs ${outcome.cutY}`,
  );
}

// mergeCutMeshes concatenates geometry and rebases indices.
{
  const a = makeBox({ width: 2, depth: 2, height: 2 });
  const b = makeBox({ width: 2, depth: 2, height: 2, minY: 5 });
  const merged = mergeCutMeshes([a, b]);
  assert.equal(merged.numProp, 3);
  assert.equal(merged.vertProperties.length, 8 * 3 * 2);
  assert.equal(merged.triVerts.length, a.triVerts.length * 2);
  const bounds = measureBounds(merged);
  assert.equal(bounds.minY, 0);
  assert.equal(bounds.maxY, 7);
  const maxIndex = Math.max(...merged.triVerts);
  assert.equal(maxIndex, 15, 'indices of the second mesh should be rebased');
}

// A single-mesh scene takes the direct path and reports one result.
{
  const outcome = await computeFlatBottomForScene(wasm, [
    makeSphere({ radius: 10 }),
  ]);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.meshes.length, 1);
  assert.equal(outcome.uncutCount, 0);
}

// An empty scene is reported, never crashed on.
{
  const outcome = await computeFlatBottomForScene(wasm, []);
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.code, 'degenerate');
}

console.log('flatBottomCut tests passed');
