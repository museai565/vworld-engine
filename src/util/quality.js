/**
 * Quality normalization — pure, DOM-free, unit-testable.
 *
 *   import { resolveQuality, normalizeQuality, QUALITY_LEVELS } from '@vworld/engine';
 *
 *   resolveQuality('high', 2);        // { pixelRatio: 2, shadows: true }
 *   resolveQuality('medium', 3);      // { pixelRatio: 1.5, shadows: true }
 *   resolveQuality('low', 2);         // { pixelRatio: 1, shadows: false }
 *   resolveQuality('auto', 2);        // resolves to high settings; auto-stepping is runtime-driven
 */

/** All supported quality level names, high → low. */
export const QUALITY_LEVELS = ['high', 'medium', 'low'];

import { vError } from './errors.js';

/**
 * Normalize an app.quality() argument into a level name.
 * Accepts: 'high' | 'medium' | 'low' | 'auto' (case-insensitive),
 * or the object form `{ level: 'auto' }` per the normalize-don't-complain law.
 *
 * @param {string|{ level: string }} v
 * @returns {'high'|'medium'|'low'|'auto'}
 * @throws {VWorldError} VWORLD/BAD_QUALITY when unreadable.
 */
export function normalizeQuality(v) {
  const raw = typeof v === 'string' ? v : v && typeof v === 'object' ? v.level : undefined;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw vError(
      'VWORLD/BAD_QUALITY',
      `[VWorld] app.quality() needs 'high' | 'medium' | 'low' | 'auto' (or { level }) — got ${typeof v}.`
    );
  }
  return raw.trim().toLowerCase();
}

/**
 * Resolve a quality level + devicePixelRatio into concrete renderer settings.
 *
 * @param {'high'|'medium'|'low'|'auto'} level - 'auto' resolves to high settings (runtime stepping adjusts it later).
 * @param {number} dpr - window.devicePixelRatio (defaults to 1; clamped).
 * @returns {{ pixelRatio: number, shadows: boolean }}
 * @throws {VWorldError} VWORLD/UNKNOWN_QUALITY for unknown levels.
 */
export function resolveQuality(level, dpr = 1) {
  const l = typeof level === 'string' ? level.trim().toLowerCase() : '';
  const r = typeof dpr === 'number' && Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  switch (l) {
    case 'high':
      return { pixelRatio: Math.min(r, 2), shadows: true };
    case 'auto': // 'auto' starts at high; the runtime steps it down/up from there.
      return { pixelRatio: Math.min(r, 2), shadows: true };
    case 'medium':
      return { pixelRatio: Math.min(r, 1.5), shadows: true };
    case 'low':
      return { pixelRatio: 1, shadows: false };
    default:
      throw vError(
        'VWORLD/UNKNOWN_QUALITY',
        `[VWorld] Unknown quality level "${level}" — try: high, medium, low, auto.`
      );
  }
}

/**
 * Pure auto-quality stepping rule: given the current level, the average FPS
 * over the last 2s window, and how many consecutive windows have been > 57,
 * decide the new level and streak.
 *
 * Rules (from the engine contract):
 *   - avg < 45            → step down one level, streak resets
 *   - avg > 57, 3rd+ time in a row → step up one level, streak resets
 *   - otherwise           → hold, streak advances only while > 57
 *
 * @param {'high'|'medium'|'low'} currentLevel
 * @param {number} avgFps
 * @param {number} highStreak - consecutive windows with avgFps > 57 so far
 * @returns {{ level: 'high'|'medium'|'low', highStreak: number }}
 */
export function autoStep(currentLevel, avgFps, highStreak = 0) {
  const idx = QUALITY_LEVELS.indexOf(currentLevel);
  const at = Math.max(0, Math.min(QUALITY_LEVELS.length - 1, idx < 0 ? 0 : idx));
  if (avgFps < 45) {
    return { level: QUALITY_LEVELS[Math.min(at + 1, QUALITY_LEVELS.length - 1)], highStreak: 0 };
  }
  if (avgFps > 57) {
    const streak = highStreak + 1;
    if (streak >= 3) {
      return { level: QUALITY_LEVELS[Math.max(at - 1, 0)], highStreak: 0 };
    }
    return { level: QUALITY_LEVELS[at], highStreak: streak };
  }
  return { level: QUALITY_LEVELS[at], highStreak: 0 };
}
