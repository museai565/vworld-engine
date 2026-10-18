import * as THREE from 'three';
import { toVec3, toNumber, withDefaults } from './util/normalize.js';
import { vError } from './util/errors.js';

/**
 * Prefab library (v0.8.0) — named, variant-bearing props built from engine
 * primitives + material presets. Prefab-built entities record their name and
 * variant, so `world.save()` / `world.load()` round-trips them exactly.
 *
 *   world.prefab('pineTree');                       // Entity, placed at origin
 *   world.prefab('rock', 2);                        // variant as a number
 *   world.prefab('lantern', { variant: 1, at: [4, 0, -2], rotateY: 0.5 });
 *   world.prefab({ name: 'crate', variant: 0, at: [0, 0, 5] });
 *   world.prefabNames();                            // ['barrel', 'bed', ...]
 *   world.registerPrefab('statue', { category: 'decor', variants: 1,
 *     build: (world, entity, variant) => { ... } });
 *
 * Pure parts (definition lookup, variant selection, name listing) are
 * DOM/THREE-scene-free and unit-tested in test/smoke.mjs. Only the builders
 * touch the scene graph.
 */

// ---------------------------------------------------------------------------
// builder helpers
// ---------------------------------------------------------------------------

/** Add a positioned, shadow-casting mesh to an entity's group. */
function part(entity, geometry, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  entity.object.add(m);
  return m;
}

const rnd2 = (a, b) => a + Math.random() * (b - a);

// ---------------------------------------------------------------------------
// built-in definitions: name -> { category, variants, build(world, entity, v) }
// ---------------------------------------------------------------------------

const DEFS = {
  // --- vegetation -----------------------------------------------------------
  pineTree: {
    category: 'vegetation', variants: 3,
    build(w, e, v) {
      const mat = (p, o) => w.engine.material(p, o);
      const trunkH = [2.4, 1.4, 2.6][v];
      const crown = [0x2e6b34, 0x3a7d40, 0x86a98f][v];
      part(e, new THREE.CylinderGeometry(0.14, 0.22, trunkH, 8), mat('wood'), 0, trunkH / 2, 0);
      const tiers = v === 1 ? 2 : 3;
      for (let i = 0; i < tiers; i++) {
        const r = (v === 1 ? 1.8 : 1.35) - i * 0.32;
        part(e, new THREE.ConeGeometry(r, 1.7, 8), mat('grass', { color: crown }), 0, trunkH + 0.55 + i * 0.95, 0);
      }
    },
  },
  oakTree: {
    category: 'vegetation', variants: 2,
    build(w, e, v) {
      const mat = (p, o) => w.engine.material(p, o);
      const crown = [0x3f7a3a, 0xc77b2e][v]; // summer / autumn
      part(e, new THREE.CylinderGeometry(0.18, 0.28, 2.2, 8), mat('wood'), 0, 1.1, 0);
      part(e, new THREE.IcosahedronGeometry(1.5, 1), mat('grass', { color: crown, flatShading: true }), 0, 3.1, 0);
      part(e, new THREE.IcosahedronGeometry(1.0, 1), mat('grass', { color: crown, flatShading: true }), 1.1, 2.5, 0.4);
      part(e, new THREE.IcosahedronGeometry(0.9, 1), mat('grass', { color: crown, flatShading: true }), -1.0, 2.6, -0.3);
    },
  },
  bush: {
    category: 'vegetation', variants: 2,
    build(w, e, v) {
      const mat = (p, o) => w.engine.material(p, o);
      if (v === 0) {
        const s = part(e, new THREE.SphereGeometry(0.8, 12, 10), mat('grass', { color: 0x3d7a37 }));
        s.scale.y = 0.75;
        s.position.y = 0.5;
      } else {
        part(e, new THREE.SphereGeometry(0.6, 12, 10), mat('grass', { color: 0x468a3e }), 0, 0.9, 0);
        const s = part(e, new THREE.SphereGeometry(0.75, 12, 10), mat('grass', { color: 0x3d7a37 }), 0, 0.45, 0);
        s.scale.y = 0.8;
      }
    },
  },
  grassTuft: {
    category: 'vegetation', variants: 2,
    build(w, e, v) {
      const mat = (p, o) => w.engine.material(p, o);
      const color = v === 0 ? 0x58a34c : 0xb8a05a; // green / dry
      for (let i = 0; i < 5; i++) {
        const blade = part(
          e, new THREE.ConeGeometry(0.09, rnd2(0.4, 0.8), 5),
          mat('grass', { color }), rnd2(-0.25, 0.25), 0.3, rnd2(-0.25, 0.25)
        );
        blade.rotation.z = rnd2(-0.2, 0.2);
      }
    },
  },

  // --- rocks ------------------------------------------------------------------
  rock: {
    category: 'rock', variants: 3,
    build(w, e, v) {
      const mat = (p, o) => w.engine.material(p, o);
      const r = [0.5, 1.1, 1.3][v];
      const m = part(e, new THREE.DodecahedronGeometry(r, 0), mat('stone', { flatShading: true }), 0, r * 0.55, 0);
      if (v === 2) m.scale.y = 0.45; // flat slab
      m.rotation.set(rnd2(0, 3), rnd2(0, 3), rnd2(0, 3));
    },
  },
  boulder: {
    category: 'rock', variants: 1,
    build(w, e) {
      const mat = (p, o) => w.engine.material(p, o);
      const m = part(e, new THREE.DodecahedronGeometry(2.2, 1), mat('stone', { flatShading: true }), 0, 1.4, 0);
      m.rotation.set(0.4, 1.2, 0.2);
      m.scale.set(1.2, 0.9, 1);
    },
  },

  // --- building parts -----------------------------------------------------------
  wall: {
    category: 'building', variants: 2,
    build(w, e, v) {
      const mat = (p, o) => w.engine.material(p, o);
      part(e, new THREE.BoxGeometry(4, 2.6, 0.3), mat('stone'), 0, 1.3, 0);
      part(e, new THREE.BoxGeometry(4.3, 0.25, 0.5), mat('wood'), 0, 2.7, 0); // cap
      if (v === 1) {
        part(e, new THREE.BoxGeometry(1.1, 1.1, 0.34), mat('glass', { color: 0x9fc8e8 }), 0, 1.5, 0); // window
        part(e, new THREE.BoxGeometry(1.3, 0.12, 0.36), mat('wood'), 0, 1.5, 0);  // sill bars
        part(e, new THREE.BoxGeometry(0.12, 1.3, 0.36), mat('wood'), 0, 1.5, 0);
      }
    },
  },
  door: {
    category: 'building', variants: 2,
    build(w, e, v) {
      const mat = (p, o) => w.engine.material(p, o);
      part(e, new THREE.BoxGeometry(0.18, 2.4, 0.24), mat('wood'), -0.65, 1.2, 0);
      part(e, new THREE.BoxGeometry(0.18, 2.4, 0.24), mat('wood'), 0.65, 1.2, 0);
      part(e, new THREE.BoxGeometry(1.5, 0.18, 0.24), mat('wood'), 0, 2.42, 0);
      const panel = part(e, new THREE.BoxGeometry(1.12, 2.24, 0.1), mat('wood', { color: 0x7a5230 }), -0.56, 1.12, 0);
      if (v === 1) { panel.position.x = -0.05; panel.rotation.y = 1.1; } // ajar
      else panel.position.x = 0;
      part(e, new THREE.SphereGeometry(0.06, 10, 8), mat('metal'), v === 1 ? 0.35 : 0.4, 1.1, 0.08); // knob
    },
  },
  floor: {
    category: 'building', variants: 1,
    build(w, e) {
      const mat = (p, o) => w.engine.material(p, o);
      part(e, new THREE.BoxGeometry(4, 0.2, 4), mat('wood'), 0, 0.1, 0);
    },
  },
  pillar: {
    category: 'building', variants: 2,
    build(w, e, v) {
      const mat = (p, o) => w.engine.material(p, o);
      if (v === 0) part(e, new THREE.CylinderGeometry(0.3, 0.36, 3, 12), mat('stone'), 0, 1.5, 0);
      else part(e, new THREE.BoxGeometry(0.6, 3, 0.6), mat('stone'), 0, 1.5, 0);
      part(e, new THREE.BoxGeometry(0.9, 0.25, 0.9), mat('stone'), 0, 3.1, 0); // capital
      part(e, new THREE.BoxGeometry(0.9, 0.25, 0.9), mat('stone'), 0, 0.12, 0); // base
    },
  },
  fence: {
    category: 'building', variants: 2,
    build(w, e, v) {
      const mat = (p, o) => w.engine.material(p, o);
      const post = v === 0 ? 'wood' : 'metal';
      const rail = v === 0 ? 'wood' : 'metal';
      for (const x of [-1.5, 0, 1.5]) {
        part(e, new THREE.BoxGeometry(0.14, 1.1, 0.14), mat(post), x, 0.55, 0);
      }
      part(e, new THREE.BoxGeometry(3.3, 0.1, 0.08), mat(rail), 0, 0.85, 0);
      part(e, new THREE.BoxGeometry(3.3, 0.1, 0.08), mat(rail), 0, 0.45, 0);
    },
  },

  // --- furniture ------------------------------------------------------------------
  table: {
    category: 'furniture', variants: 1,
    build(w, e) {
      const mat = (p, o) => w.engine.material(p, o);
      part(e, new THREE.BoxGeometry(1.7, 0.1, 1.0), mat('wood'), 0, 0.75, 0);
      for (const x of [-0.75, 0.75]) for (const z of [-0.4, 0.4]) {
        part(e, new THREE.BoxGeometry(0.1, 0.7, 0.1), mat('wood'), x, 0.35, z);
      }
    },
  },
  chair: {
    category: 'furniture', variants: 2,
    build(w, e, v) {
      const mat = (p, o) => w.engine.material(p, o);
      part(e, new THREE.BoxGeometry(0.55, 0.08, 0.55), mat('wood'), 0, 0.45, 0);
      part(e, new THREE.BoxGeometry(0.55, 0.7, 0.08), mat('wood'), 0, 0.85, -0.26);
      for (const x of [-0.22, 0.22]) for (const z of [-0.22, 0.22]) {
        part(e, new THREE.BoxGeometry(0.07, 0.45, 0.07), mat('wood'), x, 0.22, z);
      }
      if (v === 1) part(e, new THREE.BoxGeometry(0.5, 0.08, 0.5), mat('plastic', { color: 0xa33327 }), 0, 0.53, 0); // cushion
    },
  },
  bed: {
    category: 'furniture', variants: 1,
    build(w, e) {
      const mat = (p, o) => w.engine.material(p, o);
      part(e, new THREE.BoxGeometry(1.3, 0.35, 2.3), mat('wood'), 0, 0.28, 0);
      part(e, new THREE.BoxGeometry(1.2, 0.22, 2.1), mat('paper', { color: 0xe8e0d0 }), 0, 0.55, 0); // mattress
      part(e, new THREE.BoxGeometry(0.9, 0.16, 0.5), mat('paper', { color: 0xf5f2ea }), 0, 0.72, -0.7); // pillow
      part(e, new THREE.BoxGeometry(1.3, 0.9, 0.1), mat('wood'), 0, 0.7, -1.15); // headboard
    },
  },
  crate: {
    category: 'furniture', variants: 2,
    build(w, e, v) {
      const mat = (p, o) => w.engine.material(p, o);
      const s = v === 0 ? 0.8 : 1.4;
      part(e, new THREE.BoxGeometry(s, s, s), mat('wood'), 0, s / 2, 0);
      const t = s * 0.52; // edge trim
      for (const y of [0.06 * s, 0.94 * s]) {
        part(e, new THREE.BoxGeometry(s * 1.04, 0.08 * s, s * 1.04), mat('wood', { color: 0x5e4023 }), 0, y, 0);
      }
      void t;
    },
  },
  barrel: {
    category: 'furniture', variants: 1,
    build(w, e) {
      const mat = (p, o) => w.engine.material(p, o);
      part(e, new THREE.CylinderGeometry(0.42, 0.38, 1.1, 14), mat('wood'), 0, 0.55, 0);
      for (const y of [0.25, 0.85]) {
        const band = part(e, new THREE.TorusGeometry(0.415, 0.03, 8, 20), mat('metal'), 0, y, 0);
        band.rotation.x = Math.PI / 2;
      }
    },
  },
  lantern: {
    category: 'furniture', variants: 2,
    build(w, e, v) {
      const mat = (p, o) => w.engine.material(p, o);
      part(e, new THREE.CylinderGeometry(0.06, 0.09, 1.6, 8), mat('metal'), 0, 0.8, 0);
      part(e, new THREE.BoxGeometry(0.34, 0.4, 0.34), mat('glass', { color: 0xffe6a3, opacity: 0.85 }), 0, 1.75, 0);
      part(e, new THREE.ConeGeometry(0.28, 0.2, 4), mat('metal'), 0, 2.02, 0);
      part(
        e, new THREE.SphereGeometry(0.09, 10, 8),
        mat('emissive', { color: 0xffc46b, emissiveIntensity: v === 0 ? 2.2 : 0.0 }),
        0, 1.75, 0
      );
    },
  },
};

// Custom prefabs registered at runtime (world.registerPrefab).
const _customs = new Map();

// ---------------------------------------------------------------------------
// pure API — no scene graph, unit-testable
// ---------------------------------------------------------------------------

/** All prefab names (built-ins + registered customs), sorted. */
export function prefabNames() {
  return [...new Set([...Object.keys(DEFS), ..._customs.keys()])].sort();
}

/** Prefab categories in use. */
export function prefabCategories() {
  const cats = new Set(Object.values(DEFS).map((d) => d.category));
  for (const d of _customs.values()) cats.add(d.category ?? 'custom');
  return [...cats];
}

/**
 * Look up a prefab definition. Throws VWORLD/UNKNOWN_PREFAB with the full
 * name list when the name is unknown.
 */
export function getPrefabDef(name) {
  const n = String(name);
  const def = _customs.get(n) ?? DEFS[n];
  if (!def) {
    throw vError(
      'VWORLD/UNKNOWN_PREFAB',
      `[VWorld] Unknown prefab "${n}". Try: ${prefabNames().join(', ')} — or register one with world.registerPrefab().`
    );
  }
  return def;
}

/** How many variants a prefab has. */
export function prefabVariantCount(name) {
  return getPrefabDef(name).variants ?? 1;
}

/**
 * Normalize a variant selector to a valid index (pure).
 * Accepts any number (floored, wrapped), defaults to 0.
 */
export function selectVariant(name, variant = 0) {
  const count = Math.max(1, prefabVariantCount(name));
  const v = Math.floor(toNumber(variant, 'variant', 0));
  return ((v % count) + count) % count;
}

/**
 * Register (or override) a prefab definition.
 *   { category: 'decor', variants: 2, build: (world, entity, variant) => {...} }
 */
export function registerPrefabDef(name, def = {}) {
  const n = String(name);
  if (!def || typeof def.build !== 'function') {
    throw vError('VWORLD/BAD_PREFAB', `[VWorld] registerPrefab("${n}") needs { build(world, entity, variant) }.`);
  }
  _customs.set(n, {
    category: def.category ?? 'custom',
    variants: Math.max(1, Math.floor(toNumber(def.variants ?? 1, 'variants'))),
    build: def.build,
  });
  return n;
}

// ---------------------------------------------------------------------------
// engine wiring
// ---------------------------------------------------------------------------

/**
 * Normalize the polymorphic prefab call:
 *   'rock' | 'rock', 2 | 'rock', { variant, at, rotateY, scale, props }
 *   | { name: 'rock', variant: 2, at: [...] }
 * Returns { name, variant, at, rotateY, scale, props }.
 */
export function normalizePrefabCall(name, opts) {
  let n = name, o = opts;
  if (n && typeof n === 'object') {
    o = n;
    n = o.name ?? o.prefab;
  }
  if (typeof n !== 'string' || n.length === 0) {
    throw vError('VWORLD/BAD_PREFAB', '[VWorld] world.prefab() needs a name — world.prefab("pineTree").');
  }
  if (typeof o === 'number') o = { variant: o };
  const c = withDefaults(o ?? {}, { variant: 0, at: null, rotateY: 0, scale: null, props: null });
  return {
    name: n,
    variant: c.variant,
    at: c.at,
    rotateY: toNumber(c.rotateY, 'rotateY', 0),
    scale: c.scale,
    props: c.props,
  };
}

/**
 * Build a prefab into a live, tagged entity. The entity records
 * `_prefab = { name, variant }` so world.save() round-trips it.
 */
export function buildPrefab(world, name, opts) {
  const { name: n, variant, at, rotateY, scale, props } = normalizePrefabCall(name, opts);
  const def = getPrefabDef(n); // throws helpful VWORLD/UNKNOWN_PREFAB
  const v = selectVariant(n, variant);
  const e = world.engine.entity();
  e.tag('prefab').tag(`prefab:${n}`);
  e._prefab = { name: n, variant: v };
  def.build(world, e, v);
  if (at !== null && at !== undefined) e.at(at);
  if (rotateY) e.rotateY(rotateY);
  if (scale !== null && scale !== undefined) {
    if (typeof scale === 'number') e.scale(scale);
    else { const s = toVec3(scale); e.scaleXYZ(s.x, s.y, s.z); }
  }
  if (props) e.saveProps(props);
  return e;
}
