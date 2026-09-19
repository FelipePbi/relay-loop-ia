/**
 * IA Loop — pricing registry.
 *
 * A versioned table of USD-per-million-token prices, one snapshot per pricing
 * era. Nothing here is derived from the ledger: these are prices we declare,
 * not numbers inferred from what a call happened to cost. `lib/pricing-engine.mjs`
 * is the only consumer that turns a price into a cost.
 *
 * A snapshot is immutable once published. A price change is a NEW snapshot
 * with its own id and `effectiveFrom` date — never an edit to an existing one,
 * so a report generated last month can still be reproduced exactly as it was.
 */

/**
 * Canonical pricing models. Keys are the model identity the registry prices;
 * every OBSERVED model string in the ledger resolves to one of these (or to
 * none, which is `UNKNOWN_MODEL` — never a guessed price).
 *
 * Rates are USD per 1,000,000 tokens, split by category exactly as the Goal
 * requires: `input`, `output`, `cacheRead`, `cacheCreation` (blended), and the
 * finer `cacheCreation5m`/`cacheCreation1h` split used when the ledger row
 * actually carries that breakdown (see `hasReliableCacheSplit` in
 * pricing-engine.mjs). `cacheCreation` stays as the blended fallback for rows
 * that only ever have the total.
 *
 * These four rate cards are not a guess: they were reverse-engineered from the
 * real `usage.sqlite` ledger (Goals 008-010) during this Goal's validation —
 * see the "Validação real" section of the README — by solving
 * `provider_reported_cost_usd = Σ(category_tokens × category_rate)` against
 * every row whose `cache_creation_ephemeral_5m/1h` split fully accounts for
 * `cache_creation_tokens`. Every model in the ledger follows the SAME ratio
 * (output = 5× input, cacheRead = 0.1× input, cacheCreation5m = 1.25× input,
 * cacheCreation1h = 2× input) with a per-model input rate that reproduces the
 * CLI's own reported cost EXACTLY (to floating-point rounding) on 35 of 35
 * clean-split rows checked. Using the true rate card here is not circular
 * with `providerReportedCostUsd` staying OBSERVED and this staying
 * CALCULATED: the engine never reads the provider's figure, so any row priced
 * from an incomplete cache split, or under the ALL_OPUS counterfactual, still
 * diverges from it for real, checkable reasons.
 */
const ANTHROPIC_2026_09_MODELS = Object.freeze({
  'claude-opus-5': Object.freeze({
    input: 5, output: 25, cacheRead: 0.5, cacheCreation: 6.25, cacheCreation5m: 6.25, cacheCreation1h: 10,
  }),
  'claude-sonnet-5': Object.freeze({
    input: 2, output: 10, cacheRead: 0.2, cacheCreation: 2.5, cacheCreation5m: 2.5, cacheCreation1h: 4,
  }),
  'claude-haiku-4-5': Object.freeze({
    input: 1, output: 5, cacheRead: 0.1, cacheCreation: 1.25, cacheCreation5m: 1.25, cacheCreation1h: 2,
  }),
  // The ledger's most expensive model per token — a "deep review/planning"
  // specialist tier, not a cheaper alternative to Opus. ALL_OPUS is therefore
  // NOT a universal expense ceiling: a Fable-routed call recalculated as
  // Opus can show NEGATIVE routing "savings" (switching TO Opus would have
  // cost less), and that is reported as such, never clamped to zero.
  'claude-fable-5-1': Object.freeze({
    input: 10, output: 50, cacheRead: 1, cacheCreation: 12.5, cacheCreation5m: 12.5, cacheCreation1h: 20,
  }),
});

/**
 * How a snapshot's rates came to exist. Never decorative: a report MUST show
 * this, because a rate an operator can mistake for the provider's own
 * published list is a rate that gets trusted more than it has earned.
 */
export const PRICING_PROVENANCE = Object.freeze({
  /** Copied from the provider's own published price list. */
  OFFICIAL: 'OFFICIAL',
  /** Solved from OBSERVED cost/token data — see `derivedFrom` and `sampleRows`. */
  EMPIRICALLY_CALIBRATED: 'EMPIRICALLY_CALIBRATED',
  /** Entered by a person from some source this registry does not track. */
  MANUAL: 'MANUAL',
  /** The snapshot predates provenance tracking, or its origin was lost. */
  UNKNOWN: 'UNKNOWN',
});

/**
 * Published snapshots, keyed by id. Add a new key for a new era; never mutate
 * an existing one — see the module docstring.
 */
const SNAPSHOTS = Object.freeze({
  'claude-ledger-calibrated-2026-09': Object.freeze({
    id: 'claude-ledger-calibrated-2026-09',
    provider: 'anthropic',
    effectiveFrom: '2026-09-01',
    models: ANTHROPIC_2026_09_MODELS,
    // This is NOT Anthropic's published price list — see the docstring above
    // the rates themselves. It was solved from this repo's own
    // `provider_reported_cost_usd`, and MUST never be presented as an
    // official rate card. The id says "calibrated", not "official", for the
    // same reason.
    provenance: PRICING_PROVENANCE.EMPIRICALLY_CALIBRATED,
    derivedFrom: 'provider_reported_cost_usd',
    sampleRows: 35,
    validatedAt: '2026-09-12',
  }),
});

export const DEFAULT_PRICING_SNAPSHOT_ID = 'claude-ledger-calibrated-2026-09';

/** The model the ALL_OPUS counterfactual reprices every observed call as. */
export const ALL_OPUS_CANONICAL_MODEL = 'claude-opus-5';

export function getPricingSnapshot(id = DEFAULT_PRICING_SNAPSHOT_ID) {
  return SNAPSHOTS[id] ?? null;
}

export function listPricingSnapshots() {
  return Object.values(SNAPSHOTS);
}

/**
 * Aliases from an OBSERVED ledger model string to a canonical pricing model.
 *
 * The ledger records exactly what the CLI reported (`resolved_model`, an
 * auxiliary entry's `model`), which can carry a dated build suffix the pricing
 * registry deliberately does not: a snapshot prices "the Haiku 4.5 line", not
 * one specific build of it. Add an entry here for any alias that is NOT simply
 * "strip a trailing date", which `resolveCanonicalModel` already handles.
 */
const MODEL_ALIASES = Object.freeze({
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5',
});

const TRAILING_DATE_SUFFIX = /-\d{8}$/;

/**
 * Resolves whatever model string the ledger recorded to a canonical pricing
 * model, or `null` when none of this registry's models is a plausible match.
 *
 * `null` is a real answer, not a bug: a model this registry has never priced
 * must produce `UNKNOWN_MODEL` in the engine, never a borrowed or averaged
 * price.
 */
export function resolveCanonicalModel(observedModel, { models = ANTHROPIC_2026_09_MODELS } = {}) {
  if (typeof observedModel !== 'string' || observedModel === '') return null;
  if (models[observedModel]) return observedModel;
  if (MODEL_ALIASES[observedModel] && models[MODEL_ALIASES[observedModel]]) return MODEL_ALIASES[observedModel];
  const stripped = observedModel.replace(TRAILING_DATE_SUFFIX, '');
  if (stripped !== observedModel && models[stripped]) return stripped;
  return null;
}

export function canonicalModelIds({ models = ANTHROPIC_2026_09_MODELS } = {}) {
  return Object.keys(models);
}
