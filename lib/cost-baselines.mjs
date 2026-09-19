/**
 * IA Loop — CALCULATED cost baselines: ACTUAL routing vs. ALL_OPUS.
 *
 * Everything here is CALCULATED, never OBSERVED and never ESTIMATED (see the
 * three-way classification in the Goal): it reprices token counts the ledger
 * already recorded under an explicit pricing snapshot. Nothing here infers
 * how many tokens a call WOULD have used under a different model — that
 * would require guessing behaviour that never happened, which is exactly the
 * line that makes a number ESTIMATED instead of CALCULATED. ALL_OPUS keeps
 * every observed token count fixed and only swaps which price list prices it.
 *
 * Pure and read-only: takes ledger rows already fetched by the caller
 * (`run-usage.mjs`'s `buildUsageQuery`), a pricing snapshot id, and returns
 * numbers. No SQL, no file I/O, no model call.
 */

import { calculateUsageCost, PRICING_STATUS } from './pricing-engine.mjs';
import { normalizeAuxiliaryUsage, sumDefined } from './auxiliary-usage.mjs';
import {
  getPricingSnapshot, resolveCanonicalModel, DEFAULT_PRICING_SNAPSHOT_ID, ALL_OPUS_CANONICAL_MODEL,
} from './pricing-registry.mjs';

function n(value) {
  return Number.isFinite(value) ? value : 0;
}

function primaryUsageOf(row) {
  return {
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    cacheCreationEphemeral5m: row.cache_creation_ephemeral_5m,
    cacheCreationEphemeral1h: row.cache_creation_ephemeral_1h,
  };
}

/**
 * Every real model invocation ONE ledger row represents: the primary call,
 * plus one per auxiliary model (see auxiliary-usage.mjs). Each is a distinct
 * invocation with its own token counts and, in the ACTUAL baseline, its own
 * routed model — collapsing them would hide exactly the auxiliary spend
 * Goal 011 went to the trouble of keeping separate.
 */
export function invocationsOf(row) {
  const invocations = [{
    kind: 'primary', model: row.resolved_model ?? row.requested_model ?? null, usage: primaryUsageOf(row),
  }];
  const aux = normalizeAuxiliaryUsage(row.auxiliary_usage_json);
  for (const [model, tokens] of Object.entries(aux.byModel)) {
    invocations.push({ kind: 'auxiliary', model, usage: tokens });
  }
  return invocations;
}

/**
 * Prices every invocation on one row under one snapshot.
 *
 * `forceModel`, when given, reprices EVERY invocation as that model instead
 * of the one it actually ran on — the mechanism ALL_OPUS is built from. Token
 * counts are never touched; only which price list answers them changes.
 */
export function priceRow(row, snapshot, { forceModel = null } = {}) {
  const invocations = invocationsOf(row).map((invocation) => ({
    ...invocation,
    pricing: calculateUsageCost(invocation.usage, snapshot, forceModel ?? invocation.model),
  }));
  const priced = invocations.filter((i) => i.pricing.pricingStatus === PRICING_STATUS.OK);
  return {
    invocations,
    costUsd: sumDefined(invocations.map((i) => i.pricing.costUsd)),
    pricedCount: priced.length,
    totalCount: invocations.length,
    complete: priced.length === invocations.length,
  };
}

/**
 * ACTUAL vs. ALL_OPUS, routing savings, and a per-model savings breakdown.
 *
 * `rows` are the SAME `model_usage` rows `run-usage.mjs` would summarise —
 * this function adds no filtering of its own and touches no OBSERVED field
 * except the token counts and the model string every invocation already
 * carries.
 */
export function computeCostBaselines(rows, { pricingSnapshotId = DEFAULT_PRICING_SNAPSHOT_ID } = {}) {
  const snapshot = getPricingSnapshot(pricingSnapshotId);
  if (!snapshot) {
    return {
      pricingSnapshotId, pricingEffectiveDate: null,
      actual: null, allOpus: null,
      routingSavingsUsd: null, routingSavingsPercent: null,
      savingsByModel: {},
      providerVsCalculated: null,
      unknownModels: [],
      integrityFlags: ['PRICING_SNAPSHOT_MISSING'],
    };
  }

  let actualCostUsd = null;
  let allOpusCostUsd = null;
  let actualPriced = 0;
  let actualTotal = 0;
  let allOpusPriced = 0;
  const unknownModels = new Set();
  const savingsByModel = {};

  // For the provider-vs-calculated diagnostic: only rows where BOTH figures
  // are fully known are compared, so the comparison is never apples-to-oranges.
  let providerComparable = null;
  let calculatedComparable = null;

  for (const row of rows) {
    const actual = priceRow(row, snapshot);
    const allOpus = priceRow(row, snapshot, { forceModel: ALL_OPUS_CANONICAL_MODEL });

    actualTotal += actual.totalCount;
    actualPriced += actual.pricedCount;
    allOpusPriced += allOpus.pricedCount;
    for (const invocation of actual.invocations) {
      if (invocation.pricing.pricingStatus === PRICING_STATUS.UNKNOWN_MODEL) unknownModels.add(invocation.model);
    }

    if (actual.costUsd !== null) actualCostUsd = (actualCostUsd ?? 0) + actual.costUsd;
    if (allOpus.costUsd !== null) allOpusCostUsd = (allOpusCostUsd ?? 0) + allOpus.costUsd;

    if (actual.complete && allOpus.complete) {
      const bucket = resolveCanonicalModel(row.resolved_model ?? row.requested_model) ?? 'UNKNOWN';
      savingsByModel[bucket] = (savingsByModel[bucket] ?? 0) + (allOpus.costUsd - actual.costUsd);
    }

    if (actual.complete && Number.isFinite(row.provider_reported_cost_usd)) {
      providerComparable = (providerComparable ?? 0) + row.provider_reported_cost_usd;
      calculatedComparable = (calculatedComparable ?? 0) + actual.costUsd;
    }
  }

  const routingSavingsUsd = (actualCostUsd !== null && allOpusCostUsd !== null) ? allOpusCostUsd - actualCostUsd : null;
  const routingSavingsPercent = (routingSavingsUsd !== null && allOpusCostUsd > 0)
    ? Math.round((routingSavingsUsd / allOpusCostUsd) * 1000) / 10
    : null;

  const providerVsCalculated = (providerComparable !== null && calculatedComparable !== null) ? {
    providerReportedCostUsd: providerComparable,
    calculatedCostUsd: calculatedComparable,
    differenceUsd: providerComparable - calculatedComparable,
    differencePercent: providerComparable !== 0
      ? Math.round(((providerComparable - calculatedComparable) / providerComparable) * 1000) / 10
      : null,
  } : null;

  const flags = [];
  if (unknownModels.size > 0) flags.push('PRICING_MODEL_UNKNOWN');
  if (actualTotal > 0 && actualPriced < actualTotal) flags.push('CALCULATED_COST_INCOMPLETE');
  if (actualTotal > 0 && allOpusPriced < actualTotal) flags.push('COUNTERFACTUAL_INCOMPLETE');

  return {
    pricingSnapshotId: snapshot.id,
    pricingEffectiveDate: snapshot.effectiveFrom,
    actual: {
      classification: 'CALCULATED',
      baseline: 'ACTUAL',
      method: 'Sum calculateUsageCost() over every observed invocation (primary and auxiliary), '
        + 'each priced as the model it actually ran on.',
      costUsd: actualCostUsd,
      pricedInvocations: actualPriced,
      totalInvocations: actualTotal,
    },
    allOpus: {
      classification: 'CALCULATED',
      baseline: 'ALL_OPUS',
      method: `Reprice the SAME observed token categories for every invocation as ${ALL_OPUS_CANONICAL_MODEL}, `
        + 'without changing token quantities.',
      costUsd: allOpusCostUsd,
      pricedInvocations: allOpusPriced,
      totalInvocations: actualTotal,
    },
    routingSavingsUsd,
    routingSavingsPercent,
    savingsByModel,
    providerVsCalculated,
    unknownModels: [...unknownModels],
    integrityFlags: flags,
  };
}

/**
 * Routing savings grouped by an arbitrary dimension (Goal, round, role,
 * operation, stage, Work Unit, model, ...) — the same ACTUAL/ALL_OPUS
 * difference `computeCostBaselines` computes overall, broken out per group.
 *
 * `keyOf(row)` picks the dimension; rows whose key is `null`/`undefined` are
 * grouped under `'UNKNOWN'` rather than dropped, so a savings total by group
 * always accounts for every row that contributed to the overall figure.
 */
export function savingsBreakdown(rows, { pricingSnapshotId = DEFAULT_PRICING_SNAPSHOT_ID } = {}, keyOf) {
  const snapshot = getPricingSnapshot(pricingSnapshotId);
  if (!snapshot) return {};

  const groups = {};
  for (const row of rows) {
    const key = keyOf(row) ?? 'UNKNOWN';
    const actual = priceRow(row, snapshot);
    const allOpus = priceRow(row, snapshot, { forceModel: ALL_OPUS_CANONICAL_MODEL });
    if (!actual.complete || !allOpus.complete) continue;

    const bucket = groups[key] ?? { actualCostUsd: 0, allOpusCostUsd: 0, savingsUsd: 0, rows: 0 };
    bucket.actualCostUsd += actual.costUsd;
    bucket.allOpusCostUsd += allOpus.costUsd;
    bucket.savingsUsd += allOpus.costUsd - actual.costUsd;
    bucket.rows += 1;
    groups[key] = bucket;
  }
  return groups;
}

/**
 * Token-share efficiency, from OBSERVED totals `run-usage.mjs`'s `summarise`
 * already computed. Categories are NOT exclusive partitions (a row can be
 * both FAILED and a retry), so these shares are never asserted to sum to 100%.
 */
export function computeEfficiency(totals) {
  const denominator = totals.allModelTokens;
  const share = (value) => (denominator > 0 ? Math.round((value / denominator) * 1000) / 10 : null);
  return {
    successfulTokenSharePercent: share(totals.completedTokens),
    failedTokenSharePercent: share(totals.failedTokens),
    retryTokenSharePercent: share(totals.retryTokens),
    fallbackTokenSharePercent: share(totals.fallbackTokens),
    escalationTokenSharePercent: share(totals.escalationTokens),
  };
}

/**
 * Per-model routing breakdown — the "Fable analysis" the Goal asks for:
 * for each canonical model actually routed to, how many calls, how many
 * tokens, what it actually cost (CALCULATED, ACTUAL routing), what the SAME
 * tokens would have cost under ALL_OPUS, and the delta between the two.
 *
 * `routingDeltaUsd = allOpusCounterfactualCostUsd - actualCalculatedCostUsd`,
 * matching `computeCostBaselines`'s `savingsByModel` sign convention: positive
 * means routing to this model saved money against Opus, negative means it
 * cost MORE (Fable, in this ledger's calibrated pricing — see Goal 012). A
 * negative delta is preserved exactly as computed, never relabelled or
 * clamped: routing cost more for that model, and the report says so.
 */
export function modelRoutingBreakdown(rows, { pricingSnapshotId = DEFAULT_PRICING_SNAPSHOT_ID } = {}) {
  const snapshot = getPricingSnapshot(pricingSnapshotId);
  if (!snapshot) return {};

  const byModel = {};
  for (const row of rows) {
    const model = resolveCanonicalModel(row.resolved_model ?? row.requested_model) ?? 'UNKNOWN';
    const actual = priceRow(row, snapshot);
    const allOpus = priceRow(row, snapshot, { forceModel: ALL_OPUS_CANONICAL_MODEL });
    if (!actual.complete || !allOpus.complete) continue;

    const bucket = byModel[model] ?? {
      model, calls: 0, tokens: 0, actualCalculatedCostUsd: 0, allOpusCounterfactualCostUsd: 0,
    };
    bucket.calls += 1;
    bucket.tokens += n(row.total_tokens);
    bucket.actualCalculatedCostUsd += actual.costUsd;
    bucket.allOpusCounterfactualCostUsd += allOpus.costUsd;
    byModel[model] = bucket;
  }

  const result = {};
  for (const [model, bucket] of Object.entries(byModel)) {
    result[model] = {
      ...bucket,
      classification: 'CALCULATED',
      routingDeltaUsd: bucket.allOpusCounterfactualCostUsd - bucket.actualCalculatedCostUsd,
    };
  }
  return result;
}
