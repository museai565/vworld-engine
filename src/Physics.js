import * as THREE from 'three';
import { toVec3, toXYZ, toNumber, toAxis, withDefaults } from './util/normalize.js';

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
    this._eventQueue = null;
    this._watched = new Map();   // colliderHandle -> { body, collider }
    this._vehicles = new Set();
    this._limitsWarned = false;
  }

  /** Called by Engine once WASM is ready. Not part of the public API. */
  _init(RAPIER) {
    this.RAPIER = RAPIER;
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this._eventQueue = new RAPIER.EventQueue(true);
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

  /** Start a fluent joint definition: `physics.joint().hinge(a, b, {...})`. */
  joint() {
    return new JointBuilder(this);
  }

  /**
   * Simple arcade raycast vehicle around a dynamic chassis body.
   *   const car = app.physics.vehicle(chassisBody, { wheels: 4 });
   *   car.throttle(1); car.steer(-0.3);
   * Forward = the body's local +Z. Wheels are logical (raycasts); attach
   * your own visual wheels and spin them with car.wheelSpin if you like.
   */
  vehicle(chassisBody, options = {}) {
    this._assertReady();
    const v = new Vehicle(this, chassisBody, options);
    this._vehicles.add(v);
    return v;
  }

  /**
   * Opt a body's colliders into contact-event reporting and map their
   * handles for dispatch. Called automatically by entity.on('collide'|...).
   */
  _watchBody(body) {
    this._assertReady();
    for (const co of body.colliders) {
      co.setActiveEvents(this.RAPIER.ActiveEvents.COLLISION_EVENTS);
      this._watched.set(co.handle, { body, collider: co });
    }
    return this;
  }

  /** Step the simulation, dispatch contact events, update vehicles. */
  step(dt) {
    if (!this.world) return;
    this.world.timestep = dt;
    this.world.step(this._eventQueue);
    this._drainContactEvents();
    for (const v of this._vehicles) v._update(dt);
    for (const b of this._bodies) b._sync();
    if (this._debugOn) this._refreshDebug();
  }

  _drainContactEvents() {
    if (!this._eventQueue) return;
    this._eventQueue.drainCollisionEvents((h1, h2, started) => {
      const a = this._watched.get(h1);
      const b = this._watched.get(h2);
      if (!a && !b) return;
      const entA = a?.body._entity ?? null;
      const entB = b?.body._entity ?? null;
      const sensorA = a ? a.collider.isSensor() : false;
      const sensorB = b ? b.collider.isSensor() : false;
      if (sensorA || sensorB) {
        // Sensor semantics: enter/exit fire on the sensor's own entity.
        if (sensorA && entA) entA._dispatch(started ? 'enter' : 'exit', entB);
        if (sensorB && entB) entB._dispatch(started ? 'enter' : 'exit', entA);
      } else {
        if (entA) entA._dispatch('collide', entB, started);
        if (entB) entB._dispatch('collide', entA, started);
      }
    });
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
    const b = new Body(this.p, body);
    for (const c of colliders) {
      b.colliders.push(this.p.world.createCollider(c, body));
    }
    b.collider = b.colliders[0] ?? null; // first collider (character controllers)
    if (this._bindTarget) b.bind(this._bindTarget);
    this.p._bodies.add(b);
    return b;
  }
}

// ---------------------------------------------------------------------------
export class Body {
  constructor(physics, rawBody) {
    this.p = physics;
    this.raw = rawBody;
    this.colliders = [];   // all Collider objects
    this.collider = null;  // first collider (used by character controllers)
    this._entity = null;
  }

  bind(entity) {
    this._entity = entity;
    entity._body = this;
    this._sync();
    // Arm any collide/enter/exit listeners registered before bind().
    if (entity._collideListeners.length) this.p._watchBody(this);
    return this;
  }

  /**
   * Contact events without going through the entity:
   *   body.sensor(true).on('enter', (other) => ...)
   *   body.on('collide:enemy', (other, started) => ...)
   */
  on(event, fn) {
    if (!this._entity) {
      throw new Error('[VWorld] body.on() needs a bound entity — .bind(entity) first.');
    }
    return this._entity.on(event, fn);
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

  /** Impulse at a world point (torque included) — vehicles live on this. */
  applyImpulseAtPoint(ix, iy, iz, px, py, pz, wake = true) {
    this.raw.applyImpulseAtPoint({ x: ix, y: iy, z: iz }, { x: px, y: py, z: pz }, wake);
    return this;
  }

  angvel() {
    const w = this.raw.angvel();
    return { x: w.x, y: w.y, z: w.z };
  }

  setAngvel(x, y, z, wake = true) {
    this.raw.setAngvel({ x, y, z }, wake);
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

// ---------------------------------------------------------------------------
/**
 * JointBuilder — connect two bodies with constraints.
 *
 *   const doorJoint = app.physics.joint()
 *     .hinge(doorBody, frameBody, { anchor: [0, 1, 0], axis: 'y' });
 *   app.physics.joint()
 *     .spring(bodyA, bodyB, { stiffness: 60, damping: 6, restLength: 2 });
 *
 * `anchor` is a world-space point (any toVec3 shape) converted into each
 * body's local frame — or pass { a: [...], b: [...] } for explicit locals.
 * NOTE: the bundled Rapier 0.14 compat build doesn't expose joint limits
 * or motors to JS, so `limits` is accepted but warns once and is ignored.
 */
class JointBuilder {
  constructor(physics) {
    this.p = physics;
  }

  _bodies(a, b, what) {
    this.p._assertReady();
    for (const [v, n] of [[a, 'bodyA'], [b, 'bodyB']]) {
      if (!v || !v.raw) throw new Error(`[VWorld] joint.${what}() needs physics Bodies — ${n} isn't one. Build with app.physics.body()...build().`);
    }
    return [a, b];
  }

  _localAnchor(body, worldPoint) {
    // worldPoint -> body-local, using the body's current transform.
    const t = body.raw.translation();
    const r = body.raw.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w).invert();
    const v = new THREE.Vector3(worldPoint.x - t.x, worldPoint.y - t.y, worldPoint.z - t.z);
    v.applyQuaternion(q);
    return { x: v.x, y: v.y, z: v.z };
  }

  _anchors(bodyA, bodyB, anchor) {
    if (anchor && typeof anchor === 'object' && (anchor.a !== undefined || anchor.b !== undefined)) {
      return [toXYZ(anchor.a ?? [0, 0, 0]), toXYZ(anchor.b ?? [0, 0, 0])];
    }
    const w = toXYZ(anchor ?? [0, 0, 0]);
    return [this._localAnchor(bodyA, w), this._localAnchor(bodyB, w)];
  }

  _warnLimits(o) {
    if (o && o.limits !== undefined && !this.p._limitsWarned) {
      this.p._limitsWarned = true;
      console.warn('[VWorld] Joint limits are not supported by the bundled Rapier 0.14 build — the joint is created without limits.');
    }
  }

  /** Revolute (hinge) joint around an axis. */
  hinge(bodyA, bodyB, options = {}) {
    const [a, b] = this._bodies(bodyA, bodyB, 'hinge');
    const o = withDefaults(options, { anchor: [0, 0, 0], axis: 'y' });
    this._warnLimits(o);
    const [a1, a2] = this._anchors(a, b, o.anchor);
    const R = this.p.RAPIER;
    const ax = toAxis(o.axis, 'axis');
    const data = R.JointData.revolute(a1, a2, { x: ax === 'x' ? 1 : 0, y: ax === 'y' ? 1 : 0, z: ax === 'z' ? 1 : 0 });
    return this.p.world.createImpulseJoint(data, a.raw, b.raw, true);
  }

  /** Spring-damper joint pulling toward restLength. */
  spring(bodyA, bodyB, options = {}) {
    const [a, b] = this._bodies(bodyA, bodyB, 'spring');
    const o = withDefaults(options, { anchor: [0, 0, 0], stiffness: 50, damping: 5, restLength: 1 });
    const [a1, a2] = this._anchors(a, b, o.anchor);
    const data = this.p.RAPIER.JointData.spring(
      toNumber(o.stiffness, 'stiffness'), toNumber(o.damping, 'damping'),
      toNumber(o.restLength, 'restLength'), a1, a2
    );
    return this.p.world.createImpulseJoint(data, a.raw, b.raw, true);
  }

  /** Rigid weld — bodies move as one. */
  fixed(bodyA, bodyB, options = {}) {
    const [a, b] = this._bodies(bodyA, bodyB, 'fixed');
    const o = withDefaults(options, { anchor: [0, 0, 0] });
    const [a1, a2] = this._anchors(a, b, o.anchor);
    const R = this.p.RAPIER;
    const data = R.JointData.fixed(a1, { x: 0, y: 0, z: 0, w: 1 }, a2, { x: 0, y: 0, z: 0, w: 1 });
    return this.p.world.createImpulseJoint(data, a.raw, b.raw, true);
  }

  /** Ball-and-socket joint. */
  ball(bodyA, bodyB, options = {}) {
    const [a, b] = this._bodies(bodyA, bodyB, 'ball');
    const o = withDefaults(options, { anchor: [0, 0, 0] });
    const [a1, a2] = this._anchors(a, b, o.anchor);
    const data = this.p.RAPIER.JointData.spherical(a1, a2);
    return this.p.world.createImpulseJoint(data, a.raw, b.raw, true);
  }
}

// ---------------------------------------------------------------------------
const _wq = new THREE.Quaternion();
const _wv = new THREE.Vector3();

/**
 * Vehicle — simple arcade raycast car around a dynamic chassis body.
 * Forward = the body's local +Z. Honest scope: arcade handling, no tire
 * friction model — but it drives, steers, and doesn't flip over easily.
 */
class Vehicle {
  constructor(physics, chassisBody, options = {}) {
    const o = withDefaults(options, {
      wheels: 4,            // 4 | [{ offset:[x,y,z], radius, steer }]
      track: 1.7,           // width between left/right wheels
      wheelbase: 2.8,       // length between front/rear axles
      wheelRadius: 0.38,
      suspensionRest: 0.55,
      suspensionStiffness: 42,
      suspensionDamping: 5,
      power: 34,            // throttle force per driven wheel
      maxSteer: 0.55,       // radians at full lock
      downforce: 6,
    });
    this.p = physics;
    this.body = chassisBody;
    this.o = o;
    this.throttleValue = 0;
    this.steerValue = 0;
    this.wheelSpin = 0;

    if (Array.isArray(o.wheels)) {
      this.wheels = o.wheels.map((w) => ({
        offset: toVec3(w.offset ?? [0, 0, 0]),
        radius: toNumber(w.radius ?? o.wheelRadius, 'wheel radius'),
        steer: !!w.steer,
      }));
    } else {
      const n = Math.max(2, Math.round(toNumber(o.wheels, 'wheels')));
      // 4 wheels at the corners; N wheels spread along the sides.
      this.wheels = [];
      const rows = Math.max(1, Math.round(n / 2));
      for (let i = 0; i < rows; i++) {
        const z = rows === 1 ? 0 : -o.wheelbase / 2 + (o.wheelbase * i) / (rows - 1);
        for (const x of [-o.track / 2, o.track / 2]) {
          this.wheels.push({ offset: new THREE.Vector3(x, 0, z), radius: o.wheelRadius, steer: z > 0 });
        }
      }
    }
    this._ray = { x: 0, y: -1, z: 0 };
  }

  /** -1..1 (reverse..forward). Chainable. */
  throttle(v) { this.throttleValue = Math.max(-1, Math.min(1, toNumber(v, 'throttle'))); return this; }
  /** -1..1 (left..right). Chainable. */
  steer(v) { this.steerValue = Math.max(-1, Math.min(1, toNumber(v, 'steer'))); return this; }
  stop() { this.throttleValue = 0; this.steerValue = 0; return this; }

  destroy() {
    this.p._vehicles.delete(this);
    return this;
  }

  _update(dt) {
    const o = this.o;
    const raw = this.body.raw;
    const t = raw.translation();
    const r = raw.rotation();
    _wq.set(r.x, r.y, r.z, r.w);

    const linvel = raw.linvel();
    for (const wheel of this.wheels) {
      // Steering rotates front-wheel offsets around Y.
      _wv.copy(wheel.offset);
      if (wheel.steer && this.steerValue !== 0) {
        const a = this.steerValue * o.maxSteer;
        const x = _wv.x * Math.cos(a) - _wv.z * Math.sin(a);
        const z = _wv.x * Math.sin(a) + _wv.z * Math.cos(a);
        _wv.x = x; _wv.z = z;
      }
      _wv.applyQuaternion(_wq);
      const wx = t.x + _wv.x, wy = t.y + _wv.y, wz = t.z + _wv.z;

      const rayLen = o.suspensionRest + wheel.radius + 0.15;
      const hit = this.p.world.castRay(
        { x: wx, y: wy + 0.1, z: wz }, this._ray, rayLen, true
      );
      if (!hit) continue;
      const dist = hit.time_of_impact;
      const compression = 1 - Math.max(0, (dist - 0.1 - wheel.radius)) / o.suspensionRest;
      if (compression <= 0) continue;

      // Spring + damper along world Y.
      const springF = compression * o.suspensionStiffness * o.suspensionRest;
      const dampF = -linvel.y * o.suspensionDamping * compression;
      const fy = Math.max(0, springF + dampF);
      this.body.applyImpulseAtPoint(0, fy * dt, 0, wx, wy, wz);

      // Drive: forward force at the contact patch (AWD, arcade).
      if (this.throttleValue !== 0) {
        const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(_wq);
        const f = o.power * this.throttleValue * dt * compression;
        this.body.applyImpulseAtPoint(fwd.x * f, 0, fwd.z * f, wx, wy - wheel.radius, wz);
        this.wheelSpin += this.throttleValue * dt * 8;
      }
    }

    // Stability: gentle downforce + angular damping so it stays planted.
    this.body.applyImpulse(0, -o.downforce * dt, 0);
    const av = raw.angvel();
    const damp = Math.max(0, 1 - 3.5 * dt);
    raw.setAngvel({ x: av.x * damp, y: av.y * damp, z: av.z * damp }, false);
  }
}
