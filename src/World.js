import * as THREE from 'three';

/**
 * World — environment: sky dome, sun + hemisphere lights, fog, ground.
 *
 *   app.world.ground({ size: 200, color: 0x4d7c43 });
 *   app.world.dayNight().speed(120).time(0.3); // full day = 120s, start at morning
 */
export class World {
  constructor(engine) {
    this.engine = engine;
    const scene = engine.scene;

    // --- lights -----------------------------------------------------------
    this.hemi = new THREE.HemisphereLight(0xbdd7ff, 0x3a5f3a, 0.9);
    scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const s = 70;
    this.sun.shadow.camera.left = -s;
    this.sun.shadow.camera.right = s;
    this.sun.shadow.camera.top = s;
    this.sun.shadow.camera.bottom = -s;
    this.sun.shadow.camera.far = 1200;
    this.sun.shadow.bias = -0.0004;
    scene.add(this.sun);
    scene.add(this.sun.target);

    // --- gradient sky dome --------------------------------------------------
    this._skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x3d7bc4) },
        bottomColor: { value: new THREE.Color(0xcfe8f5) },
        offset: { value: 30 },
        exponent: { value: 0.7 },
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPosition = wp.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        uniform float offset;
        uniform float exponent;
        varying vec3 vWorldPosition;
        void main() {
          float h = normalize(vWorldPosition + vec3(0.0, offset, 0.0)).y;
          float t = pow(max(h, 0.0), exponent);
          gl_FragColor = vec4(mix(bottomColor, topColor, t), 1.0);
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1400, 32, 16), this._skyMat);
    scene.add(this.sky);

    scene.fog = new THREE.Fog(0xcfe8f5, 90, 900);
    this._dayNight = null;
  }

  /**
   * Add a static ground plane with a matching physics collider.
   * y=0 is the top surface of the ground.
   */
  ground({ size = 200, color = 0x4d7c43 } = {}) {
    const e = this.engine.entity().box(size, 1, size, color).at(0, -0.5, 0);
    e.object.traverse((o) => { if (o.isMesh) o.castShadow = false; });
    this.engine.physics
      .body().static()
      .cuboid(size, 1, size)
      .at(0, -0.5, 0)
      .friction(0.9)
      .build();
    return e;
  }

  /** Get (or create) the day/night cycle controller. */
  dayNight() {
    if (!this._dayNight) this._dayNight = new DayNightCycle(this);
    return this._dayNight;
  }

  /** Called every frame by the engine. */
  update(dt) {
    if (this._dayNight) this._dayNight.update(dt);
  }
}

// ---------------------------------------------------------------------------
const PALETTES = {
  day: {
    top: new THREE.Color(0x3d7bc4), bottom: new THREE.Color(0xcfe8f5),
    sun: new THREE.Color(0xfff4e0), sunI: 2.4, hemiI: 0.9,
  },
  dusk: {
    top: new THREE.Color(0x2b3a6e), bottom: new THREE.Color(0xff9a56),
    sun: new THREE.Color(0xffb36b), sunI: 1.4, hemiI: 0.5,
  },
  night: {
    top: new THREE.Color(0x04070f), bottom: new THREE.Color(0x0e1c30),
    sun: new THREE.Color(0x8fb4ff), sunI: 0.35, hemiI: 0.18,
  },
};

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

class DayNightCycle {
  constructor(world) {
    this.world = world;
    this.t = 0.3;          // 0..1, fraction of a full day
    this.dayLength = 240;  // seconds per full day
    this.enabled = true;
    this._tmpTop = new THREE.Color();
    this._tmpBottom = new THREE.Color();
    this._tmpSun = new THREE.Color();
    this.apply(0);
  }

  /** Full day/night cycle length in seconds. Chainable. */
  speed(seconds) {
    this.dayLength = Math.max(1, seconds);
    return this;
  }

  /** Set time of day directly, 0..1 (0 = midnight, 0.25 = sunrise, 0.5 = noon). */
  time(t) {
    this.t = ((t % 1) + 1) % 1;
    this.apply(0);
    return this;
  }

  pause() { this.enabled = false; return this; }
  resume() { this.enabled = true; return this; }

  update(dt) {
    if (!this.enabled) return;
    this.t = (this.t + dt / this.dayLength) % 1;
    this.apply(dt);
  }

  apply() {
    const w = this.world;
    const angle = this.t * Math.PI * 2;      // sun orbit
    const elev = Math.sin(angle);            // -1..1, + = daytime

    // Blend night -> dusk -> day by sun elevation.
    const dayF = smoothstep(0.08, 0.4, elev);
    const duskF = Math.max(0, 1 - Math.abs(elev) * 4) * (1 - dayF);

    const { day, dusk, night } = PALETTES;
    this._tmpTop.copy(night.top).lerp(dusk.top, duskF).lerp(day.top, dayF);
    this._tmpBottom.copy(night.bottom).lerp(dusk.bottom, duskF).lerp(day.bottom, dayF);
    this._tmpSun.copy(night.sun).lerp(dusk.sun, duskF).lerp(day.sun, dayF);
    const i = night.sunI + (dusk.sunI - night.sunI) * duskF + (day.sunI - night.sunI) * dayF;
    const hi = night.hemiI + (dusk.hemiI - night.hemiI) * duskF + (day.hemiI - night.hemiI) * dayF;

    w._skyMat.uniforms.topColor.value.copy(this._tmpTop);
    w._skyMat.uniforms.bottomColor.value.copy(this._tmpBottom);
    w.engine.scene.fog.color.copy(this._tmpBottom);

    // Sun orbits; below the horizon at night it becomes dim "moonlight".
    const R = 800;
    w.sun.position.set(Math.cos(angle) * R, Math.max(elev, -0.25) * R, 220);
    w.sun.color.copy(this._tmpSun);
    w.sun.intensity = i;
    w.hemi.intensity = hi;
  }
}
