# Netcode — prediction, interpolation, lag compensation

The engine ships real netcode math (all pure, THREE-free, unit-tested) but no
transport — plug in your own socket. The reference pattern is the authoritative
server in `vworld-game/server`: 20 Hz snapshots, clients predict + reconcile.

## Client prediction

```js
const seq = app.net.predict(playerEntity, { move: [0, 0, 1], jump: true }, { dt: 1/60 });
// ... send { seq, input } to the server
// ... on authoritative snapshot:
app.net.correct(playerEntity, authSnapshot, ackSeq); // snaps + re-applies unacked inputs
app.net.on('net:corrected', ({ error }) => { /* rubber-band smoothing */ });
```

Prediction is translation-only with an arcade mover (speed/accel/friction/
gravity/jump tunable) — right for character controllers. `predict` takes
**world-space** move vectors; transform camera-relative input first.

## Remote entity interpolation

```js
const interp = app.net.interpolate({ delay: 0.1 });
socket.on('snapshot', (snap) => interp.push(snap));
app.onUpdate(() => interp.apply(remoteEntity)); // lerp pos, slerp rotation
```

## Lag compensation (server-side)

```js
const rewind = app.net.rewind({ historyMs: 1000 });
rewind.push(now, positionsByEntityId);       // every server tick
// on a hit claim at time t:
const past = rewind.at(t);                  // entity positions as the shooter saw them
if (hitTest(past)) applyDamage();
```

## Interest management

```js
app.net.interest(60);                                   // radius in meters
app.net.interest({ radius: 80, kinds: ['player','prop'], exclude: ['fx'] });
app.net.interest((viewer, entity) => customRelevance(viewer, entity));
```

## Bandwidth savers

```js
const delta = app.net.delta(prevSnap, snap);  // 'same' | 'full' | { dPos, ... }
app.net.applyDelta(prevSnap, delta);          // reconstruct
const q = app.net.quantize(snap);             // 16-bit positions over ±512 m,
app.net.dequantize(q);                        // smallest-three quaternions
app.net.prioritize(viewer, entities);         // near 20 Hz / mid 10 Hz / far 2 Hz
```

## Honest limits

Game netcode, not a networking paper: no encryption, no cheat-proofing, no
clock sync. Prediction isn't coupled to Rapier — physics-driven props should
stay server-authoritative. Nothing here has been live-tested in a browser;
the two-client playtest is on you.
