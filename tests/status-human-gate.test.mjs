/**
 * The status screen must not invent a human gate.
 *
 * Found during the real execution of Goal 007: the round was ACCEPTED, the
 * ledger said CLOSE_GOAL, `humanRequired` and `escalationReason` were both
 * null — and `ia-loop:status` still printed "The runtime still records
 * HUMAN_REQUIRED", telling the operator to reconcile a Goal that was in
 * exactly the state the design intends.
 *
 * The cause was reading the STOP STATE instead of the reason: `AWAITING_HUMAN`
 * is where `run-goal` ends every supervised run, accepted ones included.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { hasStaleHumanGate } from '../run-status.mjs';
import { LOOP_STATES } from '../lib/loop-state.mjs';

const CLOSE = { kind: 'CLOSE_GOAL', goal: '007', round: 3 };
const CORRECTION = { kind: 'CORRECTION', goal: '007', round: 3 };
const HUMAN = { kind: 'HUMAN_REQUIRED', goal: '007', round: 3 };

test('an ACCEPTED Goal awaiting closure is not a stale human gate', () => {
  // The exact runtime Goal 007 was left in after its R3 review.
  const goalExecution = {
    goal: '007',
    round: 3,
    state: LOOP_STATES.AWAITING_HUMAN,
    decision: 'ACCEPTED',
    escalationReason: null,
    humanRequired: null,
  };

  assert.equal(hasStaleHumanGate({ goalExecution, next: CLOSE }), false);
});

test('AWAITING_HUMAN is the ordinary supervised stop, whatever comes next', () => {
  const goalExecution = {
    state: LOOP_STATES.AWAITING_HUMAN,
    decision: 'CHANGES_REQUIRED',
    escalationReason: null,
    humanRequired: null,
  };
  assert.equal(hasStaleHumanGate({ goalExecution, next: CORRECTION }), false);
});

test('a runtime that still names a HUMAN_REQUIRED state IS stale once the ledger moves on', () => {
  assert.equal(
    hasStaleHumanGate({
      goalExecution: { state: LOOP_STATES.HUMAN_REQUIRED, decision: null },
      next: CLOSE,
    }),
    true,
  );
});

test('a HUMAN_REQUIRED decision, or a recorded reason, is also stale', () => {
  assert.equal(hasStaleHumanGate({ goalExecution: { decision: 'HUMAN_REQUIRED' }, next: CORRECTION }), true);
  assert.equal(
    hasStaleHumanGate({ goalExecution: { humanRequired: { reason: 'POLICY_VIOLATION' } }, next: CORRECTION }),
    true,
  );
  assert.equal(hasStaleHumanGate({ goalExecution: { escalationReason: 'POLICY_VIOLATION' }, next: CORRECTION }), true);
});

test('a gate the ledger still agrees with is not reported as stale', () => {
  assert.equal(
    hasStaleHumanGate({ goalExecution: { state: LOOP_STATES.HUMAN_REQUIRED }, next: HUMAN }),
    false,
    'the run really is waiting for a person; repeating it here would be noise, not a correction',
  );
});

test('no dispatch decided yet means nothing to contradict', () => {
  assert.equal(hasStaleHumanGate({ goalExecution: { state: LOOP_STATES.HUMAN_REQUIRED }, next: null }), false);
  assert.equal(hasStaleHumanGate({ goalExecution: null, next: CLOSE }), false);
});
