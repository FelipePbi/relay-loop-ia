/**
 * Goal 005 R2, exactly as it happened.
 *
 *   Review a1 (round 2)   WAITING_FOR_CAPACITY / USAGE_LIMIT
 *   Review a2 (round 2)   COMPLETED, decision ACCEPTED, no blockers
 *
 * The live orchestrator process was asleep in `waitForResult`, fenced on a1.
 * `result-waiter.mjs` is what stops that going forward. This file covers the
 * OTHER half: a runtime snapshot left over from before that fix — state
 * REVIEWER_RUNNING, decision still CHANGES_REQUIRED from round 1 — must still
 * be repairable from the facts already on disk, without re-running anything.
 *
 * `runtimeInFlightStale` in runtime-reconciliation.mjs is what proves it: the
 * runtime claims round 2's review is still running, and the ledger shows that
 * exact stage COMPLETED with a decisive result.
 *
 * No model is called anywhere in this file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJobStore, writeJsonAtomic, STORE_VERSION } from '../lib/job-store.mjs';
import { assessRuntimeDivergence, reconcileRuntimeFromResults } from '../lib/runtime-reconciliation.mjs';
import { DISPATCH_KINDS } from '../lib/reconcile.mjs';
import { LOOP_STATES } from '../lib/loop-state.mjs';
import { PROTOCOL_VERSION_V2 } from '../lib/contracts-v2.mjs';

const GOAL = '005';
const DEV_R1 = '005-r1-developer-b218cf51';
const REV_R1 = '005-r1-tech_lead-ca1d7bf4';
const DEV_R2 = '005-r2-correction-7c3288b0';
const REV_R2 = '005-r2-tech_lead-8eec8bd3';
const SHA_BASE = '8551717940a58128a2af4c40cffeb977334860a5';
const SHA_ACCEPTED = 'ecaf7058f2b81ffe4bd4d2966e233b4b58c16dd5';

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-005-r2-'));
  try {
    return await run(createJobStore(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const jobRecord = (jobId, role, round, extra = {}) => ({
  storeVersion: STORE_VERSION,
  publishedAt: '2026-09-08T02:58:46.281Z',
  status: 'QUEUED',
  attempt: 1,
  currentAttemptId: `${jobId}-a1`,
  attemptStatus: 'QUEUED',
  attemptHistory: [],
  job: {
    protocolVersion: PROTOCOL_VERSION_V2,
    jobId, role, goal: GOAL, round,
    reviewLevel: role === 'tech_lead' ? 'DEEP' : undefined,
    type: role === 'developer' ? (round === 1 ? 'IMPLEMENTATION' : 'CORRECTION') : undefined,
    migrationAcceptedBaseline: SHA_ACCEPTED,
    executionBase: SHA_BASE,
    worktree: 'E:/w/.ai-worktrees/goal-005',
    goalPath: 'docs/migration/goals/005-x.md',
    blockers: [],
  },
  ...extra,
});

async function seedJobsForRound1And2(store) {
  await mkdir(store.paths.jobsDir('developer'), { recursive: true });
  await mkdir(store.paths.jobsDir('tech_lead'), { recursive: true });
  await mkdir(store.paths.resultsDir('developer'), { recursive: true });
  await mkdir(store.paths.resultsDir('tech_lead'), { recursive: true });

  // R1: developer done, review CHANGES_REQUIRED with two blockers.
  await writeJsonAtomic(store.paths.job('developer', DEV_R1), {
    ...jobRecord(DEV_R1, 'developer', 1), status: 'COMPLETED', attemptStatus: 'COMPLETED',
  });
  await store.publishResult('developer', DEV_R1, {
    ok: true, result: { protocolVersion: PROTOCOL_VERSION_V2, jobId: DEV_R1, goal: GOAL, round: 1, status: 'REVIEW_REQUIRED' },
  }, { attemptId: `${DEV_R1}-a1` });

  await writeJsonAtomic(store.paths.job('tech_lead', REV_R1), {
    ...jobRecord(REV_R1, 'tech_lead', 1), status: 'COMPLETED', attemptStatus: 'COMPLETED',
  });
  await store.publishResult('tech_lead', REV_R1, {
    ok: true,
    result: {
      protocolVersion: PROTOCOL_VERSION_V2, jobId: REV_R1, goal: GOAL, round: 1,
      decision: 'CHANGES_REQUIRED', blockers: ['P1', 'P2'], nextAction: 'RETURN_TO_DEVELOPER',
    },
  }, { attemptId: `${REV_R1}-a1` });

  // R2: developer (correction) done.
  await writeJsonAtomic(store.paths.job('developer', DEV_R2), {
    ...jobRecord(DEV_R2, 'developer', 2), status: 'COMPLETED', attemptStatus: 'COMPLETED',
  });
  await store.publishResult('developer', DEV_R2, {
    ok: true, result: { protocolVersion: PROTOCOL_VERSION_V2, jobId: DEV_R2, goal: GOAL, round: 2, status: 'REVIEW_REQUIRED' },
  }, { attemptId: `${DEV_R2}-a1` });

  // R2 review: a1 hits capacity, a2 materialises.
  await writeJsonAtomic(store.paths.job('tech_lead', REV_R2), {
    ...jobRecord(REV_R2, 'tech_lead', 2), status: 'WAITING_FOR_CAPACITY', attemptStatus: 'WAITING_FOR_CAPACITY',
  });
  const a2 = await store.startNextAttempt('tech_lead', REV_R2, { reason: 'USAGE_LIMIT' });

  // The stale runtime a live orchestrator, fenced on a1, would still show.
  await store.writeRuntime({
    goal: GOAL, round: 2, mode: 'REAL_EXECUTION',
    state: LOOP_STATES.REVIEWER_RUNNING,
    decision: 'CHANGES_REQUIRED', // left over from round 1
    roundsRun: [{ round: 1, decision: 'CHANGES_REQUIRED', blockers: 2 }],
    executionBase: SHA_BASE, worktreeInitialHead: SHA_BASE, migrationAcceptedBaseline: SHA_ACCEPTED,
    currentJobId: REV_R2,
  });

  return { a2: a2.attemptId };
}

// --- The regression itself --------------------------------------------------

test('a REVIEWER_RUNNING runtime is diverged once the review it names is actually COMPLETED', async () => {
  await withStore(async (store) => {
    const { a2 } = await seedJobsForRound1And2(store);
    await store.publishResult('tech_lead', REV_R2, {
      ok: true,
      result: { protocolVersion: PROTOCOL_VERSION_V2, jobId: REV_R2, goal: GOAL, round: 2, decision: 'ACCEPTED', blockers: [], nextAction: 'STOP' },
    }, { attemptId: a2 });
    await store.setJobStatus('tech_lead', REV_R2, 'COMPLETED');

    const assessment = await assessRuntimeDivergence(store, { goal: GOAL });
    assert.equal(assessment.runtimeState, LOOP_STATES.REVIEWER_RUNNING);
    assert.equal(assessment.runtimeInFlightStale, true);
    assert.equal(assessment.diverged, true);
    assert.equal(assessment.next.kind, DISPATCH_KINDS.CLOSE_GOAL);
    assert.equal(assessment.latestReview.decision, 'ACCEPTED');
  });
});

test('reconciliation converges REVIEWER_RUNNING to CLOSE_GOAL, never calling a model', async () => {
  await withStore(async (store) => {
    const { a2 } = await seedJobsForRound1And2(store);
    await store.publishResult('tech_lead', REV_R2, {
      ok: true,
      result: { protocolVersion: PROTOCOL_VERSION_V2, jobId: REV_R2, goal: GOAL, round: 2, decision: 'ACCEPTED', blockers: [], nextAction: 'STOP' },
    }, { attemptId: a2 });
    await store.setJobStatus('tech_lead', REV_R2, 'COMPLETED');

    const applied = await reconcileRuntimeFromResults(store, { goal: GOAL, reason: 'ATTEMPT_WAIT_HANDOFF_CONSUMED' });
    const runtime = applied.runtime;

    assert.equal(runtime.state, LOOP_STATES.ACCEPTED);
    assert.equal(runtime.round, 2);
    assert.equal(runtime.decision, 'ACCEPTED');
    assert.equal(runtime.blockers.length, 0);
    // Both rounds are represented, not just the one the stale runtime knew about.
    assert.deepEqual(runtime.roundsRun, [
      { round: 1, decision: 'CHANGES_REQUIRED', blockers: 2 },
      { round: 2, decision: 'ACCEPTED', blockers: 0 },
    ]);

    // Nothing new was dispatched, and no third attempt exists.
    assert.equal((await store.readAttemptState('tech_lead', REV_R2)).attempt, 2);
    assert.equal(await store.hasCompletedResult('developer', DEV_R2), true);

    const events = await store.readEvents();
    const audit = events.find((e) => e.type === 'RUNTIME_RECONCILED_FROM_COMPLETED_RESULT');
    assert.equal(audit.authoritativeDecision, 'ACCEPTED');
    assert.equal(audit.nextKind, DISPATCH_KINDS.CLOSE_GOAL);
    assert.equal(audit.attemptId, a2);
  });
});

// --- No false positive on genuinely active work -----------------------------

test('a review genuinely still in flight (no result yet) is never flagged as diverged', async () => {
  await withStore(async (store) => {
    await seedJobsForRound1And2(store);
    // a2 exists, QUEUED, but has not answered — the review really is running.
    await assert.rejects(
      () => reconcileRuntimeFromResults(store, { goal: GOAL }),
      (e) => e.code === 'NOTHING_TO_RECONCILE',
    );
    const assessment = await assessRuntimeDivergence(store, { goal: GOAL });
    assert.equal(assessment.runtimeInFlightStale, false);
    assert.equal(assessment.diverged, false);
  });
});

// --- Deliberately out of scope: never reconciles TOWARD a human gate -------

test('an in-flight-stale runtime whose facts land on HUMAN_REQUIRED is left for the live process, not patched here', async () => {
  await withStore(async (store) => {
    const { a2 } = await seedJobsForRound1And2(store);
    await store.publishResult('tech_lead', REV_R2, {
      ok: true,
      result: { protocolVersion: PROTOCOL_VERSION_V2, jobId: REV_R2, goal: GOAL, round: 2, decision: 'HUMAN_REQUIRED', blockers: [], nextAction: 'HUMAN_REQUIRED' },
    }, { attemptId: a2 });
    await store.setJobStatus('tech_lead', REV_R2, 'COMPLETED');

    const assessment = await assessRuntimeDivergence(store, { goal: GOAL });
    assert.equal(assessment.next.kind, DISPATCH_KINDS.HUMAN_REQUIRED);
    // Still REVIEWER_RUNNING-shaped in-flight staleness, but this module
    // refuses to write a human gate on its own — see runtime-reconciliation.mjs.
    assert.equal(assessment.runtimeInFlightStale, false);
    assert.equal(assessment.diverged, false);

    await assert.rejects(
      () => reconcileRuntimeFromResults(store, { goal: GOAL }),
      (e) => e.code === 'NOTHING_TO_RECONCILE',
    );
  });
});
