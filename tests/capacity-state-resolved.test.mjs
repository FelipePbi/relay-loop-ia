/**
 * `clearResolvedCapacityBlock`: the second half of the reclassify/resume
 * repair path. Once ia-loop:resume has requeued a job (or found it already
 * completed), the `runtime.capacity`/`blockedJobId` block describing the wait
 * as still pending is stale, and must not keep advertising a block that is
 * already over.
 *
 * `runtime.state` is deliberately left alone: resume requeues a job for a
 * worker that has not run yet, and does not know — and must not guess — the
 * job's real next state (QUEUED vs RUNNING is a distinction the ia-loop:goal
 * reconciliation logic derives from the job's own status, exactly as it
 * already treats `runtime.state` as a cache that can disagree with disk).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJobStore } from '../lib/job-store.mjs';
import { clearResolvedCapacityBlock, persistCapacityWait } from '../lib/capacity-state.mjs';
import { LOOP_STATES } from '../lib/loop-state.mjs';

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-capacity-resolved-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

const NOW = Date.parse('2026-09-09T22:21:30.502Z');

async function waitingRuntime(store) {
  return persistCapacityWait(store, {
    goal: '009', round: 1, blockedAgent: 'tech_lead', resumeFrom: LOOP_STATES.REVIEWER_RUNNING,
    jobId: '009-r1-tech_lead-ed717112',
    decision: { reason: 'USAGE_LIMIT', attempt: 1, nextRetryAt: new Date(NOW + 60_000).toISOString(), retryIntervalMs: 60_000 },
    now: NOW,
  });
}

test('clears capacity/blockedAgent/blockedJobId/resumeFrom once the block is resolved', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    await waitingRuntime(store);

    const cleared = await clearResolvedCapacityBlock(store, { jobId: '009-r1-tech_lead-ed717112', now: NOW + 90_000 });

    assert.equal(cleared.capacity, null);
    assert.equal(cleared.blockedAgent, null);
    assert.equal(cleared.blockedJobId, null);
    assert.equal(cleared.resumeFrom, null);
    assert.equal(cleared.capacityClearedAt, new Date(NOW + 90_000).toISOString());
  });
});

test('leaves `state` untouched — resume does not know the job\'s real next state', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    const waiting = await waitingRuntime(store);
    assert.equal(waiting.state, LOOP_STATES.WAITING_FOR_CAPACITY);

    const cleared = await clearResolvedCapacityBlock(store, { jobId: '009-r1-tech_lead-ed717112', now: NOW });
    assert.equal(cleared.state, LOOP_STATES.WAITING_FOR_CAPACITY, 'unchanged; reconciliation derives the real state, not this call');
  });
});

test('everything else on runtime survives — this touches only the block', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    await waitingRuntime(store);
    await store.writeRuntime({ ...(await store.readRuntime()), migrationAcceptedBaseline: 'abc123' });

    const cleared = await clearResolvedCapacityBlock(store, { jobId: '009-r1-tech_lead-ed717112', now: NOW });
    assert.equal(cleared.goal, '009');
    assert.equal(cleared.round, 1);
    assert.equal(cleared.migrationAcceptedBaseline, 'abc123');
  });
});

test('never clears a block describing a DIFFERENT job than the one just resolved', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    await waitingRuntime(store);
    const before = await store.readRuntime();

    const result = await clearResolvedCapacityBlock(store, { jobId: 'some-other-job', now: NOW });

    assert.deepEqual(result, before, 'nothing was written — the on-disk runtime is returned unchanged');
    const stillBlocked = await store.readRuntime();
    assert.equal(stillBlocked.blockedJobId, '009-r1-tech_lead-ed717112');
    assert.ok(stillBlocked.capacity, 'the real block is untouched');
  });
});

test('a runtime with no block at all is a safe no-op', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    await store.writeRuntime({ goal: '009', round: 1, state: LOOP_STATES.IDLE });

    const result = await clearResolvedCapacityBlock(store, { jobId: 'x', now: NOW });
    assert.equal(result.blockedJobId, undefined);
    assert.equal((await store.readRuntime()).state, LOOP_STATES.IDLE);
  });
});

test('no runtime recorded at all is a safe no-op, not a crash', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    const result = await clearResolvedCapacityBlock(store, { jobId: 'x', now: NOW });
    assert.equal(result, null);
  });
});
