import { Engine, PlayerController } from '../../src/index.js';

const app = Engine.create({ canvas: document.getElementById('scene') });
await app.ready;

app.world.ground({ size: 160 });
app.world.dayNight().speed(300);
app.weather('clear');

const player = new PlayerController(app);
player.spawn(0, 3, 6);
player.entity.inventory({ capacity: 50, maxSlots: 8 });
player.entity.health(100);

// --- HUD --------------------------------------------------------------------
const hud = app.hud();
hud.bar('hp', { value: 1, color: '#e33' });
hud.crosshair(false);
hud.objective('Find the villager and talk to them (E)');
player.entity.health().on('damage', () => hud.bar('hp', { value: player.entity.health().fraction }));

// --- quest -------------------------------------------------------------------
const quests = app.quests();
quests.define({
  id: 'moonherbs',
  objectives: [
    { id: 'talk', text: 'Talk to the villager', target: 1 },
    { id: 'herbs', text: 'Collect moonherbs', target: 5 },
  ],
  reward: () => {
    player.entity.inventory().add('gold', 10);
    hud.prompt('Quest complete! +10 gold');
  },
});
quests.start('moonherbs');
quests.on('objective', ({ objective }) =>
  hud.objective(`${objective.text} (${objective.progress}/${objective.target})`));

// --- villager with dialogue ----------------------------------------------------
const villager = app.entity().capsule(0.35, 1.1, 0x7dd87d).at([0, 1, -6]).tag('npc');
const dlg = app.dialogue({
  start: 'greet',
  nodes: {
    greet: { text: 'Moonherbs grow by the old stones. Bring me 5?', choices: [
      { text: "I'll do it", id: 'yes', next: 'go' },
      { text: 'Not now', next: null },
    ]},
    go: { text: 'Follow the lanterns. Watch for the thorns!' },
  },
});
const dlgEl = document.getElementById('dlg');
let talking = false;
function renderNode() {
  const node = dlg.node;
  if (!node) { dlgEl.style.display = 'none'; talking = false; return; }
  talking = true;
  dlgEl.style.display = 'block';
  dlgEl.innerHTML = `<p>${node.text}</p>` + (node.choices ?? [])
    .map((c, i) => `<button data-i="${i}">${c.text}</button>`).join('');
  dlgEl.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => { dlg.choose(+b.dataset.i); renderNode(); }));
}
dlg.on('end', renderNode);
app.input.map({ talk: ['KeyE', 'gamepad:0'] });

// --- moonherb pickups ----------------------------------------------------------
for (let i = 0; i < 8; i++) {
  const a = (i / 8) * Math.PI * 2;
  app.world.pickup({
    kind: 'moonherb', at: [Math.cos(a) * 24, 1, Math.sin(a) * 24],
    radius: 2, item: 'moonherb', amount: 1, respawn: 20,
    onCollect: () => {
      quests.advance('moonherbs', 'herbs');
      hud.prompt(`Moonherb ${player.entity.inventory().count('moonherb')}/5`);
    },
  });
}

// Thorn patch: stepping in hurts (manual zone — pickups only grant)
const thornAt = [12, 1, -14];
app.entity().sphere(3, 0x3a5f2a).scale([1, 0.25, 1]).at([thornAt[0], 0.4, thornAt[2]]);
let thornCd = 0;

// --- talk proximity -------------------------------------------------------------
app.onUpdate((dt) => {
  const p = player.entity.object.position;
  const v = villager.object.position;
  const near = Math.hypot(p.x - v.x, p.z - v.z) < 3;
  hud.prompt(near && !talking ? 'Press E to talk' : '');
  if (near && !talking && app.input.actionPressed('talk')) {
    quests.advance('moonherbs', 'talk');
    dlg.reset();
    renderNode();
  }
  thornCd -= dt;
  if (thornCd <= 0 && Math.hypot(p.x - thornAt[0], p.z - thornAt[2]) < 3) {
    player.entity.health().damage(10, { source: 'thorns' });
    hud.prompt('Ouch! Thorns.');
    thornCd = 1;
  }
});

app.quality('auto');
app.start();
