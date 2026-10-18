# Gameplay — inventory, health, pickups, quests, dialogue, HUD, gamepad

## Inventory

```js
const inv = entity.inventory();
inv.add('coin', 5);            // add('coin') | add({ item: 'coin', qty: 5 })
inv.remove('coin', 2);
inv.has('key'); inv.count('coin'); inv.list(); // [{ id, qty }]
inv.on('change', ({ id, qty }) => ui.refresh());
```

Capacity limits: `entity.inventory({ capacity: 100, maxSlots: 12 })`.
Partial adds return the accepted count.

## Health / damage / death

```js
entity.health(100)
  .on('damage', ({ amount, source }) => flashRed())
  .on('death', () => explode())
  .on('heal', ({ amount }) => {});

entity.health().damage(25, { source: 'lava' });
entity.health().heal(10);
entity.health().dead;      // bool
entity.health().fraction;  // 0..1 — drive a health bar
```

Death fires once; healing above 0 revives. Lava/mud fluids damage entities
automatically through this system.

## Pickups

```js
world.pickup({
  kind: 'coin', at: [5, 1, 5], radius: 1.5,
  item: 'coin', amount: 5, respawn: 30,      // respawn: 0 = one-shot
  onCollect: (entity) => chime(),
});
// or a health pack:
world.pickup({ kind: 'medkit', at: p, radius: 2, heal: 40, respawn: 45 });
```

## Quests

```js
const quests = app.quests();
quests.define({
  id: 'herbs',
  objectives: [{ id: 'pick', text: 'Pick moonherbs', target: 5 }],
  reward: (q) => { entity.inventory().add('gold', 10); },
});
quests.start('herbs');
quests.advance('herbs', 'pick');          // +1 progress
quests.on('complete', ({ quest }) => banner(quest.id));
quests.state('herbs');                    // 'locked' | 'active' | 'complete'
```

## Dialogue trees

```js
const dlg = app.dialogue({
  start: { text: 'Need supplies?', choices: [
    { text: 'Buy rope (5g)', id: 'buy', next: 'thanks' },
    { text: 'Leave', next: null },
  ]},
  thanks: { text: 'Pleasure doing business.' },
});
dlg.on('choice', ({ choice }) => { if (choice.id === 'buy') payUp(); });
dlg.choose('buy');   // by index, text, or id
```

## HUD

DOM-overlay helpers — health bars, prompts, crosshair, objectives. Fully
node-safe no-ops without a DOM:

```js
const hud = app.hud();
hud.bar('hp', { value: 0.75, color: '#e33' });
hud.prompt('Press E to talk');
hud.crosshair(true);
hud.objective('Pick moonherbs (2/5)');
hud.hide(); hud.show(); hud.dispose();
```

## Gamepad + input rebinding

```js
app.input.map({ jump: ['Space', 'gamepad:0'], fire: ['mouse:0', 'gamepad:7'] });
app.input.map('sprint', ['ShiftLeft', 'gamepad:1:5']);
app.input.action('jump');          // held?
app.input.actionPressed('fire');   // edge
app.input.actionAxis('left', 'right'); // -1..1
app.input.unmap('sprint');
```

Binding grammar: `'Space'`, `'mouse:0'`, `'gamepad:0'`, `'gamepad:1:5'`,
`'gamepad:axis0[+-]'`. Gamepads are polled per-frame (guarded, node-safe).
