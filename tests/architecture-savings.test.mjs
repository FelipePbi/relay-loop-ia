/**
 * Unit tests for combining routing and deterministic savings without double
 * counting, and for unambiguous positive/negative savings labelling.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { combineArchitectureSavings, describeSavingsDelta } from '../lib/architecture-savings.mjs';

const OK_DETERMINISTIC = {
  status: 'OK',
  totalCostUsdAvoided: { lower: 2, central: 5, upper: 9 },
};

// --- 16: no double counting --------------------------------------------

test('16. routing and deterministic savings are summed as SEPARATE components, never merged into one figure', () => {
  const result = combineArchitectureSavings({ routingSavingsUsd: 6.61, deterministicSavings: OK_DETERMINISTIC });
  assert.equal(result.components.length, 2);
  assert.deepEqual(result.components.map((c) => c.name).sort(), ['deterministic', 'routing']);
  // The total is the SUM, not one component standing in for both — proof
  // there is no accidental overlap collapsing them into a single number.
  assert.equal(result.totalEstimatedSavingsUsd.central, 6.61 + 5);
});

test('the overall classification is the WEAKEST of the components present', () => {
  const result = combineArchitectureSavings({ routingSavingsUsd: 6.61, deterministicSavings: OK_DETERMINISTIC });
  assert.equal(result.classification, 'ESTIMATED', 'one ESTIMATED component makes the whole total ESTIMATED');
});

test('routing-only (no deterministic estimate available) is CALCULATED, not ESTIMATED', () => {
  const result = combineArchitectureSavings({ routingSavingsUsd: 6.61, deterministicSavings: { status: 'INSUFFICIENT_DATA' } });
  assert.equal(result.classification, 'CALCULATED');
  assert.deepEqual(result.missing, ['deterministic']);
});

test('a missing component is reported as MISSING, never treated as zero savings', () => {
  const result = combineArchitectureSavings({ routingSavingsUsd: null, deterministicSavings: OK_DETERMINISTIC });
  assert.ok(result.missing.includes('routing'));
  assert.equal(result.components.find((c) => c.name === 'routing'), undefined);
});

test('with nothing available at all, the total is INSUFFICIENT_DATA', () => {
  const result = combineArchitectureSavings({ routingSavingsUsd: null, deterministicSavings: { status: 'INSUFFICIENT_DATA' } });
  assert.equal(result.status, 'INSUFFICIENT_DATA');
  assert.equal(result.totalEstimatedSavingsUsd, null);
});

test('the total preserves lower/central/upper as the sum of each component\'s own range', () => {
  const result = combineArchitectureSavings({ routingSavingsUsd: 6.61, deterministicSavings: OK_DETERMINISTIC });
  assert.equal(result.totalEstimatedSavingsUsd.lower, 6.61 + 2);
  assert.equal(result.totalEstimatedSavingsUsd.upper, 6.61 + 9);
});

// --- 22: routing savings negativo, unambiguous labelling --------------------

test('22. a negative routing delta is preserved exactly, never clamped to zero or silently flipped', () => {
  const result = combineArchitectureSavings({ routingSavingsUsd: -9.30, deterministicSavings: { status: 'INSUFFICIENT_DATA' } });
  assert.equal(result.totalEstimatedSavingsUsd.central, -9.30);
});

test('describeSavingsDelta labels a positive value as savings and a negative one as additional cost', () => {
  const positive = describeSavingsDelta(6.61);
  assert.equal(positive.label, 'savings');
  assert.match(positive.text, /savings/);

  const negative = describeSavingsDelta(-9.30);
  assert.equal(negative.label, 'additional cost');
  assert.match(negative.text, /additional cost/);
  assert.ok(negative.amountUsd > 0, 'the magnitude is positive even though the delta was negative');
});

test('describeSavingsDelta is null (not a fabricated $0) for a non-finite value', () => {
  assert.equal(describeSavingsDelta(null), null);
  assert.equal(describeSavingsDelta(undefined), null);
  assert.equal(describeSavingsDelta(NaN), null);
});
