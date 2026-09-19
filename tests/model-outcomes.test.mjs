/**
 * Unit tests for per-model outcome metrics and cost per successful Work
 * Unit. Goal 012 found Fable costs more per token than Opus; these metrics
 * exist to ask a different question — which model finishes more work per
 * dollar — without answering it automatically (no ranking, no routing
 * change here).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeModelOutcomes, costPerSuccessfulWorkUnit } from '../lib/model-outcomes.mjs';
import { groupIntoWorkUnits } from '../lib/historical-distributions.mjs';

function row(overrides = {}) {
  return {
    resolved_model: 'claude-sonnet-5', status: 'COMPLETED', attempt: 1, is_fallback: 0,
    input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0,
    total_tokens: 150, duration_ms: 500, provider_reported_cost_usd: 0.01, auxiliary_usage_json: null,
    work_unit_id: null,
    ...overrides,
  };
}

// --- per-model outcomes (obrigatory cases 23, 25, 26) -----------------------

test('23. Fable and Opus outcomes can be compared side by side without concluding which is "better"', () => {
  const rows = [row({ resolved_model: 'claude-fable-5-1' }), row({ resolved_model: 'claude-opus-5' })];
  const outcomes = computeModelOutcomes(rows);
  assert.ok(outcomes['claude-fable-5-1']);
  assert.ok(outcomes['claude-opus-5']);
  assert.equal(outcomes['claude-fable-5-1'].classification, 'CALCULATED');
  assert.equal(outcomes['claude-fable-5-1'].calls, 1);
});

test('25. a failed model call is counted under that model\'s failedCalls and failureRatePercent', () => {
  const rows = [row({ status: 'FAILED' }), row({ status: 'COMPLETED' })];
  const outcomes = computeModelOutcomes(rows);
  assert.equal(outcomes['claude-sonnet-5'].failedCalls, 1);
  assert.equal(outcomes['claude-sonnet-5'].failureRatePercent, 50);
});

test('26. a retry (attempt > 1) is counted under that model\'s retryCalls and retryRatePercent', () => {
  const rows = [row({ attempt: 1 }), row({ attempt: 2 })];
  const outcomes = computeModelOutcomes(rows);
  assert.equal(outcomes['claude-sonnet-5'].retryCalls, 1);
  assert.equal(outcomes['claude-sonnet-5'].retryRatePercent, 50);
});

test('acceptance/failure/retry/fallback rates are each their own independent percentage', () => {
  const rows = [
    row({ status: 'COMPLETED', attempt: 1, is_fallback: 0 }),
    row({ status: 'FAILED', attempt: 2, is_fallback: 1 }),
  ];
  const outcomes = computeModelOutcomes(rows);
  const o = outcomes['claude-sonnet-5'];
  assert.equal(o.acceptanceRatePercent, 50);
  assert.equal(o.failureRatePercent, 50);
  assert.equal(o.retryRatePercent, 50);
  assert.equal(o.fallbackRatePercent, 50);
});

test('an unresolvable model still gets its own bucket, not merged into UNKNOWN silently for a real string', () => {
  const rows = [row({ resolved_model: 'some-future-model' })];
  const outcomes = computeModelOutcomes(rows);
  assert.ok(outcomes['some-future-model']);
});

// --- cost per successful Work Unit (obrigatory case 24) ---------------------

test('24. cost/tokens/calls per successful Work Unit are CALCULATED from the unit\'s OWN final outcome', () => {
  const rows = [
    row({ work_unit_id: 'WU-1', attempt: 1, status: 'FAILED', total_tokens: 1000, resolved_model: 'claude-opus-5' }),
    row({ work_unit_id: 'WU-1', attempt: 2, status: 'COMPLETED', total_tokens: 2000, resolved_model: 'claude-opus-5' }),
    row({ work_unit_id: 'WU-2', attempt: 1, status: 'COMPLETED', total_tokens: 500, resolved_model: 'claude-opus-5' }),
  ];
  const units = groupIntoWorkUnits(rows);
  const result = costPerSuccessfulWorkUnit(units);
  assert.equal(result.classification, 'CALCULATED');
  assert.equal(result.status, 'OK');
  assert.equal(result.successfulUnits, 2, 'WU-1 succeeded on retry — it counts as ONE successful unit');
  assert.equal(result.callsPerSuccessfulWorkUnit, 1.5, '(2 calls + 1 call) / 2 units');
  assert.ok(result.costPerSuccessfulWorkUnit > 0);
});

test('a unit whose final attempt is FAILED is excluded from "successful" entirely', () => {
  const rows = [row({ work_unit_id: 'WU-1', status: 'FAILED' })];
  const units = groupIntoWorkUnits(rows);
  const result = costPerSuccessfulWorkUnit(units);
  assert.equal(result.status, 'INSUFFICIENT_DATA');
  assert.equal(result.successfulUnits, 0);
});

test('no Work Units at all is INSUFFICIENT_DATA, not a division by zero', () => {
  const result = costPerSuccessfulWorkUnit([]);
  assert.equal(result.status, 'INSUFFICIENT_DATA');
});
