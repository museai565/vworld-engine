/**
 * Net — multiplayer seams for Phase 2.
 *
 * Phase 1 ships NO transport: there is no socket, no server, no protocol
 * here on purpose. What *is* real today:
 *
 *   - entity.serialize() / entity.applySnapshot() — the exact wire format
 *     Phase 2 will send (id, position, quaternion, scale).
 *   - net.on('entity:update', fn) / net.emit(...) — the event hooks the
 *     future transport will plug into.
 *
 * When Phase 2 lands, only the transport methods (connect/send) need real
 * implementations; game code written against these hooks keeps working.
 */
export class Net {
  constructor(engine) {
    this.engine = engine;
    this.handlers = new Map();
    this.connected = false;
    this.sendRateHz = 20;
    this.clientId = `client_${Math.random().toString(36).slice(2, 10)}`;
  }

  /** Subscribe to a network event (works locally today; remote in Phase 2). */
  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(fn);
    return this;
  }

  off(event, fn) {
    this.handlers.get(event)?.delete(fn);
    return this;
  }

  /** Dispatch an event to local subscribers. */
  emit(event, data) {
    for (const fn of this.handlers.get(event) ?? []) fn(data);
    return this;
  }

  /** Serialize an entity to the wire format. */
  serialize(entity) {
    return entity.serialize();
  }

  /** Apply a wire-format snapshot to an entity. */
  applySnapshot(entity, snap) {
    return entity.applySnapshot(snap);
  }

  /** Serialize every entity in the scene (for full-state sync later). */
  snapshotAll() {
    const out = [];
    this.engine.scene.traverse((o) => {
      if (o.userData.entity) out.push(o.userData.entity.serialize());
    });
    return out;
  }

  /** How many state updates per second Phase 2 should send. */
  sendRate(hz) {
    this.sendRateHz = hz;
    return this;
  }

  get isMultiplayer() {
    return false; // Phase 1: always local
  }

  // --- transport stubs (Phase 2) ---------------------------------------------
  connect(_url) {
    console.warn('[VWorld] Net.connect() is a Phase 1 stub — no transport yet. Local events only.');
    return this;
  }

  send(_event, _data) {
    if (!this.connected) {
      console.warn('[VWorld] Net.send() dropped — not connected (Phase 1 stub).');
    }
    return this;
  }

  disconnect() {
    this.connected = false;
    return this;
  }
}
