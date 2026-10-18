/**
 * Input — unified keyboard / mouse / touch state.
 *
 *   app.input.key('KeyW')      // is the key held right now?
 *   app.input.pressed('Space') // was it pressed down *this frame*?
 *   app.input.axis('KeyA', 'KeyD') // -1..1 convenience
 *
 * Mouse deltas (`input.pointer.dx/dy`) accumulate between frames and are
 * cleared each frame by `update()` — the engine calls it automatically.
 * Touch positions are exposed via `input.touches` (Map of id -> {x, y}).
 */
export class Input {
  constructor(engine) {
    this.engine = engine;
    this.keys = new Set();
    this._pressed = new Set();
    this._released = new Set();
    this.pointer = { x: 0, y: 0, dx: 0, dy: 0, down: false };
    this.touches = new Map();

    /**
     * Master switch for game input. When false, key()/pressed()/released()/
     * axis() all report nothing — e.g. while the user is typing in a chat
     * box, so game keys don't walk the player. Pointer deltas are unaffected.
     */
    this.enabled = true;

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (!this.keys.has(e.code)) this._pressed.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      this._released.add(e.code);
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this._pressed.clear();
    });

    const canvas = engine.options.canvas;
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      this.pointer.x = e.clientX - rect.left;
      this.pointer.y = e.clientY - rect.top;
      this.pointer.dx += e.movementX || 0;
      this.pointer.dy += e.movementY || 0;
    });
    canvas.addEventListener('mousedown', () => { this.pointer.down = true; });
    window.addEventListener('mouseup', () => { this.pointer.down = false; });

    canvas.addEventListener('touchstart', (e) => {
      for (const t of e.changedTouches) this.touches.set(t.identifier, { x: t.clientX, y: t.clientY });
    }, { passive: true });
    canvas.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) this.touches.set(t.identifier, { x: t.clientX, y: t.clientY });
    }, { passive: true });
    const endTouch = (e) => {
      for (const t of e.changedTouches) this.touches.delete(t.identifier);
    };
    canvas.addEventListener('touchend', endTouch);
    canvas.addEventListener('touchcancel', endTouch);
  }

  /** Is this key currently held? Use event.code values: 'KeyW', 'Space', ... */
  key(code) {
    if (!this.enabled) return false;
    return this.keys.has(code);
  }

  /** Was this key pressed down during the current frame? */
  pressed(code) {
    if (!this.enabled) return false;
    return this._pressed.has(code);
  }

  /** Was this key released during the current frame? */
  released(code) {
    if (!this.enabled) return false;
    return this._released.has(code);
  }

  /** -1..1 from two keys, e.g. axis('KeyA', 'KeyD') for strafe. */
  axis(negative, positive) {
    if (!this.enabled) return 0;
    return (this.key(positive) ? 1 : 0) - (this.key(negative) ? 1 : 0);
  }

  /** Request pointer lock on the canvas (for mouse-look). */
  lockPointer() {
    const canvas = this.engine.options.canvas;
    if (canvas.requestPointerLock) canvas.requestPointerLock();
    return this;
  }

  unlockPointer() {
    if (document.exitPointerLock) document.exitPointerLock();
    return this;
  }

  get pointerLocked() {
    return !!document.pointerLockElement;
  }

  /** Called once per rendered frame by the engine. Clears edge states. */
  update() {
    this._pressed.clear();
    this._released.clear();
    this.pointer.dx = 0;
    this.pointer.dy = 0;
    return this;
  }
}
