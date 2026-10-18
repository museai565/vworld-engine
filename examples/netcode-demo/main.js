import { Engine, applyNetInput, PREDICT_DEFAULTS } from '../../src/index.js';

// Local loopback: client predicts at 60 Hz, a fake "server" applies the same
// inputs 120 ms late, and net.correct() reconciles. No socket needed to see
// prediction + reconciliation working.
const app = Engine.create({ canvas: document.getElementById('scene') });
await app.ready;

app.world.ground({ size: 120 });

const player = app.entity().capsule(0.4, 1.2, 0x4da3ff).at([0, 1, 0]);
const ghost = app.entity().capsule(0.4, 1.2, 0xff5a5a).at([0, 1, 0]); // authoritative state

// Fake server state (same arcade mover as prediction)
const server = { p: [0, 1, 0], v: [0, 0, 0], grounded: true };
const inbox = []; // { deliverAt, seq, input }
const LATENCY = 0.12;

const keys = {};
addEventListener('keydown', (e) => (keys[e.code] = true));
addEventListener('keyup', (e) => (keys[e.code] = false));

const net = app.net;
let lastSeq = 0;

app.onFixedUpdate((dt) => {
  const move = [
    (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0),
    (keys.KeyS ? 1 : 0) - (keys.KeyW ? 1 : 0),
  ];
  // 1. predict locally — instant response
  lastSeq = net.predict(player, { move }, { dt });

  // 2. send to "server" with latency
  inbox.push({ deliverAt: performance.now() / 1000 + LATENCY, seq: lastSeq, input: { move } });

  // 3. server applies due inputs, sends authoritative snapshot back (also delayed)
  const now = performance.now() / 1000;
  let ack = 0;
  for (const m of inbox.splice(0)) {
    if (m.deliverAt <= now) {
      server.state = applyNetInput(
        { p: server.p, v: server.v, grounded: server.grounded },
        m.input, dt, PREDICT_DEFAULTS,
      );
      server.p = server.state.p; server.v = server.state.v;
      ack = m.seq;
    } else inbox.push(m);
  }
  if (ack) {
    // 4. reconcile: snap to authority, re-apply unacked inputs
    net.correct(player, { p: server.p }, ack);
    ghost.object.position.set(server.p[0], server.p[1], server.p[2]);
  }
});

app.start();
