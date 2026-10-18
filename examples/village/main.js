import { Engine, PlayerController, mulberry32 } from '../../src/index.js';

const app = Engine.create({ canvas: document.getElementById('scene') });
await app.ready;

app.world.ground({ size: 600 });
app.world.dayNight().speed(300);
app.clouds({ count: 16, area: 500, height: 100, speed: 2, seed: 4 });

const player = new PlayerController(app);
player.spawn(0, 3, 0);

const chunkLabel = document.getElementById('chunks');
const live = new Map(); // chunkKey -> entities[]

// Deterministic content per chunk: seeded by chunk coords
function spawnChunkContent(chunk) {
  const rand = mulberry32(chunk.x * 73856093 ^ chunk.z * 19349663);
  const ents = [];
  const cx = chunk.x * 64, cz = chunk.z * 64;
  const n = 3 + Math.floor(rand() * 4);
  for (let i = 0; i < n; i++) {
    const x = cx + (rand() - 0.5) * 60, z = cz + (rand() - 0.5) * 60;
    const r = rand();
    const name = r < 0.4 ? 'pineTree' : r < 0.6 ? 'oakTree' : r < 0.75 ? 'rock' : r < 0.9 ? 'bush' : 'boulder';
    ents.push(app.world.prefab(name, { variant: Math.floor(rand() * 3), at: [x, 0, z], rotateY: rand() * 6.28 }));
  }
  // Village center chunk gets buildings
  if (chunk.x === 0 && chunk.z === 0) {
    ents.push(app.world.prefab('wall', { at: [-6, 1.5, 0], rotateY: 0 }));
    ents.push(app.world.prefab('wall', { at: [6, 1.5, 0], rotateY: 0 }));
    ents.push(app.world.prefab('floor', { at: [0, 0.1, 0] }));
    ents.push(app.world.prefab('table', { at: [0, 0, 0] }));
    ents.push(app.world.prefab('chair', { at: [2, 0, 1], rotateY: 2 }));
    ents.push(app.world.prefab('lantern', { at: [0, 0, 4] }));
    ents.push(app.world.prefab('fence', { at: [-10, 0.5, -8], rotateY: 0.4 }));
  }
  live.set(chunk.key, ents);
  chunkLabel.textContent = String(live.size);
}

app.world.chunks({
  size: 64,
  radius: 2,
  center: player.entity,          // chunks follow the player automatically
  load: spawnChunkContent,
  unload: (chunk) => {
    for (const e of live.get(chunk.key) ?? []) e.dispose();
    live.delete(chunk.key);
    chunkLabel.textContent = String(live.size);
  },
});

const stream = app.world.chunks({
  size: 64,
  radius: 2,
  center: player.entity,          // chunks follow the player automatically
  load: spawnChunkContent,
  unload: (chunk) => {
    for (const e of live.get(chunk.key) ?? []) e.dispose();
    live.delete(chunk.key);
    chunkLabel.textContent = String(live.size);
  },
});
stream.on('chunk:load', ({ key }) => console.log('chunk in:', key));

app.quality('auto');
app.start();
