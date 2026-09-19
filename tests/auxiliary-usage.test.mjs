/**
 * Unit tests for auxiliary usage normalisation.
 *
 * `auxiliary_usage_json` is a JSON string on a ledger row, so this is the
 * layer that has to survive whatever actually landed there: nothing, one
 * model, several, or a legacy/corrupt payload — without ever turning an
 * absence into a fabricated zero.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeAuxiliaryUsage, sumDefined } from '../lib/auxiliary-usage.mjs';

function entry(model, overrides = {}) {
  return {
    model,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null,
    ...overrides,
  };
}

// --- absence -----------------------------------------------------------

test('no auxiliary usage reports null totals, not zero ones', () => {
  for (const raw of [null, undefined, '', '   ']) {
    const result = normalizeAuxiliaryUsage(raw);
    assert.deepEqual(result.byModel, {});
    assert.equal(result.totalTokens, null);
    assert.equal(result.costUsd, null);
    assert.deepEqual(result.flags, []);
  }
});

test('an empty array is the same as no auxiliary usage', () => {
  const result = normalizeAuxiliaryUsage('[]');
  assert.equal(result.totalTokens, null);
  assert.equal(result.costUsd, null);
});

// --- one model -----------------------------------------------------------

test('a single auxiliary model is kept with its own breakdown', () => {
  const raw = JSON.stringify([entry('claude-haiku-4-5', {
    inputTokens: 1200, outputTokens: 100, cacheReadTokens: 9000, cacheCreationTokens: 500, costUsd: 0.004,
  })]);
  const result = normalizeAuxiliaryUsage(raw);
  assert.deepEqual(result.flags, []);
  assert.deepEqual(result.byModel['claude-haiku-4-5'], {
    inputTokens: 1200, outputTokens: 100, cacheReadTokens: 9000, cacheCreationTokens: 500,
    totalTokens: 10800, costUsd: 0.004,
  });
  assert.equal(result.totalTokens, 10800);
  assert.equal(result.costUsd, 0.004);
});

test('accepts an already-parsed array, not only a JSON string', () => {
  const result = normalizeAuxiliaryUsage([entry('claude-haiku-4-5', { inputTokens: 10, outputTokens: 5 })]);
  assert.equal(result.totalTokens, 15);
});

test('a model with no cost reported keeps the total null, not zero', () => {
  const result = normalizeAuxiliaryUsage(JSON.stringify([entry('claude-haiku-4-5', { inputTokens: 10 })]));
  assert.equal(result.costUsd, null);
  assert.equal(result.byModel['claude-haiku-4-5'].costUsd, null);
});

// --- multiple models -------------------------------------------------------

test('multiple auxiliary models are kept apart and also summed', () => {
  const raw = JSON.stringify([
    entry('claude-haiku-4-5', { inputTokens: 1000, outputTokens: 200, costUsd: 0.01 }),
    entry('claude-sonnet-5', { inputTokens: 500, outputTokens: 100, cacheReadTokens: 2000, costUsd: 0.02 }),
  ]);
  const result = normalizeAuxiliaryUsage(raw);
  assert.equal(Object.keys(result.byModel).length, 2);
  assert.equal(result.byModel['claude-haiku-4-5'].totalTokens, 1200);
  assert.equal(result.byModel['claude-sonnet-5'].totalTokens, 2600);
  assert.equal(result.totalTokens, 3800);
  assert.equal(result.costUsd, 0.03);
});

test('multiple models where only some report cost: the total is the sum of what is there', () => {
  const raw = JSON.stringify([
    entry('claude-haiku-4-5', { inputTokens: 10, costUsd: 0.01 }),
    entry('claude-sonnet-5', { inputTokens: 20, costUsd: null }),
  ]);
  const result = normalizeAuxiliaryUsage(raw);
  assert.equal(result.costUsd, 0.01, 'the missing cost is skipped, not treated as $0');
});

test('two entries naming the same model within one row are summed, not overwritten', () => {
  const raw = JSON.stringify([
    entry('claude-haiku-4-5', { inputTokens: 10, outputTokens: 1, costUsd: 0.001 }),
    entry('claude-haiku-4-5', { inputTokens: 20, outputTokens: 2, costUsd: 0.002 }),
  ]);
  const result = normalizeAuxiliaryUsage(raw);
  assert.equal(Object.keys(result.byModel).length, 1);
  assert.equal(result.byModel['claude-haiku-4-5'].inputTokens, 30);
  assert.equal(result.byModel['claude-haiku-4-5'].totalTokens, 33);
  assert.equal(result.costUsd, 0.003);
});

// --- invalid / legacy payloads ----------------------------------------------

test('a payload that is not JSON is flagged, not thrown on', () => {
  const result = normalizeAuxiliaryUsage('{not json');
  assert.deepEqual(result.byModel, {});
  assert.equal(result.totalTokens, null);
  assert.deepEqual(result.flags, ['AUXILIARY_USAGE_INVALID']);
});

test('a payload that is not an array is flagged', () => {
  assert.deepEqual(normalizeAuxiliaryUsage(JSON.stringify({ model: 'x' })).flags, ['AUXILIARY_USAGE_INVALID']);
  assert.deepEqual(normalizeAuxiliaryUsage(42).flags, ['AUXILIARY_USAGE_INVALID']);
});

test('an entry with no model name is dropped and flagged, the rest still counts', () => {
  const raw = JSON.stringify([{ inputTokens: 999 }, entry('claude-haiku-4-5', { inputTokens: 10 })]);
  const result = normalizeAuxiliaryUsage(raw);
  assert.deepEqual(Object.keys(result.byModel), ['claude-haiku-4-5']);
  assert.equal(result.totalTokens, 10);
  assert.ok(result.flags.includes('AUXILIARY_USAGE_INVALID'));
});

test('a non-numeric token field is treated as absent (0) and flagged', () => {
  const raw = JSON.stringify([entry('claude-haiku-4-5', { inputTokens: 'lots' })]);
  const result = normalizeAuxiliaryUsage(raw);
  assert.equal(result.byModel['claude-haiku-4-5'].inputTokens, 0);
  assert.ok(result.flags.includes('AUXILIARY_USAGE_INVALID'));
});

test('a negative token count is kept (not clamped) and flagged as an anomaly', () => {
  const raw = JSON.stringify([entry('claude-haiku-4-5', { inputTokens: -5, outputTokens: 10 })]);
  const result = normalizeAuxiliaryUsage(raw);
  assert.equal(result.byModel['claude-haiku-4-5'].inputTokens, -5);
  assert.ok(result.flags.includes('AUXILIARY_NEGATIVE_COUNT'));
});

test('legacy payload missing newer fields (e.g. cache columns) still normalizes', () => {
  const raw = JSON.stringify([{ model: 'claude-fable-5-1', inputTokens: 100, outputTokens: 50 }]);
  const result = normalizeAuxiliaryUsage(raw);
  assert.equal(result.byModel['claude-fable-5-1'].cacheReadTokens, 0);
  assert.equal(result.byModel['claude-fable-5-1'].totalTokens, 150);
  assert.deepEqual(result.flags, []);
});

// --- sumDefined --------------------------------------------------------

test('sumDefined ignores nulls and undefined, and is null when nothing is defined', () => {
  assert.equal(sumDefined([1, null, 2, undefined, 3]), 6);
  assert.equal(sumDefined([null, undefined]), null);
  assert.equal(sumDefined([]), null);
  assert.equal(sumDefined([0]), 0, 'a real zero is kept, not treated as absent');
});
