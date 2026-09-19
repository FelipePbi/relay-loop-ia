/**
 * IA Loop — cost × outcome effectiveness, per model.
 *
 * Answers "does a more expensive model earn its cost back in fewer retries,
 * fewer repairs, more acceptances" — never by inventing one "quality score",
 * but by keeping cost, tokens, calls, retries, failures, repairs, reviews and
 * acceptance as SEPARATE, individually-sourced numbers (Goal 014's central
 * principle). Every rate below is a real division of two OBSERVED or
 * CALCULATED counts; nothing here is estimated from a model that didn't run.
 *
 * Sample-size discipline is centralised in `sampleConfidenceFor` — the same
 * rule for every metric in this file, never judged ad hoc per call site.
 */

import { priceRow } from './cost-baselines.mjs';
import { groupIntoWorkUnits, percentileStats } from './historical-distributions.mjs';
import { computeModelOutcomes } from './model-outcomes.mjs';
import { resolveCanonicalModel, DEFAULT_PRICING_SNAPSHOT_ID, getPricingSnapshot } from './pricing-registry.mjs';
import { resolveModel } from './model-routing.mjs';
import {
  OUTCOMES, attributeWorkUnit, indexFixEvents, indexReviewDecisions,
  indexUnitCompletionEvents, classifyFailureRelevance,
} from './outcome-attribution.mjs';

function n(value) {
  return Number.isFinite(value) ? value : 0;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

/**
 * `fallback_from_model`/`escalation_from_model` store the routing MODEL KEY
 * ('sonnet', 'opus'...), not the canonical ledger model string — a different
 * vocabulary than `resolved_model` uses. Resolved through the SAME table
 * `lib/model-routing.mjs` uses for routing itself, never a second guess at
 * the mapping.
 */
function canonicalOfModelKey(key) {
  if (!key) return null;
  try {
    return resolveModel(key).model;
  } catch {
    return null;
  }
}

/**
 * The ONE minimum-sample-size rule every effectiveness metric in this module
 * defers to. Centralised and pure so a threshold change never has to be
 * hunted down across call sites.
 */
export function sampleConfidenceFor(n_) {
  if (!Number.isFinite(n_) || n_ < 5) return 'INSUFFICIENT_DATA';
  if (n_ < 20) return 'LOW_CONFIDENCE';
  if (n_ < 50) return 'MEDIUM_CONFIDENCE';
  return 'HIGH_CONFIDENCE';
}

/** A unit's model of record for closing purposes: whichever model made its LAST call. */
function closingModelOf(unit) {
  const byAttempt = [...unit.rows].sort((a, b) => n(a.attempt) - n(b.attempt));
  const last = byAttempt[byAttempt.length - 1];
  return resolveCanonicalModel(last?.resolved_model ?? last?.requested_model) ?? (last?.resolved_model ?? null);
}

/** Every canonical model that made at least one call within a unit. */
function modelsInvolvedIn(unit) {
  return new Set(unit.rows.map((row) => resolveCanonicalModel(row.resolved_model ?? row.requested_model) ?? (row.resolved_model ?? 'UNKNOWN')));
}

/**
 * Builds one model's effectiveness record — the shape from Goal 014 §21,
 * extended with the source/destination and quality-relevant breakdowns the
 * rest of the Goal asks for.
 */
function buildModelRecord(model, { modelRows, allRows, unitsInvolved, attributions, snapshot, pricingSnapshotId }) {
  const outcomes = computeModelOutcomes(modelRows, { pricingSnapshotId })[model]
    ?? { calls: 0, successfulCalls: 0, failedCalls: 0, retryCalls: 0, fallbackCalls: 0, tokens: 0, costUsd: null, durationMs: 0 };

  // --- failure relevance (quality vs infra) -------------------------------
  const failedRows = modelRows.filter((row) => row.status === 'FAILED');
  const qualityRelevantFailed = failedRows.filter((row) => classifyFailureRelevance(row).qualityRelevant).length;

  // --- fallback / escalation source vs destination ------------------------
  // Destination: THIS model's own rows that were routed here as a fallback/
  // escalation. Source: OTHER rows (anywhere in the population) that name
  // this model as where the call came FROM — never found by filtering
  // modelRows, since the "from" model's own row never carries its own name
  // in fallback_from_model/escalation_from_model.
  const fallbackDestinationCalls = modelRows.filter((row) => row.is_fallback === 1 || row.is_fallback === true).length;
  const fallbackSourceCalls = allRows.filter((row) => canonicalOfModelKey(row.fallback_from_model) === model).length;
  const escalationsReceived = modelRows.filter((row) => row.is_escalation === 1 || row.is_escalation === true);
  const escalationsResolved = escalationsReceived.filter((row) => row.status === 'COMPLETED').length;
  const escalationSourceCalls = allRows.filter((row) => canonicalOfModelKey(row.escalation_from_model) === model).length;

  // --- Work Unit level: first-pass success, retry, acceptance, repair -----
  let firstPassSuccessCalls = 0;
  let attemptedWorkUnits = 0;
  let workUnitsWithRetry = 0;
  let successfulWorkUnits = 0;
  let acceptedWorkUnits = 0;
  let changesRequiredWorkUnits = 0;
  let repairedWorkUnits = 0;
  let reviewedWorkUnits = 0;
  const successfulUnitsForCost = [];
  const acceptedUnitsForCost = [];

  for (const unit of unitsInvolved) {
    attemptedWorkUnits += 1;
    const attribution = attributions.get(`${unit.goalId ?? '-'}::${unit.roundId ?? '-'}::${unit.workUnitId}`);
    if (!attribution) continue;

    if (unit.modelCalls > 1) workUnitsWithRetry += 1;

    const madeSoleCall = unit.modelCalls === 1 && closingModelOf(unit) === model;
    if (madeSoleCall && attribution.outcome === OUTCOMES.SUCCESS) firstPassSuccessCalls += 1;

    if (attribution.outcome === OUTCOMES.SUCCESS || attribution.outcome === OUTCOMES.REPAIRED) {
      successfulWorkUnits += 1;
      successfulUnitsForCost.push(unit);
    }
    if (attribution.repaired) repairedWorkUnits += 1;

    if (attribution.reviewOutcome) {
      reviewedWorkUnits += 1;
      if (attribution.reviewOutcome.outcome === OUTCOMES.ACCEPTED) {
        acceptedWorkUnits += 1;
        acceptedUnitsForCost.push(unit);
      } else {
        changesRequiredWorkUnits += 1;
      }
    }
  }

  const costOfUnits = (units) => {
    if (!snapshot || units.length === 0) return null;
    let total = null;
    for (const unit of units) {
      const priced = unit.rows.map((row) => priceRow(row, snapshot));
      if (!priced.every((p) => p.complete)) continue;
      total = (total ?? 0) + priced.reduce((sum, p) => sum + p.costUsd, 0);
    }
    return total;
  };
  const tokensOfUnits = (units) => (units.length === 0 ? null : units.reduce((sum, unit) => sum + unit.allModelTokens, 0));
  const durationsOfUnits = (units) => percentileStats(units.map((unit) => unit.durationMs));

  const successfulCostUsd = costOfUnits(successfulUnitsForCost);
  const acceptedCostUsd = costOfUnits(acceptedUnitsForCost);

  return {
    model,
    sample: {
      calls: outcomes.calls,
      workUnits: unitsInvolved.length,
      successfulWorkUnits,
      acceptedWorkUnits: reviewedWorkUnits > 0 ? acceptedWorkUnits : null,
    },
    cost: {
      totalUsd: outcomes.costUsd,
      perCallUsd: ratio(outcomes.costUsd, outcomes.calls),
      perSuccessfulWorkUnitUsd: ratio(successfulCostUsd, successfulWorkUnits),
      perAcceptedWorkUnitUsd: reviewedWorkUnits > 0 ? ratio(acceptedCostUsd, acceptedWorkUnits) : null,
    },
    tokens: {
      total: outcomes.tokens,
      perSuccessfulWorkUnit: ratio(tokensOfUnits(successfulUnitsForCost), successfulWorkUnits),
      perAcceptedWorkUnit: reviewedWorkUnits > 0 ? ratio(tokensOfUnits(acceptedUnitsForCost), acceptedWorkUnits) : null,
    },
    calls: {
      perSuccessfulWorkUnit: ratio(successfulUnitsForCost.reduce((sum, u) => sum + u.modelCalls, 0), successfulWorkUnits),
      perAcceptedWorkUnit: reviewedWorkUnits > 0
        ? ratio(acceptedUnitsForCost.reduce((sum, u) => sum + u.modelCalls, 0), acceptedWorkUnits)
        : null,
    },
    duration: {
      perSuccessfulWorkUnit: durationsOfUnits(successfulUnitsForCost),
      perAcceptedWorkUnit: reviewedWorkUnits > 0 ? durationsOfUnits(acceptedUnitsForCost) : null,
    },
    quality: {
      firstPassSuccessRate: ratio(firstPassSuccessCalls, attemptedWorkUnits),
      retryRate: ratio(workUnitsWithRetry, attemptedWorkUnits),
      acceptanceRate: reviewedWorkUnits > 0 ? ratio(acceptedWorkUnits, reviewedWorkUnits) : null,
      changesRequiredRate: reviewedWorkUnits > 0 ? ratio(changesRequiredWorkUnits, reviewedWorkUnits) : null,
      repairRate: ratio(repairedWorkUnits, attemptedWorkUnits),
      rawFailureRate: outcomes.failureRatePercent !== null ? outcomes.failureRatePercent / 100 : null,
      qualityRelevantFailureRate: ratio(qualityRelevantFailed, outcomes.calls),
    },
    fallback: {
      fallbackSourceCalls,
      fallbackDestinationCalls,
    },
    escalation: {
      escalationsReceived: escalationsReceived.length,
      escalationsResolved,
      escalationResolutionRate: ratio(escalationsResolved, escalationsReceived.length),
      escalationSourceCalls,
    },
    reviewedWorkUnits,
    confidence: sampleConfidenceFor(unitsInvolved.length),
  };
}

/**
 * Builds an effectiveness record for every model that appears in `rows`.
 *
 * `rows` should be the SAME population `run-metrics.mjs` already fetched
 * (benchmark rows already excluded); `events` is the Goal's own
 * `events.jsonl` slice, used only for the structural links `outcome-attribution.mjs`
 * needs (fix events, review decisions, unit completions) — never for timing.
 */
export function computeModelEffectiveness(rows, events, { pricingSnapshotId = DEFAULT_PRICING_SNAPSHOT_ID } = {}) {
  const snapshot = getPricingSnapshot(pricingSnapshotId);
  const units = groupIntoWorkUnits(rows);

  const fixEventsByTarget = indexFixEvents(events);
  const reviewDecisionsByRound = indexReviewDecisions(events);
  const completionsByUnit = indexUnitCompletionEvents(events);

  const attributions = new Map();
  for (const unit of units) {
    const attribution = attributeWorkUnit(unit, { fixEventsByTarget, reviewDecisionsByRound, completionsByUnit });
    attributions.set(`${unit.goalId ?? '-'}::${unit.roundId ?? '-'}::${unit.workUnitId}`, attribution);
  }

  const models = new Set(rows.map((row) => resolveCanonicalModel(row.resolved_model ?? row.requested_model) ?? (row.resolved_model ?? row.requested_model ?? 'UNKNOWN')).filter(Boolean));

  const byModel = {};
  for (const model of models) {
    const modelRows = rows.filter((row) => (resolveCanonicalModel(row.resolved_model ?? row.requested_model) ?? row.resolved_model) === model);
    const unitsInvolved = units.filter((unit) => modelsInvolvedIn(unit).has(model));
    byModel[model] = buildModelRecord(model, { modelRows, allRows: rows, unitsInvolved, attributions, snapshot, pricingSnapshotId });
  }

  return { byModel, unitAttributions: [...attributions.values()] };
}

/**
 * Flags a large imbalance in HOW OFTEN each model's Work Units carry HIGH
 * complexity — the selection-bias warning Goal 014 §25 asks for. A model
 * that only ever receives escalated, already-difficult work will look worse
 * on raw failure/retry rates for reasons that have nothing to do with the
 * model itself.
 *
 * Deliberately coarse (a ratio threshold, not a statistical test): the point
 * is to raise a flag a human should look at, not to compute a p-value.
 */
export function detectCohortImbalance(rows, { threshold = 2 } = {}) {
  const byModel = {};
  for (const row of rows) {
    const model = resolveCanonicalModel(row.resolved_model ?? row.requested_model) ?? row.resolved_model;
    if (!model || !row.complexity) continue;
    byModel[model] = byModel[model] ?? { total: 0, high: 0 };
    byModel[model].total += 1;
    if (row.complexity === 'HIGH') byModel[model].high += 1;
  }

  const shares = Object.entries(byModel)
    .filter(([, v]) => v.total >= 5)
    .map(([model, v]) => ({ model, highComplexityShare: v.high / v.total }));

  if (shares.length < 2) return { flagged: false, reason: 'INSUFFICIENT_DATA', shares };

  const max = Math.max(...shares.map((s) => s.highComplexityShare));
  const min = Math.min(...shares.map((s) => s.highComplexityShare));
  const flagged = min > 0 ? (max / min) >= threshold : max > 0;

  return {
    flagged,
    flag: flagged ? 'MODEL_COHORT_IMBALANCE' : null,
    shares,
    note: flagged
      ? 'These models are not being compared on equivalent workloads — at least one receives disproportionately more HIGH-complexity Work Units.'
      : null,
  };
}

/**
 * Resolution chains: which SEQUENCE of models resolved each Work Unit
 * ("Sonnet only", "Sonnet → Opus"), and what the WHOLE chain cost per unit
 * it actually resolved — Goal 014 §16/§33's explicit ask that a chain's cost
 * compose the full path, not just its last (cheapest-looking) link.
 */
export function computeResolutionChains(rows, { pricingSnapshotId = DEFAULT_PRICING_SNAPSHOT_ID } = {}) {
  const snapshot = getPricingSnapshot(pricingSnapshotId);
  const units = groupIntoWorkUnits(rows);
  const chains = {};

  for (const unit of units) {
    const byAttempt = [...unit.rows].sort((a, b) => n(a.attempt) - n(b.attempt));
    const chainKey = byAttempt
      .map((row) => resolveCanonicalModel(row.resolved_model ?? row.requested_model) ?? (row.resolved_model ?? 'UNKNOWN'))
      .join(' → ');

    const bucket = chains[chainKey] ?? {
      chain: chainKey, units: 0, resolvedUnits: 0, costUsd: null, tokens: 0,
    };
    bucket.units += 1;
    if (unit.finalStatus === 'COMPLETED') bucket.resolvedUnits += 1;
    bucket.tokens += unit.allModelTokens;
    if (snapshot) {
      const priced = unit.rows.map((row) => priceRow(row, snapshot));
      if (priced.every((p) => p.complete)) bucket.costUsd = (bucket.costUsd ?? 0) + priced.reduce((sum, p) => sum + p.costUsd, 0);
    }
    chains[chainKey] = bucket;
  }

  for (const bucket of Object.values(chains)) {
    bucket.costPerResolvedUsd = (bucket.resolvedUnits > 0 && bucket.costUsd !== null) ? bucket.costUsd / bucket.resolvedUnits : null;
    bucket.confidence = sampleConfidenceFor(bucket.units);
  }
  return chains;
}

/**
 * Escalation ROI, grouped by source → destination model: how much EXTRA it
 * cost to escalate, and how many Work Units that extra spend actually
 * recovered (the unit itself reached COMPLETED, not just the escalated call).
 * "Recovered" requires BOTH the escalation call succeeding AND the unit
 * closing successfully — a call that succeeded in a unit that still failed
 * overall did not recover anything.
 */
export function computeEscalationROI(rows, { pricingSnapshotId = DEFAULT_PRICING_SNAPSHOT_ID } = {}) {
  const snapshot = getPricingSnapshot(pricingSnapshotId);
  const units = groupIntoWorkUnits(rows);
  const bySourceDest = {};

  for (const unit of units) {
    for (const row of unit.rows) {
      if (!(row.is_escalation === 1 || row.is_escalation === true)) continue;
      const source = row.escalation_from_model ?? 'UNKNOWN';
      const destination = resolveCanonicalModel(row.resolved_model) ?? row.resolved_model ?? 'UNKNOWN';
      const key = `${source} → ${destination}`;
      const bucket = bySourceDest[key] ?? {
        source, destination, escalations: 0, resolved: 0, additionalCostUsd: null,
      };
      bucket.escalations += 1;
      if (row.status === 'COMPLETED' && unit.finalStatus === 'COMPLETED') bucket.resolved += 1;
      if (snapshot) {
        const priced = priceRow(row, snapshot);
        if (priced.complete) bucket.additionalCostUsd = (bucket.additionalCostUsd ?? 0) + priced.costUsd;
      }
      bySourceDest[key] = bucket;
    }
  }

  for (const bucket of Object.values(bySourceDest)) {
    bucket.escalationResolutionRate = ratio(bucket.resolved, bucket.escalations);
    bucket.incrementalCostPerRecoveredWorkUnit = (bucket.resolved > 0 && bucket.additionalCostUsd !== null)
      ? bucket.additionalCostUsd / bucket.resolved : null;
    bucket.confidence = sampleConfidenceFor(bucket.escalations);
  }
  return bySourceDest;
}

/**
 * Retry ROI: the extra cost of every SAME-model retry attempt (`attempt > 1`,
 * excluding escalation/fallback reroutes — those are counted separately in
 * `computeEscalationROI`), and how many of the retried Work Units it
 * actually recovered.
 */
export function computeRetryROI(rows, { pricingSnapshotId = DEFAULT_PRICING_SNAPSHOT_ID } = {}) {
  const snapshot = getPricingSnapshot(pricingSnapshotId);
  const units = groupIntoWorkUnits(rows);

  let retryUnits = 0;
  let recoveredWorkUnits = 0;
  let retryCostUsd = null;

  for (const unit of units) {
    const retryRows = unit.rows.filter((row) => n(row.attempt) > 1
      && !(row.is_escalation === 1 || row.is_escalation === true));
    if (retryRows.length === 0) continue;
    retryUnits += 1;
    if (unit.finalStatus === 'COMPLETED') recoveredWorkUnits += 1;
    if (snapshot) {
      for (const row of retryRows) {
        const priced = priceRow(row, snapshot);
        if (priced.complete) retryCostUsd = (retryCostUsd ?? 0) + priced.costUsd;
      }
    }
  }

  return {
    retryUnits,
    recoveredWorkUnits,
    retryCostUsd,
    costPerRecoveredWorkUnit: (recoveredWorkUnits > 0 && retryCostUsd !== null) ? retryCostUsd / recoveredWorkUnits : null,
    confidence: sampleConfidenceFor(retryUnits),
  };
}

/**
 * Wasted spend: Work Units whose chain consumed real tokens/cost and still
 * ended FAILED. Closer to genuine waste than "retry overhead" (Goal 011/012)
 * because it excludes chains that eventually recovered.
 */
export function computeTerminalFailureCost(rows, { pricingSnapshotId = DEFAULT_PRICING_SNAPSHOT_ID } = {}) {
  const snapshot = getPricingSnapshot(pricingSnapshotId);
  const units = groupIntoWorkUnits(rows);
  const terminal = units.filter((unit) => unit.finalStatus === 'FAILED');

  let costUsd = null;
  let tokens = 0;
  for (const unit of terminal) {
    tokens += unit.allModelTokens;
    if (snapshot) {
      const priced = unit.rows.map((row) => priceRow(row, snapshot));
      if (priced.every((p) => p.complete)) costUsd = (costUsd ?? 0) + priced.reduce((sum, p) => sum + p.costUsd, 0);
    }
  }

  return { terminalFailureChains: terminal.length, terminalFailureTokens: tokens, terminalFailureCostUsd: costUsd };
}

/**
 * Incremental value of switching FROM `baseline` TO `candidate` (two
 * `buildModelRecord`-shaped records) — the framing Goal 014 §23 asks for
 * instead of a bare cost ratio: "+$0.55/accepted unit, but -8pp repair rate"
 * is answerable; "2x more expensive" alone is not.
 *
 * Never produces a verdict (no "candidate wins"): every field here is
 * `associated with`/`observed among` phrasing material, not causation — see
 * Goal 014 §24.
 */
export function computeIncrementalValue(candidate, baseline) {
  const delta = (a, b) => ((a !== null && a !== undefined && b !== null && b !== undefined) ? a - b : null);
  return {
    candidateModel: candidate.model,
    baselineModel: baseline.model,
    incrementalCostPerAcceptedUsd: delta(candidate.cost.perAcceptedWorkUnitUsd, baseline.cost.perAcceptedWorkUnitUsd),
    incrementalAcceptanceRate: delta(candidate.quality.acceptanceRate, baseline.quality.acceptanceRate),
    // Positive = candidate's retry/repair rate is LOWER (an improvement).
    incrementalRetryReduction: delta(baseline.quality.retryRate, candidate.quality.retryRate),
    incrementalRepairReduction: delta(baseline.quality.repairRate, candidate.quality.repairRate),
  };
}
