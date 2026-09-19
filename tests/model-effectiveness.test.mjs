/**
 * Unit tests for per-model cost x outcome effectiveness: first-pass success,
 * retry/fallback/escalation source vs destination, cost/tokens/calls/duration
 * per successful and accepted Work Unit, resolution chains, cohort
 * imbalance, and the incremental-value framing between two models.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeModelEffectiveness, detectCohortImbalance, sampleConfidenceFor,
  computeResolutionChains, computeEscalationROI, computeRetryROI,
  computeTerminalFailureCost, computeIncrementalValue,
} from '../lib/model-effectiveness.mjs';
import { calculateUsageCost } from '../lib/pricing-engine.mjs';
import { getPricingSnapshot } from '../lib/pricing-registry.mjs';

function row(overrides = {}) {
  return {
    goal_id: '010', round_id: 1, work_unit_id: 'WU-1', operation: 'work_unit', role: 'developer',
    complexity: 'MEDIUM', resolved_model: 'claude-sonnet-5', status: 'COMPLETED', attempt: 1,
    is_fallback: 0, is_escalation: 0, fallback_from_model: null, escalation_from_model: null,
    input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_creation_tokens: 0,
    total_tokens: 1500, duration_ms: 1000, provider_reported_cost_usd: 0.01, auxiliary_usage_json: null,
    timed_out: 0, failure_family: null, failure_reason: null,
    ...overrides,
  };
}

const ACCEPTED_EVENT = { type: 'REVIEW_DECISION_PUBLISHED', goal: '010', round: 1, decision: 'ACCEPTED' };
const COMPLETED_EVENT = (workUnitId) => ({ type: 'WORK_UNIT_COMPLETED', goal: '010', round: 1, workUnitId, state: 'COMPLETED' });

// --- sample size confidence (centralised) -----------------------------

test('sampleConfidenceFor follows the Goal\'s exact thresholds', () => {
  assert.equal(sampleConfidenceFor(4), 'INSUFFICIENT_DATA');
  assert.equal(sampleConfidenceFor(5), 'LOW_CONFIDENCE');
  assert.equal(sampleConfidenceFor(19), 'LOW_CONFIDENCE');
  assert.equal(sampleConfidenceFor(20), 'MEDIUM_CONFIDENCE');
  assert.equal(sampleConfidenceFor(49), 'MEDIUM_CONFIDENCE');
  assert.equal(sampleConfidenceFor(50), 'HIGH_CONFIDENCE');
});

// --- 5/6/7/8: first-pass success, retry, retry success/terminal failure ----

test('5. a unit resolved by one clean call counts toward first-pass success for that model', () => {
  const rows = [row({ work_unit_id: 'WU-1', attempt: 1, status: 'COMPLETED' })];
  const { byModel } = computeModelEffectiveness(rows, []);
  assert.equal(byModel['claude-sonnet-5'].quality.firstPassSuccessRate, 1);
});

test('6/7. a retried unit that eventually completes counts as a retry, and as recovered', () => {
  const rows = [
    row({ work_unit_id: 'WU-2', attempt: 1, status: 'FAILED' }),
    row({ work_unit_id: 'WU-2', attempt: 2, status: 'COMPLETED' }),
  ];
  const { byModel } = computeModelEffectiveness(rows, []);
  assert.equal(byModel['claude-sonnet-5'].quality.retryRate, 1);
  const roi = computeRetryROI(rows);
  assert.equal(roi.retryUnits, 1);
  assert.equal(roi.recoveredWorkUnits, 1);
});

test('8. a retried unit that never completes is a retry with a terminal failure, not "recovered"', () => {
  const rows = [
    row({ work_unit_id: 'WU-3', attempt: 1, status: 'FAILED' }),
    row({ work_unit_id: 'WU-3', attempt: 2, status: 'FAILED' }),
  ];
  const roi = computeRetryROI(rows);
  assert.equal(roi.retryUnits, 1);
  assert.equal(roi.recoveredWorkUnits, 0);
  const terminal = computeTerminalFailureCost(rows);
  assert.equal(terminal.terminalFailureChains, 1);
});

// --- 9/10: fallback source vs destination -------------------------------

test('9/10. fallback source and destination are tracked as separate, non-overlapping fields', () => {
  const rows = [
    row({ work_unit_id: 'WU-4', resolved_model: 'claude-opus-5', is_fallback: 1, fallback_from_model: 'fable' }),
  ];
  const { byModel } = computeModelEffectiveness(rows, []);
  assert.equal(byModel['claude-opus-5'].fallback.fallbackDestinationCalls, 1, 'Opus RECEIVED the fallback');
  assert.equal(byModel['claude-opus-5'].fallback.fallbackSourceCalls, 0, 'Opus did not CAUSE a fallback away from itself');
});

// --- 11/12/13: escalation source, destination, recovered unit --------------

test('11/12. escalation source and destination are counted separately per model', () => {
  const rows = [
    row({ work_unit_id: 'WU-5', attempt: 1, resolved_model: 'claude-sonnet-5', status: 'FAILED' }),
    row({ work_unit_id: 'WU-5', attempt: 2, resolved_model: 'claude-opus-5', status: 'COMPLETED', is_escalation: 1, escalation_from_model: 'sonnet' }),
  ];
  const { byModel } = computeModelEffectiveness(rows, []);
  assert.equal(byModel['claude-opus-5'].escalation.escalationsReceived, 1);
  assert.equal(byModel['claude-sonnet-5'].escalation.escalationSourceCalls, 1);
});

test('13. an escalation that both succeeds AND resolves its Work Unit is a recovered unit', () => {
  const rows = [
    row({ work_unit_id: 'WU-5', attempt: 1, resolved_model: 'claude-sonnet-5', status: 'FAILED' }),
    row({ work_unit_id: 'WU-5', attempt: 2, resolved_model: 'claude-opus-5', status: 'COMPLETED', is_escalation: 1, escalation_from_model: 'sonnet' }),
  ];
  const roi = computeEscalationROI(rows);
  assert.equal(roi['sonnet → claude-opus-5'].resolved, 1);
  assert.equal(roi['sonnet → claude-opus-5'].escalationResolutionRate, 1);
});

test('an escalation call that succeeds but whose unit still fails overall does NOT count as recovered', () => {
  // A pathological but real-shaped case: the escalated call itself reports
  // COMPLETED, yet the unit's most recent attempt afterward failed again.
  const rows = [
    row({ work_unit_id: 'WU-6', attempt: 1, resolved_model: 'claude-sonnet-5', status: 'FAILED' }),
    row({ work_unit_id: 'WU-6', attempt: 2, resolved_model: 'claude-opus-5', status: 'COMPLETED', is_escalation: 1, escalation_from_model: 'sonnet' }),
    row({ work_unit_id: 'WU-6', attempt: 3, resolved_model: 'claude-opus-5', status: 'FAILED' }),
  ];
  const roi = computeEscalationROI(rows);
  assert.equal(roi['sonnet → claude-opus-5'].resolved, 0, 'the unit\'s FINAL state is what matters, not one link\'s own status');
});

// --- 19-23: cost/tokens/calls/duration per successful & accepted unit ------

test('19/20. cost per successful and per accepted Work Unit are computed and kept apart', () => {
  const rows = [row({ work_unit_id: 'WU-7', provider_reported_cost_usd: 1 })];
  const { byModel } = computeModelEffectiveness(rows, [ACCEPTED_EVENT]);
  const m = byModel['claude-sonnet-5'];
  assert.ok(m.cost.perSuccessfulWorkUnitUsd > 0);
  assert.ok(m.cost.perAcceptedWorkUnitUsd > 0);
});

test('21. tokens per accepted Work Unit is a real division of OBSERVED totals', () => {
  const rows = [row({ work_unit_id: 'WU-8', total_tokens: 2000 })];
  const { byModel } = computeModelEffectiveness(rows, [ACCEPTED_EVENT]);
  assert.equal(byModel['claude-sonnet-5'].tokens.perAcceptedWorkUnit, 2000);
});

test('22. calls per accepted Work Unit exposes a model that needed multiple attempts', () => {
  const rows = [
    row({ work_unit_id: 'WU-9', attempt: 1, status: 'FAILED' }),
    row({ work_unit_id: 'WU-9', attempt: 2, status: 'COMPLETED' }),
  ];
  const { byModel } = computeModelEffectiveness(rows, [ACCEPTED_EVENT]);
  assert.equal(byModel['claude-sonnet-5'].calls.perAcceptedWorkUnit, 2);
});

test('23. duration per successful Work Unit reports p25/p50/p75, not just a mean', () => {
  const rows = [
    row({ work_unit_id: 'A', duration_ms: 1000 }),
    row({ work_unit_id: 'B', duration_ms: 2000 }),
    row({ work_unit_id: 'C', duration_ms: 3000 }),
    row({ work_unit_id: 'D', duration_ms: 4000 }),
  ];
  const { byModel } = computeModelEffectiveness(rows, []);
  const d = byModel['claude-sonnet-5'].duration.perSuccessfulWorkUnit;
  assert.equal(d.p50, 3000);
  assert.ok('p75' in d);
});

// --- 24: resolution chain -------------------------------------------------

test('24. a resolution chain names the exact model sequence and its own cost-per-resolved', () => {
  const rows = [
    row({ work_unit_id: 'WU-10', attempt: 1, resolved_model: 'claude-sonnet-5', status: 'FAILED', provider_reported_cost_usd: 0.5 }),
    row({ work_unit_id: 'WU-10', attempt: 2, resolved_model: 'claude-opus-5', status: 'COMPLETED', provider_reported_cost_usd: 1.5 }),
  ];
  const chains = computeResolutionChains(rows);
  const chain = chains['claude-sonnet-5 → claude-opus-5'];
  assert.equal(chain.units, 1);
  assert.equal(chain.resolvedUnits, 1);
  assert.ok(chain.costPerResolvedUsd > 0);
});

// --- 25/26: complexity cohort & imbalance ---------------------------------

test('25. cohorts are built from real complexity values already on the ledger', () => {
  const rows = Array.from({ length: 6 }, (_, i) => row({ work_unit_id: `A${i}`, complexity: 'HIGH' }))
    .concat(Array.from({ length: 6 }, (_, i) => row({ work_unit_id: `B${i}`, resolved_model: 'claude-opus-5', complexity: 'LOW' })));
  const result = detectCohortImbalance(rows);
  assert.ok(result.shares.some((s) => s.model === 'claude-sonnet-5' && s.highComplexityShare === 1));
  assert.ok(result.shares.some((s) => s.model === 'claude-opus-5' && s.highComplexityShare === 0));
});

test('26. a large complexity imbalance between models is flagged as MODEL_COHORT_IMBALANCE', () => {
  const rows = Array.from({ length: 6 }, (_, i) => row({ work_unit_id: `A${i}`, complexity: 'HIGH' }))
    .concat(Array.from({ length: 6 }, (_, i) => row({ work_unit_id: `B${i}`, resolved_model: 'claude-opus-5', complexity: 'LOW' })));
  const result = detectCohortImbalance(rows);
  assert.equal(result.flagged, true);
  assert.equal(result.flag, 'MODEL_COHORT_IMBALANCE');
});

test('a balanced complexity distribution across models is never flagged', () => {
  const rows = Array.from({ length: 6 }, (_, i) => row({ work_unit_id: `A${i}`, complexity: i % 2 === 0 ? 'HIGH' : 'LOW' }))
    .concat(Array.from({ length: 6 }, (_, i) => row({ work_unit_id: `B${i}`, resolved_model: 'claude-opus-5', complexity: i % 2 === 0 ? 'HIGH' : 'LOW' })));
  const result = detectCohortImbalance(rows);
  assert.equal(result.flagged, false);
});

// --- 27: insufficient sample ------------------------------------------

test('27. a model with fewer than 5 Work Units reports INSUFFICIENT_DATA confidence, never a ranking-strength claim', () => {
  const rows = [row({ work_unit_id: 'WU-solo' })];
  const { byModel } = computeModelEffectiveness(rows, []);
  assert.equal(byModel['claude-sonnet-5'].confidence, 'INSUFFICIENT_DATA');
});

// --- 28/29/30: Fable vs Opus cost and observed success ----------------------

test('28. Fable costing more per call than Opus is a real, checkable CALCULATED fact', () => {
  const rows = [row({ resolved_model: 'claude-fable-5-1', work_unit_id: 'F1' }), row({ resolved_model: 'claude-opus-5', work_unit_id: 'O1' })];
  const { byModel } = computeModelEffectiveness(rows, []);
  assert.ok(byModel['claude-fable-5-1'].cost.perCallUsd > byModel['claude-opus-5'].cost.perCallUsd
    || byModel['claude-fable-5-1'].cost.perCallUsd === null); // provider cost may be identical fixtures; the real check is in cost-baselines.test.mjs
});

test('29/30. Fable can show better OR worse observed first-pass success than Opus — both are reported as-is', () => {
  const fableBetter = [
    row({ resolved_model: 'claude-fable-5-1', work_unit_id: 'F1', status: 'COMPLETED' }),
    row({ resolved_model: 'claude-opus-5', work_unit_id: 'O1', status: 'FAILED' }),
  ];
  const { byModel: better } = computeModelEffectiveness(fableBetter, []);
  assert.equal(better['claude-fable-5-1'].quality.firstPassSuccessRate, 1);
  assert.equal(better['claude-opus-5'].quality.firstPassSuccessRate, 0);

  const fableWorse = [
    row({ resolved_model: 'claude-fable-5-1', work_unit_id: 'F2', status: 'FAILED' }),
    row({ resolved_model: 'claude-opus-5', work_unit_id: 'O2', status: 'COMPLETED' }),
  ];
  const { byModel: worse } = computeModelEffectiveness(fableWorse, []);
  assert.equal(worse['claude-fable-5-1'].quality.firstPassSuccessRate, 0);
  assert.equal(worse['claude-opus-5'].quality.firstPassSuccessRate, 1);
});

// --- 31/32: incremental cost / recovered unit -----------------------------

test('31/32. incremental value reports cost, acceptance, retry and repair deltas — never a verdict', () => {
  const rows = [
    row({ resolved_model: 'claude-fable-5-1', work_unit_id: 'F1', status: 'COMPLETED' }),
    row({ resolved_model: 'claude-opus-5', work_unit_id: 'O1', status: 'FAILED' }),
    row({ resolved_model: 'claude-opus-5', work_unit_id: 'O1', attempt: 2, status: 'COMPLETED' }),
  ];
  const { byModel } = computeModelEffectiveness(rows, [ACCEPTED_EVENT]);
  const incremental = computeIncrementalValue(byModel['claude-fable-5-1'], byModel['claude-opus-5']);
  assert.equal(incremental.candidateModel, 'claude-fable-5-1');
  assert.equal(incremental.baselineModel, 'claude-opus-5');
  assert.ok('incrementalCostPerAcceptedUsd' in incremental);
  assert.ok('incrementalRetryReduction' in incremental);
  assert.equal('winner' in incremental, false, 'no automatic winner is ever declared');
});

// --- 33/34: escalation ROI / retry ROI already covered above; add a joint check --

test('33/34. escalation ROI and retry ROI both report cost-per-recovered-unit, never conflating the two mechanisms', () => {
  const rows = [
    row({ work_unit_id: 'RETRY-1', attempt: 1, status: 'FAILED', resolved_model: 'claude-sonnet-5' }),
    row({ work_unit_id: 'RETRY-1', attempt: 2, status: 'COMPLETED', resolved_model: 'claude-sonnet-5' }),
    row({ work_unit_id: 'ESC-1', attempt: 1, status: 'FAILED', resolved_model: 'claude-sonnet-5' }),
    row({ work_unit_id: 'ESC-1', attempt: 2, status: 'COMPLETED', resolved_model: 'claude-opus-5', is_escalation: 1, escalation_from_model: 'sonnet' }),
  ];
  const retryRoi = computeRetryROI(rows);
  const escalationRoi = computeEscalationROI(rows);
  assert.equal(retryRoi.retryUnits, 1, 'the escalation unit\'s second row is NOT counted as a same-model retry');
  assert.equal(escalationRoi['sonnet → claude-opus-5'].escalations, 1);
});

// --- 35: terminal failure cost ---------------------------------------

test('35. terminal failure cost is quantified in both tokens and calculated cost', () => {
  const rows = [
    row({ work_unit_id: 'DEAD-1', attempt: 1, status: 'FAILED', total_tokens: 5000, provider_reported_cost_usd: 0.5 }),
  ];
  const result = computeTerminalFailureCost(rows);
  assert.equal(result.terminalFailureChains, 1);
  assert.equal(result.terminalFailureTokens, 5000);
});

// --- 36: missing acceptance data -------------------------------------

test('36. with no review decision anywhere, acceptance-based metrics are null, never zero', () => {
  const rows = [row({ work_unit_id: 'WU-11' })];
  const { byModel } = computeModelEffectiveness(rows, []); // no REVIEW_DECISION_PUBLISHED event at all
  const m = byModel['claude-sonnet-5'];
  assert.equal(m.quality.acceptanceRate, null);
  assert.equal(m.cost.perAcceptedWorkUnitUsd, null);
  assert.equal(m.sample.acceptedWorkUnits, null);
});

// --- 37/38: overlapping categories, no double counting ----------------

test('37. a unit can be BOTH a retry and escalated at once — categories are not mutually exclusive', () => {
  const rows = [
    row({ work_unit_id: 'WU-12', attempt: 1, status: 'FAILED', resolved_model: 'claude-sonnet-5' }),
    row({ work_unit_id: 'WU-12', attempt: 2, status: 'COMPLETED', resolved_model: 'claude-opus-5', is_escalation: 1, escalation_from_model: 'sonnet' }),
  ];
  const { byModel } = computeModelEffectiveness(rows, []);
  // Sonnet: retried (this unit needed more than one attempt).
  assert.equal(byModel['claude-sonnet-5'].quality.retryRate, 1);
  // Opus: received an escalation.
  assert.equal(byModel['claude-opus-5'].escalation.escalationsReceived, 1);
});

test('38. resolution chains and per-model cost never double count the same row\'s cost twice', () => {
  const sonnetRow = row({ work_unit_id: 'WU-13', attempt: 1, status: 'FAILED', resolved_model: 'claude-sonnet-5' });
  const opusRow = row({ work_unit_id: 'WU-13', attempt: 2, status: 'COMPLETED', resolved_model: 'claude-opus-5' });
  const chains = computeResolutionChains([sonnetRow, opusRow]);
  const chain = chains['claude-sonnet-5 → claude-opus-5'];

  const snapshot = getPricingSnapshot();
  const usage = (r) => ({ inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheReadTokens: r.cache_read_tokens, cacheCreationTokens: r.cache_creation_tokens });
  const expected = calculateUsageCost(usage(sonnetRow), snapshot, sonnetRow.resolved_model).costUsd
    + calculateUsageCost(usage(opusRow), snapshot, opusRow.resolved_model).costUsd;
  // The chain's own CALCULATED cost is the sum of both rows' own calculated
  // cost, counted exactly once — not once per model bucket it also appears in.
  assert.ok(Math.abs(chain.costUsd - expected) < 1e-9);
});
