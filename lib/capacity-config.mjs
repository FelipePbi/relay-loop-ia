/**
 * IA Loop — capacity handling configuration.
 *
 * Every interval lives here so no magic number is scattered through the
 * workers. Overridable by environment for local experimentation, but the
 * defaults are the contract.
 */

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export const CAPACITY_CONFIG = Object.freeze({
  /** Progressive backoff for RATE_LIMIT, in order of attempt. */
  rateLimitBackoffMs: Object.freeze([30_000, 60_000, 120_000, 300_000]),

  /** Hard ceiling between retries, including any Retry-After the API sends. */
  rateLimitMaxMs: envInt('IA_LOOP_RATE_LIMIT_MAX_MS', 300_000),

  /**
   * USAGE_LIMIT is a longer, expected wait (a plan window resetting), so it
   * gets a coarser interval and no attempt ceiling.
   */
  usageLimitRetryMs: envInt('IA_LOOP_USAGE_LIMIT_RETRY_MS', 1_200_000),

  /** UNKNOWN_TRANSIENT is retried a few times, then escalated. */
  unknownTransientMaxRetries: envInt('IA_LOOP_UNKNOWN_TRANSIENT_MAX_RETRIES', 3),
  unknownTransientBackoffMs: Object.freeze([15_000, 30_000, 60_000]),

  /**
   * How often a waiting worker wakes up to re-check the persisted deadline.
   * It sleeps to the deadline, so this is only the granularity used when the
   * remaining wait is long; it is not a polling loop.
   */
  waitTickMs: envInt('IA_LOOP_WAIT_TICK_MS', 30_000),
});

/** Picks the backoff for an attempt, clamping to the last entry and the ceiling. */
export function backoffForAttempt(schedule, attempt, maxMs) {
  const index = Math.min(Math.max(attempt, 1) - 1, schedule.length - 1);
  return Math.min(schedule[index], maxMs);
}
