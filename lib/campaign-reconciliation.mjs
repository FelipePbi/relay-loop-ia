/**
 * IA Loop — campaign position reconciliation.
 *
 * The autonomous run keeps its own position in the migration: which Goal it is
 * on, which ones it has finished, which baseline it believes is accepted. That
 * record is written by exactly one caller, `run-auto`, at exactly one moment —
 * after `run-close` returns to it.
 *
 * Which means any closure that happens WITHOUT `run-auto` in the loop freezes
 * it. A human running `ia-loop:close` directly, or an orchestrator that dies
 * between the closure and the record, both leave the campaign pointing at a
 * Goal that is already closed, forever, because nothing else ever writes there.
 *
 * That is not hypothetical. Of the Goals with a `GOAL_CLOSED` event, only 004,
 * 005, 006 and 012 also have the `MIGRATION_BASELINE_UPDATED` that proves the
 * run recorded them; 007 through 011 and 013 do not. Run `auto-987b6c55` sat on
 * Goal 007 for four days while 008, 009, 010 and 011 closed around it, and was
 * finally archived as `GOAL_BOUNDARY_AMBIGUOUS` — the boundary check noticing
 * the drift it could not explain.
 *
 * So the drift is detected already. What was missing is the reading that makes
 * it ordinary: a closure recorded on disk, integrated into the history HEAD is
 * standing on, naming the next Goal, is not an ambiguity. It is a Goal that
 * finished while the campaign record was not watching, and the record can be
 * moved to match the evidence.
 *
 * This decides; it never writes and never touches git. The caller proves
 * integration and applies the move through the store's existing writers, so
 * the advance is indistinguishable from one the loop made itself.
 */

export const RECONCILIATION_ACTIONS = Object.freeze({
  /** The record already matches the evidence, or the evidence does not support a move. */
  NONE: 'NONE',
  /** The current Goal closed outside the run; move the record onto the next one. */
  ADVANCE: 'ADVANCE',
});

/**
 * Should the campaign record be moved onto the next Goal?
 *
 * Fails closed, like every other judgement at a Goal boundary: every condition
 * below must hold, and anything unexpected returns NONE with the reason, so the
 * boundary check downstream still gets its chance to stop the run. Guessing
 * here would silently SKIP a Goal, which is worse than any stop.
 *
 * @param run               the campaign record as persisted
 * @param closure           `runtime.closure`, as `run-close` left it
 * @param closureIntegrated the caller's proof that `closure.integratedClosureCommit`
 *                          is reachable from HEAD — never assumed from the record
 */
export function reconcileCampaignPosition({ run, closure, closureIntegrated = false } = {}) {
  const none = (reason) => Object.freeze({ action: RECONCILIATION_ACTIONS.NONE, reason });

  if (!run?.currentGoal) return none('the run records no current Goal');
  if (!closure) return none('no closure is recorded in the runtime');

  // A closure for a DIFFERENT Goal says nothing about this one. It is the
  // previous Goal's receipt, still sitting there because nothing clears it.
  if (closure.goal !== run.currentGoal) {
    return none(`the recorded closure is for Goal ${closure.goal}, not ${run.currentGoal}`);
  }

  if (run.completedGoals?.includes(closure.goal)) {
    return none(`Goal ${closure.goal} is already recorded as completed`);
  }

  const baseline = closure.newMigrationBaseline;
  const nextGoal = closure.nextGoalId;
  const integratedCommit = closure.integratedClosureCommit;

  if (typeof integratedCommit !== 'string' || integratedCommit.trim() === '') {
    return none('the closure names no integrated commit');
  }
  if (typeof baseline !== 'string' || baseline.trim() === '') {
    return none('the closure names no new baseline');
  }
  // No next Goal is NEVER read as "the migration is over". That declaration is
  // the Tech Lead's, it arrives through its own field, and a missing next Goal
  // here means planning did not finish — which is a stop, not an advance.
  if (typeof nextGoal !== 'string' || nextGoal.trim() === '') {
    return none('the closure names no next Goal');
  }
  if (nextGoal === closure.goal) {
    return none(`the closure names Goal ${nextGoal} as its own successor`);
  }

  // The decisive one. A sha written into the runtime proves only that something
  // intended to commit; reachability from HEAD proves it survived.
  if (!closureIntegrated) {
    return none(`closure commit ${integratedCommit} is not reachable from HEAD`);
  }

  return Object.freeze({
    action: RECONCILIATION_ACTIONS.ADVANCE,
    completedGoal: closure.goal,
    baseline,
    nextGoal,
    evidence: `closure commit ${integratedCommit} is integrated and names Goal ${nextGoal} as next`,
  });
}
