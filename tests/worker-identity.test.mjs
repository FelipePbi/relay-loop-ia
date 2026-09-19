/**
 * Regression tests for the worker singleton guard.
 *
 * The incident, 2026-09-09: a Tech Lead restart left the previous process
 * alive, and two of them polled the same queue for five hours. Every existing
 * guard behaved correctly — the job lease let exactly one execute and the other
 * refused once a second — but nothing anywhere answered "is another worker of
 * this role already running?", so the duplicate never stopped, and the work ran
 * in the older process, on code from before the telemetry existed.
 *
 * These tests cover the four ways that ends: a live holder, a stale lease whose
 * holder is provably gone, a reboot, and a recycled pid. Plus the code-freshness
 * latch, because a worker executing a version that no longer exists on disk is
 * the second half of what went wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLeaseStore, LEASE_CONFIG } from '../lib/leases.mjs';
import { LIVENESS } from '../lib/process-inspector.mjs';
import {
  IDENTITY_VERDICTS,
  acquireWorkerIdentity,
  codeChangedSince,
  computeCodeVersion,
  describeHolder,
  judgeWorkerLease,
} from '../lib/worker-identity.mjs';

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ia-loop-identity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

/**
 * An inspector whose answers are fixed by the test, never by the real OS.
 *
 * `exists` returns the THREE-state LIVENESS the real inspector returns, not a
 * boolean. An earlier version of this fake returned booleans, and that is
 * exactly why a real bug survived a green suite: the production code treated
 * the answer as a boolean, `'GONE'` is truthy, and a provably dead holder was
 * therefore judged UNCERTAIN — so the role stayed locked after a crash. A fake
 * that is easier than the real contract does not test the real contract.
 */
function fakeInspector({
  bootAt = '2026-09-09T02:00:00.000Z',
  alive = new Set(),
  unknown = new Set(),
  startedAt = {},
} = {}) {
  return {
    self: () => ({}),
    bootAt: () => bootAt,
    hostname: () => 'test-host',
    exists: (pid) => {
      if (unknown.has(pid)) return LIVENESS.UNKNOWN;
      return alive.has(pid) ? LIVENESS.ALIVE : LIVENESS.GONE;
    },
    startedAt: async (pid) => startedAt[pid] ?? null,
  };
}

const NOW = Date.parse('2026-09-09T20:00:00.000Z');
const FRESH = new Date(NOW - 1000).toISOString();
const STALE = new Date(NOW - LEASE_CONFIG.expiryMs - 60_000).toISOString();

function leaseFor({ heartbeatAt = FRESH, pid = 4242, bootAt = '2026-09-09T02:00:00.000Z', processStartedAt = '2026-09-09T10:00:00.000Z' } = {}) {
  return {
    kind: 'worker', key: 'tech_lead', role: 'tech_lead',
    workerInstanceId: `${pid}-abcd1234`,
    hostname: 'test-host', bootAt, pid, processStartedAt,
    status: 'ACTIVE', version: 3,
    acquiredAt: heartbeatAt, heartbeatAt,
    expiresAt: new Date(Date.parse(heartbeatAt) + LEASE_CONFIG.expiryMs).toISOString(),
  };
}

// --- judgement -------------------------------------------------------------

test('a live, heartbeating holder is never displaced', async () => {
  const judgement = await judgeWorkerLease({
    lease: leaseFor(),
    inspector: fakeInspector({ alive: new Set([4242]) }),
    now: NOW,
  });
  assert.equal(judgement.verdict, IDENTITY_VERDICTS.HELD_BY_LIVE_WORKER);
});

test('a stale lease whose pid is gone is safe to take over', async () => {
  const judgement = await judgeWorkerLease({
    lease: leaseFor({ heartbeatAt: STALE }),
    inspector: fakeInspector({ alive: new Set() }),
    now: NOW,
  });
  assert.equal(judgement.verdict, IDENTITY_VERDICTS.HOLDER_GONE);
});

test('a lease written before the current boot cannot have a living holder', async () => {
  const judgement = await judgeWorkerLease({
    // The pid is even "alive" — irrelevant, because the machine has rebooted
    // since, so that pid belongs to something else by definition.
    lease: leaseFor({ heartbeatAt: STALE, bootAt: '2026-09-01T00:00:00.000Z' }),
    inspector: fakeInspector({ bootAt: '2026-09-09T02:00:00.000Z', alive: new Set([4242]) }),
    now: NOW,
  });
  assert.equal(judgement.verdict, IDENTITY_VERDICTS.STALE_AFTER_REBOOT);
});

test('a recycled pid is not the holder, and is not mistaken for it', async () => {
  const judgement = await judgeWorkerLease({
    lease: leaseFor({ heartbeatAt: STALE, processStartedAt: '2026-09-09T10:00:00.000Z' }),
    inspector: fakeInspector({
      alive: new Set([4242]),
      // Same pid, different process: it started hours later.
      startedAt: { 4242: '2026-09-09T19:00:00.000Z' },
    }),
    now: NOW,
  });
  assert.equal(judgement.verdict, IDENTITY_VERDICTS.PID_RECYCLED);
});

test('a stale lease whose process is alive and unchanged fails closed', async () => {
  const judgement = await judgeWorkerLease({
    lease: leaseFor({ heartbeatAt: STALE }),
    inspector: fakeInspector({
      alive: new Set([4242]),
      startedAt: { 4242: '2026-09-09T10:00:00.000Z' },
    }),
    now: NOW,
  });
  assert.equal(judgement.verdict, IDENTITY_VERDICTS.UNCERTAIN,
    'alive but silent is not proof of death; two workers is the worse outcome');
});

test('a dead holder is recognised even though the OS answer is a truthy string', async () => {
  // The regression: LIVENESS.GONE is the string 'GONE'. Read as a boolean it is
  // true, so the holder looked alive and the role stayed locked after a crash.
  const inspector = fakeInspector({ alive: new Set() });
  assert.equal(inspector.exists(4242), LIVENESS.GONE);
  assert.ok(inspector.exists(4242), 'truthy, which is exactly the trap');

  const judgement = await judgeWorkerLease({
    lease: leaseFor({ heartbeatAt: STALE }), inspector, now: NOW,
  });
  assert.equal(judgement.verdict, IDENTITY_VERDICTS.HOLDER_GONE);
});

test('an OS that will not answer about the pid leaves the role locked', async () => {
  const judgement = await judgeWorkerLease({
    lease: leaseFor({ heartbeatAt: STALE }),
    inspector: fakeInspector({ unknown: new Set([4242]) }),
    now: NOW,
  });
  assert.equal(judgement.verdict, IDENTITY_VERDICTS.UNCERTAIN);
});

test('liveness that cannot be established is uncertain, never available', async () => {
  const judgement = await judgeWorkerLease({
    lease: leaseFor({ heartbeatAt: STALE, processStartedAt: null }),
    inspector: fakeInspector({ alive: new Set([4242]), startedAt: {} }),
    now: NOW,
  });
  assert.equal(judgement.verdict, IDENTITY_VERDICTS.UNCERTAIN);
});

// --- acquisition -----------------------------------------------------------

test('the first worker takes the role; a second is refused at startup', async (t) => {
  const leaseStore = createLeaseStore(scratch(t));

  const first = await acquireWorkerIdentity({ leaseStore, role: 'tech_lead' });
  assert.equal(first.acquired, true);

  const second = await acquireWorkerIdentity({
    leaseStore,
    role: 'tech_lead',
    // The holder is this very process, so it is unambiguously alive.
    inspector: fakeInspector({ alive: new Set([process.pid]) }),
  });
  assert.equal(second.acquired, false);
  assert.equal(second.reason, 'WORKER_ALREADY_RUNNING');
  assert.equal(second.verdict, IDENTITY_VERDICTS.HELD_BY_LIVE_WORKER);
  assert.ok(describeHolder(second.heldBy).includes(String(process.pid)));
});

test('concurrent acquisitions produce exactly one holder', async (t) => {
  const leaseStore = createLeaseStore(scratch(t));
  const inspector = fakeInspector({ alive: new Set([process.pid]) });

  const results = await Promise.all(
    Array.from({ length: 8 }, () => acquireWorkerIdentity({ leaseStore, role: 'developer', inspector })),
  );

  assert.equal(results.filter((r) => r.acquired).length, 1, 'the wx create is the arbiter');
  for (const refused of results.filter((r) => !r.acquired)) {
    assert.ok(['WORKER_ALREADY_RUNNING', 'WORKER_IDENTITY_UNCERTAIN', 'WORKER_IDENTITY_RACE'].includes(refused.reason));
  }
});

test('two different roles never contend with each other', async (t) => {
  const leaseStore = createLeaseStore(scratch(t));
  assert.equal((await acquireWorkerIdentity({ leaseStore, role: 'tech_lead' })).acquired, true);
  assert.equal((await acquireWorkerIdentity({ leaseStore, role: 'developer' })).acquired, true);
});

test('a crashed worker\'s role is recoverable, and the takeover is recorded', async (t) => {
  const dir = scratch(t);
  const leaseStore = createLeaseStore(dir);

  // A previous process claimed the role and died without releasing it.
  const dead = 999_001;
  mkdirSync(leaseStore.paths.workersDir, { recursive: true });
  writeFileSync(
    join(leaseStore.paths.workersDir, 'tech_lead.lock'),
    `${JSON.stringify(leaseFor({ heartbeatAt: STALE, pid: dead }), null, 2)}\n`,
    'utf8',
  );

  const taken = await acquireWorkerIdentity({
    leaseStore,
    role: 'tech_lead',
    inspector: fakeInspector({ alive: new Set() }),
    now: () => NOW,
  });

  assert.equal(taken.acquired, true);
  assert.equal(taken.tookOver, true);
  assert.equal(taken.verdict, IDENTITY_VERDICTS.HOLDER_GONE);
  assert.equal(taken.replaced.pid, dead);
});

test('a normal shutdown releases the role, so a restart just works', async (t) => {
  const leaseStore = createLeaseStore(scratch(t));

  assert.equal((await acquireWorkerIdentity({ leaseStore, role: 'tech_lead' })).acquired, true);
  await leaseStore.releaseWorker('tech_lead');
  assert.equal(await leaseStore.readWorkerLease('tech_lead'), null);

  const restarted = await acquireWorkerIdentity({ leaseStore, role: 'tech_lead' });
  assert.equal(restarted.acquired, true);
  assert.equal(restarted.tookOver, false);
});

test('the lease records everything needed to identify the holder later', async (t) => {
  const leaseStore = createLeaseStore(scratch(t));
  const codeVersion = { version: 'abc123def456', fileCount: 42 };

  const { lease } = await acquireWorkerIdentity({
    leaseStore, role: 'tech_lead', repoRoot: 'E:/repo', codeVersion,
  });

  for (const field of ['role', 'workerInstanceId', 'pid', 'processStartedAt', 'hostname',
    'bootAt', 'repoRoot', 'bootCodeVersion', 'startedAt', 'heartbeatAt', 'expiresAt']) {
    assert.ok(lease[field] !== undefined && lease[field] !== null, `missing ${field}`);
  }
  assert.equal(lease.bootCodeVersion, 'abc123def456');
  assert.equal(lease.pid, process.pid);
  assert.notEqual(lease.workerInstanceId, String(process.pid), 'a pid alone is not an identity');
});

// --- code freshness --------------------------------------------------------

test('the code version covers what a worker loads, and only that', async (t) => {
  const root = scratch(t);
  mkdirSync(join(root, 'lib'), { recursive: true });
  mkdirSync(join(root, 'workers'), { recursive: true });
  writeFileSync(join(root, 'lib', 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(root, 'workers', 'w.mjs'), 'export const w = 1;\n');
  // An operator CLI: runs in its own process, so it cannot change what a
  // running worker executes.
  writeFileSync(join(root, 'run-status.mjs'), 'export const b = 1;\n');
  // Tests: editing one must not force every worker to restart.
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'tests', 'x.test.mjs'), 'test\n');

  const first = await computeCodeVersion({ root });
  assert.equal(first.fileCount, 2, 'lib + workers only');
  assert.equal((await computeCodeVersion({ root })).version, first.version, 'stable when nothing moves');

  writeFileSync(join(root, 'tests', 'x.test.mjs'), 'test changed a lot\n');
  assert.equal((await computeCodeVersion({ root })).version, first.version, 'a test edit is not a code change');

  writeFileSync(join(root, 'run-status.mjs'), 'export const b = 2; // changed\n');
  assert.equal((await computeCodeVersion({ root })).version, first.version,
    'an operator CLI edit must not stop a worker that never loads it');

  writeFileSync(join(root, 'lib', 'a.mjs'), 'export const a = 2; // changed\n');
  assert.notEqual((await computeCodeVersion({ root })).version, first.version);

  const afterLib = await computeCodeVersion({ root });
  writeFileSync(join(root, 'workers', 'w.mjs'), 'export const w = 2; // changed\n');
  assert.notEqual((await computeCodeVersion({ root })).version, afterLib.version);
});

test('a worker detects that its own code was replaced under it', async (t) => {
  const root = scratch(t);
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'lib', 'a.mjs'), 'export const a = 1;\n');

  const boot = await computeCodeVersion({ root });
  assert.equal((await codeChangedSince({ root, bootVersion: boot.version })).changed, false);

  writeFileSync(join(root, 'lib', 'a.mjs'), 'export const a = 1; // patched\n');
  const after = await codeChangedSince({ root, bootVersion: boot.version });
  assert.equal(after.changed, true);
  assert.notEqual(after.current.version, boot.version);
});

test('a touched file counts as a change, because a checkout moves mtime', async (t) => {
  const root = scratch(t);
  mkdirSync(join(root, 'lib'), { recursive: true });
  const file = join(root, 'lib', 'a.mjs');
  writeFileSync(file, 'export const a = 1;\n');

  const boot = await computeCodeVersion({ root });
  const later = new Date(Date.now() + 60_000);
  utimesSync(file, later, later);

  assert.equal((await codeChangedSince({ root, bootVersion: boot.version })).changed, true);
});

test('no boot version recorded means no staleness claim is made', async (t) => {
  assert.deepEqual(
    await codeChangedSince({ root: scratch(t), bootVersion: null }),
    { changed: false, current: null },
  );
});
