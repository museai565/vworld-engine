import * as THREE from 'three';
import { toVec3, toNumber, toColor, withDefaults } from './util/normalize.js';
import { vError } from './util/errors.js';

/**
 * Rendering richness (v0.5.0) — instancing, LOD, decals, clouds, light
 * shafts, material presets, shadow tuning.
 *
 * Pure, node-testable helpers live next to the classes that use them:
 * selectLod / normalizeLodLevels, MATERIAL_PRESETS / resolveMaterialPreset,
 * resolveShadowConfig, decalFrame / decalOpacity, shaftFrame, cloudLayout.
 *
 *   app.instanced(geo, mat, 500).scatter({ box: [-50, 50], y: 0 }).addTo(app);
 *   entity.lod([{ distance: 0, mesh: hi }, { distance: 60, mesh: lo }]);
 *   app.decal({ preset: 'scorch', position: hit, normal: n, size: 2, lifetime: 30 });
 *   app.material('brass', { roughness: 0.2 });
 *   app.shadows({ mapSize: 4096, bounds: 90 });
 */

// ---------------------------------------------------------------------------
// LOD — pure helpers
// ---------------------------------------------------------------------------

/**
 * Normalize LOD levels into a sorted [{ distance, mesh }] array.
 * Accepts: [{ distance, mesh }] | [[distance, mesh], ...].
 * mesh: THREE.Object3D | Entity | null (null = hidden beyond this distance).
 * Distances are sorted ascending; the first level should be distance 0.
 */
export function normalizeLodLevels(levels, name = 'levels') {
  if (!Array.isArray(levels) || levels.length === 0) {
    throw vError(
      'VWORLD/BAD_LOD',
      `[VWorld] entity.lod() needs a non-empty array — try [{ distance: 0, mesh: hi }, { distance: 60, mesh: lo }].`
    );
  }
  const out = levels.map((lv, i) => {
    let distance, mesh;
    if (Array.isArray(lv)) {
      [distance, mesh] = lv;
    } else if (lv && typeof lv === 'object') {
      ({ distance, mesh } = lv);
    } else {
      throw vError(
        'VWORLD/BAD_LOD',
        `[VWorld] entity.lod() — level ${i} must be { distance, mesh } or [distance, mesh], got ${typeof lv}.`
      );
    }
    distance = toNumber(distance, `levels[${i}].distance`);
    if (distance < 0) {
      throw vError('VWORLD/BAD_LOD', `[VWorld] entity.lod() — level ${i} distance can't be negative.`);
    }
    if (mesh !== null && mesh !== undefined) {
      const obj = mesh.object ?? mesh; // Entity unwraps to its Object3D
      if (!obj || !obj.isObject3D) {
        throw vError(
          'VWORLD/BAD_LOD',
          `[VWorld] entity.lod() — level ${i} mesh must be a THREE.Object3D, an Entity, or null (hidden).`
        );
      }
      mesh = obj;
    } else {
      mesh = null;
    }
    return { distance, mesh };
  });
  out.sort((a, b) => a.distance - b.distance); // stable in modern JS
  return out;
}

/**
 * Pick the active LOD level index for a camera distance.
 * Levels must be normalized (ascending). Returns the last level whose
 * distance <= the given distance — i.e. index 0 covers [0, d1).
 */
export function selectLod(distance, levels) {
  const d = toNumber(distance, 'distance');
  let idx = 0;
  for (let i = 0; i < levels.length; i++) {
    if (levels[i].distance <= d) idx = i;
    else break;
  }
  return idx;
}

// ---------------------------------------------------------------------------
// Material presets — pure helpers
// ---------------------------------------------------------------------------

/** Tuned MeshStandardMaterial parameter sets, keyed by preset name. */
export const MATERIAL_PRESETS = {
  metal:    { color: 0x9aa3ad, metalness: 0.9,  roughness: 0.35 },
  chrome:   { color: 0xffffff, metalness: 1.0,  roughness: 0.08 },
  gold:     { color: 0xd4af37, metalness: 1.0,  roughness: 0.28 },
  brass:    { color: 0xb5a642, metalness: 1.0,  roughness: 0.32 },
  copper:   { color: 0xb87333, metalness: 1.0,  roughness: 0.3  },
  glass:    { color: 0xd6ecff, metalness: 0.0,  roughness: 0.06, transparent: true, opacity: 0.32 },
  water:    { color: 0x2e86c1, metalness: 0.1,  roughness: 0.15, transparent: true, opacity: 0.75 },
  plastic:  { color: 0xf2f2f2, metalness: 0.0,  roughness: 0.42 },
  rubber:   { color: 0x1d1d1f, metalness: 0.0,  roughness: 0.95 },
  wood:     { color: 0x8b5a2b, metalness: 0.0,  roughness: 0.8  },
  stone:    { color: 0x8d8d8d, metalness: 0.0,  roughness: 0.93 },
  grass:    { color: 0x4d7c43, metalness: 0.0,  roughness: 1.0  },
  paper:    { color: 0xf5f1e8, metalness: 0.0,  roughness: 0.9  },
  emissive: { color: 0x1a1a1a, emissive: 0xffaa33, emissiveIntensity: 1.6, metalness: 0.0, roughness: 0.5 },
};

/** All material preset names. */
export function materialPresetNames() {
  return Object.keys(MATERIAL_PRESETS);
}

/**
 * Resolve a preset name (case-insensitive) + overrides into plain material
 * params. `color`/`emissive` accept any toColor shape and come back as hex
 * numbers. Unknown names throw listing every valid name.
 */
export function resolveMaterialPreset(name, overrides = {}) {
  if (typeof name !== 'string') {
    throw vError(
      'VWORLD/UNKNOWN_MATERIAL',
      `[VWorld] app.material() needs a preset name — try: ${materialPresetNames().join(', ')}.`
    );
  }
  const key = name.trim().toLowerCase();
  const base = MATERIAL_PRESETS[key];
  if (!base) {
    throw vError(
      'VWORLD/UNKNOWN_MATERIAL',
      `[VWorld] Unknown material preset "${name}" — try: ${materialPresetNames().join(', ')}.`
    );
  }
  const params = withDefaults(overrides, base);
  if (params.color !== undefined) params.color = toColor(params.color, 'color').getHex();
  if (params.emissive !== undefined && typeof params.emissive !== 'number') {
    params.emissive = toColor(params.emissive, 'emissive').getHex();
  }
  return params;
}

/** Build a THREE.MeshStandardMaterial from a preset name + overrides. */
export function makeMaterial(name, overrides = {}) {
  return new THREE.MeshStandardMaterial(resolveMaterialPreset(name, overrides));
}

// ---------------------------------------------------------------------------
// Shadow tuning — pure helper
// ---------------------------------------------------------------------------

/**
 * Normalize shadow settings into a plain config object.
 * Accepts: { mapSize: 2048 | [w, h], bias, normalBias, radius,
 *            bounds: 70 | { left, right, top, bottom }, near, far }.
 */
export function resolveShadowConfig(options = {}) {
  const o = withDefaults(options, {
    mapSize: 2048, bias: -0.0004, normalBias: 0.02, radius: 4,
    bounds: 70, near: 1, far: 1200,
  });
  let w, h;
  if (Array.isArray(o.mapSize)) {
    if (o.mapSize.length !== 2) {
      throw vError('VWORLD/BAD_SHADOWS', '[VWorld] app.shadows() — mapSize as array must be [width, height].');
    }
    [w, h] = o.mapSize;
  } else {
    w = h = o.mapSize;
  }
  w = Math.max(64, Math.round(toNumber(w, 'mapSize')));
  h = Math.max(64, Math.round(toNumber(h, 'mapSize')));
  let left, right, top, bottom;
  if (o.bounds !== null && typeof o.bounds === 'object' && !Array.isArray(o.bounds)) {
    const b = withDefaults(o.bounds, { left: -70, right: 70, top: 70, bottom: -70 });
    left = toNumber(b.left, 'bounds.left');
    right = toNumber(b.right, 'bounds.right');
    top = toNumber(b.top, 'bounds.top');
    bottom = toNumber(b.bottom, 'bounds.bottom');
  } else {
    const s = toNumber(o.bounds, 'bounds');
    left = -s; right = s; top = s; bottom = -s;
  }
  return {
    mapSize: [w, h],
    bias: toNumber(o.bias, 'bias'),
    normalBias: toNumber(o.normalBias, 'normalBias'),
    radius: toNumber(o.radius, 'radius'),
    left, right, top, bottom,
    near: toNumber(o.near, 'near'),
    far: toNumber(o.far, 'far'),
  };
}

// ---------------------------------------------------------------------------
// Decals — pure helpers
// ---------------------------------------------------------------------------

/**
 * Compute the placement frame for a decal quad: position nudged along the
 * normal (kills z-fighting) + quaternion rotating +Z onto the normal.
 * size: number (square) | [w, h] | { w, h }.
 * Returns { position: Vector3, quaternion: Quaternion, width, height }.
 */
export function decalFrame(position, normal, size = 1) {
  const p = toVec3(position);
  const n = toVec3(normal);
  if (n.lengthSq() < 1e-12) {
    throw vError('VWORLD/BAD_DECAL', '[VWorld] app.decal() — normal must be a non-zero vector.');
  }
  n.normalize();
  let width, height;
  if (typeof size === 'number') {
    width = height = toNumber(size, 'size');
  } else if (Array.isArray(size)) {
    if (size.length !== 2) throw vError('VWORLD/BAD_DECAL', '[VWorld] app.decal() — size as array must be [width, height].');
    [width, height] = size.map((s) => toNumber(s, 'size'));
  } else if (size && typeof size === 'object') {
    width = toNumber(size.w ?? size.width ?? 1, 'size.w');
    height = toNumber(size.h ?? size.height ?? 1, 'size.h');
  } else {
    throw vError('VWORLD/BAD_DECAL', '[VWorld] app.decal() — size must be a number, [w, h], or { w, h }.');
  }
  if (width <= 0 || height <= 0) {
    throw vError('VWORLD/BAD_DECAL', '[VWorld] app.decal() — size must be positive.');
  }
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  // Nudge off the surface along the normal: 2% of the decal's smallest side.
  const position2 = p.clone().addScaledVector(n, Math.min(width, height) * 0.02);
  return { position: position2, quaternion, width, height };
}

/**
 * Opacity multiplier for a decal's age: 1 while alive, linear fade over the
 * last `fade` seconds, 0 after `lifetime`. lifetime <= 0 = permanent (1).
 */
export function decalOpacity(age, lifetime, fade = 1) {
  if (lifetime <= 0) return 1;
  if (age < 0) return 1;
  if (age >= lifetime) return 0;
  const f = Math.max(0, toNumber(fade, 'fade'));
  if (f <= 0) return 1;
  const remaining = lifetime - age;
  return Math.min(1, remaining / f);
}

/** Procedural canvas textures for decals. Needs DOM — throws a clear error in node. */
function canvasTexture(size, draw) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    throw vError(
      'VWORLD/NO_DOM',
      '[VWorld] Procedural decal textures need a DOM canvas — pass a THREE.Texture instead, or run in a browser.'
    );
  }
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Soft irregular scorch mark: dark center fading to transparent. */
export function scorchTexture(size = 128) {
  return canvasTexture(size, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, s * 0.05, s / 2, s / 2, s * 0.5);
    g.addColorStop(0, 'rgba(8,6,5,0.95)');
    g.addColorStop(0.45, 'rgba(20,14,10,0.75)');
    g.addColorStop(0.75, 'rgba(40,30,22,0.28)');
    g.addColorStop(1, 'rgba(50,40,30,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

/** Bullet hole: dark puncture with a faint scuffed rim. */
export function bulletTexture(size = 128) {
  return canvasTexture(size, (ctx, s) => {
    const rim = ctx.createRadialGradient(s / 2, s / 2, s * 0.1, s / 2, s / 2, s * 0.42);
    rim.addColorStop(0, 'rgba(0,0,0,0)');
    rim.addColorStop(0.55, 'rgba(120,110,100,0.35)');
    rim.addColorStop(0.8, 'rgba(60,55,50,0.12)');
    rim.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rim;
    ctx.fillRect(0, 0, s, s);
    const hole = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s * 0.16);
    hole.addColorStop(0, 'rgba(2,2,2,1)');
    hole.addColorStop(0.8, 'rgba(5,5,5,0.95)');
    hole.addColorStop(1, 'rgba(10,10,10,0)');
    ctx.fillStyle = hole;
    ctx.fillRect(0, 0, s, s);
  });
}

const DECAL_PRESETS = { scorch: scorchTexture, bullet: bulletTexture };
export function decalPresetNames() {
  return Object.keys(DECAL_PRESETS);
}

// ---------------------------------------------------------------------------
// Light shafts — pure helper
// ---------------------------------------------------------------------------

/**
 * Frame for a shaft running from `from` (narrow end) to `to` (wide end).
 * Returns { midpoint: Vector3, quaternion: Quaternion (+Y → from→to),
 *           length, direction: Vector3 }.
 */
export function shaftFrame(from, to) {
  const a = toVec3(from);
  const b = toVec3(to);
  const dir = b.clone().sub(a);
  const length = dir.length();
  if (length < 1e-6) {
    throw vError('VWORLD/BAD_SHAFT', '[VWorld] app.lightShaft() — from and to must be different points.');
  }
  dir.normalize();
  const midpoint = a.clone().add(b).multiplyScalar(0.5);
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  return { midpoint, quaternion, length, direction: dir };
}

// ---------------------------------------------------------------------------
// Clouds — pure helper
// ---------------------------------------------------------------------------

/** Tiny deterministic PRNG (mulberry32) so cloud layouts are stable. */
function mulberry32(seed) {
  let a = toNumber(seed, 'seed') >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic cloud puff layout: [{ x, y, z, scale }].
 * area: number (square) | { x, z }; height: number | [min, max];
 * scale: number | [min, max].
 */
export function cloudLayout(count = 40, area = 400, height = 120, scale = [24, 64], seed = 1337) {
  const n = Math.max(1, Math.round(toNumber(count, 'count')));
  const ax = typeof area === 'number' ? area : toNumber(area.x ?? 400, 'area.x');
  const az = typeof area === 'number' ? area : toNumber(area.z ?? 400, 'area.z');
  let hMin, hMax;
  if (Array.isArray(height)) [hMin, hMax] = height.map((h) => toNumber(h, 'height'));
  else hMin = hMax = toNumber(height, 'height');
  let sMin, sMax;
  if (Array.isArray(scale)) [sMin, sMax] = scale.map((s) => toNumber(s, 'scale'));
  else sMin = sMax = toNumber(scale, 'scale');
  const rand = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      x: (rand() - 0.5) * ax,
      y: hMin + rand() * Math.max(0, hMax - hMin),
      z: (rand() - 0.5) * az,
      scale: sMin + rand() * Math.max(0, sMax - sMin),
    });
  }
  return out;
}

/** Soft radial puff texture for cloud sprites. Needs DOM. */
export function cloudTexture(size = 128) {
  return canvasTexture(size, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.42)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

// ---------------------------------------------------------------------------
// InstancedSet — one draw call for crowds, vegetation, debris
// ---------------------------------------------------------------------------

const _m4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const _eul = new THREE.Euler();

/**
 * Fluent wrapper around THREE.InstancedMesh.
 *
 *   app.instanced(geo, mat, 500)
 *     .scatter({ box: [-60, 60], y: [0, 2], scale: [0.7, 1.4] })
 *     .addTo(app);
 *
 *   const trees = app.instanced({ geometry, material, count: 200 });
 *   trees.set(0, { at: [10, 0, 5], scale: 2, rotate: [0, 1.2, 0] }).update();
 */
export class InstancedSet {
  constructor(engine, geometry, material, count = 100) {
    if (!geometry || !geometry.isBufferGeometry) {
      throw vError(
        'VWORLD/BAD_INSTANCED',
        '[VWorld] app.instanced() needs a THREE.BufferGeometry — try new THREE.BoxGeometry(1, 1, 1).'
      );
    }
    if (!material || !material.isMaterial) {
      throw vError(
        'VWORLD/BAD_INSTANCED',
        '[VWorld] app.instanced() needs a THREE.Material — try app.material("metal").'
      );
    }
    this.engine = engine ?? null;
    this.count = Math.max(1, Math.round(toNumber(count, 'count')));
    this.mesh = new THREE.InstancedMesh(geometry, material, this.count);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false; // instances span the world; geometry bounds lie
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Identity transforms until the user sets them.
    const identity = new THREE.Matrix4();
    for (let i = 0; i < this.count; i++) this.mesh.setMatrixAt(i, identity);
    this.mesh.instanceMatrix.needsUpdate = true;
    this._disposed = false;
  }

  /**
   * Set instance i's transform. Chainable (call .update() when done batching).
   * `at`: any toVec3 shape. `scale`: number (uniform) or any toVec3 shape.
   * `rotate`: [x, y, z] radians or { x, y, z }.
   */
  set(i, { at = [0, 0, 0], scale = 1, rotate = [0, 0, 0] } = {}) {
    const idx = Math.round(toNumber(i, 'index'));
    if (idx < 0 || idx >= this.count) {
      throw vError(
        'VWORLD/BAD_INSTANCED',
        `[VWorld] InstancedSet.set() — index ${idx} out of range 0..${this.count - 1}.`
      );
    }
    _pos.copy(toVec3(at));
    if (typeof scale === 'number') _scl.set(scale, scale, scale);
    else _scl.copy(toVec3(scale));
    const r = Array.isArray(rotate) ? rotate : [rotate.x ?? 0, rotate.y ?? 0, rotate.z ?? 0];
    _eul.set(toNumber(r[0], 'rotate[0]'), toNumber(r[1], 'rotate[1]'), toNumber(r[2], 'rotate[2]'));
    _quat.setFromEuler(_eul);
    _m4.compose(_pos, _quat, _scl);
    this.mesh.setMatrixAt(idx, _m4);
    return this;
  }

  /**
   * Fill instances with random transforms inside a region — crowds, forests,
   * grass tufts. Chainable.
   *
   *   .scatter({ box: [-60, 60], count: 300, y: 0, scale: [0.8, 1.6] })
   *
   * box: [min, max] (square XZ) | { x: [min,max], z: [min,max] }.
   * y: number | [min, max]. scale: number | [min, max] (uniform).
   * spin: [min, max] radians of Y rotation (default full circle).
   */
  scatter({ box = [-50, 50], count = this.count, y = 0, scale = 1, spin = [0, Math.PI * 2] } = {}) {
    let xMin, xMax, zMin, zMax;
    if (Array.isArray(box)) {
      [xMin, xMax] = box.map((v) => toNumber(v, 'box'));
      zMin = xMin; zMax = xMax;
    } else {
      [xMin, xMax] = (box.x ?? [-50, 50]).map((v) => toNumber(v, 'box.x'));
      [zMin, zMax] = (box.z ?? [-50, 50]).map((v) => toNumber(v, 'box.z'));
    }
    const n = Math.min(this.count, Math.max(1, Math.round(toNumber(count, 'count'))));
    const yR = Array.isArray(y) ? y.map((v) => toNumber(v, 'y')) : [toNumber(y, 'y'), toNumber(y, 'y')];
    const sR = Array.isArray(scale) ? scale.map((v) => toNumber(v, 'scale')) : [toNumber(scale, 'scale'), toNumber(scale, 'scale')];
    const spR = spin.map((v) => toNumber(v, 'spin'));
    const rnd = (a, b) => a + Math.random() * (b - a);
    for (let i = 0; i < n; i++) {
      const s = rnd(sR[0], sR[1]);
      this.set(i, {
        at: [rnd(xMin, xMax), rnd(yR[0], yR[1]), rnd(zMin, zMax)],
        scale: s,
        rotate: [0, rnd(spR[0], spR[1]), 0],
      });
    }
    return this.update();
  }

  /** Push batched set() calls to the GPU. Chainable. */
  update() {
    this.mesh.instanceMatrix.needsUpdate = true;
    return this;
  }

  /** Move the whole set. Chainable. */
  at(...args) {
    this.mesh.position.copy(toVec3(...args));
    return this;
  }

  /** Shift the whole set. Chainable. */
  moveBy(...args) {
    this.mesh.position.add(toVec3(...args));
    return this;
  }

  /** Add to the scene: `.addTo(app)` or `.addTo(scene)`. Chainable. */
  addTo(appOrScene) {
    const scene = appOrScene.scene ?? appOrScene;
    scene.add(this.mesh);
    return this;
  }

  /** Toggle shadow casting for every instance. Chainable. */
  shadows(on = true) {
    this.mesh.castShadow = !!on;
    this.mesh.receiveShadow = !!on;
    return this;
  }

  /** Free GPU resources. Idempotent. Chainable. */
  dispose() {
    if (this._disposed) return this;
    this._disposed = true;
    this.mesh.removeFromParent();
    this.mesh.dispose();
    return this;
  }
}

// ---------------------------------------------------------------------------
// Decal — bullet holes, scorch marks, paint splats
// ---------------------------------------------------------------------------

/**
 * A quad stuck to a surface along a normal, with optional lifetime + fade.
 *
 *   app.decal({ preset: 'scorch', position: hit, normal: n, size: 2.5,
 *               lifetime: 45, fade: 5 });
 *
 * texture: THREE.Texture | null. preset: 'scorch' | 'bullet' (needs DOM).
 * lifetime <= 0 (default) = permanent.
 */
export class Decal {
  constructor(engine, options = {}) {
    const o = withDefaults(options, {
      texture: null, preset: null, position: [0, 0, 0], normal: [0, 1, 0],
      size: 1, lifetime: 0, fade: 1, opacity: 1, color: 0xffffff,
    });
    this.engine = engine ?? null;
    const frame = decalFrame(o.position, o.normal, o.size);
    let tex = o.texture ?? null;
    if (!tex && o.preset) {
      const gen = DECAL_PRESETS[String(o.preset).toLowerCase()];
      if (!gen) {
        throw vError(
          'VWORLD/BAD_DECAL',
          `[VWorld] Unknown decal preset "${o.preset}" — try: ${decalPresetNames().join(', ')}.`
        );
      }
      tex = gen();
    }
    this.material = new THREE.MeshBasicMaterial({
      map: tex,
      color: toColor(o.color, 'color').getHex(),
      transparent: true,
      opacity: toNumber(o.opacity, 'opacity'),
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(frame.width, frame.height), this.material);
    this.mesh.position.copy(frame.position);
    this.mesh.quaternion.copy(frame.quaternion);
    this.mesh.renderOrder = 2;
    this.lifetime = toNumber(o.lifetime, 'lifetime');
    this.fade = toNumber(o.fade, 'fade');
    this.baseOpacity = this.material.opacity;
    this.age = 0;
    this._disposed = false;
    this._ticker = null;
    if (this.engine && this.lifetime > 0) {
      this._ticker = (dt) => this._tick(dt);
      this.engine.onUpdate(this._ticker);
    }
  }

  _tick(dt) {
    if (this._disposed) return;
    this.age += dt;
    this.material.opacity = this.baseOpacity * decalOpacity(this.age, this.lifetime, this.fade);
    if (this.age >= this.lifetime) this.dispose();
  }

  /** Add to the scene. Chainable. */
  addTo(appOrScene) {
    const scene = appOrScene.scene ?? appOrScene;
    scene.add(this.mesh);
    return this;
  }

  /** Free GPU resources + stop the fade ticker. Idempotent. Chainable. */
  dispose() {
    if (this._disposed) return this;
    this._disposed = true;
    if (this._ticker && this.engine) this.engine.offUpdate(this._ticker);
    this._ticker = null;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.map?.dispose();
    this.material.dispose();
    return this;
  }
}

// ---------------------------------------------------------------------------
// CloudLayer — drifting billboard puffs
// ---------------------------------------------------------------------------

/**
 * Procedural clouds: soft billboard sprites drifting across the sky.
 * Needs DOM (canvas textures). Deterministic layout from `seed`.
 *
 *   app.clouds({ count: 60, area: 500, height: [100, 160], speed: 3 });
 */
export class CloudLayer {
  constructor(engine, options = {}) {
    const o = withDefaults(options, {
      count: 40, area: 400, height: 120, speed: 2,
      scale: [24, 64], opacity: 0.85, seed: 1337, color: 0xffffff,
    });
    this.engine = engine ?? null;
    const layout = cloudLayout(o.count, o.area, o.height, o.scale, o.seed);
    const tex = cloudTexture();
    this.speed = toNumber(o.speed, 'speed');
    const half = (typeof o.area === 'number' ? o.area : toNumber(o.area.x ?? 400, 'area.x')) / 2;
    this._half = half;
    this._group = new THREE.Group();
    this._puffs = [];
    // A few shared materials with stepped opacity — cheaper than one per puff.
    const baseOpacity = toNumber(o.opacity, 'opacity');
    const mats = [0.55, 0.8, 1.0].map(
      (k) =>
        new THREE.SpriteMaterial({
          map: tex, transparent: true, depthWrite: false, fog: false,
          opacity: baseOpacity * k, color: toColor(o.color, 'color').getHex(),
        })
    );
    layout.forEach((p, i) => {
      const sp = new THREE.Sprite(mats[i % mats.length]);
      sp.position.set(p.x, p.y, p.z);
      sp.scale.set(p.scale, p.scale * 0.55, 1);
      this._group.add(sp);
      this._puffs.push(sp);
    });
    this._disposed = false;
    this._ticker = null;
    if (this.engine) {
      this._ticker = (dt) => this.update(dt);
      this.engine.onUpdate(this._ticker);
    }
  }

  /** Drift puffs along +X, wrapping around the area. Chainable. */
  update(dt) {
    if (this._disposed) return this;
    const h = this._half;
    for (const sp of this._puffs) {
      sp.position.x += this.speed * dt;
      if (sp.position.x > h) sp.position.x = -h;
    }
    return this;
  }

  /** Add to the scene. Chainable. */
  addTo(appOrScene) {
    const scene = appOrScene.scene ?? appOrScene;
    scene.add(this._group);
    return this;
  }

  /** Free GPU resources + stop the drift ticker. Idempotent. Chainable. */
  dispose() {
    if (this._disposed) return this;
    this._disposed = true;
    if (this._ticker && this.engine) this.engine.offUpdate(this._ticker);
    this._ticker = null;
    this._group.removeFromParent();
    const seen = new Set();
    this._group.traverse((o) => {
      if (o.isSprite) {
        if (!seen.has(o.material)) {
          seen.add(o.material);
          o.material.map?.dispose();
          o.material.dispose();
        }
      }
    });
    this._puffs.length = 0;
    return this;
  }
}

// ---------------------------------------------------------------------------
// LightShaft — fake volumetric cone
// ---------------------------------------------------------------------------

const SHAFT_VERT = `
varying float vH;
varying vec3 vNormal;
varying vec3 vView;
uniform float uLength;
void main() {
  vH = position.y / uLength + 0.5; // 0 at narrow end, 1 at wide end
  vNormal = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const SHAFT_FRAG = `
uniform vec3 uColor;
uniform float uIntensity;
varying float vH;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  float axial = smoothstep(0.0, 0.25, vH) * (1.0 - smoothstep(0.55, 1.0, vH));
  float edge = abs(dot(normalize(vNormal), normalize(vView)));
  float a = axial * pow(edge, 1.5) * uIntensity;
  gl_FragColor = vec4(uColor, a);
}`;

/**
 * Fake volumetric light shaft: an additive cone, narrow at `from`, wide at
 * `to`. Cheap, no render targets.
 *
 *   app.lightShaft({ from: [0, 30, 0], to: [0, 0, 0], radius: 6 });
 */
export class LightShaft {
  constructor(engine, options = {}) {
    const o = withDefaults(options, {
      from: [0, 10, 0], to: [0, 0, 0], radius: 3,
      color: 0xfff2cc, intensity: 0.35, segments: 24,
    });
    this.engine = engine ?? null;
    const frame = shaftFrame(o.from, o.to);
    const radius = toNumber(o.radius, 'radius');
    if (radius <= 0) {
      throw vError('VWORLD/BAD_SHAFT', '[VWorld] app.lightShaft() — radius must be positive.');
    }
    const geo = new THREE.CylinderGeometry(
      radius, radius * 0.35, frame.length,
      Math.max(8, Math.round(toNumber(o.segments, 'segments'))), 1, true
    );
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uColor: { value: toColor(o.color, 'color') },
        uIntensity: { value: toNumber(o.intensity, 'intensity') },
        uLength: { value: frame.length },
      },
      vertexShader: SHAFT_VERT,
      fragmentShader: SHAFT_FRAG,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.position.copy(frame.midpoint);
    this.mesh.quaternion.copy(frame.quaternion);
    this.mesh.renderOrder = 5;
    this._disposed = false;
  }

  /** Brightness multiplier. Chainable. */
  intensity(v) {
    this.material.uniforms.uIntensity.value = toNumber(v, 'intensity');
    return this;
  }

  /** Add to the scene. Chainable. */
  addTo(appOrScene) {
    const scene = appOrScene.scene ?? appOrScene;
    scene.add(this.mesh);
    return this;
  }

  /** Free GPU resources. Idempotent. Chainable. */
  dispose() {
    if (this._disposed) return this;
    this._disposed = true;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    return this;
  }
}
