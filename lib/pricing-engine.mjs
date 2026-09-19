/**
 * IA Loop — pricing engine.
 *
 * One pure function: given token counts, a pricing snapshot and a model, it
 * returns a cost. No I/O, no ledger, no CLI, no `provider_reported_cost_usd`
 * anywhere near it. That column is OBSERVED — what the provider said a call
 * cost. This is CALCULATED — what the SAME token counts cost under a pricing
 * table we control. The two are never substituted for one another; see
 * `lib/cost-baselines.mjs` for where they are compared side by side.
 *
 * Everything here is deterministic arithmetic over numbers already on a
 * ledger row (or an auxiliary-usage entry). No model, no guess, no estimate.
 */

import { resolveCanonicalModel, getPricingSnapshot } from './pricing-registry.mjs';

export const PRICING_STATUS = Object.freeze({
  OK: 'OK',
  UNKNOWN_MODEL: 'UNKNOWN_MODEL',
  SNAPSHOT_MISSING: 'SNAPSHOT_MISSING',
});

/** Token categories priced independently — never collapsed into one average rate. */
const CATEGORIES = Object.freeze(['input', 'output', 'cacheRead', 'cacheCreation']);

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function tokensFor(usage, category) {
  const key = {
    input: 'inputTokens',
    output: 'outputTokens',
    cacheRead: 'cacheReadTokens',
    cacheCreation: 'cacheCreationTokens',
    cacheCreation5m: 'cacheCreationEphemeral5m',
    cacheCreation1h: 'cacheCreationEphemeral1h',
  }[category];
  const value = usage?.[key];
  return isFiniteNumber(value) ? value : 0;
}

/**
 * Whether the cache-creation total can be priced at the finer 5m/1h split
 * instead of the single blended `cacheCreation` rate.
 *
 * Anthropic prices a 1h cache write at roughly double a 5m one, so collapsing
 * both into one rate when the split is KNOWN would misprice every row that
 * used the pricier tier. The split is only trusted when it actually accounts
 * for the whole cacheCreation total — a partial or contradictory split is
 * worth less than the number that is actually known to be complete.
 */
function hasReliableCacheSplit(usage) {
  const five = usage?.cacheCreationEphemeral5m;
  const hour = usage?.cacheCreationEphemeral1h;
  if (!isFiniteNumber(five) || !isFiniteNumber(hour)) return false;
  const total = tokensFor(usage, 'cacheCreation');
  return five + hour === total;
}

/** One category's line item: tokens, the rate applied, and the resulting cost. */
function priceCategory({ tokens, ratePerMillion }) {
  const priced = isFiniteNumber(ratePerMillion);
  return {
    tokens,
    ratePerMillion: priced ? ratePerMillion : null,
    costUsd: priced ? (tokens / 1_000_000) * ratePerMillion : null,
  };
}

/**
 * Prices one model invocation's token counts under one pricing snapshot.
 *
 * `usage` is the same shape a ledger row or an auxiliary-usage entry already
 * carries: `inputTokens`, `outputTokens`, `cacheReadTokens`,
 * `cacheCreationTokens`, and optionally `cacheCreationEphemeral5m` /
 * `cacheCreationEphemeral1h`. `model` is whatever string the ledger recorded
 * (`resolved_model`, an auxiliary entry's `model`) — resolution to a pricing
 * model happens here, never assumed by the caller.
 *
 * Returns `costUsd: null` (never `0`) when the model or the snapshot cannot
 * be resolved — an unpriceable call is not a free one.
 */
export function calculateUsageCost(usage, pricingSnapshotOrId, model) {
  const snapshot = typeof pricingSnapshotOrId === 'string'
    ? getPricingSnapshot(pricingSnapshotOrId)
    : pricingSnapshotOrId;

  if (!snapshot) {
    return {
      costUsd: null, coverage: 0, pricingModel: null,
      pricingSnapshot: typeof pricingSnapshotOrId === 'string' ? pricingSnapshotOrId : (pricingSnapshotOrId?.id ?? null),
      pricingStatus: PRICING_STATUS.SNAPSHOT_MISSING,
      components: {},
    };
  }

  // Resolved against THIS snapshot's own models, never the default registry
  // table — a snapshot is the authority on what it prices, so a caller
  // testing (or a future snapshot defining) a different model set is
  // resolved correctly instead of silently falling back to today's models.
  const canonicalModel = resolveCanonicalModel(model, { models: snapshot.models });
  const prices = canonicalModel ? snapshot.models[canonicalModel] : null;

  if (!canonicalModel || !prices) {
    return {
      costUsd: null, coverage: 0, pricingModel: canonicalModel ?? null, pricingSnapshot: snapshot.id,
      pricingStatus: PRICING_STATUS.UNKNOWN_MODEL,
      components: {},
    };
  }

  const components = {};
  const useCacheSplit = hasReliableCacheSplit(usage) && isFiniteNumber(prices.cacheCreation5m) && isFiniteNumber(prices.cacheCreation1h);

  for (const category of CATEGORIES) {
    if (category === 'cacheCreation' && useCacheSplit) continue;
    components[category] = priceCategory({ tokens: tokensFor(usage, category), ratePerMillion: prices[category] });
  }
  if (useCacheSplit) {
    components.cacheCreation5m = priceCategory({ tokens: tokensFor(usage, 'cacheCreation5m'), ratePerMillion: prices.cacheCreation5m });
    components.cacheCreation1h = priceCategory({ tokens: tokensFor(usage, 'cacheCreation1h'), ratePerMillion: prices.cacheCreation1h });
  }

  // Coverage: of the categories that actually carried tokens, how many had a
  // known price. A category with zero tokens contributes nothing either way,
  // so its price (known or not) cannot make the coverage figure lie.
  const withTokens = Object.values(components).filter((c) => c.tokens > 0);
  const priced = withTokens.filter((c) => c.costUsd !== null);
  const coverage = withTokens.length === 0 ? 1 : priced.length / withTokens.length;

  const costs = Object.values(components).map((c) => c.costUsd).filter((c) => c !== null);
  const costUsd = coverage === 1 ? costs.reduce((sum, c) => sum + c, 0) : (costs.length > 0 ? costs.reduce((sum, c) => sum + c, 0) : null);

  return {
    costUsd,
    coverage,
    pricingModel: canonicalModel,
    pricingSnapshot: snapshot.id,
    pricingStatus: PRICING_STATUS.OK,
    components,
  };
}
