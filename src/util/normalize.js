import * as THREE from 'three';

/**
 * Normalizers — the heart of the "normalize, don't complain" DX law.
 *
 * Every public API accepts every sensible input shape. Instead of
 * complaining about types, we convert:
 *
 *   toVec3(1, 2, 3)            // separate numbers
 *   toVec3([1, 2, 3])          // array
 *   toVec3({ x: 1, y: 2, z: 3 }) // object (y optional, defaults 0)
 *   toVec3(new THREE.Vector3()) // passthrough (cloned)
 *   toVec3(entity)              // uses the entity's world position
 *
 * On unrecognizable input we throw a *helpful* error naming what was
 * received and what was expected — clear errors over silent failures.
 */

export function isEntity(v) {
  return !!v && typeof v === 'object' && !!v.object && v.object.isObject3D && typeof v.at === 'function';
}

function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array[${v.length}]`;
  if (v?.isVector3) return 'Vector3';
  if (isEntity(v)) return `Entity(${v.id ?? '?'})`;
  return typeof v;
}

/**
 * Normalize any position-like input into a fresh THREE.Vector3.
 * Accepts: (x,y,z) | [x,y,z] | {x,y,z} | Vector3 | Entity | Object3D
 */
export function toVec3(...args) {
  // (x, y, z) — allow (x, z) with y defaulting to 0? No: be strict-ish but kind.
  if (args.length >= 3 && args.every((a) => typeof a === 'number')) {
    return new THREE.Vector3(args[0], args[1], args[2]);
  }
  if (args.length === 0 || args[0] === undefined || args[0] === null) {
    throw new Error(
      `[VWorld] toVec3() got ${describe(args[0])} — pass (x,y,z), [x,y,z], {x,y,z}, a Vector3, or an Entity.`
    );
  }
  const v = args[0];
  if (v.isVector3) return v.clone();
  if (Array.isArray(v)) {
    if (v.length < 3 || !v.every((n) => typeof n === 'number')) {
      throw new Error(`[VWorld] toVec3() got array ${JSON.stringify(v)} — need [x, y, z] numbers.`);
    }
    return new THREE.Vector3(v[0], v[1], v[2]);
  }
  if (typeof v === 'object') {
    if (typeof v.x === 'number' && typeof v.z === 'number') {
      return new THREE.Vector3(v.x, typeof v.y === 'number' ? v.y : 0, v.z);
    }
    if (v.isObject3D) {
      const p = new THREE.Vector3();
      v.getWorldPosition(p);
      return p;
    }
    if (isEntity(v)) {
      const p = new THREE.Vector3();
      v.object.getWorldPosition(p);
      return p;
    }
  }
  throw new Error(
    `[VWorld] toVec3() can't read ${describe(v)} — pass (x,y,z), [x,y,z], {x,y,z}, a Vector3, or an Entity.`
  );
}

/**
 * Normalize into { x, y, z } plain object (for Rapier calls).
 */
export function toXYZ(...args) {
  const v = toVec3(...args);
  return { x: v.x, y: v.y, z: v.z };
}

/** Coerce to a finite number with a clear error. */
export function toNumber(v, name = 'value', fallback) {
  if (v === undefined && fallback !== undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`[VWorld] Expected a number for "${name}", got ${describe(v)}.`);
  }
  return n;
}

/**
 * Merge user options over defaults (shallow), ignoring undefined values
 * so `fn({ speed: undefined })` keeps the default — Laravel-style.
 */
export function withDefaults(options = {}, defaults = {}) {
  const out = { ...defaults };
  if (options && typeof options === 'object') {
    for (const [k, v] of Object.entries(options)) {
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}

/**
 * Normalize an axis name: 'x' | 'y' | 'z' (case-insensitive, accepts
 * Vector3-like too, using the dominant component).
 */
export function toAxis(v, name = 'axis') {
  if (typeof v === 'string') {
    const a = v.trim().toLowerCase();
    if (a === 'x' || a === 'y' || a === 'z') return a;
  }
  if (v && typeof v === 'object') {
    const { x = 0, y = 0, z = 0 } = v;
    const m = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
    if (m === 0) throw new Error(`[VWorld] "${name}" vector is zero-length — pick an axis.`);
    return Math.abs(x) === m ? 'x' : Math.abs(y) === m ? 'y' : 'z';
  }
  throw new Error(`[VWorld] "${name}" must be 'x', 'y' or 'z' (got ${describe(v)}).`);
}

export function axisToVec3(axis) {
  const a = toAxis(axis);
  return new THREE.Vector3(a === 'x' ? 1 : 0, a === 'y' ? 1 : 0, a === 'z' ? 1 : 0);
}
