/**
 * The exact regression: Goal007 R2's review returned CHANGES_REQUIRED with one
 * blocker and an explicit Tech Lead escalation to SONNET_MEDIUM for round 3.
 * `run-goal.mjs`, in the SAME process (no restart), reacted correctly —
 * `REVIEWER_RUNNING -> CHANGES_REQUIRED -> CORRECTION_QUEUED` — persisted the
 * round-3 blockers and profile, then looped back (`continue`) to start round
 * 3. The top of that loop unconditionally re-asked the machine for
 * `CORRECTION_QUEUED`, the exact state it was already sitting in, and the
 * registry correctly has no `CORRECTION_QUEUED -> CORRECTION_QUEUED` edge —
 * self-transitions are not a real step. The crash message was verbatim:
 * "Transition CORRECTION_QUEUED -> CORRECTION_QUEUED is not allowed".
 *
 * There are two call sites that can legitimately need the machine to reach
 * `CORRECTION_QUEUED`:
 *
 *   run-goal.mjs:865  CHANGES_REQUIRED -> CORRECTION_QUEUED
 *                     the one edge the registry defines for CHANGES_REQUIRED;
 *                     this is where round/blockers/profile are persisted —
 *                     the actual "prepare the next round" step.
 *   run-goal.mjs:594  WORKTREE_READY -> CORRECTION_QUEUED (or DEVELOPER_QUEUED)
 *                     the per-round loop entry, needed when a COLD PROCESS
 *                     resumes straight into a queued correction round and has
 *                     never touched the machine before.
 *
 * The second is only ever redundant when the SAME process's SAME `machine`
 * object already ran the first in this iteration span — which is provable
 * from the file's own transitionTo call sites (`grep transitionTo` finds
 * exactly one CORRECTION_QUEUED/DEVELOPER_QUEUED-setting call besides this
 * one: line 865, CHANGES_REQUIRED's only edge). The fix is a guard scoped to
 * that fact, not a new self-transition edge in the registry — see
 * lib/state-registry.mjs, unchanged by this fix, and the test below that
 * proves a genuine, unguarded self-transition attempt still throws.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJobStore, writeJsonAtomic, STORE_VERSION } from '../lib/job-store.mjs';
import { DISPATCH_KINDS, STAGE_STATUS, reconcileExecutionState, buildStageLedger, decideNextDispatch } from '../lib/reconcile.mjs';
import { STAGES, stageKey } from '../lib/stage-identity.mjs';
import { PROTOCOL_VERSION_V2 } from '../lib/contracts-v2.mjs';
import { ALLOWED_TRANSITIONS, LOOP_STATES, createLoopStateMachine } from '../lib/loop-state.mjs';
import { SpikeError } from '../lib/claude-process.mjs';
import { classifyOrchestratorFault } from '../lib/orchestrator-fault.mjs';
import { resolveProfileForRound, PROFILE_SOURCES } from '../lib/profile-routing.mjs';

// ---------------------------------------------------------------------------
// Section A — the state machine itself, no store, no job.
// ---------------------------------------------------------------------------

test('the registry defines exactly one forward edge for CHANGES_REQUIRED: CORRECTION_QUEUED', () => {
  assert.deepEqual(ALLOWED_TRANSITIONS.CHANGES_REQUIRED, ['AWAITING_HUMAN', 'CORRECTION_QUEUED']);
});

test('CORRECTION_QUEUED has no self-edge — the registry was never changed to allow one', () => {
  assert.ok(!ALLOWED_TRANSITIONS.CORRECTION_QUEUED.includes('CORRECTION_QUEUED'));
  assert.ok(!ALLOWED_TRANSITIONS.DEVELOPER_QUEUED.includes('DEVELOPER_QUEUED'));
});

test('a genuine, unguarded self-transition still throws INVALID_TRANSITION (no generic bypass was added)', () => {
  const machine = createLoopStateMachine({ initialState: LOOP_STATES.CORRECTION_QUEUED });
  let caught = null;
  try {
    machine.transitionTo(LOOP_STATES.CORRECTION_QUEUED);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'the registry itself still refuses this — only the ONE call site in run-goal.mjs got a guard');
  assert.equal(caught.code, 'INVALID_TRANSITION');
  assert.equal(caught.message, 'Transition CORRECTION_QUEUED -> CORRECTION_QUEUED is not allowed');
  assert.equal(classifyOrchestratorFault(caught), 'HARNESS_ERROR', 'preserved taxonomy: HARNESS_ERROR, never POLICY_VIOLATION/AGENT_CONTRACT_ERROR/UNKNOWN_FATAL/CAPACITY');
});

test('OLD run-goal.mjs sequence: prepare (CHANGES_REQUIRED->CORRECTION_QUEUED) then an unconditional re-queue crashes exactly as reported', () => {
  const machine = createLoopStateMachine({ initialState: LOOP_STATES.REVIEWER_RUNNING });
  // The review just decided CHANGES_REQUIRED — the real, authoritative queuing step.
  machine.transitionTo(LOOP_STATES.CHANGES_REQUIRED);
  machine.transitionTo(LOOP_STATES.CORRECTION_QUEUED);
  assert.equal(machine.state, LOOP_STATES.CORRECTION_QUEUED);

  // The loop continues into round 3's iteration. The OLD line 594 asked again,
  // unconditionally.
  const phaseQueued = LOOP_STATES.CORRECTION_QUEUED;
  let caught = null;
  try {
    machine.transitionTo(phaseQueued);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'reproduces the real Goal007 crash');
  assert.equal(caught.code, 'INVALID_TRANSITION');
  assert.equal(caught.message, 'Transition CORRECTION_QUEUED -> CORRECTION_QUEUED is not allowed');
});

test('FIXED run-goal.mjs sequence: the same continuation never re-queues, and CORRECTION_QUEUED is entered exactly once', () => {
  const machine = createLoopStateMachine({ initialState: LOOP_STATES.REVIEWER_RUNNING });
  machine.transitionTo(LOOP_STATES.CHANGES_REQUIRED);
  machine.transitionTo(LOOP_STATES.CORRECTION_QUEUED); // run-goal.mjs:865 — the one real queuing step

  const phaseQueued = LOOP_STATES.CORRECTION_QUEUED;
  // run-goal.mjs:594, fixed:
  if (machine.state !== phaseQueued) machine.transitionTo(phaseQueued);

  assert.equal(machine.state, LOOP_STATES.CORRECTION_QUEUED, 'still correctly queued');
  const queuedEntries = machine.history.filter((h) => h.to === LOOP_STATES.CORRECTION_QUEUED);
  assert.equal(queuedEntries.length, 1, 'entered CORRECTION_QUEUED exactly once, not twice');
  assert.equal(queuedEntries[0].from, LOOP_STATES.CHANGES_REQUIRED, 'the one entry is the real CHANGES_REQUIRED->CORRECTION_QUEUED edge');
});

test('a COLD process resuming a correction round still legitimately reaches CORRECTION_QUEUED once', () => {
  // A fresh process's machine starts the round loop at WORKTREE_READY (line
  // 275) and has never touched CORRECTION_QUEUED before — the guard must not
  // block this, the only real queuing step available to this process.
  const machine = createLoopStateMachine({ initialState: LOOP_STATES.WORKTREE_READY });
  const phaseQueued = LOOP_STATES.CORRECTION_QUEUED;
  if (machine.state !== phaseQueued) machine.transitionTo(phaseQueued);
  assert.equal(machine.state, LOOP_STATES.CORRECTION_QUEUED);
  assert.equal(machine.history.length, 1);
  assert.equal(machine.history[0].from, LOOP_STATES.WORKTREE_READY);
});

test('the guard never masks an actually-invalid target: DEVELOPER_QUEUED -> CORRECTION_QUEUED still throws', () => {
  const machine = createLoopStateMachine({ initialState: LOOP_STATES.DEVELOPER_QUEUED });
  const phaseQueued = LOOP_STATES.CORRECTION_QUEUED;
  assert.notEqual(machine.state, phaseQueued, 'precondition: guard would not fire here');
  assert.throws(() => {
    if (machine.state !== phaseQueued) machine.transitionTo(phaseQueued);
  }, (error) => error.code === 'INVALID_TRANSITION');
});

// ---------------------------------------------------------------------------
// Section B — reconciliation and dispatch for the real Goal007 R2->R3 case.
// ---------------------------------------------------------------------------

const GOAL = '007';
const DEV_R1 = '007-r1-developer-057cf8fb';
const REV_R1 = '007-r1-tech_lead-58b5222a';
const DEV_R2 = '007-r2-correction-8ccf30b9';
const REV_R2 = '007-r2-tech_lead-be8887fc';
const R2_BLOCKER = 'R2-01 (P1): validate:integration fails at the constraints-count assertion in goal007-migration-rehearsal.mjs';

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-007-r3-'));
  try { return await run(createJobStore(dir)); } finally { await rm(dir, { recursive: true, force: true }); }
}

const jobRecord = (jobId, role, round, extra = {}) => ({
  storeVersion: STORE_VERSION,
  publishedAt: '2026-09-09T04:42:00.000Z',
  status: 'QUEUED', attempt: 1, currentAttemptId: `${jobId}-a1`, attemptStatus: 'QUEUED', attemptHistory: [],
  job: {
    protocolVersion: PROTOCOL_VERSION_V2, jobId, role, goal: GOAL, round,
    type: role === 'developer' ? (round === 1 ? 'IMPLEMENTATION' : 'CORRECTION') : undefined,
  },
  ...extra,
});

/** Goal007 exactly as it really stood right before the crash: R2 reviewed CHANGES_REQUIRED, R3 never dispatched. */
async function seedGoal007AtR3CorrectionDue(store, { r3JobId = null, r3Status = null, r3HasResult = false } = {}) {
  for (const role of ['developer', 'tech_lead']) {
    await mkdir(store.paths.jobsDir(role), { recursive: true });
    await mkdir(store.paths.resultsDir(role), { recursive: true });
  }

  await writeJsonAtomic(store.paths.job('developer', DEV_R1), { ...jobRecord(DEV_R1, 'developer', 1), status: 'COMPLETED', attemptStatus: 'COMPLETED' });
  await store.publishResult('developer', DEV_R1, {
    ok: true, result: { protocolVersion: PROTOCOL_VERSION_V2, jobId: DEV_R1, goal: GOAL, round: 1, status: 'REVIEW_REQUIRED' },
  }, { attemptId: `${DEV_R1}-a1` });

  await writeJsonAtomic(store.paths.job('tech_lead', REV_R1), { ...jobRecord(REV_R1, 'tech_lead', 1), status: 'COMPLETED', attemptStatus: 'COMPLETED' });
  await store.publishResult('tech_lead', REV_R1, {
    ok: true, result: {
      protocolVersion: PROTOCOL_VERSION_V2, jobId: REV_R1, goal: GOAL, round: 1,
      decision: 'CHANGES_REQUIRED', blockers: ['R1-01', 'R1-02', 'R1-03', 'R1-04', 'R1-05'], nextAction: 'RETURN_TO_DEVELOPER',
    },
  }, { attemptId: `${REV_R1}-a1` });

  await writeJsonAtomic(store.paths.job('developer', DEV_R2), { ...jobRecord(DEV_R2, 'developer', 2), status: 'COMPLETED', attemptStatus: 'COMPLETED' });
  await store.publishResult('developer', DEV_R2, {
    ok: true, result: { protocolVersion: PROTOCOL_VERSION_V2, jobId: DEV_R2, goal: GOAL, round: 2, status: 'REVIEW_REQUIRED' },
  }, { attemptId: `${DEV_R2}-a1` });

  await writeJsonAtomic(store.paths.job('tech_lead', REV_R2), { ...jobRecord(REV_R2, 'tech_lead', 2), status: 'COMPLETED', attemptStatus: 'COMPLETED' });
  await store.publishResult('tech_lead', REV_R2, {
    ok: true, result: {
      protocolVersion: PROTOCOL_VERSION_V2, jobId: REV_R2, goal: GOAL, round: 2,
      decision: 'CHANGES_REQUIRED', blockers: [R2_BLOCKER],
      nextDeveloperProfile: 'SONNET_MEDIUM',
      nextDeveloperProfileReason: 'Correção localizada de uma asserção de contagem em script de ensaio, sem tocar migrations, contratos ou domínio.',
    },
  }, { attemptId: `${REV_R2}-a1` });

  if (r3JobId) {
    await writeJsonAtomic(store.paths.job('developer', r3JobId), { ...jobRecord(r3JobId, 'developer', 3), status: r3Status, attemptStatus: r3Status });
    if (r3HasResult) {
      await store.publishResult('developer', r3JobId, {
        ok: true, result: { protocolVersion: PROTOCOL_VERSION_V2, jobId: r3JobId, goal: GOAL, round: 3, status: 'REVIEW_REQUIRED' },
      }, { attemptId: `${r3JobId}-a1` });
    }
  }
}

test('Review R2 CHANGES_REQUIRED reconciles to a CORRECTION dispatch for round 3', async () => {
  await withStore(async (store) => {
    await seedGoal007AtR3CorrectionDue(store);
    const reconciled = await reconcileExecutionState({ store, goal: GOAL, maxRounds: 3 });

    assert.equal(reconciled.next.kind, DISPATCH_KINDS.CORRECTION);
    assert.equal(reconciled.next.round, 3);
    assert.equal(reconciled.next.role, 'developer');
    assert.equal(reconciled.next.stageKey, '007:r3:correction');
    assert.equal(reconciled.next.fromReviewJobId, REV_R2);
  });
});

test('R3 carries exactly the R2 blocker — R1 blockers are never reused, none are invented', async () => {
  await withStore(async (store) => {
    await seedGoal007AtR3CorrectionDue(store);
    const reconciled = await reconcileExecutionState({ store, goal: GOAL, maxRounds: 3 });

    assert.deepEqual(reconciled.next.blockers, [R2_BLOCKER]);
    assert.equal(reconciled.next.blockers.length, 1);
    assert.ok(!reconciled.next.blockers.some((b) => b.startsWith('R1-')), 'no R1 blocker leaked into R3');
  });
});

test('R3 carries the Tech Lead\'s SONNET_MEDIUM escalation from the R2 review, not a recalculation', async () => {
  await withStore(async (store) => {
    await seedGoal007AtR3CorrectionDue(store);
    const reconciled = await reconcileExecutionState({ store, goal: GOAL, maxRounds: 3 });

    assert.equal(reconciled.next.nextDeveloperProfile, 'SONNET_MEDIUM');
    assert.match(reconciled.next.nextDeveloperProfileReason, /contagem em script de ensaio/);
  });
});

test('resolveProfileForRound: a fresh escalation for round 3 resolves to SONNET_MEDIUM, selected by tech_lead', () => {
  const resolution = resolveProfileForRound({
    goalExecution: { developerProfile: { round: 2, profile: 'SONNET_HIGH' } },
    round: 3,
    techLeadEscalation: { profile: 'SONNET_MEDIUM', reason: 'Correção localizada...' },
  });
  assert.equal(resolution.profile.name, 'SONNET_MEDIUM');
  assert.equal(resolution.profile.model, 'claude-sonnet-5');
  assert.equal(resolution.profile.effort, 'medium');
  assert.equal(resolution.source, PROFILE_SOURCES.TECH_LEAD_ESCALATION);
  assert.equal(resolution.selectedBy, 'tech_lead');
});

test('resolveProfileForRound: once round 3 already persisted SONNET_MEDIUM, a restart re-reads it and never recalculates', () => {
  // Exactly the real Goal007 runtime: DEVELOPER_PROFILE_CHANGED for round 3
  // already landed on disk (before the crash), so a resumed process must not
  // downgrade, promote, or fall back — even without re-supplying the escalation.
  const resolution = resolveProfileForRound({
    goalExecution: { developerProfile: { round: 3, profile: 'SONNET_MEDIUM', reason: 'x', selectedBy: 'tech_lead' } },
    round: 3,
    techLeadEscalation: null,
  });
  assert.equal(resolution.profile.name, 'SONNET_MEDIUM');
  assert.equal(resolution.source, PROFILE_SOURCES.PERSISTED);
  assert.equal(resolution.changed, false);
});

test('R3 stage does not exist yet: exactly one Developer job would be minted, none reused falsely', async () => {
  await withStore(async (store) => {
    await seedGoal007AtR3CorrectionDue(store);
    const reconciled = await reconcileExecutionState({ store, goal: GOAL, maxRounds: 3 });
    assert.equal(reconciled.next.resumeAttempt, null, 'nothing to resume — a fresh job id is correct here');
    assert.equal(reconciled.next.needsNewAttempt, false, 'no stage recorded yet, so this is a first dispatch, not a stuck retry');
    const r3Stage = reconciled.ledger.get('007:r3:correction');
    assert.equal(r3Stage, undefined, 'R3 DEVELOPER JOB EXISTS: NO');
  });
});

test('restart with R3 QUEUED reuses the existing job — never mints a second one', async () => {
  const r3JobId = '007-r3-correction-aaaa1111';
  await withStore(async (store) => {
    await seedGoal007AtR3CorrectionDue(store, { r3JobId, r3Status: 'QUEUED' });
    const reconciled = await reconcileExecutionState({ store, goal: GOAL, maxRounds: 3 });
    assert.equal(reconciled.next.kind, DISPATCH_KINDS.CORRECTION);
    assert.equal(reconciled.next.round, 3);
    assert.equal(reconciled.next.resumeAttempt, r3JobId);
    assert.equal(reconciled.next.needsNewAttempt, false);
  });
});

test('restart with R3 RUNNING is awaited, not redispatched', async () => {
  const r3JobId = '007-r3-correction-bbbb2222';
  await withStore(async (store) => {
    await seedGoal007AtR3CorrectionDue(store, { r3JobId, r3Status: 'RUNNING' });
    const reconciled = await reconcileExecutionState({ store, goal: GOAL, maxRounds: 3 });
    assert.equal(reconciled.next.kind, DISPATCH_KINDS.CORRECTION);
    assert.equal(reconciled.next.resumeAttempt, r3JobId);
    assert.equal(reconciled.next.resumeAttemptStatus, 'RUNNING');
    assert.equal(reconciled.next.needsNewAttempt, false);
  });
});

test('restart with R3 COMPLETED consumes the result and moves straight to R3 review — no re-dispatch', async () => {
  const r3JobId = '007-r3-correction-cccc3333';
  await withStore(async (store) => {
    await seedGoal007AtR3CorrectionDue(store, { r3JobId, r3Status: 'COMPLETED', r3HasResult: true });
    const reconciled = await reconcileExecutionState({ store, goal: GOAL, maxRounds: 3 });
    assert.equal(reconciled.next.kind, DISPATCH_KINDS.REVIEW);
    assert.equal(reconciled.next.round, 3);
    assert.equal(reconciled.next.implementationJobId, r3JobId);
  });
});

test('Review R2 is never re-dispatched: it is COMPLETED and its decision is read once, not recomputed', async () => {
  await withStore(async (store) => {
    await seedGoal007AtR3CorrectionDue(store);
    const hasResult = await store.hasCompletedResult('tech_lead', REV_R2);
    assert.equal(hasResult, true);
    const attempt = await store.readAttemptState('tech_lead', REV_R2);
    assert.equal(attempt.attempt, 1, 'no second Fable attempt for R2');
  });
});

test('Developer R2 is never re-dispatched: it is COMPLETED at attempt 1', async () => {
  await withStore(async (store) => {
    await seedGoal007AtR3CorrectionDue(store);
    const hasResult = await store.hasCompletedResult('developer', DEV_R2);
    assert.equal(hasResult, true);
    const attempt = await store.readAttemptState('developer', DEV_R2);
    assert.equal(attempt.attempt, 1);
  });
});

test('INVALID_TRANSITION from run-goal.mjs\'s own state machine classifies as HARNESS_ERROR, matching the real event log', () => {
  const error = new SpikeError('INVALID_TRANSITION', 'Transition CORRECTION_QUEUED -> CORRECTION_QUEUED is not allowed', {
    from: 'CORRECTION_QUEUED', to: 'CORRECTION_QUEUED',
  });
  assert.equal(classifyOrchestratorFault(error), 'HARNESS_ERROR');
});

test('a HARNESS_ERROR human gate can be reconciled away once the fix removes its cause, without erasing the ORCHESTRATOR_FAULT event', async () => {
  await withStore(async (store) => {
    await seedGoal007AtR3CorrectionDue(store);
    await store.appendEvent({
      type: 'ORCHESTRATOR_FAULT', goal: GOAL, code: 'INVALID_TRANSITION',
      message: 'Transition CORRECTION_QUEUED -> CORRECTION_QUEUED is not allowed', classification: 'HARNESS_ERROR',
    });
    await store.writeRuntime({ goal: GOAL, round: 2, state: 'REVIEWER_RUNNING', escalationReason: 'HARNESS_ERROR', decision: 'CHANGES_REQUIRED' });

    const reconciled = await reconcileExecutionState({ store, goal: GOAL, maxRounds: 3 });
    assert.equal(reconciled.next.kind, DISPATCH_KINDS.CORRECTION, 'not blocked once the ledger is read fresh');

    const before = await store.readRuntime();
    await store.appendEvent({
      type: 'RUNTIME_RECONCILED_AFTER_HARNESS_FIX', goal: GOAL,
      reason: 'DUPLICATE_CORRECTION_QUEUED_TRANSITION', previousEscalationReason: before.escalationReason,
    });
    await store.writeRuntime({ ...before, escalationReason: null });

    const after = await store.readRuntime();
    assert.equal(after.escalationReason, null);
    const events = await store.readEvents();
    // History is never erased — both the original fault and the reconciliation coexist.
    assert.ok(events.find((e) => e.type === 'ORCHESTRATOR_FAULT' && e.code === 'INVALID_TRANSITION'));
    assert.ok(events.find((e) => e.type === 'RUNTIME_RECONCILED_AFTER_HARNESS_FIX'));
  });
});

test('next dispatch after the fix is CORRECTION for role developer — the next real model call, if any', async () => {
  await withStore(async (store) => {
    await seedGoal007AtR3CorrectionDue(store);
    const reconciled = await reconcileExecutionState({ store, goal: GOAL, maxRounds: 3 });
    assert.equal(reconciled.next.kind, DISPATCH_KINDS.CORRECTION);
    assert.equal(reconciled.next.role, 'developer');
    assert.equal(reconciled.next.round, 3);
    assert.notEqual(reconciled.next.role, 'tech_lead', 'Review R2 already happened — the next call is the Developer, not Fable again');
  });
});
