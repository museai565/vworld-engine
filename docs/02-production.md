# Production — errors, disposal, quality, profiler

## Error handling

All internal errors are coded and routed through one bus:

```js
app.onError((err) => {
  console.error(err.code, err.message); // e.g. 'VWORLD/PHYSICS_NOT_READY'
});
app.offError(fn); // unsubscribe
```

`VWorldError` carries `.code` (`VWORLD/...`) and `.details`. With no handlers
registered, errors fall back to `console.error` — nothing is ever swallowed.
Throw your own with the same shape:

```js
import { vError } from '@vworld/engine';
throw vError('VWORLD/SAVE_CORRUPT', 'save data failed validation', { version });
```

Save/load validation throws coded errors (`VWORLD/SAVE_VERSION_UNKNOWN`,
`VWORLD/SAVE_INVALID`, …) — see Persistence.

## Disposal & leak detection

```js
entity.dispose();      // removes tickers, geometries, materials, physics body
app.dispose();         // tears down everything; start() after throws VWORLD/APP_DISPOSED
```

`entity.destroy()` is a deprecated alias (warns once, still works).

Dev-mode leak detection — run with `debug: true` during development:

```js
const app = Engine.create({ canvas, debug: true });
// ... on shutdown, console warns with the ids of undisposed entities
```

Rule of thumb: whatever you create per-frame or per-event (decals, particles,
temporary entities), dispose it.

## WebGL context loss

The engine survives GPU resets: on `webglcontextlost` it pauses and emits
`'contextlost'`; on restore it resizes, resumes, and emits `'contextrestored'`.

```js
app.on('contextlost', () => saveDraftLocally());
app.on('contextrestored', () => console.log('GPU back'));
```

## Adaptive quality

```js
app.quality('high');   // or 'medium' | 'low'
app.quality('auto');   // steps down <45fps, up >57fps — pixel ratio + shadows + effects
app.quality({ level: 'medium' });
```

`'auto'` is the right default for anything you ship.

## Profiler

```js
const p = app.profiler();
p.begin('ai'); runAI(); p.end('ai');
console.log(p.summary()); // per-section avg ms over a 120-sample window
p.reset();
```

The loop already measures `fixed`, `frame`, and `render` sections for you.
