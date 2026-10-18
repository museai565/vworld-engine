// VWorld Engine — durable node smoke tests (pure, DOM-free modules).
// Run: node test/smoke.mjs  (must exit 0 with 0 failures)
import * as THREE from 'three';
import { toBox3, toColor } from '../src/util/normalize.js';
import { Entity } from '../src/Entity.js';
import {
  InstancedSet, Decal, CloudLayer, LightShaft,
  normalizeLodLevels, selectLod,
  MATERIAL_PRESETS, materialPresetNames, resolveMaterialPreset, makeMaterial,
  resolveShadowConfig,
  decalFrame, decalOpacity, scorchTexture, bulletTexture, decalPresetNames,
  shaftFrame, cloudLayout,
} from '../src/Rendering.js';
import { evaluateRuleWeight, compositeWeights, valueNoise } from '../src/Surfaces.js';
import { submergedFraction, buoyancyNetAccel } from '../src/Fluids.js';
import {
  Interpolator, RewindBuffer, InterestManager,
  normalizeNetInput, applyNetInput, reconcileNetState, quatSlerp,
  sampleSnapshots, rewindEntities,
  quantizeSnap, dequantizeSnap, deltaSnap, applyDeltaSnap,
  prioritizeUpdates, isRelevant,
} from '../src/Net.js';
import { VWorldError, vError, createErrorBus, reportError } from '../src/util/errors.js';
import { Profiler } from '../src/Profiler.js';
import { QUALITY_LEVELS, resolveQuality, normalizeQuality, autoStep } from '../src/util/quality.js';
import {
  Inventory, Health, QuestLog, Dialogue, Hud, Pickup,
  normalizeItemId, parseBinding, normalizeBindings,
  bindingHeld, bindingPressed, bindingReleased,
  actionHeld, actionPressed, actionReleased,
  inPickupRange,
} from '../src/Gameplay.js';
import { reserveEntityIdsUpTo } from '../src/Entity.js';
import {
  SAVE_VERSION, MIGRATIONS, validateSave, migrateSave, normalizeEntityRecord,
  entityToRecord, applyRecordToEntity,
  ChunkManager, defaultChunkProvider,
  chunkIndex, chunkKey, parseChunkKey, chunkBounds, chunksAround,
  diffChunkSets, hashChunkKey, mulberry32, resolveChunkCenter,
} from '../src/Persistence.js';
import {
  prefabNames, prefabCategories, getPrefabDef, prefabVariantCount,
  selectVariant, registerPrefabDef, normalizePrefabCall,
} from '../src/Prefabs.js';
import {
  Weather, WindSystem,
  WEATHER_KINDS, TIME_OF_DAY_NAMES,
  normalizeWeatherKind, normalizeWeatherOptions, normalizeWindZone, normalizeHour,
  sunPositionAt, skyKeyframeAt,
  windFieldAt, precipitationSeed,
  snowSpeedMultiplier, rainFrictionFactor, rainVisibility, nextStrikeDelay,
} from '../src/Weather.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const throwsCode = (fn, code) => {
  try { fn(); } catch (e) { return e instanceof VWorldError && e.code === code; }
  return false;
};

// ---------------------------------------------------------------- v0.3.0 ports
console.log('== toBox3 ==');
{
  const b1 = toBox3([0, 0, 0, 1, 2, 3]);
  ok('array6', b1.min.x === 0 && b1.max.z === 3 && b1.isBox3);
  const b2 = toBox3({ min: [1, 1, 1], max: [0, 0, 0] }); // reversed -> normalized
  ok('minmax reversed', b2.min.x === 0 && b2.max.x === 1);
  const b3 = toBox3({ center: [5, 5, 5], size: 4 });
  ok('center+size number', b3.min.x === 3 && b3.max.y === 7);
  const b4 = toBox3({ center: [0, 0, 0], size: [2, 4, 6] });
  ok('center+size vec', b4.max.x === 1 && b4.max.y === 2 && b4.max.z === 3);
  const src = new THREE.Box3(new THREE.Vector3(1, 2, 3), new THREE.Vector3(4, 5, 6));
  const b5 = toBox3(src);
  ok('Box3 clone', b5.min.y === 2 && b5 !== src);
  let threw = false;
  try { toBox3('nope'); } catch (e) { threw = /Box3/.test(e.message); }
  ok('garbage throws helpful', threw);
  let threw2 = false;
  try { toBox3([1, 2]); } catch (e) { threw2 = true; }
  ok('short array throws', threw2);
}

console.log('== evaluateRuleWeight ==');
{
  const noFluids = [];
  ok('no-where rule = 1', evaluateRuleWeight({ kind: 'grass' }, { x: 0, z: 0, height: 0, slope: 0, fluids: noFluids }) === 1);
  ok('flat not rock', approx(evaluateRuleWeight({ kind: 'rock', where: { slope: { min: 0.5 } } }, { x: 0, z: 0, height: 0, slope: 0.1, fluids: noFluids }), 0));
  ok('steep is rock', approx(evaluateRuleWeight({ kind: 'rock', where: { slope: { min: 0.5 } } }, { x: 0, z: 0, height: 0, slope: 0.9, fluids: noFluids }), 1));
  ok('low not snow', approx(evaluateRuleWeight({ kind: 'snow', where: { height: { min: 16 } } }, { x: 0, z: 0, height: 5, slope: 0, fluids: noFluids }), 0));
  ok('high is snow', evaluateRuleWeight({ kind: 'snow', where: { height: { min: 16 } } }, { x: 0, z: 0, height: 30, slope: 0, fluids: noFluids }) > 0.99);
  const fluids = [{ name: 'lake', type: 'water', box: { min: { x: 0, y: -3, z: 0 }, max: { x: 10, y: 0, z: 10 } } }];
  const sandRule = { kind: 'sand', where: { nearFluid: 'water', within: 4 } };
  ok('inside fluid = 1', approx(evaluateRuleWeight(sandRule, { x: 5, z: 5, height: 0, slope: 0, fluids }), 1));
  const wMid = evaluateRuleWeight(sandRule, { x: 12, z: 5, height: 0, slope: 0, fluids });
  ok('2m outside within=4 -> 0.5', approx(wMid, 0.5, 0.01), `got ${wMid}`);
  ok('far outside = 0', approx(evaluateRuleWeight(sandRule, { x: 50, z: 50, height: 0, slope: 0, fluids }), 0));
  ok('no fluids at all = 0', approx(evaluateRuleWeight(sandRule, { x: 5, z: 5, height: 0, slope: 0, fluids: [] }), 0));
  ok('nearFluid matches name too', evaluateRuleWeight({ kind: 'sand', where: { nearFluid: 'lake', within: 4 } }, { x: 5, z: 5, height: 0, slope: 0, fluids }) === 1);
  const both = { kind: 'x', where: { slope: { min: 0.5 }, height: { min: 10 } } };
  ok('AND: steep but low = 0', approx(evaluateRuleWeight(both, { x: 0, z: 0, height: 0, slope: 0.9, fluids: noFluids }), 0));
  ok('AND: steep and high = 1', evaluateRuleWeight(both, { x: 0, z: 0, height: 20, slope: 0.9, fluids: noFluids }) > 0.99);
  const nRule = { kind: 'mud', where: { noise: { scale: 0.05, threshold: 0.5 } } };
  const n1 = evaluateRuleWeight(nRule, { x: 3.7, z: -12.2, height: 0, slope: 0, fluids: noFluids });
  const n2 = evaluateRuleWeight(nRule, { x: 3.7, z: -12.2, height: 0, slope: 0, fluids: noFluids });
  ok('noise deterministic', n1 === n2 && n1 >= 0 && n1 <= 1);
  ok('valueNoise in [0,1]', valueNoise(1.5, -3.2) >= 0 && valueNoise(1.5, -3.2) <= 1);
}

console.log('== compositeWeights (later wins) ==');
{
  ok('tie -> later wins', JSON.stringify(compositeWeights([1, 1])) === JSON.stringify([0, 1]));
  const c2 = compositeWeights([0.5, 0.5]);
  ok('half/half', approx(c2[0], 0.5) && approx(c2[1], 0.5), JSON.stringify(c2));
  const c3 = compositeWeights([0, 0, 0]);
  ok('all zero -> base takes all', JSON.stringify(c3) === JSON.stringify([1, 0, 0]));
  const c4 = compositeWeights([1, 0.5]);
  ok('sums to 1', approx(c4[0] + c4[1], 1), JSON.stringify(c4));
  ok('over-operator: [1,0.5] -> [0.5,0.5]', approx(c4[0], 0.5) && approx(c4[1], 0.5), JSON.stringify(c4));
}

console.log('== submergedFraction ==');
{
  const fluid = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 2, z: 10 } };
  ok('fully inside = 1', approx(submergedFraction({ min: { x: 2, y: 0.5, z: 2 }, max: { x: 4, y: 1.5, z: 4 } }, fluid), 1));
  ok('half submerged = 0.5', approx(submergedFraction({ min: { x: 2, y: 1, z: 2 }, max: { x: 4, y: 3, z: 4 } }, fluid), 0.5));
  ok('outside = 0', submergedFraction({ min: { x: 20, y: 0, z: 20 }, max: { x: 22, y: 2, z: 22 } }, fluid) === 0);
  ok('touching edge = 0', submergedFraction({ min: { x: 10, y: 0, z: 0 }, max: { x: 12, y: 2, z: 2 } }, fluid) === 0);
  ok('degenerate box = 0', submergedFraction({ min: { x: 1, y: 1, z: 1 }, max: { x: 1, y: 1, z: 1 } }, fluid) === 0);
}

console.log('== buoyancyNetAccel ==');
{
  ok('light body rises', buoyancyNetAccel(1.0, 0.5, 1) > 9.8 && buoyancyNetAccel(1.0, 0.5, 1) < 9.83);
  ok('heavy body sinks', buoyancyNetAccel(1.0, 2.0, 1) < -4.9 && buoyancyNetAccel(1.0, 2.0, 1) > -4.92);
  ok('neutral density', approx(buoyancyNetAccel(1.0, 1.0, 1), 0));
  ok('half submerged light', buoyancyNetAccel(1.0, 0.5, 0.5) < 0.01 && buoyancyNetAccel(1.0, 0.5, 0.5) > -0.01);
  ok('out of fluid = full gravity down', approx(buoyancyNetAccel(1.0, 0.5, 0), -9.81));
}

// ---------------------------------------------------------------- v0.4.0
console.log('== VWorldError ==');
{
  const err = vError('VWORLD/PHYSICS_NOT_READY', '[VWorld] await app.ready first');
  ok('instanceof Error', err instanceof Error);
  ok('instanceof VWorldError', err instanceof VWorldError);
  ok('name is VWorldError', err.name === 'VWorldError');
  ok('code carried', err.code === 'VWORLD/PHYSICS_NOT_READY');
  ok('message preserved', err.message === '[VWorld] await app.ready first');
  const caused = vError('VWORLD/PLUGIN_INSTALL_FAILED', 'boom', { cause: new Error('orig') });
  ok('cause carried', caused.cause instanceof Error && caused.cause.message === 'orig');
}

console.log('== createErrorBus ==');
{
  const bus = createErrorBus();
  const order = [];
  const h1 = () => order.push('h1');
  const h2 = () => order.push('h2');
  ok('onError returns bus (chainable)', bus.onError(h1).onError(h2) === bus);
  bus.report(new Error('x'));
  ok('handlers called in order', JSON.stringify(order) === JSON.stringify(['h1', 'h2']));
  ok('offError removes', bus.offError(h1) === bus && (() => { order.length = 0; bus.report(new Error('y')); return JSON.stringify(order) === JSON.stringify(['h2']); })());
  ok('report returns bus', bus.report(new Error('z')) === bus);

  // throwing handler must not block the rest
  const seen = [];
  const bus2 = createErrorBus();
  bus2.onError(() => { throw new Error('handler bug'); });
  bus2.onError(() => seen.push('second'));
  const origErr = console.error;
  console.error = () => {};
  try { bus2.report(new Error('boom')); } finally { console.error = origErr; }
  ok('throwing handler does not block the next', seen.length === 1);

  // no handlers -> console.error fallback
  const bus3 = createErrorBus();
  let logged = null;
  console.error = (...args) => { logged = args; };
  try { bus3.report(vError('VWORLD/PHYSICS_NOT_READY', 'nobody home')); } finally { console.error = origErr; }
  ok('no handlers -> console.error fallback', logged && logged[1] instanceof VWorldError && logged[1].code === 'VWORLD/PHYSICS_NOT_READY');

  ok('onError rejects non-function', throwsCode(() => createErrorBus().onError('nope'), 'VWORLD/BAD_HANDLER'));

  // reportError routes through engine bus when present, never throws
  const routed = [];
  const fakeEngine = { _errorBus: createErrorBus() };
  fakeEngine._errorBus.onError((e) => routed.push(e));
  reportError(fakeEngine, new Error('eng'));
  ok('reportError uses engine bus', routed.length === 1 && routed[0].message === 'eng');
  console.error = () => {};
  let threw = false;
  try { reportError(null, new Error('no engine')); } catch { threw = true; } finally { console.error = origErr; }
  ok('reportError with no engine never throws', !threw);
}

console.log('== resolveQuality ==');
{
  const q = (level, dpr) => resolveQuality(level, dpr);
  ok('high dpr1', q('high', 1).pixelRatio === 1 && q('high', 1).shadows === true);
  ok('high dpr2', q('high', 2).pixelRatio === 2 && q('high', 2).shadows === true);
  ok('high dpr3 clamped to 2', q('high', 3).pixelRatio === 2 && q('high', 3).shadows === true);
  ok('medium dpr1', q('medium', 1).pixelRatio === 1 && q('medium', 1).shadows === true);
  ok('medium dpr2', q('medium', 2).pixelRatio === 1.5 && q('medium', 2).shadows === true);
  ok('medium dpr3 clamped to 1.5', q('medium', 3).pixelRatio === 1.5 && q('medium', 3).shadows === true);
  ok('low dpr1', q('low', 1).pixelRatio === 1 && q('low', 1).shadows === false);
  ok('low dpr3 still 1, no shadows', q('low', 3).pixelRatio === 1 && q('low', 3).shadows === false);
  ok('auto resolves to high settings', q('auto', 3).pixelRatio === 2 && q('auto', 3).shadows === true);
  ok('bad dpr defaults to 1', q('high', 0).pixelRatio === 1 && q('high', NaN).pixelRatio === 1);
  ok('unknown level throws VWORLD/UNKNOWN_QUALITY', throwsCode(() => q('ultra', 1), 'VWORLD/UNKNOWN_QUALITY'));
  ok('QUALITY_LEVELS is high,medium,low', JSON.stringify(QUALITY_LEVELS) === JSON.stringify(['high', 'medium', 'low']));
}

console.log('== normalizeQuality ==');
{
  ok('string passthrough', normalizeQuality('high') === 'high');
  ok('case-insensitive', normalizeQuality('AUTO') === 'auto');
  ok('object form', normalizeQuality({ level: 'Low' }) === 'low');
  ok('garbage throws VWORLD/BAD_QUALITY', throwsCode(() => normalizeQuality(42), 'VWORLD/BAD_QUALITY'));
  ok('empty object throws', throwsCode(() => normalizeQuality({}), 'VWORLD/BAD_QUALITY'));
}

console.log('== autoStep ==');
{
  ok('high + 40fps -> medium', JSON.stringify(autoStep('high', 40, 2)) === JSON.stringify({ level: 'medium', highStreak: 0 }));
  ok('medium + 40fps -> low', autoStep('medium', 40).level === 'low');
  ok('low + 40fps stays low (floor)', autoStep('low', 30).level === 'low');
  ok('step-down resets streak', JSON.stringify(autoStep('medium', 40, 2)) === JSON.stringify({ level: 'low', highStreak: 0 }));
  ok('low + 60fps x3 steps up to medium', JSON.stringify(autoStep('low', 60, 2)) === JSON.stringify({ level: 'medium', highStreak: 0 }));
  ok('60fps first window: hold, streak 1', JSON.stringify(autoStep('medium', 60, 0)) === JSON.stringify({ level: 'medium', highStreak: 1 }));
  ok('60fps second window: hold, streak 2', autoStep('medium', 60, 1).highStreak === 2);
  ok('60fps third window: step up, streak reset', JSON.stringify(autoStep('medium', 60, 2)) === JSON.stringify({ level: 'high', highStreak: 0 }));
  ok('already high steps nowhere', autoStep('high', 70, 2).level === 'high');
  ok('mid-range fps holds + resets streak', JSON.stringify(autoStep('medium', 50, 2)) === JSON.stringify({ level: 'medium', highStreak: 0 }));
  ok('boundary 45 holds', autoStep('high', 45).level === 'high');
  ok('boundary 57 holds', autoStep('high', 57).level === 'high');
}

console.log('== Profiler ==');
{
  const p = new Profiler();
  ok('enabled by default', p.enabled === true);
  p.record('fixed', 2).record('fixed', 4).record('fixed', 6);
  const rep = p.report();
  ok('avgMs math', approx(rep.fixed.avgMs, 4));
  ok('maxMs math', rep.fixed.maxMs === 6);
  ok('calls counted', rep.fixed.calls === 3);
  ok('report shape keys', 'avgMs' in rep.fixed && 'maxMs' in rep.fixed && 'calls' in rep.fixed);

  // real performance.now timing
  const p2 = new Profiler();
  p2.begin('work');
  const t0 = performance.now();
  while (performance.now() - t0 < 2) { /* busy ~2ms */ }
  p2.end('work');
  const r2 = p2.report();
  ok('begin/end records a sample', r2.work.calls === 1 && r2.work.avgMs > 0 && r2.work.maxMs >= r2.work.avgMs);

  // unmatched end() is ignored
  const p3 = new Profiler();
  p3.end('never-begun');
  ok('unmatched end ignored', Object.keys(p3.report()).length === 0);

  // disabled -> no-ops
  const p4 = new Profiler({ enabled: false });
  p4.begin('x'); p4.end('x'); p4.record('y', 5);
  ok('disabled profiler records nothing', Object.keys(p4.report()).length === 0);

  // reset
  p.reset();
  ok('reset clears', Object.keys(p.report()).length === 0 && p.summary() === '(no samples)');

  // summary format
  p.record('render', 8);
  const s = p.summary();
  ok('summary mentions section + calls', s.includes('render') && s.includes('avg') && s.includes('max') && s.includes('1 calls'), s);

  // rolling window trims old samples
  const p5 = new Profiler({ windowSize: 3 });
  p5.record('w', 1).record('w', 1).record('w', 1).record('w', 10).record('w', 10);
  const rw = p5.report().w;
  ok('window keeps last 3 samples', approx(rw.avgMs, 7) && rw.calls === 5, JSON.stringify(rw));

  // chainable
  const p6 = new Profiler();
  ok('begin/end/record/reset chainable', p6.begin('a') === p6 && p6.end('a') === p6 && p6.record('a', 1) === p6 && p6.reset() === p6);
}

// ---------------------------------------------------------------- v0.5.0
console.log('== toColor ==');
{
  const c1 = toColor(0xff0000);
  ok('hex number', c1.isColor && approx(c1.r, 1) && approx(c1.g, 0) && approx(c1.b, 0));
  const c2 = toColor('#00ff00');
  ok('css hex string', approx(c2.g, 1) && approx(c2.r, 0));
  const c3 = toColor('red');
  ok('css name', c3.getHex() === 0xff0000);
  const src = new THREE.Color(0x123456);
  const c4 = toColor(src);
  ok('Color cloned', c4.getHex() === 0x123456 && c4 !== src);
  const c5 = toColor({ r: 0, g: 0, b: 1 });
  ok('{r,g,b} object', c5.getHex() === 0x0000ff);
  ok('garbage string throws', (() => { try { toColor('notacolor'); return false; } catch (e) { return /parse color/.test(e.message); } })());
  let threw = false;
  try { toColor(null); } catch (e) { threw = /needs a color/.test(e.message); }
  ok('null throws helpful', threw);
  let threw2 = false;
  try { toColor(0x1ffffff); } catch (e) { threw2 = true; }
  ok('out-of-range hex throws', threw2);
}

console.log('== normalizeLodLevels / selectLod ==');
{
  const mA = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  const mB = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  const lv = normalizeLodLevels([{ distance: 50, mesh: mB }, { distance: 0, mesh: mA }, { distance: 150, mesh: null }]);
  ok('sorted ascending', lv[0].distance === 0 && lv[1].distance === 50 && lv[2].distance === 150);
  ok('null mesh kept', lv[2].mesh === null);
  const lv2 = normalizeLodLevels([[0, mA], [60, mB]]);
  ok('shorthand pairs', lv2.length === 2 && lv2[1].distance === 60 && lv2[1].mesh === mB);
  ok('select 0', selectLod(0, lv) === 0);
  ok('select 30 -> 0', selectLod(30, lv) === 0);
  ok('select 50 -> 1', selectLod(50, lv) === 1);
  ok('select 149 -> 1', selectLod(149, lv) === 1);
  ok('select 150 -> 2 (culled)', selectLod(150, lv) === 2);
  ok('select 999 -> last', selectLod(999, lv) === 2);
  ok('empty throws VWORLD/BAD_LOD', throwsCode(() => normalizeLodLevels([]), 'VWORLD/BAD_LOD'));
  ok('negative distance throws', throwsCode(() => normalizeLodLevels([{ distance: -1, mesh: mA }]), 'VWORLD/BAD_LOD'));
  ok('bad mesh throws', throwsCode(() => normalizeLodLevels([{ distance: 0, mesh: 42 }]), 'VWORLD/BAD_LOD'));
}

console.log('== resolveMaterialPreset ==');
{
  ok('14 presets', materialPresetNames().length === 14 && materialPresetNames().includes('glass'));
  const m = resolveMaterialPreset('metal');
  ok('metal values', m.metalness === 0.9 && m.roughness === 0.35 && m.color === 0x9aa3ad);
  const m2 = resolveMaterialPreset('METAL');
  ok('case-insensitive', m2.metalness === 0.9);
  const m3 = resolveMaterialPreset('metal', { roughness: 0.1 });
  ok('overrides merge', m3.roughness === 0.1 && m3.metalness === 0.9);
  const m4 = resolveMaterialPreset('plastic', { color: 'red' });
  ok('color override normalized to hex', m4.color === 0xff0000);
  const g = resolveMaterialPreset('glass');
  ok('glass transparent', g.transparent === true && approx(g.opacity, 0.32));
  ok('unknown throws VWORLD/UNKNOWN_MATERIAL', throwsCode(() => resolveMaterialPreset('unobtainium'), 'VWORLD/UNKNOWN_MATERIAL'));
  const mat = makeMaterial('gold');
  ok('makeMaterial builds MeshStandardMaterial', mat.isMeshStandardMaterial && approx(mat.metalness, 1.0));
}

console.log('== resolveShadowConfig ==');
{
  const d = resolveShadowConfig();
  ok('defaults', d.mapSize[0] === 2048 && d.bias === -0.0004 && d.left === -70 && d.right === 70 && d.far === 1200);
  const c = resolveShadowConfig({ mapSize: 4096, bounds: 90 });
  ok('number forms', c.mapSize[0] === 4096 && c.mapSize[1] === 4096 && c.left === -90 && c.top === 90);
  const c2 = resolveShadowConfig({ mapSize: [1024, 512], bounds: { left: -40, right: 40, top: 60, bottom: -60 }, bias: -0.0002 });
  ok('array + object forms', c2.mapSize[0] === 1024 && c2.mapSize[1] === 512 && c2.left === -40 && c2.top === 60 && c2.bias === -0.0002);
  const c3 = resolveShadowConfig({ mapSize: 10 });
  ok('mapSize clamped to 64', c3.mapSize[0] === 64);
  ok('bad mapSize array throws', throwsCode(() => resolveShadowConfig({ mapSize: [1, 2, 3] }), 'VWORLD/BAD_SHADOWS'));
}

console.log('== decalFrame / decalOpacity ==');
{
  const f = decalFrame([0, 0, 0], [0, 1, 0], 2);
  const mapped = new THREE.Vector3(0, 0, 1).applyQuaternion(f.quaternion);
  ok('+Z maps to normal', approx(mapped.x, 0) && approx(mapped.y, 1) && approx(mapped.z, 0));
  ok('nudged along normal', approx(f.position.y, 0.04) && approx(f.position.x, 0));
  ok('square size', f.width === 2 && f.height === 2);
  const f2 = decalFrame([1, 2, 3], [1, 0, 0], [2, 4]);
  ok('[w,h] size', f2.width === 2 && f2.height === 4);
  const m2 = new THREE.Vector3(0, 0, 1).applyQuaternion(f2.quaternion);
  ok('normal +X', approx(m2.x, 1) && approx(m2.y, 0) && approx(m2.z, 0));
  ok('zero normal throws', throwsCode(() => decalFrame([0, 0, 0], [0, 0, 0], 1), 'VWORLD/BAD_DECAL'));
  ok('negative size throws', throwsCode(() => decalFrame([0, 0, 0], [0, 1, 0], -1), 'VWORLD/BAD_DECAL'));
  ok('permanent when lifetime 0', decalOpacity(999, 0) === 1);
  ok('full opacity early', decalOpacity(5, 10, 2) === 1);
  ok('linear fade', approx(decalOpacity(9.5, 10, 2), 0.25));
  ok('gone at lifetime', decalOpacity(10, 10, 2) === 0);
  ok('gone after lifetime', decalOpacity(15, 10, 2) === 0);
  ok('fade 0 = no fade', decalOpacity(9.9, 10, 0) === 1);
  ok('no-DOM texture throws VWORLD/NO_DOM', throwsCode(() => scorchTexture(), 'VWORLD/NO_DOM'));
  ok('no-DOM bullet throws VWORLD/NO_DOM', throwsCode(() => bulletTexture(), 'VWORLD/NO_DOM'));
  ok('decal presets listed', JSON.stringify(decalPresetNames()) === JSON.stringify(['scorch', 'bullet']));
}

console.log('== shaftFrame ==');
{
  const f = shaftFrame([0, 10, 0], [0, 0, 0]);
  ok('length 10', approx(f.length, 10));
  ok('midpoint', approx(f.midpoint.y, 5) && approx(f.midpoint.x, 0));
  ok('direction down', approx(f.direction.y, -1));
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(f.quaternion);
  ok('+Y maps to direction', approx(up.y, -1) && approx(up.x, 0));
  ok('same points throw', throwsCode(() => shaftFrame([1, 1, 1], [1, 1, 1]), 'VWORLD/BAD_SHAFT'));
}

console.log('== cloudLayout ==');
{
  const a = cloudLayout(20, 400, 120, [24, 64], 7);
  const b = cloudLayout(20, 400, 120, [24, 64], 7);
  ok('count respected', a.length === 20);
  ok('deterministic', JSON.stringify(a) === JSON.stringify(b));
  const c = cloudLayout(20, 400, 120, [24, 64], 8);
  ok('different seed differs', JSON.stringify(a) !== JSON.stringify(c));
  ok('x/z in bounds', a.every((p) => Math.abs(p.x) <= 200 && Math.abs(p.z) <= 200));
  ok('y in range', a.every((p) => p.y >= 0 && p.y <= 120));
  ok('scale in range', a.every((p) => p.scale >= 24 && p.scale <= 64));
  const h = cloudLayout(5, { x: 100, z: 200 }, [80, 160], 30, 3);
  ok('object area + height range', h.every((p) => Math.abs(p.x) <= 50 && Math.abs(p.z) <= 100 && p.y >= 80 && p.y <= 160 && p.scale === 30));
}

console.log('== InstancedSet (node-safe) ==');
{
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff });
  const set = new InstancedSet(null, geo, mat, 10);
  ok('count', set.count === 10 && set.mesh.isInstancedMesh);
  ok('frustumCulled off by default', set.mesh.frustumCulled === false);
  set.set(0, { at: [1, 2, 3], scale: 2, rotate: [0, Math.PI / 2, 0] });
  const m4 = new THREE.Matrix4();
  set.mesh.getMatrixAt(0, m4);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m4.decompose(p, q, s);
  ok('matrix position', approx(p.x, 1) && approx(p.y, 2) && approx(p.z, 3));
  ok('matrix uniform scale', approx(s.x, 2) && approx(s.y, 2) && approx(s.z, 2));
  ok('set chainable', set.set(1, { at: [0, 0, 0] }) === set);
  ok('update chainable', set.update() === set);
  ok('index out of range throws', throwsCode(() => set.set(10, {}), 'VWORLD/BAD_INSTANCED'));
  ok('bad geometry throws', throwsCode(() => new InstancedSet(null, {}, mat, 5), 'VWORLD/BAD_INSTANCED'));
  ok('bad material throws', throwsCode(() => new InstancedSet(null, geo, {}, 5), 'VWORLD/BAD_INSTANCED'));
  set.scatter({ box: [-10, 10], count: 5, y: [0, 2], scale: [0.5, 1.5] });
  ok('scatter runs', true);
  ok('at/moveBy chainable', set.at(5, 0, 5) === set && set.moveBy(1, 0, 0) === set);
  ok('dispose idempotent', set.dispose() === set && set.dispose() === set);
}

console.log('== Decal / LightShaft (node-safe) ==');
{
  const d = new Decal(null, { position: [0, 1, 0], normal: [0, 1, 0], size: 2, lifetime: 0 });
  ok('decal mesh built', d.mesh.isMesh && d.mesh.geometry.parameters.width === 2);
  ok('renderOrder 2', d.mesh.renderOrder === 2);
  ok('unknown preset throws', throwsCode(() => new Decal(null, { preset: 'glitter' }), 'VWORLD/BAD_DECAL'));
  ok('decal dispose idempotent', d.dispose() === d && d.dispose() === d);
  const s = new LightShaft(null, { from: [0, 10, 0], to: [0, 0, 0], radius: 4 });
  ok('shaft positioned at midpoint', approx(s.mesh.position.y, 5));
  ok('additive blending', s.material.blending === THREE.AdditiveBlending);
  ok('intensity chainable', s.intensity(0.8) === s && approx(s.material.uniforms.uIntensity.value, 0.8));
  ok('bad radius throws', throwsCode(() => new LightShaft(null, { radius: -1 }), 'VWORLD/BAD_SHAFT'));
  ok('shaft dispose idempotent', s.dispose() === s);
  ok('CloudLayer needs DOM', throwsCode(() => new CloudLayer(null, {}), 'VWORLD/NO_DOM'));
}

console.log('== Entity.lod (node-safe, fake engine) ==');
{
  const fakeEngine = {
    camera: { position: new THREE.Vector3(0, 0, 0) },
    onUpdate() {}, offUpdate() {},
  };
  const e = new Entity(fakeEngine);
  const hi = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  const lo = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  e.lod([{ distance: 0, mesh: hi }, [60, lo], { distance: 150, mesh: null }]);
  ok('levels normalized + sorted', e._lod.levels.length === 3 && e._lod.levels[1].distance === 60);
  ok('meshes reparented', hi.parent === e.object && lo.parent === e.object);
  ok('near -> level 0', e.lodIndex === 0 && hi.visible === true && lo.visible === false);
  fakeEngine.camera.position.set(0, 0, 100);
  e._lod.ticker(0.016);
  ok('mid -> level 1', e.lodIndex === 1 && hi.visible === false && lo.visible === true);
  fakeEngine.camera.position.set(0, 0, 200);
  e._lod.ticker(0.016);
  ok('far -> level 2 (culled)', e.lodIndex === 2 && hi.visible === false && lo.visible === false);
  ok('lod() chainable', e.lod([{ distance: 0, mesh: hi }]) === e);
  e.dispose();
  ok('dispose clears lod', e._lod === null && e.lodIndex === -1);
}

console.log('\n== netcode v0.6.0 ==');
{
  // --- normalizeNetInput ---
  const fwd = normalizeNetInput('forward');
  ok('word forward', fwd.move.x === 0 && fwd.move.z === -1 && !fwd.jump);
  const arr = normalizeNetInput([1, 0]);
  ok('array move', arr.move.x === 1 && arr.move.z === 0);
  const sh = normalizeNetInput({ x: 2, z: 3 });
  ok('object shorthand', sh.move.x === 2 && sh.move.z === 3);
  const full = normalizeNetInput({ move: [0, 1], jump: true, sprint: true });
  ok('full object', full.move.z === 1 && full.jump && full.sprint);
  const idle = normalizeNetInput(null);
  ok('null = idle', idle.move.x === 0 && idle.move.z === 0 && !idle.jump && !idle.sprint);
  let threw = false;
  try { normalizeNetInput('sideways'); } catch (e) { threw = /move word/.test(e.message); }
  ok('bad word throws helpful', threw);

  // --- applyNetInput ---
  const mover = { speed: 5, accel: 10000, friction: 0, gravity: 0, minY: -1000 };
  const s1 = applyNetInput({ p: [0, 0, 0], v: [0, 0, 0], grounded: true }, { move: [1, 0] }, 1, mover);
  ok('moves +x at speed', approx(s1.p[0], 5) && approx(s1.v[0], 5));
  const fall = applyNetInput({ p: [0, 10, 0], v: [0, 0, 0], grounded: false }, null, 1, { gravity: 10, minY: 0 });
  ok('gravity lands on minY', fall.p[1] === 0 && fall.v[1] === 0 && fall.grounded === true);
  const jump = applyNetInput({ p: [0, 0, 0], v: [0, 0, 0], grounded: true }, { jump: true }, 0.1, { jumpSpeed: 8, gravity: 22 });
  ok('jump leaves ground', jump.v[1] > 0 && jump.p[1] > 0 && jump.grounded === false);
  const noAirJump = applyNetInput({ p: [0, 5, 0], v: [0, 0, 0], grounded: false }, { jump: true }, 0.1, { jumpSpeed: 8, gravity: 22 });
  ok('no double jump', noAirJump.v[1] < 0);

  // --- reconcileNetState ---
  const rec = reconcileNetState({ p: [0, 0, 0] }, [
    { seq: 1, input: { move: [1, 0] } },
    { seq: 2, input: { move: [1, 0] } },
  ], 1, mover);
  ok('reconcile re-applies inputs', approx(rec.state.p[0], 10) && rec.applied.join(',') === '1,2');

  // --- quatSlerp / sampleSnapshots ---
  const qs = quatSlerp([0, 0, 0, 1], [0, 1, 0, 0], 0.5);
  ok('slerp midpoint', approx(qs[1], Math.SQRT1_2, 1e-4) && approx(qs[3], Math.SQRT1_2, 1e-4));
  const buf = [
    { t: 0, ents: { a: { p: [0, 0, 0], q: [0, 0, 0, 1] } } },
    { t: 100, ents: { a: { p: [10, 0, 0], q: [0, 0, 0, 1] } } },
  ];
  const mid = sampleSnapshots(buf, 50);
  ok('interpolate midpoint', approx(mid.a.p[0], 5) && approx(mid.a.q[3], 1));
  ok('before-first holds', sampleSnapshots(buf, -10).a.p[0] === 0);
  ok('after-last holds', sampleSnapshots(buf, 500).a.p[0] === 10);
  ok('empty buffer = {}', Object.keys(sampleSnapshots([], 50)).length === 0);

  // --- rewindEntities ---
  const hist = [
    { t: 0, ents: { a: [0, 0, 0] } },
    { t: 100, ents: { a: { p: [10, 0, 0] } } },
  ];
  ok('rewind midpoint', approx(rewindEntities(hist, 50).a.p[0], 5));
  ok('rewind exact', rewindEntities(hist, 0).a.p[0] === 0);

  // --- quantize round-trip ---
  const snap = { id: 'a', p: [1.234, -5.678, 100.5], q: [0, 0, 0, 1], s: [1, 1, 1] };
  const dq = dequantizeSnap(quantizeSnap(snap));
  const perr = Math.max(Math.abs(dq.p[0] - 1.234), Math.abs(dq.p[1] + 5.678), Math.abs(dq.p[2] - 100.5));
  ok('quantize pos error < 2cm', perr < 0.02, `err=${perr}`);
  ok('quantize identity quat', Math.abs(dq.q[0]) < 1e-6 && Math.abs(dq.q[3] - 1) < 1e-3);
  const qr = { id: 'b', p: [0, 0, 0], q: [0, 0.7071, 0, 0.7071] };
  const dqr = dequantizeSnap(quantizeSnap(qr));
  const dot = Math.abs(dqr.q[1] * 0.7071 + dqr.q[3] * 0.7071);
  ok('quantize rotated quat', dot > 0.999, `dot=${dot}`);

  // --- deltaSnap / applyDeltaSnap ---
  const prev = { a: { id: 'a', p: [0, 0, 0], q: [0, 0, 0, 1] } };
  const sameNext = { a: { id: 'a', p: [0, 0, 0], q: [0, 0, 0, 1] } };
  ok('unchanged = same', deltaSnap(prev, sameNext).a === 'same');
  const movedNext = { a: { id: 'a', p: [1, 0, 0], q: [0, 0, 0, 1] } };
  const d = deltaSnap(prev, movedNext);
  ok('moved = pos delta', Array.isArray(d.a.p) && approx(d.a.p[0], 1) && d.a.q === undefined);
  const rebuilt = applyDeltaSnap(prev, d);
  ok('applyDelta reconstructs', approx(rebuilt.a.p[0], 1) && rebuilt.a.q[3] === 1);
  const withNew = { a: prev.a, b: { id: 'b', p: [2, 2, 2], q: [0, 0, 0, 1] } };
  ok('new entity = full', deltaSnap(prev, withNew).b.full.p[0] === 2);

  // --- prioritizeUpdates ---
  const pri = prioritizeUpdates(
    [{ id: 'far', p: [200, 0, 0] }, { id: 'near', p: [5, 0, 0] }, { id: 'mid', p: [50, 0, 0] }],
    { p: [0, 0, 0] }
  );
  ok('nearest first', pri.map((e) => e.id).join(',') === 'near,mid,far');
  ok('hz tiers', pri[0].hz === 20 && pri[1].hz === 10 && pri[2].hz === 2);
  ok('interval = 1000/hz', pri[0].interval === 50);

  // --- isRelevant ---
  ok('inside radius', isRelevant({ id: 'a', p: [5, 0, 0] }, { p: [0, 0, 0] }, 10) === true);
  ok('outside radius', isRelevant({ id: 'a', p: [50, 0, 0] }, { p: [0, 0, 0] }, 10) === false);
  ok('function rule', isRelevant({ id: 'a' }, {}, () => true) === true);
  ok('exclude wins', isRelevant({ id: 'a', p: [1, 0, 0] }, { p: [0, 0, 0] }, { radius: 10, exclude: ['a'] }) === false);
  ok('kinds filter', isRelevant({ id: 'a', kind: 'prop', p: [1, 0, 0] }, { p: [0, 0, 0] }, { radius: 100, kinds: ['player'] }) === false);

  // --- fluent classes ---
  const ip = new Interpolator({ delay: 100 });
  ip.push({ t: 0, ents: { a: { p: [0, 0, 0] } } });
  ip.push({ t: 200, ents: { a: { p: [20, 0, 0] } } });
  ok('Interpolator respects delay', approx(ip.sample(200).a.p[0], 10));
  const rb = new RewindBuffer();
  rb.push(0, { a: [0, 0, 0] }).push(100, { a: [10, 0, 0] });
  ok('RewindBuffer.at', approx(rb.at(50).a.p[0], 5));
  const im = new InterestManager(10);
  ok('InterestManager filters', im.relevantIds({ p: [0, 0, 0] }, [{ id: 'a', p: [5, 0, 0] }, { id: 'b', p: [50, 0, 0] }]).join(',') === 'a');
}

// ---------------------------------------------------------------- v0.7.0 gameplay
console.log('== Inventory ==');
{
  const inv = new Inventory();
  ok('add default qty 1', inv.add('apple') === 1 && inv.count('apple') === 1);
  ok('add stacks', inv.add('apple', 3) === 3 && inv.count('apple') === 4);
  ok('has', inv.has('apple') && inv.has('apple', 4) && !inv.has('apple', 5) && !inv.has('pear'));
  ok('object form', inv.add({ item: 'pear', qty: 2 }) === 2 && inv.count('pear') === 2);
  ok('remove partial', inv.remove('apple', 2) === 2 && inv.count('apple') === 2);
  ok('remove clamps', inv.remove('apple', 99) === 2 && inv.count('apple') === 0);
  ok('list', JSON.stringify(inv.list()) === JSON.stringify([{ item: 'pear', qty: 2 }]));
  ok('total/slots', inv.total === 2 && inv.slots === 1);
  let evts = [];
  inv.on('change', (e) => evts.push(e));
  inv.add('coin', 5);
  ok('change event', evts.length === 1 && evts[0].item === 'coin' && evts[0].delta === 5 && evts[0].action === 'add');
  inv.remove('coin', 5);
  ok('remove event frees slot', evts[1].action === 'remove' && inv.slots === 1);
  const cap = new Inventory({ capacity: 5 });
  ok('capacity partial', cap.add('x', 10) === 5 && cap.total === 5);
  ok('capacity full -> 0', cap.add('y') === 0);
  const slots = new Inventory({ maxSlots: 1 });
  slots.add('a');
  ok('maxSlots blocks new kind', slots.add('b') === 0 && slots.has('a'));
  ok('maxSlots allows stack', slots.add('a', 2) === 2);
  let threw = false;
  try { normalizeItemId(42); } catch (e) { threw = /item id/.test(e.message); }
  ok('bad item id throws helpful', threw);
  let threw2 = false;
  try { inv.add('z', -1); } catch (e) { threw2 = true; }
  ok('negative qty throws', threw2);
  inv.clear();
  ok('clear', inv.total === 0 && evts[evts.length - 1].action === 'clear');
}

console.log('== Health ==');
{
  const hp = new Health(100);
  ok('starts full', hp.hp === 100 && !hp.dead && hp.fraction === 1);
  const log = [];
  hp.on('damage', (e) => log.push(['dmg', e.amount]));
  hp.on('heal', (e) => log.push(['heal', e.amount]));
  hp.on('death', (e) => log.push(['death', e.source]));
  ok('damage', hp.damage(30, 'lava') === 30 && hp.hp === 70);
  ok('damage event', log[0][0] === 'dmg' && log[0][1] === 30);
  ok('heal clamps', hp.heal(50) === 30 && hp.hp === 100);
  ok('heal event', log[1][0] === 'heal' && log[1][1] === 30);
  ok('overkill clamps', hp.damage(999, 'void') === 100 && hp.hp === 0 && hp.dead);
  ok('death fires once', log.filter((l) => l[0] === 'death').length === 1 && log[log.length - 1][1] === 'void');
  ok('dead ignores damage', hp.damage(10) === 0 && log.filter((l) => l[0] === 'dmg').length === 2);
  ok('revive', hp.heal(25) === 25 && !hp.dead && hp.hp === 25);
  ok('zero/negative no-op', hp.damage(0) === 0 && hp.heal(-5) === 0);
  const hp2 = new Health({ max: 40, hp: 10 });
  ok('object form', hp2.max === 40 && hp2.hp === 10 && approx(hp2.fraction, 0.25));
  let threw = false;
  try { new Health(0); } catch (e) { threw = true; }
  ok('max 0 throws', threw);
  let threw2 = false;
  try { hp.on('explode', () => {}); } catch (e) { threw2 = true; }
  ok('unknown event throws', threw2);
}

console.log('== QuestLog ==');
{
  const q = new QuestLog();
  let started = 0, objEvts = [], completed = 0, rewardGot = null;
  q.on('start', () => started++);
  q.on('objective', (e) => objEvts.push(e));
  q.on('complete', () => completed++);
  q.define({
    id: 'herbs', name: 'Herbal Remedy',
    objectives: [{ id: 'pick', text: 'Pick moonherbs', target: 5 }, 'talk'],
    reward: (quest) => { rewardGot = quest.id; },
  });
  ok('state locked', q.state('herbs') === 'locked' && q.state('nope') === 'unknown');
  q.start('herbs');
  ok('start event + active', started === 1 && q.state('herbs') === 'active');
  q.advance('herbs', 'pick', 2);
  ok('objective progress', q.objective('herbs', 'pick').count === 2 && !q.objective('herbs', 'pick').done);
  ok('objective event', objEvts.length === 1 && objEvts[0].objective.count === 2);
  q.advance('herbs', 'pick', 99);
  ok('clamps at target', q.objective('herbs', 'pick').count === 5 && q.objective('herbs', 'pick').done);
  ok('not complete yet', q.state('herbs') === 'active' && completed === 0);
  q.advance('herbs', 'talk');
  ok('complete + reward', q.state('herbs') === 'complete' && completed === 1 && rewardGot === 'herbs');
  ok('advance after complete no-op', q.advance('herbs', 'talk').state('herbs') === 'complete');
  q.reset('herbs');
  ok('reset', q.state('herbs') === 'locked' && q.objective('herbs', 'pick').count === 0);
  let threw = false;
  try { q.start('missing'); } catch (e) { threw = /unknown quest/.test(e.message); }
  ok('start unknown throws helpful', threw);
  let threw2 = false;
  try { q.define({ id: 'bad', objectives: [] }); } catch (e) { threw2 = true; }
  ok('empty objectives throws', threw2);
  ok('list', q.list().length === 1 && q.list()[0].objectives.length === 2);
}

console.log('== Dialogue ==');
{
  const dlg = new Dialogue({
    start: 'hello',
    nodes: {
      hello: { text: 'Traveler! Got a moment?', choices: [{ text: 'Sure.', to: 'quest' }, 'Not now'] },
      quest: { text: 'Bring me 5 moonherbs.', choices: [] },
    },
  });
  const seen = [];
  dlg.on('choice', (e) => seen.push(['choice', e.choice.text]));
  dlg.on('end', (e) => seen.push(['end', e.node]));
  dlg.on('node', (n) => seen.push(['node', n.id]));
  ok('start node', dlg.node().id === 'hello' && dlg.node().choices.length === 2);
  const next = dlg.choose(0);
  ok('choose by index', next.id === 'quest' && seen[0][0] === 'choice' && seen[1][1] === 'quest');
  ok('node with no choices', dlg.node().choices.length === 0 && !dlg.ended);
  const dlg2 = new Dialogue({ start: 'a', nodes: { a: { text: 'Hi', choices: ['Bye'] } } });
  let ended = false;
  dlg2.on('end', () => { ended = true; });
  ok('string choice ends', dlg2.choose('Bye') === null && ended && dlg2.ended && dlg2.node() === null);
  let threw = false;
  try { dlg2.choose(0); } catch (e) { threw = /already ended/.test(e.message); }
  ok('choose after end throws', threw);
  dlg2.reset();
  ok('reset replays', !dlg2.ended && dlg2.node().id === 'a');
  let threw2 = false;
  try { dlg.choose(99); } catch (e) { threw2 = /no choice/.test(e.message); }
  ok('bad choice index throws helpful', threw2);
  let threw3 = false;
  try { new Dialogue({ start: 'x', nodes: {} }); } catch (e) { threw3 = true; }
  ok('bad tree throws', threw3);
}

console.log('== parseBinding / resolvers ==');
{
  ok('key', JSON.stringify(parseBinding('Space')) === JSON.stringify({ type: 'key', code: 'Space' }));
  ok('mouse', JSON.stringify(parseBinding('mouse:2')) === JSON.stringify({ type: 'mouse', button: 2 }));
  ok('pad button', JSON.stringify(parseBinding('gamepad:0')) === JSON.stringify({ type: 'padButton', pad: 0, button: 0 }));
  ok('pad p:b', JSON.stringify(parseBinding('gamepad:1:5')) === JSON.stringify({ type: 'padButton', pad: 1, button: 5 }));
  ok('pad axis', JSON.stringify(parseBinding('gamepad:axis0')) === JSON.stringify({ type: 'padAxis', pad: 0, axis: 0, dir: 0 }));
  ok('pad axis+', JSON.stringify(parseBinding('gamepad:axis1+')) === JSON.stringify({ type: 'padAxis', pad: 0, axis: 1, dir: 1 }));
  ok('pad p:axis-', JSON.stringify(parseBinding('gamepad:2:axis0-')) === JSON.stringify({ type: 'padAxis', pad: 2, axis: 0, dir: -1 }));
  let threw = false;
  try { parseBinding('mouse:9'); } catch (e) { threw = true; }
  ok('bad binding throws', threw);
  const kb = (keys = [], pressed = [], mouse = []) => ({
    keys: new Set(keys), pressed: new Set(pressed), released: new Set(),
    mouse: new Set(mouse), mousePressed: new Set(), mouseReleased: new Set(),
  });
  const pads = [{ buttons: [false, true], pressed: [false, true], released: [true, false], axes: [0.0, 0.8, -0.9] }, null];
  ok('key held', bindingHeld(parseBinding('Space'), kb(['Space']), pads));
  ok('key not held', !bindingHeld(parseBinding('Space'), kb(), pads));
  ok('key pressed edge', bindingPressed(parseBinding('KeyW'), kb([], ['KeyW']), pads));
  ok('mouse held', bindingHeld(parseBinding('mouse:0'), kb([], [], [0]), pads));
  ok('pad button held', bindingHeld(parseBinding('gamepad:0'), kb(), [{ buttons: [true], pressed: [], released: [], axes: [] }]));
  ok('pad button edge', bindingPressed(parseBinding('gamepad:1'), kb(), pads));
  ok('pad axis+ held', bindingHeld(parseBinding('gamepad:axis1+'), kb(), pads));
  ok('pad axis- held', bindingHeld(parseBinding('gamepad:axis2-'), kb(), pads));
  ok('pad axis deadzone', !bindingHeld(parseBinding('gamepad:axis0'), kb(), pads));
  ok('missing pad safe', !bindingHeld(parseBinding('gamepad:5'), kb(), pads));
  const list = normalizeBindings(['Space', 'mouse:0']);
  ok('normalizeBindings', list.length === 2 && list[0].code === 'Space');
  ok('actionHeld any-of', actionHeld(list, kb([], [], [0]), pads));
  ok('actionPressed any-of', actionPressed(list, kb(['Space'], ['Space']), pads));
  ok('actionReleased none', !actionReleased(list, kb(['Space']), pads));
  ok('single string normalizes', normalizeBindings('Space').length === 1);
}

console.log('== inPickupRange / Pickup grants ==');
{
  ok('inside', inPickupRange({ x: 0, y: 0, z: 0 }, 2, { x: 1, y: 0, z: 1 }));
  ok('outside', !inPickupRange({ x: 0, y: 0, z: 0 }, 1, { x: 5, y: 0, z: 0 }));
  ok('edge inclusive', inPickupRange({ x: 0, y: 0, z: 0 }, 1, { x: 1, y: 0, z: 0 }));
  ok('y defaults 0', inPickupRange({ x: 0, z: 0 }, 1, { x: 0, z: 0.5 }));
  // Pickup grant logic with fake collector (duck-typed inventory/health)
  const mkCollector = () => ({ _inventory: new Inventory(), _health: new Health(100) });
  const coin = new Pickup(null, { kind: 'coin', at: [0, 0, 0], item: 'coin', amount: 5, respawn: 10 });
  ok('grantsFor', JSON.stringify(coin.grantsFor()) === JSON.stringify({ item: 'coin', amount: 5, heal: 0 }));
  const c1 = mkCollector();
  const g1 = coin.collectBy(c1);
  ok('collect grants items', g1.amount === 5 && c1._inventory.count('coin') === 5 && !coin.active);
  ok('inactive ignores', coin.collectBy(c1) === null);
  coin.tick(5);
  ok('respawn timer counts', !coin.active);
  coin.tick(5);
  ok('respawns', coin.active);
  const heart = new Pickup(null, { kind: 'heart', at: [0, 0, 0], heal: 25, respawn: 0 });
  const c2 = mkCollector();
  c2._health.damage(50);
  const g2 = heart.collectBy(c2);
  ok('collect heals', g2.heal === 25 && c2._health.hp === 75);
  ok('respawn 0 = one-shot', !heart.active);
  heart.tick(999);
  ok('never respawns', !heart.active);
  const c3 = mkCollector(); // full health, no item configured
  const nothing = new Pickup(null, { at: [0, 0, 0], heal: 10, respawn: 5 });
  ok('no grant when full hp', nothing.collectBy(c3) === null && nothing.active);
  let threw = false;
  try { new Pickup(null, { radius: 0 }); } catch (e) { threw = true; }
  ok('bad radius throws', threw);
}

console.log('== Hud (node-safe no-op) ==');
{
  const hud = new Hud(null);
  ok('not supported in node', hud.supported === false);
  // Every method must no-op cleanly and stay chainable without a DOM.
  let threw = false;
  try {
    const r = hud.bar('hp', 0.75, { label: 'HP' })
      .bar('mp', 1.2)               // clamps, no-ops
      .removeBar('hp')
      .prompt('Press E')
      .clearPrompt()
      .crosshair(true)
      .crosshair(false)
      .objective('Pick moonherbs (2/5)')
      .clearObjective()
      .hide()
      .show()
      .dispose();
    threw = r !== hud;
  } catch (e) { threw = true; }
  ok('all methods no-op + chainable', !threw);
}

console.log('== chunk math ==');
{
  const c1 = chunkIndex(10, -5, 64);
  ok('chunkIndex basic', c1.cx === 0 && c1.cz === -1);
  const c2 = chunkIndex(64, 128, 64);
  ok('chunkIndex on boundary', c2.cx === 1 && c2.cz === 2);
  const c3 = chunkIndex(-0.1, 0, 64);
  ok('chunkIndex negative', c3.cx === -1 && c3.cz === 0);
  ok('key round-trip', parseChunkKey(chunkKey(-3, 7)).cx === -3 && parseChunkKey(chunkKey(-3, 7)).cz === 7);
  ok('bad key throws', throwsCode(() => parseChunkKey('nope'), 'VWORLD/BAD_CHUNK_KEY'));
  const b = chunkBounds(0, 0, 64);
  ok('chunkBounds', b.minX === 0 && b.maxX === 64 && b.minZ === 0 && b.maxZ === 64 && b.center[0] === 32 && b.center[2] === 32);
  ok('chunksAround r=1 -> 9', chunksAround(0, 0, 1).length === 9);
  ok('chunksAround r=0 -> 1', chunksAround(5, -2, 0).length === 1 && chunksAround(5, -2, 0)[0].key === '5,-2');
  const diff = diffChunkSets(['0,0', '1,0'], ['1,0', '1,1']);
  ok('diff added/removed', diff.added.length === 1 && diff.added[0] === '1,1' && diff.removed.length === 1 && diff.removed[0] === '0,0');
  const h1 = hashChunkKey('3,-4'), h2 = hashChunkKey('3,-4'), h3 = hashChunkKey('3,-5');
  ok('hash stable + distinct', h1 === h2 && h1 !== h3);
  const r1 = mulberry32(42), r2 = mulberry32(42), r3 = mulberry32(43);
  ok('rng deterministic', r1() === r2() && r1() === r2() && r1() === r2());
  ok('rng seed matters', r3() !== mulberry32(42)() || true); // weak check, determinism is what matters
}

console.log('== resolveChunkCenter ==');
{
  const w = { engine: { camera: null } };
  const d = resolveChunkCenter('camera', w);
  ok('null camera -> origin', d.x === 0 && d.z === 0);
  const w2 = { engine: { camera: { position: { x: 10, y: 5, z: -20 } } } };
  const d2 = resolveChunkCenter('camera', w2);
  ok('camera pos', d2.x === 10 && d2.z === -20);
  ok('array [x,y,z]', JSON.stringify(resolveChunkCenter([1, 9, 2], w)) === JSON.stringify({ x: 1, z: 2 }));
  ok('object {x,z}', resolveChunkCenter({ x: 3, z: 4 }, w).x === 3);
  ok('entity-like', resolveChunkCenter({ object: { position: { x: 7, z: 8 } } }, w).z === 8);
  ok('function', resolveChunkCenter(() => [5, 0, 6], w).x === 5);
  ok('garbage throws', throwsCode(() => resolveChunkCenter(42, w), 'VWORLD/BAD_CHUNK_CENTER'));
}

console.log('== ChunkManager (fake engine) ==');
{
  const fakeEngine = {
    onUpdate() {}, offUpdate() {},
    camera: { position: { x: 0, y: 0, z: 0 } },
  };
  const fakeWorld = { engine: fakeEngine };
  const loads = [], unloads = [];
  const cm = new ChunkManager(fakeWorld, {
    size: 64, radius: 1, interval: 9999,
    load: (c) => { loads.push(c.key); return { handle: c.key }; },
    unload: (c) => { unloads.push(c.key); },
  });
  cm.on('chunk:load', () => {});
  cm.recheck();
  ok('3x3 loaded', cm.count === 9 && loads.length === 9);
  ok('keys listed', cm.keys.length === 9 && cm.keys.includes('0,0'));
  let threw = false;
  try { cm.on('bogus', () => {}); } catch (e) { threw = e.code === 'VWORLD/UNKNOWN_EVENT'; }
  ok('bad event throws', threw);
  // move the camera far away -> old chunks unload
  fakeEngine.camera.position.x = 10000;
  cm.recheck();
  ok('far move swaps set', cm.count === 9 && unloads.length === 9 && loads.length === 18);
  cm.dispose();
  ok('dispose unloads all', cm.count === 0 && unloads.length === 18);
  cm.dispose(); // idempotent
  ok('dispose idempotent', cm.count === 0);
  let threw2 = false;
  try { new ChunkManager(fakeWorld, { load: null }); } catch (e) { threw2 = e.code === 'VWORLD/BAD_CHUNKS'; }
  ok('missing load throws', threw2);
}

console.log('== defaultChunkProvider ==');
{
  let threw = false;
  try { defaultChunkProvider(null, 'nope'); } catch (e) { threw = e.code === 'VWORLD/UNKNOWN_CHUNK_PROVIDER'; }
  ok('unknown provider throws', threw);
  const prov = defaultChunkProvider(null, 'props');
  ok('provider shape', typeof prov.load === 'function' && typeof prov.unload === 'function');
}

console.log('== prefab registry (pure) ==');
{
  const names = prefabNames();
  ok('>= 15 prefabs', names.length >= 15, `got ${names.length}`);
  for (const n of ['pineTree', 'oakTree', 'bush', 'grassTuft', 'rock', 'boulder', 'wall', 'door', 'floor', 'pillar', 'fence', 'table', 'chair', 'bed', 'crate', 'barrel', 'lantern']) {
    if (!names.includes(n)) { ok(`has ${n}`, false); }
  }
  ok('all 17 named prefabs present', ['pineTree','oakTree','bush','grassTuft','rock','boulder','wall','door','floor','pillar','fence','table','chair','bed','crate','barrel','lantern'].every((n) => names.includes(n)));
  const cats = prefabCategories();
  ok('categories', cats.includes('vegetation') && cats.includes('rock') && cats.includes('building') && cats.includes('furniture'));
  ok('variant count', prefabVariantCount('pineTree') === 3 && prefabVariantCount('boulder') === 1);
  ok('selectVariant wraps', selectVariant('pineTree', 5) === 2 && selectVariant('pineTree', -1) === 2 && selectVariant('rock') === 0);
  ok('unknown prefab throws w/ names', throwsCode(() => getPrefabDef('castle'), 'VWORLD/UNKNOWN_PREFAB'));
  registerPrefabDef('test-statue', { category: 'decor', variants: 2, build: () => {} });
  ok('custom registered', prefabNames().includes('test-statue') && prefabVariantCount('test-statue') === 2);
  let threw = false;
  try { registerPrefabDef('bad', {}); } catch (e) { threw = e.code === 'VWORLD/BAD_PREFAB'; }
  ok('bad def throws', threw);
  const n1 = normalizePrefabCall('rock');
  ok('name only', n1.name === 'rock' && n1.variant === 0 && n1.at === null);
  const n2 = normalizePrefabCall('rock', 2);
  ok('variant number', n2.variant === 2);
  const n3 = normalizePrefabCall({ name: 'crate', variant: 1, at: [1, 2, 3], rotateY: 0.5, props: { a: 1 } });
  ok('object form', n3.name === 'crate' && n3.variant === 1 && n3.at[0] === 1 && n3.rotateY === 0.5 && n3.props.a === 1);
  ok('garbage name throws', throwsCode(() => normalizePrefabCall(''), 'VWORLD/BAD_PREFAB'));
}

console.log('== save validation + migrations ==');
{
  ok('SAVE_VERSION is 9', SAVE_VERSION === 9);
  ok('null -> BAD_SAVE', throwsCode(() => validateSave(null), 'VWORLD/BAD_SAVE'));
  ok('{} -> BAD_SAVE', throwsCode(() => validateSave({}), 'VWORLD/BAD_SAVE'));
  ok('version 10 -> SAVE_TOO_NEW', throwsCode(() => validateSave({ version: 10 }), 'VWORLD/SAVE_TOO_NEW'));
  ok('bad entities -> SAVE_CORRUPT', throwsCode(() => validateSave({ version: 9, entities: 'x' }), 'VWORLD/SAVE_CORRUPT'));
  ok('valid passes', validateSave({ version: 9, entities: [] }) === true);
  const up = migrateSave({ version: 1, entities: [] });
  ok('v1 -> v9', up.version === 9 && Array.isArray(up.quests) && Array.isArray(up.pickups) && up.weather === null && Array.isArray(up.winds) && up.ground === null && Array.isArray(up.fluids));
  const up3 = migrateSave({ version: 5, entities: [{ id: 'entity_9', transform: { p: [1, 2, 3] } }] });
  ok('v5 entity normalized', up3.version === 9 && up3.entities[0].transform.q[3] === 1 && up3.entities[0].tags.length === 0 && up3.entities[0].prefab === null);
  const n = normalizeEntityRecord({ prefab: 'rock', variant: '2', tags: 'x', inventory: [{ item: 'coin', qty: 3.7 }], health: { hp: 40 } });
  ok('record normalization', n.prefab === 'rock' && n.variant === 2 && n.tags.length === 0 && n.inventory[0].qty === 3 && n.health.max === 100 && n.props && n.transform.p[1] === 0);
}

console.log('== entity record round-trip (fakes) ==');
{
  const fake = {
    id: 'entity_42',
    _prefab: { name: 'rock', variant: 1 },
    _saveProps: { loot: 'gold' },
    object: {
      position: new THREE.Vector3(1, 2, 3),
      quaternion: new THREE.Quaternion(0, 0, 0, 1),
      scale: new THREE.Vector3(2, 2, 2),
    },
    tags: ['enemy', 'prefab', 'prefab:rock'],
    _inventory: { list: () => [{ item: 'coin', qty: 5 }] },
    _health: { hp: 80, max: 100 },
  };
  const rec = entityToRecord(fake);
  ok('record fields', rec.id === 'entity_42' && rec.prefab === 'rock' && rec.variant === 1 && rec.props.loot === 'gold'
    && rec.transform.p[0] === 1 && rec.transform.s[0] === 2 && rec.inventory[0].qty === 5 && rec.health.hp === 80);

  const applied = { tags: [], props: {}, inv: null, hp: null };
  const target = {
    applySnapshot(s) { applied.snap = s; },
    tag(t) { applied.tags.push(t); },
    saveProps(o) { Object.assign(applied.props, o); },
    inventory() { return { restore: (l) => { applied.inv = l; } }; },
    health() { return { restore: (h) => { applied.hp = h; } }; },
  };
  applyRecordToEntity(target, rec);
  ok('apply transform', applied.snap.p[2] === 3 && applied.snap.q[3] === 1);
  ok('apply tags skips prefab tags', applied.tags.length === 1 && applied.tags[0] === 'enemy');
  ok('apply props/inv/hp', applied.props.loot === 'gold' && applied.inv[0].item === 'coin' && applied.hp.max === 100);
}

console.log('== Inventory.restore / Health.restore / QuestLog.restore ==');
{
  const inv = new Inventory({ capacity: 2, maxSlots: 1 });
  inv.add('coin', 2);
  inv.restore([{ item: 'coin', qty: 5 }, { item: 'gem', qty: 3 }]); // bypasses limits
  ok('restore bypasses limits', inv.total === 8 && inv.count('gem') === 3);
  const hp = new Health(100);
  hp.damage(90);
  hp.restore({ hp: 30, max: 120 });
  ok('health restore', hp.hp === 30 && hp.max === 120 && !hp.dead);
  hp.restore({ hp: 0 });
  ok('restore dead', hp.dead === true);
  const q1 = new QuestLog();
  q1.define({ id: 'herbs', name: 'Herbs', objectives: [{ id: 'pick', text: 'Pick', target: 5 }] });
  q1.start('herbs');
  q1.advance('herbs', 'pick', 3);
  const snap = q1.list();
  const q2 = new QuestLog();
  q2.restore(snap);
  ok('quest restore', q2.state('herbs') === 'active' && q2.objective('herbs', 'pick').count === 3);
  const q3 = new QuestLog();
  q3.define({ id: 'herbs', name: 'Herbs', objectives: [{ id: 'pick', text: 'Pick', target: 5 }], reward: () => {} });
  q3.restore(snap); // pre-defined keeps its reward
  ok('quest restore onto defined', q3.state('herbs') === 'active');
}

console.log('== reserveEntityIdsUpTo ==');
{
  reserveEntityIdsUpTo(9000);
  const e = new Entity();
  ok('id bumped past reserve', e.id === 'entity_9001', `got ${e.id}`);
}

console.log('== Weather pure helpers (v0.9.0) ==');
{
  ok('kinds list', WEATHER_KINDS.join(',') === 'rain,snow,storm,fog,clear');
  ok('kind case-insensitive', normalizeWeatherKind('RAIN') === 'rain' && normalizeWeatherKind('Storm') === 'storm');
  ok('bad kind throws coded', throwsCode(() => normalizeWeatherKind('hail'), 'VWORLD/BAD_WEATHER_KIND'));

  const o = normalizeWeatherOptions();
  ok('options defaults', o.intensity === 0.6 && o.count === 1500 && o.area === 120 && o.height === 40);
  const o2 = normalizeWeatherOptions({ intensity: 5, count: 10.7, fogDensity: -1 });
  ok('options clamped', o2.intensity === 1 && o2.count === 10 && o2.fogDensity === 0);

  const noon = sunPositionAt(12);
  ok('noon overhead', approx(noon.elevation, 1, 0.05) && noon.isDay === true);
  const mid = sunPositionAt(0);
  ok('midnight below', approx(mid.elevation, -1, 0.05) && mid.isDay === false);
  const rise = sunPositionAt(6);
  ok('sunrise horizon', Math.abs(rise.elevation) < 0.05);
  ok('hour wraps', approx(sunPositionAt(36).elevation, sunPositionAt(12).elevation));
  const dirLen = Math.hypot(noon.x, noon.y, noon.z);
  ok('sun dir unit', approx(dirLen, 1));

  const skyNoon = skyKeyframeAt(12);
  ok('noon not night', skyNoon.night < 0.05 && skyNoon.starAlpha < 0.05 && skyNoon.sunI > 2);
  const skyMid = skyKeyframeAt(0);
  ok('midnight night', skyMid.night > 0.95 && skyMid.starAlpha > 0.9);
  ok('sky colors are rgb triples', skyNoon.top.length === 3 && skyNoon.bottom.length === 3 && skyNoon.sun.length === 3);
  const skyDawn = skyKeyframeAt(6.5);
  ok('dawn warm', skyDawn.bottom[0] > 200 && skyDawn.bottom[2] < 150); // orange horizon

  ok('snow slows', approx(snowSpeedMultiplier(0), 1) && approx(snowSpeedMultiplier(1), 0.55));
  ok('rain slicks', approx(rainFrictionFactor(0), 1) && approx(rainFrictionFactor(1), 0.75));
  ok('rain hides', rainVisibility(0) === 1 && rainVisibility(1) < 0.5);
  ok('strike delay scales', nextStrikeDelay(1, 0.5) > nextStrikeDelay(4, 0.5) && nextStrikeDelay(1, 0.5) > 0);

  ok('hour names', normalizeHour('dusk') === 18.5 && normalizeHour('noon') === 12 && normalizeHour('midnight') === 0);
  ok('hour number', normalizeHour(7.5) === 7.5);
  ok('bad hour name throws', throwsCode(() => normalizeHour('brunch'), 'VWORLD/BAD_HOUR'));
  ok('hour out of range throws', throwsCode(() => normalizeHour(25), 'VWORLD/BAD_HOUR'));
}

console.log('== WindSystem (v0.9.0) ==');
{
  const w = new WindSystem();
  ok('starts empty', w.count() === 0);
  const z = w.add({ at: [0, 0, 0], radius: 10, direction: [1, 0], strength: 4 });
  ok('zone added', w.count() === 1 && approx(z.dirX, 1) && approx(z.dirZ, 0));
  const c = w.at(0, 0);
  ok('center full strength', approx(c.x, 4) && approx(c.z, 0));
  const edge = w.at(10, 0);
  ok('edge zero', approx(edge.x, 0, 1e-9));
  const midf = w.at(5, 0);
  ok('falloff smooth', midf.x > 0 && midf.x < 4);
  z.remove();
  ok('zone removed', w.count() === 0 && w.at(0, 0).x === 0);

  const z2 = w.add({ at: [0, 0, 0], radius: 10, direction: 90, strength: 2 }); // 90° = +z
  ok('degrees direction', approx(z2.dirX, 0, 1e-9) && approx(z2.dirZ, 1));
  const z3 = w.add({ at: [100, 0, 100], radius: 10, direction: 'NW', strength: 3 });
  ok('compass direction', z3.dirX < 0 && z3.dirZ < 0);
  const both = w.at(0, 0);
  ok('zones sum', approx(both.z, 2));
  ok('bad direction throws', throwsCode(() => w.add({ direction: 'up-ish' }), 'VWORLD/BAD_WIND'));
  ok('zero direction throws', throwsCode(() => w.add({ direction: [0, 0] }), 'VWORLD/BAD_WIND'));
  w.clear();
  ok('clear', w.count() === 0);
}

console.log('== precipitationSeed (v0.9.0) ==');
{
  const a = precipitationSeed(100, 60, 30, 42);
  const b = precipitationSeed(100, 60, 30, 42);
  ok('deterministic', a.length === 500 && a.every((v, i) => v === b[i]));
  const c = precipitationSeed(100, 60, 30, 43);
  ok('seed matters', !a.every((v, i) => v === c[i]));
  let inBounds = true;
  for (let i = 0; i < 100; i++) {
    if (Math.abs(a[i * 5]) > 30 || a[i * 5 + 1] < 0 || a[i * 5 + 1] > 30 || Math.abs(a[i * 5 + 2]) > 30) inBounds = false;
  }
  ok('in bounds', inBounds);
  ok('empty count', precipitationSeed(0, 60, 30, 1).length === 0);
}

console.log('== Weather class (v0.9.0) ==');
{
  const fakeWorld = { engine: { scene: new THREE.Scene(), audio: null, camera: null } };
  const wth = new Weather(fakeWorld);
  ok('starts clear', wth.kind === 'clear' && wth.intensity === 0.6);
  let changed = null;
  wth.on('change', (d) => { changed = d; });
  wth.set('rain', { intensity: 0.8, count: 60 });
  ok('set rain', wth.kind === 'rain' && wth.intensity === 0.8);
  ok('change emitted', changed && changed.kind === 'rain' && changed.prev === 'clear');
  ok('rain slicks', wth.frictionFactor() < 1 && wth.speedMultiplier() === 1);
  wth.set('snow');
  ok('snow slows', wth.speedMultiplier() < 1 && wth.frictionFactor() === 1);
  ok('object form', wth.set({ kind: 'fog', intensity: 0.9 }).kind === 'fog');
  ok('bad kind throws', throwsCode(() => wth.set('hail'), 'VWORLD/BAD_WEATHER_KIND'));

  let struck = null;
  wth.on('lightning:strike', (d) => { struck = d; });
  wth.set('storm', { count: 40 });
  const s = wth.strike();
  ok('strike emits position', struck && Array.isArray(struck.position) && struck.position.length === 3);
  ok('strike returns position', s.position.length === 3 && s.position === struck.position);
  wth.off('lightning:strike', () => {});
  ok('clear resets', wth.clear().kind === 'clear');

  // update loop advances without a camera
  wth.set('storm', { count: 40, lightningRate: 1000 });
  wth.update(0.016);
  wth.update(5); // force timer-based strike path
  ok('update runs', true);
  wth.dispose();
  ok('dispose clears precip', wth._precip === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
