# Core concepts — World, Entity, Physics

## World

`app.world` owns the scene: terrain, fluids, sky, wind, weather, pickups,
chunks, and save/load.

```js
const world = app.world;

// Terrain from a height function — the floor IS its material (see Rendering)
world.terrain((x, z) => Math.sin(x * 0.1) * Math.cos(z * 0.1) * 4);

// A lake: a fluid volume with buoyancy, flow, splash events
world.fluid({ kind: 'water', at: [0, 0, 0], size: [40, 2, 40] });

// Surface rules: what the ground looks like where
world.surfaceKind('sand', { nearFluid: 3, slope: [0, 0.3] });
```

## Entity

`app.entity()` is the universal object — mesh, transform, events, tags,
LOD, inventory, health. Everything chainable:

```js
const crate = app.entity()
  .box(1, 1, 1, 0xff5a5a)   // geometry + color in one call
  .at([3, 0.5, -2])         // position (any shape)
  .rotateY(0.4)
  .tag('prop')              // tags for queries
  .on('click', () => crate.dispose());

crate.onUpdate((dt) => crate.rotateY(dt)); // per-frame hook
```

Shape helpers: `.box()`, `.sphere()`, `.cylinder()`, `.capsule()`,
`.mesh(geometry, material)` for custom geometry.

Transforms: `.at()`, `.moveBy()`, `.moveTo(target, { speed, onArrive })`,
`.rotation()`, `.rotateX/Y/Z()`, `.scale()`, `.lookAt()`, `.show()/.hide()`.

Serialization (the netcode wire format): `entity.serialize()` →
`{ id, position, quaternion, scale }`; `entity.applySnapshot(snap)` applies one.

## Physics

Rapier without the ceremony. Bodies are built fluently and bind to entities:

```js
const body = app.physics.body()
  .cuboid(0.5, 0.5, 0.5)   // collider shape
  .dynamic()               // static() | kinematicPosition()
  .density(1).friction(0.6).restitution(0.2)
  .at([0, 5, 0])
  .bind(crate)             // body drives the entity's transform
  .build();

body.applyImpulse(0, 5, 0);
body.teleport(10, 2, 10);
body.destroy();            // remove from the physics world
```

Joints, sensors, springs, hinges, and arcade vehicles:

```js
app.physics.joint(hinge).build();          // connect two bodies
app.physics.sensor().cuboid(2,2,2).at(p).on('enter', cb).build();
app.physics.vehicle({ wheels: 4 }).throttle(1).steer(-0.3);
```

`app.physics.step` is automatic in the fixed loop; `app.physics.debug(true)`
draws colliders. Character controllers: `new PlayerController(app)` —
kinematic capsule, WASD + jump, camera follow.

## Events

Everything emits: `entity.on('damage', ...)`, `world.on('chunk:load', ...)`,
`app.on('contextlost', ...)`, `app.net.on('entity:update', ...)`.
`app.onError(fn)` catches all internal errors (see Production).
