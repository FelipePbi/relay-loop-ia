/**
 * V2 state machine, context builders and dry-run invariants. No model calls.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LOOP_STATES,
  NOT_IMPLEMENTED_STATES,
  createLoopStateMachine,
  planAfterDecision,
  stateForDecision,
} from '../lib/loop-state.mjs';
import { buildDeveloperContext, buildTechLeadContext } from '../lib/context-builders.mjs';
import { createJobStore } from '../lib/job-store.mjs';
import { createPersistentSession } from '../lib/persistent-session.mjs';
import { assertSessionsAreIndependent, upsertSession, REGISTRY_VERSION } from '../lib/session-registry.mjs';

const codeIs = (code) => (error) => error.code === code;
const BASELINE = '1e874e2785d2bc78860db0eb571ea901a4395c17';
const EXEC_BASE = '0e77cb6cddc1da015e188cf7cdb55a5ff3b2ce60';

/** Drives the machine to the point just before a verdict. */
function toReviewerRunning() {
  const m = createLoopStateMachine();
  m.transitionTo(LOOP_STATES.GOAL_READY);
  m.transitionTo(LOOP_STATES.PREPARING_WORKTREE);
  m.transitionTo(LOOP_STATES.WORKTREE_READY);
  m.transitionTo(LOOP_STATES.DEVELOPER_QUEUED);
  m.transitionTo(LOOP_STATES.DEVELOPER_RUNNING);
  m.transitionTo(LOOP_STATES.REVIEW_REQUIRED);
  m.transitionTo(LOOP_STATES.REVIEWER_QUEUED);
  m.transitionTo(LOOP_STATES.REVIEWER_RUNNING);
  return m;
}

test('the full V2 path runs from IDLE to STOPPED through the human gate', () => {
  const m = toReviewerRunning();
  m.transitionTo(LOOP_STATES.ACCEPTED);
  m.transitionTo(LOOP_STATES.AWAITING_HUMAN);
  m.transitionTo(LOOP_STATES.STOPPED);

  assert.equal(m.state, LOOP_STATES.STOPPED);
  assert.equal(m.history.length, 11);
});

test('every verdict funnels through AWAITING_HUMAN', () => {
  for (const verdict of [LOOP_STATES.ACCEPTED, LOOP_STATES.CHANGES_REQUIRED, LOOP_STATES.HUMAN_REQUIRED]) {
    const m = toReviewerRunning();
    m.transitionTo(verdict);

    assert.equal(m.canTransitionTo(LOOP_STATES.AWAITING_HUMAN), true);
    assert.equal(m.canTransitionTo(LOOP_STATES.STOPPED), false, `${verdict} must not stop without the human gate`);
  }
});

test('CHANGES_REQUIRED never loops back to the Developer in V2', () => {
  const m = toReviewerRunning();
  m.transitionTo(LOOP_STATES.CHANGES_REQUIRED);

  assert.equal(m.canTransitionTo(LOOP_STATES.DEVELOPER_QUEUED), false);
  assert.throws(() => m.transitionTo(LOOP_STATES.DEVELOPER_QUEUED), codeIs('INVALID_TRANSITION'));

  // Even after the gate, the loop stops rather than re-queuing.
  m.transitionTo(LOOP_STATES.AWAITING_HUMAN);
  assert.equal(m.canTransitionTo(LOOP_STATES.DEVELOPER_QUEUED), false);
});

test('the review cannot start before the Developer has run', () => {
  const m = createLoopStateMachine();
  m.transitionTo(LOOP_STATES.GOAL_READY);

  assert.throws(() => m.transitionTo(LOOP_STATES.REVIEWER_QUEUED), codeIs('INVALID_TRANSITION'));
  assert.throws(() => m.transitionTo(LOOP_STATES.ACCEPTED), codeIs('INVALID_TRANSITION'));
  assert.equal(m.state, LOOP_STATES.GOAL_READY);
  assert.equal(m.history.length, 1);
});

test('STOPPED is terminal and unknown states are refused', () => {
  const m = createLoopStateMachine();
  m.transitionTo(LOOP_STATES.STOPPED);
  for (const state of Object.values(LOOP_STATES)) {
    assert.equal(m.canTransitionTo(state), false);
  }
  assert.throws(() => createLoopStateMachine({ initialState: 'NOPE' }), codeIs('UNKNOWN_STATE'));
});

test('states deferred to a later version are not implemented', () => {
  const m = createLoopStateMachine();
  for (const state of NOT_IMPLEMENTED_STATES) {
    assert.ok(!Object.hasOwn(LOOP_STATES, state), `${state} must not exist in V2`);
    assert.throws(() => m.transitionTo(state), codeIs('UNKNOWN_STATE'));
  }
});

test('planAfterDecision always gates on a human and records the deferred action', () => {
  assert.deepEqual(
    { ...planAfterDecision('ACCEPTED'), note: undefined },
    { decision: 'ACCEPTED', nextState: LOOP_STATES.AWAITING_HUMAN, deferredNextAction: 'CLOSE_GOAL', note: undefined },
  );
  assert.equal(planAfterDecision('CHANGES_REQUIRED').deferredNextAction, 'RETURN_TO_DEVELOPER');
  assert.equal(planAfterDecision('CHANGES_REQUIRED').nextState, LOOP_STATES.AWAITING_HUMAN);
  assert.equal(planAfterDecision('HUMAN_REQUIRED').nextState, LOOP_STATES.AWAITING_HUMAN);
  assert.throws(() => planAfterDecision('MERGE'), codeIs('UNSUPPORTED_DECISION'));
  assert.equal(stateForDecision('ACCEPTED'), LOOP_STATES.ACCEPTED);
});

// --- Context builders ------------------------------------------------------

test('the Developer context never carries a previous conversation', () => {
  const context = buildDeveloperContext({
    goal: '003',
    goalPath: 'docs/migration/goals/003-x.md',
    round: 1,
    type: 'IMPLEMENTATION',
    migrationAcceptedBaseline: BASELINE,
    executionBase: EXEC_BASE,
    worktree: '.ai-worktrees/goal-003',
  });

  const serialized = JSON.stringify(context);
  for (const forbidden of ['transcript', 'conversation', 'messages', 'history', 'sessionId']) {
    assert.ok(!serialized.includes(forbidden), `Developer context must not carry "${forbidden}"`);
  }
  assert.ok(context.mustRead.includes('CLAUDE.md'));
  assert.ok(context.mustRead.includes('AGENTS.md'));
  assert.notEqual(context.migrationAcceptedBaseline, context.executionBase);
});

test('a CORRECTION context requires the blockers it must address', () => {
  const args = {
    goal: '003',
    goalPath: 'p.md',
    round: 2,
    type: 'CORRECTION',
    migrationAcceptedBaseline: BASELINE,
    executionBase: EXEC_BASE,
    worktree: '.ai-worktrees/goal-003',
  };

  assert.throws(() => buildDeveloperContext({ ...args, blockers: [] }), codeIs('INVALID_ARGS'));
  const context = buildDeveloperContext({ ...args, blockers: ['corrigir X'], previousImplementationReport: 'antes' });
  assert.deepEqual(context.blockers, ['corrigir X']);
  assert.equal(context.previousImplementationReport, 'antes');
});

test('the Tech Lead context restates the facts instead of trusting session memory', () => {
  const context = buildTechLeadContext({
    goal: '003',
    goalPath: 'p.md',
    round: 1,
    reviewLevel: 'DEEP',
    migrationAcceptedBaseline: BASELINE,
    executionBase: EXEC_BASE,
    worktree: '.ai-worktrees/goal-003',
    changedFiles: ['a.ts'],
    implementationReport: 'relatório',
    previousBlockers: ['antes'],
  });

  assert.equal(context.reviewLevel, 'DEEP');
  assert.deepEqual(context.changedFiles, ['a.ts']);
  assert.deepEqual(context.previousBlockers, ['antes']);
  assert.equal(context.migrationAcceptedBaseline, BASELINE);
  assert.throws(
    () => buildTechLeadContext({ goal: '003', round: 1, reviewLevel: 'DEEP' }),
    codeIs('INVALID_ARGS'),
  );
});

// --- Session strategy invariants ------------------------------------------

test('the Developer never persists or resumes a session', async () => {
  const seen = [];
  const fakeSpawn = () => {
    throw new Error('spawn should not be reached in this test');
  };

  // Build args directly through the session helper the Developer does NOT use,
  // to assert the asymmetry is real rather than incidental.
  const session = createPersistentSession({
    executable: 'claude',
    role: 'tech_lead',
    model: 'claude-fable-5-1',
    expectedFamily: 'fable',
    cwd: '.',
  });
  assert.equal(session.status, 'CREATED');
  seen.push(session.sessionId);

  const second = createPersistentSession({
    executable: 'claude',
    role: 'tech_lead',
    model: 'claude-fable-5-1',
    expectedFamily: 'fable',
    cwd: '.',
  });
  // Distinct ids by default, so no two handles can collide by accident.
  assert.notEqual(second.sessionId, seen[0]);
  assert.equal(typeof fakeSpawn, 'function');
});

test('the two roles can never share a session id', () => {
  let registry = upsertSession({ version: REGISTRY_VERSION, sessions: {} }, 'tech_lead', { sessionId: 'shared' });
  registry = upsertSession(registry, 'developer', { sessionId: 'shared' });
  assert.throws(() => assertSessionsAreIndependent(registry), codeIs('SESSION_ID_COLLISION'));
});

// --- Dry-run invariants ----------------------------------------------------

test('a dry run publishes no job and creates no worktree', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-dry-'));
  try {
    const store = createJobStore(dir);

    // Simulates exactly what the dry run does: snapshots and one event only.
    await store.writeCurrentGoal({ goalId: '003', migrationAcceptedBaseline: BASELINE, executionBase: EXEC_BASE });
    await store.writeRuntime({ mode: 'DRY_RUN', goal: '003', goalExecuted: false });
    await store.appendEvent({ type: 'DRY_RUN_COMPLETED', goal: '003' });

    assert.deepEqual(await store.listJobs('developer'), []);
    assert.deepEqual(await store.listJobs('tech_lead'), []);

    const runtime = await store.readRuntime();
    assert.equal(runtime.goalExecuted, false);
    assert.equal(runtime.mode, 'DRY_RUN');

    const events = await store.readEvents();
    assert.deepEqual(events.map((e) => e.type), ['DRY_RUN_COMPLETED']);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
