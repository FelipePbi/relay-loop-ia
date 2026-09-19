/**
 * Handing a recovered run to a new orchestrator.
 *
 * The gap these cover is a contradiction the real run printed:
 *
 *   ia-loop:auto     "Run auto-7b32c56a owns the loop"
 *   ia-loop:status   "NOT HOLDING THE LOOP"
 *
 * Both were true of different things. The run was RUNNING — the campaign had
 * not finished — and no process was driving it. Recovery had taken a lease and
 * exited, and the failing auto then deleted that lease on its way out.
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

import { HANDOFF_STATUS, createHandoffStore, handoffCovers } from '../lib/recovery-handoff.mjs';
import { createAutonomousStore, RUN_STATUS } from '../lib/autonomous-state.mjs';
import { createLeaseStore } from '../lib/leases.mjs';
import { createJobStore } from '../lib/job-store.mjs';
import { RECOVERY_ACTIONS, planRecovery } from '../lib/recovery-plan.mjs';
import { OWNER_STATUS } from '../lib/orphan-evidence.mjs';
import { LOOP_STATES, createLoopStateMachine } from '../lib/loop-state.mjs';

const execFileAsync = promisify(execFile);
const codeIs = (code) => (error) => error.code === code;

const RUN_ID = 'auto-7b32c56a';
const BASELINE = '588b70f575670eeda015750b400a09752ceb5490';
const EXECUTION_BASE = 'b3a019c94b8e89f48db5ab017866ff9e325d7d82';
const REVIEW_JOB = '004-r1-tech_lead-4ded365b';

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-handoff-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

/** The real Goal004 situation, as fixture. */
const interruptedRuntime = () => ({
  mode: 'REAL_EXECUTION', goal: '004', round: 1, state: LOOP_STATES.REVIEWER_RUNNING,
  currentJobId: REVIEW_JOB, executionBase: EXECUTION_BASE, worktreeInitialHead: EXECUTION_BASE,
  migrationAcceptedBaseline: BASELINE,
  jobIdsByRound: { 1: { developer: '004-r1-developer-d8f21303', tech_lead: REVIEW_JOB } },
});

const readyHandoff = (over = {}) => ({
  autonomousRunId: RUN_ID,
  recoveryAttempt: 2,
  recoveredFromState: LOOP_STATES.REVIEWER_RUNNING,
  nextSafeAction: RECOVERY_ACTIONS.CONSUME_RESULT,
  jobId: REVIEW_JOB,
  agent: 'tech_lead',
  goal: '004',
  round: 1,
  supersededOwner: '10756-98c3e406',
  proof: 'DIFFERENT_BOOT',
  ...over,
});

// ===========================================================================
// 1–3. RUNNING is not ownership
// ===========================================================================

test('1. a run whose owner is alive still blocks a second orchestrator', async () => {
  await withDir(async (dir) => {
    const auto = createAutonomousStore(dir);
    await auto.start({ fromGoal: '004', migrationAcceptedBaseline: BASELINE });

    // A live lease is a live orchestrator: attach refuses, and says so.
    const second = createAutonomousStore(dir);
    const attached = await second.attach();
    assert.equal(attached.attached, false);
    assert.equal(attached.reason, 'AUTONOMOUS_RUN_ALREADY_ACTIVE');
  });
});

test('2. an aged lease with no proof of death blocks recovery AND attach', async () => {
  await withDir(async (dir) => {
    const auto = createAutonomousStore(dir);
    await auto.start({ fromGoal: '004', migrationAcceptedBaseline: BASELINE });

    const path = join(dir, 'leases', 'jobs', 'migration-loop.lock');
    const lease = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...lease, heartbeatAt: new Date(Date.now() - 600_000).toISOString() }, null, 2), 'utf8');

    const attached = await auto.attach();
    assert.equal(attached.reason, 'RECOVERY_REQUIRED', 'attach never guesses that a stale holder is dead');

    const p = planRecovery({
      runtime: interruptedRuntime(),
      ownerVerdict: { status: OWNER_STATUS.SUSPECTED_ORPHAN, detail: 'no proof' },
      leaseExists: true, resultExists: true,
    });
    assert.equal(p.action, RECOVERY_ACTIONS.BLOCKED);
    assert.equal(p.reason, 'ORPHAN_NOT_CONFIRMED');
  });
});

test('3/5. a RUNNING run with no orchestrator is a valid state, and is attachable', async () => {
  await withDir(async (dir) => {
    const auto = createAutonomousStore(dir);
    const run = await auto.start({ fromGoal: '004', migrationAcceptedBaseline: BASELINE });

    // Recovery proved the owner gone, handed off, and released.
    await auto.releaseLoopLease();
    const handoffs = createHandoffStore(dir);
    await handoffs.write(readyHandoff());

    const stored = await auto.read();
    assert.equal(stored.status, RUN_STATUS.RUNNING, 'the campaign is still unfinished');
    assert.equal(await auto.readLoopLease(), null, 'and nobody is driving it');

    // Which is exactly when a new orchestrator may take it.
    const attached = await auto.attach();
    assert.equal(attached.attached, true);
    assert.equal(attached.run.autonomousRunId, run.autonomousRunId);
  });
});

test('a run recorded RUNNING is never replaced by a second run', async () => {
  await withDir(async (dir) => {
    const auto = createAutonomousStore(dir);
    const run = await auto.start({ fromGoal: '004', migrationAcceptedBaseline: BASELINE });
    await auto.releaseLoopLease();

    // start() is for NEW runs. With one unfinished, it refuses and points at
    // attach rather than opening a second campaign beside it.
    await assert.rejects(
      auto.start({ fromGoal: '004', migrationAcceptedBaseline: BASELINE }),
      codeIs('AUTONOMOUS_RUN_NEEDS_ATTACH'),
    );
    assert.equal((await auto.read()).autonomousRunId, run.autonomousRunId);
  });
});

// ===========================================================================
// 4, 6, 7. The handoff itself
// ===========================================================================

test('4. a handoff records everything the next orchestrator needs to verify it', async () => {
  await withDir(async (dir) => {
    const handoffs = createHandoffStore(dir);
    const handoff = await handoffs.write(readyHandoff());

    assert.equal(handoff.status, HANDOFF_STATUS.READY_FOR_ATTACH);
    assert.equal(handoff.autonomousRunId, RUN_ID);
    assert.equal(handoff.recoveredFromState, LOOP_STATES.REVIEWER_RUNNING);
    assert.equal(handoff.nextSafeAction, RECOVERY_ACTIONS.CONSUME_RESULT);
    assert.equal(handoff.jobId, REVIEW_JOB);
    assert.equal(handoff.recoveryAttempt, 2);
    assert.equal(handoff.supersededOwner, '10756-98c3e406');
    assert.ok(handoff.nonce, 'the token that makes it one-shot');
    assert.ok(!Number.isNaN(Date.parse(handoff.createdAt)));
    assert.equal(handoff.consumedAt, null);
  });
});

test('a handoff without a run or without a next action is refused', async () => {
  await withDir(async (dir) => {
    const handoffs = createHandoffStore(dir);
    await assert.rejects(handoffs.write(readyHandoff({ autonomousRunId: null })), codeIs('INVALID_ARGS'));
    await assert.rejects(handoffs.write(readyHandoff({ nextSafeAction: null })), codeIs('INVALID_ARGS'));
  });
});

test('6/7. attaching keeps the same run id and mints no new run', async () => {
  await withDir(async (dir) => {
    const auto = createAutonomousStore(dir);
    const handoffs = createHandoffStore(dir);

    const run = await auto.start({ fromGoal: '004', migrationAcceptedBaseline: BASELINE });
    await auto.releaseLoopLease();
    await handoffs.write(readyHandoff({ autonomousRunId: run.autonomousRunId }));

    const attached = await auto.attach();
    const check = await handoffs.validateFor(attached.run.autonomousRunId);
    assert.equal(check.valid, true);

    const consumed = await handoffs.consume({ nonce: check.handoff.nonce, consumedBy: 'new-owner' });
    assert.equal(consumed.consumed, true);

    assert.equal(attached.run.autonomousRunId, run.autonomousRunId, 'same run, later attempt');
    assert.equal((await auto.read()).autonomousRunId, run.autonomousRunId);
    assert.equal((await auto.read()).startedAt, run.startedAt, 'the original start survives');
  });
});

test('a handoff for another run is refused, not stretched to fit', async () => {
  await withDir(async (dir) => {
    const handoffs = createHandoffStore(dir);
    await handoffs.write(readyHandoff({ autonomousRunId: 'auto-someone-else' }));

    const check = await handoffs.validateFor(RUN_ID);
    assert.equal(check.valid, false);
    assert.equal(check.reason, 'HANDOFF_FOR_ANOTHER_RUN');
  });
});

test('8. a handoff is one-shot: the second attach loses', async () => {
  await withDir(async (dir) => {
    const handoffs = createHandoffStore(dir);
    const handoff = await handoffs.write(readyHandoff());

    const first = await handoffs.consume({ nonce: handoff.nonce, consumedBy: 'owner-a' });
    assert.equal(first.consumed, true);

    const second = await handoffs.consume({ nonce: handoff.nonce, consumedBy: 'owner-b' });
    assert.equal(second.consumed, false);
    assert.equal(second.reason, 'HANDOFF_ALREADY_CONSUMED');

    assert.equal((await handoffs.validateFor(RUN_ID)).reason, 'HANDOFF_ALREADY_CONSUMED');
    assert.equal((await handoffs.read()).consumedBy, 'owner-a');
  });
});

test('8b. two real processes attaching at once: exactly one becomes the orchestrator', async () => {
  await withDir(async (dir) => {
    const auto = createAutonomousStore(dir);
    await auto.start({ fromGoal: '004', migrationAcceptedBaseline: BASELINE });
    await auto.releaseLoopLease();
    await createHandoffStore(dir).write(readyHandoff({ autonomousRunId: (await auto.read()).autonomousRunId }));

    const script = join(dir, 'attach.mjs');
    const autoUrl = new URL('../lib/autonomous-state.mjs', import.meta.url).href;
    const handoffUrl = new URL('../lib/recovery-handoff.mjs', import.meta.url).href;
    await writeFile(script, `
import { createAutonomousStore } from ${JSON.stringify(autoUrl)};
import { createHandoffStore } from ${JSON.stringify(handoffUrl)};
const dir = process.argv[2];
const auto = createAutonomousStore(dir);
const handoffs = createHandoffStore(dir);
await new Promise((r) => setTimeout(r, Math.max(0, Number(process.argv[3]) - Date.now())));
const attached = await auto.attach();
if (!attached?.attached) { console.log('BLOCKED:' + attached?.reason); process.exit(0); }
const check = await handoffs.validateFor(attached.run.autonomousRunId);
if (!check.valid) { console.log('BLOCKED:' + check.reason); process.exit(0); }
const consumed = await handoffs.consume({ nonce: check.handoff.nonce, consumedBy: 'p' + process.pid });
console.log(consumed.consumed ? 'ATTACHED:' + attached.run.autonomousRunId : 'BLOCKED:' + consumed.reason);
`, 'utf8');

    const runIdBefore = (await auto.read()).autonomousRunId;
    const at = String(Date.now() + 300);
    const [a, b] = await Promise.all([
      execFileAsync(process.execPath, [script, dir, at]),
      execFileAsync(process.execPath, [script, dir, at]),
    ]);
    const results = [a.stdout.trim(), b.stdout.trim()];

    assert.equal(results.filter((r) => r.startsWith('ATTACHED:')).length, 1, `one attach only: ${results}`);
    assert.ok(results.some((r) => r.startsWith('BLOCKED:')), `the loser must say why: ${results}`);
    // And still exactly one run, with the id it started with.
    assert.equal((await auto.read()).autonomousRunId, runIdBefore);
    assert.ok(results.find((r) => r.startsWith('ATTACHED:')).endsWith(runIdBefore),
      'the winner attached to the existing run, it did not open a new one');
  });
});

// ===========================================================================
// 9. No phantom ownership
// ===========================================================================

test('9. recovery holds nothing when it exits', async () => {
  // The defect: recovery took a real orchestrator lease and then the process
  // ended. For a whole expiry window the lease read as a healthy owner, so
  // ia-loop:auto refused to start — the very command recovery had just printed.
  const source = await readFile(new URL('../run-recover.mjs', import.meta.url), 'utf8');
  assert.match(source, /releaseLoopLease\(\)/, 'recovery must give the lease back before exiting');
  assert.match(source, /RECOVERY_READY_FOR_ATTACH/, 'and leave a handoff instead of ownership');
  // The release must come after the handoff is written, or a crash between them
  // would leave neither owner nor token.
  assert.ok(source.indexOf('handoffs.write(') < source.indexOf('releaseLoopLease()'),
    'the handoff is written before the lease is released');
});

test('9b. run-auto never force-releases a lease it does not own', async () => {
  // This is what turned "another orchestrator owns this" into "nobody owns
  // this": refusing to start also deleted the other process's lease.
  const source = await readFile(new URL('../run-auto.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /releaseLoopLease\(\{\s*force:\s*true/,
    'a forced release deletes another process lease');
});

test('9c. releasing a lease owned by another process is refused', async () => {
  await withDir(async (dir) => {
    const leases = createLeaseStore(dir);
    await leases.claimJob('migration-loop', { autonomousRunId: RUN_ID });

    // Rewrite the owner to simulate a different process holding it.
    const path = join(dir, 'leases', 'jobs', 'migration-loop.lock');
    const lease = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...lease, workerInstanceId: '999-other' }, null, 2), 'utf8');

    await assert.rejects(leases.releaseJob('migration-loop'), codeIs('LEASE_NOT_OWNED'));
    assert.ok(await leases.readJobLease('migration-loop'), 'and it is still there');
  });
});

// ===========================================================================
// 10–13. The next safe step for the real Goal004 state
// ===========================================================================

test('10/11/12. the recovered Goal004 consumes the review and calls no model', () => {
  const p = planRecovery({
    runtime: interruptedRuntime(),
    autonomousRun: { autonomousRunId: RUN_ID, status: RUN_STATUS.RUNNING },
    ownerVerdict: { status: OWNER_STATUS.ORPHAN_CONFIRMED, proof: 'DIFFERENT_BOOT', detail: 'rebooted' },
    leaseExists: true, resultExists: true,
    // As a real caller (run-recover.mjs) would hand it in: resolved from the
    // stage ledger, not read here from runtime.currentJobId.
    jobId: REVIEW_JOB,
  });

  assert.equal(p.action, RECOVERY_ACTIONS.CONSUME_RESULT);
  assert.equal(p.agent, 'tech_lead');
  assert.equal(p.jobId, REVIEW_JOB, 'the review that already exists');
  assert.notEqual(p.action, RECOVERY_ACTIONS.REQUEUE_JOB, 'the Tech Lead is not asked again');
});

test('13. a fake runner shows the next transition is correction round 2', async () => {
  await withDir(async (dir) => {
    // The persisted review said CHANGES_REQUIRED with four blockers. Driving
    // the real state machine from the recovered state proves where that leads,
    // without publishing a job or calling anything.
    const store = createJobStore(dir);
    await store.publishJob('tech_lead', {
      protocolVersion: 2, jobId: REVIEW_JOB, role: 'tech_lead', goal: '004', round: 1,
    }).catch(() => {});

    const machine = createLoopStateMachine({ initialState: LOOP_STATES.REVIEWER_RUNNING });
    const decision = { decision: 'CHANGES_REQUIRED', blockers: [1, 2, 3, 4] };

    machine.transitionTo(LOOP_STATES.CHANGES_REQUIRED);
    machine.transitionTo(LOOP_STATES.CORRECTION_QUEUED);
    machine.transitionTo(LOOP_STATES.CORRECTION_RUNNING);

    assert.equal(machine.state, LOOP_STATES.CORRECTION_RUNNING);
    assert.equal(decision.blockers.length, 4);
    // Round 2 is where the Developer legitimately runs again — not round 1.
    assert.ok(!machine.history.some((t) => t.to === LOOP_STATES.DEVELOPER_RUNNING),
      'round 1 implementation is never re-run');
  });
});

// ===========================================================================
// 14–16. Bases and checkpoints
// ===========================================================================

test('14/15/16. the main guard checkpoint moves; the execution base does not', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    await store.writeRuntime(interruptedRuntime());

    // What recovery and attach write: an operational checkpoint of main.
    await store.writeRuntime({
      ...(await store.readRuntime()),
      mainGuardCheckpoint: {
        head: '484bdd8000000000000000000000000000000000',
        at: new Date().toISOString(), reason: 'ORCHESTRATOR_ATTACH',
        note: 'operational checkpoint, not the execution base',
      },
    });

    const runtime = await store.readRuntime();
    assert.equal(runtime.executionBase, EXECUTION_BASE, 'the base of record never moves');
    assert.equal(runtime.worktreeInitialHead, EXECUTION_BASE);
    assert.equal(runtime.migrationAcceptedBaseline, BASELINE);
    assert.notEqual(runtime.mainGuardCheckpoint.head, runtime.executionBase,
      'the checkpoint is a different thing from the base, and is stored as one');
  });
});

test('the checkpoint is written by recovery and by attach, and labelled as not a base', async () => {
  for (const file of ['../run-recover.mjs', '../run-auto.mjs']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /mainGuardCheckpoint/, `${file} must record the checkpoint`);
    assert.match(source, /not the execution base/, `${file} must say what it is not`);
    assert.doesNotMatch(source, /executionBase:\s*mainHead/, `${file} must never assign it as the base`);
  }
});

// ===========================================================================
// 17–20. Coherent status, and crashes at every seam
// ===========================================================================

test('17. status never says "no orchestrator" and "the run owns the loop" at once', async () => {
  const source = await readFile(new URL('../run-status.mjs', import.meta.url), 'utf8');
  // Run and orchestrator are printed as separate blocks, so the two facts
  // cannot contradict: one is a campaign, the other is a process.
  assert.match(source, /out\.push\('Run:'\)/);
  assert.match(source, /out\.push\('Orchestrator:'\)/);
  assert.match(source, /Holding loop/);
  assert.match(source, /RECOVERED_READY/);
});

test('18. a crash between recover and auto leaves the handoff valid', async () => {
  await withDir(async (dir) => {
    const auto = createAutonomousStore(dir);
    const handoffs = createHandoffStore(dir);
    await auto.start({ fromGoal: '004', migrationAcceptedBaseline: BASELINE });
    const runId = (await auto.read()).autonomousRunId;
    await handoffs.write(readyHandoff({ autonomousRunId: runId }));
    await auto.releaseLoopLease();

    // Nothing runs for a while. The handoff is still the truth on disk.
    const laterAuto = createAutonomousStore(dir);
    const attached = await laterAuto.attach();
    assert.equal(attached.attached, true);
    assert.equal((await createHandoffStore(dir).validateFor(runId)).valid, true);
  });
});

test('19. a crash during attach leaves the handoff unconsumed for the next one', async () => {
  await withDir(async (dir) => {
    const auto = createAutonomousStore(dir);
    const handoffs = createHandoffStore(dir);
    await auto.start({ fromGoal: '004', migrationAcceptedBaseline: BASELINE });
    const runId = (await auto.read()).autonomousRunId;
    await auto.releaseLoopLease();
    await handoffs.write(readyHandoff({ autonomousRunId: runId }));

    // Attached, then died before consuming.
    await auto.attach();
    assert.equal((await handoffs.read()).status, HANDOFF_STATUS.READY_FOR_ATTACH);

    // The lease it left is judged by recovery like any other; the token stands.
    assert.equal((await handoffs.validateFor(runId)).valid, true);
  });
});

test('20. recovery run twice on an unchanged run does not mint a second token', async () => {
  await withDir(async (dir) => {
    const handoffs = createHandoffStore(dir);
    const first = await handoffs.write(readyHandoff());

    assert.equal(handoffCovers(first, {
      autonomousRunId: RUN_ID,
      state: LOOP_STATES.REVIEWER_RUNNING,
      nextSafeAction: RECOVERY_ACTIONS.CONSUME_RESULT,
    }), true, 'a second recover recognises its own work and stops');

    // A genuinely different situation is not covered by the old token.
    assert.equal(handoffCovers(first, {
      autonomousRunId: RUN_ID, state: LOOP_STATES.CORRECTION_RUNNING,
      nextSafeAction: RECOVERY_ACTIONS.CONSUME_RESULT,
    }), false);
    assert.equal(handoffCovers(first, {
      autonomousRunId: 'auto-other', state: LOOP_STATES.REVIEWER_RUNNING,
      nextSafeAction: RECOVERY_ACTIONS.CONSUME_RESULT,
    }), false);

    // Neither is a consumed one.
    await handoffs.consume({ nonce: first.nonce, consumedBy: 'x' });
    assert.equal(handoffCovers(await handoffs.read(), {
      autonomousRunId: RUN_ID, state: LOOP_STATES.REVIEWER_RUNNING,
      nextSafeAction: RECOVERY_ACTIONS.CONSUME_RESULT,
    }), false);
  });
});

// ===========================================================================
// 21–24. The gates recovery and attach still never open
// ===========================================================================

test('21/22. attach does not resolve a human gate', () => {
  const humanRuntime = { ...interruptedRuntime(), state: LOOP_STATES.HUMAN_REQUIRED };
  assert.equal(planRecovery({ runtime: humanRuntime, leaseExists: false }).reason, 'HUMAN_REQUIRED');

  const pausedForHuman = planRecovery({
    runtime: interruptedRuntime(),
    autonomousRun: { autonomousRunId: RUN_ID, status: RUN_STATUS.PAUSED_FOR_HUMAN, humanRequired: { reason: 'AUTH_ERROR' } },
    leaseExists: false, resultExists: true,
  });
  assert.equal(pausedForHuman.action, RECOVERY_ACTIONS.BLOCKED);
  assert.equal(pausedForHuman.reason, 'HUMAN_REQUIRED');
});

test('23. a capacity wait is still not a crash', () => {
  const p = planRecovery({
    runtime: { ...interruptedRuntime(), state: LOOP_STATES.WAITING_FOR_CAPACITY },
    leaseExists: false,
  });
  assert.equal(p.reason, 'CAPACITY_WAIT');
});

test('24. nothing in the handoff path can reach a model', async () => {
  for (const file of ['../lib/recovery-handoff.mjs', '../run-recover.mjs']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /runAgent|spawnClaude|--model|claude-opus|claude-fable|claude-sonnet|claude-haiku/,
      `${file} must not be able to invoke a model`);
  }
});
