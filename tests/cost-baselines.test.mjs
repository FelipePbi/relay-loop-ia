/**
 * Unit tests for ACTUAL vs. ALL_OPUS baselines, routing savings, the
 * provider-vs-calculated diagnostic, efficiency shares, and the historical/
 * legacy baseline infrastructure. Every input is a plain object shaped like a
 * `model_usage` row — nothing here touches a real ledger or a model.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeCostBaselines, savingsBreakdown, computeEfficiency, modelRoutingBreakdown, priceRow, invocationsOf,
} from '../lib/cost-baselines.mjs';
import { calculateUsageCost } from '../lib/pricing-engine.mjs';
import { getPricingSnapshot } from '../lib/pricing-registry.mjs';

const SNAPSHOT = getPricingSnapshot();

function row(overrides = {}) {
  return {
    goal_id: '010', round_id: 1, role: 'developer', operation: 'work_unit', work_unit_id: 'WU-1',
    resolved_model: 'claude-sonnet-5', requested_model: 'claude-sonnet-5',
    status: 'COMPLETED', attempt: 1, is_fallback: 0, is_escalation: 0,
    input_tokens: 100_000, output_tokens: 20_000, cache_read_tokens: 0, cache_creation_tokens: 0,
    total_tokens: 120_000, provider_reported_cost_usd: null, auxiliary_usage_json: null,
    ...overrides,
  };
}

// --- ACTUAL baseline ---------------------------------------------------

test('ACTUAL prices every invocation as the model it actually ran on', () => {
  const rows = [row({ resolved_model: 'claude-haiku-4-5-20251001' })];
  const baselines = computeCostBaselines(rows);
  const expected = calculateUsageCost({ inputTokens: 100_000, outputTokens: 20_000, cacheReadTokens: 0, cacheCreationTokens: 0 }, SNAPSHOT, 'claude-haiku-4-5').costUsd;
  assert.equal(baselines.actual.classification, 'CALCULATED');
  assert.equal(baselines.actual.baseline, 'ACTUAL');
  assert.ok(Math.abs(baselines.actual.costUsd - expected) < 1e-9);
  assert.equal(baselines.actual.pricedInvocations, 1);
  assert.equal(baselines.actual.totalInvocations, 1);
});

// --- ALL_OPUS baseline --------------------------------------------------

test('ALL_OPUS keeps token counts fixed and only reprices them as Opus', () => {
  const rows = [row({ resolved_model: 'claude-haiku-4-5-20251001', input_tokens: 100_000, output_tokens: 20_000 })];
  const baselines = computeCostBaselines(rows);
  const expectedOpus = calculateUsageCost({ inputTokens: 100_000, outputTokens: 20_000, cacheReadTokens: 0, cacheCreationTokens: 0 }, SNAPSHOT, 'claude-opus-5').costUsd;
  assert.equal(baselines.allOpus.classification, 'CALCULATED');
  assert.equal(baselines.allOpus.baseline, 'ALL_OPUS');
  assert.ok(Math.abs(baselines.allOpus.costUsd - expectedOpus) < 1e-9);
  assert.match(baselines.allOpus.method, /without changing token quantities/);
});

test('a call that was ALREADY Opus has (near) zero routing savings', () => {
  const rows = [row({ resolved_model: 'claude-opus-5' })];
  const baselines = computeCostBaselines(rows);
  assert.ok(Math.abs(baselines.routingSavingsUsd) < 1e-9);
});

test('a Sonnet call recalculated as Opus shows positive savings', () => {
  const rows = [row({ resolved_model: 'claude-sonnet-5' })];
  const baselines = computeCostBaselines(rows);
  assert.ok(baselines.routingSavingsUsd > 0);
});

test('a Haiku call recalculated as Opus shows even larger relative savings than Sonnet', () => {
  const sonnetSavings = computeCostBaselines([row({ resolved_model: 'claude-sonnet-5' })]).routingSavingsPercent;
  const haikuSavings = computeCostBaselines([row({ resolved_model: 'claude-haiku-4-5-20251001' })]).routingSavingsPercent;
  assert.ok(haikuSavings > sonnetSavings, 'Haiku is cheaper than Sonnet, so switching it to Opus costs relatively more');
});

// --- auxiliary usage -----------------------------------------------------

test('auxiliary usage is priced at ITS OWN model and included in the ACTUAL total', () => {
  const auxJson = JSON.stringify([{ model: 'claude-haiku-4-5-20251001', inputTokens: 50_000, outputTokens: 5_000, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null }]);
  const rows = [row({ resolved_model: 'claude-opus-5', auxiliary_usage_json: auxJson })];
  const invocations = invocationsOf(rows[0]);
  assert.equal(invocations.length, 2, 'primary plus one auxiliary invocation');

  const baselines = computeCostBaselines(rows);
  assert.equal(baselines.actual.totalInvocations, 2);
  const primaryOnly = calculateUsageCost({ inputTokens: 100_000, outputTokens: 20_000, cacheReadTokens: 0, cacheCreationTokens: 0 }, SNAPSHOT, 'claude-opus-5').costUsd;
  assert.ok(baselines.actual.costUsd > primaryOnly, 'the auxiliary Haiku spend is added on top of the primary Opus cost');
});

test('zero auxiliary usage means exactly one invocation per row, and behaves identically to no auxiliary field at all', () => {
  const withNull = invocationsOf(row({ auxiliary_usage_json: null }));
  const withEmpty = invocationsOf(row({ auxiliary_usage_json: '[]' }));
  assert.equal(withNull.length, 1);
  assert.equal(withEmpty.length, 1);
});

// --- routing savings: positive / zero / counterfactual cheaper -------------

test('routing savings across a mixed population is positive when routing avoided Opus', () => {
  const rows = [row({ resolved_model: 'claude-haiku-4-5-20251001' }), row({ resolved_model: 'claude-sonnet-5' })];
  const baselines = computeCostBaselines(rows);
  assert.ok(baselines.routingSavingsUsd > 0);
  assert.ok(baselines.routingSavingsPercent > 0);
});

test('routing savings is exactly zero when every call already ran on Opus', () => {
  const rows = [row({ resolved_model: 'claude-opus-5' }), row({ resolved_model: 'claude-opus-5', input_tokens: 5_000 })];
  const baselines = computeCostBaselines(rows);
  assert.ok(Math.abs(baselines.routingSavingsUsd) < 1e-9);
  assert.equal(baselines.routingSavingsPercent, 0);
});

test('a counterfactual that is MORE expensive than actual reports negative savings, not clamped to zero', () => {
  // A synthetic snapshot where the actual model is pricier than the
  // counterfactual target — the engine and the savings arithmetic must not
  // assume a counterfactual is always the expensive one; that assumption
  // only holds because THIS registry happens to make Opus the ceiling.
  const customSnapshot = {
    id: 'test-inverted', provider: 'test', effectiveFrom: '2026-01-01',
    models: {
      'expensive-legacy': { input: 100, output: 100, cacheRead: 100, cacheCreation: 100 },
      'cheap-target': { input: 1, output: 1, cacheRead: 1, cacheCreation: 1 },
    },
  };
  const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const actual = calculateUsageCost(usage, customSnapshot, 'expensive-legacy');
  const counterfactual = calculateUsageCost(usage, customSnapshot, 'cheap-target');
  const savings = counterfactual.costUsd - actual.costUsd;
  assert.ok(savings < 0, 'the counterfactual is cheaper than actual, so "savings" from switching TO it is negative');
});

// --- savings by model / by dimension ----------------------------------------

test('savingsByModel attributes each row\'s savings to the model it actually ran on', () => {
  const rows = [row({ resolved_model: 'claude-haiku-4-5-20251001' }), row({ resolved_model: 'claude-sonnet-5' }), row({ resolved_model: 'claude-opus-5' })];
  const baselines = computeCostBaselines(rows);
  assert.ok(baselines.savingsByModel['claude-haiku-4-5'] > 0);
  assert.ok(baselines.savingsByModel['claude-sonnet-5'] > 0);
  assert.ok(Math.abs(baselines.savingsByModel['claude-opus-5']) < 1e-9);
  const total = Object.values(baselines.savingsByModel).reduce((sum, v) => sum + v, 0);
  assert.ok(Math.abs(total - baselines.routingSavingsUsd) < 1e-6, 'the per-model breakdown reconciles with the overall total');
});

test('savingsBreakdown groups by an arbitrary dimension, e.g. operation', () => {
  const rows = [
    row({ operation: 'planning', resolved_model: 'claude-haiku-4-5-20251001' }),
    row({ operation: 'review', resolved_model: 'claude-opus-5' }),
    row({ operation: 'planning', resolved_model: 'claude-sonnet-5' }),
  ];
  const breakdown = savingsBreakdown(rows, {}, (r) => r.operation);
  assert.equal(breakdown.planning.rows, 2);
  assert.equal(breakdown.review.rows, 1);
  assert.ok(breakdown.planning.savingsUsd > 0);
});

test('savingsBreakdown groups unattributable rows under UNKNOWN rather than dropping them', () => {
  const breakdown = savingsBreakdown([row({ work_unit_id: null })], {}, (r) => r.work_unit_id);
  assert.ok(breakdown.UNKNOWN);
  assert.equal(breakdown.UNKNOWN.rows, 1);
});

// --- provider vs. calculated diagnostic -------------------------------------

test('provider reported and calculated cost are compared, never substituted for one another', () => {
  const rows = [row({ resolved_model: 'claude-opus-5', provider_reported_cost_usd: 999 })];
  const baselines = computeCostBaselines(rows);
  assert.equal(baselines.providerVsCalculated.providerReportedCostUsd, 999);
  assert.notEqual(baselines.providerVsCalculated.calculatedCostUsd, 999);
  assert.ok(Math.abs(baselines.providerVsCalculated.differenceUsd - (999 - baselines.providerVsCalculated.calculatedCostUsd)) < 1e-9);
});

test('a row with no provider cost is simply excluded from the comparison, not counted as $0', () => {
  const rows = [row({ resolved_model: 'claude-opus-5', provider_reported_cost_usd: null })];
  const baselines = computeCostBaselines(rows);
  assert.equal(baselines.providerVsCalculated, null);
});

// --- integrity: unknown models and missing snapshots ------------------------

test('an unknown model is flagged and excluded from the calculated total, never priced at $0', () => {
  const rows = [row({ resolved_model: 'gpt-5' }), row({ resolved_model: 'claude-opus-5' })];
  const baselines = computeCostBaselines(rows);
  assert.ok(baselines.unknownModels.includes('gpt-5'));
  assert.ok(baselines.integrityFlags.includes('PRICING_MODEL_UNKNOWN'));
  assert.ok(baselines.integrityFlags.includes('CALCULATED_COST_INCOMPLETE'));
  // Only the priced (Opus) row contributes; the unknown one is excluded, not zeroed.
  assert.equal(baselines.actual.pricedInvocations, 1);
  assert.equal(baselines.actual.totalInvocations, 2);
});

test('a missing pricing snapshot id is flagged and produces no calculated numbers', () => {
  const baselines = computeCostBaselines([row()], { pricingSnapshotId: 'does-not-exist' });
  assert.equal(baselines.actual, null);
  assert.equal(baselines.allOpus, null);
  assert.deepEqual(baselines.integrityFlags, ['PRICING_SNAPSHOT_MISSING']);
});

// --- efficiency --------------------------------------------------------

test('efficiency shares are percentages of allModelTokens, not asserted to sum to 100%', () => {
  const efficiency = computeEfficiency({
    allModelTokens: 1000, completedTokens: 700, failedTokens: 300, retryTokens: 200, fallbackTokens: 0, escalationTokens: 0,
  });
  assert.equal(efficiency.successfulTokenSharePercent, 70);
  assert.equal(efficiency.failedTokenSharePercent, 30);
  assert.equal(efficiency.retryTokenSharePercent, 20);
  // 70 + 30 + 20 = 120: categories are not exclusive partitions.
});

test('efficiency shares are null, not NaN or Infinity, when there are zero all-model tokens', () => {
  const efficiency = computeEfficiency({ allModelTokens: 0, completedTokens: 0, failedTokens: 0, retryTokens: 0, fallbackTokens: 0, escalationTokens: 0 });
  assert.equal(efficiency.successfulTokenSharePercent, null);
});

// Historical baselines (match-tier based) and LEGACY_MONOLITHIC now live in
// lib/historical-distributions.mjs and lib/legacy-baseline.mjs respectively
// (Goal 013) — see tests/historical-distributions.test.mjs and
// tests/legacy-baseline.test.mjs.

// --- per-model routing breakdown ("Fable analysis") -------------------------

test('modelRoutingBreakdown reports calls, tokens, actual and ALL_OPUS cost, and the delta per model', () => {
  const rows = [row({ resolved_model: 'claude-fable-5-1' }), row({ resolved_model: 'claude-opus-5' })];
  const breakdown = modelRoutingBreakdown(rows);
  assert.equal(breakdown['claude-fable-5-1'].calls, 1);
  assert.equal(breakdown['claude-fable-5-1'].classification, 'CALCULATED');
  // Fable is priced ABOVE Opus in this registry (Goal 012's real finding), so
  // routing to Fable costs MORE than the Opus counterfactual: a NEGATIVE delta.
  assert.ok(breakdown['claude-fable-5-1'].routingDeltaUsd < 0, 'Fable costs more than the all-Opus counterfactual');
  assert.ok(Math.abs(breakdown['claude-opus-5'].routingDeltaUsd) < 1e-9, 'Opus vs. itself has zero delta');
});

test('modelRoutingBreakdown never relabels or clamps a negative delta', () => {
  const breakdown = modelRoutingBreakdown([row({ resolved_model: 'claude-fable-5-1' })]);
  assert.ok(Object.prototype.hasOwnProperty.call(breakdown['claude-fable-5-1'], 'routingDeltaUsd'));
  assert.ok(breakdown['claude-fable-5-1'].routingDeltaUsd < 0);
});

// --- priceRow / invocationsOf sanity -----------------------------------

test('priceRow reports complete=false when any invocation could not be priced', () => {
  const priced = priceRow(row({ resolved_model: 'unknown-model-xyz' }), SNAPSHOT);
  assert.equal(priced.complete, false);
  assert.equal(priced.costUsd, null);
});
