/**
 * `waitForResult` following an authorised successor attempt.
 *
 * The regression this exists for, exactly as it happened on Goal 005 R2:
 *
 *   Review a1   WAITING_FOR_CAPACITY / USAGE_LIMIT
 *   (capacity returns; the capacity runner materialises a2)
 *   Review a2   COMPLETED, decision ACCEPTED
 *
 * The orchestrator had dispatched the review, read a1's attemptId, and was
 * asleep in this loop when capacity came back. `waitForResult` kept reading
 * `expectedAttemptId: a1` forever and reported, once, "ignoring a result left
 * by a2; waiting for a1" — result fencing working exactly as designed, and
 * still wrong, because a1 was never going to answer again.
 *
 * No model is called anywhere in this file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJobStore } from '../lib/job-store.mjs';
import { PROTOCOL_VERSION_V2, validateDeveloperJob } from '../lib/contracts-v2.mjs';
import { waitForResult } from '../lib/result-waiter.mjs';
import { writeHeartbeat } from '../lib/worker-registry.mjs';
import { authorizeRetryAfterHarnessFix } from '../lib/harness-retry.mjs';

const JOB = '005-r2-tech_lead-8eec8bd3';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const a = (n) => `${JOB}-a${n}`;

const noSleep = async () => {};

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-waiter-'));
  try {
    return await run(createJobStore(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedReviewJob(store, jobId = JOB) {
  const job = validateDeveloperJob({
    protocolVersion: PROTOCOL_VERSION_V2, jobId, role: 'developer', goal: '005', round: 2,
    type: 'IMPLEMENTATION', migrationAcceptedBaseline: SHA_A, executionBase: SHA_B,
    worktree: '/w', goalPath: 'p.md', blockers: [],
  });
  await store.publishJob('tech_lead', { ...job, role: 'tech_lead' });
  return a(1);
}

test('a completed successor already on disk is consumed without ever calling the model', async () => {
  await withStore(async (store) => {
    await seedReviewJob(store);
    await store.setJobStatus('tech_lead', JOB, 'WAITING_FOR_CAPACITY');
    const started = await store.startNextAttempt('tech_lead', JOB, { reason: 'USAGE_LIMIT' });
    assert.equal(started.attemptId, a(2));
    await store.publishResult('tech_lead', JOB, { ok: true, result: { decision: 'ACCEPTED' } }, { attemptId: a(2) });
    await store.setJobStatus('tech_lead', JOB, 'COMPLETED');

    const messages = [];
    const outcome = await waitForResult(store, 'tech_lead', JOB, {
      emit: (m) => messages.push(m), expectedAttemptId: a(1), sleep: noSleep, goal: '005', round: 2,
    });

    assert.equal(outcome.envelope.result.decision, 'ACCEPTED');
    assert.equal(outcome.attemptId, a(2), 'the waiter settled on the successor, not the attempt it started with');

    const events = await store.readEvents();
    const handoff = events.find((e) => e.type === 'ATTEMPT_WAIT_HANDOFF');
    assert.ok(handoff, 'the handoff is recorded, auditable, not silent');
    assert.equal(handoff.fromAttemptId, a(1));
    assert.equal(handoff.toAttemptId, a(2));
    assert.equal(handoff.reason, 'USAGE_LIMIT');
    assert.equal(handoff.goal, '005');
    assert.equal(handoff.round, 2);
    assert.ok(messages.some((m) => m.includes('following authorized successor')));

    // Exactly one handoff — no a3 was ever created by watching.
    assert.equal(events.filter((e) => e.type === 'ATTEMPT_WAIT_HANDOFF').length, 1);
    assert.equal((await store.readAttemptState('tech_lead', JOB)).attempt, 2);
  });
});

test('a successor still QUEUED is followed and then waited on normally', async () => {
  await withStore(async (store) => {
    await seedReviewJob(store);
    await store.setJobStatus('tech_lead', JOB, 'WAITING_FOR_CAPACITY');
    await store.startNextAttempt('tech_lead', JOB, { reason: 'USAGE_LIMIT' });
    await writeHeartbeat(store, 'tech_lead', { state: 'WORKING', model: 'x', sessionStrategy: 'PERSISTENT' });

    let sleeps = 0;
    const sleep = async () => {
      sleeps += 1;
      // The worker finishes while this loop is "asleep" — the same race that
      // matters whichever order the worker and the observer start in.
      await store.publishResult('tech_lead', JOB, { ok: true, result: { decision: 'ACCEPTED' } }, { attemptId: a(2) });
    };

    const outcome = await waitForResult(store, 'tech_lead', JOB, {
      expectedAttemptId: a(1), sleep, pollMs: 0,
    });

    assert.equal(outcome.attemptId, a(2));
    assert.equal(outcome.envelope.result.decision, 'ACCEPTED');
    assert.equal(sleeps, 1, 'it polled normally after the handoff, it did not spin');
  });
});

test('a multi-hop chain (capacity wait, then an authorised harness retry) hands off once', async () => {
  await withStore(async (store) => {
    await seedReviewJob(store);
    await store.setJobStatus('tech_lead', JOB, 'WAITING_FOR_CAPACITY');
    await store.startNextAttempt('tech_lead', JOB, { reason: 'USAGE_LIMIT' }); // -> a2

    await store.setJobStatus('tech_lead', JOB, 'FAILED');
    await store.publishResult('tech_lead', JOB, { ok: false, code: 'UNKNOWN_FATAL', message: 'x' }, { attemptId: a(2) });
    await store.appendEvent({
      type: 'AGENT_FAILURE', jobId: JOB, attemptId: a(2), reason: 'UNKNOWN_FATAL',
      diagnostic: 'CLI exited with code 1: Error: When using --print, --output-format=stream-json requires --verbose',
    });
    await store.writeRuntime({ goal: '005', round: 2, state: 'HUMAN_REQUIRED' });
    const repaired = await authorizeRetryAfterHarnessFix(store, {
      role: 'tech_lead', jobId: JOB, detail: 'fixed', fixCommit: 'x', resumeFrom: 'REVIEWER_RUNNING',
    });
    assert.equal(repaired.successorAttemptId, a(3));

    await store.publishResult('tech_lead', JOB, { ok: true, result: { decision: 'ACCEPTED' } }, { attemptId: a(3) });
    await store.setJobStatus('tech_lead', JOB, 'COMPLETED');

    const outcome = await waitForResult(store, 'tech_lead', JOB, { expectedAttemptId: a(1), sleep: noSleep });
    assert.equal(outcome.attemptId, a(3));

    const events = await store.readEvents();
    const handoffs = events.filter((e) => e.type === 'ATTEMPT_WAIT_HANDOFF');
    assert.equal(handoffs.length, 1, 'one hop in the chain, not one event per attempt');
    assert.equal(handoffs[0].fromAttemptId, a(1));
    assert.equal(handoffs[0].toAttemptId, a(3));
    assert.equal(handoffs[0].hops, 2);
  });
});

test('an unauthorised successor (a plain FAILED with no retry authorisation) is never followed', async () => {
  await withStore(async (store, dir) => {
    await seedReviewJob(store);
    // A legitimate a2 exists, but ended for a reason nothing authorises — no
    // capacity wait, no interruption, no harness repair. Constructed directly
    // because none of the store's own retry doors would ever produce this.
    const { readJson, writeJsonAtomic } = await import('../lib/job-store.mjs');
    const jobPath = store.paths.job('tech_lead', JOB);
    const job = await readJson(jobPath);
    await writeJsonAtomic(jobPath, {
      ...job,
      attempt: 2,
      currentAttemptId: a(2),
      attemptStatus: 'QUEUED',
      status: 'QUEUED',
      attemptHistory: [{ attempt: 1, attemptId: a(1), status: 'FAILED', reason: 'UNKNOWN_FATAL' }],
    });

    const outcome = await waitForResult(store, 'tech_lead', JOB, { expectedAttemptId: a(1), sleep: noSleep });

    // No heartbeat was ever seeded, so the loop stops on WORKER_OFFLINE after
    // exactly one pass — never because it consumed anything.
    assert.equal(outcome.workerOffline, true);
    assert.equal(outcome.attemptId, a(1), 'still fenced on the attempt it was told to wait for');

    const events = await store.readEvents();
    assert.equal(events.filter((e) => e.type === 'ATTEMPT_WAIT_HANDOFF').length, 0);
    assert.ok(dir);
  });
});

test('SUPERSEDED does not authorise a handoff', async () => {
  await withStore(async (store) => {
    await seedReviewJob(store);
    const { readJson, writeJsonAtomic } = await import('../lib/job-store.mjs');
    const jobPath = store.paths.job('tech_lead', JOB);
    const job = await readJson(jobPath);
    await writeJsonAtomic(jobPath, {
      ...job,
      attempt: 2,
      currentAttemptId: a(2),
      attemptStatus: 'QUEUED',
      status: 'QUEUED',
      attemptHistory: [{ attempt: 1, attemptId: a(1), status: 'SUPERSEDED' }],
    });

    const outcome = await waitForResult(store, 'tech_lead', JOB, { expectedAttemptId: a(1), sleep: noSleep });
    assert.equal(outcome.workerOffline, true);
    assert.equal(outcome.attemptId, a(1));
  });
});

test('restart safety: a fresh call whose expectedAttemptId is already the current attempt needs no handoff', async () => {
  await withStore(async (store) => {
    await seedReviewJob(store);
    await store.setJobStatus('tech_lead', JOB, 'WAITING_FOR_CAPACITY');
    await store.startNextAttempt('tech_lead', JOB, { reason: 'USAGE_LIMIT' });
    // A restarting orchestrator re-derives the attempt fresh from disk — see
    // run-goal.mjs, which reads `store.readAttemptState(...).attemptId` right
    // before dispatch. It never starts out fenced on a superseded attempt.
    const fresh = (await store.readAttemptState('tech_lead', JOB)).attemptId;
    assert.equal(fresh, a(2));

    await store.publishResult('tech_lead', JOB, { ok: true, result: { decision: 'ACCEPTED' } }, { attemptId: a(2) });

    const outcome = await waitForResult(store, 'tech_lead', JOB, { expectedAttemptId: fresh, sleep: noSleep });
    assert.equal(outcome.attemptId, a(2));

    const events = await store.readEvents();
    assert.equal(events.filter((e) => e.type === 'ATTEMPT_WAIT_HANDOFF').length, 0, 'nothing to hand off — it started on the right attempt');
  });
});

// --- The exact Goal 005 R2 regression --------------------------------------

test('Goal 005 R2, reproduced: capacity retry completes while the waiter is fenced on a1', async () => {
  await withStore(async (store) => {
    await seedReviewJob(store);
    await store.setJobStatus('tech_lead', JOB, 'WAITING_FOR_CAPACITY');
    const a2 = (await store.startNextAttempt('tech_lead', JOB, { reason: 'USAGE_LIMIT' })).attemptId;
    await store.publishResult('tech_lead', JOB, {
      ok: true,
      result: { protocolVersion: PROTOCOL_VERSION_V2, jobId: JOB, goal: '005', round: 2, decision: 'ACCEPTED', blockers: [], nextAction: 'STOP' },
    }, { attemptId: a2 });
    await store.setJobStatus('tech_lead', JOB, 'COMPLETED');

    // The orchestrator dispatched against a1 before capacity came back, and is
    // now waiting on exactly what the real Goal 005 process was waiting on.
    const outcome = await waitForResult(store, 'tech_lead', JOB, {
      expectedAttemptId: a(1), goal: '005', round: 2, sleep: noSleep,
    });

    assert.equal(outcome.envelope.result.decision, 'ACCEPTED');
    assert.equal(outcome.attemptId, a2);
    assert.equal((await store.readAttemptState('tech_lead', JOB)).attempt, 2, 'no a3 was created');

    const events = await store.readEvents();
    assert.equal(events.filter((e) => e.type === 'ATTEMPT_WAIT_HANDOFF').length, 1);
  });
});
