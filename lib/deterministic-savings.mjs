/**
 * IA Loop — ESTIMATED savings from executing a Work Unit deterministically
 * instead of by model.
 *
 * A deterministic Work Unit's own OBSERVED facts are `modelCalls = 0` and
 * `tokens = 0` (Goal 011/012) — there is no counterfactual buried in the
 * ledger for "what would this have cost on a model", because it never ran on
 * one. This module answers that question the only honest way available:
 * finding comparable Work Units that DID run on a model (`lib/work-unit-matching.mjs`,
 * `lib/historical-distributions.mjs`) and reporting their distribution as a
 * range, not a point estimate — with the match tier and sample size that
 * produced it, so the number is auditable without reading this file.
 *
 * Never a constant. There is no "each deterministic unit saves N tokens"
 * anywhere in this module.
 */

import { findHistoricalBaseline } from './historical-distributions.mjs';
import { DEFAULT_PRICING_SNAPSHOT_ID } from './pricing-registry.mjs';

function rangeFrom(distribution) {
  if (!distribution) return null;
  return { lower: distribution.p25, central: distribution.p50, upper: distribution.p75 };
}

function scale(range, factor) {
  if (!range) return null;
  return { lower: range.lower * factor, central: range.central * factor, upper: range.upper * factor };
}

/**
 * Estimates what ONE deterministic Work Unit would plausibly have cost on a
 * model, from the best historical match `population` (real, model-executed
 * Work Unit aggregates — see `groupIntoWorkUnits`) supports.
 *
 * `current` is the deterministic unit's own signature-bearing shape (its
 * `operation`, and whatever else `workUnitSignature` can read off it — a
 * deterministic unit rarely shares `role`/`complexity` with a model unit, so
 * this legitimately tends to land at WEAK/LOW confidence rather than being
 * forced higher than the evidence supports).
 */
export function estimateDeterministicUnitSavings(current, population, { pricingSnapshotId = DEFAULT_PRICING_SNAPSHOT_ID } = {}) {
  const baseline = findHistoricalBaseline(current, population, { pricingSnapshotId });
  if (baseline.status !== 'OK') {
    return {
      classification: 'ESTIMATED',
      method: 'HISTORICAL_MATCHED_WORK_UNITS',
      status: 'INSUFFICIENT_DATA',
      matchTier: baseline.matchTier,
      sampleSize: 0,
      confidence: 'INSUFFICIENT_DATA',
      sampleWorkUnitIds: [],
      modelCallsAvoided: null,
      tokensAvoided: null,
      costUsdAvoided: null,
    };
  }

  const { distributions } = baseline;
  return {
    classification: 'ESTIMATED',
    method: 'HISTORICAL_MATCHED_WORK_UNITS',
    status: 'OK',
    matchTier: baseline.matchTier,
    sampleSize: baseline.sampleSize,
    confidence: baseline.confidence,
    sampleWorkUnitIds: baseline.sampleWorkUnitIds,
    // Calls avoided is its own figure (Goal §8): even a unit that "obviously"
    // would have taken one call still depends on what the baseline says.
    modelCallsAvoided: distributions.modelCalls ? distributions.modelCalls.p50 : null,
    tokensAvoided: rangeFrom(distributions.allModelTokens),
    costUsdAvoided: rangeFrom(distributions.calculatedCostUsd),
  };
}

/**
 * Aggregates the per-unit estimate above over EVERY currently-observed
 * deterministic Work Unit (Goal 011's `summariseWorkUnits().deterministicUnits`
 * worth of them), scaling the SAME baseline distribution by how many units
 * actually ran deterministically — never re-deriving a fresh baseline per
 * unit when they share one signature (e.g. all `lint` actions).
 *
 * `deterministicUnits` here are lightweight descriptors — typically built
 * from `WORK_UNIT_DETERMINISTIC_EXECUTED` events — not ledger rows, since a
 * deterministic unit never produces one.
 */
export function estimateDeterministicSavings(deterministicUnits, population, { pricingSnapshotId = DEFAULT_PRICING_SNAPSHOT_ID } = {}) {
  if (!Array.isArray(deterministicUnits) || deterministicUnits.length === 0) {
    return {
      classification: 'ESTIMATED',
      method: 'HISTORICAL_MATCHED_WORK_UNITS',
      status: 'INSUFFICIENT_DATA',
      observedDeterministicUnits: 0,
      perUnit: null,
      totalModelCallsAvoided: null,
      totalTokensAvoided: null,
      totalCostUsdAvoided: null,
    };
  }

  // One representative unit stands in for the whole population when they
  // share the same signature-relevant shape (the common case: every
  // deterministic unit in a Goal is `operation: 'work_unit'`). A future
  // caller with a genuinely mixed population should call
  // `estimateDeterministicUnitSavings` per unit instead of this aggregate.
  const perUnit = estimateDeterministicUnitSavings(deterministicUnits[0], population, { pricingSnapshotId });
  const count = deterministicUnits.length;

  if (perUnit.status !== 'OK') {
    return {
      classification: 'ESTIMATED',
      method: perUnit.method,
      status: 'INSUFFICIENT_DATA',
      observedDeterministicUnits: count,
      perUnit,
      totalModelCallsAvoided: null,
      totalTokensAvoided: null,
      totalCostUsdAvoided: null,
    };
  }

  return {
    classification: 'ESTIMATED',
    method: perUnit.method,
    status: 'OK',
    observedDeterministicUnits: count,
    matchTier: perUnit.matchTier,
    sampleSize: perUnit.sampleSize,
    confidence: perUnit.confidence,
    sampleWorkUnitIds: perUnit.sampleWorkUnitIds,
    perUnit,
    totalModelCallsAvoided: perUnit.modelCallsAvoided !== null ? perUnit.modelCallsAvoided * count : null,
    totalTokensAvoided: scale(perUnit.tokensAvoided, count),
    totalCostUsdAvoided: scale(perUnit.costUsdAvoided, count),
  };
}
