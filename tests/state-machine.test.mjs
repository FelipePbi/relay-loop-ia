/**
 * State machine tests. No model calls are made here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STATES,
  createStateMachine,
  planNextAction,
  stateForDecision,
} from '../lib/state-machine.mjs';

const codeIs = (code) => (error) => error.code === code;

test('the happy path reaches ACCEPTED and stops', () => {
  const machine = createStateMachine();

  machine.transitionTo(STATES.DEVELOPER_RUNNING);
  machine.transitionTo(STATES.REVIEW_REQUIRED);
  machine.transitionTo(STATES.REVIEWER_RUNNING);
  machine.transitionTo(STATES.ACCEPTED);
  machine.transitionTo(STATES.STOP);

  assert.equal(machine.state, STATES.STOP);
  assert.deepEqual(
    machine.history.map((t) => `${t.from} -> ${t.to}`),
    [
      'START -> DEVELOPER_RUNNING',
      'DEVELOPER_RUNNING -> REVIEW_REQUIRED',
      'REVIEW_REQUIRED -> REVIEWER_RUNNING',
      'REVIEWER_RUNNING -> ACCEPTED',
      'ACCEPTED -> STOP',
    ],
  );
});

test('CHANGES_REQUIRED and HUMAN_REQUIRED also terminate in STOP', () => {
  for (const decisionState of [STATES.CHANGES_REQUIRED, STATES.HUMAN_REQUIRED]) {
    const machine = createStateMachine();
    machine.transitionTo(STATES.DEVELOPER_RUNNING);
    machine.transitionTo(STATES.REVIEW_REQUIRED);
    machine.transitionTo(STATES.REVIEWER_RUNNING);
    machine.transitionTo(decisionState);
    machine.transitionTo(STATES.STOP);

    assert.equal(machine.state, STATES.STOP);
  }
});

test('an impossible transition fails closed', () => {
  const machine = createStateMachine();

  // Cannot skip the Developer entirely.
  assert.throws(() => machine.transitionTo(STATES.REVIEWER_RUNNING), codeIs('INVALID_TRANSITION'));
  // Cannot jump straight to a verdict.
  assert.throws(() => machine.transitionTo(STATES.ACCEPTED), codeIs('INVALID_TRANSITION'));
  // The failed attempts left the machine untouched.
  assert.equal(machine.state, STATES.START);
  assert.deepEqual(machine.history, []);
});

test('V1 never loops back to the Developer', () => {
  const machine = createStateMachine();
  machine.transitionTo(STATES.DEVELOPER_RUNNING);
  machine.transitionTo(STATES.REVIEW_REQUIRED);
  machine.transitionTo(STATES.REVIEWER_RUNNING);
  machine.transitionTo(STATES.CHANGES_REQUIRED);

  // The correction loop is out of scope: CHANGES_REQUIRED only leads to STOP.
  assert.equal(machine.canTransitionTo(STATES.DEVELOPER_RUNNING), false);
  assert.throws(() => machine.transitionTo(STATES.DEVELOPER_RUNNING), codeIs('INVALID_TRANSITION'));
});

test('STOP is terminal', () => {
  const machine = createStateMachine();
  machine.transitionTo(STATES.DEVELOPER_RUNNING);
  machine.transitionTo(STATES.REVIEW_REQUIRED);
  machine.transitionTo(STATES.REVIEWER_RUNNING);
  machine.transitionTo(STATES.ACCEPTED);
  machine.transitionTo(STATES.STOP);

  for (const state of Object.values(STATES)) {
    assert.equal(machine.canTransitionTo(state), false);
  }
});

test('an unknown state is rejected', () => {
  const machine = createStateMachine();
  assert.throws(() => machine.transitionTo('DEPLOYING'), codeIs('UNKNOWN_STATE'));
  assert.throws(() => createStateMachine({ initialState: 'NOPE' }), codeIs('UNKNOWN_STATE'));
});

test('history is a copy and cannot be mutated from outside', () => {
  const machine = createStateMachine();
  machine.transitionTo(STATES.DEVELOPER_RUNNING);

  const history = machine.history;
  history.push({ from: 'X', to: 'Y' });
  history[0].from = 'TAMPERED';

  assert.equal(machine.history.length, 1);
  assert.equal(machine.history[0].from, 'START');
});

test('stateForDecision maps every allowed decision', () => {
  assert.equal(stateForDecision('ACCEPTED'), STATES.ACCEPTED);
  assert.equal(stateForDecision('CHANGES_REQUIRED'), STATES.CHANGES_REQUIRED);
  assert.equal(stateForDecision('HUMAN_REQUIRED'), STATES.HUMAN_REQUIRED);
  assert.throws(() => stateForDecision('LGTM'), codeIs('UNSUPPORTED_DECISION'));
});

test('planNextAction defers the correction loop instead of running it', () => {
  assert.deepEqual(planNextAction('STOP').deferred, false);

  const returnToDeveloper = planNextAction('RETURN_TO_DEVELOPER');
  assert.equal(returnToDeveloper.deferred, true);
  assert.match(returnToDeveloper.note, /not implemented in V1/);

  assert.equal(planNextAction('HUMAN_REQUIRED').deferred, true);
  assert.throws(() => planNextAction('MERGE'), codeIs('UNSUPPORTED_NEXT_ACTION'));
});
