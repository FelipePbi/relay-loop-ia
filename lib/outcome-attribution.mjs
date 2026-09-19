/**
 * IA Loop — correlating a model invocation to the Work Unit it belonged to,
 * the review/repair that followed, and a final OUTCOME — using only IDs the
 * harness already writes (`work_unit_id`, `forVerification`, `goal`/`round`),
 * never temporal proximity. Proximity is how you get "the review right after
 * this call must be about it" wrong the one time two things happen to
 * overlap; an ID is either the same thing or it is not.
 *
 * Every outcome carries an ATTRIBUTION CONFIDENCE, because not every
 * consequence can be pinned on one model:
 *
 *   DIRECT         one invocation, no retry/escalation, no repair — the
 *                  outcome is that call's alone.
 *   SHARED         a chain (retry, fallback, escalation, or a repair that
 *                  targeted this unit) produced the outcome — it belongs to
 *                  the chain, not to any one link in it.
 *   INDIRECT       a Goal/round-level signal (a review decision spanning
 *                  every Work Unit in the round) touches this unit without a
 *                  unit-specific structural link.
 *   UNATTRIBUTED   no terminal evidence exists for this unit at all.
 *
 * INDIRECT and UNATTRIBUTED are never promoted to DIRECT responsibility —
 * that promotion is exactly the fabrication this module exists to refuse.
 */

export const OUTCOMES = Object.freeze({
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  ACCEPTED: 'ACCEPTED',
  CHANGES_REQUIRED: 'CHANGES_REQUIRED',
  REPAIRED: 'REPAIRED',
  ABORTED: 'ABORTED',
  UNKNOWN: 'UNKNOWN',
});

export const ATTRIBUTION = Object.freeze({
  DIRECT: 'DIRECT',
  SHARED: 'SHARED',
  INDIRECT: 'INDIRECT',
  UNATTRIBUTED: 'UNATTRIBUTED',
});

/** `goal::round` key used to correlate a round-level event to its Work Units. */
export function roundKey(goalId, roundId) {
  return `${goalId ?? '-'}::${roundId ?? '-'}`;
}

/**
 * Indexes `WORK_UNIT_FIX_CREATED` events by the unit they repair
 * (`forVerification`) — the ONE structural link the harness records between
 * a failure and the corrective unit it spawned. `attributedTo` (whether the
 * repair was caused by the model's own output vs. infrastructure) exists on
 * the event shape but is not populated by the harness today — read
 * defensively and reported as UNKNOWN rather than guessed.
 */
export function indexFixEvents(events) {
  const byTarget = new Map();
  for (const event of events) {
    if (event.type !== 'WORK_UNIT_FIX_CREATED' || !event.forVerification) continue;
    const key = `${event.goal ?? '-'}::${event.round ?? '-'}::${event.forVerification}`;
    const list = byTarget.get(key) ?? [];
    list.push(event);
    byTarget.set(key, list);
  }
  return byTarget;
}

/**
 * Indexes `REVIEW_DECISION_PUBLISHED` events by `goal::round` — a review
 * decision is a ROUND-level fact (Goal 014 §8: never attributed directly to
 * one Work Unit when the harness cannot tell which unit it concerns).
 * The LAST decision published for a round wins, matching how a round can be
 * re-reviewed after a correction.
 */
export function indexReviewDecisions(events) {
  const byRound = new Map();
  for (const event of events) {
    if (event.type !== 'REVIEW_DECISION_PUBLISHED') continue;
    byRound.set(roundKey(event.goal, event.round), event);
  }
  return byRound;
}

/**
 * Indexes `WORK_UNIT_COMPLETED`/`WORK_UNIT_BLOCKED` events by unit — the
 * harness's OWN terminal verdict for a Work Unit, preferred over inferring
 * one from the ledger's `finalStatus` alone because it also reports states
 * a ledger row cannot (`BLOCKED`, `ESCALATION_REQUIRED`).
 */
export function indexUnitCompletionEvents(events) {
  const byUnit = new Map();
  for (const event of events) {
    if (event.type !== 'WORK_UNIT_COMPLETED') continue;
    const key = `${event.goal ?? '-'}::${event.round ?? '-'}::${event.workUnitId}`;
    byUnit.set(key, event);
  }
  return byUnit;
}

/**
 * Attributes ONE Work Unit aggregate (see `historical-distributions.mjs`'s
 * `groupIntoWorkUnits`) to an outcome and an attribution confidence.
 *
 * `context.fixEventsByTarget`/`reviewDecisionsByRound`/`completionsByUnit`
 * come from the indexers above; all three are optional, and their absence
 * degrades the result toward `UNATTRIBUTED`/`INDIRECT` rather than throwing.
 */
export function attributeWorkUnit(unit, {
  fixEventsByTarget = new Map(), reviewDecisionsByRound = new Map(), completionsByUnit = new Map(),
} = {}) {
  const unitKey = `${unit.goalId ?? '-'}::${unit.roundId ?? '-'}::${unit.workUnitId}`;
  const wasRepaired = fixEventsByTarget.has(unitKey);
  const completion = completionsByUnit.get(unitKey);
  const state = completion?.state ?? unit.finalStatus ?? null;

  let outcome = OUTCOMES.UNKNOWN;
  let attribution = ATTRIBUTION.UNATTRIBUTED;

  if (state === 'COMPLETED') {
    outcome = wasRepaired ? OUTCOMES.REPAIRED : OUTCOMES.SUCCESS;
    attribution = (unit.modelCalls === 1 && !wasRepaired) ? ATTRIBUTION.DIRECT : ATTRIBUTION.SHARED;
  } else if (state === 'FAILED') {
    outcome = OUTCOMES.FAILED;
    attribution = unit.modelCalls === 1 ? ATTRIBUTION.DIRECT : ATTRIBUTION.SHARED;
  } else if (state === 'BLOCKED' || state === 'ESCALATION_REQUIRED') {
    outcome = OUTCOMES.ABORTED;
    attribution = ATTRIBUTION.SHARED;
  }
  // No completion event and no usable ledger finalStatus: stays UNKNOWN/UNATTRIBUTED.

  const decision = reviewDecisionsByRound.get(roundKey(unit.goalId, unit.roundId));
  const reviewOutcome = decision ? {
    outcome: decision.decision === 'ACCEPTED' ? OUTCOMES.ACCEPTED : OUTCOMES.CHANGES_REQUIRED,
    // A round-level decision is SHARED by every Work Unit in the round —
    // never DIRECT, because the harness cannot tell which unit(s) a review
    // decision is actually about (Goal 014 §8).
    attribution: ATTRIBUTION.SHARED,
  } : null;

  const repairCause = wasRepaired
    ? (fixEventsByTarget.get(unitKey).some((event) => event.attributedTo) ? 'MODEL_OUTPUT' : 'UNKNOWN')
    : null;

  return {
    workUnitId: unit.workUnitId, goalId: unit.goalId, roundId: unit.roundId,
    outcome, attribution, reviewOutcome, repaired: wasRepaired, repairCause,
  };
}

/**
 * Whether a FAILED call's failure is relevant to a model-quality question at
 * all, reusing the SAME taxonomy `lib/failure-taxonomy.mjs`/
 * `capacity-classifier.mjs` already write to `failure_family`/`failure_reason`
 * — never a second, parallel classification.
 *
 *   TIMEOUT / CAPACITY_FAILURE / RATE_LIMIT / INFRA_FAILURE   not the
 *     model's fault: a provider capacity limit or a harness/tooling problem.
 *   VALIDATION_FAILURE   the model's own output failed contract validation —
 *     relevant to quality.
 *   UNKNOWN   no family recorded. Counted as quality-relevant by default:
 *     there is no positive evidence it was infra, and treating an unknown
 *     failure as automatically NOT the model's fault would be the more
 *     dangerous assumption of the two.
 *
 * `STATE_MACHINE_FAILURE` from the Goal's own taxonomy has no observable
 * source in the ledger today (nothing marks a failure as state-machine
 * related) and is never assigned — see the README for this limitation.
 */
export function classifyFailureRelevance(row) {
  if (row.timed_out === 1 || row.timed_out === true) return { category: 'TIMEOUT', qualityRelevant: false };
  if (row.failure_family === 'MODEL_CAPACITY') {
    return { category: row.failure_reason === 'RATE_LIMIT' ? 'RATE_LIMIT' : 'CAPACITY_FAILURE', qualityRelevant: false };
  }
  if (row.failure_family === 'HARNESS') return { category: 'INFRA_FAILURE', qualityRelevant: false };
  if (row.failure_family === 'AGENT_CONTRACT') return { category: 'VALIDATION_FAILURE', qualityRelevant: true };
  return { category: 'UNKNOWN', qualityRelevant: true };
}
