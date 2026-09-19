/**
 * Unit tests for historical distributions and the confidence rule: grouping
 * ledger rows into per-Work-Unit aggregates, percentile statistics over
 * them, and finding the best defensible historical baseline for a Work Unit.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  groupIntoWorkUnits, percentileStats, confidenceFor, findHistoricalBaseline,
} from '../lib/historical-distributions.mjs';
import { MATCH_TIERS } from '../lib/work-unit-matching.mjs';

function row(overrides = {}) {
  return {
    goal_id: '010', round_id: 1, work_unit_id: 'WU-1', operation: 'work_unit', role: 'developer',
    stage: 'implementation', complexity: 'HIGH', risk_score: 3, model_family: 'sonnet',
    resolved_model: 'claude-sonnet-5', status: 'COMPLETED', attempt: 1,
    input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_creation_tokens: 0,
    total_tokens: 1500, duration_ms: 1000, provider_reported_cost_usd: 0.01, auxiliary_usage_json: null,
    ...overrides,
  };
}

// --- groupIntoWorkUnits ------------------------------------------------

test('rows sharing goal/round/workUnitId are grouped into one unit, tokens and calls summed', () => {
  const rows = [
    row({ attempt: 1, total_tokens: 1000, status: 'FAILED' }),
    row({ attempt: 2, total_tokens: 2000, status: 'COMPLETED' }),
  ];
  const [unit] = groupIntoWorkUnits(rows);
  assert.equal(unit.modelCalls, 2);
  assert.equal(unit.allModelTokens, 3000);
  assert.equal(unit.finalStatus, 'COMPLETED', 'the outcome is the LATEST attempt, not the first');
});

test('rows with no work_unit_id are excluded — they are not Work Units', () => {
  const rows = [row({ work_unit_id: null })];
  assert.deepEqual(groupIntoWorkUnits(rows), []);
});

test('different workUnitIds (even in the same Goal/round) produce separate units', () => {
  const rows = [row({ work_unit_id: 'WU-1' }), row({ work_unit_id: 'WU-2' })];
  assert.equal(groupIntoWorkUnits(rows).length, 2);
});

// --- percentileStats (obrigatory case 5, 6, 7) ------------------------------

test('5. p25/p50/p75/mean/min/max over a sample', () => {
  const stats = percentileStats([10, 20, 30, 40]);
  assert.equal(stats.count, 4);
  assert.equal(stats.p25, 20);
  assert.equal(stats.p50, 30);
  assert.equal(stats.p75, 40);
  assert.equal(stats.mean, 25);
  assert.equal(stats.min, 10);
  assert.equal(stats.max, 40);
});

test('6. an empty sample is null, never a fabricated zero', () => {
  assert.equal(percentileStats([]), null);
});

test('7. a single-value sample reports that value for every percentile', () => {
  const stats = percentileStats([42]);
  assert.equal(stats.count, 1);
  assert.equal(stats.p25, 42);
  assert.equal(stats.p50, 42);
  assert.equal(stats.p75, 42);
  assert.equal(stats.min, 42);
  assert.equal(stats.max, 42);
});

test('non-finite values are ignored, not treated as zero', () => {
  const stats = percentileStats([10, NaN, 20, undefined, null]);
  assert.equal(stats.count, 2);
});

// --- confidence rule (obrigatory cases 8, 9, 10) ----------------------------

test('8. LOW confidence: WEAK match regardless of sample size, or any tier under 5 samples', () => {
  assert.equal(confidenceFor(MATCH_TIERS.WEAK, 1000), 'LOW');
  assert.equal(confidenceFor(MATCH_TIERS.EXACT, 4), 'LOW');
  assert.equal(confidenceFor(MATCH_TIERS.STRONG, 4), 'LOW');
});

test('9. MEDIUM confidence: EXACT or STRONG match with 5-19 samples', () => {
  assert.equal(confidenceFor(MATCH_TIERS.EXACT, 5), 'MEDIUM');
  assert.equal(confidenceFor(MATCH_TIERS.EXACT, 19), 'MEDIUM');
  assert.equal(confidenceFor(MATCH_TIERS.STRONG, 5), 'MEDIUM');
  assert.equal(confidenceFor(MATCH_TIERS.STRONG, 19), 'MEDIUM');
});

test('10. HIGH confidence: EXACT match with 20 or more samples', () => {
  assert.equal(confidenceFor(MATCH_TIERS.EXACT, 20), 'HIGH');
  assert.equal(confidenceFor(MATCH_TIERS.EXACT, 1000), 'HIGH');
  assert.equal(confidenceFor(MATCH_TIERS.STRONG, 20), 'MEDIUM', 'STRONG never reaches HIGH, however large the sample');
});

test('INSUFFICIENT_DATA when there is no match tier or the sample is empty', () => {
  assert.equal(confidenceFor(MATCH_TIERS.NONE, 0), 'INSUFFICIENT_DATA');
  assert.equal(confidenceFor(MATCH_TIERS.EXACT, 0), 'INSUFFICIENT_DATA');
});

// --- findHistoricalBaseline ----------------------------------------------

test('finds the best available tier, preferring EXACT over STRONG over WEAK', () => {
  const current = { operation: 'work_unit', role: 'developer', complexity: 'HIGH' };
  const population = groupIntoWorkUnits([
    row({ work_unit_id: 'A', role: 'developer', complexity: 'HIGH' }), // EXACT
    row({ work_unit_id: 'B', role: 'tech_lead', complexity: 'LOW' }), // WEAK
  ]);
  const baseline = findHistoricalBaseline(current, population);
  assert.equal(baseline.status, 'OK');
  assert.equal(baseline.matchTier, MATCH_TIERS.EXACT);
  assert.equal(baseline.sampleSize, 1);
});

test('falls back to STRONG when no EXACT match exists, and to WEAK when neither does', () => {
  const current = { operation: 'work_unit', role: 'developer', complexity: 'HIGH' };
  const strongPopulation = groupIntoWorkUnits([row({ work_unit_id: 'A', role: 'developer', complexity: 'MEDIUM' })]);
  assert.equal(findHistoricalBaseline(current, strongPopulation).matchTier, MATCH_TIERS.STRONG);

  const weakPopulation = groupIntoWorkUnits([row({ work_unit_id: 'B', role: 'tech_lead', complexity: 'LOW' })]);
  assert.equal(findHistoricalBaseline(current, weakPopulation).matchTier, MATCH_TIERS.WEAK);
});

test('INSUFFICIENT_DATA when the population has no comparable operation at all', () => {
  const current = { operation: 'work_unit' };
  const population = groupIntoWorkUnits([row({ operation: 'review' })]);
  const baseline = findHistoricalBaseline(current, population);
  assert.equal(baseline.status, 'INSUFFICIENT_DATA');
  assert.equal(baseline.sampleSize, 0);
  assert.deepEqual(baseline.sampleWorkUnitIds, []);
});

test('the baseline names exactly which historical Work Unit ids produced it — explainable without reading code', () => {
  const current = { operation: 'work_unit', role: 'developer', complexity: 'HIGH' };
  const population = groupIntoWorkUnits([row({ work_unit_id: 'WU-77', role: 'developer', complexity: 'HIGH' })]);
  const baseline = findHistoricalBaseline(current, population);
  assert.deepEqual(baseline.sampleWorkUnitIds, ['WU-77']);
});

test('distributions cover every metric the Goal lists, including calculatedCostUsd', () => {
  const current = { operation: 'work_unit', role: 'developer', complexity: 'HIGH' };
  const population = groupIntoWorkUnits([
    row({ work_unit_id: 'A', role: 'developer', complexity: 'HIGH', input_tokens: 1000, output_tokens: 200 }),
    row({ work_unit_id: 'B', role: 'developer', complexity: 'HIGH', input_tokens: 2000, output_tokens: 400 }),
  ]);
  const baseline = findHistoricalBaseline(current, population);
  for (const metric of ['modelCalls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'allModelTokens', 'durationMs', 'calculatedCostUsd']) {
    assert.ok(baseline.distributions[metric], `${metric} distribution should be present`);
  }
});
