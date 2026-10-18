import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { toNumber } from '../util/normalize.js';

/**
 * PostPlugin — cinematic color grading with game-DX.
 *
 *   app.use(PostPlugin);
 *   app.world.post()
 *     .bloom(0.6).vignette(0.35).saturation(1.15).grain(0.05)
 *     .contrast(1.05).brightness(0.02);
 *   app.world.post().preset('cinematic'); // or 'vibrant' | 'noir' | 'dreamy' | 'none'
 *   app.world.post().enabled = false;      // bypass, render normally
 *
 * Built on three/addons EffectComposer. If the composer can't initialize
 * (old GPU, missing WebGL2 features), it degrades gracefully: a warning,
 * then the engine renders exactly as before.
 */

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uVignette: { value: 0 },
    uSaturation: { value: 1 },
    uContrast: { value: 1 },
    uBrightness: { value: 0 },
    uGrain: { value: 0 },
    uTime: { value: 0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uVignette, uSaturation, uContrast, uBrightness, uGrain, uTime;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      // saturation
      float lum = dot(col.rgb, vec3(0.299, 0.587, 0.114));
      col.rgb = mix(vec3(lum), col.rgb, uSaturation);
      // contrast + brightness
      col.rgb = (col.rgb - 0.5) * uContrast + 0.5 + uBrightness;
      // vignette
      float d = distance(vUv, vec2(0.5));
      col.rgb *= 1.0 - uVignette * smoothstep(0.35, 0.85, d);
      // film grain
      col.rgb += (hash(vUv * (1000.0 + fract(uTime) * 500.0)) - 0.5) * uGrain;
      gl_FragColor = col;
    }`,
};

const PRESETS = {
  cinematic: { bloom: 0.55, vignette: 0.42, saturation: 1.08, grain: 0.045, contrast: 1.06, brightness: 0.0 },
  vibrant:   { bloom: 0.35, vignette: 0.18, saturation: 1.35, grain: 0.0,   contrast: 1.02, brightness: 0.02 },
  noir:      { bloom: 0.15, vignette: 0.55, saturation: 0.05, grain: 0.09,  contrast: 1.18, brightness: -0.04 },
  dreamy:    { bloom: 0.9,  vignette: 0.25, saturation: 1.15, grain: 0.02,  contrast: 0.96, brightness: 0.06 },
  none:      { bloom: 0,    vignette: 0,    saturation: 1,    grain: 0,     contrast: 1,    brightness: 0 },
};

export const PostPlugin = {
  name: 'post',
  install(app) {
    // The chain builds lazily on first world.post() so a failed GPU
    // never breaks boot — it just warns and renders normally.
    app.world._postFactory = (world) => new PostChain(app, world);
  },
};

class PostChain {
  constructor(app, world) {
    this.app = app;
    this.world = world;
    this.enabled = true;
    this._ok = false;
    try {
      const renderer = app.renderer;
      const size = new THREE.Vector2();
      renderer.getSize(size);
      this.composer = new EffectComposer(renderer);
      this.composer.addPass(new RenderPass(world.engine.scene, world.engine.camera));
      this.bloomPass = new UnrealBloomPass(size, 0, 0.6, 0.85);
      this.composer.addPass(this.bloomPass);
      this.gradePass = new ShaderPass(GradeShader);
      this.composer.addPass(this.gradePass);
      this.composer.addPass(new OutputPass());
      this._ok = true;
    } catch (err) {
      console.warn('[VWorld] Post-processing unavailable on this GPU — rendering without it.', err.message);
      this.enabled = false;
    }
    // Sensible default look: subtle, not a filter firehose.
    this._vals = { bloom: 0, vignette: 0, saturation: 1, grain: 0, contrast: 1, brightness: 0 };
  }

  get available() { return this._ok; }

  _apply() {
    if (!this._ok) return this;
    const v = this._vals;
    this.bloomPass.strength = v.bloom;
    this.bloomPass.enabled = v.bloom > 0.001;
    const u = this.gradePass.uniforms;
    u.uVignette.value = v.vignette;
    u.uSaturation.value = v.saturation;
    u.uGrain.value = v.grain;
    u.uContrast.value = v.contrast;
    u.uBrightness.value = v.brightness;
    return this;
  }

  bloom(s = 0.6)      { this._vals.bloom = toNumber(s, 'bloom'); return this._apply(); }
  vignette(v = 0.35)  { this._vals.vignette = toNumber(v, 'vignette'); return this._apply(); }
  saturation(s = 1.1) { this._vals.saturation = toNumber(s, 'saturation'); return this._apply(); }
  grain(g = 0.05)     { this._vals.grain = toNumber(g, 'grain'); return this._apply(); }
  contrast(c = 1.05)  { this._vals.contrast = toNumber(c, 'contrast'); return this._apply(); }
  brightness(b = 0.02){ this._vals.brightness = toNumber(b, 'brightness'); return this._apply(); }

  /** Named looks: cinematic | vibrant | noir | dreamy | none. */
  preset(name) {
    const p = PRESETS[name];
    if (!p) throw new Error(`[VWorld] Unknown post preset "${name}". Try: ${Object.keys(PRESETS).join(', ')}.`);
    Object.assign(this._vals, p);
    return this._apply();
  }

  /** Called by the engine instead of renderer.render when enabled. */
  render() {
    if (!this._ok || !this.enabled) {
      this.app.renderer.render(this.app.scene, this.app.camera);
      return;
    }
    const size = new THREE.Vector2();
    this.app.renderer.getSize(size);
    const cs = new THREE.Vector2();
    this.composer.getSize?.(cs);
    // Keep the composer in sync with canvas resizes.
    if (this._lastW !== size.x || this._lastH !== size.y) {
      this._lastW = size.x; this._lastH = size.y;
      this.composer.setSize(size.x, size.y);
    }
    this.gradePass.uniforms.uTime.value = performance.now() / 1000;
    this.composer.render();
  }
}
