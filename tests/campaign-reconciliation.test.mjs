/**
 * Campaign position reconciliation — the policy, as a pure function.
 *
 * What this file states: a Goal that closed outside the run is recoverable
 * evidence, and everything short of that proof is refused. Nothing here touches
 * git or disk; the caller proves integration and performs the write.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RECONCILIATION_ACTIONS,
  reconcileCampaignPosition,
} from '../lib/campaign-reconciliation.mjs';

const RUN = Object.freeze({
  autonomousRunId: 'auto-56a536a7',
  currentGoal: '013',
  completedGoals: ['012'],
  migrationAcceptedBaseline: '90ffa2361fd18bb811e85687d06653cc09a0fc76',
});

/** The closure Goal 013 actually left on disk. */
const CLOSURE = Object.freeze({
  goal: '013',
  integratedClosureCommit: '108f88d4463498fc7fed0096955b0a241bcff71b',
  newMigrationBaseline: '108f88d4463498fc7fed0096955b0a241bcff71b',
  nextGoalId: '014',
});

const decide = (over = {}) => reconcileCampaignPosition({
  run: RUN, closure: CLOSURE, closureIntegrated: true, ...over,
});

test('the real stuck state advances: Goal 013 closed outside the run', () => {
  const d = decide();
  assert.equal(d.action, RECONCILIATION_ACTIONS.ADVANCE);
  assert.equal(d.completedGoal, '013');
  assert.equal(d.nextGoal, '014');
  assert.equal(d.baseline, CLOSURE.newMigrationBaseline);
  assert.match(d.evidence, /integrated/);
});

test('an unintegrated closure commit never advances, however complete the record', () => {
  const d = decide({ closureIntegrated: false });
  assert.equal(d.action, RECONCILIATION_ACTIONS.NONE);
  assert.match(d.reason, /not reachable from HEAD/);
});

test('integration is never inferred from the record: the default is refusal', () => {
  const d = reconcileCampaignPosition({ run: RUN, closure: CLOSURE });
  assert.equal(d.action, RECONCILIATION_ACTIONS.NONE);
});

test('a closure for another Goal is the previous receipt, not this Goal closing', () => {
  const d = decide({ closure: { ...CLOSURE, goal: '012', nextGoalId: '013' } });
  assert.equal(d.action, RECONCILIATION_ACTIONS.NONE);
  assert.match(d.reason, /for Goal 012, not 013/);
});

test('a Goal already counted is not counted twice', () => {
  const d = decide({ run: { ...RUN, completedGoals: ['012', '013'] } });
  assert.equal(d.action, RECONCILIATION_ACTIONS.NONE);
  assert.match(d.reason, /already recorded as completed/);
});

test('a missing next Goal stops instead of being read as "migration over"', () => {
  for (const nextGoalId of [null, undefined, '', '   ']) {
    const d = decide({ closure: { ...CLOSURE, nextGoalId } });
    assert.equal(d.action, RECONCILIATION_ACTIONS.NONE, String(nextGoalId));
    assert.match(d.reason, /no next Goal/);
  }
});

test('a closure naming itself as its own successor is refused', () => {
  const d = decide({ closure: { ...CLOSURE, nextGoalId: '013' } });
  assert.equal(d.action, RECONCILIATION_ACTIONS.NONE);
  assert.match(d.reason, /its own successor/);
});

test('a closure without a commit or without a baseline is incomplete, not evidence', () => {
  assert.match(decide({ closure: { ...CLOSURE, integratedClosureCommit: null } }).reason, /no integrated commit/);
  assert.match(decide({ closure: { ...CLOSURE, newMigrationBaseline: '' } }).reason, /no new baseline/);
});

test('no closure and no current Goal both refuse rather than throw', () => {
  assert.equal(decide({ closure: null }).action, RECONCILIATION_ACTIONS.NONE);
  assert.equal(decide({ run: { ...RUN, currentGoal: null } }).action, RECONCILIATION_ACTIONS.NONE);
  assert.equal(reconcileCampaignPosition().action, RECONCILIATION_ACTIONS.NONE);
});

test('a run that never completed anything can still advance', () => {
  const d = decide({ run: { ...RUN, completedGoals: undefined } });
  assert.equal(d.action, RECONCILIATION_ACTIONS.ADVANCE);
});

test('the decision is deterministic and frozen', () => {
  assert.deepEqual(decide(), decide());
  assert.ok(Object.isFrozen(decide()));
});
