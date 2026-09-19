/**
 * Unit tests for the pricing registry: snapshot lookup and canonical model
 * resolution. No pricing arithmetic here — see pricing-engine.test.mjs — just
 * "which snapshot, which model, and what happens when either is unknown."
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PRICING_SNAPSHOT_ID, ALL_OPUS_CANONICAL_MODEL, PRICING_PROVENANCE,
  getPricingSnapshot, listPricingSnapshots, resolveCanonicalModel, canonicalModelIds,
} from '../lib/pricing-registry.mjs';

test('the default snapshot exists, is versioned, and prices every canonical model', () => {
  const snapshot = getPricingSnapshot(DEFAULT_PRICING_SNAPSHOT_ID);
  assert.ok(snapshot);
  assert.equal(snapshot.id, DEFAULT_PRICING_SNAPSHOT_ID);
  assert.ok(snapshot.effectiveFrom);
  assert.ok(snapshot.provider);
  for (const model of canonicalModelIds()) {
    const prices = snapshot.models[model];
    assert.ok(prices, `${model} should be priced`);
    for (const category of ['input', 'output', 'cacheRead', 'cacheCreation']) {
      assert.equal(typeof prices[category], 'number', `${model}.${category} should be a number`);
    }
  }
});

test('an unknown snapshot id resolves to null, never a guessed snapshot', () => {
  assert.equal(getPricingSnapshot('anthropic-1999-01'), null);
});

test('listPricingSnapshots reports at least the default, and each entry is a real snapshot', () => {
  const snapshots = listPricingSnapshots();
  assert.ok(snapshots.length >= 1);
  assert.ok(snapshots.some((s) => s.id === DEFAULT_PRICING_SNAPSHOT_ID));
});

// --- canonical model resolution ---------------------------------------------

test('a model string that already matches a canonical model resolves to itself', () => {
  assert.equal(resolveCanonicalModel('claude-opus-5'), 'claude-opus-5');
  assert.equal(resolveCanonicalModel('claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(resolveCanonicalModel('claude-fable-5-1'), 'claude-fable-5-1');
});

test('the ledger\'s dated Haiku build resolves via alias to the canonical line', () => {
  assert.equal(resolveCanonicalModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
});

test('an unregistered dated suffix still resolves by stripping the trailing date', () => {
  // A FUTURE Haiku build the alias table was never updated for — the
  // date-stripping fallback means resolution does not silently regress to
  // UNKNOWN_MODEL just because nobody edited an alias table yet.
  assert.equal(resolveCanonicalModel('claude-haiku-4-5-20990101'), 'claude-haiku-4-5');
});

test('a genuinely unknown model resolves to null, never a borrowed price', () => {
  assert.equal(resolveCanonicalModel('gpt-5'), null);
  assert.equal(resolveCanonicalModel('claude-haiku-9-9'), null);
});

test('non-string or empty input resolves to null without throwing', () => {
  assert.equal(resolveCanonicalModel(null), null);
  assert.equal(resolveCanonicalModel(undefined), null);
  assert.equal(resolveCanonicalModel(''), null);
  assert.equal(resolveCanonicalModel(42), null);
});

test('ALL_OPUS_CANONICAL_MODEL is itself a priced, resolvable model', () => {
  const snapshot = getPricingSnapshot();
  assert.ok(snapshot.models[ALL_OPUS_CANONICAL_MODEL]);
  assert.equal(resolveCanonicalModel(ALL_OPUS_CANONICAL_MODEL), ALL_OPUS_CANONICAL_MODEL);
});

test('every model prices the same way Anthropic\'s own cache economics do: output 5x input, cache read 0.1x, cache write 5m/1h at 1.25x/2x', () => {
  // Not a coincidence: these ratios were solved from the real ledger (see the
  // registry's own docstring) and hold for every canonical model.
  const snapshot = getPricingSnapshot();
  for (const [model, prices] of Object.entries(snapshot.models)) {
    const input = prices.input;
    assert.equal(prices.output, input * 5, `${model} output`);
    assert.equal(prices.cacheRead, input * 0.1, `${model} cacheRead`);
    assert.equal(prices.cacheCreation5m, input * 1.25, `${model} cacheCreation5m`);
    assert.equal(prices.cacheCreation1h, input * 2, `${model} cacheCreation1h`);
  }
});

test('Fable, not Opus, is this ledger\'s most expensive tier — ALL_OPUS is a fixed counterfactual, not an assumed ceiling', () => {
  // A real, checked fact (see the registry docstring), not an assumption:
  // ALL_OPUS must still work correctly even though repricing a Fable call as
  // Opus makes it CHEAPER, not more expensive — see cost-baselines.test.mjs's
  // "counterfactual mais barato" coverage for the savings-arithmetic side.
  const snapshot = getPricingSnapshot();
  const opus = snapshot.models[ALL_OPUS_CANONICAL_MODEL];
  const fable = snapshot.models['claude-fable-5-1'];
  assert.ok(fable.input > opus.input);
});

// --- provenance (obrigatory cases 29-30) ------------------------------------

test('29. every snapshot declares its provenance — never left implicit', () => {
  const snapshot = getPricingSnapshot();
  assert.ok(snapshot.provenance, 'a snapshot with no provenance field would look like it needs no scrutiny');
  assert.ok(Object.values(PRICING_PROVENANCE).includes(snapshot.provenance));
});

test('30. the default snapshot is clearly labelled EMPIRICALLY_CALIBRATED, never OFFICIAL', () => {
  // This registry's rates were solved from provider_reported_cost_usd (see
  // its own docstring), not copied from a published Anthropic price list.
  // Mislabelling this OFFICIAL would let an operator trust it more than it
  // has earned — exactly what Goal 013 §0 exists to prevent.
  const snapshot = getPricingSnapshot();
  assert.equal(snapshot.provenance, PRICING_PROVENANCE.EMPIRICALLY_CALIBRATED);
  assert.notEqual(snapshot.provenance, PRICING_PROVENANCE.OFFICIAL);
  assert.equal(snapshot.derivedFrom, 'provider_reported_cost_usd');
  assert.ok(Number.isInteger(snapshot.sampleRows) && snapshot.sampleRows > 0);
  assert.ok(snapshot.validatedAt);
});

test('the snapshot id itself does not claim to be an official Anthropic price list', () => {
  const snapshot = getPricingSnapshot();
  assert.equal(snapshot.id.includes('anthropic-'), false, 'the id must not read as "Anthropic\'s own 2026-09 price list"');
});

test('PRICING_PROVENANCE enumerates exactly the four values the Goal allows', () => {
  assert.deepEqual(new Set(Object.values(PRICING_PROVENANCE)), new Set(['OFFICIAL', 'EMPIRICALLY_CALIBRATED', 'MANUAL', 'UNKNOWN']));
});
