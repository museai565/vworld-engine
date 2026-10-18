import { parseBinding, normalizeBindings, actionHeld, actionPressed, actionReleased } from './Gameplay.js';

/**
 * Input — unified keyboard / mouse / touch state.
 *
 *   app.input.key('KeyW')      // is the key held right now?
 *   app.input.pressed('Space') // was it pressed down *this frame*?
 *   app.input.axis('KeyA', 'KeyD') // -1..1 convenience
 *
 * v0.7.0 — action mapping + gamepads:
 *
 *   app.input.map({ jump: ['Space', 'gamepad:0'], fire: ['mouse:0', 'gamepad:7'] });
 *   app.input.action('jump');         // held?
 *   app.input.actionPressed('fire');  // pressed this frame?
 *   app.input.actionAxis('left', 'right');
 *
 * Binding strings: 'Space' (keyboard code), 'mouse:0' (0=left 1=middle 2=right),
 * 'gamepad:0' (pad 0 button 0), 'gamepad:1:5' (pad 1 button 5),
 * 'gamepad:axis0' / 'gamepad:axis1+' / 'gamepad:2:axis0-'.
 * Gamepads are polled every frame; everything is a no-op without a DOM/navigator.
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

    // --- v0.7.0: mouse buttons, action bindings, gamepads -------------------
    this._mouse = new Set();
    this._mousePressed = new Set();
    this._mouseReleased = new Set();
    /** action name -> parsed binding list */
    this._bindings = new Map();
    /** per-frame gamepad snapshots: [{ buttons, pressed, released, axes }] */
    this._pads = [];
    this._padPrev = [];

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
    canvas.addEventListener('mousedown', (e) => {
      this.pointer.down = true;
      if (!this._mouse.has(e.button)) this._mousePressed.add(e.button);
      this._mouse.add(e.button);
    });
    window.addEventListener('mouseup', (e) => {
      this.pointer.down = false;
      this._mouse.delete(e.button);
      this._mouseReleased.add(e.button);
    });

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

  // --- v0.7.0: action mapping (keyboard / mouse / gamepad unified) --------------

  /**
   * Bind action names to inputs. Accepts an object or (action, bindings):
   *
   *   input.map({ jump: ['Space', 'gamepad:0'], fire: 'mouse:0' });
   *   input.map('sprint', ['ShiftLeft', 'gamepad:1:5']);
   *
   * Binding strings: 'Space' (keyboard code), 'mouse:0' (0=left 1=middle
   * 2=right), 'gamepad:0' (pad 0 button 0), 'gamepad:1:5' (pad 1 button 5),
   * 'gamepad:axis0', 'gamepad:axis1+', 'gamepad:2:axis0-'. Re-calling for an
   * action replaces its bindings. Chainable.
   */
  map(def, bindings) {
    const entries = bindings === undefined ? Object.entries(def ?? {}) : [[def, bindings]];
    for (const [action, b] of entries) {
      if (typeof action !== 'string' || action.length === 0) {
        throw new Error('[VWorld] input.map() — action names must be non-empty strings.');
      }
      this._bindings.set(action, normalizeBindings(b));
    }
    return this;
  }

  /** Remove an action's bindings. Chainable. */
  unmap(action) {
    this._bindings.delete(action);
    return this;
  }

  /** Action names currently bound. */
  actions() {
    return [...this._bindings.keys()];
  }

  /** Raw parsed bindings for an action (for debugging). */
  bindingsFor(action) {
    return [...(this._bindings.get(action) ?? [])];
  }

  _kbState() {
    return {
      keys: this.keys, pressed: this._pressed, released: this._released,
      mouse: this._mouse, mousePressed: this._mousePressed, mouseReleased: this._mouseReleased,
    };
  }

  /** Is any binding of this action currently held? */
  action(name) {
    if (!this.enabled) return false;
    const b = this._bindings.get(name);
    return b ? actionHeld(b, this._kbState(), this._pads) : false;
  }

  /** Was any binding of this action pressed down this frame? */
  actionPressed(name) {
    if (!this.enabled) return false;
    const b = this._bindings.get(name);
    return b ? actionPressed(b, this._kbState(), this._pads) : false;
  }

  /** Was any binding of this action released this frame? */
  actionReleased(name) {
    if (!this.enabled) return false;
    const b = this._bindings.get(name);
    return b ? actionReleased(b, this._kbState(), this._pads) : false;
  }

  /** -1..1 from two actions, e.g. actionAxis('moveLeft', 'moveRight'). */
  actionAxis(negative, positive) {
    if (!this.enabled) return 0;
    return (this.action(positive) ? 1 : 0) - (this.action(negative) ? 1 : 0);
  }

  /** Is mouse button `button` (0=left, 1=middle, 2=right) held? */
  mouseButton(button) {
    if (!this.enabled) return false;
    return this._mouse.has(button);
  }

  /** Snapshot of connected gamepads (empty array without navigator). */
  get gamepads() {
    return this._pads.map((p, i) => ({ index: i, buttons: p.buttons.length, axes: p.axes.length }));
  }

  /** Poll navigator.getGamepads() into edge-detected snapshots. Node-safe. */
  _pollGamepads() {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
      this._pads = [];
      this._padPrev = [];
      return;
    }
    let raw;
    try {
      raw = navigator.getGamepads();
    } catch {
      return;
    }
    const next = [];
    const prev = this._padPrev;
    let i = 0;
    for (const gp of raw ?? []) {
      if (!gp) { i++; continue; }
      const buttons = gp.buttons.map((b) => !!b.pressed);
      const axes = [...gp.axes];
      const pPrev = prev[i];
      const pressed = buttons.map((b, bi) => b && !(pPrev?.buttons[bi]));
      const released = buttons.map((b, bi) => !b && pPrev?.buttons[bi]);
      next[i] = { buttons, pressed, released, axes };
      i++;
    }
    this._pads = next;
    this._padPrev = next.map((p) => (p ? { buttons: p.buttons } : null));
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
    this._pollGamepads();
    this._pressed.clear();
    this._released.clear();
    this._mousePressed.clear();
    this._mouseReleased.clear();
    this.pointer.dx = 0;
    this.pointer.dy = 0;
    return this;
  }
}
