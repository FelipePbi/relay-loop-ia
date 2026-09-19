/**
 * Unit tests for the deterministic Work Unit matcher: signature construction
 * and the EXACT/STRONG/WEAK/NONE grading. No embeddings, no LLM, no scoring
 * — every assertion here is field equality a human can verify by eye.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MATCH_TIERS, matchTier, workUnitSignature, riskBucketOf, groupByMatchTier,
} from '../lib/work-unit-matching.mjs';

// --- signature -----------------------------------------------------------

test('a signature reads only known fields, leaving unobservable ones explicitly null', () => {
  const signature = workUnitSignature({ operation: 'work_unit', role: 'developer', complexity: 'HIGH', risk_score: 6 });
  assert.equal(signature.operation, 'work_unit');
  assert.equal(signature.role, 'developer');
  assert.equal(signature.complexity, 'HIGH');
  assert.equal(signature.riskBucket, 'HIGH');
  assert.equal(signature.repositoryArea, null, 'not observable in this ledger today — never approximated');
  assert.equal(signature.workUnitType, null);
});

test('riskBucketOf buckets deterministically and is null for anything unusable', () => {
  assert.equal(riskBucketOf(0), 'LOW');
  assert.equal(riskBucketOf(2), 'LOW');
  assert.equal(riskBucketOf(3), 'MEDIUM');
  assert.equal(riskBucketOf(5), 'MEDIUM');
  assert.equal(riskBucketOf(6), 'HIGH');
  assert.equal(riskBucketOf(null), null);
  assert.equal(riskBucketOf(undefined), null);
  assert.equal(riskBucketOf(NaN), null);
});

// --- match tiers (obrigatory cases 1-4) -------------------------------------

test('1. EXACT match: same operation, complexity, role, and workUnitType', () => {
  const current = { operation: 'work_unit', role: 'developer', complexity: 'HIGH', workUnitType: 'COMPLEX' };
  const candidate = { operation: 'work_unit', role: 'developer', complexity: 'HIGH', workUnitType: 'COMPLEX' };
  assert.equal(matchTier(current, candidate), MATCH_TIERS.EXACT);
});

test('EXACT still applies when workUnitType is unknown on both sides (never invented, never disqualifying)', () => {
  const current = { operation: 'work_unit', role: 'developer', complexity: 'HIGH', workUnitType: null };
  const candidate = { operation: 'work_unit', role: 'developer', complexity: 'HIGH', workUnitType: null };
  assert.equal(matchTier(current, candidate), MATCH_TIERS.EXACT);
});

test('2. STRONG match: same operation and role, compatible (one step apart) complexity', () => {
  const current = { operation: 'review', role: 'tech_lead', complexity: 'HIGH' };
  const candidate = { operation: 'review', role: 'tech_lead', complexity: 'MEDIUM' };
  assert.equal(matchTier(current, candidate), MATCH_TIERS.STRONG);
});

test('3. WEAK match: same operation only — role and complexity differ', () => {
  const current = { operation: 'work_unit', role: 'developer', complexity: 'HIGH' };
  const candidate = { operation: 'work_unit', role: 'tech_lead', complexity: 'LOW' };
  assert.equal(matchTier(current, candidate), MATCH_TIERS.WEAK);
});

test('WEAK also covers complexity two-or-more steps apart, even with the same role', () => {
  const current = { operation: 'work_unit', role: 'developer', complexity: 'LOW' };
  const candidate = { operation: 'work_unit', role: 'developer', complexity: 'HIGH' };
  assert.equal(matchTier(current, candidate), MATCH_TIERS.WEAK, 'LOW to HIGH is two steps — not STRONG');
});

test('4. NONE: different operation — no defensible baseline regardless of everything else matching', () => {
  const current = { operation: 'work_unit', role: 'developer', complexity: 'HIGH', workUnitType: 'COMPLEX' };
  const candidate = { operation: 'review', role: 'developer', complexity: 'HIGH', workUnitType: 'COMPLEX' };
  assert.equal(matchTier(current, candidate), MATCH_TIERS.NONE);
});

test('NONE when either side has no operation at all', () => {
  assert.equal(matchTier({ operation: null }, { operation: 'work_unit' }), MATCH_TIERS.NONE);
  assert.equal(matchTier({ operation: 'work_unit' }, { operation: null }), MATCH_TIERS.NONE);
});

test('an unrecognised complexity value never counts as STRONG-compatible, even with itself', () => {
  const current = { operation: 'work_unit', role: 'developer', complexity: 'GALACTIC' };
  const candidate = { operation: 'work_unit', role: 'developer', complexity: 'GALACTIC' };
  // Equal complexity values that are not in the known order still cannot be
  // proven "one step apart" (STRONG's specific claim) — but two identical
  // UNKNOWN values are, at minimum, EXACT (equal is equal).
  assert.equal(matchTier(current, candidate), MATCH_TIERS.EXACT);
});

// --- population grouping ------------------------------------------------

test('groupByMatchTier buckets a whole population by tier against one current signature', () => {
  const current = { operation: 'work_unit', role: 'developer', complexity: 'HIGH' };
  const population = [
    { operation: 'work_unit', role: 'developer', complexity: 'HIGH' }, // EXACT
    { operation: 'work_unit', role: 'developer', complexity: 'MEDIUM' }, // STRONG
    { operation: 'work_unit', role: 'tech_lead', complexity: 'LOW' }, // WEAK
    { operation: 'review', role: 'developer', complexity: 'HIGH' }, // NONE
  ];
  const groups = groupByMatchTier(current, population, (x) => x);
  assert.equal(groups.EXACT.length, 1);
  assert.equal(groups.STRONG.length, 1);
  assert.equal(groups.WEAK.length, 1);
  assert.equal(groups.NONE.length, 1);
});
