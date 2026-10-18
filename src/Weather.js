import * as THREE from 'three';
import { toVec3, toNumber, withDefaults } from './util/normalize.js';
import { vError } from './util/errors.js';

/**
 * Weather & atmosphere (v0.9.0) — precipitation, storms, wind zones,
 * and day/night polish.
 *
 *   app.weather('rain', { intensity: 0.8 });
 *   app.weather('storm');                       // lightning + thunder
 *   app.timeOfDay('dusk');                      // 18.5h
 *   world.wind({ at: [0, 0, 0], radius: 60, direction: 'E', strength: 3 });
 *   world.windAt([10, 0, 5]);                   // -> THREE.Vector3
 *
 * Everything up to the render boundary is node-testable: the pure helpers
 * below are THREE-free (plain {x,y,z} / arrays), and the Weather / WindSystem
 * classes only touch THREE for visuals.
 */

export const WEATHER_KINDS = ['rain', 'snow', 'storm', 'fog', 'clear'];

/** Validate a weather kind (case-insensitive). Throws VWORLD/BAD_WEATHER_KIND. */
export function normalizeWeatherKind(kind) {
  const k = String(kind ?? '').toLowerCase();
  if (!WEATHER_KINDS.includes(k)) {
    throw vError(
      'VWORLD/BAD_WEATHER_KIND',
      `[VWorld] Unknown weather "${kind}". Try: ${WEATHER_KINDS.join(', ')}.`
    );
  }
  return k;
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Normalize weather options with sensible defaults. */
export function normalizeWeatherOptions(opts = {}) {
  const o = withDefaults(opts, {
    intensity: 0.6,    // 0..1 — how hard it rains/snows/storms/fogs
    area: 120,          // precipitation box size in meters (follows camera)
    count: 1500,        // particle count
    height: 40,         // fall height in meters
    seed: 1337,          // deterministic layout seed
    lightningRate: 0.12,// storm strikes/sec at intensity 1
    fogDensity: 0.5,    // how dense 'fog' gets (0..1)
    windScale: 1,       // wind influence on precipitation drift
  });
  o.intensity = clamp01(toNumber(o.intensity, 'intensity'));
  o.area = Math.max(10, toNumber(o.area, 'area'));
  o.count = Math.max(0, Math.floor(toNumber(o.count, 'count')));
  o.height = Math.max(4, toNumber(o.height, 'height'));
  o.seed = Math.floor(toNumber(o.seed, 'seed'));
  o.lightningRate = Math.max(0, toNumber(o.lightningRate, 'lightningRate'));
  o.fogDensity = clamp01(toNumber(o.fogDensity, 'fogDensity'));
  o.windScale = Math.max(0, toNumber(o.windScale, 'windScale'));
  return o;
}

// --- sun & sky math (pure) ---------------------------------------------------

/**
 * Sun direction for a time of day. `hour` 0..24 (wraps).
 * Returns { x, y, z } unit vector, elevation (-1..1), isDay.
 */
export function sunPositionAt(hour) {
  const h = ((toNumber(hour, 'hour') % 24) + 24) % 24;
  const a = ((h - 6) / 12) * Math.PI; // 6h sunrise -> 12h zenith -> 18h sunset
  const elevation = Math.sin(a);
  const az = Math.cos(a);
  const x = az * 0.55, y = elevation, z = 0.35;
  const len = Math.hypot(x, y, z) || 1;
  return { x: x / len, y: y / len, z: z / len, elevation, isDay: elevation > 0.02 };
}

const _c = (hex) => {
  const n = typeof hex === 'number' ? hex : parseInt(String(hex).replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const _lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Sky grading keyframes — complements the engine's day/night palettes. */
export const SKY_KEYFRAMES = [
  { h: 0,   top: _c(0x04070f), bottom: _c(0x0e1c30), sun: _c(0x8fb4ff), sunI: 0.35, hemiI: 0.18 },
  { h: 5,   top: _c(0x0a1226), bottom: _c(0x1a2a44), sun: _c(0x8fb4ff), sunI: 0.30, hemiI: 0.16 },
  { h: 6.5, top: _c(0x2b3a6e), bottom: _c(0xff9a56), sun: _c(0xffb36b), sunI: 1.40, hemiI: 0.50 },
  { h: 9,   top: _c(0x3d7bc4), bottom: _c(0xcfe8f5), sun: _c(0xfff4e0), sunI: 2.40, hemiI: 0.90 },
  { h: 16,  top: _c(0x3d7bc4), bottom: _c(0xcfe8f5), sun: _c(0xfff4e0), sunI: 2.40, hemiI: 0.90 },
  { h: 18.5,top: _c(0x2b3a6e), bottom: _c(0xff9a56), sun: _c(0xffb36b), sunI: 1.40, hemiI: 0.50 },
  { h: 20,  top: _c(0x04070f), bottom: _c(0x0e1c30), sun: _c(0x8fb4ff), sunI: 0.35, hemiI: 0.18 },
  { h: 24,  top: _c(0x04070f), bottom: _c(0x0e1c30), sun: _c(0x8fb4ff), sunI: 0.35, hemiI: 0.18 },
];

const _sstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/**
 * Interpolated sky state for an hour (0..24). Returns
 * { top, bottom, sun } as [r,g,b] 0..255, sunI, hemiI, night 0..1, starAlpha 0..1.
 */
export function skyKeyframeAt(hour) {
  const h = ((toNumber(hour, 'hour') % 24) + 24) % 24;
  let lo = SKY_KEYFRAMES[0], hi = SKY_KEYFRAMES[SKY_KEYFRAMES.length - 1];
  for (let i = 0; i < SKY_KEYFRAMES.length - 1; i++) {
    if (h >= SKY_KEYFRAMES[i].h && h <= SKY_KEYFRAMES[i + 1].h) { lo = SKY_KEYFRAMES[i]; hi = SKY_KEYFRAMES[i + 1]; break; }
  }
  const span = hi.h - lo.h || 1;
  const t = clamp01((h - lo.h) / span);
  const { elevation } = sunPositionAt(h);
  const night = 1 - _sstep(-0.12, 0.10, elevation);
  return {
    top: _lerp3(lo.top, hi.top, t),
    bottom: _lerp3(lo.bottom, hi.bottom, t),
    sun: _lerp3(lo.sun, hi.sun, t),
    sunI: lo.sunI + (hi.sunI - lo.sunI) * t,
    hemiI: lo.hemiI + (hi.hemiI - lo.hemiI) * t,
    night,
    starAlpha: 1 - _sstep(-0.14, 0.04, elevation),
  };
}

// --- wind (pure) ---------------------------------------------------------------

const COMPASS = {
  n: 270, north: 270, s: 90, south: 90, e: 0, east: 0, w: 180, west: 180,
  ne: 315, northeast: 315, se: 45, southeast: 45, sw: 135, southwest: 135, nw: 225, northwest: 225,
};

/**
 * Normalize a wind zone. direction accepts: [x,z] | {x,z} | degrees
 * (0° = +x east, 90° = +z south) | compass 'N'|'SE'|... Returns
 * { at: Vector3, radius, dirX, dirZ, strength }.
 */
export function normalizeWindZone(opts = {}) {
  const o = withDefaults(opts, { at: [0, 0, 0], radius: 40, direction: [1, 0], strength: 2 });
  const at = toVec3(o.at);
  let dx, dz;
  const d = o.direction;
  if (typeof d === 'number') {
    const a = (d * Math.PI) / 180;
    dx = Math.cos(a); dz = Math.sin(a);
  } else if (typeof d === 'string') {
    const deg = COMPASS[d.toLowerCase()];
    if (deg === undefined) {
      throw vError('VWORLD/BAD_WIND', `[VWorld] Unknown wind direction "${d}". Use [x,z], degrees, or a compass point.`);
    }
    const a = (deg * Math.PI) / 180;
    dx = Math.cos(a); dz = Math.sin(a);
  } else if (Array.isArray(d)) {
    dx = toNumber(d[0], 'direction[0]'); dz = toNumber(d[1] ?? 0, 'direction[1]');
  } else if (d && typeof d === 'object') {
    const v = toVec3(d); dx = v.x; dz = v.z;
  } else {
    throw vError('VWORLD/BAD_WIND', '[VWorld] wind direction must be [x,z], {x,z}, degrees, or a compass point.');
  }
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) throw vError('VWORLD/BAD_WIND', '[VWorld] wind direction must not be zero-length.');
  return {
    at,
    radius: Math.max(0.5, toNumber(o.radius, 'radius')),
    dirX: dx / len,
    dirZ: dz / len,
    strength: toNumber(o.strength, 'strength'),
  };
}

/**
 * Sum wind zone contributions at a ground point (smooth quadratic falloff).
 * `zones`: [{ at:{x,z}, radius, dirX, dirZ, strength }]. Returns { x, z }.
 */
export function windFieldAt(zones, x, z) {
  let vx = 0, vz = 0;
  for (const zn of zones ?? []) {
    const ax = zn.at && zn.at.x !== undefined ? zn.at.x : 0;
    const az = zn.at && zn.at.z !== undefined ? zn.at.z : 0;
    const dx = x - ax, dz = z - az;
    const r = zn.radius > 0 ? zn.radius : 0.5;
    const dist = Math.hypot(dx, dz);
    if (dist >= r) continue;
    const f = (1 - (dist / r) ** 2) ** 2;
    vx += (zn.dirX ?? 0) * zn.strength * f;
    vz += (zn.dirZ ?? 0) * zn.strength * f;
  }
  return { x: vx, z: vz };
}

/** Live wind zone registry. Zones are plain data + a remove() handle. */
export class WindSystem {
  constructor() { this.zones = []; }

  /** Add a zone: world.wind({ at, radius, direction, strength }). Returns the zone. */
  add(opts = {}) {
    const z = normalizeWindZone(opts);
    z.remove = () => this.remove(z);
    this.zones.push(z);
    return z;
  }

  remove(zone) { this.zones = this.zones.filter((z) => z !== zone); return this; }
  clear() { this.zones.length = 0; return this; }
  count() { return this.zones.length; }

  /** Wind vector at a ground point. x,z numbers (or anything toVec3-shaped via caller). */
  at(x, z) { return windFieldAt(this.zones, x, z); }
}

// --- precipitation layout (pure) -----------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic precipitation particle layout. Returns a Float32Array of
 * [x, y, z, speed, phase] per particle. Same seed -> same layout.
 */
export function precipitationSeed(count, area, height, seed = 1337) {
  const n = Math.max(0, Math.floor(count));
  const out = new Float32Array(n * 5);
  const rand = mulberry32(seed);
  for (let i = 0; i < n; i++) {
    out[i * 5 + 0] = (rand() - 0.5) * area;
    out[i * 5 + 1] = rand() * height;
    out[i * 5 + 2] = (rand() - 0.5) * area;
    out[i * 5 + 3] = 0.6 + rand() * 0.8;  // speed multiplier
    out[i * 5 + 4] = rand() * Math.PI * 2; // sway phase
  }
  return out;
}

// --- gameplay hooks (pure) -------------------------------------------------------

/** Entity speed multiplier in snow (0.55x at full intensity). */
export function snowSpeedMultiplier(intensity) { return 1 - 0.45 * clamp01(toNumber(intensity, 'intensity')); }
/** Ground friction factor in rain (0.75x at full intensity). */
export function rainFrictionFactor(intensity) { return 1 - 0.25 * clamp01(toNumber(intensity, 'intensity')); }
/** Visibility factor in rain — multiply fog near/far by this (0.45x at full). */
export function rainVisibility(intensity) { return 1 - 0.55 * clamp01(toNumber(intensity, 'intensity')); }

/**
 * Delay until the next lightning strike (exponential distribution).
 * `rand` in [0,1) lets tests pin the value.
 */
export function nextStrikeDelay(ratePerSec, rand = Math.random()) {
  const r = Math.min(1 - 1e-6, Math.max(1e-6, toNumber(rand, 'rand')));
  return -Math.log(1 - r) / Math.max(1e-6, toNumber(ratePerSec, 'ratePerSec'));
}

// --- precipitation visuals -------------------------------------------------------

const PRECIP_VERT = `
  attribute float aSpeed;
  attribute float aPhase;
  uniform float uTime;
  uniform vec2 uWind;      // xz wind * windScale
  uniform float uHeight;
  uniform float uArea;
  uniform float uFall;      // base fall speed m/s
  uniform float uSway;      // horizontal sway amplitude (snow)
  uniform float uSize;      // point size
  varying float vFade;
  void main() {
    vec3 p = position;
    float t = uTime;
    // wind drift wraps inside the area box
    p.x = mod(p.x + uWind.x * t + uArea * 0.5, uArea) - uArea * 0.5;
    p.z = mod(p.z + uWind.y * t + uArea * 0.5, uArea) - uArea * 0.5;
    // fall wraps inside the height column
    p.y = uHeight - mod(p.y + t * uFall * aSpeed, uHeight);
    // snow sway
    p.x += sin(t * 1.7 + aPhase) * uSway;
    p.z += cos(t * 1.3 + aPhase) * uSway;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = uSize * (140.0 / max(1.0, -mv.z));
    vFade = smoothstep(0.0, 2.0, p.y) * smoothstep(uHeight, uHeight - 4.0, p.y);
    gl_Position = projectionMatrix * mv;
  }`;

const PRECIP_FRAG = `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFade;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.15, d) * uOpacity * vFade;
    gl_FragColor = vec4(uColor, a);
  }`;

const RAIN_VERT = `
  attribute float aSpeed;
  attribute float aPhase;
  uniform float uTime;
  uniform vec2 uWind;
  uniform float uHeight;
  uniform float uArea;
  uniform float uFall;
  uniform float uStreak;   // streak length in meters
  varying float vFade;
  void main() {
    vec3 p = position;
    float t = uTime;
    p.x = mod(p.x + uWind.x * t + uArea * 0.5, uArea) - uArea * 0.5;
    p.z = mod(p.z + uWind.y * t + uArea * 0.5, uArea) - uArea * 0.5;
    float fall = mod(p.y + t * uFall * aSpeed, uHeight);
    p.y = uHeight - fall;
    // streak tail: second vertex of each pair hangs below
    if (aPhase > 3.14159) p.y -= uStreak;
    vFade = smoothstep(0.0, 2.0, p.y) * smoothstep(uHeight, uHeight - 4.0, p.y);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }`;

const RAIN_FRAG = `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFade;
  void main() { gl_FragColor = vec4(uColor, uOpacity * vFade); }`;

/** GPU precipitation: rain/storm = line streaks, snow = soft points. Follows the camera. */
class Precipitation {
  constructor(scene, mode, opts) {
    this.scene = scene;
    this.mode = mode; // 'rain' | 'snow'
    const layout = precipitationSeed(opts.count, opts.area, opts.height, opts.seed);
    const n = opts.count;
    const pos = new Float32Array(n * 3);
    const speed = new Float32Array(n);
    const phase = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = layout[i * 5]; pos[i * 3 + 1] = layout[i * 5 + 1]; pos[i * 3 + 2] = layout[i * 5 + 2];
      speed[i] = layout[i * 5 + 3]; phase[i] = layout[i * 5 + 4];
    }
    const geo = new THREE.BufferGeometry();
    if (mode === 'rain') {
      // two vertices per drop; tail flagged by aPhase > PI
      const p2 = new Float32Array(n * 2 * 3);
      const s2 = new Float32Array(n * 2);
      const ph2 = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < 2; k++) {
          p2[(i * 2 + k) * 3] = pos[i * 3]; p2[(i * 2 + k) * 3 + 1] = pos[i * 3 + 1]; p2[(i * 2 + k) * 3 + 2] = pos[i * 3 + 2];
          s2[i * 2 + k] = speed[i]; ph2[i * 2 + k] = phase[i] + (k === 1 ? Math.PI + 0.1 : 0);
        }
      }
      geo.setAttribute('position', new THREE.BufferAttribute(p2, 3));
      geo.setAttribute('aSpeed', new THREE.BufferAttribute(s2, 1));
      geo.setAttribute('aPhase', new THREE.BufferAttribute(ph2, 1));
      this.mat = new THREE.ShaderMaterial({
        vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG,
        transparent: true, depthWrite: false,
        uniforms: {
          uTime: { value: 0 }, uWind: { value: new THREE.Vector2() },
          uHeight: { value: opts.height }, uArea: { value: opts.area },
          uFall: { value: mode === 'rain' ? 28 : 4 },
          uStreak: { value: 0.9 },
          uColor: { value: new THREE.Color(mode === 'rain' ? 0x9db8d6 : 0xffffff) },
          uOpacity: { value: 0.55 },
        },
      });
      this.mesh = new THREE.LineSegments(geo, this.mat);
    } else {
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
      geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
      this.mat = new THREE.ShaderMaterial({
        vertexShader: PRECIP_VERT, fragmentShader: PRECIP_FRAG,
        transparent: true, depthWrite: false,
        uniforms: {
          uTime: { value: 0 }, uWind: { value: new THREE.Vector2() },
          uHeight: { value: opts.height }, uArea: { value: opts.area },
          uFall: { value: 4 }, uSway: { value: 0.7 }, uSize: { value: 26 },
          uColor: { value: new THREE.Color(0xffffff) },
          uOpacity: { value: 0.85 },
        },
      });
      this.mesh = new THREE.Points(geo, this.mat);
    }
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
  }

  /** Rebuild when mode/count changes. */
  static needsRebuild(prev, next) {
    return !prev || prev.mode !== next.mode || prev.count !== next.count;
  }

  update(dt, time, wind) {
    const u = this.mat.uniforms;
    u.uTime.value = time;
    u.uWind.value.set(wind.x, wind.z);
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

// --- the Weather system ----------------------------------------------------------

/**
 * Weather — precipitation, storms, fog, and gameplay hooks.
 *
 *   app.weather('rain', { intensity: 0.8 });
 *   app.weather().on('lightning:strike', ({ position }) => { ... });
 *   app.weather().speedMultiplier();   // snow slows entities
 */
export class Weather {
  constructor(world) {
    this.world = world;
    this.kind = 'clear';
    this.o = normalizeWeatherOptions();
    this._handlers = new Map();
    this._precip = null;       // Precipitation | null
    this._precipKey = '';      // mode+count+area+height+seed signature
    this._flash = null;        // storm flash light
    this._strikeIn = Infinity; // seconds until next strike
    this._flashT = 0;          // flash decay timer
    this._savedFog = null;     // { near, far } to restore
    this._time = 0;
    this._disposed = false;
  }

  // --- events ------------------------------------------------------------------
  on(event, fn) {
    if (typeof fn !== 'function') throw vError('VWORLD/BAD_HANDLER', '[VWorld] weather.on(event, fn) — fn must be a function.');
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(fn);
    return this;
  }

  off(event, fn) {
    this._handlers.get(event)?.delete(fn);
    return this;
  }

  _emit(event, data) {
    for (const fn of this._handlers.get(event) ?? []) {
      try { fn(data); } catch (err) {
        this.world?.engine?._errorBus?.report(err);
      }
    }
  }

  /**
   * Set the weather. `kind`: 'rain'|'snow'|'storm'|'fog'|'clear' (also accepts
   * { kind, intensity, ... } object form). Emits 'change' { kind, prev }.
   */
  set(kind, opts = {}) {
    if (this._disposed) throw vError('VWORLD/APP_DISPOSED', '[VWorld] weather.set() after dispose.');
    if (kind && typeof kind === 'object' && !Array.isArray(kind)) {
      ({ kind, ...opts } = kind);
    }
    const next = normalizeWeatherKind(kind);
    this.o = normalizeWeatherOptions({ ...this.o, ...opts });
    const prev = this.kind;
    this.kind = next;
    this._applyFog();
    this._syncPrecipitation();
    if (next === 'storm') {
      this._strikeIn = Math.min(this._strikeIn, nextStrikeDelay(this.o.lightningRate * this.o.intensity));
    } else {
      this._strikeIn = Infinity;
    }
    this._emit('change', { kind: next, prev, intensity: this.o.intensity });
    return this;
  }

  /** Back to clear skies. Chainable. */
  clear() { return this.set('clear'); }

  /** Current intensity 0..1. */
  get intensity() { return this.o.intensity; }

  /** Entity speed multiplier from weather (snow slows). */
  speedMultiplier() {
    return this.kind === 'snow' ? snowSpeedMultiplier(this.o.intensity) : 1;
  }

  /** Ground friction factor from weather (rain slicks). */
  frictionFactor() {
    return (this.kind === 'rain' || this.kind === 'storm') ? rainFrictionFactor(this.o.intensity) : 1;
  }

  /** Force a lightning strike now (storms also strike on a timer). Returns { position }. */
  strike() {
    const a = this.o.area;
    const position = [(Math.random() - 0.5) * a, 0, (Math.random() - 0.5) * a];
    // Camera-relative so strikes land near the action.
    const cam = this.world?.engine?.camera;
    if (cam) { position[0] += cam.position.x; position[2] += cam.position.z; }
    if (!this._flash) {
      this._flash = new THREE.DirectionalLight(0xdde8ff, 0);
      this._flash.position.set(position[0], 300, position[2]);
      this.world.engine.scene.add(this._flash);
    } else {
      this._flash.position.set(position[0], 300, position[2]);
    }
    this._flash.intensity = 5 + Math.random() * 4;
    this._flashT = 0.35;
    this._emit('lightning:strike', { position });
    // Thunder rolls in after the light — distance / speed of sound.
    const audio = this.world?.engine?.audio;
    if (audio && typeof audio.play === 'function') {
      const cx = cam ? cam.position.x : 0, cz = cam ? cam.position.z : 0;
      const dist = Math.hypot(position[0] - cx, position[2] - cz);
      const delay = Math.min(3, Math.max(0.15, dist / 343));
      const vol = Math.min(1, Math.max(0.15, 1 - dist / (a * 1.5)));
      setTimeout(() => {
        try { audio.play('thunder', { volume: vol }); } catch { /* audio is best-effort */ }
      }, delay * 1000);
    }
    return { position };
  }

  // --- internals -----------------------------------------------------------------

  _scene() { return this.world?.engine?.scene ?? null; }

  _syncPrecipitation() {
    const scene = this._scene();
    const mode = this.kind === 'snow' ? 'snow' : (this.kind === 'rain' || this.kind === 'storm') ? 'rain' : null;
    const key = mode ? `${mode}:${this.o.count}:${this.o.area}:${this.o.height}:${this.o.seed}` : '';
    if (key !== this._precipKey) {
      if (this._precip) { this._precip.dispose(); this._precip = null; }
      this._precipKey = key;
      if (mode && scene) this._precip = new Precipitation(scene, mode, this.o);
    }
    if (this._precip) {
      this._precip.mat.uniforms.uOpacity.value =
        (mode === 'snow' ? 0.85 : 0.55) * (0.25 + 0.75 * this.o.intensity);
    }
  }

  _applyFog() {
    const scene = this._scene();
    if (!scene || !scene.fog) return;
    const fog = scene.fog;
    // Save the baseline once (day/night keeps recoloring fog.color — that's fine).
    if (!this._savedFog) this._savedFog = { near: fog.near, far: fog.far };
    const base = this._savedFog;
    if (this.kind === 'fog') {
      const d = this.o.fogDensity * this.o.intensity + (1 - this.o.intensity) * 0.15;
      fog.near = base.near + (8 - base.near) * d;
      fog.far = base.far + (140 - base.far) * d;
    } else if (this.kind === 'rain' || this.kind === 'storm') {
      const v = rainVisibility(this.o.intensity);
      fog.near = base.near * v;
      fog.far = base.far * (0.35 + 0.65 * v);
    } else {
      fog.near = base.near; fog.far = base.far;
    }
  }

  /** Called every frame by World.update. */
  update(dt) {
    if (this._disposed) return;
    this._time += dt;
    // Storm lightning on an exponential timer.
    if (this.kind === 'storm') {
      this._strikeIn -= dt;
      if (this._strikeIn <= 0) {
        this.strike();
        this._strikeIn = nextStrikeDelay(Math.max(0.02, this.o.lightningRate * this.o.intensity));
      }
    }
    // Flash decay.
    if (this._flashT > 0) {
      this._flashT -= dt;
      if (this._flash) {
        // double-blink: bright, dip, bright again, then fade
        const t = Math.max(0, this._flashT / 0.35);
        this._flash.intensity = 9 * t * (0.6 + 0.4 * Math.sin(t * 25));
        if (this._flashT <= 0) this._flash.intensity = 0;
      }
    }
    // Precipitation follows the camera and drifts with the wind.
    if (this._precip) {
      const cam = this.world?.engine?.camera;
      let wx = 0, wz = 0;
      if (cam) {
        this._precip.mesh.position.set(cam.position.x, 0, cam.position.z);
        const f = this.world._wind ? this.world._wind.at(cam.position.x, cam.position.z) : { x: 0, z: 0 };
        wx = f.x * this.o.windScale; wz = f.z * this.o.windScale;
      }
      this._precip.update(dt, this._time, { x: wx, z: wz });
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._precip) { this._precip.dispose(); this._precip = null; }
    if (this._flash) { this._scene()?.remove(this._flash); this._flash = null; }
    // Restore baseline fog.
    const scene = this._scene();
    if (scene && scene.fog && this._savedFog) {
      scene.fog.near = this._savedFog.near;
      scene.fog.far = this._savedFog.far;
    }
    this._handlers.clear();
  }
}

/** Named times of day for app.timeOfDay(). */
export const TIME_OF_DAY_NAMES = {
  midnight: 0, night: 0, dawn: 6, sunrise: 6, morning: 9,
  noon: 12, midday: 12, afternoon: 15, dusk: 18.5, sunset: 18.5, evening: 20,
};

/** Normalize an hour input: number 0..24 or a name like 'dusk'. */
export function normalizeHour(hour) {
  if (typeof hour === 'string') {
    const h = TIME_OF_DAY_NAMES[hour.toLowerCase()];
    if (h === undefined) {
      throw vError(
        'VWORLD/BAD_HOUR',
        `[VWorld] Unknown time of day "${hour}". Use 0-24 or: ${Object.keys(TIME_OF_DAY_NAMES).join(', ')}.`
      );
    }
    return h;
  }
  const h = toNumber(hour, 'hour');
  if (h < 0 || h > 24) throw vError('VWORLD/BAD_HOUR', '[VWorld] timeOfDay hour must be 0-24.');
  return h;
}
