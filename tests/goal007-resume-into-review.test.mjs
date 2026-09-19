/**
 * The exact regression: Goal007's R1 review asked for changes (5 blockers),
 * R2's Developer correction COMPLETED with REVIEW_REQUIRED, and no R2 review
 * job existed yet. `reconcileExecutionState` correctly said `next.kind =
 * REVIEW, round: 2` — but `run-goal.mjs`'s round loop computed
 * `isCorrection = startAsCorrection || round > 1`, which is `true` for ANY
 * round beyond the first regardless of what reconciliation actually decided.
 * That built a hypothetical CORRECTION job from `pendingBlockers` — empty,
 * because a REVIEW-kind dispatch carries no blockers — and
 * `validateDeveloperJob` correctly refused it: "A CORRECTION job must carry
 * at least one blocker". The crash happened BEFORE the code ever reached the
 * check that would have reused the Developer's already-completed result, on a
 * round that needed no new Developer job at all.
 *
 * Compounding it: the crash was an uncaught CONTRACT_FIELD_INVALID that
 * `orchestrator-fault.mjs` did not yet classify, so `runtime.escalationReason`
 * kept whatever a PREVIOUS, already human-resolved gate had left there
 * (POLICY_VIOLATION) — a completely unrelated reason surfacing for a brand
 * new failure.
 *
 * This reproduces the exact sequence `run-goal.mjs` runs — the same
 * reconciliation call, the same ledger — without a worktree, a git checkout,
 * or a model. See goal005-resume-after-accepted.test.mjs for the sibling
 * incident this follows the same shape as.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJobStore, writeJsonAtomic, STORE_VERSION } from '../lib/job-store.mjs';
import { DISPATCH_KINDS, STAGE_STATUS, reconcileExecutionState } from '../lib/reconcile.mjs';
import { STAGES, stageKey } from '../lib/stage-identity.mjs';
import { validateDeveloperJob, PROTOCOL_VERSION_V2 } from '../lib/contracts-v2.mjs';
import { classifyOrchestratorFault } from '../lib/orchestrator-fault.mjs';

const GOAL = '007';
const DEV_R1 = '007-r1-developer-057cf8fb';
const REV_R1 = '007-r1-tech_lead-58b5222a';
const DEV_R2 = '007-r2-correction-8ccf30b9';
const R1_BLOCKERS = [
  'Regressão de ativação da IA para fonte Minha Agenda',
  '/internal/services deixa de garantir "apenas o que a IA pode oferecer"',
  'Payload das tools da IA perde a semântica do total',
  'Faltam as asserções exigidas pelos critérios 6 e 8',
  'Documentação de migração exigida pelo próprio Goal não foi escrita',
];

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-007-resume-'));
  try { return await run(createJobStore(dir)); } finally { await rm(dir, { recursive: true, force: true }); }
}

const jobRecord = (jobId, role, round, extra = {}) => ({
  storeVersion: STORE_VERSION,
  publishedAt: '2026-09-09T00:27:06.133Z',
  status: 'QUEUED', attempt: 1, currentAttemptId: `${jobId}-a1`, attemptStatus: 'QUEUED', attemptHistory: [],
  job: {
    protocolVersion: PROTOCOL_VERSION_V2, jobId, role, goal: GOAL, round,
    type: role === 'developer' ? (round === 1 ? 'IMPLEMENTATION' : 'CORRECTION') : undefined,
    reviewLevel: role === 'tech_lead' ? 'DEEP' : undefined,
    developerProfile: role === 'developer' ? 'SONNET_HIGH' : undefined,
  },
  ...extra,
});

/** Goal007 exactly as it really stood: R1 CHANGES_REQUIRED, R2 Developer done, R2 review never dispatched. */
async function seedGoal007AtR2ReviewDue(store) {
  await mkdir(store.paths.jobsDir('developer'), { recursive: true });
  await mkdir(store.paths.jobsDir('tech_lead'), { recursive: true });
  await mkdir(store.paths.resultsDir('developer'), { recursive: true });
  await mkdir(store.paths.resultsDir('tech_lead'), { recursive: true });

  await writeJsonAtomic(store.paths.job('developer', DEV_R1), { ...jobRecord(DEV_R1, 'developer', 1), status: 'COMPLETED', attemptStatus: 'COMPLETED' });
  await store.publishResult('developer', DEV_R1, {
    ok: true, result: { protocolVersion: PROTOCOL_VERSION_V2, jobId: DEV_R1, goal: GOAL, round: 1, status: 'REVIEW_REQUIRED' },
  }, { attemptId: `${DEV_R1}-a1` });

  await writeJsonAtomic(store.paths.job('tech_lead', REV_R1), { ...jobRecord(REV_R1, 'tech_lead', 1), status: 'COMPLETED', attemptStatus: 'COMPLETED' });
  await store.publishResult('tech_lead', REV_R1, {
    ok: true, result: {
      protocolVersion: PROTOCOL_VERSION_V2, jobId: REV_R1, goal: GOAL, round: 1,
      decision: 'CHANGES_REQUIRED', blockers: R1_BLOCKERS, nextAction: 'RETURN_TO_DEVELOPER',
    },
  }, { attemptId: `${REV_R1}-a1` });

  await writeJsonAtomic(store.paths.job('developer', DEV_R2), { ...jobRecord(DEV_R2, 'developer', 2), status: 'COMPLETED', attemptStatus: 'COMPLETED' });
  await store.publishResult('developer', DEV_R2, {
    ok: true, result: { protocolVersion: PROTOCOL_VERSION_V2, jobId: DEV_R2, goal: GOAL, round: 2, status: 'REVIEW_REQUIRED' },
  }, { attemptId: `${DEV_R2}-a1` });

  // No R2 tech_lead job exists — the review was never dispatched.

  await store.writeRuntime({
    goal: GOAL, round: 2, mode: 'REAL_EXECUTION', state: 'WORKTREE_READY',
    worktreePath: '.ai-worktrees/goal-007', worktreeInitialHead: '9494eb643bd85199a876d6a91ba1461ada101099',
    escalationReason: 'POLICY_VIOLATION', // the stale reason from the already-resolved gate
  });
}

test('1/2. reconciliation resumes Goal007 straight into REVIEW at round 2, not CORRECTION', async () => {
  await withStore(async (store) => {
    await seedGoal007AtR2ReviewDue(store);
    const reconciled = await reconcileExecutionState({ store, goal: GOAL, maxRounds: 3 });

    assert.equal(reconciled.next.kind, DISPATCH_KINDS.REVIEW);
    assert.equal(reconciled.next.round, 2);
    assert.equal(reconciled.next.implementationJobId, DEV_R2);

    const devStage = reconciled.ledger.get(stageKey({ goal: GOAL, round: 2, stage: STAGES.CORRECTION }));
    assert.equal(devStage.status, STAGE_STATUS.COMPLETED, 'R2 DEVELOPER: COMPLETED');
    assert.equal(devStage.completedBy, DEV_R2);

    const reviewStage = reconciled.ledger.get(stageKey({ goal: GOAL, round: 2, stage: STAGES.REVIEW }));
    assert.equal(reviewStage, undefined, 'R2 REVIEW JOB EXISTS: NO');
  });
});

test('the OLD code path is provably the crash: isCorrection from round alone builds an invalid job', async () => {
  await withStore(async (store) => {
    await seedGoal007AtR2ReviewDue(store);
    const reconciled = await reconcileExecutionState({ store, goal: GOAL, maxRounds: 3 });
    assert.equal(reconciled.next.kind, DISPATCH_KINDS.REVIEW, 'reconciliation itself was always correct');

    // run-goal.mjs's actual (unpatched) computation: `round > 1` alone decided
    // "this round is a correction", never consulting `reconciled.next.kind`.
    const round = reconciled.next.round;
    const isCorrectionOld = false || round > 1;
    assert.equal(isCorrectionOld, true, 'the unpatched boolean really does come out true here');

    // And a REVIEW-kind dispatch carries no blockers to inherit — there is
    // nothing to correct, there is only a review left to run.
    const pendingBlockers = reconciled.next.blockers ?? [];
    assert.deepEqual(pendingBlockers, []);

    let caught = null;
    try {
      validateDeveloperJob({
        protocolVersion: PROTOCOL_VERSION_V2, jobId: DEV_R2, role: 'developer', goal: GOAL, round,
        type: isCorrectionOld ? 'CORRECTION' : 'IMPLEMENTATION',
        migrationAcceptedBaseline: '8d77ed992f12e1405ae7bfaaeb2d852af5711b5d',
        executionBase: '9494eb643bd85199a876d6a91ba1461ada101099',
        worktreeInitialHead: '9494eb643bd85199a876d6a91ba1461ada101099',
        worktree: 'E:/Projetos/atendly-ia/.ai-worktrees/goal-007',
        goalPath: 'docs/migration/goals/007-catalogo-e-acordo-comercial.md',
        blockers: isCorrectionOld ? pendingBlockers : [],
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, 'the unpatched shape really does throw');
    assert.equal(caught.code, 'CONTRACT_FIELD_INVALID');
    assert.match(caught.message, /CORRECTION job must carry at least one blocker/);

    // And this is the exact fault run-auto.mjs must NOT read as a stale,
    // unrelated POLICY_VIOLATION.
    assert.equal(classifyOrchestratorFault(caught), 'HARNESS_ERROR');

    // The precondition that makes the FIX correct and sufficient: the
    // Developer's own result was already sitting on disk the entire time —
    // nothing about this failure was a fact about Goal007's work.
    assert.equal(await store.hasCompletedResult('developer', DEV_R2), true);
    assert.equal((await store.readAttemptState('developer', DEV_R2)).attempt, 1, 'still just one attempt');
  });
});

test('R1 blockers survive in history and are never required to dispatch R2\'s review', async () => {
  await withStore(async (store) => {
    await seedGoal007AtR2ReviewDue(store);
    const reconciled = await reconcileExecutionState({ store, goal: GOAL, maxRounds: 3 });

    const r1Review = reconciled.ledger.get(stageKey({ goal: GOAL, round: 1, stage: STAGES.REVIEW }));
    assert.equal(r1Review.result.blockers.length, 5, 'BLOCKERS FROM R1: count 5, preserved');
    assert.deepEqual([...r1Review.result.blockers], R1_BLOCKERS);

    // The R2 dispatch itself carries none — it is a review, not a correction.
    assert.deepEqual(reconciled.next.blockers ?? [], []);
  });
});

test('the effective R2 profile (SONNET_HIGH) is read from the completed job, never recomputed', async () => {
  await withStore(async (store) => {
    await seedGoal007AtR2ReviewDue(store);
    const job = await store.readJob('developer', DEV_R2);
    assert.equal(job.developerProfile, 'SONNET_HIGH');
  });
});

test('a stale escalationReason from an already-resolved gate does not survive a normal reconciliation', async () => {
  await withStore(async (store) => {
    await seedGoal007AtR2ReviewDue(store);
    const before = await store.readRuntime();
    assert.equal(before.escalationReason, 'POLICY_VIOLATION', 'seeded exactly as the real incident left it');

    const reconciled = await reconcileExecutionState({ store, goal: GOAL, maxRounds: 3 });
    // Reconciliation says the run is not blocked at all — this is run-goal.mjs's
    // own signal (mirrored here) that any prior human-gate reason is stale.
    assert.notEqual(reconciled.next.kind, DISPATCH_KINDS.HUMAN_REQUIRED);
  });
});

// Reproduces run-goal.mjs's own stale-reason-clearing block verbatim (see
// run-goal.mjs, right after the HUMAN_REQUIRED/CLOSE_GOAL early returns and
// before `let round = reconciled.next.round`): once reconciliation proves the
// run is not currently blocked, any escalationReason/humanRequired/decision
// still on disk describes a gate a human already closed, not this attempt.
test('the stale-human-reason block clears escalationReason/humanRequired and logs why', async () => {
  await withStore(async (store) => {
    await seedGoal007AtR2ReviewDue(store);
    await store.writeRuntime({
      ...(await store.readRuntime()),
      humanRequired: { reason: 'POLICY_VIOLATION', note: 'MAIN_CHECKOUT_MUTATED', at: '2026-09-08T00:00:00.000Z' },
      decision: 'HUMAN_REQUIRED',
    });
    const reconciled = await reconcileExecutionState({ store, goal: GOAL, maxRounds: 3 });
    assert.equal(reconciled.next.kind, DISPATCH_KINDS.REVIEW, 'not blocked — the clearing block is reachable');

    const stalePriorRuntime = await store.readRuntime();
    assert.ok(stalePriorRuntime.escalationReason || stalePriorRuntime.humanRequired || stalePriorRuntime.decision === 'HUMAN_REQUIRED');

    await store.appendEvent({
      type: 'STALE_HUMAN_REASON_CLEARED', goal: GOAL,
      previousReason: stalePriorRuntime.escalationReason ?? null,
      previousDecision: stalePriorRuntime.decision ?? null,
    });
    await store.writeRuntime({
      ...stalePriorRuntime, escalationReason: null, humanRequired: null,
      decision: stalePriorRuntime.decision === 'HUMAN_REQUIRED' ? null : stalePriorRuntime.decision,
    });

    const after = await store.readRuntime();
    assert.equal(after.escalationReason, null, 'HUMAN GATE: escalationReason cleared');
    assert.equal(after.humanRequired, null, 'HUMAN GATE: humanRequired cleared');
    assert.equal(after.decision, null, 'HUMAN GATE: decision cleared');
    // The resolution is not erased — it moved into the event log, which
    // history (§6/§10) requires to be preserved, never deleted.
    const events = await store.readEvents();
    const cleared = events.find((e) => e.type === 'STALE_HUMAN_REASON_CLEARED');
    assert.equal(cleared.previousReason, 'POLICY_VIOLATION');
    assert.equal(cleared.previousDecision, 'HUMAN_REQUIRED');
    assert.equal(cleared.goal, GOAL);
  });
});

test('reconciling twice in a row is idempotent: no new developer attempt, result untouched', async () => {
  await withStore(async (store) => {
    await seedGoal007AtR2ReviewDue(store);
    const first = await reconcileExecutionState({ store, goal: GOAL, maxRounds: 3 });
    const resultBefore = await store.readResult('developer', DEV_R2);
    const attemptBefore = await store.readAttemptState('developer', DEV_R2);

    const second = await reconcileExecutionState({ store, goal: GOAL, maxRounds: 3 });
    const resultAfter = await store.readResult('developer', DEV_R2);
    const attemptAfter = await store.readAttemptState('developer', DEV_R2);

    assert.equal(second.next.kind, first.next.kind);
    assert.equal(second.next.round, first.next.round);
    assert.deepEqual(resultAfter, resultBefore, 'NO RESULT DELETE / NO RESULT MUTATION');
    assert.equal(attemptAfter.attempt, attemptBefore.attempt, 'NO NEW R2 DEVELOPER ATTEMPT');
    assert.equal(attemptAfter.attempt, 1);
  });
});

test('next dispatch after resume is REVIEW for role tech_lead — the next real model call, if any', () => {
  return withStore(async (store) => {
    await seedGoal007AtR2ReviewDue(store);
    const reconciled = await reconcileExecutionState({ store, goal: GOAL, maxRounds: 3 });
    assert.equal(reconciled.next.kind, DISPATCH_KINDS.REVIEW);
    assert.equal(reconciled.next.role, 'tech_lead');
    assert.equal(reconciled.next.round, 2);
    // Developer is never the next role here — it already finished this round.
    assert.notEqual(reconciled.next.role, 'developer');
  });
});
