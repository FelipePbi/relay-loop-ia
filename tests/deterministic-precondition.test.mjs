/**
 * Unit tests for a deterministic gate whose precondition the harness cannot
 * meet.
 *
 * Written from Goal 014: `validate:integration` exited 2 instantly three times
 * because no `*_TEST_DATABASE_URL` was set, each failure spent a fix unit on a
 * defect no model could repair, and the Goal was reported with "4 FAILED"
 * units while its product code was fine. A gate that never ran and a gate that
 * ran and went red are different facts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runDeterministicAction,
  toDeterministicResult,
} from '../lib/deterministic-executor.mjs';
import { DETERMINISTIC_ACTIONS } from '../lib/deterministic-actions.mjs';

const UNIT = Object.freeze({ id: 'WU-15', type: 'DETERMINISTIC', action: 'validate-integration' });
const WORKTREE = '/fake/worktree';

const FULL_ENV = Object.freeze({
  BFF_TEST_DATABASE_URL: 'postgresql://u@127.0.0.1:5500/bff',
  AI_TEST_DATABASE_URL: 'postgresql://u@127.0.0.1:5500/ai',
  EVOLUTION_TEST_DATABASE_URL: 'postgresql://u@127.0.0.1:5500/evo',
  SCHEDULING_TEST_DATABASE_URL: 'postgresql://u@127.0.0.1:5500/sched',
});

/** Fails the test if anything is spawned; a skipped gate must not run. */
const neverSpawn = () => { throw new Error('nothing may be spawned when a precondition is missing'); };

test('the integration gate declares the databases it cannot run without', () => {
  assert.deepEqual(DETERMINISTIC_ACTIONS['validate-integration'].requiresEnv, [
    'BFF_TEST_DATABASE_URL',
    'AI_TEST_DATABASE_URL',
    'EVOLUTION_TEST_DATABASE_URL',
    'SCHEDULING_TEST_DATABASE_URL',
  ]);
});

test('gates with no declared precondition are unaffected', () => {
  for (const name of ['typecheck', 'lint', 'validate-core', 'validate-ui']) {
    assert.equal(DETERMINISTIC_ACTIONS[name].requiresEnv, undefined, `${name} must not gain a precondition`);
  }
});

test('a missing precondition skips WITHOUT spawning anything', async () => {
  const outcome = await runDeterministicAction({
    unit: UNIT, worktree: WORKTREE, env: {}, spawnFn: neverSpawn,
  });

  assert.equal(outcome.skipped, true);
  assert.equal(outcome.ok, false, 'a skip is not a pass: nothing was verified');
  assert.equal(outcome.exitCode, null, 'there is no exit code, because nothing ran');
  assert.deepEqual(outcome.missingEnv, [
    'BFF_TEST_DATABASE_URL', 'AI_TEST_DATABASE_URL',
    'EVOLUTION_TEST_DATABASE_URL', 'SCHEDULING_TEST_DATABASE_URL',
  ]);
});

test('a partially satisfied precondition still skips, and names only what is missing', async () => {
  const outcome = await runDeterministicAction({
    unit: UNIT, worktree: WORKTREE, spawnFn: neverSpawn,
    env: { ...FULL_ENV, AI_TEST_DATABASE_URL: undefined, SCHEDULING_TEST_DATABASE_URL: '   ' },
  });

  assert.equal(outcome.skipped, true);
  assert.deepEqual(outcome.missingEnv, ['AI_TEST_DATABASE_URL', 'SCHEDULING_TEST_DATABASE_URL'],
    'a blank string is not a database URL');
});

test('a satisfied precondition runs the command normally', async () => {
  let spawned = null;
  const spawnFn = (command, args) => {
    spawned = { command, args };
    return {
      stdout: { on() {} }, stderr: { on() {} },
      on(event, handler) { if (event === 'close') setImmediate(() => handler(0, null)); },
      kill() {},
    };
  };

  const outcome = await runDeterministicAction({
    unit: UNIT, worktree: WORKTREE, env: FULL_ENV, spawnFn, resolveTarget: (argv) => ({ command: argv[0], args: argv.slice(1) }),
  });

  assert.equal(outcome.skipped, undefined);
  assert.equal(outcome.ok, true);
  assert.ok(spawned, 'the command runs once its precondition is met');
});

// --- how the skip is reported ------------------------------------------

test('a skipped gate becomes SKIPPED, never BLOCKED, and carries no failure paths', () => {
  const outcome = {
    action: 'validate-integration', label: 'Integration validation gate',
    argv: ['npm', 'run', 'validate:integration'], durationMs: 0,
    ok: false, skipped: true, missingEnv: ['BFF_TEST_DATABASE_URL'],
    stdout: '', stderr: '',
  };
  const result = toDeterministicResult({ unit: UNIT, outcome, goal: '015', round: 1, jobId: 'j1' });

  assert.equal(result.status, 'SKIPPED');
  assert.equal(result.blockedReason, null, 'nothing blocked; the gate simply could not start');
  assert.deepEqual(result.failurePaths, [], 'no output means no paths to attribute a failure to');
  assert.deepEqual(result.missingEnv, ['BFF_TEST_DATABASE_URL']);
  assert.match(result.summary, /pré-condição ausente/);
  assert.match(result.report, /limitação do harness/, 'the report must not read as a defect of the Goal');
});

test('a gate that really failed is still BLOCKED, with its exit code and paths', () => {
  const outcome = {
    action: 'validate-core', label: 'Core validation gate',
    argv: ['npm', 'run', 'validate:core'], durationMs: 1200,
    ok: false, exitCode: 1, signal: null, error: null,
    stdout: '', stderr: 'FAIL apps/bff/src/app.ts:12',
  };
  const result = toDeterministicResult({ unit: { id: 'WU-14', action: 'validate-core' }, outcome, goal: '015', round: 1, jobId: 'j2' });

  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.failurePaths, ['apps/bff/src/app.ts']);
});
