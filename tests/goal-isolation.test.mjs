/**
 * Execution state is isolated between Goals.
 *
 * The bug, exactly as it happened. Goal 004 was ACCEPTED at round 2, closed,
 * its baseline recorded as ecaf7058…, Goal 005 planned and created READY, and
 * the autonomous loop continued on its own. `run-auto` moved the run's pointer
 * to 005; the execution state on disk was still 004's. Goal 005's ledger was
 * empty — nothing had ever run for it — so the job-id fallback chain in
 * `run-goal` reached `jobIdsByRound["1"].developer` from the PREVIOUS Goal and
 * dispatched `004-r1-developer-69a88746`, an attempt already marked SUPERSEDED
 * as a duplicate. The store refused it:
 *
 *   [STAGE_NOT_RETRYABLE] Attempt 004-r1-developer-69a88746-a1 is SUPERSEDED
 *
 * and the run stopped as UNKNOWN_FATAL — reading, from the outside, as though
 * Goal 005 had failed. Goal 005 never ran. No inference ever happened for it.
 *
 * These tests state the invariant that makes it impossible: in the execution
 * context of Goal G, every entity that is "current" satisfies entity.goal === G.
 * A closed Goal's entities keep existing in the store — that is history — and
 * can never be selected.
 *
 * No model is called anywhere here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GOAL_SCOPED_RUNTIME_FIELDS,
  RUN_SCOPED_RUNTIME_FIELDS,
  assertBelongsToGoal,
  goalExecutionOf,
  initializeGoalExecutionState,
  jobIdForGoal,
  readJobForGoal,
  scopeOfRuntimeField,
  staleGoalPointers,
} from '../lib/goal-execution.mjs';
import { createJobStore } from '../lib/job-store.mjs';
import {
  DISPATCH_KINDS, STAGE_STATUS, buildStageLedger, decideNextDispatch, reconcileExecutionState,
} from '../lib/reconcile.mjs';
import { STAGES, goalOfJobId, stageKey } from '../lib/stage-identity.mjs';
import { RECOVERY_ACTIONS, planRecovery } from '../lib/recovery-plan.mjs';
import { LOOP_STATES } from '../lib/loop-state.mjs';
import { FAILURE_FAMILIES, eventTypeFor, familyFor } from '../lib/failure-taxonomy.mjs';
import { HUMAN_REQUIRED_REASONS, requiresHuman } from '../lib/autonomous-state.mjs';

const codeIs = (code) => (error) => error.code === code;

const PREVIOUS = '004';
const CURRENT = '005';

// The real ids from the run this was written for.
const DEV_004_R1 = '004-r1-developer-69a88746';
const DEV_004_R1_ORIGINAL = '004-r1-developer-d8f21303';
const REV_004_R1 = '004-r1-tech_lead-4ded365b';
const DEV_004_R2 = '004-r2-correction-dde6dca4';
const REV_004_R2 = '004-r2-tech_lead-b6b591ef';

const BASELINE_004 = '588b70f575670eeda015750b400a09752ceb5490';
const BASELINE_005 = 'ecaf7058f2b81ffe4bd4d2966e233b4b58c16dd5';
const HEAD_005 = '8551717940a58128a2af4c40cffeb977334860a5';
const RUN_ID = 'auto-9722bbb7';

const BLOCKERS = [
  { id: 'B1', title: 'inbox worker sem backoff' },
  { id: 'B2', title: 'outbox sem idempotência' },
  { id: 'B3', title: 'webhook sem verificação de assinatura' },
  { id: 'B4', title: 'migração sem ensaio' },
];

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-goal-isolation-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

/** The runtime exactly as Goal 004 left it, at the moment 005 was about to start. */
const goal004Runtime = () => ({
  storeVersion: 1,
  mode: 'REAL_EXECUTION',
  goal: PREVIOUS,
  state: LOOP_STATES.ACCEPTED,
  round: 2,
  reviewLevel: 'DEEP',
  autonomousRunId: RUN_ID,
  migrationAcceptedBaseline: BASELINE_004,
  executionBase: 'b3a019c94b8e89f48db5ab017866ff9e325d7d82',
  worktreePath: '.ai-worktrees/goal-004',
  worktreeInitialHead: 'b3a019c94b8e89f48db5ab017866ff9e325d7d82',
  mainGuardCheckpoint: { head: 'ca6444c1e06e3bc9490f3b9dfcd85a1c0aa7651d', reason: 'ORCHESTRATOR_ATTACH' },

  currentJobId: DEV_004_R1,
  currentAttemptId: `${DEV_004_R1}-a1`,
  jobIdsByRound: {
    1: { developer: DEV_004_R1, tech_lead: REV_004_R1 },
    2: { developer: DEV_004_R2, tech_lead: REV_004_R2 },
  },
  decision: 'ACCEPTED',
  reviewDecision: 'ACCEPTED',
  blockers: BLOCKERS,
  correction: { round: 2, fromReviewJobId: REV_004_R1 },
  lastImplementationReport: 'Goal 004: transporte de mensagens duráveis',
  closure: { goal: PREVIOUS, newMigrationBaseline: BASELINE_005, nextGoalId: CURRENT },
  goalClosed: true,
  acceptedSnapshot: { head: BASELINE_005, worktree: '.ai-worktrees/goal-004' },
  recovery: { at: '2026-09-08T00:50:58.662Z', fromState: 'CORRECTION_QUEUED', action: 'REQUEUE_JOB' },
  capacity: { reason: 'RATE_LIMIT', attempt: 1 },
  blockedAgent: 'developer',
  blockedJobId: DEV_004_R2,
  resumeFrom: LOOP_STATES.CORRECTION_RUNNING,
  goalExecuted: true,
  humanRequired: { reason: 'UNKNOWN_FATAL', at: '2026-09-08T01:21:37.538Z' },
});

/** What the boundary produces for Goal 005. */
const goal005Runtime = () => initializeGoalExecutionState({
  previousRuntime: goal004Runtime(),
  goal: CURRENT,
  execution: { state: LOOP_STATES.GOAL_READY, migrationAcceptedBaseline: BASELINE_005 },
});

const devEntry = (jobId, goal, round, type = 'IMPLEMENTATION') => ({
  role: 'developer', job: { jobId, role: 'developer', goal, round, type },
});
const revEntry = (jobId, goal, round) => ({
  role: 'tech_lead', job: { jobId, role: 'tech_lead', goal, round },
});
const withResult = (entry, result, status = 'COMPLETED') => ({ ...entry, status, result: { ok: true, ...result } });

/** Goal 004 as it actually finished: R1 changes required, R2 accepted, one superseded duplicate. */
const goal004Entries = () => [
  withResult(devEntry(DEV_004_R1_ORIGINAL, PREVIOUS, 1), { status: 'REVIEW_REQUIRED' }),
  withResult(revEntry(REV_004_R1, PREVIOUS, 1), { decision: 'CHANGES_REQUIRED', blockers: BLOCKERS }),
  { ...devEntry(DEV_004_R1, PREVIOUS, 1), status: 'SUPERSEDED', attemptStatus: 'SUPERSEDED', result: null },
  withResult(devEntry(DEV_004_R2, PREVIOUS, 2, 'CORRECTION'), { status: 'REVIEW_REQUIRED' }),
  withResult(revEntry(REV_004_R2, PREVIOUS, 2), { decision: 'ACCEPTED', blockers: [] }),
];

// ===========================================================================
// 1–12. Nothing of a closed Goal's execution crosses the boundary
// ===========================================================================

test('1. Goal004 currentJobId does not cross into Goal005', () => {
  assert.equal(goal004Runtime().currentJobId, DEV_004_R1, 'the leak was real, and this is what leaked');
  assert.equal(goal005Runtime().currentJobId, null);
});

test('2. Goal004 currentAttemptId does not cross into Goal005', () => {
  assert.equal(goal005Runtime().currentAttemptId, null);
});

test('3. the round resets to 1', () => {
  // Inheriting round 2 turned the first implementation of a new Goal into a
  // correction with no blockers, which is not even a valid job.
  assert.equal(goal004Runtime().round, 2);
  assert.equal(goal005Runtime().round, 1);
});

test('4. blockers reset', () => {
  assert.deepEqual(goal005Runtime().blockers, []);
});

test('5. the review decision resets', () => {
  assert.equal(goal005Runtime().reviewDecision, null);
  assert.equal(goal005Runtime().decision, null, 'nor the decision the runner reads');
});

test('6. correction state resets', () => {
  assert.equal(goal005Runtime().correction, null);
});

test('7. jobIdsByRound resets', () => {
  assert.deepEqual(goal005Runtime().jobIdsByRound, {});
});

test('8. a recovery continuation does not cross', () => {
  // "Resume what was interrupted" is meaningless once the Goal that was
  // interrupted has been accepted and closed.
  assert.equal(goal005Runtime().recovery, null);
});

test('9. closure state does not cross', () => {
  assert.equal(goal005Runtime().closure, null);
  assert.equal(goal005Runtime().goalClosed, false);
});

test('10. a capacity resume point from Goal004 does not cross', () => {
  const next = goal005Runtime();
  assert.equal(next.resumeFrom, null);
  assert.equal(next.capacity, null);
  assert.equal(next.blockedAgent, null);
  assert.equal(next.blockedJobId, null);
});

test('11. the accepted snapshot of Goal004 does not cross', () => {
  assert.equal(goal005Runtime().acceptedSnapshot, null);
  assert.equal(goal005Runtime().lastImplementationReport, null,
    'nor the report describing work that is not in the tree under review');
});

test('12. Goal004 worktree metadata does not cross', () => {
  const next = initializeGoalExecutionState({ previousRuntime: goal004Runtime(), goal: CURRENT });
  assert.equal(next.worktreePath, undefined,
    'the next Goal has no worktree until run-goal plans one');
  assert.equal(next.worktreeInitialHead, undefined);
  assert.equal(next.executionBase, undefined);
});

// ===========================================================================
// 13–16. What the run owns is preserved
// ===========================================================================

test('13. the migration baseline is preserved across the boundary', () => {
  assert.equal(goal005Runtime().migrationAcceptedBaseline, BASELINE_005,
    'the closure of Goal 004 is what set it, and Goal 005 executes on it');
  assert.equal(
    initializeGoalExecutionState({ previousRuntime: goal004Runtime(), goal: CURRENT }).migrationAcceptedBaseline,
    BASELINE_004,
    'without an explicit new one, the run keeps the baseline it had',
  );
});

test('14. the autonomous run id is preserved', () => {
  assert.equal(goal005Runtime().autonomousRunId, RUN_ID);
});

test('15. run-level configuration is preserved', () => {
  assert.equal(goal005Runtime().reviewLevel, 'DEEP');
  assert.equal(goal005Runtime().mode, 'REAL_EXECUTION');
  assert.equal(goal005Runtime().mainGuardCheckpoint.reason, 'ORCHESTRATOR_ATTACH');
});

test('16. the audit history is never touched by a boundary', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    await store.appendEvent({ type: 'GOAL_ACCEPTED', goal: PREVIOUS });
    await store.appendEvent({ type: 'GOAL_CLOSED', goal: PREVIOUS, newMigrationBaseline: BASELINE_005 });

    await store.writeRuntime(goal004Runtime());
    const archived = await store.archiveGoalExecution(await store.readRuntime());
    await store.writeRuntime(goal005Runtime());
    await store.appendEvent({ type: 'GOAL_EXECUTION_ARCHIVED', previousGoal: PREVIOUS, nextGoal: CURRENT });

    const events = await store.readEvents();
    assert.deepEqual(events.map((e) => e.type),
      ['GOAL_ACCEPTED', 'GOAL_CLOSED', 'GOAL_EXECUTION_ARCHIVED']);
    assert.equal(archived.archived, true);

    // And Goal 004's execution is still readable — archived, not deleted.
    const history = await store.readArchivedGoalExecution(PREVIOUS);
    assert.equal(history.currentJobId, DEV_004_R1);
    assert.equal(history.round, 2);
  });
});

// ===========================================================================
// 17–21. The ledger of a closed Goal cannot decide anything for the next one
// ===========================================================================

test('17. a SUPERSEDED stage of Goal004 does not affect Goal005 R1', () => {
  const ledger = buildStageLedger(goal004Entries(), { goal: CURRENT });
  assert.equal(ledger.size, 0, 'no stage of Goal 004 belongs to Goal 005 ledger');

  const next = decideNextDispatch({ ledger, goal: CURRENT });
  assert.equal(next.kind, DISPATCH_KINDS.IMPLEMENTATION);
  assert.equal(next.round, 1);
  assert.equal(next.resumeAttempt, null, 'the superseded 004 attempt is not offered as a resume point');
});

test('18. a COMPLETED stage of Goal004 does not affect Goal005 R1', () => {
  const mixed = buildStageLedger([...goal004Entries(), devEntry('005-r1-developer-aaaaaaaa', CURRENT, 1)]);
  assert.equal(mixed.get('004:r1:implementation').status, STAGE_STATUS.COMPLETED);
  assert.equal(mixed.get('005:r1:implementation').status, STAGE_STATUS.NOT_STARTED);

  // Scoped, the completed 004 stage is not even visible.
  const scoped = buildStageLedger([...goal004Entries(), devEntry('005-r1-developer-aaaaaaaa', CURRENT, 1)], { goal: CURRENT });
  assert.deepEqual([...scoped.keys()], ['005:r1:implementation']);
});

test('19. a FAILED stage of Goal004 does not affect Goal005', () => {
  const failed = { ...devEntry('004-r1-developer-failed01', PREVIOUS, 1), status: 'FAILED', attemptStatus: 'FAILED', result: null };
  const ledger = buildStageLedger([failed], { goal: CURRENT });
  assert.equal(ledger.size, 0);

  const next = decideNextDispatch({ ledger, goal: CURRENT });
  assert.equal(next.kind, DISPATCH_KINDS.IMPLEMENTATION);
  assert.equal(next.round, 1);
});

test('20. the same round and role in two Goals are different stages', () => {
  assert.notEqual(
    stageKey({ goal: PREVIOUS, round: 1, stage: STAGES.IMPLEMENTATION }),
    stageKey({ goal: CURRENT, round: 1, stage: STAGES.IMPLEMENTATION }),
  );
  assert.equal(stageKey({ goal: CURRENT, round: 1, stage: STAGES.IMPLEMENTATION }), '005:r1:implementation');

  // Both live in one ledger without colliding: the key carries the Goal.
  const both = buildStageLedger([
    withResult(devEntry(DEV_004_R1_ORIGINAL, PREVIOUS, 1), { status: 'REVIEW_REQUIRED' }),
    devEntry('005-r1-developer-aaaaaaaa', CURRENT, 1),
  ]);
  assert.equal(both.size, 2);
  assert.equal(both.get('004:r1:implementation').status, STAGE_STATUS.COMPLETED);
  assert.equal(both.get('005:r1:implementation').status, STAGE_STATUS.NOT_STARTED);
});

test('21. reconciliation filters by the current Goal', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    for (const entry of goal004Entries()) {
      await store.publishJob(entry.role, entry.job);
      if (entry.result) await store.publishResult(entry.role, entry.job.jobId, entry.result, { attemptId: (await store.readAttemptState(entry.role, entry.job.jobId))?.attemptId });
    }
    await store.setJobStatus('developer', DEV_004_R1, 'SUPERSEDED');

    const reconciled = await reconcileExecutionState({ store, goal: CURRENT });
    assert.equal(reconciled.ledger.size, 0, 'not one stage of Goal 004 is visible to Goal 005');
    assert.deepEqual(reconciled.duplicates, []);
    assert.equal(reconciled.next.kind, DISPATCH_KINDS.IMPLEMENTATION);
    assert.equal(reconciled.next.stageKey, '005:r1:implementation');

    // And Goal 004 itself still reconciles to its own truth: accepted at R2.
    const previous = await reconcileExecutionState({ store, goal: PREVIOUS });
    assert.equal(previous.next.kind, DISPATCH_KINDS.CLOSE_GOAL);
    assert.equal(previous.next.round, 2);
  });
});

// ===========================================================================
// 22–25. A cross-Goal pointer is rejected, never reinterpreted
// ===========================================================================

test('22. a stale cross-goal currentJobId is rejected', () => {
  // The read gate: the runtime on disk is 004's, so Goal 005 sees nothing.
  assert.equal(goalExecutionOf(goal004Runtime(), CURRENT), null);
  assert.equal(goalExecutionOf(goal004Runtime(), PREVIOUS)?.currentJobId, DEV_004_R1);

  // The id itself says which Goal it belongs to.
  assert.equal(goalOfJobId(DEV_004_R1), PREVIOUS);
  assert.equal(goalOfJobId(`${DEV_004_R1}-a1`), PREVIOUS);
  assert.equal(jobIdForGoal(DEV_004_R1, CURRENT), null);
  assert.equal(jobIdForGoal('005-r1-developer-aaaaaaaa', CURRENT), '005-r1-developer-aaaaaaaa');

  assert.throws(() => assertBelongsToGoal(DEV_004_R1, CURRENT, 'developer job'), codeIs('CROSS_GOAL_STATE_LEAK'));
  assert.throws(
    () => assertBelongsToGoal({ jobId: DEV_004_R1, goal: PREVIOUS }, CURRENT, 'job'),
    codeIs('CROSS_GOAL_STATE_LEAK'),
  );

  // And recovery does not offer it either: the pointer names another Goal.
  const plan = planRecovery({
    runtime: { ...goal004Runtime(), goal: CURRENT, state: LOOP_STATES.DEVELOPER_QUEUED },
  });
  assert.equal(plan.action, RECOVERY_ACTIONS.BLOCKED);
  assert.equal(plan.reason, 'STATE_INCONSISTENT',
    'no current job for this Goal is stated as such, never resolved from the previous one');
});

test('23. Goal005 R1 is a new stage, not a retry', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    for (const entry of goal004Entries()) {
      await store.publishJob(entry.role, entry.job);
      if (entry.result) await store.publishResult(entry.role, entry.job.jobId, entry.result, { attemptId: (await store.readAttemptState(entry.role, entry.job.jobId))?.attemptId });
    }
    await store.setJobStatus('developer', DEV_004_R1, 'SUPERSEDED');
    await store.writeRuntime(goal005Runtime());

    const runtime = await store.readRuntime();
    const execution = goalExecutionOf(runtime, CURRENT);
    const reconciled = await reconcileExecutionState({ store, goal: CURRENT });

    // The exact selection run-goal makes, with the exact inputs it had.
    const stageLedger = reconciled.ledger.get('005:r1:implementation');
    const chosen = stageLedger?.completedBy
      ?? reconciled.next.resumeAttempt
      ?? jobIdForGoal(execution?.jobIdsByRound?.['1']?.developer, CURRENT)
      ?? store.newJobId(CURRENT, 1, 'developer');

    assert.equal(reconciled.next.kind, DISPATCH_KINDS.IMPLEMENTATION);
    assert.equal(goalOfJobId(chosen), CURRENT, `chose ${chosen}`);
    assert.notEqual(chosen, DEV_004_R1);
    assert.equal(await store.hasCompletedResult('developer', chosen), false, 'a genuinely new stage');
  });
});

test('24. Opus would be called for Goal005 R1 — once, under its own id', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    const reconciled = await reconcileExecutionState({ store, goal: CURRENT });

    assert.equal(reconciled.next.kind, DISPATCH_KINDS.IMPLEMENTATION);
    assert.equal(reconciled.next.role, 'developer', 'the Developer, which is Opus');
    assert.equal(reconciled.next.round, 1);
    assert.equal(reconciled.next.needsNewAttempt, false, 'nothing to re-attempt; there is nothing yet');
  });
});

test('25. no attempt of Goal004 is read during Goal005 dispatch', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    for (const entry of goal004Entries()) {
      await store.publishJob(entry.role, entry.job);
      if (entry.result) await store.publishResult(entry.role, entry.job.jobId, entry.result, { attemptId: (await store.readAttemptState(entry.role, entry.job.jobId))?.attemptId });
    }
    await store.setJobStatus('developer', DEV_004_R1, 'SUPERSEDED');

    // Every read of an attempt is recorded, so "it was never consulted" is a
    // fact rather than a claim.
    const readAttempts = [];
    const watched = {
      ...store,
      readAttemptState: (role, jobId) => { readAttempts.push(jobId); return store.readAttemptState(role, jobId); },
    };

    const reconciled = await reconcileExecutionState({ store: watched, goal: CURRENT });
    assert.equal(reconciled.ledger.size, 0);
    assert.deepEqual(readAttempts.filter((id) => id.startsWith('004-')), [],
      'not one 004 attempt was read while dispatching Goal 005');

    // And the store itself refuses, if a leak ever gets that far.
    await assert.rejects(
      store.dispatchJob('developer', { jobId: DEV_004_R1, role: 'developer', goal: CURRENT, round: 1, type: 'IMPLEMENTATION' }),
      codeIs('CROSS_GOAL_STATE_LEAK'),
      'the failure that actually happened is now named for what it is',
    );
  });
});

// ===========================================================================
// 26–28. The boundary itself
// ===========================================================================

test('26. a crash at the Goal boundary is resumable', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    // Crash point: Goal 004 is closed and Goal 005 is READY, but no execution
    // state for 005 exists yet. This is exactly where the real run was.
    await store.writeRuntime(goal004Runtime());

    const runtime = await store.readRuntime();
    assert.equal(goalExecutionOf(runtime, CURRENT), null, 'no Goal 005 execution yet');

    // The restart crosses the boundary once.
    await store.archiveGoalExecution(runtime);
    await store.writeRuntime(initializeGoalExecutionState({
      previousRuntime: runtime, goal: CURRENT,
      execution: { state: LOOP_STATES.GOAL_READY, migrationAcceptedBaseline: BASELINE_005 },
    }));

    const after = await store.readRuntime();
    assert.equal(after.goal, CURRENT);
    assert.equal(after.round, 1);
    assert.equal(after.currentJobId, null);
    assert.equal(await store.readArchivedGoalExecution(PREVIOUS) !== null, true);
  });
});

test('27. initializing the next Goal is idempotent', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    await store.writeRuntime(goal004Runtime());

    const cross = async () => {
      const runtime = await store.readRuntime();
      if (goalExecutionOf(runtime, CURRENT)) return { crossed: false };
      await store.archiveGoalExecution(runtime);
      await store.writeRuntime(initializeGoalExecutionState({
        previousRuntime: runtime, goal: CURRENT,
        execution: { state: LOOP_STATES.GOAL_READY, migrationAcceptedBaseline: BASELINE_005 },
      }));
      return { crossed: true };
    };

    assert.equal((await cross()).crossed, true);

    // Goal 005 does some work, then the boundary is reached again by a restart.
    await store.writeRuntime({ ...await store.readRuntime(), round: 1, currentJobId: '005-r1-developer-aaaaaaaa' });
    assert.equal((await cross()).crossed, false, 'crossing twice must not rewind a Goal that has started');
    assert.equal((await store.readRuntime()).currentJobId, '005-r1-developer-aaaaaaaa');

    // The archive is written once and never rewritten.
    const archivedAgain = await store.archiveGoalExecution(goal004Runtime());
    assert.equal(archivedAgain.archived, false);
    assert.equal(archivedAgain.reason, 'ALREADY_ARCHIVED');
    assert.equal((await store.readArchivedGoalExecution(PREVIOUS)).round, 2);
  });
});

test('28. an existing Goal005 worktree is reused, not recreated', () => {
  // The rule run-goal applies: resume is decided from THIS Goal's execution
  // state, and only when the recorded worktree is still on disk.
  const started = {
    ...goal005Runtime(),
    mode: 'REAL_EXECUTION',
    worktreePath: '.ai-worktrees/goal-005',
    worktreeInitialHead: HEAD_005,
  };
  const execution = goalExecutionOf(started, CURRENT);
  const resuming = execution?.mode === 'REAL_EXECUTION'
    && Boolean(execution.worktreeInitialHead)
    && Boolean(execution.worktreePath)
    && true; // pathExists, in the real runner

  assert.equal(resuming, true);
  assert.equal(execution.worktreePath, '.ai-worktrees/goal-005');

  // The previous Goal's worktree can never produce a resume for this one.
  assert.equal(goalExecutionOf(goal004Runtime(), CURRENT), null);
});

// ===========================================================================
// 29–30. What the failure is called
// ===========================================================================

test('29. nothing here falls back to another model', () => {
  // The taxonomy has no model-substitution family, and a harness error is never
  // a capacity wait — which is the only reason the loop ever waits and retries.
  assert.equal(familyFor({ code: 'CROSS_GOAL_STATE_LEAK' }), FAILURE_FAMILIES.HARNESS);
  assert.notEqual(familyFor({ code: 'CROSS_GOAL_STATE_LEAK' }), FAILURE_FAMILIES.MODEL_CAPACITY);
  assert.equal(familyFor({ code: 'STAGE_NOT_RETRYABLE' }), FAILURE_FAMILIES.HARNESS);
});

test('30. CROSS_GOAL_STATE_LEAK is a harness error and stops for a human', () => {
  assert.equal(eventTypeFor({ code: 'CROSS_GOAL_STATE_LEAK' }), 'HARNESS_ERROR',
    'never CAPACITY_LIMIT_REACHED, never AGENT_FAILURE');
  assert.equal(requiresHuman('CROSS_GOAL_STATE_LEAK'), true);
  assert.equal(HUMAN_REQUIRED_REASONS.includes('CROSS_GOAL_STATE_LEAK'), true);
  assert.notEqual(eventTypeFor({ code: 'CROSS_GOAL_STATE_LEAK' }), 'AGENT_FAILURE',
    'it is our bug, not a verdict about the Goal that was starting');
});

// ===========================================================================
// The invariant, and the classification that keeps it honest
// ===========================================================================

test('every "current" entity in a Goal context belongs to that Goal', () => {
  const entities = [
    { what: 'job', entity: { jobId: DEV_004_R1, goal: PREVIOUS } },
    { what: 'attempt', entity: `${DEV_004_R1}-a1` },
    { what: 'stage', entity: { goal: PREVIOUS, stageKey: '004:r1:implementation' } },
    { what: 'result', entity: { goal: PREVIOUS, decision: 'CHANGES_REQUIRED' } },
    { what: 'review', entity: { goal: PREVIOUS, jobId: REV_004_R2 } },
    { what: 'blocker source', entity: { goal: PREVIOUS, jobId: REV_004_R1 } },
    { what: 'recovery continuation', entity: { goal: PREVIOUS, action: 'REQUEUE_JOB' } },
    { what: 'capacity operation', entity: { goal: PREVIOUS, reason: 'RATE_LIMIT' } },
    { what: 'worktree execution metadata', entity: { goal: PREVIOUS, worktreePath: '.ai-worktrees/goal-004' } },
  ];

  for (const { what, entity } of entities) {
    assert.throws(() => assertBelongsToGoal(entity, CURRENT, what), codeIs('CROSS_GOAL_STATE_LEAK'), what);
    // The same entity is perfectly valid in its own Goal: history exists, it
    // just is never current somewhere else.
    assert.doesNotThrow(() => assertBelongsToGoal(entity, PREVIOUS, what), what);
  }
});

test('every runtime field is classified as run-scoped or Goal-scoped', () => {
  // The list is what makes the boundary a decision instead of an accident: a
  // field nobody classified would be dropped silently, so it is caught here.
  for (const field of Object.keys(goal004Runtime())) {
    assert.notEqual(scopeOfRuntimeField(field), 'unclassified', `${field} belongs to no scope`);
  }
  for (const field of RUN_SCOPED_RUNTIME_FIELDS) {
    assert.equal(GOAL_SCOPED_RUNTIME_FIELDS.includes(field), false, `${field} cannot be both`);
  }
  assert.equal(scopeOfRuntimeField('currentJobId'), 'goal');
  assert.equal(scopeOfRuntimeField('migrationAcceptedBaseline'), 'run');
});

test('stale pointers are reported with what they named, and nothing is repaired', () => {
  const stale = staleGoalPointers(goal004Runtime(), CURRENT);
  const fields = stale.map((p) => p.field);

  assert.ok(fields.includes('currentJobId'));
  assert.ok(fields.includes('round'));
  assert.ok(fields.includes('jobIdsByRound.1.developer'));
  assert.ok(fields.includes('closure'));
  assert.equal(stale.find((p) => p.field === 'currentJobId').goal, PREVIOUS,
    'the report says which Goal the pointer belongs to');

  // Nothing is stale when the state is the Goal's own.
  assert.deepEqual(staleGoalPointers(goal004Runtime(), PREVIOUS), []);
});

test('a runtime naming the right Goal but carrying another Goal’s ids is still stale', () => {
  // Exactly what the failed transition left on disk: goal "005" beside
  // currentJobId "004-r1-developer-69a88746". Judging the whole record by
  // runtime.goal alone would have reported it as clean.
  const polluted = {
    goal: CURRENT, round: 1, state: LOOP_STATES.DEVELOPER_QUEUED,
    currentJobId: DEV_004_R1,
    jobIdsByRound: { 1: { developer: DEV_004_R1 } },
  };

  const stale = staleGoalPointers(polluted, CURRENT);
  assert.deepEqual(stale.map((p) => p.field).sort(), ['currentJobId', 'jobIdsByRound.1.developer']);
  assert.equal(stale.every((p) => p.goal === PREVIOUS), true);

  // And the pointer is dropped rather than followed, so the dispatch is new.
  assert.equal(jobIdForGoal(polluted.jobIdsByRound['1'].developer, CURRENT), null);
});

test('readJobForGoal refuses a job belonging to another Goal', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    await store.publishJob('developer', { jobId: DEV_004_R1, role: 'developer', goal: PREVIOUS, round: 1, type: 'IMPLEMENTATION' });

    await assert.rejects(readJobForGoal(store, 'developer', DEV_004_R1, CURRENT), codeIs('CROSS_GOAL_STATE_LEAK'));
    assert.equal((await readJobForGoal(store, 'developer', DEV_004_R1, PREVIOUS)).goal, PREVIOUS);
    assert.equal(await readJobForGoal(store, 'developer', '005-r1-developer-aaaaaaaa', CURRENT), null,
      'an id with no job yet is simply new');
  });
});

// ===========================================================================
// Integration: Goal004 R2 ACCEPTED → closure → Goal005 READY → one dispatch
// ===========================================================================

test('the whole boundary: 004 R2 ACCEPTED → closure → 005 starts clean at R1 implementation', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);

    // --- Goal 004, exactly as it ran ---------------------------------------
    for (const entry of goal004Entries()) {
      await store.publishJob(entry.role, entry.job);
      if (entry.result) await store.publishResult(entry.role, entry.job.jobId, entry.result, { attemptId: (await store.readAttemptState(entry.role, entry.job.jobId))?.attemptId });
    }
    await store.setJobStatus('developer', DEV_004_R1, 'SUPERSEDED');
    await store.writeRuntime(goal004Runtime());

    const closed = await reconcileExecutionState({ store, goal: PREVIOUS });
    assert.equal(closed.next.kind, DISPATCH_KINDS.CLOSE_GOAL);
    assert.equal(closed.next.decision, 'ACCEPTED');
    assert.equal(closed.next.round, 2);
    await store.appendEvent({ type: 'GOAL_CLOSED', goal: PREVIOUS, newMigrationBaseline: BASELINE_005, nextGoalId: CURRENT });

    // --- The boundary ------------------------------------------------------
    const before = await store.readRuntime();
    const archived = await store.archiveGoalExecution(before);
    await store.appendEvent({
      type: 'GOAL_EXECUTION_ARCHIVED', previousGoal: PREVIOUS, nextGoal: CURRENT,
      baseline: BASELINE_005, runId: RUN_ID,
    });
    await store.writeRuntime(initializeGoalExecutionState({
      previousRuntime: before, goal: CURRENT,
      execution: { state: LOOP_STATES.GOAL_READY, migrationAcceptedBaseline: BASELINE_005 },
    }));
    await store.appendEvent({
      type: 'NEXT_GOAL_EXECUTION_INITIALIZED', previousGoal: PREVIOUS, nextGoal: CURRENT,
      baseline: BASELINE_005, runId: RUN_ID, round: 1,
    });
    assert.equal(archived.archived, true);

    // --- Goal 005 starts ----------------------------------------------------
    const runtime = await store.readRuntime();
    const execution = goalExecutionOf(runtime, CURRENT);

    assert.equal(execution.goal, CURRENT);
    assert.equal(execution.round, 1);
    assert.equal(execution.currentJobId, null);
    assert.equal(execution.currentAttemptId, null);
    assert.deepEqual(execution.jobIdsByRound, {});
    assert.deepEqual(execution.blockers, []);
    assert.equal(execution.decision, null);
    assert.equal(execution.closure, null);
    assert.equal(execution.recovery, null);
    assert.equal(execution.resumeFrom, null);
    assert.equal(execution.migrationAcceptedBaseline, BASELINE_005);
    assert.equal(execution.autonomousRunId, RUN_ID);

    const reconciled = await reconcileExecutionState({ store, goal: CURRENT });

    // Exactly one thing to publish, and it is 005's own first implementation.
    assert.equal(reconciled.next.kind, DISPATCH_KINDS.IMPLEMENTATION);
    assert.equal(reconciled.next.stageKey, '005:r1:implementation');
    assert.equal(reconciled.next.round, 1);
    assert.equal(reconciled.next.role, 'developer');
    assert.equal(reconciled.next.resumeAttempt, null);
    assert.equal(reconciled.ledger.size, 0);

    // Nothing named 004 is anywhere in the decision.
    const decisionText = JSON.stringify({ execution, next: reconciled.next, ledger: [...reconciled.ledger.keys()] });
    assert.equal(/004-/.test(decisionText), false, `a 004 reference survived: ${decisionText}`);
    assert.equal(/"004"/.test(decisionText), false);

    // The dispatch itself: a new id for Goal 005, published once.
    const jobId = store.newJobId(CURRENT, 1, 'developer');
    const dispatched = await store.dispatchJob('developer', {
      jobId, role: 'developer', goal: CURRENT, round: 1, type: 'IMPLEMENTATION',
    });
    assert.equal(dispatched.outcome, 'PUBLISHED');
    assert.equal(goalOfJobId(dispatched.jobId), CURRENT);

    // Goal 004's history is intact and still readable.
    assert.equal(await store.hasCompletedResult('tech_lead', REV_004_R2), true);
    assert.equal(await store.readJobStatus('developer', DEV_004_R1), 'SUPERSEDED');
    assert.equal((await store.readArchivedGoalExecution(PREVIOUS)).currentJobId, DEV_004_R1);
    assert.deepEqual((await store.readEvents()).map((e) => e.type), [
      'GOAL_CLOSED', 'GOAL_EXECUTION_ARCHIVED', 'NEXT_GOAL_EXECUTION_INITIALIZED',
    ]);
  });
});
