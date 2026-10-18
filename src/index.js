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
export { Entity } from './Entity.js';
export { Physics, Body } from './Physics.js';
export { Input } from './Input.js';
export { PlayerController } from './PlayerController.js';
export { Assets } from './Assets.js';
export { Net } from './Net.js';
export { Build } from './Build.js';
export { AI, StateMachine } from './AI.js';
export { Time, EASES, easeValue } from './Time.js';
export { AudioPlugin, EffectsPlugin, PostPlugin, AnimationPlugin, allPlugins } from './plugins/index.js';
export { toVec3, toXYZ, toNumber, withDefaults, toAxis, axisToVec3 } from './util/normalize.js';

export const VERSION = '0.2.0';
