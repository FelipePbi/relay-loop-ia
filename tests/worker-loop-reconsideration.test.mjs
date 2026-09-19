/**
 * Regression: a job repaired from outside the process must be reconsidered by
 * a worker that never restarted.
 *
 * The incident, Goal 009, 2026-09-09: a review job failed
 * (UNKNOWN_FATAL, actually a misclassified 429), was repaired by
 * ia-loop:reclassify (FAILED -> WAITING_FOR_CAPACITY) and requeued by
 * ia-loop:resume (-> QUEUED) — on the SAME attemptId throughout, which is
 * deliberate harness design (see README V21/V22 and
 * `lib/leases.mjs`'s `canStartNewAttempt`: a lease-less job is only
 * considered safely resumable when its status is one a FRESH dispatch could
 * also have, and `startNextAttempt` itself refuses to mint a new attempt for
 * a QUEUED job — "already claimable, nothing to do"). The SAME live Tech Lead
 * process — never restarted — silently skipped the requeued job forever: its
 * `seen` cache, keyed by `${jobId}#a${attempt}`, had already marked
 * `#a1` as dealt with the moment it first claimed attempt 1, and QUEUED is
 * both "never attempted" and "just repaired", so the recomputed key collided
 * with itself.
 *
 * The fix (lib/worker-loop.mjs, `evaluateJobEligibility`) keys the cache by
 * attempt + status + statusAt instead: `statusAt` is stamped fresh by every
 * write that changes status, including the repair's own, so a job that
 * legitimately returns to a status it already had produces a cache MISS
 * anyway and is looked at again — no restart required.
 *
 * No model is called anywhere in this file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJobStore, readJson, writeJsonAtomic } from '../lib/job-store.mjs';
import { createLeaseStore } from '../lib/leases.mjs';
import { runWithCapacity, RUN_OUTCOMES } from '../lib/capacity-runner.mjs';
import { evaluateJobEligibility } from '../lib/worker-loop.mjs';
import { LOOP_STATES } from '../lib/loop-state.mjs';
import { PROTOCOL_VERSION_V2 } from '../lib/contracts-v2.mjs';

const ROLE = 'tech_lead';
const GOAL = '009';
const ROUND = 1;
const JOB_ID = '009-r1-tech_lead-ed717112';

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-reconsider-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

function reviewJob() {
  return {
    protocolVersion: PROTOCOL_VERSION_V2, jobId: JOB_ID, role: ROLE, goal: GOAL, round: ROUND,
    worktree: 'W', reviewLevel: 'DEEP',
  };
}

/** A message the classifier reads as UNKNOWN_FATAL — any real capacity limit works the same; the classifier's own correctness is covered in cli-args.test.mjs. */
const failing = async () => ({
  error: { code: 'NON_ZERO_EXIT', message: 'CLI exited with code 1: totally unrecognized failure xyz' },
  structuredOutput: false,
});

const succeeding = async () => ({
  structuredOutput: true, payload: { ok: true },
  resolvedPrimaryModel: 'x', observedModels: ['x'], auxiliaryModels: [],
});

/**
 * Mirrors, field for field, the job-document write
 * `lib/failure-reclassification.mjs`'s `reclassifyFailure` performs once a
 * repair is accepted: status and attemptStatus move to WAITING_FOR_CAPACITY,
 * on the SAME attempt, with a freshly stamped `statusAt`. `reclassifyFailure`
 * itself is exercised in its own tests; this file is about what the WORKER
 * LOOP does once a job comes back from a repair, so it drives the exact shape
 * a repair leaves rather than invoking the real classifier — which, having
 * been fixed for the message that motivated this investigation, would no
 * longer misclassify it and would correctly refuse to "repair" it
 * (NOTHING_TO_RECLASSIFY), for a message chosen here purely to be
 * UNKNOWN_FATAL under the CURRENT classifier so the retry mechanics can be
 * exercised deterministically.
 */
async function repairToWaitingForCapacity(store, role, jobId) {
  const path = store.paths.job(role, jobId);
  const current = await readJson(path);
  await writeJsonAtomic(path, {
    ...current,
    status: 'WAITING_FOR_CAPACITY',
    attemptStatus: 'WAITING_FOR_CAPACITY',
    statusAt: new Date().toISOString(),
  });
}

/** ia-loop:resume's actual, real core action — no mirroring needed. */
async function resumeToQueued(store, role, jobId) {
  await store.setJobStatus(role, jobId, 'QUEUED');
}

test('a1 FAILED -> reclassify -> WAITING_FOR_CAPACITY -> resume -> QUEUED: the SAME live worker reconsiders and re-executes a1, exactly once', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    const leaseStore = createLeaseStore(dir);
    await store.publishJob(ROLE, reviewJob());

    // One `seen` Set for the whole test: it stands in for the SAME worker
    // process across every poll below. It is never recreated — a restart
    // would trivially fix the bug by starting with an empty cache, which is
    // exactly why that is not the fix.
    const seen = new Set();

    // --- Poll #1: a fresh job, before anything has run -----------------
    const first = await evaluateJobEligibility({ store, leaseStore, role: ROLE, jobId: JOB_ID, seen });
    assert.equal(first.eligible, true);
    assert.equal(first.cache, 'ADD');
    assert.equal(seen.has(first.seenKey), false, 'evaluateJobEligibility reports the key; the loop is what adds it');

    // The loop's own next step, right before it commits to claiming:
    seen.add(first.seenKey);
    const claim1 = await leaseStore.claimJob(JOB_ID, { attemptId: `${JOB_ID}-a1`, agent: ROLE, goal: GOAL, round: ROUND });
    assert.equal(claim1.acquired, true);

    const run1 = await runWithCapacity({
      store, role: ROLE, jobId: JOB_ID, goal: GOAL, round: ROUND,
      resumeFrom: LOOP_STATES.REVIEWER_RUNNING, invoke: failing,
    });
    assert.equal(run1.outcome, RUN_OUTCOMES.HUMAN_REQUIRED);
    assert.equal(run1.reason, 'UNKNOWN_FATAL');

    // The `finally` block of the real loop releases the lease unconditionally.
    await leaseStore.releaseJob(JOB_ID);

    const afterFail = await store.readAttemptState(ROLE, JOB_ID);
    assert.equal(afterFail.attempt, 1);
    assert.equal(afterFail.attemptStatus, 'FAILED');

    // --- Poll #2, still before any repair: correctly cached, silent -----
    const stillFailed = await evaluateJobEligibility({ store, leaseStore, role: ROLE, jobId: JOB_ID, seen });
    assert.equal(stillFailed.eligible, false);
    assert.equal(stillFailed.reason, 'TERMINAL');
    // Not yet in `seen` — the loop adds it now, exactly as it would live.
    seen.add(stillFailed.seenKey);
    const cachedNow = await evaluateJobEligibility({ store, leaseStore, role: ROLE, jobId: JOB_ID, seen });
    assert.equal(cachedNow.cache, 'HIT', 'a genuinely unchanged terminal job is skipped silently — correctly');

    // --- ia-loop:reclassify + ia-loop:resume run here, out of process ---
    await repairToWaitingForCapacity(store, ROLE, JOB_ID);
    await resumeToQueued(store, ROLE, JOB_ID);

    const afterResume = await store.readAttemptState(ROLE, JOB_ID);
    assert.equal(afterResume.attempt, 1, 'the harness reuses a1 by design; repair never mints an attempt');
    assert.equal(afterResume.attemptStatus, 'QUEUED');

    // --- Poll #3: the SAME `seen` Set, from the SAME (simulated) process —
    // this is the exact bug. Before the fix, `${jobId}#a1` was already in
    // `seen` from poll #1's claim, and QUEUED is indistinguishable from a
    // fresh dispatch by attempt+status alone, so this returned a silent
    // cache HIT forever. -----------------------------------------------
    const reconsidered = await evaluateJobEligibility({ store, leaseStore, role: ROLE, jobId: JOB_ID, seen });
    assert.notEqual(reconsidered.cache, 'HIT', 'the repair must break the cache, not confirm it');
    assert.equal(reconsidered.eligible, true);
    assert.equal(reconsidered.reason, undefined);
    assert.equal(reconsidered.attemptState.attempt, 1);

    // --- The loop claims and re-executes a1, for real, exactly once ----
    seen.add(reconsidered.seenKey);
    const claim2 = await leaseStore.claimJob(JOB_ID, { attemptId: `${JOB_ID}-a1`, agent: ROLE, goal: GOAL, round: ROUND });
    assert.equal(claim2.acquired, true, 'no lease survived the first attempt to contest this claim');

    let invocations = 0;
    const run2 = await runWithCapacity({
      store, role: ROLE, jobId: JOB_ID, goal: GOAL, round: ROUND,
      resumeFrom: LOOP_STATES.REVIEWER_RUNNING,
      invoke: async (args) => { invocations += 1; return succeeding(args); },
    });
    await leaseStore.releaseJob(JOB_ID);

    assert.equal(invocations, 1, 'exactly one new execution — not a loop, not a double-run');
    assert.equal(run2.outcome, RUN_OUTCOMES.COMPLETED);

    const final = await store.readAttemptState(ROLE, JOB_ID);
    assert.equal(final.attempt, 1, 'reused a1, as the harness designs it — no artificial a2');
    assert.equal(final.attemptStatus, 'COMPLETED');
    assert.equal((await store.readEvents()).filter((e) => e.type === 'JOB_ATTEMPT_STARTED').length, 0,
      'no new attempt was materialised; the retry legitimately shares a1');

    // --- Poll #4: now genuinely terminal and unchanged; a final skip is
    // correctly silent, and does not spin. ------------------------------
    const done = await evaluateJobEligibility({ store, leaseStore, role: ROLE, jobId: JOB_ID, seen });
    assert.equal(done.eligible, false);
    assert.equal(done.reason, 'TERMINAL');
    seen.add(done.seenKey);
    assert.equal(
      (await evaluateJobEligibility({ store, leaseStore, role: ROLE, jobId: JOB_ID, seen })).cache,
      'HIT',
    );
  });
});

test('a live lease still blocks a concurrent claim, exactly as before — leases remain the real guard', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    const leaseStore = createLeaseStore(dir);
    await store.publishJob(ROLE, reviewJob());
    const seen = new Set();

    // Worker A claims and is mid-execution (lease held, job RUNNING).
    const eligible = await evaluateJobEligibility({ store, leaseStore, role: ROLE, jobId: JOB_ID, seen });
    assert.equal(eligible.eligible, true);
    seen.add(eligible.seenKey);
    const claim = await leaseStore.claimJob(JOB_ID, { attemptId: `${JOB_ID}-a1`, agent: ROLE, goal: GOAL, round: ROUND });
    assert.equal(claim.acquired, true);
    await store.setJobStatus(ROLE, JOB_ID, 'RUNNING');

    // Worker B (a second `seen` Set — a different process) looks at the same
    // job while A is still working. RUNNING is not, on its own, a status
    // `isClaimableJobStatus` excludes — only COMPLETED/FAILED/SUPERSEDED/
    // INTERRUPTED are — so status alone does not stop B here. That is by
    // design, not a gap: the LEASE is the actual concurrency guard, and this
    // is exactly what proves it is still doing that job under the new key.
    const secondSeen = new Set();
    const bView = await evaluateJobEligibility({ store, leaseStore, role: ROLE, jobId: JOB_ID, seen: secondSeen });
    assert.equal(bView.eligible, false);
    assert.equal(bView.reason, 'LEASE_BLOCKED', 'status alone never stops a second worker; the lease does');

    // A direct claim attempt fails the exact same way — the lease, read
    // straight from disk, never from any in-memory cache, refuses it outright.
    const raceClaim = await leaseStore.claimJob(JOB_ID, { attemptId: `${JOB_ID}-a1-race`, agent: ROLE, goal: GOAL, round: ROUND });
    assert.equal(raceClaim.acquired, false, 'the persisted lease is the concurrency guard, not anything cached');
  });
});

test('idempotent/repeated resume calls do not create two attempts', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    await store.publishJob(ROLE, reviewJob());
    await store.setJobStatus(ROLE, JOB_ID, 'FAILED');
    await repairToWaitingForCapacity(store, ROLE, JOB_ID);

    // ia-loop:resume, called twice in a row (an operator re-running it, or a
    // retry of the CLI itself) — both calls do the exact same, idempotent
    // write; setJobStatus is not additive.
    await resumeToQueued(store, ROLE, JOB_ID);
    const afterFirst = await store.readAttemptState(ROLE, JOB_ID);
    await resumeToQueued(store, ROLE, JOB_ID);
    const afterSecond = await store.readAttemptState(ROLE, JOB_ID);

    assert.equal(afterFirst.attempt, 1);
    assert.equal(afterSecond.attempt, 1, 'attempt does not advance just because resume ran again');
    assert.equal(afterSecond.attemptStatus, 'QUEUED');
  });
});

test('a genuinely terminal job never comes back without an explicit transition', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    const leaseStore = createLeaseStore(dir);
    await store.publishJob(ROLE, reviewJob());
    await store.setJobStatus(ROLE, JOB_ID, 'COMPLETED');
    const seen = new Set();

    const first = await evaluateJobEligibility({ store, leaseStore, role: ROLE, jobId: JOB_ID, seen });
    assert.equal(first.eligible, false);
    assert.equal(first.reason, 'TERMINAL');
    seen.add(first.seenKey);

    // Polled another hundred times: still silent, still correct — no drift,
    // no eventual reconsideration of a job nothing ever repaired.
    for (let i = 0; i < 100; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- exercising repeated polls is the point
      const again = await evaluateJobEligibility({ store, leaseStore, role: ROLE, jobId: JOB_ID, seen });
      assert.equal(again.cache, 'HIT');
    }
  });
});

test('a restart (a fresh `seen` Set) reconsiders correctly too — the fix does not depend on staying alive', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    const leaseStore = createLeaseStore(dir);
    await store.publishJob(ROLE, reviewJob());

    const beforeRestart = new Set();
    const claimed = await evaluateJobEligibility({ store, leaseStore, role: ROLE, jobId: JOB_ID, seen: beforeRestart });
    assert.equal(claimed.eligible, true);
    beforeRestart.add(claimed.seenKey);
    await leaseStore.claimJob(JOB_ID, { attemptId: `${JOB_ID}-a1`, agent: ROLE, goal: GOAL, round: ROUND });
    await store.setJobStatus(ROLE, JOB_ID, 'FAILED');
    await leaseStore.releaseJob(JOB_ID);
    await repairToWaitingForCapacity(store, ROLE, JOB_ID);
    await resumeToQueued(store, ROLE, JOB_ID);

    // The process restarts: a brand-new, empty `seen` Set. This already
    // worked before the fix — restarting was the known (if unwanted) escape
    // hatch — and must keep working after it.
    const afterRestart = new Set();
    const reconsidered = await evaluateJobEligibility({ store, leaseStore, role: ROLE, jobId: JOB_ID, seen: afterRestart });
    assert.equal(reconsidered.eligible, true);
    assert.equal(reconsidered.cache, 'ADD');
  });
});
