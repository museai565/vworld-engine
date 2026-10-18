import {
  Engine, PlayerController,
  AudioPlugin, EffectsPlugin, PostPlugin, AnimationPlugin,
} from '../../src/index.js';

// --- boot -----------------------------------------------------------------
const app = Engine.create({ canvas: document.getElementById('scene') });
app.use(AudioPlugin);
app.use(EffectsPlugin);
app.use(PostPlugin);
app.use(AnimationPlugin);
await app.ready; // WASM physics ready; subsystems usable from here

// --- world: terrain + water + scatter + biome -------------------------------
const height = (x, z) => {
  const edge = Math.max(Math.abs(x), Math.abs(z));
  const hills = Math.max(0, (edge - 35) / 45); // flat in the middle, hilly outside
  let h = hills * hills * (Math.sin(x * 0.08) * Math.cos(z * 0.07) * 7 + Math.sin(x * 0.021 + 1.7) * Math.cos(z * 0.025 + 0.6) * 9);
  const dx = x - 55, dz = z - 55;             // pond bowl
  h -= 9 * Math.exp(-(dx * dx + dz * dz) / 700);
  return h;
};
app.world.terrain({ size: 320, resolution: 72, height });
app.world.water({ level: -2.5, color: 0x2e7fd9, waves: 0.5 });
app.world.scatter('pine-tree', { count: 220, area: [-150, 150, -150, 150] });
app.world.scatter('rock', { count: 60, area: [-150, 150, -150, 150] });
app.world.scatter('grass', { count: 350, area: [-120, 120, -120, 120] });
app.world.biome('desert', { area: { center: [-95, 0, 70], size: 90 } });
app.world.dayNight().speed(180).time(0.32);

// --- cinematic post -----------------------------------------------------------
app.world.post().preset('cinematic');

// --- static platforms to jump on ----------------------------------------------
function platform(x, y, z, w = 3, h = 0.6, d = 3, color = 0x8a6f4d) {
  app.entity().box(w, h, d, color).at(x, y, z);
  app.physics.body().static().cuboid(w, h, d).at(x, y, z).friction(0.9).build();
}
platform(7, 0.3, -5);
platform(11, 1.4, -9);
platform(15, 2.8, -13);
platform(-8, 0.3, -6, 4, 0.6, 4, 0x6d7c8a);

// --- dynamic boxes: real physics, falling and stacking --------------------------
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

// --- bouncy balls -----------------------------------------------------------------
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

// --- hinge door: push it and watch the joint work -----------------------------------
const doorX = 4, doorZ = -14;
app.entity().box(0.25, 2.6, 0.25, 0x5a3d24).at(doorX - 0.65, 1.3, doorZ); // posts (visual)
app.entity().box(0.25, 2.6, 0.25, 0x5a3d24).at(doorX + 0.65, 1.3, doorZ);
app.entity().box(1.55, 0.25, 0.25, 0x5a3d24).at(doorX, 2.6, doorZ);
const doorE = app.entity().box(1.1, 2.3, 0.12, 0x8a5a33).at(doorX, 1.15, doorZ);
const doorBody = app.physics.body().dynamic().cuboid(1.1, 2.3, 0.12)
  .at(doorX, 1.15, doorZ).friction(0.4).bind(doorE).build();
const hingePost = app.physics.body().static().cuboid(0.25, 2.6, 0.25)
  .at(doorX - 0.65, 1.3, doorZ).build();
app.physics.joint().hinge(doorBody, hingePost, { anchor: [doorX - 0.6, 1.15, doorZ], axis: 'y' });
app.every(6, () => doorBody.applyImpulse(2.5, 0, 1.5)); // the wind pushes it

// --- animated walker: default character, procedural walk, square patrol ---------------
const walkerGroup = await app.assets.characters.spawn('default');
const walker = app.entity().at(8, 0, 14);
walker.object.add(walkerGroup);
walker.anim().play('walk');
const waypoints = [[8, 0, 14], [-8, 0, 14], [-8, 0, 2], [8, 0, 2]];
let wi = 1;
function nextWaypoint() {
  const wp = waypoints[wi % waypoints.length];
  wi++;
  walker.lookAt(wp);
  walker.moveTo(wp, { speed: 2.4, onArrive: nextWaypoint });
}
nextWaypoint();

// --- wandering NPC with AI steering ----------------------------------------------------
const npcGroup = await app.assets.characters.spawn('default', { tint: 0xff8a5a });
const npc = app.entity().at(-6, 0, -20);
npc.object.add(npcGroup);
npc.anim().play('walk');
app.ai.agent(npc).speed(2.2).wander({ center: [-6, 0, -20], size: 44 });

// --- a campfire: repeating particle bursts -------------------------------------------------
app.every(0.12, () => {
  app.effects.burst('fire', [12, 0.4, 8]);
  if (Math.random() < 0.4) app.effects.burst('smoke', [12, 1.6, 8]);
});

// --- third-person player --------------------------------------------------------------------
const player = new PlayerController(app, { speed: 6, runSpeed: 9.5 });
player.spawn(0, 4, 10);

// --- interaction: click = unlock audio + sparkle burst + thud ----------------------------------
const canvas = document.getElementById('scene');
canvas.addEventListener('click', (e) => {
  app.input.lockPointer();
  app.audio.unlock();
  const hit = app.build.pickScene(e.clientX, e.clientY);
  if (hit) {
    app.effects.burst('sparkle', hit.point);
    app.audio.play('thud', { at: hit.point, volume: 0.5 });
  }
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyG') app.physics.debug();                    // collider wireframes
  if (e.code === 'KeyT') {                                       // toggle cinematic grade
    const post = app.world.post();
    post.enabled = !post.enabled;
  }
  if (e.code === 'KeyF') {                                       // fireworks!
    const x = (Math.random() - 0.5) * 30, z = (Math.random() - 0.5) * 30;
    app.effects.burst('fire', [x, 6, z]);
    app.audio.play('pop', { at: [x, 6, z], volume: 0.7 });
  }
  if (e.code === 'KeyM') app.audio.mute(!app.audio.muted);       // mute toggle
});

// --- go ------------------------------------------------------------------------------------------
app.start();
