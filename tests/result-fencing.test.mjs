/**
 * Fencing results by attempt.
 *
 * The failure this exists for: Goal 005 R1's review really did complete, with
 * CHANGES_REQUIRED. But a repair had left the PREVIOUS attempt's failure
 * envelope on the primary result path, the orchestrator started six seconds
 * after the worker, and `waitForResult` returned "the first non-null envelope"
 * — a dead attempt's answer — and stopped the Goal for a human 4.5 minutes
 * before the live attempt finished.
 *
 * So the property under test is narrow and absolute: a result belongs to ONE
 * attempt, and nothing waiting on attempt N may ever consume attempt N-1's.
 *
 * No model is called anywhere in this file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJobStore, readJson } from '../lib/job-store.mjs';
import { PROTOCOL_VERSION_V2, validateDeveloperJob } from '../lib/contracts-v2.mjs';
import { reclassifyFailure } from '../lib/failure-reclassification.mjs';
import { authorizeRetryAfterHarnessFix } from '../lib/harness-retry.mjs';
import { LOOP_STATES } from '../lib/loop-state.mjs';

const JOB = '005-r1-developer-b218cf51';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-fencing-'));
  try {
    return await run(createJobStore(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedJob(store, { jobId = JOB, role = 'developer' } = {}) {
  const job = validateDeveloperJob({
    protocolVersion: PROTOCOL_VERSION_V2, jobId, role: 'developer', goal: '005', round: 1,
    type: 'IMPLEMENTATION', migrationAcceptedBaseline: SHA_A, executionBase: SHA_B,
    worktree: '/w', goalPath: 'p.md', blockers: [],
  });
  // The review side needs a job addressed to its own role; the contents do not
  // matter here, only the attempt bookkeeping the store keeps around it.
  await store.publishJob(role, role === 'developer' ? job : { ...job, role: 'tech_lead' });
  return `${jobId}-a1`;
}

/** Materialises the next attempt the way every retry path does. */
async function nextAttempt(store, { jobId = JOB, role = 'developer', from = 'INTERRUPTED' } = {}) {
  await store.setJobStatus(role, jobId, from);
  const started = await store.startNextAttempt(role, jobId, { reason: from });
  return started.attemptId;
}

// --- 1-2. A result names its attempt --------------------------------------

test('1. a published result carries its attemptId, at both levels', async () => {
  await withStore(async (store) => {
    const a1 = await seedJob(store);
    await store.publishResult('developer', JOB, { ok: true, result: { x: 1 } }, { attemptId: a1 });

    const envelope = await readJson(store.paths.result('developer', JOB));
    assert.equal(envelope.attemptId, a1);
    assert.equal(envelope.result.attemptId, a1, 'the payload carries it too, for readers that only have that');
  });
});

test('2. publishing without an attemptId is refused', async () => {
  await withStore(async (store) => {
    await seedJob(store);
    await assert.rejects(
      () => store.publishResult('developer', JOB, { ok: true, result: {} }),
      (e) => e.code === 'RESULT_ATTEMPT_REQUIRED',
    );
    assert.equal(await store.readResult('developer', JOB), null, 'nothing was written');
  });
});

// --- 3-6. Reading is fenced -----------------------------------------------

test('3. a fenced read accepts the attempt it asked for', async () => {
  await withStore(async (store) => {
    const a1 = await seedJob(store);
    await store.publishResult('developer', JOB, { ok: true, result: { from: 'a1' } }, { attemptId: a1 });

    const result = await store.readResult('developer', JOB, { expectedAttemptId: a1 });
    assert.equal(result.result.from, 'a1');
    assert.equal(await store.hasCompletedResult('developer', JOB, { expectedAttemptId: a1 }), true);
  });
});

test('4. a fenced read ignores a previous attempt entirely', async () => {
  await withStore(async (store) => {
    const a1 = await seedJob(store);
    await store.publishResult('developer', JOB, { ok: false, code: 'UNKNOWN_FATAL' }, { attemptId: a1 });

    // The primary path is deliberately NOT cleared here: this is the read-side
    // half of the guarantee, and it must hold on its own.
    const a2 = `${JOB}-a2`;
    assert.equal(await store.readResult('developer', JOB, { expectedAttemptId: a2 }), null);
    assert.equal(await store.hasCompletedResult('developer', JOB, { expectedAttemptId: a2 }), false);

    // Unfenced, the same file still answers "the latest result of this job",
    // which is the right answer to a different question.
    assert.equal((await store.readResult('developer', JOB)).code, 'UNKNOWN_FATAL');
  });
});

test('5. an envelope that names no attempt is not consumed by a fenced read', async () => {
  await withStore(async (store, dir) => {
    await seedJob(store);
    // Exactly the shape every result had before fencing existed.
    const { writeJsonAtomic } = await import('../lib/job-store.mjs');
    await writeJsonAtomic(store.paths.result('developer', JOB), {
      storeVersion: 1, publishedAt: new Date().toISOString(), result: { ok: true, result: {} },
    });
    assert.equal(await store.readResult('developer', JOB, { expectedAttemptId: `${JOB}-a1` }), null,
      'unprovable ownership is treated as stale, not assumed');
    assert.ok(dir);
  });
});

test('6. a stale read reports itself, without becoming an error', async () => {
  await withStore(async (store) => {
    const a1 = await seedJob(store);
    await store.publishResult('developer', JOB, { ok: true, result: {} }, { attemptId: a1 });

    const seen = [];
    const result = await store.readResult('developer', JOB, {
      expectedAttemptId: `${JOB}-a2`,
      onStale: (info) => seen.push(info),
    });

    assert.equal(result, null);
    assert.deepEqual(seen, [{ jobId: JOB, role: 'developer', expectedAttemptId: `${JOB}-a2`, foundAttemptId: a1 }]);

    // A throwing reporter must not break the read.
    assert.doesNotReject(() => store.readResult('developer', JOB, {
      expectedAttemptId: `${JOB}-a2`, onStale: () => { throw new Error('sink exploded'); },
    }));
  });
});

// --- 7-8. The primary path belongs to the current attempt -----------------

test('7. materialising a successor clears the primary path and preserves the result', async () => {
  await withStore(async (store) => {
    const a1 = await seedJob(store);
    await store.publishResult('developer', JOB, { ok: false, code: 'UNKNOWN_FATAL' }, { attemptId: a1 });

    const a2 = await nextAttempt(store);
    assert.equal(a2, `${JOB}-a2`);

    // Cleared: nothing is sitting there for a2 to trip over.
    assert.equal(await store.readResult('developer', JOB), null);
    // Preserved: a1's answer is still readable, under its own name.
    const archived = await readJson(store.paths.result('developer', JOB).replace(/\.json$/, `.attempt-${a1}.json`));
    assert.equal(archived.original.result.code, 'UNKNOWN_FATAL');
    assert.equal(archived.attemptId, a1);
  });
});

test('8. the attempt history survives the clearing', async () => {
  await withStore(async (store) => {
    const a1 = await seedJob(store);
    await store.publishResult('developer', JOB, { ok: false, code: 'UNKNOWN_FATAL' }, { attemptId: a1 });
    await nextAttempt(store);

    const job = await readJson(store.paths.job('developer', JOB));
    assert.equal(job.attemptHistory.length, 1);
    assert.equal(job.attemptHistory[0].attemptId, a1);
    assert.equal(job.attemptHistory[0].status, 'INTERRUPTED');
  });
});

// --- 9-11. Writing is fenced ----------------------------------------------

test('9. a late predecessor cannot overwrite the successor', async () => {
  await withStore(async (store, dir) => {
    const a1 = await seedJob(store);
    const a2 = await nextAttempt(store);
    await store.publishResult('developer', JOB, { ok: true, result: { from: 'a2' } }, { attemptId: a2 });

    // a1 finally answers, long after it was superseded. It does not know that.
    await assert.rejects(
      () => store.publishResult('developer', JOB, { ok: true, result: { from: 'a1' } }, { attemptId: a1 }),
      (e) => e.code === 'STALE_ATTEMPT_RESULT',
    );

    assert.equal((await store.readResult('developer', JOB)).result.from, 'a2', 'a2 still owns the primary path');
    const preserved = JSON.parse(await readFile(join(dir, 'results', 'developer', `${JOB}.stale-${a1}.json`), 'utf8'));
    assert.equal(preserved.staleAttemptId, a1);
    assert.equal(preserved.result.result.from, 'a1', 'the late answer is kept, not discarded');
  });
});

test('10. the same attempt publishing twice is idempotent, not a conflict', async () => {
  await withStore(async (store) => {
    const a1 = await seedJob(store);
    await store.publishResult('developer', JOB, { ok: true, result: { n: 1 } }, { attemptId: a1 });
    await store.publishResult('developer', JOB, { ok: true, result: { n: 2 } }, { attemptId: a1 });
    assert.equal((await store.readResult('developer', JOB)).result.n, 2);
  });
});

test('11. an explicit expectedAttemptId still fails closed when it disagrees', async () => {
  await withStore(async (store) => {
    const a1 = await seedJob(store);
    await assert.rejects(
      () => store.publishResult('developer', JOB, { ok: true, result: {} },
        { attemptId: a1, expectedAttemptId: `${JOB}-a9` }),
      (e) => e.code === 'STALE_ATTEMPT_RESULT',
    );
  });
});

// --- 12-14. Every retry path uses the same infrastructure -----------------

test('12. an interrupted retry cannot read its predecessor result', async () => {
  await withStore(async (store) => {
    const a1 = await seedJob(store);
    // A failure, not a success: an attempt that produced a valid result was
    // never interrupted, and a completed stage is never given a successor.
    await store.publishResult('developer', JOB, { ok: false, code: 'TIMEOUT' }, { attemptId: a1 });
    const a2 = await nextAttempt(store, { from: 'INTERRUPTED' });
    assert.equal(a2, `${JOB}-a2`);
    assert.equal(await store.readResult('developer', JOB, { expectedAttemptId: a2 }), null);
  });
});

test('13. a capacity retry cannot read its predecessor result', async () => {
  await withStore(async (store) => {
    const a1 = await seedJob(store);
    await store.publishResult('developer', JOB, { ok: false, code: 'USAGE_LIMIT' }, { attemptId: a1 });
    const a2 = await nextAttempt(store, { from: 'WAITING_FOR_CAPACITY' });
    assert.equal(await store.readResult('developer', JOB, { expectedAttemptId: a2 }), null);
  });
});

test('13b. a capacity reclassification clears the primary path too', async () => {
  await withStore(async (store) => {
    const a1 = await seedJob(store, { jobId: '005-r1-tech_lead-x', role: 'tech_lead' });
    const jobId = '005-r1-tech_lead-x';
    await store.setJobStatus('tech_lead', jobId, 'FAILED');
    await store.publishResult('tech_lead', jobId,
      { ok: false, code: 'UNKNOWN_FATAL', message: 'x' }, { attemptId: a1 });
    await store.appendEvent({
      type: 'AGENT_FAILURE', jobId, attemptId: a1, reason: 'UNKNOWN_FATAL',
      diagnostic: "You've hit your session limit · resets 3:10am (America/Sao_Paulo)",
    });
    await store.writeRuntime({ goal: '005', round: 1, state: LOOP_STATES.HUMAN_REQUIRED });

    await reclassifyFailure(store, { role: 'tech_lead', jobId, resumeFrom: LOOP_STATES.REVIEWER_RUNNING });

    assert.equal(await store.readResult('tech_lead', jobId), null,
      'the repaired attempt leaves nothing on the primary path for its successor');
  });
});

test('14. a harness retry clears the primary path too', async () => {
  await withStore(async (store) => {
    const jobId = '005-r1-tech_lead-ca1d7bf4';
    const a1 = await seedJob(store, { jobId, role: 'tech_lead' });
    await store.setJobStatus('tech_lead', jobId, 'FAILED');
    await store.publishResult('tech_lead', jobId,
      { ok: false, code: 'UNKNOWN_FATAL', message: 'x' }, { attemptId: a1 });
    await store.appendEvent({
      type: 'AGENT_FAILURE', jobId, attemptId: a1, reason: 'UNKNOWN_FATAL',
      diagnostic: 'CLI exited with code 1: Error: When using --print, --output-format=stream-json requires --verbose',
    });
    await store.writeRuntime({ goal: '005', round: 1, state: LOOP_STATES.HUMAN_REQUIRED });

    const applied = await authorizeRetryAfterHarnessFix(store, {
      role: 'tech_lead', jobId, detail: 'argv fixed', fixCommit: 'abc',
      resumeFrom: LOOP_STATES.REVIEWER_RUNNING,
    });

    // THE regression. This is exactly the state Goal 005 was in when the
    // orchestrator read a2's failure as a3's answer.
    assert.equal(await store.readResult('tech_lead', jobId), null);
    assert.equal(
      await store.readResult('tech_lead', jobId, { expectedAttemptId: applied.successorAttemptId }),
      null,
    );
    // And the failure is still readable as history.
    const archived = await readJson(store.paths.result('tech_lead', jobId).replace(/\.json$/, `.failed-${a1}.json`));
    assert.equal(archived.original.result.code, 'UNKNOWN_FATAL');
  });
});

// --- 15-16. Who starts first does not matter ------------------------------

test('15/16. neither start order lets a stale result be consumed', async () => {
  for (const workerFirst of [true, false]) {
    // eslint-disable-next-line no-await-in-loop
    await withStore(async (store) => {
      const a1 = await seedJob(store);
      await store.publishResult('developer', JOB, { ok: false, code: 'UNKNOWN_FATAL' }, { attemptId: a1 });
      const a2 = await nextAttempt(store);

      if (workerFirst) {
        // Worker claims and starts; the observer arrives afterwards.
        await store.setJobStatus('developer', JOB, 'RUNNING');
        assert.equal(await store.readResult('developer', JOB, { expectedAttemptId: a2 }), null);
        await store.publishResult('developer', JOB, { ok: true, result: { from: 'a2' } }, { attemptId: a2 });
      } else {
        // Observer waits first; the worker answers later.
        assert.equal(await store.readResult('developer', JOB, { expectedAttemptId: a2 }), null);
        await store.setJobStatus('developer', JOB, 'RUNNING');
        await store.publishResult('developer', JOB, { ok: true, result: { from: 'a2' } }, { attemptId: a2 });
      }

      assert.equal((await store.readResult('developer', JOB, { expectedAttemptId: a2 })).result.from, 'a2');
    });
  }
});

// --- 17-18. Completed results are still reused ----------------------------

test('17/18. a completed result is still reused, so no model is called twice', async () => {
  await withStore(async (store) => {
    const a1 = await seedJob(store);
    await store.publishResult('developer', JOB, { ok: true, result: { status: 'REVIEW_REQUIRED' } }, { attemptId: a1 });
    await store.setJobStatus('developer', JOB, 'COMPLETED');

    // Unfenced: "does this logical stage already have an answer?" — yes.
    assert.equal(await store.hasCompletedResult('developer', JOB), true);
    assert.equal((await store.readResult('developer', JOB)).result.status, 'REVIEW_REQUIRED');
    // And a completed stage refuses a successor, so the reuse cannot be lost.
    assert.equal((await store.startNextAttempt('developer', JOB)).reason, 'STAGE_ALREADY_COMPLETED');
  });
});
