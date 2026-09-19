/**
 * IA Loop — durable capacity state.
 *
 * A capacity wait must survive the process, the terminal and the machine. All
 * of it lives on disk; nothing here relies on process memory.
 *
 * Crucially, the record says exactly WHERE to resume, so work already completed
 * is never repeated: if the Developer finished round 2 and only the review was
 * blocked, resuming re-enters REVIEWER_RUNNING, not the Developer.
 */

import { SpikeError } from './claude-process.mjs';
import { readJson, writeJsonAtomic, STORE_VERSION } from './job-store.mjs';
import { LOOP_STATES, RESUMABLE_STATES } from './loop-state.mjs';
import { CAPACITY_REASONS } from './capacity-classifier.mjs';
import { ROLES } from './contracts-v2.mjs';

// The resumable set is DERIVED from the canonical state registry. It used to be
// a hand-maintained list here, which is how CORRECTION_RUNNING ended up in the
// state machine but unknown to capacity resume.

function fail(code, message, details = {}) {
  throw new SpikeError(code, message, details);
}

function assertIso(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail('CAPACITY_STATE_CORRUPT', `Field "${field}" must be an ISO timestamp, got ${JSON.stringify(value)}`);
  }
}

/**
 * Validates a persisted capacity block, failing closed.
 * A corrupt record is never repaired or ignored: acting on a half-written
 * capacity state could duplicate an inference or skip completed work.
 */
export function validateCapacityRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    fail('CAPACITY_STATE_CORRUPT', 'Capacity record is not an object');
  }
  if (!Object.hasOwn(CAPACITY_REASONS, record.reason)) {
    fail('CAPACITY_STATE_CORRUPT', `Unknown capacity reason ${JSON.stringify(record.reason)}`);
  }
  if (!Number.isInteger(record.attempt) || record.attempt < 1) {
    fail('CAPACITY_STATE_CORRUPT', `Field "attempt" must be an integer >= 1, got ${JSON.stringify(record.attempt)}`);
  }
  assertIso(record.firstSeenAt, 'firstSeenAt');
  assertIso(record.lastAttemptAt, 'lastAttemptAt');
  assertIso(record.nextRetryAt, 'nextRetryAt');
  if (!Number.isFinite(record.retryIntervalMs) || record.retryIntervalMs < 0) {
    fail('CAPACITY_STATE_CORRUPT', `Field "retryIntervalMs" must be a non-negative number`);
  }
  return record;
}

/** Validates the whole waiting snapshot, including where to resume. */
export function validateWaitingRuntime(runtime) {
  if (!ROLES.includes(runtime?.blockedAgent)) {
    fail('CAPACITY_STATE_CORRUPT', `Unknown blockedAgent ${JSON.stringify(runtime?.blockedAgent)}`);
  }
  if (!RESUMABLE_STATES.includes(runtime?.resumeFrom)) {
    fail('CAPACITY_STATE_CORRUPT', `resumeFrom ${JSON.stringify(runtime?.resumeFrom)} is not a resumable state`);
  }
  if (!runtime?.goal) fail('CAPACITY_STATE_CORRUPT', 'Waiting runtime lost its goal');
  if (!Number.isInteger(runtime?.round) || runtime.round < 1) {
    fail('CAPACITY_STATE_CORRUPT', 'Waiting runtime lost its round');
  }
  validateCapacityRecord(runtime.capacity);
  return runtime;
}

/**
 * Records that an agent is waiting for capacity.
 *
 * Merges into the existing runtime rather than replacing it, so the goal,
 * round, baselines and worktree plan already recorded are preserved.
 */
export async function persistCapacityWait(store, {
  goal,
  round,
  blockedAgent,
  resumeFrom,
  jobId,
  decision,
  now,
}) {
  const previous = (await store.readRuntime()) ?? {};
  const nowIso = new Date(now).toISOString();

  const capacity = {
    reason: decision.reason,
    attempt: decision.attempt,
    // The first sighting is kept across retries so the total wait is visible.
    firstSeenAt: previous.capacity?.firstSeenAt ?? nowIso,
    lastAttemptAt: nowIso,
    nextRetryAt: decision.nextRetryAt,
    retryIntervalMs: decision.retryIntervalMs,
  };
  validateCapacityRecord(capacity);

  const runtime = {
    ...previous,
    goal: goal ?? previous.goal,
    round: round ?? previous.round,
    state: LOOP_STATES.WAITING_FOR_CAPACITY,
    blockedAgent,
    resumeFrom,
    blockedJobId: jobId ?? previous.blockedJobId ?? null,
    capacity,
  };

  validateWaitingRuntime(runtime);
  await store.writeRuntime(runtime);
  return runtime;
}

/** Clears the capacity block once the agent got through. */
export async function clearCapacityWait(store, { state, now }) {
  const previous = (await store.readRuntime()) ?? {};
  const runtime = { ...previous, state, capacity: null, blockedAgent: null, resumeFrom: null, blockedJobId: null };
  runtime.capacityClearedAt = new Date(now).toISOString();
  await store.writeRuntime(runtime);
  return runtime;
}

/**
 * Clears a capacity block ia-loop:resume has just resolved, without touching
 * `state`.
 *
 * `clearCapacityWait` is the in-process path: it runs the instant the SAME
 * call that was waiting gets through, and it knows the real next state to
 * write (`resumeFrom`). `ia-loop:resume` knows no such thing — it requeues a
 * job for a worker that has not run yet, so writing a `state` here would be a
 * guess (QUEUED vs RUNNING is a real distinction the reconciliation logic in
 * `ia-loop:goal`/`ia-loop:status` derives from the job's own status, which is
 * exactly the authority this codebase already treats `runtime.state` as a
 * cache of — see run-status.mjs). What resume DOES know is that the block it
 * is describing is over: the job was requeued (or already had a result), so
 * a `capacity` object still naming an old `nextRetryAt` is now describing a
 * wait that already ended.
 *
 * Guarded by `blockedJobId` matching exactly the job being resumed, so this
 * can never clear a DIFFERENT block than the one just resolved.
 */
export async function clearResolvedCapacityBlock(store, { jobId, now }) {
  const previous = await store.readRuntime();
  if (!previous || previous.blockedJobId !== jobId) return previous ?? null;
  const runtime = {
    ...previous, capacity: null, blockedAgent: null, resumeFrom: null, blockedJobId: null,
  };
  runtime.capacityClearedAt = new Date(now).toISOString();
  await store.writeRuntime(runtime);
  return runtime;
}

/** Records an escalation. The Goal is preserved; only the state changes. */
export async function persistHumanRequired(store, { blockedAgent, reason, note, jobId, now }) {
  const previous = (await store.readRuntime()) ?? {};
  const runtime = {
    ...previous,
    state: LOOP_STATES.HUMAN_REQUIRED,
    blockedAgent,
    blockedJobId: jobId ?? previous.blockedJobId ?? null,
    capacity: null,
    humanRequired: {
      reason,
      note: note ?? null,
      at: new Date(now).toISOString(),
    },
  };
  await store.writeRuntime(runtime);
  return runtime;
}

/** Milliseconds still to wait, never negative. */
export function remainingWaitMs(runtime, now) {
  const nextRetryAt = runtime?.capacity?.nextRetryAt;
  if (!nextRetryAt) return 0;
  const at = Date.parse(nextRetryAt);
  if (Number.isNaN(at)) {
    fail('CAPACITY_STATE_CORRUPT', `nextRetryAt is not a valid timestamp: ${nextRetryAt}`);
  }
  return Math.max(0, at - now);
}

export function isWaitingForCapacity(runtime) {
  return runtime?.state === LOOP_STATES.WAITING_FOR_CAPACITY;
}

/** Reads and validates the runtime, refusing a corrupt waiting record. */
export async function readRuntimeStrict(store) {
  const runtime = await readJson(store.paths.runtime);
  if (!runtime) return null;
  if (runtime.storeVersion !== undefined && runtime.storeVersion !== STORE_VERSION) {
    fail('STORE_VERSION_MISMATCH', `Runtime has store version ${runtime.storeVersion}, expected ${STORE_VERSION}`);
  }
  if (isWaitingForCapacity(runtime)) validateWaitingRuntime(runtime);
  return runtime;
}
