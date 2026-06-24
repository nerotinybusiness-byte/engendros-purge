# Tree Felling Redesign — CORE (splinters-in-geometry + permanent destructible stump)

- **Date:** 2026-06-24
- **Branch:** `feat/tree-splinter-breaks` (worktree `.claude/worktrees/tree-splinter`, off PR #117). Supersedes the separate-mesh splinter commits on this branch (not pushed).
- **Status:** Design — approved in brainstorming, pending written-spec review
- **Author:** Tomáš + Claude

---

## 1. Why a redesign (the failure)

The previous splinter work added the torn-wood crowns as **separate meshes** parented to each tree piece. A separate object does not share the wood's lifecycle, so in play (owner testing, `?map=forest`):

- splinters stay behind / **float in mid-air** when their wood piece disappears,
- they don't fall / burn / move with the piece — **twisting bits not part of any chunk**,
- they can't be destroyed,
- a shot-out **middle chunk levitates**, and the whole felling has fake "the trunk falls as if it were still there" animations + non-shootable charred/short birch stumps.

Three rounds of patches (parenting, sink-by-AABB, material caching, char-guards) treated symptoms. The **root cause is architectural**: splinters as separate objects. Per systematic-debugging, 3+ symptom fixes ⇒ question the architecture. This spec replaces the architecture.

## 2. The two fixes (owner's vision)

1. **Splinters are PART OF the wood geometry** — baked into each piece's triangles, so they inherit *everything* the piece does (fall, gravity, fire, position, movement, removal, re-sectioning). Not an attached object.
2. **Felling model = permanent destructible stump, only-above-falls** — shooting a tree drops only the part above the cut; a rooted stump always remains and is itself destructible.

### Goals (CORE)
- Splinter crowns are triangles inside the wood geometry of every piece (stump face, falling-part torn end, each fallen-log chunk face).
- A snap always leaves a **rooted, shootable stump**; only the part **above** the cut falls.
- The stump is a normal **destructible** piece: once it is a standalone stump (after the top has fallen), continued shooting breaks it down and eventually removes it entirely (splinters/debris); digging the ground under it = uproot (whole stump topples).
- The falling upper part is one unified piece (with merged splinters) that lands as a **sectional** log; shooting out a middle chunk makes that chunk **and its splinters** vanish — no levitation.
- Splinter width matches each trunk's real visual radius; teeth are randomized (jittered); deterministic (co-op-safe), no new netcode.

### Non-goals (CORE — deferred to the IMPACT spec)
- Falling-tree **collision with buildings** (break-through by weight/material along the fall vector).
- Falling-tree **damage to the player**.
- Tree **weight by size**.
- These get their own spec (`…-tree-impact-design.md`) after CORE lands.

## 3. Architecture: splinters baked into the wood geometry

Keep the pure generator `makeSplinters(...)` (it already returns a `{positions,colors,normals,uvs}` triangle bag, node-tested). Change how it is consumed: instead of a separate mesh, **merge the splinter bag into the wood piece's own geometry** before the piece's mesh is built.

A single new pure helper does the merge at the array level:

```
mergeBagIntoGeometry(geometry, bag) → BufferGeometry
```

…reads the geometry's `position/color/normal/uv` attribute arrays, concatenates the bag's arrays, and returns a new non-indexed `BufferGeometry` (same format MeshBuilder/`_geomFrom` produce). It is applied to **every** wood piece at its build site:

- **stump** wood geometry → merge a teeth-**up** crown at the cut (radius = real visual trunk radius at the cut, NOT the padded collision radius),
- **falling upper part** wood geometry → merge a teeth-**down** crown at its torn end,
- **each fallen-log chunk** geometry (`binFallenGeometry` output / `breakLogSeg` survivors) → merge crowns at its freshly-cut faces.

Because the teeth are now triangles of the piece's own mesh, they fall, hinge, flat-fall, char, sink, re-bin into chunks, and disappear **automatically** with the piece — no parenting, no separate update, no floating. This single change resolves: floating splinters, twisting orphan bits, indestructible mid-air pieces, the shared-`SPLINTER_MAT` charring bug, and (via correct radius) the over-wide teeth. Randomization (jittered tooth angles + variance) stays in `makeSplinters`.

`makeSplinters` keeps its determinism (seeded off the piece's stable id/seed) → host and clients bake identical teeth into identical geometry; **no new network message**.

## 4. Felling model: permanent destructible stump, only-above-falls

Rework `fellTree` (`src/forestdemo.js`) to a single consistent rule:

- A snap at height H (the shot height, clamped) splits the standing tree into **stump = below H** (stays) and **top = above H** (falls). The top hinge-topples and lands as a sectional log (reuse the existing hinge / flat-fall / `regroundLog`), now with its splinters baked in.
- The **stump is always a live destructible piece**: it keeps `rec.standing = true`, a live `rec.part` with HP scaled to its height, trunk-band collision, and a teeth-up splinter crown baked into its geometry. It is fully shootable.
- **Continued shooting of the standalone stump** re-snaps it lower (each kill drops a short top piece + leaves a shorter stump) until it is below a minimum height, at which point it is **fully removed** (broken into debris/splinters), not left as an inert stub. So a stump can be "shot away" once the top is down — matching the owner's choice.
- **Digging the ground under the stump** = uproot: the whole rooted stump topples (reuse the existing `#117` dig-uproot path).
- **Remove the failure paths:** no "whole tree topples on first snap," no "inert non-shootable stub," no fake "the trunk falls as if still standing." Every snap leaves a real, shootable stump.

The fallen upper part on the ground stays **sectional** (reuse `binFallenGeometry` chunks); shooting out a middle chunk removes that chunk's geometry (with its baked splinters) and sinks/vanishes it correctly (no levitation — the chunk's own mesh, splinters included, is sunk by its AABB height).

## 5. How each reported bug is fixed (traceability)

| Reported bug | Fixed by |
|---|---|
| Splinters stay/float when the piece disappears | §3 — splinters are the piece's own triangles |
| Twisting bits not part of any chunk | §3 — merged into chunk geometry, re-bin with it |
| Indestructible mid-air pieces | §3 + §4 — no separate objects; chunk removal takes its splinters |
| Middle chunk levitates | §4 — chunk (with splinters) sinks by its AABB height |
| Fake "whole trunk falls as if there" | §4 — only above-cut falls; stump always stays |
| Non-shootable charred / short birch stumps | §4 — stump always live + destructible (no inert stub) |
| Splinters wider than trunk | §3 — radius from real visual wood, not padded collision radius |
| Charring darkens all future splinters | §3 — no shared splinter material; teeth are in-geometry vertex colors |

## 6. Co-op / determinism

Splinter geometry is generated from the seeded piece id, baked into the deterministic wood geometry; the felling result is host-authoritative and replayed on clients via the existing `forestfx`/`fellTreeById` path (which re-runs the same `fellTree` → same baked geometry). **No new netcode, no new message.** The stump-destruction and uproot reuse existing host-auth paths.

## 7. Hitboxes (PR #124)
The capsule narrowphase from PR #124 is committed + pushed, independent, and **OK saved**. It is not needed for CORE (CORE is geometry + felling logic), but is relevant to the IMPACT spec (the falling log's precise swept shape for building collision) — it will be reused there.

## 8. Testing
- **Unit (node):** `makeSplinters` tests stay green; add a test for `mergeBagIntoGeometry` (output vertex count = base + bag; attributes concatenated; non-indexed; format intact).
- **In-browser (Chrome, no-store, `?map=forest`):** shoot trees — splinters are part of the wood (no floating, none left behind when a piece goes); a snap always leaves a rooted shootable stump; only the part above falls; keep shooting a standalone stump → it shrinks then is fully gone; dig under a stump → it topples; shoot a middle chunk of a fallen log → that chunk + its splinters vanish (no levitation); char a log → only that log darkens (no global splinter darkening); teeth hug the real trunk width and look randomized.

## 9. Phasing (CORE)
- **C1 — `mergeBagIntoGeometry`** helper (pure) + node test.
- **C2 — Bake splinters into the falling top + stump** in `fellTree` (replace the separate-mesh `_splinterMesh` calls); correct visual radius.
- **C3 — Permanent destructible stump model** in `fellTree`: always leave a live shootable stump; remove whole-topple / inert-stub paths; re-snap-down-then-remove; keep dig-uproot.
- **C4 — Fallen-log chunks**: bake splinters into chunk geometry (`_registerFallenLog`/`binFallenGeometry`), and ensure a removed chunk (with its splinters) sinks/vanishes (no levitation).
- **C5 — Remove the old separate-mesh splinter code** (`_splinterMesh`, `_addGapSplinters`, `SPLINTER_MAT`, the parenting) once C2/C4 replace it.

Each step browser-verified; C1 carries the node test.

## 10. File-by-file touch list
- `src/destruct.js` — keep `makeSplinters`; **add** `mergeBagIntoGeometry` (pure, THREE-free).
- `src/forestdemo.js` — `fellTree` rewrite (permanent stump, only-above-falls, bake splinters into stump+top); `_registerFallenLog`/`breakLogSeg` bake splinters into chunk geometry + correct sink; **remove** `_splinterMesh`/`_addGapSplinters`/`SPLINTER_MAT`/parenting.
- `tests/splinter/…` — keep splinter tests; add `mergeBagIntoGeometry` test.
- *Untouched:* hitbox files (`raycollide.js`/`grid.js`/`world.js`), buildings, movement, nav, co-op netcode.

## 11. Branch / #117 coordination
This rewrites `fellTree` felling behaviour, which overlaps the brother's `#117` tree-physics heavily. Decision at plan time: either (a) make this the definitive felling system on this branch and reconcile/​supersede `#117`'s fall code at merge, or (b) coordinate so it lands in `#117`. Flag to the brother that CORE replaces the fall model.

## 12. Open questions / deferred
- **IMPACT** (own spec): falling-tree → building collision (break-through by weight/material along fall vector, don't destroy concrete/harder-than-wood), player damage on landing, weight by tree size. Owner provided real tree-on-house references for the "cheap research."
- **Stump-destruction feel**: re-snap-down-then-remove vs accumulate-damage-then-poof — start with re-snap-down (reuses existing re-snap), tune in-browser.
