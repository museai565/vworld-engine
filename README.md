# VWorld Engine

A Laravel-DX-flavored 3D game engine built on **Three.js** + **Rapier physics** (WASM).
Fluent, chainable APIs. Sensible defaults. One line gets a running scene.

> **v0.4.0 — production hardening.** TypeScript definitions for the full
> public API, a central error bus (`app.onError`) with machine-readable
> error codes, full resource disposal (`entity.dispose()` / `app.dispose()`)
> with debug-mode leak detection, WebGL context-loss recovery, adaptive
> render quality (`app.quality('auto')`), and a zero-dependency frame
> profiler (`app.profiler()`).
>
> **v0.3.0 — surfaces & fluids.** Rule-blended terrain materials (the floor
> IS grass/sand/rock/snow — splat mapping), custom surface kinds, and game
> fluids: volumes with buoyancy, currents, viscosity, damage, splash/exit
> events, and animated surfaces — water, lava, mud, oil, or your own types.
> All behind one DX law: **normalize, don't complain.**
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

## Terrain surfaces — the floor IS its material

Instead of scattering decoration, the terrain surface itself is a rule-blended
mix of material kinds (splat mapping). Pass `surface` to `terrain()`:

```js
app.world.terrain({
  size: 400, height: (x, z) => hills(x, z),
  surface: [
    { kind: 'grass' },                                          // base layer
    { kind: 'sand', where: { nearFluid: 'water', within: 6 } },  // beaches
    { kind: 'rock', where: { slope: { min: 0.55 } } },           // steep faces
    { kind: 'snow', where: { height: { min: 60 } } },           // peaks
    { kind: 'mud',  where: { noise: { scale: 0.05, threshold: 0.63 } } },
  ],
});
```

`where` conditions AND together and blend smoothly; later rules win ties
(standard over-compositing). Supported conditions:

- `slope: { min, max, softness }` — gradient magnitude, 0 = flat
- `height: { min, max, softness }` — world-space Y
- `nearFluid: 'name-or-type', within: <meters>` — distance to a fluid volume
- `noise: { scale, threshold, softness }` — organic patches (deterministic)

A rule with no `where` covers everything — use it as the base. Built-in
kinds: `grass | dirt | sand | rock | snow | mud` (procedural canvas textures,
zero downloads). Register your own:

```js
app.world.surfaceKind('moss', { color: 0x3d6b2f, roughness: 1 });
// app.world.surfaceKinds() lists everything registered
```

Up to 8 kinds per terrain. `nearFluid` works no matter which order you create
things in — adding a fluid automatically refreshes terrain weights. Omit
`surface` entirely for the classic single-color vertex path.

## Fluids — volumes with behavior

An honest note first: these are **game fluids, not Navier-Stokes**. Real
fluid simulation doesn't run in real time in a browser at world scale. VWorld
fluids are volumes with physical *behavior* — buoyancy, currents, viscosity —
plus animated surfaces and splash hooks. This is what actual games do.

```js
// Box shapes: Box3 | [x0,y0,z0,x1,y1,z1] | { min, max } | { center, size }
const lake = app.world.fluid({
  name: 'lake', type: 'water',
  box: { center: [55, -5.5, 55], size: [70, 6, 70] },
  flow: [0.4, 0.15],                       // current pushes bodies (x, z)
});

// Events — splash FX hooks straight into the effects plugin:
lake.on('splash', (body, info) => {
  app.effects.burst({ type: 'splash', at: info.point, /* ... */ });
  app.audio.play('pop', { at: info.point, volume: 0.35 });
});
lake.on('enter', (body, info) => { /* ... */ });
lake.on('exit', (body, info) => { /* ... */ });
lava.on('damage', (body, info) => {
  console.log('burning!', info.amount);    // info.amount = damage this tick
});
lake.on('cameraUnder', (inside) => {
  app.world.post().preset(inside ? 'dreamy' : 'cinematic'); // dive tint
});
```

Per-fluid physics, applied every fixed tick to dynamic bodies:

- **Buoyancy** — bodies float/sink by body density vs fluid density
  (a default-density crate bobs; a dense one sinks; lava at 2.4 floats almost
  everything while burning it)
- **Flow** — the `flow` current pushes submerged bodies
- **Viscosity** — exponential drag; mud (20) stops you cold, water (1) barely
- **Damage** — `damage` per second while submerged past 25%

Built-in types: `water | lava | mud | oil`. Register your own:

```js
app.world.fluidType('acid', { color: 0x7CFC00, density: 1.1, viscosity: 3, damage: 5, glow: false });
// per-fluid overrides work too: world.fluid({ type: 'water', density: 1.2, box })
```

Fluid definitions: `{ color, density, viscosity, damage, glow, opacity, waves, speed }`.
`fluid.topY`, `fluid.box`, `fluid.destroy()` round out the API.

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

**Action mapping (v0.7.0)** — bind names to keyboard / mouse / gamepad once, read actions everywhere. Gamepads are polled automatically every frame.

```js
app.input.map({
  jump:  ['Space', 'gamepad:0'],      // keyboard OR pad button 0
  fire:  ['mouse:0', 'gamepad:7'],    // mouse OR pad button 7
  left:  ['KeyA', 'gamepad:axis0-'],  // key OR left stick left
  right: ['KeyD', 'gamepad:axis0+'],
});
app.input.action('jump');          // held?
app.input.actionPressed('fire');   // pressed this frame?
app.input.actionAxis('left', 'right'); // -1..1 from two actions
```

Binding strings: `'Space'` (keyboard `event.code`), `'mouse:0'` (0=left 1=middle 2=right), `'gamepad:0'` (pad 0 button 0), `'gamepad:1:5'` (pad 1 button 5), `'gamepad:axis0'` / `'gamepad:axis1+'` / `'gamepad:2:axis0-'`. The pure resolvers (`parseBinding`, `bindingHeld`, `actionHeld`, …) are exported for tests and custom loops.

## Gameplay systems (v0.7.0)

Everything a small game needs, with the same normalize-don't-complain DX. Pure logic (inventory math, health, quest state machine, dialogue walker, binding resolution) is DOM/THREE-free and unit-tested in `test/smoke.mjs`.

**Inventory** — stackable items, capacity limits, change events:

```js
const inv = player.inventory({ capacity: 99, maxSlots: 12 }); // lazy, per-entity
inv.on('change', ({ item, delta, total }) => hud.bar('weight', total / 99));
inv.add('coin', 5);   // add('coin') and add({ item: 'coin', qty: 5 }) work too
inv.has('coin', 3);   // true
inv.remove('coin', 2);
inv.count('coin');    // 3
inv.list();           // [{ item: 'coin', qty: 3 }]
```

**Health / damage** — damage, heal, death events; lava and other damaging fluids hurt entities automatically:

```js
const hp = player.health(100);
hp.on('damage', ({ amount, hp }) => hud.bar('hp', hp / 100));
hp.on('death', () => respawn(player));
hp.damage(30, { source: 'lava' });
hp.heal(10);
hp.dead; // false
```

**Pickups** — auto-collect zones that grant items/health and respawn:

```js
world.pickup({ kind: 'coin', at: [10, 1, 4], radius: 1.6, item: 'coin', amount: 5, respawn: 12 });
world.pickup({ kind: 'heart', at: [4, 1, -8], heal: 25, respawn: 20,
               onCollect: ({ entity }) => app.effects.burst({ type: 'sparkle', at: entity }) });
```

**Quests** — definitions, objective progress, completion rewards:

```js
const q = app.quests();
q.define({ id: 'herbs', name: 'Herbal Remedy',
           objectives: [{ id: 'pick', text: 'Pick moonherbs', target: 5 }],
           reward: () => player.inventory().add('potion') });
q.on('objective', ({ objective }) => hud.objective(`${objective.text} (${objective.count}/${objective.target})`));
q.on('complete', ({ quest }) => hud.objective(''));
q.start('herbs');
q.advance('herbs', 'pick', 2);
q.state('herbs'); // 'locked' | 'active' | 'complete'
```

**Dialogue trees** — node/choice walker for NPCs:

```js
const dlg = app.dialogue({
  start: 'hello',
  nodes: {
    hello: { text: 'Traveler! Got a moment?',
             choices: [{ text: 'Sure.', to: 'quest' }, 'Not now'] }, // string choice ends the branch
    quest: { text: 'Bring me 5 moonherbs.', choices: [] },
  },
});
dlg.on('choice', ({ choice }) => console.log('picked:', choice.text));
dlg.on('end', () => console.log('conversation over'));
dlg.choose(0); // or choose('Sure.')
```

**HUD** — DOM overlay helpers; every method chains and safely no-ops in node (no DOM):

```js
const hud = app.hud();
hud.bar('hp', player.health().fraction, { label: 'HP', color: '#e5484d' });
hud.prompt('Press E to talk');   // hud.clearPrompt()
hud.crosshair(true);
hud.objective('Pick moonherbs (2/5)'); // hud.clearObjective()
hud.hide(); hud.show();          // toggle everything
```

**Gamepad** — see Input above. Pads are polled in the frame loop (`input.gamepads` lists them); bindings unify keyboard, mouse, and pad buttons/axes under action names.

## Build helpers (game-layer primitives)

```js
app.build.gridSize(1);
const ghost = app.build.ghost(new THREE.BoxGeometry(1, 1, 1)); // translucent preview
const hit = app.build.pickScene(mouseX, mouseY);               // raycast pick
if (hit) ghost.position.copy(app.build.snapVec3(hit.point));
```

## Netcode (v0.6.0)

No transport ships in the engine — the game layer owns its socket — but everything around it is real now: prediction, interpolation, lag compensation, interest management, and bandwidth savers. All math is pure and exported for tests.

```js
// --- client-side prediction: move instantly, reconcile on server truth ---
const seq = net.predict(player, { move: [0, -1], sprint: true }, { dt: 1 / 60 });
socket.send({ type: 'input', seq, input });          // server acks with last seq
// on authoritative snapshot:
net.correct(player, serverSnap, ackSeq);            // snap + re-apply unacked inputs

// --- interpolation: smooth remote entities, 100ms behind newest snapshot ---
const interp = net.interpolate({ delay: 100 });
socket.on('snapshot', (s) => interp.push(s));
interp.apply(remoteEntitiesById);                   // per frame

// --- lag compensation (server): rewind for fair hit tests ---
const rw = net.rewind({ historyMs: 1000 });
rw.push(now, { [id]: entity.object.position });      // per tick
const past = rw.at(shotTime - ping / 2);            // test the hit here

// --- interest: only replicate what's relevant ---
const im = net.interest({ radius: 60, kinds: ['player', 'prop'] });
const visible = im.relevant(playerEntity, allEntities);

// --- bandwidth: deltas, quantization, prioritization ---
const d = net.delta(prevSnaps, nextSnaps);          // 'same' | 'full' | { p:[dx,dy,dz] }
const wire = net.quantize(snap);                    // fixed-point pos, smallest-three quat
const rates = net.prioritize(viewer, entities);     // [{ id, dist, hz, interval }]
```

Notes:

- `net.predict` input accepts `'forward'`/`'back'`/`'left'`/`'right'`, `[x, z]`, `{ x, z }`, or `{ move, jump, sprint }` — always world-space (convert camera-relative input first). The arcade mover (`speed/accel/friction/gravity/jumpSpeed`) is tunable per call.
- `net.correct` emits `net:corrected` with `{ entity, ackSeq, reapplied }` so you can hide the pop.
- Interpolation lerps positions and slerps quaternions between the two snapshots bracketing render time; times outside the buffer hold the nearest end.
- Quantization defaults: 16-bit positions over ±512 m (< 2 cm error), 10-bit smallest-three quaternions.
- The old hooks still work unchanged: `net.on('entity:update', …)`, `net.serialize(entity)`, `net.applySnapshot(entity, snap)`.
- Honest boundary: game netcode, not a networking paper — no encryption, no cheat-proofing, no clock sync. Pair with your transport's acks and RTT.

## Production hardening (v0.4.0)

### TypeScript definitions

The full public API ships with types at the package root (`"types": "index.d.ts"`):

```ts
import { Engine, VWorldError, type QualityMode } from '@vworld/engine';

const app = Engine.create({ canvas: document.querySelector('canvas')! });
const level: QualityMode = 'auto';
app.quality(level).start();
```

### Error handling — the error bus

Every internal catch site (event handlers, plugin installs, `moveTo` arrival
callbacks, entity contact listeners) reports to a central bus instead of
dropping errors into the void:

```js
app.onError((err) => {
  console.log(err.code, err.message); // 'VWORLD/EVENT_HANDLER_THREW', ...
  sendToTelemetry(err);
});
app.offError(myHandler); // unsubscribe; both are chainable
```

With no handlers registered, errors fall back to `console.error` — nothing is
ever silently swallowed. Thrown validation errors keep their messages, and
key ones are `VWorldError` with machine-readable codes:

| Code | When |
|---|---|
| `VWORLD/MISSING_CANVAS` | `Engine.create()` without a `<canvas>` |
| `VWORLD/APP_DISPOSED` | `start()` / `entity()` after `app.dispose()` |
| `VWORLD/BAD_PLUGIN` | `app.use()` got a malformed plugin object |
| `VWORLD/PLUGIN_INSTALL_FAILED` | a plugin's `install()` threw during `app.use()` (also re-thrown, with the original as `.cause`) |
| `VWORLD/UNKNOWN_EVENT` | `app.on()` with an unknown event name |
| `VWORLD/EVENT_HANDLER_THREW` | a subscribed engine-event handler threw |
| `VWORLD/PHYSICS_NOT_READY` | physics touched before `await app.ready` |
| `VWORLD/BODY_NOT_BOUND` | `body.on()` before `.bind(entity)` |
| `VWORLD/BAD_BODY` | a joint builder got a non-Body argument |
| `VWORLD/PLUGIN_MISSING` | `entity.anim()` without the animation plugin |
| `VWORLD/UNKNOWN_QUALITY` | `app.quality()` got an unknown level |
| `VWORLD/BAD_QUALITY` | `app.quality()` got an unreadable value |

```js
import { VWorldError } from '@vworld/engine';
try { await app.ready; /* ... */ }
catch (err) {
  if (err instanceof VWorldError && err.code === 'VWORLD/PHYSICS_NOT_READY') { /* ... */ }
}
```

### Disposal

`entity.dispose()` is full teardown — frame/move tickers, geometries,
materials **and textures**, the bound physics body (removed via the body's
own API), engine untracking, and scene removal. It's idempotent:

```js
const crate = app.entity().box(1, 1, 1, 0xff5a5a);
// later…
crate.dispose();
```

`entity.destroy()` still works but is deprecated (one-time `console.warn`) —
it now just calls `dispose()`.

`app.dispose()` tears everything down: fires `'dispose'` (plugins clean up
first), disposes every entity still alive, stops the loop, removes the
resize **and** WebGL-context listeners, disposes the renderer, and clears
plugin/event/updater maps. Double-dispose is a safe no-op. After dispose,
`start()` throws `VWORLD/APP_DISPOSED` — build a new `Engine` instead:

```js
window.addEventListener('beforeunload', () => app.dispose());
```

### Debug mode — leak detection

```js
const app = Engine.create({ canvas, debug: true });
// or: app.debug(true).debug(false) — chainable toggle
```

In debug mode the engine tracks entities created via `app.entity()`. On
`app.dispose()` it warns once listing any entities that were never disposed
(up to 10 ids plus the count):

```
[VWorld] debug: 3 entities were not disposed before app.dispose(): entity_7, entity_12, entity_31
```

### Adaptive quality

```js
app.quality('low');            // pixelRatio 1, shadows off
app.quality('medium');         // pixelRatio min(dpr, 1.5), shadows on
app.quality({ level: 'auto' }); // object form also accepted
app.quality();                 // => 'high' — current effective level
```

`'auto'` starts at high and samples FPS over rolling 2-second windows in the
frame loop: average under 45 steps down a level; average over 57 for 3
consecutive windows steps back up. Level changes apply pixel ratio + shadows
immediately. Default is `'high'` (unchanged behavior).

### Profiler

```js
const prof = app.profiler();
prof.begin('npcThink');
// ... work ...
prof.end('npcThink');

console.log(prof.summary());
// fixed: avg 0.42ms max 1.10ms (60 calls) | frame: avg 0.80ms max 1.42ms (60 calls) | render: avg 1.05ms max 2.30ms (60 calls)

prof.report();  // { fixed: { avgMs, maxMs, calls }, ... }
prof.reset();   // clear all samples
prof.enabled = false; // begin()/end() become no-ops
```

The engine measures `'fixed'` (fixed updaters + physics step), `'frame'`
(input + frame updaters + world update), and `'render'` itself. Each section
keeps a rolling window of the last 120 samples. Pure logic, no DOM.

### WebGL context-loss recovery

The engine listens for `webglcontextlost` on the canvas: it prevents the
default, pauses the loop (remembering whether it was running), and emits
`'contextlost'`. On `webglcontextrestored` it refreshes the renderer size,
resumes the loop if it was running, and emits `'contextrestored'`:

```js
app.on('contextlost', () => showOverlay('GPU context lost — waiting…'));
app.on('contextrestored', () => hideOverlay());
```

Both listeners are removed by `app.dispose()`.

## Rendering richness (v0.5.0)

### Instanced meshes — crowds, forests, debris in one draw call

```js
// Positional or object form — both fine.
const trees = app.instanced(geo, mat, 500)
  .scatter({ box: [-60, 60], y: 0, scale: [0.7, 1.4] })
  .addTo(app);

// …or place instances by hand:
trees.set(0, { at: [10, 0, 5], scale: 2, rotate: [0, 1.2, 0] }).update();

const crowd = app.instanced({ geometry: bodyGeo, material: skinMat, count: 200 });
crowd.scatter({ box: { x: [-20, 20], z: [0, 40] }, count: 200, y: [0, 0.5], spin: [0, Math.PI * 2] });
```

`set(i, { at, scale, rotate })` batches matrix updates — call `.update()`
once when done (`.scatter()` does it for you). `frustumCulled` is off by
default (a crowd's instances span the world; the geometry bounds would lie).
Tracked and disposed with the app.

### LOD — distance-based mesh switching

```js
entity.lod([
  { distance: 0,   mesh: hiDetail },  // or [0, hiDetail]
  { distance: 60,  mesh: loDetail },
  { distance: 150, mesh: null },       // hidden beyond 150
]);
```

Levels are sorted automatically; `mesh` accepts a `THREE.Object3D`, an
`Entity`, or `null` (culled). Meshes are reparented under the entity and
visibility flips on camera distance each frame. `entity.lodIndex` reports the
active level; the ticker is removed on `dispose()`.

### Decals — bullet holes, scorch marks

```js
app.decal({ preset: 'scorch', position: hitPoint, normal: hitNormal, size: 2.5 });
app.decal({ preset: 'bullet', position: hitPoint, normal: hitNormal, size: 0.6,
            lifetime: 45, fade: 5 });   // fades out over the last 5 s, then gone
app.decal({ texture: myTex, position, normal, size: [2, 4] });
```

Quads are nudged off the surface along the normal (no z-fighting) with
`polygonOffset` and `depthWrite: false`. Presets are procedural canvas
textures (`'scorch'`, `'bullet'`); pass your own `THREE.Texture` for anything
else. `lifetime <= 0` (default) = permanent.

### Clouds + light shafts

```js
app.clouds({ count: 60, area: 500, height: [100, 160], speed: 3, opacity: 0.85 });
// Deterministic layout from `seed` (default 1337) — same sky every load.

app.lightShaft({ from: [0, 30, 0], to: [0, 0, 0], radius: 6, intensity: 0.4 })
  .intensity(0.6);   // chainable brightness
```

Clouds are billboard sprites drifting +X and wrapping around the area.
Shafts are additive cones (narrow at `from`, wide at `to`) with a fresnel-ish
edge fade — fake volumetrics, no render targets. Both are tracked and disposed
with the app.

### Material presets

```js
app.material('brass');                    // tuned MeshStandardMaterial
app.material('glass', { opacity: 0.5 });  // overrides merge over the preset
app.material({ preset: 'wood', color: 'red' });  // color takes any color shape
```

Presets: `metal`, `chrome`, `gold`, `brass`, `copper`, `glass`, `water`,
`plastic`, `rubber`, `wood`, `stone`, `grass`, `paper`, `emissive`.
Unknown names throw listing every valid name.

### Shadow tuning

```js
app.shadows({ mapSize: 4096, bias: -0.0002, bounds: 90 });
app.shadows({ mapSize: [2048, 2048],
              bounds: { left: -40, right: 40, top: 60, bottom: -60 } });
app.shadows();  // => current settings as a plain object
```

Applies to the sun's shadow camera (bounds + near/far + projection update)
and map (size, bias, normalBias, radius). Chainable when applying.

### `toColor` normalizer

New in the normalize law: `toColor(0xff0000)`, `toColor('#ff0000')`,
`toColor('red')`, `toColor(new THREE.Color())`, `toColor({ r, g, b })` — all
yield a fresh `THREE.Color`. Garbage throws a helpful error.

## Demo playground

```bash
npm run dev      # open http://localhost:5173
npm run build    # production build -> dist/
```

The playground now showcases v0.3.0: rule-blended terrain (grass meadow →
sandy shore → rocky slope → snowy peak, mud patches), a lake fluid with a
bobbing low-density crate and splash FX on entry, a lava pool that chars and
damages whatever touches it, camera-underwater grade switching, scattered
pines/rocks/grass, a desert biome tint, day/night cycle, cinematic post grade
(toggle with `T`), dynamic crates + bouncy balls, a swinging hinge door, a
campfire (particles), a patrolling animated character, a wandering AI NPC,
and a physics player. Click the scene for sparkles + positional thuds
(`F` for fireworks, `M` to mute, `G` for wireframes).

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
