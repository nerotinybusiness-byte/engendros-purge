import test from 'node:test';
import assert from 'node:assert/strict';
import { MANIFEST } from '../../src/props/operators/manifest.js';
import { EXTENTS } from '../../src/props/operators/extents.js';
// NOTE: import the pure impl files directly — operators/index.js re-exports the
// THREE-bound round ops, and `three` is unresolvable under bare `node --test`.
import * as STRUCT from '../../src/props/operators/structural.js';
import * as FURN from '../../src/props/operators/furniture.js';
import * as CONT from '../../src/props/operators/container.js';

const PURE_OPS = {
  bevelBox: STRUCT.bevelBox, panel: STRUCT.panel, plate: STRUCT.plate, stencil: STRUCT.stencil, planks: STRUCT.planks,
  finSet: STRUCT.finSet, latticeBeam: STRUCT.latticeBeam, cabinet: STRUCT.cabinet,
  drawerStack: FURN.drawerStack, legs: FURN.legs,
  lidBox: CONT.lidBox, strapBand: CONT.strapBand, handleU: CONT.handleU,
};
// Ops verified by EXTENTS sanity only here, and excluded from the PURE z-fight / box-within-extents
// property tests below. Two distinct reasons:
//  - THREE-bound round ops (cylinder…loaf): impls call THREE and can't run under bare `node --test`.
//  - star + meshReflector: box-only and ARE behaviourally unit-tested in operators.test.mjs; they're
//    held out of the z-fight PROPERTY test only because their dense overlapping members carry
//    intentional coplanar same-colour faces (and star's k=0 spoke has rz:0, which `isRotated` reads
//    as un-rotated) that the box z-fight check would false-positive on.
const ROUND_OPS = ['cylinder', 'disc', 'cone', 'deltaFins', 'texturedCylinder', 'torus', 'tube', 'texturedDisc', 'decal', 'texturedPanel', 'loaf', 'wheel', 'pipe', 'tubeMast', 'star', 'meshReflector'];

function mock() {
  const calls = [];
  return { calls, box: (w, h, d, x, y, z, color, opts) => calls.push({ w, h, d, x, y, z, color, opts }) };
}
const T = { hi: '#1', mid: '#2', lo: '#3', slot: '#4', bright: '#5' };
const O = { x: 0, y: 0, z: 0 };

// representative args per PURE operator, used by the property tests below
const SAMPLES = {
  bevelBox: { w: 0.28, h: 0.14, d: 0.14 },
  panel: { w: 0.7, h: 0.4 },
  plate: { w: 1.2, d: 0.6 },
  stencil: { w: 0.04, h: 0.04 },
  planks: { w: 0.798, h: 0.225, d: 0.452, count: 2 },
  finSet: { count: 4, root: 1.8, span: 0.9, r0: 0.33, sweep: 0.6, phase: 0.785 },
  latticeBeam: { len: 7, w: 0.6, h: 0.7 },
  cabinet: { w: 1.6, h: 1.8, d: 2.4 },
  drawerStack: { w: 0.42, h: 0.7, d: 0.66, count: 3 },
  legs: { w: 1, d: 0.6, h: 0.7 },
  lidBox: { w: 0.28, h: 0.165, d: 0.14, lid: 0.03 },
  strapBand: { w: 0.03, h: 0.165, d: 0.14 },
  handleU: { w: 0.18, h: 0.05 },
};
// extents-only samples for the THREE-bound ops (impls aren't node-runnable)
const ROUND_SAMPLES = {
  cylinder: { r: 0.33, h: 2.7 },
  disc: { r: 0.125, h: 0.003, axis: 'y' },
  cone: { r: 0.25, h: 0.96 },
  deltaFins: { count: 4, root: 1.8, span: 0.97, r0: 0.33 },
  texturedCylinder: { r: 0.25, h: 6.98 },
  torus: { r: 0.12, tube: 0.009, axis: 'y' },
  tube: { pts: [[0, 0, 0], [0, 0.05, 0.05], [0.1, 0.05, 0.05]], tube: 0.011 },
  texturedDisc: { r: 0.045, axis: 'y' },
  decal: { w: 0.11, h: 0.14, axis: 'z' },
  texturedPanel: { w: 0.15, h: 0.30, axis: 'z' },
  loaf: { w: 0.226, h: 0.108, d: 0.175 },
  wheel: { r: 0.45, w: 0.25, axis: 'x', twin: true },
  pipe: { pts: [[0, 0, 0], [0, 0.4, 0], [0.3, 0.4, 0]], r: 0.04 },
  tubeMast: { baseW: 1.2, baseD: 1.2, h: 4.5, topW: 0.3, topD: 0.3, apexZ: -0.7 },   // apexZ leans the top → exercises the z-extents lean math
  star: { r: 0.5, points: 5, th: 0.05 },
  meshReflector: { w: 6.75, h: 3.5, clipTop: 0.18, chord: 0.05 },   // P-37 «Bar Lock» dish (clipped pentagon top)
};

test('every manifest operator has an impl (pure or round), extents, sample args, and a valid anchor', () => {
  for (const [op, m] of Object.entries(MANIFEST)) {
    assert.ok(PURE_OPS[op] || ROUND_OPS.includes(op), `${op}: not a pure impl and not a declared round op`);
    assert.equal(typeof EXTENTS[op], 'function', `${op}: missing extents`);
    assert.ok(SAMPLES[op] || ROUND_SAMPLES[op], `${op}: add sample args so the property tests cover it`);
    assert.ok(['center', 'floor'].includes(m.anchor), `${op}: anchor must be center|floor`);
  }
});

test('round-op extents produce sane positive AABBs', () => {
  for (const [op, args] of Object.entries(ROUND_SAMPLES)) {
    const { min, max } = EXTENTS[op](args);
    for (let i = 0; i < 3; i++) assert.ok(max[i] > min[i], `${op}: degenerate extents axis ${i}`);
  }
});

test('lidBox emits body, overhanging lid, hinges and hasp hardware', () => {
  const b = mock();
  PURE_OPS.lidBox(b, SAMPLES.lidBox, T, O);
  assert.equal(b.calls.length, 8);
  const lid = b.calls[2];
  assert.ok(lid.w > SAMPLES.lidBox.w, 'lid overhangs the body');
  assert.ok(b.calls.some((c) => c.color === T.bright), 'has a lit accent');
});

test('strapBand wraps all four sides', () => {
  const b = mock();
  PURE_OPS.strapBand(b, SAMPLES.strapBand, T, O);
  assert.equal(b.calls.length, 4);
  const zs = b.calls.map((c) => c.z);
  assert.ok(Math.max(...zs) > 0.07 && Math.min(...zs) < -0.07, 'front and back runs');
});

test('handleU emits a crossbar and two posts', () => {
  const b = mock();
  PURE_OPS.handleU(b, SAMPLES.handleU, T, O);
  assert.equal(b.calls.length, 3);
  assert.equal(b.calls.filter((c) => c.color === T.bright).length, 1);
});

test('planks emits count boards + count-1 recessed seams, filling 0..h', () => {
  const b = mock();
  PURE_OPS.planks(b, { w: 0.8, h: 0.2, d: 0.45, count: 2 }, T, O);
  assert.equal(b.calls.length, 3);                       // 2 boards + 1 seam
  const tops = b.calls.map((c) => c.y + c.h / 2);
  assert.ok(Math.abs(Math.max(...tops) - 0.2) < 1e-9, 'fills to h');
  assert.equal(b.calls.filter((c) => c.color === T.slot).length, 1, 'one recessed seam');
});

test('planks axis:z lays boards side-by-side along depth', () => {
  const b = mock();
  PURE_OPS.planks(b, { w: 0.8, h: 0.02, d: 0.45, count: 3, axis: 'z' }, T, O);
  assert.equal(b.calls.length, 5);                       // 3 boards + 2 seams
  const zs = b.calls.filter((c) => c.color !== T.slot).map((c) => c.z);
  assert.ok(new Set(zs.map((z) => z.toFixed(3))).size === 3, 'boards at distinct z');
});

test('stencil is a single proud single-tone box', () => {
  const b = mock();
  PURE_OPS.stencil(b, SAMPLES.stencil, T, O);
  assert.equal(b.calls.length, 1);
  assert.ok(b.calls[0].z > 0, 'stands proud of the face plane (+Z)');
});

test('stencil with lines:3 emits 3 text-like bars inside the same envelope', () => {
  const b = mock();
  PURE_OPS.stencil(b, { w: 0.1, h: 0.05, lines: 3 }, T, O);
  assert.equal(b.calls.length, 3);
  assert.ok(b.calls[2].w < b.calls[0].w, 'last line is shorter (reads as text)');
  for (const c of b.calls) assert.ok(c.y + c.h / 2 <= 0.025 + 1e-9 && c.y - c.h / 2 >= -0.025 - 1e-9, 'bars stay inside h');
});

// ── property: no two same-normal coplanar overlapping faces (z-fighting) ───
// Two boxes whose SAME-direction faces share a plane AND overlap in cross-
// section will shimmer. Opposite-normal contact (stacking) is fine. Rotated
// boxes (opts.rx/ry/rz) are skipped — AABB face math doesn't apply to them;
// they're covered by the visual graze-angle check in the viewer.
const isRotated = (c) => c.opts && (c.opts.rx || c.opts.ry || c.opts.rz);

function zFightPairs(calls) {
  const eps = 1e-9, bad = [];
  const boxes = calls.filter((c) => !isRotated(c)).map((c) => ({
    min: [c.x - c.w / 2, c.y - c.h / 2, c.z - c.d / 2],
    max: [c.x + c.w / 2, c.y + c.h / 2, c.z + c.d / 2],
  }));
  const overlap1D = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0) > eps;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const A = boxes[i], B = boxes[j];
    for (let ax = 0; ax < 3; ax++) {
      const o1 = (ax + 1) % 3, o2 = (ax + 2) % 3;
      const crossOverlap = overlap1D(A.min[o1], A.max[o1], B.min[o1], B.max[o1]) && overlap1D(A.min[o2], A.max[o2], B.min[o2], B.max[o2]);
      if (!crossOverlap) continue;
      if (Math.abs(A.min[ax] - B.min[ax]) < eps || Math.abs(A.max[ax] - B.max[ax]) < eps) bad.push([i, j, ax]);
    }
  }
  return bad;
}

test('PROPERTY: no operator emits same-normal coplanar overlapping faces', () => {
  for (const [op, args] of Object.entries(SAMPLES)) {
    const b = mock();
    PURE_OPS[op](b, args, T, { x: 0, y: 0, z: 0 });
    const bad = zFightPairs(b.calls);
    assert.deepEqual(bad, [], `${op}: coplanar same-normal overlapping faces (z-fight) between emitted boxes ${JSON.stringify(bad)}`);
  }
});

test('PROPERTY: every (axis-aligned) emitted box stays inside the operator\'s declared extents', () => {
  for (const [op, args] of Object.entries(SAMPLES)) {
    const b = mock();
    PURE_OPS[op](b, args, T, { x: 0, y: 0, z: 0 });
    const { min, max } = EXTENTS[op](args);
    for (const c of b.calls) {
      if (isRotated(c)) continue;            // rotated boxes: extents are conservative by design
      const bmin = [c.x - c.w / 2, c.y - c.h / 2, c.z - c.d / 2];
      const bmax = [c.x + c.w / 2, c.y + c.h / 2, c.z + c.d / 2];
      for (let i = 0; i < 3; i++) {
        assert.ok(bmin[i] >= min[i] - 1e-9 && bmax[i] <= max[i] + 1e-9,
          `${op}: an emitted box escapes the declared extents on axis ${i} (box ${bmin[i].toFixed(4)}..${bmax[i].toFixed(4)} vs extents ${min[i].toFixed(4)}..${max[i].toFixed(4)})`);
      }
    }
  }
});
