/**
 * Recovery after a process restart.
 *
 * No model is called anywhere here, and no test depends on the machine it runs
 * on: process liveness, boot time and hostname all come from an injected fake.
 *
 * The case these were written for is real. The machine rebooted while Goal004
 * was in REVIEWER_RUNNING; the Tech Lead's answer landed on disk four seconds
 * after the last heartbeat, and the orchestrator died before reading it.
 * Recovery has to notice that and consume the result — not pay for it twice.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { LIVENESS, sameBoot } from '../lib/process-inspector.mjs';
import {
  OWNER_STATUS,
  collectOwnerEvidence,
  isRecoveryEligible,
  judgeOwner,
} from '../lib/orphan-evidence.mjs';
import { RECOVERY_ACTIONS, AGENT_EXECUTION_STATES, planRecovery, resolveRecoveryJob } from '../lib/recovery-plan.mjs';
import { buildStageLedger, STAGE_JOB_SOURCE } from '../lib/reconcile.mjs';
import { createLeaseStore } from '../lib/leases.mjs';
import { createAutonomousStore } from '../lib/autonomous-state.mjs';
import {
  JOB_STATUSES,
  NON_CLAIMABLE_JOB_STATUSES,
  isClaimableJobStatus,
  isTerminalJobStatus,
} from '../lib/job-store.mjs';
import { planResume, reclaimBlockedJobLease } from '../run-resume.mjs';
import { LOOP_STATES } from '../lib/loop-state.mjs';

const execFileAsync = promisify(execFile);
const codeIs = (code) => (error) => error.code === code;

const NOW = Date.parse('2026-09-07T20:00:00.000Z');
const BOOT_OLD = '2026-09-07T10:00:00.000Z';
const BOOT_NEW = '2026-09-07T19:50:00.000Z';
const iso = (ms) => new Date(ms).toISOString();

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-recover-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

/** A machine that answers only what the test tells it to. */
function fakeInspector({ host = 'HOST-A', bootAt = BOOT_OLD, alive = {}, startedAt = {} } = {}) {
  return {
    hostname: () => host,
    bootAt: () => bootAt,
    self: () => ({ hostname: host, bootAt, pid: 1, processStartedAt: BOOT_OLD }),
    exists: (pid) => alive[pid] ?? LIVENESS.UNKNOWN,
    startedAt: async (pid) => startedAt[pid] ?? null,
  };
}

function leaseAt({ ageMs = 0, acquiredAt = BOOT_OLD, pid = 4242, ...rest } = {}) {
  return {
    jobId: 'migration-loop',
    workerInstanceId: `${pid}-abc123`,
    attemptId: 'migration-loop-a1',
    pid,
    hostname: 'HOST-A',
    bootAt: BOOT_OLD,
    processStartedAt: '2026-09-07T11:00:00.000Z',
    acquiredAt,
    heartbeatAt: iso(NOW - ageMs),
    ...rest,
  };
}

const judge = async (lease, inspector) =>
  judgeOwner({ lease, evidence: await collectOwnerEvidence(lease, inspector, { now: NOW }), now: NOW });

// ===========================================================================
// 1–5. From suspicion to proof
// ===========================================================================

test('1. a recent heartbeat is not an orphan, whatever else is true', async () => {
  // Even with the process gone from the fake, a live heartbeat settles it: a
  // process that wrote a second ago was alive a second ago.
  const verdict = await judge(
    leaseAt({ ageMs: 5_000 }),
    fakeInspector({ alive: { 4242: LIVENESS.GONE } }),
  );
  assert.equal(verdict.status, OWNER_STATUS.ACTIVE);
  assert.equal(isRecoveryEligible(verdict), false);
});

test('2. an expired heartbeat with the holder confirmed alive is NOT recovered', async () => {
  const started = '2026-09-07T11:00:00.000Z';
  const verdict = await judge(
    leaseAt({ ageMs: 600_000, processStartedAt: started }),
    fakeInspector({ alive: { 4242: LIVENESS.ALIVE }, startedAt: { 4242: started } }),
  );
  assert.equal(verdict.status, OWNER_STATUS.OWNER_ALIVE);
  assert.equal(isRecoveryEligible(verdict), false);
  assert.match(verdict.detail, /may still write/);
});

test('3. an expired heartbeat with the process gone is a confirmed orphan', async () => {
  const verdict = await judge(
    leaseAt({ ageMs: 600_000 }),
    fakeInspector({ alive: { 4242: LIVENESS.GONE } }),
  );
  assert.equal(verdict.status, OWNER_STATUS.ORPHAN_CONFIRMED);
  assert.equal(verdict.proof, 'PROCESS_GONE');
  assert.equal(isRecoveryEligible(verdict), true);
});

test('4. a recycled pid is an orphan: same number, different process', async () => {
  const verdict = await judge(
    leaseAt({ ageMs: 600_000, processStartedAt: '2026-09-07T11:00:00.000Z' }),
    fakeInspector({
      alive: { 4242: LIVENESS.ALIVE },
      startedAt: { 4242: '2026-09-07T19:55:00.000Z' },
    }),
  );
  assert.equal(verdict.proof, 'PID_REUSED');
  assert.equal(isRecoveryEligible(verdict), true);
});

test('5. a reboot after the lease was taken is proof on its own', async () => {
  // The real Goal004 case: nothing about the old process can be inspected, but
  // the machine booted after the lease existed, so nothing holding it survived.
  const verdict = await judge(
    leaseAt({ ageMs: 600_000, acquiredAt: '2026-09-07T19:14:46.748Z' }),
    fakeInspector({ bootAt: BOOT_NEW, alive: { 4242: LIVENESS.ALIVE } }),
  );
  assert.equal(verdict.proof, 'DIFFERENT_BOOT');
  assert.equal(isRecoveryEligible(verdict), true);
});

test('5b. a lease with no identity at all is still recoverable after a reboot', async () => {
  // Leases written before this feature carry no bootAt, hostname or start time.
  // The reboot proof only needs the lease's own acquiredAt, so the very lease a
  // first crash leaves behind is not a dead end.
  const legacy = {
    jobId: 'migration-loop', workerInstanceId: '428-bf3a6d32', pid: 428,
    acquiredAt: '2026-09-07T19:14:46.748Z', heartbeatAt: '2026-09-07T19:24:37.408Z',
  };
  const verdict = await judge(legacy, fakeInspector({ bootAt: BOOT_NEW, alive: { 428: LIVENESS.ALIVE } }));
  assert.equal(verdict.proof, 'DIFFERENT_BOOT');
  assert.equal(isRecoveryEligible(verdict), true);
});

test('a pid that exists with no start time available stays SUSPECTED, never confirmed', async () => {
  const verdict = await judge(
    leaseAt({ ageMs: 600_000 }),
    fakeInspector({ alive: { 4242: LIVENESS.ALIVE }, startedAt: {} }),
  );
  assert.equal(verdict.status, OWNER_STATUS.SUSPECTED_ORPHAN);
  assert.equal(isRecoveryEligible(verdict), false);
});

test('a lease from another machine is never judged from here', async () => {
  const verdict = await judge(
    leaseAt({ ageMs: 600_000, hostname: 'HOST-B' }),
    fakeInspector({ host: 'HOST-A' }),
  );
  assert.equal(verdict.status, OWNER_STATUS.FOREIGN_HOST);
  assert.equal(isRecoveryEligible(verdict), false);
});

test('boot times within tolerance are the same boot; a reboot is far outside it', () => {
  assert.equal(sameBoot(BOOT_OLD, iso(Date.parse(BOOT_OLD) + 1500)), true, 'uptime sampling drift');
  assert.equal(sameBoot(BOOT_OLD, BOOT_NEW), false);
  assert.equal(sameBoot('not-a-date', BOOT_OLD), null, 'unknowable is not equal');
});

test('25. an unreadable heartbeat fails closed instead of being read as old', () => {
  assert.throws(
    () => judgeOwner({ lease: leaseAt({ heartbeatAt: 'garbage' }), evidence: null, now: NOW }),
    codeIs('LEASE_CORRUPT'),
  );
});

// ===========================================================================
// 6–7. Suspicion alone never takes a lease
// ===========================================================================

test('6/7. only a proven orphan is eligible; every other verdict is refused', () => {
  for (const status of [OWNER_STATUS.ACTIVE, OWNER_STATUS.SUSPECTED_ORPHAN,
    OWNER_STATUS.OWNER_ALIVE, OWNER_STATUS.FOREIGN_HOST]) {
    assert.equal(isRecoveryEligible({ status, proof: null }), false, status);
  }
  assert.equal(isRecoveryEligible({ status: OWNER_STATUS.ORPHAN_CONFIRMED, proof: 'PROCESS_GONE' }), true);
  // A confirmation without a named proof is not a confirmation.
  assert.equal(isRecoveryEligible({ status: OWNER_STATUS.ORPHAN_CONFIRMED, proof: null }), false);
  assert.equal(isRecoveryEligible({ status: OWNER_STATUS.ORPHAN_CONFIRMED, proof: 'BECAUSE_I_SAY_SO' }), false);
});

// ===========================================================================
// 8–9. Takeover is atomic
// ===========================================================================

test('8. takeover swaps the lease and archives the one it replaced', async () => {
  await withDir(async (dir) => {
    const leases = createLeaseStore(dir);
    const first = await leases.claimJob('migration-loop', { autonomousRunId: 'auto-1', attemptId: 'migration-loop-a1' });

    const taken = await leases.takeoverJob('migration-loop', {
      expected: first.lease,
      proof: 'DIFFERENT_BOOT',
      payload: { autonomousRunId: 'auto-1', attemptId: 'migration-loop-a2', attempt: 2 },
    });

    assert.equal(taken.acquired, true);
    assert.equal(taken.lease.attemptId, 'migration-loop-a2');

    // The replaced lease is history, not garbage.
    const archived = JSON.parse(await readFile(join(dir, 'leases', 'jobs', 'migration-loop.lock.superseded'), 'utf8'));
    assert.equal(archived.workerInstanceId, first.lease.workerInstanceId);
    assert.equal(archived.status, 'SUPERSEDED');
    assert.equal(archived.supersededProof, 'DIFFERENT_BOOT');
  });
});

test('8b. a lease that changed since it was judged is never overwritten', async () => {
  await withDir(async (dir) => {
    const leases = createLeaseStore(dir);
    const first = await leases.claimJob('migration-loop', { autonomousRunId: 'auto-1' });
    const judged = { ...first.lease };

    // The holder woke up and heartbeated between the judgement and the swap.
    await leases.renewJob('migration-loop');

    const taken = await leases.takeoverJob('migration-loop', {
      expected: judged, proof: 'PROCESS_GONE', payload: { autonomousRunId: 'auto-1' },
    });
    assert.equal(taken.acquired, false);
    assert.equal(taken.reason, 'LEASE_CHANGED_SINCE_JUDGEMENT');
    assert.equal((await leases.readJobLease('migration-loop')).workerInstanceId, first.lease.workerInstanceId);
  });
});

test('9. two real processes recovering at once: exactly one wins', async () => {
  await withDir(async (dir) => {
    const leases = createLeaseStore(dir);
    const held = await leases.claimJob('migration-loop', { autonomousRunId: 'auto-1' });

    const script = join(dir, 'takeover.mjs');
    const libUrl = new URL('../lib/leases.mjs', import.meta.url).href;
    await writeFile(script, `
import { createLeaseStore } from ${JSON.stringify(libUrl)};
const leases = createLeaseStore(process.argv[2]);
const expected = JSON.parse(process.argv[4]);
await new Promise((r) => setTimeout(r, Math.max(0, Number(process.argv[3]) - Date.now())));
const r = await leases.takeoverJob('migration-loop', {
  expected, proof: 'PROCESS_GONE', payload: { autonomousRunId: 'auto-1' },
});
console.log(r.acquired ? 'WON' : 'LOST:' + r.reason);
`, 'utf8');

    const at = String(Date.now() + 300);
    const payload = JSON.stringify(held.lease);
    const [a, b] = await Promise.all([
      execFileAsync(process.execPath, [script, dir, at, payload]),
      execFileAsync(process.execPath, [script, dir, at, payload]),
    ]);

    const results = [a.stdout.trim(), b.stdout.trim()];
    assert.equal(results.filter((r) => r === 'WON').length, 1, `exactly one winner, got ${results}`);
    assert.ok(results.some((r) => r.startsWith('LOST:')), `the loser must say why: ${results}`);
  });
});

// ===========================================================================
// 10–14. What recovery does, per state
// ===========================================================================

const confirmed = { status: OWNER_STATUS.ORPHAN_CONFIRMED, proof: 'DIFFERENT_BOOT', detail: 'rebooted' };
const runtimeAt = (state, over = {}) => ({
  mode: 'REAL_EXECUTION', goal: '004', round: 1, state, currentJobId: 'job-1', ...over,
});
// jobId defaults to the runtime's own currentJobId here only because these
// tests are checking planRecovery's DECISION given an already-resolved job,
// not the resolution itself (see the "hint never overrides the ledger"
// section below for that). The real caller (run-recover.mjs) never passes
// runtime.currentJobId itself — it resolves this from the stage ledger via
// resolveRecoveryJob first.
const plan = (state, over = {}, facts = {}) => planRecovery({
  runtime: runtimeAt(state, over), ownerVerdict: confirmed, leaseExists: true, jobId: 'job-1', ...facts,
});

test('10. REVIEWER_RUNNING with the review already on disk does not call the Tech Lead again', () => {
  const p = plan(LOOP_STATES.REVIEWER_RUNNING, {}, { resultExists: true });
  assert.equal(p.action, RECOVERY_ACTIONS.CONSUME_RESULT);
  assert.equal(p.agent, 'tech_lead');
  assert.equal(p.jobId, 'job-1');
  assert.match(p.message, /consumed, not recomputed/);
});

test('11. REVIEWER_RUNNING with no result re-queues the same review job', () => {
  const p = plan(LOOP_STATES.REVIEWER_RUNNING, {}, { resultExists: false, jobStatus: 'RUNNING' });
  assert.equal(p.action, RECOVERY_ACTIONS.REQUEUE_JOB);
  assert.equal(p.agent, 'tech_lead');
  assert.equal(p.jobId, 'job-1', 'the same job, not a new one');
  assert.match(p.message, /same Goal, same round, same packet/);
});

test('12. DEVELOPER_RUNNING with a result on disk never re-runs the Developer', () => {
  const p = plan(LOOP_STATES.DEVELOPER_RUNNING, {}, { resultExists: true });
  assert.equal(p.action, RECOVERY_ACTIONS.CONSUME_RESULT);
  assert.equal(p.agent, 'developer');
});

test('13. DEVELOPER_RUNNING with no result marks the attempt INTERRUPTED and retries explicitly', () => {
  const p = plan(LOOP_STATES.DEVELOPER_RUNNING, {}, { resultExists: false, jobStatus: 'RUNNING' });
  assert.equal(p.action, RECOVERY_ACTIONS.REQUEUE_JOB);
  assert.equal(p.agent, 'developer');
  assert.match(p.message, /INTERRUPTED/);
});

test('14. a correction round recovers exactly like the implementation round', () => {
  assert.equal(plan(LOOP_STATES.CORRECTION_RUNNING, {}, { resultExists: true }).action,
    RECOVERY_ACTIONS.CONSUME_RESULT);
  const requeue = plan(LOOP_STATES.CORRECTION_RUNNING, { round: 2 }, { resultExists: false });
  assert.equal(requeue.action, RECOVERY_ACTIONS.REQUEUE_JOB);
  assert.equal(requeue.agent, 'developer');
});

// ===========================================================================
// 14b-14e. resolveRecoveryJob: the ledger decides, the runtime pointer never
// does. The Goal010 shape, one level down from run-goal.mjs's dispatch: a
// crash can leave runtime.currentJobId aimed at a job the ledger has since
// disowned (SUPERSEDED, or from a round that already moved on), and
// setJobStatus has no guard against flipping a SUPERSEDED job back to
// INTERRUPTED — which is exactly what would make it claimable again.
// ===========================================================================

const recoveryJob = (jobId, { role = 'developer', round = 2, type = 'IMPLEMENTATION', status = 'QUEUED', result = null } = {}) => ({
  role, status, result,
  job: { jobId, role, goal: '010', round, type },
});

test('14b. a genuinely interrupted attempt at the current stage is resumed by its own id', () => {
  const ledger = buildStageLedger([recoveryJob('010-r2-developer-aaaaaaaa', { status: 'INTERRUPTED' })]);
  const runtime = { goal: '010', round: 2, state: LOOP_STATES.DEVELOPER_RUNNING, currentJobId: '010-r2-developer-aaaaaaaa' };
  const resolved = resolveRecoveryJob({ reconciled: { ledger }, runtime });
  assert.equal(resolved.jobId, '010-r2-developer-aaaaaaaa');
  assert.equal(resolved.resultExists, false);
  assert.equal(resolved.source, STAGE_JOB_SOURCE.RESUMED_ATTEMPT);
});

test('14c. a completed stage resolves to the completing job even when the runtime pointer disagrees', () => {
  const ledger = buildStageLedger([recoveryJob('010-r1-tech_lead-real0001', {
    role: 'tech_lead', round: 1, status: 'COMPLETED', result: { decision: 'CHANGES_REQUIRED' },
  })]);
  const runtime = { goal: '010', round: 1, state: LOOP_STATES.REVIEWER_RUNNING, currentJobId: 'stale-pointer' };
  const resolved = resolveRecoveryJob({ reconciled: { ledger }, runtime });
  assert.equal(resolved.jobId, '010-r1-tech_lead-real0001');
  assert.equal(resolved.resultExists, true);
  assert.equal(resolved.source, STAGE_JOB_SOURCE.COMPLETED);
});

test('14d. a SUPERSEDED job named by a stale runtime pointer is never revived', () => {
  // Exactly the Goal010 incident shape: the runtime still points at the
  // review that was superseded for having reviewed the wrong DeveloperResult.
  const ledger = buildStageLedger([recoveryJob('010-r2-tech_lead-stale001', {
    role: 'tech_lead', round: 2, status: 'SUPERSEDED',
  })]);
  const runtime = { goal: '010', round: 2, state: LOOP_STATES.REVIEWER_RUNNING, currentJobId: '010-r2-tech_lead-stale001' };

  const resolved = resolveRecoveryJob({ reconciled: { ledger }, runtime });
  assert.equal(resolved.jobId, null, 'the ledger disowns it; recovery must not name it');
  assert.equal(resolved.resultExists, false);
  assert.equal(resolved.source, STAGE_JOB_SOURCE.NEW_JOB_REQUIRED);

  // planRecovery, given that answer, admits it does not know rather than
  // resurrecting the pointer itself — it never reaches the REQUEUE_JOB path
  // that would flip the SUPERSEDED job's status to INTERRUPTED.
  const p = planRecovery({ runtime, resultExists: resolved.resultExists, jobId: resolved.jobId, leaseExists: false });
  assert.equal(p.action, RECOVERY_ACTIONS.BLOCKED);
  assert.equal(p.reason, 'STATE_INCONSISTENT');
});

test('14e. a pointer left over from a finished round is ignored; the new round is judged on its own ledger', () => {
  // runtime.round says 2, but currentJobId still names round 1's job — the
  // same failure shape run-goal.mjs had for dispatch (jobIdsByRound), here for
  // recovery instead.
  const ledger = buildStageLedger([recoveryJob('010-r1-developer-real0001', {
    round: 1, status: 'COMPLETED', result: { status: 'BLOCKED' },
  })]);
  const runtime = { goal: '010', round: 2, state: LOOP_STATES.DEVELOPER_RUNNING, currentJobId: '010-r1-developer-real0001' };
  const resolved = resolveRecoveryJob({ reconciled: { ledger }, runtime });
  assert.equal(resolved.jobId, null, 'round 2 has no attempt of its own yet');
  assert.equal(resolved.source, STAGE_JOB_SOURCE.NEW_JOB_REQUIRED);
});

test('run-recover.mjs resolves the stage job from the ledger; the old runtime-pointer fallback cannot reappear', async () => {
  const source = await readFile(new URL('../run-recover.mjs', import.meta.url), 'utf8');
  assert.match(source, /resolveRecoveryJob\(/, 'the ledger-only resolver must actually be wired in');
  assert.doesNotMatch(source, /\?\?\s*runtime\??\.currentJobId/,
    'no fallback to the runtime pointer may reappear as an "or else" after a reconciled/ledger lookup');
});

test('a queued job that was never picked up is simply re-queued', () => {
  for (const state of [LOOP_STATES.DEVELOPER_QUEUED, LOOP_STATES.CORRECTION_QUEUED, LOOP_STATES.REVIEWER_QUEUED]) {
    assert.equal(plan(state, {}, { resultExists: false }).action, RECOVERY_ACTIONS.REQUEUE_JOB, state);
  }
});

test('every state where an agent works has a recovery rule, derived not hand-listed', () => {
  // The parallel-list bug that cost a V4 evening: a state added to the machine
  // and forgotten in a list somewhere else.
  for (const state of AGENT_EXECUTION_STATES) {
    const p = plan(state, {}, { resultExists: true });
    assert.equal(p.action, RECOVERY_ACTIONS.CONSUME_RESULT, `${state} has no rule`);
  }
  assert.ok(AGENT_EXECUTION_STATES.includes(LOOP_STATES.CORRECTION_RUNNING));
  assert.ok(AGENT_EXECUTION_STATES.includes(LOOP_STATES.NEXT_GOAL_PLANNING));
});

test('an execution state with no recorded job is refused rather than guessed', () => {
  // "No recorded job" means the caller's own resolution (jobId) came back
  // empty — runtime.currentJobId being null is no longer what this turns on,
  // since planRecovery does not read that field at all.
  const p = plan(LOOP_STATES.REVIEWER_RUNNING, { currentJobId: null }, { jobId: null });
  assert.equal(p.action, RECOVERY_ACTIONS.BLOCKED);
  assert.equal(p.reason, 'STATE_INCONSISTENT');
});

// ===========================================================================
// 15–17. What recovery must not touch
// ===========================================================================

test('15. a capacity wait is not a crash and is not recovered', () => {
  const p = plan(LOOP_STATES.WAITING_FOR_CAPACITY);
  assert.equal(p.action, RECOVERY_ACTIONS.BLOCKED);
  assert.equal(p.reason, 'CAPACITY_WAIT');
  assert.match(p.message, /ia-loop:resume/);
});

test('15b. resume still handles capacity, and points at recover for an interrupted run', () => {
  const capacity = planResume(
    {
      state: LOOP_STATES.WAITING_FOR_CAPACITY, goal: '004', round: 1, blockedAgent: 'tech_lead',
      blockedJobId: 'job-1', resumeFrom: LOOP_STATES.REVIEWER_RUNNING,
      capacity: {
        reason: 'USAGE_LIMIT', attempt: 1, retryIntervalMs: 60_000,
        firstSeenAt: iso(NOW - 60_000), lastAttemptAt: iso(NOW), nextRetryAt: iso(NOW + 60_000),
      },
    },
    { now: NOW },
  );
  assert.equal(capacity.action, 'WAIT', 'capacity resume is untouched');

  const interrupted = planResume({ state: LOOP_STATES.REVIEWER_RUNNING }, { now: NOW });
  assert.equal(interrupted.action, 'NOTHING_TO_RESUME');
  assert.match(interrupted.message, /ia-loop:recover/);
});

// ===========================================================================
// 15c. A capacity wait interrupted by a reboot — resume must clear its OWN
// lease, since ia-loop:recover correctly refuses to (it is not a crash) and
// nothing else ever does.
//
// The real incident: Goal007's review fell back Fable → Opus on a usage
// limit, Opus hit the same account-wide limit and parked WAITING_FOR_CAPACITY,
// and the machine was rebooted while it waited. The deadline passed, the
// worker came back up, ia-loop:resume correctly saw the wait as elapsed and
// requeued the job — but the pre-reboot worker's lease was still on disk, so
// the freshly-started worker refused every poll with ORPHANED_EXECUTION_UNCERTAIN,
// forever, once a second. Nothing had ever cleared it: ia-loop:recover's own
// lease sweep explicitly excludes a job whose status is still claimable
// (WAITING_FOR_CAPACITY is), by design — that exclusion assumes something
// else handles this case, and nothing did.
// ===========================================================================

function jobLeaseAt({ jobId = 'goal-007-r1-tech_lead-x', worktree = null, pid = 31852, ageMs = 3_600_000, bootAt = BOOT_OLD } = {}) {
  return {
    jobId, attemptId: `${jobId}-a2`, agent: 'tech_lead', goal: '007', round: 1,
    worktree, kind: 'job', key: jobId,
    workerInstanceId: `${pid}-4b5705e7`, hostname: 'HOST-A', bootAt, pid,
    processStartedAt: BOOT_OLD, status: 'ACTIVE', version: 1,
    acquiredAt: BOOT_OLD, heartbeatAt: iso(NOW - ageMs),
    expiresAt: iso(NOW - ageMs + 90_000),
  };
}

async function withRawLease(dir, lease) {
  const leaseStore = createLeaseStore(dir);
  const path = leaseStore.paths.pathFor('job', lease.jobId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(lease, null, 2)}\n`, 'utf8');
  return leaseStore;
}

test('15c. a lease proven orphaned (different boot, process gone) is reclaimed', async () => {
  await withDir(async (dir) => {
    const lease = jobLeaseAt({ jobId: '007-r1-tech_lead-x' });
    const leaseStore = await withRawLease(dir, lease);
    const inspector = fakeInspector({ bootAt: BOOT_NEW, alive: { 31852: LIVENESS.GONE } });

    const result = await reclaimBlockedJobLease({ leaseStore, inspector, jobId: lease.jobId, now: NOW });

    assert.equal(result.outcome, 'RECLAIMED');
    assert.equal(result.proof, 'DIFFERENT_BOOT');
    assert.equal(await leaseStore.readJobLease(lease.jobId), null, 'the lease is gone, not just marked');
  });
});

test('15c. the matching worktree lease is freed alongside it', async () => {
  await withDir(async (dir) => {
    const worktree = '.ai-worktrees/goal-007';
    const lease = jobLeaseAt({ jobId: '007-r1-tech_lead-x', worktree });
    const leaseStore = await withRawLease(dir, lease);
    await leaseStore.claimWorktree(worktree, { attemptId: lease.attemptId, agent: 'tech_lead' });
    const inspector = fakeInspector({ bootAt: BOOT_NEW, alive: { 31852: LIVENESS.GONE } });

    await reclaimBlockedJobLease({ leaseStore, inspector, jobId: lease.jobId, now: NOW });

    const freed = await leaseStore.claimWorktree(worktree, { attemptId: 'new-a1', agent: 'tech_lead' });
    assert.equal(freed.acquired, true, 'a live worker can claim the worktree again');
  });
});

test('15c. a lease that cannot be proven abandoned is left exactly where it is', async () => {
  await withDir(async (dir) => {
    const lease = jobLeaseAt({ jobId: '007-r1-tech_lead-x', ageMs: 5_000 });
    const leaseStore = await withRawLease(dir, lease);
    // Same boot, and a fresh heartbeat: nothing here proves the holder gone.
    const inspector = fakeInspector({ bootAt: BOOT_OLD, alive: { 31852: LIVENESS.ALIVE } });

    const result = await reclaimBlockedJobLease({ leaseStore, inspector, jobId: lease.jobId, now: NOW });

    assert.equal(result.outcome, 'NOT_PROVEN');
    assert.ok(await leaseStore.readJobLease(lease.jobId), 'the lease survives an unproven guess');
  });
});

test('15c. no lease at all is the ordinary case: nothing to reclaim', async () => {
  await withDir(async (dir) => {
    const leaseStore = createLeaseStore(dir);
    const result = await reclaimBlockedJobLease({
      leaseStore, inspector: fakeInspector(), jobId: 'never-claimed', now: NOW,
    });
    assert.equal(result.outcome, 'NO_LEASE');
  });
});

test('15c. resume wires the reclaim outcome before ever requeuing the job', async () => {
  // Not a re-test of the judgement (test 15c above already covers that) —
  // this pins the ORDER in run-resume.mjs's own source: a job must never be
  // set to QUEUED before an unproven lease has had the chance to refuse it.
  const source = await readFile(new URL('../run-resume.mjs', import.meta.url), 'utf8');
  const reclaimAt = source.indexOf('reclaimBlockedJobLease({');
  const notProvenReturnAt = source.indexOf("return 1;", source.indexOf("outcome === 'NOT_PROVEN'"));
  const queuedAt = source.indexOf("setJobStatus(plan.agent, jobId, 'QUEUED')", source.indexOf('// RESUME:'));
  assert.ok(reclaimAt > 0 && notProvenReturnAt > reclaimAt && queuedAt > notProvenReturnAt,
    'reclaim, then the refusal path returns, then (only otherwise) the job is queued');
});

test('16/17. recovery never clears a human gate', () => {
  const humanState = plan(LOOP_STATES.HUMAN_REQUIRED, { humanRequired: { reason: 'POLICY_VIOLATION' } });
  assert.equal(humanState.reason, 'HUMAN_REQUIRED');

  const awaiting = plan(LOOP_STATES.AWAITING_HUMAN);
  assert.equal(awaiting.reason, 'HUMAN_REQUIRED');

  const pausedRun = planRecovery({
    runtime: runtimeAt(LOOP_STATES.REVIEWER_RUNNING),
    autonomousRun: { autonomousRunId: 'auto-1', status: 'PAUSED_FOR_HUMAN', humanRequired: { reason: 'AUTH_ERROR' } },
    ownerVerdict: confirmed, leaseExists: true, resultExists: true,
  });
  assert.equal(pausedRun.action, RECOVERY_ACTIONS.BLOCKED);
  assert.equal(pausedRun.reason, 'HUMAN_REQUIRED');
});

test('a live or merely suspected owner blocks recovery', () => {
  for (const [status, reason] of [
    [OWNER_STATUS.ACTIVE, 'ORCHESTRATOR_ALIVE'],
    [OWNER_STATUS.OWNER_ALIVE, 'ORCHESTRATOR_ALIVE'],
    [OWNER_STATUS.SUSPECTED_ORPHAN, 'ORPHAN_NOT_CONFIRMED'],
    [OWNER_STATUS.FOREIGN_HOST, 'ORPHAN_NOT_CONFIRMED'],
  ]) {
    const p = planRecovery({
      runtime: runtimeAt(LOOP_STATES.REVIEWER_RUNNING),
      ownerVerdict: { status, detail: 'x' }, leaseExists: true, resultExists: true,
    });
    assert.equal(p.action, RECOVERY_ACTIONS.BLOCKED, status);
    assert.equal(p.reason, reason, status);
  }
});

test('with no lease at all there is nothing to take over, and recovery proceeds', () => {
  const p = planRecovery({
    runtime: runtimeAt(LOOP_STATES.REVIEWER_RUNNING), leaseExists: false, resultExists: true, jobId: 'job-1',
  });
  assert.equal(p.action, RECOVERY_ACTIONS.CONSUME_RESULT);
});

// ===========================================================================
// 18–20. Closure stays idempotent
// ===========================================================================

test('18. closure and planning states resume their phase rather than an agent', () => {
  for (const state of [LOOP_STATES.ACCEPTED, LOOP_STATES.CLOSURE_PREPARING, LOOP_STATES.CLOSURE_READY,
    LOOP_STATES.GOAL_COMMITTING, LOOP_STATES.GOAL_COMMITTED, LOOP_STATES.INTEGRATING_ACCEPTED,
    LOOP_STATES.BASELINE_ACCEPTED]) {
    const p = plan(state);
    assert.equal(p.action, RECOVERY_ACTIONS.RESUME_PHASE, state);
    assert.equal(p.phase, 'close', state);
  }
});

test('19/20. every closure side effect is guarded by what it already recorded', async () => {
  // Recovery re-runs run-close, so its steps must each check before acting.
  // Asserted against the source because the guarantee is structural: a new step
  // added without a guard would duplicate a commit or a cherry-pick.
  const source = await readFile(new URL('../run-close.mjs', import.meta.url), 'utf8');
  for (const field of [
    'sourceClosureCommit',      // the Goal commit
    'integratedClosureCommit',  // the cherry-pick onto main
    'closureDocsJobId',         // the documentation inference
    'planningJobId',            // the planning inference
    'sourcePlanningCommit',     // the next Goal commit
    'planningIntegrationCommit',
  ]) {
    assert.match(source, new RegExp(`if \\(!closure\\.${field}\\)`),
      `${field} is written without a guard, so a re-run would duplicate it`);
  }
});

// ===========================================================================
// 21. Identity: an attempt is never undefined
// ===========================================================================

test('21. the orchestrator lease carries a run, an attempt and an owner', async () => {
  await withDir(async (dir) => {
    const auto = createAutonomousStore(dir);
    const run = await auto.start({ fromGoal: '004', migrationAcceptedBaseline: 'a'.repeat(40) });
    const lease = await auto.readLoopLease();

    assert.equal(lease.autonomousRunId, run.autonomousRunId);
    assert.equal(lease.attemptId, 'migration-loop-a1', 'this is what printed as "Attempt: undefined"');
    assert.equal(lease.attempt, 1);
    assert.equal(lease.ownerKind, 'orchestrator');
    assert.ok(lease.workerInstanceId);
    assert.equal(run.attempt, 1);
    assert.equal(run.ownerInstanceId, lease.workerInstanceId);
  });
});

test('21b. every lease carries the identity needed to judge it later', async () => {
  await withDir(async (dir) => {
    const leases = createLeaseStore(dir);
    const { lease } = await leases.claimJob('some-job', { agent: 'developer' });

    for (const field of ['hostname', 'bootAt', 'pid', 'processStartedAt', 'workerInstanceId', 'acquiredAt']) {
      assert.ok(lease[field] !== undefined && lease[field] !== null, `${field} must be recorded`);
    }
    assert.ok(!Number.isNaN(Date.parse(lease.bootAt)));
    assert.ok(!Number.isNaN(Date.parse(lease.processStartedAt)));
  });
});

test('a recovered run counts a new attempt instead of restarting the old one', async () => {
  await withDir(async (dir) => {
    const auto = createAutonomousStore(dir);
    const run = await auto.start({ fromGoal: '004', migrationAcceptedBaseline: 'a'.repeat(40) });
    const lease = await auto.readLoopLease();

    const taken = await auto.takeoverLoopLease({ expected: lease, proof: 'DIFFERENT_BOOT' });
    assert.equal(taken.acquired, true);
    assert.equal(taken.lease.attemptId, 'migration-loop-a2');
    assert.equal(taken.run.autonomousRunId, run.autonomousRunId, 'the same run, a later attempt');
    assert.equal(taken.run.attempt, 2);
    assert.equal(taken.run.recoveryCount, 1);
    assert.equal(taken.run.lastRecovery.proof, 'DIFFERENT_BOOT');
  });
});

// ===========================================================================
// 22–24. Ownership, job status, restart during restart
// ===========================================================================

test('an aged lease is no longer taken over by simply attaching', async () => {
  await withDir(async (dir) => {
    const auto = createAutonomousStore(dir);
    await auto.start({ fromGoal: '004', migrationAcceptedBaseline: 'a'.repeat(40) });

    // Age the lease past expiry without touching anything else.
    const path = join(dir, 'leases', 'jobs', 'migration-loop.lock');
    const lease = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...lease, heartbeatAt: iso(Date.now() - 600_000) }, null, 2), 'utf8');

    const attached = await auto.attach();
    assert.equal(attached.attached, false);
    assert.equal(attached.reason, 'RECOVERY_REQUIRED',
      'attach used to force-release a stale lease, which is exactly the guess recovery exists to avoid');
    assert.ok(await auto.readLoopLease(), 'and the lease is still there, untouched');
  });
});

test('an INTERRUPTED job is history a worker will not pick up on its own', () => {
  assert.ok(JOB_STATUSES.includes('INTERRUPTED'));
  assert.equal(isTerminalJobStatus('INTERRUPTED'), false, 'nothing was learned, so it is not a terminal outcome');
  assert.equal(isClaimableJobStatus('INTERRUPTED'), false, 'but only the orchestrator decides what happens next');
  assert.ok(NON_CLAIMABLE_JOB_STATUSES.includes('INTERRUPTED'));

  // The statuses that were claimable before stay claimable.
  assert.equal(isClaimableJobStatus('QUEUED'), true);
  assert.equal(isClaimableJobStatus('RUNNING'), true);
  assert.equal(isClaimableJobStatus(null), true);
  for (const s of ['COMPLETED', 'FAILED', 'SUPERSEDED']) assert.equal(isClaimableJobStatus(s), false, s);
});

test('24. recovery is idempotent: a crash during recovery leaves a state the next one can read', async () => {
  await withDir(async (dir) => {
    const auto = createAutonomousStore(dir);
    await auto.start({ fromGoal: '004', migrationAcceptedBaseline: 'a'.repeat(40) });
    const leases = createLeaseStore(dir);

    // A recovery died between creating its marker and swapping the lease.
    const markerPath = join(dir, 'leases', 'jobs', 'migration-loop.lock.takeover');
    await writeFile(markerPath, '', 'utf8');

    const blocked = await leases.takeoverJob('migration-loop', {
      expected: await auto.readLoopLease(), proof: 'PROCESS_GONE', payload: {},
    });
    assert.equal(blocked.acquired, false);
    assert.equal(blocked.reason, 'RECOVERY_IN_PROGRESS', 'the stale marker is visible, not invisible');

    // Once cleared, the next recovery goes through — no state is impossible.
    await rm(markerPath, { force: true });
    const retry = await auto.takeoverLoopLease({ expected: await auto.readLoopLease(), proof: 'PROCESS_GONE' });
    assert.equal(retry.acquired, true);

    // And running it again does not invent a third run.
    const again = await auto.takeoverLoopLease({ expected: await auto.readLoopLease(), proof: 'PROCESS_GONE' });
    assert.equal(again.acquired, true);
    assert.equal(again.run.attempt, 3);
    assert.equal(again.run.autonomousRunId, (await auto.read()).autonomousRunId);
  });
});

test('26. recovery needs no manual editing or deletion of state files', async () => {
  const source = await readFile(new URL('../run-recover.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /rm\(|unlink\(|rmdir\(/, 'recovery must never delete state to get moving');
  assert.match(source, /takeoverLoopLease/, 'the lease changes hands through the atomic swap');
});

// ===========================================================================
// 27. No model is reachable from recovery
// ===========================================================================

test('27. recovery calls no model and cannot fall back to one', async () => {
  for (const file of ['../run-recover.mjs', '../lib/recovery-plan.mjs', '../lib/orphan-evidence.mjs',
    '../lib/process-inspector.mjs']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /runAgent|spawnClaude|--model|claude-opus|claude-fable|claude-sonnet|claude-haiku/,
      `${file} must not be able to invoke a model`);
  }
});

// ===========================================================================
// Retiring the leases of an attempt that will never run again
// ===========================================================================

test('a lease whose holder is proven gone is retired, archived, and leaves nothing behind', async () => {
  await withDir(async (dir) => {
    const leases = createLeaseStore(dir);
    const { lease } = await leases.claimJob('004-r1-developer-dupe', { agent: 'developer' });

    const retired = await leases.retireJob('004-r1-developer-dupe', {
      expected: lease, proof: 'PROCESS_GONE',
    });

    assert.equal(retired.retired, true);
    assert.equal(await leases.readJobLease('004-r1-developer-dupe'), null, 'ownership ends');

    const archived = JSON.parse(
      await readFile(join(dir, 'leases', 'jobs', '004-r1-developer-dupe.lock.superseded'), 'utf8'),
    );
    assert.equal(archived.status, 'SUPERSEDED');
    assert.equal(archived.supersededProof, 'PROCESS_GONE', 'the proof that retired it is kept');
  });
});

test('retiring is refused when the lease moved since it was judged', async () => {
  await withDir(async (dir) => {
    const leases = createLeaseStore(dir);
    const { lease } = await leases.claimJob('k', {});
    const judged = { ...lease };
    await leases.renewJob('k');

    const retired = await leases.retireJob('k', { expected: judged, proof: 'PROCESS_GONE' });
    assert.equal(retired.retired, false);
    assert.equal(retired.reason, 'LEASE_CHANGED_SINCE_JUDGEMENT');
    assert.ok(await leases.readJobLease('k'), 'and the lease stays');
  });
});

test('a worktree lease held by a dead attempt does not block the next round', async () => {
  // The real leftover: the duplicate attempt died holding the Goal004 worktree,
  // so the correction round would have been refused with WORKTREE_BUSY by a
  // process that no longer existed.
  await withDir(async (dir) => {
    const leases = createLeaseStore(dir);
    const path = '.ai-worktrees/goal-004';
    const { lease } = await leases.claimWorktree(path, { attemptId: 'dupe-a1', agent: 'developer' });

    const blocked = await leases.claimWorktree(path, { attemptId: 'r2-a1', agent: 'developer' });
    assert.equal(blocked.acquired, false, 'busy while the lease stands');

    await leases.retireWorktree(path, { expected: lease, proof: 'PROCESS_GONE' });

    const free = await leases.claimWorktree(path, { attemptId: 'r2-a1', agent: 'developer' });
    assert.equal(free.acquired, true, 'and free once its holder is proven gone');
  });
});

test('recovery retires an orphan lease only with proof, never because a job was superseded', async () => {
  const source = await readFile(new URL('../run-recover.mjs', import.meta.url), 'utf8');
  assert.match(source, /isRecoveryEligible\(heldVerdict\)/, 'the same standard of proof as the loop lease');
  assert.match(source, /ORPHANED_LEASE_RETIRED/, 'and it is recorded');
  assert.match(source, /if \(!isRecoveryEligible\(heldVerdict\)\) \{[\s\S]{0,200}continue;/,
    'an unproven holder keeps its lease');
  assert.match(source, /if \(isClaimableJobStatus\(status\)\) continue;/,
    'and so does a job that could still legitimately run');
});
