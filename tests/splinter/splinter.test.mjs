import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSplinters, mergeBags } from '../../src/destruct.js';

test('makeSplinters: count teeth → 2 triangles each (two-sided) → 18 floats/tooth', () => {
  const b = makeSplinters(0, 5, 0, 0.5, 123, 8);
  // 8 teeth × 2 windings × 3 verts × 3 floats = 144 position floats
  assert.equal(b.positions.length, 144);
  assert.equal(b.colors.length, 144);
  assert.equal(b.normals.length, 144);
  assert.equal(b.uvs.length, 96);            // 48 verts × 2
});

test('makeSplinters: base verts sit on the cut plane, tips rise within [lenMin,lenMax]', () => {
  const cy = 5, lenMin = 0.2, lenMax = 0.6;
  const b = makeSplinters(0, cy, 0, 0.5, 7, 8, lenMin, lenMax, true);
  let baseCount = 0, tipMin = Infinity, tipMax = -Infinity;
  for (let i = 0; i < b.positions.length; i += 3) {
    const y = b.positions[i + 1];
    if (Math.abs(y - cy) < 1e-9) baseCount++;
    else { tipMin = Math.min(tipMin, y); tipMax = Math.max(tipMax, y); }
  }
  assert.ok(baseCount >= 32, `base verts on plane: ${baseCount}`);   // 2 of 3 verts/tri are on the rim, ×16 tris
  assert.ok(tipMin >= cy + lenMin - 1e-9 && tipMax <= cy + lenMax + 1e-9, `tips ${tipMin}..${tipMax}`);
});

test('makeSplinters: base verts lie within the break radius', () => {
  const r = 0.5, b = makeSplinters(0, 5, 0, r, 9, 8);
  for (let i = 0; i < b.positions.length; i += 3) {
    const x = b.positions[i], z = b.positions[i + 2];
    assert.ok(Math.hypot(x, z) <= r + 1e-9, `vert radius ${Math.hypot(x, z)} > ${r}`);
  }
});

test('makeSplinters: up=false flips tips below the cut', () => {
  const cy = 5, b = makeSplinters(0, cy, 0, 0.5, 3, 8, 0.2, 0.6, false);
  let minY = Infinity;
  for (let i = 0; i < b.positions.length; i += 3) minY = Math.min(minY, b.positions[i + 1]);
  assert.ok(minY < cy, `min tip y ${minY} should dip below cut ${cy}`);
});

test('makeSplinters: deterministic for the same seed', () => {
  const a = makeSplinters(1, 2, 3, 0.4, 42, 8);
  const b = makeSplinters(1, 2, 3, 0.4, 42, 8);
  assert.deepEqual(a.positions, b.positions);
});

test('makeSplinters: colour = the raw-wood tone on every vertex', () => {
  const col = [0.74, 0.60, 0.42], b = makeSplinters(0, 0, 0, 0.5, 5, 4, 0.2, 0.5, true, col);
  for (let i = 0; i < b.colors.length; i += 3) {
    assert.equal(b.colors[i], col[0]); assert.equal(b.colors[i + 1], col[1]); assert.equal(b.colors[i + 2], col[2]);
  }
});

test('mergeBags: concatenates both bags attribute-by-attribute', () => {
  const a = { positions: [0,0,0, 1,0,0, 0,1,0], colors: [1,1,1, 1,1,1, 1,1,1], normals: [0,0,1, 0,0,1, 0,0,1], uvs: [0,0, 1,0, 0,1] };
  const b = { positions: [9,9,9], colors: [2,2,2], normals: [1,0,0], uvs: [5,5] };
  const m = mergeBags(a, b);
  assert.deepEqual(m.positions, [0,0,0, 1,0,0, 0,1,0, 9,9,9]);
  assert.deepEqual(m.colors,    [1,1,1, 1,1,1, 1,1,1, 2,2,2]);
  assert.deepEqual(m.normals,   [0,0,1, 0,0,1, 0,0,1, 1,0,0]);
  assert.deepEqual(m.uvs,       [0,0, 1,0, 0,1, 5,5]);
});

test('mergeBags: does not mutate the inputs', () => {
  const a = { positions: [1,2,3], colors: [0,0,0], normals: [0,1,0], uvs: [0,0] };
  const b = { positions: [4,5,6], colors: [1,1,1], normals: [1,0,0], uvs: [1,1] };
  const aPos = a.positions.slice();
  mergeBags(a, b);
  assert.deepEqual(a.positions, aPos);
});

test('mergeBags: real makeSplinters crown appends onto a wood bag', () => {
  const wood = { positions: [0,0,0, 1,0,0, 0,1,0], colors: [0.4,0.3,0.2, 0.4,0.3,0.2, 0.4,0.3,0.2], normals: [0,0,1,0,0,1,0,0,1], uvs: [0,0,0,0,0,0] };
  const crown = makeSplinters(0, 0, 0, 0.3, 7, 8);
  const m = mergeBags(wood, crown);
  assert.equal(m.positions.length, wood.positions.length + crown.positions.length);
  assert.equal(m.colors.length, wood.colors.length + crown.colors.length);
});
