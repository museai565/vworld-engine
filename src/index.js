/**
 * VWorld Engine — public API.
 *
 *   import { Engine, PlayerController } from '@vworld/engine';
 *
 *   const app = Engine.create({ canvas: document.querySelector('canvas') });
 *   await app.ready;
 *   app.world.ground({ size: 200 });
 *   app.world.dayNight().speed(120);
 *   app.start();
 */
export { Engine } from './Engine.js';
export { World } from './World.js';
export { Entity, reserveEntityIdsUpTo } from './Entity.js';
export { Physics, Body } from './Physics.js';
export { Input } from './Input.js';
export { PlayerController } from './PlayerController.js';
export { Assets } from './Assets.js';
export {
  Net, Interpolator, RewindBuffer, InterestManager,
  normalizeNetInput, applyNetInput, reconcileNetState, quatSlerp,
  normalizeSnapshot, sampleSnapshots, rewindEntities,
  quantizeSnap, dequantizeSnap, deltaSnap, applyDeltaSnap,
  prioritizeUpdates, isRelevant,
  PREDICT_DEFAULTS, QUANTIZE_DEFAULTS, PRIORITIZE_DEFAULTS,
} from './Net.js';
export { Build } from './Build.js';
export { AI, StateMachine } from './AI.js';
export { Time, EASES, easeValue } from './Time.js';
export { AudioPlugin, EffectsPlugin, PostPlugin, AnimationPlugin, allPlugins } from './plugins/index.js';
export { SurfaceKinds, buildAtlas, buildSplatMaterial, evaluateRuleWeight, compositeWeights, valueNoise, MAX_SURFACE_LAYERS, BUILTIN_SURFACE_KIND_NAMES } from './Surfaces.js';
export { FluidSystem, Fluid, BUILTIN_FLUID_TYPES, submergedFraction, buoyancyNetAccel } from './Fluids.js';
export { toVec3, toXYZ, toNumber, toColor, withDefaults, toAxis, axisToVec3, toBox3 } from './util/normalize.js';
// v0.5.0 — rendering richness
export {
  InstancedSet, Decal, CloudLayer, LightShaft,
  normalizeLodLevels, selectLod,
  MATERIAL_PRESETS, materialPresetNames, resolveMaterialPreset, makeMaterial,
  resolveShadowConfig,
  decalFrame, decalOpacity, scorchTexture, bulletTexture, decalPresetNames,
  shaftFrame, cloudLayout, cloudTexture,
} from './Rendering.js';
// v0.7.0 — gameplay systems
export {
  Inventory, Health, QuestLog, Dialogue, Pickup, Hud,
  normalizeItemId, parseBinding, normalizeBindings,
  bindingHeld, bindingPressed, bindingReleased,
  actionHeld, actionPressed, actionReleased,
  inPickupRange,
} from './Gameplay.js';
// v0.8.0 — persistence & streaming
export {
  SAVE_VERSION, MIGRATIONS, validateSave, migrateSave, normalizeEntityRecord,
  entityToRecord, applyRecordToEntity, serializeWorld, restoreWorld,
  ChunkManager, defaultChunkProvider,
  chunkIndex, chunkKey, parseChunkKey, chunkBounds, chunksAround,
  diffChunkSets, hashChunkKey, mulberry32, resolveChunkCenter,
} from './Persistence.js';
export {
  prefabNames, prefabCategories, getPrefabDef, prefabVariantCount,
  selectVariant, registerPrefabDef, normalizePrefabCall, buildPrefab,
} from './Prefabs.js';
// v0.4.0 — production hardening
export { Profiler } from './Profiler.js';
export { VWorldError, vError, createErrorBus, reportError } from './util/errors.js';
export { QUALITY_LEVELS, resolveQuality, normalizeQuality, autoStep } from './util/quality.js';

export const VERSION = '0.8.0';
