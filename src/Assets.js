import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Assets — cached async loaders + character pack registry.
 *
 *   const gltf = await app.assets.load('models/tree.glb'); // cached
 *   const tex  = await app.assets.texture('img/grass.png');
 *
 * Character packs (PUBG-style): players can download cosmetic character
 * packs. Anyone whose pack you haven't downloaded renders as the built-in
 * default character instead — no missing-model errors, ever.
 *
 *   app.assets.characters.registerPack('cyber-ninja', { url: 'chars/ninja.glb' });
 *   await app.assets.characters.downloadPack('cyber-ninja'); // fetch + cache
 *   const avatar = await app.assets.characters.spawn('cyber-ninja'); // or default fallback
 */
export class Assets {
  constructor(engine) {
    this.engine = engine;
    this._cache = new Map();
    this._gltf = new GLTFLoader();
    this._tex = new THREE.TextureLoader();
    this.characters = new CharacterRegistry(this);
  }

  /** Load any asset by URL, cached. GLB/GLTF -> parsed scene, images -> texture. */
  load(url) {
    if (this._cache.has(url)) return this._cache.get(url);
    const isModel = /\.(glb|gltf)(\?|#|$)/i.test(url);
    const p = isModel
      ? this._gltf.loadAsync(url).then((g) => g.scene)
      : this._tex.loadAsync(url);
    // Don't cache rejections forever — allow retry.
    p.catch(() => this._cache.delete(url));
    this._cache.set(url, p);
    return p;
  }

  /** Explicit GLTF load (cached). Resolves to a THREE.Group (the scene). */
  model(url) {
    return this.load(url);
  }

  /** Explicit texture load (cached). */
  texture(url) {
    if (this._cache.has(url)) return this._cache.get(url);
    const p = this._tex.loadAsync(url);
    p.catch(() => this._cache.delete(url));
    this._cache.set(url, p);
    return p;
  }

  has(url) {
    return this._cache.has(url);
  }

  clear(url) {
    if (url) this._cache.delete(url);
    else this._cache.clear();
    return this;
  }
}

// ---------------------------------------------------------------------------
class CharacterRegistry {
  constructor(assets) {
    this.assets = assets;
    this.packs = new Map();       // id -> { url, name }
    this.downloaded = new Set(['default']); // 'default' is always available
    this.defaultTint = 0x3fa7ff;
  }

  /** Register a downloadable character pack (no download happens yet).
   *  A pack can provide either a `url` (GLB/GLTF fetched on download) or a
   *  `factory` (() => THREE.Group, procedural — no download needed). */
  registerPack(id, { url, name = id, factory = null } = {}) {
    this.packs.set(id, { url, name, factory });
    return this;
  }

  /** Is this pack available locally (downloaded)? */
  hasPack(id) {
    return id === 'default' || this.downloaded.has(id);
  }

  /** Download + cache a pack. Resolves when the model is ready.
   *  Factory packs are procedural — nothing to fetch, just mark downloaded. */
  async downloadPack(id) {
    const pack = this.packs.get(id);
    if (!pack) throw new Error(`[VWorld] Unknown character pack "${id}". Register it first.`);
    if (pack.url) await this.assets.load(pack.url);
    this.downloaded.add(id);
    return this;
  }

  /** Forget a downloaded pack (frees the cached model). */
  removePack(id) {
    const pack = this.packs.get(id);
    if (pack?.url) this.assets.clear(pack.url);
    this.downloaded.delete(id);
    return this;
  }

  list() {
    return [...this.packs.keys()];
  }

  /**
   * Spawn an avatar Group for a pack id.
   * Falls back to the built-in default character when the pack isn't
   * downloaded — the PUBG semantic: you always see *someone*.
   */
  async spawn(id, { tint = this.defaultTint } = {}) {
    const useId = this.hasPack(id) ? id : 'default';
    if (useId === 'default') return this._defaultHumanoid(tint);
    const pack = this.packs.get(useId);
    if (pack.factory) {
      // Procedural pack: build a fresh instance from the factory.
      const g = await pack.factory();
      g.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
      g.userData.packId = useId;
      return g;
    }
    const model = await this.assets.load(pack.url);
    const clone = model.clone(true);
    clone.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
    return clone;
  }

  /** Procedural fallback character — always available, zero downloads. */
  _defaultHumanoid(tint) {
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: tint, roughness: 0.6 });
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xf2c89b, roughness: 0.6 });

    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.75, 6, 16), bodyMat);
    body.position.y = 0.95;
    body.castShadow = true;

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 24, 18), skinMat);
    head.position.y = 1.72;
    head.castShadow = true;

    // Simple visor so the default reads as a "character" at distance.
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.12, 0.1),
      new THREE.MeshStandardMaterial({ color: 0x182338, roughness: 0.3 })
    );
    visor.position.set(0, 1.76, 0.2);

    g.add(body, head, visor);
    g.userData.packId = 'default';
    return g;
  }
}
