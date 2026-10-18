# Changelog

All notable changes to VWorld Engine. The public API is frozen for the entire
v1 series — see the [deprecation policy](README.md#api-freeze--deprecation-policy).

## v1.0.0

- API freeze for v1.x + deprecation policy.
- `docs/`: 9 full guides (getting started through weather + migration from 0.x).
- Examples gallery: 5 runnable demos (`playground`, `weather-showcase`, `netcode-demo`, `village`, `quest-playground`) + `scripts/build-examples.mjs`.
- vworld-game upgraded onto the v1.0 APIs.

## v0.9.0 — Weather & atmosphere

- `app.weather('rain'|'snow'|'storm'|'fog'|'clear')` with shader-driven GPU precipitation (camera-following, deterministic layout).
- Storms: lightning flashes, `lightning:strike` events, distance-delayed positional thunder.
- Wind zones (`world.wind`, `world.windAt`) — push precipitation, drift AI agents, add surface current to fluids.
- Day/night polish: sun path, sky color keyframes, stars, a moon riding opposite the sun; `app.timeOfDay()` accepts hours or names.
- Gameplay hooks: snow slows entities, rain slicks friction and cuts visibility.
- Save format v9 — weather + wind zones round-trip through `world.save()`/`world.load()`.

## v0.8.0 — Persistence & streaming

- `world.save()` / `world.load()`: the whole world as versioned plain JSON (entities, terrain, fluids, weather, quests, pickups) with v1→v8 migrations and coded save errors.
- Chunk streaming: `world.chunks()` loads/unloads content by distance, with a deterministic seeded default provider.
- 17-prefab library (vegetation, rocks, building parts, furniture) with variants + `world.registerPrefab()` for customs.

## v0.7.0 — Gameplay systems

- Inventory (stackable, capacity/slot limits, change events), health/damage/death, pickups (auto-collect, respawn), quests (objectives, rewards), dialogue trees, HUD helpers (node-safe), gamepad support.
- `app.input.map()` — unified action rebinding across keyboard, mouse, and gamepad.

## v0.6.0 — Netcode

- Client-side prediction with server reconciliation, entity interpolation, lag-compensation rewind buffer for server hit tests, interest management, bandwidth savers (delta compression, 16-bit quantization, update prioritization).
- All network math as pure, THREE-free, unit-tested functions.

## v0.5.0 — Rendering richness

- Instanced meshes (`app.instanced`) for crowds/vegetation, LOD system (`entity.lod`), decals (scorch/bullet presets), procedural clouds, volumetric-style light shafts, 14 material presets, shadow tuning, `toColor` normalizer.

## v0.4.0 — Production hardening

- TypeScript definitions for the full public API, central error bus (`app.onError`) with machine-readable `VWORLD/...` codes, full resource disposal (`entity.dispose()` / `app.dispose()`) with debug-mode leak detection, WebGL context-loss recovery, adaptive render quality (`app.quality('auto')`), zero-dependency frame profiler (`app.profiler()`).

## v0.3.0 — Surfaces & fluids

- Rule-blended terrain surface materials via splat mapping (the floor IS grass/sand/rock/snow — blended by slope/height/nearFluid/noise) + custom surface kinds.
- Fluid system: typed volumes (water/lava/mud/oil + custom types) with buoyancy, flow currents, viscosity drag, damage ticks, splash/enter/exit events, animated surfaces.

## v0.2.0 — Plugins & world life

- Plugin system via `app.use()` + lifecycle hooks.
- New plugins: Audio (positional HRTF, synth SFX, reverb zones), Effects (GPU particles, trails), Post (bloom + grade presets), Animation (clip blending + procedural fallback).
- Physics: joints, sensors, arcade raycast vehicle. World: heightfield terrain + collider, animated water, scatter/biomes. AI agents (goto/wander/follow/flee + state machine). Time helpers (`after`/`every`/`tween`).

## v0.1.0 — Engine core

- Initial release: 60 Hz engine loop, World (sky, day/night), Entity (fluent transforms, serialize/snapshot), Rapier physics bodies, Input, third-person PlayerController, Assets + character registry with procedural fallback, Net event stubs, Build helpers (grid snap, ghost preview).
