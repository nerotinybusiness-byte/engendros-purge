// destruct.js — DESTRUCTION CORE (pure logic). Originally prototyped in a since-removed
// `tools/destructlab/` scratch area; consolidated here for the game.
//
// PURE & node-testable: NO `import 'three'`, NO DOM. Every export here can run under
// `node --test` (live suite: `node --test tests/destruct/*.test.mjs`). The browser-only
// InstancedMesh debris pool lives in a SEPARATE file, src/destruct-debris.js (it needs THREE)
// — keeping this module THREE-free is what lets the node tests import it directly.
//
// Consolidated here: AABB/ray helpers, the MATERIALS damage matrix + makePart + the part-metadata
// contract, resolveHit/Blast/Penetration (incl. the refined APFSDS model: obliterate fragile /
// through-hole structural + spall), FallingBody mini-physics (hinge/tumble), the `fuel` + `sound`
// fields on MATERIALS, and the runtime apply* pipeline (DestructRuntime).
//
// WIRED: DestructRuntime drives the demo BUILDING destructibles — instantiated in demobuilding.js,
// installed via game.js, and called from weapons.js combat (applyHit/applyBlast/applyPenetration).
// Forest props deliberately call the lower-level resolve*/makePart directly (mirroring the tree
// path) rather than going through DestructRuntime. applyCrush is now a live (but DORMANT) capability
// — resolveCrush + DemoBuilding.applyCrush exist + are tested; no drivable vehicle wires them yet.

// ───────────────────────────────────────────────────────────────────────────
// 1. Geometry helpers (pure AABB/ray on plain [x,y,z] arrays). From geom.js.
// ───────────────────────────────────────────────────────────────────────────

// Slab method. o=origin[3], d=dir[3] (normalized), min/max=[3]. Returns entry t ≥ 0 or null.
export function rayAABB(o, d, min, max) {
  const span = rayAABBSpan(o, d, min, max);
  return span ? span.tIn : null;
}

// Returns { tIn, tOut } or null. tIn clamped to ≥ 0 (origin inside box ⇒ tIn = 0).
export function rayAABBSpan(o, d, min, max) {
  let tIn = -Infinity, tOut = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) {
      if (o[i] < min[i] || o[i] > max[i]) return null;
      continue;
    }
    let t1 = (min[i] - o[i]) / d[i], t2 = (max[i] - o[i]) / d[i];
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tIn) tIn = t1;
    if (t2 < tOut) tOut = t2;
    if (tIn > tOut) return null;
  }
  if (tOut < 0) return null;
  return { tIn: Math.max(tIn, 0), tOut };
}

// Distance from point to closest surface point of the AABB (0 if inside).
export function distToAABB(p, min, max) {
  let s = 0;
  for (let i = 0; i < 3; i++) {
    const d = Math.max(min[i] - p[i], 0, p[i] - max[i]);
    s += d * d;
  }
  return Math.sqrt(s);
}

export function pointInAABB(p, min, max, inflate = 0) {
  return p[0] >= min[0] - inflate && p[0] <= max[0] + inflate &&
         p[1] >= min[1] - inflate && p[1] <= max[1] + inflate &&
         p[2] >= min[2] - inflate && p[2] <= max[2] + inflate;
}

export function aabbCenter(min, max) {
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
}

// ───────────────────────────────────────────────────────────────────────────
// 2. Material registry & damage matrix. From matrix.js + spec §2.2.
// ───────────────────────────────────────────────────────────────────────────

// Single source of truth. Each entry: { tier, hp, debris, sound, fuel }.
//  - tier   : hardness 0–5; a weapon `pen < tier` ⇒ cosmetic only (no HP loss).
//  - hp      : base part hit-points (scaled per part via hpScale).
//  - debris  : recipe key consumed by the DebrisPool (src/destruct-debris.js).
//  - sound   : audio bucket key for a later audio phase (glass/wood/metal/masonry/grass).
//  - fuel    : burn-time budget the FIRE system reads. fuel === 0 ⇒ NEVER ignites
//              (glass/sheetmetal/brick/concrete/steel). fuel > 0 ⇒ burns + ignites neighbours.
export const MATERIALS = {
  glass:      { tier: 0, hp: 1,    debris: 'shards',  sound: 'glass',   fuel: 0  },
  wood:       { tier: 1, hp: 60,   debris: 'splints', sound: 'wood',    fuel: 6  },
  sheetmetal: { tier: 2, hp: 120,  debris: 'panels',  sound: 'metal',   fuel: 0  },
  trunk:      { tier: 2, hp: 250,  debris: 'splints', sound: 'wood',    fuel: 10 },
  brick:      { tier: 3, hp: 400,  debris: 'rubble',  sound: 'masonry', fuel: 0  },
  concrete:   { tier: 4, hp: 900,  debris: 'rubble',  sound: 'masonry', fuel: 0  },
  steel:      { tier: 5, hp: 2000, debris: 'sparks',  sound: 'metal',   fuel: 0  },
  grass:      { tier: 0, hp: 1,    debris: 'splints', sound: 'grass',   fuel: 2  },
  stone:      { tier: 4, hp: 600,  debris: 'rubble',  sound: 'masonry', fuel: 0  },
  // железобетон (reinforced concrete) — bunker armour ABOVE the whole caliber roster: HE blast.tier ≤4
  // and APFSDS pen 5 both fall short of tier 6, so nothing in CALIBERS removes it (resolveHit ⇒ cosmetic,
  // resolveBlast ⇒ skipped; APFSDS only ever HOLES a structural wall, never deletes it). To crack it,
  // ADD a pen ≥6 / blast.tier ≥6 caliber — the scalability hook. Ported from the demo lab (matrix.js).
  reinforcedConcrete: { tier: 6, hp: 6000, debris: 'rubble', sound: 'masonry', fuel: 0 },
};

// APFSDS classifies parts by tier: tier ≤ FRAGILE_MAX_TIER ⇒ FRAGILE (obliterated / spall target);
// tier > it ⇒ STRUCTURAL (through-hole, stays standing). Single source so the long-rod rule can't
// drift between resolvePenetration here and the forest prop path (forest.penetrate).
export const FRAGILE_MAX_TIER = 2;

// Reference caliber/pen table (spec §5). Gameplay weaponDefs map onto this shape
// ({ pen, dmg } + optional blast / through / spall). Kept as a graduated copy of the
// lab's LAB_WEAPONS so the ported tests and the apply* pipeline share one source.
export const CALIBERS = {
  pistol:   { key: 'pistol',   pen: 0, dmg: 8 },
  shotgun:  { key: 'shotgun',  pen: 1, dmg: 12 },   // pellet pen 1 — breaks fences
  rifle:    { key: 'rifle',    pen: 1, dmg: 15 },
  hmg127:   { key: 'hmg127',   pen: 2, dmg: 40 },
  heRocket: { key: 'heRocket', pen: 4, dmg: 500, blast: { r1: 2.5, r2: 6, tier: 3 } },
  apfsds:   { key: 'apfsds',   pen: 5, dmg: 900, through: { maxWalls: 4, falloff: 0.6 },
              spall: { range: 6, halfAngle: 0.5 } },
  he152:    { key: 'he152',    pen: 5, dmg: 2000, blast: { r1: 4.5, r2: 11, tier: 4 } },  // 152 mm ОФ — a
              // heavier shell: ~3× the breach radius of heRocket and cracks CONCRETE/stone (tier 4) too,
              // but still NOT reinforcedConcrete (tier 6). The scalability demo — bigger caliber wrecks more.
};

// ── Part-metadata contract ───────────────────────────────────────────────────
// A destructible part generalizes world.js's `struct: true, _ref` fortification box:
//   { min, max,          AABB corners as [x,y,z] arrays (as today's collision boxes)
//     dmat,              material key into MATERIALS — its PRESENCE marks a box destructible
//     dhp,               current hit-points
//     dpart,             stable part id (MP sync + late-join)
//     downer,            back-ref to the owning destructible (building/tree) — solves the
//                        "world.boxes has no mesh back-reference" gotcha
//     dead }             true once destroyed (pooled, not freed)
// makePart fills this shape; `downer` is wired by the owner at registration time.
export function makePart(id, mat, min, max, hpScale = 1) {
  if (!MATERIALS[mat]) throw new Error(`unknown material: ${mat}`);
  return { dpart: id, dmat: mat, dhp: MATERIALS[mat].hp * hpScale, min, max, downer: null, dead: false };
}

// Orphan-support flood for voxel collapse (#6). `cells` = destructible CELLS, each carrying
//   { dpart, dead, grounded, adj:[dpart...] } — grounded cells rest on the foundation (support
// roots); adj is the precomputed 4-neighbour id list. Floods "supported" out from every live
// grounded cell through live neighbours, then returns the ids of still-LIVE cells with NO alive
// path back to the ground — they've lost support and should cave. Pure + deterministic (no RNG):
// removing them all in one pass IS the full single-event cascade (grounded is static, so killing
// orphans can't ground anything new). Lateral links mean a single knocked-out base cell arches
// over (no collapse); cutting a whole base row drops everything above it.
export function orphanedCells(cells) {
  const byId = new Map();
  for (const c of cells) byId.set(c.dpart, c);
  const supported = new Set();
  const stack = [];
  for (const c of cells) if (!c.dead && c.grounded) { supported.add(c.dpart); stack.push(c); }
  while (stack.length) {
    const c = stack.pop();
    for (const nid of c.adj) {
      if (supported.has(nid)) continue;
      const n = byId.get(nid);
      if (n && !n.dead) { supported.add(nid); stack.push(n); }
    }
  }
  const orphans = [];
  for (const c of cells) if (!c.dead && !supported.has(c.dpart)) orphans.push(c.dpart);
  return orphans;
}

// Hitscan rule: pen < tier ⇒ cosmetic (decal/chip, no hp). Else damage; killed at hp ≤ 0.
// Mutates part.dhp / part.dead when pen ≥ tier. `tierOverride` (optional) lets a caller gate on a
// DIFFERENT threshold than the material's own tier — used by trees/logs so the "what caliber fells
// it" check scales with the trunk THICKNESS (a slim trunk falls to an SMG; a thick bole needs an
// MG/HE) while the material still drives fire + HP. null ⇒ use the material tier (unchanged).
export function resolveHit(part, weapon, tierOverride = null) {
  if (part.dead) return { effect: 'cosmetic' };
  const m = MATERIALS[part.dmat];
  const tier = tierOverride != null ? tierOverride : m.tier;
  if (weapon.pen < tier) return { effect: 'cosmetic' };
  part.dhp -= weapon.dmg;
  if (part.dhp <= 0) part.dead = true;
  return { effect: 'damage', dmg: weapon.dmg, killed: part.dead };
}

// HE blast (spec §5): kills parts with tier ≤ blast.tier within r1 of the closest AABB point;
// additionally shatters ALL glass within the wider r2. Mutates parts. Returns id lists.
export function resolveBlast(parts, pos, blast) {
  const killed = [], glass = [];
  for (const part of parts) {
    if (part.dead) continue;
    const d = distToAABB(pos, part.min, part.max);
    const m = MATERIALS[part.dmat];
    if (d <= blast.r1 && m.tier <= blast.tier) {
      part.dhp = 0; part.dead = true; killed.push(part.dpart);
    } else if (d <= blast.r2 && part.dmat === 'glass') {
      part.dhp = 0; part.dead = true; glass.push(part.dpart);
    }
  }
  return { killed, glass };
}

// REFINED APFSDS long-rod (spec §5 + owner refinement). NO explosion. Along the ray:
//   • FRAGILE parts (material tier ≤ FRAGILE_MAX_TIER — glass/wood/sheetmetal/trunk/grass) are
//     OBLITERATED (dead:true) and returned for debris. They do NOT consume a wall slot
//     and do NOT stop the rod.
//   • STRUCTURAL parts (tier > FRAGILE_MAX_TIER — brick/stone/concrete/steel) get a THROUGH-HOLE only: the part
//     STAYS (dead:false), damage decays by `falloff` per wall, and a SPALL CONE opens behind
//     each penetrated wall. Each cone carries `targets` = fragile parts whose centre lies in
//     the cone, so the caller can apply real spall damage (kill props / hurt enemies+players).
//   The rod stops after `through.maxWalls` STRUCTURAL penetrations.
// Returns { hits:[{id,tIn,entry,exit,dmg,killed,kind}], cones:[{apex,dir,range,halfAngle,targets}] }.
export function resolvePenetration(parts, origin, dir, weapon) {
  const candidates = [];
  for (const part of parts) {
    if (part.dead) continue;
    const span = rayAABBSpan(origin, dir, part.min, part.max);
    if (span) candidates.push({ part, tIn: span.tIn, tOut: span.tOut });
  }
  candidates.sort((a, b) => a.tIn - b.tIn);

  const maxWalls = (weapon.through && weapon.through.maxWalls) ?? 4;
  const falloff  = (weapon.through && weapon.through.falloff)  ?? 0.6;
  const spallRange = (weapon.spall && weapon.spall.range) ?? 6;
  const spallHalf  = (weapon.spall && weapon.spall.halfAngle) ?? 0.5;

  const hits = [], cones = [];
  let dmg = weapon.dmg, walls = 0;
  for (const { part, tIn, tOut } of candidates) {
    const entry = [origin[0] + dir[0] * tIn, origin[1] + dir[1] * tIn, origin[2] + dir[2] * tIn];
    const exit  = [origin[0] + dir[0] * tOut, origin[1] + dir[1] * tOut, origin[2] + dir[2] * tOut];
    const tier = MATERIALS[part.dmat].tier;
    if (tier <= FRAGILE_MAX_TIER) {                    // FRAGILE — obliterated, free pass
      part.dhp = 0; part.dead = true;
      hits.push({ id: part.dpart, tIn, entry, exit, dmg, killed: true, kind: 'obliterate' });
      continue;
    }
    if (walls >= maxWalls) break;                      // rod spent on structural walls
    part.dhp = Math.max(0, part.dhp - dmg);            // takes damage but STAYS (hole, not breach)
    hits.push({ id: part.dpart, tIn, entry, exit, dmg, killed: false, kind: 'hole' });
    const cone = { apex: exit, dir: [...dir], range: spallRange, halfAngle: spallHalf, targets: [] };
    // Spall targets: fragile, still-alive parts whose centre falls in the cone (beyond this
    // wall) — scanned over ALL parts, not just ray-candidates, since spall fans off-axis.
    for (const c of parts) {
      if (c === part || c.dead || MATERIALS[c.dmat].tier > FRAGILE_MAX_TIER) continue;
      if (coneContains(cone, aabbCenter(c.min, c.max))) cone.targets.push(c.dpart);
    }
    cones.push(cone);
    dmg *= falloff; walls++;
  }
  return { hits, cones };
}

// AABB-vs-AABB overlap on plain [x,y,z] arrays (inclusive). Used by the vehicle-crush query.
export function aabbOverlap(amin, amax, bmin, bmax) {
  return amin[0] <= bmax[0] && amax[0] >= bmin[0] &&
         amin[1] <= bmax[1] && amax[1] >= bmin[1] &&
         amin[2] <= bmax[2] && amax[2] >= bmin[2];
}

// Vehicle crush query (pure; the runtime/owner applies the result). A vehicle pressing its world
// AABB into a set of destructible parts, with crushTier = its crushing power:
//   • a part of tier ≤ crushTier overlapping the AABB is CRUSHED (shoved out of the way) + adds drag;
//   • any overlapping part of tier > crushTier is HARD → the vehicle is BLOCKED (can't shove through);
//   • glass always shatters (free) and never blocks.
// Returns { blocked, crushed:[dpart], hard:[dpart], drag(0..1) }. Scales by data: a T-62 (crushTier 4)
// flattens brick (3) but stops at reinforcedConcrete (6); a car (crushTier 1) can't even crush brick.
export function resolveCrush(parts, aabb, crushTier) {
  const crushed = [], hard = [];
  for (const p of parts) {
    if (p.dead) continue;
    if (!aabbOverlap(aabb.min, aabb.max, p.min, p.max)) continue;
    if (p.dmat === 'glass') { crushed.push(p.dpart); continue; }      // panes shatter, never block
    if (MATERIALS[p.dmat].tier <= crushTier) crushed.push(p.dpart);
    else hard.push(p.dpart);
  }
  const blocked = hard.length > 0;
  const drag = blocked ? 1 : Math.min(0.85, crushed.length * 0.12);   // resistance shoving through soft mass
  return { blocked, crushed, hard, drag };
}

// Is point p inside the spall cone?
export function coneContains(cone, p) {
  const v = [p[0] - cone.apex[0], p[1] - cone.apex[1], p[2] - cone.apex[2]];
  const along = v[0] * cone.dir[0] + v[1] * cone.dir[1] + v[2] * cone.dir[2];
  if (along <= 0 || along > cone.range) return false;
  const len = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2);
  return Math.acos(Math.min(1, along / len)) <= cone.halfAngle;
}

// ───────────────────────────────────────────────────────────────────────────
// 3. FallingBody mini-physics (deterministic, fixed 120 Hz substep). From fallphys.js.
//    Math.sin/cos are not bit-specified by ECMAScript; MP replay determinism assumes the
//    same JS engine family (V8) on all peers. Settle thresholds are coarse enough that
//    ULP-level trig differences are very unlikely to change outcomes.
// ───────────────────────────────────────────────────────────────────────────

const SUBSTEP = 1 / 120;
const G = 9.81;            // 1 unit = 1 m
const DAMP = 0.35;         // angular drag (air + green-wood fibres at the hinge)
const SETTLE_AV = 1.2;     // contact below this angular speed ⇒ settle
const BOUNCE = -0.25;      // angular restitution on hard contact
const MAX_BOUNCES = 3;

// Tiny seeded RNG (mulberry32 copy of util.js makeRNG — kept dependency-free for node tests).
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Hinged trunk above a break point. pivot=[x,y,z]; dirXZ=[x,z] horizontal fall dir (normalized);
// length/radius in metres; obstacles = [{min,max}, ...] static AABBs to rest against.
// `groundAt(x,z)→y` (optional) makes the rod settle on a heightfield instead of the y=0 plane —
// pass terrain.terrainHeightAt so a felled tree on a hill rests ON the slope, not hanging down to
// y=0. Must be PURE/deterministic (no RNG) for co-op replay. Omitted ⇒ flat y=0 (node tests, arena).
export function makeHinge({ pivot, dirXZ, length, radius, seed = 1, obstacles = [], groundAt = null }) {
  const rng = mulberry32(seed);
  return {
    kind: 'hinge', pivot, dirXZ, length, radius, obstacles, groundAt,
    angle: 0.03 + rng() * 0.04,   // seeded initial lean — the only randomness
    angVel: 0, bounces: 0, settled: false, acc: 0, rng,
  };
}

// Ballistic tumbling chunk (HE hero debris / collapsing masonry). pos/vel = [x,y,z].
//   g      overrides gravity (default 9.81 = physical). Pass a smaller value (e.g. FALL_G ≈ 4.2) for
//          a slower, weightier collapse — heavy masonry settling reads better slowed down (owner ask).
//   spin   scales the tumble rate (1 = default; < 1 = a heavy, lazy roll).
//   floorY rest plane (default 0 = world ground). Pass the building's base so collapse rubble piles
//          ON the foundation instead of sinking to world y=0 when the structure sits up on terrain.
// All three default to the previous behaviour, so the lone existing caller path is byte-identical.
export function makeTumble({ pos, vel, seed = 1, radius = 0.15, g = G, spin = 1, floorY = 0 }) {
  const rng = mulberry32(seed);
  const ax = [rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1];
  const n = Math.hypot(...ax) || 1;
  return {
    kind: 'tumble', pos: [...pos], vel: [...vel], g, floorY,
    rotAxis: ax.map(v => v / n), rotAngle: 0, rotSpeed: (2 + rng() * 6) * spin,
    bounces: 0, settled: false, acc: 0, radius,
  };
}

// World point at fraction f (0=pivot/butt, 1=tip) along the hinged rod at its current angle.
export function hingePoint(b, f) {
  const s = b.length * f, sin = Math.sin(b.angle), cos = Math.cos(b.angle);
  return [b.pivot[0] + sin * s * b.dirXZ[0], b.pivot[1] + cos * s, b.pivot[2] + sin * s * b.dirXZ[1]];
}

// Advance by caller dt (any size; clamps at 50 ms like the game loop). Fixed-substep inside.
export function stepBody(b, dt) {
  if (b.settled) return;
  b.acc += Math.min(dt, 0.05);
  while (b.acc >= SUBSTEP && !b.settled) {
    b.acc -= SUBSTEP;
    if (b.kind === 'hinge') subHinge(b); else subTumble(b);
  }
}

// 5-point sampling along the rod (no f=0 — the pivot region can't reach the ground).
function hingeContact(b) {
  for (const f of [0.35, 0.55, 0.75, 0.92, 1.0]) {
    const p = hingePoint(b, f);
    const gy = b.groundAt ? b.groundAt(p[0], p[2]) : 0;          // terrain surface under this sample (else flat 0)
    if (p[1] - b.radius <= gy) return true;                      // ground
    for (const o of b.obstacles) if (pointInAABB(p, o.min, o.max, b.radius)) return true;
  }
  return false;
}

function subHinge(b) {
  b.angVel += ((1.5 * G / b.length) * Math.sin(b.angle) - DAMP * b.angVel) * SUBSTEP;
  const prev = b.angle;
  b.angle += b.angVel * SUBSTEP;
  if (b.angVel > 0 && hingeContact(b)) {
    b.angle = prev;                                              // back out of penetration
    if (Math.abs(b.angVel) < SETTLE_AV || b.bounces >= MAX_BOUNCES) { b.settled = true; return; }
    b.angVel *= BOUNCE; b.bounces++;
  }
}

function subTumble(b) {
  b.vel[1] -= (b.g ?? G) * SUBSTEP;   // per-body gravity (makeTumble always sets b.g; ?? guards legacy bodies)
  for (let i = 0; i < 3; i++) b.pos[i] += b.vel[i] * SUBSTEP;
  b.rotAngle += b.rotSpeed * SUBSTEP;
  const floor = (b.floorY ?? 0) + b.radius;             // rest ON the building base, not world y=0
  if (b.pos[1] <= floor) {
    b.pos[1] = floor;
    if (Math.abs(b.vel[1]) < 1.0 || b.bounces >= MAX_BOUNCES) {
      b.settled = true; b.vel = [0, 0, 0]; b.rotSpeed = 0; return;
    }
    b.vel[1] *= -0.3; b.vel[0] *= 0.6; b.vel[2] *= 0.6; b.rotSpeed *= 0.5; b.bounces++;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Tight per-CELL AABBs hugging a TRANSFORMED mesh's vertices, binned in the log's own horizontal
// frame. Gives a FELLED tree's lying log + branches a 1:1 collision hull — short boxes that follow
// the log's real heading and rise ONLY where wood/branches actually are (walk UNDER a raised crown,
// step OVER the bole), and — with crossBins > 1 — SPLIT the trunk from side-branches across the axis
// so there's real air to walk between them. Replaces one fat axis-aligned box over the whole diagonal.
// PURE & node-testable (no THREE): positions = flat [x,y,z,…] (Float32Array|Array); m = 16 column-major
// matrixWorld elements; axis = [dx,dz] unit horizontal heading (the log direction); originXZ = [ax,az]
// the projection origin (log butt); binLen ≈ slice length along the log (m); maxBins caps the ALONG
// count; crossBins caps the ACROSS count (1 = a single slice per along-bin, the old 1-D behaviour);
// crossLen ≈ cell width across the log (m). Returns [{ min:[x,y,z], max:[x,y,z] }] per non-empty cell,
// in the SAME (world) space as `m` maps into, ordered along→across (deterministic for MP replay).
export function binFallenAABBs(positions, m, axis, originXZ, binLen = 1.0, maxBins = 8, crossBins = 1, crossLen = 0.7) {
  const n = positions.length;
  if (n < 9) return [];
  const ax = originXZ[0], az = originXZ[1], dx = axis[0], dz = axis[1];
  const px = -dz, pz = dx;                              // perpendicular horizontal axis (across the log)
  const cnt = (n / 3) | 0;
  const wx = new Float64Array(cnt), wy = new Float64Array(cnt), wz = new Float64Array(cnt);
  const uu = new Float64Array(cnt), vv = new Float64Array(cnt);
  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
  for (let i = 0, j = 0; j < cnt; i += 3, j++) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    const X = m[0] * x + m[4] * y + m[8] * z + m[12];   // column-major (THREE Matrix4.elements)
    const Y = m[1] * x + m[5] * y + m[9] * z + m[13];
    const Z = m[2] * x + m[6] * y + m[10] * z + m[14];
    wx[j] = X; wy[j] = Y; wz[j] = Z;
    const u = (X - ax) * dx + (Z - az) * dz;            // distance along the log axis from the butt
    const v = (X - ax) * px + (Z - az) * pz;            // distance across the log (trunk ≈ 0)
    uu[j] = u; vv[j] = v;
    if (u < umin) umin = u; if (u > umax) umax = u; if (v < vmin) vmin = v; if (v > vmax) vmax = v;
  }
  const uspan = Math.max(1e-3, umax - umin);
  const nu = Math.max(1, Math.min(maxBins | 0, Math.ceil(uspan / binLen)));
  const uinv = nu / uspan;
  const vspan = Math.max(1e-3, vmax - vmin);
  const nv = (crossBins | 0) <= 1 ? 1 : Math.max(1, Math.min(crossBins | 0, Math.ceil(vspan / crossLen)));
  const vinv = nv / vspan;
  const cells = new Map();
  for (let j = 0; j < cnt; j++) {
    let bu = Math.floor((uu[j] - umin) * uinv); if (bu < 0) bu = 0; else if (bu >= nu) bu = nu - 1;
    let bv = nv === 1 ? 0 : Math.floor((vv[j] - vmin) * vinv); if (bv < 0) bv = 0; else if (bv >= nv) bv = nv - 1;
    const key = bu * nv + bv, X = wx[j], Y = wy[j], Z = wz[j];
    const bb = cells.get(key);
    if (!bb) cells.set(key, { min: [X, Y, Z], max: [X, Y, Z] });
    else {
      if (X < bb.min[0]) bb.min[0] = X; else if (X > bb.max[0]) bb.max[0] = X;
      if (Y < bb.min[1]) bb.min[1] = Y; else if (Y > bb.max[1]) bb.max[1] = Y;
      if (Z < bb.min[2]) bb.min[2] = Z; else if (Z > bb.max[2]) bb.max[2] = Z;
    }
  }
  const out = [];
  for (const k of [...cells.keys()].sort((a, b) => a - b)) out.push(cells.get(k));
  return out;
}

// 2-WAY split of a NON-INDEXED triangle-soup at a cut along one local axis component, by triangle
// centroid. Used to RE-snap a bare stump: the lower part stays as the new (shorter) stump, the upper
// part becomes the falling top — re-zeroed along `comp` by `cut` so its local origin sits at the break
// (ready to hinge). PURE & node-testable. Returns { lo, hi } each { positions, colors|null, normals|null,
// uvs|null } (hi's positions shifted down by cut along comp).
export function splitGeomAtY(pos, col, nor, uv, comp, cut) {
  const triN = (pos.length / 9) | 0;
  const mk = () => ({ positions: [], colors: col ? [] : null, normals: nor ? [] : null, uvs: uv ? [] : null });
  const lo = mk(), hi = mk();
  for (let t = 0; t < triN; t++) {
    const o = t * 9;
    const cen = (pos[o + comp] + pos[o + 3 + comp] + pos[o + 6 + comp]) / 3;
    const dst = cen <= cut ? lo : hi, shift = dst === hi ? cut : 0;
    for (let v = 0; v < 3; v++) { const p = o + v * 3; let X = pos[p], Y = pos[p + 1], Z = pos[p + 2];
      if (shift) { if (comp === 0) X -= shift; else if (comp === 1) Y -= shift; else Z -= shift; }
      dst.positions.push(X, Y, Z); }
    if (col) for (let k = 0; k < 9; k++) (dst.colors).push(col[o + k]);
    if (nor) for (let k = 0; k < 9; k++) (dst.normals).push(nor[o + k]);
    if (uv) { const ou = t * 6; for (let k = 0; k < 6; k++) (dst.uvs).push(uv[ou + k]); }
  }
  return { lo, hi };
}

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
  const slotW = (Math.PI * 2) / count;
  for (let i = 0; i < count; i++) {
    // FIX 5: jitter each tooth's angular position within its slot (±0.35 slot width) → torn/irregular look
    const ja = (rng() - 0.5) * 0.7 * slotW, jb = (rng() - 0.5) * 0.7 * slotW;
    const a0 = (i / count) * Math.PI * 2 + ja, a1 = ((i + 1) / count) * Math.PI * 2 + jb;
    const r0 = radius * (0.8 + rng() * 0.2), r1 = radius * (0.8 + rng() * 0.2);   // rim base, within radius
    const am = (a0 + a1) / 2, rm = radius * (0.08 + rng() * 0.57);                 // wider inward-pull variance [0.08,0.65]×radius
    const len = lenMin + rng() * (lenMax - lenMin);
    tooth(
      cx + Math.cos(a0) * r0, cy, cz + Math.sin(a0) * r0,
      cx + Math.cos(a1) * r1, cy, cz + Math.sin(a1) * r1,
      cx + Math.cos(am) * rm, cy + dir * len, cz + Math.sin(am) * rm,
    );
  }
  return { positions, colors, normals, uvs };
}

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

// Where a STANDING tree snaps when shot: the break fraction = the hit height up the trunk, clamped so
// a snap never sits at the very base (a tiny stub) or up in the crown (a half-canopy stub). remainFrac
// (= breakAt) scales the surviving stump's HP so a tall stump still resists, a short stub dies easily.
// PURE & node-testable. (makeTree({breakAt}) further clamps the cut below the crown, so the whole canopy
// rides the falling top — this just maps a world hit Y to a 0..1 trunk fraction.)
export function snapPlan(fullHeight, hitY, baseY, minFrac = 0.08, maxFrac = 0.92) {
  const h = fullHeight > 1e-3 ? fullHeight : 1;
  let breakAt = (hitY - baseY) / h;
  if (breakAt < minFrac) breakAt = minFrac; else if (breakAt > maxFrac) breakAt = maxFrac;
  return { breakAt, remainFrac: breakAt };
}

// Seeded flat-fall decision: once a felled top settles, does it DETACH and lie FLAT on the ground (true)
// or stay PROPPED on its stump (false)? A high/precarious break (breakFrac > 0.38) would wobble on a thin
// stump top, so it stays propped far less often (10 %) than a low break (30 %). Drawn from the tree's fell
// seed so the host, every client, and late joiners reach the SAME outcome with no extra co-op event. PURE.
export function flatFalls(seed, breakFrac) {
  const propChance = breakFrac > 0.38 ? 0.10 : 0.30;
  return ((((seed >>> 0) * 2654435761) >>> 0) / 4294967296) >= propChance;
}

// Partition a NON-INDEXED triangle-soup geometry into bins along ONE LOCAL axis component, by each
// triangle's centroid. The companion to binFallenAABBs (which makes COLLISION boxes from WORLD verts);
// this makes per-segment GEOMETRY in the mesh's own LOCAL space, so the caller builds one Mesh per bin
// and parents them under the same node (rotation/normals handled by the engine). Used to chop a felled
// log's wood into individually-destructible chunks. PURE & node-testable.
//   pos = flat [x,y,z,…] non-indexed (3 verts per triangle, 9 floats); col/nor flat [r,g,b…]/[x,y,z…]
//   (optional, pass null to skip); uv flat [u,v…] (optional); comp = 0|1|2 axis to bin along (the log
//   length axis in local space — Y for a felled tree top); binLen = bin size; maxBins caps the count.
// Returns [{ positions, colors, normals, uvs, min:[x,y,z], max:[x,y,z] }] per non-empty bin, ordered
// low→high along comp (deterministic). Vertex count is conserved across the bins.
export function binFallenGeometry(pos, col, nor, uv, comp, binLen = 1.0, maxBins = 8) {
  const triN = (pos.length / 9) | 0;            // 3 verts × 3 floats per triangle
  if (triN < 1) return [];
  let lo = Infinity, hi = -Infinity;
  const cen = new Float64Array(triN);
  for (let t = 0; t < triN; t++) {
    const o = t * 9;
    const c = (pos[o + comp] + pos[o + 3 + comp] + pos[o + 6 + comp]) / 3;
    cen[t] = c; if (c < lo) lo = c; if (c > hi) hi = c;
  }
  const span = Math.max(1e-6, hi - lo);
  const nb = Math.max(1, Math.min(maxBins | 0, Math.ceil(span / binLen)));
  const inv = nb / span;
  const bins = new Array(nb).fill(null);
  const ensure = (i) => bins[i] || (bins[i] = {
    positions: [], colors: col ? [] : null, normals: nor ? [] : null, uvs: uv ? [] : null,
    min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity],
  });
  for (let t = 0; t < triN; t++) {
    let bi = Math.floor((cen[t] - lo) * inv); if (bi < 0) bi = 0; else if (bi >= nb) bi = nb - 1;
    const bb = ensure(bi), o = t * 9;
    for (let k = 0; k < 9; k++) bb.positions.push(pos[o + k]);
    if (col) for (let k = 0; k < 9; k++) bb.colors.push(col[o + k]);
    if (nor) for (let k = 0; k < 9; k++) bb.normals.push(nor[o + k]);
    if (uv) { const ou = t * 6; for (let k = 0; k < 6; k++) bb.uvs.push(uv[ou + k]); }
    for (let v = 0; v < 3; v++) { const p = o + v * 3; for (let a = 0; a < 3; a++) { const val = pos[p + a]; if (val < bb.min[a]) bb.min[a] = val; if (val > bb.max[a]) bb.max[a] = val; } }
  }
  const out = [];
  for (const bb of bins) if (bb) out.push(bb);
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// 4. Runtime apply* pipeline — WIRED for the demo building (see demobuilding.js / weapons.js).
//    DestructRuntime holds a parts collection + an `emit` event sink + an optional debris
//    pool, and exposes the four pipeline entry points the building combat path calls. Each
//    queries the parts collection and calls the resolve* rules above. Effects/MP-sync are
//    surfaced as events via `emit({type, ...})` so the owner decides how to render + broadcast
//    (host-auth, event+seed). (Forest props bypass this and call resolve* directly.)
// ───────────────────────────────────────────────────────────────────────────

// Normalize a gameplay weaponDef onto the { pen, dmg, blast, through, spall } shape the
// resolve* rules expect. Accepts either a CALIBERS-style def or a raw game weapon def.
function normWeapon(def) {
  if (!def) return { pen: 0, dmg: 0 };
  return {
    pen: def.pen ?? 0,
    dmg: def.structDmg ?? def.dmg ?? 0,
    blast: def.blast,
    through: def.through,
    spall: def.spall,
  };
}

export class DestructRuntime {
  // parts: iterable of part-metadata objects; emit: (event)=>void; debris: optional DebrisPool.
  constructor({ parts = [], emit = () => {}, debris = null } = {}) {
    this.parts = Array.from(parts);
    this.emit = emit;
    this.debris = debris;
  }
  addPart(part) { this.parts.push(part); return part; }
  removePart(part) { const i = this.parts.indexOf(part); if (i >= 0) this.parts.splice(i, 1); }
  _byId(id) { return this.parts.find(p => p.dpart === id); }

  // Hitscan bullet/pellet at a surface point. Resolves the part containing `point`.
  applyHit(point, normal, dir, weaponDef) {
    const w = normWeapon(weaponDef);
    // Pick the nearest still-alive destructible whose AABB contains the impact point.
    let part = null;
    for (const p of this.parts) {
      if (p.dead) continue;
      if (pointInAABB(point, p.min, p.max, 0.05)) { part = p; break; }
    }
    if (!part) return { effect: 'miss' };
    const r = resolveHit(part, w);
    if (r.effect === 'damage') {
      this.emit({ type: 'hit', dpart: part.dpart, dmat: part.dmat, point, killed: r.killed });
      if (r.killed) this._kill(part, point);
    } else {
      this.emit({ type: 'chip', dmat: part?.dmat, point, normal });   // cosmetic decal
    }
    return r;
  }

  // HE blast (bazooka / shell). `ammoDef.blast` preferred; else derived from `radius`.
  applyBlast(pos, radius, ammoDef) {
    const blast = (ammoDef && ammoDef.blast) ||
      { r1: radius * 0.45, r2: radius, tier: (ammoDef && ammoDef.blastTier) ?? 3 };
    const res = resolveBlast(this.parts, pos, blast);
    for (const id of res.killed) this._kill(this._byId(id), pos);
    for (const id of res.glass)  this._kill(this._byId(id), pos);
    this.emit({ type: 'blast', pos, ...res });
    return res;
  }

  // APFSDS long rod. Obliterates fragile parts on the ray, holes structural walls, spalls.
  applyPenetration(origin, dir, weaponDef) {
    const w = normWeapon(weaponDef);
    const res = resolvePenetration(this.parts, origin, dir, w);
    for (const h of res.hits) if (h.killed) this._kill(this._byId(h.id), h.entry);
    // Apply spall: fragile parts caught in a cone are destroyed (caller also hurts enemies).
    for (const cone of res.cones) {
      for (const id of cone.targets) {
        const p = this._byId(id);
        if (p && !p.dead) { p.dhp = 0; p.dead = true; this._kill(p, cone.apex); }
      }
    }
    this.emit({ type: 'penetration', origin, dir, ...res });
    return res;
  }

  // Vehicle crush at the RUNTIME (parts-only) level — pure resolveCrush + kill, no fallers/collision.
  // The building-level path with cave-in + collision + co-op is DemoBuilding.applyCrush (the one a
  // drivable vehicle would call). Dormant: no drivable vehicle wires either yet (tanks/cars are on
  // other branches), but the capability is live + tested. Returns { blocked, drag, crushed:[dpart] }.
  applyCrush(aabb, vehicleDef = {}) {
    const res = resolveCrush(this.parts, aabb, vehicleDef.crushTier ?? 3);
    if (!res.blocked) for (const id of res.crushed) { const p = this._byId(id); if (p && !p.dead) { p.dead = true; this._kill(p, aabbCenter(p.min, p.max)); } }
    this.emit({ type: 'crush', aabb, ...res });
    return { blocked: res.blocked, drag: res.drag, crushed: res.crushed };
  }

  _kill(part, at) {
    if (!part) return;
    const recipe = MATERIALS[part.dmat]?.debris;
    if (this.debris && recipe && at) this.debris.burst(recipe, at, (this._seed = (this._seed | 0) + 1));
    this.emit({ type: 'destroy', dpart: part.dpart, dmat: part.dmat, debris: recipe, at });
  }
}
