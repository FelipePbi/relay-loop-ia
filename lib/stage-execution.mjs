/**
 * IA Loop — STAGE / ROUND / GOAL execution telemetry.
 *
 * Goal 014 measured Work Unit effectiveness. That unit of analysis does not
 * exist for a model that only ever runs planning/review/closure — Fable has
 * ZERO Work Units in the validated ledger (Goals 008-010). This module
 * builds the correlation those models actually need, at the STAGE (one
 * planning/review/closure/correction job), ROUND and GOAL level.
 *
 * ## Why `job_id` is the stage execution identity, not a new minted ID
 *
 * The Goal's own instruction is to audit existing telemetry BEFORE adding
 * persistence, and never duplicate what is already unambiguous. Audited
 * against the real ledger: `job_id` is stable across every retry, fallback
 * and escalation WITHIN one stage attempt (a fallback mints a new
 * `attemptId`, never a new `jobId` — see `usage-collector.mjs`'s
 * `generateInvocationId` docstring and the V22 incident in this README), and
 * distinct across separate stage attempts (a new round's review gets a new
 * `jobId`). No harness code mints a dedicated `stageExecutionId` today, so
 * every grouping this module produces is honestly classified
 * `LEGACY_RECONSTRUCTED` — never `EXACT` — until a future change makes the
 * harness mint one before dispatch. `job_id` is not treated as a "made-up"
 * substitute: it is read, unmodified, off a column the ledger already
 * guarantees is unique per real job. See "Correlation quality" below.
 *
 * Everything here is read-only arithmetic over `model_usage` rows and
 * `events.jsonl` entries already written by Goals 011-014's own
 * infrastructure. No new column, no new event, no model call.
 */

function n(value) {
  return Number.isFinite(value) ? value : 0;
}

export const STAGE_TYPES = Object.freeze({
  PLANNING: 'PLANNING',
  REVIEW: 'REVIEW',
  REPAIR: 'REPAIR',
  CLOSURE: 'CLOSURE',
});

/**
 * Round-level stage operations this module covers. `work_unit` and
 * `implementation` are deliberately excluded — that is Goal 014's domain
 * (Work Unit effectiveness), and conflating the two would double-count the
 * same invocations under two different units of analysis.
 */
const OPERATION_TO_STAGE_TYPE = Object.freeze({
  planning: STAGE_TYPES.PLANNING,
  review: STAGE_TYPES.REVIEW,
  correction: STAGE_TYPES.REPAIR,
  closure_documentation: STAGE_TYPES.CLOSURE,
});

export function isStageOperation(operation) {
  return Object.prototype.hasOwnProperty.call(OPERATION_TO_STAGE_TYPE, operation);
}

export function stageTypeOfOperation(operation) {
  return OPERATION_TO_STAGE_TYPE[operation] ?? null;
}

export const CORRELATION_QUALITY = Object.freeze({
  EXACT: 'EXACT',
  LEGACY_RECONSTRUCTED: 'LEGACY_RECONSTRUCTED',
  UNATTRIBUTED: 'UNATTRIBUTED',
});

export const STAGE_OUTCOMES = Object.freeze({
  ACCEPTED: 'ACCEPTED',
  CHANGES_REQUIRED: 'CHANGES_REQUIRED',
  PLAN_PRODUCED: 'PLAN_PRODUCED',
  CLOSURE_PUBLISHED: 'CLOSURE_PUBLISHED',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN',
});

export const ROUND_OUTCOMES = Object.freeze({
  CONTINUE: 'CONTINUE',
  ACCEPTED: 'ACCEPTED',
  CHANGES_REQUIRED: 'CHANGES_REQUIRED',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN',
});

/**
 * Groups stage-scoped ledger rows into one STAGE EXECUTION per `job_id` —
 * the identity that survives every retry/fallback/escalation inside it (see
 * module docstring). A row with no `job_id` at all (an unattributed call —
 * Goal 011's own UNKNOWN operation path) becomes its own single-row,
 * `UNATTRIBUTED` execution rather than being silently dropped.
 */
export function groupIntoStageExecutions(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!isStageOperation(row.operation)) continue;
    const key = row.job_id ?? `unattributed::${row.invocation_id ?? Math.random()}`;
    if (!groups.has(key)) {
      groups.set(key, {
        stageExecutionId: row.job_id ?? null,
        correlationQuality: row.job_id ? CORRELATION_QUALITY.LEGACY_RECONSTRUCTED : CORRELATION_QUALITY.UNATTRIBUTED,
        goalId: row.goal_id ?? null,
        roundId: row.round_id ?? null,
        stageType: OPERATION_TO_STAGE_TYPE[row.operation],
        role: row.role ?? null,
        rows: [],
      });
    }
    groups.get(key).rows.push(row);
  }
  return [...groups.values()].map(enrichStageExecution);
}

/** Adds the resolution chain and provider-vs-stage success split to one grouped execution. */
function enrichStageExecution(execution) {
  const byAttempt = [...execution.rows].sort((a, b) => n(a.attempt) - n(b.attempt));

  const resolutionChain = byAttempt.map((row) => ({
    attempt: row.attempt ?? null,
    requestedModel: row.requested_model ?? null,
    resolvedModel: row.resolved_model ?? null,
    status: row.status ?? null,
    isFallback: row.is_fallback === 1 || row.is_fallback === true,
    fallbackFromModel: row.fallback_from_model ?? null,
    isEscalation: row.is_escalation === 1 || row.is_escalation === true,
    escalationFromModel: row.escalation_from_model ?? null,
    failureFamily: row.failure_family ?? null,
    failureReason: row.failure_reason ?? null,
  }));

  const last = byAttempt[byAttempt.length - 1] ?? null;
  // `providerAttemptSuccess`: did the LAST real call to a provider succeed.
  // `stageResolutionSuccess`: did the stage, as a whole, reach a usable
  // result. These read the same underlying fact today (the last attempt's
  // status) but are named and returned separately — see Goal 015 §16 — so a
  // future distinction (e.g. a stage whose last call succeeded but whose
  // result was later discarded) has somewhere to live without renaming
  // everything that reads this shape.
  const providerAttemptSuccess = last ? last.status === 'COMPLETED' : null;
  const stageResolutionSuccess = providerAttemptSuccess;

  const startedAt = byAttempt.reduce((min, row) => (row.started_at && (!min || row.started_at < min) ? row.started_at : min), null);
  const finishedAt = byAttempt.reduce((max, row) => (row.finished_at && (!max || row.finished_at > max) ? row.finished_at : max), null);

  return {
    ...execution,
    resolutionChain,
    providerAttemptSuccess,
    stageResolutionSuccess,
    // Read-side reconstructed timing, NOT a persisted STAGE_STARTED/COMPLETED
    // event — labelled as such so a caller never mistakes this for the
    // harness's own lifecycle record (which does not exist yet).
    lifecycle: { reconstructedFrom: 'model_usage', startedAt, finishedAt },
  };
}

/**
 * Indexes the business-outcome events a stage execution can be tied to,
 * keyed by `jobId` — a STRUCTURAL link, stronger than Goal 014's round-level
 * `SHARED` review attribution: `REVIEW_DECISION_PUBLISHED` carries the exact
 * `jobId` of the review job that produced it, so a stage execution's outcome
 * can be `DIRECT` here even where the Work-Unit view could only ever be
 * `SHARED`.
 */
export function indexStageOutcomeEvents(events) {
  const byJobId = new Map();
  for (const event of events) {
    if (event.type === 'REVIEW_DECISION_PUBLISHED' && event.jobId) {
      byJobId.set(event.jobId, { outcome: event.decision === 'ACCEPTED' ? STAGE_OUTCOMES.ACCEPTED : STAGE_OUTCOMES.CHANGES_REQUIRED, source: event.type });
    } else if (event.type === 'CLOSURE_DOCUMENTATION_PUBLISHED' && event.jobId) {
      byJobId.set(event.jobId, { outcome: STAGE_OUTCOMES.CLOSURE_PUBLISHED, source: event.type, documents: event.documents ?? null });
    } else if (event.type === 'NEXT_GOAL_PLANNING_PUBLISHED' && event.jobId) {
      byJobId.set(event.jobId, { outcome: STAGE_OUTCOMES.PLAN_PRODUCED, source: event.type, planningDecision: event.planningDecision ?? null });
    }
  }
  return byJobId;
}

/**
 * Attributes ONE stage execution to a business outcome.
 *
 * `DIRECT` when the execution's own `jobId` matches an outcome event exactly
 * (the common, and today the ONLY, case this ledger's events support).
 * `UNKNOWN` — never fabricated as `ACCEPTED` — when the stage's last provider
 * attempt succeeded but no outcome event exists for it (Goal 015 §7's
 * explicit rule: process exiting without exception is not evidence of
 * acceptance).
 */
export function attributeStageOutcome(execution, outcomeEventsByJobId) {
  const matched = execution.stageExecutionId ? outcomeEventsByJobId.get(execution.stageExecutionId) : null;
  if (matched) {
    return { outcome: matched.outcome, attribution: 'DIRECT', source: matched.source };
  }
  if (execution.stageResolutionSuccess === false) {
    return { outcome: STAGE_OUTCOMES.FAILED, attribution: execution.rows.length === 1 ? 'DIRECT' : 'SHARED', source: 'model_usage.status' };
  }
  return { outcome: STAGE_OUTCOMES.UNKNOWN, attribution: 'UNATTRIBUTED', source: null };
}

/**
 * A round's outcome: the LATEST `REVIEW_DECISION_PUBLISHED` for that round
 * decides it (a re-review after a correction overwrites an earlier
 * decision — this reads the most recent one, never averages or picks the
 * first). `CORRECTION_ROUND_STARTED` for a LATER round with no decision yet
 * means the round is still open (`CONTINUE`). Absent both, `UNKNOWN` — never
 * guessed from Work Unit or stage completion alone.
 */
export function computeRoundOutcome(goalId, roundId, events) {
  const decisions = events.filter((event) => event.type === 'REVIEW_DECISION_PUBLISHED' && event.goal === goalId && event.round === roundId);
  if (decisions.length > 0) {
    const latest = decisions[decisions.length - 1];
    return { outcome: latest.decision === 'ACCEPTED' ? ROUND_OUTCOMES.ACCEPTED : ROUND_OUTCOMES.CHANGES_REQUIRED, source: 'REVIEW_DECISION_PUBLISHED' };
  }
  const started = events.some((event) => (event.type === 'REVIEW_JOB_RECEIVED' || event.type === 'CORRECTION_ROUND_STARTED') && event.goal === goalId && event.round === roundId);
  if (started) return { outcome: ROUND_OUTCOMES.CONTINUE, source: 'round activity observed, no terminal decision yet' };
  return { outcome: ROUND_OUTCOMES.UNKNOWN, source: null };
}

/**
 * A Goal's terminal outcome, from `GOAL_CLOSED` — never attributed to
 * "the last model used" (Goal 015 §12's explicit rule). Absent a
 * `GOAL_CLOSED` event, `UNKNOWN`: a Goal still open, paused for a human, or
 * abandoned produces no false terminal claim.
 */
export function computeGoalOutcome(goalId, events) {
  const closed = events.find((event) => event.type === 'GOAL_CLOSED' && event.goal === goalId);
  if (closed) return { outcome: 'CLOSED', source: 'GOAL_CLOSED', nextGoalId: closed.nextGoalId ?? null };
  const humanRequired = events.find((event) => event.type === 'HUMAN_REQUIRED' && event.goal === goalId);
  if (humanRequired) return { outcome: 'PAUSED_FOR_HUMAN', source: 'HUMAN_REQUIRED' };
  return { outcome: 'UNKNOWN', source: null };
}

/**
 * Correlates a REVIEW stage execution that produced `CHANGES_REQUIRED` to
 * the REPAIR (`correction`) stage execution that resolved it.
 *
 * Audited against the real event timeline (Goal 015's own validation,
 * Goal 009): a round's `CHANGES_REQUIRED` review does NOT get a correction
 * in the SAME round — the harness advances to round N+1
 * (`DEVELOPER_PROFILE_CHANGED round=2 "Correções envolvem..."`) and the
 * correction runs there, followed by the re-review that then either accepts
 * or requires changes again. The link is therefore: same `goalId`, the
 * SMALLEST `roundId` strictly greater than the review's own round that has a
 * REPAIR execution — round adjacency (a structural fact from the state
 * machine), never a raw timestamp comparison across unrelated rounds.
 */
export function correlateReviewToRepair(reviewExecution, allExecutions) {
  if (reviewExecution.stageType !== STAGE_TYPES.REVIEW || !Number.isFinite(reviewExecution.roundId)) return null;
  const candidates = allExecutions.filter((candidate) => candidate.stageType === STAGE_TYPES.REPAIR
    && candidate.goalId === reviewExecution.goalId
    && Number.isFinite(candidate.roundId)
    && candidate.roundId > reviewExecution.roundId);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.roundId - b.roundId);
  return { reviewStageExecutionId: reviewExecution.stageExecutionId, repairStageExecutionId: candidates[0].stageExecutionId, repairRoundId: candidates[0].roundId };
}
