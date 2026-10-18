/**
 * Net — multiplayer netcode (v0.6.0).
 *
 * Still no transport ships in the engine (the game layer owns its socket),
 * but everything *around* the transport is real now:
 *
 *   - Client-side prediction + server reconciliation (`net.predict`,
 *     `net.correct`) so local movement feels instant at any ping.
 *   - Entity interpolation (`net.interpolate`) for smooth remote movement.
 *   - Lag compensation (`net.rewind`) — rewind entity positions to a
 *     timestamp for fair server-side hit tests.
 *   - Interest management (`net.interest`) — replicate only what's relevant.
 *   - Bandwidth savers (`net.delta`, `net.quantize`, `net.prioritize`).
 *
 * The math is pure (plain arrays, no THREE import) and exported for tests:
 * `applyNetInput`, `reconcileNetState`, `sampleSnapshots`, `rewindEntities`,
 * `quantizeSnap`, `dequantizeSnap`, `deltaSnap`, `applyDeltaSnap`,
 * `prioritizeUpdates`, `isRelevant`, `normalizeNetInput`.
 *
 * Wire format stays `{ id, p:[x,y,z], q:[x,y,z,w], s:[x,y,z] }` via
 * `entity.serialize()` / `entity.applySnapshot()`.
 */

// ---------------------------------------------------------------------------
// small pure helpers
// ---------------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function withDefaults(options = {}, defaults = {}) {
  const out = { ...defaults };
  if (options && typeof options === 'object') {
    for (const [k, v] of Object.entries(options)) {
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}

/** Read a world position as [x,y,z] from any sensible shape. No THREE needed. */
function posOf(v) {
  if (!v || typeof v !== 'object') throw new Error('[VWorld] expected a position-like value.');
  if (Array.isArray(v)) {
    if (v.length >= 3) return [+v[0], +v[1], +v[2]];
    throw new Error('[VWorld] position array needs 3 numbers.');
  }
  if (v.object && v.object.position) {
    const p = v.object.position;
    return [+p.x, +p.y, +p.z];
  }
  if (typeof v.x === 'number' && typeof v.z === 'number') {
    return [+v.x, typeof v.y === 'number' ? +v.y : 0, +v.z];
  }
  if (v.p && Array.isArray(v.p)) return [+v.p[0], +v.p[1], +v.p[2]];
  throw new Error('[VWorld] cannot read a position from the given value — pass [x,y,z], {x,y,z}, {p:[x,y,z]}, or an Entity.');
}

const lerp = (a, b, t) => a + (b - a) * t;

/** Quaternion slerp on plain [x,y,z,w] arrays. */
export function quatSlerp(q0, q1, t) {
  let [x0, y0, z0, w0] = q0;
  let [x1, y1, z1, w1] = q1;
  let dot = x0 * x1 + y0 * y1 + z0 * z1 + w0 * w1;
  if (dot < 0) {
    dot = -dot;
    x1 = -x1; y1 = -y1; z1 = -z1; w1 = -w1;
  }
  if (dot > 0.9995) {
    // nearly identical — plain lerp + normalize
    const out = [lerp(x0, x1, t), lerp(y0, y1, t), lerp(z0, z1, t), lerp(w0, w1, t)];
    const l = Math.hypot(...out) || 1;
    return out.map((c) => c / l);
  }
  const th = Math.acos(clamp(dot, -1, 1));
  const s = Math.sin(th);
  const a = Math.sin((1 - t) * th) / s;
  const b = Math.sin(t * th) / s;
  return [a * x0 + b * x1, a * y0 + b * y1, a * z0 + b * z1, a * w0 + b * w1];
}

// ---------------------------------------------------------------------------
// input normalization
// ---------------------------------------------------------------------------

const WORD_DIRS = {
  forward: [0, -1], back: [0, 1], left: [-1, 0], right: [1, 0],
  up: [0, -1], down: [0, 1], // aliases
};

/**
 * Normalize any movement-input shape into `{ move: { x, z }, jump, sprint }`.
 *
 * Accepts: undefined/null (idle) | 'forward' | 'back' | 'left' | 'right' |
 * `[x, z]` | `{ x, z }` | `{ move: [x,z] | {x,z}, jump, sprint }`.
 * World-space: +x east, -z "north" (three.js forward).
 */
export function normalizeNetInput(input) {
  const out = { move: { x: 0, z: 0 }, jump: false, sprint: false };
  if (input === undefined || input === null) return out;
  const takeMove = (m) => {
    if (Array.isArray(m) && m.length >= 2) return { x: +m[0] || 0, z: +m[1] || 0 };
    if (m && typeof m === 'object' && typeof m.x === 'number' && typeof m.z === 'number') {
      return { x: +m.x || 0, z: +m.z || 0 };
    }
    throw new Error('[VWorld] move must be [x,z] or {x,z}.');
  };
  if (typeof input === 'string') {
    const d = WORD_DIRS[input.trim().toLowerCase()];
    if (!d) throw new Error(`[VWorld] unknown move word "${input}" — use forward/back/left/right.`);
    out.move = { x: d[0], z: d[1] };
    return out;
  }
  if (Array.isArray(input)) {
    out.move = takeMove(input);
    return out;
  }
  if (typeof input === 'object') {
    if (input.move !== undefined) out.move = takeMove(input.move);
    else if (typeof input.x === 'number' || typeof input.z === 'number') {
      out.move = { x: +input.x || 0, z: +input.z || 0 };
    }
    out.jump = !!input.jump;
    out.sprint = !!input.sprint;
    return out;
  }
  throw new Error('[VWorld] input must be a move word, [x,z], {x,z}, or { move, jump, sprint }.');
}

// ---------------------------------------------------------------------------
// prediction + reconciliation (pure)
// ---------------------------------------------------------------------------

export const PREDICT_DEFAULTS = {
  speed: 6, accel: 40, friction: 12, gravity: 22, jumpSpeed: 8, minY: 0, sprintMul: 1.6,
};

/**
 * Advance a predicted character state by one input sample. Pure.
 *
 * `state` = `{ p:[x,y,z], v:[x,y,z], grounded }`. Returns a fresh state.
 * Arcade mover: horizontal velocity eases toward the wish direction, gravity
 * pulls down, `minY` is the floor. Pass camera-relative input already
 * transformed to world space.
 */
export function applyNetInput(state, input, dt, opts = {}) {
  const o = withDefaults(opts, PREDICT_DEFAULTS);
  const ni = normalizeNetInput(input);
  const p = [state.p[0], state.p[1], state.p[2]];
  const v = [state.v[0], state.v[1], state.v[2]];
  let grounded = !!state.grounded;

  let mx = ni.move.x, mz = ni.move.z;
  const ml = Math.hypot(mx, mz);
  if (ml > 1) { mx /= ml; mz /= ml; }
  const wish = o.speed * (ni.sprint ? o.sprintMul : 1);
  const rate = (ml > 0.001 ? o.accel : o.friction) * dt;
  v[0] += clamp(mx * wish - v[0], -rate * wish, rate * wish);
  v[2] += clamp(mz * wish - v[2], -rate * wish, rate * wish);

  if (ni.jump && grounded) {
    v[1] = o.jumpSpeed;
    grounded = false;
  }
  v[1] -= o.gravity * dt;

  p[0] += v[0] * dt;
  p[1] += v[1] * dt;
  p[2] += v[2] * dt;
  if (p[1] <= o.minY) {
    p[1] = o.minY;
    if (v[1] < 0) v[1] = 0;
    grounded = true;
  }
  return { p, v, grounded };
}

/**
 * Server reconciliation. Pure.
 *
 * Snaps to the authoritative state, then re-applies the still-unacknowledged
 * inputs in sequence order. `pendingInputs` = `[{ seq, input }]`.
 * Returns `{ state, applied }` where `applied` lists the re-applied seqs.
 */
export function reconcileNetState(authoritative, pendingInputs, dt, opts = {}) {
  let state = {
    p: [...authoritative.p],
    v: authoritative.v ? [...authoritative.v] : [0, 0, 0],
    grounded: authoritative.grounded !== undefined ? !!authoritative.grounded : true,
  };
  const ordered = [...pendingInputs].sort((a, b) => a.seq - b.seq);
  const applied = [];
  for (const { seq, input } of ordered) {
    state = applyNetInput(state, input, dt, opts);
    applied.push(seq);
  }
  return { state, applied };
}

// ---------------------------------------------------------------------------
// interpolation + rewind (pure)
// ---------------------------------------------------------------------------

/**
 * Normalize a snapshot into `{ t, ents }` where
 * `ents = { id: { p:[x,y,z], q:[x,y,z,w] } }`.
 * Accepts: `{ t, ents }` | `{ t, id, p, q }` | `{ t, list:[{id,p,q}] }`.
 */
export function normalizeSnapshot(snap) {
  if (!snap || typeof snap.t !== 'number') {
    throw new Error('[VWorld] snapshot needs a numeric `t` (ms timestamp).');
  }
  if (snap.ents && typeof snap.ents === 'object') return { t: snap.t, ents: snap.ents };
  if (snap.id !== undefined) {
    return { t: snap.t, ents: { [snap.id]: { p: snap.p, q: snap.q } } };
  }
  if (Array.isArray(snap.list)) {
    const ents = {};
    for (const e of snap.list) ents[e.id] = { p: e.p, q: e.q };
    return { t: snap.t, ents };
  }
  throw new Error('[VWorld] snapshot needs `ents`, `{id,p,q}`, or `list`.');
}

function bracketAt(samples, t) {
  // samples sorted by .t; returns [before, after] indices (may be equal at ends)
  let lo = 0, hi = samples.length - 1;
  if (t <= samples[0].t) return [0, 0];
  if (t >= samples[hi].t) return [hi, hi];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid; else hi = mid;
  }
  return [lo, hi];
}

/**
 * Sample interpolated entity transforms at `renderTime` from a snapshot
 * buffer. Pure. Positions lerp, quaternions slerp; times outside the buffer
 * hold the nearest end. Returns `{ id: { p:[x,y,z], q:[x,y,z,w] } }`.
 */
export function sampleSnapshots(buffer, renderTime) {
  if (!buffer.length) return {};
  const buf = [...buffer].sort((a, b) => a.t - b.t);
  const [i0, i1] = bracketAt(buf, renderTime);
  const a = buf[i0], b = buf[i1];
  const span = b.t - a.t;
  const t = span > 0 ? (renderTime - a.t) / span : 0;
  const out = {};
  const ids = new Set([...Object.keys(a.ents), ...Object.keys(b.ents)]);
  for (const id of ids) {
    const ea = a.ents[id] || b.ents[id];
    const eb = b.ents[id] || a.ents[id];
    const pa = ea.p, pb = eb.p;
    out[id] = {
      p: [lerp(pa[0], pb[0], t), lerp(pa[1], pb[1], t), lerp(pa[2], pb[2], t)],
      q: ea.q && eb.q ? quatSlerp(ea.q, eb.q, t) : (ea.q || eb.q || [0, 0, 0, 1]),
    };
  }
  return out;
}

/**
 * Lag compensation: interpolate entity *positions* at an exact timestamp
 * from a history buffer. Pure. `history` = sorted `[{ t, ents }]`,
 * `ents` values accept `{ p }` or bare `[x,y,z]`. Returns `{ id: { p } }`.
 */
export function rewindEntities(history, timestamp) {
  if (!history.length) return {};
  const buf = [...history].sort((a, b) => a.t - b.t);
  const [i0, i1] = bracketAt(buf, timestamp);
  const a = buf[i0], b = buf[i1];
  const span = b.t - a.t;
  const t = span > 0 ? (timestamp - a.t) / span : 0;
  const pos = (e) => (Array.isArray(e) ? e : e.p);
  const out = {};
  const ids = new Set([...Object.keys(a.ents), ...Object.keys(b.ents)]);
  for (const id of ids) {
    const pa = pos(a.ents[id] ?? b.ents[id]);
    const pb = pos(b.ents[id] ?? a.ents[id]);
    out[id] = { p: [lerp(pa[0], pb[0], t), lerp(pa[1], pb[1], t), lerp(pa[2], pb[2], t)] };
  }
  return out;
}

// ---------------------------------------------------------------------------
// bandwidth: quantization + delta compression (pure)
// ---------------------------------------------------------------------------

export const QUANTIZE_DEFAULTS = { posBits: 16, posRange: 512, quatBits: 10 };

/**
 * Quantize a wire snapshot for the wire. Positions become fixed-point ints
 * over ±posRange; quaternions use smallest-three encoding. Scale passes
 * through at 3 decimals. Pure. Returns `{ id, p:[i,j,k], q:[i,j,k,idx,sign], s }`.
 */
export function quantizeSnap(snap, opts = {}) {
  const o = withDefaults(opts, QUANTIZE_DEFAULTS);
  const qn = (v) => Math.round(clamp(v / o.posRange, -1, 1) * ((1 << (o.posBits - 1)) - 1));
  // smallest-three quaternion encoding
  const q = snap.q;
  let bi = 0;
  for (let i = 1; i < 4; i++) if (Math.abs(q[i]) > Math.abs(q[bi])) bi = i;
  const qb = (1 << (o.quatBits - 1)) - 1;
  const qc = [];
  for (let i = 0; i < 4; i++) {
    if (i === bi) continue;
    qc.push(Math.round(clamp(q[i], -1, 1) * qb));
  }
  return {
    id: snap.id,
    p: [qn(snap.p[0]), qn(snap.p[1]), qn(snap.p[2])],
    q: [...qc, bi, q[bi] < 0 ? 1 : 0],
    s: snap.s ? [+snap.s[0].toFixed(3), +snap.s[1].toFixed(3), +snap.s[2].toFixed(3)] : undefined,
  };
}

/** Inverse of `quantizeSnap`. Pure. */
export function dequantizeSnap(qs, opts = {}) {
  const o = withDefaults(opts, QUANTIZE_DEFAULTS);
  const qmax = (1 << (o.posBits - 1)) - 1;
  const pmax = (1 << (o.quatBits - 1)) - 1;
  const p = qs.p.map((c) => (c / qmax) * o.posRange);
  const [c0, c1, c2, bi, sign] = qs.q;
  const comps = [c0 / pmax, c1 / pmax, c2 / pmax];
  const missing = Math.sqrt(Math.max(0, 1 - (comps[0] ** 2 + comps[1] ** 2 + comps[2] ** 2)));
  const q = [];
  let ci = 0;
  for (let i = 0; i < 4; i++) {
    q.push(i === bi ? (sign ? -missing : missing) : comps[ci++]);
  }
  return { id: qs.id, p, q, s: qs.s };
}

/**
 * Delta-compress one snapshot against the previous one. Pure.
 * Returns `{ id: 'same' | 'full' | { p:[dx,dy,dz]?, q?, s? } }` per entity.
 * Positions delta as offsets (small numbers compress well); quaternions and
 * scale go absolute when changed beyond `eps`.
 */
export function deltaSnap(prev, next, eps = 0.001) {
  const out = {};
  const changed = (a, b) => {
    if (!a || !b || a.length !== b.length) return true;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > eps) return true;
    return false;
  };
  for (const [id, n] of Object.entries(next)) {
    const p = prev[id];
    if (!p) { out[id] = { full: n }; continue; }
    const d = {};
    if (changed(p.p, n.p)) d.p = [n.p[0] - p.p[0], n.p[1] - p.p[1], n.p[2] - p.p[2]];
    if (n.q && changed(p.q, n.q)) d.q = [...n.q];
    if (n.s && changed(p.s, n.s)) d.s = [...n.s];
    out[id] = Object.keys(d).length ? d : 'same';
  }
  return out;
}

/** Reconstruct a full snapshot map from `prev` + a `deltaSnap` delta. Pure. */
export function applyDeltaSnap(prev, delta) {
  const out = {};
  for (const [id, d] of Object.entries(delta)) {
    if (d === 'same') { out[id] = prev[id]; continue; }
    if (d.full) { out[id] = d.full; continue; }
    const p = prev[id] || { p: [0, 0, 0] };
    out[id] = {
      id,
      p: d.p ? [p.p[0] + d.p[0], p.p[1] + d.p[1], p.p[2] + d.p[2]] : [...p.p],
      q: d.q ? [...d.q] : (p.q ? [...p.q] : undefined),
      s: d.s ? [...d.s] : (p.s ? [...p.s] : undefined),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// prioritization + interest (pure)
// ---------------------------------------------------------------------------

export const PRIORITIZE_DEFAULTS = { near: 30, mid: 80, nearHz: 20, midHz: 10, farHz: 2 };

/**
 * Assign update rates by distance from the viewer. Pure.
 * `entities` = `[{ id, p }]`, viewer accepts any `posOf` shape.
 * Returns `[{ id, dist, hz, interval }]` sorted nearest-first.
 */
export function prioritizeUpdates(entities, viewer, opts = {}) {
  const o = withDefaults(opts, PRIORITIZE_DEFAULTS);
  const vp = posOf(viewer);
  return entities
    .map((e) => {
      const ep = posOf(e.p !== undefined ? e.p : e);
      const dist = Math.hypot(ep[0] - vp[0], ep[1] - vp[1], ep[2] - vp[2]);
      const hz = dist < o.near ? o.nearHz : dist < o.mid ? o.midHz : o.farHz;
      return { id: e.id, dist, hz, interval: 1000 / hz };
    })
    .sort((a, b) => a.dist - b.dist);
}

/**
 * Is an entity relevant to a viewer? Pure. `rule` accepts:
 *   - a number → replicate within that radius (meters)
 *   - a function `(entity, viewer) => boolean`
 *   - `{ radius, kinds?, exclude? }` — kinds matches `entity.kind`,
 *     exclude is an id list that never replicates
 */
export function isRelevant(entity, viewer, rule = 60) {
  if (typeof rule === 'function') return !!rule(entity, viewer);
  if (typeof rule === 'number') {
    const a = posOf(entity.p !== undefined ? entity.p : entity);
    const b = posOf(viewer);
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= rule;
  }
  if (rule && typeof rule === 'object') {
    const o = withDefaults(rule, { radius: 60 });
    if (Array.isArray(o.exclude) && o.exclude.includes(entity.id)) return false;
    if (Array.isArray(o.kinds) && !o.kinds.includes(entity.kind)) return false;
    return isRelevant(entity, viewer, o.radius);
  }
  throw new Error('[VWorld] interest rule must be a radius number, a function, or { radius, kinds?, exclude? }.');
}

// ---------------------------------------------------------------------------
// fluent helpers
// ---------------------------------------------------------------------------

/** Snapshot buffer with interpolation sampling. See `net.interpolate()`. */
export class Interpolator {
  constructor(opts = {}) {
    const o = withDefaults(opts, { delay: 100, maxBuffer: 40 });
    this.delay = o.delay;
    this.maxBuffer = o.maxBuffer;
    this.buffer = [];
  }
  /** Push a snapshot (`{ t, ents }` or any `normalizeSnapshot` shape). */
  push(snap) {
    this.buffer.push(normalizeSnapshot(snap));
    if (this.buffer.length > this.maxBuffer) {
      this.buffer.splice(0, this.buffer.length - this.maxBuffer);
    }
    return this;
  }
  /** Render timestamp for `now` (ms): now minus interpolation delay. */
  renderTime(now = Date.now()) {
    return now - this.delay;
  }
  /** Interpolated `{ id: { p, q } }` at `now` (render time = now - delay). */
  sample(now = Date.now()) {
    return sampleSnapshots(this.buffer, this.renderTime(now));
  }
  /**
   * Apply the sampled transforms to entities. `byId` = `{ id: Entity }`.
   * Entities missing from the sample are left untouched.
   */
  apply(byId, now = Date.now()) {
    const s = this.sample(now);
    for (const [id, tr] of Object.entries(s)) {
      const e = byId[id];
      if (e) e.applySnapshot({ p: tr.p, q: tr.q });
    }
    return this;
  }
  clear() {
    this.buffer.length = 0;
    return this;
  }
}

/** Position history for server-side lag compensation. See `net.rewind()`. */
export class RewindBuffer {
  constructor(opts = {}) {
    const o = withDefaults(opts, { historyMs: 1000, maxSamples: 60 });
    this.historyMs = o.historyMs;
    this.maxSamples = o.maxSamples;
    this.samples = [];
  }
  /**
   * Record entity positions at time `t` (ms). `positions` =
   * `{ id: { p } | [x,y,z] }`.
   */
  push(t, positions) {
    this.samples.push({ t, ents: positions });
    const cutoff = t - this.historyMs;
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
    if (this.samples.length > this.maxSamples) {
      this.samples.splice(0, this.samples.length - this.maxSamples);
    }
    return this;
  }
  /** Positions rewound to `timestamp` (ms): `{ id: { p } }`. */
  at(timestamp) {
    return rewindEntities(this.samples, timestamp);
  }
  clear() {
    this.samples.length = 0;
    return this;
  }
}

/** Interest management: who sees what. See `net.interest()`. */
export class InterestManager {
  constructor(rule = 60) {
    this._rule = rule;
  }
  /** Set the relevance rule (number | fn | `{ radius, kinds?, exclude? }`). */
  rule(r) {
    this._rule = r;
    return this;
  }
  /** Filter `entities` to those relevant to `viewer`. */
  relevant(viewer, entities) {
    return entities.filter((e) => isRelevant(e, viewer, this._rule));
  }
  /** Same, but returns ids only. */
  relevantIds(viewer, entities) {
    return this.relevant(viewer, entities).map((e) => e.id);
  }
  /** Predicate form: `entities.filter(im.for(viewer))`. */
  for(viewer) {
    const rule = this._rule;
    return (e) => isRelevant(e, viewer, rule);
  }
}

// ---------------------------------------------------------------------------
// Net
// ---------------------------------------------------------------------------

export class Net {
  constructor(engine) {
    this.engine = engine;
    this.handlers = new Map();
    this.connected = false;
    this.sendRateHz = 20;
    this.clientId = `client_${Math.random().toString(36).slice(2, 10)}`;
    /** entity -> { state, pending: [{seq,input}], opts } for prediction. */
    this._predictors = new Map();
    this._seq = 0;
  }

  /** Subscribe to a network event (works locally today; remote in Phase 2). */
  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(fn);
    return this;
  }

  off(event, fn) {
    this.handlers.get(event)?.delete(fn);
    return this;
  }

  /** Dispatch an event to local subscribers. */
  emit(event, data) {
    for (const fn of this.handlers.get(event) ?? []) fn(data);
    return this;
  }

  /** Serialize an entity to the wire format. */
  serialize(entity) {
    return entity.serialize();
  }

  /** Apply a wire-format snapshot to an entity. */
  applySnapshot(entity, snap) {
    return entity.applySnapshot(snap);
  }

  /** Serialize every entity in the scene (for full-state sync later). */
  snapshotAll() {
    const out = [];
    this.engine.scene.traverse((o) => {
      if (o.userData.entity) out.push(o.userData.entity.serialize());
    });
    return out;
  }

  /** How many state updates per second Phase 2 should send. */
  sendRate(hz) {
    this.sendRateHz = hz;
    return this;
  }

  get isMultiplayer() {
    return false; // engine ships no transport; the game layer flips this
  }

  // --- client-side prediction -----------------------------------------------

  /**
   * Predict local movement immediately (no round-trip wait). `input` accepts
   * any `normalizeNetInput` shape; pass world-space move vectors (convert
   * camera-relative input first). Returns the input's sequence number —
   * send it to the server so it can ack it later.
   *
   * ```js
   * const seq = net.predict(player, { move: [0, -1], sprint: true }, { dt: 1/60 });
   * socket.send({ type: 'input', seq, input });
   * ```
   */
  predict(entity, input, opts = {}) {
    const o = withDefaults(opts, { dt: 1 / 60 });
    const ni = normalizeNetInput(input);
    let tr = this._predictors.get(entity);
    if (!tr) {
      const p = entity.object.position;
      tr = {
        state: { p: [+p.x, +p.y, +p.z], v: [0, 0, 0], grounded: true },
        pending: [],
        opts: withDefaults(opts, PREDICT_DEFAULTS),
      };
      this._predictors.set(entity, tr);
    }
    const seq = ++this._seq;
    tr.pending.push({ seq, input: ni });
    if (tr.pending.length > 120) tr.pending.shift();
    tr.state = applyNetInput(tr.state, ni, o.dt, tr.opts);
    entity.object.position.set(tr.state.p[0], tr.state.p[1], tr.state.p[2]);
    return seq;
  }

  /** Drop acknowledged inputs (seq <= ackSeq) from the prediction buffer. */
  ack(entity, ackSeq) {
    const tr = this._predictors.get(entity);
    if (tr) tr.pending = tr.pending.filter((p) => p.seq > ackSeq);
    return this;
  }

  /** How many unacknowledged inputs are buffered for an entity. */
  predictionPending(entity) {
    return this._predictors.get(entity)?.pending.length ?? 0;
  }

  /**
   * Server reconciliation: snap to the authoritative snapshot, then re-apply
   * every input the server hasn't acked. `authSnap` = `{ p, v?, grounded? }`,
   * `ackSeq` = last sequence the server confirmed.
   */
  correct(entity, authSnap, ackSeq, opts = {}) {
    const o = withDefaults(opts, { dt: 1 / 60 });
    const tr = this._predictors.get(entity);
    if (!tr) {
      entity.applySnapshot(authSnap);
      return this;
    }
    const pending = tr.pending.filter((p) => p.seq > ackSeq);
    const { state } = reconcileNetState(authSnap, pending, o.dt, tr.opts);
    tr.state = state;
    tr.pending = pending;
    entity.object.position.set(state.p[0], state.p[1], state.p[2]);
    this.emit('net:corrected', { entity, ackSeq, reapplied: pending.length });
    return this;
  }

  /** Stop predicting an entity (e.g. on disconnect). */
  forgetPrediction(entity) {
    this._predictors.delete(entity);
    return this;
  }

  // --- interpolation ----------------------------------------------------------

  /**
   * Interpolated remote entities: render `delay` ms behind the newest
   * snapshot and lerp between the two bracketing snapshots.
   *
   * ```js
   * const interp = net.interpolate({ delay: 100 });
   * socket.on('snapshot', (s) => interp.push(s));
   * // per frame:
   * interp.apply(remoteEntitiesById);
   * ```
   */
  interpolate(opts) {
    return new Interpolator(opts);
  }

  // --- lag compensation -------------------------------------------------------

  /**
   * Server-side hit-test rewind. Record authoritative positions each tick,
   * then rewind to the shooter's timestamp before testing the hit.
   *
   * ```js
   * const rw = net.rewind({ historyMs: 1000 });
   * // per server tick:
   * rw.push(now, { [id]: entity.object.position });
   * // on shot at time t:
   * const past = rw.at(t - shooterPing / 2);
   * ```
   */
  rewind(opts) {
    return new RewindBuffer(opts);
  }

  // --- interest management ----------------------------------------------------

  /**
   * Replicate only what's relevant. `rule` = radius meters | fn |
   * `{ radius, kinds?, exclude? }`; change it later with `.rule()`.
   *
   * ```js
   * const im = net.interest({ radius: 60, kinds: ['player', 'prop'] });
   * const visible = im.relevant(playerEntity, allEntities);
   * ```
   */
  interest(rule = 60) {
    return new InterestManager(rule);
  }

  /** One-shot relevance filter without keeping a manager around. */
  relevant(viewer, entities, rule = 60) {
    return entities.filter((e) => isRelevant(e, viewer, rule));
  }

  // --- bandwidth --------------------------------------------------------------

  /**
   * Delta-compress `next` against `prev` (both `{ id: snap }` maps).
   * Unchanged entities collapse to `'same'`; new ones go `'full'`.
   */
  delta(prev, next, eps) {
    return deltaSnap(prev, next, eps);
  }

  /** Rebuild a full snapshot map from `prev` + a `net.delta` result. */
  applyDelta(prev, d) {
    return applyDeltaSnap(prev, d);
  }

  /** Quantize a snapshot for the wire (fixed-point positions, smallest-three quats). */
  quantize(snap, opts) {
    return quantizeSnap(snap, opts);
  }

  /** Inverse of `net.quantize`. */
  dequantize(qs, opts) {
    return dequantizeSnap(qs, opts);
  }

  /**
   * Update-rate assignment by distance: near entities update often, far ones
   * rarely. Returns `[{ id, dist, hz, interval }]` nearest-first.
   */
  prioritize(viewer, entities, opts) {
    return prioritizeUpdates(entities, viewer, opts);
  }

  // --- transport stubs (game layer owns the socket) -----------------------------
  connect(_url) {
    console.warn('[VWorld] Net.connect() is a stub — the game layer owns the transport. Local hooks only.');
    return this;
  }

  send(_event, _data) {
    if (!this.connected) {
      console.warn('[VWorld] Net.send() dropped — not connected (stub).');
    }
    return this;
  }

  disconnect() {
    this.connected = false;
    this._predictors.clear();
    return this;
  }
}
