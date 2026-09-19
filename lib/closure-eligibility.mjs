/**
 * IA Loop — proving a Goal is eligible for closure, independently of the
 * ledger's own conclusion.
 *
 * `reconcileExecutionState` (reconcile.mjs) already only returns
 * `DISPATCH_KINDS.CLOSE_GOAL` when its ledger shows the round's review stage
 * COMPLETED with `decision === 'ACCEPTED'`. `assertGoalEligibleForClosure`
 * re-derives the same conclusion from the job store directly, scoped to the
 * exact job the ledger named — a second, independent read of the same facts,
 * not a second opinion about them. If the two ever disagree, that is a bug in
 * one of them, and this fails closed rather than trusting the first answer.
 *
 * What it adds beyond the ledger: fencing. The ledger's `stage.result` is read
 * once, at ledger-build time, from whichever result was on the primary path
 * then. This asks again, fenced to the CURRENT completed attempt — so a
 * caller acting on this guard's evidence is proven to be acting on the
 * attempt that is actually COMPLETED right now, not on a snapshot that could
 * have gone stale between the ledger read and this one.
 */

import { SpikeError } from './claude-process.mjs';

function fail(code, message, details = {}) {
  throw new SpikeError(code, message, details);
}

/**
 * @returns `{ goal, round, reviewJobId, attemptId, decision: 'ACCEPTED' }` —
 *          the evidence a caller may hand to `machine.hydrateTo(ACCEPTED, ...)`.
 *          Throws `CLOSURE_INELIGIBLE` (with a `reason` in `details`) for
 *          anything short of a fully proven acceptance. Never returns a
 *          partial or best-effort answer.
 */
export async function assertGoalEligibleForClosure(store, { goal, round, reviewJobId }) {
  if (!goal || !round || !reviewJobId) {
    fail('INVALID_ARGS', 'assertGoalEligibleForClosure needs goal, round and reviewJobId');
  }

  const job = await store.readJob('tech_lead', reviewJobId).catch(() => null);
  if (!job) {
    fail('CLOSURE_INELIGIBLE', `Review job ${reviewJobId} does not exist`,
      { reason: 'REVIEW_JOB_NOT_FOUND', reviewJobId });
  }
  if (job.goal !== goal) {
    fail('CLOSURE_INELIGIBLE', `Review job ${reviewJobId} belongs to Goal ${job.goal}, not ${goal}`,
      { reason: 'GOAL_MISMATCH', reviewJobId, expectedGoal: goal, actualGoal: job.goal });
  }
  if (Number(job.round) !== Number(round)) {
    fail('CLOSURE_INELIGIBLE', `Review job ${reviewJobId} is round ${job.round}, not ${round}`,
      { reason: 'ROUND_MISMATCH', reviewJobId, expectedRound: round, actualRound: job.round });
  }

  const attemptState = await store.readAttemptState('tech_lead', reviewJobId);
  if (attemptState?.attemptStatus !== 'COMPLETED') {
    fail('CLOSURE_INELIGIBLE',
      `Review job ${reviewJobId}'s current attempt is ${attemptState?.attemptStatus ?? 'unknown'}, not COMPLETED`,
      { reason: 'ATTEMPT_NOT_COMPLETED', reviewJobId, attemptStatus: attemptState?.attemptStatus ?? null });
  }

  // Fenced: the result trusted here must belong to the attempt just proven
  // COMPLETED — never a stale envelope a superseded attempt left behind.
  const envelope = await store.readResult('tech_lead', reviewJobId, { expectedAttemptId: attemptState.attemptId });
  if (!envelope?.ok) {
    fail('CLOSURE_INELIGIBLE',
      `Review job ${reviewJobId} has no valid result fenced to its completed attempt ${attemptState.attemptId}`,
      { reason: 'RESULT_NOT_FENCED', reviewJobId, attemptId: attemptState.attemptId });
  }
  if (envelope.result?.decision !== 'ACCEPTED') {
    fail('CLOSURE_INELIGIBLE',
      `Review job ${reviewJobId}'s decision is ${envelope.result?.decision ?? 'unknown'}, not ACCEPTED`,
      { reason: 'NOT_ACCEPTED', reviewJobId, decision: envelope.result?.decision ?? null });
  }
  const blockers = envelope.result?.blockers ?? [];
  if (blockers.length > 0) {
    fail('CLOSURE_INELIGIBLE',
      `Review job ${reviewJobId} is ACCEPTED but still carries ${blockers.length} blocker(s)`,
      { reason: 'UNRESOLVED_BLOCKERS', reviewJobId, blockers: blockers.length });
  }

  return Object.freeze({
    goal, round, reviewJobId, attemptId: attemptState.attemptId, decision: 'ACCEPTED',
  });
}
