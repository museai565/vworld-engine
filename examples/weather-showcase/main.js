import { Engine } from '../../src/index.js';

const app = Engine.create({ canvas: document.getElementById('scene') });
await app.ready;

app.world.ground({ size: 220 });
app.world.dayNight().speed(240);
app.clouds({ count: 20, area: 380, height: 90, speed: 3, seed: 11 });
app.lightShaft({ from: [30, 60, -20], to: [30, 0, -20], radius: 8, color: '#fff2cc', intensity: 0.4 });

// A wind zone so precipitation visibly drifts
app.world.wind({ at: [0, 0, 0], radius: 120, direction: 'NE', strength: 2.5 });

// Lightning strikes leave scorch marks
app.weather().on('lightning:strike', ({ position }) => {
  app.decal({ preset: 'scorch', position, normal: [0, 1, 0], size: 4, lifetime: 120, fade: 10 });
});

// A few trees + a lantern for scale
for (const [x, z] of [[-14, 6], [9, -11], [18, 14], [-6, -18]]) {
  app.world.prefab('pineTree', { at: [x, 0, z] });
}
app.world.prefab('lantern', { at: [0, 0, 8] });

const kinds = ['clear', 'rain', 'snow', 'storm', 'fog'];
let dusk = false;
addEventListener('keydown', (e) => {
  const i = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4 }[e.code];
  if (i !== undefined) app.weather(kinds[i], { intensity: 0.8 });
  if (e.code === 'KeyD') { dusk = !dusk; app.timeOfDay(dusk ? 'dusk' : 'noon'); }
});

app.quality('auto');
app.start();
