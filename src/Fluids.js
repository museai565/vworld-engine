import * as THREE from 'three';
import { toVec3, toNumber, toBox3, withDefaults } from './util/normalize.js';

/**
 * Fluids — game fluids, not Navier-Stokes.
 *
 * An honest note (also in the README): real fluid simulation doesn't run in
 * real time in a browser at world scale. VWorld fluids are *volumes with
 * behavior*: buoyancy (bodies float/sink by density), flow (currents push),
 * viscosity (drag — mud slows you, water doesn't), plus splash/ripple FX
 * hooks and animated surfaces. This is what actual games do.
 *
 *   world.fluidType('lava', { color: 0xff5a1a, density: 2.4, viscosity: 8, damage: 10, glow: true });
 *   const lake = world.fluid({ name: 'lake', type: 'water', box: { center: [55, -5, 55], size: [70, 6, 70] }, flow: [0.4, 0.1] });
 *   lake.on('splash', (body, info) => app.effects.burst('splash', info.point));
 *   lake.on('damage', (body, info) => console.log('burning!', info.amount));
 *   lake.on('cameraUnder', (inside) => { ...tint the screen... });
 *
 * Box shapes: Box3 | [x0,y0,z0,x1,y1,z1] | { min, max } | { center, size }.
 * Flow shapes: [x, z] | [x, y, z] | { x, y, z } | Vector3.
 */

export const BUILTIN_FLUID_TYPES = {
  water: { color: 0x2e7fd9, density: 1.0, viscosity: 1.0, damage: 0, glow: false, opacity: 0.78, waves: 0.6, speed: 1.2 },
  lava:  { color: 0xff5a1a, density: 2.4, viscosity: 8.0, damage: 10, glow: true, opacity: 0.96, waves: 0.25, speed: 0.5 },
  mud:   { color: 0x5a4632, density: 1.6, viscosity: 20.0, damage: 0, glow: false, opacity: 1.0, waves: 0.12, speed: 0.3 },
  oil:   { color: 0x1a1a22, density: 0.9, viscosity: 12.0, damage: 0, glow: false, opacity: 0.92, waves: 0.2, speed: 0.6 },
};

// ---------------------------------------------------------------------------
// Pure math — DOM-free, node-testable.
// ---------------------------------------------------------------------------

function boxVolume(b) {
  return Math.max(0, b.max.x - b.min.x) * Math.max(0, b.max.y - b.min.y) * Math.max(0, b.max.z - b.min.z);
}

/**
 * Fraction (0..1) of `aabb` submerged inside `box`.
 * Boxes as { min: {x,y,z}, max: {x,y,z} } — plain objects are fine.
 */
export function submergedFraction(aabb, box) {
  const ox = Math.max(0, Math.min(aabb.max.x, box.max.x) - Math.max(aabb.min.x, box.min.x));
  const oy = Math.max(0, Math.min(aabb.max.y, box.max.y) - Math.max(aabb.min.y, box.min.y));
  const oz = Math.max(0, Math.min(aabb.max.z, box.max.z) - Math.max(aabb.min.z, box.min.z));
  const v = boxVolume(aabb);
  if (v <= 1e-9) return 0;
  return Math.min(1, (ox * oy * oz) / v);
}

/**
 * Net vertical acceleration from buoyancy at a submersion fraction.
 * Positive = rises, negative = sinks, 0 = neutrally buoyant.
 *   buoyancyNetAccel(fluidDensity, bodyDensity, fraction, g)
 */
export function buoyancyNetAccel(fluidDensity, bodyDensity, fraction, g = 9.81) {
  const rhoB = Math.max(bodyDensity, 1e-6);
  return ((fluidDensity * fraction - rhoB) / rhoB) * g;
}

// ---------------------------------------------------------------------------
// Fluid surface visuals.
// ---------------------------------------------------------------------------

function makeSurfaceMaterial(def) {
  const cA = new THREE.Color(def.color);
  const cB = cA.clone().lerp(new THREE.Color(0xffffff), def.glow ? 0.45 : 0.3);
  const mat = new THREE.ShaderMaterial({
    transparent: def.opacity < 1,
    depthWrite: def.opacity >= 1,
    uniforms: {
      uTime: { value: 0 },
      uColorA: { value: cA },
      uColorB: { value: cB },
      uOpacity: { value: toNumber(def.opacity, 'opacity') },
      uWaves: { value: toNumber(def.waves, 'waves') },
      uSpeed: { value: toNumber(def.speed, 'speed') },
      uGlow: { value: def.glow ? 1 : 0 },
    },
    vertexShader: `
      uniform float uTime;
      uniform float uWaves;
      uniform float uSpeed;
      varying float vWave;
      varying vec2 vP;
      void main() {
        vec3 p = position;
        float w = sin(p.x * 0.35 + uTime * uSpeed * 1.6) * sin(p.y * 0.33 + uTime * uSpeed);
        p.z += w * uWaves;
        vWave = w;
        vP = p.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uColorA;
      uniform vec3 uColorB;
      uniform float uOpacity;
      uniform float uTime;
      uniform float uSpeed;
      uniform float uGlow;
      varying float vWave;
      varying vec2 vP;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        float n = hash(floor(vP * 2.0) + floor(uTime * uSpeed) * 0.13);
        vec3 col = mix(uColorA, uColorB, vWave * 0.5 + 0.5);
        col = mix(col, uColorB, n * 0.25);
        col += uColorA * uGlow * (0.55 + 0.45 * n);
        gl_FragColor = vec4(col, uOpacity);
      }`,
  });
  return mat;
}

// ---------------------------------------------------------------------------
// Fluid + FluidSystem.
// ---------------------------------------------------------------------------

let _fluidUid = 1;
const FLUID_EVENTS = ['splash', 'enter', 'exit', 'damage', 'cameraUnder'];

export class Fluid {
  constructor(system, options = {}) {
    this.system = system;
    this.world = system.world;
    const o = withDefaults(options, { name: null, type: 'water', box: null, flow: [0, 0] });

    const typeName = String(o.type);
    const typeDef = system.types.get(typeName);
    if (!typeDef) {
      throw new Error(`[VWorld] Unknown fluid type "${typeName}". Built-ins: ${[...system.types.keys()].join(', ')} — or register one with world.fluidType().`);
    }
    // Per-fluid overrides: any extra option keys merge over the type def.
    const { name, type, box, flow, ...overrides } = o;
    this.name = String(name ?? `fluid_${_fluidUid++}`);
    this.type = typeName;
    this.def = { ...typeDef, ...overrides };

    if (!box) throw new Error('[VWorld] world.fluid() needs a `box` — Box3, [x0,y0,z0,x1,y1,z1], { min, max }, or { center, size }.');
    this.box = toBox3(box, 'box');

    const f = flow;
    this.flow = Array.isArray(f) && f.length === 2
      ? new THREE.Vector3(toNumber(f[0], 'flow[0]'), 0, toNumber(f[1], 'flow[1]'))
      : toVec3(f);

    this._listeners = new Map();
    this._states = new Map(); // body -> { inFluid }
    this._camInside = false;

    // Animated surface plane at the top of the volume.
    const w = this.box.max.x - this.box.min.x;
    const d = this.box.max.z - this.box.min.z;
    this._surfaceMat = makeSurfaceMaterial(this.def);
    this.surface = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(w, 0.1), Math.max(d, 0.1), 32, 32), this._surfaceMat);
    this.surface.rotation.x = -Math.PI / 2;
    this.surface.position.set((this.box.min.x + this.box.max.x) / 2, this.box.max.y + 0.02, (this.box.min.z + this.box.max.z) / 2);
    this.surface.renderOrder = 3;
    this.world.engine.scene.add(this.surface);
  }

  get topY() {
    return this.box.max.y;
  }

  /**
   * Subscribe: 'splash' | 'enter' | 'exit' | 'damage' | 'cameraUnder'.
   *   lake.on('splash', (body, info) => { ... info.point, info.impactSpeed ... });
   *   lava.on('damage', (body, info) => { ... info.amount (this tick), info.fraction ... });
   *   lake.on('cameraUnder', (inside) => { ... });
   */
  on(event, fn) {
    if (!FLUID_EVENTS.includes(event)) {
      throw new Error(`[VWorld] fluid.on() — unknown event "${event}". Try: ${FLUID_EVENTS.join(', ')}.`);
    }
    if (typeof fn !== 'function') throw new Error('[VWorld] fluid.on(event, fn) — fn must be a function.');
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return this;
  }

  _emit(event, ...args) {
    for (const fn of this._listeners.get(event) ?? []) {
      try { fn(...args); } catch (err) { console.error(`[VWorld] fluid "${event}" handler threw:`, err); }
    }
  }

  /** Remove the fluid volume and its surface. */
  destroy() {
    this.world.engine.scene.remove(this.surface);
    this._surfaceMat.dispose();
    this.surface.geometry.dispose();
    const i = this.system.fluids.indexOf(this);
    if (i >= 0) this.system.fluids.splice(i, 1);
    return this;
  }
}

export class FluidSystem {
  constructor(world) {
    this.world = world;
    this.types = new Map();
    for (const [name, def] of Object.entries(BUILTIN_FLUID_TYPES)) {
      this.types.set(name, { ...def });
    }
    this.fluids = [];
    this._tick = 0;
    // Buoyancy/flow/drag run in the fixed step, before physics integrates.
    world.engine.onFixedUpdate((dt) => this._step(dt));
  }

  /**
   * Register (or override) a fluid type.
   *   world.fluidType('lava', { color: 0xff5a1a, density: 2.4, viscosity: 8, damage: 10, glow: true });
   */
  registerType(name, def = {}) {
    const base = this.types.get(String(name)) ?? { ...BUILTIN_FLUID_TYPES.water };
    this.types.set(String(name), { ...base, ...def });
    return this;
  }

  typeNames() {
    return [...this.types.keys()];
  }

  /**
   * Create a fluid volume. Order-independent: creating a fluid after terrain
   * automatically refreshes `nearFluid` surface rules.
   */
  create(options = {}) {
    const fluid = new Fluid(this, options);
    this.fluids.push(fluid);
    // Scatter's water avoidance keys off the water level.
    if (fluid.type === 'water') {
      this.world._waterLevel = Math.max(this.world._waterLevel, fluid.box.max.y);
    }
    this.world._refreshTerrainSurface();
    return fluid;
  }

  /** Animate surfaces (per frame) and watch the camera. */
  update(dt) {
    for (const f of this.fluids) {
      f._surfaceMat.uniforms.uTime.value += dt;
    }
    const cam = this.world.engine.camera.position;
    for (const f of this.fluids) {
      const inside = f.box.containsPoint(cam);
      if (inside !== f._camInside) {
        f._camInside = inside;
        f._emit('cameraUnder', inside, { fluid: f });
      }
    }
  }

  _step(dt) {
    this._tick++;
    const phys = this.world.engine.physics;
    if (!phys.world) return;
    const g = Math.abs(phys.world.gravity.y) || 9.81;
    const fx = this.world.engine.effects; // optional (EffectsPlugin)

    for (const fluid of this.fluids) {
      const def = fluid.def;
      phys.eachBody((body) => {
        const ent = body._entity;
        if (!ent) return;

        // Cached AABB (refreshed every 10 fixed ticks).
        let cache = body._fluidAabb;
        if (!cache || this._tick - cache.tick > 10) {
          cache = body._fluidAabb = { box: new THREE.Box3().setFromObject(ent.object), tick: this._tick };
        }
        const f = submergedFraction(
          { min: cache.box.min, max: cache.box.max },
          { min: fluid.box.min, max: fluid.box.max }
        );

        let st = fluid._states.get(body);
        if (!st) { st = { inFluid: false }; fluid._states.set(body, st); }

        const pos = ent.object.position;
        if (f > 0 && !st.inFluid) {
          st.inFluid = true;
          const lv = body.linvel ? body.linvel() : { x: 0, y: 0, z: 0 };
          const info = {
            fluid, body, entity: ent,
            point: new THREE.Vector3(pos.x, fluid.topY, pos.z),
            impactSpeed: Math.max(0, -lv.y),
            fraction: f,
          };
          fluid._emit('enter', body, info);
          fluid._emit('splash', body, info);
          if (fx && info.impactSpeed > 1.5) {
            fx.burst({
              type: 'splash', at: info.point,
              count: Math.min(70, Math.round(14 + info.impactSpeed * 5)),
              color: [0xbfe3ff, 0xffffff], size: 0.45, lifetime: 0.8,
              spread: 1.6, rise: 2.6, gravity: 7,
            });
          }
        } else if (f === 0 && st.inFluid) {
          st.inFluid = false;
          fluid._emit('exit', body, { fluid, body, entity: ent, fraction: 0 });
        }

        if (f > 0 && body.isDynamic) {
          const vol = boxVolume({ min: cache.box.min, max: cache.box.max });
          if (vol > 1e-6) {
            const m = body.raw.mass();
            // Buoyancy: upward force = fluidDensity * displacedVolume * g.
            const Fb = def.density * vol * g * f;
            body.raw.applyImpulse({ x: 0, y: Fb * dt, z: 0 }, true);
            // Flow current.
            if (fluid.flow.lengthSq() > 1e-8) {
              const a = 3.0 * f;
              body.raw.applyImpulse(
                { x: fluid.flow.x * m * a * dt, y: 0, z: fluid.flow.z * m * a * dt }, true
              );
            }
            // Viscous drag (exponential, stable): v *= e^(-c·dt).
            const c = def.viscosity * f * 1.4;
            const k = Math.exp(-c * dt) - 1; // negative
            const v = body.raw.linvel();
            body.raw.applyImpulse({ x: v.x * m * k, y: v.y * m * k * 0.35, z: v.z * m * k }, true);
            const av = body.raw.angvel();
            const kd = Math.exp(-c * dt * 0.9);
            body.raw.setAngvel({ x: av.x * kd, y: av.y * kd, z: av.z * kd }, false);
          }
          // Damage (lava etc.).
          if (def.damage > 0 && f > 0.25) {
            fluid._emit('damage', body, { fluid, body, entity: ent, amount: def.damage * f * dt, fraction: f });
          }
        }
      });
    }
  }
}
