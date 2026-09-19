/**
 * IA Loop — capacity policy.
 *
 * Maps a classified failure to one of two actions: wait and retry the SAME
 * model, or stop and ask a human. There is no third option: switching models is
 * never a remedy here, and a temporary limit never fails the Goal.
 */

import { SpikeError } from './claude-process.mjs';
import { CAPACITY_CONFIG, backoffForAttempt } from './capacity-config.mjs';
import { CAPACITY_REASONS } from './capacity-classifier.mjs';

export const CAPACITY_ACTIONS = Object.freeze({
  WAIT: 'WAIT',
  HUMAN_REQUIRED: 'HUMAN_REQUIRED',
});

/** Reasons a human must resolve; retrying them would only waste time. */
const ESCALATE_IMMEDIATELY = Object.freeze([
  CAPACITY_REASONS.AUTH_ERROR,
  CAPACITY_REASONS.BILLING_ERROR,
  CAPACITY_REASONS.MODEL_UNAVAILABLE,
  CAPACITY_REASONS.UNKNOWN_FATAL,
  // Waiting cannot fix a local tooling failure.
  CAPACITY_REASONS.HARNESS_ERROR,
  /**
   * Not because a human is the right answer — they are not — but because the
   * right answer does not exist here yet.
   *
   * A unit that spends its turn budget should be recorded as blocked and left
   * for the review, which is a THIRD action this policy deliberately does not
   * have. Until it does, escalating is the honest failure mode: visible, and
   * it stops rather than waiting out a limit that no amount of waiting lifts.
   * This is why `maxTurnsPerUnit` defaults to 0.
   */
  CAPACITY_REASONS.TURN_BUDGET_EXHAUSTED,
]);

/**
 * Decides what to do about a classified failure.
 *
 * `attempt` is 1-based and counts the attempts already made for this job.
 */
export function decideCapacityAction({
  reason,
  attempt = 1,
  retryAfterMs = null,
  now,
  config = CAPACITY_CONFIG,
}) {
  if (!Object.hasOwn(CAPACITY_REASONS, reason)) {
    throw new SpikeError('UNKNOWN_CAPACITY_REASON', `Unknown capacity reason ${JSON.stringify(reason)}`);
  }
  if (!Number.isFinite(now)) {
    throw new SpikeError('INVALID_ARGS', 'now (epoch ms) is required');
  }

  if (ESCALATE_IMMEDIATELY.includes(reason)) {
    return Object.freeze({
      action: CAPACITY_ACTIONS.HUMAN_REQUIRED,
      reason,
      attempt,
      retryIntervalMs: null,
      nextRetryAt: null,
      note: humanNoteFor(reason),
    });
  }

  if (reason === CAPACITY_REASONS.UNKNOWN_TRANSIENT) {
    // A small, bounded number of retries. Unlike a usage limit, an unexplained
    // failure that keeps repeating is not something to wait out indefinitely.
    if (attempt > config.unknownTransientMaxRetries) {
      return Object.freeze({
        action: CAPACITY_ACTIONS.HUMAN_REQUIRED,
        reason,
        attempt,
        retryIntervalMs: null,
        nextRetryAt: null,
        note: `Exceeded ${config.unknownTransientMaxRetries} retries for an unclassified transient failure.`,
      });
    }
    const interval = backoffForAttempt(config.unknownTransientBackoffMs, attempt, config.rateLimitMaxMs);
    return wait({ reason, attempt, interval, now });
  }

  if (reason === CAPACITY_REASONS.RATE_LIMIT) {
    // Honour Retry-After when the API sent one, but never wait longer than the
    // ceiling; otherwise fall back to progressive backoff.
    const interval = Number.isFinite(retryAfterMs) && retryAfterMs !== null
      ? Math.min(retryAfterMs, config.rateLimitMaxMs)
      : backoffForAttempt(config.rateLimitBackoffMs, attempt, config.rateLimitMaxMs);
    return wait({ reason, attempt, interval, now });
  }

  // USAGE_LIMIT: an expected, longer wait. No attempt ceiling — the number of
  // retries is not evidence of a problem, so it never becomes HUMAN_REQUIRED
  // on its own.
  const interval = Number.isFinite(retryAfterMs) && retryAfterMs !== null
    ? retryAfterMs
    : config.usageLimitRetryMs;
  return wait({ reason, attempt, interval, now });
}

function wait({ reason, attempt, interval, now }) {
  return Object.freeze({
    action: CAPACITY_ACTIONS.WAIT,
    reason,
    attempt,
    retryIntervalMs: interval,
    nextRetryAt: new Date(now + interval).toISOString(),
    note: null,
  });
}

function humanNoteFor(reason) {
  switch (reason) {
    case CAPACITY_REASONS.AUTH_ERROR:
      return 'Authentication needs human intervention; retrying cannot fix it.';
    case CAPACITY_REASONS.BILLING_ERROR:
      return 'Billing needs human intervention. Switching provider or model is not an option.';
    case CAPACITY_REASONS.MODEL_UNAVAILABLE:
      return 'The requested model is unavailable. No fallback model will be used.';
    case CAPACITY_REASONS.HARNESS_ERROR:
      return 'Local harness failure, not a model limit. Fix the tooling; retrying as-is will not help.';
    default:
      return 'Unrecoverable failure; a human must look at it.';
  }
}

/** Formats a remaining wait for terminal output, e.g. "12m 43s". */
export function formatRemaining(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
