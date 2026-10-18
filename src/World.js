import * as THREE from 'three';
import { toVec3, toNumber, withDefaults } from './util/normalize.js';

/**
 * World — environment: sky dome, sun + hemisphere lights, fog, ground.
 *
 *   app.world.ground({ size: 200, color: 0x4d7c43 });
 *   app.world.dayNight().speed(120).time(0.3); // full day = 120s, start at morning
 *   app.world.terrain({ size: 400, resolution: 96, height: (x, z) => Math.sin(x * 0.05) * 6 });
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

    // --- grand-engine additions ------------------------------------------------
    this._postChain = null;      // set by the post plugin
    this._terrain = null;        // { size, resolution, height, mesh }
    this._water = null;          // { mesh, level, mat }
    this._waterLevel = -Infinity;
    this._kinds = new Map();     // scatterable prop factories
    this._biomes = [];
    this._registerBuiltinKinds();
  }

  // --- scatterable prop kinds ----------------------------------------------------
  _registerBuiltinKinds() {
    const rnd = (a, b) => a + Math.random() * (b - a);
    const std = (color, extra = {}) =>
      new THREE.MeshStandardMaterial({ color, roughness: 0.9, ...extra });
    this._kinds.set('pine-tree', () => {
      const e = this.engine.entity();
      const trunkH = rnd(1.6, 2.6);
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, trunkH, 8), std(0x6b4a2f));
      trunk.position.y = trunkH / 2;
      trunk.castShadow = true;
      const crown = new THREE.Mesh(
        new THREE.ConeGeometry(rnd(1.1, 1.6), rnd(2.2, 3.4), 8), std(0x2e6b34)
      );
      crown.position.y = trunkH + 1.1;
      crown.castShadow = true;
      e.object.add(trunk, crown);
      return e;
    });
    this._kinds.set('rock', () => {
      const s = rnd(0.4, 1.6);
      const e = this.engine.entity();
      const m = new THREE.Mesh(
        new THREE.DodecahedronGeometry(s, 0),
        new THREE.MeshStandardMaterial({ color: 0x8d8d94, roughness: 0.95, flatShading: true })
      );
      m.castShadow = m.receiveShadow = true;
      m.position.y = s * 0.55;
      m.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      e.object.add(m);
      return e;
    });
    this._kinds.set('grass', () => {
      const e = this.engine.entity();
      const m = new THREE.Mesh(
        new THREE.ConeGeometry(0.16, rnd(0.5, 0.9), 5),
        new THREE.MeshStandardMaterial({ color: 0x58a34c, roughness: 0.9 })
      );
      m.position.y = 0.3;
      e.object.add(m);
      return e;
    });
  }

  /** Register a scatterable prop factory: `world.registerKind('oak', () => app.entity()...)`. */
  registerKind(name, factory) {
    if (typeof factory !== 'function') throw new Error('[VWorld] registerKind(name, factory) — factory must be a function returning an Entity.');
    this._kinds.set(String(name), factory);
    return this;
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

  /**
   * Post-processing chain entry point. Requires the post plugin:
   *   app.use(PostPlugin);
   *   app.world.post().bloom(0.6).vignette(0.35).preset('cinematic');
   */
  post() {
    if (!this._postChain) {
      if (!this._postFactory) {
        throw new Error('[VWorld] app.world.post() needs the post plugin — app.use(PostPlugin) first.');
      }
      this._postChain = this._postFactory(this);
    }
    return this._postChain;
  }

  /**
   * Heightfield terrain with matching Rapier collider.
   *   app.world.terrain({ size: 400, resolution: 96, height: (x, z) => Math.sin(x * 0.05) * 6 });
   * Vertex colors shade by elevation automatically (set colorByHeight: false
   * and pass `color` for a flat tint).
   */
  terrain({ size = 200, resolution = 64, height = () => 0, color = 0x4d7c43, colorByHeight = true } = {}) {
    this.engine.physics._assertReady();
    if (typeof height !== 'function') throw new Error('[VWorld] terrain() — height must be a function (x, z) => y.');
    const res = Math.max(1, Math.round(toNumber(resolution, 'resolution')));
    const geo = new THREE.PlaneGeometry(size, size, res, res);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const base = new THREE.Color(color);
    const low = base.clone().multiplyScalar(0.72);
    const high = base.clone().lerp(new THREE.Color(0xffffff), 0.55);
    const c = new THREE.Color();
    let minH = Infinity, maxH = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const h = height(pos.getX(i), pos.getZ(i));
      pos.setY(i, h);
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
    const span = Math.max(1e-6, maxH - minH);
    for (let i = 0; i < pos.count; i++) {
      if (colorByHeight) {
        const t = (pos.getY(i) - minH) / span;
        c.copy(low).lerp(high, t * t);
      } else {
        c.copy(base);
      }
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 })
    );
    mesh.receiveShadow = true;
    this.engine.scene.add(mesh);

    // Matching Rapier heightfield. Verified mapping: scale = TOTAL extent,
    // heights[ix*(res+1)+iz] with x from ix, z from iz.
    const heights = new Float32Array((res + 1) * (res + 1));
    for (let iz = 0; iz <= res; iz++) {
      for (let ix = 0; ix <= res; ix++) {
        heights[ix * (res + 1) + iz] = height(-size / 2 + (size * ix) / res, -size / 2 + (size * iz) / res);
      }
    }
    const R = this.engine.physics.RAPIER;
    const body = this.engine.physics.world.createRigidBody(R.RigidBodyDesc.fixed());
    this.engine.physics.world.createCollider(
      R.ColliderDesc.heightfield(res, res, heights, { x: size, y: 1, z: size }).setFriction(0.9),
      body
    );

    this._terrain = { size, resolution: res, height, mesh };
    return mesh;
  }

  /** Sample terrain height at (x, z) — 0 when no terrain exists. */
  groundHeight(x, z) {
    return this._terrain ? this._terrain.height(x, z) : 0;
  }

  /**
   * Animated water plane.
   *   app.world.water({ level: 1.5, color: 0x2e7fd9, waves: 0.6 });
   */
  water({ level = 0, color = 0x2e7fd9, waves = 0.6, size = 600, opacity = 0.78 } = {}) {
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uWaves: { value: toNumber(waves, 'waves') },
        uColor: { value: new THREE.Color(color) },
        uOpacity: { value: toNumber(opacity, 'opacity') },
      },
      vertexShader: `
        uniform float uTime;
        uniform float uWaves;
        varying float vWave;
        void main() {
          vec3 p = position;
          float w = sin(p.x * 0.12 + uTime * 1.4) * sin(p.y * 0.11 + uTime * 1.05);
          p.z += w * uWaves;
          vWave = w;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vWave;
        void main() {
          vec3 col = uColor * (0.82 + vWave * 0.18);
          gl_FragColor = vec4(col, uOpacity);
        }`,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size, 48, 48), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = level;
    mesh.renderOrder = 2;
    this.engine.scene.add(mesh);
    this._water = { mesh, mat, level };
    this._waterLevel = level;
    return mesh;
  }

  /**
   * Scatter registered prop kinds across an area.
   *   app.world.scatter('pine-tree', { count: 300, area: [-150, 150, -150, 150] });
   *   app.world.scatter('rock', { count: 60, area: { center: [0,0,0], size: 200 } });
   * Area shapes: [minX, maxX, minZ, maxZ] | { min:[..], max:[..] } | { center, size }.
   */
  scatter(kind, options = {}) {
    const factory = this._kinds.get(String(kind));
    if (!factory) {
      throw new Error(`[VWorld] Unknown scatter kind "${kind}". Register one with world.registerKind(), or use a built-in: ${[...this._kinds.keys()].join(', ')}.`);
    }
    const o = withDefaults(options, { count: 100, area: [-100, 100, -100, 100], avoidWater: true, yOffset: 0 });
    const count = Math.max(0, Math.round(toNumber(o.count, 'count')));
    const { minX, maxX, minZ, maxZ } = normalizeArea(o.area);
    const placed = [];
    let guard = 0;
    while (placed.length < count && guard++ < count * 20) {
      const x = minX + Math.random() * (maxX - minX);
      const z = minZ + Math.random() * (maxZ - minZ);
      const y = this.groundHeight(x, z);
      if (o.avoidWater && y < this._waterLevel + 0.4) continue;
      const e = factory().at(x, y + toNumber(o.yOffset, 'yOffset'), z).rotateY(Math.random() * Math.PI * 2);
      placed.push(e);
    }
    return placed;
  }

  /**
   * Tint a terrain region toward a biome color.
   *   app.world.biome('desert', { area: { center: [120, 0, 40], size: 160 } });
   * Built-ins: desert, forest, snow, volcanic, meadow — or pass { color }.
   */
  biome(name, { area = null, color = null } = {}) {
    if (!this._terrain) throw new Error('[VWorld] biome() needs terrain first — call world.terrain() before world.biome().');
    const presets = {
      desert: 0xd9b36c, forest: 0x2f6b33, snow: 0xeef2f7, volcanic: 0x4a3436, meadow: 0x5da24f,
    };
    const target = new THREE.Color(color ?? presets[name]);
    if (color === null && presets[name] === undefined) {
      throw new Error(`[VWorld] Unknown biome "${name}". Try: ${Object.keys(presets).join(', ')} — or pass { color: 0x... }.`);
    }
    const { minX, maxX, minZ, maxZ } = area ? normalizeArea(area) : { minX: -Infinity, maxX: Infinity, minZ: -Infinity, maxZ: Infinity };
    const pos = this._terrain.mesh.geometry.attributes.position;
    const colAttr = this._terrain.mesh.geometry.attributes.color;
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
      tmp.setRGB(colAttr.getX(i), colAttr.getY(i), colAttr.getZ(i)).lerp(target, 0.65);
      colAttr.setXYZ(i, tmp.r, tmp.g, tmp.b);
    }
    colAttr.needsUpdate = true;
    this._biomes.push({ name, color: target.getHex() });
    return this;
  }

  /** Called every frame by the engine. */
  update(dt) {
    if (this._dayNight) this._dayNight.update(dt);
    if (this._water) this._water.mat.uniforms.uTime.value += dt;
  }
}

/** Normalize area shapes to { minX, maxX, minZ, maxZ }. */
function normalizeArea(area) {
  if (Array.isArray(area)) {
    if (area.length !== 4 || !area.every((n) => typeof n === 'number')) {
      throw new Error('[VWorld] area as array must be [minX, maxX, minZ, maxZ].');
    }
    const [minX, maxX, minZ, maxZ] = area;
    return { minX, maxX, minZ, maxZ };
  }
  if (area && typeof area === 'object') {
    if (area.min && area.max) {
      const mn = toVec3(area.min), mx = toVec3(area.max);
      return { minX: Math.min(mn.x, mx.x), maxX: Math.max(mn.x, mx.x), minZ: Math.min(mn.z, mx.z), maxZ: Math.max(mn.z, mx.z) };
    }
    if (area.center !== undefined || area.size !== undefined) {
      const c = toVec3(area.center ?? [0, 0, 0]);
      const s = toNumber(area.size ?? 100, 'size') / 2;
      return { minX: c.x - s, maxX: c.x + s, minZ: c.z - s, maxZ: c.z + s };
    }
  }
  throw new Error('[VWorld] area must be [minX,maxX,minZ,maxZ], { min, max }, or { center, size }.');
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
