/**
 * Unit tests for ESTIMATED deterministic-savings: what a deterministic Work
 * Unit plausibly avoided, from comparable historical Work Units that DID run
 * on a model. Every number here must carry a range and a confidence — never
 * a single point estimate, and never present when there is nothing to base
 * it on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { estimateDeterministicUnitSavings, estimateDeterministicSavings } from '../lib/deterministic-savings.mjs';
import { groupIntoWorkUnits } from '../lib/historical-distributions.mjs';

function row(overrides = {}) {
  return {
    goal_id: '010', round_id: 1, work_unit_id: 'WU-hist', operation: 'work_unit', role: 'developer',
    complexity: 'MEDIUM', resolved_model: 'claude-sonnet-5', status: 'COMPLETED', attempt: 1,
    input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_creation_tokens: 0,
    total_tokens: 1500, duration_ms: 1000, provider_reported_cost_usd: 0.01, auxiliary_usage_json: null,
    ...overrides,
  };
}

// --- 11/12: unit without / with a baseline ----------------------------------

test('11. a deterministic unit with no comparable history is INSUFFICIENT_DATA, never a fabricated estimate', () => {
  const current = { operation: 'work_unit', deterministicAction: 'lint' };
  const result = estimateDeterministicUnitSavings(current, []);
  assert.equal(result.classification, 'ESTIMATED');
  assert.equal(result.status, 'INSUFFICIENT_DATA');
  assert.equal(result.modelCallsAvoided, null);
  assert.equal(result.tokensAvoided, null);
  assert.equal(result.costUsdAvoided, null);
});

test('12. a deterministic unit WITH comparable history produces a range, method, and evidence', () => {
  const current = { operation: 'work_unit', deterministicAction: 'lint' };
  const population = groupIntoWorkUnits([
    row({ work_unit_id: 'A', total_tokens: 1000 }),
    row({ work_unit_id: 'B', total_tokens: 2000 }),
    row({ work_unit_id: 'C', total_tokens: 3000 }),
  ]);
  const result = estimateDeterministicUnitSavings(current, population);
  assert.equal(result.status, 'OK');
  assert.equal(result.method, 'HISTORICAL_MATCHED_WORK_UNITS');
  assert.ok(result.sampleWorkUnitIds.length > 0);
  assert.ok(result.confidence);
});

// --- 13: estimated calls avoided --------------------------------------

test('13. estimated calls avoided is its own figure, from the historical median calls per unit', () => {
  const current = { operation: 'work_unit' };
  // Two historical units: one took 1 call, one took 2 (a retry) — median 1.5? no,
  // p50 of [1, 2] with the nearest-rank rule used everywhere in this codebase.
  const population = groupIntoWorkUnits([
    row({ work_unit_id: 'A', attempt: 1 }),
    row({ work_unit_id: 'B', attempt: 1 }),
    row({ work_unit_id: 'B', attempt: 2 }),
  ]);
  const result = estimateDeterministicUnitSavings(current, population);
  assert.equal(result.status, 'OK');
  assert.ok(Number.isFinite(result.modelCallsAvoided));
});

// --- 14/15: token and cost ranges --------------------------------------

test('14. tokens avoided is a lower/central/upper range, not a single number', () => {
  const current = { operation: 'work_unit' };
  const population = groupIntoWorkUnits([
    row({ work_unit_id: 'A', total_tokens: 1000 }),
    row({ work_unit_id: 'B', total_tokens: 5000 }),
    row({ work_unit_id: 'C', total_tokens: 9000 }),
  ]);
  const result = estimateDeterministicUnitSavings(current, population);
  assert.ok(result.tokensAvoided.lower <= result.tokensAvoided.central);
  assert.ok(result.tokensAvoided.central <= result.tokensAvoided.upper);
});

test('15. cost avoided is a lower/central/upper range, derived from calculated (not observed) cost', () => {
  const current = { operation: 'work_unit' };
  const population = groupIntoWorkUnits([
    row({ work_unit_id: 'A', resolved_model: 'claude-opus-5', total_tokens: 1000 }),
    row({ work_unit_id: 'B', resolved_model: 'claude-opus-5', total_tokens: 5000 }),
  ]);
  const result = estimateDeterministicUnitSavings(current, population);
  assert.ok(result.costUsdAvoided);
  assert.ok(result.costUsdAvoided.lower <= result.costUsdAvoided.upper);
});

// --- aggregate over several deterministic units -----------------------------

test('aggregating over N observed deterministic units scales the SAME baseline, not N separate lookups', () => {
  const units = [{ operation: 'work_unit' }, { operation: 'work_unit' }, { operation: 'work_unit' }];
  const population = groupIntoWorkUnits([
    row({ work_unit_id: 'A', total_tokens: 1000 }),
    row({ work_unit_id: 'B', total_tokens: 1000 }),
  ]);
  const result = estimateDeterministicSavings(units, population);
  assert.equal(result.status, 'OK');
  assert.equal(result.observedDeterministicUnits, 3);
  const perUnitCentral = result.perUnit.tokensAvoided.central;
  assert.ok(Math.abs(result.totalTokensAvoided.central - perUnitCentral * 3) < 1e-6);
});

test('zero observed deterministic units is INSUFFICIENT_DATA, not zero savings', () => {
  const result = estimateDeterministicSavings([], []);
  assert.equal(result.status, 'INSUFFICIENT_DATA');
  assert.equal(result.observedDeterministicUnits, 0);
  assert.equal(result.totalCostUsdAvoided, null);
});
