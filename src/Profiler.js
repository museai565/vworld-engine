/**
 * Profiler — zero-dependency frame-time measurement.
 *
 * Pure logic, no DOM: safe to use and test in Node. The engine drives the
 * built-in sections ('fixed', 'frame', 'render') from `Engine._loop`; add
 * your own sections anywhere with begin/end.
 *
 *   const prof = app.profiler();
 *   prof.begin('npcThink');
 *   // ... work ...
 *   prof.end('npcThink');
 *   console.log(prof.summary());
 *   // fixed: avg 0.42ms max 1.10ms (60 calls) | frame: avg 0.80ms max 1.42ms (60 calls)
 *
 * Each section keeps a rolling window of the last 120 samples. `enabled`
 * defaults to true; set it false and begin()/end() become no-ops.
 */

const DEFAULT_WINDOW = 120;

export class Profiler {
  /**
   * @param {{ enabled?: boolean, windowSize?: number }} [options]
   */
  constructor(options = {}) {
    /** Master switch — when false, begin()/end() are no-ops. */
    this.enabled = options.enabled ?? true;
    this._windowSize = Math.max(1, options.windowSize ?? DEFAULT_WINDOW);
    this._sections = new Map(); // name -> { samples: number[], calls: number }
    this._open = new Map(); // name -> start timestamp (performance.now)
  }

  /**
   * Start timing a named section. Chainable. No-op when disabled.
   * Calling begin() twice for the same name restarts it.
   * @param {string} name
   */
  begin(name) {
    if (!this.enabled) return this;
    this._open.set(String(name), performance.now());
    return this;
  }

  /**
   * Stop timing a named section and record the sample. Chainable.
   * Silently ignores unmatched end() calls. No-op when disabled.
   * @param {string} name
   */
  end(name) {
    if (!this.enabled) return this;
    const key = String(name);
    const start = this._open.get(key);
    if (start === undefined) return this;
    this._open.delete(key);
    const ms = performance.now() - start;
    let s = this._sections.get(key);
    if (!s) {
      s = { samples: [], calls: 0 };
      this._sections.set(key, s);
    }
    s.samples.push(ms);
    s.calls += 1;
    if (s.samples.length > this._windowSize) s.samples.shift();
    return this;
  }

  /**
   * Record an explicit sample (when you timed it yourself).
   * Chainable. No-op when disabled.
   * @param {string} name
   * @param {number} ms
   */
  record(name, ms) {
    if (!this.enabled) return this;
    const key = String(name);
    let s = this._sections.get(key);
    if (!s) {
      s = { samples: [], calls: 0 };
      this._sections.set(key, s);
    }
    s.samples.push(ms);
    s.calls += 1;
    if (s.samples.length > this._windowSize) s.samples.shift();
    return this;
  }

  /**
   * Stats per section over the rolling window.
   * @returns {{ [name: string]: { avgMs: number, maxMs: number, calls: number } }}
   */
  report() {
    const out = {};
    for (const [name, s] of this._sections) {
      const n = s.samples.length;
      let sum = 0;
      let max = 0;
      for (const v of s.samples) {
        sum += v;
        if (v > max) max = v;
      }
      out[name] = {
        avgMs: n ? sum / n : 0,
        maxMs: max,
        calls: s.calls,
      };
    }
    return out;
  }

  /** Clear all samples and call counts. Chainable. */
  reset() {
    this._sections.clear();
    this._open.clear();
    return this;
  }

  /**
   * One-line human summary: `fixed: avg 0.42ms max 1.10ms (60 calls) | ...`.
   * Returns '(no samples)' when empty.
   */
  summary() {
    const rep = this.report();
    const names = Object.keys(rep);
    if (names.length === 0) return '(no samples)';
    return names
      .map((n) => {
        const s = rep[n];
        return `${n}: avg ${s.avgMs.toFixed(2)}ms max ${s.maxMs.toFixed(2)}ms (${s.calls} calls)`;
      })
      .join(' | ');
  }
}
