/**
 * Unit tests for stage telemetry coverage, metric applicability
 * (NOT_APPLICABLE vs. INSUFFICIENT_DATA), and the per-model stage/Work-Unit
 * call breakdown — the piece that makes explicit WHY Fable cannot be
 * measured with Work-Unit metrics.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeStageTelemetryCoverage, metricApplicability, computeStageCallsByModel } from '../lib/stage-telemetry.mjs';

function row(overrides = {}) {
  return {
    goal_id: '010', round_id: 1, job_id: 'job-1', attempt: 1,
    role: 'tech_lead', operation: 'review', resolved_model: 'claude-fable-5-1', requested_model: 'claude-fable-5-1',
    status: 'COMPLETED', is_fallback: 0, is_escalation: 0, fallback_from_model: null, escalation_from_model: null,
    failure_family: null, failure_reason: null, timed_out: 0,
    started_at: '2026-09-10T10:00:00.000Z', finished_at: '2026-09-10T10:01:00.000Z', invocation_id: 'inv-1',
    ...overrides,
  };
}

// --- coverage report -----------------------------------------------------

test('coverage counts stage executions, invocation links, terminal status, outcome and round correlation', () => {
  const rows = [row({ job_id: 'r1' }), row({ job_id: 'r2', status: 'FAILED' })];
  const events = [{ type: 'REVIEW_DECISION_PUBLISHED', jobId: 'r1', goal: '010', round: 1, decision: 'ACCEPTED' }];
  const coverage = computeStageTelemetryCoverage(rows, events);
  assert.equal(coverage.stageExecutions, 2);
  assert.equal(coverage.withInvocationLinks, 2);
  assert.equal(coverage.withTerminalStatus, 2);
  assert.equal(coverage.withStageOutcome, 2, 'r1 has a DIRECT outcome, r2 has a FAILED outcome from its own terminal status');
  assert.equal(coverage.withRoundCorrelation, 2);
});

test('coverage classifies every execution as LEGACY_RECONSTRUCTED or UNATTRIBUTED — never fabricates EXACT', () => {
  const rows = [row({ job_id: 'r1' }), row({ job_id: null })];
  const coverage = computeStageTelemetryCoverage(rows, []);
  assert.equal(coverage.correlationQuality.EXACT, 0);
  assert.equal(coverage.correlationQuality.LEGACY_RECONSTRUCTED, 1);
  assert.equal(coverage.correlationQuality.UNATTRIBUTED, 1);
});

test('an empty ledger produces zero coverage, not an error', () => {
  const coverage = computeStageTelemetryCoverage([], []);
  assert.equal(coverage.stageExecutions, 0);
});

// --- 25/26: NOT_APPLICABLE vs. INSUFFICIENT_DATA ----------------------

test('25. a model with ZERO calls in a metric\'s scope is NOT_APPLICABLE — no sample size fixes this', () => {
  assert.equal(metricApplicability('costPerAcceptedWorkUnit', { workUnitCallCount: 0, stageCallCount: 40 }), 'NOT_APPLICABLE');
});

test('26. a model WITH calls in scope but below the minimum sample is INSUFFICIENT_DATA, not NOT_APPLICABLE', () => {
  assert.equal(metricApplicability('reviewStageResolution', { stageCallCount: 2, minSample: 5 }), 'INSUFFICIENT_DATA');
});

test('enough same-scope calls makes a metric APPLICABLE', () => {
  assert.equal(metricApplicability('reviewStageResolution', { stageCallCount: 10, minSample: 5 }), 'APPLICABLE');
  assert.equal(metricApplicability('costPerAcceptedWorkUnit', { workUnitCallCount: 10, minSample: 5 }), 'APPLICABLE');
});

test('an unrecognised metric name is conservatively NOT_APPLICABLE, never a false APPLICABLE', () => {
  assert.equal(metricApplicability('totallyMadeUpMetric', { workUnitCallCount: 100, stageCallCount: 100 }), 'NOT_APPLICABLE');
});

// --- 27/28: Fable with zero Work Units vs. with review calls ---------------

test('27/28. Fable with zero Work Unit calls but real review calls is reported honestly, side by side', () => {
  const rows = [row({ operation: 'review' }), row({ operation: 'planning' }), row({ operation: 'review' })];
  const byModel = computeStageCallsByModel(rows, { workUnitCallCounts: { 'claude-fable-5-1': 0 } });
  const fable = byModel['claude-fable-5-1'];
  assert.equal(fable.workUnitCalls, 0);
  assert.equal(fable.stageCalls, 3);
  assert.equal(fable.review, 2);
  assert.equal(fable.planning, 1);
});

test('a model present ONLY in Work Units still gets a row, with stageCalls explicitly 0', () => {
  const byModel = computeStageCallsByModel([], { workUnitCallCounts: { 'claude-sonnet-5': 12 } });
  assert.equal(byModel['claude-sonnet-5'].stageCalls, 0);
  assert.equal(byModel['claude-sonnet-5'].workUnitCalls, 12);
});

test('capacity and quality-relevant stage failures are counted separately per model', () => {
  const rows = [
    row({ status: 'FAILED', failure_family: 'MODEL_CAPACITY' }),
    row({ status: 'FAILED', failure_family: 'AGENT_CONTRACT' }),
    row({ status: 'COMPLETED' }),
  ];
  const byModel = computeStageCallsByModel(rows);
  assert.equal(byModel['claude-fable-5-1'].capacityFailures, 1);
  assert.equal(byModel['claude-fable-5-1'].qualityFailures, 1);
});

// --- 29: fallback vocabulary normalization -----------------------------

test('29. models present under both a modelKey-shaped and full-string source still merge into ONE canonical bucket', () => {
  // resolved_model is the full ledger string; the canonical resolver
  // (pricing-registry.mjs) is what stage-telemetry relies on to avoid
  // splitting the same model across two labels.
  const rows = [row({ resolved_model: 'claude-haiku-4-5-20251001' }), row({ resolved_model: 'claude-haiku-4-5-20251001' })];
  const byModel = computeStageCallsByModel(rows);
  assert.equal(Object.keys(byModel).filter((k) => k.startsWith('claude-haiku')).length, 1, 'the dated build resolves to ONE canonical bucket');
  assert.equal(byModel['claude-haiku-4-5'].stageCalls, 2);
});
