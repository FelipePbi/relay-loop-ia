/**
 * Local integration harness for capacity handling.
 *
 * Exercises the full path Developer → Reviewer with a fake agent and a virtual
 * clock. No Claude process is spawned, no quota is consumed, and no real time
 * passes despite the 20-minute usage-limit wait being exercised end to end.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJobStore } from '../lib/job-store.mjs';
import { createFakeClock } from '../lib/clock.mjs';
import { CAPACITY_CONFIG } from '../lib/capacity-config.mjs';
import { RUN_OUTCOMES, runWithCapacity } from '../lib/capacity-runner.mjs';
import { LOOP_STATES, createLoopStateMachine, stateForDecision } from '../lib/loop-state.mjs';
import { readRuntimeStrict } from '../lib/capacity-state.mjs';
import { PROTOCOL_VERSION_V2 } from '../lib/contracts-v2.mjs';

const NOW = Date.parse('2026-09-07T02:31:14.000Z');
const BASELINE = '1e874e2785d2bc78860db0eb571ea901a4395c17';
const EXEC_BASE = 'b93f631ec000a58e8bccca1c5eae109102f99b8f';

/**
 * Fake agent: a scripted queue of outcomes per role, so any sequence of
 * limits and successes can be replayed deterministically.
 */
function createFakeAgent(script) {
  const calls = { developer: 0, tech_lead: 0 };
  return {
    calls,
    invokeFor(role) {
      return async () => {
        calls[role] += 1;
        const next = script[role].shift();
        if (!next) throw new Error(`fake agent for ${role} ran out of scripted outcomes`);
        return next;
      };
    },
  };
}

const limitedBy = (message) => ({ error: { code: 'NON_ZERO_EXIT', message }, structuredOutput: false, payload: null });
const answered = (payload) => ({ error: null, structuredOutput: true, available: true, payload, resolvedPrimaryModel: 'fake' });

const DEV_RESULT = {
  protocolVersion: PROTOCOL_VERSION_V2,
  jobId: 'dev-r2',
  goal: '003',
  round: 2,
  status: 'REVIEW_REQUIRED',
  summary: 'implementado',
  implementationReport: 'relatório da rodada 2',
  validations: [{ name: 'test:gate', passed: true }],
};

const REVIEW_DECISION = {
  protocolVersion: PROTOCOL_VERSION_V2,
  jobId: 'rev-r2',
  goal: '003',
  round: 2,
  decision: 'ACCEPTED',
  blockers: [],
  nextAction: 'STOP',
};

function job(role, jobId) {
  return {
    protocolVersion: PROTOCOL_VERSION_V2,
    jobId,
    role,
    goal: '003',
    round: 2,
    migrationAcceptedBaseline: BASELINE,
    executionBase: EXEC_BASE,
    worktree: '.ai-worktrees/goal-003',
    goalPath: 'docs/migration/goals/003-x.md',
  };
}

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-integration-'));
  try {
    return await run(createJobStore(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test('integration: Developer succeeds, Reviewer hits USAGE_LIMIT, waits, then ACCEPTS', async () => {
  await withStore(async (store) => {
    const clock = createFakeClock(NOW);
    const machine = createLoopStateMachine();
    const agent = createFakeAgent({
      developer: [answered(DEV_RESULT)],
      // First review attempt is limited; the second one succeeds.
      tech_lead: [limitedBy('Usage limit reached. Your 5-hour limit will reset later.'), answered(REVIEW_DECISION)],
    });

    await store.publishJob('developer', job('developer', 'dev-r2'));
    await store.publishJob('tech_lead', job('tech_lead', 'rev-r2'));
    await store.writeRuntime({ goal: '003', round: 2, migrationAcceptedBaseline: BASELINE, executionBase: EXEC_BASE });

    // --- Developer round 2 -------------------------------------------------
    machine.transitionTo(LOOP_STATES.GOAL_READY);
    machine.transitionTo(LOOP_STATES.PREPARING_WORKTREE);
    machine.transitionTo(LOOP_STATES.WORKTREE_READY);
    machine.transitionTo(LOOP_STATES.DEVELOPER_QUEUED);
    machine.transitionTo(LOOP_STATES.DEVELOPER_RUNNING);

    const devRun = await runWithCapacity({
      store,
      role: 'developer',
      jobId: 'dev-r2',
      goal: '003',
      round: 2,
      resumeFrom: LOOP_STATES.DEVELOPER_RUNNING,
      clock,
      invoke: agent.invokeFor('developer'),
    });

    assert.equal(devRun.outcome, RUN_OUTCOMES.COMPLETED);
    assert.equal(agent.calls.developer, 1);
    machine.transitionTo(LOOP_STATES.REVIEW_REQUIRED);

    // --- Reviewer round 2, blocked then resumed ----------------------------
    machine.transitionTo(LOOP_STATES.REVIEWER_QUEUED);
    machine.transitionTo(LOOP_STATES.REVIEWER_RUNNING);

    const waitStates = [];
    const revRun = await runWithCapacity({
      store,
      role: 'tech_lead',
      jobId: 'rev-r2',
      goal: '003',
      round: 2,
      resumeFrom: LOOP_STATES.REVIEWER_RUNNING,
      clock,
      onEvent: async (event) => {
        if (event.type === 'CAPACITY_WAIT') {
          // Observed mid-flight: the run is parked, not failed.
          waitStates.push(event.reason);
        }
      },
      invoke: agent.invokeFor('tech_lead'),
    });

    assert.equal(revRun.outcome, RUN_OUTCOMES.COMPLETED);
    assert.deepEqual(waitStates, ['USAGE_LIMIT']);
    assert.equal(agent.calls.tech_lead, 2, 'the reviewer retried exactly once');

    // The Developer was never called again for work it had already finished.
    assert.equal(agent.calls.developer, 1, 'a blocked review must not re-run the Developer');

    // The wait cost 20 virtual minutes and no real time.
    assert.deepEqual(clock.slept, [CAPACITY_CONFIG.usageLimitRetryMs]);

    // --- Verdict -----------------------------------------------------------
    machine.transitionTo(stateForDecision(revRun.result.decision));
    machine.transitionTo(LOOP_STATES.AWAITING_HUMAN);

    assert.equal(machine.state, LOOP_STATES.AWAITING_HUMAN);
    assert.deepEqual(
      machine.history.map((t) => t.to),
      [
        'GOAL_READY', 'PREPARING_WORKTREE', 'WORKTREE_READY',
        'DEVELOPER_QUEUED', 'DEVELOPER_RUNNING', 'REVIEW_REQUIRED',
        'REVIEWER_QUEUED', 'REVIEWER_RUNNING', 'ACCEPTED', 'AWAITING_HUMAN',
      ],
    );

    // --- Final state -------------------------------------------------------
    const runtime = await readRuntimeStrict(store);
    assert.equal(runtime.capacity, null, 'the capacity block is cleared once through');
    assert.equal(runtime.migrationAcceptedBaseline, BASELINE, 'the baseline is never touched by a capacity event');
    assert.equal(runtime.goal, '003');
    assert.equal(runtime.round, 2);

    assert.equal(await store.readJobStatus('developer', 'dev-r2'), 'COMPLETED');
    assert.equal(await store.readJobStatus('tech_lead', 'rev-r2'), 'COMPLETED');

    const logged = (await store.readEvents()).map((e) => e.type);
    assert.ok(logged.includes('CAPACITY_LIMIT_REACHED'));
    assert.ok(logged.includes('CAPACITY_WAIT_STARTED'));
    assert.ok(logged.includes('CAPACITY_AVAILABLE'));
    assert.ok(logged.includes('CAPACITY_WAIT_ENDED'));
    assert.ok(!logged.includes('HUMAN_REQUIRED'), 'a temporary limit must not escalate');
  });
});

test('integration: an auth error mid-review escalates without burning retries', async () => {
  await withStore(async (store) => {
    const clock = createFakeClock(NOW);
    const agent = createFakeAgent({
      developer: [],
      tech_lead: [limitedBy('Not logged in · Please run /login')],
    });

    await store.publishJob('tech_lead', job('tech_lead', 'rev-r2'));
    await store.writeRuntime({ goal: '003', round: 2, migrationAcceptedBaseline: BASELINE });

    const run = await runWithCapacity({
      store,
      role: 'tech_lead',
      jobId: 'rev-r2',
      goal: '003',
      round: 2,
      resumeFrom: LOOP_STATES.REVIEWER_RUNNING,
      clock,
      invoke: agent.invokeFor('tech_lead'),
    });

    assert.equal(run.outcome, RUN_OUTCOMES.HUMAN_REQUIRED);
    assert.equal(run.reason, 'AUTH_ERROR');
    assert.equal(agent.calls.tech_lead, 1);
    assert.deepEqual(clock.slept, [], 'no waiting for an error a human must fix');

    const runtime = await readRuntimeStrict(store);
    assert.equal(runtime.state, LOOP_STATES.HUMAN_REQUIRED);
    // The Goal itself survives the escalation.
    assert.equal(runtime.goal, '003');
    assert.equal(runtime.migrationAcceptedBaseline, BASELINE);
  });
});

test('integration: a rate limit backs off progressively before succeeding', async () => {
  await withStore(async (store) => {
    const clock = createFakeClock(NOW);
    const agent = createFakeAgent({
      developer: [
        limitedBy('API Error: 429 rate_limit_error'),
        limitedBy('API Error: 429 rate_limit_error'),
        answered(DEV_RESULT),
      ],
      tech_lead: [],
    });

    await store.publishJob('developer', job('developer', 'dev-r2'));

    const run = await runWithCapacity({
      store,
      role: 'developer',
      jobId: 'dev-r2',
      goal: '003',
      round: 2,
      resumeFrom: LOOP_STATES.DEVELOPER_RUNNING,
      clock,
      invoke: agent.invokeFor('developer'),
    });

    assert.equal(run.outcome, RUN_OUTCOMES.COMPLETED);
    assert.equal(agent.calls.developer, 3);
    assert.deepEqual(clock.slept, [30_000, 60_000], 'progressive backoff, in order');
  });
});
