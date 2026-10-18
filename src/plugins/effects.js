import * as THREE from 'three';
import { toVec3, toNumber, withDefaults } from '../util/normalize.js';

/**
 * EffectsPlugin — GPU-friendly particle bursts with game-DX.
 *
 *   app.use(EffectsPlugin);
 *   app.effects.burst('fire');                          // at origin
 *   app.effects.burst('fire', [10, 1, 5]);               // any toVec3 shape
 *   app.effects.burst('fire', enemy);                    // Entity works
 *   app.effects.burst({ type: 'smoke', at, count: 200, color: 0x555555,
 *                       size: 2, lifetime: 4, spread: 1.5, rise: 2 });
 *   const t = app.effects.trail(player, 'sparkle');      // emits while moving
 *   t.stop();
 *   app.effects.clear('fire');                           // remove by tag
 *
 * Presets: fire, smoke, sparkle, dust. Each burst is one THREE.Points
 * object — cheap enough for dozens of simultaneous bursts.
 */

const PRESETS = {
  fire:    { count: 60,  color: [0xff7a1a, 0xffc93c], size: 0.55, lifetime: 0.9, spread: 0.5, rise: 2.6,  gravity: 1.2,  blending: 'additive', tag: 'fire' },
  smoke:   { count: 40,  color: [0x555555, 0x888888], size: 1.4,  lifetime: 2.8, spread: 0.8, rise: 1.4,  gravity: -0.4, blending: 'normal',   tag: 'smoke', growth: 1.8 },
  sparkle: { count: 50,  color: [0xfff6c9, 0xffd76a], size: 0.32, lifetime: 1.2, spread: 1.6, rise: 0.6,  gravity: -1.5, blending: 'additive', tag: 'sparkle' },
  dust:    { count: 36,  color: [0xcbb68f, 0xa8906a], size: 0.8,  lifetime: 1.6, spread: 1.2, rise: 0.5,  gravity: -0.8, blending: 'normal',   tag: 'dust' },
};

export const EffectsPlugin = {
  name: 'effects',
  install(app, options = {}) {
    app.effects = new Effects(app, options);
  },
};

class Burst {
  constructor(effects, opts) {
    this.fx = effects;
    const o = withDefaults(opts, {
      type: 'sparkle', at: [0, 0, 0], count: 50, color: 0xffffff,
      size: 0.5, lifetime: 1.2, spread: 1, rise: 1, gravity: 0,
      blending: 'additive', tag: null, growth: 0,
    });
    const preset = typeof opts.type === 'string' || !opts.type ? PRESETS[opts.type ?? 'sparkle'] ?? {} : {};
    // Custom options win over the preset; preset wins over bare defaults.
    const p = { ...o, ...preset, ...opts };
    this.tag = p.tag ?? (typeof opts.type === 'string' ? opts.type : 'burst');
    this.life = toNumber(p.lifetime, 'lifetime');
    this.age = 0;
    this.dead = false;

    const count = Math.max(1, Math.round(toNumber(p.count, 'count')));
    const origin = toVec3(p.at);
    const colors = Array.isArray(p.color) ? p.color : [p.color];
    const spread = toNumber(p.spread, 'spread');

    this.positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    this.lives = new Float32Array(count);
    const colAttr = new Float32Array(count * 3);
    const c = new THREE.Color();

    for (let i = 0; i < count; i++) {
      this.positions[i * 3] = origin.x + (Math.random() - 0.5) * 0.3;
      this.positions[i * 3 + 1] = origin.y + (Math.random() - 0.5) * 0.3;
      this.positions[i * 3 + 2] = origin.z + (Math.random() - 0.5) * 0.3;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      const sp = spread * (0.3 + Math.random() * 0.7);
      this.velocities[i * 3] = Math.sin(ph) * Math.cos(th) * sp;
      this.velocities[i * 3 + 1] = Math.abs(Math.cos(ph)) * sp * 0.7 + toNumber(p.rise, 'rise') * Math.random();
      this.velocities[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * sp;
      this.lives[i] = this.life * (0.6 + Math.random() * 0.4);
      c.set(colors[(Math.random() * colors.length) | 0]);
      colAttr[i * 3] = c.r; colAttr[i * 3 + 1] = c.g; colAttr[i * 3 + 2] = c.b;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colAttr, 3));
    const mat = new THREE.PointsMaterial({
      size: toNumber(p.size, 'size'),
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: p.blending === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.gravity = toNumber(p.gravity, 'gravity');
    this.growth = toNumber(p.growth, 'growth');
    this.baseSize = toNumber(p.size, 'size');
    effects.app.scene.add(this.points);
  }

  update(dt) {
    if (this.dead) return true;
    this.age += dt;
    const n = this.lives.length;
    let alive = 0;
    for (let i = 0; i < n; i++) {
      if (this.lives[i] <= 0) {
        // park dead particles far underground
        this.positions[i * 3 + 1] = -1000;
        continue;
      }
      alive++;
      this.lives[i] -= dt;
      this.velocities[i * 3 + 1] += this.gravity * dt;
      this.positions[i * 3] += this.velocities[i * 3] * dt;
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * dt;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    const frac = Math.max(0, 1 - this.age / (this.life * 1.1));
    this.points.material.opacity = 0.95 * frac;
    if (this.growth) this.points.material.size = this.baseSize * (1 + this.growth * (this.age / this.life));
    if (alive === 0) {
      this.dispose();
      return true;
    }
    return false;
  }

  dispose() {
    if (this.dead) return;
    this.dead = true;
    this.points.removeFromParent();
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}

class Trail {
  constructor(effects, entity, preset, options = {}) {
    this.fx = effects;
    this.entity = entity;
    this.preset = preset;
    this.o = withDefaults(options, { interval: 0.08, size: 0.5 });
    this._t = 0;
    this.stopped = false;
    this._pos = new THREE.Vector3();
  }
  update(dt) {
    if (this.stopped) return;
    this._t -= dt;
    if (this._t <= 0) {
      this._t = this.o.interval;
      this.entity.object.getWorldPosition(this._pos);
      this.fx.burst({ type: this.preset, at: this._pos, count: 6, size: this.o.size, lifetime: 0.7 });
    }
  }
  stop() { this.stopped = true; return this; }
}

class Effects {
  constructor(app, options = {}) {
    this.app = app;
    this.o = withDefaults(options, { maxBursts: 64 });
    this._bursts = new Set();
    this._trails = new Set();
    app.on('tick', (dt) => this._update(dt));
    app.on('dispose', () => this.clear());
  }

  /** Named presets available. */
  get presets() { return Object.keys(PRESETS); }

  /**
   * Spawn a burst. `preset`: name | full options object.
   * `at`: any toVec3 shape (second arg or inside options).
   */
  burst(preset, at) {
    let opts;
    if (typeof preset === 'string') {
      opts = { type: preset };
      if (at !== undefined) opts.at = at;
    } else if (preset && typeof preset === 'object') {
      opts = { ...preset };
      if (at !== undefined) opts.at = at;
    } else {
      throw new Error('[VWorld] burst() needs a preset name or options object — e.g. burst(\'fire\', [1,2,3]).');
    }
    if (this._bursts.size >= this.o.maxBursts) {
      console.warn(`[VWorld] Too many particle bursts (${this.o.maxBursts}) — oldest removed.`);
      const oldest = this._bursts.values().next().value;
      if (oldest) { oldest.dispose(); this._bursts.delete(oldest); }
    }
    const b = new Burst(this, opts);
    this._bursts.add(b);
    return b;
  }

  /** Emit small bursts at an entity's position on an interval. Returns { stop() }. */
  trail(entity, preset = 'sparkle', options = {}) {
    if (!entity || !entity.object) throw new Error('[VWorld] trail() needs an Entity.');
    const t = new Trail(this, entity, preset, options);
    this._trails.add(t);
    return t;
  }

  /** Remove bursts by tag (preset names are auto-tags). */
  clear(tag) {
    for (const b of [...this._bursts]) {
      if (tag === undefined || b.tag === tag) {
        b.dispose();
        this._bursts.delete(b);
      }
    }
    if (tag === undefined) {
      for (const t of this._trails) t.stop();
      this._trails.clear();
    }
    return this;
  }

  get activeCount() { return this._bursts.size; }

  _update(dt) {
    for (const b of [...this._bursts]) {
      if (b.update(dt)) this._bursts.delete(b);
    }
    for (const t of [...this._trails]) {
      t.update(dt);
      if (t.stopped) this._trails.delete(t);
    }
  }
}
