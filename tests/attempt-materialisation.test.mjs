/**
 * Materialising the next attempt.
 *
 * The failure this covers: recovery decided REQUEUE_JOB for the interrupted R2
 * correction and put the job back to QUEUED — while it still pointed at the
 * interrupted attempt a1. The job looked ready, nothing actually was, the a1
 * lease stayed on disk as an orphan, and the Developer sat IDLE against work it
 * was supposed to be doing. Forever.
 *
 * Requeuing a logical job and creating its next attempt are different acts.
 * Only the second produces something a worker can claim.
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
  JOB_DISPATCH, attemptIdOf, createJobStore, isClaimableJobStatus, isInconsistentAttemptState,
} from '../lib/job-store.mjs';
import {
  DISPATCH_KINDS, STAGE_STATUS, assertNoDuplicateStageDispatch,
  needsNewAttempt, reconcileExecutionState,
} from '../lib/reconcile.mjs';
import { STAGES } from '../lib/stage-identity.mjs';
import { createLeaseStore, canStartNewAttempt } from '../lib/leases.mjs';
import { PROTOCOL_VERSION_V2 } from '../lib/contracts-v2.mjs';

const execFileAsync = promisify(execFile);
const codeIs = (code) => (error) => error.code === code;

const GOAL = '004';
const JOB = '004-r2-correction-dde6dca4';
const DEV_R1 = '004-r1-developer-d8f21303';
const REV_R1 = '004-r1-tech_lead-4ded365b';
const BASE = 'b3a019c94b8e89f48db5ab017866ff9e325d7d82';

const BLOCKERS = [
  { id: 'B1', title: 'mensagem única descartada como duplicata' },
  { id: 'B2', title: 'bloqueio de fila em claimNext' },
  { id: 'B3', title: 'janela de fragmentos regrediu' },
  { id: 'B4', title: 'lint da IA falha' },
];

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-materialise-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

const correctionJob = () => ({
  protocolVersion: PROTOCOL_VERSION_V2, jobId: JOB, role: 'developer',
  goal: GOAL, round: 2, type: 'CORRECTION',
  blockers: BLOCKERS.map((b) => b.title),
  executionBase: BASE, worktreeInitialHead: BASE,
});

const ok = (result) => ({ ok: true, result });

/** R1 done and reviewed with four blockers; R2 correction published. */
async function goal004(dir) {
  const store = createJobStore(dir);

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
  return store;
}

// ===========================================================================
// 14. The real state, reproduced
// ===========================================================================

test('THE FIXTURE: job QUEUED pointing at an INTERRUPTED attempt is NEEDS_NEW_ATTEMPT, not ALREADY_QUEUED', async () => {
  await withDir(async (dir) => {
    const store = await goal004(dir);
    const leases = createLeaseStore(dir);

    // Exactly the shape the real state was left in: recovery marked the attempt
    // interrupted and then put the JOB back to QUEUED, with a1's lease still on
    // disk and its holder gone.
    await leases.claimJob(JOB, { agent: 'developer', attemptId: attemptIdOf(JOB, 1), worktree: '.ai-worktrees/goal-004' });
    const path = join(dir, 'jobs', 'developer', `${JOB}.json`);
    const envelope = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({
      ...envelope, status: 'QUEUED', attempt: 1,
      currentAttemptId: attemptIdOf(JOB, 1), attemptStatus: 'INTERRUPTED',
    }, null, 2), 'utf8');

    // The state is recognised as impossible rather than read as ready.
    assert.equal(isInconsistentAttemptState(JSON.parse(await readFile(path, 'utf8'))), true);

    const reconciled = await reconcileExecutionState({ store, goal: GOAL });
    const stage = reconciled.ledger.get('004:r2:correction');

    assert.equal(stage.status, STAGE_STATUS.NOT_STARTED,
      'an interrupted attempt is not in flight, whatever the job status says');
    assert.equal(needsNewAttempt(stage), true, 'this is what the old code read as ALREADY_QUEUED');
    assert.equal(reconciled.next.kind, DISPATCH_KINDS.CORRECTION);
    assert.equal(reconciled.next.round, 2);
    assert.equal(reconciled.next.needsNewAttempt, true);

    // And dispatching materialises a2 instead of reporting "already queued".
    const dispatched = await store.dispatchJob('developer', correctionJob(), { reason: 'PROCESS_GONE' });
    assert.equal(dispatched.outcome, JOB_DISPATCH.NEW_ATTEMPT);
    assert.equal(dispatched.attemptId, attemptIdOf(JOB, 2));
  });
});

test('the worker refuses that job while nothing is claimable, and does not remember the refusal', async () => {
  await withDir(async (dir) => {
    const store = await goal004(dir);
    const leases = createLeaseStore(dir);
    const { lease } = await leases.claimJob(JOB, { agent: 'developer', attemptId: attemptIdOf(JOB, 1) });

    await store.setJobStatus('developer', JOB, 'INTERRUPTED');

    // What the worker sees: the job-level status is not claimable…
    assert.equal(await store.isJobClaimable('developer', JOB), false);
    // …and the lease of the dead attempt is what made it refuse even when the
    // job said QUEUED.
    const verdict = canStartNewAttempt({
      lease, jobStatus: 'QUEUED', now: Date.parse(lease.heartbeatAt) + 600_000,
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, 'ORPHANED_EXECUTION_UNCERTAIN');

    const source = await readFile(new URL('../lib/worker-loop.mjs', import.meta.url), 'utf8');
    // seenKey now also carries statusAt, not just attempt+status: a repaired
    // job (ia-loop:reclassify, ia-loop:resume) legitimately returns to the
    // EXACT SAME status string it started at — QUEUED is both "never
    // attempted" and "just requeued after a repair" — so status alone cannot
    // tell the two apart. statusAt changes on every write that changes status,
    // so it is what makes the worker notice without needing a restart.
    assert.match(
      source,
      /seenKey = `\$\{jobId\}#a\$\{attemptState\.attempt\}:\$\{attemptState\.attemptStatus\}@\$\{attemptState\.statusAt\}`/,
      'seen is keyed by attempt, status AND statusAt, so a repair that returns to the same status is still noticed',
    );
    assert.match(source, /Not cached: the\s*\n\s*\/\/ next attempt materialising/,
      'a refusal recovery can undo must not be permanent');
  });
});

// ===========================================================================
// 1–7. The transition
// ===========================================================================

test('1/2/3/4/5. a1 INTERRUPTED becomes a2 QUEUED: same job, same stage, next attempt', async () => {
  await withDir(async (dir) => {
    const store = await goal004(dir);
    await store.setJobStatus('developer', JOB, 'INTERRUPTED');

    const started = await store.startNextAttempt('developer', JOB, { reason: 'PROCESS_GONE' });
    assert.equal(started.created, true);
    assert.equal(started.attempt, 2);
    assert.equal(started.attemptId, `${JOB}-a2`);
    assert.equal(started.previousAttemptId, `${JOB}-a1`);

    const state = await store.readAttemptState('developer', JOB);
    assert.equal(state.attemptStatus, 'QUEUED');
    assert.equal(state.status, 'QUEUED');
    assert.equal(state.inconsistent, false);
    assert.deepEqual(state.history.map((h) => [h.attemptId, h.status]), [[`${JOB}-a1`, 'INTERRUPTED']]);

    const reconciled = await reconcileExecutionState({ store, goal: GOAL });
    assert.ok(reconciled.ledger.has('004:r2:correction'), 'the same logical stage');
    assert.equal(reconciled.ledger.get('004:r2:correction').status, STAGE_STATUS.IN_FLIGHT);
  });
});

test('6/7. a1 keeps its lease record; a2 gets one of its own', async () => {
  await withDir(async (dir) => {
    const store = await goal004(dir);
    const leases = createLeaseStore(dir);
    const { lease: first } = await leases.claimJob(JOB, { agent: 'developer', attemptId: attemptIdOf(JOB, 1) });

    // Recovery retires a1's lease with proof; it is archived, not deleted.
    await leases.retireJob(JOB, { expected: first, proof: 'PROCESS_GONE' });
    const archived = JSON.parse(await readFile(join(dir, 'leases', 'jobs', `${JOB}.lock.superseded`), 'utf8'));
    assert.equal(archived.attemptId, attemptIdOf(JOB, 1));
    assert.equal(archived.status, 'SUPERSEDED');

    await store.setJobStatus('developer', JOB, 'INTERRUPTED');
    await store.startNextAttempt('developer', JOB, { reason: 'PROCESS_GONE' });

    // a2 claims a fresh lease under its own attempt id.
    const { acquired, lease: second } = await leases.claimJob(JOB, {
      agent: 'developer', attemptId: attemptIdOf(JOB, 2),
    });
    assert.equal(acquired, true);
    assert.equal(second.attemptId, attemptIdOf(JOB, 2));
    assert.notEqual(second.workerInstanceId + second.attemptId, first.workerInstanceId + first.attemptId);
  });
});

test('8/9. a2 is claimable and is what a worker and status would see', async () => {
  await withDir(async (dir) => {
    const store = await goal004(dir);
    await store.setJobStatus('developer', JOB, 'INTERRUPTED');
    await store.startNextAttempt('developer', JOB, { reason: 'PROCESS_GONE' });

    const state = await store.readAttemptState('developer', JOB);
    assert.equal(await store.isJobClaimable('developer', JOB), true);
    assert.equal(isClaimableJobStatus(state.attemptStatus), true);
    assert.equal(state.attemptId, `${JOB}-a2`, 'status must show a2, never a1');
    assert.equal(await store.readJobAttempt('developer', JOB), 2);
  });
});

// ===========================================================================
// 12, 13, 14, 15, 16. Idempotence, concurrency, and the states that block
// ===========================================================================

test('12. running recovery twice does not create a3', async () => {
  await withDir(async (dir) => {
    const store = await goal004(dir);
    await store.setJobStatus('developer', JOB, 'INTERRUPTED');

    const first = await store.startNextAttempt('developer', JOB, { reason: 'PROCESS_GONE' });
    assert.equal(first.created, true);

    const second = await store.startNextAttempt('developer', JOB, { reason: 'PROCESS_GONE' });
    assert.equal(second.created, false);
    assert.equal(second.reason, 'ATTEMPT_ALREADY_QUEUED');
    assert.equal(await store.readJobAttempt('developer', JOB), 2, 'still a2');
  });
});

test('13. two recoveries racing create only a2', async () => {
  await withDir(async (dir) => {
    const store = await goal004(dir);
    await store.setJobStatus('developer', JOB, 'INTERRUPTED');

    const script = join(dir, 'attempt.mjs');
    const storeUrl = new URL('../lib/job-store.mjs', import.meta.url).href;
    await writeFile(script, `
import { createJobStore } from ${JSON.stringify(storeUrl)};
const store = createJobStore(process.argv[2]);
await new Promise((r) => setTimeout(r, Math.max(0, Number(process.argv[3]) - Date.now())));
const r = await store.startNextAttempt('developer', ${JSON.stringify(JOB)}, { reason: 'RACE' });
console.log(r.created ? 'CREATED:' + r.attemptId : 'REUSED:' + r.reason);
`, 'utf8');

    const at = String(Date.now() + 300);
    const [a, b] = await Promise.all([
      execFileAsync(process.execPath, [script, dir, at]),
      execFileAsync(process.execPath, [script, dir, at]),
    ]);
    const results = [a.stdout.trim(), b.stdout.trim()];

    assert.equal(results.filter((r) => r.startsWith('CREATED:')).length, 1, `one winner: ${results}`);
    assert.equal(await store.readJobAttempt('developer', JOB), 2, 'and the loser did not add a third');
  });
});

test('14. a live a2 blocks another attempt', async () => {
  await withDir(async (dir) => {
    const store = await goal004(dir);
    await store.setJobStatus('developer', JOB, 'INTERRUPTED');
    await store.startNextAttempt('developer', JOB, { reason: 'PROCESS_GONE' });
    await store.setJobStatus('developer', JOB, 'RUNNING');

    const blocked = await store.startNextAttempt('developer', JOB, { reason: 'AGAIN' });
    assert.equal(blocked.created, false);
    assert.equal(blocked.reason, 'ATTEMPT_RUNNING');

    const dispatched = await store.dispatchJob('developer', correctionJob());
    assert.equal(dispatched.outcome, JOB_DISPATCH.ALREADY_RUNNING);
  });
});

test('15. a completed a2 is reused, never re-attempted', async () => {
  await withDir(async (dir) => {
    const store = await goal004(dir);
    await store.setJobStatus('developer', JOB, 'INTERRUPTED');
    await store.startNextAttempt('developer', JOB, { reason: 'PROCESS_GONE' });
    await store.publishResult('developer', JOB, ok({
      protocolVersion: PROTOCOL_VERSION_V2, jobId: JOB, goal: GOAL, round: 2,
      status: 'REVIEW_REQUIRED', summary: 'corrigido',
    }), { attemptId: (await store.readAttemptState('developer', JOB))?.attemptId });
    await store.setJobStatus('developer', JOB, 'COMPLETED');

    const again = await store.startNextAttempt('developer', JOB, { reason: 'X' });
    assert.equal(again.created, false);
    assert.equal(again.reason, 'STAGE_ALREADY_COMPLETED');

    const dispatched = await store.dispatchJob('developer', correctionJob());
    assert.equal(dispatched.outcome, JOB_DISPATCH.ALREADY_COMPLETED);
  });
});

test('16. a2 dying without a result earns a3', async () => {
  await withDir(async (dir) => {
    const store = await goal004(dir);
    await store.setJobStatus('developer', JOB, 'INTERRUPTED');
    await store.startNextAttempt('developer', JOB, { reason: 'FIRST_CRASH' });
    await store.setJobStatus('developer', JOB, 'RUNNING');
    await store.setJobStatus('developer', JOB, 'INTERRUPTED');

    const third = await store.startNextAttempt('developer', JOB, { reason: 'SECOND_CRASH' });
    assert.equal(third.created, true);
    assert.equal(third.attemptId, `${JOB}-a3`);

    const state = await store.readAttemptState('developer', JOB);
    assert.deepEqual(state.history.map((h) => h.attemptId), [`${JOB}-a1`, `${JOB}-a2`],
      'both earlier attempts are kept');
  });
});

test('18. FAILED is not retried by a restart', async () => {
  await withDir(async (dir) => {
    const store = await goal004(dir);
    await store.setJobStatus('developer', JOB, 'FAILED');
    await assert.rejects(store.startNextAttempt('developer', JOB, { reason: 'X' }), codeIs('STAGE_NOT_RETRYABLE'));
  });
});

// ===========================================================================
// 11, 17, 19–24. What must not regress
// ===========================================================================

test('17/19. a completed logical stage still refuses every new attempt', async () => {
  await withDir(async (dir) => {
    const store = await goal004(dir);
    await store.setJobStatus('developer', JOB, 'INTERRUPTED');
    await store.startNextAttempt('developer', JOB, { reason: 'PROCESS_GONE' });

    const reconciled = await reconcileExecutionState({ store, goal: GOAL });
    for (const stage of [STAGES.IMPLEMENTATION, STAGES.REVIEW]) {
      assert.throws(() => assertNoDuplicateStageDispatch({
        ledger: reconciled.ledger, goal: GOAL, round: 1, stage, jobId: 'fresh',
      }), codeIs('DUPLICATE_COMPLETED_STAGE_DISPATCH'), stage);
    }
    // R1's implementation completed, so no attempt at it can be made at all.
    const r1 = await store.startNextAttempt('developer', DEV_R1, { reason: 'X' });
    assert.equal(r1.created, false);
    assert.equal(r1.reason, 'STAGE_ALREADY_COMPLETED');
    assert.equal(reconciled.next.round, 2, 'never back to round 1');
  });
});

test('20/21/22. the four blockers and both bases survive every attempt', async () => {
  await withDir(async (dir) => {
    const store = await goal004(dir);
    await store.setJobStatus('developer', JOB, 'INTERRUPTED');
    await store.startNextAttempt('developer', JOB, { reason: 'PROCESS_GONE' });
    await store.setJobStatus('developer', JOB, 'INTERRUPTED');
    await store.startNextAttempt('developer', JOB, { reason: 'AGAIN' });

    const job = await store.readJob('developer', JOB);
    assert.deepEqual(job.blockers, BLOCKERS.map((b) => b.title), 'the four blockers, unchanged');
    assert.equal(job.executionBase, BASE);
    assert.equal(job.worktreeInitialHead, BASE);
    assert.equal(job.round, 2);
  });
});

test('24. nothing in the attempt path can reach a model', async () => {
  for (const file of ['../lib/job-store.mjs', '../lib/reconcile.mjs']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /runAgent|spawnClaude|--model|claude-opus|claude-fable|claude-sonnet|claude-haiku/,
      `${file} must not be able to invoke a model`);
  }
});

test('the fingerprint of each attempt is kept, never overwritten by the next', async () => {
  const source = await readFile(new URL('../run-goal.mjs', import.meta.url), 'utf8');
  assert.match(source, /worktree-fingerprint-before-a\$\{attemptNumber\}\.json/);
  assert.doesNotMatch(source, /'worktree-fingerprint-before\.json'/,
    'the single-file version lost the state each attempt started from');
});

// ===========================================================================
// The integration
// ===========================================================================

test('THE INTEGRATION: a1 running, process dies, recover, a2 claimed, result, review is next', async () => {
  await withDir(async (dir) => {
    const store = await goal004(dir);
    const leases = createLeaseStore(dir);

    // --- a1 is running, held by a worker -----------------------------------
    await store.setJobStatus('developer', JOB, 'RUNNING');
    const { lease: a1Lease } = await leases.claimJob(JOB, {
      agent: 'developer', attemptId: attemptIdOf(JOB, 1), worktree: '.ai-worktrees/goal-004',
    });
    await leases.claimWorktree('.ai-worktrees/goal-004', { attemptId: attemptIdOf(JOB, 1), agent: 'developer' });

    // --- the process dies; recovery proves it and retires the lease ---------
    await leases.retireJob(JOB, { expected: a1Lease, proof: 'PROCESS_GONE' });
    await leases.retireWorktree('.ai-worktrees/goal-004', {
      expected: await leases.readWorktreeLease('.ai-worktrees/goal-004'), proof: 'PROCESS_GONE',
    });
    await store.setJobStatus('developer', JOB, 'INTERRUPTED');

    // --- recovery materialises a2 ------------------------------------------
    const started = await store.startNextAttempt('developer', JOB, { reason: 'PROCESS_GONE' });
    assert.equal(started.attemptId, `${JOB}-a2`);
    assert.equal((await store.readAttemptState('developer', JOB)).attemptStatus, 'QUEUED');

    // --- a fake developer claims a2 ----------------------------------------
    const attemptNumber = await store.readJobAttempt('developer', JOB);
    assert.equal(attemptNumber, 2);
    const claim = await leases.claimJob(JOB, { agent: 'developer', attemptId: attemptIdOf(JOB, attemptNumber) });
    assert.equal(claim.acquired, true, 'the worktree and job are free for a2');
    await store.setJobStatus('developer', JOB, 'RUNNING');

    // --- it produces a result ----------------------------------------------
    await store.publishResult('developer', JOB, ok({
      protocolVersion: PROTOCOL_VERSION_V2, jobId: JOB, goal: GOAL, round: 2,
      status: 'REVIEW_REQUIRED', summary: 'quatro blockers corrigidos',
    }), { attemptId: (await store.readAttemptState('developer', JOB))?.attemptId });
    await store.setJobStatus('developer', JOB, 'COMPLETED');
    await leases.releaseJob(JOB);

    // --- and the loop moves to the review of round 2 ------------------------
    const reconciled = await reconcileExecutionState({ store, goal: GOAL });
    assert.equal(reconciled.ledger.get('004:r2:correction').status, STAGE_STATUS.COMPLETED);
    assert.equal(reconciled.next.kind, DISPATCH_KINDS.REVIEW);
    assert.equal(reconciled.next.round, 2);
    assert.equal(reconciled.next.role, 'tech_lead');

    // Nothing about round 1 was ever re-dispatched along the way.
    for (const stage of [STAGES.IMPLEMENTATION, STAGES.REVIEW]) {
      assert.throws(() => assertNoDuplicateStageDispatch({
        ledger: reconciled.ledger, goal: GOAL, round: 1, stage, jobId: 'fresh',
      }), codeIs('DUPLICATE_COMPLETED_STAGE_DISPATCH'));
    }
  });
});
