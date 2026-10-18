import * as THREE from 'three';

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

  // --- fluent transforms -----------------------------------------------------
  at(x, y, z) {
    this.object.position.set(x, y, z);
    return this;
  }

  moveBy(x, y, z) {
    this.object.position.x += x;
    this.object.position.y += y;
    this.object.position.z += z;
    return this;
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

  lookAt(x, y, z) {
    this.object.lookAt(x, y, z);
    return this;
  }

  show() { this.object.visible = true; return this; }
  hide() { this.object.visible = false; return this; }

  /** Parent another entity under this one. */
  child(entity) {
    this.object.add(entity.object);
    return this;
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
