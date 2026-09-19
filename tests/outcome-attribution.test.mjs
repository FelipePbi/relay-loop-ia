/**
 * Unit tests for correlating a Work Unit to its outcome and attribution
 * confidence — using only structural IDs (`work_unit_id`, `forVerification`,
 * `goal`/`round`), never timing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OUTCOMES, ATTRIBUTION, attributeWorkUnit, indexFixEvents, indexReviewDecisions,
  indexUnitCompletionEvents, classifyFailureRelevance, roundKey,
} from '../lib/outcome-attribution.mjs';
import { groupIntoWorkUnits } from '../lib/historical-distributions.mjs';

function row(overrides = {}) {
  return {
    goal_id: '010', round_id: 1, work_unit_id: 'WU-1', operation: 'work_unit', role: 'developer',
    resolved_model: 'claude-sonnet-5', status: 'COMPLETED', attempt: 1, is_fallback: 0, is_escalation: 0,
    input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0,
    total_tokens: 150, duration_ms: 500, provider_reported_cost_usd: 0.01, auxiliary_usage_json: null,
    timed_out: 0, failure_family: null, failure_reason: null,
    ...overrides,
  };
}

// --- 1: invocation -> Work Unit attribution ---------------------------

test('1. an invocation is correlated to its Work Unit by workUnitId, never by timing', () => {
  const units = groupIntoWorkUnits([row({ work_unit_id: 'WU-9' }), row({ work_unit_id: 'WU-10' })]);
  assert.equal(units.length, 2);
  assert.deepEqual(units.map((u) => u.workUnitId).sort(), ['WU-10', 'WU-9']);
});

// --- 2/3/4: direct / shared / unattributed ------------------------------

test('2. DIRECT: a single clean invocation with no retry produces a direct outcome', () => {
  const [unit] = groupIntoWorkUnits([row({ attempt: 1, status: 'COMPLETED' })]);
  const result = attributeWorkUnit(unit);
  assert.equal(result.outcome, OUTCOMES.SUCCESS);
  assert.equal(result.attribution, ATTRIBUTION.DIRECT);
});

test('3. SHARED: a retry/escalation chain\'s outcome belongs to the chain, not one link', () => {
  const [unit] = groupIntoWorkUnits([
    row({ attempt: 1, status: 'FAILED' }),
    row({ attempt: 2, status: 'COMPLETED', resolved_model: 'claude-opus-5', is_escalation: 1 }),
  ]);
  const result = attributeWorkUnit(unit);
  assert.equal(result.outcome, OUTCOMES.SUCCESS);
  assert.equal(result.attribution, ATTRIBUTION.SHARED);
});

test('4. UNATTRIBUTED: a unit with no terminal evidence at all', () => {
  const [unit] = groupIntoWorkUnits([row({ status: 'STARTED' })]);
  const result = attributeWorkUnit(unit);
  assert.equal(result.outcome, OUTCOMES.UNKNOWN);
  assert.equal(result.attribution, ATTRIBUTION.UNATTRIBUTED);
});

test('a BLOCKED/ESCALATION_REQUIRED completion event is ABORTED, never silently folded into FAILED', () => {
  const [unit] = groupIntoWorkUnits([row({ status: 'COMPLETED' })]); // ledger status alone would say COMPLETED
  const completionsByUnit = indexUnitCompletionEvents([
    { type: 'WORK_UNIT_COMPLETED', goal: '010', round: 1, workUnitId: 'WU-1', state: 'BLOCKED' },
  ]);
  const result = attributeWorkUnit(unit, { completionsByUnit });
  assert.equal(result.outcome, OUTCOMES.ABORTED, 'the harness\'s own event overrides the ledger-only inference');
});

// --- review outcomes (14/15) ---------------------------------------------

test('14. a round-level ACCEPTED decision applies to every unit in the round, with SHARED attribution', () => {
  const [unit] = groupIntoWorkUnits([row({ work_unit_id: 'WU-A' })]);
  const reviewDecisionsByRound = indexReviewDecisions([
    { type: 'REVIEW_DECISION_PUBLISHED', goal: '010', round: 1, decision: 'ACCEPTED' },
  ]);
  const result = attributeWorkUnit(unit, { reviewDecisionsByRound });
  assert.equal(result.reviewOutcome.outcome, OUTCOMES.ACCEPTED);
  assert.equal(result.reviewOutcome.attribution, ATTRIBUTION.SHARED, 'never DIRECT — the harness cannot tell which unit a round review is about');
});

test('15. a round-level CHANGES_REQUIRED decision is distinguished from ACCEPTED', () => {
  const [unit] = groupIntoWorkUnits([row()]);
  const reviewDecisionsByRound = indexReviewDecisions([
    { type: 'REVIEW_DECISION_PUBLISHED', goal: '010', round: 1, decision: 'CHANGES_REQUIRED' },
  ]);
  const result = attributeWorkUnit(unit, { reviewDecisionsByRound });
  assert.equal(result.reviewOutcome.outcome, OUTCOMES.CHANGES_REQUIRED);
});

test('a unit in a round with no review decision at all carries no reviewOutcome — never guessed', () => {
  const [unit] = groupIntoWorkUnits([row()]);
  const result = attributeWorkUnit(unit, { reviewDecisionsByRound: new Map() });
  assert.equal(result.reviewOutcome, null);
});

test('roundKey is symmetric: the same goal/round always produces the same lookup key', () => {
  assert.equal(roundKey('010', 1), roundKey('010', 1));
  assert.notEqual(roundKey('010', 1), roundKey('010', 2));
});

// --- repair (16) ---------------------------------------------------------

test('16. a Work Unit with a WORK_UNIT_FIX_CREATED targeting it is REPAIRED, linked by forVerification', () => {
  const [unit] = groupIntoWorkUnits([row({ work_unit_id: 'WU-16', status: 'FAILED' })]);
  const fixEventsByTarget = indexFixEvents([
    { type: 'WORK_UNIT_FIX_CREATED', goal: '010', round: 1, workUnitId: 'DIAG-001', forVerification: 'WU-16', attributedTo: null },
  ]);
  // Even though the ledger's own status is FAILED, the completion event
  // (or, absent one, the ledger COMPLETED after a fix) is what marks REPAIRED —
  // here we simulate the harness's own completion event reporting success.
  const completionsByUnit = indexUnitCompletionEvents([
    { type: 'WORK_UNIT_COMPLETED', goal: '010', round: 1, workUnitId: 'WU-16', state: 'COMPLETED' },
  ]);
  const result = attributeWorkUnit(unit, { fixEventsByTarget, completionsByUnit });
  assert.equal(result.outcome, OUTCOMES.REPAIRED);
  assert.equal(result.repaired, true);
});

test('repair cause is UNKNOWN when attributedTo is not populated — never guessed as model-caused', () => {
  const [unit] = groupIntoWorkUnits([row({ work_unit_id: 'WU-16', status: 'COMPLETED' })]);
  const fixEventsByTarget = indexFixEvents([
    { type: 'WORK_UNIT_FIX_CREATED', goal: '010', round: 1, workUnitId: 'DIAG-001', forVerification: 'WU-16', attributedTo: null },
  ]);
  const result = attributeWorkUnit(unit, { fixEventsByTarget });
  assert.equal(result.repairCause, 'UNKNOWN');
});

test('a repair correctly attributed to the model IS reported as MODEL_OUTPUT', () => {
  const [unit] = groupIntoWorkUnits([row({ work_unit_id: 'WU-16', status: 'COMPLETED' })]);
  const fixEventsByTarget = indexFixEvents([
    { type: 'WORK_UNIT_FIX_CREATED', goal: '010', round: 1, workUnitId: 'DIAG-001', forVerification: 'WU-16', attributedTo: 'claude-sonnet-5' },
  ]);
  const result = attributeWorkUnit(unit, { fixEventsByTarget });
  assert.equal(result.repairCause, 'MODEL_OUTPUT');
});

// --- failure taxonomy: infra vs quality-relevant (17/18) --------------------

test('17. a HARNESS-family failure is INFRA_FAILURE, never quality-relevant', () => {
  const result = classifyFailureRelevance(row({ status: 'FAILED', failure_family: 'HARNESS' }));
  assert.equal(result.category, 'INFRA_FAILURE');
  assert.equal(result.qualityRelevant, false);
});

test('a MODEL_CAPACITY failure is CAPACITY_FAILURE or RATE_LIMIT, never quality-relevant', () => {
  assert.equal(classifyFailureRelevance(row({ failure_family: 'MODEL_CAPACITY', failure_reason: 'USAGE_LIMIT' })).category, 'CAPACITY_FAILURE');
  assert.equal(classifyFailureRelevance(row({ failure_family: 'MODEL_CAPACITY', failure_reason: 'RATE_LIMIT' })).category, 'RATE_LIMIT');
  assert.equal(classifyFailureRelevance(row({ failure_family: 'MODEL_CAPACITY', failure_reason: 'RATE_LIMIT' })).qualityRelevant, false);
});

test('a timeout is classified before family is even consulted', () => {
  const result = classifyFailureRelevance(row({ timed_out: 1, failure_family: 'AGENT_CONTRACT' }));
  assert.equal(result.category, 'TIMEOUT');
  assert.equal(result.qualityRelevant, false);
});

test('18. an AGENT_CONTRACT failure IS quality-relevant — the model\'s own output was invalid', () => {
  const result = classifyFailureRelevance(row({ failure_family: 'AGENT_CONTRACT' }));
  assert.equal(result.category, 'VALIDATION_FAILURE');
  assert.equal(result.qualityRelevant, true);
});

test('an unclassified failure defaults to quality-relevant — never assumed to be infra without evidence', () => {
  const result = classifyFailureRelevance(row({ failure_family: 'UNCLASSIFIED' }));
  assert.equal(result.category, 'UNKNOWN');
  assert.equal(result.qualityRelevant, true);
});
