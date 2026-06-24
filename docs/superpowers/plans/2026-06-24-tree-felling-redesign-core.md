# Tree Felling Redesign — CORE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bake splinter crowns INTO each wood piece's geometry (so they inherit the wood's whole lifecycle) and rework felling to a permanent destructible stump where only the part above the cut falls.

**Architecture:** A pure bag-merge (`mergeBags`, in THREE-free `destruct.js`, node-tested) concatenates a `makeSplinters` triangle bag into a wood piece's geometry bag; a thin `forestdemo` helper `_bakeSplinters` applies it to built geometries. `fellTree` is reworked so every snap leaves a live, shootable, re-snappable stump (only the above-cut part falls); the old separate-mesh splinter code and the whole-topple / inert-stub paths are removed.

**Tech Stack:** vanilla ES modules, Three.js r160 (import map), `node:test` for the pure merge, isolated Chrome + no-store server for the visual.

## Global Constraints

- No build step; native ES modules; bare/unversioned internal imports.
- `mergeBags` lives in `src/destruct.js` and MUST stay THREE-free (no `import 'three'`) — node-loadable. Anything touching `THREE.BufferGeometry` lives in `src/forestdemo.js`.
- Splinters are baked into the wood piece's OWN geometry (no separate mesh, no parenting). They must inherit fall/fire/move/remove/re-bin automatically.
- Splinter radius = the real VISUAL trunk radius at the cut (`rec.trunkR * (1 - 0.6 * breakY/fullH)`), never the padded collision radius.
- Deterministic: splinters seeded off the piece's stable id; no new network message. Felling stays host-authoritative, replayed via the existing `forestfx`/`fellTreeById` path.
- Every snap leaves a live, shootable stump; only the above-cut part falls; the base only falls via dig-uproot.
- Do NOT touch hitbox files (`raycollide.js`/`grid.js`/`world.js`), buildings, movement, nav, co-op netcode. IMPACT (building collision + player dmg + weight) is a SEPARATE later spec — out of scope here.

**Branch:** `feat/tree-splinter-breaks` (worktree `.claude/worktrees/tree-splinter`, off PR #117). This rewrites `fellTree` felling, which overlaps the brother's #117 — flag at PR time.

---

## File structure

- `src/destruct.js` — keep `makeSplinters`; **add** `mergeBags` (pure, THREE-free).
- `tests/splinter/splinter.test.mjs` — keep; **add** `mergeBags` tests.
- `src/forestdemo.js` — add `_bakeSplinters` helper; rework `fellTree` (permanent stump, bake splinters into stump+top); bake splinters into fallen-log chunks in `_registerFallenLog`; remove the separate-mesh splinter code (`_splinterMesh`, `_addGapSplinters`, `SPLINTER_MAT` usage as a material, the `.add(...)` parenting) and the whole-topple / inert-stub paths.

## Interfaces (locked)

- `makeSplinters(cx,cy,cz, radius, seed, count, lenMin, lenMax, up, color) → {positions,colors,normals,uvs}` (unchanged; the jittered generator).
- `mergeBags(base, add) → {positions,colors,normals,uvs}` — concatenate two triangle-soup bags (both carry the same attributes present). Pure, THREE-free.
- `forestdemo._bakeSplinters(geometry, cx,cy,cz, radius, seed, up) → THREE.BufferGeometry` — read `geometry`'s attrs into a bag, `mergeBags` with a `makeSplinters` crown, return a new geometry via `_geomFrom`. THREE-side.
- `forestdemo._geomFrom(bag) → THREE.BufferGeometry` (existing).
- `box.cap` etc. — NOT used here (CORE is geometry/felling only).

---

## Task C1: `mergeBags` pure helper + node tests

**Files:**
- Modify: `src/destruct.js` (add near `makeSplinters`)
- Test: `tests/splinter/splinter.test.mjs`

**Interfaces:**
- Produces: `mergeBags(base, add) → {positions,colors,normals,uvs}`.

- [ ] **Step 1: Write the failing test**

Append to `tests/splinter/splinter.test.mjs`:

```js
import { mergeBags } from '../../src/destruct.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/splinter/splinter.test.mjs`
Expected: FAIL — `mergeBags` not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/destruct.js`, add after `makeSplinters`:

```js
// mergeBags — concatenate two triangle-soup bags {positions,colors,normals,uvs} into a NEW bag (inputs
// untouched). Both bags must carry the same attributes (the wood bags and makeSplinters both produce all
// four). Used to bake a splinter crown INTO a wood piece's geometry so the teeth become triangles of that
// piece and inherit its whole lifecycle. PURE & THREE-free (node-testable).
export function mergeBags(base, add) {
  const cat = (a, b) => {
    if (a == null && b == null) return null;
    const out = a ? a.slice() : [];
    if (b) for (let i = 0; i < b.length; i++) out.push(b[i]);
    return out;
  };
  return {
    positions: cat(base.positions, add.positions),
    colors:    cat(base.colors,    add.colors),
    normals:   cat(base.normals,   add.normals),
    uvs:       cat(base.uvs,       add.uvs),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/splinter/splinter.test.mjs`
Expected: PASS. Then `node --test` (full) → all green (753 + 3 new = 756).

- [ ] **Step 5: Commit**

```bash
git add src/destruct.js tests/splinter/splinter.test.mjs
git commit -m "feat(forest): mergeBags — concat triangle-soup bags (bake splinters into geometry) + tests"
```

---

## Task C2: bake splinters into the stump + falling-top GEOMETRY

**Files:**
- Modify: `src/forestdemo.js` — add `_bakeSplinters` near `_geomFrom`; in `fellTree`, bake into the stump + top geometry and REMOVE the two `_splinterMesh(...)` child `.add(...)` calls.

**Interfaces:**
- Consumes: `mergeBags` (C1), `makeSplinters`, `_geomFrom`, `WOOD_RAW`.
- Produces: `_bakeSplinters(geometry, cx,cy,cz, radius, seed, up) → THREE.BufferGeometry`.

- [ ] **Step 1: Add the `_bakeSplinters` helper**

Near `_geomFrom` in `src/forestdemo.js`, add (and ensure `mergeBags` is in the `./destruct.js` import):

```js
  // Bake a splinter crown directly INTO a wood geometry: read its attrs into a bag, merge a makeSplinters
  // crown, return a new geometry. The teeth become triangles of THIS piece's mesh → they fall/burn/move/
  // disappear/re-bin with it automatically (no separate object). radius = the REAL visual wood radius at
  // the cut (not the padded collision radius); up flips teeth direction (stump = up, falling top = down).
  _bakeSplinters(geometry, cx, cy, cz, radius, seed, up) {
    const a = geometry.attributes;
    const bag = {
      positions: Array.from(a.position.array),
      colors:    a.color  ? Array.from(a.color.array)  : null,
      normals:   a.normal ? Array.from(a.normal.array) : null,
      uvs:       a.uv     ? Array.from(a.uv.array)      : null,
    };
    const r = Math.max(0.08, radius);
    const crown = makeSplinters(cx, cy, cz, r, (seed >>> 0) || 1, 9, r * 0.4, Math.min(r * 1.3, 0.85), up, WOOD_RAW);
    return this._geomFrom(mergeBags(bag, crown));
  }
```

- [ ] **Step 2: Bake into the stump + top geometry; remove the `_splinterMesh` child calls**

In `fellTree`, the splinter radius/centreline block already exists (`_cl`, `_splR`). Keep `_cl`/`_splR` (note `_splR` is already pad-free). Then:

- Where the **stump mesh** is built (`stumpMesh = new THREE.Mesh(split.stumpWoodGeometry, ...)` for first-snap, and `this._geomFrom(sp.lo)` for re-snap), wrap the geometry through `_bakeSplinters(..., up:true)` at the cut. E.g. first-snap:
  ```js
  stumpMesh = new THREE.Mesh(this._bakeSplinters(split.stumpWoodGeometry, _spl[0], breakY, _spl[1], _splR, (rec.id * 2654435761) >>> 0, true), split.material);
  ```
  and re-snap:
  ```js
  stumpMesh = new THREE.Mesh(this._bakeSplinters(this._geomFrom(sp.lo), _spl[0], breakY, _spl[1], _splR, (rec.id * 2654435761) >>> 0, true), wm.material);
  ```
  (Note `_cl`/`_splR` are computed AFTER the split block today — move that small block ABOVE the geometry builds, or compute `_spl`/`_splR` inline before building, so they're available. `breakY` is known per branch.)
- Where the **top wood mesh** is built, bake a teeth-DOWN crown at its torn end (local y≈0, cx=cz=0):
  ```js
  topWoodMesh = new THREE.Mesh(this._bakeSplinters(<topWoodGeometry>, 0, 0, 0, _splR, ((rec.id*2654435761)>>>0) ^ 0x5a, false), <material>);
  ```
  Confirm the top geometry's break is at local y≈0 (the current bbox check); if its bbox min.y is materially >0 pass that as cy.
- **REMOVE** the two separate-mesh splinter adds: `stumpMesh.add(this._splinterMesh(...))` (both the live-stump and inert-stub branches) and `top.add(this._splinterMesh(...))`. The teeth are now in the geometry.

- [ ] **Step 3: Verify in-browser (no-store, Chrome, `?map=forest`)**

Fell trees. Confirm the torn-wood teeth are part of the wood (they hinge/fall/lie exactly with the trunk, none left floating, none twist independently), hug the real trunk width, and are randomized. Run `node --test` (regression, green).

- [ ] **Step 4: Commit**

```bash
git add src/forestdemo.js
git commit -m "feat(forest): bake splinter crowns into stump + falling-top geometry (inherit lifecycle)"
```

---

## Task C3: permanent destructible stump model (only-above-falls)

**Files:**
- Modify: `src/forestdemo.js` `fellTree` — remove the whole-topple and inert-stub paths; always leave a live shootable stump; bottom of the re-snap recursion = full removal.

**Interfaces:** consumes the existing `_buildTrunkBands`, `rec.part`, `STUB_FLOOR`, the hinge/fall block.

- [ ] **Step 1: Always leave a live stump (remove whole-topple on snap)**

In the **first-snap** branch (`snapN===0`): DELETE the `if (!liveStump) { …topple whole… }` block (the current FIX-2 lines that dispose the split top and clone the whole tree). Always keep `stumpMesh = makeTree split stump` and set `liveStump = true` for a first snap (a first snap always has a real stump below the cut). The top is the split top.

In the **re-snap** branch (`snapN>0`): when the stump is too short to split further (`prevHeight < STUB_FLOOR + 0.6 || cut >= prevHeight - 0.3`), do NOT topple the whole remaining stump. Instead **fully remove the stump** (it crumbles): set `liveStump=false`, `stumpMesh=null`, `topWoodMesh=null` (nothing falls — the little stub is gone), mark `rec.standing=false` and `rec.part.dead=true`, drop its boxes, and emit a debris burst at the base:
```js
this.debris && this.debris.burst('splints', [rec.x, y0 + 0.2, rec.z], sd);
```
So repeatedly shooting a stump lowers it (normal re-snap) until the last hit removes it entirely — no inert immortal stub.

- [ ] **Step 2: Remove the inert-stub branch**

In the "surviving stump" section, the `else` branch (currently lines ~293-298: `rec.mesh=null; rec.standing=false; … inert stub … world.boxes.push(sb)`) is now only reached by (a) uproot (no stump, fine) and (b) the "fully remove" case from Step 1. DELETE the inert-stub collision box creation (`if (breakY > 0.05) { … stumpBox … }`) — a removed stump leaves NO bullet-immune box. Keep the uproot path (no stump) intact.

- [ ] **Step 2b: Stump HP for re-snap-down feel**

The live-stump branch already sets `rec.part.dhp = Math.max(8, TREE_HP[rec.cls] * (breakY / fullH))`, so a tall stump resists and a short stump dies in one more burst → natural "shoot it down piece by piece." Leave as-is (it already gives the owner-chosen behaviour).

- [ ] **Step 3: Verify in-browser**

`?map=forest`: shoot a standing tree → only the part above the hit falls; a rooted stump always remains and is shootable. Keep shooting the stump → it shortens, then the last burst removes it entirely (debris), leaving NO immortal/non-shootable stub. Charred + thin birches behave the same (always a shootable stump). Dig under a stump → it still uproots (whole topple). Run `node --test` (green).

- [ ] **Step 4: Commit**

```bash
git add src/forestdemo.js
git commit -m "feat(forest): permanent destructible stump — only above-cut falls, no inert stub / whole-topple"
```

---

## Task C4: bake splinters into fallen-log chunks; remove gap-splinter objects

**Files:**
- Modify: `src/forestdemo.js` `_registerFallenLog` (chunk build) + remove `_addGapSplinters` and its `breakLogSeg` calls.

- [ ] **Step 1: Bake crowns into each chunk's geometry**

In `_registerFallenLog`, where each fallen-log chunk mesh is built from `binFallenGeometry` output (a bag), bake a crown into BOTH cut faces of the chunk before `_geomFrom`. Compute the chunk's along-axis end centres from its bag bounds + the log's `_axis3`, and `mergeBags(chunkBag, makeSplinters(...))` for each exposed face (radius = `log.boleR`, the unpadded bole radius already stored). Build the chunk mesh from the merged bag. (The crowns are now triangles of the chunk → when a chunk is shot out and sunk by `_killSeg`, its splinters sink with it; no separate gap object.)

- [ ] **Step 2: Remove the separate gap-splinter code**

DELETE `_addGapSplinters` and its two call sites in `breakLogSeg`/`breakLogSegById`. (Gap faces are now baked at chunk-build time in Step 1; a shot-out chunk's neighbours already carry their baked end crowns.)

- [ ] **Step 3: Verify in-browser**

`?map=forest`: fell a tree, shoot a MIDDLE chunk out of the fallen log → that chunk AND its splinters vanish/sink together (no levitation, nothing left behind); the surviving neighbours show torn faces (their baked crowns). Run `node --test` (green).

- [ ] **Step 4: Commit**

```bash
git add src/forestdemo.js
git commit -m "feat(forest): bake splinter crowns into fallen-log chunks; drop separate gap-splinter meshes"
```

---

## Task C5: remove the dead separate-mesh splinter code

**Files:**
- Modify: `src/forestdemo.js`

- [ ] **Step 1: Delete now-unused code**

Remove `_splinterMesh` (no longer called after C2), the `SPLINTER_MAT` module const (no longer used as a material — `WOOD_RAW` is now passed to `makeSplinters` inside `_bakeSplinters`), and the `charLog` `SPLINTER_MAT` clone-guard line (the shared material is gone). Keep `WOOD_RAW`. Confirm no references remain:
```bash
grep -n "_splinterMesh\|_addGapSplinters\|SPLINTER_MAT" src/forestdemo.js
```
Expected: no matches.

- [ ] **Step 2: Verify**

Run `node --test` (green). In-browser `?map=forest`: full regression — snap/re-snap/uproot, stump destruction, fallen-log chunking, charring — all show baked-in torn wood, nothing floating, no console errors.

- [ ] **Step 3: Commit**

```bash
git add src/forestdemo.js
git commit -m "refactor(forest): remove dead separate-mesh splinter code (now baked into geometry)"
```

---

## Finishing (after all tasks verified)

- [ ] `node --test` — full suite green.
- [ ] Chrome regression (`?map=forest`): all owner-reported bugs gone — no floating/twisting splinters, no levitating middle chunk, no non-shootable charred/birch stumps, no fake whole-trunk-fall, teeth match trunk width + randomized, charring local.
- [ ] Cache-bust: bump `?v=N` (index.html) + `GAME_BUILD` (src/game.js) to current minute; commit `chore(forest): cache-bust vNNN`.
- [ ] Owner localhost review → then push + PR (base `feat/forest-tree-physics-2`); flag to brother that this replaces the #117 fall model. THEN start the IMPACT spec (building collision + player dmg + weight).

---

## Self-review (against the CORE spec)

- **Spec §3 splinters-in-geometry** → C1 (`mergeBags`) + C2 (`_bakeSplinters` for stump/top) + C4 (chunks). ✓
- **Spec §4 permanent destructible stump, only-above-falls** → C3 (always live stump, remove whole-topple/inert-stub, re-snap-down-then-remove). ✓
- **Spec §5 bug traceability** → floating/twisting/indestructible/charring all resolved by C2/C4/C5 (in-geometry); levitating middle chunk by C4 + existing AABB-height sink; non-shootable stumps by C3; width by C2 `_splR` pad-free + `_bakeSplinters` radius. ✓
- **Spec §6 co-op** → seeded, baked into deterministic geometry, replayed via existing path; no netcode. ✓
- **Spec §9 phasing** → C1–C5 match. ✓
- **Placeholder scan:** C1 has full code+tests; C2/C4 give exact helper + integration snippets + explicit removals; C3 gives exact removals + the precise "fully remove" replacement; C5 is deletion with a grep gate. The fellTree edits are directive-against-live-code (the implementer reconciles with the current function) because it's a rewrite of an existing 120-line method — each instruction names the exact branch + the exact change, not a vague "handle it." ✓
- **Type consistency:** `mergeBags(base,add)→bag`, `makeSplinters(...)→bag`, `_bakeSplinters(geometry,cx,cy,cz,radius,seed,up)→geometry`, `_geomFrom(bag)→geometry` consistent across C1–C5. ✓
- **IMPACT (building collision + player dmg + weight)** → correctly OUT of scope (own spec). ✓
