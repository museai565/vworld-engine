import * as THREE from 'three';
import { toVec3, toNumber, withDefaults } from '../util/normalize.js';

/**
 * AudioPlugin — Web Audio with game-DX.
 *
 *   app.use(AudioPlugin);
 *   app.audio.register('laser', 'sfx/laser.mp3');
 *   app.audio.play('thud');                                   // built-in synth SFX
 *   app.audio.play('laser', { at: enemy, volume: 0.6 });      // positional
 *   app.audio.play('laser', { at: [10, 1, 5], loop: true, fade: 2 });
 *   app.audio.ambient('forest.mp3', { volume: 0.3 });
 *   app.audio.zone({ min: [-10,0,-10], max: [10,5,10] }, 'cave');
 *   app.audio.volume(0.8).mute(true);
 *
 * Built-in synthesized SFX (no files needed): thud, click, pop, whoosh.
 * The AudioContext starts on first user gesture (browser rule) — call
 * app.audio.unlock() inside a click handler, or it unlocks lazily on play().
 * Node-safe: every method degrades to a no-op with a warning.
 */

const SYNTH = ['thud', 'click', 'pop', 'whoosh'];

export const AudioPlugin = {
  name: 'audio',
  install(app, options = {}) {
    app.audio = new AudioEngine(app, options);
  },
};

class AudioEngine {
  constructor(app, options = {}) {
    this.app = app;
    this.o = withDefaults(options, { masterVolume: 1, muted: false });
    this.ctx = null;
    this.master = null;
    this._buffers = new Map();   // name -> AudioBuffer (loaded or synthesized)
    this._loading = new Map();   // name -> Promise
    this._positional = new Set(); // { panner, entity?, pos:Vector3, gain }
    this._zones = [];            // { min, max, convolver, gain }
    this._unlocked = false;

    app.on('tick', () => this._update());
    app.on('dispose', () => this.dispose());
  }

  get ready() { return !!this.ctx; }

  /** Create/resume the AudioContext. Call from a user gesture. */
  unlock() {
    if (typeof window === 'undefined' || !window.AudioContext) {
      console.warn('[VWorld] Web Audio is not available in this environment.');
      return false;
    }
    if (!this.ctx) {
      this.ctx = new window.AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.o.muted ? 0 : this.o.masterVolume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    this._unlocked = true;
    return true;
  }

  _needCtx() {
    if (!this.unlock()) return null;
    return this.ctx;
  }

  // --- asset registration ------------------------------------------------------
  /** Register a named sound from a URL (fetched + decoded on first play). */
  register(name, url) {
    this._buffers.delete(String(name));
    this._loading.set(String(name), url);
    return this;
  }

  has(name) {
    return SYNTH.includes(name) || this._buffers.has(name) || this._loading.has(name);
  }

  async _resolveBuffer(target) {
    if (target && typeof target.getChannelData === 'function') return target; // AudioBuffer
    const name = String(target);
    if (this._buffers.has(name)) return this._buffers.get(name);
    if (SYNTH.includes(name)) {
      const buf = this._synthesize(name);
      this._buffers.set(name, buf);
      return buf;
    }
    const url = this._loading.get(name);
    if (!url) throw new Error(`[VWorld] Unknown sound "${name}". Register it with app.audio.register('${name}', url) — or use a built-in: ${SYNTH.join(', ')}.`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`[VWorld] Could not fetch sound "${name}" from ${url} (HTTP ${res.status}).`);
    const data = await res.arrayBuffer();
    const buf = await this.ctx.decodeAudioData(data);
    this._buffers.set(name, buf);
    return buf;
  }

  // --- synthesized SFX (zero files needed) ---------------------------------------
  _synthesize(kind) {
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const mk = (dur) => {
      const buf = ctx.createBuffer(1, Math.ceil(sr * dur), sr);
      return { buf, d: buf.getChannelData(0) };
    };
    if (kind === 'thud') {
      const { buf, d } = mk(0.28);
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        d[i] = Math.sin(2 * Math.PI * (90 - t * 220) * t) * Math.exp(-t * 18) * 0.9;
      }
      return buf;
    }
    if (kind === 'click') {
      const { buf, d } = mk(0.07);
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        d[i] = Math.sin(2 * Math.PI * 2400 * t) * Math.exp(-t * 90) * 0.5;
      }
      return buf;
    }
    if (kind === 'pop') {
      const { buf, d } = mk(0.16);
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        d[i] = Math.sin(2 * Math.PI * (300 + t * 1800) * t) * Math.exp(-t * 22) * 0.7;
      }
      return buf;
    }
    // whoosh: filtered noise swell
    const { buf, d } = mk(0.6);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      const n = Math.random() * 2 - 1;
      last = last * 0.92 + n * 0.08;
      const env = Math.sin(Math.PI * Math.min(1, t / 0.6));
      d[i] = last * env * 1.6;
    }
    return buf;
  }

  // --- playback --------------------------------------------------------------------
  /**
   * Play a sound. `target`: registered name | built-in SFX | AudioBuffer.
   * Options: { at (Entity|vec3|...), volume, loop, fade (s), rate }.
   * Returns a handle: { stop(fade?), setVolume(v), node }.
   */
  async play(target, options = {}) {
    const ctx = this._needCtx();
    if (!ctx) return { stop: () => {}, setVolume: () => {}, node: null };
    const o = withDefaults(options, { at: null, volume: 1, loop: false, fade: 0, rate: 1 });
    let buffer;
    try {
      buffer = await this._resolveBuffer(target);
    } catch (err) {
      console.error(err.message);
      return { stop: () => {}, setVolume: () => {}, node: null };
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = !!o.loop;
    src.playbackRate.value = toNumber(o.rate, 'rate');

    const gain = ctx.createGain();
    const vol = toNumber(o.volume, 'volume');
    if (o.fade > 0 && !o.loop) {
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol), ctx.currentTime + o.fade);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + o.fade + buffer.duration / src.playbackRate.value);
    } else {
      gain.gain.value = vol;
    }

    let out = gain;
    let tracker = null;
    if (o.at !== null && o.at !== undefined) {
      const panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 4;
      panner.maxDistance = 80;
      const pos = toVec3(o.at);
      this._setPanner(panner, pos);
      panner.connect(gain);
      out = panner;
      tracker = { panner, gain, entity: o.at && o.at.object ? o.at : null, pos };
      this._positional.add(tracker);
      src.onended = () => this._positional.delete(tracker);
    }

    src.connect(out);
    gain.connect(this.master);
    src.start();

    const handle = {
      node: src,
      stop: (fade = 0) => {
        try {
          if (fade > 0) {
            gain.gain.cancelScheduledValues(ctx.currentTime);
            gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + fade);
            setTimeout(() => { try { src.stop(); } catch { /* already stopped */ } }, fade * 1000 + 50);
          } else {
            src.stop();
          }
        } catch { /* already stopped */ }
        if (tracker) this._positional.delete(tracker);
      },
      setVolume: (v) => { gain.gain.value = toNumber(v, 'volume'); },
    };
    return handle;
  }

  _setPanner(panner, v) {
    // Modern spec (AudioParams) with legacy fallback.
    if (panner.positionX) {
      panner.positionX.value = v.x; panner.positionY.value = v.y; panner.positionZ.value = v.z;
    } else if (panner.setPosition) {
      panner.setPosition(v.x, v.y, v.z);
    }
  }

  /** Looping background sound. Returns a handle with stop(). */
  ambient(target, { volume = 0.35 } = {}) {
    return this.play(target, { volume, loop: true });
  }

  /**
   * Reverb zone: inside the box, sounds route through a generated impulse.
   *   app.audio.zone({ min: [-10,0,-10], max: [10,6,10] }, 'cave');
   * Presets: 'cave' | 'hall' | { decay: seconds }.
   */
  zone(box, preset = 'hall') {
    const ctx = this._needCtx();
    if (!ctx) return this;
    let min, max;
    if (box && box.min && box.max) {
      min = toVec3(box.min); max = toVec3(box.max);
    } else if (Array.isArray(box) && box.length === 2) {
      min = toVec3(box[0]); max = toVec3(box[1]);
    } else {
      throw new Error('[VWorld] zone() needs { min, max } or [min, max] — each any toVec3 shape.');
    }
    const decay = typeof preset === 'object' ? toNumber(preset.decay ?? 2.5, 'decay') : { cave: 4.5, hall: 2.2 }[preset] ?? 2.2;
    const len = Math.ceil(ctx.sampleRate * decay);
    const impulse = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = impulse.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2);
    }
    const convolver = ctx.createConvolver();
    convolver.buffer = impulse;
    const wet = ctx.createGain();
    wet.gain.value = 0;
    convolver.connect(wet).connect(this.master);
    this._zones.push({ min, max, wet });
    return this;
  }

  // --- master ------------------------------------------------------------------------
  volume(v) {
    this.o.masterVolume = toNumber(v, 'volume');
    if (this.master && !this.o.muted) this.master.gain.value = this.o.masterVolume;
    return this;
  }

  mute(m = true) {
    this.o.muted = !!m;
    if (this.master) this.master.gain.value = this.o.muted ? 0 : this.o.masterVolume;
    return this;
  }

  get muted() { return this.o.muted; }

  // --- per-frame -----------------------------------------------------------------------
  _update() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const cam = this.app.camera;
    // Listener follows the camera.
    const L = this.ctx.listener;
    if (L.positionX) {
      L.positionX.value = cam.position.x; L.positionY.value = cam.position.y; L.positionZ.value = cam.position.z;
      const dir = cam.getWorldDirection(new THREE.Vector3());
      if (L.forwardX) {
        L.forwardX.value = dir.x; L.forwardY.value = dir.y; L.forwardZ.value = dir.z;
        L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
      }
    } else if (L.setPosition) {
      L.setPosition(cam.position.x, cam.position.y, cam.position.z);
    }
    // Positional sources track their entities.
    for (const t of this._positional) {
      if (t.entity) {
        t.entity.object.getWorldPosition(t.pos);
        this._setPanner(t.panner, t.pos);
      }
    }
    // Reverb zones follow the camera.
    for (const z of this._zones) {
      const p = cam.position;
      const inside = p.x >= z.min.x && p.x <= z.max.x && p.y >= z.min.y && p.y <= z.max.y && p.z >= z.min.z && p.z <= z.max.z;
      const target = inside ? 0.55 : 0;
      z.wet.gain.value += (target - z.wet.gain.value) * 0.1;
    }
  }

  dispose() {
    for (const t of [...this._positional]) {
      try { t.gain.disconnect(); } catch { /* noop */ }
    }
    this._positional.clear();
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null;
  }
}
