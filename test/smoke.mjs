// VWorld Engine — durable node smoke tests (pure, DOM-free modules).
// Run: node test/smoke.mjs  (must exit 0 with 0 failures)
import * as THREE from 'three';
import { toBox3 } from '../src/util/normalize.js';
import { evaluateRuleWeight, compositeWeights, valueNoise } from '../src/Surfaces.js';
import { submergedFraction, buoyancyNetAccel } from '../src/Fluids.js';
import { VWorldError, vError, createErrorBus, reportError } from '../src/util/errors.js';
import { Profiler } from '../src/Profiler.js';
import { QUALITY_LEVELS, resolveQuality, normalizeQuality, autoStep } from '../src/util/quality.js';

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
