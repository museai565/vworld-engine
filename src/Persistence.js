import * as THREE from 'three';
import { toVec3, toNumber, withDefaults } from './util/normalize.js';
import { vError, reportError } from './util/errors.js';
import { buildPrefab } from './Prefabs.js';
import { reserveEntityIdsUpTo } from './Entity.js';
import { BUILTIN_FLUID_TYPES } from './Fluids.js';
import { BUILTIN_SURFACE_KIND_NAMES } from './Surfaces.js';

/**
 * World persistence & streaming (v0.8.0).
 *
 *   const data = world.save();            // versioned plain JSON
 *   localStorage.setItem('slot1', JSON.stringify(data));
 *   world.load(JSON.parse(localStorage.getItem('slot1')));
 *
 *   world.chunks({ size: 64, radius: 2, ...world.chunkProvider('props') });
 *
 * Design rules (same as the rest of the engine):
 * - Pure logic (migrations, validation, chunk math, record conversion) is
 *   DOM/THREE-scene-free and unit-tested in test/smoke.mjs.
 * - `world.load()` never throws away data it can't rebuild: unknown quest
 *   ids, missing terrain height functions, and custom-entity visuals are
 *   reported with warnings, not silent drops.
 * - Normalize, don't complain: every public method accepts every sensible
 *   input shape and throws a *helpful* coded error otherwise.
 */

// ---------------------------------------------------------------------------
// version + migrations
// ---------------------------------------------------------------------------

/** Current save-data version. Bump with a migration entry when the schema changes. */
export const SAVE_VERSION = 8;

/**
 * Migration functions: MIGRATIONS[N] upgrades a v(N-1) save to vN.
 * Each returns a new object (never mutates its input).
 */
export const MIGRATIONS = {
  2: (d) => ({ ...d, version: 2, terrain: d.terrain ?? null }),
  3: (d) => ({
    ...d, version: 3,
    surfaces: d.surfaces ?? [], fluidTypes: d.fluidTypes ?? [], fluids: d.fluids ?? [],
  }),
  4: (d) => ({ ...d, version: 4, water: d.water ?? null, dayNight: d.dayNight ?? null }),
  5: (d) => ({ ...d, version: 5, quests: d.quests ?? [] }),
  6: (d) => ({ ...d, version: 6, pickups: d.pickups ?? [] }),
  7: (d) => ({ ...d, version: 7, weather: d.weather ?? null }),
  8: (d) => ({
    ...d, version: 8,
    ground: d.ground ?? null,
    entities: (d.entities ?? []).map(normalizeEntityRecord),
  }),
};

/**
 * Validate a save-data object. Throws VWORLD/BAD_SAVE for wrong shapes,
 * VWORLD/SAVE_TOO_NEW when it was written by a newer engine,
 * VWORLD/SAVE_CORRUPT for internally inconsistent data.
 */
export function validateSave(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw vError(
      'VWORLD/BAD_SAVE',
      `[VWorld] world.load() needs a save object — got ${data === null ? 'null' : Array.isArray(data) ? 'an array' : typeof data}. Produce one with world.save().`
    );
  }
  const v = data.version;
  if (!Number.isInteger(v) || v < 1) {
    throw vError(
      'VWORLD/BAD_SAVE',
      `[VWorld] Save data needs an integer version >= 1 — got ${JSON.stringify(v)}.`
    );
  }
  if (v > SAVE_VERSION) {
    throw vError(
      'VWORLD/SAVE_TOO_NEW',
      `[VWorld] This save is v${v} but the engine only understands up to v${SAVE_VERSION} — update @vworld/engine to load it.`
    );
  }
  if (data.entities !== undefined && !Array.isArray(data.entities)) {
    throw vError('VWORLD/SAVE_CORRUPT', '[VWorld] Save data "entities" must be an array.');
  }
  return true;
}

/**
 * Upgrade a validated save to the current version (pure). Warns once when an
 * upgrade actually happened.
 */
export function migrateSave(data) {
  validateSave(data);
  let d = { ...data };
  const from = d.version;
  while (d.version < SAVE_VERSION) {
    const fn = MIGRATIONS[d.version + 1];
    if (typeof fn !== 'function') {
      throw vError('VWORLD/SAVE_CORRUPT', `[VWorld] No migration from save v${d.version} — the data is corrupt.`);
    }
    d = fn(d);
  }
  if (from < SAVE_VERSION) {
    console.warn(`[VWorld] Save data upgraded v${from} → v${SAVE_VERSION}.`);
  }
  return d;
}

/**
 * Normalize one entity record to the full v8 shape (pure). Used by the v8
 * migration and by load() for forward tolerance of hand-written saves.
 */
export function normalizeEntityRecord(rec = {}) {
  const r = rec && typeof rec === 'object' ? rec : {};
  const t = r.transform ?? {};
  return {
    id: typeof r.id === 'string' ? r.id : null,
    prefab: typeof r.prefab === 'string' ? r.prefab : null,
    variant: Number.isFinite(+r.variant) ? Math.max(0, Math.floor(+r.variant)) : 0,
    props: r.props && typeof r.props === 'object' ? { ...r.props } : {},
    transform: {
      p: Array.isArray(t.p) && t.p.length === 3 ? t.p.map(Number) : [0, 0, 0],
      q: Array.isArray(t.q) && t.q.length === 4 ? t.q.map(Number) : [0, 0, 0, 1],
      s: Array.isArray(t.s) && t.s.length === 3 ? t.s.map(Number) : [1, 1, 1],
    },
    tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
    inventory: Array.isArray(r.inventory) ? r.inventory.map((s) => ({ item: String(s.item), qty: Math.max(0, Math.floor(+s.qty || 0)) })) : null,
    health: r.health && typeof r.health === 'object'
      ? { hp: Math.max(0, +r.health.hp || 0), max: Math.max(1, +r.health.max || 100) }
      : null,
  };
}

// ---------------------------------------------------------------------------
// record conversion (duck-typed — works with real Entities and test fakes)
// ---------------------------------------------------------------------------

/** Convert a live entity to a plain save record (reads only, never mutates). */
export function entityToRecord(e) {
  const o = e.object;
  const inv = e._inventory;
  const hp = e._health;
  return {
    id: e.id ?? null,
    prefab: e._prefab?.name ?? null,
    variant: e._prefab?.variant ?? 0,
    props: { ...(e._saveProps ?? {}) },
    transform: {
      p: [o.position.x, o.position.y, o.position.z],
      q: [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w],
      s: [o.scale.x, o.scale.y, o.scale.z],
    },
    tags: typeof e.tags !== 'undefined' ? [...e.tags] : [],
    inventory: inv && typeof inv.list === 'function' ? inv.list() : null,
    health: hp ? { hp: hp.hp, max: hp.max } : null,
  };
}

/**
 * Apply a (normalized) record to an entity: transform, tags, saved props,
 * inventory, health. Prefab visuals are expected to already exist.
 */
export function applyRecordToEntity(e, rec) {
  const r = normalizeEntityRecord(rec);
  const t = r.transform;
  if (typeof e.applySnapshot === 'function') e.applySnapshot({ p: t.p, q: t.q, s: t.s });
  for (const tag of r.tags) {
    if (typeof e.tag === 'function' && tag !== 'prefab' && !tag.startsWith('prefab:')) e.tag(tag);
  }
  if (Object.keys(r.props).length && typeof e.saveProps === 'function') e.saveProps(r.props);
  if (r.inventory && typeof e.inventory === 'function') e.inventory().restore(r.inventory);
  if (r.health && typeof e.health === 'function') e.health().restore(r.health);
  return e;
}

// ---------------------------------------------------------------------------
// serialize — world -> save data
// ---------------------------------------------------------------------------

function fluidToRecord(f) {
  const base = BUILTIN_FLUID_TYPES[f.type] ?? {};
  const overrides = {};
  for (const [k, v] of Object.entries(f.def ?? {})) {
    if (!(k in base) || base[k] !== v) overrides[k] = v;
  }
  const b = f.box;
  return {
    name: f.name,
    type: f.type,
    box: [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z],
    flow: [f.flow.x, f.flow.z],
    overrides,
  };
}

function pickupToRecord(p) {
  const c = p.center;
  return {
    kind: p.kind,
    at: [c.x, c.y, c.z],
    radius: p.radius,
    item: p.item,
    amount: p.amount,
    heal: p.heal,
    respawn: p.respawn,
    active: p.active,
  };
}

/**
 * Serialize the whole world to a versioned plain-JSON object.
 * Entities tagged 'nosave' (ground, pickup visuals, ghosts) are skipped —
 * their configs are captured in the dedicated sections instead.
 */
export function serializeWorld(engine, options = {}) {
  const world = engine.world;
  const data = {
    version: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    entities: [],
    ground: world._ground ? { ...world._ground } : null,
    terrain: null,
    water: null,
    surfaces: [],
    fluidTypes: [],
    fluids: [],
    dayNight: null,
    weather: null, // reserved for v0.9.0
    quests: [],
    pickups: [],
  };

  const t = world._terrain;
  if (t) {
    data.terrain = {
      size: t.size,
      resolution: t.resolution,
      surface: t.surface ? t.surface.rules.map((r) => ({ ...r })) : null,
    };
  }

  const wtr = world._water;
  if (wtr) {
    data.water = {
      level: wtr.level,
      color: wtr.mat.uniforms.uColor.value.getHex(),
      waves: wtr.mat.uniforms.uWaves.value,
      opacity: wtr.mat.uniforms.uOpacity.value,
      size: wtr.mesh.geometry.parameters.width,
    };
  }

  for (const name of world._surfaces.names()) {
    if (BUILTIN_SURFACE_KIND_NAMES.includes(name)) continue;
    const k = world._surfaces.get(name);
    data.surfaces.push({ name, color: k.color, roughness: k.roughness });
    if (k.texture) console.warn(`[VWorld] Surface kind "${name}" has a texture, which can't be serialized — saving color/roughness only.`);
  }

  for (const [name, def] of world._fluidSystem.types) {
    if (BUILTIN_FLUID_TYPES[name]) continue;
    data.fluidTypes.push({ name, def: { ...def } });
  }
  data.fluids = world.fluids.map(fluidToRecord);

  const dn = world._dayNight;
  if (dn) data.dayNight = { t: dn.t, dayLength: dn.dayLength, enabled: dn.enabled };

  if (engine._quests) data.quests = engine._quests.list();

  data.pickups = world._pickups.map(pickupToRecord);

  for (const e of engine._liveEntities) {
    if (e._disposed) continue;
    if (typeof e.hasTag === 'function' && e.hasTag('nosave')) continue;
    data.entities.push(entityToRecord(e));
  }

  void options;
  return data;
}

// ---------------------------------------------------------------------------
// restore — save data -> world
// ---------------------------------------------------------------------------

/** Clear restorable world content. Internal — used by load({ clear: true }). */
function clearWorld(engine) {
  const world = engine.world;
  for (const e of [...engine._liveEntities]) {
    try { e.dispose(); } catch (err) { reportError(engine, err); }
  }
  for (const f of [...world.fluids]) {
    try { f.destroy(); } catch (err) { reportError(engine, err); }
  }
  for (const p of [...world._pickups]) {
    try { p.dispose(); } catch (err) { reportError(engine, err); }
  }
  if (world._terrain) {
    try {
      world.engine.scene.remove(world._terrain.mesh);
      world._terrain.mesh.geometry.dispose();
      world._terrain.mesh.material.dispose();
    } catch (err) { reportError(engine, err); }
    world._terrain = null;
  }
  if (world._water) {
    try {
      world.engine.scene.remove(world._water.mesh);
      world._water.mesh.geometry.dispose();
      world._water.mat.dispose();
    } catch (err) { reportError(engine, err); }
    world._water = null;
    world._waterLevel = -Infinity;
  }
  world._ground = null;
}

/**
 * Restore a world from save data (validated + migrated first).
 *
 *   world.load(data);                              // clears, then restores
 *   world.load(data, { clear: false });            // additive restore
 *   world.load(data, { height: (x, z) => hills }); // terrain relief — height
 *                                                  // functions can't be serialized
 *   world.load(data, { onEntity: (rec, entity) => attachVisuals(rec, entity) });
 *
 * Non-prefab entities restore transform/tags/props/inventory/health; their
 * visuals must be (re)built by game code via `onEntity` (or by making them
 * prefabs with world.registerPrefab()). Returns the world.
 */
export function restoreWorld(engine, data, options = {}) {
  const o = withDefaults(options, { clear: true, height: null, onEntity: null });
  const d = migrateSave(data); // validates + upgrades
  const world = engine.world;

  if (o.clear) clearWorld(engine);

  // Custom surface kinds + fluid types first — terrain/fluids reference them.
  for (const s of d.surfaces ?? []) {
    try { world.surfaceKind(s.name, { color: s.color, roughness: s.roughness }); }
    catch (err) { reportError(engine, err); }
  }
  for (const ft of d.fluidTypes ?? []) {
    try { world.fluidType(ft.name, ft.def); }
    catch (err) { reportError(engine, err); }
  }

  if (d.ground) {
    try { world.ground(d.ground); }
    catch (err) { reportError(engine, err); }
  }

  if (d.terrain) {
    if (typeof o.height !== 'function') {
      console.warn('[VWorld] Save has terrain but no `height` function was passed to world.load() — restoring flat. Pass { height: (x, z) => ... }.');
    }
    try {
      world.terrain({
        size: d.terrain.size,
        resolution: d.terrain.resolution,
        height: o.height ?? (() => 0),
        surface: d.terrain.surface,
      });
    } catch (err) { reportError(engine, err); }
  }

  if (d.water) {
    try { world.water(d.water); }
    catch (err) { reportError(engine, err); }
  }

  for (const f of d.fluids ?? []) {
    try {
      world.fluid({
        name: f.name, type: f.type,
        box: { min: f.box.slice(0, 3), max: f.box.slice(3, 6) },
        flow: f.flow, ...(f.overrides ?? {}),
      });
    } catch (err) { reportError(engine, err); }
  }

  if (d.dayNight) {
    try {
      const dn = world.dayNight().time(d.dayNight.t).speed(d.dayNight.dayLength);
      if (d.dayNight.enabled === false) dn.pause(); else dn.resume();
    } catch (err) { reportError(engine, err); }
  }

  // Quests: definitions restore (rewards are functions — game code should
  // re-define quests with rewards *before* load to keep them; otherwise they
  // restore reward-less with a warning).
  if ((d.quests ?? []).length && engine._quests) {
    try { engine._quests.restore(d.quests); }
    catch (err) { reportError(engine, err); }
  } else if ((d.quests ?? []).length && !engine._quests) {
    // quests() is lazy — create it so state isn't lost.
    try { engine.quests().restore(d.quests); }
    catch (err) { reportError(engine, err); }
  }

  let maxId = 0;
  for (const rec of d.entities ?? []) {
    try {
      const r = normalizeEntityRecord(rec);
      let e;
      if (r.prefab) e = buildPrefab(world, r.prefab, { variant: r.variant });
      else e = engine.entity();
      if (r.id) {
        e.id = r.id;
        const m = /^entity_(\d+)$/.exec(r.id);
        if (m) maxId = Math.max(maxId, +m[1]);
      }
      applyRecordToEntity(e, r);
      if (typeof o.onEntity === 'function') {
        try { o.onEntity(r, e); } catch (err) { reportError(engine, err); }
      }
    } catch (err) { reportError(engine, err); }
  }
  if (maxId > 0) reserveEntityIdsUpTo(maxId);

  for (const p of d.pickups ?? []) {
    try {
      const pk = world.pickup({
        kind: p.kind, at: p.at, radius: p.radius,
        item: p.item, amount: p.amount, heal: p.heal, respawn: p.respawn,
      });
      if (p.active === false) { pk.active = false; pk._timer = pk.respawn; }
    } catch (err) { reportError(engine, err); }
  }

  return world;
}

// ---------------------------------------------------------------------------
// chunk math (pure)
// ---------------------------------------------------------------------------

/** Which chunk contains world point (x, z)? */
export function chunkIndex(x, z, size) {
  const s = Math.max(0.001, toNumber(size, 'size'));
  return { cx: Math.floor(toNumber(x, 'x') / s), cz: Math.floor(toNumber(z, 'z') / s) };
}

/** Stable string key for a chunk coordinate. */
export function chunkKey(cx, cz) {
  return `${Math.floor(cx)},${Math.floor(cz)}`;
}

/** Parse a chunk key back to coordinates. */
export function parseChunkKey(key) {
  const m = /^(-?\d+),(-?\d+)$/.exec(String(key));
  if (!m) throw vError('VWORLD/BAD_CHUNK_KEY', `[VWorld] Bad chunk key "${key}" — expected "cx,cz".`);
  return { cx: +m[1], cz: +m[2] };
}

/** World-space bounds of a chunk: { minX, maxX, minZ, maxZ, center: [x, 0, z] }. */
export function chunkBounds(cx, cz, size) {
  const s = Math.max(0.001, toNumber(size, 'size'));
  const minX = cx * s, minZ = cz * s;
  return { minX, maxX: minX + s, minZ, maxZ: minZ + s, center: [minX + s / 2, 0, minZ + s / 2] };
}

/** All chunk coords in a Chebyshev square of `radius` around (cx, cz). */
export function chunksAround(cx, cz, radius) {
  const r = Math.max(0, Math.floor(toNumber(radius, 'radius')));
  const out = [];
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      out.push({ cx: cx + dx, cz: cz + dz, key: chunkKey(cx + dx, cz + dz) });
    }
  }
  return out;
}

/** Diff two key sets: { added: [...keys], removed: [...keys] } (pure). */
export function diffChunkSets(prev, next) {
  const p = new Set(prev), n = new Set(next);
  return {
    added: [...n].filter((k) => !p.has(k)),
    removed: [...p].filter((k) => !n.has(k)),
  };
}

/** djb2 string hash -> uint32 (stable across sessions — seeds chunk RNG). */
export function hashChunkKey(key) {
  let h = 5381;
  const s = String(key);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Deterministic PRNG (mulberry32). Same seed -> same sequence. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Resolve the chunk center: 'camera' (default) | Entity | [x, z] | { x, z } |
 * () => any-of-those. Returns { x, z }.
 */
export function resolveChunkCenter(center, world) {
  const c = center ?? 'camera';
  if (typeof c === 'function') return resolveChunkCenter(c(), world);
  if (c === 'camera') {
    const p = world.engine.camera?.position;
    return p ? { x: p.x, z: p.z } : { x: 0, z: 0 };
  }
  if (Array.isArray(c)) return { x: toNumber(c[0], 'center[0]'), z: toNumber(c[2] ?? c[1], 'center[1]') };
  if (c && typeof c === 'object') {
    const pos = c.object?.position ?? c.position ?? c;
    return { x: toNumber(pos.x ?? 0, 'center.x'), z: toNumber(pos.z ?? 0, 'center.z') };
  }
  throw vError('VWORLD/BAD_CHUNK_CENTER', "[VWorld] chunks() center must be 'camera', an Entity, [x, z], { x, z }, or a function returning one.");
}

// ---------------------------------------------------------------------------
// ChunkManager — distance-based streaming
// ---------------------------------------------------------------------------

/**
 * Streams chunk content by distance to a center point (camera by default).
 *
 *   const stream = world.chunks({
 *     size: 64, radius: 2,                       // 5x5 chunks around center
 *     ...world.chunkProvider('props'),           // default prop scatter
 *     // ...or custom:
 *     // load: (chunk) => { ... return handle; },
 *     // unload: (chunk, handle) => { ... },
 *   });
 *   stream.on('chunk:load', (chunk) => console.log('in', chunk.key));
 *   stream.on('chunk:unload', (chunk) => console.log('out', chunk.key));
 *   stream.recheck();   // force an immediate pass
 *   stream.dispose();   // unload everything, stop ticking
 *
 * `chunk` = { cx, cz, key, minX, maxX, minZ, maxZ, center: [x, 0, z] }.
 * `load` returns an opaque handle passed back to `unload`.
 */
export class ChunkManager {
  constructor(world, options = {}) {
    const o = withDefaults(options, {
      size: 64, radius: 2, center: 'camera', interval: 0.5, load: null, unload: null,
    });
    this.world = world;
    this.engine = world.engine;
    this._size = Math.max(1, toNumber(o.size, 'size'));
    this._radius = Math.max(0, Math.floor(toNumber(o.radius, 'radius')));
    this._center = o.center;
    this._interval = Math.max(0.01, toNumber(o.interval, 'interval'));
    if (typeof o.load !== 'function') {
      throw vError('VWORLD/BAD_CHUNKS', '[VWorld] world.chunks() needs a `load(chunk)` function — or spread world.chunkProvider("props") for the default.');
    }
    this._load = o.load;
    this._unload = typeof o.unload === 'function' ? o.unload : () => {};
    this._loaded = new Map(); // key -> { chunk, handle }
    this._listeners = new Map();
    this._timer = this._interval; // first update() rechecks immediately
    this._disposed = false;
    this._tickFn = (dt) => this.update(dt);
    if (this.engine) this.engine.onUpdate(this._tickFn);
  }

  on(event, fn) {
    if (!['chunk:load', 'chunk:unload'].includes(String(event))) {
      throw vError('VWORLD/UNKNOWN_EVENT', `[VWorld] ChunkManager.on() — unknown event "${event}". Try: chunk:load, chunk:unload.`);
    }
    if (typeof fn !== 'function') throw vError('VWORLD/BAD_HANDLER', '[VWorld] ChunkManager.on(event, fn) — fn must be a function.');
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return this;
  }

  off(event, fn) {
    this._listeners.get(String(event))?.delete(fn);
    return this;
  }

  _emit(event, chunk) {
    for (const fn of this._listeners.get(event) ?? []) {
      try { fn(chunk); } catch (err) { reportError(this.engine, err); }
    }
  }

  /** Loaded chunk keys. */
  get keys() { return [...this._loaded.keys()]; }

  /** Number of loaded chunks. */
  get count() { return this._loaded.size; }

  /** Advance the recheck timer (called by the engine loop). */
  update(dt) {
    if (this._disposed) return;
    this._timer += dt;
    if (this._timer >= this._interval) {
      this._timer = 0;
      this.recheck();
    }
  }

  /** Run one load/unload pass immediately. Chainable. */
  recheck() {
    if (this._disposed) return this;
    const { x, z } = resolveChunkCenter(this._center, this.world);
    const { cx, cz } = chunkIndex(x, z, this._size);
    const want = new Set(chunksAround(cx, cz, this._radius).map((c) => c.key));
    const { added, removed } = diffChunkSets(this._loaded.keys(), want);

    for (const key of removed) {
      const rec = this._loaded.get(key);
      this._loaded.delete(key);
      try { this._unload(rec.chunk, rec.handle); }
      catch (err) { reportError(this.engine, err); }
      this._emit('chunk:unload', rec.chunk);
    }
    for (const key of added) {
      const { cx: ax, cz: az } = parseChunkKey(key);
      const chunk = { cx: ax, cz: az, key, ...chunkBounds(ax, az, this._size) };
      let handle = null;
      try {
        handle = this._load(chunk);
      } catch (err) {
        reportError(this.engine, err);
        continue; // retry on the next pass
      }
      this._loaded.set(key, { chunk, handle });
      this._emit('chunk:load', chunk);
    }
    return this;
  }

  /** Unload every chunk and stop ticking. Chainable. Idempotent. */
  dispose() {
    if (this._disposed) return this;
    this._disposed = true;
    if (this.engine && this._tickFn) {
      try { this.engine.offUpdate(this._tickFn); } catch { /* already gone */ }
      this._tickFn = null;
    }
    for (const [, rec] of this._loaded) {
      try { this._unload(rec.chunk, rec.handle); } catch (err) { reportError(this.engine, err); }
    }
    this._loaded.clear();
    this._listeners.clear();
    return this;
  }
}

/**
 * Default chunk content providers.
 *
 *   world.chunks({ size: 64, radius: 2, ...world.chunkProvider('props') });
 *   world.chunks({ size: 64, radius: 2,
 *     ...world.chunkProvider('props', { kinds: ['pineTree', 'oakTree'], perChunk: 30 }) });
 *
 * 'props' scatters prefabs deterministically per chunk (same seed every
 * session — no pop-in variance), disposing them on unload.
 */
export function defaultChunkProvider(world, kind = 'props', options = {}) {
  if (kind !== 'props' && kind !== 'scatter') {
    throw vError(
      'VWORLD/UNKNOWN_CHUNK_PROVIDER',
      `[VWorld] Unknown chunk provider "${kind}". Try 'props' — or pass your own { load, unload }.`
    );
  }
  const o = withDefaults(options, { kinds: ['pineTree', 'rock'], perChunk: 24, yOffset: 0 });
  const kinds = Array.isArray(o.kinds) ? o.kinds : [o.kinds];
  const perChunk = Math.max(0, Math.floor(toNumber(o.perChunk, 'perChunk')));
  const yOffset = toNumber(o.yOffset, 'yOffset');
  return {
    load(chunk) {
      const rng = mulberry32(hashChunkKey(chunk.key));
      const placed = [];
      for (let i = 0; i < perChunk; i++) {
        const name = kinds[Math.floor(rng() * kinds.length) % kinds.length];
        const x = chunk.minX + rng() * (chunk.maxX - chunk.minX);
        const z = chunk.minZ + rng() * (chunk.maxZ - chunk.minZ);
        const y = world.groundHeight(x, z) + yOffset;
        try {
          const e = buildPrefab(world, name, { at: [x, y, z] });
          e.rotateY(rng() * Math.PI * 2);
          e.scale(0.7 + rng() * 0.8);
          placed.push(e);
        } catch (err) {
          reportError(world.engine, err);
        }
      }
      return placed;
    },
    unload(chunk, handle) {
      for (const e of handle ?? []) {
        try { e.dispose(); } catch (err) { reportError(world.engine, err); }
      }
      void chunk;
    },
  };
}
