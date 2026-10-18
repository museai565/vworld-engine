/**
 * Centralized error handling for the VWorld Engine.
 *
 * Every internal catch site (event handlers, plugin install, moveTo arrival
 * callbacks, entity listeners) reports through the engine's error bus instead
 * of dropping errors into the void. The bus is pure and DOM-free, so it's
 * fully unit-testable in Node.
 *
 *   import { VWorldError, vError, createErrorBus } from '@vworld/engine';
 *
 *   const err = vError('VWORLD/PHYSICS_NOT_READY', 'await app.ready first');
 *   err instanceof VWorldError; // true
 *   err.code;                   // 'VWORLD/PHYSICS_NOT_READY'
 *
 * Error codes (see README "Production hardening" for the full list):
 *   VWORLD/MISSING_CANVAS      Engine.create() without a <canvas>
 *   VWORLD/APP_DISPOSED        start() (or other use) after app.dispose()
 *   VWORLD/BAD_PLUGIN          app.use() got a malformed plugin object
 *   VWORLD/PLUGIN_INSTALL_FAILED plugin.install() threw during app.use()
 *   VWORLD/UNKNOWN_EVENT       app.on() / app.off() with an unknown event name
 *   VWORLD/EVENT_HANDLER_THREW a subscribed engine-event handler threw
 *   VWORLD/PHYSICS_NOT_READY   physics touched before `await app.ready`
 *   VWORLD/BODY_NOT_BOUND      body.on() before .bind(entity)
 *   VWORLD/BAD_BODY            joint builder got a non-Body argument
 *   VWORLD/PLUGIN_MISSING      entity.anim() without the animation plugin
 *   VWORLD/UNKNOWN_QUALITY     app.quality() got an unknown level
 *   VWORLD/BAD_QUALITY         app.quality() got an unreadable value
 */

/** Base class for every engine-thrown error. Carries a machine-readable code. */
export class VWorldError extends Error {
  /**
   * @param {string} code - 'VWORLD/...' machine code.
   * @param {string} message - human-readable message (keeps the '[VWorld]' prefix convention).
   * @param {{ cause?: unknown }} [opts] - optional original error.
   */
  constructor(code, message, opts = {}) {
    super(message);
    this.name = 'VWorldError';
    this.code = code;
    if (opts.cause !== undefined) this.cause = opts.cause;
    if (Error.captureStackTrace) Error.captureStackTrace(this, VWorldError);
  }
}

/** Shorthand factory: `vError('VWORLD/PHYSICS_NOT_READY', 'await app.ready first')`. */
export function vError(code, message, opts) {
  return new VWorldError(code, message, opts);
}

/**
 * Pure, testable error bus. Handlers run in registration order; a throwing
 * handler never blocks the rest. With no handlers registered, errors fall
 * back to `console.error` — nothing is ever silently swallowed.
 *
 *   const bus = createErrorBus();
 *   bus.onError((err) => logger.error(err.code, err));
 *   bus.report(vError('VWORLD/PHYSICS_NOT_READY', '...'));
 */
export function createErrorBus() {
  const handlers = new Set();

  const bus = {
    /**
     * Register an error handler. Chainable.
     * @param {(err: Error) => void} fn
     */
    onError(fn) {
      if (typeof fn !== 'function') {
        throw vError('VWORLD/BAD_HANDLER', '[VWorld] onError(fn) — fn must be a function.');
      }
      handlers.add(fn);
      return bus;
    },

    /**
     * Remove a previously registered error handler. Chainable.
     * @param {(err: Error) => void} fn
     */
    offError(fn) {
      handlers.delete(fn);
      return bus;
    },

    /**
     * Report an error to every handler, in order. Falls back to
     * `console.error` when no handlers are registered.
     * @param {unknown} err - the error (or any thrown value) to report.
     */
    report(err) {
      if (handlers.size === 0) {
        console.error('[VWorld]', err);
        return bus;
      }
      for (const fn of handlers) {
        try {
          fn(err);
        } catch (handlerErr) {
          // A logging pipeline must never take the engine down.
          console.error('[VWorld] error handler threw:', handlerErr);
        }
      }
      return bus;
    },
  };

  return bus;
}

// Module-level fallback bus for code paths with no engine reference
// (e.g. an Entity built with `new Entity()` instead of `app.entity()`).
const _fallbackBus = createErrorBus();

/**
 * Report an error through the engine's error bus when available, otherwise
 * through the shared fallback bus (which itself falls back to
 * console.error). Never throws.
 *
 * @param {object|null|undefined} engine - Engine instance, or null.
 * @param {unknown} err - the error to report.
 */
export function reportError(engine, err) {
  const bus = engine && engine._errorBus ? engine._errorBus : _fallbackBus;
  bus.report(err);
}
