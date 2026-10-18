# Weather & atmosphere — rain, storms, wind, day/night

## Weather kinds

```js
app.weather('clear');
app.weather('rain', { intensity: 0.8 });
app.weather('snow', { intensity: 0.5 });
app.weather('storm');                       // rain + lightning + thunder
app.weather('fog', { density: 0.02 });

app.weather().on('lightning:strike', ({ position }) => {
  app.decal({ preset: 'scorch', position, normal: [0, 1, 0], size: 3 });
});
```

Precipitation is GPU-shader driven (one draw call per system). Storms pick
random strike points; thunder is a distance-delayed sound, not a sample —
position a `AudioPlugin` listener and it just works.

## Gameplay hooks

Weather isn't decoration — it feeds systems:

```js
app.weather().speedMultiplier();  // snow slows entities (< 1)
app.weather().frictionFactor();    // rain slicks surfaces
```

Multiply your movement code by these and storms change how the game plays.

## Wind zones

```js
world.wind({ at: [0, 0, 0], radius: 60, direction: 'NE', strength: 3 });
world.wind({ at: [30, 0, -10], radius: 20, direction: 90, strength: 5 }); // degrees
world.clearWind();

const w = world.windAt(player.position); // THREE.Vector3 — push flags, boats, particles
```

Direction accepts compass (`'N'`, `'SE'`), degrees (0° = +x east), or `[x, z]`.
Wind drifts AI agents, pushes fluid surface current, and scatters precipitation.

## Day / night polish

```js
app.world.dayNight().speed(120);   // full cycle = 120 s
app.timeOfDay(18.5);               // 0–24 hours…
app.timeOfDay('dusk');             // …or a name: dawn, morning, noon,
                                   // afternoon, evening, dusk, midnight
```

The sun follows a real path, sky colors keyframe through palettes, stars fade
in at night, and the moon rises opposite the sun. Chain it all:

```js
app.weather('storm').timeOfDay('dusk'); // app.weather() is chainable when setting
```
