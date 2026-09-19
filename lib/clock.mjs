/**
 * IA Loop — injectable clock.
 *
 * Capacity waits are measured in minutes. Tests must exercise them without
 * actually waiting, so every wait goes through this abstraction rather than
 * calling setTimeout directly.
 */

export function systemClock() {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => {
      if (ms <= 0) { resolve(); return; }
      setTimeout(resolve, ms);
    }),
  };
}

/**
 * Test clock: sleeping advances virtual time instantly.
 * `advance` moves time without sleeping, to simulate a process restart gap.
 */
export function createFakeClock(startMs = Date.parse('2026-09-07T02:00:00.000Z')) {
  let current = startMs;
  const slept = [];

  return {
    now: () => current,
    sleep: async (ms) => {
      slept.push(ms);
      current += Math.max(0, ms);
    },
    advance: (ms) => { current += ms; },
    get slept() { return [...slept]; },
  };
}
