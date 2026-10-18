# Rendering — instancing, LOD, decals, clouds, shafts, materials

## Instancing (crowds & forests in one draw call)

```js
const trees = app.instanced(treeGeo, treeMat, 500);
trees.scatter({ box: [-100, 0, -100, 100, 0, 100], count: 500, y: 0, scale: [0.8, 1.4] });
trees.set(12, { at: [3, 0, 4], scale: 1.2, rotate: [0, 1.2, 0] });
trees.at(7).moveBy([0, 0, 5]);   // chainable per-instance cursor
trees.update();                  // flush matrices
```

## LOD

```js
entity.lod([
  { distance: 0,  mesh: highDetail },
  { distance: 40, mesh: lowDetail },
  { distance: 120, mesh: null },   // culled beyond 120 m
]);
entity.lodIndex; // currently active level (for debugging)
```

## Decals

```js
app.decal({ preset: 'scorch', position: hitPoint, normal: hitNormal, size: 2 });
app.decal({ preset: 'bullet', position, normal, lifetime: 30, fade: 5 });
```

`app.build.pick()` returns a world-space `normal`, so click-to-scorch is two lines.

## Clouds & light shafts

```js
app.clouds({ count: 24, area: 400, height: 80, speed: 2, seed: 7 });
app.lightShaft({ from: [10, 30, 10], to: [10, 0, 10], radius: 6, color: '#fff2cc', intensity: 0.5 });
```

## Material presets

```js
app.material('brass');                       // tuned MeshStandardMaterial
app.material('glass', { color: '#aaccff' }); // overrides merge
```

Presets: `metal, chrome, gold, brass, copper, glass, water, plastic, rubber,
wood, stone, grass, paper, emissive`. Unknown names throw, listing valid ones.

## Shadow tuning

```js
app.shadows({ mapSize: 2048, bias: -0.0005, normalBias: 0.02, bounds: 60 });
app.shadows(); // returns current config
```

## Terrain surfaces — the floor IS its material

Splat-mapped rules blend built-in kinds (`grass, dirt, sand, rock, snow, mud`)
by slope, height, noise, and distance to fluid:

```js
world.surfaceKind('snow',  { height: [12, 20] });
world.surfaceKind('rock',  { slope: [0.5, 1] });
world.surfaceKind('sand',  { nearFluid: 4 });
world.registerKind('lavaRock', { color: 0x331111, roughness: 1 }); // custom
```

## Fluids — volumes with behavior

```js
world.fluidType('acid', { density: 900, damage: 10 }); // custom type
world.fluid({ kind: 'lava', at: [20, 0, 20], size: [10, 2, 10] });
world.on('fluid:enter', ({ fluid, entity }) => splash(entity));
```

Buoyancy follows density, flow pushes, viscosity drags, and lava damages
entities with health (see Gameplay). Game fluids, not Navier-Stokes.
