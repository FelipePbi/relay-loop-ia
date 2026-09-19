/**
 * V6 regression: the incident that motivated leases.
 *
 * A runner gave up waiting on a correction while the worker was still running
 * it. A second correction was queued for the same round, and two Opus
 * inferences ended up working on the same worktree.
 *
 * These tests reproduce that shape with a deliberately slow fake agent and
 * assert the thing that matters: the model is called exactly once.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJobStore } from '../lib/job-store.mjs';
import {
  attemptIdFor,
  canStartNewAttempt,
  createLeaseStore,
  logicalJobId,
  startLeaseHeartbeat,
} from '../lib/leases.mjs';
import { PROTOCOL_VERSION_V2, validateDeveloperJob } from '../lib/contracts-v2.mjs';

const WORKTREE = '/repo/.ai-worktrees/goal-004';

async function withStores(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-dup-'));
  try {
    return await run({ store: createJobStore(dir), leases: createLeaseStore(dir), dir });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function correctionJob(jobId) {
  return validateDeveloperJob({
    protocolVersion: PROTOCOL_VERSION_V2,
    jobId, role: 'developer', goal: '004', round: 2, type: 'CORRECTION',
    migrationAcceptedBaseline: '1'.repeat(40),
    executionBase: '2'.repeat(40),
    worktree: WORKTREE, goalPath: 'docs/migration/goals/004-x.md',
    blockers: ['fix the thing'],
  });
}

/**
 * A worker whose inference takes real time, so a faster observer can time out
 * while it is still running — exactly the condition that caused the incident.
 */
function createSlowWorker({ store, leases, counter, durationMs }) {
  return {
    async run(jobId, attemptId) {
      const claim = await leases.claimJob(jobId, { attemptId, agent: 'developer', worktree: WORKTREE });
      if (!claim.acquired) return { started: false, reason: claim.reason };

      const wt = await leases.claimWorktree(WORKTREE, { attemptId, jobId });
      if (!wt.acquired) {
        await leases.releaseJob(jobId);
        return { started: false, reason: wt.reason };
      }

      const stopHeartbeat = startLeaseHeartbeat(leases, { jobId, worktreePath: WORKTREE }, { intervalMs: 15 });
      await store.setJobStatus('developer', jobId, 'RUNNING');

      // The "inference".
      counter.calls += 1;
      await new Promise((r) => { setTimeout(r, durationMs); });

      await store.publishResult('developer', jobId, {
        ok: true,
        result: { protocolVersion: PROTOCOL_VERSION_V2, jobId, goal: '004', round: 2, status: 'REVIEW_REQUIRED' },
      }, { attemptId });
      await store.setJobStatus('developer', jobId, 'COMPLETED');

      await stopHeartbeat();
      await leases.releaseWorktree(WORKTREE);
      await leases.releaseJob(jobId);
      return { started: true };
    },
  };
}

/** The observer: gives up quickly, and must change nothing when it does. */
async function observeUntil(store, jobId, windowMs) {
  const startedAt = Date.now();
  for (;;) {
    const envelope = await store.readResult('developer', jobId);
    if (envelope) return { envelope };
    if (Date.now() - startedAt > windowMs) return { observerTimeout: true };
    await new Promise((r) => { setTimeout(r, 10); });
  }
}

// ===========================================================================
// 22. The incident, reproduced
// ===========================================================================

test('THE REGRESSION: observer timeout while the agent runs never causes a second inference', async () => {
  await withStores(async ({ store, leases }) => {
    const counter = { calls: 0 };
    const jobId = logicalJobId({ goal: '004', round: 2, kind: 'correction' });
    const attemptId = attemptIdFor(jobId, 1);

    await store.publishJob('developer', correctionJob(jobId));
    const worker = createSlowWorker({ store, leases, counter, durationMs: 500 });

    // The worker starts and keeps running.
    const running = worker.run(jobId, attemptId);

    // The observer gives up long before the work finishes.
    const observed = await observeUntil(store, jobId, 60);
    assert.equal(observed.observerTimeout, true, 'the observer must time out first');

    // What the OLD code did here: treat this as a failure and queue another
    // correction. Every one of those steps must now be impossible.
    assert.equal(await store.readJobStatus('developer', jobId), 'RUNNING',
      'the observer timeout must NOT change the job status');

    const lease = await leases.readJobLease(jobId);
    assert.ok(lease, 'the lease must survive the observer giving up');
    assert.equal(lease.attemptId, attemptId);

    const verdict = canStartNewAttempt({ lease, jobStatus: 'RUNNING' });
    assert.equal(verdict.allowed, false, 'a second attempt must be refused');
    assert.equal(verdict.reason, 'ATTEMPT_ALREADY_RUNNING');

    // And if something tried anyway, the filesystem refuses it.
    const second = await createSlowWorker({ store, leases, counter, durationMs: 10 })
      .run(jobId, attemptIdFor(jobId, 2));
    assert.equal(second.started, false);
    assert.equal(second.reason, 'JOB_ALREADY_CLAIMED');

    await running;

    // The one assertion that matters.
    assert.equal(counter.calls, 1, 'modelCallCount must be exactly 1');

    const envelope = await store.readResult('developer', jobId);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.attemptId, attemptId);
  });
});

test('5. a different logical job cannot start on a worktree already being written', async () => {
  await withStores(async ({ store, leases }) => {
    const counter = { calls: 0 };
    const r2 = logicalJobId({ goal: '004', round: 2, kind: 'correction' });
    const r3 = logicalJobId({ goal: '004', round: 3, kind: 'correction' });

    await store.publishJob('developer', correctionJob(r2));
    await store.publishJob('developer', { ...correctionJob(r3), round: 3 });

    const worker = createSlowWorker({ store, leases, counter, durationMs: 200 });
    const running = worker.run(r2, attemptIdFor(r2, 1));
    await new Promise((r) => { setTimeout(r, 30); });

    // R3 is a legitimately different job, but the tree is taken.
    const blocked = await createSlowWorker({ store, leases, counter, durationMs: 10 })
      .run(r3, attemptIdFor(r3, 1));

    assert.equal(blocked.started, false);
    assert.equal(blocked.reason, 'WORKTREE_BUSY');

    await running;
    assert.equal(counter.calls, 1, 'only the owner of the worktree may run');
  });
});

// ===========================================================================
// 23. Orchestrator restart while the worker keeps going
// ===========================================================================

test('RESTART: a new orchestrator attaches to the running attempt instead of starting one', async () => {
  await withStores(async ({ store, leases, dir }) => {
    const counter = { calls: 0 };
    const jobId = logicalJobId({ goal: '004', round: 2, kind: 'correction' });
    const attemptId = attemptIdFor(jobId, 1);

    await store.publishJob('developer', correctionJob(jobId));
    const running = createSlowWorker({ store, leases, counter, durationMs: 400 }).run(jobId, attemptId);
    await new Promise((r) => { setTimeout(r, 40); });

    // Orchestrator 1 disappears; orchestrator 2 loads state from disk only.
    const store2 = createJobStore(dir);
    const leases2 = createLeaseStore(dir);

    const lease = await leases2.readJobLease(jobId);
    const verdict = canStartNewAttempt({ lease, jobStatus: await store2.readJobStatus('developer', jobId) });

    assert.equal(verdict.allowed, false, 'the restarted orchestrator must not start a new attempt');
    assert.equal(verdict.reason, 'ATTEMPT_ALREADY_RUNNING');
    assert.equal(lease.attemptId, attemptId, 'it attaches to the existing attempt');

    // It observes; it does not call the model.
    const { envelope } = await observeUntil(store2, jobId, 2000);
    await running;

    assert.equal(counter.calls, 1, 'no model call from the restarted orchestrator');
    assert.equal(envelope.ok, true);
    assert.equal(envelope.attemptId, attemptId);
  });
});

// ===========================================================================
// 18/19. Terminal jobs and capacity waits
// ===========================================================================

test('18. a FAILED job is not picked up again after a restart', async () => {
  await withStores(async ({ store }) => {
    const jobId = logicalJobId({ goal: '004', round: 2, kind: 'correction' });
    await store.publishJob('developer', correctionJob(jobId));
    await store.setJobStatus('developer', jobId, 'FAILED');

    assert.equal(await store.isJobClaimable('developer', jobId), false);
    // History is kept; only eligibility is gone.
    assert.equal(await store.readJobStatus('developer', jobId), 'FAILED');
  });
});

test('19. a capacity wait keeps the same attempt and never spawns a second one', async () => {
  await withStores(async ({ store, leases }) => {
    const jobId = logicalJobId({ goal: '004', round: 2, kind: 'correction' });
    const attemptId = attemptIdFor(jobId, 1);
    await store.publishJob('developer', correctionJob(jobId));

    await leases.claimJob(jobId, { attemptId, agent: 'developer', worktree: WORKTREE });
    await store.setJobStatus('developer', jobId, 'WAITING_FOR_CAPACITY');

    // Waiting is not a terminal state and the lease is still held.
    assert.equal(await store.isJobClaimable('developer', jobId), true);
    const verdict = canStartNewAttempt({
      lease: await leases.readJobLease(jobId),
      jobStatus: 'WAITING_FOR_CAPACITY',
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, 'ATTEMPT_ALREADY_RUNNING');
    assert.equal((await leases.readJobLease(jobId)).attemptId, attemptId);
  });
});

// ===========================================================================
// 20/21. The same protection for the reviewer, closure and planning
// ===========================================================================

test('20/21/22. review, closure and planning jobs are protected identically', async () => {
  await withStores(async ({ leases }) => {
    for (const [goal, kind] of [['004', 'review'], ['003', 'closure'], ['003', 'planning']]) {
      const jobId = logicalJobId({ goal, kind });

      const first = await leases.claimJob(jobId, { attemptId: `${jobId}-a1`, agent: 'tech_lead' });
      assert.equal(first.acquired, true, kind);

      // An observer timeout must not let a second Fable run start.
      const second = await leases.claimJob(jobId, { attemptId: `${jobId}-a2`, agent: 'tech_lead' });
      assert.equal(second.acquired, false, kind);
      assert.equal(second.reason, 'JOB_ALREADY_CLAIMED', kind);
    }
  });
});

test('planning cannot run twice, so two next Goals cannot be created by a race', async () => {
  await withStores(async ({ leases }) => {
    const jobId = logicalJobId({ goal: '003', kind: 'planning' });
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => leases.claimJob(jobId, { attemptId: `a${i}` })),
    );
    assert.equal(results.filter((r) => r.acquired).length, 1);
  });
});
