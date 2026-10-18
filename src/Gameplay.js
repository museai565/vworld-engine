import * as THREE from 'three';
import { toVec3, toNumber, withDefaults } from './util/normalize.js';
import { vError, reportError } from './util/errors.js';

/**
 * Gameplay systems (v0.7.0) — inventory, health, pickups, quests, dialogue,
 * HUD overlays, and unified input bindings (keyboard / mouse / gamepad).
 *
 * Design rules:
 * - Pure logic lives in dependency-free classes/functions so node can test
 *   it: Inventory, Health, QuestLog, Dialogue, the binding resolvers, and
 *   inPickupRange. None of them touch THREE, the DOM, or the engine.
 * - Engine wiring (entity.inventory(), world.pickup(), app.hud(), gamepad
 *   polling) is a thin layer on top and degrades cleanly without a DOM.
 * - Normalize, don't complain: every public method accepts every sensible
 *   input shape and throws a *helpful* error otherwise.
 */

// ---------------------------------------------------------------------------
// tiny event helper (engine-aware error reporting, like the rest of the engine)
// ---------------------------------------------------------------------------

function makeEmitter(owner) {
  const listeners = new Map(); // event -> Set<fn>
  return {
    on(event, fn) {
      if (typeof fn !== 'function') {
        throw vError('VWORLD/BAD_HANDLER', `[VWorld] on('${event}', fn) — fn must be a function.`);
      }
      const e = String(event);
      if (!listeners.has(e)) listeners.set(e, new Set());
      listeners.get(e).add(fn);
      return owner;
    },
    off(event, fn) {
      listeners.get(String(event))?.delete(fn);
      return owner;
    },
    emit(event, ...args) {
      for (const fn of listeners.get(String(event)) ?? []) {
        try {
          fn(...args);
        } catch (err) {
          reportError(owner && owner._engine, err);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Inventory — stackable items, capacity limits, change events (pure)
// ---------------------------------------------------------------------------

/**
 * Normalize an item reference to a string id.
 * Accepts: 'apple' | { id: 'apple' } | { item: 'apple' } | { name: 'apple' }.
 */
export function normalizeItemId(item) {
  if (typeof item === 'string' && item.length > 0) return item;
  if (item && typeof item === 'object') {
    const id = item.id ?? item.item ?? item.name;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  throw vError(
    'VWORLD/BAD_ITEM',
    `[VWorld] Inventory needs an item id — pass 'apple' or { id: 'apple' } (got ${item === null ? 'null' : typeof item}).`
  );
}

function normalizeQty(qty, name = 'qty') {
  const n = toNumber(qty, name, 1);
  if (!Number.isInteger(n) || n < 0) {
    throw vError('VWORLD/BAD_QTY', `[VWorld] Inventory qty must be a non-negative integer — got ${qty}.`);
  }
  return n;
}

/**
 * Stackable inventory with capacity limits and change events (pure logic —
 * no DOM, no THREE, no engine required).
 *
 *   const inv = new Inventory({ capacity: 99, maxSlots: 12 });
 *   inv.on('change', ({ item, delta, total }) => console.log(item, delta));
 *   inv.add('apple', 3);   // +3
 *   inv.add('apple');      // +1  (qty defaults to 1)
 *   inv.remove('apple', 2);
 *   inv.has('apple');      // true
 *   inv.count('apple');    // 2
 *   inv.list();            // [{ item: 'apple', qty: 2 }]
 *
 * `capacity` caps the total number of units; `maxSlots` caps distinct item
 * kinds. `add` returns how many units were actually accepted (may be
 * partial); `remove` returns how many were actually removed.
 */
export class Inventory {
  constructor(options = {}, engine = null) {
    const o = withDefaults(options, { capacity: Infinity, maxSlots: Infinity });
    this.capacity = o.capacity === undefined || o.capacity === Infinity ? Infinity : toNumber(o.capacity, 'capacity');
    this.maxSlots = o.maxSlots === undefined || o.maxSlots === Infinity ? Infinity : toNumber(o.maxSlots, 'maxSlots');
    if (!(this.capacity >= 0) || !(this.maxSlots >= 0)) {
      throw vError('VWORLD/BAD_CAPACITY', '[VWorld] Inventory capacity/maxSlots must be >= 0.');
    }
    this._engine = engine;
    this._stacks = new Map(); // id -> qty
    this._emitter = makeEmitter(this);
  }

  on(event, fn) { return this._emitter.on(event, fn); }
  off(event, fn) { return this._emitter.off(event, fn); }

  /** Distinct item kinds currently held. */
  get slots() { return this._stacks.size; }

  /** Total units across all stacks. */
  get total() {
    let n = 0;
    for (const q of this._stacks.values()) n += q;
    return n;
  }

  /** Units of one item (0 when absent). */
  count(item) {
    return this._stacks.get(normalizeItemId(item)) ?? 0;
  }

  /** True when at least `qty` units are held (qty defaults to 1). */
  has(item, qty = 1) {
    return this.count(item) >= normalizeQty(qty, 'qty');
  }

  /** All stacks as [{ item, qty }]. */
  list() {
    return [...this._stacks.entries()].map(([item, qty]) => ({ item, qty }));
  }

  /**
   * Add units. Accepts add('apple'), add('apple', 3), add({ item: 'apple', qty: 3 }).
   * Returns the number of units actually accepted.
   */
  add(item, qty = 1) {
    let id, n;
    if (item && typeof item === 'object' && (item.qty !== undefined || item.count !== undefined)) {
      id = normalizeItemId(item);
      n = normalizeQty(item.qty ?? item.count, 'qty');
    } else {
      id = normalizeItemId(item);
      n = normalizeQty(qty, 'qty');
    }
    if (n === 0) return 0;
    const isNew = !this._stacks.has(id);
    if (isNew && this._stacks.size >= this.maxSlots) return 0;
    const room = this.capacity - this.total;
    const accepted = Math.max(0, Math.min(n, room));
    if (accepted === 0) return 0;
    this._stacks.set(id, (this._stacks.get(id) ?? 0) + accepted);
    this._emitter.emit('change', { item: id, qty: accepted, delta: accepted, total: this.total, action: 'add' });
    return accepted;
  }

  /** Remove units (clamped to what is held). Returns units actually removed. */
  remove(item, qty = 1) {
    const id = normalizeItemId(item);
    const n = normalizeQty(qty, 'qty');
    const held = this._stacks.get(id) ?? 0;
    const removed = Math.min(n, held);
    if (removed === 0) return 0;
    const left = held - removed;
    if (left > 0) this._stacks.set(id, left);
    else this._stacks.delete(id);
    this._emitter.emit('change', { item: id, qty: removed, delta: -removed, total: this.total, action: 'remove' });
    return removed;
  }

  /** Empty the whole inventory. */
  clear() {
    if (this._stacks.size === 0) return this;
    this._stacks.clear();
    this._emitter.emit('change', { item: null, qty: 0, delta: 0, total: 0, action: 'clear' });
    return this;
  }
}

// ---------------------------------------------------------------------------
// Health — damage / heal / death state machine (pure)
// ---------------------------------------------------------------------------

/**
 * Health pool with damage/heal/death events (pure logic).
 *
 *   const hp = new Health(100);
 *   hp.on('damage', ({ amount, hp }) => ...);
 *   hp.on('death', ({ source }) => ...);
 *   hp.damage(30, { source: 'lava' });
 *   hp.heal(10);
 *   hp.dead; // false
 *
 * Death fires exactly once per death; healing above 0 revives.
 */
export class Health {
  constructor(max = 100, engine = null) {
    let m = max, start = null;
    if (max && typeof max === 'object') {
      m = max.max ?? 100;
      start = max.hp ?? null;
    }
    this.max = toNumber(m, 'max');
    if (!(this.max > 0)) {
      throw vError('VWORLD/BAD_HEALTH', `[VWorld] Health max must be > 0 — got ${m}.`);
    }
    this._engine = engine;
    this._hp = start === null ? this.max : Math.min(this.max, Math.max(0, toNumber(start, 'hp')));
    this._dead = this._hp <= 0;
    this._emitter = makeEmitter(this);
  }

  on(event, fn) {
    if (!['damage', 'heal', 'death'].includes(String(event))) {
      throw vError('VWORLD/UNKNOWN_EVENT', `[VWorld] Health.on() — unknown event "${event}". Try: damage, heal, death.`);
    }
    return this._emitter.on(event, fn);
  }
  off(event, fn) { return this._emitter.off(event, fn); }

  get hp() { return this._hp; }
  get dead() { return this._dead; }
  /** 0..1 fill fraction. */
  get fraction() { return this.max > 0 ? this._hp / this.max : 0; }

  /**
   * Deal damage. `source` is anything describing the cause
   * ('lava', { source: 'goblin' }, ...). Returns damage actually applied.
   * No-ops when already dead or amount <= 0.
   */
  damage(amount, source = null) {
    const n = toNumber(amount, 'amount');
    if (this._dead || !(n > 0)) return 0;
    const applied = Math.min(n, this._hp);
    this._hp -= applied;
    this._emitter.emit('damage', { amount: applied, hp: this._hp, max: this.max, source });
    if (this._hp <= 0) {
      this._dead = true;
      this._emitter.emit('death', { hp: 0, max: this.max, source });
    }
    return applied;
  }

  /** Restore health (clamped to max). Healing above 0 revives. Returns amount restored. */
  heal(amount) {
    const n = toNumber(amount, 'amount');
    if (!(n > 0)) return 0;
    const before = this._hp;
    this._hp = Math.min(this.max, this._hp + n);
    const restored = this._hp - before;
    if (restored > 0) {
      if (this._dead && this._hp > 0) this._dead = false;
      this._emitter.emit('heal', { amount: restored, hp: this._hp, max: this.max });
    }
    return restored;
  }
}

// ---------------------------------------------------------------------------
// QuestLog — quest definitions, objective progress, completion rewards (pure)
// ---------------------------------------------------------------------------

function normalizeObjective(o, i = 0) {
  if (typeof o === 'string') return { id: o, text: o, target: 1 };
  if (o && typeof o === 'object') {
    const id = o.id ?? `objective_${i}`;
    return {
      id: String(id),
      text: o.text ?? String(id),
      target: Math.max(1, Math.floor(toNumber(o.target ?? 1, 'target'))),
    };
  }
  throw vError('VWORLD/BAD_OBJECTIVE', '[VWorld] Quest objectives must be strings or { id, text?, target? }.');
}

/**
 * Quest state machine (pure logic).
 *
 *   const q = app.quests();
 *   q.define({
 *     id: 'herbs', name: 'Herbal Remedy',
 *     objectives: [{ id: 'pick', text: 'Pick moonherbs', target: 5 }],
 *     reward: (quest) => player.inventory().add('potion'),
 *   });
 *   q.on('objective', ({ quest, objective }) => hud.objective(...));
 *   q.on('complete', ({ quest }) => console.log('done!', quest.id));
 *   q.start('herbs');
 *   q.advance('herbs', 'pick', 2);   // +2 progress
 *   q.state('herbs');                // 'active' | 'complete' | 'locked' | 'unknown'
 */
export class QuestLog {
  constructor(engine = null) {
    this._engine = engine;
    this._quests = new Map(); // id -> { def, state, progress: Map }
    this._emitter = makeEmitter(this);
  }

  on(event, fn) {
    if (!['start', 'objective', 'complete'].includes(String(event))) {
      throw vError('VWORLD/UNKNOWN_EVENT', `[VWorld] QuestLog.on() — unknown event "${event}". Try: start, objective, complete.`);
    }
    return this._emitter.on(event, fn);
  }
  off(event, fn) { return this._emitter.off(event, fn); }

  /** Register a quest. Re-defining an id replaces it. Chainable. */
  define(def = {}) {
    const id = def.id ?? def.name;
    if (!id || typeof id !== 'string') {
      throw vError('VWORLD/BAD_QUEST', '[VWorld] QuestLog.define() needs { id, objectives: [...] }.');
    }
    const objectives = (def.objectives ?? []).map((o, i) => normalizeObjective(o, i));
    if (objectives.length === 0) {
      throw vError('VWORLD/BAD_QUEST', `[VWorld] Quest "${id}" needs at least one objective.`);
    }
    if (def.reward !== undefined && typeof def.reward !== 'function') {
      throw vError('VWORLD/BAD_QUEST', `[VWorld] Quest "${id}" reward must be a function.`);
    }
    this._quests.set(id, {
      def: { id, name: def.name ?? id, objectives, reward: def.reward ?? null },
      state: 'locked',
      progress: new Map(objectives.map((o) => [o.id, 0])),
    });
    return this;
  }

  /** Quest state: 'unknown' | 'locked' | 'active' | 'complete'. */
  state(id) {
    return this._quests.get(String(id))?.state ?? 'unknown';
  }

  /** Begin a quest. No-op when already active or complete. Chainable. */
  start(id) {
    const q = this._quests.get(String(id));
    if (!q) throw vError('VWORLD/UNKNOWN_QUEST', `[VWorld] QuestLog.start() — unknown quest "${id}". Define it first.`);
    if (q.state !== 'locked') return this;
    q.state = 'active';
    this._emitter.emit('start', { quest: this._summary(q) });
    return this;
  }

  /**
   * Add progress to an objective: advance('herbs', 'pick') or
   * advance('herbs', 'pick', 3). Completes the quest (and runs its reward)
   * when every objective reaches target. Chainable.
   */
  advance(questId, objectiveId, n = 1) {
    const q = this._quests.get(String(questId));
    if (!q) throw vError('VWORLD/UNKNOWN_QUEST', `[VWorld] QuestLog.advance() — unknown quest "${questId}".`);
    if (q.state !== 'active') return this;
    const oid = String(objectiveId);
    const obj = q.def.objectives.find((o) => o.id === oid);
    if (!obj) throw vError('VWORLD/UNKNOWN_OBJECTIVE', `[VWorld] Quest "${questId}" has no objective "${oid}".`);
    const before = q.progress.get(oid);
    const after = Math.min(obj.target, before + Math.max(0, Math.floor(toNumber(n, 'n'))));
    if (after === before) return this;
    q.progress.set(oid, after);
    const done = after >= obj.target;
    this._emitter.emit('objective', {
      quest: this._summary(q), objective: { ...obj, count: after, done },
    });
    if (q.def.objectives.every((o) => (q.progress.get(o.id) ?? 0) >= o.target)) {
      q.state = 'complete';
      const summary = this._summary(q);
      this._emitter.emit('complete', { quest: summary });
      if (typeof q.def.reward === 'function') {
        try { q.def.reward(summary); } catch (err) { reportError(this._engine, err); }
      }
    }
    return this;
  }

  /** Progress snapshot for one objective: { id, text, target, count, done }. */
  objective(questId, objectiveId) {
    const q = this._quests.get(String(questId));
    const oid = String(objectiveId);
    const obj = q?.def.objectives.find((o) => o.id === oid);
    if (!obj) return null;
    const count = q.progress.get(oid) ?? 0;
    return { ...obj, count, done: count >= obj.target };
  }

  /** Reset a quest to 'locked' with zeroed progress. Chainable. */
  reset(id) {
    const q = this._quests.get(String(id));
    if (!q) return this;
    q.state = 'locked';
    for (const o of q.def.objectives) q.progress.set(o.id, 0);
    return this;
  }

  /** All quests as [{ id, name, state, objectives: [{...done}] }]. */
  list() {
    return [...this._quests.values()].map((q) => this._summary(q));
  }

  _summary(q) {
    return {
      id: q.def.id,
      name: q.def.name,
      state: q.state,
      objectives: q.def.objectives.map((o) => {
        const count = q.progress.get(o.id) ?? 0;
        return { ...o, count, done: count >= o.target };
      }),
    };
  }
}

// ---------------------------------------------------------------------------
// Dialogue — node/choice tree walker (pure)
// ---------------------------------------------------------------------------

function normalizeChoice(c) {
  if (typeof c === 'string') return { text: c, to: null };
  if (c && typeof c === 'object' && typeof c.text === 'string') {
    return { id: c.id !== undefined ? String(c.id) : null, text: c.text, to: c.to ?? null };
  }
  throw vError('VWORLD/BAD_CHOICE', '[VWorld] Dialogue choices must be strings or { text, to }.');
}

function normalizeNode(id, n) {
  if (typeof n === 'string') return { text: n, choices: [] };
  if (n && typeof n === 'object') {
    return {
      text: n.text ?? '',
      choices: (n.choices ?? []).map(normalizeChoice),
      onEnter: typeof n.onEnter === 'function' ? n.onEnter : null,
    };
  }
  throw vError('VWORLD/BAD_NODE', `[VWorld] Dialogue node "${id}" must be a string or { text, choices }.`);
}

/**
 * Branching dialogue walker (pure logic).
 *
 *   const dlg = app.dialogue({
 *     start: 'hello',
 *     nodes: {
 *       hello: { text: 'Traveler! Got a moment?',
 *                choices: [{ text: 'Sure.', to: 'quest' }, 'Not now'] },
 *       quest:  { text: 'Bring me 5 moonherbs.', choices: [] },
 *     },
 *   });
 *   dlg.on('choice', ({ choice }) => ...);
 *   dlg.on('end', () => ...);
 *   dlg.node();        // { id: 'hello', text, choices }
 *   dlg.choose(0);     // or choose('Sure.')
 */
export class Dialogue {
  constructor(tree = {}, engine = null) {
    if (!tree || typeof tree !== 'object' || !tree.nodes || typeof tree.nodes !== 'object') {
      throw vError('VWORLD/BAD_DIALOGUE', '[VWorld] app.dialogue() needs { start, nodes: { id: { text, choices } } }.');
    }
    this._engine = engine;
    this._nodes = new Map();
    for (const [id, n] of Object.entries(tree.nodes)) this._nodes.set(id, normalizeNode(id, n));
    this._start = tree.start ?? [...this._nodes.keys()][0];
    if (!this._nodes.has(this._start)) {
      throw vError('VWORLD/BAD_DIALOGUE', `[VWorld] Dialogue start node "${this._start}" is not in nodes.`);
    }
    this._emitter = makeEmitter(this);
    this.reset();
  }

  on(event, fn) {
    if (!['node', 'choice', 'end'].includes(String(event))) {
      throw vError('VWORLD/UNKNOWN_EVENT', `[VWorld] Dialogue.on() — unknown event "${event}". Try: node, choice, end.`);
    }
    return this._emitter.on(event, fn);
  }
  off(event, fn) { return this._emitter.off(event, fn); }

  /** Current node { id, text, choices } — null once the dialogue ended. */
  node() {
    if (this._ended || this._current === null) return null;
    const n = this._nodes.get(this._current);
    return { id: this._current, text: n.text, choices: n.choices.map((c) => ({ ...c })) };
  }

  /** True when the dialogue has run to an end (a choice with no `to`). */
  get ended() { return this._ended; }

  /**
   * Pick a choice: index, choice text, or choice id. Fires 'choice', then
   * 'node' for the next node or 'end' when the branch terminates.
   * Returns the new current node (or null at end). Chainable? No — returns node.
   */
  choose(sel) {
    if (this._ended) {
      throw vError('VWORLD/DIALOGUE_ENDED', '[VWorld] Dialogue.choose() — the dialogue already ended. Call reset() to replay.');
    }
    const cur = this.node();
    const idx = typeof sel === 'number'
      ? sel
      : cur.choices.findIndex((c) => c.text === sel || (c.id !== null && c.id === String(sel)));
    const choice = cur.choices[idx];
    if (!choice) {
      throw vError(
        'VWORLD/BAD_CHOICE',
        `[VWorld] Dialogue.choose() — no choice ${JSON.stringify(sel)} at node "${cur.id}". Choices: ${cur.choices.map((c) => JSON.stringify(c.text)).join(', ') || '(none)'}`
      );
    }
    this._emitter.emit('choice', { node: cur.id, choice: { ...choice }, index: idx });
    if (choice.to === null || choice.to === undefined) {
      this._ended = true;
      this._current = null;
      this._emitter.emit('end', { node: cur.id, choice: { ...choice } });
      return null;
    }
    if (!this._nodes.has(choice.to)) {
      throw vError('VWORLD/BAD_DIALOGUE', `[VWorld] Dialogue choice "${choice.text}" points at unknown node "${choice.to}".`);
    }
    this._goto(choice.to);
    return this.node();
  }

  /** Restart from the start node. Chainable. */
  reset() {
    this._ended = false;
    this._goto(this._start, true);
    return this;
  }

  _goto(id, silent = false) {
    this._current = id;
    const n = this._nodes.get(id);
    if (n.onEnter) {
      try { n.onEnter(this); } catch (err) { reportError(this._engine, err); }
    }
    if (!silent) this._emitter.emit('node', this.node());
  }
}

// ---------------------------------------------------------------------------
// Input bindings — pure resolvers shared by Input.map() and tests
// ---------------------------------------------------------------------------

/**
 * Parse one binding string into a structured descriptor.
 *
 *   'Space'            -> { type: 'key', code: 'Space' }
 *   'mouse:0'          -> { type: 'mouse', button: 0 }        (0=left 1=middle 2=right)
 *   'gamepad:0'        -> { type: 'padButton', pad: 0, button: 0 }
 *   'gamepad:1:5'      -> { type: 'padButton', pad: 1, button: 5 }
 *   'gamepad:axis0'    -> { type: 'padAxis', pad: 0, axis: 0, dir: 0 }
 *   'gamepad:axis1+'   -> { type: 'padAxis', pad: 0, axis: 1, dir: 1 }
 *   'gamepad:2:axis0-' -> { type: 'padAxis', pad: 2, axis: 0, dir: -1 }
 */
export function parseBinding(str) {
  const s = String(str).trim();
  let m = /^mouse:([0-2])$/.exec(s);
  if (m) return { type: 'mouse', button: Number(m[1]) };
  m = /^gamepad:(?:(\d+):)?axis(\d+)([+-])?$/.exec(s);
  if (m) {
    return {
      type: 'padAxis', pad: Number(m[1] ?? 0), axis: Number(m[2]),
      dir: m[3] === '+' ? 1 : m[3] === '-' ? -1 : 0,
    };
  }
  m = /^gamepad:(?:(\d+):)?(\d+)$/.exec(s);
  if (m) return { type: 'padButton', pad: Number(m[1] ?? 0), button: Number(m[2]) };
  if (/^[A-Za-z0-9]+$/.test(s)) return { type: 'key', code: s };
  throw vError(
    'VWORLD/BAD_BINDING',
    `[VWorld] Can't parse binding "${str}". Try 'Space', 'mouse:0', 'gamepad:0', 'gamepad:1:5', or 'gamepad:axis0+'.`
  );
}

/** Normalize binding lists: 'Space' | ['Space','mouse:0'] | parsed objects. */
export function normalizeBindings(input) {
  const list = Array.isArray(input) ? input : [input];
  return list.map((b) => (typeof b === 'string' ? parseBinding(b) : b));
}

/**
 * Keyboard state shape: { keys:Set, pressed:Set, released:Set,
 *                          mouse:Set, mousePressed:Set, mouseReleased:Set }.
 * Pad state: array (indexed by pad) of { buttons:bool[], pressed:bool[],
 * released:bool[], axes:number[] } — entries may be null/undefined.
 */
function padAt(pads, i) {
  const p = pads?.[i];
  return p ?? null;
}

const AXIS_DEADZONE = 0.25;

/** Is one parsed binding currently held? */
export function bindingHeld(b, kb, pads) {
  switch (b.type) {
    case 'key': return !!kb?.keys?.has(b.code);
    case 'mouse': return !!kb?.mouse?.has(b.button);
    case 'padButton': return padAt(pads, b.pad)?.buttons?.[b.button] === true;
    case 'padAxis': {
      const v = padAt(pads, b.pad)?.axes?.[b.axis] ?? 0;
      if (b.dir === 1) return v > AXIS_DEADZONE;
      if (b.dir === -1) return v < -AXIS_DEADZONE;
      return Math.abs(v) > AXIS_DEADZONE;
    }
    default: return false;
  }
}

/** Was one parsed binding pressed this frame? (Analog axes report held.) */
export function bindingPressed(b, kb, pads) {
  switch (b.type) {
    case 'key': return !!kb?.pressed?.has(b.code);
    case 'mouse': return !!kb?.mousePressed?.has(b.button);
    case 'padButton': return padAt(pads, b.pad)?.pressed?.[b.button] === true;
    case 'padAxis': return bindingHeld(b, kb, pads);
    default: return false;
  }
}

/** Was one parsed binding released this frame? (Analog axes report !held.) */
export function bindingReleased(b, kb, pads) {
  switch (b.type) {
    case 'key': return !!kb?.released?.has(b.code);
    case 'mouse': return !!kb?.mouseReleased?.has(b.button);
    case 'padButton': return padAt(pads, b.pad)?.released?.[b.button] === true;
    case 'padAxis': return !bindingHeld(b, kb, pads);
    default: return false;
  }
}

/** Any-of helpers over a parsed binding list. */
export function actionHeld(bindings, kb, pads) {
  return bindings.some((b) => bindingHeld(b, kb, pads));
}
export function actionPressed(bindings, kb, pads) {
  return bindings.some((b) => bindingPressed(b, kb, pads));
}
export function actionReleased(bindings, kb, pads) {
  return bindings.some((b) => bindingReleased(b, kb, pads));
}

// ---------------------------------------------------------------------------
// Pickups — auto-collect zones granting items / health, with respawn (pure core)
// ---------------------------------------------------------------------------

/**
 * Pure range check: is `point` within `radius` of `center`?
 * Positions accept { x, y, z } (y defaults to 0).
 */
export function inPickupRange(center, radius, point) {
  const c = center ?? {};
  const p = point ?? {};
  const dx = (c.x ?? 0) - (p.x ?? 0);
  const dy = (c.y ?? 0) - (p.y ?? 0);
  const dz = (c.z ?? 0) - (p.z ?? 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz) <= radius;
}

/**
 * Auto-collect pickup zone.
 *
 *   world.pickup({
 *     kind: 'coin', at: [10, 1, 4], radius: 1.6,
 *     item: 'coin', amount: 5,        // granted to collector inventory
 *     heal: 25,                        // ...and/or healed
 *     respawn: 12,                     // seconds until it comes back (0 = once)
 *     onCollect: ({ entity, pickup }) => app.effects.burst(...),
 *   });
 *
 * A collector is any entity with `.inventory()` or `.health()` attached.
 * The pure grant logic (`grantsFor`) is testable without an engine.
 */
export class Pickup {
  constructor(world = null, options = {}) {
    const o = withDefaults(options, {
      kind: 'pickup', radius: 1.6, amount: 1, item: null, heal: 0,
      respawn: 10, onCollect: null, mesh: true, spin: true, bob: true,
    });
    this.world = world;
    this.engine = world?.engine ?? null;
    this.kind = String(o.kind);
    this.radius = toNumber(o.radius, 'radius');
    if (!(this.radius > 0)) {
      throw vError('VWORLD/BAD_PICKUP', `[VWorld] world.pickup() radius must be > 0 — got ${o.radius}.`);
    }
    this.center = o.at === undefined ? { x: 0, y: 0, z: 0 } : toVec3(o.at);
    this.item = o.item === null || o.item === undefined ? null : normalizeItemId(o.item);
    this.amount = Math.max(1, Math.floor(toNumber(o.amount, 'amount')));
    this.heal = Math.max(0, toNumber(o.heal, 'heal'));
    this.respawn = Math.max(0, toNumber(o.respawn, 'respawn'));
    if (typeof o.onCollect !== 'function' && o.onCollect !== null) {
      throw vError('VWORLD/BAD_PICKUP', '[VWorld] world.pickup() onCollect must be a function.');
    }
    this.onCollect = o.onCollect;
    this.active = true;
    this._timer = 0;
    this._visual = null;
    this._spin = o.spin !== false;
    this._bob = o.bob !== false;
    this._baseY = this.center.y;
    this._tickFn = null;

    if (this.engine && o.mesh !== false) this._buildVisual(o.mesh);
    if (this.engine) {
      this._tickFn = (dt) => this.tick(dt);
      this.engine.onUpdate(this._tickFn);
      this.engine.on('dispose', () => this.dispose());
    }
  }

  /**
   * What this pickup would grant a collector, without applying it.
   * Returns { item, amount, heal } (item may be null).
   */
  grantsFor() {
    return { item: this.item, amount: this.amount, heal: this.heal };
  }

  /** Grant to a collector entity (duck-typed: uses ._inventory / ._health). Returns what was granted. */
  collectBy(entity) {
    if (!this.active || !entity) return null;
    const granted = { item: null, amount: 0, heal: 0 };
    const inv = entity._inventory;
    if (this.item && inv && typeof inv.add === 'function') {
      granted.amount = inv.add(this.item, this.amount);
      if (granted.amount > 0) granted.item = this.item;
    }
    const hp = entity._health;
    if (this.heal > 0 && hp && typeof hp.heal === 'function') {
      granted.heal = hp.heal(this.heal);
    }
    if (granted.amount === 0 && granted.heal === 0) return null; // nothing to take
    this.active = false;
    this._timer = this.respawn;
    if (this._visual) this._visual.visible = false;
    if (this.onCollect) {
      try { this.onCollect({ pickup: this, entity, granted }); } catch (err) { reportError(this.engine, err); }
    }
    return granted;
  }

  /** Advance timers, spin/bob the visual, and scan for collectors. */
  tick(dt) {
    if (!this.active) {
      if (this.respawn > 0) {
        this._timer -= dt;
        if (this._timer <= 0) {
          this.active = true;
          if (this._visual) this._visual.visible = true;
        }
      }
      return;
    }
    if (this._visual) {
      const t = (this._visual.userData.t ?? 0) + dt;
      this._visual.userData.t = t;
      if (this._spin) this._visual.rotation.y += dt * 2.2;
      if (this._bob) this._visual.position.y = this._baseY + Math.sin(t * 2.4) * 0.25;
    }
    const collectors = this._collectors();
    for (const e of collectors) {
      const p = e.object.position;
      if (inPickupRange(this.center, this.radius, p)) {
        this.collectBy(e);
        if (!this.active) break;
      }
    }
  }

  _collectors() {
    const live = this.engine?._liveEntities;
    if (!live) return [];
    const out = [];
    for (const e of live) {
      if (e._disposed) continue;
      if (e._inventory || e._health) out.push(e);
    }
    return out;
  }

  /** Remove the pickup (and its visual) from the world. Chainable. */
  dispose() {
    if (this._tickFn && this.engine) {
      try { this.engine.offUpdate(this._tickFn); } catch { /* already gone */ }
      this._tickFn = null;
    }
    if (this._visual) {
      try { this._visual.dispose(); } catch (err) { reportError(this.engine, err); }
      this._visual = null;
    }
    const list = this.world?._pickups;
    if (list) {
      const i = list.indexOf(this);
      if (i >= 0) list.splice(i, 1);
    }
    return this;
  }

  _buildVisual(meshOpt) {
    const engine = this.engine;
    const e = engine.entity();
    if (meshOpt && typeof meshOpt === 'object' && meshOpt.isObject3D) {
      e.object.add(meshOpt);
    } else {
      // Default: small floating octahedron, tinted by kind.
      const palette = { coin: 0xffd23e, heart: 0xe5484d, ammo: 0x8ecae6, key: 0xc9a227 };
      const color = palette[this.kind] ?? 0x9be15d;
      const m = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.35),
        new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.4, emissive: color, emissiveIntensity: 0.35 })
      );
      m.castShadow = true;
      e.object.add(m);
    }
    e.at(this.center.x, this.center.y, this.center.z);
    this._visual = e;
  }
}

// ---------------------------------------------------------------------------
// Hud — DOM-overlay helpers (node-safe: every method no-ops without a DOM)
// ---------------------------------------------------------------------------

const HUD_CSS = 'position:fixed;pointer-events:none;z-index:9999;font-family:system-ui,-apple-system,sans-serif;';

/**
 * Screen-space HUD: health bars, prompt text, crosshair, objective tracker.
 * Every method is chainable and safely no-ops when there is no DOM (node).
 *
 *   const hud = app.hud();
 *   hud.bar('hp', player.health().fraction, { label: 'HP', color: '#e5484d' });
 *   hud.prompt('Press E to talk');
 *   hud.crosshair(true);
 *   hud.objective('Pick moonherbs (2/5)');
 */
export class Hud {
  constructor(engine = null) {
    this._engine = engine;
    this._hasDom = typeof document !== 'undefined' && typeof document.createElement === 'function';
    this._root = null;
    this._bars = new Map();
    this._promptEl = null;
    this._crossEl = null;
    this._objEl = null;
    this._visible = true;
  }

  /** False in node / DOM-less environments — every method below no-ops. */
  get supported() { return this._hasDom; }

  _rootEl() {
    if (!this._hasDom || this._root) return this._root;
    const root = document.createElement('div');
    root.setAttribute('data-vworld-hud', '');
    root.style.cssText = `${HUD_CSS}inset:0;`;
    const host = document.body ?? document.documentElement;
    host.appendChild(root);
    this._root = root;
    return root;
  }

  _el(tag, css) {
    const el = document.createElement(tag);
    el.style.cssText = HUD_CSS + css;
    return el;
  }

  /**
   * Show/update a named progress bar (0..1 fraction, clamped).
   *   hud.bar('hp', 0.75, { label: 'HP', color: '#e5484d' });
   */
  bar(name, fraction, { label = null, color = '#46c46a', width = 220 } = {}) {
    if (!this._hasDom) return this;
    const root = this._rootEl();
    const key = String(name);
    let wrap = this._bars.get(key);
    if (!wrap) {
      wrap = this._el('div', `left:18px;bottom:${18 + this._bars.size * 34}px;width:${width}px;`);
      const lab = this._el('div', 'font-size:11px;color:#fff;opacity:.85;margin-bottom:2px;text-shadow:0 1px 2px #000;');
      const track = this._el('div', `width:100%;height:10px;background:rgba(0,0,0,.45);border-radius:5px;overflow:hidden;`);
      const fill = this._el('div', 'height:100%;width:100%;border-radius:5px;transition:width .15s;');
      wrap.append(lab, track);
      track.append(fill);
      root.append(wrap);
      this._bars.set(key, { wrap, lab, fill });
    }
    const f = Math.min(1, Math.max(0, Number(fraction) || 0));
    const rec = this._bars.get(key);
    rec.lab.textContent = label ?? key;
    rec.fill.style.width = `${Math.round(f * 100)}%`;
    rec.fill.style.background = color;
    return this;
  }

  /** Remove a named bar. Chainable. */
  removeBar(name) {
    const rec = this._bars.get(String(name));
    if (rec) {
      rec.wrap.remove();
      this._bars.delete(String(name));
    }
    return this;
  }

  /** Center-bottom prompt text ("Press E to talk"). Empty string clears. Chainable. */
  prompt(text) {
    if (!this._hasDom) return this;
    const root = this._rootEl();
    if (!this._promptEl) {
      this._promptEl = this._el(
        'div',
        'left:50%;bottom:12%;transform:translateX(-50%);font-size:15px;color:#fff;background:rgba(0,0,0,.55);padding:8px 14px;border-radius:8px;'
      );
      root.append(this._promptEl);
    }
    this._promptEl.textContent = text ?? '';
    this._promptEl.style.display = text ? 'block' : 'none';
    return this;
  }

  /** Clear the prompt. Chainable. */
  clearPrompt() { return this.prompt(''); }

  /** Toggle a simple crosshair. Chainable. */
  crosshair(show = true) {
    if (!this._hasDom) return this;
    const root = this._rootEl();
    if (!this._crossEl) {
      this._crossEl = this._el(
        'div',
        'left:50%;top:50%;transform:translate(-50%,-50%);font-size:20px;color:rgba(255,255,255,.9);text-shadow:0 1px 2px #000;'
      );
      this._crossEl.textContent = '+';
      root.append(this._crossEl);
    }
    this._crossEl.style.display = show ? 'block' : 'none';
    return this;
  }

  /** Objective tracker (top-left). Empty string clears. Chainable. */
  objective(text) {
    if (!this._hasDom) return this;
    const root = this._rootEl();
    if (!this._objEl) {
      this._objEl = this._el(
        'div',
        'left:18px;top:18px;max-width:320px;font-size:13px;color:#ffe9a8;background:rgba(0,0,0,.5);padding:8px 12px;border-radius:8px;border-left:3px solid #ffd23e;'
      );
      root.append(this._objEl);
    }
    this._objEl.textContent = text ?? '';
    this._objEl.style.display = text ? 'block' : 'none';
    return this;
  }

  /** Clear the objective tracker. Chainable. */
  clearObjective() { return this.objective(''); }

  /** Show the whole HUD. Chainable. */
  show() {
    this._visible = true;
    if (this._root) this._root.style.display = 'block';
    return this;
  }

  /** Hide the whole HUD. Chainable. */
  hide() {
    this._visible = false;
    if (this._root) this._root.style.display = 'none';
    return this;
  }

  /** Remove every HUD element. Chainable. */
  dispose() {
    if (this._root) {
      this._root.remove();
      this._root = null;
    }
    this._bars.clear();
    this._promptEl = this._crossEl = this._objEl = null;
    return this;
  }
}
