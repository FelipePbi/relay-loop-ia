/**
 * Unit tests for the pricing engine: `calculateUsageCost` is the ONE function
 * that turns token counts into a CALCULATED cost. Every test here is pure
 * arithmetic against a known snapshot — nothing spawns a process, touches the
 * ledger, or calls a model.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { calculateUsageCost, PRICING_STATUS } from '../lib/pricing-engine.mjs';
import { getPricingSnapshot } from '../lib/pricing-registry.mjs';

const SNAPSHOT = getPricingSnapshot();
const OPUS = 'claude-opus-5';
const opusPrices = SNAPSHOT.models[OPUS];

test('input tokens alone are priced at the model\'s input rate', () => {
  const result = calculateUsageCost({ inputTokens: 2_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, SNAPSHOT, OPUS);
  assert.equal(result.costUsd, 2 * opusPrices.input);
  assert.equal(result.components.input.costUsd, 2 * opusPrices.input);
  assert.equal(result.components.output.costUsd, 0);
});

test('output tokens alone are priced at the model\'s output rate', () => {
  const result = calculateUsageCost({ inputTokens: 0, outputTokens: 500_000, cacheReadTokens: 0, cacheCreationTokens: 0 }, SNAPSHOT, OPUS);
  assert.equal(result.costUsd, 0.5 * opusPrices.output);
});

test('cache read tokens are priced at the (cheaper) cache-read rate, not the input rate', () => {
  const result = calculateUsageCost({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 10_000_000, cacheCreationTokens: 0 }, SNAPSHOT, OPUS);
  assert.equal(result.costUsd, 10 * opusPrices.cacheRead);
  assert.notEqual(opusPrices.cacheRead, opusPrices.input, 'the test is meaningless if the two rates happen to be equal');
});

test('cache creation tokens are priced at the cache-creation rate when no 5m/1h split is known', () => {
  const result = calculateUsageCost({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 4_000_000 }, SNAPSHOT, OPUS);
  assert.equal(result.costUsd, 4 * opusPrices.cacheCreation);
  assert.equal(result.components.cacheCreation5m, undefined, 'no split reported, so no split priced');
});

test('a reliable 5m/1h split reprices cache creation at each tier\'s own rate instead of the blended one', () => {
  const usage = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 3_000_000,
    cacheCreationEphemeral5m: 1_000_000, cacheCreationEphemeral1h: 2_000_000,
  };
  const result = calculateUsageCost(usage, SNAPSHOT, OPUS);
  const expected = 1 * opusPrices.cacheCreation5m + 2 * opusPrices.cacheCreation1h;
  assert.equal(result.costUsd, expected);
  assert.equal(result.components.cacheCreation, undefined, 'the blended category is not ALSO priced — that would double count');
  assert.ok(result.components.cacheCreation1h.costUsd > result.components.cacheCreation5m.costUsd / 2,
    'a 1h write costs more per token than a 5m one');
});

test('an incomplete or contradictory 5m/1h split falls back to the blended rate rather than mispricing it', () => {
  const usage = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 3_000_000,
    cacheCreationEphemeral5m: 1_000_000, cacheCreationEphemeral1h: 500_000, // does not sum to the total
  };
  const result = calculateUsageCost(usage, SNAPSHOT, OPUS);
  assert.equal(result.costUsd, 3 * opusPrices.cacheCreation);
});

test('multiple categories at once sum independently, never as totalTokens times one average rate', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 5_000_000, cacheCreationTokens: 300_000 };
  const result = calculateUsageCost(usage, SNAPSHOT, OPUS);
  const expected = 1 * opusPrices.input + 0.2 * opusPrices.output + 5 * opusPrices.cacheRead + 0.3 * opusPrices.cacheCreation;
  assert.ok(Math.abs(result.costUsd - expected) < 1e-9);
  // Proof that categories are priced separately: an average-rate shortcut
  // (totalTokens * blended rate) would not reproduce this number, because
  // the four rates are all different.
  const totalTokens = 1_000_000 + 200_000 + 5_000_000 + 300_000;
  const naiveAverage = (opusPrices.input + opusPrices.output + opusPrices.cacheRead + opusPrices.cacheCreation) / 4;
  assert.notEqual(result.costUsd, (totalTokens / 1_000_000) * naiveAverage);
});

test('an unknown model prices to null, never $0, and reports UNKNOWN_MODEL', () => {
  const result = calculateUsageCost({ inputTokens: 1000, outputTokens: 500 }, SNAPSHOT, 'gpt-5');
  assert.equal(result.costUsd, null);
  assert.equal(result.coverage, 0);
  assert.equal(result.pricingStatus, PRICING_STATUS.UNKNOWN_MODEL);
  assert.deepEqual(result.components, {});
});

test('a missing snapshot prices to null and reports SNAPSHOT_MISSING, by id or by object', () => {
  const byId = calculateUsageCost({ inputTokens: 100 }, 'anthropic-1999-01', OPUS);
  assert.equal(byId.costUsd, null);
  assert.equal(byId.pricingStatus, PRICING_STATUS.SNAPSHOT_MISSING);
  assert.equal(byId.pricingSnapshot, 'anthropic-1999-01');

  const byNull = calculateUsageCost({ inputTokens: 100 }, null, OPUS);
  assert.equal(byNull.pricingStatus, PRICING_STATUS.SNAPSHOT_MISSING);
});

test('a model alias resolves through the engine exactly as it does through the registry directly', () => {
  const result = calculateUsageCost({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, SNAPSHOT, 'claude-haiku-4-5-20251001');
  assert.equal(result.pricingModel, 'claude-haiku-4-5');
  assert.equal(result.pricingStatus, PRICING_STATUS.OK);
  assert.equal(result.costUsd, SNAPSHOT.models['claude-haiku-4-5'].input);
});

test('zero tokens in every category prices to exactly $0 with full coverage, not null', () => {
  const result = calculateUsageCost({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, SNAPSHOT, OPUS);
  assert.equal(result.costUsd, 0);
  assert.equal(result.coverage, 1);
  assert.equal(result.pricingStatus, PRICING_STATUS.OK);
});

test('missing/undefined token fields are treated as zero tokens, not as missing pricing', () => {
  const result = calculateUsageCost({ inputTokens: 1_000_000 }, SNAPSHOT, OPUS);
  assert.equal(result.costUsd, opusPrices.input);
  assert.equal(result.coverage, 1);
});
