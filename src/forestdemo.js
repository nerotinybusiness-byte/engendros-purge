// forestdemo.js — DEMO-FAITHFUL trees for ?map=forest (replaces the game's instanced forest here).
// Individual round-trunk makeTree meshes that FELL into a standing STUMP + a hinge-falling CANOPY
// (the standalone forest-destruct demo's destruction), not the game's instanced hide-instance + snag.
//
// Drop-in for `game.forest`: weapons.js already dispatches a tree hit as
//   box.tree → resolveHit(box.downer.part, w) → killed ? game.forest.fellTree(tree, [dir.x,dir.z], seed)
// so each tree registers an AABB collision box with box.downer = the tree record + box.tree = true, and
// we expose fellTree / blast / penetrate / clearArea / update / debris / netSnapshot — nothing else needed.
import * as THREE from 'three';
import { makeTree } from './props/generators/tree.js';
import { makeBush, makeShrub } from './props/generators/groundcover.js';
import { makePart, MATERIALS, makeHinge, stepBody, resolveHit, binFallenAABBs, binFallenGeometry, orphanedCells, snapPlan, splitGeomAtY, flatFalls, makeSplinters } from './destruct.js';
import { rr, voxelMaterial, foliageFadeMaterial, makeRNG } from './util.js';
import { FOLIAGE_FADE_NEAR, FOLIAGE_FADE_FAR, FOLIAGE_FADE_GATE } from './tuning.js';

// Two SHARED leaf materials (one program each, compiled once): leaves render opaque by default; the
// 0–2 trees the camera is inside get their leaf mesh swapped to the fade material so the leaves at your
// face dissolve. Wood always uses a plain opaque material — only the LEAF mesh ever fades.
const FOLIAGE_OPAQUE = voxelMaterial();
const FOLIAGE_FADE = foliageFadeMaterial(FOLIAGE_FADE_NEAR, FOLIAGE_FADE_FAR);

const _axis = new THREE.Vector3();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _my = new THREE.Matrix4();
const ri = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
// crush class → ballistics: saplings are WOOD (tier 1, a rifle fells them); grown trees + oak are
// TRUNK (tier 2, need an HMG+). HP from the demo so felling stays responsive (a few hits, not a magazine).
const SPECIES_CLS = { scotsPine: 2, birch: 2, oak: 3, poplar: 2, willow: 2 };
const TREE_HP = { 1: 20, 2: 55, 3: 100 };   // destructive vibe: rifle fells a grown tree in a burst, HMG/HE/APFSDS instantly
const LOG_HP_MUL = 2.0;   // a FALLEN log is durable scenery (×2 the standing trunk) → a deliberate burst shoots it apart, a stray bullet leaves it lying; it NEVER despawns on a timer
// FELLING BY CALIBER × TREE SIZE: a tree/log carries a "fell tier" = the min weapon pen that can chop
// it, derived from TRUNK THICKNESS (not species) so a slim trunk falls to an SMG/rifle (pen 1) while a
// thick bole needs an MG/sniper/HE (pen 2+). Only the caliber GATE scales with size — fire + HP still
// come from the material. (Pen by class: pistol0 smg1 rifle1 shotgun1 sniper2 hmg2 launcher4 cannon5.)
const FELL_TIER_R = 0.5;                        // scaled trunk radius ≥ this ⇒ "thick" (MG/sniper/HE only); below ⇒ a rifle/SMG burst fells it. The slender majority (birch/willow/smaller pine+poplar) fall to the rifle; only big boles (oak, the largest pines) need a heavy weapon.
const felTierFor = (r) => (r >= FELL_TIER_R ? 2 : 1);
// SECTIONAL log destruction: a felled log's wood is chopped into per-segment chunks (own mesh + HP +
// collision), so you can shoot a log apart piece-by-piece — a gap appears where you hit, the rest stays.
const GROUND_EPS   = 0.4;                       // a log segment whose underside is within this of the terrain is "grounded" (won't orphan-cascade)
const WOOD_SEG_LEN = 1.1;                       // local length (m) of each destructible log segment
const WOOD_SEG_MAX = 7;                         // cap segments per log (perf)
const MAX_SEG_LOGS = 10;                        // cap concurrent per-chunk logs; beyond it logs fall back to one shared-HP hull
const STUB_FLOOR = 0.9;                         // a snap leaving a stump shorter than this makes an inert stub (not re-snappable)
const WOOD_RAW = [0.78, 0.63, 0.45];   // paler raw inner-wood tone for fresh break splinters (vs darker bark)
const CLS_MAT = { 1: 'wood', 2: 'trunk', 3: 'trunk' };
const TREE_MIX = [['scotsPine', 60], ['birch', 18], ['oak', 8], ['poplar', 6], ['willow', 8]];

export class ForestDemo {
  // debris = the ForestScene's shared DebrisPool (the scene steps it, so we never call debris.update)
  constructor(game, debris) {
    this.game = game; this.world = game.world; this.scene = this.world.scene; this.debris = debris;
    this.trees = []; this.stumps = []; this.stumpBoxes = []; this.logs = []; this.bushes = []; this.props = []; this.FALLING = []; this.windy = [];
    this._sinking = [];   // logs being destroyed: sink-into-ground animation before the mesh is removed (no instant poof)
    this._dropping = [];  // felled tops that detach + fall FLAT to the ground (vs stay propped on the stump)
    this._frng = makeRNG(0x6f7e57);   // SEEDED layout RNG → every co-op peer builds the IDENTICAL forest (id→tree matches, so a host-synced fell/char/burn lands on the right tree)
    this._t = 0; this._idc = 0; this._reserved = [];
    this._fading = new Set();   // tree/bush recs whose leaf mesh is currently on the near-camera fade material
  }

  reserve(x, z, r) { this._reserved.push({ x, z, r }); }     // keep-out (cottage / crate footprints)

  _rr(lo, hi) { return lo + this._frng() * (hi - lo); }   // seeded rr() over the forest layout RNG
  _pickSpecies() {
    let tot = 0; for (const [, w] of TREE_MIX) tot += w;
    let n = this._frng() * tot;
    for (const [s, w] of TREE_MIX) { if ((n -= w) <= 0) return s; }
    return 'scotsPine';
  }

  _blocked(x, z, minD) {
    for (const r of this._reserved) { const dx = x - r.x, dz = z - r.z; if (dx * dx + dz * dz < (r.r) * (r.r)) return true; }
    for (const t of this.trees) { const dx = x - t.x, dz = z - t.z; if (dx * dx + dz * dz < minD * minD) return true; }
    return false;
  }

  // scatter `n` grown trees + `nSap` saplings into dense STANDS (clusters) within `rad`, avoiding
  // reserves, neighbours and steep ground. Stands matter: trees a few m apart let the FIRE ember
  // chain jump tree→tree (spread radius 6 m), and the woods read as a forest, not a sprinkle. Call
  // AFTER reserve()-ing the building footprints.
  scatter(n = 150, nSap = 45, rad = 120) {
    const terr = this.world.terrain;
    const NS = 11, stands = [];          // denser wood: more stands + more trees + tighter spacing (see drop())
    for (let s = 0; s < NS; s++) {
      const a = (s / NS) * Math.PI * 2 + this._rr(-0.35, 0.35), d = 22 + this._frng() * (rad - 22);
      stands.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, r: 10 + this._frng() * 8 });
    }
    const drop = (count, scaleLo, scaleHi, minD, footR, sapling) => {
      for (let i = 0; i < count; i++) {
        for (let tries = 0; tries < 12; tries++) {
          const st = stands[(this._frng() * stands.length) | 0];
          const a = this._frng() * Math.PI * 2, d = Math.sqrt(this._frng()) * st.r;
          const x = st.x + Math.cos(a) * d, z = st.z + Math.sin(a) * d;
          if (Math.abs(x) > this.world.HALF - 6 || Math.abs(z) > this.world.HALF - 6) continue;
          if (terr && !terr.isPlaceable(x, z, footR, 'tree')) continue;
          if (this._blocked(x, z, minD)) continue;
          this._addTree(sapling ? 'birch' : this._pickSpecies(), x, z, this._rr(scaleLo, scaleHi), i * 17 + (sapling ? 700 : 3), sapling); break;
        }
      }
    };
    drop(n, 0.9, 1.25, 2.7, 1.0, false);     // grown trees — ~2.7 m apart inside a stand ⇒ denser + fire chains
    drop(nSap, 0.42, 0.6, 2.0, 0.6, true);   // birch saplings filling the understory
  }

  _addTree(species, x, z, scale, seed, sapling) {
    const res = makeTree({ species, seed, lod: 0, scale });
    const yaw = this._rr(0, Math.PI * 2);
    const y = this.world.terrain ? this.world.terrain.terrainHeightAt(x, z) : 0;
    // WOOD (opaque) + LEAF (fadeable) as two meshes under one group: wind/transform/fell all act on the
    // group, while only the leaf mesh ever swaps to the transparent near-camera fade material.
    const m = new THREE.Group();
    const woodMesh = new THREE.Mesh(res.woodGeometry || res.geometry, res.material); woodMesh.castShadow = true; m.add(woodMesh);
    let leafMesh = null;
    if (res.leafGeometry) { leafMesh = new THREE.Mesh(res.leafGeometry, FOLIAGE_OPAQUE); leafMesh.castShadow = true; m.add(leafMesh); }
    m.position.set(x, y, z); m.rotation.y = yaw;
    this.scene.add(m);
    const cls = sapling ? 1 : (SPECIES_CLS[species] || 2);
    const mat = CLS_MAT[cls];
    const id = ++this._idc;
    const trunkR = res.trunkRadius || (0.30 * scale);          // REAL base trunk radius (world units), per species
    const H = res.height, topY = y + H;
    const half = trunkR + 0.12;
    // FIRE/record AABB: a simple trunk-centred column. fire.js reads part.min/max to seat the flame, which
    // must rise from the TRUNK base, not the wide lean-offset canopy — so the part stays a tight bole column
    // independent of the precise hit boxes below.
    const part = makePart(id, mat, [x - half, y, z - half], [x + half, topY, z + half], TREE_HP[cls] / MATERIALS[mat].hp);
    const felTier = felTierFor(trunkR);          // caliber needed to fell THIS trunk (by its thickness)
    // fullH = the ORIGINAL height (taper reference, survives snaps); spine = leaning centreline (for rebuilding
    // stump bands after a snap); snapN = how many times this trunk has been snapped (→ unique fallen-log ids).
    const rec = { id, species, seed, scale, x, z, yaw, baseY: y, height: H, fullH: H, trunkR, mesh: m, leafMesh, cls, mat, part, felTier, spine: res.spine, snapN: 0, standing: true, boxes: [] };
    part.downer = rec;
    // ── PRECISE HITBOXES (the headline fix) ──────────────────────────────────────────────────────────
    // Built from the tree's REAL geometry (tree.js returns the leaning trunk centreline + the MEASURED
    // leaf-mass envelope), then rotated by this tree's yaw into world AABBs:
    //   · TRUNK — a few SOLID bands that hug the leaning bole (you can't walk through or shoot past it).
    //     One base-centred column missed the lean entirely → shots at the upper bole hit nothing.
    //   · CANOPY — ONE box matching the actual foliage, flagged `foliage` (soft cover): the raycast hits
    //     it but movement passes THROUGH it (slowed — World.foliageSlowAt). The crown is 10–20 m wide; a
    //     SOLID box that size walls the whole footprint — that floating box was also a phantom wall.
    // TRUNK — solid bands hugging the leaning bole + root collar (shared with snapTree's stump rebuild).
    this._buildTrunkBands(rec, H, 6);
    // CANOPY — ONE soft-cover foliage box matching the MEASURED leaf mass: the raycast hits it (shoot/conceal),
    // but movement passes THROUGH (slowed). thicket(slow)=only saplings — a grown crown is overhead.
    const cab = res.crownAABB;
    if (cab) {
      const cos = Math.cos(yaw), sin = Math.sin(yaw);
      const cxL = (cab.min[0] + cab.max[0]) * 0.5, czL = (cab.min[2] + cab.max[2]) * 0.5;   // crown centre (lean-offset, local)
      const cxr = cxL * cos + czL * sin, czr = -cxL * sin + czL * cos;                      // rotate by yaw → world
      const hw = Math.max(cab.max[0] - cab.min[0], cab.max[2] - cab.min[2]) * 0.5 + 0.1;    // square hull (rotation-safe)
      rec.crownHW = hw;
      const cb = { min: new THREE.Vector3(x + cxr - hw, y + cab.min[1] - 0.2, z + czr - hw), max: new THREE.Vector3(x + cxr + hw, y + cab.max[1] + 0.2, z + czr + hw), downer: rec, tree: true, dmat: mat, dpart: id, felTier, foliage: true };
      if (sapling) cb.thicket = true;
      rec.boxes.push(cb); this.world.boxes.push(cb); this.world.grid.addBox(cb);
    }
    this.trees.push(rec);
    if (!sapling) this.windy.push({ m, yaw, amp: 0.018 + rr(0, 0.022), ph: rr(0, 6.28), speed: 0.8 + rr(0, 1.2) });
  }

  // Build the SOLID trunk-band collision boxes (+ root collar) over [0, yHi] from rec's stored leaning
  // spine, taper referenced to rec.fullH (the ORIGINAL height, so a snapped stump keeps the right girth).
  // Shared by _addTree (full tree, yHi = H) and snapTree (the surviving stump, yHi = breakY). Appends to
  // rec.boxes + world.boxes + grid. Does NOT clear rec.boxes — caller drops the old set first (_dropBox).
  _buildTrunkBands(rec, yHi, nb) {
    const x = rec.x, y = rec.baseY, z = rec.z, yaw = rec.yaw, trunkR = rec.trunkR, mat = rec.mat, felTier = rec.felTier, id = rec.id, spine = rec.spine, fullH = rec.fullH || rec.height;
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const push = (mn, mx) => { const b = { min: new THREE.Vector3(...mn), max: new THREE.Vector3(...mx), downer: rec, tree: true, dmat: mat, dpart: id, felTier }; rec.boxes.push(b); this.world.boxes.push(b); this.world.grid.addBox(b); };
    if (spine && spine.length) {
      const cl = (yt) => {
        if (yt <= spine[0][1]) return [spine[0][0], spine[0][2]];
        for (let i = 0; i < spine.length - 1; i++) { const a = spine[i], b = spine[i + 1]; if (yt <= b[1] + 1e-6) { const tt = (yt - a[1]) / ((b[1] - a[1]) || 1); return [a[0] + (b[0] - a[0]) * tt, a[2] + (b[2] - a[2]) * tt]; } }
        const e = spine[spine.length - 1]; return [e[0], e[2]];
      };
      for (let s = 0; s < nb; s++) {
        const y0 = (s / nb) * yHi, y1 = ((s + 1) / nb) * yHi;
        let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
        const add = (lx, lz) => { const rx = lx * cos + lz * sin, rz = -lx * sin + lz * cos; if (rx < mnx) mnx = rx; if (rx > mxx) mxx = rx; if (rz < mnz) mnz = rz; if (rz > mxz) mxz = rz; };
        const e0 = cl(y0), e1 = cl(y1); add(e0[0], e0[1]); add(e1[0], e1[1]);
        for (const p of spine) if (p[1] > y0 && p[1] < y1) add(p[0], p[2]);
        const rad = trunkR * (1 - 0.6 * (y0 / fullH)) + 0.1;
        push([x + mnx - rad, y + y0, z + mnz - rad], [x + mxx + rad, y + y1, z + mxz + rad]);
      }
      const collarR = trunkR * 1.25 + 0.05, collarH = Math.min(0.5, fullH * 0.12);
      push([x - collarR, y, z - collarR], [x + collarR, y + collarH, z + collarR]);
    } else {
      const half = trunkR + 0.12;
      push([x - half, y, z - half], [x + half, y + yHi, z + half]);
    }
  }

  _dropBox(rec) {
    for (const b of (rec.boxes || [])) {         // drop every trunk band + the canopy box
      this.world.grid.removeBox(b); const i = this.world.boxes.indexOf(b); if (i >= 0) this.world.boxes.splice(i, 1);
    }
    rec.boxes = [];
  }

  // weapons.js _destructHit calls this when a tree's trunk part is killed. dirXZ = the SHOT direction
  // ([dir.x, dir.z]) so the canopy hinges DOWN away from the shooter. Rebuilds the tree split:
  // a standing stump (kept) + the canopy on a pivot that falls under makeHinge gravity.
  fellTree(rec, dirXZ = null, seed = null, hitY = null, breakAtOverride = null) {
    if (rec && rec.fallen) { this._breakLog(rec, seed); return; }   // a hit on an ALREADY-fallen log breaks it apart
    if (!rec || !rec.standing) return;
    if (this.game.fire) this.game.fire.retire(rec.part);    // drop any active fire so flames don't hover where the trunk was
    this._fading.delete(rec);
    this._dropBox(rec);                                      // drop the standing boxes (bands + canopy)
    let dx = dirXZ ? dirXZ[0] : (Math.random() - 0.5), dz = dirXZ ? dirXZ[1] : (Math.random() - 0.5);
    let dl = Math.hypot(dx, dz); if (dl < 1e-4) { dx = 1; dz = 0; dl = 1; } dx /= dl; dz /= dl;   // zero dir → default topple +X (avoids a NaN fall axis)
    const sd = ((seed ?? (rec.id * 2654435761)) >>> 0) || 1;
    const y0 = rec.baseY, fullH = rec.fullH || rec.height, prevHeight = rec.height;
    // WHERE it snaps: a co-op replay override → the SHOT's hit height (snap where you hit) → else a seeded low break.
    let breakAt;
    if (breakAtOverride != null) breakAt = breakAtOverride;
    else if (hitY != null) breakAt = snapPlan(fullH, hitY, y0).breakAt;
    else breakAt = rec.cls === 1 ? 0.1 : 0.12 + ((sd >>> 8) % 1000) / 1000 * 0.18;
    const snapN = rec.snapN || 0;
    const logId = 200000 + (rec.id % 6000) * 16 + Math.min(15, snapN);   // unique fallen-log id per (tree, snap)
    rec.snapN = snapN + 1;

    let topWoodMesh = null, topLeafMesh = null, breakY, liveStump, stumpMesh = null;
    if (breakAtOverride === 0) {
      // UPROOT — the WHOLE tree topples from the base, root and all, NO stump (the ground was dug out from
      // under it). Reuse the current standing geometry (wood + leaf) as the falling top, hinged at the base.
      breakY = 0; liveStump = false;
      const wm = rec._woodMesh || (rec.mesh && (rec.mesh.isMesh ? rec.mesh : rec.mesh.children.find((c) => c.isMesh && c !== rec.leafMesh)));
      if (wm && wm.geometry) { topWoodMesh = new THREE.Mesh(wm.geometry.clone(), wm.material); topWoodMesh.castShadow = true; }
      if (rec.leafMesh && rec.leafMesh.geometry) { topLeafMesh = new THREE.Mesh(rec.leafMesh.geometry.clone(), FOLIAGE_OPAQUE); topLeafMesh.castShadow = true; }
    } else if (snapN === 0) {
      // FIRST snap — makeTree gives a clean stump + a coherent crowned top (canopy clamped onto the top).
      const split = makeTree({ species: rec.species, seed: rec.seed, scale: rec.scale, breakAt, damage: rec.charred ? 'charred' : undefined });
      breakY = split.breakY;
      topWoodMesh = new THREE.Mesh(split.topWoodGeometry, split.material); topWoodMesh.castShadow = true;
      if (split.topLeafGeometry) { topLeafMesh = new THREE.Mesh(split.topLeafGeometry, FOLIAGE_OPAQUE); topLeafMesh.castShadow = true; }
      liveStump = !rec.charred && breakY >= STUB_FLOOR;
      stumpMesh = new THREE.Mesh(split.stumpWoodGeometry, split.material);
    } else {
      // RE-snap — geometry-split the bare stump wood at the cut (no crown left to preserve).
      const wm = rec._woodMesh || (rec.mesh && rec.mesh.isMesh ? rec.mesh : null);
      let cut = breakAt * fullH;                              // local height above base (snapPlan returns (hitY-y0)/fullH)
      cut = Math.max(STUB_FLOOR, Math.min(prevHeight - 0.4, cut));
      if (!wm || !wm.geometry || prevHeight < STUB_FLOOR + 0.6 || cut >= prevHeight - 0.3) {
        // too short to re-snap → topple the WHOLE remaining stump as one piece (no live stump left)
        breakY = 0; liveStump = false;
        if (wm && wm.geometry) { topWoodMesh = new THREE.Mesh(wm.geometry.clone(), wm.material); topWoodMesh.castShadow = true; }
      } else {
        breakY = cut; liveStump = true;
        const a = wm.geometry.attributes;
        const sp = splitGeomAtY(a.position.array, a.color && a.color.array, a.normal && a.normal.array, a.uv && a.uv.array, 1, cut);
        topWoodMesh = new THREE.Mesh(this._geomFrom(sp.hi), wm.material); topWoodMesh.castShadow = true;
        stumpMesh = new THREE.Mesh(this._geomFrom(sp.lo), wm.material);
      }
    }

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

    // remove the OLD standing mesh + its wind entry
    const oldMesh = rec.mesh;
    if (oldMesh) { const wi = this.windy.findIndex((w) => w.m === oldMesh); if (wi >= 0) this.windy.splice(wi, 1); if (oldMesh.parent) this.scene.remove(oldMesh); }
    rec.leafMesh = null;

    // ── the surviving stump ──
    if (liveStump && stumpMesh) {
      stumpMesh.position.set(rec.x, y0, rec.z); stumpMesh.rotation.y = rec.yaw; stumpMesh.castShadow = true; this.scene.add(stumpMesh);
      rec.mesh = stumpMesh; rec._woodMesh = stumpMesh; rec.height = breakY; rec.standing = true;
      this._buildTrunkBands(rec, breakY, Math.max(2, Math.round(6 * breakY / fullH)));   // re-snappable: rebuild the shorter bole's bands
      if (rec.part) { rec.part.dead = false; rec.part.dhp = Math.max(8, TREE_HP[rec.cls] * (breakY / fullH));   // a tall stump still resists; a stub dies in one more burst
        const sh = (rec.trunkR || 0.3) + 0.12; rec.part.min = [rec.x - sh, y0, rec.z - sh]; rec.part.max = [rec.x + sh, y0 + breakY, rec.z + sh]; }
      stumpMesh.add(this._splinterMesh(_spl[0], breakY, _spl[1], _splR, (rec.id * 2654435761) >>> 0, true, _splMat));
    } else {
      rec.mesh = null; rec.standing = false; rec._woodMesh = null; if (rec.part) rec.part.dead = true;   // inert stub — off the live trees
      if (stumpMesh) { stumpMesh.position.set(rec.x, y0, rec.z); stumpMesh.rotation.y = rec.yaw; stumpMesh.castShadow = true; this.scene.add(stumpMesh); this.stumps.push(stumpMesh);
        stumpMesh.add(this._splinterMesh(_spl[0], breakY, _spl[1], _splR, (rec.id * 2654435761) >>> 0, true, _splMat)); }
      if (breakY > 0.05) { const sh = (rec.trunkR || 0.3) + 0.12, sb = { min: new THREE.Vector3(rec.x - sh, y0, rec.z - sh), max: new THREE.Vector3(rec.x + sh, y0 + Math.max(0.4, breakY), rec.z + sh) }; this.world.boxes.push(sb); this.world.grid.addBox(sb); this.stumpBoxes.push(sb); }
    }

    // ── the falling top ──
    if (topWoodMesh) {
      const top = new THREE.Group(); top.rotation.y = rec.yaw; top.add(topWoodMesh); if (topLeafMesh) top.add(topLeafMesh);
      // confirm the top's break is at local y≈0 (re-zeroed); if its bbox min.y is materially > 0, use that as cy
      topWoodMesh.geometry.computeBoundingBox();
      const _topCutY = Math.abs(topWoodMesh.geometry.boundingBox.min.y) < 0.05 ? 0 : topWoodMesh.geometry.boundingBox.min.y;
      top.add(this._splinterMesh(0, _topCutY, 0, _splR, ((rec.id * 2654435761) >>> 0) ^ 0x5a, false, topWoodMesh.material));
      const pivot = new THREE.Group(); pivot.position.set(rec.x, y0 + breakY, rec.z); pivot.add(top); this.scene.add(pivot);
      const length = Math.max(0.5, prevHeight - breakY);
      const groundAt = this.world.terrain ? (gx, gz) => this.world.terrain.terrainHeightAt(gx, gz) : null;
      // collision: the falling top rests against nearby BUILDINGS + other TREES instead of clipping through —
      // gather the solid AABBs in the fall arc (leaves excluded; not our own dropped boxes).
      const obstacles = this._fallObstacles(rec, dx, dz, length);
      const body = makeHinge({ pivot: [rec.x, y0 + breakY, rec.z], dirXZ: [dx, dz], length, radius: Math.max(0.22, rec.trunkR || 0.22), seed: sd, obstacles, groundAt });
      this.FALLING.push({ kind: 'hinge', body, pivot, rec, charred: !!rec.charred, logged: false, logId, breakY, fullH, seed: sd, topWoodMesh, topLeafMesh });
      if (this.debris) this.debris.burst('splints', [rec.x, y0 + breakY, rec.z], sd, undefined, [dx, 0, dz]);
    }
    rec._fellDx = dx; rec._fellDz = dz; rec._fellSeed = sd; rec._snapBy = +breakAt.toFixed(3);
    this._emitForest('fell', rec.id, { dx, dz, seed: sd, by: +breakAt.toFixed(3) });   // host-auth: clients replay the identical fall + cut height
  }

  // Gather the SOLID collision AABBs the falling top could strike — nearby buildings, props and OTHER
  // trees' boles inside the fall arc — so the hinge rests AGAINST them instead of clipping through. Leaves
  // (foliage) and this tree's own stump/bole bands are excluded. Pure read of the XZ grid, capped for cost.
  // Returned ARRAY-indexed ({min:[x,y,z],max:[x,y,z]}) as makeHinge/pointInAABB expect (not THREE.Vector3).
  _fallObstacles(rec, dx, dz, length) {
    const grid = this.world && this.world.grid; if (!grid) return [];
    const ex = rec.x + dx * length, ez = rec.z + dz * length, pad = 2.5;
    const minx = Math.min(rec.x, ex) - pad, maxx = Math.max(rec.x, ex) + pad;
    const minz = Math.min(rec.z, ez) - pad, maxz = Math.max(rec.z, ez) + pad;
    const out = [];
    for (const b of grid.queryAABB(minx, minz, maxx, maxz)) {
      if (b.foliage) continue;                                 // leaves never stop a fall
      if (b.downer === rec) continue;                          // our own stump/bole bands
      if (!(b.tree || b.struct || b.building || b.prop)) continue;
      out.push({ min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] });
      if (out.length >= 40) break;
    }
    return out;
  }

  // build a BufferGeometry from a {positions, colors?, normals?, uvs?} bag (splitGeomAtY output)
  _geomFrom(bag) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(bag.positions, 3));
    if (bag.normals) g.setAttribute('normal', new THREE.Float32BufferAttribute(bag.normals, 3));
    if (bag.uvs) g.setAttribute('uv', new THREE.Float32BufferAttribute(bag.uvs, 2));
    if (bag.colors) g.setAttribute('color', new THREE.Float32BufferAttribute(bag.colors, 3));
    g.computeBoundingSphere();
    return g;
  }

  // Build a splinter "torn wood" crown mesh for a break face, in the LOCAL frame of the piece it parents
  // to. cx/cz = leaning-centreline offset at the cut; cy = cut height in that frame; up = teeth direction.
  _splinterMesh(cx, cy, cz, radius, seed, up, material) {
    const bag = makeSplinters(cx, cy, cz, Math.max(0.12, radius), (seed >>> 0) || 1, 9, radius * 0.5, radius * 1.7, up, WOOD_RAW);
    const m = new THREE.Mesh(this._geomFrom(bag), material);
    m.castShadow = true;
    return m;
  }

  // Once a falling top SETTLES, give the lying log a collision box (solid + shootable) and make it a
  // flammable "prop" so it can still be hit, can still BURN on the ground, and can be broken apart.
  _registerFallenLog(f) {
    const b = f.body, rec = f.rec;
    const s = Math.sin(b.angle), c = Math.cos(b.angle), L = b.length;
    const ax = b.pivot[0], ay = b.pivot[1], az = b.pivot[2];
    const bx = ax + s * L * b.dirXZ[0], by = ay + c * L, bz = az + s * L * b.dirXZ[1];   // far tip of the fallen log = the CROWN/leaves
    const r = Math.max(0.2, (rec && rec.trunkR) || 0.25) + 0.12;
    const matName = (rec && rec.cls === 1) ? 'wood' : 'trunk';
    const id = f.logId != null ? f.logId : (100000 + (rec ? rec.id : ++this._idc));   // unique per snap (re-snappable trees make several logs)
    // FULL-log AABB only sizes the part (fire flame seat + HP); collision is TWO boxes below.
    const gy = this.world.terrain ? Math.min(this.world.terrain.terrainHeightAt(ax, az), this.world.terrain.terrainHeightAt(bx, bz)) : 0;
    const minA = [Math.min(ax, bx) - r, Math.min(ay, by, gy), Math.min(az, bz) - r];
    const maxA = [Math.max(ax, bx) + r, Math.max(ay, by, gy) + 2 * r, Math.max(az, bz) + r];
    const part = makePart(id, matName, minA, maxA, (TREE_HP[(rec && rec.cls) || 2] / MATERIALS[matName].hp) * LOG_HP_MUL); // a downed log is sturdy scenery — takes a BURST to shoot apart, not one stray bullet
    const log = { fallen: true, prop: true, id, part, mesh: f.pivot, leafMesh: f.topLeafMesh || null, trunkR: r, cls: (rec && rec.cls) || 2,
                  height: maxA[1] - minA[1],   // fire reads owner.height → keeps a downed log's flame low (not a 12 m tree column)
                  fallingRef: f, burntOut: !!f.charred, consumed: false, boxes: [] };  // charred logs already burnt → not flammable
    part.downer = log;
    // ── 1:1 COLLISION HULL ───────────────────────────────────────────────────────────────────────
    // Bin the ACTUAL fallen geometry into tight per-slice AABBs that follow the log's real heading and
    // rise ONLY where wood/branches are — so you walk UNDER a raised crown and step OVER the bole. This
    // replaces the old two FAT seg() boxes (one spanned the whole diagonal as an axis-aligned block; the
    // crown one was a 5 m cube), which neither hugged the log nor let you pass between the branches.
    const logFelTier = felTierFor((rec && rec.trunkR) || 0.25);  // caliber to chop this downed log apart (by its bole thickness)
    f.pivot.updateWorldMatrix(true, true);                       // settle pose is baked → world verts are final
    const axis2 = [b.dirXZ[0], b.dirXZ[1]], org2 = [ax, az];
    // helper: tight WORLD collision boxes for a mesh's verts, tagged with the given seg/flags
    const collide = (mesh, opts, binLen, maxBins, crossBins) => {
      const a = mesh.geometry && mesh.geometry.attributes, pos = a && a.position; if (!pos) return [];
      const made = [];
      for (const bb of binFallenAABBs(pos.array, mesh.matrixWorld.elements, axis2, org2, binLen, maxBins, crossBins)) {
        const box = { min: new THREE.Vector3(bb.min[0] - 0.06, bb.min[1] - 0.06, bb.min[2] - 0.06),
                      max: new THREE.Vector3(bb.max[0] + 0.06, bb.max[1] + 0.06, bb.max[2] + 0.06),
                      downer: log, tree: true, dmat: matName, dpart: opts.dpart, felTier: logFelTier };
        if (opts.foliage) box.foliage = true; if (opts.thicket) box.thicket = true; if (opts.seg) box.seg = opts.seg;
        made.push(box); log.boxes.push(box); this.world.boxes.push(box); this.world.grid.addBox(box);
      }
      return made;
    };
    // ── PER-SEGMENT WOOD ───────────────────────────────────────────────────────────────────────────
    // Chop the fallen bole+branches into chunks (LOCAL-Y bins of the top geometry → along-log after the
    // fall). Each chunk = its own mesh (child of the settled pivot group) + part/HP + collision boxes, so
    // a shot removes only that chunk (gap), the rest stays shootable. Leaves stay one pass-through volume.
    log.segs = [];
    const wood = f.topWoodMesh;
    // perf cap: only the first MAX_SEG_LOGS downed logs get per-chunk geometry; beyond that, fall back to one
    // shared-HP wood hull (still solid/shootable/flammable, but breaks as a whole — no per-chunk gaps).
    const segmentize = this.logs.filter((l) => l.segs && l.segs.length && !l.consumed).length < MAX_SEG_LOGS;
    if (wood && wood.geometry && wood.geometry.attributes.position && segmentize) {
      const top = wood.parent, a = wood.geometry.attributes;
      const segGeos = binFallenGeometry(a.position.array, a.color && a.color.array, a.normal && a.normal.array, a.uv && a.uv.array, 1, WOOD_SEG_LEN, WOOD_SEG_MAX);
      const nSeg = Math.max(1, segGeos.length);
      const segHpScale = (TREE_HP[(rec && rec.cls) || 2] / MATERIALS[matName].hp) * LOG_HP_MUL / nSeg;
      if (top) top.remove(wood); wood.geometry.dispose();       // replace the single falling-top mesh with the chunks
      segGeos.forEach((sg, idx) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(sg.positions, 3));
        if (sg.normals) g.setAttribute('normal', new THREE.Float32BufferAttribute(sg.normals, 3));
        if (sg.uvs) g.setAttribute('uv', new THREE.Float32BufferAttribute(sg.uvs, 2));
        if (sg.colors) g.setAttribute('color', new THREE.Float32BufferAttribute(sg.colors, 3));
        g.computeBoundingSphere();
        const m = new THREE.Mesh(g, wood.material); m.castShadow = true; if (top) top.add(m);
        const sid = id * 100 + idx, part = makePart(sid, matName, [0, 0, 0], [0, 0, 0], segHpScale);
        part.downer = log;
        log.segs.push({ sid, mesh: m, part, dead: false, grounded: true, adj: [], boxes: [] });
      });
      f.pivot.updateWorldMatrix(true, true);                    // bake the settle pose onto the new chunk meshes
      for (let i = 0; i < log.segs.length; i++) {
        const seg = log.segs[i];
        seg.boxes = collide(seg.mesh, { dpart: seg.part.dpart, seg }, 0.9, 3, 3);   // tight, walk-through gaps
        // seat the seg part on its real world AABB + decide grounded (for the orphan cascade)
        let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
        for (const bx of seg.boxes) { mnx = Math.min(mnx, bx.min.x); mny = Math.min(mny, bx.min.y); mnz = Math.min(mnz, bx.min.z); mxx = Math.max(mxx, bx.max.x); mxy = Math.max(mxy, bx.max.y); mxz = Math.max(mxz, bx.max.z); }
        if (seg.boxes.length) { seg.part.min = [mnx, mny, mnz]; seg.part.max = [mxx, mxy, mxz];
          const cgx = (mnx + mxx) / 2, cgz = (mnz + mxz) / 2, terr = this.world.terrain ? this.world.terrain.terrainHeightAt(cgx, cgz) : 0;
          seg.grounded = mny <= terr + GROUND_EPS;
        }
      }
      for (let i = 0; i < log.segs.length; i++) {                // linear chain adjacency for orphan cascade
        const adj = []; if (i > 0) adj.push(log.segs[i - 1].sid); if (i < log.segs.length - 1) adj.push(log.segs[i + 1].sid);
        log.segs[i].adj = adj;
      }
    } else if (wood && wood.geometry && wood.geometry.attributes.position) {
      collide(wood, { dpart: id }, 1.0, 7, 3);                  // perf fallback: one shared-HP wood hull (no chunks)
    }
    // FALLEN CROWN — leaves: one pass-through foliage volume (no HP/segments; bullets pass, you wade in slowed).
    if (f.topLeafMesh) collide(f.topLeafMesh, { dpart: id, foliage: true, thicket: true }, 1.4, 6);
    this.logs.push(log);
    this.regroundLog(log);   // safety: never register a log floating above the terrain (it rests ON the ground)
  }

  // Drop a fallen log/chunk so its lowest point rests ON the current terrain — no levitation, whether on a
  // slope at settle-time or after a dig removed the soil under it (grid is XZ-only, so a Y shift needs no
  // re-bucketing). Lowers the mesh group (carrying its child chunk meshes), the collision boxes, and the parts.
  regroundLog(log) {
    if (!log || log.consumed || !log.boxes || !log.boxes.length) return;
    let lowest = Infinity, lx = 0, lz = 0;
    for (const bx of log.boxes) { if (bx.min.y < lowest) { lowest = bx.min.y; lx = (bx.min.x + bx.max.x) / 2; lz = (bx.min.z + bx.max.z) / 2; } }
    const terr = this.world.terrain ? this.world.terrain.terrainHeightAt(lx, lz) : 0;
    const drop = lowest - terr;
    if (drop <= 0.1) return;                                   // already resting (or below) the ground
    if (log.mesh) log.mesh.position.y -= drop;
    for (const bx of log.boxes) { bx.min.y -= drop; bx.max.y -= drop; }
    if (log.part) { log.part.min[1] -= drop; log.part.max[1] -= drop; }
    for (const seg of (log.segs || [])) { if (seg.part) { seg.part.min[1] -= drop; seg.part.max[1] -= drop; } }
  }

  // ── FLAT-FALL ──────────────────────────────────────────────────────────────────────────────────────
  // Once a felled top has SETTLED on its stump, decide — SEEDED off the fell seed, so host + every client
  // (and late joiners) agree without a new event — whether it stays PROPPED on the stump or DETACHES and
  // lays FLAT on the ground. A high/precarious break would wobble on a thin stump top, so it stays propped
  // far less often (10 %) than a low break (30 %); the rest fall flat. Returns true ⇒ falls flat.
  _flatFalls(f) {
    if (!this.world.terrain) return false;                     // flat arena/tests: hinge already rests on y=0
    return flatFalls(f.seed, f.fullH > 0 ? f.breakY / f.fullH : 0);
  }
  // The flat rest pose, computed PHYSICALLY so the laid-flat log never buries into a slope: drop the hinge
  // pivot (the butt) to ground level and SIMULATE a fresh fall from there with the same direction, obstacles
  // and terrain. A rigid rod stops at its FIRST ground/obstacle contact (the 5-point groundAt sampling), so
  // it rests ON a hillside / bump instead of forcing a straight line through it. Deterministic (fixed seed +
  // deterministic terrain/obstacles) → host + clients + late joiners agree. Returns { pivotY, angle }.
  _flatTarget(f) {
    const b = f.body, terr = this.world.terrain;
    const r = Math.max(0.2, (f.rec && f.rec.trunkR) || b.radius || 0.25);
    const groundY = (terr ? terr.terrainHeightAt(b.pivot[0], b.pivot[2]) : 0) + r;
    const sim = makeHinge({ pivot: [b.pivot[0], groundY, b.pivot[2]], dirXZ: b.dirXZ, length: b.length, radius: b.radius, seed: 1, obstacles: b.obstacles, groundAt: b.groundAt });
    let g = 0; while (!sim.settled && g++ < 4000) stepBody(sim, 1 / 60);
    return { pivotY: groundY, angle: sim.angle };
  }
  // Did the top come to rest on the GROUND (its own stump / the terrain) rather than leaning against an
  // OBSTACLE (a building / a neighbouring tree)? Only a ground rest may detach + lay flat — a top resting
  // against a solid neighbour must STAY there, or laying it flat would clip it straight through the obstacle.
  _groundSettled(f) {
    const b = f.body; if (!b.groundAt) return true;            // flat arena/tests: always a ground rest
    for (const fr of [0.5, 0.75, 0.92, 1.0]) {
      const s = b.length * fr, sin = Math.sin(b.angle), cos = Math.cos(b.angle);
      const px = b.pivot[0] + sin * s * b.dirXZ[0], py = b.pivot[1] + cos * s, pz = b.pivot[2] + sin * s * b.dirXZ[1];
      if (py - b.radius <= b.groundAt(px, pz) + 0.6) return true;
    }
    return false;                                              // no sample near the terrain ⇒ it's hung up on an obstacle
  }
  // Would laying this top FLAT at `tgt` drive its wood into the terrain? A wide-crowned species (thick
  // side-boughs) can't lie flat without its down-side boughs burying metres deep — those trees must STAY
  // propped (their elevated natural lean keeps the crown in the air). Exact per-vertex test of the wood
  // geometry at the flat pose vs the terrain under each vertex; deterministic (geometry + terrain).
  _flatWouldBury(f, tgt) {
    const wm = f.topWoodMesh, terr = this.world.terrain;
    if (!wm || !wm.geometry || !wm.geometry.attributes.position || !terr) return false;
    const pos = wm.geometry.attributes.position.array;
    const yaw = (f.pivot.children[0] && f.pivot.children[0].rotation.y) || 0;   // the `top` group's tree-yaw
    _q.setFromAxisAngle(_axis.set(f.body.dirXZ[1], 0, -f.body.dirXZ[0]).normalize(), tgt.angle);
    _m.makeRotationFromQuaternion(_q).multiply(_my.makeRotationY(yaw));          // fall-rotation ∘ yaw (translate added below)
    const px = f.body.pivot[0], pz = f.body.pivot[2], py = tgt.pivotY;
    for (let i = 0; i < pos.length; i += 3) {
      _v.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(_m);
      if (py + _v.y - terr.terrainHeightAt(px + _v.x, pz + _v.z) < -0.8) return true;   // a wood vert >0.8 m underground
    }
    return false;
  }
  // Live settle: if seeded to fall flat, it settled on the GROUND (not against an obstacle) and laying it
  // flat won't bury its boughs, start a short detach-and-lay-flat animation (the _dropping loop eases the
  // top off the stump, then registers the log). Returns true ⇒ started (caller must NOT register yet);
  // false ⇒ register where it rests now (propped).
  _resolveFlatFall(f) {
    if (!this._flatFalls(f) || !this._groundSettled(f)) return false;
    const tgt = this._flatTarget(f);
    if (this._flatWouldBury(f, tgt)) return false;            // wide-bough tree → keep its natural propped lean
    f.dropping = true; f.dropT = 0; f.dropDur = 0.5;
    f.dropStartY = f.pivot.position.y; f.dropEndY = tgt.pivotY;
    f.dropStartAngle = f.body.angle; f.dropEndAngle = tgt.angle;
    this._dropping.push(f);
    return true;
  }
  // Late-join snapshot: apply the same flat pose with NO animation, so the resting log exists immediately
  // for any following segdie/propdie replay (the host's flat-vs-propped outcome reproduced from the seed).
  _applyFlatInstant(f) {
    if (!this._flatFalls(f) || !this._groundSettled(f)) return;
    const tgt = this._flatTarget(f);
    if (this._flatWouldBury(f, tgt)) return;
    f.body.angle = tgt.angle; f.body.pivot[1] = tgt.pivotY; f.pivot.position.y = tgt.pivotY;
    _axis.set(f.body.dirXZ[1], 0, -f.body.dirXZ[0]).normalize();
    f.pivot.quaternion.setFromAxisAngle(_axis, tgt.angle);
    f.pivot.updateWorldMatrix(true, true);
  }

  // Remove a fallen log (shot apart or burned out): drop its collision boxes, splinter, retire its mesh.
  _consumeLog(log, seed, shot) {
    if (!log || log.consumed) return;
    log.consumed = true;
    this._emitForest('propdie', log.id);                      // host-auth: clients remove the same log
    this._fading.delete(log);                                  // drop it from the near-camera leaf-fade rotation
    if (this.game.fire) this.game.fire.retire(log.part);      // a shot-apart / blasted burning log: retire its fire too
    if (log.part) log.part.dead = true;
    for (const b of (log.boxes || [])) { this.world.grid.removeBox(b); const i = this.world.boxes.indexOf(b); if (i >= 0) this.world.boxes.splice(i, 1); }
    log.boxes = [];
    const cx = log.part ? (log.part.min[0] + log.part.max[0]) / 2 : 0,
          cy = log.part ? (log.part.min[1] + log.part.max[1]) / 2 : 0,
          cz = log.part ? (log.part.min[2] + log.part.max[2]) / 2 : 0;
    if (this.debris) this.debris.burst('splints', [cx, cy, cz], (seed >>> 0) || 1, undefined, [0, shot ? 0.6 : 0.3, 0]);
    // sink the mesh INTO the ground (no instant poof) — collision boxes already gone, so it's inert while it sinks
    if (log.mesh && log.mesh.parent) {
      const h = log.part ? (log.part.max[1] - log.part.min[1]) : (2 * (log.trunkR || 0.4));
      this._sinking.push({ mesh: log.mesh, t: 0, dur: 1.1, y0: log.mesh.position.y, drop: Math.max(2, h + 1.4) });
    }
    if (log.fallingRef) { const fi = this.FALLING.indexOf(log.fallingRef); if (fi >= 0) this.FALLING.splice(fi, 1); }
  }
  _breakLog(log, seed) { this._consumeLog(log, (seed ?? (log.id * 2654435761)) >>> 0, true); }   // shot apart (whole log — segless decor / blast)

  // Shoot ONE log CHUNK apart: a gap appears where you hit, the rest of the log stays shootable. Any
  // chunk left with no grounded support (a crown bin propped on a now-gone branch) cascades. Host-auth.
  breakLogSeg(log, seg, seed) {
    if (!log || !seg || seg.dead || log.consumed) return;
    const sd = (seed >>> 0) || 1;
    this._killSeg(log, seg, sd);
    const extra = [];
    try {                                                       // orphan cascade (no-op for an all-grounded log)
      const orphans = orphanedCells(log.segs.map((s) => ({ dpart: s.sid, dead: s.dead, grounded: s.grounded, adj: s.adj })));
      for (const o of orphans) { const os = log.segs.find((s) => s.sid === o.dpart && !s.dead); if (os) { this._killSeg(log, os, (sd ^ os.sid) >>> 0); extra.push(os.sid); } }
    } catch (e) { console.warn('[forest] seg orphan cascade failed', e); }
    this._emitForest('segdie', log.id, { sids: [seg.sid, ...extra] });   // host-auth: clients mirror the same chunks
    if (log.segs.every((s) => s.dead)) this._consumeLog(log, sd, true);  // last chunk gone → tidy the empty log
  }
  // remove one chunk: drop its boxes, splinter, sink JUST that chunk into the ground. The chunk mesh is a
  // child of the rotated pivot, so reparent it to the scene (keeping world transform) — then a world-Y sink works.
  _killSeg(log, seg, seed) {
    if (!seg || seg.dead) return;
    seg.dead = true;
    for (const b of seg.boxes) { this.world.grid.removeBox(b); let i = this.world.boxes.indexOf(b); if (i >= 0) this.world.boxes.splice(i, 1); i = log.boxes.indexOf(b); if (i >= 0) log.boxes.splice(i, 1); }
    seg.boxes = [];
    if (seg.part) seg.part.dead = true;
    const c = seg.part ? [(seg.part.min[0] + seg.part.max[0]) / 2, (seg.part.min[1] + seg.part.max[1]) / 2, (seg.part.min[2] + seg.part.max[2]) / 2] : [0, 0, 0];
    if (this.debris) this.debris.burst('splints', c, (seed >>> 0) || 1, undefined, [0, 0.5, 0]);
    if (seg.mesh && seg.mesh.parent) { this.scene.attach(seg.mesh);   // keep world pose, reparent to scene so a world-down sink reads right
      this._sinking.push({ mesh: seg.mesh, t: 0, dur: 0.9, y0: seg.mesh.position.y, drop: Math.max(1.5, 2 * (log.trunkR || 0.4)) }); }
  }
  breakLogSegById(id, sids) {                                   // co-op client mirror (host already ran the cascade)
    const log = this.logs.find((l) => l.id === id); if (!log || !log.segs) return;
    for (const sid of (sids || [])) { const seg = log.segs.find((s) => s.sid === sid && !s.dead); if (seg) this._killSeg(log, seg, (sid >>> 0) || 1); }
    if (log.segs.length && log.segs.every((s) => s.dead) && !log.consumed) { log.consumed = true; this._fading.delete(log); if (log.part) log.part.dead = true; if (this.game.fire) this.game.fire.retire(log.part); }
  }

  consumeProp(rec) {                                                                              // FireManager burnout consumes a prop
    if (rec && rec.isBush) this._consumeBush(rec, (rec.id * 2654435761) >>> 0, false);
    else if (rec && rec.isProp) this._destroyProp(rec, false);
    else this._consumeLog(rec, (rec.id * 2654435761) >>> 0, false);
  }

  // HE blast: fell every standing tree within `radius` whose tier ≤ blastTier (+1 so a tier-3 rocket
  // still topples grown trunks). dir of fall = radially outward from the blast.
  blast(pos, radius, blastTier = 3) {
    for (const rec of this.trees) {
      if (!rec.standing) continue;
      const dx = rec.x - pos.x, dz = rec.z - pos.z;
      if (dx * dx + dz * dz <= radius * radius && MATERIALS[rec.part.dmat].tier <= blastTier + 1) {
        rec.part.dead = true; this.fellTree(rec, [dx, dz], (rec.id * 1597) >>> 0);
      }
    }
    for (const b of this.bushes) {                            // an explosion flattens nearby brush
      if (b.dead) continue;
      const dx = b.x - pos.x, dz = b.z - pos.z;
      if (dx * dx + dz * dz <= radius * radius) this._consumeBush(b, (b.id * 1597) >>> 0, true);
    }
    for (const p of this.props) {                             // shatter nearby destructible props (rock tier 4 shrugs off a tier-3 rocket)
      if (p.dead) continue;
      const dx = p.x - pos.x, dz = p.z - pos.z;
      if (dx * dx + dz * dz <= radius * radius && MATERIALS[p.dmat].tier <= blastTier) this._destroyProp(p, true);
    }
    for (const log of this.logs) {                            // an explosion chews the nearby section out of a downed log
      if (log.consumed || !log.part) continue;
      if (MATERIALS[log.part.dmat].tier > blastTier + 1) continue;
      if (log.segs && log.segs.length) {
        for (let i = log.segs.length - 1; i >= 0; i--) { const seg = log.segs[i]; if (seg.dead || !seg.part) continue;
          const cx = (seg.part.min[0] + seg.part.max[0]) / 2, cz = (seg.part.min[2] + seg.part.max[2]) / 2, dx = cx - pos.x, dz = cz - pos.z;
          if (dx * dx + dz * dz <= radius * radius) this.breakLogSeg(log, seg, (seg.sid * 1597) >>> 0); }
      } else {
        const cx = (log.part.min[0] + log.part.max[0]) / 2, cz = (log.part.min[2] + log.part.max[2]) / 2, dx = cx - pos.x, dz = cz - pos.z;
        if (dx * dx + dz * dz <= radius * radius) this._consumeLog(log, (log.id * 1597) >>> 0, true);
      }
    }
  }

  // APFSDS / penetrator: fell standing trees the rod passes through (tier ≤ pen).
  // APFSDS / penetrator rod: MARCH the world raycast (the SAME boxes bullets hit) and pierce everything
  // on the line — fell each standing tree at the rod's height, chop each log chunk, smash each prop —
  // passing THROUGH foliage like a bullet. This replaces the old loose base-point distance test that
  // missed leaning/thick trees and was inconsistent with how guns hit (trunk-band boxes).
  penetrate(origin, dir, range, w) {
    const pen = (w && w.pen != null) ? w.pen : 5;
    const ignored = [], hit = new Set();
    for (let guard = 0; guard < 24; guard++) {                // each pierced box is added to `ignored`, so this ends
      const wh = this.world.rayHit(origin, dir, range, ignored.length ? ignored : null);
      if (!wh || !wh.box) break;
      const box = wh.box, dn = box.downer; ignored.push(box);
      if (!dn || box.foliage) continue;                       // pass straight through leaves / non-destructible cover
      if (box.seg && dn.fallen) {                             // a sectional log chunk on the line
        const seg = box.seg;
        if (!seg.dead && seg.part && MATERIALS[seg.part.dmat].tier <= pen) this.breakLogSeg(dn, seg, (seg.sid * 7919) >>> 0);
      } else if ((box.tree || box.dmat === 'trunk') && dn.standing && dn.part) {   // standing tree → SNAP at the rod's height
        if (!hit.has(dn) && MATERIALS[dn.part.dmat].tier <= pen) { hit.add(dn); this.fellTree(dn, [dir.x, dir.z], (dn.id * 7919) >>> 0, wh.point.y); }
      } else if (box.tree && dn.fallen && dn.part) {          // a segless (decor) downed log
        if (!hit.has(dn) && MATERIALS[dn.part.dmat].tier <= pen) { hit.add(dn); this._consumeLog(dn, (dn.id * 7919) >>> 0, true); }
      } else if (box.prop && dn.part) {                       // rock / decor prop (rock tier 4 needs APFSDS-tier pen)
        if (!hit.has(dn) && MATERIALS[dn.part.dmat].tier <= pen) { hit.add(dn); this._destroyProp(dn, true); }
      }
    }
  }

  // weapons.js _destructHit routes a `box.prop` hit here — for us that's a BUSH. Damage it (grass tier 0,
  // any round out-pens) and clear it on kill; a non-fatal hit just puffs leaf debris.
  hitProp(rec, w, point) {
    if (!rec || rec.dead || !rec.part || rec.part.dead) return;
    const res = resolveHit(rec.part, w);
    if (res.killed) { if (rec.isBush) this._consumeBush(rec, (rec.id * 2654435761) >>> 0, true); else this._destroyProp(rec, true); }   // bush vs rock/decor prop
    else if (res.effect === 'damage' && this.debris && point) this.debris.burst(rec.dmat === 'stone' ? 'sparks' : 'splints', [point[0], point[1], point[2]], (rec.id ^ 0x55) >>> 0);
  }

  // ── DECOR PROPS (rocks + static fallen logs): destructible scenery placed by ForestScene._scatterDecor.
  // A rock is a SOLID stone prop (tier 4 — bullets chip/spark, only HE-tier blast / APFSDS breaks it);
  // routed via this.props (hitProp/blast/penetrate/consumeProp). Logs reuse the fallen-log path (this.logs).
  _addRock(geometry, material, x, z, yaw) {
    const y = this.world.terrain ? this.world.terrain.terrainHeightAt(x, z) : 0;
    const mesh = new THREE.Mesh(geometry, material); mesh.position.set(x, y, z); mesh.rotation.y = yaw;
    mesh.castShadow = mesh.receiveShadow = true; this.scene.add(mesh);
    geometry.computeBoundingBox(); const bb = geometry.boundingBox;
    const hw = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) * 0.5 + 0.05, top = y + bb.max.y;
    const id = 300000 + (++this._idc), min = [x - hw, y, z - hw], max = [x + hw, top, z + hw];
    const part = makePart(id, 'stone', min, max, 1); part.downer = null;
    const rec = { id, x, z, baseY: y, dmat: 'stone', mesh, part, dead: false, box: null, isProp: true, prop: true };
    part.downer = rec;
    const box = { min: new THREE.Vector3(...min), max: new THREE.Vector3(...max), downer: rec, prop: true, dmat: 'stone', dpart: id };
    rec.box = box; this.world.boxes.push(box); this.world.grid.addBox(box);
    this.props.push(rec);
    return rec;
  }
  _destroyProp(rec, shot) {
    if (!rec || rec.dead) return;
    rec.dead = true; if (rec.part) rec.part.dead = true;
    this._emitForest('propdie', rec.id);                      // host-auth: clients remove the same rock/prop
    if (this.game.fire) this.game.fire.retire(rec.part);
    if (rec.box) { this.world.grid.removeBox(rec.box); const i = this.world.boxes.indexOf(rec.box); if (i >= 0) this.world.boxes.splice(i, 1); rec.box = null; }
    if (this.debris) this.debris.burst(rec.dmat === 'stone' ? 'rubble' : 'splints', [rec.x, rec.baseY + 0.4, rec.z], (rec.id * 2654435761) >>> 0, undefined, [0, shot ? 0.5 : 0.3, 0]);
    if (rec.mesh && rec.mesh.parent) this.scene.remove(rec.mesh); rec.mesh = null;
  }

  // A static fallen-log scenery piece: reuses the live-log path (this.logs) so it's SOLID (stops rounds),
  // shootable-apart (_destructHit → _breakLog) and FLAMMABLE — identical to a tree you felled.
  _addDecorLog(mesh, x, z, yaw, length, r, charred = false) {
    const y = this.world.terrain ? this.world.terrain.terrainHeightAt(x, z) : 0;
    mesh.position.set(x, y + r, z); mesh.rotation.y = yaw; mesh.castShadow = mesh.receiveShadow = true; this.scene.add(mesh);
    const c = Math.cos(yaw), s = Math.sin(yaw), hl = length / 2;
    const ax = x - s * hl, az = z - c * hl, bx = x + s * hl, bz = z + c * hl;   // the two ends along the log axis
    const id = 100000 + (++this._idc);
    const matName = 'trunk';
    const minA = [Math.min(ax, bx) - r, y, Math.min(az, bz) - r], maxA = [Math.max(ax, bx) + r, y + 2 * r, Math.max(az, bz) + r];
    const part = makePart(id, matName, minA, maxA, (TREE_HP[2] / MATERIALS[matName].hp) * LOG_HP_MUL);
    const log = { fallen: true, prop: true, id, part, mesh, leafMesh: null, trunkR: r, cls: 2, height: 2 * r, burntOut: !!charred, consumed: false, boxes: [] };
    part.downer = log;
    const box = { min: new THREE.Vector3(...minA), max: new THREE.Vector3(...maxA), downer: log, tree: true, dmat: matName, dpart: id, felTier: felTierFor(r) };
    log.boxes.push(box); this.world.boxes.push(box); this.world.grid.addBox(box);
    this.logs.push(log);
    return log;
  }

  // ── BUSHES (M3): head-height understorey you push THROUGH (slow) + that fades at the camera + hides
  // you, and that a shot/blast/fire clears. A bush is a single leaf mesh + ONE foliage+thicket+prop box
  // (no wood bands — it's all leaf) + a light 'grass' destruct part (fuel>0 → burns). ─────────────────
  _addBush(x, z, scale, seed) {
    const shrub = this._frng() < 0.32;                         // a few low steppe-scrub shrubs among the bushes
    const res = shrub ? makeShrub(seed) : makeBush(seed);
    const geo = res.geometry; if (scale !== 1) geo.scale(scale, scale, scale);
    geo.computeBoundingBox(); const bb = geo.boundingBox;       // local AABB (post-scale), base ~at origin
    const yaw = this._rr(0, Math.PI * 2);
    const y = this.world.terrain ? this.world.terrain.terrainHeightAt(x, z) : 0;
    const mesh = new THREE.Mesh(geo, FOLIAGE_OPAQUE);          // leaf material → fades near the camera (the showcase)
    mesh.position.set(x, y, z); mesh.rotation.y = yaw; mesh.castShadow = true;
    this.scene.add(mesh);
    const id = 200000 + (++this._idc);
    const hw = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) * 0.5 + 0.1;   // square hull (round bush, rotation-safe)
    const top = y + bb.max.y;
    const min = [x - hw, y, z - hw], max = [x + hw, top, z + hw];
    const part = makePart(id, 'grass', min, max, 10);          // grass tier 0, fuel 2 → burns; ~10 HP, a shot or two clears it
    const rec = { id, kind: shrub ? 'shrub' : 'bush', x, z, baseY: y, height: bb.max.y, mesh, leafMesh: mesh, part, dead: false, box: null, isBush: true, prop: true };
    part.downer = rec;
    const box = { min: new THREE.Vector3(...min), max: new THREE.Vector3(...max), downer: rec, foliage: true, thicket: true, prop: true, dmat: 'grass', dpart: id };
    rec.box = box; this.world.boxes.push(box); this.world.grid.addBox(box);
    this.bushes.push(rec);
  }

  _blockedBush(x, z) {
    for (const r of this._reserved) { const dx = x - r.x, dz = z - r.z; if (dx * dx + dz * dz < r.r * r.r) return true; }      // off building footprints
    for (const t of this.trees) { const dx = x - t.x, dz = z - t.z; if (dx * dx + dz * dz < 1.2 * 1.2) return true; }          // not clipping a trunk
    for (const b of this.bushes) { const dx = x - b.x, dz = z - b.z; if (dx * dx + dz * dz < 1.3 * 1.3) return true; }         // spread the bushes out
    return false;
  }

  // Scatter `n` bushes into the UNDERSTOREY — clustered around existing trees (1.5–6 m out) so they read
  // as undergrowth, not a lawn. Call AFTER scatter() (needs the trees as cluster seeds).
  scatterBushes(n = 50) {
    const terr = this.world.terrain;
    if (!this.trees.length) return;
    for (let i = 0; i < n; i++) {
      for (let tries = 0; tries < 14; tries++) {
        const host = this.trees[(this._frng() * this.trees.length) | 0];
        const a = this._frng() * Math.PI * 2, d = 1.5 + this._frng() * 5;
        const x = host.x + Math.cos(a) * d, z = host.z + Math.sin(a) * d;
        if (Math.abs(x) > this.world.HALF - 4 || Math.abs(z) > this.world.HALF - 4) continue;
        if (terr && !terr.isPlaceable(x, z, 0.6, 'tree')) continue;
        if (this._blockedBush(x, z)) continue;
        this._addBush(x, z, this._rr(0.85, 1.3), i * 23 + 5000); break;
      }
    }
  }

  _consumeBush(rec, seed, shot) {
    if (!rec || rec.dead) return;
    rec.dead = true;
    this._emitForest('propdie', rec.id);                      // host-auth: clients remove the same bush
    if (this.game.fire) this.game.fire.retire(rec.part);      // a burning bush flattened by a blast/shot: retire its fire
    if (rec.part) rec.part.dead = true;
    this._fading.delete(rec);
    if (rec.box) { this.world.grid.removeBox(rec.box); const i = this.world.boxes.indexOf(rec.box); if (i >= 0) this.world.boxes.splice(i, 1); rec.box = null; }
    if (this.debris) this.debris.burst('splints', [rec.x, rec.baseY + rec.height * 0.5, rec.z], (seed >>> 0) || 1, undefined, [0, shot ? 0.5 : 0.3, 0]);
    if (rec.mesh && rec.mesh.parent) this.scene.remove(rec.mesh);
    rec.mesh = null; rec.leafMesh = null;
  }

  // ── FIRE (game FireManager) — the molotov/rocket fire path. FireManager enumerates burnables via
  // flammableParts(), then chars (charTree → snaps easier) + fells (fellTree on burnout) by the part's
  // owner (= the tree record we set as part.downer). trunk(fuel 10)/wood(fuel 6) burn; the ember chain
  // spreads tree↔tree on its own. ──────────────────────────────────────────────────────────────────
  flammableParts() {
    const out = [];
    for (const t of this.trees) if (t.standing && t.part && !t.part.dead && !t.burntOut) out.push(t.part);
    for (const lg of this.logs) if (!lg.consumed && !lg.burntOut && lg.part && !lg.part.dead) out.push(lg.part);   // downed logs still burn on the ground
    for (const bsh of this.bushes) if (!bsh.dead && bsh.part && !bsh.part.dead) out.push(bsh.part);               // bushes burn (fuel 2) → consumeProp clears them
    return out;
  }
  // FIRE phase 1 — the foliage BLACKENS in place (chars, still leafy): tint the whole merged mesh dark
  // so leaves + bark scorch together. dropLeaves() later strips the leaves for the bare snag.
  charTree(tree) {
    if (!tree || !tree.standing || tree.charred) return;
    tree.charred = true;
    if (tree.part) tree.part.dhp = Math.max(1, tree.part.dhp * 0.5);   // charred wood snaps under the next hit
    // Scorch the trunk/wood IN PLACE. mesh is a Group(wood[,leaf]); tint each mesh EXCEPT the leaf mesh,
    // whose foliage material is shared across all trees (tinting it would blacken the whole forest). The
    // leaves blacken+drop later in dropLeaves. (Old code tinted tree.mesh.material — a Group has none → no-op.)
    if (tree.mesh) tree.mesh.traverse((o) => { if (o.isMesh && o !== tree.leafMesh && o.material && o.material.color) o.material.color.setHex(0x161310); });
    this._emitForest('char', tree.id);   // host-auth: mirror the charred snag on every peer
  }

  // FIRE on a DOWNED log: blacken the lying log INCLUDING its fallen crown leaves, then it burns out
  // (fire._burnout → consumeProp → _consumeLog sinks it). Unlike a standing tree, here we DO scorch the
  // leaf mesh — but its foliage material is shared, so clone it first (else the whole forest's leaves
  // blacken). _noFade pins the tint so the near-camera leaf-fade rotation can't revert it.
  charLog(log) {
    if (!log || !log.fallen || log.charred || log.consumed) return;
    log.charred = true; log._noFade = true; this._fading.delete(log);
    if (log.mesh) log.mesh.traverse((o) => {
      if (!o.isMesh || !o.material || !o.material.color) return;
      if (o === log.leafMesh) o.material = o.material.clone();   // shared foliage mat → clone before tinting
      o.material.color.setHex(0x161310);
    });
    this._emitForest('charlog', log.id);   // host-auth: mirror the blackened log on every peer
  }
  charLogById(id) { const l = this.logs.find((x) => x.id === id); if (l) this.charLog(l); }

  // FIRE phase 2 — the blackened leaves DROP: rebuild the standing tree as its bare CHARRED self. Same
  // species+seed+scale (NO height override) reproduces the EXACT standing tree, now bare + blackened, so the
  // dead snag matches its neighbours. (Passing tree.height double-scaled the snag — it stood scale× too tall.)
  // The fire keeps spanning the bare trunk; it later either fells charred or stays a burnt snag.
  dropLeaves(tree) {
    if (!tree || tree.bare || !tree.standing || !tree.mesh) return;
    tree.bare = true;
    // leaves gone → drop the canopy's soft-cover hitbox so it isn't a phantom shoot-through box in mid-air
    // (the trunk bands stay — the bare snag is still solid + shootable). fellTree drops ALL boxes via _dropBox.
    if (tree.boxes) for (let i = tree.boxes.length - 1; i >= 0; i--) { const b = tree.boxes[i]; if (b.foliage) { this.world.grid.removeBox(b); const j = this.world.boxes.indexOf(b); if (j >= 0) this.world.boxes.splice(j, 1); tree.boxes.splice(i, 1); } }
    // A SNAPPED STUMP (already shorter than the original) has no crown left to drop and must NOT be rebuilt:
    // makeTree with no height override regrows the FULL tree (the regen bug). Just scorch the existing stump
    // mesh in place. (Passing tree.height instead would double-scale — height is pre-scale in makeTree.)
    if ((tree.snapN || 0) > 0 || !tree.leafMesh || (tree.fullH && tree.height < tree.fullH * 0.99)) {
      if (tree.mesh.traverse) tree.mesh.traverse((o) => { if (o.isMesh && o.material && o.material.color) o.material.color.setHex(0x161310); });
      this._emitForest('drop', tree.id);
      return;
    }
    try {
      const res = makeTree({ species: tree.species, seed: tree.seed, scale: tree.scale, lod: 0, damage: 'charred' });
      const old = tree.mesh;                                  // a Group(wood, leaf) — the charred snag is a single merged mesh (no leaves to fade)
      const m = new THREE.Mesh(res.geometry, res.material);
      m.position.copy(old.position); m.rotation.y = tree.yaw; m.castShadow = true;
      this.scene.add(m); tree.mesh = m; this._fading.delete(tree); tree.leafMesh = null;
      for (const w of this.windy) if (w.m === old) { w.m = m; break; }   // keep the (barely-swaying) snag wired to wind
      this.scene.remove(old);
      old.traverse && old.traverse((o) => { if (o.isMesh && o.geometry && o.geometry !== res.leafGeometry) o.geometry.dispose(); }); // free the old wood+leaf geometries (leaf material is shared — don't dispose)
    } catch (e) {
      tree.mesh.traverse && tree.mesh.traverse((o) => { if (o.isMesh && o.material && o.material.color) o.material.color.setHex(0x161310); }); // fallback: scorch-tint in place
    }
    this._emitForest('drop', tree.id);   // host-auth: mirror the bare (leaves-dropped) snag on every peer
  }

  // A fire that burned out WITHOUT toppling the tree (the ~70% that don't fall): it stays standing as a
  // bare burnt snag, off the flammable list (won't re-ignite) but still shootable — a later hit fells it.
  burnoutSnag(tree) {
    if (!tree) return;
    tree.burntOut = true;
    if (!tree.bare) this.dropLeaves(tree);
  }
  charTreeById(id) { const t = this._treeById(id); if (t) this.charTree(t); }

  clearArea(cx, cz, r) {
    for (const rec of this.trees) {
      if (!rec.standing) continue;
      const dx = rec.x - cx, dz = rec.z - cz;
      if (dx * dx + dz * dz < r * r) { if (rec.mesh) { this.scene.remove(rec.mesh); rec.mesh = null; } this._fading.delete(rec); rec.leafMesh = null; this._dropBox(rec); rec.standing = false; rec.cleared = true; }
    }
  }

  update(dt) {
    this._t += dt; const t = this._t;
    for (const f of this.FALLING) {
      if (f.dropping) continue;                                     // detaching + laying flat → handled by the _dropping loop
      if (f.body.settled) {                                         // give the rested log a hitbox once (unless it's about to fall flat)
        if (!f.logged && !this._resolveFlatFall(f)) { f.logged = true; this._registerFallenLog(f); }
        continue;
      }
      stepBody(f.body, dt);
      _axis.set(f.body.dirXZ[1], 0, -f.body.dirXZ[0]).normalize();   // hinge axis ⟂ fall direction
      f.pivot.quaternion.setFromAxisAngle(_axis, f.body.angle);
      if (f.body.settled && !f.logged && !this._resolveFlatFall(f)) { f.logged = true; this._registerFallenLog(f); }   // settled THIS frame → register (or start the flat-fall)
    }
    // detach-and-lay-flat: ease a felled top down off its stump onto the ground (along the slope), then box it.
    for (let i = this._dropping.length - 1; i >= 0; i--) {
      const f = this._dropping[i]; f.dropT += dt; const u = Math.min(1, f.dropT / f.dropDur);
      const e = u * u * (3 - 2 * u);                                // smoothstep ease
      f.pivot.position.y = f.dropStartY + (f.dropEndY - f.dropStartY) * e;
      const ang = f.dropStartAngle + (f.dropEndAngle - f.dropStartAngle) * e;
      f.body.angle = ang;
      _axis.set(f.body.dirXZ[1], 0, -f.body.dirXZ[0]).normalize();
      f.pivot.quaternion.setFromAxisAngle(_axis, ang);
      if (u >= 1) { f.body.pivot[1] = f.dropEndY; f.dropping = false; f.logged = true; this._registerFallenLog(f); this._dropping.splice(i, 1); }
    }
    // sink-into-ground animation for destroyed logs (ease-in accelerate down, then drop the mesh)
    for (let i = this._sinking.length - 1; i >= 0; i--) {
      const s = this._sinking[i]; s.t += dt; const u = Math.min(1, s.t / s.dur);
      s.mesh.position.y = s.y0 - s.drop * (u * u);
      if (u >= 1) { if (s.mesh.parent) s.mesh.parent.remove(s.mesh); this._sinking.splice(i, 1); }
    }
    const gust = 0.5 + 0.4 * Math.sin(t * 0.5) + 0.2 * Math.sin(t * 1.7 + 1.3);
    for (const w of this.windy) {
      if (!w.m.parent) continue;
      const sz = Math.sin(t * w.speed + w.ph) * w.amp * gust;
      w.m.rotation.set(Math.cos(t * w.speed * 0.7 + w.ph) * w.amp * 0.5 * gust, w.yaw, sz);
    }
    this._updateLeafFade();
  }

  // Near-camera leaf fade: swap the leaf mesh of the 0–2 trees the camera is inside/near to the shared
  // transparent fade material; revert the rest to opaque. Keeps the transparent-queue cost bounded (the
  // fade math is per-fragment off the built-in cameraPosition uniform — no per-tree uniform push needed).
  _updateLeafFade() {
    const cam = this.game.engine && this.game.engine.camera; if (!cam) return;
    const cx = cam.position.x, cy = cam.position.y, cz = cam.position.z, G = FOLIAGE_FADE_GATE, G2 = G * G;
    const want = new Set();
    for (const b of this.world.grid.queryAABB(cx - G, cz - G, cx + G, cz + G)) {
      if (!b.foliage || !b.downer || !b.downer.leafMesh || b.downer._noFade) continue;   // _noFade = a charred log: keep its blackened tint, don't swap to the fade material
      const ddx = Math.max(b.min.x - cx, 0, cx - b.max.x), ddy = Math.max(b.min.y - cy, 0, cy - b.max.y), ddz = Math.max(b.min.z - cz, 0, cz - b.max.z);
      if (ddx * ddx + ddy * ddy + ddz * ddz <= G2) want.add(b.downer);
    }
    for (const rec of want) if (!this._fading.has(rec) && rec.leafMesh) { rec.leafMesh.material = FOLIAGE_FADE; this._fading.add(rec); }
    for (const rec of this._fading) if (!want.has(rec)) { if (rec.leafMesh) rec.leafMesh.material = FOLIAGE_OPAQUE; this._fading.delete(rec); }
  }

  // ── co-op (basic — manual gate): fell ids streamed by the host ──
  // ── CO-OP: the host broadcasts every authoritative forest mutation (char / leaves-drop / fell / prop
  // death); clients mirror it. Each mutation guards on its own state and _emitForest fires ONLY on the
  // host, so a client mirror can't echo. ⚠️ Correct replay needs the forest LAYOUT identical on every
  // peer (id→tree must match) — ForestDemo.scatter is currently UNSEEDED, so until it's made
  // deterministic this is wired-but-positionally-approximate (known co-op-forest gap, 2-PC manual gate).
  _emitForest(k, id, extra = null) {
    const mp = this.game.mp;
    if (!mp || !mp.active || !mp.isHost || !mp.net) return;
    try { mp.net.send('forestfx', Object.assign({ k, id }, extra || {})); } catch (e) {}
  }
  _treeById(id) { return this.trees.find((t) => t.id === id); }
  fellTreeById(id, dx, dz, seed, by, instant) {
    const t = this._treeById(id); if (!t || !t.standing) return;
    this.fellTree(t, [dx, dz], seed, null, by != null ? by : null);
    if (instant) {   // late-join snapshot: settle the fall NOW so the resting log exists for any following segdie
      const f = this.FALLING[this.FALLING.length - 1];
      if (f && f.rec === t && !f.logged) {
        let g = 0; while (!f.body.settled && g++ < 4000) stepBody(f.body, 1 / 60);
        _axis.set(f.body.dirXZ[1], 0, -f.body.dirXZ[0]).normalize(); f.pivot.quaternion.setFromAxisAngle(_axis, f.body.angle);
        this._applyFlatInstant(f);                             // late-join: match the host's flat-vs-propped outcome with no animation
        f.logged = true; this._registerFallenLog(f);
      }
    }
  }
  dropLeavesById(id) { const t = this._treeById(id); if (t) this.dropLeaves(t); }
  destroyPropById(id) {                                       // a fallen log / bush / rock removed on the host
    let r = this.logs.find((l) => l.id === id); if (r) { this._consumeLog(r, (id * 2654435761) >>> 0, false); return; }
    r = this.bushes.find((b) => b.id === id); if (r) { this._consumeBush(r, (id * 2654435761) >>> 0, false); return; }
    r = this.props.find((p) => p.id === id); if (r) this._destroyProp(r, false);
  }
  consumeGrassById() {}                                       // groundcover here is non-destructible visual InstancedMeshes — nothing to consume (kept so the host 'grass' handler can't crash)
  // Late-join: replay every authoritative mutation a fresh joiner missed, as .k-tagged 'forestfx' records.
  netSnapshot() {
    const out = [];
    for (const t of this.trees) {
      // a tree that's been snapped at least once (inert OR still a live stump) → replay its FIRST snap, settled
      // instantly so the resting log exists; re-snaps beyond the first are approximate on a late joiner.
      if ((t.snapN > 0 || !t.standing) && !t.cleared) out.push({ k: 'fell', id: t.id, dx: t._fellDx || 0, dz: t._fellDz || 1, seed: t._fellSeed || ((t.id * 2654435761) >>> 0), by: t._snapBy, instant: 1 });
      else if (t.bare) out.push({ k: 'drop', id: t.id });
      else if (t.charred) out.push({ k: 'char', id: t.id });
    }
    // chopped log chunks — AFTER the fells (the instant-settled logs now exist) so segdie lands on a real log
    for (const lg of this.logs) { if (lg.consumed || !lg.segs || !lg.segs.length) continue; const sids = lg.segs.filter((s) => s.dead).map((s) => s.sid); if (sids.length) out.push({ k: 'segdie', id: lg.id, sids }); }
    for (const lg of this.logs) if (lg.consumed) out.push({ k: 'propdie', id: lg.id });
    for (const b of this.bushes) if (b.dead) out.push({ k: 'propdie', id: b.id });
    for (const p of this.props) if (p.dead) out.push({ k: 'propdie', id: p.id });
    return out;
  }
  stats() { return { trees: this.trees.length, standing: this.trees.filter((t) => t.standing).length, falling: this.FALLING.length }; }
}
