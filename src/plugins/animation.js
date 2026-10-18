import * as THREE from 'three';
import { toNumber, withDefaults } from '../util/normalize.js';

/**
 * AnimationPlugin — skeletal clips AND a procedural fallback.
 *
 *   app.use(AnimationPlugin);
 *   app.animation.register('dance', danceClip);   // THREE.AnimationClip
 *   const avatar = await app.assets.characters.spawn('cyber-ninja');
 *   avatar.userData.clips = { dance: danceClip };  // per-entity clips
 *
 *   const a = someEntity.anim();                   // Animator
 *   a.play('walk');
 *   a.play('walk', { speed: 1.5, loop: true, fade: 0.25 });
 *   a.blend('walk', 'run', 0.6);
 *   a.on('finished:jump', () => a.play('idle'));
 *   a.stop();
 *
 * No clips? No problem: 'idle' | 'walk' | 'run' always work procedurally —
 * the built-in default character animates with zero assets (gentle bob,
 * lean, and sway driven by a phase clock).
 */

export const AnimationPlugin = {
  name: 'animation',
  install(app) {
    app.animation = new AnimationSystem(app);
  },
};

// Procedural locomotion parameters: amplitude of bob, sway, lean.
const PROCEDURAL = {
  idle: { bob: 0.025, freq: 2.2, sway: 0.008, lean: 0.0 },
  walk: { bob: 0.06,  freq: 8.0, sway: 0.035, lean: 0.09 },
  run:  { bob: 0.1,   freq: 12.0, sway: 0.05, lean: 0.16 },
};

class Animator {
  constructor(system, entity) {
    this.system = system;
    this.entity = entity;
    this.mixer = null;
    this._actions = new Map();   // name -> AnimationAction
    this._current = null;
    this._proc = null;           // { name, speed, t }
    this._baseY = entity.object.position.y;
    this._finishedListeners = new Map(); // clipName -> Set<fn>
    this._tick = (dt) => this._update(dt);
    system.app.on('tick', this._tick);
    this._disposed = false;
  }

  _clips() {
    return {
      ...this.system.clips,
      ...(this.entity.object.userData.clips || {}),
    };
  }

  _ensureMixer() {
    if (!this.mixer) {
      this.mixer = new THREE.AnimationMixer(this.entity.object);
      this.mixer.addEventListener('finished', (e) => {
        const name = e.action?.getClip?.()?.name;
        for (const fn of this._finishedListeners.get(name) ?? []) {
          try { fn(this.entity); } catch (err) { console.error('[VWorld] animation finished listener threw:', err); }
        }
      });
    }
    return this.mixer;
  }

  /**
   * Play a clip by name. Falls back to procedural locomotion for
   * 'idle' | 'walk' | 'run' when no clip is registered.
   */
  play(name, options = {}) {
    const o = withDefaults(options, { speed: 1, loop: true, fade: 0.25 });
    const clip = this._clips()[name];
    if (clip && clip.isAnimationClip) {
      this._stopProcedural();
      const mixer = this._ensureMixer();
      let action = this._actions.get(name);
      if (!action) {
        action = mixer.clipAction(clip);
        this._actions.set(name, action);
      }
      const fade = toNumber(o.fade, 'fade');
      if (this._current && this._current !== action) this._current.fadeOut(fade);
      action.reset()
        .setLoop(o.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
        .setEffectiveTimeScale(toNumber(o.speed, 'speed'))
        .fadeIn(fade)
        .play();
      action.clampWhenFinished = !o.loop;
      this._current = action;
    } else if (PROCEDURAL[name]) {
      this._startProcedural(name, o);
    } else {
      const known = [...Object.keys(this._clips()), ...Object.keys(PROCEDURAL)].join(', ') || '(none)';
      throw new Error(`[VWorld] Unknown animation "${name}". Registered: ${known}.`);
    }
    return this;
  }

  /**
   * Cross-blend two skeletal clips: `blend('walk', 'run', 0.6)` →
   * 40% walk, 60% run. Mixer clips only.
   */
  blend(a, b, t = 0.5, { fade = 0.25 } = {}) {
    const clips = this._clips();
    if (!clips[a]?.isAnimationClip || !clips[b]?.isAnimationClip) {
      throw new Error(`[VWorld] blend() needs two registered AnimationClips — got "${a}", "${b}".`);
    }
    this._stopProcedural();
    const mixer = this._ensureMixer();
    const get = (n) => {
      let act = this._actions.get(n);
      if (!act) { act = mixer.clipAction(clips[n]); this._actions.set(n, act); }
      return act;
    };
    const aa = get(a), bb = get(b);
    if (this._current && this._current !== aa && this._current !== bb) this._current.fadeOut(fade);
    const k = Math.min(1, Math.max(0, toNumber(t, 't')));
    aa.reset().setEffectiveWeight(1 - k).fadeIn(fade).play();
    bb.reset().setEffectiveWeight(k).fadeIn(fade).play();
    this._current = k >= 0.5 ? bb : aa;
    return this;
  }

  /** Stop all animation and reset the procedural pose. */
  stop() {
    if (this._current) { this._current.stop(); this._current = null; }
    this._stopProcedural();
    return this;
  }

  /**
   * `a.on('finished:jump', fn)` — fires when a non-looping clip ends.
   * (Procedural clips loop forever, so they never "finish".)
   */
  on(event, fn) {
    const m = /^finished:(.+)$/.exec(String(event));
    if (!m) throw new Error(`[VWorld] animator.on() — unknown event "${event}". Try 'finished:<clipName>'.`);
    if (typeof fn !== 'function') throw new Error('[VWorld] animator.on(event, fn) — fn must be a function.');
    if (!this._finishedListeners.has(m[1])) this._finishedListeners.set(m[1], new Set());
    this._finishedListeners.get(m[1]).add(fn);
    return this;
  }

  get playing() {
    return this._proc ? this._proc.name : (this._current?.getClip()?.name ?? null);
  }

  // --- procedural fallback -------------------------------------------------------
  _startProcedural(name, o) {
    if (this._current) { this._current.fadeOut(toNumber(o.fade, 'fade')); this._current = null; }
    this._proc = { name, speed: toNumber(o.speed, 'speed'), t: Math.random() * 10 };
    this._baseY = this.entity.object.position.y;
  }

  _stopProcedural() {
    if (!this._proc) return;
    this._proc = null;
    // Ease back to a neutral pose instead of snapping.
    this.entity.object.position.y = this._baseY;
    this.entity.object.rotation.x *= 0.2;
    this.entity.object.rotation.z *= 0.2;
  }

  _update(dt) {
    if (this._disposed) return;
    if (this.mixer) this.mixer.update(dt);
    if (this._proc) {
      const p = PROCEDURAL[this._proc.name];
      this._proc.t += dt * p.freq * this._proc.speed;
      const t = this._proc.t;
      const obj = this.entity.object;
      obj.position.y = this._baseY + Math.abs(Math.sin(t)) * p.bob;
      obj.rotation.x = p.lean + Math.sin(t * 2) * p.sway * 0.4;
      obj.rotation.z = Math.sin(t) * p.sway;
    }
  }

  dispose() {
    this._disposed = true;
    this.system.app.off('tick', this._tick);
    this._stopProcedural();
  }
}

class AnimationSystem {
  constructor(app) {
    this.app = app;
    this.clips = {};   // name -> THREE.AnimationClip (global registry)
    this._animators = new Set();
    app.on('dispose', () => {
      for (const a of [...this._animators]) a.dispose();
      this._animators.clear();
    });
  }

  /** Register a global clip: `app.animation.register('dance', clip)`. */
  register(name, clip) {
    if (!clip || !clip.isAnimationClip) {
      throw new Error('[VWorld] register() needs a THREE.AnimationClip — got ' + (clip === null ? 'null' : typeof clip) + '.');
    }
    this.clips[String(name)] = clip;
    return this;
  }

  /** Get (or create) the Animator for an entity. */
  for(entity) {
    if (!entity || !entity.object) throw new Error('[VWorld] app.animation.for() needs an Entity.');
    if (!entity._animator) {
      entity._animator = new Animator(this, entity);
      this._animators.add(entity._animator);
    }
    return entity._animator;
  }

  /** Procedural locomotion names that always work, no assets needed. */
  get procedural() { return Object.keys(PROCEDURAL); }
}
