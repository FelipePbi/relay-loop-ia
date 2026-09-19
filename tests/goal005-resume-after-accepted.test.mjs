/**
 * The exact regression: `npm run ia-loop:auto` re-invokes `run-goal.mjs` as a
 * fresh child process for a Goal that is ALREADY accepted — it does this
 * every iteration, since finding out whether closure is still owed IS the
 * point of running it again. The fresh process's local state machine starts
 * at IDLE and walks to WORKTREE_READY before it ever reads the ledger.
 * `reconcileExecutionState` correctly says `CLOSE_GOAL`. The old code then
 * called `machine.transitionTo(LOOP_STATES.ACCEPTED)` straight from
 * WORKTREE_READY, which the transition graph correctly refuses — the Goal had
 * nothing wrong with it, and the process still crashed with
 * INVALID_TRANSITION, surfacing to `run-auto.mjs` as `Goal 005 needs a human:
 * UNKNOWN_FATAL`.
 *
 * This reproduces the exact sequence `run-goal.mjs` runs — the same machine
 * walk, the same `reconcileExecutionState` call, the same guard and the same
 * `hydrateTo` — without a worktree, a git checkout, or a model.
 *
 * No model is called anywhere in this file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJobStore, writeJsonAtomic, STORE_VERSION } from '../lib/job-store.mjs';
import { DISPATCH_KINDS, reconcileExecutionState } from '../lib/reconcile.mjs';
import { LOOP_STATES, createLoopStateMachine } from '../lib/loop-state.mjs';
import { assertGoalEligibleForClosure } from '../lib/closure-eligibility.mjs';
import { classifyOrchestratorFault } from '../lib/orchestrator-fault.mjs';
import { PROTOCOL_VERSION_V2 } from '../lib/contracts-v2.mjs';

const GOAL = '005';
const DEV_R1 = '005-r1-developer-b218cf51';
const REV_R1 = '005-r1-tech_lead-ca1d7bf4';
const DEV_R2 = '005-r2-correction-7c3288b0';
const REV_R2 = '005-r2-tech_lead-8eec8bd3';

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-005-resume-'));
  try {
    return await run(createJobStore(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const jobRecord = (jobId, role, round, extra = {}) => ({
  storeVersion: STORE_VERSION,
  publishedAt: '2026-09-08T02:58:46.281Z',
  status: 'QUEUED', attempt: 1, currentAttemptId: `${jobId}-a1`, attemptStatus: 'QUEUED', attemptHistory: [],
  job: {
    protocolVersion: PROTOCOL_VERSION_V2, jobId, role, goal: GOAL, round,
    type: role === 'developer' ? (round === 1 ? 'IMPLEMENTATION' : 'CORRECTION') : undefined,
    reviewLevel: role === 'tech_lead' ? 'DEEP' : undefined,
  },
  ...extra,
});

/** Goal 005 as it really stood: R1 CHANGES_REQUIRED, R2 developer done, R2 review a1 capacity-waited then a2 ACCEPTED. */
async function seedGoal005AcceptedAtR2(store) {
  await mkdir(store.paths.jobsDir('developer'), { recursive: true });
  await mkdir(store.paths.jobsDir('tech_lead'), { recursive: true });
  await mkdir(store.paths.resultsDir('developer'), { recursive: true });
  await mkdir(store.paths.resultsDir('tech_lead'), { recursive: true });

  await writeJsonAtomic(store.paths.job('developer', DEV_R1), { ...jobRecord(DEV_R1, 'developer', 1), status: 'COMPLETED', attemptStatus: 'COMPLETED' });
  await store.publishResult('developer', DEV_R1, { ok: true, result: { protocolVersion: PROTOCOL_VERSION_V2, jobId: DEV_R1, goal: GOAL, round: 1, status: 'REVIEW_REQUIRED' } }, { attemptId: `${DEV_R1}-a1` });

  await writeJsonAtomic(store.paths.job('tech_lead', REV_R1), { ...jobRecord(REV_R1, 'tech_lead', 1), status: 'COMPLETED', attemptStatus: 'COMPLETED' });
  await store.publishResult('tech_lead', REV_R1, {
    ok: true, result: { protocolVersion: PROTOCOL_VERSION_V2, jobId: REV_R1, goal: GOAL, round: 1, decision: 'CHANGES_REQUIRED', blockers: ['P1', 'P2'] },
  }, { attemptId: `${REV_R1}-a1` });

  await writeJsonAtomic(store.paths.job('developer', DEV_R2), { ...jobRecord(DEV_R2, 'developer', 2), status: 'COMPLETED', attemptStatus: 'COMPLETED' });
  await store.publishResult('developer', DEV_R2, { ok: true, result: { protocolVersion: PROTOCOL_VERSION_V2, jobId: DEV_R2, goal: GOAL, round: 2, status: 'REVIEW_REQUIRED' } }, { attemptId: `${DEV_R2}-a1` });

  await writeJsonAtomic(store.paths.job('tech_lead', REV_R2), { ...jobRecord(REV_R2, 'tech_lead', 2), status: 'WAITING_FOR_CAPACITY', attemptStatus: 'WAITING_FOR_CAPACITY' });
  const a2 = await store.startNextAttempt('tech_lead', REV_R2, { reason: 'USAGE_LIMIT' });
  await store.publishResult('tech_lead', REV_R2, {
    ok: true, result: { protocolVersion: PROTOCOL_VERSION_V2, jobId: REV_R2, goal: GOAL, round: 2, decision: 'ACCEPTED', blockers: [], nextAction: 'STOP' },
  }, { attemptId: a2.attemptId });
  await store.setJobStatus('tech_lead', REV_R2, 'COMPLETED');

  await store.writeRuntime({
    goal: GOAL, round: 2, mode: 'REAL_EXECUTION', state: LOOP_STATES.WORKTREE_READY,
    worktreePath: '.ai-worktrees/goal-005', worktreeInitialHead: 'a'.repeat(40),
  });

  return { a2AttemptId: a2.attemptId };
}

test('a freshly re-invoked run-goal.mjs process reaches ACCEPTED with no exception and no new dispatch', async () => {
  await withStore(async (store) => {
    const { a2AttemptId } = await seedGoal005AcceptedAtR2(store);

    // --- Exactly run-goal.mjs's own sequence, before any dispatch ----------
    const machine = createLoopStateMachine();
    machine.transitionTo(LOOP_STATES.GOAL_READY, { goal: GOAL });
    machine.transitionTo(LOOP_STATES.PREPARING_WORKTREE);
    machine.transitionTo(LOOP_STATES.WORKTREE_READY);
    assert.equal(machine.state, LOOP_STATES.WORKTREE_READY, 'a fresh process always starts here, regardless of runtime.json');

    const reconciled = await reconcileExecutionState({ store, goal: GOAL, maxRounds: 3 });
    assert.equal(reconciled.next.kind, DISPATCH_KINDS.CLOSE_GOAL);
    assert.equal(reconciled.next.round, 2);
    assert.equal(reconciled.next.reviewJobId, REV_R2);

    // --- The fix: independent proof, then a hydrated (never faked) jump ----
    const evidence = await assertGoalEligibleForClosure(store, {
      goal: GOAL, round: reconciled.next.round, reviewJobId: reconciled.next.reviewJobId,
    });
    assert.equal(evidence.attemptId, a2AttemptId);

    machine.hydrateTo(LOOP_STATES.ACCEPTED, { reason: 'AUTHORITATIVE_REVIEW_ACCEPTED', evidence });
    assert.equal(machine.state, LOOP_STATES.ACCEPTED);

    // --- Nothing else happened -----------------------------------------
    assert.equal((await store.readAttemptState('tech_lead', REV_R2)).attempt, 2, 'no a3');
    assert.equal(await store.hasCompletedResult('developer', DEV_R2), true, 'the Developer was never re-invoked');
    assert.equal((await store.readAttemptState('developer', DEV_R2)).attempt, 1, 'no new Developer attempt');
  });
});

test('the OLD code path is provably the crash: transitionTo alone throws exactly what was reported', async () => {
  await withStore(async (store) => {
    await seedGoal005AcceptedAtR2(store);

    const machine = createLoopStateMachine();
    machine.transitionTo(LOOP_STATES.GOAL_READY, { goal: GOAL });
    machine.transitionTo(LOOP_STATES.PREPARING_WORKTREE);
    machine.transitionTo(LOOP_STATES.WORKTREE_READY);

    const reconciled = await reconcileExecutionState({ store, goal: GOAL, maxRounds: 3 });
    assert.equal(reconciled.next.kind, DISPATCH_KINDS.CLOSE_GOAL);

    let caught = null;
    try {
      machine.transitionTo(LOOP_STATES.ACCEPTED);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, 'the unpatched call really does throw');
    assert.equal(caught.code, 'INVALID_TRANSITION');
    assert.equal(caught.message, 'Transition WORKTREE_READY -> ACCEPTED is not allowed');

    // And this is the exact fault run-auto.mjs must NOT read as UNKNOWN_FATAL.
    assert.equal(classifyOrchestratorFault(caught), 'HARNESS_ERROR');
  });
});

test('reconciliation never fires CLOSE_GOAL without an ACCEPTED review — the guard has something real to check', async () => {
  await withStore(async (store) => {
    await seedGoal005AcceptedAtR2(store);
    // Round 1's review is CHANGES_REQUIRED; asking the guard about IT, not the
    // Goal's actual next step, must refuse — proving this is not a rubber stamp.
    await assert.rejects(
      () => assertGoalEligibleForClosure(store, { goal: GOAL, round: 1, reviewJobId: REV_R1 }),
      (e) => e.code === 'CLOSURE_INELIGIBLE' && e.details.reason === 'NOT_ACCEPTED',
    );
  });
});
