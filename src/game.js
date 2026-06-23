// game.js — ENGENDROS PURGE. Orchestrator + gameplay.
// A Zumbi-Blocks-style voxel FPS wave shooter: hold a dusty de_dust2-flavored
// arena against waves of "Engendros" voodoo-plush zombies. Big weapon roster
// (guns + melee), a bank-economy survival loop: scavenge pickups, unlock loadout gear in the SHOP, manage a flat 15-slot inventory.
import * as THREE from 'three';
import { TAU, randRange } from './util.js';
import { ENEMY_BURN_DUR, FIRE_BURN_TICK, FIRE_DOT_ENEMY, FIRE_POOL_LIFE, FIRE_POOL_MAX, FIRE_POOL_RADIUS, OCCLUSION_INSET, PLAYER_BURN_DUR, WAVE_BREATHER, WORLD_DAY_SEC, WORLD_START_MIN } from './tuning.js';
import { KILL_CASH } from './economy.js';
import { buildFlare, buildFlopo } from './props.js';
import { MountedGun, WeaponSystem, WEAPONS } from './weapons.js';
import { Player } from './player.js';
import { EnemyManager } from './enemies.js';
import { BuildManager, DayNight, World } from './world.js';
import { LootManager } from './loot.js';
import { Forest } from './forest.js';
import { installDemoBuilding } from './demobuilding.js';
import { ForestAtmosphere } from './forestatmos.js';
import { HitboxDebug } from './debughitbox.js';
import { ForestScene } from './forestscene.js';
import { installArenaClocks } from './arenaclocks.js';
import { FireManager } from './fire.js';
import { DigManager } from './dig-manager.js';
import { Inventory, Shop, LOADOUT_SLOTS } from './inventory.js';
import { WaveManager } from './waves.js';
import { HUD, Settings, UI, WeaponPreview } from './ui.js';
import { Admin } from './admin.js';
import { CrateCeremony, rollCrateReward } from './crate.js';
import { Fonoteka, GramophoneManager, ensureGramophoneSpec, placeGramophones } from './fonoteka.js';
import { PokerTable } from './poker-table.js';
import { PokerSceneRenderer } from './poker-scene.js';
import { MP } from './mp.js';
import { Engine } from './engine.js';
import { SimWorker } from './sim-worker-client.js';
import { Input } from './input.js';
import { AudioManager } from './audio.js';
import { Effects } from './effects.js';
import { registerModel } from './props/registry.js';
import { NightPost } from './nightpost.js';
import { Mortar } from './mortar.js';
import { HitchLogger } from './hitch.js';
import { installStress } from './stress.js';
import { bearingMils, rangeMeters, formatUglomer } from './bearing.js';
import { DevConsole } from './console.js';
import { makeClock } from './simclock.js';
import { makeWorldClock, MINUTES_PER_DAY, isNight } from './worldclock.js';
import { EFFECT_TPS, stepEffects } from './effects-status.js';

// Register modelgen prop specs (fire-and-forget; consumers keep a fallback mesh).
// Specs are authored in METRES — never compensate a wrong-sized spec with a
// scale factor at the call site (see tools/modelgen/lint.mjs).
const _registerModels = async () => {
  const load = async (id) => {
    try { registerModel(id, await (await fetch(`./models/${id}/spec.json?cb=${Date.now()}`)).json()); }
    catch (e) { console.warn(`[modelgen] Failed to register ${id}:`, e); }
  };
  await load('dshk-ammo-box');
  await load('supply-lootbox');     // «Посылка» lootbox crate (CrateCeremony falls back to a procedural chest if this fails)
  await load('electronika-clock');   // «Электроника 6.15М» digital desk clock (live VFD reads the world clock)
  await load('wallclock-chasozbor'); // «ЧАСОЗБОР» analog wall clock (demobuilding hangs it lazily once registered)
  await load('nnp23');              // ННП-23 «Резчик» night observation device (placed at the steppe strongpoint)
  await load('lpr1');               // ЛПР-1 «Каралон-М» laser rangefinder (hand tool; admin viewer + world prop)
  await load('mortar-82pm37');      // 82-ПМ-37 (БМ-37) co-op indirect-fire mortar (placed at the steppe strongpoint)
  await load('poker-table');        // round green-baize poker table — the hero prop of the 3D poker scene
  await load('poker-chip');         // composite "dice" poker chip (canonical model; in-game stacks mirror it per denom)
  await load('dealer-button');      // DEALER puck (canonical; in-scene D/SB/BB markers mirror it recoloured)
  // Forest deadwood + rock kit — scattered through the ?map=demo wood by forest.js (Forest._ensureProps).
  for (const id of [
    'rock_boulder_lg', 'rock_boulder_mossy', 'rock_cluster_sm', 'rock_outcrop',
    'log_fallen', 'log_pile', 'log_split', 'stump_cut', 'stump_shattered', 'debris_treetangle',
  ]) await load(id);
};
_registerModels();

// --- build identity (shown bottom-right in the co-op lobby) ---
// GAME_VERSION auto-tracks the ?v= cache-bust on this module's own URL, so it can't drift from
// the build the browser actually loaded. GAME_BUILD is the release time (local, to the minute) —
// bump it together with index.html's ?v= on every deploy.
const GAME_VERSION = (() => { try { const m = String(import.meta.url).match(/[?&]v=(\d+)/); return m ? 'v' + m[1] : 'dev'; } catch (e) { return 'dev'; } })();
const GAME_BUILD = '2026-06-23 23:06';

const FIXED_STEP = 1 / 60;              // fixed-timestep sim tick (60 Hz) when this._fixedStep is ON
const MAX_SUBSTEPS = 5;                 // spiral-of-death guard: cap sim sub-steps per render frame

const _flareWP = new THREE.Vector3();   // scratch: flare flame world-position (module-private, mirrors the copies in mp.js/loot.js; was dropped from game.js during the module split)

// HE blast profile for tier-3 rockets/HE (bazooka rocket, mortar shell): tier 3 removes brick wall
// segments within r1 (a WALKABLE breach), shatters all glass within r2, ignites + fells nearby trees.
const DEMO_HE_BLAST = { r1: 2.6, r2: 6.0, tier: 3 };

class Game {
  constructor() {
    this.canvas = document.getElementById('game');
    this.engine = new Engine(this.canvas);
    this.input = new Input(this.canvas);
    this.audio = new AudioManager();
    this.effects = new Effects(this);
    this.simWorker = new SimWorker(); // background thread for pure-math sim (horde flow-field; terrain in Phase B). Falls back to sync if unavailable.
    // Map selection. World reads game.mapId in its constructor, so this MUST precede `new World`.
    // Priority: ?map= URL override (dev) -> the menu's saved pick (localStorage) -> 'arena' default.
    this.mapId = (() => { try {
      const p = new URLSearchParams(location.search).get('map');
      if (p === 'steppe' || p === 'arena' || p === 'demo' || p === 'forest') return p; // 'demo' = dev testbed; 'forest' = playable forest map
      const saved = localStorage.getItem('engendros_map');
      return (saved === 'steppe' || saved === 'demo' || saved === 'forest') ? saved : 'arena';
    } catch (e) { return 'arena'; } })();
    // Dev fly-cam (noclip). `freecam` must exist before the first player.update below. ?fly=1 auto-enters on startGame.
    this.freecam = false;
    this.flyMode = false; // console /fly — same free movement as freecam, but the sim keeps running (mobs/waves stay alive)
    this._flyStart = (() => { try { return new URLSearchParams(location.search).get('fly') === '1'; } catch (e) { return false; } })();
    this.world = new World(this);
    this.player = new Player(this);
    this.enemies = new EnemyManager(this);
    this.rules = { god: false, doMobSpawning: true, sendCommandFeedback: true };  // «ПОЛИГОН» gamerules
    this.gameVersion = GAME_VERSION; this.gameBuild = GAME_BUILD; // surfaced on the instance for the F3 overlay
    this.devconsole = new DevConsole(this);
    this.f3 = false; this._fps = 0; this._frameMs = 0; // smoothed, fed each frame for the F3 readout
    this.dbgHitboxes = false; // F3+B collision-hitbox overlay toggle (see debughitbox.js)
    this.hitch = new HitchLogger(); installStress(this); // dev perf stress harness (GAME.stress) — never auto-runs
    this._stressName = null;
    this._drawDist = 0; this._showFps = false; this._fpsEl = null; this._culling = false;
    this._nextTagId = 1; // per-run id stamped onto each spawned enemy's e.tag (reset in reset())
    this.weapons = new WeaponSystem(this);
    this.loot = new LootManager(this);
    this.build = new BuildManager(this); // fortification placement (held builders, ghost preview, structures)
    // ?map=forest: build the WHOLE scene from the standalone-demo's real destructible assets — demo
    // split-fell trees (ForestDemo) + the buildgen cottage with the falling sign + crates + colonnade
    // (ForestScene). The scene stands in as game.forest (trees) + game.world.demoBuilding (a facade that
    // fans HE/APFSDS to every building). ?map=demo + flat maps keep the game's own forest + guard-post.
    if (this.mapId === 'forest') {
      this.forestScene = new ForestScene(this);
      this.forest = this.forestScene.trees;
      this.world.demoBuilding = this.demoBuilding = this.forestScene;
    } else {
      this.forest = new Forest(this); // ?map=demo forest kit: destructible/flammable trees + groundcover (no-op on flat maps)
      // Phase 7: destructible building. Constructs AFTER forest so it can clearArea() its footprint.
      // Phase 9 wires live fire via world.rayHit() → box.downer===building → building.apply*(...).
      this.demoBuilding = installDemoBuilding(this); // no-op on flat maps (arena/steppe untouched)
    }
    this.forestAtmos = (this.mapId === 'forest') ? new ForestAtmosphere(this.engine.scene) : null; // ?map=forest pollen + fireflies
    this.arenaClocks = installArenaClocks(this);   // arena-only: a stand of both live clocks by the spawn
    this.fire = new FireManager(this); // Phase 8: fire SPREAD (molotov→trees↔grass, dies at stone, chars→snaps). Inert on flat maps.
    this.hitboxDebug = new HitboxDebug(this.engine.scene); // F3+B collision-hitbox overlay (Minecraft-style, dev)
    // Terrain excavation: shovel pits + explosion craters, with gravity-collapse of undermined
    // walls/trees/props. Wires its DeformField into world.terrain; harmless on maps without terrain
    // (empty field fast-returns 0). MUST follow forest/build/demoBuilding (its SupportScan reads them).
    this.digManager = new DigManager(this);
    const m2Pos = new THREE.Vector3(0, 3.4, 46);     // south bunker roof
    const dshkPos = new THREE.Vector3(42, 6.8, 30);  // warehouse roof
    const dshkYaw = Math.atan2(dshkPos.x, dshkPos.z);
    this.m2MountedGun = new MountedGun(this, m2Pos, 0, { variant: 'm2hb', id: 'm2hb' });
    this.dshkMountedGun = new MountedGun(this, dshkPos, dshkYaw, { variant: 'dshk', id: 'dshk' });
    this.mountedGuns = [this.m2MountedGun, this.dshkMountedGun];
    this.mountedGun = this.m2MountedGun; // compatibility alias for older .50-cal code paths; direct interactions use mountedGuns
    // ННП-23 «Резчик» observation post(s) — steppe: dug in beside the strongpoint НП tower,
    // objective laid ~N over the open steppe. Built lazily once the nnp23 spec registers.
    this.nightPosts = [];
    if (this.mapId === 'steppe') this.nightPosts.push(new NightPost(this, -321.5, -296.5, 0.1));
    // 82-ПМ-37 co-op mortar — fixed indirect-fire pit in the strongpoint's SW rear defilade (clear of
    // colliders + the НП/nightpost cluster). baseYaw 0 lays grid-N over the position into the steppe;
    // Y resolved from terrain in ensureBuilt.
    this.mortars = [];
    if (this.mapId === 'steppe') this.mortars.push(new Mortar(this, new THREE.Vector3(-335, 0, -308), 0));
    this.waves = new WaveManager(this);
    this.hud = new HUD(this);
    this.inventory = new Inventory(this); // survival backpack + unified held-item model
    this.shop = new Shop(this);
    const _pc = document.getElementById('previewCanvas'); this.preview = _pc ? new WeaponPreview(_pc) : null;
    this.ui = new UI();
    const _ac = document.getElementById('adminCanvas'); this.admin = _ac ? new Admin(this) : null;
    const _cc = document.getElementById('crateCanvas'); // «Посылка» lootbox ceremony (own renderer, gated on state==='crate')
    try { this.crate = _cc ? new CrateCeremony(this) : null; } catch (e) { console.warn('[crate] ceremony init failed — crates disabled', e); this.crate = null; } // a WebGL/context failure must not brick boot (openCrate guards null)
    this.fonoteka = new Fonoteka(this); ensureGramophoneSpec(); // ФОНОТЕКА music screen + preload the gramophone model
    this.gramophone = new GramophoneManager(this); placeGramophones(this.gramophone, this.engine.scene, this.mapId); // in-world gramophone props (genre per prop, E + ◀/▶)
    this.poker = new PokerTable(this); // secret poker den — Texas Hold'em (renderer mounts lazily on first open)
    // inject the 3D table renderer (THREE) here so poker-table.js stays node-testable; ?poker2d=1 keeps the 2D fallback
    if (!/[?&]poker2d=1/.test(location.search)) this.poker.RendererClass = PokerSceneRenderer;
    this.settings = new Settings(this); // loads localStorage + applies sens/volume/sharpness/fov
    this.meta = this._loadMeta(); // persistent best-wave / lifetime stats
    this.dayNight = new DayNight(this); // day/night + sky + flashlight (drives THE LONG NIGHT)
    this.mp = new MP(this); // multiplayer co-op (dormant until host/join)
    this.mode = 'purge'; this.flares = []; this.molotovPools = []; this._surviveTime = 0;
    this._molTmp = new THREE.Vector3(); this._molTmp2 = new THREE.Vector3(); this._molTmp3 = new THREE.Vector3();

    this.state = 'menu'; this.score = 0; this.kills = 0; this.mpMenuOpen = false;
    this._intentionalUnlock = false; this._waveBreak = 0; this._startCountdown = 0;
    this._last = 0; this._bound = this._frame.bind(this);
    this._fixedStep = (() => { try { return new URLSearchParams(location.search).get('fixed') === '1'; } catch (e) { return false; } })(); // M4 fixed-timestep: ?fixed=1 URL opt-in or F8 toggle (default OFF)
    this._acc = 0; this._camPrev = new THREE.Vector3(); this._camCur = new THREE.Vector3(); // render-time camera interpolation state

    // --- status effects (src/effects-status.js) ---
    this._fxClock = makeClock({ step: 1 / EFFECT_TPS, maxDt: 0.05 });   // 10 ticks/s, same primitive as fire.js
    this._stepFx = () => this._stepEffectsOnce();                       // stable callback for clock.advance
    // world clock (src/worldclock.js): the always-running day/night time. Host/solo advances the truth + fires
    // timed day/night transitions; clients predict locally and reconcile to the host's 'night' push.
    this._worldClock = makeWorldClock({ stepSec: WORLD_DAY_SEC / MINUTES_PER_DAY, startMinute: WORLD_START_MIN });
    this._stepMinute = (total) => { if (!this.mp.active || this.mp.isHost) this.dayNight.onWorldMinute(total); };
    this._fxCtx = {                                                     // injected side-effect ops (keeps effects-status.js pure)
      isEnemy: (t) => t !== this.player,                               // player-kind handler for the local player; enemy-kind for everything else
      hurtPlayer: (p, dmg) => p._takeSurvivalDamage(dmg, 1),           // bypassArmor=1 in solo; in MP routes claimPlayerHit→hostHurt, which applies armor (bypass NOT forwarded)
      healEnemy: (e, n) => this.enemies.heal(e, n),
      fireFx: (e) => this.effects.firePool(e.pos, 0.45, 0.4),
      drip: (e) => this.effects.stuffing(e.pos, e.col ? e.col.body : 0xeeeeee, 3, 2),  // «пух» puff
      setLimp: (entity, on) => { if (entity === this.player) { this.player.legBroken = on; this.hud.setSurvival(this.player); } },
    };

    this._wireUI(); this._wireInput(); this._showMenuBest(); this._wireMapPick(); this._maybeAutoRejoin();
    this.player.update(0.0001); this.engine.render();
    requestAnimationFrame((t) => { this._last = t; requestAnimationFrame(this._bound); });
  }

  // Main-menu map picker (Arena/Steppe). The world is built once at boot from this.mapId,
  // so switching maps persists the choice to localStorage and reloads to a clean world.
  _wireMapPick() {
    const NOTES = {
      arena: 'de_dust2 arena — the classic wave-defence map.',
      steppe: 'Soviet steppe — airfield, kombinát, проходная, field base + POIs.',
      demo: 'ПОЛИГОН — destruction demo: walkable hills, forest, destructible building & spreading fire. Bazooka/molotov/APFSDS in hand. (single-player slice)',
      forest: 'ЛЕС — wooded battleground: hilly terrain, dense forest kit, destructible building, green mist + fireflies. Full waves.',
    };
    const tabs = Array.from(document.querySelectorAll('#map-pick .tab'));
    const note = document.getElementById('map-note');
    const sync = () => { tabs.forEach((t) => t.classList.toggle('on', t.dataset.map === this.mapId)); if (note) note.textContent = NOTES[this.mapId] || ''; };
    tabs.forEach((t) => t.addEventListener('click', () => {
      const m = t.dataset.map; if (!m || m === this.mapId) return;
      try { localStorage.setItem('engendros_map', m); } catch (e) {}
      location.href = location.pathname;
    }));
    sync();
  }

  // After a host-driven co-op map switch, reload onto the host's map and resume joining.
  _maybeAutoRejoin() {
    let info = null;
    try { info = JSON.parse(sessionStorage.getItem('engendros_autojoin') || 'null'); sessionStorage.removeItem('engendros_autojoin'); } catch (e) {}
    if (!info || !info.code) return;
    setTimeout(() => {
      try {
        this.toLobby();
        if (info.lan && this.mp.toggleLanMode && this.mp._lanMode && !this.mp._lanMode()) this.mp.toggleLanMode();
        if (info.skin != null) this.mp.chosenSkin = info.skin;
        const nameEl = document.getElementById('mp-name'); if (nameEl) nameEl.value = info.name || 'Player';
        const codeEl = document.getElementById('mp-code'); if (codeEl) codeEl.value = info.code;
        this.mp.startJoin(info.code, info.name || 'Player');
        if (this.hud && this.hud.toast) this.hud.toast('Rejoining host on the new map...', 0x6fd0e8);
      } catch (e) {}
    }, 900);
  }

  _wireUI() {
    const click = (id, fn) => { const e = document.getElementById(id); if (e) e.addEventListener('click', fn); };
    // build version + release time (to the minute), shown in both the main menu and the co-op lobby corner
    const verHTML = `ENGENDROS PURGE <b>${GAME_VERSION}</b> (${GAME_BUILD})`;
    for (const id of ['lobby-version', 'menu-version']) { const e = document.getElementById(id); if (e) e.innerHTML = verHTML; }
    click('enterBtn', () => this.ui.show('play'));        // hero art screen → deployment screen
    click('playBackBtn', () => this.ui.show('menu'));      // deployment → back to the hero
    click('playBtn', () => this.startGame('purge'));
    click('longNightBtn', () => this.startGame('longnight'));
    click('resumeBtn', () => this.resume());
    click('quitBtn', () => this.toMenu());
    click('menuBtn', () => this.toMenu());
    click('restartBtn', () => this.startGame(this.mode)); // try again in the same mode
    click('nextWaveBtn', () => this.beginNextWave());
    click('settingsBtn', () => this.settings.open('menu'));
    click('adminBtn', () => this.openAdmin());
    click('fonoteka-menu-btn', () => this.openFonoteka('menu'));
    click('fonoteka-lobby-btn', () => this.openFonoteka('lobby'));
    click('adminBack', () => this.toMenu());
    click('multiplayerBtn', () => this.toLobby());
    click('armoryBtn', () => this.shop.open('menu'));
    click('lobbyArmoryBtn', () => this.shop.open('lobby'));
    click('pokerBtn', () => this.openPoker('menu'));
    click('lobbyPokerBtn', () => this.openCoopPoker());
    click('armoryBackBtn', () => { if (this.shop.returnTo === 'lobby') this.toLobby(); else this.toMenu(); });
    click('mpHostBtn', () => this.mp.startHost((document.getElementById('mp-name') || {}).value || 'Host'));
    click('mpJoinBtn', () => this.mp.startJoin((document.getElementById('mp-code') || {}).value || '', (document.getElementById('mp-name') || {}).value || 'Player'));
    click('mpCloseRoomBtn', () => this.mp.closeRoom());
    click('mpCopyCodeBtn', async () => {
      const code = ((document.getElementById('mp-mycode') || {}).textContent || '').trim();
      if (!code || code === '-----') return;
      const ok = await this._copyText(code);
      this.mp._setLobbyDiag(ok ? 'Room code copied.' : 'Copy failed. Select the room code and copy it manually.');
      if (this.hud && this.hud.toast) this.hud.toast(ok ? 'Room code copied' : 'Copy failed', ok ? 0x7fd06a : 0xd23a2a);
    });
    click('mpStartBtn', () => this.mp.hostStart());
    click('mpReadyBtn', () => this.mp.toggleReady());
    click('mpLanBtn', () => this.mp.toggleLanMode());
    click('mpRelayBtn', () => this.mp.toggleRelayMode());
    click('mp-mode-purge', () => this.mp.setMode('purge'));
    click('mp-mode-night', () => this.mp.setMode('longnight'));
    click('mp-mode-poker', () => this.mp.setMode('poker'));
    click('mpBackBtn', () => { this.mp.leave(); this.toMenu(); });
    document.querySelectorAll('.mp-skinpick').forEach(b => b.addEventListener('click', () => {
      this.mp.chosenSkin = +b.dataset.skin;
      document.querySelectorAll('.mp-skinpick').forEach(x => x.classList.toggle('sel', x === b));
    }));
    click('pauseSettingsBtn', () => this.settings.open('pause'));
    this.canvas.addEventListener('click', () => {
      if (this.devconsole && this.devconsole.open) return; // chat open: keep the cursor free for clicking in the input — never re-grab pointer-lock
      if (this.state === 'menu' || this.state === 'dead' || this.state === 'shop' || this.state === 'admin' || this.state === 'music' || this.state === 'crate' || this.state === 'poker') return;
      if (this.state === 'paused') this.resume(); else this.input.requestLock();
    });
    this.input.on('lock', () => { if (this.mpMenuOpen) this._closeMpMenu(false); else if (this.state === 'paused') { this.state = 'playing'; this.ui.hideAll(); } });
    this.input.on('unlock', () => { if (this._intentionalUnlock) { this._intentionalUnlock = false; return; } if (this._invOpen) { this._closeInventory(); return; } if (this.state === 'playing') this.pause(); });
    document.addEventListener('fullscreenchange', () => this.engine.resize());
  }

  async _copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {}
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  _wireInput() {
    this.input.on('key', (code, ev) => {
      // Esc toggles pause/resume in a live run. Under Keyboard Lock (Chromium fullscreen) the tapped Esc is
      // delivered here without dropping fullscreen, so we drive BOTH pause and resume from it. Handled before
      // the state/console guards so it also works while paused — but we never steal the dev-console's own Esc.
      // (On FF/Safari Esc additionally releases pointer-lock and the 'unlock' handler pauses as a fallback.)
      if (code === 'Escape' && !(this.devconsole && this.devconsole.open) && (this.state === 'playing' || this.state === 'paused')) {
        if (ev) ev.preventDefault();
        if (this.state === 'paused' || this.mpMenuOpen) this.resume(); else this.pause();
        return;
      }
      if (this.state !== 'playing') return;
      if (this.devconsole && this.devconsole.open) return; // console eats input while open
      // at the ННП-23 eyepieces: E leave · T day/night branch · F fullscreen · M mute; swallow the
      // rest (must run BEFORE console-open so T toggles the branch instead of opening the console)
      if (this.player.nightPost) {
        if (code === 'KeyE') this.player.nightPost.exit();
        else if (code === 'KeyT') this.player.nightPost.toggleBranch();
        else if (code === 'KeyF') this.toggleFullscreen();
        else if (code === 'KeyM') { this.audio.setMuted(!this.audio.muted); this.hud.bigMessage(this.audio.muted ? 'MUTED' : 'SOUND ON'); }
        return;
      }
      // manning the mortar: E leave · F fullscreen · M mute; swallow the rest (W/S/A/D/Shift held-lay
      // + LMB fire are read in Mortar.controlUpdate via input.down, so they don't route through here)
      if (this.player.mortar) {
        if (code === 'KeyE') this.player.mortar.dismount();
        else if (code === 'KeyF') this.toggleFullscreen();
        else if (code === 'KeyM') { this.audio.setMuted(!this.audio.muted); this.hud.bigMessage(this.audio.muted ? 'MUTED' : 'SOUND ON'); }
        return;
      }
      // ЛПР-1 raised to the eyes: T fires a ranging pulse — must run BEFORE console-open (same pattern as the ННП-23 branch toggle above)
      if (code === 'KeyT' && this.weapons.lprRaised) { this.weapons.lprMeasure(); return; }
      if (code === 'Backquote' || code === 'KeyT' || code === 'Slash') { if (ev) ev.preventDefault(); this.devconsole.openConsole(code === 'Slash' ? '/' : ''); return; } // preventDefault so the opening key itself isn't typed into the freshly-focused input // T / ` open chat empty; / pre-fills the slash (Minecraft)
      if (code === 'F3') { this.f3 = !this.f3; return; }
      if (code === 'F8') { this._fixedStep = !this._fixedStep; this._acc = 0; const _fs = this._fixedStep; this.hud.bigMessage('FIXED-STEP ' + (_fs ? 'ON · 60Hz' : 'OFF')); console.log('[fixed-step] ' + (_fs ? 'ON (60 Hz sim + camera interp)' : 'OFF (variable dt)')); return; } // M4 dev toggle (mirrors ?fixed=1)
      if (code === 'KeyD' && this.input.isDown('F3')) { this.devconsole.clearLog(); this.f3 = !this.f3; return; } // F3+D clears the console scrollback (Minecraft); toggle back so the combo doesn't flip the overlay
      if (code === 'KeyB' && this.input.isDown('F3')) { this.dbgHitboxes = !this.dbgHitboxes; this.f3 = !this.f3; this.hud.bigMessage('HITBOXY ' + (this.dbgHitboxes ? 'ON' : 'OFF')); return; } // F3+B toggles the collision-hitbox overlay (Minecraft); toggle f3 back so the chord doesn't flip the text overlay (and B doesn't change fire-mode)
      // dev fly-cam toggle (solo only): N, or Ctrl+F
      if (!(this.mp && this.mp.active) && (code === 'KeyN' || (code === 'KeyF' && (this.input.isDown('ControlLeft') || this.input.isDown('ControlRight'))))) { this.toggleFreecam(); return; }
      if (this.mpMenuOpen) {
        if (code === 'KeyF') this.toggleFullscreen();
        else if (code === 'KeyM') { this.audio.setMuted(!this.audio.muted); this.hud.bigMessage(this.audio.muted ? 'MUTED' : 'SOUND ON'); }
        return;
      }
      if (this.mp.active && this.mp._localDead) {
        if (code === 'KeyQ') this.mp.cycleSpectate(-1);
        else if (code === 'KeyE') this.mp.cycleSpectate(1);
        else if (code === 'KeyF') this.toggleFullscreen();
        else if (code === 'KeyM') { this.audio.setMuted(!this.audio.muted); this.hud.bigMessage(this.audio.muted ? 'MUTED' : 'SOUND ON'); }
        return;
      }
      if (this.weapons.isThrowLocked() && code !== 'KeyM') return; // committed molotov: only the LMB throw (and mute) work
      if (this.mp.active && this.mp.frozen) return; // downed/dead/waiting: no reload/melee/mount/board/loot/weapon-switch
      if (this.player.mountedGun && code !== 'KeyE' && code !== 'KeyF' && code !== 'KeyM') return; // on the mounted gun: only dismount / fullscreen / mute — no weapon or inventory switching
      if (code === 'KeyR') this.weapons.startReload();
      else if (code === 'KeyV') this.weapons.quickMelee();
      else if (code === 'KeyE') {
        if (this.mp.active && this.mp.tryStartRevive && this.mp.tryStartRevive()) return;
        // ---- fixed heavy MG + loot ----
        if (this.player.mountedGun) this.player.mountedGun.dismount();
        else if (this.inventory.tryReloadFiftyCan()) { /* reloaded the mounted heavy MG from a carried ammo can */ }
        else {
          const gun = this.nearestMountedGun(this.player.pos, (g) => g.canMount(this.player.pos));
          if (gun) gun.mount();
          else if (this.nearestNightPost()) { this.nearestNightPost().enter(); } // ННП-23: step up to the eyepieces
          else if (this.nearestMortar()) { this.nearestMortar().mount(); } // 82-ПМ-37: man the indirect-fire station
          else if (this.world.gateTarget) { this.world.toggleGate(this); } // booth console: open/close the works gate
          else if (this.world.doorTarget) { this.world.toggleDoor(this, this.world.doorTarget); } // bunker гермодверь: swing open/closed
          else if (this.build.radioTarget) { this.build.toggleRadio(this.build.radioTarget); }
          else if (this.gramophone.target) { this.gramophone.toggle(this.gramophone.target); }
          else if (this.loot.tryPickupNearby()) { /* grabbed a ground item into the backpack */ }
          else if (this.loot.openNearby()) { /* claimed a landed supply drop */ }
          else if (this.inventory.isHoldingFlashlight()) this.dayNight.toggleFlashlight(); // nothing nearby to interact with → toggle the held flashlight beam
        }
      }
      else if (code === 'KeyF') this.toggleFullscreen();
      else if (code === 'KeyB') this.weapons.toggleFireMode();
      else if (code === 'KeyG') { const c = this.inventory.curItem(); if (c) this.inventory.dropSlot(c.slot); }
      else if (code === 'KeyI') this.toggleInventory();
      else if (code === 'KeyC') this.tryMortarSpot(); // spotter: range+bearing call to the mortar (+ shared marker)
      else if (code === 'KeyM') { this.audio.setMuted(!this.audio.muted); this.hud.bigMessage(this.audio.muted ? 'MUTED' : 'SOUND ON'); }
      else if (code.startsWith('Digit')) { const n = parseInt(code.slice(5), 10); if (n >= 1 && n <= 9) this.inventory.selectSlotN(n); }
    });

    // Prime Web Audio on the first user gesture so menu/lobby/shop music can start
    // (browsers block audio until a gesture). One-shot; safe if already inited.
    const _primeMusic = () => {
      window.removeEventListener('pointerdown', _primeMusic); window.removeEventListener('keydown', _primeMusic);
      this.audio.init();
      if (this.state === 'menu' && this.audio.music) this.audio.music.setPlaylist('soviet'); // menu + co-op lobby share the shuffled jukebox
    };
    window.addEventListener('pointerdown', _primeMusic); window.addEventListener('keydown', _primeMusic);
  }

  startGame(mode = 'purge') {
    this.mode = mode === 'longnight' ? 'longnight' : 'purge';
    this.audio.init(); this.audio.music.setScene('gameplay');
    this._intentionalUnlock = false;
    this._setUnloadGuard(true); // arm the "leave site?" net for the whole run
    this.reset();
    this.ui.hideAll(); this.hud.show(true); this.ui.hint.style.display = 'none';
    this.state = 'playing'; this._startCountdown = 0.6;
    this.enemies.prewarm(); // pre-pay buildTolo() + boss-FX shader programs now (run-start), not mid-fight
    this.freecam = !!this._flyStart; // ?fly=1 → boot straight into the fly-cam (no enemies until you press N)
    if (this.freecam) this.hud.bigMessage('🚁 FREECAM', 'WASD fly · Space up · Ctrl/C down · Shift boost · N toggle');
    // Go real-fullscreen on this user gesture, then resize, grab the pointer & lock the keyboard.
    const root = document.documentElement;
    const after = () => { this.engine.resize(); this.input.requestLock(); this._lockKeyboard(); };
    if (!document.fullscreenElement && root.requestFullscreen) root.requestFullscreen().then(after, after);
    else after();
  }

  toggleFullscreen() {
    if (document.fullscreenElement) { if (document.exitFullscreen) document.exitFullscreen(); }
    else { const r = document.documentElement; if (r.requestFullscreen) r.requestFullscreen().then(() => this.engine.resize(), () => {}); }
  }
  // Dev fly-cam toggle (solo only). On: dismount, clear enemies, suspend spawns (see the `sim` gate in
  // _updatePlaying) and fly noclip/invulnerable. Off: drop velocity and let waves resume.
  toggleFreecam() {
    if (this.mp && this.mp.active) { this.hud.bigMessage('FREECAM', 'solo only'); return; }
    if (this.state !== 'playing') return;
    this.freecam = !this.freecam;
    if (this.freecam) {
      if (this.player.mountedGun) this.player.mountedGun.dismount();
      if (this.player.nightPost) this.player.nightPost.exit();
      this.weapons.cancelMolotov();
      this.enemies.clearAll(); // clean, empty map to inspect
      this.hud.bigMessage('🚁 FREECAM', 'WASD fly · Space up · Ctrl/C down · Shift boost · N exit');
    } else {
      this.player.vel.set(0, 0, 0);
      if (!this.waves.active && this._waveBreak <= 0 && this._startCountdown <= 0) this._waveBreak = 0.8; // kick spawns back on
      this.hud.bigMessage('FREECAM OFF', 'normal play resumed');
    }
  }

  _mountedGunList() {
    return (Array.isArray(this.mountedGuns) && this.mountedGuns.length) ? this.mountedGuns : (this.mountedGun ? [this.mountedGun] : []);
  }
  mountedGunById(id) {
    const key = id || (this.mountedGun && this.mountedGun.id);
    return this._mountedGunList().find((gun) => gun && gun.id === key) || this.mountedGun || null;
  }
  nearestNightPost() {
    // the ННП-23 the player can step up to (built + close); not while seated anywhere else
    if (this.player.mountedGun || this.player.nightPost) return null;
    for (const np of this.nightPosts) if (np.near(this.player.pos)) return np;
    return null;
  }
  nearestMortar() {
    // the mortar the player can man (built + close + free + has mines); not while seated elsewhere
    if (this.player.mountedGun || this.player.nightPost || this.player.mortar) return null;
    for (const m of this.mortars) if (m.canMount(this.player.pos)) return m;
    return null;
  }
  // Spotter (v1 minimal): march the look-ray to the ground → range+bearing FROM THE MORTAR to that
  // point (the firing solution the gunner must dial), shown to the spotter + a shared marker. ЛПР-1
  // will later replace the look-ray with a real lased target; the {range,bearing} contract is the same.
  tryMortarSpot() {
    if (this.state !== 'playing' || this.player.mortar) return;
    const m = this.mortars && this.mortars[0];
    if (!m || !m.root) return;
    const cam = this.engine.camera;
    const o = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const d = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
    let hit = null;
    for (let t = 2; t < 700; t += 1.5) {
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      const g = m._groundY(x, z);
      if (y <= g) { hit = { x, y: g, z }; break; }
    }
    if (!hit) return;
    const mp = this.mp;
    if (!mp || !mp.active) {
      this._dropMortarMark({ p: [hit.x, hit.y, hit.z], rng: Math.round(rangeMeters(m.base, hit)), mils: formatUglomer(bearingMils(m.base, hit)) });
    } else mp.net.send('mortarspot', { p: [+hit.x.toFixed(2), +hit.z.toFixed(2)] });
  }
  // Drop the shared world beacon + show the spotter call. Host broadcasts this to everyone.
  _dropMortarMark(d) {
    const [x, y, z] = d.p;
    if (this._mortarMark) { this.engine.scene.remove(this._mortarMark); this._mortarMark.geometry.dispose(); this._mortarMark.material.dispose(); }
    const geo = new THREE.CylinderGeometry(0.16, 0.16, 9, 6, 1, true);
    const beacon = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffcc33, transparent: true, opacity: 0.75, side: THREE.DoubleSide }));
    beacon.position.set(x, y + 4.5, z);
    this.engine.scene.add(beacon);
    this._mortarMark = beacon; this._mortarMarkT = 14;
    if (this.hud.setSpotCall) this.hud.setSpotCall(`TARGET · RNG ${d.rng}m · ${d.mils}`);
  }
  nearestMountedGun(pos, predicate = null) {
    let best = null, bestD = Infinity;
    for (const gun of this._mountedGunList()) {
      if (!gun) continue;
      if (predicate && !predicate(gun)) continue;
      const d = Math.hypot(pos.x - gun.base.x, pos.z - gun.base.z);
      if (d < bestD) { best = gun; bestD = d; }
    }
    return best;
  }
  resetMountedGuns() {
    for (const gun of this._mountedGunList()) if (gun && typeof gun.forceReset === 'function') gun.forceReset();
  }

  reset() {
    if (this.devconsole && this.devconsole.open) this.devconsole.close();
    if (this._invOpen) { this._invOpen = false; if (this.hud) this.hud.closeInventory(); }
    this.player.reset();
    this.enemies.clearAll(); this.loot.reset();
    this._nextTagId = 1; // new run → enemy tag ids restart at 1
    this.resetMountedGuns();
    for (const np of this.nightPosts) np.forceReset();
    for (const m of this.mortars) m.forceReset(); // step away from the ННП-23 (restores lights/FOV/overlay)
    if (this.hud) this.hud.setCompass(null); // body-level overlay — hud.show(false) won't hide it; clear on run reset
    this.world.clearWrecks && this.world.clearWrecks();
    this.build.reset();
    this.inventory.reset(); // clear backpack BEFORE resetLoadout (which deploys throwable start-stock into it)
    this.weapons.resetLoadout();
    this.waves.reset();
    this._clearFlares();
    if (this._clearMolotovPools) this._clearMolotovPools();
    if (this.fire) this.fire.clear();
    this._worldClock.setTotal(WORLD_START_MIN); // fresh run → world starts at 08:00 (the clock is the source of time)
    this.dayNight.reset();                       // sky reflects the seeded clock immediately
    this._surviveTime = 0;
    this.score = 0; this.kills = 0;
    this.hud.setHealth(this.player.hp, this.player.maxHp);
    this.hud.setArmor(this.player.armor, this.player.armorMax);
    this.hud.setMoney(this.player.money); this.hud.setRadios(this.player.radios);
    this.hud.setHunger(this.player.hunger); this.hud.setSurvival(this.player);
    this.hud.setScore(0); this.hud.setWeapon(this.weapons);
    this.hud.setNightMode(true); // the world clock runs in every mode → always show the HH:MM clock + night gear
    this._startCountdown = 0.6; this._waveBreak = 0; this._banked = false; // _banked: per-run guard for bank deposit
  }
  _disposeFlare(f) {
    this.engine.scene.remove(f.mesh); this.engine.releaseFxLight(f.lightH);
    f.mesh.geometry.dispose(); f.mesh.material.dispose();
    if (f.flame) { f.flame.geometry.dispose(); f.flame.material.dispose(); }
  }
  _clearFlares() {
    for (const f of this.flares) this._disposeFlare(f);
    this.flares.length = 0;
  }
  throwFlare(force) {
    if ((!force && this.mode !== 'longnight') || this.weapons.flares <= 0) return;
    this.weapons.flares--; this.hud.setNightGear(this);
    const cam = this.engine.camera; cam.updateMatrixWorld();
    const origin = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const mesh = buildFlare();
    mesh.position.copy(origin).addScaledVector(fwd, 0.8);
    mesh.rotation.set(randRange(0, TAU), randRange(0, TAU), randRange(0, TAU));
    // burning flame nub at the cap end (local +Y), additive glow
    const flame = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffd14a, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    flame.position.set(0, 0.34, 0); flame.renderOrder = 998; mesh.add(flame);
    const lh = this.engine.acquireFxLight(0xff5a26, 18, 28, 1.2); // starts hot → eases down; borrowed from the fixed FX pool (no scene.add → no shader recompile)
    const light = lh.light; light.position.copy(mesh.position);
    this.engine.scene.add(mesh);
    this.effects.muzzleFlash(mesh.position.clone(), fwd, 0.6); // small ignite flash
    this.flares.push({ mesh, light, lightH: lh, flame, flameMat: flame.material,
      vel: fwd.clone().multiplyScalar(15).add(new THREE.Vector3(0, 4.5, 0)),
      spin: new THREE.Vector3(randRange(-7, 7), randRange(-4, 4), randRange(-7, 7)),
      life: 22, grounded: false, out: false, smokeT: 0 });
    // keep spent sticks on the ground, but cap how many linger
    const spent = this.flares.filter((x) => x.out);
    while (spent.length > 6) { const old = spent.shift(); this._disposeFlare(old); this.flares.splice(this.flares.indexOf(old), 1); }
    this.audio.uiClick();
  }
  _updateFlares(dt) {
    if (!this.flares.length) return;
    const t = performance.now() * 0.001;   // mode-independent clock for flicker (matches _updateMolotovPools); _surviveTime only advances in longnight, freezing the flame in purge
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i];
      if (!f.grounded) {
        f.vel.y -= 20 * dt; f.mesh.position.addScaledVector(f.vel, dt);
        f.mesh.rotation.x += f.spin.x * dt; f.mesh.rotation.y += f.spin.y * dt; f.mesh.rotation.z += f.spin.z * dt;
        const fgy = this.world.groundY(f.mesh.position.x, f.mesh.position.z);   // settle on the terrain surface (groundY≡0 on flat maps)
        if (f.mesh.position.y <= fgy + 0.06) { f.mesh.position.y = fgy + 0.06; f.grounded = true; f.vel.set(0, 0, 0); f.mesh.rotation.set(Math.PI / 2, f.mesh.rotation.y, 0); } // settle lying down
      }
      if (f.out) continue;                               // spent: just a dark stick on the ground
      f.life -= dt;
      f.flame.getWorldPosition(_flareWP); f.light.position.copy(_flareWP);
      const fade = f.life < 3.5 ? Math.max(0, f.life / 3.5) : 1;          // gradual burn-out over the last 3.5s
      const flick = 0.82 + Math.sin(t * 22 + i) * 0.12 + Math.sin(t * 57 + i) * 0.05;
      f.light.intensity += (9 * fade * flick - f.light.intensity) * Math.min(1, dt * 6); // eases the ignite spike down, then fades out
      f.light.color.setHSL(0.035, 1, 0.5 + 0.05 * Math.sin(t * 30 + i));
      f.flame.scale.setScalar((0.8 + Math.sin(t * 26 + i) * 0.2) * (0.35 + 0.65 * fade));
      f.flameMat.opacity = 0.95 * fade;
      f.smokeT -= dt;
      if (f.smokeT <= 0) { f.smokeT = 0.07; this.effects.flareSmoke(_flareWP.clone().setY(_flareWP.y + 0.05), fade); }
      if (f.life <= 0) { f.out = true; this.engine.releaseFxLight(f.lightH); f.flame.visible = false; }
    }
  }
  // Line-of-sight test so molotov fire cannot reach through a wall into the next room.
  raySegBlocked(from, to) {
    const dir = this._molTmp3.copy(to).sub(from); const dist = dir.length();
    if (dist < 0.9) return false; dir.multiplyScalar(1 / dist);
    const start = from.clone().addScaledVector(dir, OCCLUSION_INSET);
    return this.world.rayHit(start, dir, dist - OCCLUSION_INSET * 2) !== null;
  }
  // Console hook (?map=demo): fire an APFSDS long-rod straight out of the camera. Lets a
  // tester demonstrate penetration through-holes + spall without scrolling to the cannon slot.
  // Usage: GAME.demoFireAPFSDS()
  demoFireAPFSDS() {
    const cam = this.engine.camera; cam.updateMatrixWorld();
    const origin = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
    this.weapons._fireAPFSDS(origin, dir, WEAPONS.apfsds);
    return 'APFSDS fired';
  }
  _spawnMolotovPool(pos, fromNet = false) {
    if (this.mp.active && !this.mp.isHost && !fromNet) { this.mp.net.send('molotov', { x: pos.x, y: pos.y, z: pos.z }); return; }
    if (!this.molotovPools) this.molotovPools = [];
    if (this.molotovPools.length >= FIRE_POOL_MAX) this._disposeMolotovPool(this.molotovPools.shift());
    this._downV = this._downV || new THREE.Vector3(0, -1, 0); // drop the burning liquid onto the floor under the impact so the fire never floats
    const gh = this.world.rayHit(new THREE.Vector3(pos.x, pos.y + 0.5, pos.z), this._downV, 200, (b) => !b.foliage);   // skip leaves/bushes so the puddle drops to the real ground, not floating on a bush canopy
    const py = gh ? gh.point.y + 0.02 : 0.05;
    const lh = this.engine.acquireFxLight(0xff5a26, 7, 14, 1.4); lh.light.position.set(pos.x, py + 0.45, pos.z); // borrow from the fixed FX pool (no scene.add → no shader recompile)
    const pool = { pos: new THREE.Vector3(pos.x, py, pos.z), light: lh.light, lightH: lh, life: FIRE_POOL_LIFE, maxLife: FIRE_POOL_LIFE, radius: FIRE_POOL_RADIUS, emitT: 0, tickT: 0 };
    this.molotovPools.push(pool);
    // Register the burning puddle as a generic fire SOURCE — FireManager re-ignites flammables near
    // it without any molotov-specific knowledge (the only coupling; removed again on dispose).
    if (this.fire) pool._emitter = this.fire.addEmitter({ pos: pool.pos, radius: pool.radius, alive: () => pool.life > 0, startY: pos.y });
    if (this.mp.active && this.mp.isHost) this.mp.net.send('firepool', { x: pos.x, y: pos.y, z: pos.z });
  }
  _fxBeam(from, dir) { // transient red boss-laser beam for clients (visual only — damage is host-authoritative)
    const len = 70, end = from.clone().addScaledVector(dir, len);
    const beam = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xff2436, transparent: true, opacity: 0.95, depthWrite: false, fog: false }));
    beam.renderOrder = 998; beam.position.copy(from).add(end).multiplyScalar(0.5); beam.scale.set(0.4, 0.4, len); beam.lookAt(end);
    this.engine.scene.add(beam);
    setTimeout(() => { this.engine.scene.remove(beam); beam.geometry.dispose(); beam.material.dispose(); }, 180);
  }
  _disposeMolotovPool(p) { if (p) this.engine.releaseFxLight(p.lightH); if (this.fire && p && p._emitter) this.fire.removeEmitter(p._emitter); }
  _clearMolotovPools() { if (this.molotovPools) { for (const p of this.molotovPools) this._disposeMolotovPool(p); this.molotovPools.length = 0; } }
  _updateMolotovPools(dt) {
    if (!this.molotovPools || !this.molotovPools.length) return;
    const hostSim = !this.mp.active || this.mp.isHost;
    const t = performance.now() * 0.001;
    for (let i = this.molotovPools.length - 1; i >= 0; i--) {
      const p = this.molotovPools[i];
      p.life -= dt;
      const fade = p.life < 2.0 ? Math.max(0, p.life / 2.0) : 1;
      p.emitT -= dt; if (p.emitT <= 0) { p.emitT = 0.05; this.effects.firePool(p.pos, p.radius, fade); }
      if (p.light) { const flick = 0.8 + Math.sin(t * 24 + i) * 0.15; p.light.intensity += (7 * fade * flick - p.light.intensity) * Math.min(1, dt * 6); }
      p.tickT -= dt;
      if (hostSim && p.tickT <= 0 && p.life > 0) {
        p.tickT = FIRE_BURN_TICK;
        this.loot.clearPickupsInRadius(p.pos.x, p.pos.z, p.radius); // fire burns up any ground item lying in (or dropped into) the pool while it's alight; broadcasts 'pickupgone' so clients' copies vanish too
        const center = this._molTmp.set(p.pos.x, p.pos.y + 0.5, p.pos.z);
        for (const e of this.enemies.active) {
          if (!e.alive) continue;
          if (Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z) > p.radius) continue;
          if (this.raySegBlocked(center, this._molTmp2.set(e.pos.x, e.pos.y + e.height * 0.5, e.pos.z))) continue;
          e.burnT = ENEMY_BURN_DUR; this.enemies.damage(e, FIRE_DOT_ENEMY * FIRE_BURN_TICK, 'fire', e.pos.clone());
        }
        const tryBurn = (px, py, pz, id, isLocal) => {
          if (Math.hypot(px - p.pos.x, pz - p.pos.z) > p.radius) return;
          if (this.raySegBlocked(center, this._molTmp2.set(px, py + 0.9, pz))) return;
          // MP: refresh the burn timer only — _tickBurn is the SINGLE source of player DoT, so burn lingers ~PLAYER_BURN_DUR after leaving the pool (no per-tick hostHurt here, or it'd double-dip)
          if (this.mp.active) { const s = this.mp.pstate.get(id); if (s) s.burnT = PLAYER_BURN_DUR; }
          else this.player.burnT = PLAYER_BURN_DUR; // solo: local burnT + survivalTick DoT (unchanged)
        };
        if (this.mp.active && this.mp.isHost) { tryBurn(this.player.pos.x, this.player.pos.y, this.player.pos.z, 'host', true); for (const [id, rp] of this.mp.remotes) tryBurn(rp.pos.x, rp.pos.y, rp.pos.z, id, false); }
        else if (!this.mp.active) tryBurn(this.player.pos.x, this.player.pos.y, this.player.pos.z, null, true);
      }
      if (p.life <= 0) { this._disposeMolotovPool(p); this.molotovPools.splice(i, 1); }
    }
  }
  onNightStart(n, blood) {
    // world clock runs in every mode → nightfall is announced everywhere now (was longnight-only)
    if (blood) this.hud.bigMessage('🔴 BLOOD MOON', 'the horde swells — survive it');
    else this.hud.bigMessage(`NIGHT ${n}`, 'darkness falls — watch your back');
    this.audio.waveStart();
  }
  onDayStart() { this.hud.bigMessage('DAWN', 'you made it through the night'); }
  useRadio() {
    if (this.state !== 'playing') return;
    if ((this.player.radios || 0) <= 0) { this.hud.bigMessage('NO RADIO', 'kill a backpack courier to get one'); this.audio.noMoney(); return; }
    this.player.radios--; this.hud.setRadios(this.player.radios);
    this.loot.requestSupplyDrop();
  }

  // Survival inventory overlay (key I) — non-pausing: free the cursor but keep the run live (you stay vulnerable while managing).
  toggleInventory() {
    if (this._invOpen) { this._closeInventory(); return; }
    this._invOpen = true; this.hud.openInventory(this.inventory);
    this._intentionalUnlock = true; this.input.exitLock(); // free the cursor; the 'unlock' handler skips the pause
  }
  _closeInventory() { this._invOpen = false; this.hud.closeInventory(); if (this.state === 'playing') this.input.requestLock(); }
  // ---- Anti-accidental-exit guards (game-feel) ----
  // Cross-browser backstop: a "leave site?" confirm on tab-close / reload / nav-away during a live run. On
  // Chromium, Keyboard Lock already eats Ctrl/Cmd+W & Ctrl/Cmd+R; this still covers the window-close button /
  // Cmd+Q / F5 and is the ONLY net on browsers without Keyboard Lock. (beforeunload needs a prior user gesture —
  // satisfied because runs start on a click.)
  _setUnloadGuard(on) { window.onbeforeunload = on ? (e) => { e.preventDefault(); e.returnValue = ''; return ''; } : null; }
  // Keyboard Lock API (Chromium, fullscreen only): a tapped Esc pauses IN PLACE instead of dropping fullscreen,
  // and the locked keys' browser shortcuts (here Ctrl/Cmd+W & Ctrl/Cmd+R) reach the game instead of the browser
  // (a held Esc ~2 s is still the safety exit). Released only on run-exit, NOT in pause(), so the lock survives a
  // pause and resume() just re-locks idempotently. Feature-detected + never throws; FF/Safari simply have no lock.
  _lockKeyboard() { if (navigator.keyboard && navigator.keyboard.lock) { try { const p = navigator.keyboard.lock(['Escape', 'KeyW', 'KeyR']); if (p && p.catch) p.catch(() => {}); } catch (e) {} } }
  _unlockKeyboard() { if (navigator.keyboard && navigator.keyboard.unlock) { try { navigator.keyboard.unlock(); } catch (e) {} } }
  pause() {
    if (this.state !== 'playing') return;
    if (this._invOpen) { this._invOpen = false; this.hud.closeInventory(); } // close the backpack WITHOUT re-locking the pointer (we're about to free the cursor)
    this.weapons.cancelMolotov();
    if (this.input.locked) { this._intentionalUnlock = true; this.input.exitLock(); } // free the cursor for the menu — Keyboard Lock keeps us pointer-locked through a tapped Esc; _intentionalUnlock makes the 'unlock' handler skip its own pause
    if (this.mp && this.mp.active) { this.mpMenuOpen = true; this.ui.show('pause'); return; }
    this.state = 'paused'; this.ui.show('pause');
  }
  resume() {
    if (this.mp && this.mp.active && this.mpMenuOpen) { this._closeMpMenu(true); return; }
    if (this.state !== 'paused') return;
    // Re-enter fullscreen (Esc may have dropped it on FF/Safari) then re-grab the pointer + keyboard lock; 'lock' handler hides the overlay once granted.
    const root = document.documentElement;
    const after = () => { this.input.requestLock(); this._lockKeyboard(); };
    if (!document.fullscreenElement && root.requestFullscreen) root.requestFullscreen().then(after, after);
    else after();
  }
  _closeMpMenu(lockPointer) {
    this.mpMenuOpen = false;
    this.ui.hideAll();
    if (lockPointer && this.state === 'playing') this.input.requestLock();
  }
  _lobbyVisible() { const el = document.getElementById('lobby'); return !!(el && el.classList.contains('show')); }
  toMenu() {
    if (this.state === 'playing' || this.state === 'paused') { this._bankRunMoney(); this._saveMeta(); } // leaving a live run banks its money
    if (this.mp && this.mp.active) this.mp.leave();
    const _lab = document.getElementById('mp-labels'); if (_lab) _lab.style.display = 'none';
    this.mpMenuOpen = false;
    this.state = 'menu'; this._intentionalUnlock = this.input.locked; this.input.exitLock();
    this._setUnloadGuard(false); this._unlockKeyboard(); // run over → drop the exit guards
    this.resetMountedGuns();
    for (const np of this.nightPosts) np.forceReset();
    for (const m of this.mortars) m.forceReset(); // clear the ННП-23 NV filter/overlay when leaving to menu
    if (this.hud) this.hud.setCompass(null); // tear the буссоль overlay down on the way to menu
    this.enemies.clearAll(); if (this.audio.music) this.audio.music.setPlaylist('soviet'); this.hud.show(false);
    this.ui.show('menu'); this.ui.hint.style.display = '';
  }
  // Dev/preview: drop a Flopo avatar into the scene (returns the rigged Group).
  showAvatar(opts) {
    if (this._avatarMesh) { this.engine.scene.remove(this._avatarMesh); this._avatarMesh.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); }
    const o = buildFlopo(opts || {});
    this._avatarMesh = o; this.engine.scene.add(o);
    return o;
  }

  openAdmin() { this.state = 'admin'; if (this.audio.music && !this.audio.music.playlist) this.audio.music.setPlaylist('soviet'); if (this.admin) this.admin.open(); } // keep the jukebox running so the asset-viewer Music player controls it live
  // ФОНОТЕКА — full-screen music screen (live 3D gramophone + genre browser), from the menu or the co-op lobby.
  openFonoteka(from) {
    this._fonoFrom = (from === 'lobby') ? 'lobby' : 'menu';
    this.state = 'music';
    this.audio.init();
    if (this.audio.music && !this.audio.music.playlist) this.audio.music.setPlaylist('soviet');
    this.ui.show('music');
    if (this.fonoteka) this.fonoteka.open();
  }
  closeFonoteka() {
    if (this.fonoteka) this.fonoteka.close();
    if (this._fonoFrom === 'lobby') this.toLobby(); else { this.state = 'menu'; this.ui.show('menu'); }
  }
  // Secret poker den — 2D Texas Hold'em Sit & Go (solo practice vs bots; co-op PvP later).
  openPoker(from) {
    this._pokerFrom = (from === 'lobby') ? 'lobby' : 'menu';
    this.state = 'poker';
    this._intentionalUnlock = this.input.locked; this.input.exitLock();
    this.audio.init();
    if (this.audio.music) this.audio.music.stop({ fade: 0.6 }); // poker room is its own acoustic space — hush the lobby jukebox
    this.ui.show('poker');
    if (this.poker) this.poker.open();
  }
  closePoker() {
    if (this.poker && this.poker.renderer && this.poker.renderer.stopRadio) this.poker.renderer.stopRadio(); // kill the den radio stream
    const wasPoker = !!(this.mp && this.mp._lobbyMode === 'poker');
    if (this.poker) this.poker.leave();
    // leaving the den restores the lobby/menu jukebox (toLobby already does; menu path restores here)
    if (this._pokerFrom === 'lobby') {
      this.toLobby();
      if (wasPoker && this.mp) {                       // a fresh ante round is required before the next game
        this.mp.ready = false;
        if (this.mp.isHost) { this.mp._resetReadies(); try { this.mp.net.send('roster', this.mp._rosterArr()); } catch (e) {} }
        if (this.mp._renderRoster) this.mp._renderRoster();
      }
    } else { this.state = 'menu'; this.ui.show('menu'); if (this.audio.music) this.audio.music.setPlaylist('soviet'); }
  }
  // Host-only: DEAL co-op poker straight from the room lobby — the buy-in was chosen and players anted
  // (READY) in the lobby, so seat EXACTLY the anted set and deal. Replaces the standalone POKER button.
  startCoopPokerFromLobby() {
    if (!this.mp || !this.mp.isHost) return;
    const buyIn = this.mp.pokerBuyIn | 0;
    const seatIds = [...this.mp.roster].filter(([id, r]) => id === 'host' || r.ready).map(([id]) => id);
    if (seatIds.length < 2) { this.mp._lobbyMsg('Need at least 2 anted players.'); return; }
    this._pokerFrom = 'lobby';
    this.state = 'poker';
    this._intentionalUnlock = this.input.locked; this.input.exitLock();
    this.audio.init();
    if (this.audio.music) this.audio.music.stop({ fade: 0.6 });
    this.ui.show('poker');
    this.poker.openCoop(true);                          // host role + reset, skip the buy-in lobby
    this.poker.startCoop(buyIn, seatIds);               // deterministic seat list = exactly the anted players
  }
  // Co-op PvP poker — host opens the den for the room; clients are pulled in by the 'pkstart' message.
  openCoopPoker() {
    if (!this.mp || !this.mp.isHost) return; // host-only entry
    this._pokerFrom = 'lobby';
    this.state = 'poker';
    this._intentionalUnlock = this.input.locked; this.input.exitLock();
    this.audio.init();
    if (this.audio.music) this.audio.music.stop({ fade: 0.6 }); // co-op poker room: hush the lobby jukebox too
    this.ui.show('poker');
    if (this.poker) this.poker.openCoop();
  }
  _enterCoopPoker(d) { // client side — host has dealt; join the table
    this._pokerFrom = 'lobby';
    this.state = 'poker';
    this._intentionalUnlock = this.input.locked; this.input.exitLock();
    this.audio.init();
    if (this.audio.music) this.audio.music.stop({ fade: 0.6 }); // co-op poker room: hush the lobby jukebox too
    this.ui.show('poker');
    if (this.poker) this.poker.enterCoopClient(d);
  }
  // «Посылка» lootbox — open one owned crate. The roll is COMMITTED + saved BEFORE any
  // animation so an Esc/refresh/crash mid-ceremony can never re-roll or lose the reward.
  openCrate() {
    const m = this.meta;
    if (!this.crate || this.state === 'crate' || !((m.crates | 0) > 0)) { this.audio.noMoney(); return; } // re-entry/stock guard
    this.audio.init();                       // CTA click = the user gesture that unlocks WebAudio
    const result = rollCrateReward(this);    // decrement stock, advance pity, grant reward
    this._saveMeta();
    this.state = 'crate'; this.ui.show('crate');
    this.crate.open(result);
  }
  beginNextWave() {
    if (this.state !== 'shop') return;
    if (this.mp.active && !this.mp.isHost) { this.ui.hideAll(); this.hud.bigMessage('READY', 'waiting for the host…'); return; }
    this.ui.hideAll(); this.state = 'playing'; this.input.requestLock();
    this.waves.startWave(this.waves.wave + 1);
  }

  onEnemyKilled(e, attacker = 'host') {
    // CO-OP, client-credited kill: the HOST still rolls+broadcasts the SHARED ground loot (so everyone sees
    // the same pile), but the cash/score CREDIT — including the rolled key-cash — goes to the actual KILLER
    // via creditKill. The host does NOT keep the client's reward. Tank-mechanic special rewards stay host-side.
    if (this.mp.active && this.mp.isHost && attacker !== 'host') {
      this.loot.drop(e.pos, e.def); if (e.courier) this.loot.dropCourier(e.pos);
      this.mp.creditKill(attacker, e);   // killer gets flat personal cash + score; shared loot is separate
      return;
    }
    this.kills++;
    this.player.addMoney(KILL_CASH);
    this.score += e.def.reward + (e.def.boss ? 1500 : 0); this.hud.setScore(this.score);
    if (this.mp.active && this.mp.isHost) this.mp.feed(((this.mp.roster.get('host') || {}).name) || 'Host', e.name); else this.hud.kill(e.name);
    this.loot.drop(e.pos, e.def);
    if (e.courier) this.loot.dropCourier(e.pos);
  }
  toLobby() {
    this.state = 'menu';
    this.ui.show('lobby');
    this.mp._renderLanMode();
    this.mp._renderRelayMode();
    this.mp._renderModeSel();
    this.mp._renderRoomBrowser();
    if (this.audio.music) this.audio.music.setPlaylist('soviet'); // lobby plays the shuffled song jukebox
  }
  _enterMP(mode) {
    this.mode = (mode === 'longnight') ? 'longnight' : 'purge';
    this.audio.init(); this.audio.music.setScene('gameplay'); this._intentionalUnlock = false;
    this._setUnloadGuard(true); // arm the "leave site?" net for the co-op run too
    this.mpMenuOpen = false;
    if (this.mp) { this.mp._spilledLoot = false; this.mp.spectateTarget = null; } // fresh run → loot can spill again on the next real death
    this.reset(); this.ui.hideAll(); this.hud.show(true); this.ui.hint.style.display = 'none';
    const labels = document.getElementById('mp-labels'); if (labels) labels.style.display = 'block';
    this.state = 'playing'; this._startCountdown = this.mp.isHost ? 0.6 : 0;
    this.enemies.prewarm(); // co-op too: the host runs the boss sim (buildTolo/navGrid/FX), clients render boss ghosts → both want it warm, not mid-fight
    const root = document.documentElement; const after = () => { this.engine.resize(); this.input.requestLock(); this._lockKeyboard(); };
    if (!document.fullscreenElement && root.requestFullscreen) root.requestFullscreen().then(after, after); else after();
  }
  _mpGameOver(msg) {
    this._mpReturnToLobby(msg || 'Squad wiped. Ready up and start again.');
  }
  _mpReturnToLobby(msg) {
    if (this.state === 'menu' && !(this.mp && this.mp.active)) return;
    if (this._invOpen) { this._invOpen = false; this.hud.closeInventory(); }
    this._intentionalUnlock = this.input.locked; this.input.exitLock();
    this._setUnloadGuard(false); this._unlockKeyboard(); // squad wiped → back to lobby, drop the exit guards
    this._bankRunMoney(); this._saveMeta(); // each player banks their own run money locally
    if (this.mp && typeof this.mp.endRunToLobby === 'function') this.mp.endRunToLobby(msg);
    this.state = 'menu'; this.mpMenuOpen = false;
    this.resetMountedGuns();
    for (const np of this.nightPosts) np.forceReset();
    for (const m of this.mortars) m.forceReset(); // clear the ННП-23 NV filter/overlay on squad-wipe → lobby
    if (this.hud) this.hud.setCompass(null); // tear the буссоль overlay down on squad-wipe → lobby
    this.enemies.clearAll(); this.loot.reset(); this.build.reset(); this.waves.reset();
    this._clearFlares();
    if (this._clearMolotovPools) this._clearMolotovPools();
    if (this.fire) this.fire.clear();
    this.dayNight.reset();
    if (this.audio.music) this.audio.music.setPlaylist('soviet'); this.hud.show(false); // lobby plays the shuffled song jukebox
    this.hud.setBleed(-1); this.hud.hideBoss(); this.hud.clearWaveTag();
    const lab = document.getElementById('mp-labels'); if (lab) lab.style.display = 'none';
    this.ui.show('lobby');
    this.mp._lobbyMsg(msg || 'Run ended. Ready up and start again.');
    this.mp._renderRoster();
    this.mp._renderLanMode();
    this.mp._renderRelayMode();
    this.mp._renderModeSel();
    this.mp._renderRoomBrowser();
  }
  // _mpOpenShop removed — co-op has continuous waves with no between-wave shop.
  _hurtTarget(id, dmg) { if (this.mp.active && this.mp.isHost) this.mp.hostHurt(id, dmg); else this.player.hurt(dmg); }
  // Host-origin one-way broadcast of a boss/tank attack VISUAL so clients (who never run EnemyManager.update) can SEE/HEAR it.
  _bossFx(kind, fields) { if (this.mp && this.mp.active && this.mp.isHost) this.mp.net.send('bossfx', Object.assign({ k: kind }, fields)); }
  _explodeHurt(pos, radius, dmg) {
    const hurt = (px, pz, id) => { const d = Math.hypot(px - pos.x, pz - pos.z); if (d < radius) { const dd = dmg * (1 - d / radius); if (this.mp.active && this.mp.isHost) this.mp.hostHurt(id, dd); else this.player.hurt(dd); } };
    if (this.mp.active && this.mp.isHost) { hurt(this.player.pos.x, this.player.pos.z, 'host'); for (const [id, rp] of this.mp.remotes) hurt(rp.pos.x, rp.pos.z, id); }
    else hurt(this.player.pos.x, this.player.pos.z, 'host');
    if (this.world.igniteFABsNear) this.world.igniteFABsNear(pos, radius); // any blast sets off nearby kolkhoz FAB-500s (chain)
  }
  // ── Centralized explosion ──────────────────────────────────────────────────────────
  // ONE place that does "what an explosion does": visual+audio, enemy AoE, player splash
  // (+FAB chain), ground-item clearing, and destruction (trees/props/building/fire). Per
  // call site you only tune the params/flags. Authority + co-op are handled here: the
  // visual runs locally for everyone, the authoritative bits run only on the host, and a
  // client routes the whole thing to the host via one 'boom' packet (which the host
  // replays with visual:false, since it already saw the detonation via the 'proj' ghost).
  explode(pos, opts = {}) {
    const { radius = 5, dmg = 0, enemyDmg = dmg, source = 'explosion', except = null,
            harmEnemies = true, harmPlayers = true, clearLoot = true, destroy = true,
            isRocket = false, visual = true, shake = 0, net = true, attacker = 'host' } = opts;
    if (!pos || !Number.isFinite(radius) || radius <= 0) { console.warn('explode: bad pos/radius — skipped', pos, radius); return; } // surface a bad call instead of an audible blast that silently deals no damage
    if (visual) this.effects.explosion(pos, radius);          // explosion() also plays audio.explosion()
    if (shake && this.engine.shake) this.engine.shake(shake);
    const hostSim = !this.mp.active || this.mp.isHost;
    if (hostSim) {
      if (destroy) this._carveCrater(pos, radius);          // FIRST: lower the ground so _demoBlast's support scan + any settle read the bowl
      if (harmEnemies) this.enemies.damageInRadius(pos, radius, enemyDmg, except, source, attacker);
      if (harmPlayers) this._explodeHurt(pos, radius, dmg); // includes the FAB-500 chain
      if (clearLoot) this.loot.clearPickupsInRadius(pos.x, pos.z, radius);
      if (destroy) this._demoBlast(pos, radius, isRocket);  // trees/props/building/fire (no-op without a forest/demo building)
    } else if (net && this.mp.active) {
      // client → host: one packet carries everything the host needs to authoritatively apply.
      this.mp.net.send('boom', { p: [+pos.x.toFixed(2), +pos.y.toFixed(2), +pos.z.toFixed(2)], r: radius, d: dmg, ed: enemyDmg, s: source,
        he: harmEnemies ? 1 : 0, hp: harmPlayers ? 1 : 0, cl: clearLoot ? 1 : 0, ds: destroy ? 1 : 0, rk: isRocket ? 1 : 0 });
    }
  }
  // HE blast routed into the demo destructibles: remove brick wall segments (a WALKABLE breach)
  // + shatter glass via the building, fell trees + destroy props within the blast, and seed a
  // fire at the impact (a rocket into the woods lights the stand). Host-auth.
  _demoBlast(pos, radius, isRocket) {
    const hostSim = !this.mp.active || this.mp.isHost;
    if (!hostSim) return;
    const b = this.world.demoBuilding;
    const blast = isRocket ? DEMO_HE_BLAST : { r1: radius * 0.35, r2: radius, tier: 2 };
    if (b && typeof b.applyBlast === 'function') b.applyBlast(pos, radius, { blast });
    // Trees fall across the FULL explosion radius (matches the visible blast) for rockets/HE; a thrown
    // grenade keeps the tight ring. forest.blast() uses horizontal distance, so this radius alone decides
    // how much of the surrounding stand comes down — the small building r1 stays the building's breach size.
    const fellR = isRocket ? Math.max(radius, blast.r1 + 0.6) : (blast.r1 + 0.6);
    if (this.forest && typeof this.forest.blast === 'function') this.forest.blast(pos, fellR, blast.tier);
    if (this.fire && typeof this.fire.igniteAt === 'function') this.fire.igniteAt([pos.x, pos.y, pos.z], isRocket ? 4.5 : 3.2);
  }
  // Blast → terrain crater (shared by explode() and the hand-rolled mortar detonation). Host-auth:
  // digManager.carveCrater carves the bowl, re-meshes the chunk, drops undermined objects, and (in
  // co-op) broadcasts the dig. Small blasts only scuff; ordnance digs a real bowl (see dig.js).
  _carveCrater(pos, radius) {
    if (this.digManager) this.digManager.carveCrater(pos, radius);
  }
  onWaveCleared(n) {
    this.audio.waveClear(); if (this.audio.music) this.audio.music.sting('victory', 'small'); this.player.addMoney(150 + n * 25);
    if (this.mp.active && this.mp.isHost) this.mp.net.send('waveclear', { n: this.waves.wave });
    this.hud.bigMessage('WAVE CLEAR', 'breathe — next wave incoming'); this._waveBreak = WAVE_BREATHER; // pure breather, auto-advances (no shop)
  }
  // Wave timed out with survivors still alive — start the next wave on top of them (no clear, no breather; they carry over).
  onTimedAdvance(n) {
    this.waves.startWave(n + 1); // startWave handles the MP 'wave' broadcast + survivors persist (it never clears enemies)
    this.hud.bigMessage('WAVE ' + (n + 1), 'survivors remain — hold!');
  }
  onPlayerDead() {
    if (this.mp && this.mp.active) return; // co-op death is pstate-driven; _mpGameOver handles the squad wipe
    if (this.devconsole && this.devconsole.open) this.devconsole.close();
    if (this._invOpen) { this._invOpen = false; this.hud.closeInventory(); }
    this.state = 'dead'; this._intentionalUnlock = this.input.locked; this.input.exitLock();
    this._setUnloadGuard(false); this._unlockKeyboard(); // run over → drop the exit guards
    this._bankRunMoney(); // run money → persistent bank (the _saveMeta below persists it)
    this.resetMountedGuns();
    for (const np of this.nightPosts) np.forceReset();
    for (const m of this.mortars) m.forceReset(); // clear the ННП-23 NV filter/overlay off the death screen
    if (this.hud) this.hud.setCompass(null); // tear the буссоль overlay down on death
    if (this.audio.music) { this.audio.music.setScene('gameover'); this.audio.music.setIntensity(0.85); this.audio.music.setStress(0); } this.hud.show(false);
    // persistent meta (per mode) + lifetime tallies
    const m = this.meta; m.kills = (m.kills || 0) + this.kills; m.runs = (m.runs || 0) + 1;
    const rec = document.getElementById('goRecord');
    if (this.mode === 'longnight') {
      const prev = m.bestNight || 0, record = this._surviveTime > prev;
      m.bestNight = Math.max(prev, this._surviveTime);
      document.getElementById('goWave').textContent = 'night wave ' + this.waves.wave;
      if (rec) rec.innerHTML = `survived <b style="color:var(--gold)">${this._fmtTime(this._surviveTime)}</b> ` + (record ? `🏆 <b style="color:var(--gold)">NEW BEST!</b>` : `· best ${this._fmtTime(m.bestNight)}`);
    } else {
      const prevBest = m.bestWave || 0, record = this.waves.wave > prevBest;
      m.bestWave = Math.max(prevBest, this.waves.wave); m.bestScore = Math.max(m.bestScore || 0, this.score);
      document.getElementById('goWave').textContent = 'wave ' + this.waves.wave;
      if (rec) rec.innerHTML = (record ? `🏆 <b style="color:var(--gold)">NEW BEST — wave ${m.bestWave}!</b>` : `Best: wave ${m.bestWave}`) + ` &nbsp;·&nbsp; lifetime ${m.kills} popped over ${m.runs} runs`;
    }
    this._saveMeta(); this._showMenuBest();
    document.getElementById('goScore').textContent = this.score;
    document.getElementById('goKills').textContent = this.kills;
    this.ui.show('gameover');
  }
  _fmtTime(s) { s = Math.floor(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  _loadMeta() {
    let m; try { m = JSON.parse(localStorage.getItem('engendros_meta') || '{}'); } catch (e) { m = {}; }
    // roguelite economy (backward-compatible: missing keys default for existing players)
    if (typeof m.bank !== 'number') m.bank = 0;                                   // persistent money "account"
    if (typeof m.chipSkin !== 'string') m.chipSkin = 'dice';                      // poker chip-skin cosmetic (CHIP_SKINS id)
    if (!Array.isArray(m.chipSkinsUnlocked)) m.chipSkinsUnlocked = [];            // crate-unlocked chip skins (marx/lenin); free skins aren't listed
    if (typeof m.cardBack !== 'string') m.cardBack = 'default';                   // poker card-back cosmetic (CARD_BACKS id)
    if (!Array.isArray(m.cardBacksUnlocked)) m.cardBacksUnlocked = [];            // crate-unlocked card backs (redstar/emblem)
    if (!Array.isArray(m.unlocked)) m.unlocked = ['knife'];                       // permanently owned gear keys
    if (!m.unlocked.includes('knife')) m.unlocked.push('knife');                  // knife is always owned (cold start)
    // Loadout is now a flat array of LOADOUT_SLOTS equal slots (any gear in any slot, duplicates OK).
    // Migrate the old keyed forms losslessly: oldest {gadget}, then {primary,secondary,melee,gadget1,gadget2}.
    if (Array.isArray(m.loadout)) {
      m.loadout = m.loadout.slice(0, LOADOUT_SLOTS);
    } else {
      const old = (m.loadout && typeof m.loadout === 'object') ? m.loadout : {};
      if ('gadget' in old && old.gadget1 == null) old.gadget1 = old.gadget;       // oldest single-gadget form
      const arr = [];
      for (const s of ['primary', 'secondary', 'melee', 'gadget1', 'gadget2']) { const k = old[s]; if (k && typeof k === 'string') arr.push(k); }
      m.loadout = arr;
    }
    while (m.loadout.length < LOADOUT_SLOTS) m.loadout.push(null);                 // pad to fixed length
    m.loadout = m.loadout.map((k) => (k && typeof k === 'string' && !/^build_/.test(k)) ? k : null); // drop junk/removed-builder keys
    if (m.loadout.every((k) => !k)) m.loadout[0] = 'knife';                       // cold start / empty → knife in slot 0
    for (const k of m.loadout) { if (k && !m.unlocked.includes(k)) m.unlocked.push(k); } // anything equipped is owned (catalog ownership derives from m.unlocked)
    for (const k of ['crates', 'crateOpens', 'pityEpic', 'pityLegend']) if (typeof m[k] !== 'number' || !(m[k] >= 0)) m[k] = 0; // «Посылка» lootbox: stock + pity counters
    if (!m.playerId) { m.playerId = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); try { localStorage.setItem('engendros_meta', JSON.stringify(m)); } catch (e) {} } // stable per-device co-op identity — persist immediately so it survives reloads
    return m;
  }
  _saveMeta() { try { localStorage.setItem('engendros_meta', JSON.stringify(this.meta)); } catch (e) {} }
  // Deposit this run's money into the persistent bank — once per run (guarded by _banked, reset in reset()).
  _bankRunMoney() {
    if (this._banked) return; this._banked = true;
    this.meta.bank = (this.meta.bank || 0) + Math.max(0, Math.round(this.player.money || 0));
  }
  _showMenuBest() {
    const el = document.getElementById('menuBest'); if (!el) return;
    const m = this.meta || {}; const parts = [];
    if (m.bestWave) parts.push(`Purge: wave ${m.bestWave}`);
    if (m.bestNight) parts.push(`Long Night: ${this._fmtTime(m.bestNight)}`);
    el.textContent = parts.length ? 'Best — ' + parts.join(' · ') : '';
  }

  // Adaptive score driver (client-local, cosmetic): pick scene from local threat,
  // ramp intensity, fire the boss-down victory sting. Smoothing/scheduling live in MusicDirector.
  _updateAdaptiveMusic() {
    const m = this.audio.music; if (!m) return;
    const en = this.enemies;
    let boss = null;
    for (const e of en.active) { if (e.alive && e.def && e.def.boss) { boss = e; break; } }
    if (boss) {
      if (m.sceneName !== 'boss') m.setScene('boss', { variant: 'tolo' });
      const frac = Math.max(0, Math.min(1, boss.hp / (boss.maxHp || 1)));
      m.setIntensity(0.65 + (1 - frac) * 0.35);
      this._bossMusic = true;
    } else {
      if (this._bossMusic) { this._bossMusic = false; m.sting('victory', 'big'); m.setScene('gameplay'); }
      if (m.sceneName === 'gameplay') {
        const pp = this.player.pos; let near = 0;
        for (const e of en.active) { if (!e.alive) continue; if (Math.hypot(e.pos.x - pp.x, e.pos.z - pp.z) < 14) near++; }
        const aliveFrac = Math.min(1, en.aliveCount / 18);
        const nearFrac = Math.min(1, near / 8);
        const waveBonus = (this._waveBreak > 0) ? 0 : 0.15;
        m.setIntensity(Math.min(1, 0.05 + nearFrac * 0.6 + aliveFrac * 0.3 + waveBonus));
      }
    }
    const hpFrac = this.player.maxHp ? this.player.hp / this.player.maxHp : 1;
    m.setStress(Math.max(0, Math.min(1, (0.35 - hpFrac) / 0.35)));
  }

  _frame(t) {
    requestAnimationFrame(this._bound);
    let dt = (t - this._last) / 1000; this._last = t;
    if (!(dt > 0)) dt = 0.0001;
    const _rf = 1 / dt; if (_rf > 1 && _rf < 1000) { this._fps = this._fps ? this._fps * 0.9 + _rf * 0.1 : _rf; this._frameMs = this._frameMs ? this._frameMs * 0.9 + dt * 1000 * 0.1 : dt * 1000; } // smoothed FPS + frame-ms for F3 (raw delta, before the sim clamp)
    if (this._stressName) { // dev stress harness: sample RAW frame-time (pre-clamp) to catch hitches
      if (this._stressTick) { this._stressTick.acc += dt; if (this._stressTick.acc >= this._stressTick.every) { this._stressTick.acc = 0; this._stressTick.fn(); } }
      this.hitch.sample(dt * 1000);
      this._stressElapsed += dt;
      if (this._stressElapsed >= this._stressSeconds) {
        this._hitchReport = this.hitch.report();
        console.table([this._hitchReport]);
        console.log('[stress] "' + this._stressName + '" done →', JSON.stringify(this._hitchReport));
        this._stressName = null; this._stressTick = null;
      }
    }
    const frameDt = Math.min(dt, 0.05);
    if (this.audio.music) this.audio.music.update(frameDt); // score smoothing runs in every state

    let interp = false, alpha = 0;
    if (this.state === 'playing' && this._fixedStep) {
      this._acc += Math.min(dt, 0.25);                       // larger cap than the sim clamp; bounds catch-up
      let n = 0;
      while (this._acc >= FIXED_STEP && n < MAX_SUBSTEPS && this.state === 'playing') { // re-check state: a sub-step (death/wipe) can leave 'playing'
        this._camPrev.copy(this.engine.camera.position);     // capture BEFORE each step → after the loop, _camPrev is exactly ONE step before _camCur (correct interp interval even when N>1)
        this._updatePlaying(FIXED_STEP);
        if (n === 0) this.input.endFrame();                  // consume edges + mouse delta ONCE (first sub-step only)
        this._acc -= FIXED_STEP; n++;
      }
      if (this._acc >= FIXED_STEP) this._acc %= FIXED_STEP;  // loop exited on the MAX_SUBSTEPS cap (or a state change) with backlog left → SHED it: accept slow-motion, never fast-forward catch-up or alpha>1 camera overshoot (this is the actual spiral-of-death break)
      if (n > 0) { this._camCur.copy(this.engine.camera.position); alpha = Math.min(this._acc / FIXED_STEP, 1); interp = true; } // clamp alpha so lerpVectors interpolates, never extrapolates
      // n === 0: no sim this frame → camera unchanged; edges NOT consumed (carry to next frame)
    } else if (this.state === 'playing') {
      this._updatePlaying(frameDt);                          // OFF / non-fixed path = unchanged
    }

    if (this.digManager) this.digManager.update();          // flush dug chunks → one re-mesh each (before chunks.update picks LODs)
    if (this.world && this.world.chunks) this.world.chunks.update(this.engine.camera); // uses TRUE sim cam pos
    this.engine.updateAdaptive(this._frameMs);
    if (this._drawDist > 0) { this._cullByDistance(this._drawDist); this._culling = true; } // uses TRUE sim cam pos
    else if (this._culling) { this._restoreVisibility(); this._culling = false; }
    if (this._showFps) { const el = this._fpsEl || (this._fpsEl = document.getElementById('fps')); if (el) { el.style.display = 'block'; el.textContent = Math.round(this._fps || 0) + ' FPS'; } }
    if (interp) this.engine.camera.position.lerpVectors(this._camPrev, this._camCur, alpha); // smooth between ticks
    if (this.hitboxDebug) this.hitboxDebug.update(this, this.dbgHitboxes && this.state === 'playing'); // F3+B collision overlay
    this.engine.update(frameDt); this.engine.render();
    if (interp) this.engine.camera.position.copy(this._camCur); // restore TRUE pos for F3/devconsole/raycasts/next prev
    { const _ri = this.engine.renderer.info.render; this._draws = _ri.calls; this._tris = _ri.triangles; } // F3 stats — read post-render (Three.js resets info per render)
    if (this.devconsole) { const dbg = this.f3 && this.state === 'playing'; this.devconsole.updateF3(dbg); this.devconsole.updateEntityLabels(dbg); }
    if (this.state === 'shop' && this.preview) this.preview.render(frameDt);
    if (this.state === 'admin' && this.admin) this.admin.viewer.render(frameDt);
    if (this.state === 'music' && this.fonoteka) this.fonoteka.render(frameDt);
    if (this.state === 'crate' && this.crate) this.crate.render(frameDt);
    else if (this.crate && this.crate.active) this.crate.abort(); // state hijacked (e.g. co-op host start) — reward already granted+saved
    if (this.state === 'poker' && this.poker) { this.poker.update(frameDt); this.poker.render(frameDt); }
    if (!(this._fixedStep && this.state === 'playing')) this.input.endFrame(); // fixed path clears inside the loop (or carries when n===0)
  }

  // One fixed effect tick: advance the player + every alive enemy by one step.
  // The player is skipped while MP-frozen (downed/dead/waiting — DoT suspended during bleed-out);
  // enemies have no such guard and always tick when alive.
  _stepEffectsOnce() {
    const ctx = this._fxCtx, p = this.player;
    if (p.alive && !(this.mp.active && this.mp.frozen)) stepEffects(p, ctx);
    const list = this.enemies.active;
    for (let i = 0; i < list.length; i++) { const e = list[i]; if (e.alive) stepEffects(e, ctx); }
  }

  _updatePlaying(dt) {
    const hostSim = !this.mp.active || this.mp.isHost; // clients don't simulate enemies/waves
    const sim = hostSim && !this.freecam;              // fly-cam = pure observation: no countdown/spawns/enemies
    if (sim && this._startCountdown > 0) { this._startCountdown -= dt; if (this._startCountdown <= 0) this.waves.startWave(this.waves.wave + 1); }
    if (sim && this._waveBreak > 0) { this._waveBreak -= dt; if (this._waveBreak <= 0) { this._waveBreak = 0; this.waves.startWave(this.waves.wave + 1); } } // continuous: breather → next wave (no shop, stay 'playing')

    for (const np of this.nightPosts) np.ensureBuilt(); // place the ННП-23 prop once its spec registers (async boot fetch)
    for (const m of this.mortars) { m.ensureBuilt(); m.update(dt); } // mortar: lazy place + tick in-flight shells (even unseated)
    if (this._mortarMark) { this._mortarMarkT -= dt; if (this._mortarMarkT <= 0) { this.engine.scene.remove(this._mortarMark); this._mortarMark.geometry.dispose(); this._mortarMark.material.dispose(); this._mortarMark = null; } } // fade the spotter beacon
    if (this.mp.active && this.mp.frozen) {
      if (this.player.mountedGun) this.player.mountedGun.dismount();
      if (this.player.nightPost) this.player.nightPost.exit();
      if (this.player.mortar) this.player.mortar.dismount();
      this.weapons.cancelMolotov();
      this.hud.setCompass(null); // downed/dead in co-op: weapons.update() is skipped → tear the буссоль overlay down
    }
    if (this.player.mountedGun) {
      this.player.mountedGun.controlUpdate(dt); // aim + fire + heat + camera handled here
    } else if (this.player.mortar) {
      this.player.mortar.controlUpdate(dt); // indirect-fire lay (W/S/A/D) + framing camera + fire handled here
    } else if (this.player.nightPost) {
      this.player.nightPost.controlUpdate(dt); // handwheel slew + eyepiece camera + branch FOV handled here
    } else {
      if (!this.mp.frozen) {
        const edge = this.input.buttonsPressed[0] ? 'press' : (this.input.buttons[0] ? 'hold' : null);
        const reviving = this.mp.active && this.mp.blocksWeaponUse && this.mp.blocksWeaponUse();
        if (edge && !reviving && !this.freecam) this.inventory.handleLMB(edge); // LMB use, dispatched by held item class (gun/melee/consumable/material/callable/throwable)
      }
      if (!this.mp.frozen && !(this.devconsole && this.devconsole.open) && this.input.wheel !== 0) { const _shift = this.input.isDown('ShiftLeft') || this.input.isDown('ShiftRight'); if (this.inventory.heldMaterial() && _shift) this.build.rotateGhost(this.input.wheel > 0 ? 1 : -1); else this.weapons.cycle(this.input.wheel > 0 ? 1 : -1); } // Shift+wheel rotates a held material's ghost; plain wheel scrolls the inventory — disabled while chat is open
      this.build.updateRadioTarget(); // radio look-target + ←/→ tuning, BEFORE player.update reads strafe
      this.gramophone.updateTarget(); // gramophone prop look-target + ←/→ song change (BEFORE player.update reads strafe)
      if (this.world.updateGateConsole) this.world.updateGateConsole(this); // booth gate-control console look-target (steppe only)
      if (this.world.updateDoorTarget) this.world.updateDoorTarget(this); // bunker гермодверь look-target (steppe only)
      this.player.update(dt);
      this.weapons.update(dt);
      this.inventory.update(dt); // throwable (molotov/grenade) state-machine tick
    }
    for (const gun of this._mountedGunList()) if (this.player.mountedGun !== gun) gun.idleCool(dt); // fixed MGs cool down even when nobody is manning them
    this.player.survivalTick(dt); // survival timers tick in every seat (on foot, mounted MG, tank)
    if (this.world.updateGate) this.world.updateGate(dt, this.player.pos); // steppe: animate the sliding works gate
    if (this.world.updateDoors) this.world.updateDoors(dt); // steppe: ease bunker гермодвери open/closed + track leaf colliders
    if (this.world.updateKolkhoz) this.world.updateKolkhoz(dt, this.player.pos); // steppe: sway the wreck smoke + smoulder near the player
    this.build.update(dt); // build ghost preview (shows only while a builder is held, on foot)
    if (this.forest) this.forest.update(dt); // advance any felled-tree FallingBodies + debris (demo forest)
    if (this.demoBuilding && this.demoBuilding.update) this.demoBuilding.update(dt); // advance building destruction debris (demo)
    if (this.forestAtmos) this.forestAtmos.update(dt, this.player.pos, isNight(this._worldClock.minuteOfDay())); // ?map=forest motes
    if (this.arenaClocks) this.arenaClocks.update(dt); // arena: drive both spawn-side clocks from the world clock
    this.gramophone.update(dt); // gramophone props: record spin + distance volume + score duck
    this.dayNight.flash.intensity = (!this.player.mountedGun && this.inventory.isHoldingFlashlight() && this.dayNight.flashOn) ? 7 : 0; // flashlight beam = the flashlight is the held item
    if (sim) this.enemies.update(dt);
    this.loot.update(dt);
    if (sim) this._fxClock.advance(dt, this._stepFx); // status effects tick at a fixed 10 Hz; host/solo only (sim = hostSim && !freecam → also paused in freecam). Co-op clients tick via host broadcast (P3).
    if (!hostSim) this.enemies.updateGhostFx(dt); // clients advance host-relayed boss/tank attack visuals (they don't tick enemies.update)
    if (sim) this.waves.update(dt);
    this.mp.update(dt);
    this._updateAdaptiveMusic();
    // World clock advances every frame in every mode. Host/solo = authoritative (advances the truth + fires timed
    // transitions via _stepMinute); clients predict locally for smooth HH:MM and reconcile to the host's 'night' push.
    if (hostSim) this._worldClock.advance(dt, this._stepMinute);
    else this._worldClock.advance(dt);
    if (this.mode === 'longnight' && hostSim) this._surviveTime += dt; // run-duration record for the game-over screen (longnight only)
    this.dayNight.renderFrom(this._worldClock); // sky from minute-of-day + alpha (host + client)
    this.hud.setClock(this.dayNight.info(), this._worldClock);
    if (this.player.nightPost) this.player.nightPost.lateLight(); // AFTER DayNight applied its frame values: intensifier gain lifts the night scene
    this._updateFlares(dt);       // flare is a deployable gadget in EVERY mode → tick gravity/burn/smoke unconditionally (mirrors _updateMolotovPools), else a flare thrown in purge hangs in mid-air
    this._updateMolotovPools(dt);
    if (this.fire) this.fire.update(dt); // Phase 8: ember-chain spread + burn-through (own fixed clock; reads molotovPools as sources)
    if (hostSim) this.hud.setEnemiesLeft(this.waves.active ? this.waves.toSpawn + this.enemies.aliveCount : this.enemies.aliveCount); // clients get the authoritative count via 'clock'
    this.effects.update(dt);
    // ADS hides the crosshair so you aim down the iron sight, which is 1:1 with the shot. F3 keeps it
    // always-on as a safety fallback. Mounted-gun / night-post views manage their own reticle, so skip them.
    if (!this.player.mountedGun && !this.player.nightPost && this.hud.el.cross) {
      this.hud.el.cross.style.opacity = (!this.weapons.ads || this.f3) ? '' : '0';
    }
    this.hud.update(dt);
    // ---- Interact prompt priority: tank crew > mounted MG > loot ----
    if (this.mp.active && this.mp._localDead) {
      const rp = this.mp.ensureSpectateTarget();
      this.hud.setInteract(rp ? `Spectating <b>${rp.name}</b> · Q/E switch` : 'No live squadmate to spectate');
      return;
    }
    if (this.mp.active && this.mp._localDown) {
      const prog = this.mp._incomingRevive && performance.now() < this.mp._incomingRevive.until ? this.mp._incomingRevive : null;
      this.hud.setInteract(prog ? `Being revived: <b>${prog.clicks}/${prog.total}</b> clicks` : `DOWNED · bleed-out ${(this.mp._bleedT || 0).toFixed(0)}s`);
      return;
    }
    if (this.mp.active && this.mp._localWaiting) {
      this.hud.setInteract('WAITING · squad must survive');
      return;
    }
    if (this.mp.active && !this.mp.frozen && this.mp.reviveTargetNear) {
      const rp = this.mp.reviveTargetNear();
      if (rp) { this.hud.setInteract(this.mp.revivePrompt(rp)); return; }
    }
    const _nearMountedGun = this.nearestMountedGun(this.player.pos, (gun) => gun.updateNearby(this.player.pos));
    const _reloadGun = this.nearestMountedGun(this.player.pos, (gun) => gun.near(this.player.pos));
    const activeGun = this.player.mountedGun || _nearMountedGun || _reloadGun;
    const mgName = activeGun && activeGun.displayName ? activeGun.displayName : 'mounted gun';
    if (this.player.mountedGun) {
      this.hud.setInteract(`Press <b>E</b> to leave the ${mgName}`);
    } else if (this.player.nightPost) {
      this.hud.setInteract(''); // at the optic: the controls hint is self-contained in the NV overlay (#nvhint, timed fade)
    } else if (this.nearestNightPost()) {
      this.hud.setInteract('Press <b>E</b> to use the ННП-23 «Резчик» night observation post');
    } else if (this.player.mortar) {
      this.hud.setInteract(''); // at the mortar: the dial HUD is self-contained (#mortarpanel)
    } else if (this.nearestMortar()) {
      this.hud.setInteract(`Press <b>E</b> to man the 82-PM-37 mortar — ${this.nearestMortar().ammo} rounds · indirect fire`);
    } else if (this.inventory.isHoldingFiftyCan() && _reloadGun) {
      // holding the ammo can at the gun: refill, never mount (switch to a weapon to man it)
      this.hud.setInteract(_reloadGun.ammo >= _reloadGun.maxAmmo
        ? `${mgName} full — switch weapon to man it`
        : `Press <b>E</b> to refill the ${mgName}`);
    } else if (_nearMountedGun) {
      this.hud.setInteract(`Press <b>E</b> to man the ${mgName} — ${_nearMountedGun.maxAmmo} rounds, overheats`);
    } else if (this.player._splintT > 0) {
      this.hud.setInteract(`Applying splint… ${this.player._splintT.toFixed(1)}s`);
    } else if (this.world.gateTarget) {
      const _open = this.world._slideGate && this.world._slideGate.open;
      this.hud.setInteract('Press <b>E</b> to ' + (_open ? 'CLOSE' : 'OPEN') + ' the gate · ВОРОТА');
    } else if (this.world.doorTarget) {
      this.hud.setInteract('Press <b>E</b> to ' + (this.world.doorTarget.open ? 'ЗАКРЫТЬ' : 'ОТКРЫТЬ') + ' · ГЕРМОДВЕРЬ');
    } else if (this.build.radioTarget) {
      const _r = this.build.radioTarget;
      this.hud.setInteract(_r.on ? '←/→ stanice · <b>E</b> vypnout rádio' : 'Press <b>E</b> to turn on radio');
    } else if (this.gramophone.target) {
      this.hud.setInteract(this.gramophone.prompt(this.gramophone.target));
    } else if (this.loot.nearPickup) {
      this.hud.setInteract(this.loot.promptPickup());
    } else {
      this.hud.setInteract(this.loot.prompt);
    }
  }

  // Hide dynamic entities + terrain chunks + registered static decor beyond `d` metres of the camera; clamp
  // fog so the cull edge isn't visible. Cheap per-frame visibility toggles (no allocation).
  _cullByDistance(d) {
    const cam = this.engine.camera.position, d2 = d * d;
    const far = (p) => { const dx = p.x - cam.x, dz = p.z - cam.z; return dx * dx + dz * dz > d2; };
    if (this.enemies && this.enemies.active) for (const e of this.enemies.active) { if (e.mesh && e.pos) e.mesh.visible = !!e.alive && !far(e.pos); }
    if (this.loot && this.loot.pickups) for (const pu of this.loot.pickups) { if (pu.mesh) pu.mesh.visible = !far(pu.mesh.position); }
    if (this.world && this.world.cullProps) for (const m of this.world.cullProps) { if (m) { const ud = m.userData, dx = (ud._cullX != null ? ud._cullX : m.position.x) - cam.x, dz = (ud._cullZ != null ? ud._cullZ : m.position.z) - cam.z; m.visible = dx * dx + dz * dz <= d2; } } // cull by precomputed world centre (district meshes bake geometry in world coords → position is origin)
    if (this.world && this.world.chunks) this.world.chunks.drawDistance = d;
    if (this.engine.scene && this.engine.scene.fog) this.engine.scene.fog.far = Math.min(this.engine.scene.fog.far, d);
  }

  // Re-show every dynamic mesh the cull may have hidden. Called once when `_drawDist` drops back to 0 so the
  // feature is safe to toggle (DayNight re-expands fog.far on its own each frame; chunk drawDistance is reset
  // to 0 below so TerrainChunks.update re-shows chunks by frustum-only from the next frame).
  _restoreVisibility() {
    if (this.enemies && this.enemies.active) for (const e of this.enemies.active) { if (e.mesh) e.mesh.visible = !!e.alive; }
    if (this.loot && this.loot.pickups) for (const pu of this.loot.pickups) { if (pu.mesh) pu.mesh.visible = true; }
    if (this.world && this.world.cullProps) for (const m of this.world.cullProps) { if (m) m.visible = true; }
    if (this.world && this.world.chunks) this.world.chunks.drawDistance = 0; // clear cull radius (TerrainChunks.update re-shows next frame)
  }
}

window.addEventListener('DOMContentLoaded', () => { if (!window.GAME) window.GAME = new Game(); });
if (document.readyState !== 'loading' && !window.GAME) window.GAME = new Game();
