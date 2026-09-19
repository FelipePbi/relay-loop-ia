/**
 * Goal 005 R1, exactly as it happened, and what the runtime must say afterwards.
 *
 *   Developer R1   COMPLETED, reused, never called again
 *   Review a1      USAGE_LIMIT → capacity wait
 *   Review a2      HARNESS_ERROR (argv rejected) → repair authorises a3
 *   Review a3      worker starts FIRST; the orchestrator arrives six seconds
 *                  later and must NOT consume a2's failure
 *   Review a3      finishes: CHANGES_REQUIRED, 2 blockers, OPUS_MEDIUM
 *
 * The runtime had recorded HUMAN_REQUIRED / UNKNOWN_FATAL from the stale read.
 * The results on disk said otherwise the whole time, and the results win.
 *
 * No model is called anywhere in this file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJobStore, writeJsonAtomic, readJson, STORE_VERSION } from '../lib/job-store.mjs';
import { authorizeRetryAfterHarnessFix } from '../lib/harness-retry.mjs';
import { assessRuntimeDivergence, reconcileRuntimeFromResults } from '../lib/runtime-reconciliation.mjs';
import { DISPATCH_KINDS, reconcileExecutionState } from '../lib/reconcile.mjs';
import { LOOP_STATES } from '../lib/loop-state.mjs';
import { PROTOCOL_VERSION_V2 } from '../lib/contracts-v2.mjs';

const GOAL = '005';
const DEV_JOB = '005-r1-developer-b218cf51';
const REV_JOB = '005-r1-tech_lead-ca1d7bf4';
const SHA_BASE = '8551717940a58128a2af4c40cffeb977334860a5';
const SHA_ACCEPTED = 'ecaf7058f2b81ffe4bd4d2966e233b4b58c16dd5';

const BLOCKERS = [
  'blocker one, exactly as the review persisted it',
  'blocker two, exactly as the review persisted it',
];

const ARGV_ERROR = 'CLI exited with code 1: Error: When using --print, --output-format=stream-json requires --verbose';

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-005-'));
  try {
    return await run(createJobStore(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const jobRecord = (jobId, role, extra = {}) => ({
  storeVersion: STORE_VERSION,
  publishedAt: '2026-09-08T02:58:46.281Z',
  status: 'QUEUED',
  attempt: 1,
  currentAttemptId: `${jobId}-a1`,
  attemptStatus: 'QUEUED',
  job: {
    protocolVersion: PROTOCOL_VERSION_V2,
    jobId, role, goal: GOAL, round: 1,
    reviewLevel: role === 'tech_lead' ? 'DEEP' : undefined,
    type: role === 'developer' ? 'IMPLEMENTATION' : undefined,
    migrationAcceptedBaseline: SHA_ACCEPTED,
    executionBase: SHA_BASE,
    worktree: 'E:/w/.ai-worktrees/goal-005',
    goalPath: 'docs/migration/goals/005-x.md',
    blockers: [],
  },
  ...extra,
});

/** Rebuilds Goal 005 up to the moment the repair authorised a3. */
async function goal005UpToA3(store) {
  await mkdir(store.paths.jobsDir('developer'), { recursive: true });
  await mkdir(store.paths.jobsDir('tech_lead'), { recursive: true });
  await mkdir(store.paths.resultsDir('developer'), { recursive: true });
  await mkdir(store.paths.resultsDir('tech_lead'), { recursive: true });

  // --- Developer R1: done, and it stays done ------------------------------
  await writeJsonAtomic(store.paths.job('developer', DEV_JOB), {
    ...jobRecord(DEV_JOB, 'developer'), status: 'COMPLETED', attemptStatus: 'COMPLETED',
  });
  await store.publishResult('developer', DEV_JOB, {
    ok: true,
    result: {
      protocolVersion: PROTOCOL_VERSION_V2, jobId: DEV_JOB, goal: GOAL, round: 1,
      status: 'REVIEW_REQUIRED', summary: 'implementado', implementationReport: 'R1',
    },
  }, { attemptId: `${DEV_JOB}-a1` });

  // --- Review a1: quota, then a2 materialised -----------------------------
  await writeJsonAtomic(store.paths.job('tech_lead', REV_JOB), {
    ...jobRecord(REV_JOB, 'tech_lead'), status: 'WAITING_FOR_CAPACITY', attemptStatus: 'WAITING_FOR_CAPACITY',
  });
  const a2 = await store.startNextAttempt('tech_lead', REV_JOB, { reason: 'USAGE_LIMIT' });
  assert.equal(a2.attemptId, `${REV_JOB}-a2`);

  // --- Review a2: argv rejected before any inference -----------------------
  await store.setJobStatus('tech_lead', REV_JOB, 'FAILED');
  await store.publishResult('tech_lead', REV_JOB, {
    ok: false, code: 'UNKNOWN_FATAL',
    message: 'Unrecoverable failure; a human must look at it.', escalation: 'HUMAN_REQUIRED',
  }, { attemptId: a2.attemptId });
  await store.appendEvent({
    type: 'AGENT_FAILURE', goal: GOAL, round: 1, agent: 'tech_lead',
    jobId: REV_JOB, attemptId: a2.attemptId, reason: 'UNKNOWN_FATAL', code: 'NON_ZERO_EXIT',
    diagnostic: ARGV_ERROR,
  });
  await store.writeRuntime({
    goal: GOAL, round: 1, mode: 'REAL_EXECUTION',
    state: LOOP_STATES.HUMAN_REQUIRED, decision: 'HUMAN_REQUIRED', escalationReason: 'UNKNOWN_FATAL',
    blockedAgent: 'tech_lead', blockedJobId: REV_JOB, roundsRun: [],
    executionBase: SHA_BASE, worktreeInitialHead: SHA_BASE, migrationAcceptedBaseline: SHA_ACCEPTED,
  });

  // --- The tooling fix, then the authorised retry --------------------------
  const authorised = await authorizeRetryAfterHarnessFix(store, {
    role: 'tech_lead', jobId: REV_JOB,
    detail: 'buildArgs now passes --verbose with stream-json',
    fixCommit: 'c198f43',
    resumeFrom: LOOP_STATES.REVIEWER_RUNNING,
  });
  return { a2: a2.attemptId, a3: authorised.successorAttemptId };
}

/** The decision a3 actually produced. */
const a3Decision = {
  protocolVersion: PROTOCOL_VERSION_V2,
  jobId: REV_JOB, goal: GOAL, round: 1,
  decision: 'CHANGES_REQUIRED',
  blockers: BLOCKERS,
  nextAction: 'RETURN_TO_DEVELOPER',
  nextDeveloperProfile: 'OPUS_MEDIUM',
  nextDeveloperProfileReason: 'Multi-service contract change.',
};

// --- 15. The race, reproduced ---------------------------------------------

test('15. the orchestrator arriving after the worker does not consume a2', async () => {
  await withStore(async (store) => {
    const { a2, a3 } = await goal005UpToA3(store);

    // The worker has claimed a3 and is running. The orchestrator starts now.
    await store.setJobStatus('tech_lead', REV_JOB, 'RUNNING');

    // THE regression: before fencing, this returned a2's failure envelope and
    // the Goal stopped for a human 4.5 minutes before a3 finished.
    const stale = [];
    const early = await store.readResult('tech_lead', REV_JOB, {
      expectedAttemptId: a3,
      onStale: (info) => stale.push(info),
    });
    assert.equal(early, null, 'a2 must not answer for a3');

    // The repair also cleared the primary path, so there is nothing left to be
    // stale about — belt and braces, and both are asserted.
    assert.equal(await store.readResult('tech_lead', REV_JOB), null);
    assert.equal(stale.length, 0);
    assert.notEqual(a2, a3);

    // a3 finishes.
    await store.publishResult('tech_lead', REV_JOB, { ok: true, result: a3Decision }, { attemptId: a3 });
    await store.setJobStatus('tech_lead', REV_JOB, 'COMPLETED');

    const consumed = await store.readResult('tech_lead', REV_JOB, { expectedAttemptId: a3 });
    assert.equal(consumed.result.decision, 'CHANGES_REQUIRED');
    assert.equal(consumed.attemptId, a3);
  });
});

// --- 19-22. The results outrank the runtime -------------------------------

test('19. a runtime human gate loses to a completed CHANGES_REQUIRED', async () => {
  await withStore(async (store) => {
    const { a3 } = await goal005UpToA3(store);
    await store.publishResult('tech_lead', REV_JOB, { ok: true, result: a3Decision }, { attemptId: a3 });
    await store.setJobStatus('tech_lead', REV_JOB, 'COMPLETED');

    // The runtime still carries the conclusion drawn from the stale read.
    await store.writeRuntime({
      ...(await store.readRuntime()),
      state: LOOP_STATES.HUMAN_REQUIRED, decision: 'HUMAN_REQUIRED', escalationReason: 'UNKNOWN_FATAL',
    });

    const assessment = await assessRuntimeDivergence(store, { goal: GOAL });
    assert.equal(assessment.diverged, true);
    assert.equal(assessment.factsSayHuman, false);
    assert.equal(assessment.runtimeDecision, 'HUMAN_REQUIRED');
    assert.equal(assessment.latestReview.decision, 'CHANGES_REQUIRED');
    assert.equal(assessment.next.kind, DISPATCH_KINDS.CORRECTION);
    assert.equal(assessment.next.round, 2);
  });
});

test('20/21/22. reconciliation clears the gate, carries the real blockers and the profile', async () => {
  await withStore(async (store) => {
    const { a3 } = await goal005UpToA3(store);
    await store.publishResult('tech_lead', REV_JOB, { ok: true, result: a3Decision }, { attemptId: a3 });
    await store.setJobStatus('tech_lead', REV_JOB, 'COMPLETED');
    await store.writeRuntime({
      ...(await store.readRuntime()),
      state: LOOP_STATES.HUMAN_REQUIRED, decision: 'HUMAN_REQUIRED', escalationReason: 'UNKNOWN_FATAL',
    });

    const applied = await reconcileRuntimeFromResults(store, { goal: GOAL });
    const runtime = applied.runtime;

    assert.equal(runtime.state, LOOP_STATES.CORRECTION_QUEUED);
    assert.equal(runtime.round, 2);
    assert.equal(runtime.humanRequired, null);
    assert.equal(runtime.escalationReason, null);
    assert.equal(runtime.decision, 'CHANGES_REQUIRED');

    // Exactly the blockers the review persisted. Not re-derived, not invented.
    assert.deepEqual(runtime.blockers, BLOCKERS);
    assert.equal(runtime.blockers.length, 2);

    // And the escalation the Tech Lead attached to that same review.
    assert.equal(runtime.nextDeveloperProfile.profile, 'OPUS_MEDIUM');
    assert.equal(runtime.nextDeveloperProfile.round, 2);
    assert.equal(runtime.nextDeveloperProfile.selectedBy, 'tech_lead');

    // Rebuilt from the reviews on disk, not kept from the runtime that had none.
    assert.deepEqual(runtime.roundsRun, [{ round: 1, decision: 'CHANGES_REQUIRED', blockers: 2 }]);

    const events = await store.readEvents();
    const audit = events.find((e) => e.type === 'RUNTIME_RECONCILED_FROM_COMPLETED_RESULT');
    assert.equal(audit.previousRuntimeDecision, 'HUMAN_REQUIRED');
    assert.equal(audit.previousReason, 'UNKNOWN_FATAL');
    assert.equal(audit.authoritativeDecision, 'CHANGES_REQUIRED');
    assert.equal(audit.authoritativeSource, 'COMPLETED_REVIEW_RESULT');
    assert.equal(audit.attemptId, a3);
    assert.equal(audit.nextDeveloperProfile, 'OPUS_MEDIUM');

    // Nothing earlier was erased.
    assert.ok(events.some((e) => e.type === 'AGENT_FAILURE' && e.reason === 'UNKNOWN_FATAL'));
    assert.ok(events.some((e) => e.type === 'RETRY_AUTHORIZED_AFTER_HARNESS_FIX'));
  });
});

// --- 23-25. What must NOT happen ------------------------------------------

test('23/24/25. no new attempt, no re-review, no re-implementation', async () => {
  await withStore(async (store) => {
    const { a3 } = await goal005UpToA3(store);
    await store.publishResult('tech_lead', REV_JOB, { ok: true, result: a3Decision }, { attemptId: a3 });
    await store.setJobStatus('tech_lead', REV_JOB, 'COMPLETED');
    await store.writeRuntime({
      ...(await store.readRuntime()),
      state: LOOP_STATES.HUMAN_REQUIRED, decision: 'HUMAN_REQUIRED', escalationReason: 'UNKNOWN_FATAL',
    });

    await reconcileRuntimeFromResults(store, { goal: GOAL });

    // 25. No a4. The review job stays exactly where a3 left it.
    const reviewJob = await readJson(store.paths.job('tech_lead', REV_JOB));
    assert.equal(reviewJob.attempt, 3);
    assert.equal(reviewJob.currentAttemptId, a3);
    assert.equal(reviewJob.status, 'COMPLETED');
    assert.deepEqual(
      reviewJob.attemptHistory.map((h) => [h.attemptId, h.status]),
      [[`${REV_JOB}-a1`, 'WAITING_FOR_CAPACITY'], [`${REV_JOB}-a2`, 'FAILED']],
    );

    // 23. The review is complete, so nothing would call Fable again.
    assert.equal(await store.hasCompletedResult('tech_lead', REV_JOB), true);
    assert.equal((await store.startNextAttempt('tech_lead', REV_JOB)).reason, 'STAGE_ALREADY_COMPLETED');

    // 24. And the R1 implementation is complete, so nothing would call Opus for
    // it again. The next Developer work is a CORRECTION at round 2.
    const devJob = await readJson(store.paths.job('developer', DEV_JOB));
    assert.equal(devJob.attempt, 1);
    assert.equal(await store.hasCompletedResult('developer', DEV_JOB), true);

    const { next } = await reconcileExecutionState({ store, goal: GOAL });
    assert.equal(next.kind, DISPATCH_KINDS.CORRECTION);
    assert.equal(next.round, 2);
    assert.deepEqual([...next.blockers], BLOCKERS);
    assert.equal(next.fromReviewJobId, REV_JOB);
  });
});

test('reconciliation refuses when the facts genuinely call for a human', async () => {
  await withStore(async (store) => {
    const { a3 } = await goal005UpToA3(store);
    await store.publishResult('tech_lead', REV_JOB, {
      ok: true,
      result: { ...a3Decision, decision: 'HUMAN_REQUIRED', blockers: [], nextAction: 'HUMAN_REQUIRED', nextDeveloperProfile: undefined },
    }, { attemptId: a3 });
    await store.setJobStatus('tech_lead', REV_JOB, 'COMPLETED');

    await assert.rejects(
      () => reconcileRuntimeFromResults(store, { goal: GOAL }),
      (e) => e.code === 'NOTHING_TO_RECONCILE',
    );
  });
});

test('reconciliation refuses when the runtime already agrees', async () => {
  await withStore(async (store) => {
    const { a3 } = await goal005UpToA3(store);
    await store.publishResult('tech_lead', REV_JOB, { ok: true, result: a3Decision }, { attemptId: a3 });
    await store.setJobStatus('tech_lead', REV_JOB, 'COMPLETED');
    await store.writeRuntime({
      ...(await store.readRuntime()), state: LOOP_STATES.CORRECTION_QUEUED, decision: 'CHANGES_REQUIRED',
    });

    await assert.rejects(
      () => reconcileRuntimeFromResults(store, { goal: GOAL }),
      (e) => e.code === 'NOTHING_TO_RECONCILE',
    );
  });
});
