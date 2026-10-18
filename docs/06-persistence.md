# Persistence & streaming — save/load, chunks, prefabs

## Versioned save / load

```js
const data = world.save();              // { version: 9, entities, terrain, fluids, weather, ... }
localStorage.setItem('slot1', JSON.stringify(data));

const raw = JSON.parse(localStorage.getItem('slot1'));
world.load(raw);                        // auto-migrates older versions, warns
```

- `SAVE_VERSION` is 9. Every bump ships a `migrate(prev)` function; loading an
  old save walks the chain v1→v9 automatically.
- Corrupt data throws coded errors: `VWORLD/SAVE_VERSION_UNKNOWN`,
  `VWORLD/SAVE_INVALID`.
- Entity ids are stable across save/load, so netcode and quests keep working.
- `entity.saveProps({ custom: 'data' })` stashes game state into the record;
  `entity.prefabInfo()` reports which prefab (if any) spawned it.

## Chunk streaming

```js
world.chunks({
  size: 64, radius: 3,                  // 3 chunks around the focus in each direction
  load: (chunk) => spawnChunkContent(chunk),   // chunk: { x, z, key, bounds }
  unload: (chunk) => despawn(chunk),
});
world.on('chunk:load', ({ chunk }) => {});
world.on('chunk:unload', ({ chunk }) => {});
```

Chunk math is pure and tested: `chunkIndex(x, size)`, `chunkKey(x, z)`,
`chunksAround(cx, cz, radius)`, `diffChunkSets(a, b)`. A deterministic seeded
provider (`defaultChunkProvider`) gives repeatable terrain/scatter per chunk —
same seed, same chunk, every load.

## Prefab library

17 built-ins across vegetation, rocks, building parts, furniture:

```js
world.prefab('pineTree');                            // default variant
world.prefab('rock', 2);                             // variant as number
world.prefab('lantern', { variant: 1, at: [4, 0, -2], rotateY: 0.5 });
world.prefabNames();                                 // all names
```

`barrel, bed, boulder, bush, chair, crate, door, fence, floor, grassTuft,
lantern, oakTree, pillar, pineTree, rock, table, wall`.

Register your own:

```js
world.registerPrefab('statue', {
  category: 'decor', variants: 2,
  build: (world, entity, variant) => {
    entity.box(1, 2, 1, 0x888888).at([0, 1, 0]);
  },
});
```

Unknown names throw with the full valid list — no silent typos.
