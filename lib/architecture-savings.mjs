/**
 * IA Loop — combining routing and deterministic savings into one total,
 * without double counting.
 *
 * Why the two never overlap, structurally rather than by convention:
 *
 *   ROUTING savings (`lib/cost-baselines.mjs`) is computed ONLY from rows
 *   that exist in `model_usage` — real invocations that really happened.
 *
 *   DETERMINISTIC savings (`lib/deterministic-savings.mjs`) is computed ONLY
 *   for Work Units that made ZERO model calls (Goal 011/012:
 *   `deterministicModelCalls = 0`) and therefore produced NO `model_usage`
 *   row at all.
 *
 * A call is in exactly one of "has a ledger row" or "has zero ledger rows
 * because it ran deterministically" — never both. Summing the two is
 * therefore additive by construction, not by hoping the evidence sets don't
 * collide. Context reduction is measured in characters (Goal 013 §17) and is
 * NEVER folded into the dollar total — see `lib/legacy-baseline.mjs`.
 */

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Composes whatever savings components are actually available into one
 * total. The overall `classification` is the WEAKEST of the components
 * present (any `ESTIMATED` component makes the total `ESTIMATED`) — a total
 * is never more certain than its least certain part.
 *
 * A component that is unavailable (`null`, or its own `status` is not `OK`)
 * is reported as MISSING and excluded from the sum, never treated as zero:
 * "we don't have a deterministic estimate yet" and "deterministic savings
 * are $0" are different claims.
 */
export function combineArchitectureSavings({ routingSavingsUsd, deterministicSavings } = {}) {
  const components = [];
  const missing = [];

  if (isFiniteNumber(routingSavingsUsd)) {
    components.push({
      name: 'routing', classification: 'CALCULATED',
      lower: routingSavingsUsd, central: routingSavingsUsd, upper: routingSavingsUsd,
    });
  } else {
    missing.push('routing');
  }

  if (deterministicSavings?.status === 'OK' && deterministicSavings.totalCostUsdAvoided) {
    const { lower, central, upper } = deterministicSavings.totalCostUsdAvoided;
    if ([lower, central, upper].every(isFiniteNumber)) {
      components.push({ name: 'deterministic', classification: 'ESTIMATED', lower, central, upper });
    } else {
      missing.push('deterministic');
    }
  } else {
    missing.push('deterministic');
  }

  if (components.length === 0) {
    return {
      classification: 'INSUFFICIENT_DATA', status: 'INSUFFICIENT_DATA',
      components: [], missing, totalEstimatedSavingsUsd: null,
    };
  }

  const sum = (key) => components.reduce((total, component) => total + component[key], 0);
  return {
    classification: components.some((component) => component.classification === 'ESTIMATED') ? 'ESTIMATED' : 'CALCULATED',
    status: 'OK',
    components,
    missing,
    totalEstimatedSavingsUsd: { lower: sum('lower'), central: sum('central'), upper: sum('upper') },
    note: 'Routing savings covers REAL invocations; deterministic savings covers COUNTERFACTUAL invocations '
      + 'for Work Units that made zero real model calls. The two evidence sets never overlap by construction — '
      + 'see this module\'s own docstring.',
  };
}

/**
 * Renders a signed dollar amount unambiguously: never lets "$-9.30" (which
 * reads as an oddly-formatted positive number to a skimming reader) stand in
 * for "routing cost $9.30 MORE than the counterfactual". Goal 013 §23.
 */
export function describeSavingsDelta(value, { positiveLabel = 'savings', negativeLabel = 'additional cost' } = {}) {
  if (!isFiniteNumber(value)) return null;
  if (value >= 0) return { amountUsd: value, label: positiveLabel, text: `$${value.toFixed(4)} ${positiveLabel}` };
  return { amountUsd: Math.abs(value), label: negativeLabel, text: `$${Math.abs(value).toFixed(4)} ${negativeLabel}` };
}
