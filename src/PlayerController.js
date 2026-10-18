import * as THREE from 'three';

/**
 * PlayerController — third-person, physics-driven character.
 *
 * Uses a kinematic position-based Rapier body + Rapier character controller,
 * so the player collides with the world instead of tunneling through it.
 *
 *   const player = new PlayerController(app, { speed: 6 });
 *   player.spawn(0, 3, 8);
 *
 * Controls: WASD / arrows move (camera-relative), Space jumps, Shift runs.
 * Click the canvas and call `app.input.lockPointer()` for mouse-look.
 */
export class PlayerController {
  constructor(engine, options = {}) {
    this.engine = engine;
    this.o = {
      speed: 5.5,
      runSpeed: 9,
      jumpSpeed: 7.5,
      radius: 0.38,
      height: 1.5,      // total capsule height
      eyeHeight: 1.45,  // camera look-at height
      camDist: 6.5,
      ...options,
    };

    // --- visual -----------------------------------------------------------
    this.entity = engine.entity();
    const r = this.o.radius;
    const cylLen = Math.max(0.1, this.o.height - r * 2);
    // Group origin = player's feet (the body teleports it there).
    // Capsule mesh is centered, so lift it by height/2 to sit on the feet.
    this.entity.capsule(r, cylLen, 0x3fa7ff);
    this.entity.object.children.forEach((m) => { m.position.y = this.o.height / 2; });

    // --- physics: kinematic body, collision solved per fixed step ------------
    const halfCyl = cylLen / 2;
    this.body = engine.physics
      .body().kinematicPosition()
      .capsule(halfCyl, r)
      .at(0, 3, 0)
      .friction(0.2)
      .bind(this.entity)
      .build();
    // The collider origin must match the visual: offset it up by height/2.
    // (Rapier capsule is centered, so we translate the collider, not the body.)
    this._recenterCollider();

    this.cc = engine.physics.characterController(0.03);

    // --- state --------------------------------------------------------------
    this.velY = 0;
    this.grounded = false;
    this.yaw = 0;
    this.pitch = 0.32;
    this._camPos = new THREE.Vector3();

    engine.onFixedUpdate((dt) => this._step(dt));
    engine.onUpdate(() => this._camera());
  }

  _recenterCollider() {
    // Move the capsule collider up so its bottom sits at the body origin.
    // Rapier JS: collider.setTranslationWrtParent({x,y,z})
    if (this.body.collider && this.body.collider.setTranslationWrtParent) {
      this.body.collider.setTranslationWrtParent({ x: 0, y: this.o.height / 2, z: 0 });
    }
  }

  /** Place the player in the world. Chainable. */
  spawn(x, y, z) {
    this.body.teleport(x, y, z);
    this.velY = 0;
    return this;
  }

  speed(v) { this.o.speed = v; return this; }
  runSpeed(v) { this.o.runSpeed = v; return this; }
  jumpSpeed(v) { this.o.jumpSpeed = v; return this; }

  _step(dt) {
    const input = this.engine.input;
    const o = this.o;

    // --- camera-relative move direction --------------------------------------
    const f = (input.key('KeyW') || input.key('ArrowUp') ? 1 : 0)
            - (input.key('KeyS') || input.key('ArrowDown') ? 1 : 0);
    const s = (input.key('KeyD') || input.key('ArrowRight') ? 1 : 0)
            - (input.key('KeyA') || input.key('ArrowLeft') ? 1 : 0);
    const running = input.key('ShiftLeft') || input.key('ShiftRight');
    const sp = running ? o.runSpeed : o.speed;

    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let mx = (-sin * f + cos * s);
    let mz = (-cos * f - sin * s);
    const len = Math.hypot(mx, mz);
    if (len > 0.001) { mx = (mx / len) * sp * dt; mz = (mz / len) * sp * dt; }
    else { mx = 0; mz = 0; }

    // --- vertical: gravity + jump ----------------------------------------------
    const g = this.engine.physics.world.gravity.y;
    this.velY += g * dt;
    if (this.velY < -40) this.velY = -40;
    if (this.grounded && input.pressed('Space')) this.velY = o.jumpSpeed;
    const dy = this.velY * dt;

    // --- solve collisions -------------------------------------------------------
    const sol = this.cc.solve(this.body, this.body.collider, mx, dy, mz);
    this.grounded = sol.grounded;
    if (sol.grounded && this.velY < 0) this.velY = 0;

    const p = this.body.translation();
    this.body.setNextTranslation(p.x + sol.x, p.y + sol.y, p.z + sol.z);

    // --- face travel direction ----------------------------------------------------
    if (len > 0.001) {
      const target = Math.atan2(mx, mz);
      const cur = this.entity.object.rotation.y;
      let d = target - cur;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.entity.object.rotation.y = cur + d * Math.min(1, dt * 12);
    }
  }

  _camera() {
    const input = this.engine.input;
    if (input.pointerLocked) {
      this.yaw -= input.pointer.dx * 0.0026;
      this.pitch += input.pointer.dy * 0.0026;
      this.pitch = Math.max(-0.15, Math.min(1.25, this.pitch));
    }
    const p = this.body.translation();
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const d = this.o.camDist;

    this._camPos.set(
      p.x + Math.sin(this.yaw) * cp * d,
      p.y + this.o.eyeHeight + sp * d,
      p.z + Math.cos(this.yaw) * cp * d
    );
    // Don't let the camera sink below the ground plane.
    if (this._camPos.y < 0.4) this._camPos.y = 0.4;

    const cam = this.engine.camera;
    cam.position.lerp(this._camPos, 1 - Math.exp(-14 * (1 / 60)));
    cam.lookAt(p.x, p.y + this.o.eyeHeight, p.z);
  }

  /** Clean up: remove body, controller and entity. */
  destroy() {
    this.cc.free();
    this.body.destroy();
    this.entity.destroy();
  }
}
