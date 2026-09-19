/**
 * A session limit is a wait, not a failure.
 *
 * What happened. Goal 005's Developer finished round 1 and the Tech Lead's DEEP
 * review started. The Claude CLI exited 1 with its own words:
 *
 *   You've hit your session limit · resets 3:10am (America/Sao_Paulo)
 *
 * No pattern in the classifier knew that wording — it looked for "usage limit",
 * "quota", "limit will reset" — so the one condition the loop is built to wait
 * out was classified UNKNOWN_FATAL, escalated immediately, and stopped a Goal
 * for a human ELEVEN MINUTES before the quota reset itself. The event log
 * recorded it as CAPACITY_LIMIT_REACHED with reason UNKNOWN_FATAL: a capacity
 * event claiming a limit that its own reason denies.
 *
 * These tests state the three things that were wrong: the words the CLI uses,
 * what a capacity event is allowed to be, and what a retry actually creates —
 * a new attempt at the same stage, never a reuse of the one that hit the wall.
 *
 * No model is called anywhere here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CAPACITY_REASONS, classifyFailure, extractRetryAfterMs, parseResetAt,
} from '../lib/capacity-classifier.mjs';
import { CAPACITY_ACTIONS, decideCapacityAction } from '../lib/capacity-policy.mjs';
import { CAPACITY_CONFIG } from '../lib/capacity-config.mjs';
import { FAILURE_FAMILIES, eventTypeFor, familyFor, producesCapacityEvent } from '../lib/failure-taxonomy.mjs';
import { RETRYABLE_JOB_STATUSES, createJobStore } from '../lib/job-store.mjs';
import { RUN_OUTCOMES, runWithCapacity } from '../lib/capacity-runner.mjs';
import { readRuntimeStrict, remainingWaitMs } from '../lib/capacity-state.mjs';
import { createAutonomousStore } from '../lib/autonomous-state.mjs';
import {
  findFailureEvidence, reclassifyEvidence, reclassifyFailure,
} from '../lib/failure-reclassification.mjs';
import { DISPATCH_KINDS, reconcileExecutionState } from '../lib/reconcile.mjs';
import { LOOP_STATES } from '../lib/loop-state.mjs';
import { PROTOCOL_VERSION_V2 } from '../lib/contracts-v2.mjs';

const codeIs = (code) => (error) => error.code === code;

/** The exact message the Claude CLI produced on 2026-09-08 at 02:59 local. */
const SESSION_LIMIT = "You've hit your session limit · resets 3:10am (America/Sao_Paulo)";
const CLI_MESSAGE = `CLI exited with code 1: ${SESSION_LIMIT}`;

const GOAL = '005';
const DEV_JOB = '005-r1-developer-b218cf51';
const REV_JOB = '005-r1-tech_lead-ca1d7bf4';
const BASELINE = 'ecaf7058f2b81ffe4bd4d2966e233b4b58c16dd5';
const EXECUTION_BASE = '8551717940a58128a2af4c40cffeb977334860a5';

/** 2026-09-08T02:59:25 in America/Sao_Paulo is 05:59:25 UTC. */
const FAILED_AT = Date.parse('2026-09-08T05:59:25.741Z');

const failure = (message, code = 'NON_ZERO_EXIT') => ({
  error: { code, message }, structuredOutput: false,
});
const success = (payload) => ({ structuredOutput: true, payload });

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-session-limit-'));
  try { return await run(createJobStore(dir), dir); } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** A clock that never really sleeps, so a 20-minute wait costs nothing. */
function createFakeClock(startMs) {
  let current = startMs;
  const slept = [];
  return {
    slept,
    now: () => current,
    sleep: async (ms) => { slept.push(ms); current += ms; },
  };
}

const reviewJob = () => ({
  protocolVersion: PROTOCOL_VERSION_V2, jobId: REV_JOB, role: 'tech_lead',
  goal: GOAL, round: 1, reviewLevel: 'DEEP',
  migrationAcceptedBaseline: BASELINE, executionBase: EXECUTION_BASE,
  worktreeInitialHead: EXECUTION_BASE,
});
const developerJob = () => ({
  protocolVersion: PROTOCOL_VERSION_V2, jobId: DEV_JOB, role: 'developer',
  goal: GOAL, round: 1, type: 'IMPLEMENTATION',
  migrationAcceptedBaseline: BASELINE, executionBase: EXECUTION_BASE,
  worktreeInitialHead: EXECUTION_BASE,
});

// ===========================================================================
// 1–5. Classifier: the words the CLI actually uses
// ===========================================================================

test("1. \"You've hit your session limit\" is a usage limit", () => {
  assert.equal(classifyFailure(failure("You've hit your session limit")).reason, CAPACITY_REASONS.USAGE_LIMIT);
});

test('2. "session limit · resets 3:10am" is a usage limit', () => {
  assert.equal(classifyFailure(failure('session limit · resets 3:10am')).reason, CAPACITY_REASONS.USAGE_LIMIT);
});

test('3. the real message, timezone and all, is a usage limit', () => {
  const classification = classifyFailure(failure(CLI_MESSAGE), { now: FAILED_AT });

  assert.equal(classification.reason, CAPACITY_REASONS.USAGE_LIMIT);
  assert.notEqual(classification.reason, CAPACITY_REASONS.UNKNOWN_FATAL,
    'this is the exact misclassification that stopped Goal 005');

  // And it is a WAIT, which is the whole point: the loop never stops for it.
  const decision = decideCapacityAction({
    reason: classification.reason, attempt: 1,
    retryAfterMs: classification.retryAfterMs, now: FAILED_AT,
  });
  assert.equal(decision.action, CAPACITY_ACTIONS.WAIT);
});

test('4. an authentication problem is not turned into a usage limit', () => {
  // Ordering matters: auth and billing are checked before usage, so a message
  // carrying both words still reads as the thing a person has to fix.
  assert.equal(classifyFailure(failure('unauthorized: session limit')).reason, CAPACITY_REASONS.AUTH_ERROR);
  assert.equal(classifyFailure(failure('Not logged in. Please run /login')).reason, CAPACITY_REASONS.AUTH_ERROR);
  assert.equal(classifyFailure(failure('credit balance too low')).reason, CAPACITY_REASONS.BILLING_ERROR);
});

test('5. an unrelated "limit" is not a usage limit', () => {
  // "limit" on its own must never be enough, or every round budget and context
  // ceiling becomes a quota wall the loop waits out forever.
  for (const message of [
    'Round 1 asked for changes and the round budget is 3',
    'Refusing to dispatch: the correction limit is 3',
    'context limit exceeded for this request',
  ]) {
    assert.equal(classifyFailure(failure(message)).reason, CAPACITY_REASONS.UNKNOWN_FATAL, message);
  }
  // A local spawn failure still wins over everything: it is checked first.
  assert.equal(
    classifyFailure(failure('Failed to spawn claude.exe: spawn ENAMETOOLONG', 'SPAWN_FAILED')).reason,
    CAPACITY_REASONS.HARNESS_ERROR,
  );
});

// ===========================================================================
// 6–10. Reset time: when the quota actually comes back
// ===========================================================================

test('6. "resets 3:10am" is parsed into a wait', () => {
  // 02:59:25 in São Paulo, resetting at 03:10 → 10 minutes and 35 seconds.
  const ms = parseResetAt(SESSION_LIMIT, { now: FAILED_AT });
  assert.equal(ms, (10 * 60 + 35) * 1000);
});

test('7. the timezone stated in the message is the one used', () => {
  // The same instant, read in a zone three hours ahead, is a different wait.
  const inMessage = parseResetAt('resets 3:10am (America/Sao_Paulo)', { now: FAILED_AT });
  const elsewhere = parseResetAt('resets 3:10am', { now: FAILED_AT, timeZone: 'UTC' });

  assert.equal(inMessage, (10 * 60 + 35) * 1000);
  assert.notEqual(elsewhere, inMessage);
  // 05:59:25 UTC → next 03:10 UTC is tomorrow.
  assert.ok(elsewhere > 20 * 3_600_000, `expected a next-day wait, got ${elsewhere}`);
});

test('8. a reset later the same day is that same day', () => {
  // 10:00 in São Paulo (13:00 UTC), resetting at 15:10 → five hours and ten.
  const now = Date.parse('2026-09-08T13:00:00.000Z');
  assert.equal(parseResetAt('resets 15:10 (America/Sao_Paulo)', { now }), 5 * 3_600_000 + 10 * 60_000);
  assert.equal(parseResetAt('resets at 3:10pm (America/Sao_Paulo)', { now }), 5 * 3_600_000 + 10 * 60_000);
});

test('9. a reset already past today rolls over to tomorrow', () => {
  // 23:50 in São Paulo (02:50 UTC the next day), resetting at 3:10am.
  const now = Date.parse('2026-09-09T02:50:00.000Z');
  const ms = parseResetAt('resets 3:10am (America/Sao_Paulo)', { now });

  assert.equal(ms, (3 * 60 + 20) * 60_000, '23:50 → 03:10 the next day is 3h20');
  assert.ok(ms > 0);
  assert.ok(ms <= 24 * 3_600_000, 'never longer than a day');
});

test('10. an unreadable reset falls back to the default interval', () => {
  for (const text of [
    'resets 99:99am',
    'resets 25:00',
    'your limit will reset soon',
    'resets 3:10am (Not/A_Zone)',
  ]) {
    assert.equal(parseResetAt(text, { now: FAILED_AT }), null, text);
  }

  // Nothing is invented: the policy uses its configured interval instead.
  const classification = classifyFailure(failure('usage limit reached; your limit will reset soon'));
  assert.equal(classification.reason, CAPACITY_REASONS.USAGE_LIMIT);
  assert.equal(classification.retryAfterMs, null);
  const decision = decideCapacityAction({
    reason: classification.reason, attempt: 1, retryAfterMs: null, now: FAILED_AT,
  });
  assert.equal(decision.retryIntervalMs, CAPACITY_CONFIG.usageLimitRetryMs);
  assert.equal(decision.retryIntervalMs, 1_200_000, 'twenty minutes');
});

test('an explicit Retry-After still wins over a stated reset', () => {
  assert.equal(extractRetryAfterMs('retry-after: 30; resets 3:10am', { now: FAILED_AT }), 30_000);
});

// ===========================================================================
// 11–15. Taxonomy: what a capacity event is allowed to be
// ===========================================================================

test('11. USAGE_LIMIT produces a capacity event', () => {
  assert.equal(producesCapacityEvent({ reason: CAPACITY_REASONS.USAGE_LIMIT }), true);
  assert.equal(eventTypeFor({ reason: CAPACITY_REASONS.USAGE_LIMIT }), 'CAPACITY_LIMIT_REACHED');
});

test('12. RATE_LIMIT produces a capacity event', () => {
  assert.equal(producesCapacityEvent({ reason: CAPACITY_REASONS.RATE_LIMIT }), true);
  assert.equal(familyFor({ reason: CAPACITY_REASONS.RATE_LIMIT }), FAILURE_FAMILIES.MODEL_CAPACITY);
});

test('13. UNKNOWN_FATAL does not produce a capacity event', () => {
  // The real log carries four CAPACITY_LIMIT_REACHED events whose reason is
  // UNKNOWN_FATAL — a claim that a model limit was hit when none was.
  assert.equal(producesCapacityEvent({ reason: CAPACITY_REASONS.UNKNOWN_FATAL }), false);
  assert.notEqual(eventTypeFor({ reason: CAPACITY_REASONS.UNKNOWN_FATAL }), 'CAPACITY_LIMIT_REACHED');
});

test('14. HARNESS_ERROR does not produce a capacity event', () => {
  assert.equal(producesCapacityEvent({ reason: CAPACITY_REASONS.HARNESS_ERROR }), false);
  assert.equal(eventTypeFor({ reason: CAPACITY_REASONS.HARNESS_ERROR }), 'HARNESS_ERROR');
  assert.equal(eventTypeFor({ code: 'SPAWN_FAILED' }), 'HARNESS_ERROR');
});

test('15. a contract error does not produce a capacity event', () => {
  assert.equal(producesCapacityEvent({ code: 'UNSUPPORTED_DECISION' }), false);
  assert.equal(eventTypeFor({ code: 'UNSUPPORTED_DECISION' }), 'AGENT_CONTRACT_ERROR');
  assert.equal(eventTypeFor({ code: 'INVALID_AGENT_JSON' }), 'AGENT_CONTRACT_ERROR');
});

// ===========================================================================
// 16–25. Attempts: every real call is its own try
// ===========================================================================

test('16/17/18/19/20/21. a usage limit ends the attempt and the next one is a successor', async () => {
  await withStore(async (store) => {
    await store.publishJob('tech_lead', reviewJob());
    const clock = createFakeClock(FAILED_AT);

    let calls = 0;
    const run = await runWithCapacity({
      store, role: 'tech_lead', jobId: REV_JOB, goal: GOAL, round: 1,
      resumeFrom: LOOP_STATES.REVIEWER_RUNNING, clock,
      invoke: async () => {
        calls += 1;
        return calls === 1
          ? failure(CLI_MESSAGE)
          : success({ jobId: REV_JOB, goal: GOAL, round: 1, decision: 'ACCEPTED' });
      },
    });

    assert.equal(run.outcome, RUN_OUTCOMES.COMPLETED);
    assert.equal(calls, 2, 'two real calls');

    const envelope = await store.readAttemptState('tech_lead', REV_JOB);
    // 18. The job id never changed.
    assert.equal(envelope.attemptId, `${REV_JOB}-a2`);
    assert.equal(envelope.attempt, 2);

    // 20/21. a1 is preserved in the history, with why it ended.
    const history = envelope.history;
    assert.equal(history.length, 1);
    assert.equal(history[0].attemptId, `${REV_JOB}-a1`);
    assert.equal(history[0].status, 'WAITING_FOR_CAPACITY',
      '16. a capacity limit ends an attempt as a wait, never as FAILED');
    assert.equal(history[0].classification, CAPACITY_REASONS.USAGE_LIMIT);
    assert.equal(history[0].retryReason, CAPACITY_REASONS.USAGE_LIMIT);
    assert.equal(history[0].capacityWait, true);
    assert.equal(history[0].role, 'tech_lead');
    assert.ok(history[0].nextRetryAt, 'the deadline it waited for is recorded');
    assert.ok(history[0].endedAt);

    assert.notEqual(history[0].attemptId, envelope.attemptId, '21. a distinct attempt id');
  });
});

test('17. the stage stays incomplete while an attempt is waiting', async () => {
  await withStore(async (store) => {
    await store.publishJob('tech_lead', reviewJob());
    await store.publishJob('developer', developerJob());
    await store.publishResult('developer', DEV_JOB, { ok: true, result: { status: 'REVIEW_REQUIRED' } }, { attemptId: (await store.readAttemptState('developer', DEV_JOB))?.attemptId });
    await store.setJobStatus('developer', DEV_JOB, 'COMPLETED');
    await store.setJobStatus('tech_lead', REV_JOB, 'WAITING_FOR_CAPACITY');

    const reconciled = await reconcileExecutionState({ store, goal: GOAL });

    assert.equal(reconciled.next.kind, DISPATCH_KINDS.REVIEW, 'the review is still what is left to do');
    assert.equal(reconciled.ledger.get('005:r1:review').status, 'NOT_STARTED');
    assert.equal(reconciled.ledger.get('005:r1:implementation').status, 'COMPLETED');
    assert.equal(await store.hasCompletedResult('tech_lead', REV_JOB), false);
  });
});

test('22. a repeated resume does not create a third attempt', async () => {
  await withStore(async (store) => {
    await store.publishJob('tech_lead', reviewJob());
    await store.setJobStatus('tech_lead', REV_JOB, 'WAITING_FOR_CAPACITY');

    const first = await store.startNextAttempt('tech_lead', REV_JOB, { reason: 'USAGE_LIMIT' });
    assert.equal(first.created, true);
    assert.equal(first.attemptId, `${REV_JOB}-a2`);

    // a2 is QUEUED and claimable: a second resume finds it, it does not add a3.
    const second = await store.startNextAttempt('tech_lead', REV_JOB, { reason: 'USAGE_LIMIT' });
    assert.equal(second.created, false);
    assert.equal(second.reason, 'ATTEMPT_ALREADY_QUEUED');
    assert.equal((await store.readAttemptState('tech_lead', REV_JOB)).attempt, 2);
  });
});

test('23. an attempt that is RUNNING blocks a new one', async () => {
  await withStore(async (store) => {
    await store.publishJob('tech_lead', reviewJob());
    await store.setJobStatus('tech_lead', REV_JOB, 'RUNNING');

    const started = await store.startNextAttempt('tech_lead', REV_JOB, { reason: 'USAGE_LIMIT' });
    assert.equal(started.created, false);
    assert.equal(started.reason, 'ATTEMPT_RUNNING');
  });
});

test('24. a completed attempt is reused, never recomputed', async () => {
  await withStore(async (store) => {
    await store.publishJob('tech_lead', reviewJob());
    await store.publishResult('tech_lead', REV_JOB, { ok: true, result: { decision: 'ACCEPTED' } }, { attemptId: (await store.readAttemptState('tech_lead', REV_JOB))?.attemptId });

    let calls = 0;
    const run = await runWithCapacity({
      store, role: 'tech_lead', jobId: REV_JOB, goal: GOAL, round: 1,
      resumeFrom: LOOP_STATES.REVIEWER_RUNNING,
      clock: createFakeClock(FAILED_AT),
      invoke: async () => { calls += 1; return success({ decision: 'CHANGES_REQUIRED' }); },
    });

    assert.equal(run.outcome, RUN_OUTCOMES.ALREADY_COMPLETED);
    assert.equal(calls, 0, 'no model call');
    assert.equal(await store.startNextAttempt('tech_lead', REV_JOB).then((r) => r.reason), 'STAGE_ALREADY_COMPLETED');
  });
});

test('25. a second usage limit produces a third attempt, never a stop', async () => {
  await withStore(async (store) => {
    await store.publishJob('tech_lead', reviewJob());
    const clock = createFakeClock(FAILED_AT);

    let calls = 0;
    const run = await runWithCapacity({
      store, role: 'tech_lead', jobId: REV_JOB, goal: GOAL, round: 1,
      resumeFrom: LOOP_STATES.REVIEWER_RUNNING, clock,
      invoke: async () => {
        calls += 1;
        return calls <= 2 ? failure(CLI_MESSAGE) : success({ decision: 'ACCEPTED' });
      },
    });

    assert.equal(run.outcome, RUN_OUTCOMES.COMPLETED);
    assert.equal(calls, 3);
    const state = await store.readAttemptState('tech_lead', REV_JOB);
    assert.equal(state.attemptId, `${REV_JOB}-a3`);
    assert.equal(state.history.length, 2, 'a1 and a2 both preserved');
    // A usage limit has no attempt ceiling: it never becomes HUMAN_REQUIRED.
    assert.notEqual(run.outcome, RUN_OUTCOMES.HUMAN_REQUIRED);
  });
});

// ===========================================================================
// 26–30. Restart in the middle of a wait
// ===========================================================================

test('26. the deadline persisted is the reset the CLI stated, not a generic interval', async () => {
  await withStore(async (store) => {
    await store.publishJob('tech_lead', reviewJob());
    await store.writeRuntime({ goal: GOAL, round: 1, migrationAcceptedBaseline: BASELINE });

    const clock = createFakeClock(FAILED_AT);
    let onDisk = null;
    let calls = 0;

    await runWithCapacity({
      store, role: 'tech_lead', jobId: REV_JOB, goal: GOAL, round: 1,
      resumeFrom: LOOP_STATES.REVIEWER_RUNNING, clock,
      invoke: async () => {
        calls += 1;
        if (calls === 1) return failure(CLI_MESSAGE);
        // Read exactly what a process restarting mid-wait would find.
        onDisk = await readRuntimeStrict(store);
        return success({ decision: 'ACCEPTED' });
      },
    });

    assert.equal(onDisk.state, LOOP_STATES.WAITING_FOR_CAPACITY);
    assert.equal(onDisk.capacity.reason, CAPACITY_REASONS.USAGE_LIMIT);
    assert.equal(onDisk.blockedJobId, REV_JOB);
    assert.equal(onDisk.resumeFrom, LOOP_STATES.REVIEWER_RUNNING);
    assert.equal(onDisk.capacity.nextRetryAt, new Date(FAILED_AT + (10 * 60 + 35) * 1000).toISOString());
    assert.deepEqual(clock.slept, [(10 * 60 + 35) * 1000],
      'ten minutes and thirty-five seconds, not the twenty-minute default');
    // The baseline is untouched by a capacity event.
    assert.equal(onDisk.migrationAcceptedBaseline, BASELINE);
  });
});

test('27. a restart before the deadline sleeps the remainder instead of calling the model', async () => {
  await withStore(async (store) => {
    await store.publishJob('tech_lead', reviewJob());
    await store.setJobStatus('tech_lead', REV_JOB, 'WAITING_FOR_CAPACITY');
    await store.writeRuntime({
      goal: GOAL, round: 1, state: LOOP_STATES.WAITING_FOR_CAPACITY,
      blockedAgent: 'tech_lead', blockedJobId: REV_JOB, resumeFrom: LOOP_STATES.REVIEWER_RUNNING,
      migrationAcceptedBaseline: BASELINE,
      capacity: {
        reason: CAPACITY_REASONS.USAGE_LIMIT, attempt: 1,
        firstSeenAt: new Date(FAILED_AT).toISOString(),
        lastAttemptAt: new Date(FAILED_AT).toISOString(),
        nextRetryAt: new Date(FAILED_AT + 635_000).toISOString(),
        retryIntervalMs: 635_000,
      },
    });

    const restart = createFakeClock(FAILED_AT + 60_000);
    let calls = 0;
    await runWithCapacity({
      store, role: 'tech_lead', jobId: REV_JOB, goal: GOAL, round: 1,
      resumeFrom: LOOP_STATES.REVIEWER_RUNNING, clock: restart,
      invoke: async () => { calls += 1; return success({ decision: 'ACCEPTED' }); },
    });

    assert.deepEqual(restart.slept, [635_000 - 60_000], 'slept to the persisted deadline');
    assert.equal(calls, 1, 'and only then called the model, once');
  });
});

test('28/29/30. a restart after the deadline runs the next attempt of the same review', async () => {
  await withStore(async (store) => {
    await store.publishJob('tech_lead', { ...reviewJob(), packetPath: '/artefacts/005-r1/review-packet.json' });
    await store.setJobStatus('tech_lead', REV_JOB, 'WAITING_FOR_CAPACITY');
    await store.writeRuntime({
      goal: GOAL, round: 1, state: LOOP_STATES.WAITING_FOR_CAPACITY,
      blockedAgent: 'tech_lead', blockedJobId: REV_JOB, resumeFrom: LOOP_STATES.REVIEWER_RUNNING,
      migrationAcceptedBaseline: BASELINE, executionBase: EXECUTION_BASE,
      capacity: {
        reason: CAPACITY_REASONS.USAGE_LIMIT, attempt: 1,
        firstSeenAt: new Date(FAILED_AT).toISOString(),
        lastAttemptAt: new Date(FAILED_AT).toISOString(),
        nextRetryAt: new Date(FAILED_AT + 600_000).toISOString(),
        retryIntervalMs: 600_000,
      },
    });

    const clock = createFakeClock(FAILED_AT + 3_600_000);
    let seen = null;
    const run = await runWithCapacity({
      store, role: 'tech_lead', jobId: REV_JOB, goal: GOAL, round: 1,
      resumeFrom: LOOP_STATES.REVIEWER_RUNNING, clock,
      invoke: async () => { seen = await store.readJob('tech_lead', REV_JOB); return success({ decision: 'ACCEPTED' }); },
    });

    assert.equal(run.outcome, RUN_OUTCOMES.COMPLETED);
    assert.deepEqual(clock.slept, [], 'the deadline had passed; nothing to wait for');
    assert.equal((await store.readAttemptState('tech_lead', REV_JOB)).attemptId, `${REV_JOB}-a2`);

    // 29/30. Same packet, same Goal, same round — the job was never rebuilt.
    assert.equal(seen.packetPath, '/artefacts/005-r1/review-packet.json');
    assert.equal(seen.goal, GOAL);
    assert.equal(seen.round, 1);
    assert.equal(seen.worktreeInitialHead, EXECUTION_BASE);
  });
});

// ===========================================================================
// 31–40. Goal 005: the repair, and what it must not touch
// ===========================================================================

/** The state on disk when Goal 005 stopped, rebuilt exactly. */
async function goal005AtTheStop(store) {
  await store.publishJob('developer', developerJob());
  await store.publishResult('developer', DEV_JOB, {
    ok: true,
    result: { jobId: DEV_JOB, goal: GOAL, round: 1, status: 'REVIEW_REQUIRED', implementationReport: 'Goal 005' },
  }, { attemptId: (await store.readAttemptState('developer', DEV_JOB))?.attemptId });
  await store.setJobStatus('developer', DEV_JOB, 'COMPLETED');

  await store.publishJob('tech_lead', reviewJob());
  await store.setJobStatus('tech_lead', REV_JOB, 'FAILED');
  await store.appendEvent({
    at: new Date(FAILED_AT).toISOString(),
    type: 'CAPACITY_LIMIT_REACHED', goal: GOAL, round: 1, agent: 'tech_lead', jobId: REV_JOB,
    reason: 'UNKNOWN_FATAL', attempt: 1, diagnostic: CLI_MESSAGE,
  });
  await store.publishResult('tech_lead', REV_JOB, {
    ok: false, code: 'UNKNOWN_FATAL',
    message: 'Unrecoverable failure; a human must look at it.', escalation: 'HUMAN_REQUIRED',
  }, { attemptId: (await store.readAttemptState('tech_lead', REV_JOB))?.attemptId });
  await store.writeRuntime({
    mode: 'REAL_EXECUTION', goal: GOAL, round: 1, state: LOOP_STATES.AWAITING_HUMAN,
    migrationAcceptedBaseline: BASELINE, executionBase: EXECUTION_BASE,
    worktreePath: '.ai-worktrees/goal-005', worktreeInitialHead: EXECUTION_BASE,
    reviewLevel: 'DEEP', decision: 'HUMAN_REQUIRED', escalationReason: 'UNKNOWN_FATAL',
    blockedAgent: 'tech_lead', blockedJobId: REV_JOB,
    jobIdsByRound: { 1: { developer: DEV_JOB, tech_lead: REV_JOB } },
    humanRequired: { reason: 'UNKNOWN_FATAL', note: 'Unrecoverable failure; a human must look at it.' },
  });
}

test('31/32. the Developer result survives the repair and Opus is not called again', async () => {
  await withStore(async (store) => {
    await goal005AtTheStop(store);
    const before = await store.readResult('developer', DEV_JOB);

    await reclassifyFailure(store, {
      role: 'tech_lead', jobId: REV_JOB, resumeFrom: LOOP_STATES.REVIEWER_RUNNING,
      now: Date.parse('2026-09-08T08:00:00.000Z'),
    });

    const after = await store.readResult('developer', DEV_JOB);
    assert.deepEqual(after, before, '31. byte for byte the same result');
    assert.equal(await store.readJobStatus('developer', DEV_JOB), 'COMPLETED');

    // 32. The implementation stage is complete, so nothing may dispatch it.
    const reconciled = await reconcileExecutionState({ store, goal: GOAL });
    assert.equal(reconciled.ledger.get('005:r1:implementation').status, 'COMPLETED');
    assert.equal(reconciled.next.kind, DISPATCH_KINDS.REVIEW, 'the review, never the implementation');
    assert.equal(reconciled.next.role, 'tech_lead');
    await assert.rejects(
      store.startNextAttempt('developer', DEV_JOB).then((r) => {
        assert.equal(r.created, false);
        assert.equal(r.reason, 'STAGE_ALREADY_COMPLETED');
        throw new Error('checked');
      }),
      /checked/,
    );
  });
});

test('33/34. the historical UNKNOWN_FATAL is repaired, and stays readable', async () => {
  await withStore(async (store) => {
    await goal005AtTheStop(store);

    const evidence = await findFailureEvidence(store, { role: 'tech_lead', jobId: REV_JOB });
    assert.equal(evidence.recordedReason, 'UNKNOWN_FATAL');
    assert.equal(evidence.diagnostic, CLI_MESSAGE);

    const verdict = reclassifyEvidence(evidence);
    assert.equal(verdict.from, 'UNKNOWN_FATAL');
    assert.equal(verdict.to, CAPACITY_REASONS.USAGE_LIMIT);
    assert.equal(verdict.changed, true);
    assert.equal(verdict.action, CAPACITY_ACTIONS.WAIT);

    const applied = await reclassifyFailure(store, {
      role: 'tech_lead', jobId: REV_JOB, resumeFrom: LOOP_STATES.REVIEWER_RUNNING,
      now: Date.parse('2026-09-08T08:00:00.000Z'),
    });

    // 34. Nothing was erased.
    assert.equal(applied.repair.originalStatus, 'FAILED');
    assert.equal(applied.repair.originalClassification, 'UNKNOWN_FATAL');
    assert.equal(applied.repair.correctedClassification, CAPACITY_REASONS.USAGE_LIMIT);
    assert.equal(applied.repair.repairReason, 'CAPACITY_CLASSIFIER_BUG');
    assert.equal(applied.repair.sourceEvidence.event.diagnostic, CLI_MESSAGE);

    const job = await readJobEnvelope(store, 'tech_lead', REV_JOB);
    assert.equal(job.status, 'WAITING_FOR_CAPACITY');
    assert.equal(job.reclassifications.length, 1);
    assert.equal(job.reclassifications[0].originalClassification, 'UNKNOWN_FATAL');

    const events = (await store.readEvents()).map((e) => e.type);
    assert.ok(events.includes('CAPACITY_LIMIT_REACHED'), 'the original event is untouched');
    assert.ok(events.includes('FAILURE_RECLASSIFIED'));
    const correction = (await store.readEvents()).find((e) => e.type === 'FAILURE_RECLASSIFIED');
    assert.equal(correction.from, 'UNKNOWN_FATAL');
    assert.equal(correction.to, CAPACITY_REASONS.USAGE_LIMIT);
    assert.equal(correction.jobId, REV_JOB);
    assert.equal(correction.attemptId, `${REV_JOB}-a1`);
    assert.equal(correction.reason, 'CAPACITY_CLASSIFIER_BUG');
  });
});

test('35/36. the next attempt is a2, and the next model is the reviewer', async () => {
  await withStore(async (store) => {
    await goal005AtTheStop(store);
    await reclassifyFailure(store, {
      role: 'tech_lead', jobId: REV_JOB, resumeFrom: LOOP_STATES.REVIEWER_RUNNING,
      now: Date.parse('2026-09-08T08:00:00.000Z'),
    });

    // The reset stated was 03:10; by 08:00 UTC (05:00 local) it has passed.
    const runtime = await readRuntimeStrict(store);
    assert.equal(runtime.state, LOOP_STATES.WAITING_FOR_CAPACITY);
    assert.equal(runtime.capacity.retryIntervalMs, 0, 'the deadline is already behind us');
    assert.equal(remainingWaitMs(runtime, Date.parse('2026-09-08T08:00:00.000Z')), 0);
    assert.equal(runtime.humanRequired, null);

    // 36. Reconciliation says review, and the role is the Tech Lead.
    const reconciled = await reconcileExecutionState({ store, goal: GOAL });
    assert.equal(reconciled.next.kind, DISPATCH_KINDS.REVIEW);
    assert.equal(reconciled.next.role, 'tech_lead');
    assert.equal(reconciled.next.stageKey, '005:r1:review');
    assert.equal(reconciled.next.resumeAttempt, REV_JOB, 'the same job, not a new one');

    // 35. And running it materialises a2 of that same job.
    const started = await store.startNextAttempt('tech_lead', REV_JOB, { reason: 'USAGE_LIMIT' });
    assert.equal(started.created, true);
    assert.equal(started.attemptId, `${REV_JOB}-a2`);
    assert.equal(started.previousAttemptId, `${REV_JOB}-a1`);
  });
});

test('37/38/39. the worktree, execution base and baseline are untouched by a repair', async () => {
  await withStore(async (store) => {
    await goal005AtTheStop(store);
    const before = await store.readRuntime();

    await reclassifyFailure(store, {
      role: 'tech_lead', jobId: REV_JOB, resumeFrom: LOOP_STATES.REVIEWER_RUNNING,
      now: Date.parse('2026-09-08T08:00:00.000Z'),
    });

    const after = await store.readRuntime();
    assert.equal(after.worktreeInitialHead, before.worktreeInitialHead);
    assert.equal(after.worktreePath, before.worktreePath);
    assert.equal(after.executionBase, before.executionBase);
    assert.equal(after.migrationAcceptedBaseline, BASELINE);
    assert.equal(after.goal, GOAL);
    assert.equal(after.round, 1);
    assert.deepEqual(after.jobIdsByRound, before.jobIdsByRound);

    // The review job's own contract is untouched too.
    const job = await store.readJob('tech_lead', REV_JOB);
    assert.equal(job.worktreeInitialHead, EXECUTION_BASE);
    assert.equal(job.migrationAcceptedBaseline, BASELINE);
    assert.equal(job.reviewLevel, 'DEEP');
  });
});

test('40. no fallback model is ever chosen for a capacity wait', () => {
  // The policy has exactly two actions, and neither of them is "use a different
  // model". A capacity wait resumes the SAME model, by construction.
  assert.deepEqual(Object.keys(CAPACITY_ACTIONS).sort(), ['HUMAN_REQUIRED', 'WAIT']);
  for (const reason of [CAPACITY_REASONS.USAGE_LIMIT, CAPACITY_REASONS.RATE_LIMIT]) {
    const decision = decideCapacityAction({ reason, attempt: 7, now: FAILED_AT });
    assert.equal(decision.action, CAPACITY_ACTIONS.WAIT);
    assert.equal(decision.reason, reason);
    assert.equal(Object.hasOwn(decision, 'model'), false, 'the decision does not name a model at all');
  }
  // And a detected fallback stays fatal.
  assert.equal(
    classifyFailure(failure('resolved model differs', 'MODEL_FALLBACK_DETECTED')).reason,
    CAPACITY_REASONS.UNKNOWN_FATAL,
  );
});

// ===========================================================================
// The repair refuses everything it cannot justify
// ===========================================================================

test('a failure that still classifies the same way is not repairable', async () => {
  await withStore(async (store) => {
    await store.publishJob('tech_lead', reviewJob());
    await store.setJobStatus('tech_lead', REV_JOB, 'FAILED');
    await store.appendEvent({
      type: 'AGENT_FAILURE', jobId: REV_JOB, reason: 'UNKNOWN_FATAL',
      diagnostic: 'CLI exited with code 1: something nobody has ever seen',
    });
    await store.publishResult('tech_lead', REV_JOB, { ok: false, code: 'UNKNOWN_FATAL', message: 'x' }, { attemptId: (await store.readAttemptState('tech_lead', REV_JOB))?.attemptId });

    await assert.rejects(
      reclassifyFailure(store, { role: 'tech_lead', jobId: REV_JOB, resumeFrom: LOOP_STATES.REVIEWER_RUNNING }),
      codeIs('NOTHING_TO_RECLASSIFY'),
    );
    assert.equal(await store.readJobStatus('tech_lead', REV_JOB), 'FAILED', 'and nothing was written');
  });
});

test('a repair that would still need a human is refused', async () => {
  await withStore(async (store) => {
    await store.publishJob('tech_lead', reviewJob());
    await store.setJobStatus('tech_lead', REV_JOB, 'FAILED');
    await store.appendEvent({
      type: 'AGENT_FAILURE', jobId: REV_JOB, reason: 'UNKNOWN_FATAL',
      diagnostic: 'CLI exited with code 1: Not logged in. Please run /login',
    });
    await store.publishResult('tech_lead', REV_JOB, { ok: false, code: 'UNKNOWN_FATAL', message: 'x' }, { attemptId: (await store.readAttemptState('tech_lead', REV_JOB))?.attemptId });

    // AUTH_ERROR is a better reading, and still a person's problem: turning the
    // stop into a wait would hide it.
    await assert.rejects(
      reclassifyFailure(store, { role: 'tech_lead', jobId: REV_JOB, resumeFrom: LOOP_STATES.REVIEWER_RUNNING }),
      codeIs('RECLASSIFICATION_NOT_A_WAIT'),
    );
  });
});

test('a completed stage is never reopened by a repair', async () => {
  await withStore(async (store) => {
    await goal005AtTheStop(store);
    await store.publishResult('tech_lead', REV_JOB, { ok: true, result: { decision: 'ACCEPTED' } }, { attemptId: (await store.readAttemptState('tech_lead', REV_JOB))?.attemptId });

    await assert.rejects(
      reclassifyFailure(store, { role: 'tech_lead', jobId: REV_JOB, resumeFrom: LOOP_STATES.REVIEWER_RUNNING }),
      codeIs('NO_FAILURE_TO_RECLASSIFY'),
    );
  });
});

test('the run stops being PAUSED_FOR_HUMAN only for the reason that was repaired', async () => {
  await withStore(async (store, dir) => {
    await goal005AtTheStop(store);
    const auto = createAutonomousStore(dir);
    await auto.write({
      runMode: 'AUTONOMOUS', autonomousRunId: 'auto-008f98f8', status: 'PAUSED_FOR_HUMAN',
      currentGoal: GOAL, completedGoals: [], migrationAcceptedBaseline: BASELINE,
      humanRequired: { reason: 'UNKNOWN_FATAL', detail: 'Goal 005 ended as HUMAN_REQUIRED' },
    });

    const applied = await reclassifyFailure(store, {
      role: 'tech_lead', jobId: REV_JOB, resumeFrom: LOOP_STATES.REVIEWER_RUNNING,
      autonomousStore: auto, now: Date.parse('2026-09-08T08:00:00.000Z'),
    });

    assert.equal(applied.run.status, 'RUNNING');
    assert.equal(applied.run.humanRequired, null);
    assert.equal(applied.run.autonomousRunId, 'auto-008f98f8', 'the same run, not a new one');
    assert.equal(applied.run.migrationAcceptedBaseline, BASELINE);
    assert.equal(applied.run.reclassifiedFrom.reason, 'UNKNOWN_FATAL');
  });
});

// ===========================================================================
// Integration: Developer once, reviewer twice, no human
// ===========================================================================

test('Goal005 R1: session limit is waited out and the review completes without a human', async () => {
  await withStore(async (store) => {
    const clock = createFakeClock(FAILED_AT);
    const calls = { developer: 0, tech_lead: 0 };
    const models = [];

    // --- Developer R1, once ------------------------------------------------
    await store.publishJob('developer', developerJob());
    const dev = await runWithCapacity({
      store, role: 'developer', jobId: DEV_JOB, goal: GOAL, round: 1,
      resumeFrom: LOOP_STATES.DEVELOPER_RUNNING, clock,
      invoke: async () => {
        calls.developer += 1;
        models.push('claude-opus-5');
        return success({ jobId: DEV_JOB, goal: GOAL, round: 1, status: 'REVIEW_REQUIRED' });
      },
    });
    assert.equal(dev.outcome, RUN_OUTCOMES.COMPLETED);

    // --- Review R1: a1 hits the session limit, a2 answers -------------------
    await store.publishJob('tech_lead', reviewJob());
    const review = await runWithCapacity({
      store, role: 'tech_lead', jobId: REV_JOB, goal: GOAL, round: 1,
      resumeFrom: LOOP_STATES.REVIEWER_RUNNING, clock,
      invoke: async () => {
        calls.tech_lead += 1;
        models.push('claude-fable-5-1');
        return calls.tech_lead === 1
          ? failure(CLI_MESSAGE)
          : success({
            jobId: REV_JOB, goal: GOAL, round: 1, decision: 'CHANGES_REQUIRED',
            blockers: [{ id: 'B1', title: 'sessão sem expiração determinística' }],
          });
      },
    });

    assert.equal(review.outcome, RUN_OUTCOMES.COMPLETED);
    assert.notEqual(review.outcome, RUN_OUTCOMES.HUMAN_REQUIRED, 'a session limit never stops the loop');

    // The Developer ran exactly once; the reviewer exactly twice.
    assert.equal(calls.developer, 1);
    assert.equal(calls.tech_lead, 2);

    // One logical stage, one job, two attempts.
    const state = await store.readAttemptState('tech_lead', REV_JOB);
    assert.equal(state.attemptId, `${REV_JOB}-a2`);
    assert.equal(state.history[0].attemptId, `${REV_JOB}-a1`);
    assert.equal(state.history[0].status, 'WAITING_FOR_CAPACITY');

    // The same model on both attempts. No fallback, ever.
    assert.deepEqual([...new Set(models)], ['claude-opus-5', 'claude-fable-5-1']);
    assert.equal(models.filter((m) => m === 'claude-fable-5-1').length, 2);

    // The waiting was a capacity wait, named as one.
    const events = (await store.readEvents()).map((e) => e.type);
    assert.ok(events.includes('CAPACITY_LIMIT_REACHED'));
    assert.ok(events.includes('CAPACITY_WAIT_STARTED'));
    assert.ok(events.includes('CAPACITY_AVAILABLE'));
    assert.ok(events.includes('JOB_ATTEMPT_STARTED'));
    assert.equal(events.includes('HUMAN_REQUIRED'), false);

    // The capacity event says USAGE_LIMIT, not UNKNOWN_FATAL.
    const limit = (await store.readEvents()).find((e) => e.type === 'CAPACITY_LIMIT_REACHED');
    assert.equal(limit.reason, CAPACITY_REASONS.USAGE_LIMIT);
    assert.equal(limit.attemptId, `${REV_JOB}-a1`);

    // And the next thing to do is the correction round the review asked for.
    const reconciled = await reconcileExecutionState({ store, goal: GOAL });
    assert.equal(reconciled.next.kind, DISPATCH_KINDS.CORRECTION);
    assert.equal(reconciled.next.round, 2);
    assert.equal(reconciled.next.blockers.length, 1);
  });
});

/** The raw envelope, for assertions about fields the reader does not expose. */
async function readJobEnvelope(store, role, jobId) {
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile(store.paths.job(role, jobId), 'utf8'));
}
