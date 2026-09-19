/**
 * The turn budget: plumbing, classification, and why it ships off.
 *
 * A session's token cost is quadratic in its turns, so one runaway unit is
 * disproportionately expensive — Goal 014's WU-04 spent 234 turns, 59.8M
 * tokens and $15.08 by itself, 41% of that Goal's whole volume. The ceiling
 * exists to bound that.
 *
 * It is OFF by default because of what was measured about hitting it: the CLI
 * ends with `subtype: "error_max_turns"`, `is_error: true`, an empty result and
 * exit 1 — no report and no contract payload — and the capacity policy has no
 * action for "record it as blocked and carry on". These tests pin the pieces
 * that DO exist, including the classification, so that enabling it later is a
 * policy change rather than an archaeology exercise.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildArgs } from '../lib/claude-process.mjs';
import { CAPACITY_REASONS, classifyFailure } from '../lib/capacity-classifier.mjs';
import { CAPACITY_ACTIONS, decideCapacityAction } from '../lib/capacity-policy.mjs';
import { workUnitConfig } from '../lib/work-unit-config.mjs';

const BASE = Object.freeze({
  prompt: 'x', model: 'claude-sonnet-5', sessionId: '11111111-1111-1111-1111-111111111111',
});

const flagValue = (argv, flag) => argv[argv.indexOf(flag) + 1];

// --- the flag ------------------------------------------------------------

test('no budget emits no flag, which is how the CLI default is preserved', () => {
  for (const maxTurns of [null, undefined, 0, -5, 1.5, 'many']) {
    assert.equal(buildArgs({ ...BASE, maxTurns }).includes('--max-turns'), false,
      `maxTurns: ${String(maxTurns)} must not reach the CLI`);
  }
});

test('a budget is passed as --max-turns, once', () => {
  const argv = buildArgs({ ...BASE, maxTurns: 80 });
  assert.equal(flagValue(argv, '--max-turns'), '80');
  assert.equal(argv.filter((a) => a === '--max-turns').length, 1);
});

// --- the classification --------------------------------------------------

test('the CLI names the budget stop in the envelope, so it is never matched out of prose', () => {
  const classified = classifyFailure(
    { error: { code: 'NON_ZERO_EXIT', message: '' } },
    { envelope: { subtype: 'error_max_turns', is_error: true, num_turns: 80, result: '' } },
  );
  assert.equal(classified.reason, CAPACITY_REASONS.TURN_BUDGET_EXHAUSTED);
});

test('a budget stop is NOT a usage limit and NOT an unknown fatal', () => {
  const classified = classifyFailure(
    { error: { code: 'NON_ZERO_EXIT', message: 'Reached maximum number of turns (80)' } },
    { envelope: { subtype: 'error_max_turns', is_error: true } },
  );
  assert.notEqual(classified.reason, CAPACITY_REASONS.USAGE_LIMIT,
    'waiting does not lift a ceiling the operator set');
  assert.notEqual(classified.reason, CAPACITY_REASONS.UNKNOWN_FATAL);
});

test('a real usage limit is still a usage limit, envelope or not', () => {
  const classified = classifyFailure(
    { error: { code: 'NON_ZERO_EXIT', message: "You've reached your Opus limit. Switch to another model." } },
    { envelope: { subtype: 'success' } },
  );
  assert.equal(classified.reason, CAPACITY_REASONS.USAGE_LIMIT);
});

// --- what happens when it is hit ----------------------------------------

test('hitting the budget stops rather than waiting out a limit nothing lifts', () => {
  const decision = decideCapacityAction({
    reason: CAPACITY_REASONS.TURN_BUDGET_EXHAUSTED, attempt: 1, now: Date.now(),
  });
  assert.equal(decision.action, CAPACITY_ACTIONS.HUMAN_REQUIRED);
  assert.equal(decision.retryIntervalMs, null, 'a retry would only spend the same budget again');
});

// --- the default ---------------------------------------------------------

test('the budget is OFF by default, because hitting it currently stops the run', () => {
  assert.equal(workUnitConfig({}).maxTurnsPerUnit, 0);
});

test('an operator can turn it on, and junk never becomes a ceiling', () => {
  assert.equal(workUnitConfig({ IA_LOOP_WU_MAX_TURNS: '80' }).maxTurnsPerUnit, 80);
  assert.equal(workUnitConfig({ IA_LOOP_WU_MAX_TURNS: 'abc' }).maxTurnsPerUnit, 0);
  assert.equal(workUnitConfig({ IA_LOOP_WU_MAX_TURNS: '-1' }).maxTurnsPerUnit, 0);
});
