/**
 * IA Loop — following an authorised successor while waiting.
 *
 * A job names one logical stage; `job-store.mjs` names one ATTEMPT at it with
 * an incrementing counter. Every successor is materialised in that same file,
 * through exactly two doors — `startNextAttempt` (capacity, interruption) and
 * `authorizeRetryAfterHarnessFix` (a repaired harness bug) — and both append an
 * entry to `attemptHistory` before moving `currentAttemptId` on. That is what
 * makes a chain provable from the job alone: nothing outside those two doors
 * can advance the counter, so `attemptHistory` is always a complete, ordered
 * account of how attempt N ended and why N+1 exists.
 *
 * `waitForResult` asks this before it treats a mismatched attempt as merely
 * stale: is the CURRENT attempt an authorised descendant of the one it was
 * told to wait for? If every hop between them ended for a reason the store
 * itself allows a retry from, the answer is yes and the waiter follows. If any
 * hop is missing, forked, or ended for a reason nothing authorises — a plain
 * FAILED with no retry authorisation, a SUPERSEDED duplicate, an attempt that
 * belongs to a different chain entirely — the answer is no, and the caller
 * keeps waiting on what it was told to wait for.
 *
 * This never invents a successor and never picks "the latest attempt" by
 * feel: it only walks a chain that is already written down, and it fails
 * closed the moment that chain does not fully account for the gap.
 */

import { RETRYABLE_JOB_STATUSES } from './job-store.mjs';

/** Why `findAuthorizedSuccessor` declined to hand off. */
export const HANDOFF_REFUSALS = Object.freeze({
  UNKNOWN_ATTEMPT: 'UNKNOWN_ATTEMPT',
  BROKEN_LINEAGE: 'BROKEN_LINEAGE',
  NOT_AUTHORIZED: 'NOT_AUTHORIZED',
  CONFLICTING_LINEAGE: 'CONFLICTING_LINEAGE',
});

/**
 * Did this attemptHistory entry end for a reason the store itself may start a
 * successor from?
 *
 * INTERRUPTED and WAITING_FOR_CAPACITY are `RETRYABLE_JOB_STATUSES` — the same
 * set `startNextAttempt` itself is guarded by, so this can never be more
 * permissive than the door that actually creates successors.
 *
 * A harness retry is the one case a bare status cannot answer: the attempt
 * really is FAILED, on purpose — that is the line `harness-retry.mjs` must
 * never soften. What makes ITS successor legitimate is the explicit
 * authorisation `authorizeRetryAfterHarnessFix` stamps onto the history entry.
 * An ordinary FAILED with no such stamp — an unauthorised, unexplained
 * failure — is exactly the case this must refuse.
 */
function isAuthorizedEnd(entry) {
  if (!entry) return false;
  if (RETRYABLE_JOB_STATUSES.includes(entry.status)) return true;
  return entry.status === 'FAILED' && Boolean(entry.retryAuthorizedBy);
}

/**
 * Does the job's CURRENT attempt descend from `expectedAttemptId` through a
 * chain the store itself proves?
 *
 * @param state  the shape `store.readAttemptState(role, jobId)` returns:
 *               `{ attempt, attemptId, history }` at minimum.
 * @param expectedAttemptId  the attempt a waiter was told to wait for.
 * @returns `null` when the current attempt already IS the expected one — there
 *          is nothing to hand off, the waiter keeps waiting normally.
 *          Otherwise `{ authorized: boolean, ... }`. Never throws.
 */
export function findAuthorizedSuccessor(state, expectedAttemptId) {
  if (!state || !expectedAttemptId) return null;
  if (state.attemptId === expectedAttemptId) return null;

  const history = state.history ?? [];

  // A fork — two history entries claiming the same attempt number — could
  // only reach disk through a corrupted or hand-edited job file:
  // `startNextAttempt` serialises every increment behind its own lock, so
  // legitimate history is always one entry per attempt number. Still
  // checked, and checked before anything else, because silently picking one
  // of two conflicting successors is exactly the "latest wins" shortcut this
  // module exists to refuse.
  const byAttempt = new Map();
  for (const entry of history) {
    if (byAttempt.has(entry.attempt)) {
      return { authorized: false, reason: HANDOFF_REFUSALS.CONFLICTING_LINEAGE, attempt: entry.attempt };
    }
    byAttempt.set(entry.attempt, entry);
  }

  const start = history.find((entry) => entry.attemptId === expectedAttemptId);
  if (!start) {
    // Not "the job moved on" — this job's history says nothing about the
    // attempt being waited for at all. That is never a handoff; it is either
    // a caller error or an attempt that belongs to a different chain.
    return { authorized: false, reason: HANDOFF_REFUSALS.UNKNOWN_ATTEMPT };
  }

  // Walk attempt numbers one at a time from the expected attempt to the
  // current one. Every intermediate hop must be present and authorised —
  // a multi-hop chain (capacity wait, then a harness failure, then a repair)
  // is legitimate only when NONE of the links are missing or unexplained.
  for (let n = start.attempt; n < state.attempt; n += 1) {
    const hop = byAttempt.get(n);
    if (!hop) return { authorized: false, reason: HANDOFF_REFUSALS.BROKEN_LINEAGE, brokenAtAttempt: n };
    if (!isAuthorizedEnd(hop)) {
      return {
        authorized: false,
        reason: HANDOFF_REFUSALS.NOT_AUTHORIZED,
        unauthorizedAttemptId: hop.attemptId,
        endedStatus: hop.status,
      };
    }
  }

  return {
    authorized: true,
    attemptId: state.attemptId,
    fromAttemptId: expectedAttemptId,
    endedReason: start.reason ?? start.status,
    hops: state.attempt - start.attempt,
  };
}
