import * as THREE from 'three';
import { toVec3, toNumber, withDefaults } from './util/normalize.js';

let _nextId = 1;

function stdMaterial(color) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.05 });
}

/**
 * Entity — a chainable wrapper around a THREE.Object3D.
 *
 *   app.entity().box(2, 1, 2, 0x8844ff).at(0, 0.5, 0).rotateY(0.4);
 *
 * Every method returns `this` so calls chain. Entities created through
 * `app.entity()` are added to the scene automatically and can hook the
 * frame loop with `.onUpdate((dt, entity) => ...)`.
 */
export class Entity {
  constructor(engine = null) {
    this.engine = engine;
    this.id = `entity_${_nextId++}`;
    this.object = new THREE.Group();
    this.object.userData.entity = this;
    this._ticker = null;
    this._tags = new Set();
    this._body = null;            // set by Body.bind()
    this._collideListeners = [];  // { filter, fn }
    this._moveTicker = null;
    this._animator = null;
  }

  // --- tags --------------------------------------------------------------------
  /** Tag this entity: `entity.tag('player')`. Chainable. */
  tag(name) {
    this._tags.add(String(name));
    return this;
  }

  untag(name) {
    this._tags.delete(String(name));
    return this;
  }

  hasTag(name) {
    return this._tags.has(String(name));
  }

  get tags() {
    return [...this._tags];
  }

  // --- shape builders ------------------------------------------------------
  mesh(geometry, material) {
    const m = new THREE.Mesh(geometry, material);
    m.castShadow = true;
    m.receiveShadow = true;
    this.object.add(m);
    return this;
  }

  box(w, h, d, color = 0xffffff) {
    return this.mesh(new THREE.BoxGeometry(w, h, d), stdMaterial(color));
  }

  sphere(r, color = 0xffffff, segments = 24) {
    return this.mesh(new THREE.SphereGeometry(r, segments, Math.max(12, segments / 2)), stdMaterial(color));
  }

  /** Capsule: radius + length of the cylindrical mid-section. */
  capsule(radius, length, color = 0xffffff) {
    return this.mesh(new THREE.CapsuleGeometry(radius, length, 6, 18), stdMaterial(color));
  }

  cylinder(rTop, rBottom, height, color = 0xffffff) {
    return this.mesh(new THREE.CylinderGeometry(rTop, rBottom, height, 24), stdMaterial(color));
  }

  /** Recolor every mesh in this entity. */
  colored(hex) {
    this.object.traverse((o) => {
      if (o.isMesh && o.material && 'color' in o.material) o.material.color.set(hex);
    });
    return this;
  }

  // --- fluent transforms (polymorphic: (x,y,z) | [x,y,z] | {x,y,z} | Vector3 | Entity)
  at(...args) {
    const v = toVec3(...args);
    this.object.position.copy(v);
    return this;
  }

  moveBy(...args) {
    const v = toVec3(...args);
    this.object.position.add(v);
    return this;
  }

  /**
   * Glide toward a destination over time (visual movement, not physics).
   * `dest` accepts any toVec3 shape. Arrival fires onArrive once.
   */
  moveTo(dest, { speed = 3, arrive = 0.15, onArrive } = {}) {
    const target = toVec3(dest);
    const sp = toNumber(speed, 'speed');
    this._stopMove();
    const obj = this.object;
    const tick = (dt) => {
      const d = target.clone().sub(obj.position);
      d.y = 0;
      const dist = d.length();
      if (dist <= arrive) {
        obj.position.copy(target);
        this._stopMove();
        if (typeof onArrive === 'function') {
          try { onArrive(this); } catch (err) { console.error('[VWorld] moveTo onArrive threw:', err); }
        }
        return;
      }
      d.normalize().multiplyScalar(Math.min(sp * dt, dist));
      obj.position.add(d);
    };
    this._moveTicker = tick;
    if (this.engine) this.engine.onUpdate(tick);
    return this;
  }

  /** Cancel an in-flight moveTo. */
  stopMove() {
    this._stopMove();
    return this;
  }

  _stopMove() {
    if (this._moveTicker && this.engine) this.engine.offUpdate(this._moveTicker);
    this._moveTicker = null;
  }

  rotateX(a) { this.object.rotation.x += a; return this; }
  rotateY(a) { this.object.rotation.y += a; return this; }
  rotateZ(a) { this.object.rotation.z += a; return this; }

  rotation(x, y, z) {
    this.object.rotation.set(x, y, z);
    return this;
  }

  scale(s) {
    this.object.scale.setScalar(s);
    return this;
  }

  scaleXYZ(x, y, z) {
    this.object.scale.set(x, y, z);
    return this;
  }

  lookAt(...args) {
    const v = toVec3(...args);
    this.object.lookAt(v);
    return this;
  }

  show() { this.object.visible = true; return this; }
  hide() { this.object.visible = false; return this; }

  /** Parent one entity — or an array of them — under this one. */
  attach(...children) {
    const flat = children.length === 1 && Array.isArray(children[0]) ? children[0] : children;
    for (const c of flat) {
      if (!c || !c.object) throw new Error('[VWorld] attach() needs Entities — got ' + (c === null ? 'null' : typeof c) + '.');
      this.object.add(c.object);
    }
    return this;
  }

  /** Alias kept for v0.1.0 compatibility. */
  child(entity) {
    return this.attach(entity);
  }

  // --- collision + sensor events ---------------------------------------------------
  /**
   * Listen for physics contacts involving this entity's body:
   *   entity.on('collide', (other, started) => ...)
   *   entity.on('collide:player', (other, started) => ...) // filtered by tag
   *   entity.on('enter', (other) => ...)  // sensor volumes only
   *   entity.on('exit', (other) => ...)
   * Requires a physics body bound via app.physics.body()...bind(entity).build().
   */
  on(event, fn) {
    if (typeof fn !== 'function') throw new Error('[VWorld] entity.on(event, fn) — fn must be a function.');
    const [kind, filter] = String(event).split(':');
    if (!['collide', 'enter', 'exit'].includes(kind)) {
      throw new Error(`[VWorld] entity.on() — unknown event "${event}". Try 'collide', 'collide:<tag>', 'enter', 'exit'.`);
    }
    if (!this._body) {
      console.warn('[VWorld] entity.on(\'' + event + '\') has no physics body yet — bind one with app.physics.body()...bind(entity).build() and the listener will arm automatically.');
    }
    this._collideListeners.push({ kind, filter: filter || null, fn });
    if (this._body && this.engine) this.engine.physics._watchBody(this._body);
    return this;
  }

  /** Remove a previously added listener. */
  off(event, fn) {
    const [kind, filter] = String(event).split(':');
    this._collideListeners = this._collideListeners.filter(
      (l) => !(l.kind === kind && (filter || null) === l.filter && l.fn === fn)
    );
    return this;
  }

  /** Dispatch a contact event to matching listeners (called by Physics). */
  _dispatch(kind, otherEntity, started) {
    for (const l of this._collideListeners) {
      if (l.kind !== kind) continue;
      if (l.filter && !(otherEntity && otherEntity.hasTag(l.filter))) continue;
      try {
        if (kind === 'collide') l.fn(otherEntity, started);
        else l.fn(otherEntity);
      } catch (err) { console.error('[VWorld] entity event listener threw:', err); }
    }
  }

  // --- animation (needs the animation plugin) ---------------------------------------
  /** Animator for this entity — requires app.use(AnimationPlugin) first. */
  anim() {
    if (!this.engine || !this.engine.using('animation')) {
      throw new Error('[VWorld] entity.anim() needs the animation plugin — app.use(AnimationPlugin) first.');
    }
    if (!this._animator) this._animator = this.engine.animation.for(this);
    return this._animator;
  }

  /** Run `fn(dt, entity)` every rendered frame. Removed on destroy(). */
  onUpdate(fn) {
    if (this.engine) {
      const wrapped = (dt) => fn(dt, this);
      this._ticker = wrapped;
      this.engine.onUpdate(wrapped);
    }
    return this;
  }

  /** Remove from scene, dispose geometry/materials, unhook tickers. */
  destroy() {
    this._stopMove();
    if (this._ticker && this.engine) this.engine.offUpdate(this._ticker);
    this.object.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => m?.dispose());
      }
    });
    this.object.removeFromParent();
    return this;
  }

  // --- networking seam ---------------------------------------------------------
  /** Plain-data snapshot for replication (used by Net in Phase 2). */
  serialize() {
    const p = this.object.position;
    const q = this.object.quaternion;
    const s = this.object.scale;
    return {
      id: this.id,
      p: [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)],
      q: [+q.x.toFixed(4), +q.y.toFixed(4), +q.z.toFixed(4), +q.w.toFixed(4)],
      s: [+s.x.toFixed(3), +s.y.toFixed(3), +s.z.toFixed(3)],
    };
  }

  /** Apply a snapshot produced by serialize(). */
  applySnapshot(snap) {
    if (snap.p) this.object.position.set(snap.p[0], snap.p[1], snap.p[2]);
    if (snap.q) this.object.quaternion.set(snap.q[0], snap.q[1], snap.q[2], snap.q[3]);
    if (snap.s) this.object.scale.set(snap.s[0], snap.s[1], snap.s[2]);
    return this;
  }
}
