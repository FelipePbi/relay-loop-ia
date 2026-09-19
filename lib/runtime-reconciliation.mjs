/**
 * IA Loop — making the runtime agree with what actually happened.
 *
 * `runtime.json` is DERIVED state: a cache of what the orchestrator concluded
 * as it went. The jobs and their results are the facts. When the two disagree,
 * the facts win — always, and without argument.
 *
 * The failure this exists for: Goal 005 R1's review really did complete, with
 * CHANGES_REQUIRED, two blockers and an OPUS_MEDIUM escalation for the next
 * round. But the orchestrator had already read a dead attempt's failure
 * envelope off the primary result path and written HUMAN_REQUIRED /
 * UNKNOWN_FATAL into the runtime — 4.5 minutes before the review finished. The
 * result was correct on disk the whole time. The runtime was a record of a
 * conclusion drawn from the wrong file.
 *
 * The precedence, stated once so nothing has to infer it:
 *
 *   1. a valid COMPLETED result for the current/most recent attempt
 *   2. the JobStore's attempt history
 *   3. the persisted stage ledger
 *   4. the runtime the orchestrator derived
 *
 * A runtime human-gate NEVER outranks a completed result. This module only ever
 * moves the runtime toward the facts; it cannot invent a decision, cannot
 * create an attempt, and cannot clear a gate the facts still support.
 *
 * A second, related lie the runtime can tell: Goal 005 R2's review completed —
 * ACCEPTED, no blockers — while a live orchestrator process was still asleep in
 * its wait loop, fenced on the attempt that review's capacity retry had already
 * superseded (`result-waiter.mjs` is what stops that going forward). The
 * runtime it had written stayed REVIEWER_RUNNING, at the PREVIOUS round's
 * decision, with nothing to move it. That is not a human gate; it is an
 * in-flight marker the facts have already outrun. `runtimeInFlightStale` below
 * is what catches it: the runtime claims stage X of its own round is still
 * running, and the ledger shows that exact stage COMPLETED. It only ever
 * fires when a decisive result already landed — a genuinely active stage
 * always shows IN_FLIGHT or NOT_STARTED there, never COMPLETED — so it can
 * never mistake real, ongoing work for staleness. And it only ever moves the
 * runtime TOWARD progress (a later stage, a later round, or CLOSE_GOAL) —
 * never toward a human gate, which stays the first divergence's job alone.
 */

import { SpikeError } from './claude-process.mjs';
import { DISPATCH_KINDS, STAGE_STATUS, reconcileExecutionState } from './reconcile.mjs';
import { LOOP_STATES } from './loop-state.mjs';
import { STAGES } from './stage-identity.mjs';
import { goalExecutionOf } from './goal-execution.mjs';
import { developerProfileOrDefault } from './developer-profiles.mjs';

/** Runtime states that assert a person is needed. */
const HUMAN_GATE_STATES = Object.freeze([LOOP_STATES.HUMAN_REQUIRED, LOOP_STATES.AWAITING_HUMAN]);

/** Where each dispatch kind says the run actually is. */
const STATE_FOR_DISPATCH = Object.freeze({
  [DISPATCH_KINDS.IMPLEMENTATION]: LOOP_STATES.DEVELOPER_QUEUED,
  [DISPATCH_KINDS.CORRECTION]: LOOP_STATES.CORRECTION_QUEUED,
  [DISPATCH_KINDS.REVIEW]: LOOP_STATES.REVIEWER_QUEUED,
  [DISPATCH_KINDS.CLOSE_GOAL]: LOOP_STATES.ACCEPTED,
  [DISPATCH_KINDS.HUMAN_REQUIRED]: LOOP_STATES.HUMAN_REQUIRED,
});

/**
 * Which dispatch kind an IN-FLIGHT runtime state claims to still be doing.
 *
 * Both the QUEUED and the RUNNING member of each stage are listed: a live
 * orchestrator writes QUEUED before dispatch and RUNNING once it starts
 * waiting, and the runtime can go stale in either one.
 */
const IN_FLIGHT_KIND_FOR_STATE = Object.freeze({
  [LOOP_STATES.DEVELOPER_QUEUED]: DISPATCH_KINDS.IMPLEMENTATION,
  [LOOP_STATES.DEVELOPER_RUNNING]: DISPATCH_KINDS.IMPLEMENTATION,
  [LOOP_STATES.CORRECTION_QUEUED]: DISPATCH_KINDS.CORRECTION,
  [LOOP_STATES.CORRECTION_RUNNING]: DISPATCH_KINDS.CORRECTION,
  [LOOP_STATES.REVIEWER_QUEUED]: DISPATCH_KINDS.REVIEW,
  [LOOP_STATES.REVIEWER_RUNNING]: DISPATCH_KINDS.REVIEW,
});

/**
 * Dispatch kinds that represent genuine progress past an in-flight stage.
 *
 * HUMAN_REQUIRED is deliberately absent: reconciling FROM an in-flight state
 * TO a human gate would need to populate `humanRequired` with the reason and
 * note the normal dispatch path attaches, which this function's blanket
 * `humanRequired: null` does not do. Rather than grow that special case here,
 * an in-flight runtime that the facts have moved to HUMAN_REQUIRED is left
 * alone: the live orchestrator process reaches that gate correctly on its
 * own once `result-waiter.mjs` lets it stop waiting on a superseded attempt.
 */
const PROGRESSION_KINDS = Object.freeze(new Set([
  DISPATCH_KINDS.IMPLEMENTATION, DISPATCH_KINDS.CORRECTION,
  DISPATCH_KINDS.REVIEW, DISPATCH_KINDS.CLOSE_GOAL,
]));

function fail(code, message, details = {}) {
  throw new SpikeError(code, message, details);
}

/**
 * Reads the authoritative picture for a Goal and says whether the runtime lies.
 *
 * Pure inspection: reads jobs, results and the runtime, writes nothing.
 */
export async function assessRuntimeDivergence(store, { goal, maxRounds = 3 }) {
  if (!goal) fail('INVALID_ARGS', 'assessRuntimeDivergence needs a goal');

  const { ledger, next } = await reconcileExecutionState({ store, goal, maxRounds });
  const runtime = await store.readRuntime();
  const execution = goalExecutionOf(runtime, goal);

  // The most recent completed review for this Goal, which is what a human gate
  // most often contradicts. A ledger stage carries its identity in `stageKey`,
  // not in a `stage` field, and the attempt that produced the result lives in
  // `attempts` — reading either one wrongly makes this silently find nothing.
  const isReview = (stage) => stage.stageKey.endsWith(`:${STAGES.REVIEW}`);
  const reviews = [...ledger.values()]
    .filter((stage) => isReview(stage) && stage.status === STAGE_STATUS.COMPLETED && stage.result?.decision)
    .sort((a, b) => a.round - b.round);
  const latestReview = reviews.at(-1) ?? null;
  const decision = latestReview?.result?.decision ?? null;
  const latestReviewAttemptId = latestReview
    ? (latestReview.attempts.find((a) => a.jobId === latestReview.completedBy)?.attemptId ?? null)
    : null;

  const runtimeState = execution?.state ?? null;
  const runtimeDecision = execution?.decision ?? null;
  const runtimeSaysHuman = HUMAN_GATE_STATES.includes(runtimeState) || runtimeDecision === 'HUMAN_REQUIRED';
  const factsSayHuman = next.kind === DISPATCH_KINDS.HUMAN_REQUIRED;

  // The runtime claims a stage is still in flight; does the ledger show that
  // EXACT stage already resolved? This can only be true when a decisive
  // result already landed — an active stage's ledger entry is always
  // IN_FLIGHT or NOT_STARTED, never COMPLETED — so it never flags genuinely
  // ongoing work.
  const expectedKind = IN_FLIGHT_KIND_FOR_STATE[runtimeState] ?? null;
  const runtimeInFlightStale = expectedKind !== null
    && PROGRESSION_KINDS.has(next.kind)
    && next.kind !== expectedKind;

  return {
    goal,
    ledger,
    next,
    runtime,
    execution,
    latestReview: latestReview
      ? {
        round: latestReview.round,
        jobId: latestReview.completedBy,
        attemptId: latestReviewAttemptId,
        decision,
        blockers: latestReview.result?.blockers ?? [],
        nextDeveloperProfile: latestReview.result?.nextDeveloperProfile ?? null,
        nextDeveloperProfileReason: latestReview.result?.nextDeveloperProfileReason ?? null,
      }
      : null,
    runtimeState,
    runtimeDecision,
    runtimeReason: execution?.escalationReason ?? null,
    runtimeInFlightStale,
    // Two different lies, one repair: the runtime holds a person hostage to a
    // conclusion the facts no longer support, OR the runtime still claims a
    // stage is running that the facts show already finished.
    diverged: (runtimeSaysHuman && !factsSayHuman) || runtimeInFlightStale,
    factsSayHuman,
  };
}

/**
 * Rewrites the derived runtime so it matches the facts.
 *
 * Refuses when there is nothing to repair, and refuses when the facts still
 * call for a human. Nothing is deleted: the event log keeps every earlier
 * conclusion, and this correction is appended as its own fact.
 */
export async function reconcileRuntimeFromResults(store, {
  goal,
  maxRounds = 3,
  now = Date.now(),
  autonomousStore = null,
  reason = 'STALE_ATTEMPT_RESULT_CONSUMED',
}) {
  const assessment = await assessRuntimeDivergence(store, { goal, maxRounds });

  if (!assessment.diverged) {
    fail('NOTHING_TO_RECONCILE',
      assessment.factsSayHuman
        ? `Goal ${goal} genuinely needs a human (${assessment.next.reason ?? assessment.next.kind}); the runtime is not wrong.`
        : `Goal ${goal}'s runtime already agrees with the jobs on disk.`);
  }

  const { next, latestReview, runtime, execution } = assessment;
  const at = new Date(now).toISOString();

  // What the round actually is, taken from the ledger rather than from the
  // runtime that got it wrong.
  const round = next.round ?? execution?.round ?? 1;

  // The profile the NEXT round runs on. Stated by the Tech Lead in the review
  // that produced the blockers; absent means the Goal keeps what it is on.
  const escalated = latestReview?.nextDeveloperProfile ?? null;
  const nextProfile = escalated
    ? {
      profile: escalated,
      reason: latestReview?.nextDeveloperProfileReason ?? null,
      round,
      selectedBy: 'tech_lead',
    }
    : (execution?.nextDeveloperProfile ?? null);

  if (escalated) developerProfileOrDefault(escalated);

  // Rounds that actually ran, rebuilt from the reviews on disk rather than kept
  // from a runtime that recorded none.
  const roundsRun = [...assessment.ledger.values()]
    .filter((stage) => stage.stageKey.endsWith(`:${STAGES.REVIEW}`)
      && stage.status === STAGE_STATUS.COMPLETED && stage.result?.decision)
    .sort((a, b) => a.round - b.round)
    .map((stage) => ({
      round: stage.round,
      decision: stage.result.decision,
      blockers: (stage.result.blockers ?? []).length,
    }));

  const reconciled = {
    ...runtime,
    goal,
    round,
    state: STATE_FOR_DISPATCH[next.kind] ?? LOOP_STATES.REVIEWER_QUEUED,
    // The verdict of the round that has actually been reviewed.
    decision: latestReview?.decision ?? null,
    reviewDecision: latestReview
      ? { round: latestReview.round, decision: latestReview.decision, jobId: latestReview.jobId }
      : null,
    // Exactly the blockers the review persisted. Never re-derived, never
    // re-asked for, never invented.
    blockers: next.kind === DISPATCH_KINDS.CORRECTION ? [...(next.blockers ?? [])] : [],
    roundsRun,
    nextDeveloperProfile: nextProfile,
    // The gate this correction removes. Why it was raised survives in the
    // event log and in the archived envelope.
    humanRequired: null,
    escalationReason: null,
    blockedAgent: null,
    blockedJobId: null,
    capacity: null,
    resumeFrom: null,
  };

  await store.writeRuntime(reconciled);

  await store.appendEvent({
    type: 'RUNTIME_RECONCILED_FROM_COMPLETED_RESULT',
    goal,
    round: latestReview?.round ?? round,
    jobId: latestReview?.jobId ?? null,
    attemptId: latestReview?.attemptId ?? null,
    previousRuntimeDecision: assessment.runtimeDecision,
    previousReason: assessment.runtimeReason,
    previousState: assessment.runtimeState,
    authoritativeDecision: latestReview?.decision ?? null,
    authoritativeSource: 'COMPLETED_REVIEW_RESULT',
    nextKind: next.kind,
    nextRound: round,
    nextDeveloperProfile: escalated,
    reason,
  });

  let run = null;
  if (autonomousStore) {
    run = await autonomousStore.read();
    if (run?.status === 'PAUSED_FOR_HUMAN') {
      run = await autonomousStore.write({
        ...run,
        status: 'RUNNING',
        humanRequired: null,
        reconciledFrom: {
          reason,
          jobId: latestReview?.jobId ?? null,
          decision: latestReview?.decision ?? null,
          at,
        },
      });
      await store.appendEvent({
        type: 'AUTONOMOUS_RUN_RESUMED',
        autonomousRunId: run.autonomousRunId,
        reason: 'RUNTIME_RECONCILED_FROM_COMPLETED_RESULT',
        jobId: latestReview?.jobId ?? null,
      });
    }
  }

  return { assessment, runtime: reconciled, run };
}
