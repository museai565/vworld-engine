import * as THREE from 'three';

/**
 * Physics — Rapier (WASM) wrapped in a Laravel-flavored fluent API.
 *
 *   app.physics.gravity(0, -9.81, 0);
 *
 *   const e = app.entity().box(1, 1, 1, 0xff5a5a).at(0, 5, 0);
 *   app.physics.body()
 *     .dynamic()                 // or .static() / .kinematicPosition()
 *     .cuboid(1, 1, 1)           // FULL extents: a 1m cube (halved internally)
 *     .at(0, 5, 0)
 *     .friction(0.5)
 *     .restitution(0.2)
 *     .bind(e)                   // sync the visual entity every step
 *     .build();
 *
 * Sizes in builder methods are full extents (what you'd measure with a
 * ruler), unlike raw Rapier which wants half-extents.
 */
export class Physics {
  constructor(engine) {
    this.engine = engine;
    this.RAPIER = null;
    this.world = null;
    this._bodies = new Set();
    this._debugLines = null;
    this._debugOn = false;
  }

  /** Called by Engine once WASM is ready. Not part of the public API. */
  _init(RAPIER) {
    this.RAPIER = RAPIER;
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  }

  _assertReady() {
    if (!this.world) {
      throw new Error('[VWorld] Physics used before WASM init — `await app.ready` before creating bodies.');
    }
  }

  // --- world settings --------------------------------------------------------
  gravity(x, y, z = 0) {
    this._assertReady();
    this.world.gravity.x = x;
    this.world.gravity.y = y;
    this.world.gravity.z = z;
    return this;
  }

  /** Start a fluent rigid-body definition. */
  body() {
    return new BodyBuilder(this);
  }

  /** Step the simulation and sync bound entities. Called by the engine loop. */
  step(dt) {
    if (!this.world) return;
    this.world.timestep = dt;
    this.world.step();
    for (const b of this._bodies) b._sync();
    if (this._debugOn) this._refreshDebug();
  }

  /**
   * Toggle collider wireframe overlay. `physics.debug()` with no argument
   * toggles; `physics.debug(true/false)` sets explicitly.
   */
  debug(show) {
    this._assertReady();
    if (show === undefined) show = !this._debugOn;
    this._debugOn = show;
    if (show && !this._debugLines) {
      const geo = new THREE.BufferGeometry();
      this._debugLines = new THREE.LineSegments(
        geo,
        new THREE.LineBasicMaterial({ vertexColors: true })
      );
      this._debugLines.frustumCulled = false;
      this.engine.scene.add(this._debugLines);
    }
    if (this._debugLines) this._debugLines.visible = show;
    return this;
  }

  get debugVisible() {
    return this._debugOn;
  }

  _refreshDebug() {
    const { vertices, colors } = this.world.debugRender();
    const geo = this._debugLines.geometry;
    geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }

  /**
   * Create a Rapier character controller for kinematic player movement.
   * Returns { solve(body, collider, dx, dy, dz) -> {x,y,z,grounded}, free() }.
   */
  characterController(offset = 0.02) {
    this._assertReady();
    const controller = this.world.createCharacterController(offset);
    const world = this.world;
    return {
      raw: controller,
      solve(_body, collider, dx, dy, dz) {
        controller.computeColliderMovement(collider, { x: dx, y: dy, z: dz });
        const m = controller.computedMovement();
        return { x: m.x, y: m.y, z: m.z, grounded: controller.computedGrounded() };
      },
      free() {
        world.removeCharacterController(controller);
      },
    };
  }
}

// ---------------------------------------------------------------------------
class BodyBuilder {
  constructor(physics) {
    this.p = physics;
    this._desc = null;
    this._colliders = [];
    this._at = [0, 0, 0];
    this._friction = 0.5;
    this._restitution = 0.0;
    this._density = null;
    this._sensor = false;
    this._bindTarget = null;
  }

  _ensureDesc() {
    if (!this._desc) this.dynamic();
    return this._desc;
  }

  // --- body type -------------------------------------------------------------
  dynamic() {
    this.p._assertReady();
    this._desc = this.p.RAPIER.RigidBodyDesc.dynamic().setTranslation(...this._at);
    return this;
  }

  static() {
    this.p._assertReady();
    this._desc = this.p.RAPIER.RigidBodyDesc.fixed().setTranslation(...this._at);
    return this;
  }

  kinematicPosition() {
    this.p._assertReady();
    this._desc = this.p.RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(...this._at);
    return this;
  }

  at(x, y, z) {
    this._at = [x, y, z];
    if (this._desc) this._desc.setTranslation(x, y, z);
    return this;
  }

  // --- collider shapes (FULL extents — ruler measurements) ---------------------
  _push(desc) {
    desc.setFriction(this._friction).setRestitution(this._restitution);
    if (this._density !== null) desc.setDensity(this._density);
    if (this._sensor) desc.setSensor(true);
    this._colliders.push(desc);
    return this;
  }

  /** Box collider, full width/height/depth in meters. */
  cuboid(w, h, d) {
    this.p._assertReady();
    return this._push(this.p.RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2));
  }

  ball(radius) {
    this.p._assertReady();
    return this._push(this.p.RAPIER.ColliderDesc.ball(radius));
  }

  /** Capsule: halfHeight = half the cylindrical section, radius as given. */
  capsule(halfHeight, radius) {
    this.p._assertReady();
    return this._push(this.p.RAPIER.ColliderDesc.capsule(halfHeight, radius));
  }

  // --- surface properties ------------------------------------------------------
  friction(f) { this._friction = f; return this; }
  restitution(e) { this._restitution = e; return this; }
  density(d) { this._density = d; return this; }
  sensor(v = true) { this._sensor = v; return this; }

  /** Sync an Entity's transform from this body after every step. */
  bind(entity) {
    this._bindTarget = entity;
    return this;
  }

  build() {
    this.p._assertReady();
    this._ensureDesc();
    const body = this.p.world.createRigidBody(this._desc);
    const colliders = this._colliders.length
      ? this._colliders
      : [this.p.RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5)]; // sensible default: 1m cube
    let first = null;
    for (const c of colliders) {
      const handle = this.p.world.createCollider(c, body);
      if (!first) first = handle;
    }
    const b = new Body(this.p, body, first);
    if (this._bindTarget) b.bind(this._bindTarget);
    this.p._bodies.add(b);
    return b;
  }
}

// ---------------------------------------------------------------------------
export class Body {
  constructor(physics, rawBody, collider) {
    this.p = physics;
    this.raw = rawBody;
    this.collider = collider; // first collider (used by character controllers)
    this._entity = null;
  }

  bind(entity) {
    this._entity = entity;
    this._sync();
    return this;
  }

  /** Copy body transform onto the bound entity. Called by Physics.step(). */
  _sync() {
    if (!this._entity) return;
    const t = this.raw.translation();
    const r = this.raw.rotation();
    this._entity.object.position.set(t.x, t.y, t.z);
    this._entity.object.quaternion.set(r.x, r.y, r.z, r.w);
  }

  translation() {
    const t = this.raw.translation();
    return { x: t.x, y: t.y, z: t.z };
  }

  rotation() {
    const r = this.raw.rotation();
    return { x: r.x, y: r.y, z: r.z, w: r.w };
  }

  /** Teleport: set position immediately (all body types). */
  teleport(x, y, z) {
    this.raw.setTranslation({ x, y, z }, true);
    this._sync();
    return this;
  }

  /** Next-frame position for kinematic bodies (use in fixed update). */
  setNextTranslation(x, y, z) {
    this.raw.setNextKinematicTranslation({ x, y, z });
    return this;
  }

  applyImpulse(x, y, z, wake = true) {
    this.raw.applyImpulse({ x, y, z }, wake);
    return this;
  }

  linvel() {
    const v = this.raw.linvel();
    return { x: v.x, y: v.y, z: v.z };
  }

  setLinvel(x, y, z, wake = true) {
    this.raw.setLinvel({ x, y, z }, wake);
    return this;
  }

  setEnabled(enabled) {
    this.raw.setEnabled(enabled);
    return this;
  }

  destroy() {
    this.p._bodies.delete(this);
    this.p.world.removeRigidBody(this.raw);
    return this;
  }
}
