/**
 * `hydrateTo` — jumping the local state machine to an authoritative outcome
 * without walking (or faking) the intermediate lifecycle.
 *
 * The regression: a resumed `run-goal.mjs` process starts a FRESH local
 * machine at IDLE and walks it to WORKTREE_READY before it ever consults the
 * ledger. When the ledger already shows the Goal ACCEPTED — a review that
 * completed on an earlier attempt, or a prior run of this same process — the
 * old code called `machine.transitionTo(LOOP_STATES.ACCEPTED)` straight from
 * WORKTREE_READY, which the transition graph correctly refuses:
 * WORKTREE_READY only leads to DEVELOPER_QUEUED, CORRECTION_QUEUED or
 * STOPPED. The process crashed with INVALID_TRANSITION on a Goal that had
 * nothing wrong with it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { LOOP_STATES, createLoopStateMachine } from '../lib/loop-state.mjs';

test('the regression itself: WORKTREE_READY -> ACCEPTED is refused by transitionTo', () => {
  const machine = createLoopStateMachine();
  machine.transitionTo(LOOP_STATES.GOAL_READY);
  machine.transitionTo(LOOP_STATES.PREPARING_WORKTREE);
  machine.transitionTo(LOOP_STATES.WORKTREE_READY);

  assert.throws(
    () => machine.transitionTo(LOOP_STATES.ACCEPTED),
    (e) => e.code === 'INVALID_TRANSITION' && e.details.from === 'WORKTREE_READY' && e.details.to === 'ACCEPTED',
  );
  // Unchanged: a refused transition never moves the machine.
  assert.equal(machine.state, LOOP_STATES.WORKTREE_READY);
});

test('hydrateTo reaches ACCEPTED from WORKTREE_READY given a reason and evidence', () => {
  const machine = createLoopStateMachine();
  machine.transitionTo(LOOP_STATES.GOAL_READY);
  machine.transitionTo(LOOP_STATES.PREPARING_WORKTREE);
  machine.transitionTo(LOOP_STATES.WORKTREE_READY);

  const transition = machine.hydrateTo(LOOP_STATES.ACCEPTED, {
    reason: 'AUTHORITATIVE_REVIEW_ACCEPTED',
    evidence: { reviewJobId: '005-r2-tech_lead-8eec8bd3', attemptId: '005-r2-tech_lead-8eec8bd3-a2' },
  });

  assert.equal(machine.state, LOOP_STATES.ACCEPTED);
  assert.equal(transition.hydrated, true);
  assert.equal(transition.from, LOOP_STATES.WORKTREE_READY);
  assert.equal(transition.to, LOOP_STATES.ACCEPTED);
  assert.equal(transition.reason, 'AUTHORITATIVE_REVIEW_ACCEPTED');
  assert.equal(transition.evidence.reviewJobId, '005-r2-tech_lead-8eec8bd3');
});

test('the hydration is visible in history, distinguishable from a real transition', () => {
  const machine = createLoopStateMachine();
  machine.transitionTo(LOOP_STATES.GOAL_READY);
  machine.transitionTo(LOOP_STATES.PREPARING_WORKTREE);
  machine.transitionTo(LOOP_STATES.WORKTREE_READY);
  machine.hydrateTo(LOOP_STATES.ACCEPTED, { reason: 'x', evidence: { proof: true } });

  const last = machine.history.at(-1);
  assert.equal(last.hydrated, true);
  const real = machine.history[0];
  assert.equal(real.hydrated, undefined, 'a real transition is never tagged hydrated');
});

test('hydrateTo refuses without a reason', () => {
  const machine = createLoopStateMachine();
  assert.throws(
    () => machine.hydrateTo(LOOP_STATES.GOAL_READY, { evidence: { x: 1 } }),
    (e) => e.code === 'HYDRATION_EVIDENCE_REQUIRED',
  );
  assert.equal(machine.state, LOOP_STATES.IDLE, 'a refused hydration never moves the machine');
});

test('hydrateTo refuses without evidence', () => {
  const machine = createLoopStateMachine();
  assert.throws(
    () => machine.hydrateTo(LOOP_STATES.GOAL_READY, { reason: 'because' }),
    (e) => e.code === 'HYDRATION_EVIDENCE_REQUIRED',
  );
});

test('hydrateTo refuses an unknown target state, same as transitionTo', () => {
  const machine = createLoopStateMachine();
  assert.throws(
    () => machine.hydrateTo('NOT_A_REAL_STATE', { reason: 'x', evidence: {} }),
    (e) => e.code === 'UNKNOWN_STATE',
  );
});

test('hydrateTo does not weaken transitionTo: every OTHER illegal jump still fails', () => {
  const machine = createLoopStateMachine();
  // IDLE straight to ACCEPTED was never legal and still is not.
  assert.throws(
    () => machine.transitionTo(LOOP_STATES.ACCEPTED),
    (e) => e.code === 'INVALID_TRANSITION',
  );
  // hydrateTo was never called; nothing about calling it elsewhere changes this.
});

test('a normal, non-resumed execution never needs hydration and is untouched', () => {
  const machine = createLoopStateMachine();
  machine.transitionTo(LOOP_STATES.GOAL_READY);
  machine.transitionTo(LOOP_STATES.PREPARING_WORKTREE);
  machine.transitionTo(LOOP_STATES.WORKTREE_READY);
  machine.transitionTo(LOOP_STATES.DEVELOPER_QUEUED);
  machine.transitionTo(LOOP_STATES.DEVELOPER_RUNNING);
  machine.transitionTo(LOOP_STATES.REVIEW_REQUIRED);
  machine.transitionTo(LOOP_STATES.REVIEWER_QUEUED);
  machine.transitionTo(LOOP_STATES.REVIEWER_RUNNING);
  machine.transitionTo(LOOP_STATES.ACCEPTED);

  assert.equal(machine.state, LOOP_STATES.ACCEPTED);
  assert.ok(machine.history.every((t) => t.hydrated === undefined), 'no step of a real run is ever hydrated');
});

test('after a hydration, a legal transitionTo from the new state still works normally', () => {
  const machine = createLoopStateMachine();
  machine.transitionTo(LOOP_STATES.GOAL_READY);
  machine.transitionTo(LOOP_STATES.PREPARING_WORKTREE);
  machine.transitionTo(LOOP_STATES.WORKTREE_READY);
  machine.hydrateTo(LOOP_STATES.HUMAN_REQUIRED, { reason: 'MAX_CORRECTION_ROUNDS_REACHED', evidence: { round: 4 } });
  // HUMAN_REQUIRED -> AWAITING_HUMAN is an ordinary, graph-checked transition.
  machine.transitionTo(LOOP_STATES.AWAITING_HUMAN);
  assert.equal(machine.state, LOOP_STATES.AWAITING_HUMAN);
});
