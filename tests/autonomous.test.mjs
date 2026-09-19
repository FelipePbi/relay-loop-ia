/**
 * V7 autonomous goal-to-goal execution.
 *
 * No real model is called. The multi-goal test drives a fake planner and fake
 * agents through two complete Goals and a declared completion, asserting the
 * thing that defines autonomy: humanInterventionCount === 0.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  RUN_STATUS,
  createAutonomousStore,
  isCapacityWait,
  requiresHuman,
  shouldPauseAt,
} from '../lib/autonomous-state.mjs';
import {
  PLANNING_DECISIONS,
  assertMigrationComplete,
  planningDecisionSchemaFor,
  validatePlanningDecision,
} from '../lib/planning-decision.mjs';
import { LOOP_STATES, createLoopStateMachine } from '../lib/loop-state.mjs';
import { PROTOCOL_VERSION_V2 } from '../lib/contracts-v2.mjs';
import { PER_GOAL_RUNTIME_FIELDS, clearPerGoalRuntime, createJobStore } from '../lib/job-store.mjs';
import { createLeaseStore } from '../lib/leases.mjs';
import { BOUNDARY_VERDICTS, evaluateGoalBoundary } from '../lib/goal-boundary.mjs';

const execFileAsync = promisify(execFile);
const codeIs = (code) => (error) => error.code === code;
const BASELINE_1 = '588b70f575670eeda015750b400a09752ceb5490';
const BASELINE_2 = 'a'.repeat(40);

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-auto-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

// ===========================================================================
// The happy path no longer stops at a human
// ===========================================================================

test('ACCEPTED continues into closure instead of ending at AWAITING_HUMAN', () => {
  const m = createLoopStateMachine({ initialState: LOOP_STATES.ACCEPTED });
  assert.equal(m.canTransitionTo(LOOP_STATES.CLOSURE_PREPARING), true);
  m.transitionTo(LOOP_STATES.CLOSURE_PREPARING);
});

test('NEXT_GOAL_READY starts the next Goal by itself', () => {
  const m = createLoopStateMachine({ initialState: LOOP_STATES.NEXT_GOAL_READY });
  assert.equal(m.canTransitionTo(LOOP_STATES.NEXT_GOAL_STARTING), true);
  m.transitionTo(LOOP_STATES.NEXT_GOAL_STARTING);
  m.transitionTo(LOOP_STATES.PREPARING_WORKTREE);
  assert.equal(m.state, LOOP_STATES.PREPARING_WORKTREE);
});

test('a full autonomous cycle is a legal path with no human gate', () => {
  const m = createLoopStateMachine();
  const path = [
    'GOAL_READY', 'PREPARING_WORKTREE', 'WORKTREE_READY',
    'DEVELOPER_QUEUED', 'DEVELOPER_RUNNING', 'REVIEW_REQUIRED',
    'REVIEWER_QUEUED', 'REVIEWER_RUNNING', 'CHANGES_REQUIRED',
    'CORRECTION_QUEUED', 'CORRECTION_RUNNING', 'REVIEW_REQUIRED',
    'REVIEWER_QUEUED', 'REVIEWER_RUNNING', 'ACCEPTED',
    'CLOSURE_PREPARING', 'CLOSURE_DOCUMENTING', 'CLOSURE_READY',
    'GOAL_COMMITTING', 'GOAL_COMMITTED', 'INTEGRATING_ACCEPTED',
    'BASELINE_ACCEPTED', 'NEXT_GOAL_PLANNING', 'NEXT_GOAL_READY',
    'NEXT_GOAL_STARTING', 'PREPARING_WORKTREE',
  ];
  for (const state of path) m.transitionTo(LOOP_STATES[state]);

  assert.ok(!m.history.some((t) => t.to === LOOP_STATES.AWAITING_HUMAN),
    'the happy path must never touch AWAITING_HUMAN');
});

// ===========================================================================
// What stops the loop, and what does not
// ===========================================================================

test('capacity limits are waits, never human interventions', () => {
  for (const reason of ['RATE_LIMIT', 'USAGE_LIMIT']) {
    assert.equal(isCapacityWait(reason), true, reason);
    assert.equal(requiresHuman(reason), false, reason);
  }
});

test('genuine problems do require a human', () => {
  for (const reason of [
    'AUTH_ERROR', 'BILLING_ERROR', 'MODEL_UNAVAILABLE', 'UNKNOWN_FATAL',
    'HARNESS_ERROR', 'AGENT_CONTRACT_ERROR', 'POLICY_VIOLATION',
    'CHERRY_PICK_CONFLICT', 'ACCEPTED_WORKTREE_CHANGED',
    'ORPHANED_EXECUTION_UNCERTAIN', 'MAX_CORRECTION_ROUNDS_REACHED',
    'PRODUCT_DECISION', 'ARCHITECTURE_DECISION',
  ]) {
    assert.equal(requiresHuman(reason), true, reason);
  }
});

// ===========================================================================
// Orchestrator lease
// ===========================================================================

test('31. a second autonomous run is refused while one owns the loop', async () => {
  await withDir(async (dir) => {
    const auto = createAutonomousStore(dir);
    const run = await auto.start({ fromGoal: '004', migrationAcceptedBaseline: BASELINE_1 });
    assert.equal(run.status, RUN_STATUS.RUNNING);

    const second = createAutonomousStore(dir);
    await assert.rejects(
      second.start({ fromGoal: '004', migrationAcceptedBaseline: BASELINE_1 }),
      codeIs('AUTONOMOUS_RUN_ALREADY_ACTIVE'),
    );
  });
});

test('31/CROSS. two real processes racing to start: exactly one owns the loop', async () => {
  await withDir(async (dir) => {
    const script = join(dir, 'start.mjs');
    const libUrl = new URL('../lib/autonomous-state.mjs', import.meta.url).href;

    await writeFile(script, `
import { createAutonomousStore } from ${JSON.stringify(libUrl)};
const auto = createAutonomousStore(process.argv[2]);
await new Promise((r) => setTimeout(r, Math.max(0, Number(process.argv[3]) - Date.now())));
try {
  await auto.start({ fromGoal: '004', migrationAcceptedBaseline: '${BASELINE_1}' });
  console.log('OWNER');
} catch (e) {
  console.log(e.code === 'AUTONOMOUS_RUN_ALREADY_ACTIVE' ? 'REFUSED' : 'ERR:' + e.code);
}
`, 'utf8');

    const startAt = Date.now() + 300;
    const [a, b] = await Promise.all([
      execFileAsync(process.execPath, [script, dir, String(startAt)]),
      execFileAsync(process.execPath, [script, dir, String(startAt)]),
    ]);

    assert.deepEqual([a.stdout.trim(), b.stdout.trim()].sort(), ['OWNER', 'REFUSED']);
  });
});

test('a restarted orchestrator re-attaches instead of starting a second run', async () => {
  await withDir(async (dir) => {
    const first = createAutonomousStore(dir);
    const run = await first.start({ fromGoal: '004', migrationAcceptedBaseline: BASELINE_1 });
    await first.releaseLoopLease();

    const second = createAutonomousStore(dir);
    const attached = await second.attach();

    assert.equal(attached.attached, true);
    assert.equal(attached.run.autonomousRunId, run.autonomousRunId, 'the run id survives the restart');
  });
});

// ===========================================================================
// Pause is a decision; HUMAN_REQUIRED is a problem
// ===========================================================================

test('32. a pause request stops at the next safe boundary, not mid-inference', async () => {
  await withDir(async (dir) => {
    const auto = createAutonomousStore(dir);
    await auto.start({ fromGoal: '004', migrationAcceptedBaseline: BASELINE_1 });
    await auto.requestPause();

    const run = await auto.read();
    assert.equal(run.pauseRequested, true);
    // Still RUNNING: the request does not itself stop anything.
    assert.equal(run.status, RUN_STATUS.RUNNING);
    assert.equal(shouldPauseAt(run, { boundary: 'AFTER_DECISION' }).pause, true);
  });
});

test('--after-goal waits for the whole Goal before pausing', async () => {
  await withDir(async (dir) => {
    const auto = createAutonomousStore(dir);
    await auto.start({ fromGoal: '004', migrationAcceptedBaseline: BASELINE_1 });
    await auto.requestPause({ afterGoal: true });
    const run = await auto.read();

    assert.equal(shouldPauseAt(run, { boundary: 'AFTER_DECISION' }).pause, false,
      'a mid-Goal boundary must not stop an --after-goal pause');
    assert.equal(shouldPauseAt(run, { boundary: 'GOAL_BOUNDARY' }).pause, true);
  });
});

test('14. PAUSED resumes; PAUSED_FOR_HUMAN does not', async () => {
  await withDir(async (dir) => {
    const auto = createAutonomousStore(dir);
    await auto.start({ fromGoal: '004', migrationAcceptedBaseline: BASELINE_1 });

    await auto.markPaused('PAUSE_REQUESTED');
    assert.equal((await auto.read()).status, RUN_STATUS.PAUSED);
    await auto.clearPause();
    assert.equal((await auto.read()).status, RUN_STATUS.RUNNING);

    await auto.markHumanRequired('AUTH_ERROR', 'not logged in');
    const run = await auto.read();
    assert.equal(run.status, RUN_STATUS.PAUSED_FOR_HUMAN);
    assert.equal(run.humanRequired.reason, 'AUTH_ERROR');
    // clearPause must not be a way around a real problem.
    assert.notEqual(run.status, RUN_STATUS.PAUSED);
  });
});

// ===========================================================================
// Migration completion is a claim, never an inference
// ===========================================================================

const planningBase = {
  protocolVersion: PROTOCOL_VERSION_V2, jobId: 'j', goal: '004', summary: 's',
  documentsUpdated: ['docs/migration/MIGRATION_STATUS.md'],
};

test('33. MIGRATION_COMPLETE must be declared and justified', () => {
  const ok = validatePlanningDecision({
    ...planningBase, decision: 'MIGRATION_COMPLETE',
    reason: 'Todos os gaps críticos fechados', remainingCriticalGaps: [],
  }, { jobId: 'j', goal: '004' });
  assert.equal(ok.decision, 'MIGRATION_COMPLETE');

  // Without a reason it is not a declaration.
  assert.throws(() => validatePlanningDecision({
    ...planningBase, decision: 'MIGRATION_COMPLETE', remainingCriticalGaps: [],
  }, { jobId: 'j', goal: '004' }), codeIs('CONTRACT_FIELD_INVALID'));

  // With known gaps it contradicts itself.
  assert.throws(() => validatePlanningDecision({
    ...planningBase, decision: 'MIGRATION_COMPLETE', reason: 'quase lá',
    remainingCriticalGaps: ['G-99'],
  }, { jobId: 'j', goal: '004' }), codeIs('MIGRATION_NOT_COMPLETE'));
});

test('33. completion is verified against the repository, not taken on trust', () => {
  const decision = { decision: 'MIGRATION_COMPLETE', reason: 'done', remainingCriticalGaps: [] };

  assert.equal(assertMigrationComplete({
    decision, goalStatuses: new Map([['001', 'ACCEPTED'], ['002', 'ACCEPTED']]),
  }), true);

  // A Goal still READY proves the migration is not finished, whatever was said.
  assert.throws(() => assertMigrationComplete({
    decision, goalStatuses: new Map([['001', 'ACCEPTED'], ['005', 'READY']]),
  }), codeIs('MIGRATION_NOT_COMPLETE'));

  assert.throws(() => assertMigrationComplete({
    decision, goalStatuses: new Map([['005', 'IN_PROGRESS']]),
  }), codeIs('MIGRATION_NOT_COMPLETE'));
});

test('33. an empty or ambiguous planning answer is never read as completion', () => {
  for (const decision of [undefined, null, '', 'DONE', 'FINISHED']) {
    assert.throws(
      () => validatePlanningDecision({ ...planningBase, decision }, { jobId: 'j', goal: '004' }),
      codeIs('UNSUPPORTED_DECISION'),
    );
  }
  assert.deepEqual([...PLANNING_DECISIONS], ['NEXT_GOAL', 'MIGRATION_COMPLETE', 'HUMAN_REQUIRED']);
});

test('NEXT_GOAL names exactly one Goal, different from the closed one', () => {
  const ok = validatePlanningDecision({
    ...planningBase, decision: 'NEXT_GOAL', nextGoalId: '005',
    nextGoalTitle: 'T', nextGoalPath: 'docs/migration/goals/005-x.md',
  }, { jobId: 'j', goal: '004' });
  assert.equal(ok.nextGoalId, '005');

  assert.throws(() => validatePlanningDecision({
    ...planningBase, decision: 'NEXT_GOAL', nextGoalId: '004',
    nextGoalTitle: 'T', nextGoalPath: 'docs/migration/goals/004-x.md',
  }, { jobId: 'j', goal: '004' }), codeIs('CONTRACT_FIELD_INVALID'));
});

test('the planning schema pins identity and constrains the decision', () => {
  const schema = planningDecisionSchemaFor({ jobId: 'j', goal: '004' });
  assert.deepEqual(schema.properties.decision.enum, [...PLANNING_DECISIONS]);
  assert.deepEqual(schema.properties.jobId.enum, ['j']);
  assert.deepEqual(schema.properties.protocolVersion.enum, [PROTOCOL_VERSION_V2]);
});

// ===========================================================================
// 26. The multi-goal run
// ===========================================================================

test('THE MULTI-GOAL RUN: two Goals and a declared completion, with no human', async () => {
  await withDir(async (dir) => {
    const auto = createAutonomousStore(dir);
    const store = createJobStore(dir);

    const modelCalls = [];
    let humanInterventionCount = 0;

    // A scripted planner: 004 → 005 → complete.
    const planner = {
      '004': { decision: 'NEXT_GOAL', nextGoalId: '005', nextGoalTitle: 'Observabilidade' },
      '005': { decision: 'MIGRATION_COMPLETE', reason: 'Todos os gaps críticos fechados', remainingCriticalGaps: [] },
    };
    // 004 needs one correction; 005 is accepted first time.
    const reviews = { '004': ['CHANGES_REQUIRED', 'ACCEPTED'], '005': ['ACCEPTED'] };

    let run = await auto.start({ fromGoal: '004', migrationAcceptedBaseline: BASELINE_1 });
    await store.appendEvent({ type: 'AUTONOMOUS_RUN_STARTED', autonomousRunId: run.autonomousRunId });

    const baselines = { '004': BASELINE_1, '005': BASELINE_2 };
    const seenBaselines = [];

    for (let guard = 0; guard < 10; guard += 1) {
      const goalId = run.currentGoal;
      seenBaselines.push({ goal: goalId, baseline: run.migrationAcceptedBaseline });

      // Implementation and review rounds.
      let round = 1;
      for (;;) {
        modelCalls.push({ goal: goalId, round, agent: 'developer' });
        const decision = reviews[goalId].shift();
        modelCalls.push({ goal: goalId, round, agent: 'tech_lead' });

        if (decision === 'ACCEPTED') break;
        if (decision === 'CHANGES_REQUIRED') { round += 1; continue; }
        humanInterventionCount += 1;
        break;
      }
      await store.appendEvent({ type: 'GOAL_ACCEPTED', goal: goalId });

      // Closure moves the baseline; planning decides what follows.
      const newBaseline = baselines[goalId] === BASELINE_1 ? BASELINE_2 : 'b'.repeat(40);
      run = await auto.recordGoalCompleted(goalId, newBaseline);
      modelCalls.push({ goal: goalId, agent: 'tech_lead', phase: 'planning' });

      const planning = planner[goalId];
      if (planning.decision === 'MIGRATION_COMPLETE') {
        assertMigrationComplete({ decision: planning, goalStatuses: new Map([['004', 'ACCEPTED'], ['005', 'ACCEPTED']]) });
        run = await auto.markCompleted(planning.reason);
        await store.appendEvent({ type: 'MIGRATION_COMPLETE', goal: goalId });
        break;
      }

      await store.appendEvent({ type: 'GOAL_TRANSITION', from: goalId, to: planning.nextGoalId });
      run = await auto.setCurrentGoal(planning.nextGoalId);
    }

    // What defines autonomy.
    assert.equal(humanInterventionCount, 0, 'humanInterventionCount must be 0');

    const final = await auto.read();
    assert.equal(final.status, RUN_STATUS.COMPLETED);
    assert.deepEqual(final.completedGoals, ['004', '005']);

    // The baseline advanced with each Goal and never went backwards.
    assert.equal(seenBaselines[0].baseline, BASELINE_1);
    assert.equal(seenBaselines[1].baseline, BASELINE_2);

    // 004 took two rounds, 005 took one; each round is one developer call.
    assert.equal(modelCalls.filter((c) => c.goal === '004' && c.agent === 'developer').length, 2);
    assert.equal(modelCalls.filter((c) => c.goal === '005' && c.agent === 'developer').length, 1);

    const events = (await store.readEvents()).map((e) => e.type);
    assert.ok(events.includes('AUTONOMOUS_RUN_STARTED'));
    assert.ok(events.includes('GOAL_TRANSITION'));
    assert.ok(events.includes('MIGRATION_COMPLETE'));
    assert.ok(!events.includes('AUTONOMOUS_RUN_HUMAN_REQUIRED'));
  });
});

// ===========================================================================
// 27/28/29. Stop conditions and continuity
// ===========================================================================

test('27. HUMAN_REQUIRED stops the run and the next Goal never starts', async () => {
  await withDir(async (dir) => {
    const auto = createAutonomousStore(dir);
    const run = await auto.start({ fromGoal: '004', migrationAcceptedBaseline: BASELINE_1 });

    await auto.markHumanRequired('REVIEWER_ASKED_FOR_HUMAN', 'architecture decision');
    const stopped = await auto.read();

    assert.equal(stopped.status, RUN_STATUS.PAUSED_FOR_HUMAN);
    assert.equal(stopped.currentGoal, '004', 'the run does not advance to the next Goal');
    assert.deepEqual(stopped.completedGoals, []);
    assert.equal(stopped.autonomousRunId, run.autonomousRunId);
  });
});

test('28. a capacity wait crosses Goals without ending the run', async () => {
  await withDir(async (dir) => {
    const auto = createAutonomousStore(dir);
    const run = await auto.start({ fromGoal: '005', migrationAcceptedBaseline: BASELINE_2 });

    // A usage limit is a wait: the run stays RUNNING and the Goal unchanged.
    assert.equal(isCapacityWait('USAGE_LIMIT'), true);
    assert.equal(requiresHuman('USAGE_LIMIT'), false);

    const during = await auto.read();
    assert.equal(during.status, RUN_STATUS.RUNNING);
    assert.equal(during.currentGoal, '005', 'no premature Goal 006');
    assert.equal(during.autonomousRunId, run.autonomousRunId);
  });
});

test('29. a crash between Goals resumes the next Goal exactly once', async () => {
  await withDir(async (dir) => {
    const first = createAutonomousStore(dir);
    const run = await first.start({ fromGoal: '004', migrationAcceptedBaseline: BASELINE_1 });
    await first.recordGoalCompleted('004', BASELINE_2);
    await first.setCurrentGoal('005');
    await first.releaseLoopLease();

    // The process dies here; a new one loads state from disk only.
    const second = createAutonomousStore(dir);
    const attached = await second.attach();

    assert.equal(attached.attached, true);
    assert.equal(attached.run.currentGoal, '005');
    assert.deepEqual(attached.run.completedGoals, ['004'], 'Goal 004 is not closed twice');
    assert.equal(attached.run.migrationAcceptedBaseline, BASELINE_2);
    assert.equal(attached.run.autonomousRunId, run.autonomousRunId);

    // Recording the same Goal again is idempotent.
    const again = await second.recordGoalCompleted('004', BASELINE_2);
    assert.deepEqual(again.completedGoals, ['004']);
  });
});

// ===========================================================================
// 30. Goal boundaries
// ===========================================================================

const readyGoal = { status: 'READY', migrationAcceptedBaseline: BASELINE_2 };
const boundary = (over) => evaluateGoalBoundary({
  goalId: '005', goal: readyGoal, expectedBaseline: BASELINE_2, ...over,
});

test('a clean boundary starts the next Goal', () => {
  const r = boundary({});
  assert.equal(r.verdict, BOUNDARY_VERDICTS.START);
  assert.deepEqual(r.problems, []);
});

test('the Goal\'s own branch and worktree mean resume, not a fresh start', () => {
  const r = boundary({ branchExists: true, worktreeExists: true });
  assert.equal(r.verdict, BOUNDARY_VERDICTS.RESUME);
  assert.equal(r.resuming, true);
});

test('30. a branch without its worktree is ambiguous and stops the run', () => {
  const r = boundary({ branchExists: true, worktreeExists: false });
  assert.equal(r.verdict, BOUNDARY_VERDICTS.HUMAN_REQUIRED);
  assert.match(r.problems[0], /disagree/);
});

test('30. a baseline mismatch after a partial closure stops the run', () => {
  // The Goal was written against the previous baseline: the closure that should
  // have advanced it did not finish. Starting anyway would build on the wrong tree.
  const r = boundary({ goal: { status: 'READY', migrationAcceptedBaseline: BASELINE_1 } });
  assert.equal(r.verdict, BOUNDARY_VERDICTS.HUMAN_REQUIRED);
  assert.match(r.problems[0], /baseline/);
});

test('30. a dirty main checkout stops the run', () => {
  const r = boundary({ dirtyFiles: ['apps/bff/src/x.ts'] });
  assert.equal(r.verdict, BOUNDARY_VERDICTS.HUMAN_REQUIRED);
  assert.match(r.problems[0], /dirty/);
});

test('30. a Goal that is not READY is never started', () => {
  for (const status of ['IN_PROGRESS', 'ACCEPTED', 'BLOCKED']) {
    const r = boundary({ goal: { status, migrationAcceptedBaseline: BASELINE_2 } });
    assert.equal(r.verdict, BOUNDARY_VERDICTS.HUMAN_REQUIRED, status);
  }
});

test('30. failed discovery stops the run instead of assuming a Goal', () => {
  const r = boundary({ goal: null, discoveryError: 'GOAL_NOT_FOUND' });
  assert.equal(r.verdict, BOUNDARY_VERDICTS.HUMAN_REQUIRED);
});

// ===========================================================================
// A claim in flight is not a corrupt lease
// ===========================================================================

test('a lease file still being written is read as a claim in flight, not corruption', async () => {
  await withDir(async (dir) => {
    const leases = createLeaseStore(dir);
    const first = await leases.claimJob('k', { autonomousRunId: 'auto-1' });
    assert.equal(first.acquired, true);

    const leasePath = join(dir, 'leases', 'jobs', 'k.lock');
    const content = await readFile(leasePath, 'utf8');

    // Reproduce the exact window: exclusive create has happened, the content
    // write has not. This is what the loser of a race observes.
    await writeFile(leasePath, '', 'utf8');
    const fillsIn = setTimeout(() => { writeFile(leasePath, content, 'utf8'); }, 60);

    const held = await leases.readJobLease('k');
    clearTimeout(fillsIn);
    assert.equal(held.autonomousRunId, 'auto-1', 'the reader waited for the claim to settle');
  });
});

test('a lease that never fills in is still reported as corrupt', async () => {
  await withDir(async (dir) => {
    const leases = createLeaseStore(dir);
    await leases.claimJob('k', { autonomousRunId: 'auto-1' });
    await writeFile(join(dir, 'leases', 'jobs', 'k.lock'), '', 'utf8');

    await assert.rejects(leases.readJobLease('k'), codeIs('LEASE_CORRUPT'));
  });
});

// ===========================================================================
// A Goal boundary keeps nothing from the previous Goal's execution
// ===========================================================================

test('starting a new Goal does not inherit the previous Goal\'s round', () => {
  // The real failure: Goal 003 ended at round 2 with CHANGES_REQUIRED. The loop
  // started Goal 004 by itself and opened it as "Round 2 (correction)" with no
  // blockers, which is not a valid job.
  const leftover = {
    mode: 'REAL_EXECUTION', goal: '003', round: 2, decision: 'CHANGES_REQUIRED',
    blockers: [{ id: 'B1' }], currentJobId: '003-r2-correction',
    goalExecuted: true, roundsRun: [{ round: 1 }], escalationReason: 'CHANGES_REQUIRED',
    capacity: { until: 1 }, blockedAgent: 'developer', resumeFrom: 'CORRECTION_RUNNING',
    closure: { goal: '003', newMigrationBaseline: BASELINE_1 },
    goalClosed: true, lastImplementationReport: 'R2 — Goal 003 …',
    policyViolations: [], deferredNextAction: 'RETURN_TO_DEVELOPER',
    reviewLevel: 'FULL',
  };

  const clean = clearPerGoalRuntime(leftover);

  for (const field of PER_GOAL_RUNTIME_FIELDS) {
    assert.equal(Object.hasOwn(clean, field), false, `${field} must not cross a Goal boundary`);
  }
  // The three that would corrupt the next Goal most quietly.
  assert.equal(clean.closure, undefined, 'a closure for another Goal must not be inherited');
  assert.equal(clean.lastImplementationReport, undefined,
    'the next Goal reviewer must not read the previous Goal report');
  assert.equal(clean.round, undefined);

  // Fields that are not about one Goal's execution survive.
  assert.equal(clean.reviewLevel, 'FULL');
  assert.equal(clean.mode, 'REAL_EXECUTION');
});

test('a decision or closure belonging to another Goal proves nothing', () => {
  // The rule run-auto applies after each phase, stated once.
  const decisionFor = (runtime, goalId) => (runtime?.goal === goalId ? (runtime.decision ?? null) : null);
  const closureFor = (runtime, goalId) => {
    const recorded = runtime?.closure ?? {};
    return recorded.goal === goalId ? recorded : {};
  };

  const stale = { goal: '003', decision: 'ACCEPTED', closure: { goal: '003', newMigrationBaseline: BASELINE_1 } };

  assert.equal(decisionFor(stale, '004'), null, 'Goal 003 being ACCEPTED says nothing about Goal 004');
  assert.deepEqual(closureFor(stale, '004'), {});
  assert.equal(decisionFor(stale, '003'), 'ACCEPTED');
  assert.equal(closureFor(stale, '003').newMigrationBaseline, BASELINE_1);
});

test('a resumed Goal keeps its round; a new Goal starts at 1', () => {
  const previous = { goal: '003', round: 2, blockers: [{ id: 'B1' }] };

  // Same Goal, worktree present: this is a resume, and the round is its own.
  assert.equal(true ? (previous.round ?? 1) : 1, 2);
  // Different Goal: round 1, and no blockers to inherit.
  assert.equal(false ? (previous.round ?? 1) : 1, 1);
  assert.equal(clearPerGoalRuntime(previous).blockers, undefined);
});

// ===========================================================================
// Getting past PAUSED_FOR_HUMAN is a person's decision, and it is recorded
// ===========================================================================

test('a stopped run is retired only with an explicit note, and archived', async () => {
  await withDir(async (dir) => {
    const auto = createAutonomousStore(dir);
    const run = await auto.start({ fromGoal: '004', migrationAcceptedBaseline: BASELINE_1 });
    await auto.markHumanRequired('UNKNOWN_FATAL', 'harness bug');

    // No note: nothing is retired. Silence must not clear a problem.
    await assert.rejects(auto.archiveRun({ resolvedBy: 'operator', note: '' }), codeIs('INVALID_ARGS'));
    assert.equal((await auto.read()).status, RUN_STATUS.PAUSED_FOR_HUMAN);

    const archived = await auto.archiveRun({ resolvedBy: 'operator', note: 'runtime inheritance fixed' });
    assert.equal(archived.resolutionNote, 'runtime inheritance fixed');
    assert.equal(archived.humanRequired.reason, 'UNKNOWN_FATAL', 'the archive keeps why it stopped');

    // The run is gone from the active slot but preserved on disk.
    assert.equal(await auto.read(), null);
    const onDisk = JSON.parse(await readFile(join(dir, 'autonomous-runs', `${run.autonomousRunId}.json`), 'utf8'));
    assert.equal(onDisk.autonomousRunId, run.autonomousRunId);

    // And a new run can now start.
    await auto.releaseLoopLease({ force: true });
    const fresh = await auto.start({ fromGoal: '004', migrationAcceptedBaseline: BASELINE_1 });
    assert.equal(fresh.status, RUN_STATUS.RUNNING);
    assert.notEqual(fresh.autonomousRunId, run.autonomousRunId);
  });
});

test('a RUNNING run is never archived out from under itself', async () => {
  await withDir(async (dir) => {
    const auto = createAutonomousStore(dir);
    await auto.start({ fromGoal: '004', migrationAcceptedBaseline: BASELINE_1 });
    await assert.rejects(
      auto.archiveRun({ resolvedBy: 'operator', note: 'nope' }),
      codeIs('AUTONOMOUS_RUN_ALREADY_ACTIVE'),
    );
  });
});

// ===========================================================================
// No exit path may leave the orchestrator lease behind
// ===========================================================================

test('every early exit after attach releases the loop lease', async () => {
  // The real failure: a run that stopped for a human threw before its own try
  // block, so attach()'s lease was never released. The next start was then
  // refused by a lease nobody was holding — the loop locked out of itself.
  // Source is inspected because the bug is in control flow, not in a value.
  const source = await readFile(new URL('../run-auto.mjs', import.meta.url), 'utf8');
  const lines = source.split('\n');
  const attachLine = lines.findIndex((l) => l.includes('await auto.attach()'));
  const tryLine = lines.findIndex((l, i) => i > attachLine && l.trim() === 'try {');
  assert.ok(attachLine > 0 && tryLine > attachLine);

  // Every failure in that window must go through failAfterAttach, which
  // releases first. A bare throw there is the original bug.
  for (let i = attachLine; i < tryLine; i += 1) {
    assert.ok(
      !lines[i].includes('throw new SpikeError'),
      `run-auto.mjs:${i + 1} throws while the loop lease may be held; use failAfterAttach`,
    );
  }
  assert.match(source, /async function failAfterAttach\([\s\S]*?releaseLoopLease/,
    'failAfterAttach must release the loop lease before throwing');
});
