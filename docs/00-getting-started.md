# Getting started — VWorld Engine v1.0

VWorld is a Three.js + Rapier (WASM) 3D engine with a fluent, Laravel-style API.
One call does one thing, everything chainable, and every public function accepts
many input shapes ("normalize, don't complain").

## Install

```bash
npm install @vworld/engine
```

The engine bundles Three.js; Rapier's WASM loads automatically at boot.

## Your first scene — 10 lines

```js
import { Engine, PlayerController } from '@vworld/engine';

const app = Engine.create({ canvas: document.getElementById('scene') });
await app.ready;                    // Rapier WASM ready — physics usable now

app.world.ground({ size: 200 });    // flat green ground, 200×200 m
app.world.dayNight().speed(120);    // full day = 120 s

const player = new PlayerController(app); // WASD + Space, third-person
player.spawn(0, 3, 8);

app.entity().box(2, 2, 2, 0xff5a5a).at([5, 1, -3]); // a red crate

app.start();                        // 60 Hz fixed-step loop starts
```

## The normalize law

Position-like arguments accept every shape — the engine converts, never complains:

```js
entity.at(1, 2, 3);
entity.at([1, 2, 3]);
entity.at({ x: 1, y: 2, z: 3 });
entity.at(otherEntity.position);
```

Same for colors (`0xff0000`, `'#f00'`, `'red'`, `{r,g,b}`, `THREE.Color`),
directions (`'N'`, degrees, `[x, z]`), and times (`18.5`, `'dusk'`).

## The loop

`app.start()` runs a fixed-timestep loop:

- `onFixedUpdate(fn)` — physics-rate callbacks (movement, AI).
- `onUpdate(fn)` — per-frame callbacks (visuals, HUD).
- `app.stop()` pauses; `app.start()` resumes.

## Where next

- [Core concepts](01-core-concepts.md) — World, Entity, Physics
- [Production](02-production.md) — errors, disposal, adaptive quality, profiler
- [Rendering](03-rendering.md) — instancing, LOD, decals, clouds, materials
- [Netcode](04-netcode.md) — prediction, interpolation, lag compensation
- [Gameplay](05-gameplay.md) — inventory, health, quests, dialogue, HUD
- [Persistence](06-persistence.md) — save/load, chunk streaming, prefabs
- [Weather](07-weather.md) — rain, storms, wind, day/night
- [Migration from 0.x](08-migration-from-0x.md) — upgrading old code
