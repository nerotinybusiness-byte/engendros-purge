# Splintered Tree Breaks + No-Levitation

- **Date:** 2026-06-23
- **Branch:** `feat/tree-splinter-breaks` (off PR #117 `feat/forest-tree-physics-2`)
- **Status:** Design — approved in brainstorming, pending written-spec review
- **Author:** Tomáš + Claude

---

## 1. Problem & intent

When a tree snaps, the break is currently a **flat cut**: `splitGeomAtY` partitions the trunk's
triangle soup at the cut height, leaving an open, flat cylinder cross-section on both the standing
stump and the falling top. A real tree doesn't part cleanly at a saw-flat plane — the fibres tear,
leaving **jagged splinters of raw, paler inner wood**. The owner's reference sketch shows: (1) intact
tree → (2) snapping with a **jagged, splintered break** (zig-zag + a burst flash) → (3) fallen, the
broken end still reading as torn wood.

The current FALL behaviour (hinge → tip over → lie as a log, with the `#117` flat-fall/no-levitation
work) is **good and stays**. Two changes only:

1. **Every tree break shows splintered wood, never a flat cut** — jagged spikes + raw inner-wood
   colour at the break, on both sides (stump top + the broken piece's end).
2. **No piece may levitate** — gravity always applies; no broken block left floating in mid-air.

This is a **visual** feature (break geometry) plus a **gravity guarantee** (audit/fix). It is NOT a
new physics joint — the owner explicitly walked back "permanently attached" to "keep the current
fall, just splinter the break and don't let anything float."

### Goals

- Procedurally generated **jagged splinter crown** at every break face, with a paler raw-wood colour.
- Applied to **all break types**: first snap, re-snap of a bare stump, uproot, and the cut ends of
  sectional fallen-log chunks.
- Deterministic (seeded off the existing fell seed) → co-op-safe, no new netcode.
- A guarantee that **no broken piece ends up levitating**; audit the fall/settle/reground path and
  fix any floating case found.

### Non-goals

- **No permanent physical attachment** of the top to the stump (the owner rejected this). Keep the
  current detach/hinge/flat-fall.
- **No new collision** for the splinters — they are thin cosmetic spikes; the trunk capsule
  (PR #124) already covers the bole. (This branch does not depend on #124.)
- No change to felling triggers, HP, caliber rules, or the fall trajectory.

---

## 2. Current behaviour (findings)

- **`fellTree` (`src/forestdemo.js`)**: snaps at the hit height.
  - *First snap*: `makeTree({breakAt})` yields a clean stump geometry (`split.stumpWoodGeometry`) +
    a crowned top; the top rides a pivot and falls via `makeHinge`.
  - *Re-snap of a bare stump*: `splitGeomAtY(woodArrays, …, comp=1, cut)` → `{lo, hi}` (lo = new
    stump, hi = falling top, re-zeroed at the break).
  - *Uproot*: the whole tree topples from the base (no stump).
  - After settling, `flatFalls(seed, breakFrac)` decides detach-and-lie-flat vs propped; the lying
    top is registered as a fallen log via `_registerFallenLog`.
- **`splitGeomAtY` (`src/destruct.js:449`)**: pure triangle-soup partition by centroid. Creates **no
  cap** — the cut is an open cross-section. The "flat" look is that open cylinder end.
- **Trunk geometry** is cylinder-based (`tree.js`, per-species `trunkDiaM`); at the cut the boundary
  is ≈ a circle of radius `taper(cut)` centred on the leaning spine at the cut height. `fellTree`
  already knows `rec.trunkR`, `fullH`, the spine, and the cut height → **centre + radius are
  derivable without scanning vertices**.
- **No-levitation**: `#117` added `regroundLog`, `grounded` flags, `flatFalls`, and `stepBody`
  settle. The owner wants no "block staying levitating" — treat as a guarantee + audit.
- **Determinism/co-op**: felling is host-authoritative; the host broadcasts `forestfx {dx,dz,seed}`
  and clients replay an identical fall. Anything seeded off that seed stays in sync for free.

---

## 3. Design

### 3.1 Splinter generator — `makeSplinters(...)` in `src/destruct.js` (pure, THREE-free)

A pure function (sibling of `splitGeomAtY`, so it's node-testable and worker-safe):

```
makeSplinters({ cx, cy, cz, radius, axis:[ax,ay,az], seed, count, color:[r,g,b],
                up=true, lenRange:[lo,hi] }) → { positions, colors, normals, uvs }
```

- Builds `count` (~6–10) **jagged shards** spaced around the rim circle (radius `radius`, centre
  `(cx,cy,cz)`, in the local space of the piece being appended to).
- Each shard = a thin tapered spike: a base pair on the rim + a tip pushed along `axis` by a
  **seeded** length in `lenRange` (varying heights → torn look), a few triangles each. Some shards
  tall, some short.
- `up` flips the spike direction: stump shards point **out of the cut along +axis**; the fallen
  piece's shards point along its break end. Heights use the **same seed stream** so the stump's
  tall shard lines up with a notch on the top (basic complementarity; full interlock is a
  nice-to-have, not required).
- Output is a flat triangle-soup bag in the **same format** the wood meshes use (non-indexed,
  `positions`/`colors`/`normals`/`uvs`), ready to concatenate.

### 3.2 Raw inner-wood colour

Shards are coloured a **paler wood tone** than the bark (fresh-break look). Derived by brightening
the trunk's wood colour (or a fixed pale tan if no per-tree colour is handy). A thin paler rim on
the cut edge is an optional polish.

### 3.3 Integration in `fellTree` (`src/forestdemo.js`)

At each break, after the geometry split and BEFORE building the meshes:

- Compute the break centre `(cx,cy,cz)` (spine at cut height) and `radius = taper(cut)` and the
  trunk axis at the cut.
- Append `makeSplinters({…, up:true})` to the **stump** wood bag (spikes up out of the cut).
- Append `makeSplinters({…, up:false})` to the **falling top** wood bag (spikes down from its broken
  end, re-zeroed into the top's local space).
- Cover all paths: first snap (`makeTree` split — append to `split.stumpWoodGeometry` source + top),
  re-snap (`sp.lo`/`sp.hi`), uproot (top only), and **sectional chunk ends** in `_registerFallenLog`
  / `binFallenGeometry` (the new cut faces where a chunk is severed).

### 3.4 No-levitation guarantee

Audit `makeHinge`/`stepBody`/`flatFalls`/`regroundLog`/the orphan-cascade path for any case where a
broken piece (propped top, flat-fallen log, orphan chunk) can come to rest above the terrain. Ensure
every settled piece is re-grounded onto the heightfield (the `regroundLog` mechanism already exists —
extend its coverage if a gap is found). If a live floating-block repro is found in play, fix it.

### 3.5 Determinism / co-op

`makeSplinters` is seeded off the existing fell seed (`rec.id`/the broadcast `seed`), so host and all
clients (and late-joiners replaying `forestfx`) generate identical splinters. **No new network
message.** Host-authoritative felling is unchanged.

### 3.6 Hitboxes / performance

Splinters are thin cosmetic spikes — **no collision box / no `box.cap`** (the trunk/log capsules from
PR #124, when present, already cover the bole; this branch is independent of #124). Each break adds a
few dozen triangles, merged into the existing stump/top mesh — negligible. The generator is THREE-free
→ node-tested.

---

## 4. Testing

- **Unit (`tests/` , node):** `makeSplinters` — vertex count = `count × trisPerShard × 9`; all base
  vertices lie on the rim circle (±ε); tip offsets within `lenRange` along `axis`; `up` flips the
  sign; same seed → identical output (determinism); colours = the raw-wood tone.
- **In-browser (Chrome, no-store):** fell trees on `?map=forest` — every break (snap, re-snap,
  uproot, shot-out chunk) shows jagged paler splinters on both faces; no flat cut remains; nothing
  floats; the fall still behaves as before. Screenshot the break close-up.

---

## 5. Phasing

- **S1 — Splinter generator** (`makeSplinters` + node tests). Pure, independent.
- **S2 — Wire into `fellTree`**: first snap + re-snap + uproot break faces (stump + top).
- **S3 — Sectional chunk ends**: splinter the severed faces in the fallen-log chunking path.
- **S4 — No-levitation audit/fix**: guarantee every broken piece grounds; fix any floating case.

Each is independently shippable; S1 carries the node tests, S2–S4 are browser-verified.

---

## 6. File-by-file touch list

- `src/destruct.js` — **add** `makeSplinters` (pure, THREE-free) next to `splitGeomAtY`.
- `src/forestdemo.js` — call `makeSplinters` at every break (fellTree first-snap/re-snap/uproot;
  `_registerFallenLog` chunk ends); the no-levitation audit/fix lives here + in the settle path.
- `tests/splinter/…` — **new** node tests for `makeSplinters`.
- *Untouched:* hitbox files (`raycollide.js`/`grid.js`/`world.js`), buildings, movement, nav, co-op
  netcode.

---

## 7. Scope / branch

- Sibling branch off PR #117 (the felling code lives there). Separate PR from the hitbox PR #124.
- ⚠️ Both this branch and #124 edit `src/forestdemo.js` (different functions) — expect a trivial
  merge touch-up when both land. When #117 merges to `main`, rebase this onto `main`.

---

## 8. Open questions / deferred

- **Complementary interlock** (stump spike ↔ top notch exact fit) — basic seed-shared variance is in;
  perfect interlock deferred unless it reads wrong.
- **Live levitation repro** — owner to confirm if a specific floating block was seen; otherwise S4 is
  a guarantee/audit.
- **Splinter LOD** — if distant trees ever show too many spikes, gate `count` by distance (likely
  unnecessary; a few dozen tris).
