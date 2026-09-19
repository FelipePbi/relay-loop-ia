/**
 * Capacity handling tests.
 *
 * No real model is ever called and no quota is ever exercised: failures come
 * from sanitized fixtures and a fake agent, and every wait uses a virtual clock
 * so minute-long backoffs cost nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJobStore, readJson } from '../lib/job-store.mjs';
import { createFakeClock } from '../lib/clock.mjs';
import { CAPACITY_CONFIG } from '../lib/capacity-config.mjs';
import {
  CAPACITY_REASONS,
  classifyFailure,
  extractRetryAfterMs,
  sanitizeDiagnostic,
} from '../lib/capacity-classifier.mjs';
import { CAPACITY_ACTIONS, decideCapacityAction, formatRemaining } from '../lib/capacity-policy.mjs';
import {
  persistCapacityWait,
  readRuntimeStrict,
  remainingWaitMs,
  validateWaitingRuntime,
} from '../lib/capacity-state.mjs';
import { RUN_OUTCOMES, runWithCapacity } from '../lib/capacity-runner.mjs';
import { LOOP_STATES, createLoopStateMachine } from '../lib/loop-state.mjs';
import { readWorkerHealth, WORKER_HEALTH, writeHeartbeat } from '../lib/worker-registry.mjs';
import { PROTOCOL_VERSION_V2 } from '../lib/contracts-v2.mjs';
import { planResume } from '../run-resume.mjs';

const codeIs = (code) => (error) => error.code === code;
const NOW = Date.parse('2026-09-07T02:00:00.000Z');

/** Sanitized fixtures — shapes only, no real captured payloads. */
const FIXTURES = Object.freeze({
  rateLimit: { code: 'NON_ZERO_EXIT', message: 'API Error: 429 rate_limit_error · too many requests' },
  rateLimitWithRetryAfter: { code: 'NON_ZERO_EXIT', message: 'API Error: 429 rate_limit_error. retry-after: 45' },
  rateLimitHugeRetryAfter: { code: 'NON_ZERO_EXIT', message: 'API Error: 429 rate_limit_error. retry-after: 86400' },
  usageLimit: { code: 'NON_ZERO_EXIT', message: 'Usage limit reached. Your 5-hour limit will reset later.' },
  authError: { code: 'NON_ZERO_EXIT', message: 'Not logged in · Please run /login' },
  billingError: { code: 'NON_ZERO_EXIT', message: 'API Error: credit balance is too low. Please check your billing.' },
  modelUnavailable: { code: 'NON_ZERO_EXIT', message: 'API Error: model_not_found — unknown model requested' },
  transient: { code: 'TIMEOUT', message: 'Process exceeded 900000ms and was killed' },
  fatal: { code: 'NON_ZERO_EXIT', message: 'Something entirely unexpected happened' },
  fallbackDetected: { code: 'MODEL_FALLBACK_DETECTED', message: 'Requested "claude-opus-5" but the main inference came from "claude-haiku-4-5"' },
});

const failure = (fixture) => ({ error: fixture, structuredOutput: false, payload: null });
const success = (payload) => ({ error: null, structuredOutput: true, available: true, payload, resolvedPrimaryModel: 'claude-opus-5' });

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-capacity-'));
  try {
    return await run(createJobStore(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function developerJob(overrides = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION_V2,
    jobId: 'job-dev-1',
    role: 'developer',
    goal: '003',
    round: 2,
    type: 'IMPLEMENTATION',
    migrationAcceptedBaseline: '1e874e2785d2bc78860db0eb571ea901a4395c17',
    executionBase: 'b93f631ec000a58e8bccca1c5eae109102f99b8f',
    worktree: '.ai-worktrees/goal-003',
    goalPath: 'docs/migration/goals/003-x.md',
    blockers: [],
    ...overrides,
  };
}

const DEV_RESULT = {
  protocolVersion: PROTOCOL_VERSION_V2,
  jobId: 'job-dev-1',
  goal: '003',
  round: 2,
  status: 'REVIEW_REQUIRED',
  summary: 'feito',
  implementationReport: 'relatório',
  validations: [],
};

// ===========================================================================
// Classification
// ===========================================================================

test('1/5/7/8/9/13. each fixture classifies to its reason', () => {
  const cases = [
    ['rateLimit', CAPACITY_REASONS.RATE_LIMIT],
    ['usageLimit', CAPACITY_REASONS.USAGE_LIMIT],
    ['authError', CAPACITY_REASONS.AUTH_ERROR],
    ['billingError', CAPACITY_REASONS.BILLING_ERROR],
    ['modelUnavailable', CAPACITY_REASONS.MODEL_UNAVAILABLE],
    ['transient', CAPACITY_REASONS.UNKNOWN_TRANSIENT],
    ['fatal', CAPACITY_REASONS.UNKNOWN_FATAL],
  ];
  for (const [fixture, expected] of cases) {
    assert.equal(classifyFailure(failure(FIXTURES[fixture])).reason, expected, fixture);
  }
});

test('26. a detected model fallback is fatal, never retried around', () => {
  const classification = classifyFailure(failure(FIXTURES.fallbackDetected));
  assert.equal(classification.reason, CAPACITY_REASONS.UNKNOWN_FATAL);

  const decision = decideCapacityAction({ reason: classification.reason, attempt: 1, now: NOW });
  assert.equal(decision.action, CAPACITY_ACTIONS.HUMAN_REQUIRED);
});

test('classification prefers our structured code over text', () => {
  // Text says "rate limit", but our own code says the executable is missing:
  // a local tooling failure, not a model limit.
  const outcome = failure({ code: 'EXECUTABLE_NOT_FOUND', message: 'rate limit 429' });
  assert.equal(classifyFailure(outcome).reason, CAPACITY_REASONS.HARNESS_ERROR);
});

// ---------------------------------------------------------------------------
// Model-identity resolution failures are local tooling, not an unknowable
// model failure. Goal006 R1's review stopped as UNKNOWN_FATAL on
// RESOLVED_MODEL_UNKNOWN even though the CLI had already answered correctly;
// see claude-process.mjs's resolveServedPrimaryModel and resolvePrimaryModel.
// ---------------------------------------------------------------------------

test('11. RESOLVED_MODEL_UNKNOWN classifies as HARNESS_ERROR, not UNKNOWN_FATAL', () => {
  const outcome = failure({ code: 'RESOLVED_MODEL_UNKNOWN', message: 'no modelUsage entry accounts for the top-level usage' });
  const classification = classifyFailure(outcome);
  assert.equal(classification.reason, CAPACITY_REASONS.HARNESS_ERROR);

  const decision = decideCapacityAction({ reason: classification.reason, attempt: 1, now: NOW });
  assert.equal(decision.action, CAPACITY_ACTIONS.HUMAN_REQUIRED);
  assert.match(decision.note, /local harness failure/i);
});

test('12. RESOLVED_MODEL_AMBIGUOUS classifies as HARNESS_ERROR, not UNKNOWN_FATAL', () => {
  const outcome = failure({ code: 'RESOLVED_MODEL_AMBIGUOUS', message: 'several models match the top-level usage indistinguishably' });
  assert.equal(classifyFailure(outcome).reason, CAPACITY_REASONS.HARNESS_ERROR);
});

test('9/10. missing or conflicting explicit model evidence classifies as HARNESS_ERROR', () => {
  const missing = failure({ code: 'PRIMARY_MODEL_EVIDENCE_MISSING', message: 'no assistant event carried message.model' });
  assert.equal(classifyFailure(missing).reason, CAPACITY_REASONS.HARNESS_ERROR);

  const conflict = failure({ code: 'PRIMARY_MODEL_EVIDENCE_CONFLICT', message: 'more than one served model reported' });
  assert.equal(classifyFailure(conflict).reason, CAPACITY_REASONS.HARNESS_ERROR);
});

test('a genuinely detected fallback stays UNKNOWN_FATAL, distinct from a harness verification bug', () => {
  // Unchanged by the fix: MODEL_FALLBACK_DETECTED means the evidence is clear
  // and damning (a different model answered), never "we could not tell".
  assert.equal(classifyFailure(failure(FIXTURES.fallbackDetected)).reason, CAPACITY_REASONS.UNKNOWN_FATAL);
});

test('2. Retry-After is extracted when present', () => {
  assert.equal(extractRetryAfterMs('retry-after: 45'), 45_000);
  assert.equal(extractRetryAfterMs('try again in 3 minutes'), 180_000);
  assert.equal(extractRetryAfterMs('available again in 2 hours'), 7_200_000);
  assert.equal(extractRetryAfterMs({ retryAfterMs: 1234 }), 1234);
  assert.equal(extractRetryAfterMs({ retryAfter: 30 }), 30_000);
  assert.equal(extractRetryAfterMs('nothing here'), null);
});

test('diagnostics are scrubbed and truncated, never carrying secrets', () => {
  const dirty = 'failed with api_key="sk-abc123SECRET" Authorization: Bearer tok_987 cookie=xyz session 6dee5c24-1111-4222-8333-444455556666';
  const clean = sanitizeDiagnostic(dirty);

  for (const secret of ['sk-abc123SECRET', 'tok_987', 'xyz', '6dee5c24-1111']) {
    assert.ok(!clean.includes(secret), `diagnostic must not contain ${secret}`);
  }
  assert.ok(clean.includes('<redacted>'));
  assert.ok(sanitizeDiagnostic('x'.repeat(1000)).length <= 300);
});

// ===========================================================================
// Policy
// ===========================================================================

test('1. RATE_LIMIT waits instead of failing the Goal', () => {
  const decision = decideCapacityAction({ reason: CAPACITY_REASONS.RATE_LIMIT, attempt: 1, now: NOW });
  assert.equal(decision.action, CAPACITY_ACTIONS.WAIT);
  assert.equal(decision.retryIntervalMs, 30_000);
});

test('2. Retry-After is respected for RATE_LIMIT', () => {
  const decision = decideCapacityAction({
    reason: CAPACITY_REASONS.RATE_LIMIT, attempt: 1, retryAfterMs: 45_000, now: NOW,
  });
  assert.equal(decision.retryIntervalMs, 45_000);
  assert.equal(decision.nextRetryAt, new Date(NOW + 45_000).toISOString());
});

test('3. RATE_LIMIT without Retry-After uses progressive backoff', () => {
  const intervals = [1, 2, 3, 4].map((attempt) =>
    decideCapacityAction({ reason: CAPACITY_REASONS.RATE_LIMIT, attempt, now: NOW }).retryIntervalMs);
  assert.deepEqual(intervals, [30_000, 60_000, 120_000, 300_000]);
});

test('4. backoff is capped at 5 minutes, including a huge Retry-After', () => {
  const late = decideCapacityAction({ reason: CAPACITY_REASONS.RATE_LIMIT, attempt: 99, now: NOW });
  assert.equal(late.retryIntervalMs, CAPACITY_CONFIG.rateLimitMaxMs);
  assert.equal(late.retryIntervalMs, 300_000);

  const huge = decideCapacityAction({
    reason: CAPACITY_REASONS.RATE_LIMIT, attempt: 1, retryAfterMs: 86_400_000, now: NOW,
  });
  assert.equal(huge.retryIntervalMs, 300_000);
});

test('5. USAGE_LIMIT waits with the longer interval', () => {
  const decision = decideCapacityAction({ reason: CAPACITY_REASONS.USAGE_LIMIT, attempt: 1, now: NOW });
  assert.equal(decision.action, CAPACITY_ACTIONS.WAIT);
  assert.equal(decision.retryIntervalMs, 1_200_000);
});

test('6. USAGE_LIMIT never becomes HUMAN_REQUIRED from retry count alone', () => {
  for (const attempt of [3, 4, 10, 50, 500]) {
    const decision = decideCapacityAction({ reason: CAPACITY_REASONS.USAGE_LIMIT, attempt, now: NOW });
    assert.equal(decision.action, CAPACITY_ACTIONS.WAIT, `attempt ${attempt} must keep waiting`);
  }
});

test('7/8/9. auth, billing and model-unavailable escalate immediately', () => {
  for (const reason of [CAPACITY_REASONS.AUTH_ERROR, CAPACITY_REASONS.BILLING_ERROR, CAPACITY_REASONS.MODEL_UNAVAILABLE]) {
    const decision = decideCapacityAction({ reason, attempt: 1, now: NOW });
    assert.equal(decision.action, CAPACITY_ACTIONS.HUMAN_REQUIRED, reason);
    assert.equal(decision.nextRetryAt, null);
  }
});

test('10/11/12. UNKNOWN_TRANSIENT retries a bounded number of times, then escalates', () => {
  assert.equal(decideCapacityAction({ reason: CAPACITY_REASONS.UNKNOWN_TRANSIENT, attempt: 1, now: NOW }).action, CAPACITY_ACTIONS.WAIT);
  assert.equal(decideCapacityAction({ reason: CAPACITY_REASONS.UNKNOWN_TRANSIENT, attempt: 3, now: NOW }).action, CAPACITY_ACTIONS.WAIT);
  assert.equal(decideCapacityAction({ reason: CAPACITY_REASONS.UNKNOWN_TRANSIENT, attempt: 4, now: NOW }).action, CAPACITY_ACTIONS.HUMAN_REQUIRED);
});

test('13. UNKNOWN_FATAL escalates on the first failure', () => {
  const decision = decideCapacityAction({ reason: CAPACITY_REASONS.UNKNOWN_FATAL, attempt: 1, now: NOW });
  assert.equal(decision.action, CAPACITY_ACTIONS.HUMAN_REQUIRED);
});

test('an unknown reason is refused rather than guessed', () => {
  assert.throws(() => decideCapacityAction({ reason: 'VIBES', attempt: 1, now: NOW }), codeIs('UNKNOWN_CAPACITY_REASON'));
});

// ===========================================================================
// Runner: waiting, resuming and idempotency
// ===========================================================================

test('1/5. a limited agent parks in WAITING_FOR_CAPACITY and then succeeds', async () => {
  await withStore(async (store) => {
    await store.publishJob('developer', developerJob());
    const clock = createFakeClock(NOW);
    const events = [];

    let calls = 0;
    const run = await runWithCapacity({
      store,
      role: 'developer',
      jobId: 'job-dev-1',
      goal: '003',
      round: 2,
      resumeFrom: LOOP_STATES.DEVELOPER_RUNNING,
      clock,
      onEvent: (e) => events.push(e.type),
      invoke: async () => {
        calls += 1;
        return calls === 1 ? failure(FIXTURES.usageLimit) : success(DEV_RESULT);
      },
    });

    assert.equal(run.outcome, RUN_OUTCOMES.COMPLETED);
    assert.equal(calls, 2);
    assert.ok(events.includes('CAPACITY_WAIT'));
    assert.ok(events.includes('CAPACITY_AVAILABLE'));
    // The virtual clock advanced by the usage-limit interval, not real time.
    assert.deepEqual(clock.slept, [CAPACITY_CONFIG.usageLimitRetryMs]);

    const logged = (await store.readEvents()).map((e) => e.type);
    for (const expected of ['CAPACITY_LIMIT_REACHED', 'CAPACITY_WAIT_STARTED', 'CAPACITY_RETRY', 'CAPACITY_AVAILABLE', 'CAPACITY_WAIT_ENDED']) {
      assert.ok(logged.includes(expected), `event log must contain ${expected}`);
    }
  });
});

test('16/17/18/19. the wait record preserves resumeFrom, round, goal and baseline', async () => {
  await withStore(async (store) => {
    await store.publishJob('developer', developerJob());
    await store.writeRuntime({
      goal: '003',
      round: 2,
      migrationAcceptedBaseline: '1e874e2785d2bc78860db0eb571ea901a4395c17',
      executionBase: 'b93f631ec000a58e8bccca1c5eae109102f99b8f',
    });

    const clock = createFakeClock(NOW);
    await runWithCapacity({
      store,
      role: 'developer',
      jobId: 'job-dev-1',
      goal: '003',
      round: 2,
      resumeFrom: LOOP_STATES.DEVELOPER_RUNNING,
      clock,
      maxWaits: 1,
      invoke: async () => failure(FIXTURES.usageLimit),
    }).catch((error) => {
      assert.equal(error.code, 'CAPACITY_WAIT_LIMIT');
    });

    const runtime = await readRuntimeStrict(store);
    assert.equal(runtime.state, LOOP_STATES.WAITING_FOR_CAPACITY);
    assert.equal(runtime.resumeFrom, LOOP_STATES.DEVELOPER_RUNNING);
    assert.equal(runtime.round, 2);
    assert.equal(runtime.goal, '003');
    assert.equal(runtime.blockedAgent, 'developer');
    assert.equal(runtime.capacity.reason, 'USAGE_LIMIT');
    // The baseline is untouched by a capacity event.
    assert.equal(runtime.migrationAcceptedBaseline, '1e874e2785d2bc78860db0eb571ea901a4395c17');
  });
});

test('23. an existing result prevents a duplicate model call', async () => {
  await withStore(async (store) => {
    await store.publishJob('developer', developerJob());
    await store.publishResult('developer', 'job-dev-1', { ok: true, result: DEV_RESULT }, { attemptId: (await store.readAttemptState('developer', 'job-dev-1'))?.attemptId });

    let calls = 0;
    const run = await runWithCapacity({
      store,
      role: 'developer',
      jobId: 'job-dev-1',
      goal: '003',
      round: 2,
      resumeFrom: LOOP_STATES.DEVELOPER_RUNNING,
      clock: createFakeClock(NOW),
      invoke: async () => { calls += 1; return success(DEV_RESULT); },
    });

    assert.equal(run.outcome, RUN_OUTCOMES.ALREADY_COMPLETED);
    assert.equal(calls, 0, 'the model must not be called when a result already exists');
    assert.equal(run.result.status, 'REVIEW_REQUIRED');
  });
});

test('7. AUTH_ERROR escalates and stops retrying', async () => {
  await withStore(async (store) => {
    await store.publishJob('developer', developerJob());
    let calls = 0;

    const run = await runWithCapacity({
      store,
      role: 'developer',
      jobId: 'job-dev-1',
      goal: '003',
      round: 2,
      resumeFrom: LOOP_STATES.DEVELOPER_RUNNING,
      clock: createFakeClock(NOW),
      invoke: async () => { calls += 1; return failure(FIXTURES.authError); },
    });

    assert.equal(run.outcome, RUN_OUTCOMES.HUMAN_REQUIRED);
    assert.equal(run.reason, CAPACITY_REASONS.AUTH_ERROR);
    assert.equal(calls, 1, 'auth errors must not be retried');

    const runtime = await store.readRuntime();
    assert.equal(runtime.state, LOOP_STATES.HUMAN_REQUIRED);
    assert.equal(await store.readJobStatus('developer', 'job-dev-1'), 'FAILED');
  });
});

test('14/15/16. a harness-side model-identity failure preserves the CLI\'s valid answer as a candidate result', async () => {
  await withStore(async (store) => {
    await store.publishJob('tech_lead', developerJob({ jobId: 'job-tl-1', role: 'tech_lead' }));
    const attemptId = (await store.readAttemptState('tech_lead', 'job-tl-1'))?.attemptId;

    const decisionPayload = { role: 'tech_lead', ok: true, decision: 'CHANGES_REQUIRED' };
    const run = await runWithCapacity({
      store,
      role: 'tech_lead',
      jobId: 'job-tl-1',
      goal: '003',
      round: 2,
      resumeFrom: LOOP_STATES.REVIEWER_RUNNING,
      clock: createFakeClock(NOW),
      invoke: async () => ({
        error: { code: 'PRIMARY_MODEL_EVIDENCE_MISSING', message: 'no assistant event carried message.model' },
        structuredOutput: true,
        available: false,
        payload: null,
        // The point of the fix: a structurally-valid candidate survives a
        // model-identity failure instead of being discarded with it.
        candidatePayload: decisionPayload,
        requestedModel: 'claude-fable-5-1',
        observedModels: ['claude-fable-5-1'],
      }),
    });

    assert.equal(run.outcome, RUN_OUTCOMES.HUMAN_REQUIRED);
    assert.equal(run.reason, CAPACITY_REASONS.HARNESS_ERROR);

    // Not published as trusted: the FAILED result stands on the primary path.
    const primary = await store.readResult('tech_lead', 'job-tl-1');
    assert.equal(primary.ok, false);

    // But recoverable: the candidate sits alongside it, unpublished as truth.
    const candidate = await store.readCandidateResult('tech_lead', 'job-tl-1', attemptId);
    assert.ok(candidate, 'the candidate result must have been preserved');
    assert.deepEqual(candidate.payload, decisionPayload);
    assert.equal(candidate.modelVerificationError.code, 'PRIMARY_MODEL_EVIDENCE_MISSING');
  });
});

test('a harness failure with no candidate payload writes no candidate result', async () => {
  await withStore(async (store) => {
    await store.publishJob('developer', developerJob());
    const attemptId = (await store.readAttemptState('developer', 'job-dev-1'))?.attemptId;

    await runWithCapacity({
      store,
      role: 'developer',
      jobId: 'job-dev-1',
      goal: '003',
      round: 2,
      resumeFrom: LOOP_STATES.DEVELOPER_RUNNING,
      clock: createFakeClock(NOW),
      invoke: async () => failure({ code: 'PRIMARY_MODEL_EVIDENCE_MISSING', message: 'no evidence' }),
    });

    const candidate = await store.readCandidateResult('developer', 'job-dev-1', attemptId);
    assert.equal(candidate, null);
  });
});

test('12. UNKNOWN_TRANSIENT gives up after the configured retries', async () => {
  await withStore(async (store) => {
    await store.publishJob('developer', developerJob());
    let calls = 0;

    const run = await runWithCapacity({
      store,
      role: 'developer',
      jobId: 'job-dev-1',
      goal: '003',
      round: 2,
      resumeFrom: LOOP_STATES.DEVELOPER_RUNNING,
      clock: createFakeClock(NOW),
      invoke: async () => { calls += 1; return failure(FIXTURES.transient); },
    });

    assert.equal(run.outcome, RUN_OUTCOMES.HUMAN_REQUIRED);
    assert.equal(calls, CAPACITY_CONFIG.unknownTransientMaxRetries + 1);
  });
});

test('14/15. limits are per agent: one blocked agent does not block the other', async () => {
  await withStore(async (store) => {
    await store.publishJob('developer', developerJob());
    await store.publishJob('tech_lead', {
      ...developerJob({ jobId: 'job-rev-1', role: 'tech_lead' }),
    });

    // The Developer finished round 2; only the review is blocked.
    await store.publishResult('developer', 'job-dev-1', { ok: true, result: DEV_RESULT }, { attemptId: (await store.readAttemptState('developer', 'job-dev-1'))?.attemptId });

    const clock = createFakeClock(NOW);
    await runWithCapacity({
      store,
      role: 'tech_lead',
      jobId: 'job-rev-1',
      goal: '003',
      round: 2,
      resumeFrom: LOOP_STATES.REVIEWER_RUNNING,
      clock,
      maxWaits: 1,
      invoke: async () => failure(FIXTURES.usageLimit),
    }).catch(() => {});

    const runtime = await readRuntimeStrict(store);
    assert.equal(runtime.blockedAgent, 'tech_lead');
    assert.equal(runtime.resumeFrom, LOOP_STATES.REVIEWER_RUNNING);

    // The Developer's completed work is intact and would not be redone.
    assert.equal(await store.hasCompletedResult('developer', 'job-dev-1'), true);

    let developerCalls = 0;
    const rerun = await runWithCapacity({
      store,
      role: 'developer',
      jobId: 'job-dev-1',
      goal: '003',
      round: 2,
      resumeFrom: LOOP_STATES.DEVELOPER_RUNNING,
      clock,
      invoke: async () => { developerCalls += 1; return success(DEV_RESULT); },
    });
    assert.equal(rerun.outcome, RUN_OUTCOMES.ALREADY_COMPLETED);
    assert.equal(developerCalls, 0, 'a blocked Tech Lead must not cause the Developer to re-run');
  });
});

// ===========================================================================
// Persistence across restart
// ===========================================================================

test('20. nextRetryAt survives a restart and is honoured', async () => {
  await withStore(async (store) => {
    await store.publishJob('developer', developerJob());
    await store.writeRuntime({ goal: '003', round: 2 });

    const decision = decideCapacityAction({ reason: CAPACITY_REASONS.USAGE_LIMIT, attempt: 1, now: NOW });
    await persistCapacityWait(store, {
      goal: '003', round: 2, blockedAgent: 'developer',
      resumeFrom: LOOP_STATES.DEVELOPER_RUNNING, jobId: 'job-dev-1', decision, now: NOW,
    });

    // A brand-new store handle stands in for a restarted process.
    const reopened = createJobStore(store.paths.root);
    const runtime = await readRuntimeStrict(reopened);

    assert.equal(runtime.capacity.nextRetryAt, decision.nextRetryAt);
    assert.equal(remainingWaitMs(runtime, NOW), 1_200_000);
    assert.equal(remainingWaitMs(runtime, NOW + 1_200_000), 0);
  });
});

test('a restarted worker sleeps only the time still remaining', async () => {
  await withStore(async (store) => {
    await store.publishJob('developer', developerJob());
    const decision = decideCapacityAction({ reason: CAPACITY_REASONS.USAGE_LIMIT, attempt: 1, now: NOW });
    await persistCapacityWait(store, {
      goal: '003', round: 2, blockedAgent: 'developer',
      resumeFrom: LOOP_STATES.DEVELOPER_RUNNING, jobId: 'job-dev-1', decision, now: NOW,
    });

    // Simulate the machine being off for 15 of the 20 minutes.
    const clock = createFakeClock(NOW + 900_000);
    const run = await runWithCapacity({
      store,
      role: 'developer',
      jobId: 'job-dev-1',
      goal: '003',
      round: 2,
      resumeFrom: LOOP_STATES.DEVELOPER_RUNNING,
      clock,
      invoke: async () => success(DEV_RESULT),
    });

    assert.equal(run.outcome, RUN_OUTCOMES.COMPLETED);
    assert.deepEqual(clock.slept, [300_000], 'only the remaining 5 minutes should be waited');
  });
});

test('27. a corrupt capacity state fails closed', async () => {
  await withStore(async (store, dir) => {
    await writeFile(join(dir, 'runtime.json'), JSON.stringify({
      state: LOOP_STATES.WAITING_FOR_CAPACITY,
      goal: '003',
      round: 2,
      blockedAgent: 'developer',
      resumeFrom: LOOP_STATES.DEVELOPER_RUNNING,
      capacity: { reason: 'NONSENSE', attempt: 1, firstSeenAt: 'x', lastAttemptAt: 'x', nextRetryAt: 'x', retryIntervalMs: 1 },
    }), 'utf8');

    await assert.rejects(readRuntimeStrict(store), codeIs('CAPACITY_STATE_CORRUPT'));

    // And a truly unparseable file is refused too, never zeroed.
    await writeFile(join(dir, 'runtime.json'), '{ broken', 'utf8');
    await assert.rejects(readRuntimeStrict(store), codeIs('FILE_CORRUPT'));
    assert.equal(await readJson(join(dir, 'runtime.json')).catch((e) => e.code), 'FILE_CORRUPT');
  });
});

test('validateWaitingRuntime rejects a non-resumable resumeFrom', () => {
  assert.throws(() => validateWaitingRuntime({
    goal: '003', round: 1, blockedAgent: 'developer', resumeFrom: LOOP_STATES.ACCEPTED,
    capacity: { reason: 'USAGE_LIMIT', attempt: 1, firstSeenAt: new Date(NOW).toISOString(), lastAttemptAt: new Date(NOW).toISOString(), nextRetryAt: new Date(NOW).toISOString(), retryIntervalMs: 1 },
  }), codeIs('CAPACITY_STATE_CORRUPT'));
});

// ===========================================================================
// Heartbeat, resume command and state machine
// ===========================================================================

test('24. a worker waiting for capacity keeps heartbeating and stays healthy', async () => {
  await withStore(async (store) => {
    await writeHeartbeat(store, 'tech_lead', {
      state: 'WAITING_FOR_CAPACITY',
      model: 'claude-fable-5-1',
      sessionStrategy: 'PERSISTENT',
      capacityReason: 'USAGE_LIMIT',
      nextRetryAt: new Date(NOW + 1_200_000).toISOString(),
    });

    const health = await readWorkerHealth(store, 'tech_lead');
    assert.equal(health.health, WORKER_HEALTH.RUNNING, 'waiting must not read as STALE/OFFLINE');
    assert.equal(health.state, 'WAITING_FOR_CAPACITY');
    assert.equal(health.capacityReason, 'USAGE_LIMIT');
  });
});

test('21. resume before nextRetryAt calls no model', () => {
  const runtime = {
    state: LOOP_STATES.WAITING_FOR_CAPACITY,
    goal: '003', round: 2, blockedAgent: 'tech_lead',
    resumeFrom: LOOP_STATES.REVIEWER_RUNNING, blockedJobId: 'job-rev-1',
    capacity: {
      reason: 'USAGE_LIMIT', attempt: 2,
      firstSeenAt: new Date(NOW).toISOString(),
      lastAttemptAt: new Date(NOW).toISOString(),
      nextRetryAt: new Date(NOW + 600_000).toISOString(),
      retryIntervalMs: 1_200_000,
    },
  };

  const plan = planResume(runtime, { now: NOW });
  assert.equal(plan.action, 'WAIT');
  assert.equal(plan.remainingMs, 600_000);
});

test('22. resume after nextRetryAt allows a new attempt', () => {
  const runtime = {
    state: LOOP_STATES.WAITING_FOR_CAPACITY,
    goal: '003', round: 2, blockedAgent: 'tech_lead',
    resumeFrom: LOOP_STATES.REVIEWER_RUNNING, blockedJobId: 'job-rev-1',
    capacity: {
      reason: 'USAGE_LIMIT', attempt: 2,
      firstSeenAt: new Date(NOW).toISOString(),
      lastAttemptAt: new Date(NOW).toISOString(),
      nextRetryAt: new Date(NOW).toISOString(),
      retryIntervalMs: 1_200_000,
    },
  };

  const plan = planResume(runtime, { now: NOW + 1 });
  assert.equal(plan.action, 'RESUME');
  assert.equal(plan.resumeFrom, LOOP_STATES.REVIEWER_RUNNING);
  assert.equal(plan.jobId, 'job-rev-1');
});

test('25. resume never overrides HUMAN_REQUIRED', () => {
  const plan = planResume(
    { state: LOOP_STATES.HUMAN_REQUIRED, humanRequired: { reason: 'AUTH_ERROR' } },
    { now: NOW },
  );
  assert.equal(plan.action, 'BLOCKED_BY_HUMAN');
  assert.match(plan.message, /AUTH_ERROR/);
});

test('resume with nothing parked exits cleanly', () => {
  assert.equal(planResume(null, { now: NOW }).action, 'NOTHING_TO_RESUME');
  assert.equal(planResume({ state: LOOP_STATES.IDLE }, { now: NOW }).action, 'NOTHING_TO_RESUME');
});

test('the state machine parks and resumes at the exact blocked step', () => {
  const machine = createLoopStateMachine();
  machine.transitionTo(LOOP_STATES.GOAL_READY);
  machine.transitionTo(LOOP_STATES.PREPARING_WORKTREE);
  machine.transitionTo(LOOP_STATES.WORKTREE_READY);
  machine.transitionTo(LOOP_STATES.DEVELOPER_QUEUED);
  machine.transitionTo(LOOP_STATES.DEVELOPER_RUNNING);
  machine.transitionTo(LOOP_STATES.REVIEW_REQUIRED);
  machine.transitionTo(LOOP_STATES.REVIEWER_QUEUED);
  machine.transitionTo(LOOP_STATES.REVIEWER_RUNNING);

  machine.transitionTo(LOOP_STATES.WAITING_FOR_CAPACITY);
  // Resuming goes back to the review, never back to the Developer's work.
  assert.equal(machine.canTransitionTo(LOOP_STATES.REVIEWER_RUNNING), true);
  machine.transitionTo(LOOP_STATES.REVIEWER_RUNNING);
  machine.transitionTo(LOOP_STATES.ACCEPTED);
  machine.transitionTo(LOOP_STATES.AWAITING_HUMAN);

  assert.equal(machine.state, LOOP_STATES.AWAITING_HUMAN);
});

test('formatRemaining renders a human-readable countdown', () => {
  assert.equal(formatRemaining(763_000), '12m 43s');
  assert.equal(formatRemaining(45_000), '45s');
  assert.equal(formatRemaining(0), 'now');
});
