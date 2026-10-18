import * as THREE from 'three';
import { toVec3, toNumber, withDefaults } from './util/normalize.js';

/**
 * AI — steering agents with Rapier-aware movement.
 *
 *   const npc = app.ai.agent(entity).speed(3.5);
 *   npc.goto([50, 0, 30]);                 // one-shot, any toVec3 shape
 *   npc.goto(player);                      // Entity works too
 *   npc.wander({ min: [-40,0,-40], max: [40,0,40] });
 *   npc.follow(player, 4);                 // keep 4m distance
 *   npc.flee(danger);                      // run away, continuously
 *   npc.state({
 *     idle:  { enter(a){}, update(dt,a){} },
 *     chase: { update(dt,a){ a.goto(player); } },
 *   });
 *   npc.when(() => nearPlayer(), 'chase'); // transitions checked each tick
 *   npc.to('idle');
 *
 * Movement is collision-aware: each step shape-casts against the Rapier
 * world so agents slide along walls instead of tunneling through them.
 * (Pair with a kinematic physics body if you want full rigid-body response.)
 */

// --- tiny pure state machine (unit-testable, no engine needed) ----------------
export class StateMachine {
  constructor(states = {}) {
    this.states = { ...states };
    this.current = null;
    this._transitions = [];
  }

  add(name, def) {
    this.states[name] = def || {};
    return this;
  }

  /** Switch state now. Calls exit(old) then enter(new). */
  to(name, ctx) {
    const next = this.states[name];
    if (!next) throw new Error(`[VWorld] Unknown AI state "${name}". Available: ${Object.keys(this.states).join(', ') || '(none)'}`);
    if (this.current && this.states[this.current].exit) {
      this.states[this.current].exit(ctx);
    }
    this.current = name;
    if (next.enter) next.enter(ctx);
    return this;
  }

  /** Register a transition: when cond(ctx) is true, switch to `name`. */
  when(cond, name) {
    if (typeof cond !== 'function') throw new Error('[VWorld] ai.when(cond, name) — cond must be a function.');
    this._transitions.push({ cond, name });
    return this;
  }

  /** Evaluate transitions, then run the current state's update. */
  update(dt, ctx) {
    for (const t of this._transitions) {
      let hit = false;
      try { hit = t.cond(ctx); } catch (err) { console.error('[VWorld] AI transition threw:', err); }
      if (hit && t.name !== this.current) {
        this.to(t.name, ctx);
        break; // one transition per tick
      }
    }
    const s = this.current && this.states[this.current];
    if (s && s.update) {
      try { s.update(dt, ctx); } catch (err) { console.error('[VWorld] AI state update threw:', err); }
    }
    return this;
  }
}

// --- steering agent --------------------------------------------------------------
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

class Agent {
  constructor(ai, entity) {
    this.ai = ai;
    this.engine = ai.engine;
    this.entity = entity;
    this.speedValue = 3.5;
    this.radius = 0.4;
    this.arriveDistance = 0.4;
    this._mode = 'idle';       // idle | goto | wander | follow | flee
    this._target = new THREE.Vector3();
    this._targetEntity = null;
    this._followDist = 3;
    this._wanderArea = null;
    this._wanderTimer = 0;
    this._onArrive = null;
    this.machine = null;
  }

  speed(v) { this.speedValue = toNumber(v, 'speed'); return this; }
  bodyRadius(r) { this.radius = toNumber(r, 'radius'); return this; }

  /** One-shot move. `dest` accepts any toVec3 shape. */
  goto(dest, { arrive, onArrive } = {}) {
    this._target.copy(toVec3(dest));
    this._targetEntity = null;
    if (arrive !== undefined) this.arriveDistance = toNumber(arrive, 'arrive');
    this._onArrive = typeof onArrive === 'function' ? onArrive : null;
    this._mode = 'goto';
    return this;
  }

  /** Roam random points inside a box: { min:[..], max:[..] } or { center, size }. */
  wander(area = {}) {
    const a = withDefaults(area, {});
    if (a.min && a.max) {
      this._wanderArea = { min: toVec3(a.min), max: toVec3(a.max) };
    } else {
      const c = toVec3(a.center ?? [0, 0, 0]);
      const s = toNumber(a.size ?? 40, 'size') / 2;
      this._wanderArea = { min: new THREE.Vector3(c.x - s, c.y, c.z - s), max: new THREE.Vector3(c.x + s, c.y, c.z + s) };
    }
    this._wanderTimer = 0;
    this._mode = 'wander';
    return this;
  }

  /** Keep `dist` meters from a target (Entity or position). */
  follow(target, dist = 3) {
    this._targetEntity = target;
    this._followDist = toNumber(dist, 'dist');
    this._mode = 'follow';
    return this;
  }

  /** Run away from a threat (Entity or position), repathing continuously. */
  flee(danger) {
    this._targetEntity = danger;
    this._mode = 'flee';
    return this;
  }

  stop() {
    this._mode = 'idle';
    this._onArrive = null;
    return this;
  }

  /** Attach a state machine: { name: { enter?, update?, exit? } }. */
  state(states) {
    this.machine = new StateMachine(states);
    const names = Object.keys(states);
    if (names.length) this.machine.to(names[0], this);
    return this;
  }

  to(name) {
    if (!this.machine) throw new Error('[VWorld] agent.to() needs agent.state({...}) first.');
    this.machine.to(name, this);
    return this;
  }

  when(cond, name) {
    if (!this.machine) throw new Error('[VWorld] agent.when() needs agent.state({...}) first.');
    this.machine.when(cond, name);
    return this;
  }

  get mode() { return this._mode; }
  get stateName() { return this.machine?.current ?? null; }

  /** Distance to the current target (Infinity when idle). */
  distanceToTarget() {
    if (this._mode === 'idle') return Infinity;
    return this.entity.object.position.distanceTo(this._target);
  }

  // --- per-tick ---------------------------------------------------------------
  _pickWanderTarget() {
    const { min, max } = this._wanderArea;
    this._target.set(
      min.x + Math.random() * (max.x - min.x),
      min.y,
      min.z + Math.random() * (max.z - min.z)
    );
  }

  _resolveTarget(dt) {
    const pos = this.entity.object.position;
    switch (this._mode) {
      case 'goto':
        break; // _target already set
      case 'wander': {
        this._wanderTimer -= dt;
        if (this._wanderTimer <= 0 || pos.distanceTo(this._target) < this.arriveDistance * 2) {
          this._pickWanderTarget();
          this._wanderTimer = 2 + Math.random() * 3;
        }
        break;
      }
      case 'follow': {
        const tp = toVec3(this._targetEntity);
        _v1.copy(pos).sub(tp);
        const d = _v1.length();
        if (d <= this._followDist) return null; // close enough — hold
        this._target.copy(tp);
        break;
      }
      case 'flee': {
        const dp = toVec3(this._targetEntity);
        _v1.copy(pos).sub(dp);
        if (_v1.lengthSq() < 1e-6) _v1.set(1, 0, 0);
        _v1.normalize();
        this._target.copy(pos).addScaledVector(_v1, 12);
        break;
      }
      default:
        return null;
    }
    return this._target;
  }

  _step(dt) {
    if (this.machine) this.machine.update(dt, this);
    const target = this._resolveTarget(dt);
    if (!target) return;

    const pos = this.entity.object.position;
    _v2.copy(target).sub(pos);
    _v2.y = 0; // agents steer on the ground plane
    const dist = _v2.length();
    if (dist < 1e-4) return;

    // Arrival slowdown: ease into the target instead of orbiting it.
    const slow = Math.min(1, dist / Math.max(0.001, this.arriveDistance * 4));
    _v2.normalize().multiplyScalar(this.speedValue * slow);
    const stepLen = _v2.length() * dt;

    // Rapier-aware: ray-cast so we slide along walls, never tunnel.
    const move = this.ai._collideMove(pos, _v2, stepLen, this.radius);
    pos.addScaledVector(move.dir, move.dist);

    // Face travel direction.
    if (move.dir.lengthSq() > 1e-6) {
      const yaw = Math.atan2(move.dir.x, move.dir.z);
      const obj = this.entity.object;
      let d = yaw - obj.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      obj.rotation.y += d * Math.min(1, dt * 10);
    }

    if (this._mode === 'goto' && dist <= this.arriveDistance) {
      this._mode = 'idle';
      const cb = this._onArrive;
      this._onArrive = null;
      if (cb) { try { cb(this); } catch (err) { console.error('[VWorld] goto onArrive threw:', err); } }
    }
  }
}

// --- the AI subsystem ------------------------------------------------------------
export class AI {
  constructor(engine) {
    this.engine = engine;
    this._agents = new Set();
    engine.onFixedUpdate((dt) => {
      for (const a of [...this._agents]) {
        try { a._step(dt); } catch (err) { console.error('[VWorld] AI agent threw:', err); }
      }
    });
  }

  /** Create a steering agent around an Entity. */
  agent(entity) {
    if (!entity || !entity.object) {
      throw new Error('[VWorld] app.ai.agent() needs an Entity — got ' + (entity === null ? 'null' : typeof entity) + '.');
    }
    const a = new Agent(this, entity);
    this._agents.add(a);
    return a;
  }

  /** Remove an agent (it keeps existing as a plain entity). */
  release(agent) {
    this._agents.delete(agent);
    return this;
  }

  get count() { return this._agents.size; }

  /**
   * Collision-aware move via forward ray casts (the bundled Rapier 0.14
   * build's shape-cast doesn't cooperate, but rays are verified working).
   * Returns { dir, dist }: the travelable distance along `dir`, or a
   * whisker direction (±40°) when that slides further along a wall.
   */
  _collideMove(pos, dir, distance, radius = 0.4) {
    const physics = this.engine.physics;
    const fallback = { dir: dir.clone(), dist: distance };
    if (!physics.world || !physics.RAPIER.Ray) return fallback;
    try {
      const R = physics.RAPIER;
      const UP = new THREE.Vector3(0, 1, 0);
      const probe = (d) => {
        const ray = new R.Ray(
          { x: pos.x + d.x * radius * 0.5, y: pos.y + 0.6, z: pos.z + d.z * radius * 0.5 },
          { x: d.x, y: 0, z: d.z }
        );
        const hit = physics.world.castRay(ray, distance + radius, true);
        const toi = hit ? hit.timeOfImpact : Infinity;
        return Math.max(0, Math.min(distance, toi - radius * 0.5));
      };
      const straight = probe(dir);
      if (straight >= distance * 0.95) return { dir: dir.clone(), dist: straight };
      // Blocked — try whiskers for natural wall sliding.
      const l = dir.clone().applyAxisAngle(UP, 0.7);
      const r = dir.clone().applyAxisAngle(UP, -0.7);
      const tl = probe(l), tr = probe(r);
      if (tl >= tr && tl > straight) return { dir: l, dist: tl };
      if (tr > straight) return { dir: r, dist: tr };
      return { dir: dir.clone(), dist: straight };
    } catch {
      return fallback; // never let collision probing break movement
    }
  }
}
