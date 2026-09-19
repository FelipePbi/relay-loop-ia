/**
 * IA Loop — what to do after a crash.
 *
 * Recovery is a decision, not a reset. Given a stored state and what is already
 * on disk, exactly one next step is safe, and this decides which — as a pure
 * function, so every branch is testable without a machine, a model or a repo.
 *
 * The rule that governs all of it: an inference that already produced a result
 * is never paid for twice. A crash destroys the process, not the artefact — and
 * on the run this was written for, the reviewer's answer landed on disk four
 * seconds after the last heartbeat. Re-running it would have thrown away work
 * that was already finished and already paid for.
 */

import { LOOP_STATES, STATE_REGISTRY } from './state-registry.mjs';
import { STAGES } from './stage-identity.mjs';
import { resolveStageJobId, STAGE_JOB_SOURCE } from './reconcile.mjs';

export const RECOVERY_ACTIONS = Object.freeze({
  NOTHING_TO_RECOVER: 'NOTHING_TO_RECOVER',
  BLOCKED: 'BLOCKED',
  CONSUME_RESULT: 'CONSUME_RESULT',
  REQUEUE_JOB: 'REQUEUE_JOB',
  RESUME_PHASE: 'RESUME_PHASE',
});

/**
 * States whose recovery is decided by looking for a result on disk.
 *
 * Derived from the registry rather than hand-listed: every state where an agent
 * is working is a state where a crash can leave a finished result unconsumed,
 * and a future execution state must not be forgotten here the way
 * CORRECTION_RUNNING once was.
 */
export const AGENT_EXECUTION_STATES = Object.freeze(
  Object.entries(STATE_REGISTRY)
    .filter(([, def]) => def.execution === true)
    .map(([name]) => name),
);

/** States where a job is published and simply waiting to be picked up. */
const QUEUED_STATES = Object.freeze([
  LOOP_STATES.DEVELOPER_QUEUED,
  LOOP_STATES.CORRECTION_QUEUED,
  LOOP_STATES.REVIEWER_QUEUED,
]);

/**
 * States that are pure orchestration — no agent is mid-inference, and the
 * phase's own idempotency (recorded commit SHAs, snapshots, closure fields)
 * decides what still needs doing when it runs again.
 */
const REPLAYABLE_PHASES = Object.freeze({
  [LOOP_STATES.PREPARING_WORKTREE]: 'goal',
  [LOOP_STATES.WORKTREE_READY]: 'goal',
  [LOOP_STATES.REVIEW_REQUIRED]: 'goal',
  [LOOP_STATES.CHANGES_REQUIRED]: 'goal',
  [LOOP_STATES.ACCEPTED]: 'close',
  [LOOP_STATES.CLOSURE_PREPARING]: 'close',
  [LOOP_STATES.CLOSURE_READY]: 'close',
  [LOOP_STATES.GOAL_COMMITTING]: 'close',
  [LOOP_STATES.GOAL_COMMITTED]: 'close',
  [LOOP_STATES.INTEGRATING_ACCEPTED]: 'close',
  [LOOP_STATES.BASELINE_ACCEPTED]: 'close',
  [LOOP_STATES.NEXT_GOAL_READY]: 'auto',
  [LOOP_STATES.NEXT_GOAL_STARTING]: 'auto',
  [LOOP_STATES.GOAL_READY]: 'goal',
});

/** Which agent owns the job in a given execution state. */
export function agentForState(state) {
  return STATE_REGISTRY[state]?.agent ?? null;
}

/** Which stage the persisted state claims was in flight, from the name alone. */
export function stageForState(state) {
  if (state?.startsWith('REVIEWER')) return STAGES.REVIEW;
  if (state?.startsWith('CORRECTION')) return STAGES.CORRECTION;
  return STAGES.IMPLEMENTATION;
}

/**
 * The job (and whether it already has a result) that recovery should act on
 * for the stage `runtime.state` claims was running — resolved from the stage
 * ledger alone, via the same resolveStageJobId a fresh dispatch would use.
 *
 * runtime.currentJobId never enters this: it is a hint, and a hint that
 * disagrees with the ledger was never more correct, only older. See the note
 * in planRecovery for the incident this is closing off.
 */
export function resolveRecoveryJob({ reconciled, runtime }) {
  const round = Number(runtime?.round);
  if (!reconciled || !runtime?.goal || !Number.isInteger(round) || round < 1) {
    return { jobId: null, resultExists: false, source: STAGE_JOB_SOURCE.NEW_JOB_REQUIRED };
  }
  const resolved = resolveStageJobId({
    ledger: reconciled.ledger, goal: runtime.goal, round, stage: stageForState(runtime.state),
  });
  return { ...resolved, resultExists: resolved.source === STAGE_JOB_SOURCE.COMPLETED };
}

/**
 * @param facts.runtime          persisted loop runtime
 * @param facts.autonomousRun    persisted autonomous run, if any
 * @param facts.ownerVerdict     judgement of the orchestrator lease holder
 * @param facts.leaseExists      whether a loop lease is on disk at all
 * @param facts.resultExists     true when the stage already has a result
 * @param facts.jobStatus        stored status of that attempt
 * @param facts.jobId            the attempt that OWNS the stage, as the caller
 *                               resolved it from the stage ledger (see
 *                               resolveRecoveryJob). Null means the ledger
 *                               named nothing legitimate for this stage — there
 *                               is no fallback to runtime.currentJobId, which is
 *                               a pointer a crash can leave aimed at an attempt
 *                               the ledger has since disowned.
 */
export function planRecovery({
  runtime,
  autonomousRun = null,
  ownerVerdict = null,
  leaseExists = false,
  resultExists = false,
  jobStatus = null,
  jobId: reconciledJobId = null,
}) {
  const blocked = (reason, message) => ({ action: RECOVERY_ACTIONS.BLOCKED, reason, message });

  if (!runtime) {
    return { action: RECOVERY_ACTIONS.NOTHING_TO_RECOVER, message: 'No run recorded yet.' };
  }

  // --- Gates that recovery must never walk past -----------------------------

  if (runtime.state === LOOP_STATES.HUMAN_REQUIRED || runtime.state === LOOP_STATES.AWAITING_HUMAN) {
    return blocked('HUMAN_REQUIRED',
      `The run is ${runtime.state} (${runtime.humanRequired?.reason ?? 'reason not recorded'}). `
      + 'Recovery restores an interrupted execution; it does not resolve a problem a person has to look at.');
  }

  if (autonomousRun?.status === 'PAUSED_FOR_HUMAN') {
    return blocked('HUMAN_REQUIRED',
      `Run ${autonomousRun.autonomousRunId} is stopped for a human `
      + `(${autonomousRun.humanRequired?.reason ?? 'reason not recorded'}). Recovery will not clear it.`);
  }

  if (runtime.state === LOOP_STATES.WAITING_FOR_CAPACITY) {
    // A usage limit is not a crash. Keeping the two apart is what stops a
    // rate limit from being "recovered" into a duplicate inference.
    return blocked('CAPACITY_WAIT',
      'The run is parked waiting for capacity, not interrupted. Use ia-loop:resume.');
  }

  if (STATE_REGISTRY[runtime.state]?.terminal) {
    return { action: RECOVERY_ACTIONS.NOTHING_TO_RECOVER, message: `The run is ${runtime.state}.` };
  }

  // --- Is the previous orchestrator really gone? ----------------------------

  if (leaseExists) {
    if (ownerVerdict?.status === 'ACTIVE' || ownerVerdict?.status === 'OWNER_ALIVE') {
      return blocked('ORCHESTRATOR_ALIVE',
        `The loop is still owned: ${ownerVerdict.detail} Recovering would put two orchestrators on one run.`);
    }
    if (ownerVerdict?.status !== 'ORPHAN_CONFIRMED') {
      return blocked('ORPHAN_NOT_CONFIRMED',
        `The lease is ${ownerVerdict?.status ?? 'unreadable'} and abandonment could not be proven: `
        + `${ownerVerdict?.detail ?? 'no evidence'} Recovery refuses rather than guessing.`);
    }
  }

  // --- What was interrupted? ------------------------------------------------

  // No runtime-hint fallback. The caller resolves this from the stage ledger
  // (see resolveRecoveryJob / resolveStageJobId below) and passes the answer
  // in as `jobId`; if that resolution found nothing, `runtime.currentJobId` is
  // deliberately never consulted as a substitute. That pointer is exactly what
  // a crash can leave aimed at a job the ledger has since disowned —
  // SUPERSEDED, from a different round, or superseded by a genuine correction
  // — and REQUEUE_JOB below flips the target's status to INTERRUPTED with no
  // check on what it was before, which would have made a superseded job
  // claimable again. The equivalent hint in run-goal.mjs (jobIdsByRound) had
  // exactly this failure shape; resolveStageJobId is the ledger-only fix for
  // both.
  const jobId = reconciledJobId ?? null;
  const agent = agentForState(runtime.state);

  if (AGENT_EXECUTION_STATES.includes(runtime.state) || QUEUED_STATES.includes(runtime.state)) {
    if (!jobId) {
      return blocked('STATE_INCONSISTENT',
        `The run is ${runtime.state} but records no current job. Recovery cannot tell what was running.`);
    }

    if (resultExists) {
      // The crash killed the reader, not the work.
      return {
        action: RECOVERY_ACTIONS.CONSUME_RESULT,
        state: runtime.state,
        agent,
        jobId,
        phase: phaseForState(runtime.state),
        message: `A completed result for ${jobId} is already on disk; it is consumed, not recomputed.`,
      };
    }

    return {
      action: RECOVERY_ACTIONS.REQUEUE_JOB,
      state: runtime.state,
      agent,
      jobId,
      phase: phaseForState(runtime.state),
      previousJobStatus: jobStatus,
      message:
        `${jobId} was interrupted before producing a result. The attempt is recorded as INTERRUPTED and the `
        + 'same job is re-queued — same Goal, same round, same packet.',
    };
  }

  const phase = REPLAYABLE_PHASES[runtime.state];
  if (phase) {
    return {
      action: RECOVERY_ACTIONS.RESUME_PHASE,
      state: runtime.state,
      phase,
      message:
        `The run stopped at ${runtime.state}, between agent steps. The phase runs again and skips whatever it `
        + 'already recorded as done.',
    };
  }

  return blocked('STATE_NOT_RECOVERABLE',
    `There is no defined recovery for ${runtime.state}.`);
}

/** Which runner owns a state, so recovery can say where the run continues. */
export function phaseForState(state) {
  if (REPLAYABLE_PHASES[state]) return REPLAYABLE_PHASES[state];
  if (state === LOOP_STATES.CLOSURE_DOCUMENTING || state === LOOP_STATES.NEXT_GOAL_PLANNING) return 'close';
  return 'goal';
}
