/**
 * IA Loop — comparing Work Units without an LLM.
 *
 * Two things live here: a canonical SIGNATURE for what a Work Unit (or a
 * round-level call treated as one) actually was, and a deterministic MATCHER
 * that grades how comparable two signatures are. Everything is pure field
 * equality and small ordered-list lookups — no embeddings, no similarity
 * score, no model call. See work-unit-signature's own fields for exactly
 * which comparisons are made and why.
 *
 * This is infrastructure for a baseline, not a baseline itself: matching two
 * Work Units does not by itself produce a savings number. See
 * `lib/historical-distributions.mjs` and `lib/deterministic-savings.mjs` for
 * what is built on top of it.
 */

export const MATCH_TIERS = Object.freeze({
  EXACT: 'EXACT',
  STRONG: 'STRONG',
  WEAK: 'WEAK',
  NONE: 'NONE',
});

/** Ordered so "one step apart" has a meaning; unlisted values never compare compatible. */
const COMPLEXITY_ORDER = Object.freeze(['LOW', 'MEDIUM', 'HIGH']);

export function riskBucketOf(riskScore) {
  if (!Number.isFinite(riskScore)) return null;
  if (riskScore <= 2) return 'LOW';
  if (riskScore <= 5) return 'MEDIUM';
  return 'HIGH';
}

/**
 * The canonical comparison key for one Work Unit (or work-unit-shaped call).
 *
 * Built ONLY from fields the ledger (or an events.jsonl join the caller has
 * already done) actually carries — never from free text. A field this
 * repository cannot currently observe (`repositoryArea`: no ledger column or
 * event carries it yet) stays `null` rather than being approximated from
 * something else, so the matcher can tell "unknown" apart from "known and
 * different".
 *
 * `row` is whatever a `model_usage` row or an enriched historical record
 * supplies; `workUnitType`/`deterministicAction` are optional because
 * today's ledger schema does not carry them (they come from `events.jsonl`'s
 * `WORK_UNIT_STARTED`/`WORK_UNIT_DETERMINISTIC_EXECUTED`) — a caller that has
 * joined them in passes them through `row.work_unit_type`/`row.deterministic_action`.
 */
export function workUnitSignature(row = {}) {
  return {
    operation: row.operation ?? null,
    role: row.role ?? null,
    stage: row.stage ?? null,
    complexity: row.complexity ?? null,
    riskBucket: riskBucketOf(row.risk_score ?? row.riskScore),
    modelFamily: row.model_family ?? row.modelFamily ?? null,
    workUnitType: row.work_unit_type ?? row.workUnitType ?? null,
    deterministicAction: row.deterministic_action ?? row.deterministicAction ?? null,
    // Not observable anywhere in this ledger today (see docstring). Declared
    // explicitly rather than omitted, so a future source can populate it
    // without changing this signature's shape.
    repositoryArea: row.repository_area ?? row.repositoryArea ?? null,
  };
}

function fieldEquals(a, b) {
  return a !== null && a !== undefined && a === b;
}

/** Both known and equal, or both genuinely unknown — never "unknown vs known" treated as a match. */
function fieldCompatible(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  return a === b;
}

function complexityCompatible(a, b) {
  if (a === b && a !== null) return true;
  const ia = COMPLEXITY_ORDER.indexOf(a);
  const ib = COMPLEXITY_ORDER.indexOf(b);
  if (ia === -1 || ib === -1) return false;
  return Math.abs(ia - ib) <= 1;
}

/**
 * Grades how defensible it is to use `candidate` as a stand-in for `current`.
 *
 *   EXACT   same operation, complexity, role, and workUnitType (unknown on
 *           both sides counts as equal for workUnitType only — the ledger
 *           does not always carry it, and refusing EXACT purely for that
 *           absence would make EXACT unreachable for most of today's data).
 *   STRONG  same operation and role, and compatible (equal or one step
 *           apart, both known) complexity.
 *   WEAK    same operation only — same functional category, everything else
 *           may differ.
 *   NONE    different (or unknown) operation. No defensible baseline.
 *
 * Deliberately field-equality only: no scoring, no weighting, no learned
 * similarity. A future field can be added to a tier, but the RULE for each
 * tier must stay a fixed, readable list of comparisons.
 */
export function matchTier(current, candidate) {
  if (!current?.operation || !candidate?.operation || current.operation !== candidate.operation) {
    return MATCH_TIERS.NONE;
  }
  const roleEqual = fieldEquals(current.role, candidate.role);
  const complexityEqual = fieldEquals(current.complexity, candidate.complexity);
  const workUnitTypeCompatible = fieldCompatible(current.workUnitType, candidate.workUnitType);

  if (roleEqual && complexityEqual && workUnitTypeCompatible) return MATCH_TIERS.EXACT;
  if (roleEqual && complexityCompatible(current.complexity, candidate.complexity)) return MATCH_TIERS.STRONG;
  return MATCH_TIERS.WEAK;
}

/**
 * Splits a historical population by match tier against `current`, without
 * picking a "best" one — the caller (see `historical-distributions.mjs`)
 * decides how to prefer EXACT over STRONG over WEAK, because that policy
 * belongs with the confidence rule, not with the comparison itself.
 */
export function groupByMatchTier(current, population, signatureOf = workUnitSignature) {
  const groups = { [MATCH_TIERS.EXACT]: [], [MATCH_TIERS.STRONG]: [], [MATCH_TIERS.WEAK]: [], [MATCH_TIERS.NONE]: [] };
  const currentSignature = signatureOf(current);
  for (const candidate of population) {
    groups[matchTier(currentSignature, signatureOf(candidate))].push(candidate);
  }
  return groups;
}
