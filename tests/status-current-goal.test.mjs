/**
 * Regression test for the Goal the status screen names as current.
 *
 * The real case, from 2026-09-09: autonomous run auto-987b6c55 stopped for a
 * human at Goal 007 (04:42) and was never resumed — the event log carries no
 * AUTONOMOUS_RUN_RESUMED after it. The operator continued supervised: Goal 007
 * was closed at 13:43 and Goal 008 executed to ACCEPTED at 18:11, both of which
 * write `current-goal.json` and `runtime.json`.
 *
 * `run-status` nevertheless read the paused run's pointer unconditionally, so
 * it announced "Current Goal: 007", offered 007's already-completed closure as
 * the next step, and reported Goal 008's live execution state as "historical,
 * not current". Every one of those statements was false, and one of them was
 * acted on.
 *
 * The paused run is never rewritten to say otherwise — see resolveCurrentGoal.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { closureStateOf, resolveCurrentGoal } from '../run-status.mjs';
import { RUN_STATUS } from '../lib/autonomous-state.mjs';

const GOAL_008 = { goalId: '008' };
const RUNTIME_008 = { goal: '008' };

test('a run stopped for a human does not name the current Goal', () => {
  assert.equal(
    resolveCurrentGoal({
      autonomousRun: { status: RUN_STATUS.PAUSED_FOR_HUMAN, currentGoal: '007' },
      goal: GOAL_008,
      runtime: RUNTIME_008,
    }),
    '008',
    'the supervised path moved on; the paused run is history',
  );
});

test('a paused or completed run does not name the current Goal either', () => {
  for (const status of [RUN_STATUS.PAUSED, RUN_STATUS.COMPLETED]) {
    assert.equal(
      resolveCurrentGoal({
        autonomousRun: { status, currentGoal: '007' },
        goal: GOAL_008,
        runtime: RUNTIME_008,
      }),
      '008',
      `a ${status} run drives nothing`,
    );
  }
});

test('a RUNNING run keeps priority, because its pointer may legitimately be ahead', () => {
  // setCurrentGoal(next) fires when planning names the next Goal, before
  // run-goal writes the live pointer for it. Reading the live pointer here
  // would report the Goal that just finished.
  assert.equal(
    resolveCurrentGoal({
      autonomousRun: { status: RUN_STATUS.RUNNING, currentGoal: '009' },
      goal: GOAL_008,
      runtime: RUNTIME_008,
    }),
    '009',
  );
});

test('the live pointer wins over a stale runtime, and runtime is the last resort', () => {
  assert.equal(resolveCurrentGoal({ goal: GOAL_008, runtime: { goal: '007' } }), '008');
  assert.equal(resolveCurrentGoal({ runtime: RUNTIME_008 }), '008');
});

test('with no live pointer at all, a stopped run is still better than nothing', () => {
  assert.equal(
    resolveCurrentGoal({ autonomousRun: { status: RUN_STATUS.PAUSED_FOR_HUMAN, currentGoal: '007' } }),
    '007',
  );
  assert.equal(resolveCurrentGoal({}), null);
  assert.equal(resolveCurrentGoal(), null);
});

test('a RUNNING run with no Goal recorded falls through instead of erasing the Goal', () => {
  assert.equal(
    resolveCurrentGoal({
      autonomousRun: { status: RUN_STATUS.RUNNING, currentGoal: null },
      goal: GOAL_008,
    }),
    '008',
  );
});


// --- a closed Goal is not the Goal to work on ------------------------------

/**
 * The second half of the same confusion. `current-goal.json` is written when a
 * Goal STARTS and never rewritten at closure, and the round ledger ends at
 * "review ACCEPTED -> CLOSE_GOAL" knowing nothing about the closure that ran.
 * So a Goal that was closed, committed, baselined and succeeded by the next one
 * was still advertised as needing its closure.
 */
const CLOSED_008 = Object.freeze({
  closure: {
    goal: '008',
    integratedClosureCommit: '1dc170eb8b04d6ee8a706dca089cfe4538175125',
    newMigrationBaseline: '1dc170eb8b04d6ee8a706dca089cfe4538175125',
    nextGoalId: '009',
    nextGoalTitle: 'Disponibilidade, compromissos pessoais e recorrência',
    nextGoalDeveloperProfile: 'OPUS_MEDIUM',
  },
});

test('a Goal whose closure ran is reported as closed, naming the next Goal', () => {
  const closure = closureStateOf(CLOSED_008);
  assert.equal(closure.closed, true);
  assert.equal(closure.nextGoalId, '009');
  assert.equal(closure.nextDeveloperProfile, 'OPUS_MEDIUM');
  assert.equal(closure.baseline, '1dc170eb8b04d6ee8a706dca089cfe4538175125');
});

test('documentation without planning is not a closed Goal', () => {
  // Closure documentation published, but the next Goal was never written: the
  // Goal is mid-closure, and claiming otherwise would skip the planning step.
  assert.equal(closureStateOf({
    closure: { closureDocsJobId: 'j1', closureDocs: ['a.md'], integratedClosureCommit: 'abc' },
  }).closed, false);
});

test('planning without an integrated commit is not a closed Goal either', () => {
  assert.equal(closureStateOf({ closure: { nextGoalId: '009' } }).closed, false);
});

test('a Goal that never reached closure reports nothing', () => {
  assert.equal(closureStateOf({ closure: null }).closed, false);
  assert.equal(closureStateOf({}).closed, false);
  assert.equal(closureStateOf(null).closed, false);
  assert.equal(closureStateOf(undefined).nextGoalId, null);
});
