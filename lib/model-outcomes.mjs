/**
 * IA Loop — per-model outcome metrics, and cost per successful Work Unit.
 *
 * Goal 012 found that Fable costs more per token than Opus in this ledger's
 * calibrated pricing. That is a cost fact, not an efficiency verdict:
 * "cheaper per call" and "gets more finished work per dollar" are different
 * questions. This module answers outcome questions with plain arithmetic
 * over OBSERVED counts — CALCULATED, never a ranking, a recommendation, or a
 * routing change.
 */

import { priceRow } from './cost-baselines.mjs';
import { DEFAULT_PRICING_SNAPSHOT_ID, getPricingSnapshot, resolveCanonicalModel } from './pricing-registry.mjs';

function n(value) {
  return Number.isFinite(value) ? value : 0;
}

function pct(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;
}

/**
 * Per-model call outcomes: how many calls, how many succeeded/failed/were
 * retries/were fallbacks, and the derived rates — CALCULATED from the same
 * outcome facts `run-usage.mjs`'s `summarise()` already tracks in aggregate,
 * here broken out per model instead of totalled across all of them.
 */
export function computeModelOutcomes(rows, { pricingSnapshotId = DEFAULT_PRICING_SNAPSHOT_ID } = {}) {
  const snapshot = getPricingSnapshot(pricingSnapshotId);
  const byModel = {};

  for (const row of rows) {
    const observedModel = row.resolved_model ?? row.requested_model ?? 'UNKNOWN';
    const model = resolveCanonicalModel(observedModel) ?? observedModel;
    if (!byModel[model]) {
      byModel[model] = {
        calls: 0, successfulCalls: 0, failedCalls: 0, retryCalls: 0, fallbackCalls: 0,
        tokens: 0, costUsd: null, durationMs: 0,
      };
    }
    const bucket = byModel[model];
    bucket.calls += 1;
    if (row.status === 'COMPLETED') bucket.successfulCalls += 1;
    if (row.status === 'FAILED') bucket.failedCalls += 1;
    if (n(row.attempt) > 1) bucket.retryCalls += 1;
    if (row.is_fallback === 1 || row.is_fallback === true) bucket.fallbackCalls += 1;
    bucket.tokens += n(row.total_tokens);
    bucket.durationMs += n(row.duration_ms);

    if (snapshot) {
      const priced = priceRow(row, snapshot);
      if (priced.complete) bucket.costUsd = (bucket.costUsd ?? 0) + priced.costUsd;
    }
  }

  const outcomes = {};
  for (const [model, bucket] of Object.entries(byModel)) {
    outcomes[model] = {
      ...bucket,
      classification: 'CALCULATED',
      acceptanceRatePercent: pct(bucket.successfulCalls, bucket.calls),
      failureRatePercent: pct(bucket.failedCalls, bucket.calls),
      retryRatePercent: pct(bucket.retryCalls, bucket.calls),
      fallbackRatePercent: pct(bucket.fallbackCalls, bucket.calls),
    };
  }
  return outcomes;
}

/**
 * Cost/tokens/calls per SUCCESSFUL Work Unit — over `groupIntoWorkUnits`'s
 * aggregates (`lib/historical-distributions.mjs`), never over raw rows: a
 * unit that retried twice before succeeding is ONE successful unit that took
 * three calls, not three units.
 *
 * `CALCULATED`: every input (unit outcome, token count, price) is either
 * OBSERVED or already-CALCULATED (pricing engine) — nothing here is a guess
 * about a unit that never ran.
 */
export function costPerSuccessfulWorkUnit(units, { pricingSnapshotId = DEFAULT_PRICING_SNAPSHOT_ID } = {}) {
  const snapshot = getPricingSnapshot(pricingSnapshotId);
  const successful = units.filter((unit) => unit.finalStatus === 'COMPLETED');

  if (successful.length === 0) {
    return { classification: 'CALCULATED', status: 'INSUFFICIENT_DATA', successfulUnits: 0 };
  }

  let totalCostUsd = null;
  let pricedUnits = 0;
  for (const unit of successful) {
    if (!snapshot) continue;
    const priced = unit.rows.map((row) => priceRow(row, snapshot));
    if (!priced.every((p) => p.complete)) continue;
    totalCostUsd = (totalCostUsd ?? 0) + priced.reduce((sum, p) => sum + p.costUsd, 0);
    pricedUnits += 1;
  }

  const totalCalls = successful.reduce((sum, unit) => sum + unit.modelCalls, 0);
  const totalTokens = successful.reduce((sum, unit) => sum + unit.allModelTokens, 0);

  return {
    classification: 'CALCULATED',
    status: 'OK',
    successfulUnits: successful.length,
    callsPerSuccessfulWorkUnit: totalCalls / successful.length,
    tokensPerSuccessfulWorkUnit: totalTokens / successful.length,
    costPerSuccessfulWorkUnit: pricedUnits > 0 ? totalCostUsd / pricedUnits : null,
    pricedUnits,
  };
}
