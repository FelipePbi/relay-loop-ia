/**
 * A stage's job, attempted more than once.
 *
 * The bug: recovery decided REQUEUE_JOB for an interrupted correction and
 * reconciliation agreed — "next is CORRECTION at round 2" — and then the
 * dispatch died with DUPLICATE_JOB, because the runner always called publishJob
 * even when it had deliberately chosen to reuse an existing job id. The two
 * halves disagreed about who owns the job's existence.
 *
 * One logical stage, many attempts. The jobId IS the stage's job; what changes
 * between tries is the attempt number.
 *
 * No model is called anywhere here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  JOB_DISPATCH, RETRYABLE_JOB_STATUSES, createJobStore, isClaimableJobStatus,
} from '../lib/job-store.mjs';
import {
  DISPATCH_KINDS, STAGE_STATUS, assertNoDuplicateStageDispatch,
  buildStageLedger, decideNextDispatch, reconcileExecutionState,
} from '../lib/reconcile.mjs';
import { STAGES } from '../lib/stage-identity.mjs';
import { createLeaseStore, leaseMoved } from '../lib/leases.mjs';
import { PROTOCOL_VERSION_V2 } from '../lib/contracts-v2.mjs';

const execFileAsync = promisify(execFile);
const codeIs = (code) => (error) => error.code === code;

const GOAL = '004';
const CORRECTION_JOB = '004-r2-correction-dde6dca4';
const DEV_R1 = '004-r1-developer-d8f21303';
const REV_R1 = '004-r1-tech_lead-4ded365b';
const EXECUTION_BASE = 'b3a019c94b8e89f48db5ab017866ff9e325d7d82';

const BLOCKERS = [
  { id: 'B1', title: 'inbox worker sem backoff' },
  { id: 'B2', title: 'outbox sem idempotência' },
  { id: 'B3', title: 'webhook sem verificação de assinatura' },
  { id: 'B4', title: 'migração sem ensaio' },
];

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-attempt-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

const correctionJob = () => ({
  protocolVersion: PROTOCOL_VERSION_V2, jobId: CORRECTION_JOB, role: 'developer',
  goal: GOAL, round: 2, type: 'CORRECTION', blockers: BLOCKERS.map((b) => b.title),
  executionBase: EXECUTION_BASE, worktreeInitialHead: EXECUTION_BASE,
});

/** Goal 004 as it really stood: R1 done and reviewed, R2 correction interrupted. */
async function goal004(dir) {
  const store = createJobStore(dir);
  const ok = (result) => ({ ok: true, result });

  await store.publishJob('developer', {
    protocolVersion: PROTOCOL_VERSION_V2, jobId: DEV_R1, role: 'developer',
    goal: GOAL, round: 1, type: 'IMPLEMENTATION',
  });
  await store.publishResult('developer', DEV_R1, ok({
    protocolVersion: PROTOCOL_VERSION_V2, jobId: DEV_R1, goal: GOAL, round: 1,
    status: 'REVIEW_REQUIRED', summary: 's',
  }), { attemptId: (await store.readAttemptState('developer', DEV_R1))?.attemptId });
  await store.setJobStatus('developer', DEV_R1, 'COMPLETED');

  await store.publishJob('tech_lead', {
    protocolVersion: PROTOCOL_VERSION_V2, jobId: REV_R1, role: 'tech_lead', goal: GOAL, round: 1,
  });
  await store.publishResult('tech_lead', REV_R1, ok({
    protocolVersion: PROTOCOL_VERSION_V2, jobId: REV_R1, goal: GOAL, round: 1,
    decision: 'CHANGES_REQUIRED', blockers: BLOCKERS, summary: 's',
  }), { attemptId: (await store.readAttemptState('tech_lead', REV_R1))?.attemptId });
  await store.setJobStatus('tech_lead', REV_R1, 'COMPLETED');

  await store.publishJob('developer', correctionJob());
  await store.setJobStatus('developer', CORRECTION_JOB, 'INTERRUPTED');
  return store;
}

// ===========================================================================
// The failure, and the semantics that replace it
// ===========================================================================

test('THE REGRESSION: an interrupted correction is dispatched again instead of failing DUPLICATE_JOB', async () => {
  await withDir(async (dir) => {
    const store = await goal004(dir);

    // Publishing is exactly what the runner used to do here.
    await assert.rejects(store.publishJob('developer', correctionJob()), codeIs('DUPLICATE_JOB'));

    // Dispatching does the right thing instead.
    const dispatched = await store.dispatchJob('developer', correctionJob(), { reason: 'ORCHESTRATOR_CRASH' });
    assert.equal(dispatched.outcome, JOB_DISPATCH.NEW_ATTEMPT);
    assert.equal(dispatched.attempt, 2);
    assert.equal(dispatched.jobId, CORRECTION_JOB, 'the same job, a later attempt');
  });
});

test('the new attempt keeps the same stage, Goal, round, packet and the four blockers', async () => {
  await withDir(async (dir) => {
    const store = await goal004(dir);
    await store.dispatchJob('developer', correctionJob(), { reason: 'ORCHESTRATOR_CRASH' });

    const job = await store.readJob('developer', CORRECTION_JOB);
    assert.equal(job.jobId, CORRECTION_JOB);
    assert.equal(job.goal, GOAL);
    assert.equal(job.round, 2);
    assert.equal(job.type, 'CORRECTION');
    assert.deepEqual(job.blockers, BLOCKERS.map((b) => b.title), 'the four blockers are unchanged');
    assert.equal(job.executionBase, EXECUTION_BASE);
    assert.equal(job.worktreeInitialHead, EXECUTION_BASE);

    const reconciled = await reconcileExecutionState({ store, goal: GOAL });
    assert.ok(reconciled.ledger.has('004:r2:correction'), 'and it is still the same logical stage');
  });
});

test('attempt 1 stays in the record as INTERRUPTED', async () => {
  await withDir(async (dir) => {
    const store = await goal004(dir);
    await store.dispatchJob('developer', correctionJob(), { reason: 'ORCHESTRATOR_CRASH' });

    const envelope = JSON.parse(await readFile(join(dir, 'jobs', 'developer', `${CORRECTION_JOB}.json`), 'utf8'));
    assert.equal(envelope.attempt, 2);
    assert.equal(envelope.status, 'QUEUED');
    assert.deepEqual(envelope.attemptHistory.map((h) => [h.attempt, h.status]), [[1, 'INTERRUPTED']]);
    assert.equal(envelope.attemptHistory[0].reason, 'ORCHESTRATOR_CRASH', 'and why it ended');
    assert.equal(await store.readJobAttempt('developer', CORRECTION_JOB), 2);
  });
});

test('the worker takes the attempt number from the job, so a2 is not mistaken for a1', async () => {
  const source = await readFile(new URL('../lib/worker-loop.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /attemptIdFor\(jobId, 1\)/,
    'hardcoding 1 meant result fencing could not tell two attempts apart');
  // readJobAttempt was folded into readAttemptState when the eligibility check
  // was extracted (see evaluateJobEligibility) so the same read serves both the
  // seen-cache key and the claim; the number still comes from the persisted
  // job, never a literal.
  assert.match(source, /readAttemptState\(role, jobId\)/, 'the number comes from the job');
  assert.match(source, /attemptIdFor\(jobId, attemptState\.attempt\)/, 'and the lease is claimed for that attempt');
});

// ===========================================================================
// What dispatch still refuses
// ===========================================================================

test('a completed stage is never dispatched again', async () => {
  await withDir(async (dir) => {
    const store = await goal004(dir);

    // R1 implementation completed: the guard refuses before dispatch is reached.
    const reconciled = await reconcileExecutionState({ store, goal: GOAL });
    assert.throws(() => assertNoDuplicateStageDispatch({
      ledger: reconciled.ledger, goal: GOAL, round: 1, stage: STAGES.IMPLEMENTATION, jobId: 'anything',
    }), codeIs('DUPLICATE_COMPLETED_STAGE_DISPATCH'));

    // And dispatch itself reports it rather than creating an attempt.
    const dispatched = await store.dispatchJob('developer', {
      protocolVersion: PROTOCOL_VERSION_V2, jobId: DEV_R1, role: 'developer',
      goal: GOAL, round: 1, type: 'IMPLEMENTATION',
    });
    assert.equal(dispatched.outcome, JOB_DISPATCH.ALREADY_COMPLETED);
  });
});

test('a running stage is not given a second attempt beside the first', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    await store.publishJob('developer', correctionJob());
    await store.setJobStatus('developer', CORRECTION_JOB, 'RUNNING');

    const dispatched = await store.dispatchJob('developer', correctionJob());
    assert.equal(dispatched.outcome, JOB_DISPATCH.ALREADY_RUNNING);
    assert.equal(dispatched.attempt, 1, 'no attempt was created');
  });
});

test('a queued job is left alone rather than published twice', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    await store.dispatchJob('developer', correctionJob());
    const again = await store.dispatchJob('developer', correctionJob());

    assert.equal(again.outcome, JOB_DISPATCH.ALREADY_QUEUED);
    assert.equal(again.attempt, 1);
  });
});

test('FAILED is not retried by a restart: that is a policy decision, not an assumption', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    await store.publishJob('developer', correctionJob());
    await store.setJobStatus('developer', CORRECTION_JOB, 'FAILED');

    await assert.rejects(store.dispatchJob('developer', correctionJob()), codeIs('STAGE_NOT_RETRYABLE'));
    // What matters is which statuses are EXCLUDED. A capacity wait joined the
    // retryable set — the model said "not now", which is not a failure of the
    // work — but FAILED and SUPERSEDED never may.
    assert.equal(RETRYABLE_JOB_STATUSES.includes('FAILED'), false);
    assert.equal(RETRYABLE_JOB_STATUSES.includes('SUPERSEDED'), false);
    assert.equal(RETRYABLE_JOB_STATUSES.includes('COMPLETED'), false);
    assert.equal(RETRYABLE_JOB_STATUSES.includes('INTERRUPTED'), true);

    await store.setJobStatus('developer', CORRECTION_JOB, 'SUPERSEDED');
    await assert.rejects(store.dispatchJob('developer', correctionJob()), codeIs('STAGE_NOT_RETRYABLE'));
  });
});

// ===========================================================================
// Concurrency
// ===========================================================================

test('two recoveries racing create exactly one new attempt', async () => {
  await withDir(async (dir) => {
    await goal004(dir);

    const script = join(dir, 'dispatch.mjs');
    const storeUrl = new URL('../lib/job-store.mjs', import.meta.url).href;
    await writeFile(script, `
import { createJobStore } from ${JSON.stringify(storeUrl)};
const store = createJobStore(process.argv[2]);
await new Promise((r) => setTimeout(r, Math.max(0, Number(process.argv[3]) - Date.now())));
const job = JSON.parse(process.argv[4]);
try {
  const d = await store.dispatchJob('developer', job, { reason: 'RACE' });
  console.log(d.outcome + ':' + d.attempt);
} catch (e) { console.log('ERR:' + e.code); }
`, 'utf8');

    const at = String(Date.now() + 300);
    const payload = JSON.stringify(correctionJob());
    const [a, b] = await Promise.all([
      execFileAsync(process.execPath, [script, dir, at, payload]),
      execFileAsync(process.execPath, [script, dir, at, payload]),
    ]);
    const results = [a.stdout.trim(), b.stdout.trim()];

    assert.equal(results.filter((r) => r.startsWith('NEW_ATTEMPT')).length, 1,
      `exactly one new attempt, got ${results}`);

    const store = createJobStore(dir);
    assert.equal(await store.readJobAttempt('developer', CORRECTION_JOB), 2, 'and it is attempt 2, not 3');
  });
});

test('a lease that moved is detected by version, not by a millisecond timestamp', async () => {
  await withDir(async (dir) => {
    const leases = createLeaseStore(dir);
    const { lease } = await leases.claimJob('k', {});
    assert.equal(lease.version, 1);

    const renewed = await leases.renewJob('k');
    assert.equal(renewed.version, 2);

    // Two writes inside one millisecond share a heartbeat; only the version
    // separates them, and a compare-and-swap that cannot tell them apart would
    // overwrite a lease that had moved.
    assert.equal(leaseMoved({ ...lease, heartbeatAt: lease.heartbeatAt, version: 2 }, lease), true);
    assert.equal(leaseMoved(lease, lease), false);

    // A lease written before versions existed still falls back to the heartbeat.
    const legacy = { workerInstanceId: 'w', heartbeatAt: 'A' };
    assert.equal(leaseMoved(legacy, { workerInstanceId: 'w', heartbeatAt: 'A' }), false);
    assert.equal(leaseMoved({ ...legacy, heartbeatAt: 'B' }, { workerInstanceId: 'w', heartbeatAt: 'A' }), true);
  });
});

// ===========================================================================
// Where the run actually goes
// ===========================================================================

test('the interrupted attempt is the one reused — no new random id for the same stage', () => {
  const ledger = buildStageLedger([
    { role: 'developer', status: 'COMPLETED', result: { status: 'REVIEW_REQUIRED' }, job: { jobId: DEV_R1, role: 'developer', goal: GOAL, round: 1, type: 'IMPLEMENTATION' } },
    { role: 'tech_lead', status: 'COMPLETED', result: { decision: 'CHANGES_REQUIRED', blockers: BLOCKERS }, job: { jobId: REV_R1, role: 'tech_lead', goal: GOAL, round: 1 } },
    { role: 'developer', status: 'INTERRUPTED', result: null, job: { jobId: CORRECTION_JOB, role: 'developer', goal: GOAL, round: 2, type: 'CORRECTION' } },
  ]);

  const next = decideNextDispatch({ ledger, goal: GOAL });
  assert.equal(next.kind, DISPATCH_KINDS.CORRECTION);
  assert.equal(next.round, 2, 'never back to round 1');
  assert.equal(next.resumeAttempt, CORRECTION_JOB, 'the interrupted attempt is surfaced, not hidden');
  assert.equal(next.resumeAttemptStatus, 'INTERRUPTED');
  assert.deepEqual(next.blockers, BLOCKERS, 'carrying the same four blockers');
  assert.equal(ledger.get('004:r2:correction').status, STAGE_STATUS.NOT_STARTED,
    'interrupted is not in flight and not complete');
});

test('a live attempt still wins over an interrupted one when both exist', () => {
  const ledger = buildStageLedger([
    { role: 'developer', status: 'INTERRUPTED', result: null, job: { jobId: 'old', role: 'developer', goal: GOAL, round: 1, type: 'IMPLEMENTATION' } },
    { role: 'developer', status: 'RUNNING', result: null, job: { jobId: 'live', role: 'developer', goal: GOAL, round: 1, type: 'IMPLEMENTATION' } },
  ]);
  const next = decideNextDispatch({ ledger, goal: GOAL });
  assert.equal(next.resumeAttempt, 'live');
  assert.equal(next.resumeAttemptStatus, 'RUNNING');
});

test('an INTERRUPTED job is still not something a worker picks up on its own', () => {
  assert.equal(isClaimableJobStatus('INTERRUPTED'), false,
    'the orchestrator decides; dispatch is what makes the next attempt');
});

test('restarting during attempt 2 leaves it recoverable, as attempt 3', async () => {
  await withDir(async (dir) => {
    const store = await goal004(dir);
    await store.dispatchJob('developer', correctionJob(), { reason: 'ORCHESTRATOR_CRASH' });
    await store.setJobStatus('developer', CORRECTION_JOB, 'RUNNING');

    // The machine goes down again mid-attempt.
    await store.setJobStatus('developer', CORRECTION_JOB, 'INTERRUPTED');
    const third = await store.dispatchJob('developer', correctionJob(), { reason: 'REBOOT' });

    assert.equal(third.outcome, JOB_DISPATCH.NEW_ATTEMPT);
    assert.equal(third.attempt, 3);

    const envelope = JSON.parse(await readFile(join(dir, 'jobs', 'developer', `${CORRECTION_JOB}.json`), 'utf8'));
    assert.deepEqual(envelope.attemptHistory.map((h) => h.attempt), [1, 2], 'both earlier attempts are kept');
    assert.equal(envelope.job.round, 2, 'and it is still round 2');
  });
});

test('the bases of record survive every attempt', async () => {
  await withDir(async (dir) => {
    const store = await goal004(dir);
    await store.dispatchJob('developer', correctionJob(), { reason: 'ORCHESTRATOR_CRASH' });
    await store.setJobStatus('developer', CORRECTION_JOB, 'INTERRUPTED');
    await store.dispatchJob('developer', correctionJob(), { reason: 'AGAIN' });

    const job = await store.readJob('developer', CORRECTION_JOB);
    assert.equal(job.executionBase, EXECUTION_BASE);
    assert.equal(job.worktreeInitialHead, EXECUTION_BASE);
  });
});

test('no R1 dispatch is possible at any point in this sequence', async () => {
  await withDir(async (dir) => {
    const store = await goal004(dir);
    await store.dispatchJob('developer', correctionJob(), { reason: 'ORCHESTRATOR_CRASH' });

    const reconciled = await reconcileExecutionState({ store, goal: GOAL });
    for (const stage of [STAGES.IMPLEMENTATION, STAGES.REVIEW]) {
      assert.throws(() => assertNoDuplicateStageDispatch({
        ledger: reconciled.ledger, goal: GOAL, round: 1, stage, jobId: 'fresh',
      }), codeIs('DUPLICATE_COMPLETED_STAGE_DISPATCH'), stage);
    }
    assert.equal(reconciled.next.round, 2);
  });
});

// ===========================================================================
// SKIPPED — the status the skip path wrote for a year without it existing
// ===========================================================================

test('every status a work unit can write is a status the job store accepts', async () => {
  // `work-unit-executor` has always written SKIPPED for a gate whose
  // precondition the harness could not meet. It was never in JOB_STATUSES,
  // and the path had never once run — every earlier Goal either ran the gate
  // or died before reaching it. Goal024's first real skip was refused as
  // INVALID_JOB_STATUS and took the whole Developer job down with it.
  const { JOB_STATUSES } = await import('../lib/job-store.mjs');
  for (const written of ['COMPLETED', 'FAILED', 'SKIPPED']) {
    assert.ok(JOB_STATUSES.includes(written), `work-unit-executor writes ${written}`);
  }
});

test('SKIPPED is terminal, unclaimable and not retryable — in that order', async () => {
  // Terminal because a retry of THIS job cannot produce the precondition it
  // lacked. Unclaimable and non-retryable follow from that, and the lease is
  // released on terminal — leaving SKIPPED out held the lease forever.
  const store = await import('../lib/job-store.mjs');
  assert.equal(store.isTerminalJobStatus('SKIPPED'), true);
  assert.equal(store.isClaimableJobStatus('SKIPPED'), false);
  assert.equal(store.RETRYABLE_JOB_STATUSES.includes('SKIPPED'), false);
});

test('the lease agrees with the job store about what is terminal', async () => {
  // The literal list in `canStartNewAttempt` was a third copy of this
  // vocabulary, and it is how SKIPPED came to be terminal in one place and
  // ambiguous in another.
  const { JOB_STATUSES, isTerminalJobStatus } = await import('../lib/job-store.mjs');
  const { canStartNewAttempt } = await import('../lib/leases.mjs');

  for (const status of JOB_STATUSES) {
    if (!isTerminalJobStatus(status) && status !== 'QUEUED') continue;
    assert.equal(
      canStartNewAttempt({ lease: null, jobStatus: status }).allowed,
      true,
      `a terminal job (${status}) with no lease must allow a new attempt`,
    );
  }
});
