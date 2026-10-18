import { Engine, PlayerController } from '../../src/index.js';

// --- boot ---------------------------------------------------------------
const app = Engine.create({ canvas: document.getElementById('scene') });
await app.ready; // WASM physics ready; subsystems usable from here

// --- world: ground + day/night -------------------------------------------
app.world.ground({ size: 160, color: 0x4d7c43 });
app.world.dayNight().speed(120).time(0.3); // 2-minute days, start in the morning

// --- static platforms to jump on ------------------------------------------
function platform(x, y, z, w = 3, h = 0.6, d = 3, color = 0x8a6f4d) {
  app.entity().box(w, h, d, color).at(x, y, z);
  app.physics.body().static().cuboid(w, h, d).at(x, y, z).friction(0.9).build();
}
platform(7, 0.3, -5);
platform(11, 1.4, -9);
platform(15, 2.8, -13);
platform(-8, 0.3, -6, 4, 0.6, 4, 0x6d7c8a);

// --- dynamic boxes: real physics, falling and stacking ----------------------
const palette = [0x8844ff, 0xff5a5a, 0xffc93c, 0x3fa7ff, 0x51e08a];
for (let i = 0; i < 10; i++) {
  const s = 0.8 + Math.random() * 0.7;
  const x = (Math.random() - 0.5) * 12;
  const z = (Math.random() - 0.5) * 12;
  const y = 7 + i * 1.6;
  const color = palette[i % palette.length];
  const e = app.entity().box(s, s, s, color).at(x, y, z).rotateY(Math.random());
  app.physics
    .body().dynamic()
    .cuboid(s, s, s)
    .at(x, y, z)
    .friction(0.5)
    .restitution(0.15)
    .bind(e)
    .build();
}

// --- a couple of bouncy balls for fun ---------------------------------------
for (let i = 0; i < 3; i++) {
  const x = -6 + i * 3;
  const e = app.entity().sphere(0.5, 0xff8a3c).at(x, 6 + i * 2, 6);
  app.physics
    .body().dynamic()
    .ball(0.5)
    .at(x, 6 + i * 2, 6)
    .friction(0.4)
    .restitution(0.75)
    .bind(e)
    .build();
}

// --- third-person player ------------------------------------------------------
const player = new PlayerController(app, { speed: 6, runSpeed: 9.5 });
player.spawn(0, 4, 10);

// --- input niceties -----------------------------------------------------------
const canvas = document.getElementById('scene');
canvas.addEventListener('click', () => app.input.lockPointer());
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyG') app.physics.debug(); // toggle collider wireframes
});

// --- go ------------------------------------------------------------------------
app.start();
