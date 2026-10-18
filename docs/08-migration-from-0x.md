# Migration from 0.x → 1.0

v1.0.0 is additive — **no API was removed**. The only renamed method has a
working shim, so 0.x code runs unchanged. This guide covers the one rename
and the recommended modernizations.

## The one rename: `entity.destroy()`

```js
// 0.x — still works, warns once in the console
entity.destroy();

// 1.0 — the canonical name
entity.dispose();
```

Replace `destroy()` with `dispose()` at your leisure; nothing breaks either way.
(Note: `physics.body().destroy()` and `vehicle.destroy()` were *not* renamed —
they remove the object from the physics world, which is what "destroy" means
there.)

## Recommended modernizations

```js
// Error handling — subscribe once at boot
app.onError((err) => reportToSentry(err));

// Adaptive quality for shipped games
app.quality('auto');

// Replace manual try/catch around saves with coded errors
try { world.load(data); }
catch (err) {
  if (err.code === 'VWORLD/SAVE_VERSION_UNKNOWN') promptNewGame();
}

// Input rebinding instead of hardcoded keys
app.input.map({ jump: ['Space', 'gamepad:0'] });
if (app.input.action('jump')) player.jump();
```

## Deprecation policy (v1.x)

- **v1.x keeps every v1.0.0 public API working.** New features are additive.
- If an API must be renamed, the old name becomes a shim that warns once and
  keeps working for the whole v1 series.
- Breaking changes happen only in a major version (v2), with a migration guide
  like this one published alongside.
- Pure utility exports (`toVec3`, `quantizeSnap`, `chunkKey`, …) are frozen too —
  their signatures won't change in v1.x.

## Checklist

- [ ] Replace `entity.destroy()` → `entity.dispose()` (optional; shim covers you)
- [ ] Add `app.onError()` reporting
- [ ] Set `app.quality('auto')` for production builds
- [ ] Re-export anything you imported from deep paths (`src/...`) — import from
      `@vworld/engine` instead; the public surface is `src/index.js` (+ `index.d.ts`)
