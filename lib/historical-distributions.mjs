/**
 * IA Loop — historical distributions and the confidence rule.
 *
 * Turns a population of PAST `model_usage` rows into per-Work-Unit
 * aggregates, then into percentile distributions a baseline can be read off.
 * Confidence is derived from the match tier (`lib/work-unit-matching.mjs`)
 * and the sample size by ONE centralised, deterministic rule — never judged
 * per call site, and never by a model.
 */

import { priceRow } from './cost-baselines.mjs';
import { normalizeAuxiliaryUsage } from './auxiliary-usage.mjs';
import { DEFAULT_PRICING_SNAPSHOT_ID, getPricingSnapshot } from './pricing-registry.mjs';
import { MATCH_TIERS, matchTier, workUnitSignature } from './work-unit-matching.mjs';

function n(value) {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Groups ledger rows into one aggregate per logical Work Unit
 * (`goal::round::workUnitId`). A unit retried or escalated leaves several
 * rows; this is what makes "how many model calls did a unit like this take"
 * answerable as a per-unit count instead of a per-row one.
 */
export function groupIntoWorkUnits(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.work_unit_id) continue;
    const key = `${row.goal_id ?? '-'}::${row.round_id ?? '-'}::${row.work_unit_id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        workUnitId: row.work_unit_id,
        goalId: row.goal_id ?? null,
        roundId: row.round_id ?? null,
        operation: row.operation ?? null,
        role: row.role ?? null,
        stage: row.stage ?? null,
        complexity: row.complexity ?? null,
        risk_score: row.risk_score ?? null,
        model_family: row.model_family ?? null,
        rows: [],
      });
    }
    groups.get(key).rows.push(row);
  }

  return [...groups.values()].map((unit) => {
    const auxTotals = unit.rows.map((row) => normalizeAuxiliaryUsage(row.auxiliary_usage_json).totalTokens ?? 0);
    // The unit's own outcome is its MOST RECENT attempt's status, never any
    // one row's — a unit that failed once and succeeded on retry is a
    // successful unit, and a row-level scan that stopped at the first
    // attempt would call it failed.
    const byAttempt = [...unit.rows].sort((a, b) => n(a.attempt) - n(b.attempt));
    const finalStatus = byAttempt[byAttempt.length - 1]?.status ?? null;
    return {
      ...unit,
      finalStatus,
      modelCalls: unit.rows.length,
      inputTokens: unit.rows.reduce((sum, row) => sum + n(row.input_tokens), 0),
      outputTokens: unit.rows.reduce((sum, row) => sum + n(row.output_tokens), 0),
      cacheReadTokens: unit.rows.reduce((sum, row) => sum + n(row.cache_read_tokens), 0),
      cacheCreationTokens: unit.rows.reduce((sum, row) => sum + n(row.cache_creation_tokens), 0),
      allModelTokens: unit.rows.reduce((sum, row) => sum + n(row.total_tokens), 0) + auxTotals.reduce((sum, v) => sum + v, 0),
      durationMs: unit.rows.reduce((sum, row) => sum + n(row.duration_ms), 0),
    };
  });
}

/** p25/p50/p75/mean/min/max over a numeric sample, or null when empty — never a fabricated zero. */
export function percentileStats(values) {
  const present = values.filter((value) => Number.isFinite(value));
  if (present.length === 0) return null;
  const sorted = [...present].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return {
    count: sorted.length,
    p25: at(0.25),
    p50: at(0.5),
    p75: at(0.75),
    mean: sorted.reduce((sum, v) => sum + v, 0) / sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

const DISTRIBUTION_METRICS = Object.freeze([
  'modelCalls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'allModelTokens', 'durationMs',
]);

/**
 * Every distribution the Goal asks for, over one population of Work Unit
 * aggregates (see `groupIntoWorkUnits`). `calculatedCostUsd` is priced under
 * `pricingSnapshotId` using each unit's OWN routed model (its ACTUAL cost),
 * not a counterfactual — units a snapshot cannot price are simply excluded
 * from that one distribution, never zeroed.
 */
export function distributionsFor(units, { pricingSnapshotId = DEFAULT_PRICING_SNAPSHOT_ID } = {}) {
  const snapshot = getPricingSnapshot(pricingSnapshotId);
  const distributions = {};
  for (const metric of DISTRIBUTION_METRICS) {
    distributions[metric] = percentileStats(units.map((unit) => unit[metric]));
  }

  // Cost is priced PER UNIT (summing that unit's own rows), not per row —
  // the distribution answers "what does a unit like this typically cost".
  const unitCosts = snapshot
    ? units.map((unit) => {
      if (!Array.isArray(unit.rows)) return null;
      const priced = unit.rows.map((row) => priceRow(row, snapshot));
      return priced.every((p) => p.complete) ? priced.reduce((sum, p) => sum + p.costUsd, 0) : null;
    }).filter((cost) => cost !== null)
    : [];
  distributions.calculatedCostUsd = percentileStats(unitCosts);
  return distributions;
}

/**
 * The ONE confidence rule, centralised: how much a historical distribution
 * should be trusted, from the match tier it came from and how many units
 * support it. Never judged by a model, never inlined at a call site.
 */
export function confidenceFor(tier, sampleSize) {
  if (tier === MATCH_TIERS.NONE || !Number.isFinite(sampleSize) || sampleSize === 0) return 'INSUFFICIENT_DATA';
  if (tier === MATCH_TIERS.EXACT && sampleSize >= 20) return 'HIGH';
  if ((tier === MATCH_TIERS.EXACT || tier === MATCH_TIERS.STRONG) && sampleSize >= 5) return 'MEDIUM';
  return 'LOW';
}

/**
 * Finds the best defensible historical baseline for `current` inside
 * `population`, preferring EXACT over STRONG over WEAK — the first tier with
 * at least one match wins, rather than pooling every tier together and
 * diluting a strong match with weak ones.
 *
 * `INSUFFICIENT_DATA` is a normal, expected result, not a failure: a Work
 * Unit with no comparable history at any tier gets it instead of a baseline
 * built from nothing.
 */
export function findHistoricalBaseline(current, population, { pricingSnapshotId = DEFAULT_PRICING_SNAPSHOT_ID } = {}) {
  const currentSignature = workUnitSignature(current);
  const withTiers = population.map((unit) => ({ unit, tier: matchTier(currentSignature, workUnitSignature(unit)) }));

  for (const tier of [MATCH_TIERS.EXACT, MATCH_TIERS.STRONG, MATCH_TIERS.WEAK]) {
    const matched = withTiers.filter((entry) => entry.tier === tier).map((entry) => entry.unit);
    if (matched.length === 0) continue;
    return {
      status: 'OK',
      matchTier: tier,
      sampleSize: matched.length,
      confidence: confidenceFor(tier, matched.length),
      sampleWorkUnitIds: matched.map((unit) => unit.workUnitId ?? unit.key ?? null),
      distributions: distributionsFor(matched, { pricingSnapshotId }),
    };
  }

  return { status: 'INSUFFICIENT_DATA', matchTier: MATCH_TIERS.NONE, sampleSize: 0, confidence: 'INSUFFICIENT_DATA', sampleWorkUnitIds: [], distributions: null };
}
