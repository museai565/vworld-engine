/**
 * VWorld Engine plugins — every rich feature ships as a plugin.
 *
 *   import { AudioPlugin, EffectsPlugin, PostPlugin, AnimationPlugin } from '@vworld/engine';
 *
 *   app.use(AudioPlugin);
 *   app.use(EffectsPlugin, { maxBursts: 128 });
 *   app.use(PostPlugin);
 *   app.use(AnimationPlugin);
 *
 * Plugin contract: { name: 'audio', install(app, options) }.
 * Core never imports plugins — they attach via app.use() and the
 * app.on('tick' | 'render' | 'dispose') lifecycle hooks.
 */
export { AudioPlugin } from './audio.js';
export { EffectsPlugin } from './effects.js';
export { PostPlugin } from './post.js';
export { AnimationPlugin } from './animation.js';

/** All plugins, for `for (const p of allPlugins) app.use(p)`. */
import { AudioPlugin } from './audio.js';
import { EffectsPlugin } from './effects.js';
import { PostPlugin } from './post.js';
import { AnimationPlugin } from './animation.js';
export const allPlugins = [AudioPlugin, EffectsPlugin, PostPlugin, AnimationPlugin];
