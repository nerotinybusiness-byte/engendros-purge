# Splintered Tree Breaks + No-Levitation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat cut at every tree break with a jagged, paler "torn wood" splinter crown, and guarantee no broken piece levitates — keeping the current hinge/flat-fall.

**Architecture:** A pure THREE-free generator `makeSplinters` (in `destruct.js`, next to `splitGeomAtY`) returns a triangle-soup bag of seeded jagged teeth around the break circle. `forestdemo.js` builds a small splinter mesh from that bag and parents it to each break piece (stump = teeth up out of the cut; falling top = teeth down from its torn end), at every break path (first snap / re-snap / uproot / sectional chunk gap). A no-levitation audit guards the settle path.

**Tech Stack:** vanilla ES modules, Three.js r160 (import map `import * as THREE from 'three'`), `node:test` for the pure generator, isolated Chrome + no-store server for the visual.

## Global Constraints

- No build step; native ES modules; all internal imports are bare/unversioned.
- `makeSplinters` lives in `src/destruct.js` and MUST stay THREE-free (no `import 'three'`) — `destruct.js` is node-loadable and the existing test suite imports it.
- Deterministic: seed splinters off the existing fell seed so host + clients + late-joiners replaying `forestfx {dx,dz,seed}` produce identical crowns. **No new network message.**
- Splinters are cosmetic: **no collision box, no `box.cap`** (the trunk/log capsules from PR #124, if present on a future merge, already cover the bole; this branch is independent of #124).
- Keep the current fall behaviour (hinge → tip → flat-fall) unchanged. This adds break-face geometry + a gravity guard only.
- Splinter colour = a paler raw-wood tone than the bark.
- In-browser verification in **Chrome** against a **no-store** server (`?map=forest`).
- Cache-bust ritual (`?v=N` on `index.html` + `GAME_BUILD`) once at the end, before the PR.
- Do NOT touch hitbox files (`raycollide.js`/`grid.js`/`world.js`), buildings, movement, nav, or co-op netcode.

**Branch:** `feat/tree-splinter-breaks` (worktree `.claude/worktrees/tree-splinter`, off PR #117).

---

## File structure

- `src/destruct.js` — **add** `makeSplinters(...)` (pure, THREE-free), beside `splitGeomAtY`.
- `tests/splinter/splinter.test.mjs` — **new** node unit tests for `makeSplinters`.
- `src/forestdemo.js` — **modify**: build + parent splinter meshes at each break (`fellTree` first-snap/re-snap/uproot; `breakLogSeg` chunk gaps); the no-levitation guard in the settle/register path.

---

## Interfaces (locked)

- `makeSplinters(cx, cy, cz, radius, seed, count, lenMin, lenMax, up, color) → { positions:number[], colors:number[], normals:number[], uvs:number[] }` — a non-indexed triangle-soup bag (same shape `splitGeomAtY` / `_geomFrom` use). `up=true` → teeth point +Y from the cut; `up=false` → −Y. Deterministic in `seed`.
- `box`/mesh: the bag is turned into a mesh via the existing `this._geomFrom(bag)` (forestdemo) + a vertex-coloured wood material.

---

## Task 1: `makeSplinters` generator (pure, node-tested)

**Files:**
- Modify: `src/destruct.js` (add the function near `splitGeomAtY`, ~line 465)
- Test: `tests/splinter/splinter.test.mjs`

**Interfaces:**
- Produces: `makeSplinters(cx, cy, cz, radius, seed, count=8, lenMin=0.15, lenMax=0.6, up=true, color=[0.74,0.60,0.42]) → {positions,colors,normals,uvs}`.

- [ ] **Step 1: Write the failing test**

Create `tests/splinter/splinter.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSplinters } from '../../src/destruct.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/splinter/splinter.test.mjs`
Expected: FAIL — `makeSplinters` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/destruct.js`, add after `splitGeomAtY` (around line 465):

```js
// makeSplinters — a jagged "torn wood" crown for a break face. PURE & THREE-free (node-testable),
// returns a non-indexed triangle-soup bag {positions,colors,normals,uvs} in the LOCAL space of the
// piece it is parented to. The break is a circle of `radius` centred at (cx,cy,cz); `count` teeth ring
// it; each tooth's tip is pushed along ±Y (trunks build along +Y) by a SEEDED length in [lenMin,lenMax]
// (varying heights = torn look). `up` picks the direction: a stump points teeth up out of the cut; a
// broken/falling top points them the other way. Both triangle windings are emitted so a single-sided
// wood material shows the teeth from both faces. Deterministic: same seed → same crown.
export function makeSplinters(cx, cy, cz, radius, seed, count = 8, lenMin = 0.15, lenMax = 0.6, up = true, color = [0.74, 0.60, 0.42]) {
  const positions = [], colors = [], normals = [], uvs = [];
  let s = (seed >>> 0) || 1;
  const rng = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const dir = up ? 1 : -1, cr = color[0], cg = color[1], cb = color[2];
  const tooth = (ax, ay, az, bx, by, bz, tx, ty, tz) => {
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = tx - ax, vy = ty - ay, vz = tz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    // winding A (n) then winding B (−n): two-sided
    const tri = (p, q, w, sgn) => {
      positions.push(p[0], p[1], p[2], q[0], q[1], q[2], w[0], w[1], w[2]);
      for (let k = 0; k < 3; k++) { normals.push(nx * sgn, ny * sgn, nz * sgn); colors.push(cr, cg, cb); uvs.push(0, 0); }
    };
    const A = [ax, ay, az], B = [bx, by, bz], T = [tx, ty, tz];
    tri(A, B, T, 1); tri(B, A, T, -1);
  };
  for (let i = 0; i < count; i++) {
    const a0 = (i / count) * Math.PI * 2, a1 = ((i + 1) / count) * Math.PI * 2;
    const r0 = radius * (0.8 + rng() * 0.2), r1 = radius * (0.8 + rng() * 0.2);   // rim base, within radius
    const am = (a0 + a1) / 2, rm = radius * (0.15 + rng() * 0.45);                // tip pulled inward
    const len = lenMin + rng() * (lenMax - lenMin);
    tooth(
      cx + Math.cos(a0) * r0, cy, cz + Math.sin(a0) * r0,
      cx + Math.cos(a1) * r1, cy, cz + Math.sin(a1) * r1,
      cx + Math.cos(am) * rm, cy + dir * len, cz + Math.sin(am) * rm,
    );
  }
  return { positions, colors, normals, uvs };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/splinter/splinter.test.mjs`
Expected: PASS (6 tests). Then run the FULL suite `node --test` → all green (baseline + 6).

- [ ] **Step 5: Commit**

```bash
git add src/destruct.js tests/splinter/splinter.test.mjs
git commit -m "feat(forest): makeSplinters — procedural torn-wood break crown (pure) + tests"
```

---

## Task 2: splinter meshes on snap / re-snap / uproot break faces

**Files:**
- Modify: `src/forestdemo.js` (`fellTree`, ~lines 219-283; add a `WOOD_RAW` constant near the top constants ~line 45; add a small `_splinterMesh` helper near `_geomFrom` ~line 308)

**Interfaces:**
- Consumes: `makeSplinters` (Task 1); the existing `this._geomFrom(bag)`; `rec.spine`, `rec.trunkR`, `rec.fullH`, `breakY`, `rec.yaw`, the fell `seed` (`sd`).
- Produces: a splinter mesh parented to the stump (teeth up at the cut) and to the falling top group (teeth down from its torn end), on every break.

**Background the implementer must confirm first (read, don't guess):**
- In `fellTree`, the stump mesh (`stumpMesh`) has its geometry local frame = tree base at y=0, the cut at local y=`breakY`; it's placed at `(rec.x, y0, rec.z)` with `rotation.y = rec.yaw`. So a splinter mesh **added as a child of `stumpMesh`** is in that pre-yaw local frame.
- The falling top (`topWoodMesh`) is re-zeroed so its break sits at local y≈0; it's added to a `top` group → `pivot` at `(rec.x, y0+breakY, rec.z)`. **Confirm** `topWoodMesh.geometry.boundingBox` min.y ≈ 0 (call `geometry.computeBoundingBox()`); if instead the break is at y≈`breakY`, set the top splinter `cy` to that value.
- The leaning-centreline offset at a height: `fellTree` already interpolates `rec.spine` (see `_buildTrunkBands`' `cl(yt)` — reuse the same interpolation to get `[lx, lz]` at `breakY`).
- The trunk radius at the cut: `radius = rec.trunkR * (1 - 0.6 * (breakY / (rec.fullH || rec.height))) + 0.1` (the same taper `_buildTrunkBands` uses).

- [ ] **Step 1: Add the raw-wood colour constant + the splinter-mesh helper**

Near the other module constants in `src/forestdemo.js` (e.g. after `STUB_FLOOR`, ~line 45):

```js
const WOOD_RAW = [0.78, 0.63, 0.45];   // paler raw inner-wood tone for fresh break splinters (vs darker bark)
```

Near `_geomFrom` (~line 308), add:

```js
  // Build a splinter "torn wood" crown mesh for a break face, in the LOCAL frame of the piece it parents
  // to. cx/cz = leaning-centreline offset at the cut; cy = cut height in that frame; up = teeth direction.
  _splinterMesh(cx, cy, cz, radius, seed, up, material) {
    const bag = makeSplinters(cx, cy, cz, Math.max(0.12, radius), (seed >>> 0) || 1, 9, radius * 0.5, radius * 1.7, up, WOOD_RAW);
    const m = new THREE.Mesh(this._geomFrom(bag), material);
    m.castShadow = true;
    return m;
  }
```

Add `makeSplinters` to the import from `./destruct.js` at the top of `src/forestdemo.js` (the line currently importing `splitGeomAtY` etc.).

- [ ] **Step 2: Compute the cut centreline + radius once in `fellTree`, after `breakY` is known**

In `fellTree`, after the block that sets `breakY`/`liveStump`/meshes (right after line ~251, before "remove the OLD standing mesh"), add:

```js
    // ── BREAK SPLINTERS — torn raw wood at the snap, on both faces (replaces the flat-cut look) ──
    const _fullH = rec.fullH || rec.height || 1;
    const _cl = (yt) => {                                   // leaning-centreline [lx,lz] at local height yt (pre-yaw)
      const sp = rec.spine;
      if (!sp || !sp.length) return [0, 0];
      if (yt <= sp[0][1]) return [sp[0][0], sp[0][2]];
      for (let i = 0; i < sp.length - 1; i++) { const a = sp[i], b = sp[i + 1]; if (yt <= b[1] + 1e-6) { const tt = (yt - a[1]) / ((b[1] - a[1]) || 1); return [a[0] + (b[0] - a[0]) * tt, a[2] + (b[2] - a[2]) * tt]; } }
      const e = sp[sp.length - 1]; return [e[0], e[2]];
    };
    const _spl = _cl(breakY);
    const _splR = (rec.trunkR || 0.3) * (1 - 0.6 * (breakY / _fullH)) + 0.1;
    const _splMat = (stumpMesh && stumpMesh.material) || (topWoodMesh && topWoodMesh.material) || voxelMaterial();
```

- [ ] **Step 3: Parent a teeth-up crown to the stump (when there is a live or inert stump)**

Inside the `if (liveStump && stumpMesh) { … }` block (after `this._buildTrunkBands(...)`, ~line 262) AND the `else { … if (stumpMesh) {…} }` inert-stub branch (~line 267), add — in each — after the stump mesh is positioned and added:

```js
      stumpMesh.add(this._splinterMesh(_spl[0], breakY, _spl[1], _splR, (rec.id * 2654435761) >>> 0, true, _splMat));
```

(The child inherits `stumpMesh`'s position + yaw, so the local-frame bag lands correctly at the cut.)

- [ ] **Step 4: Parent a teeth-down crown to the falling top**

Where the falling top is assembled (the block that builds `const top = new THREE.Group(); … top.add(topWoodMesh); … pivot.add(top)`, ~line 272-283 in `_registerFallenLog`'s caller / the fall block), after `top.add(topWoodMesh)`, add:

```js
      // confirm the top's break is at local y≈0 (re-zeroed); if its bbox min.y is materially > 0, use that as cy
      topWoodMesh.geometry.computeBoundingBox();
      const _topCutY = Math.abs(topWoodMesh.geometry.boundingBox.min.y) < 0.05 ? 0 : topWoodMesh.geometry.boundingBox.min.y;
      top.add(this._splinterMesh(0, _topCutY, 0, _splR, ((rec.id * 2654435761) >>> 0) ^ 0x5a, false, topWoodMesh.material));
```

(The top group already carries `rotation.y = rec.yaw`; the break is on the trunk axis ≈ centre, so cx=cz=0 is correct. The `^ 0x5a` makes the top crown differ from the stump crown while staying seeded/deterministic.)

- [ ] **Step 5: Verify in-browser (Chrome, no-store)**

Start a no-store server from the worktree and open `http://localhost:<port>/?map=forest&cb=1` in Chrome. Fell several trees (shoot the bole). Confirm:
1. Every snap leaves **jagged paler splinters** on the stump top AND on the falling top's broken end — no flat cut.
2. Re-snapping a tall stump again shows fresh splinters at the new break.
3. An uprooted/whole-tree topple shows splinters at its base.
4. The fall still behaves as before; splinters ride the falling top down.
Tune `count` / `lenMin..lenMax` / `WOOD_RAW` if the teeth read too tall/short/flat. Run `node --test` (regression, still green).

- [ ] **Step 6: Commit**

```bash
git add src/forestdemo.js
git commit -m "feat(forest): torn-wood splinters on snap/re-snap/uproot break faces"
```

---

## Task 3: splinters on sectional chunk gaps

**Files:**
- Modify: `src/forestdemo.js` (`breakLogSeg`, where a fallen-log chunk is shot out — find it via `breakLogSeg` / where `seg` is removed)

**Interfaces:**
- Consumes: `this._splinterMesh`, `makeSplinters`, the log's per-segment data (`seg`, its world axis/centre, the log radius `r`).

- [ ] **Step 1: Read `breakLogSeg` and the segment data**

Run: `grep -n "breakLogSeg" src/forestdemo.js` and read the function. Identify, for the removed chunk's two surviving neighbours, the world position of each newly-exposed end and the log radius (`log.trunkR`), and the log's 3-D axis (the same `[s*dirXZ[0], c, s*dirXZ[1]]` used in `_registerFallenLog`, or stored on the log/seg).

- [ ] **Step 2: Add splinters at the gap when a chunk is removed**

In `breakLogSeg`, after the chunk's meshes/boxes are removed, for each surviving neighbour end exposed by the gap, add a splinter crown oriented along the log axis (teeth pointing into the gap), parented to the log's pivot group so it rides the log:

```js
    // torn wood at the freshly-exposed chunk faces (gap edges), pointing into the gap along the log axis
    const _r = Math.max(0.12, (log.trunkR || 0.25));
    const _axis = log._axis3 || [0, 1, 0];   // [ax,ay,az] unit log heading; store it in _registerFallenLog if absent
    for (const end of exposedEnds) {          // end = { x, y, z, sign } world pos of a surviving neighbour's cut + which way it faces
      const localBag = makeSplinters(0, 0, 0, _r, ((end.sid ?? 1) * 2654435761) >>> 0, 7, _r * 0.4, _r * 1.3, true, WOOD_RAW);
      const m = new THREE.Mesh(this._geomFrom(localBag), log.mesh ? undefined : voxelMaterial());
      // orient the +Y teeth onto the log axis * sign, place at the exposed end (world → parent-local if parented)
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(_axis[0] * end.sign, _axis[1] * end.sign, _axis[2] * end.sign));
      m.position.set(end.x, end.y, end.z);
      m.material = (log.mesh && log.mesh.children[0] && log.mesh.children[0].material) || voxelMaterial();
      (log.mesh || this.scene).add(m);
    }
```

> If the existing `breakLogSeg` doesn't readily expose `exposedEnds`/`_axis3`, store the log's 3-D axis on the log object in `_registerFallenLog` (the spec's `[s*dirXZ[0], c, s*dirXZ[1]]`) and compute the two neighbour ends from the removed seg's AABB centre ± half-extent along that axis. Keep it to the two faces actually exposed by the gap.

- [ ] **Step 3: Verify in-browser**

`?map=forest`: fell a tree, let it lie, then shoot a chunk out of the middle of the log. Confirm the gap's two facing ends show splinters along the log axis. Run `node --test` (green).

- [ ] **Step 4: Commit**

```bash
git add src/forestdemo.js
git commit -m "feat(forest): torn-wood splinters at sectional log chunk gaps"
```

---

## Task 4: no-levitation audit + guard

**Files:**
- Modify: `src/forestdemo.js` (the settle/registration path: `_registerFallenLog` / `regroundLog` / the `FALLING` settle handler)

**Interfaces:**
- Consumes: the existing `regroundLog(log)` (drops a log so its lowest box rests on the terrain).

- [ ] **Step 1: Audit the settle path for floating cases**

Read the `FALLING` settle handler (where a hinged top finishes and becomes a registered log) and the propped-vs-flat branch. Identify any path where a settled piece (propped top, flat log, orphan chunk after a cascade) is NOT followed by a `regroundLog` (or equivalent ground-snap). List each in the report.

- [ ] **Step 2: Add a defensive ground-snap guard**

Ensure EVERY settle/registration path ends with a reground. Concretely, in `_registerFallenLog`, the final line already calls `this.regroundLog(log)` — confirm it. For the **propped** branch (a top that stays leaning on the stump) and the **orphan-cascade** branch (chunks that fall when support is shot out), add a `regroundLog`/ground-snap call after they settle so no piece floats:

```js
    // guard: a settled/orphaned piece must rest ON the terrain — never levitate
    if (log) this.regroundLog(log);
```

(Place it at the end of each settle branch that currently lacks it. `regroundLog` is idempotent — it early-returns when the piece already rests within 0.1 m of the ground, so calling it defensively is safe.)

- [ ] **Step 3: Verify in-browser**

`?map=forest`: fell trees onto slopes, re-snap stumps, shoot chunks to trigger cascades, and dig under a fallen log. Confirm NO piece is left hanging in the air at any point (watch the moment of settle and after a cascade). Run `node --test` (green).

- [ ] **Step 4: Commit**

```bash
git add src/forestdemo.js
git commit -m "fix(forest): guarantee broken pieces ground (no levitating block)"
```

---

## Finishing (after all tasks verified)

- [ ] `node --test` — full suite green.
- [ ] Chrome regression sweep (`?map=forest`): snap/re-snap/uproot splinters, chunk-gap splinters, no levitation, fall unchanged; no console errors.
- [ ] Cache-bust: bump `?v=N` on `index.html` + `GAME_BUILD` in `src/game.js`; commit `chore(forest): cache-bust vNNN`.
- [ ] `git push -u origin feat/tree-splinter-breaks` + `gh pr create --base feat/forest-tree-physics-2` (stacked on #117); request review.

---

## Self-review (against the spec)

- **Spec §3.1 generator** → Task 1 (`makeSplinters`, pure, node-tested). ✓
- **Spec §3.2 raw-wood colour** → `WOOD_RAW` (Task 2) + the `color` param/test (Task 1). ✓
- **Spec §3.3 integration, all break types** → Task 2 (snap/re-snap/uproot) + Task 3 (sectional chunk gaps). ✓
- **Spec §3.4 no-levitation** → Task 4 (audit + reground guard). ✓
- **Spec §3.5 determinism/co-op** → seeded off `rec.id`/fell seed in Tasks 2-3; no netcode added. ✓
- **Spec §3.6 no collision / perf** → splinter meshes carry no box/cap; only triangles. ✓ (Verify in review that no `world.boxes.push`/`grid.addBox` is added for splinters.)
- **Placeholder scan:** Tasks 1-2 carry complete code; Task 3/4 carry concrete code with a clearly-flagged "if the existing structure differs, store `_axis3`/compute ends" adaptation (a real, bounded instruction, not a TODO); Task 4's audit produces a concrete guard. No stray/invalid lines in any test or code block.
- **Type consistency:** `makeSplinters(cx,cy,cz,radius,seed,count,lenMin,lenMax,up,color)` and the `{positions,colors,normals,uvs}` bag shape are identical across Task 1 (def/tests), Task 2 (`_splinterMesh`), and Task 3. ✓
