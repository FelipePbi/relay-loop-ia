/**
 * V6 job ownership, leases and duplicate-execution prevention.
 *
 * No real model is called. The cross-process claim test spawns two actual Node
 * processes, because two promises in one process would not prove the
 * filesystem primitive is atomic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  LEASE_CONFIG,
  LEASE_STATUS,
  attemptIdFor,
  canStartNewAttempt,
  classifyLease,
  createLeaseStore,
  isResultAuthorised,
  logicalJobId,
  startLeaseHeartbeat,
  workerInstanceId,
  worktreeKey,
} from '../lib/leases.mjs';
import { createJobStore } from '../lib/job-store.mjs';
import { PROTOCOL_VERSION_V2, validateDeveloperJob } from '../lib/contracts-v2.mjs';
import { STATE_REGISTRY, RESUMABLE_STATES } from '../lib/state-registry.mjs';

const execFileAsync = promisify(execFile);
const codeIs = (code) => (error) => error.code === code;
const NOW = Date.parse('2026-09-07T20:00:00.000Z');

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-lease-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

// ===========================================================================
// Logical job / attempt identity
// ===========================================================================

test('1. a logical job is stable while attempts are distinct', () => {
  const jobId = logicalJobId({ goal: '004', round: 2, kind: 'correction' });
  assert.equal(jobId, '004-r2-correction');
  assert.equal(attemptIdFor(jobId, 1), '004-r2-correction-a1');
  assert.equal(attemptIdFor(jobId, 2), '004-r2-correction-a2');
  // The same operation keeps one identity no matter how many attempts it takes.
  assert.equal(logicalJobId({ goal: '004', round: 2, kind: 'correction' }), jobId);
});

test('24. the worker instance id is stable in-process and never empty', () => {
  assert.equal(workerInstanceId(), workerInstanceId());
  assert.match(workerInstanceId(), /^\d+-[0-9a-f]{8}$/);
});

// ===========================================================================
// Atomic claim
// ===========================================================================

test('1/2. a job is claimed once; a second claim is refused', async () => {
  await withDir(async (dir) => {
    const leases = createLeaseStore(dir);

    const first = await leases.claimJob('004-r2-correction', { attemptId: 'a1', agent: 'developer' });
    assert.equal(first.acquired, true);

    const second = await leases.claimJob('004-r2-correction', { attemptId: 'a2', agent: 'developer' });
    assert.equal(second.acquired, false);
    assert.equal(second.reason, 'JOB_ALREADY_CLAIMED');
    assert.equal(second.heldBy.attemptId, 'a1');
  });
});

test('3. two concurrent claims in-process still yield exactly one winner', async () => {
  await withDir(async (dir) => {
    const leases = createLeaseStore(dir);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => leases.claimJob('j', { attemptId: `a${i}` })),
    );
    assert.equal(results.filter((r) => r.acquired).length, 1);
  });
});

test('25. a lease held by another instance is never removed blindly', async () => {
  await withDir(async (dir) => {
    const leases = createLeaseStore(dir);
    await leases.claimJob('j', { attemptId: 'a1' });

    // Rewrite the lease as if another process owned it.
    const path = leases.paths.pathFor('job', 'j');
    const lease = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...lease, workerInstanceId: 'someone-else' }), 'utf8');

    await assert.rejects(leases.releaseJob('j'), codeIs('LEASE_NOT_OWNED'));
    await assert.rejects(leases.renewJob('j'), codeIs('LEASE_NOT_OWNED'));
  });
});

// ===========================================================================
// Worktree ownership
// ===========================================================================

test('4/5. a worktree has one owner; a second writer is refused', async () => {
  await withDir(async (dir) => {
    const leases = createLeaseStore(dir);
    const worktree = '/repo/.ai-worktrees/goal-004';

    const first = await leases.claimWorktree(worktree, { attemptId: 'a1', jobId: '004-r2-correction' });
    assert.equal(first.acquired, true);

    // A different logical job wanting the same tree — the exact incident.
    const second = await leases.claimWorktree(worktree, { attemptId: 'b1', jobId: '004-r3-correction' });
    assert.equal(second.acquired, false);
    assert.equal(second.reason, 'WORKTREE_BUSY');
    assert.equal(second.heldBy.attemptId, 'a1');
  });
});

test('the worktree key is path-stable across separator styles', () => {
  assert.equal(worktreeKey('/repo/.ai-worktrees/goal-004'), worktreeKey('\\repo\\.ai-worktrees\\goal-004'));
  assert.notEqual(worktreeKey('/repo/a'), worktreeKey('/repo/b'));
});

// ===========================================================================
// Heartbeat and liveness
// ===========================================================================

test('10. renewing extends the lease', async () => {
  await withDir(async (dir) => {
    const leases = createLeaseStore(dir);
    const { lease } = await leases.claimJob('j', { attemptId: 'a1' });
    await new Promise((r) => { setTimeout(r, 5); });

    const renewed = await leases.renewJob('j');
    assert.ok(Date.parse(renewed.heartbeatAt) >= Date.parse(lease.heartbeatAt));
    assert.ok(Date.parse(renewed.expiresAt) > Date.parse(lease.acquiredAt));
  });
});

test('the heartbeat keeps renewing during a long inference', async () => {
  await withDir(async (dir) => {
    const leases = createLeaseStore(dir);
    await leases.claimJob('j', { attemptId: 'a1' });
    const before = (await leases.readJobLease('j')).heartbeatAt;

    const stop = startLeaseHeartbeat(leases, { jobId: 'j' }, { intervalMs: 10 });
    await new Promise((r) => { setTimeout(r, 60); });
    await stop();

    assert.notEqual((await leases.readJobLease('j')).heartbeatAt, before);
  });
});

test('an expired lease is SUSPECTED_ORPHAN, never "dead"', () => {
  const fresh = { heartbeatAt: new Date(NOW - 1000).toISOString() };
  const stale = { heartbeatAt: new Date(NOW - LEASE_CONFIG.expiryMs - 1000).toISOString() };

  assert.equal(classifyLease(fresh, { now: NOW }).status, LEASE_STATUS.ACTIVE);
  assert.equal(classifyLease(stale, { now: NOW }).status, LEASE_STATUS.SUSPECTED_ORPHAN);
});

// ===========================================================================
// When a new attempt is allowed
// ===========================================================================

const activeLease = { attemptId: 'a1', heartbeatAt: new Date(NOW - 1000).toISOString() };
const staleLease = { attemptId: 'a1', heartbeatAt: new Date(NOW - LEASE_CONFIG.expiryMs - 5000).toISOString() };

test('6/7/12/14. an active lease blocks a new attempt', () => {
  const verdict = canStartNewAttempt({ lease: activeLease, jobStatus: 'RUNNING', now: NOW });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, 'ATTEMPT_ALREADY_RUNNING');
  assert.equal(verdict.escalate, false);
});

test('11. a stale lease with a healthy worker is still not requeued', () => {
  const verdict = canStartNewAttempt({
    lease: staleLease, jobStatus: 'RUNNING', workerHealth: { health: 'RUNNING' }, now: NOW,
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, 'ATTEMPT_ALREADY_RUNNING');
});

test('12/13. a stale lease with no live worker escalates instead of guessing', () => {
  const verdict = canStartNewAttempt({
    lease: staleLease, jobStatus: 'RUNNING', workerHealth: { health: 'OFFLINE' }, now: NOW,
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, 'ORPHANED_EXECUTION_UNCERTAIN');
  assert.equal(verdict.escalate, true);
  // Fail closed: a child process may still be writing.
  assert.match(verdict.detail, /child process may still be writing/);
});

test('14. a new attempt is allowed only after a terminal state', () => {
  for (const jobStatus of ['COMPLETED', 'FAILED', 'SUPERSEDED', 'QUEUED']) {
    assert.equal(canStartNewAttempt({ lease: null, jobStatus, now: NOW }).allowed, true, jobStatus);
  }
  // RUNNING with no lease cannot be proven finished.
  const ambiguous = canStartNewAttempt({ lease: null, jobStatus: 'RUNNING', now: NOW });
  assert.equal(ambiguous.allowed, false);
  assert.equal(ambiguous.reason, 'ORPHANED_EXECUTION_UNCERTAIN');
});

test('26. a bare PID is never treated as proof', () => {
  // The verdict depends on heartbeat and worker health, never on pid alone:
  // PIDs are reused, so a live pid proves nothing about THIS execution.
  const withPid = { ...staleLease, pid: process.pid };
  const verdict = canStartNewAttempt({ lease: withPid, jobStatus: 'RUNNING', workerHealth: { health: 'OFFLINE' }, now: NOW });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, 'ORPHANED_EXECUTION_UNCERTAIN');
});

// ===========================================================================
// Result fencing
// ===========================================================================

test('17. a result from the authorised attempt is accepted', () => {
  assert.equal(isResultAuthorised({ result: { attemptId: 'a1' }, expectedAttemptId: 'a1' }), true);
});

test('15/16. a stale attempt result is neither accepted nor allowed to overwrite', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    const job = validateDeveloperJob({
      protocolVersion: PROTOCOL_VERSION_V2, jobId: 'j', role: 'developer', goal: '004', round: 2,
      type: 'IMPLEMENTATION',
      migrationAcceptedBaseline: '1'.repeat(40), executionBase: '2'.repeat(40),
      worktree: '/w', goalPath: 'p.md', blockers: [],
    });
    await store.publishJob('developer', job);

    // Real attempt ids, materialised the way the store materialises them: the
    // authorised attempt is now whatever the JOB says it is, so a late writer
    // cannot authorise itself by claiming to be expected.
    await store.setJobStatus('developer', 'j', 'INTERRUPTED');
    const a2 = await store.startNextAttempt('developer', 'j', { reason: 'INTERRUPTED' });
    assert.equal(a2.attemptId, 'j-a2');

    await store.publishResult('developer', 'j', { ok: true, result: { from: 'a2' } }, { attemptId: 'j-a2' });

    await assert.rejects(
      store.publishResult('developer', 'j', { ok: true, result: { from: 'a1' } },
        { attemptId: 'j-a1' }),
      codeIs('STALE_ATTEMPT_RESULT'),
    );

    // The authorised result stands, and the late one is kept for audit.
    const current = await store.readResult('developer', 'j');
    assert.equal(current.result.from, 'a2');
    const stale = JSON.parse(await readFile(join(dir, 'results', 'developer', 'j.stale-j-a1.json'), 'utf8'));
    assert.equal(stale.staleAttemptId, 'j-a1');
  });
});

test('a published result carries its attempt identity', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    await store.publishResult('developer', 'j', { ok: true, result: {} }, { attemptId: 'a1' });
    assert.equal((await store.readResult('developer', 'j')).attemptId, 'a1');
    // And a fenced read only answers for the attempt it was asked about.
    assert.equal(await store.readResult('developer', 'j', { expectedAttemptId: 'a1' }) !== null, true);
    assert.equal(await store.readResult('developer', 'j', { expectedAttemptId: 'a2' }), null);
  });
});

// ===========================================================================
// Cross-process atomicity — two real Node processes
// ===========================================================================

test('3/CROSS. two separate processes racing for one claim: exactly one wins', async () => {
  await withDir(async (dir) => {
    const script = join(dir, 'claim.mjs');
    const libUrl = new URL('../lib/leases.mjs', import.meta.url).href;

    await writeFile(script, `
import { createLeaseStore } from ${JSON.stringify(libUrl)};
const leases = createLeaseStore(process.argv[2]);
// Both processes aim at the same instant, so the race is real.
const target = Number(process.argv[3]);
await new Promise((r) => setTimeout(r, Math.max(0, target - Date.now())));
const result = await leases.claimJob('contested', { attemptId: process.argv[4] });
console.log(result.acquired ? 'ACQUIRED' : 'REFUSED');
`, 'utf8');

    const startAt = Date.now() + 300;
    const [a, b] = await Promise.all([
      execFileAsync(process.execPath, [script, dir, String(startAt), 'a1']),
      execFileAsync(process.execPath, [script, dir, String(startAt), 'b1']),
    ]);

    const outcomes = [a.stdout.trim(), b.stdout.trim()].sort();
    assert.deepEqual(outcomes, ['ACQUIRED', 'REFUSED'],
      'exactly one of two OS processes may hold the claim');
  });
});

test('23. a lease survives a restart and is readable by a new store handle', async () => {
  await withDir(async (dir) => {
    const first = createLeaseStore(dir);
    await first.claimJob('j', { attemptId: 'a1', agent: 'developer' });

    // A fresh handle stands in for a restarted orchestrator.
    const reopened = createLeaseStore(dir);
    const lease = await reopened.readJobLease('j');
    assert.equal(lease.attemptId, 'a1');
    assert.equal(classifyLease(lease).status, LEASE_STATUS.ACTIVE);
  });
});

// ===========================================================================
// Canonical registry still intact
// ===========================================================================

test('29. the canonical state registry stays the single source', () => {
  const derived = Object.entries(STATE_REGISTRY)
    .filter(([, def]) => def.resumable === true).map(([n]) => n).sort();
  assert.deepEqual([...RESUMABLE_STATES].sort(), derived);
});
