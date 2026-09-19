/**
 * IA Loop — waiting for a worker to publish a result.
 *
 * A timeout here is an OBSERVER timeout, never a job failure. The waiter is a
 * spectator: the work belongs to the attempt that holds the lease. Treating
 * the wait as a failure is what once queued a second correction while the
 * first was still running, putting two agents on one worktree.
 *
 * So on timeout this returns instead of throwing, and the caller stops
 * watching without failing the job, without releasing the lease and without
 * creating a new attempt.
 *
 * Reads are fenced by attempt (`store.readResult(..., { expectedAttemptId })`,
 * see job-store.mjs): "the first non-null envelope" was the bug that let a
 * dead attempt's failure be read as the live attempt's answer. But fencing on
 * its own has a second failure mode — Goal 005 R2 hit it — when the attempt
 * being waited for is superseded by an AUTHORISED successor (a capacity retry,
 * a recovery, a harness repair) while this loop is asleep: the fence then
 * holds forever against an attempt that will never answer again, while its
 * successor's result sits on disk unread. `findAuthorizedSuccessor`
 * (attempt-handoff.mjs) is what tells the difference between that and an
 * ordinary stale result — a chain the job itself proves, never "whatever is
 * newest".
 */

import { classifyLease } from './leases.mjs';
import { findAuthorizedSuccessor } from './attempt-handoff.mjs';
import { readWorkerHealth, WORKER_HEALTH } from './worker-registry.mjs';

export const DEFAULT_RESULT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_POLL_MS = 5_000;

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * @param store          the job store
 * @param role           'developer' | 'tech_lead'
 * @param jobId          the logical job to watch
 * @param emit           progress line sink
 * @param leaseStore     for reporting lease status on an observer stop
 * @param expectedAttemptId  the attempt this call starts out waiting for
 * @param goal, round    carried onto ATTEMPT_WAIT_HANDOFF for the audit trail
 * @param resultTimeoutMs, pollMs, sleep  overridable for tests
 * @returns `{ envelope, attemptId }` on success; `{ observerTimeout, ... }` or
 *          `{ workerOffline, ... }` when the loop stopped without one. The
 *          returned `attemptId` is always the attempt actually settled on —
 *          the caller's original `expectedAttemptId` after zero or more
 *          authorised handoffs.
 */
export async function waitForResult(store, role, jobId, {
  emit = () => {},
  leaseStore = null,
  expectedAttemptId = null,
  goal = null,
  round = null,
  resultTimeoutMs = DEFAULT_RESULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  sleep = defaultSleep,
} = {}) {
  const startedAt = Date.now();
  let lastState = null;
  // Reported once per distinct stale attempt, so a five-second poll does not
  // fill the terminal and the event log with the same fact.
  const reportedStale = new Set();
  // Reassigned on an authorised handoff. Every subsequent read is fenced by
  // the NEW attempt — never by the one this call started with.
  let currentAttemptId = expectedAttemptId;

  for (;;) {
    const envelope = await store.readResult(role, jobId, {
      expectedAttemptId: currentAttemptId,
      onStale: ({ foundAttemptId }) => {
        if (reportedStale.has(foundAttemptId)) return;
        reportedStale.add(foundAttemptId);
        emit(`  … ignoring a result left by ${foundAttemptId ?? 'an unnamed attempt'}; waiting for ${currentAttemptId}.`);
        void store.appendEvent({
          type: 'STALE_RESULT_IGNORED',
          role, jobId, expectedAttemptId: currentAttemptId, foundAttemptId: foundAttemptId ?? null,
        }).catch(() => {});
      },
    });
    if (envelope) return { envelope, attemptId: currentAttemptId };

    // The attempt this loop is waiting for may have ended while it slept — a
    // capacity retry, a recovery, a harness repair. Follow it, but only
    // through a chain the job itself proves; anything else keeps waiting on
    // the attempt it was told to wait for.
    if (currentAttemptId) {
      // eslint-disable-next-line no-await-in-loop
      const attemptState = await store.readAttemptState(role, jobId);
      const successor = findAuthorizedSuccessor(attemptState, currentAttemptId);
      if (successor?.authorized) {
        emit(`  … ${currentAttemptId} ended (${successor.endedReason}); following authorized successor ${successor.attemptId}.`);
        // eslint-disable-next-line no-await-in-loop
        await store.appendEvent({
          type: 'ATTEMPT_WAIT_HANDOFF',
          goal, round, role, jobId,
          fromAttemptId: currentAttemptId, toAttemptId: successor.attemptId,
          reason: successor.endedReason, hops: successor.hops,
        });
        currentAttemptId = successor.attemptId;
        // Re-check immediately: the successor's result may already be on disk.
        continue;
      }
    }

    if (Date.now() - startedAt > resultTimeoutMs) {
      const lease = await leaseStore?.readJobLease(jobId);
      const { status, ageMs } = lease ? classifyLease(lease) : { status: null, ageMs: null };
      return {
        observerTimeout: true,
        lease,
        leaseStatus: status,
        leaseAgeMs: ageMs,
        attemptId: currentAttemptId,
      };
    }

    const health = await readWorkerHealth(store, role);
    if (health.state !== lastState) {
      lastState = health.state;
      const suffix = health.capacityReason ? ` (${health.capacityReason})` : '';
      emit(`  … ${role}: ${health.state ?? 'unknown'}${suffix}`);
    }
    if (health.health === WORKER_HEALTH.OFFLINE) {
      // The worker is gone. Whether its child died with it is NOT knowable
      // here, so this is reported, not resolved: no new attempt is started.
      return { workerOffline: true, attemptId: currentAttemptId };
    }

    await sleep(pollMs);
  }
}
