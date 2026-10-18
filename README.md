# VWorld Engine

A Laravel-DX-flavored 3D game engine built on **Three.js** + **Rapier physics** (WASM).
Fluent, chainable APIs. Sensible defaults. One line gets a running scene.

> **Phase 1** — engine only. No game features (no chat, rooms, or prop catalog UI).
> Clean seams are exposed for Phase 2: multiplayer replication (`Net`),
> downloadable avatar packs with default fallback (`Assets.characters`),
> and prop-building tools (`Build`).

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

## Entities — fluent transforms

```js
const tower = app.entity()
  .box(2, 8, 2, 0x8a6f4d)
  .at(10, 4, -6)
  .rotateY(0.5);

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

// World gravity
app.physics.gravity(0, -9.81, 0);

// Collider wireframes (toggle)
app.physics.debug();
```

Physics runs on a fixed 60 Hz timestep with an accumulator, decoupled from
render framerate.

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

## Day / night

```js
app.world.dayNight()
  .speed(90)   // full cycle in 90 seconds
  .time(0.3)   // 0=midnight, 0.25=sunrise, 0.5=noon
  .pause();    // .resume() to continue
```

Drives the sun orbit, sky-dome gradient, fog color, and light intensity.

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
```

## Build helpers (Phase 2 primitives)

```js
app.build.gridSize(1);
const ghost = app.build.ghost(new THREE.BoxGeometry(1, 1, 1)); // translucent preview
const hit = app.build.pickScene(mouseX, mouseY);               // raycast pick
if (hit) ghost.position.copy(app.build.snapVec3(hit.point));
```

## Net (Phase 2 stub)

No transport ships in Phase 1 — but the seams are real:

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

The playground drops dynamic crates and bouncy balls with real physics,
static jump platforms, a day/night cycle, and a WASD + mouse-look
third-person player. Press `G` for collider wireframes.

## API decisions

- **Rapier via `@dimforge/rapier3d-compat`** — pure WASM, no native toolchain.
- **Full-extent collider sizes** in the builder (`.cuboid(1,1,1)` = 1 m cube).
- **Fixed-timestep physics** (60 Hz accumulator) separate from rendering.
- **Kinematic character controller** for the player (no tunneling, real collisions).
- **Character registry** bakes in the "download pack, fallback to default" rule now,
  so Phase 2 multiplayer never shows a missing avatar.
