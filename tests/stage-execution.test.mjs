/**
 * Unit tests for STAGE/ROUND/GOAL execution correlation: grouping by
 * `job_id` (the read-side reconstructed stage execution identity — see the
 * module's own docstring for why no new ID is minted yet), resolution
 * chains, business outcomes, and round/Goal terminal state.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STAGE_TYPES, CORRELATION_QUALITY, STAGE_OUTCOMES, ROUND_OUTCOMES,
  groupIntoStageExecutions, indexStageOutcomeEvents, attributeStageOutcome,
  computeRoundOutcome, computeGoalOutcome, correlateReviewToRepair,
  isStageOperation, stageTypeOfOperation,
} from '../lib/stage-execution.mjs';

function row(overrides = {}) {
  return {
    goal_id: '010', round_id: 1, job_id: 'job-1', attempt_id: 'job-1-a1', attempt: 1,
    role: 'tech_lead', operation: 'review', resolved_model: 'claude-fable-5-1', requested_model: 'claude-fable-5-1',
    status: 'COMPLETED', is_fallback: 0, is_escalation: 0, fallback_from_model: null, escalation_from_model: null,
    failure_family: null, failure_reason: null, timed_out: 0,
    started_at: '2026-09-10T10:00:00.000Z', finished_at: '2026-09-10T10:01:00.000Z',
    invocation_id: 'inv-1',
    ...overrides,
  };
}

// --- 1: stageExecutionId uniqueness ---------------------------------

test('1. each distinct job_id produces its own stage execution, with that job_id as identity', () => {
  const executions = groupIntoStageExecutions([row({ job_id: 'job-a' }), row({ job_id: 'job-b' })]);
  assert.equal(executions.length, 2);
  assert.deepEqual(executions.map((e) => e.stageExecutionId).sort(), ['job-a', 'job-b']);
});

test('isStageOperation/stageTypeOfOperation cover planning, review, correction, closure — never work_unit', () => {
  assert.equal(stageTypeOfOperation('planning'), STAGE_TYPES.PLANNING);
  assert.equal(stageTypeOfOperation('review'), STAGE_TYPES.REVIEW);
  assert.equal(stageTypeOfOperation('correction'), STAGE_TYPES.REPAIR);
  assert.equal(stageTypeOfOperation('closure_documentation'), STAGE_TYPES.CLOSURE);
  assert.equal(isStageOperation('work_unit'), false, 'Work Units are Goal 014\'s domain, never double-counted here');
  assert.equal(isStageOperation('implementation'), false);
});

// --- 2/3/4/5: planning/review/repair/closure lifecycle -----------------

test('2. a planning stage execution groups every attempt of that planning job', () => {
  const [execution] = groupIntoStageExecutions([row({ operation: 'planning', attempt: 1 }), row({ operation: 'planning', attempt: 2 })]);
  assert.equal(execution.stageType, STAGE_TYPES.PLANNING);
  assert.equal(execution.resolutionChain.length, 2);
});

test('3. a review stage execution groups every attempt of that review job', () => {
  const [execution] = groupIntoStageExecutions([row({ operation: 'review' })]);
  assert.equal(execution.stageType, STAGE_TYPES.REVIEW);
});

test('4. a repair (correction) stage execution is its own stage type', () => {
  const [execution] = groupIntoStageExecutions([row({ operation: 'correction' })]);
  assert.equal(execution.stageType, STAGE_TYPES.REPAIR);
});

test('5. a closure stage execution is its own stage type', () => {
  const [execution] = groupIntoStageExecutions([row({ operation: 'closure_documentation' })]);
  assert.equal(execution.stageType, STAGE_TYPES.CLOSURE);
});

// --- 6/7: invocation -> stage correlation -----------------------------

test('6. an invocation correlates to its stage execution by job_id, never by timing', () => {
  const executions = groupIntoStageExecutions([row({ job_id: 'job-x' })]);
  assert.equal(executions[0].rows[0].job_id, 'job-x');
});

test('7. multiple invocations in one stage execution are all present in the resolution chain', () => {
  const [execution] = groupIntoStageExecutions([
    row({ attempt: 1, status: 'FAILED' }),
    row({ attempt: 2, status: 'COMPLETED' }),
  ]);
  assert.equal(execution.resolutionChain.length, 2);
});

// --- 8/9/10: retry, fallback, escalation inside a stage --------------------

test('8. a retry inside a stage is a second attempt under the SAME job_id', () => {
  const [execution] = groupIntoStageExecutions([
    row({ attempt: 1, status: 'FAILED', failure_family: 'MODEL_CAPACITY' }),
    row({ attempt: 2, status: 'COMPLETED' }),
  ]);
  assert.equal(execution.resolutionChain[1].attempt, 2);
  assert.equal(execution.stageResolutionSuccess, true, 'the LAST attempt decides stage resolution success');
});

test('9. a fallback inside a stage keeps the job_id stable and names the source model', () => {
  const [execution] = groupIntoStageExecutions([
    row({ attempt: 1, status: 'FAILED', resolved_model: 'claude-fable-5-1' }),
    row({ attempt: 2, status: 'COMPLETED', resolved_model: 'claude-opus-5', is_fallback: 1, fallback_from_model: 'fable' }),
  ]);
  assert.equal(execution.resolutionChain[1].isFallback, true);
  assert.equal(execution.resolutionChain[1].fallbackFromModel, 'fable');
});

test('10. an escalation inside a stage names the source model separately from fallback', () => {
  const [execution] = groupIntoStageExecutions([
    row({ attempt: 1, status: 'FAILED', resolved_model: 'claude-opus-5' }),
    row({ attempt: 2, status: 'COMPLETED', resolved_model: 'claude-fable-5-1', is_escalation: 1, escalation_from_model: 'opus' }),
  ]);
  assert.equal(execution.resolutionChain[1].isEscalation, true);
  assert.equal(execution.resolutionChain[1].escalationFromModel, 'opus');
  assert.equal(execution.resolutionChain[1].isFallback, false);
});

// --- 11/12/13: capacity, rate-limit, quality-relevant failure --------------

test('11/12. capacity and rate-limit failures are preserved verbatim from the reused taxonomy', () => {
  const [execution] = groupIntoStageExecutions([row({ status: 'FAILED', failure_family: 'MODEL_CAPACITY', failure_reason: 'USAGE_LIMIT' })]);
  assert.equal(execution.resolutionChain[0].failureFamily, 'MODEL_CAPACITY');
  assert.equal(execution.resolutionChain[0].failureReason, 'USAGE_LIMIT');
});

test('13. a quality-relevant (AGENT_CONTRACT) failure is preserved distinctly from capacity', () => {
  const [execution] = groupIntoStageExecutions([row({ status: 'FAILED', failure_family: 'AGENT_CONTRACT' })]);
  assert.equal(execution.resolutionChain[0].failureFamily, 'AGENT_CONTRACT');
});

// --- 14/15: completed invocation + business outcome ------------------

test('14. a completed review invocation with a CHANGES_REQUIRED decision keeps the two facts separate', () => {
  const [execution] = groupIntoStageExecutions([row({ job_id: 'review-job', status: 'COMPLETED' })]);
  const outcomeEventsByJobId = indexStageOutcomeEvents([
    { type: 'REVIEW_DECISION_PUBLISHED', jobId: 'review-job', goal: '010', round: 1, decision: 'CHANGES_REQUIRED' },
  ]);
  assert.equal(execution.providerAttemptSuccess, true, 'the invocation itself succeeded');
  const attribution = attributeStageOutcome(execution, outcomeEventsByJobId);
  assert.equal(attribution.outcome, STAGE_OUTCOMES.CHANGES_REQUIRED, 'the BUSINESS outcome is independent of invocation status');
  assert.equal(attribution.attribution, 'DIRECT', 'REVIEW_DECISION_PUBLISHED carries the exact jobId — a structural link');
});

test('15. a completed review invocation with an ACCEPTED decision is attributed DIRECT', () => {
  const [execution] = groupIntoStageExecutions([row({ job_id: 'review-job', status: 'COMPLETED' })]);
  const outcomeEventsByJobId = indexStageOutcomeEvents([
    { type: 'REVIEW_DECISION_PUBLISHED', jobId: 'review-job', goal: '010', round: 1, decision: 'ACCEPTED' },
  ]);
  const attribution = attributeStageOutcome(execution, outcomeEventsByJobId);
  assert.equal(attribution.outcome, STAGE_OUTCOMES.ACCEPTED);
});

test('a successful invocation with NO outcome event is UNKNOWN, never inferred as ACCEPTED', () => {
  const [execution] = groupIntoStageExecutions([row({ job_id: 'review-job', status: 'COMPLETED' })]);
  const attribution = attributeStageOutcome(execution, new Map());
  assert.equal(attribution.outcome, STAGE_OUTCOMES.UNKNOWN, 'a process exiting cleanly is not evidence of acceptance');
  assert.equal(attribution.attribution, 'UNATTRIBUTED');
});

// --- 16/17: review -> repair -> next review correlation ------------------
//
// Audited against the real event timeline (Goal 009): a CHANGES_REQUIRED
// review in round N is answered by a correction in round N+1, never the
// SAME round — the state machine advances the round before the repair runs.

test('16. a CHANGES_REQUIRED review correlates to the repair stage execution in the NEXT round', () => {
  const executions = groupIntoStageExecutions([
    row({ job_id: 'review-r1', operation: 'review', round_id: 1 }),
    row({ job_id: 'repair-r2', operation: 'correction', round_id: 2 }),
  ]);
  const [reviewExecution, repairExecution] = executions;
  const link = correlateReviewToRepair(reviewExecution, executions);
  assert.equal(link.reviewStageExecutionId, 'review-r1');
  assert.equal(link.repairStageExecutionId, repairExecution.stageExecutionId);
  assert.equal(link.repairRoundId, 2);
});

test('17. a repair in the SAME round, or an EARLIER round, is never linked — only a later round is', () => {
  const sameRound = groupIntoStageExecutions([
    row({ job_id: 'review-r1', operation: 'review', round_id: 1 }),
    row({ job_id: 'repair-same-round', operation: 'correction', round_id: 1 }),
  ]);
  assert.equal(correlateReviewToRepair(sameRound[0], sameRound), null, 'a same-round correction is never the answer to this review — see Goal 009\'s real sequence');

  const earlierRound = groupIntoStageExecutions([
    row({ job_id: 'repair-r1', operation: 'correction', round_id: 1 }),
    row({ job_id: 'review-r2', operation: 'review', round_id: 2 }),
  ]);
  const reviewExecution = earlierRound.find((e) => e.stageType === STAGE_TYPES.REVIEW);
  assert.equal(correlateReviewToRepair(reviewExecution, earlierRound), null, 'a repair from a round BEFORE this review is never linked forward to it');
});

test('the next repair round is picked even when a LATER, non-adjacent round also has one', () => {
  const executions = groupIntoStageExecutions([
    row({ job_id: 'review-r1', operation: 'review', round_id: 1 }),
    row({ job_id: 'repair-r2', operation: 'correction', round_id: 2 }),
    row({ job_id: 'repair-r4', operation: 'correction', round_id: 4 }),
  ]);
  const link = correlateReviewToRepair(executions[0], executions);
  assert.equal(link.repairRoundId, 2, 'the NEAREST later round wins, not just any later one');
});

test('a review with no following repair correlates to null, never a guess', () => {
  const executions = groupIntoStageExecutions([row({ job_id: 'review-only', operation: 'review' })]);
  assert.equal(correlateReviewToRepair(executions[0], executions), null);
});

// --- 18/19: multiple rounds, round terminal outcome ------------------

test('18/19. each round gets its own outcome from the LATEST decision published for it', () => {
  const events = [
    { type: 'REVIEW_DECISION_PUBLISHED', jobId: 'r1-review', goal: '010', round: 1, decision: 'CHANGES_REQUIRED' },
    { type: 'REVIEW_DECISION_PUBLISHED', jobId: 'r2-review', goal: '010', round: 2, decision: 'ACCEPTED' },
  ];
  assert.equal(computeRoundOutcome('010', 1, events).outcome, ROUND_OUTCOMES.CHANGES_REQUIRED);
  assert.equal(computeRoundOutcome('010', 2, events).outcome, ROUND_OUTCOMES.ACCEPTED);
});

test('a round with activity but no terminal decision yet is CONTINUE, not UNKNOWN', () => {
  const events = [{ type: 'CORRECTION_ROUND_STARTED', goal: '010', round: 3 }];
  assert.equal(computeRoundOutcome('010', 3, events).outcome, ROUND_OUTCOMES.CONTINUE);
});

test('a round with no activity at all is UNKNOWN, never guessed', () => {
  assert.equal(computeRoundOutcome('010', 99, []).outcome, ROUND_OUTCOMES.UNKNOWN);
});

// --- 20: Goal terminal outcome ----------------------------------------

test('20. a Goal\'s outcome comes from GOAL_CLOSED, never from "the last model used"', () => {
  const events = [{ type: 'GOAL_CLOSED', goal: '010', nextGoalId: '011' }];
  const result = computeGoalOutcome('010', events);
  assert.equal(result.outcome, 'CLOSED');
  assert.equal(result.source, 'GOAL_CLOSED');
});

test('a Goal paused for a human reports PAUSED_FOR_HUMAN, not UNKNOWN', () => {
  const events = [{ type: 'HUMAN_REQUIRED', goal: '010' }];
  assert.equal(computeGoalOutcome('010', events).outcome, 'PAUSED_FOR_HUMAN');
});

test('a Goal with neither event is UNKNOWN — still open, or history does not say', () => {
  assert.equal(computeGoalOutcome('999', []).outcome, 'UNKNOWN');
});

// --- 21/22: DIRECT / SHARED attribution --------------------------------

test('21. DIRECT attribution when an outcome event names this exact job_id', () => {
  const [execution] = groupIntoStageExecutions([row({ job_id: 'r1' })]);
  const outcomeEventsByJobId = indexStageOutcomeEvents([{ type: 'REVIEW_DECISION_PUBLISHED', jobId: 'r1', goal: '010', round: 1, decision: 'ACCEPTED' }]);
  assert.equal(attributeStageOutcome(execution, outcomeEventsByJobId).attribution, 'DIRECT');
});

test('22. SHARED attribution when a multi-attempt chain\'s failure is the only evidence', () => {
  const [execution] = groupIntoStageExecutions([
    row({ attempt: 1, status: 'FAILED' }),
    row({ attempt: 2, status: 'FAILED' }),
  ]);
  const attribution = attributeStageOutcome(execution, new Map());
  assert.equal(attribution.outcome, STAGE_OUTCOMES.FAILED);
  assert.equal(attribution.attribution, 'SHARED', 'more than one invocation contributed to this failure');
});

// --- 23/24: legacy reconstruction / unattributed -----------------------

test('23. every execution built from job_id alone is honestly LEGACY_RECONSTRUCTED, never EXACT', () => {
  const [execution] = groupIntoStageExecutions([row()]);
  assert.equal(execution.correlationQuality, CORRELATION_QUALITY.LEGACY_RECONSTRUCTED);
});

test('24. a row with no job_id at all becomes its own UNATTRIBUTED execution, never dropped', () => {
  const [execution] = groupIntoStageExecutions([row({ job_id: null })]);
  assert.equal(execution.correlationQuality, CORRELATION_QUALITY.UNATTRIBUTED);
  assert.equal(execution.rows.length, 1);
});

// --- lifecycle timing (read-side reconstructed, not a persisted event) -----

test('lifecycle timing spans the earliest start to the latest finish across every attempt', () => {
  const [execution] = groupIntoStageExecutions([
    row({ attempt: 1, started_at: '2026-09-10T10:00:00Z', finished_at: '2026-09-10T10:05:00Z' }),
    row({ attempt: 2, started_at: '2026-09-10T10:10:00Z', finished_at: '2026-09-10T10:20:00Z' }),
  ]);
  assert.equal(execution.lifecycle.startedAt, '2026-09-10T10:00:00Z');
  assert.equal(execution.lifecycle.finishedAt, '2026-09-10T10:20:00Z');
  assert.equal(execution.lifecycle.reconstructedFrom, 'model_usage', 'never confused with a real persisted STAGE_STARTED event');
});

// --- planning and closure outcomes -------------------------------------

test('a planning job that published NEXT_GOAL_PLANNING_PUBLISHED is PLAN_PRODUCED', () => {
  const [execution] = groupIntoStageExecutions([row({ job_id: 'plan-1', operation: 'planning' })]);
  const outcomeEventsByJobId = indexStageOutcomeEvents([{ type: 'NEXT_GOAL_PLANNING_PUBLISHED', jobId: 'plan-1', goal: '010', planningDecision: 'NEXT_GOAL' }]);
  assert.equal(attributeStageOutcome(execution, outcomeEventsByJobId).outcome, STAGE_OUTCOMES.PLAN_PRODUCED);
});

test('a closure job that published CLOSURE_DOCUMENTATION_PUBLISHED is CLOSURE_PUBLISHED', () => {
  const [execution] = groupIntoStageExecutions([row({ job_id: 'closure-1', operation: 'closure_documentation' })]);
  const outcomeEventsByJobId = indexStageOutcomeEvents([{ type: 'CLOSURE_DOCUMENTATION_PUBLISHED', jobId: 'closure-1', goal: '010', documents: 3 }]);
  assert.equal(attributeStageOutcome(execution, outcomeEventsByJobId).outcome, STAGE_OUTCOMES.CLOSURE_PUBLISHED);
});

// --- 30: no temporal heuristic when a structural link is absent -------

test('30. a repair that started immediately AFTER the review in wall-clock time is never linked when its round is not later — round order wins, not proximity in time', () => {
  // If correlation were "nearest in time", this repair — which starts right
  // after the review finishes — would wrongly match. It is round_id 1, the
  // SAME round as the review, so the real (round-based) rule refuses it.
  const executions = groupIntoStageExecutions([
    row({ job_id: 'review-1', operation: 'review', round_id: 1, started_at: '2026-09-10T10:00:00Z', finished_at: '2026-09-10T10:05:00Z' }),
    row({ job_id: 'repair-same-round-fast-follow', operation: 'correction', round_id: 1, started_at: '2026-09-10T10:05:01Z', finished_at: '2026-09-10T10:10:00Z' }),
  ]);
  const reviewExecution = executions.find((e) => e.stageType === STAGE_TYPES.REVIEW);
  assert.equal(correlateReviewToRepair(reviewExecution, executions), null);
});

// --- 31: no new failure taxonomy ---------------------------------------

test('31. failure family/reason are copied verbatim from the ledger, never re-translated through a new table', () => {
  const [execution] = groupIntoStageExecutions([row({ status: 'FAILED', failure_family: 'MODEL_CAPACITY', failure_reason: 'RATE_LIMIT' })]);
  // Exactly what the row carried, byte for byte — this module defines no
  // FAILURE_FAMILIES-shaped enum of its own (see lib/failure-taxonomy.mjs,
  // the one and only source).
  assert.equal(execution.resolutionChain[0].failureFamily, 'MODEL_CAPACITY');
  assert.equal(execution.resolutionChain[0].failureReason, 'RATE_LIMIT');
});
