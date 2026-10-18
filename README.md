# VWorld Engine

A Laravel-DX-flavored 3D game engine built on **Three.js** + **Rapier physics** (WASM).
Fluent, chainable APIs. Sensible defaults. One line gets a running scene.

> **v0.2.0 — the grand engine.** Plugin system, audio, particles,
> post-processing, skeletal + procedural animation, joints, sensors, vehicles,
> terrain/water/biomes, NPC AI, and a time/tween toolkit — all behind one DX
> law: **normalize, don't complain.**
>
> Phase 1 scope still holds: engine only. No game features (no chat, rooms, or
> prop catalog UI). Clean seams are exposed for the game layer: multiplayer
> replication (`Net`), downloadable avatar packs with default fallback
> (`Assets.characters`), and prop-building tools (`Build`).

## Install

```bash
npm install
```

## Boot — one line to a running scene

```js
import { Engine } from '@vworld/engine';

const app = Engine.create({ canvas: document.querySelector('canvas') }).start();
```

`start()` waits for Rapier's WASM init internally, so you never have to.
`await app.ready` first if you want to add things before the loop begins:

```js
const app = Engine.create({ canvas });
await app.ready;

app.world.ground({ size: 200, color: 0x4d7c43 });
app.world.dayNight().speed(120).time(0.3); // 2-minute days, start at morning

app.start();
```

## The normalize law

Every public function accepts every sensible input shape. Positions especially:

```js
entity.at(1, 2, 3);          // separate numbers
entity.at([1, 2, 3]);        // array
entity.at({ x: 1, y: 2 });   // object (y defaults to 0)
entity.at(new THREE.Vector3(1, 2, 3));
entity.at(otherEntity);      // uses its world position
```

This works for `at`, `moveBy`, `lookAt`, `moveTo`, `goto`, effect positions,
audio positions — everywhere a position makes sense. Unreadable input throws
a *helpful* error naming what you passed and what was expected. The helpers
live in `util/normalize.js` (`toVec3`, `toXYZ`, `toNumber`, `withDefaults`,
`toAxis`) and are exported for your own code too.

## Plugins — how the engine grows

Rich features ship as plugins. Core never imports them; they attach via
`app.use()` and the lifecycle hooks:

```js
import { AudioPlugin, EffectsPlugin, PostPlugin, AnimationPlugin } from '@vworld/engine';

app.use(AudioPlugin);
app.use(EffectsPlugin, { maxBursts: 128 }); // options, Laravel-config style
app.use(PostPlugin);
app.use(AnimationPlugin);

app.on('tick', (dt) => { /* every frame, before render */ });
app.on('render', (dt) => { /* every frame, after render */ });
app.on('dispose', () => { /* on app.dispose() */ });
app.using('audio'); // -> true — was it installed?
```

Writing your own:

```js
export const MyPlugin = {
  name: 'my-feature',            // installing twice warns and skips
  install(app, options = {}) {
    app.myFeature = new MyFeature(app, options);
    app.on('tick', (dt) => app.myFeature.update(dt));
    app.on('dispose', () => app.myFeature.dispose());
  },
};
```

House rules every plugin follows (and every contributor should):
1. **Fluent chainables** — every setter returns `this`.
2. **Sensible defaults** — works with zero config: `app.use(AudioPlugin)` is enough.
3. **Namespaced** — `app.audio`, `app.effects`, never globals or monkey-patches.
4. **Normalize, don't complain** — accept every input shape via the shared normalizers.
5. **Clear errors** — `entity.anim()` without the plugin says exactly what's missing.

## Audio — Web Audio with game-DX

```js
app.use(AudioPlugin);
app.audio.unlock(); // call from a click handler (browser rule)

app.audio.register('laser', 'sfx/laser.mp3');
app.audio.play('thud');                              // built-in synth SFX
app.audio.play('laser', { at: enemy, volume: 0.6 });   // positional (follows entities!)
app.audio.play('laser', { at: [10, 1, 5], loop: true, fade: 2, rate: 1.2 });
const music = await app.audio.ambient('forest.mp3', { volume: 0.3 });
app.audio.zone({ min: [-10, 0, -10], max: [10, 6, 10] }, 'cave'); // reverb volume
app.audio.volume(0.8).mute(true);
```

Built-in synthesized SFX (zero files): `thud`, `click`, `pop`, `whoosh`.
Positional sources use HRTF panning; the listener follows the camera every
frame. `play()` returns `{ stop(fade?), setVolume(v), node }`. Node-safe:
no-ops with a warning outside browsers.

## Effects — particles

```js
app.use(EffectsPlugin);

app.effects.burst('fire');                    // preset, at origin
app.effects.burst('fire', [10, 1, 5]);        // any toVec3 shape
app.effects.burst('fire', enemy);             // Entity works
app.effects.burst({ type: 'smoke', at, count: 200, color: 0x555555,
                    size: 2, lifetime: 4, spread: 1.5, rise: 2 });
const trail = app.effects.trail(player, 'sparkle'); // emits while moving
trail.stop();
app.effects.clear('fire');                    // remove by tag (preset names auto-tag)
```

Presets: `fire`, `smoke`, `sparkle`, `dust` (see `app.effects.presets`).
Points-based, one draw call per burst.

## Post-processing — cinematic grading

```js
app.use(PostPlugin);

app.world.post()
  .bloom(0.6).vignette(0.35).saturation(1.15)
  .grain(0.05).contrast(1.05).brightness(0.02);
app.world.post().preset('cinematic'); // vibrant | noir | dreamy | none
app.world.post().enabled = false;     // bypass, render normally
```

EffectComposer chain (bloom + custom grade shader). If the GPU can't do it,
it warns once and the engine renders exactly as before — graceful degrade.

## Animation — clips + procedural fallback

```js
app.use(AnimationPlugin);

app.animation.register('dance', danceClip);   // THREE.AnimationClip
avatar.userData.clips = { dance: danceClip }; // per-entity clips work too

const a = someEntity.anim();
a.play('walk');
a.play('walk', { speed: 1.5, loop: true, fade: 0.25 });
a.blend('walk', 'run', 0.6);                  // skeletal cross-blend
a.on('finished:jump', () => a.play('idle'));  // non-looping clips
a.stop();
```

No clips? `'idle' | 'walk' | 'run'` always work procedurally — the built-in
default character bobs, leans, and sways with zero assets.

## Entities — fluent transforms, polymorphic

```js
const tower = app.entity()
  .box(2, 8, 2, 0x8a6f4d)
  .at(10, 4, -6)          // any toVec3 shape
  .rotateY(0.5);

tower.tag('enemy');                 // tags for filtered events
tower.attach(childA, childB);       // or attach([childA, childB])
tower.lookAt(player);               // any toVec3 shape
tower.moveTo([20, 0, -10], { speed: 4, arrive: 0.3, onArrive: (e) => e.hide() });

tower.onUpdate((dt, e) => e.rotateY(dt * 0.2)); // per-frame hook
tower.destroy(); // dispose + unhook
```

## Physics — Rapier without the ceremony

Sizes are **full extents** (ruler measurements), halved internally.

```js
// A dynamic 1m crate that falls and stacks for real
const crate = app.entity().box(1, 1, 1, 0xff5a5a).at(0, 6, 0);
app.physics.body()
  .dynamic()                 // .static() or .kinematicPosition()
  .cuboid(1, 1, 1)
  .at(0, 6, 0)
  .friction(0.5)
  .restitution(0.2)
  .bind(crate)               // sync the mesh every physics step
  .build();

app.physics.gravity(0, -9.81, 0);
app.physics.debug();         // collider wireframes (toggle)
```

Physics runs on a fixed 60 Hz timestep with an accumulator, decoupled from
render framerate.

### Contacts, sensors, joints

```js
// Collision events (needs a body bound to the entity)
crate.tag('player');
wall.on('collide', (other, started) => console.log('hit!', other?.id, started));
wall.on('collide:player', (other) => console.log('a player hit the wall'));

// Trigger volumes — no physical response, just enter/exit
const zone = app.entity().box(6, 3, 6, 0x35e08a).at(0, 1.5, 0).hide();
app.physics.body().static().cuboid(6, 3, 6).at(0, 1.5, 0)
  .sensor(true).bind(zone).build()
  .on('enter', (other) => console.log('entered:', other?.id))
  .on('exit', (other) => console.log('left'));

// Joints — hinge a door to its frame
app.physics.joint()
  .hinge(doorBody, frameBody, { anchor: [4, 1.2, -8], axis: 'y' });
app.physics.joint()
  .spring(bodyA, bodyB, { stiffness: 60, damping: 6, restLength: 2 });
app.physics.joint().fixed(a, b);   // weld
app.physics.joint().ball(a, b, { anchor: [0, 2, 0] }); // ball-and-socket
```

> Joint limits aren't exposed by the bundled Rapier 0.14 build — passing
> `limits` warns once and creates the joint without them.

### Vehicles — arcade raycast car

```js
const car = app.physics.vehicle(chassisBody, { wheels: 4 }); // or custom wheel list
car.throttle(1);   // -1..1
car.steer(-0.3);   // -1..1
```

Forward is the body's local +Z. Wheels are logical raycasts (suspension
spring + damper per wheel); attach your own visual wheels and read
`car.wheelSpin` to rotate them. Arcade handling, stays planted.

## Player controller — third-person, physics-based

```js
import { PlayerController } from '@vworld/engine';

const player = new PlayerController(app, { speed: 6, runSpeed: 9.5 });
player.spawn(0, 3, 8);

// WASD/arrows move (camera-relative), Space jumps, Shift sprints.
// Click the canvas, then:
app.input.lockPointer(); // mouse-look
```

Movement is solved through Rapier's character controller against a kinematic
body — the player collides instead of tunneling.

## World — terrain, water, biomes

```js
// Heightfield terrain with a MATCHING Rapier collider (not just visual!)
app.world.terrain({
  size: 400, resolution: 96,
  height: (x, z) => Math.sin(x * 0.05) * Math.cos(z * 0.06) * 8,
});
app.world.groundHeight(12, -7); // sample the height function anywhere

app.world.water({ level: 1.5, color: 0x2e7fd9, waves: 0.6 }); // animated shader

app.world.registerKind('oak', () => app.entity().box(1, 3, 1, 0x6b4a2f)); // custom
app.world.scatter('pine-tree', { count: 300, area: [-150, 150, -150, 150] });
app.world.scatter('rock', { count: 60, area: { center: [0, 0, 0], size: 200 } });
// built-ins: pine-tree, rock, grass — skipped below the waterline by default

app.world.biome('desert', { area: { center: [120, 0, 40], size: 160 } });
// built-ins: desert | forest | snow | volcanic | meadow — or { color: 0x... }
```

Area shapes everywhere: `[minX, maxX, minZ, maxZ]` | `{ min, max }` | `{ center, size }`.

## Day / night

```js
app.world.dayNight()
  .speed(90)   // full cycle in 90 seconds
  .time(0.3)   // 0=midnight, 0.25=sunrise, 0.5=noon
  .pause();    // .resume() to continue
```

Drives the sun orbit, sky-dome gradient, fog color, and light intensity.

## AI — steering agents

```js
const npc = app.ai.agent(someEntity).speed(3.5);
npc.goto([50, 0, 30]);                 // any toVec3 shape, arrival callback optional
npc.goto(player, { onArrive: (a) => a.stop() });
npc.wander({ center: [0, 0, 0], size: 60 });
npc.follow(player, 4);                 // keep 4m back
npc.flee(danger);                      // repaths continuously

npc.state({
  idle:  { enter(a) {}, update(dt, a) {} },
  chase: { update(dt, a) { a.goto(player); } },
});
npc.when(() => playerNear(), 'chase'); // transitions checked each tick
npc.to('idle');
npc.stop();
```

Movement shape-casts against the Rapier world every step — agents slide
along walls instead of tunneling. (Pair with a kinematic body for full
rigid-body response.)

## Time — scheduling + tweening

```js
app.after(2, () => door.open());                    // once
const h = app.every(1, () => spawner.tick());       // repeat…
h.cancel();                                         // …until cancelled

app.tween(entity)
  .to({ at: [10, 0, 0], opacity: 0, scale: 1.5 }, 2)
  .ease('outCubic')                                 // linear | inQuad | outQuad |
  .then(() => entity.destroy());                    // inOutQuad | inCubic | outBack | outElastic…
```

## Assets — cached loading + character packs

```js
const tree = await app.assets.load('models/tree.glb'); // cached, GLTF or texture
```

Character packs follow PUBG semantics — download cosmetics, fall back to the
built-in default when a pack isn't local:

```js
app.assets.characters.registerPack('cyber-ninja', { url: 'chars/ninja.glb' });
await app.assets.characters.downloadPack('cyber-ninja');
const avatar = await app.assets.characters.spawn('some-pack-id'); // default if missing
```

## Input

```js
app.input.key('KeyW');        // held?
app.input.pressed('Space');   // pressed this frame?
app.input.axis('KeyA', 'KeyD'); // -1..1
app.input.lockPointer();      // pointer lock for mouse-look
app.input.enabled = false;    // freeze game input (e.g. while typing in chat)
```

## Build helpers (game-layer primitives)

```js
app.build.gridSize(1);
const ghost = app.build.ghost(new THREE.BoxGeometry(1, 1, 1)); // translucent preview
const hit = app.build.pickScene(mouseX, mouseY);               // raycast pick
if (hit) ghost.position.copy(app.build.snapVec3(hit.point));
```

## Net (game-layer stub)

No transport ships in the engine — but the seams are real:

```js
net.on('entity:update', (snap) => { /* apply */ });
const snap = net.serialize(entity);   // { id, p, q, s } wire format
net.applySnapshot(entity, snap);
```

## Demo playground

```bash
npm run dev      # open http://localhost:5173
npm run build    # production build -> dist/
```

The playground now showcases v0.2.0: heightfield terrain with a pond,
scattered pines/rocks/grass, a desert biome, day/night cycle, cinematic
post grade (toggle with `T`), dynamic crates + bouncy balls, a swinging
hinge door, a campfire (particles), a patrolling animated character, a
wandering AI NPC, and a physics player. Click the scene for sparkles +
positional thuds (`F` for fireworks, `M` to mute, `G` for wireframes).

## API decisions

- **Rapier via `@dimforge/rapier3d-compat`** — pure WASM, no native toolchain.
- **Full-extent collider sizes** in the builder (`.cuboid(1,1,1)` = 1 m cube).
- **Fixed-timestep physics** (60 Hz accumulator) separate from rendering.
- **Kinematic character controller** for the player (no tunneling, real collisions).
- **Heightfield terrain**: verified mapping — `scale` is the *total* extent,
  `heights[ix*(n+1)+iz]` with x from ix, z from iz (empirically confirmed
  against the bundled Rapier 0.14 build).
- **Normalize, don't complain** — shared normalizers (`util/normalize.js`)
  give every API multi-shape inputs with helpful errors.
- **Plugins over core bloat** — audio/effects/post/animation attach via
  `app.use()` + lifecycle hooks; core stays small.
- **Joint limits** are not exposed by Rapier 0.14's JS bindings — accepted
  but warn once.
- **Character registry** bakes in the "download pack, fallback to default"
  rule, so multiplayer never shows a missing avatar.
