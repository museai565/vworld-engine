import { toVec3, toNumber, withDefaults } from './util/normalize.js';

/**
 * Time — scheduling + tweening without boilerplate.
 *
 *   app.after(2, () => door.open());          // run once after 2s
 *   const h = app.every(1, () => spawner.tick()); // repeat; h.cancel()
 *   app.tween(entity)
 *     .to({ at: [10, 0, 0], opacity: 0 }, 2) // 2 seconds
 *     .ease('outCubic')
 *     .then(() => entity.destroy());
 *
 * Tweens run on the engine's per-frame tick. Durations are real seconds.
 */

// --- easing functions (pure math — unit-testable) ---------------------------
export const EASES = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outBack: (t) => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
  outElastic: (t) => {
    if (t === 0 || t === 1) return t;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
  },
};

export function easeValue(name, t) {
  const fn = EASES[name] ?? EASES.linear;
  return fn(Math.min(1, Math.max(0, t)));
}

// --- cancellable handle -------------------------------------------------------
class Handle {
  constructor(cancel) {
    this._cancel = cancel;
    this.cancelled = false;
  }
  cancel() {
    if (!this.cancelled) {
      this.cancelled = true;
      this._cancel();
    }
    return this;
  }
}

// --- tween --------------------------------------------------------------------
class Tween {
  constructor(time, entity) {
    this._time = time;
    this._entity = entity;
    this._props = null;
    this._dur = 1;
    this._ease = 'linear';
    this._then = [];
    this._elapsed = 0;
    this._done = false;
    this._from = null;
    this._started = false;
  }

  /**
   * Target properties over `duration` seconds.
   * Supported: at (any toVec3 shape), opacity 0..1, scale (number or [x,y,z]).
   */
  to(props, duration = 1) {
    this._props = { ...(props || {}) };
    this._dur = Math.max(0.001, toNumber(duration, 'duration'));
    return this;
  }

  ease(name) {
    if (!EASES[name]) {
      console.warn(`[VWorld] Unknown ease "${name}" — falling back to linear. Try: ${Object.keys(EASES).join(', ')}`);
      name = 'linear';
    }
    this._ease = name;
    return this;
  }

  then(fn) {
    if (typeof fn === 'function') this._then.push(fn);
    return this;
  }
  onComplete(fn) { return this.then(fn); }

  cancel() {
    this._done = true;
    return this;
  }

  get done() { return this._done; }

  _captureFrom() {
    const e = this._entity.object;
    const from = {};
    if (this._props.at !== undefined) from.at = e.position.clone();
    if (this._props.opacity !== undefined) {
      from.opacity = [];
      e.traverse((o) => {
        if (o.isMesh && o.material && 'opacity' in o.material) {
          o.material.transparent = true;
          from.opacity.push(o.material.opacity);
        }
      });
    }
    if (this._props.scale !== undefined) from.scale = e.scale.clone();
    this._from = from;
  }

  _apply(k) {
    const e = this._entity.object;
    const p = this._props;
    if (p.at !== undefined) {
      const target = toVec3(p.at);
      e.position.lerpVectors(this._from.at, target, k);
    }
    if (p.opacity !== undefined) {
      let i = 0;
      e.traverse((o) => {
        if (o.isMesh && o.material && 'opacity' in o.material) {
          o.material.transparent = true;
          o.material.opacity = this._from.opacity[i] + (p.opacity - this._from.opacity[i]) * k;
          i++;
        }
      });
    }
    if (p.scale !== undefined) {
      const s = typeof p.scale === 'number' ? [p.scale, p.scale, p.scale] : p.scale;
      const target = toVec3(s[0], s[1], s[2]);
      e.scale.lerpVectors(this._from.scale, target, k);
    }
  }

  /** Advance by dt seconds. Returns true when finished. */
  update(dt) {
    if (this._done) return true;
    if (!this._started) {
      this._started = true;
      this._captureFrom();
    }
    this._elapsed += dt;
    const t = Math.min(1, this._elapsed / this._dur);
    this._apply(easeValue(this._ease, t));
    if (t >= 1) {
      this._done = true;
      for (const fn of this._then) {
        try { fn(this._entity); } catch (err) { console.error('[VWorld] tween .then() threw:', err); }
      }
    }
    return this._done;
  }
}

// --- the Time subsystem ---------------------------------------------------------
export class Time {
  constructor(engine) {
    this.engine = engine;
    this._timers = new Set();
    this._tweens = new Set();
    // Drive everything from one engine hook — no manual wiring.
    engine.on('tick', (dt) => this._update(dt));
  }

  /** Run fn once after `seconds`. Returns a cancellable handle. */
  after(seconds, fn) {
    const s = toNumber(seconds, 'seconds');
    if (typeof fn !== 'function') throw new Error('[VWorld] app.after(seconds, fn) — fn must be a function.');
    const t = { remaining: s, fn, repeat: 0, handle: null };
    t.handle = new Handle(() => this._timers.delete(t));
    this._timers.add(t);
    return t.handle;
  }

  /** Run fn every `seconds`. Returns a cancellable handle. */
  every(seconds, fn) {
    const s = toNumber(seconds, 'seconds');
    if (s <= 0) throw new Error('[VWorld] app.every() needs a positive interval.');
    if (typeof fn !== 'function') throw new Error('[VWorld] app.every(seconds, fn) — fn must be a function.');
    const t = { remaining: s, interval: s, fn, repeat: Infinity, handle: null };
    t.handle = new Handle(() => this._timers.delete(t));
    this._timers.add(t);
    return t.handle;
  }

  /** Start a tween on an entity. */
  tween(entity) {
    const tw = new Tween(this, entity);
    this._tweens.add(tw);
    return tw;
  }

  _update(dt) {
    for (const t of [...this._timers]) {
      t.remaining -= dt;
      if (t.remaining <= 0) {
        try { t.fn(); } catch (err) { console.error('[VWorld] timer callback threw:', err); }
        if (t.repeat === Infinity) {
          t.remaining += t.interval;
        } else {
          t.handle.cancelled = true;
          this._timers.delete(t);
        }
      }
    }
    for (const tw of [...this._tweens]) {
      if (tw.update(dt)) this._tweens.delete(tw);
    }
  }

  get pendingCount() {
    return this._timers.size + this._tweens.size;
  }
}
