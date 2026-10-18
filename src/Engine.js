import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { World } from './World.js';
import { Physics } from './Physics.js';
import { Input } from './Input.js';
import { Assets } from './Assets.js';
import { Net } from './Net.js';
import { Build } from './Build.js';
import { Entity } from './Entity.js';

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
      ...options,
    };
    if (!o.canvas) {
      throw new Error('[VWorld] Engine.create({ canvas }) — a <canvas> element is required.');
    }
    this.options = o;

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

    // --- subsystems (sync shells; physics finishes async) ----------------
    this.world = new World(this);
    this.physics = new Physics(this); // RAPIER injected on ready
    this.input = new Input(this);
    this.assets = new Assets(this);
    this.net = new Net(this);
    this.build = new Build(this);

    this.ready = this._boot();
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
    const dt = Math.min((now - this._last) / 1000, this.options.maxFrameDt);
    this._last = now;

    // Fixed-timestep accumulator: physics always steps at a stable rate.
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

    this.input.update(dt);
    for (const fn of this._frameUpdaters) fn(dt);
    this.world.update(dt);
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame((t) => this._loop(t));
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
  /** Create an Entity already added to the scene. Chain transforms on it. */
  entity() {
    const e = new Entity(this);
    this.scene.add(e.object);
    return e;
  }

  /** Add an Entity (or raw Object3D) to the scene. */
  add(thing) {
    this.scene.add(thing.object ?? thing);
    return this;
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
