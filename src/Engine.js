import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { World } from './World.js';
import { Physics } from './Physics.js';
import { Input } from './Input.js';
import { Assets } from './Assets.js';
import { Net } from './Net.js';
import { Build } from './Build.js';
import { Entity } from './Entity.js';
import { AI } from './AI.js';
import { Time } from './Time.js';
import { VWorldError, vError, createErrorBus } from './util/errors.js';
import { Profiler } from './Profiler.js';
import { resolveQuality, normalizeQuality, autoStep } from './util/quality.js';
import {
  InstancedSet, Decal, CloudLayer, LightShaft,
  makeMaterial, resolveShadowConfig,
} from './Rendering.js';

/**
 * VWorld Engine — core application object.
 *
 * DX goal: one line gets a running scene.
 *
 *   const app = Engine.create({ canvas }).start();
 *
 * Subsystems (world, physics, input, assets, net, build) are created
 * synchronously, but Rapier's WASM needs one async init. `app.ready`
 * resolves when everything is usable — `start()` waits for it internally,
 * so you never *have* to await anything yourself. If you touch physics
 * before init finishes you get a clear error telling you to `await app.ready`.
 *
 * v0.4.0 (production hardening):
 * - `app.onError(fn)` / `app.offError(fn)` — central error bus; internal
 *   catch sites report here, falling back to console.error with no handlers.
 * - `app.dispose()` — full teardown (loop, listeners, entities, renderer).
 * - `Engine.create({ debug: true })` — leak detection on dispose.
 * - `app.quality('high' | 'medium' | 'low' | 'auto')` — adaptive quality.
 * - `app.profiler()` — frame-time sections ('fixed', 'frame', 'render').
 * - WebGL context-loss recovery with 'contextlost' / 'contextrestored' events.
 */
export class Engine {
  static create(options = {}) {
    return new Engine(options);
  }

  constructor(options = {}) {
    const o = {
      canvas: null,
      antialias: true,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      fixedDt: 1 / 60,
      maxFrameDt: 0.1,
      fov: 60,
      near: 0.1,
      far: 3000,
      shadows: true,
      debug: false,
      ...options,
    };
    if (!o.canvas) {
      throw vError('VWORLD/MISSING_CANVAS', '[VWorld] Engine.create({ canvas }) — a <canvas> element is required.');
    }
    this.options = o;

    // --- error bus + profiler (before everything, so subsystems can use them)
    this._errorBus = createErrorBus();
    this._profiler = new Profiler();

    // --- renderer / scene / camera -------------------------------------
    this.renderer = new THREE.WebGLRenderer({ canvas: o.canvas, antialias: o.antialias });
    this.renderer.setPixelRatio(o.pixelRatio);
    this.renderer.shadowMap.enabled = o.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(o.fov, 1, o.near, o.far);
    this.camera.position.set(0, 6, 12);

    // --- loop state ------------------------------------------------------
    this._acc = 0;
    this._last = 0;
    this._running = false;
    this._fixedUpdaters = [];
    this._frameUpdaters = [];

    // --- plugin + event plumbing (must exist before subsystems) ------------
    this._plugins = new Map();
    this._events = new Map();

    // --- v0.5.0: rendering handles (instanced sets, decals, clouds, shafts)
    this._renderHandles = new Set();

    // --- v0.4.0: disposal / debug / quality ----------------------------------
    this._disposed = false;
    this._debug = !!o.debug;
    this._liveEntities = new Set(); // app.entity() creations, removed on dispose
    this._qualityMode = 'high';     // requested: 'high'|'medium'|'low'|'auto'
    this._qualityLevel = 'high';    // effective: 'high'|'medium'|'low'
    this._qualityFrames = 0;        // FPS sampling state for 'auto'
    this._qualityWindowStart = 0;
    this._qualityHighStreak = 0;

    // --- subsystems (sync shells; physics finishes async) ----------------
    this.world = new World(this);
    this.physics = new Physics(this); // RAPIER injected on ready
    this.input = new Input(this);
    this.assets = new Assets(this);
    this.net = new Net(this);
    this.build = new Build(this);
    this.ai = new AI(this);
    this.time = new Time(this);

    this.ready = this._boot();

    // --- WebGL context-loss recovery ---------------------------------------
    this._contextLostWasRunning = false;
    this._onContextLost = (e) => {
      e.preventDefault(); // lets the browser restore the context later
      this._contextLostWasRunning = this._running;
      this._running = false;
      this._emit('contextlost');
    };
    this._onContextRestored = () => {
      this.resize(); // re-sync renderer size after the context comes back
      this._emit('contextrestored');
      if (this._contextLostWasRunning && !this._disposed) {
        this._contextLostWasRunning = false;
        this.start();
      }
    };
    o.canvas.addEventListener('webglcontextlost', this._onContextLost);
    o.canvas.addEventListener('webglcontextrestored', this._onContextRestored);

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  async _boot() {
    await RAPIER.init();
    this.physics._init(RAPIER);
    return this;
  }

  // --- main loop ----------------------------------------------------------
  start() {
    if (this._disposed) {
      throw vError('VWORLD/APP_DISPOSED', '[VWorld] app.start() called after app.dispose() — create a new Engine instead.');
    }
    if (this._running) return this;
    this._running = true;
    // The loop only begins once WASM physics is ready — users never await.
    this.ready.then(() => {
      this._last = performance.now();
      requestAnimationFrame((t) => this._loop(t));
    });
    return this;
  }

  stop() {
    this._running = false;
    window.removeEventListener('resize', this._onResize);
    return this;
  }

  _loop(now) {
    if (!this._running) return;
    const prof = this._profiler;
    const dt = Math.min((now - this._last) / 1000, this.options.maxFrameDt);
    this._last = now;

    // Fixed-timestep accumulator: physics always steps at a stable rate.
    prof.begin('fixed');
    this._acc += dt;
    const fixed = this.options.fixedDt;
    let iterations = 0;
    while (this._acc >= fixed && iterations < 5) {
      for (const fn of this._fixedUpdaters) fn(fixed);
      this.physics.step(fixed);
      this._acc -= fixed;
      iterations++;
    }
    if (iterations === 5) this._acc = 0; // avoid spiral of death
    prof.end('fixed');

    prof.begin('frame');
    this.input.update(dt);
    for (const fn of this._frameUpdaters) fn(dt);
    this.world.update(dt);
    prof.end('frame');
    this._emit('tick', dt);

    prof.begin('render');
    // Post-processing plugin (if installed & enabled) takes over rendering.
    const post = this.world._postChain;
    if (post && post.enabled) post.render();
    else this.renderer.render(this.scene, this.camera);
    prof.end('render');
    this._emit('render', dt);

    this._sampleQuality(now);
    requestAnimationFrame((t) => this._loop(t));
  }

  // --- plugin system ----------------------------------------------------------
  /**
   * Install a plugin: `app.use(AudioPlugin)` or `app.use(AudioPlugin, { ... })`.
   * A plugin is `{ name: 'audio', install(app, options) }`. Core never imports
   * plugins — plugins attach themselves here. Installing the same name twice
   * warns and skips (no double wiring). A throwing install() is reported to
   * the error bus (VWORLD/PLUGIN_INSTALL_FAILED) and re-thrown.
   */
  use(plugin, options) {
    if (!plugin || typeof plugin.name !== 'string' || typeof plugin.install !== 'function') {
      throw vError('VWORLD/BAD_PLUGIN', '[VWorld] app.use() needs a plugin shaped like { name: "audio", install(app, options) }.');
    }
    if (this._plugins.has(plugin.name)) {
      console.warn(`[VWorld] Plugin "${plugin.name}" is already installed — skipping second install.`);
      return this;
    }
    this._plugins.set(plugin.name, plugin);
    try {
      plugin.install(this, options ?? {});
    } catch (err) {
      this._plugins.delete(plugin.name);
      const wrapped = vError(
        'VWORLD/PLUGIN_INSTALL_FAILED',
        `[VWorld] Plugin "${plugin.name}" install() threw: ${err && err.message ? err.message : String(err)}`,
        { cause: err }
      );
      this._errorBus.report(wrapped);
      throw wrapped;
    }
    return this;
  }

  /** Is a plugin installed? `app.using('audio')`. */
  using(name) {
    return this._plugins.has(name);
  }

  // --- error handling (v0.4.0) ----------------------------------------------------
  /**
   * Subscribe to engine errors — every internal catch site reports here:
   * event handlers, plugin installs, moveTo arrivals, entity listeners.
   * With no handlers registered, errors fall back to `console.error`.
   * Chainable.
   *
   *   app.onError((err) => console.log(err.code, err.message));
   */
  onError(fn) {
    this._errorBus.onError(fn);
    return this;
  }

  /** Remove a previously registered error handler. Chainable. */
  offError(fn) {
    this._errorBus.offError(fn);
    return this;
  }

  // --- debug mode (v0.4.0) ----------------------------------------------------------
  /**
   * Toggle debug mode. In debug mode the engine tracks live entities and,
   * on `app.dispose()`, warns once listing any that were never disposed
   * (up to 10 ids plus the count). Chainable.
   *
   *   app.debug(true);  // or Engine.create({ canvas, debug: true })
   */
  debug(flag = true) {
    this._debug = flag !== false && flag !== 0 && flag !== null;
    return this;
  }

  /** Untrack an entity (called by Entity.dispose). Internal. */
  _untrackEntity(entity) {
    this._liveEntities.delete(entity);
  }

  // --- adaptive quality (v0.4.0) ----------------------------------------------------
  /**
   * Set the render quality — 'high' | 'medium' | 'low' | 'auto' (or the
   * object form `{ level: 'auto' }` per the normalize law). Chainable.
   * With no arguments, returns the current *effective* level string
   * ('high' | 'medium' | 'low').
   *
   *   app.quality('low');   // pixelRatio 1, shadows off
   *   app.quality({ level: 'auto' }); // starts high, steps down under 45 FPS
   *   app.quality();        // => 'high'
   *
   * high: pixelRatio = min(dpr, 2), shadows on.
   * medium: pixelRatio = min(dpr, 1.5), shadows on.
   * low: pixelRatio = 1, shadows off.
   * auto: starts at high; rolling 2s FPS windows step down a level when the
   *   average drops under 45, and step back up after 3 consecutive windows
   *   above 57.
   */
  quality(level) {
    if (level === undefined) return this._qualityLevel;
    const name = normalizeQuality(level);
    if (!['high', 'medium', 'low', 'auto'].includes(name)) {
      throw vError('VWORLD/UNKNOWN_QUALITY', `[VWorld] Unknown quality level "${name}" — try: high, medium, low, auto.`);
    }
    this._qualityMode = name;
    if (name === 'auto') {
      this._qualityFrames = 0;
      this._qualityWindowStart = 0;
      this._qualityHighStreak = 0;
      this._applyQualityLevel('high');
    } else {
      this._applyQualityLevel(name);
    }
    return this;
  }

  /** Resolve + apply a concrete quality level immediately. Internal. */
  _applyQualityLevel(level) {
    const { pixelRatio, shadows } = resolveQuality(level, window.devicePixelRatio || 1);
    this._applyQualitySettings(pixelRatio, shadows);
    this._qualityLevel = level;
  }

  /** Push pixel ratio / shadow settings into the renderer. Internal. */
  _applyQualitySettings(pixelRatio, shadows) {
    this.renderer.setPixelRatio(pixelRatio);
    if (this.renderer.shadowMap.enabled !== shadows) {
      this.renderer.shadowMap.enabled = shadows;
      // three.js bakes shadow support into each material's program — force recompile.
      this.scene.traverse((o) => {
        if (o.isMesh) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) if (m) m.needsUpdate = true;
        }
      });
    }
  }

  /** FPS sampling for quality('auto') — called at the end of every frame. */
  _sampleQuality(now) {
    if (this._qualityMode !== 'auto') return;
    if (!this._qualityWindowStart) this._qualityWindowStart = now;
    this._qualityFrames += 1;
    const elapsed = (now - this._qualityWindowStart) / 1000;
    if (elapsed >= 2) {
      const fps = this._qualityFrames / elapsed;
      const { level, highStreak } = autoStep(this._qualityLevel, fps, this._qualityHighStreak);
      this._qualityHighStreak = highStreak;
      if (level !== this._qualityLevel) this._applyQualityLevel(level);
      this._qualityFrames = 0;
      this._qualityWindowStart = now;
    }
  }

  // --- profiler (v0.4.0) ---------------------------------------------------------------
  /**
   * The engine profiler — sections 'fixed', 'frame', 'render' are measured
   * in the frame loop; add your own with `begin(name)` / `end(name)`.
   *
   *   console.log(app.profiler().summary());
   */
  profiler() {
    return this._profiler;
  }

  // --- lifecycle events ---------------------------------------------------------
  static EVENTS = ['tick', 'render', 'dispose', 'contextlost', 'contextrestored'];

  /**
   * Subscribe to engine lifecycle: 'tick' (every frame, before render),
   * 'render' (every frame, after render), 'dispose' (on app.dispose()),
   * 'contextlost' / 'contextrestored' (WebGL context loss recovery).
   */
  on(event, fn) {
    if (!Engine.EVENTS.includes(event)) {
      throw vError('VWORLD/UNKNOWN_EVENT', `[VWorld] app.on() — unknown event "${event}". Try: ${Engine.EVENTS.join(', ')}.`);
    }
    if (typeof fn !== 'function') {
      throw vError('VWORLD/BAD_HANDLER', '[VWorld] app.on(event, fn) — fn must be a function.');
    }
    if (!this._events.has(event)) this._events.set(event, new Set());
    this._events.get(event).add(fn);
    return this;
  }

  off(event, fn) {
    this._events.get(event)?.delete(fn);
    return this;
  }

  _emit(event, ...args) {
    for (const fn of this._events.get(event) ?? []) {
      try {
        fn(...args);
      } catch (err) {
        this._errorBus.report(vError(
          'VWORLD/EVENT_HANDLER_THREW',
          `[VWorld] "${event}" handler threw: ${err && err.message ? err.message : String(err)}`,
          { cause: err }
        ));
      }
    }
  }

  /**
   * Full teardown: fires 'dispose' (so plugins clean up), warns about leaked
   * entities in debug mode, disposes every remaining entity, stops the loop,
   * removes the resize + WebGL-context listeners, disposes the renderer, and
   * clears plugin/event/updater maps. Idempotent — a second call is a no-op
   * returning `this`. After dispose, `start()` throws VWORLD/APP_DISPOSED.
   */
  dispose() {
    if (this._disposed) return this;
    this._disposed = true;

    this._emit('dispose');

    // Debug leak detection — before teardown so the report names survivors.
    if (this._debug) {
      const leaked = [...this._liveEntities].filter((e) => !e._disposed);
      if (leaked.length > 0) {
        const ids = leaked.slice(0, 10).map((e) => e.id).join(', ');
        const more = leaked.length > 10 ? ` (+${leaked.length - 10} more)` : '';
        console.warn(
          `[VWorld] debug: ${leaked.length} ${leaked.length === 1 ? 'entity was' : 'entities were'} not disposed before app.dispose(): ${ids}${more}`
        );
      }
    }

    // Dispose every entity still alive (each one untracks itself).
    for (const e of [...this._liveEntities]) {
      try { e.dispose(); } catch (err) { this._errorBus.report(err); }
    }
    this._liveEntities.clear();

    // v0.5.0: dispose rendering handles (instanced sets, decals, clouds, shafts).
    for (const h of [...this._renderHandles]) {
      try { h.dispose(); } catch (err) { this._errorBus.report(err); }
    }
    this._renderHandles.clear();

    this.stop();
    const canvas = this.options.canvas;
    if (canvas) {
      canvas.removeEventListener('webglcontextlost', this._onContextLost);
      canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
    }

    if (this.renderer && typeof this.renderer.dispose === 'function') {
      try { this.renderer.dispose(); } catch (err) { this._errorBus.report(err); }
    }

    this._plugins.clear();
    this._events.clear();
    this._fixedUpdaters.length = 0;
    this._frameUpdaters.length = 0;
    return this;
  }

  // --- hooks ---------------------------------------------------------------
  /** Called every fixed physics tick (dt = 1/60 by default). */
  onFixedUpdate(fn) {
    this._fixedUpdaters.push(fn);
    return this;
  }

  /** Called every rendered frame. */
  onUpdate(fn) {
    this._frameUpdaters.push(fn);
    return this;
  }

  offUpdate(fn) {
    this._fixedUpdaters = this._fixedUpdaters.filter((f) => f !== fn);
    this._frameUpdaters = this._frameUpdaters.filter((f) => f !== fn);
    return this;
  }

  // --- scene helpers ---------------------------------------------------------
  /**
   * Create an Entity already added to the scene. Chain transforms on it.
   * Tracked for debug leak detection and disposed with the app.
   */
  entity() {
    if (this._disposed) {
      throw vError('VWORLD/APP_DISPOSED', '[VWorld] app.entity() called after app.dispose() — create a new Engine instead.');
    }
    const e = new Entity(this);
    this._liveEntities.add(e);
    this.scene.add(e.object);
    return e;
  }

  /** Add an Entity (or raw Object3D) to the scene. */
  add(thing) {
    this.scene.add(thing.object ?? thing);
    return this;
  }

  // --- rendering richness (v0.5.0) ----------------------------------------------

  /**
   * One draw call for many copies: crowds, forests, grass tufts, debris.
   * Accepts positional args or a single options object (normalize law).
   * The set is tracked and disposed with the app.
   *
   *   app.instanced(geo, mat, 500)
   *     .scatter({ box: [-60, 60], y: 0, scale: [0.7, 1.4] })
   *     .addTo(app);
   *   app.instanced({ geometry: geo, material: mat, count: 200 });
   */
  instanced(geometry, material, count = 100) {
    if (this._disposed) {
      throw vError('VWORLD/APP_DISPOSED', '[VWorld] app.instanced() called after app.dispose() — create a new Engine instead.');
    }
    if (geometry && typeof geometry === 'object' && !geometry.isBufferGeometry) {
      // Object form: app.instanced({ geometry, material, count })
      ({ geometry, material, count = 100 } = geometry);
    }
    const set = new InstancedSet(this, geometry, material, count);
    this._renderHandles.add(set);
    return set;
  }

  /**
   * A tuned MeshStandardMaterial from the preset library, with optional
   * overrides. `color` accepts any toColor shape.
   *
   *   app.material('brass');                       // preset as-is
   *   app.material('glass', { opacity: 0.5 });     // tweaked
   *   app.material({ preset: 'wood', color: 'red' });
   *
   * Presets: metal, chrome, gold, brass, copper, glass, water, plastic,
   * rubber, wood, stone, grass, paper, emissive.
   */
  material(name, overrides = {}) {
    if (name && typeof name === 'object') {
      const { preset, ...rest } = name;
      if (preset === undefined) {
        throw vError('VWORLD/UNKNOWN_MATERIAL', '[VWorld] app.material({ preset }) — the preset name is required.');
      }
      return makeMaterial(preset, rest);
    }
    return makeMaterial(name, overrides);
  }

  /**
   * Tune the sun's shadow map. With no arguments, returns the current
   * settings as a plain object. Chainable when applying.
   *
   *   app.shadows({ mapSize: 4096, bias: -0.0002, bounds: 90 });
   *   app.shadows({ mapSize: [2048, 2048], bounds: { left: -40, right: 40, top: 60, bottom: -60 } });
   */
  shadows(options) {
    if (options === undefined) {
      const s = this.world.sun.shadow;
      return {
        mapSize: [s.mapSize.x, s.mapSize.y],
        bias: s.bias, normalBias: s.normalBias, radius: s.radius,
        left: s.camera.left, right: s.camera.right,
        top: s.camera.top, bottom: s.camera.bottom,
        near: s.camera.near, far: s.camera.far,
      };
    }
    const cfg = resolveShadowConfig(options);
    const sh = this.world.sun.shadow;
    sh.mapSize.set(cfg.mapSize[0], cfg.mapSize[1]);
    sh.bias = cfg.bias;
    sh.normalBias = cfg.normalBias;
    sh.radius = cfg.radius;
    sh.camera.left = cfg.left;
    sh.camera.right = cfg.right;
    sh.camera.top = cfg.top;
    sh.camera.bottom = cfg.bottom;
    sh.camera.near = cfg.near;
    sh.camera.far = cfg.far;
    sh.camera.updateProjectionMatrix();
    if (sh.map) { sh.map.dispose(); sh.map = null; } // force realloc at new size
    return this;
  }

  /**
   * Stick a decal to a surface: bullet holes, scorch marks, paint splats.
   * Added to the scene automatically; tracked and disposed with the app.
   *
   *   app.decal({ preset: 'scorch', position: hitPoint, normal: hitNormal,
   *               size: 2.5, lifetime: 45, fade: 5 });
   */
  decal(options = {}) {
    if (this._disposed) {
      throw vError('VWORLD/APP_DISPOSED', '[VWorld] app.decal() called after app.dispose() — create a new Engine instead.');
    }
    const d = new Decal(this, options).addTo(this);
    this._renderHandles.add(d);
    return d;
  }

  /**
   * Procedural drifting clouds. Added to the scene automatically; tracked
   * and disposed with the app.
   *
   *   app.clouds({ count: 60, area: 500, height: [100, 160], speed: 3 });
   */
  clouds(options = {}) {
    if (this._disposed) {
      throw vError('VWORLD/APP_DISPOSED', '[VWorld] app.clouds() called after app.dispose() — create a new Engine instead.');
    }
    const c = new CloudLayer(this, options).addTo(this);
    this._renderHandles.add(c);
    return c;
  }

  /**
   * Fake volumetric light shaft: an additive cone, narrow at `from`,
   * wide at `to`. Added to the scene automatically; tracked and disposed
   * with the app.
   *
   *   app.lightShaft({ from: [0, 30, 0], to: [0, 0, 0], radius: 6 });
   */
  lightShaft(options = {}) {
    if (this._disposed) {
      throw vError('VWORLD/APP_DISPOSED', '[VWorld] app.lightShaft() called after app.dispose() — create a new Engine instead.');
    }
    const s = new LightShaft(this, options).addTo(this);
    this._renderHandles.add(s);
    return s;
  }

  resize() {
    const c = this.options.canvas;
    const w = c.clientWidth || window.innerWidth;
    const h = c.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    return this;
  }
}

// Re-export the VWorldError class for `err instanceof VWorldError` checks
// without importing the util module directly.
export { VWorldError };
