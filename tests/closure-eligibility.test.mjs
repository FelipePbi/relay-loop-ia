/**
 * `assertGoalEligibleForClosure` — the proof `run-goal.mjs` requires before
 * hydrating its local state machine straight to ACCEPTED.
 *
 * Independent of `reconcileExecutionState`'s own ledger: this re-derives the
 * same conclusion directly from the job store, fenced to the attempt that is
 * actually COMPLETED right now. If the ledger and this guard ever disagreed,
 * this is the one that decides — it fails closed on anything short of a full
 * proof, never on a best guess.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJobStore, writeJsonAtomic, STORE_VERSION } from '../lib/job-store.mjs';
import { assertGoalEligibleForClosure } from '../lib/closure-eligibility.mjs';
import { PROTOCOL_VERSION_V2 } from '../lib/contracts-v2.mjs';

const GOAL = '005';
const REV_JOB = '005-r2-tech_lead-8eec8bd3';

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-closure-eligibility-'));
  try {
    return await run(createJobStore(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const jobRecord = (jobId, round, extra = {}) => ({
  storeVersion: STORE_VERSION,
  publishedAt: '2026-09-08T15:51:01.340Z',
  status: 'QUEUED',
  attempt: 1,
  currentAttemptId: `${jobId}-a1`,
  attemptStatus: 'QUEUED',
  attemptHistory: [],
  job: {
    protocolVersion: PROTOCOL_VERSION_V2, jobId, role: 'tech_lead', goal: GOAL, round, reviewLevel: 'DEEP',
  },
  ...extra,
});

async function seedAcceptedReview(store, { round = 2, blockers = [] } = {}) {
  await mkdir(store.paths.jobsDir('tech_lead'), { recursive: true });
  await mkdir(store.paths.resultsDir('tech_lead'), { recursive: true });
  await writeJsonAtomic(store.paths.job('tech_lead', REV_JOB), {
    ...jobRecord(REV_JOB, round), status: 'COMPLETED', attemptStatus: 'COMPLETED',
  });
  await store.publishResult('tech_lead', REV_JOB, {
    ok: true,
    result: { protocolVersion: PROTOCOL_VERSION_V2, jobId: REV_JOB, goal: GOAL, round, decision: 'ACCEPTED', blockers, nextAction: 'STOP' },
  }, { attemptId: `${REV_JOB}-a1` });
}

test('a completed, unblocked ACCEPTED review of the right goal and round is eligible', async () => {
  await withStore(async (store) => {
    await seedAcceptedReview(store, { round: 2 });
    const evidence = await assertGoalEligibleForClosure(store, { goal: GOAL, round: 2, reviewJobId: REV_JOB });
    assert.equal(evidence.goal, GOAL);
    assert.equal(evidence.round, 2);
    assert.equal(evidence.reviewJobId, REV_JOB);
    assert.equal(evidence.attemptId, `${REV_JOB}-a1`);
    assert.equal(evidence.decision, 'ACCEPTED');
  });
});

test('a nonexistent review job is refused', async () => {
  await withStore(async (store) => {
    await assert.rejects(
      () => assertGoalEligibleForClosure(store, { goal: GOAL, round: 2, reviewJobId: 'does-not-exist' }),
      (e) => e.code === 'CLOSURE_INELIGIBLE' && e.details.reason === 'REVIEW_JOB_NOT_FOUND',
    );
  });
});

test('a review job belonging to another Goal is refused', async () => {
  await withStore(async (store) => {
    await mkdir(store.paths.jobsDir('tech_lead'), { recursive: true });
    await mkdir(store.paths.resultsDir('tech_lead'), { recursive: true });
    await writeJsonAtomic(store.paths.job('tech_lead', REV_JOB), {
      storeVersion: STORE_VERSION, status: 'COMPLETED', attempt: 1, currentAttemptId: `${REV_JOB}-a1`,
      attemptStatus: 'COMPLETED', attemptHistory: [],
      job: { protocolVersion: PROTOCOL_VERSION_V2, jobId: REV_JOB, role: 'tech_lead', goal: '004', round: 2 },
    });
    await store.publishResult('tech_lead', REV_JOB, {
      ok: true, result: { protocolVersion: PROTOCOL_VERSION_V2, jobId: REV_JOB, goal: '004', round: 2, decision: 'ACCEPTED', blockers: [] },
    }, { attemptId: `${REV_JOB}-a1` });

    await assert.rejects(
      () => assertGoalEligibleForClosure(store, { goal: GOAL, round: 2, reviewJobId: REV_JOB }),
      (e) => e.code === 'CLOSURE_INELIGIBLE' && e.details.reason === 'GOAL_MISMATCH',
    );
  });
});

test('a review job of the wrong round is refused', async () => {
  await withStore(async (store) => {
    await seedAcceptedReview(store, { round: 1 });
    await assert.rejects(
      () => assertGoalEligibleForClosure(store, { goal: GOAL, round: 2, reviewJobId: REV_JOB }),
      (e) => e.code === 'CLOSURE_INELIGIBLE' && e.details.reason === 'ROUND_MISMATCH',
    );
  });
});

test('an attempt that is not COMPLETED (still QUEUED) is refused', async () => {
  await withStore(async (store) => {
    await mkdir(store.paths.jobsDir('tech_lead'), { recursive: true });
    await writeJsonAtomic(store.paths.job('tech_lead', REV_JOB), jobRecord(REV_JOB, 2));
    await assert.rejects(
      () => assertGoalEligibleForClosure(store, { goal: GOAL, round: 2, reviewJobId: REV_JOB }),
      (e) => e.code === 'CLOSURE_INELIGIBLE' && e.details.reason === 'ATTEMPT_NOT_COMPLETED',
    );
  });
});

test('an attempt WAITING_FOR_CAPACITY (not yet resolved) is refused', async () => {
  await withStore(async (store) => {
    await mkdir(store.paths.jobsDir('tech_lead'), { recursive: true });
    await writeJsonAtomic(store.paths.job('tech_lead', REV_JOB), {
      ...jobRecord(REV_JOB, 2), status: 'WAITING_FOR_CAPACITY', attemptStatus: 'WAITING_FOR_CAPACITY',
    });
    await assert.rejects(
      () => assertGoalEligibleForClosure(store, { goal: GOAL, round: 2, reviewJobId: REV_JOB }),
      (e) => e.code === 'CLOSURE_INELIGIBLE' && e.details.reason === 'ATTEMPT_NOT_COMPLETED',
    );
  });
});

test('a completed attempt whose result belongs to a DIFFERENT (stale) attempt is refused', async () => {
  await withStore(async (store) => {
    await mkdir(store.paths.jobsDir('tech_lead'), { recursive: true });
    await mkdir(store.paths.resultsDir('tech_lead'), { recursive: true });
    // The job says a2 is COMPLETED, but the only result on disk is fenced to a1
    // — exactly the shape a mid-repair crash could leave behind.
    await writeJsonAtomic(store.paths.job('tech_lead', REV_JOB), {
      storeVersion: STORE_VERSION, status: 'COMPLETED', attempt: 2, currentAttemptId: `${REV_JOB}-a2`,
      attemptStatus: 'COMPLETED',
      attemptHistory: [{ attempt: 1, attemptId: `${REV_JOB}-a1`, status: 'WAITING_FOR_CAPACITY' }],
      job: { protocolVersion: PROTOCOL_VERSION_V2, jobId: REV_JOB, role: 'tech_lead', goal: GOAL, round: 2 },
    });
    await writeJsonAtomic(store.paths.result('tech_lead', REV_JOB), {
      storeVersion: STORE_VERSION, publishedAt: new Date().toISOString(),
      attemptId: `${REV_JOB}-a1`,
      result: { ok: true, decision: 'ACCEPTED', blockers: [], attemptId: `${REV_JOB}-a1` },
    });

    await assert.rejects(
      () => assertGoalEligibleForClosure(store, { goal: GOAL, round: 2, reviewJobId: REV_JOB }),
      (e) => e.code === 'CLOSURE_INELIGIBLE' && e.details.reason === 'RESULT_NOT_FENCED',
    );
  });
});

test('CHANGES_REQUIRED is refused, never treated as eligible', async () => {
  await withStore(async (store) => {
    await mkdir(store.paths.jobsDir('tech_lead'), { recursive: true });
    await mkdir(store.paths.resultsDir('tech_lead'), { recursive: true });
    await writeJsonAtomic(store.paths.job('tech_lead', REV_JOB), {
      ...jobRecord(REV_JOB, 2), status: 'COMPLETED', attemptStatus: 'COMPLETED',
    });
    await store.publishResult('tech_lead', REV_JOB, {
      ok: true, result: { protocolVersion: PROTOCOL_VERSION_V2, jobId: REV_JOB, goal: GOAL, round: 2, decision: 'CHANGES_REQUIRED', blockers: ['x'] },
    }, { attemptId: `${REV_JOB}-a1` });

    await assert.rejects(
      () => assertGoalEligibleForClosure(store, { goal: GOAL, round: 2, reviewJobId: REV_JOB }),
      (e) => e.code === 'CLOSURE_INELIGIBLE' && e.details.reason === 'NOT_ACCEPTED',
    );
  });
});

test('HUMAN_REQUIRED is refused, never treated as eligible', async () => {
  await withStore(async (store) => {
    await mkdir(store.paths.jobsDir('tech_lead'), { recursive: true });
    await mkdir(store.paths.resultsDir('tech_lead'), { recursive: true });
    await writeJsonAtomic(store.paths.job('tech_lead', REV_JOB), {
      ...jobRecord(REV_JOB, 2), status: 'COMPLETED', attemptStatus: 'COMPLETED',
    });
    await store.publishResult('tech_lead', REV_JOB, {
      ok: true, result: { protocolVersion: PROTOCOL_VERSION_V2, jobId: REV_JOB, goal: GOAL, round: 2, decision: 'HUMAN_REQUIRED', blockers: [] },
    }, { attemptId: `${REV_JOB}-a1` });

    await assert.rejects(
      () => assertGoalEligibleForClosure(store, { goal: GOAL, round: 2, reviewJobId: REV_JOB }),
      (e) => e.code === 'CLOSURE_INELIGIBLE' && e.details.reason === 'NOT_ACCEPTED',
    );
  });
});

test('ACCEPTED with unresolved blockers is refused', async () => {
  await withStore(async (store) => {
    await seedAcceptedReview(store, { round: 2, blockers: ['leftover blocker'] });
    await assert.rejects(
      () => assertGoalEligibleForClosure(store, { goal: GOAL, round: 2, reviewJobId: REV_JOB }),
      (e) => e.code === 'CLOSURE_INELIGIBLE' && e.details.reason === 'UNRESOLVED_BLOCKERS',
    );
  });
});

test('missing arguments are refused rather than silently guessed', async () => {
  await withStore(async (store) => {
    await assert.rejects(() => assertGoalEligibleForClosure(store, { round: 2, reviewJobId: REV_JOB }), (e) => e.code === 'INVALID_ARGS');
    await assert.rejects(() => assertGoalEligibleForClosure(store, { goal: GOAL, reviewJobId: REV_JOB }), (e) => e.code === 'INVALID_ARGS');
    await assert.rejects(() => assertGoalEligibleForClosure(store, { goal: GOAL, round: 2 }), (e) => e.code === 'INVALID_ARGS');
  });
});
