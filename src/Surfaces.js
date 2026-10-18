import * as THREE from 'three';
import { toNumber, withDefaults } from './util/normalize.js';

/**
 * Surfaces — the terrain floor IS its material.
 *
 * Instead of scattering decoration meshes, the terrain surface itself is a
 * rule-blended mix of material kinds (grass, sand, rock, ...), implemented
 * as GPU splat mapping: per-vertex weights computed once in JS, mixed in a
 * custom shader injected into MeshStandardMaterial (so lights, shadows and
 * fog keep working).
 *
 *   app.world.surfaceKind('moss', { color: 0x3d6b2f, roughness: 1 });
 *   app.world.terrain({
 *     size: 400, height: (x, z) => hills(x, z),
 *     surface: [
 *       { kind: 'grass' },                                            // base
 *       { kind: 'sand', where: { nearFluid: 'water', within: 6 } },
 *       { kind: 'rock', where: { slope: { min: 0.55 } } },
 *       { kind: 'snow', where: { height: { min: 60 } } },
 *       { kind: 'mud',  where: { noise: { scale: 0.05, threshold: 0.62 } } },
 *     ],
 *   });
 *
 * `where` conditions AND together; each blends smoothly; later rules win
 * ties (standard over-compositing). A rule with no `where` covers everything
 * (useful as the base layer).
 */

export const MAX_SURFACE_LAYERS = 8;

const BUILTIN_KINDS = {
  grass: { color: 0x5da24f, roughness: 0.95 },
  dirt:  { color: 0x7a5a3a, roughness: 0.95 },
  sand:  { color: 0xd9b36c, roughness: 0.9 },
  rock:  { color: 0x8d8d94, roughness: 0.9 },
  snow:  { color: 0xeef2f7, roughness: 0.6 },
  mud:   { color: 0x5a4632, roughness: 1.0 },
};

// ---------------------------------------------------------------------------
// Pure math — no DOM, no THREE scene graph. Importable in node for tests.
// ---------------------------------------------------------------------------

function sstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Deterministic 2D value noise in [0, 1]. */
export function valueNoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const h = (a, b) => {
    const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const A = h(xi, yi), B = h(xi + 1, yi), C = h(xi, yi + 1), D = h(xi + 1, yi + 1);
  return A + (B - A) * u + (C - A) * v + (A - B - C + D) * u * v;
}

function bandWeight(v, band, defaultSoft) {
  const s = band.softness ?? defaultSoft;
  let w = 1;
  if (band.min !== undefined) w *= sstep(band.min - s, band.min + s, v);
  if (band.max !== undefined) w *= 1 - sstep(band.max - s, band.max + s, v);
  return w;
}

function distToBoxXZ(x, z, box) {
  const dx = Math.max(box.min.x - x, 0, x - box.max.x);
  const dz = Math.max(box.min.z - z, 0, z - box.max.z);
  return Math.hypot(dx, dz);
}

/**
 * Evaluate one surface rule at a terrain sample.
 * ctx: { x, z, height, slope, fluids: [{ name, type, box }] }
 * Returns 0..1.
 */
export function evaluateRuleWeight(rule, ctx) {
  const where = rule.where || {};
  let w = 1;
  if (where.slope) w *= bandWeight(ctx.slope, withDefaults(where.slope, {}), 0.06);
  if (where.height) w *= bandWeight(ctx.height, withDefaults(where.height, {}), 1.5);
  if (where.noise) {
    const n = withDefaults(where.noise, { scale: 0.05, threshold: 0.5, softness: 0.2 });
    const val = valueNoise(ctx.x * n.scale, ctx.z * n.scale);
    w *= sstep(n.threshold - n.softness, n.threshold + n.softness, val);
  }
  if (where.nearFluid !== undefined || where.within !== undefined) {
    const match = where.nearFluid;
    const within = toNumber(where.within ?? 4, 'within');
    let dmin = Infinity;
    for (const f of ctx.fluids || []) {
      if (match !== undefined && f.name !== match && f.type !== match) continue;
      dmin = Math.min(dmin, distToBoxXZ(ctx.x, ctx.z, f.box));
    }
    w *= dmin === Infinity ? 0 : 1 - sstep(0, within, dmin);
  }
  return Math.min(1, Math.max(0, w));
}

/**
 * Over-composite raw rule weights so later rules win ties.
 * Remainder (uncovered ground) falls back to the first rule (the base).
 * Returns weights summing to 1.
 */
export function compositeWeights(raw) {
  const n = raw.length;
  const W = new Array(n).fill(0);
  let uncovered = 1;
  for (let i = n - 1; i >= 0; i--) {
    const w = Math.min(1, Math.max(0, raw[i]));
    W[i] = w * uncovered;
    uncovered *= 1 - w;
  }
  if (n > 0) W[0] += uncovered;
  return W;
}

// ---------------------------------------------------------------------------
// Kind registry + procedural textures (DOM needed only when building).
// ---------------------------------------------------------------------------

function canvas2d(w, h) {
  if (typeof document === 'undefined') {
    throw new Error('[VWorld] Surface textures need a browser DOM — build terrain in the browser, not node.');
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** Procedural detail texture for a kind: base color + speckles + blotches. */
function makeKindTexture(colorHex, seed = 1) {
  const S = 128;
  const c = canvas2d(S, S);
  const g = c.getContext('2d');
  const base = new THREE.Color(colorHex);
  g.fillStyle = `#${base.getHexString()}`;
  g.fillRect(0, 0, S, S);
  // Deterministic pseudo-random from seed.
  let s = seed * 1013904223 + 1664525;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const tmp = new THREE.Color();
  for (let i = 0; i < 900; i++) {
    const v = 0.82 + rnd() * 0.36;
    tmp.copy(base).multiplyScalar(v);
    g.fillStyle = `#${tmp.getHexString()}`;
    const r = 1 + rnd() * 2.2;
    g.beginPath();
    g.arc(rnd() * S, rnd() * S, r, 0, 7);
    g.fill();
  }
  for (let i = 0; i < 14; i++) {
    const v = 0.9 + rnd() * 0.2;
    tmp.copy(base).multiplyScalar(v);
    g.fillStyle = `#${tmp.getHexString()}`;
    g.globalAlpha = 0.5;
    const r = 8 + rnd() * 18;
    g.beginPath();
    g.arc(rnd() * S, rnd() * S, r, 0, 7);
    g.fill();
  }
  g.globalAlpha = 1;
  return c;
}

export class SurfaceKinds {
  constructor() {
    this.kinds = new Map();
    for (const [name, def] of Object.entries(BUILTIN_KINDS)) {
      this.kinds.set(name, { color: def.color, roughness: def.roughness, texture: null });
    }
  }

  /**
   * Register (or override) a surface kind.
   *   world.surfaceKind('moss', { color: 0x3d6b2f, roughness: 1 });
   *   world.surfaceKind('marble', { color: 0xffffff, texture: canvasEl });
   */
  register(name, { color = 0xffffff, roughness = 0.95, texture = null } = {}) {
    this.kinds.set(String(name), { color, roughness: toNumber(roughness, 'roughness'), texture });
    return this;
  }

  has(name) {
    return this.kinds.has(String(name));
  }

  get(name) {
    const k = this.kinds.get(String(name));
    if (!k) {
      throw new Error(`[VWorld] Unknown surface kind "${name}". Built-ins: ${[...this.kinds.keys()].join(', ')} — or register one with world.surfaceKind().`);
    }
    return k;
  }

  names() {
    return [...this.kinds.keys()];
  }
}

/**
 * Build a texture atlas (4x2 tiles of 128px) from ordered kind names.
 * Returns { texture, count }.
 */
export function buildAtlas(kindNames, kinds) {
  const cols = 4, rows = 2, tile = 128;
  const atlas = canvas2d(cols * tile, rows * tile);
  const g = atlas.getContext('2d');
  kindNames.forEach((name, i) => {
    const kind = kinds.get(name);
    const src = kind.texture || makeKindTexture(kind.color, i + 1);
    g.drawImage(src, (i % cols) * tile, Math.floor(i / cols) * tile, tile, tile);
  });
  const tex = new THREE.CanvasTexture(atlas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return { texture: tex, count: kindNames.length };
}

/**
 * MeshStandardMaterial with a splat-mixing shader injected.
 * kindDefs: [{ color, roughness }] aligned with the atlas tiles (≤ 8).
 * Weights come from per-vertex attributes aW0/aW1 (vec4 each).
 * vertexColors stay enabled (white by default) so biome() tints still work.
 */
export function buildSplatMaterial(kindDefs, { repeat = 24, atlasTexture = null } = {}) {
  if (kindDefs.length > MAX_SURFACE_LAYERS) {
    throw new Error(`[VWorld] A terrain supports up to ${MAX_SURFACE_LAYERS} surface kinds — got ${kindDefs.length}.`);
  }
  const defs = [...kindDefs];
  while (defs.length < MAX_SURFACE_LAYERS) defs.push({ color: 0xffffff, roughness: 1 });

  const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, vertexColors: true });

  // Unrolled mix loop (constant indices — safe on every GLSL version).
  // Accumulators use vworld-prefixed names at main() scope so the
  // roughness chunk (which comes later) can read them.
  let mixCode = '';
  for (let i = 0; i < MAX_SURFACE_LAYERS; i++) {
    const wSrc = i < 4 ? `vW0[${i}]` : `vW1[${i - 4}]`;
    mixCode += `
    {
      float wLayer = ${wSrc};
      vec2 auv = (vec2(${(i % 4).toFixed(1)}, ${(Math.floor(i / 4)).toFixed(1)}) + vworldSuv) / vec2(4.0, 2.0);
      vec3 texel = texture2D(uAtlas, auv).rgb * uTint[${i}];
      vworldSplat += texel * wLayer;
      vworldRough += uRough[${i}] * wLayer;
      vworldWsum += wLayer;
    }`;
  }

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uAtlas = { value: atlasTexture };
    shader.uniforms.uTint = { value: defs.map((d) => new THREE.Color(d.color)) };
    shader.uniforms.uRough = { value: defs.map((d) => toNumber(d.roughness, 'roughness')) };
    shader.uniforms.uRepeat = { value: toNumber(repeat, 'repeat') };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aW0;
        attribute vec4 aW1;
        varying vec4 vW0;
        varying vec4 vW1;
        varying vec2 vSplatUv;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vW0 = aW0;
        vW1 = aW1;
        vSplatUv = uv;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uAtlas;
        uniform vec3 uTint[${MAX_SURFACE_LAYERS}];
        uniform float uRough[${MAX_SURFACE_LAYERS}];
        uniform float uRepeat;
        varying vec4 vW0;
        varying vec4 vW1;
        varying vec2 vSplatUv;`)
      .replace('#include <map_fragment>', `
      vec2 vworldSuv = fract(vSplatUv * uRepeat);
      vec3 vworldSplat = vec3(0.0);
      float vworldRough = 0.0;
      float vworldWsum = 0.0;
      ${mixCode}
      diffuseColor.rgb = vworldSplat / max(vworldWsum, 1e-4);`)
      .replace('#include <roughnessmap_fragment>', `
      float roughnessFactor = vworldRough / max(vworldWsum, 1e-4);`);
  };
  mat.customProgramCacheKey = () => 'vworld-splat-v1';
  return mat;
}
