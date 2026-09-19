/**
 * Adaptive routing, against a real job store.
 *
 * The properties here are the ones that make a model change safe rather than
 * merely possible: the predecessor attempt keeps its identity and its answer,
 * the successor is a real attempt on the routed model, the same Goal, round,
 * stage, job and worktree carry through, and running the whole thing twice
 * does not manufacture a third attempt.
 *
 * No model is called. `invoke` is a fake that returns invokeAgent-shaped
 * outcomes, so every branch is exercised for zero tokens.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJobStore, readJson } from '../lib/job-store.mjs';
import { createFakeClock } from '../lib/clock.mjs';
import { RUN_OUTCOMES, runWithCapacity } from '../lib/capacity-runner.mjs';
import { createAttemptRouter } from '../lib/routing-runtime.mjs';
import { LOOP_STATES } from '../lib/loop-state.mjs';
import { PROTOCOL_VERSION_V2 } from '../lib/contracts-v2.mjs';
import {
  COMPLEXITY,
  ROUTING_STAGES,
  routeDeveloper,
  authorizeReviewEscalation,
  routeTechLead,
  toJobRouting,
} from '../lib/model-routing.mjs';

/**
 * A review job already running on the specialist. Routing never selects Fable
 * on its own any more, so the only way to be on it is to have escalated there.
 */
const escalatedToFable = (assessment) => authorizeReviewEscalation({
  request: { reason: 'ARCHITECTURAL_RISK_DISCOVERED', evidence: ['the Opus round could not settle the question'] },
  current: routeTechLead({ stage: ROUTING_STAGES.REVIEW, assessment }),
}).decision;
import { renderRoutingSummary, summarizeRouting } from '../lib/routing-summary.mjs';

const NOW = Date.parse('2026-09-09T10:00:00.000Z');
const GOAL = '007';
const DEV_JOB = '007-r1-developer-aaaa1111';
const REV_JOB = '007-r1-tech_lead-bbbb2222';
const WORKTREE = '.ai-worktrees/goal-007';

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-routing-'));
  try {
    return await run(createJobStore(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

const devJob = (routing) => ({
  protocolVersion: PROTOCOL_VERSION_V2,
  jobId: DEV_JOB, role: 'developer', goal: GOAL, round: 1, type: 'IMPLEMENTATION',
  worktree: WORKTREE, routing,
});

const revJob = (routing) => ({
  protocolVersion: PROTOCOL_VERSION_V2,
  jobId: REV_JOB, role: 'tech_lead', goal: GOAL, round: 1, reviewLevel: 'DEEP',
  worktree: WORKTREE, routing,
});

/** An invokeAgent-shaped success. */
const ok = (payload) => ({ error: null, structuredOutput: true, available: true, payload });
/** An invokeAgent-shaped failure. */
const fail = (code, message) => ({ error: { code, message }, structuredOutput: false, payload: null });

const DEV_DONE = Object.freeze({
  protocolVersion: PROTOCOL_VERSION_V2, jobId: DEV_JOB, goal: GOAL, round: 1,
  status: 'REVIEW_REQUIRED', summary: 'feito', implementationReport: 'relatório', validations: [],
});

const DEV_ESCALATES = Object.freeze({
  ...DEV_DONE,
  status: 'ESCALATION_REQUIRED',
  escalation: {
    reason: 'REPEATED_EXECUTION_FAILURE',
    confidence: 'LOW',
    evidence: [
      'the same integration assertion failed after three distinct fixes',
      'the failure moves between modules instead of narrowing',
    ],
  },
});

const REVIEW_ACCEPTED = Object.freeze({
  protocolVersion: PROTOCOL_VERSION_V2, jobId: REV_JOB, goal: GOAL, round: 1,
  decision: 'ACCEPTED', blockers: [], nextAction: 'STOP',
});

const REVIEW_INCONCLUSIVE = Object.freeze({
  protocolVersion: PROTOCOL_VERSION_V2, jobId: REV_JOB, goal: GOAL, round: 1,
  decision: 'HUMAN_REQUIRED', blockers: [], nextAction: 'HUMAN_REQUIRED',
  escalationRequest: {
    reason: 'ARCHITECTURAL_RISK_DISCOVERED',
    confidence: 'LOW',
    evidence: ['the lease renewal path has no fencing token and I cannot rule out a lost update'],
  },
});

/** Reads the attempt history a job accumulated. */
async function historyOf(store, role, jobId) {
  const envelope = await readJson(store.paths.job(role, jobId));
  return envelope?.attemptHistory ?? [];
}

// ===========================================================================
// 27. Developer escalation
// ===========================================================================

test('27. Sonnet asks for help with evidence, and Opus finishes the SAME job', async () => {
  await withStore(async (store) => {
    const base = toJobRouting(routeDeveloper({}));
    await store.publishJob('developer', devJob(base));

    const router = createAttemptRouter({
      store, role: 'developer', jobId: DEV_JOB, base, kind: 'developer', goal: GOAL, round: 1,
    });

    const modelsUsed = [];
    const run = await runWithCapacity({
      store, role: 'developer', jobId: DEV_JOB, goal: GOAL, round: 1,
      resumeFrom: LOOP_STATES.DEVELOPER_RUNNING,
      clock: createFakeClock(NOW),
      router,
      invoke: async ({ attempt }) => {
        const { routing } = await router.current();
        modelsUsed.push(routing.modelKey);
        return attempt === 1 ? ok(DEV_ESCALATES) : ok(DEV_DONE);
      },
    });

    assert.equal(run.outcome, RUN_OUTCOMES.COMPLETED);
    assert.deepEqual(modelsUsed, ['sonnet', 'opus'], 'a1 on Sonnet, a2 on Opus');
    assert.equal(run.attempts, 2, 'exactly two attempts, not three');

    // --- The history is intact, and honest --------------------------------
    const history = await historyOf(store, 'developer', DEV_JOB);
    assert.equal(history.length, 1);
    assert.equal(history[0].attemptId, `${DEV_JOB}-a1`);
    assert.equal(history[0].status, 'REROUTED', 'a1 was rerouted, not interrupted and not failed');
    assert.equal(history[0].reason, 'MODEL_ESCALATION');
    assert.equal(history[0].routedTo.modelKey, 'opus');
    assert.equal(history[0].escalationReason, 'REPEATED_EXECUTION_FAILURE');

    // --- a1's own answer survives -----------------------------------------
    const candidate = await store.readCandidateResult('developer', DEV_JOB, `${DEV_JOB}-a1`);
    assert.equal(candidate.payload.status, 'ESCALATION_REQUIRED');
    assert.deepEqual(candidate.payload.escalation.evidence, DEV_ESCALATES.escalation.evidence);

    // --- Same job, same stage, same worktree -------------------------------
    const envelope = await readJson(store.paths.job('developer', DEV_JOB));
    assert.equal(envelope.job.jobId, DEV_JOB);
    assert.equal(envelope.job.goal, GOAL);
    assert.equal(envelope.job.round, 1);
    assert.equal(envelope.job.worktree, WORKTREE);
    assert.equal(envelope.currentAttemptId, `${DEV_JOB}-a2`);
    assert.equal(envelope.status, 'COMPLETED');

    // --- And the published result is a2's, on the escalated model ----------
    const result = await store.readResult('developer', DEV_JOB);
    assert.equal(result.result.status, 'REVIEW_REQUIRED');
    assert.equal(result.attemptId, `${DEV_JOB}-a2`);

    const events = await store.readEvents();
    const escalated = events.find((e) => e.type === 'MODEL_ESCALATED');
    assert.equal(escalated.from, 'sonnet');
    assert.equal(escalated.to, 'opus');
    assert.equal(escalated.attemptId, `${DEV_JOB}-a1`);
    assert.ok(escalated.evidence.length > 0, 'the grounds are on the record');
  });
});

test('34. an escalation with no evidence is refused, and the round continues on Sonnet', async () => {
  await withStore(async (store) => {
    const base = toJobRouting(routeDeveloper({}));
    await store.publishJob('developer', devJob(base));
    const router = createAttemptRouter({
      store, role: 'developer', jobId: DEV_JOB, base, kind: 'developer', goal: GOAL, round: 1,
    });

    const modelsUsed = [];
    const run = await runWithCapacity({
      store, role: 'developer', jobId: DEV_JOB, goal: GOAL, round: 1,
      resumeFrom: LOOP_STATES.DEVELOPER_RUNNING,
      clock: createFakeClock(NOW),
      router,
      invoke: async () => {
        const { routing } = await router.current();
        modelsUsed.push(routing.modelKey);
        // The contract requires evidence, so this shape can only reach the
        // router by bypassing validation — which is exactly what the router
        // must survive without granting anything.
        return ok({ ...DEV_DONE, status: 'ESCALATION_REQUIRED', escalation: { reason: 'LOW_CONFIDENCE', evidence: [] } });
      },
    });

    assert.deepEqual(modelsUsed, ['sonnet'], 'no successor attempt was created');
    assert.equal(run.outcome, RUN_OUTCOMES.COMPLETED, 'the answer stands as the stage result');
    assert.equal(run.result.status, 'ESCALATION_REQUIRED');

    const events = await store.readEvents();
    assert.ok(events.some((e) => e.type === 'MODEL_ESCALATION_REFUSED'), 'the refusal is auditable');
    assert.ok(!events.some((e) => e.type === 'MODEL_ESCALATED'));
  });
});

// ===========================================================================
// 28. Developer capacity fallback
// ===========================================================================

test('28. a Sonnet usage limit falls back to Opus, recorded as CAPACITY and not as escalation', async () => {
  await withStore(async (store) => {
    const base = toJobRouting(routeDeveloper({}));
    await store.publishJob('developer', devJob(base));
    const router = createAttemptRouter({
      store, role: 'developer', jobId: DEV_JOB, base, kind: 'developer', goal: GOAL, round: 1,
    });

    const modelsUsed = [];
    const run = await runWithCapacity({
      store, role: 'developer', jobId: DEV_JOB, goal: GOAL, round: 1,
      resumeFrom: LOOP_STATES.DEVELOPER_RUNNING,
      clock: createFakeClock(NOW),
      router,
      invoke: async ({ attempt }) => {
        const { routing } = await router.current();
        modelsUsed.push(routing.modelKey);
        return attempt === 1
          ? fail('NON_ZERO_EXIT', "You've hit your session limit · resets 3:10am")
          : ok(DEV_DONE);
      },
    });

    assert.equal(run.outcome, RUN_OUTCOMES.COMPLETED);
    assert.deepEqual(modelsUsed, ['sonnet', 'opus']);

    const history = await historyOf(store, 'developer', DEV_JOB);
    assert.equal(history[0].reason, 'MODEL_FALLBACK', 'capacity, not capability');
    assert.equal(history[0].classification, 'USAGE_LIMIT');
    assert.equal(history[0].routedTo.modelKey, 'opus');

    const events = await store.readEvents();
    assert.ok(events.some((e) => e.type === 'MODEL_FALLBACK' && e.reason === 'USAGE_LIMIT'));
    assert.ok(!events.some((e) => e.type === 'MODEL_ESCALATED'), 'a quota is never an escalation');
    // And the pipeline never parked: no capacity wait was persisted.
    assert.ok(!events.some((e) => e.type === 'CAPACITY_WAIT_STARTED'));
  });
});

// ===========================================================================
// 26. A harness failure is never routed around
// ===========================================================================

test('26. a harness failure on Fable stops for a human instead of falling back', async () => {
  await withStore(async (store) => {
    const base = toJobRouting(escalatedToFable({
      classification: COMPLEXITY.CRITICAL, riskScore: 8, signals: ['MIGRATION'],
    }));
    await store.publishJob('tech_lead', revJob(base));
    const router = createAttemptRouter({
      store, role: 'tech_lead', jobId: REV_JOB, base, kind: 'review', goal: GOAL, round: 1,
    });

    const modelsUsed = [];
    const run = await runWithCapacity({
      store, role: 'tech_lead', jobId: REV_JOB, goal: GOAL, round: 1,
      resumeFrom: LOOP_STATES.REVIEWER_RUNNING,
      clock: createFakeClock(NOW),
      router,
      invoke: async () => {
        const { routing } = await router.current();
        modelsUsed.push(routing.modelKey);
        return fail('INVALID_CLAUDE_CLI_ARGS', 'When using --print, --output-format=stream-json requires --verbose');
      },
    });

    assert.equal(run.outcome, RUN_OUTCOMES.HUMAN_REQUIRED);
    assert.equal(run.reason, 'HARNESS_ERROR');
    assert.deepEqual(modelsUsed, ['fable'], 'a harness bug must be fixed, not routed around');

    const events = await store.readEvents();
    assert.ok(!events.some((e) => e.type === 'MODEL_FALLBACK'));
  });
});

// ===========================================================================
// 20/29. Review: fallback down, escalation up
// ===========================================================================

test('20. a Fable usage limit falls back to Opus rather than parking the pipeline for days', async () => {
  await withStore(async (store) => {
    const base = toJobRouting(escalatedToFable({
      classification: COMPLEXITY.HIGH, riskScore: 5, signals: ['MIGRATION'],
    }));
    await store.publishJob('tech_lead', revJob(base));
    const router = createAttemptRouter({
      store, role: 'tech_lead', jobId: REV_JOB, base, kind: 'review', goal: GOAL, round: 1,
    });

    const modelsUsed = [];
    const run = await runWithCapacity({
      store, role: 'tech_lead', jobId: REV_JOB, goal: GOAL, round: 1,
      resumeFrom: LOOP_STATES.REVIEWER_RUNNING,
      clock: createFakeClock(NOW),
      router,
      invoke: async ({ attempt }) => {
        const { routing } = await router.current();
        modelsUsed.push(routing.modelKey);
        return attempt === 1
          ? fail('NON_ZERO_EXIT', 'Usage limit reached. Your weekly limit will reset later.')
          : ok(REVIEW_ACCEPTED);
      },
    });

    assert.equal(run.outcome, RUN_OUTCOMES.COMPLETED);
    assert.deepEqual(modelsUsed, ['fable', 'opus']);
    assert.equal(run.result.decision, 'ACCEPTED');
  });
});

test('29. an inconclusive Opus review escalates to Fable on the same review job', async () => {
  await withStore(async (store) => {
    const base = toJobRouting(routeTechLead({
      stage: ROUTING_STAGES.REVIEW,
      assessment: { classification: COMPLEXITY.MEDIUM, riskScore: 3, signals: [] },
    }));
    await store.publishJob('tech_lead', revJob(base));
    const router = createAttemptRouter({
      store, role: 'tech_lead', jobId: REV_JOB, base, kind: 'review', goal: GOAL, round: 1,
    });

    const modelsUsed = [];
    const run = await runWithCapacity({
      store, role: 'tech_lead', jobId: REV_JOB, goal: GOAL, round: 1,
      resumeFrom: LOOP_STATES.REVIEWER_RUNNING,
      clock: createFakeClock(NOW),
      router,
      invoke: async ({ attempt }) => {
        const { routing } = await router.current();
        modelsUsed.push(routing.modelKey);
        return attempt === 1 ? ok(REVIEW_INCONCLUSIVE) : ok(REVIEW_ACCEPTED);
      },
    });

    assert.equal(run.outcome, RUN_OUTCOMES.COMPLETED);
    assert.deepEqual(modelsUsed, ['opus', 'fable']);
    assert.equal(run.result.decision, 'ACCEPTED');

    // The first review is not erased: it is preserved, with its own reasoning.
    const candidate = await store.readCandidateResult('tech_lead', REV_JOB, `${REV_JOB}-a1`);
    assert.equal(candidate.payload.decision, 'HUMAN_REQUIRED');
    assert.equal(candidate.payload.escalationRequest.reason, 'ARCHITECTURAL_RISK_DISCOVERED');

    const history = await historyOf(store, 'tech_lead', REV_JOB);
    assert.equal(history[0].reason, 'MODEL_ESCALATION');
    assert.equal(history[0].routedTo.modelKey, 'fable');

    // Same review job, same round, same packet surface.
    const envelope = await readJson(store.paths.job('tech_lead', REV_JOB));
    assert.equal(envelope.job.jobId, REV_JOB);
    assert.equal(envelope.job.round, 1);
    assert.equal(envelope.job.worktree, WORKTREE);
  });
});

// ===========================================================================
// 30/31. Idempotency and restart
// ===========================================================================

test('30. a second run after an escalation reuses the result and creates no third attempt', async () => {
  await withStore(async (store) => {
    const base = toJobRouting(routeDeveloper({}));
    await store.publishJob('developer', devJob(base));
    const makeRouter = () => createAttemptRouter({
      store, role: 'developer', jobId: DEV_JOB, base, kind: 'developer', goal: GOAL, round: 1,
    });

    const first = makeRouter();
    await runWithCapacity({
      store, role: 'developer', jobId: DEV_JOB, goal: GOAL, round: 1,
      resumeFrom: LOOP_STATES.DEVELOPER_RUNNING, clock: createFakeClock(NOW), router: first,
      invoke: async ({ attempt }) => (attempt === 1 ? ok(DEV_ESCALATES) : ok(DEV_DONE)),
    });

    // A restart of the whole step, exactly as a recovery would run it.
    let calls = 0;
    const again = await runWithCapacity({
      store, role: 'developer', jobId: DEV_JOB, goal: GOAL, round: 1,
      resumeFrom: LOOP_STATES.DEVELOPER_RUNNING, clock: createFakeClock(NOW), router: makeRouter(),
      invoke: async () => { calls += 1; return ok(DEV_DONE); },
    });

    assert.equal(again.outcome, RUN_OUTCOMES.ALREADY_COMPLETED);
    assert.equal(calls, 0, 'the model is not called again for finished work');

    const envelope = await readJson(store.paths.job('developer', DEV_JOB));
    assert.equal(envelope.currentAttemptId, `${DEV_JOB}-a2`, 'still a2 — no a3 was minted');
    assert.equal((await historyOf(store, 'developer', DEV_JOB)).length, 1);
  });
});

test('31. a restart mid-escalation resolves the escalated model from disk, not from memory', async () => {
  await withStore(async (store) => {
    const base = toJobRouting(routeDeveloper({}));
    await store.publishJob('developer', devJob(base));

    // Process 1 escalates, then dies before the successor runs.
    const router = createAttemptRouter({
      store, role: 'developer', jobId: DEV_JOB, base, kind: 'developer', goal: GOAL, round: 1,
    });
    const escalation = await router.escalationFor({ result: DEV_ESCALATES, attempt: 1 });
    assert.equal(escalation.decision.modelKey, 'opus');
    await store.setJobStatus('developer', DEV_JOB, 'REROUTED');
    await store.startNextAttempt('developer', DEV_JOB, {
      reason: 'MODEL_ESCALATION',
      detail: { routedTo: escalation.routed, escalationReason: escalation.reason },
    });

    // Process 2 knows nothing except what is on disk.
    const restarted = createAttemptRouter({
      store, role: 'developer', jobId: DEV_JOB, base, kind: 'developer', goal: GOAL, round: 1,
    });
    const { routing, escalated } = await restarted.current();
    assert.equal(routing.modelKey, 'opus', 'the decision survived the process that made it');
    assert.equal(routing.effort, 'high');
    assert.equal(escalated, true);

    // And it will not escalate a second time.
    assert.equal(await restarted.escalationFor({ result: DEV_ESCALATES, attempt: 2 }), null);
  });
});

// ===========================================================================
// 23/24. The summary reports the run, not a remembered total
// ===========================================================================

test('24. the Goal summary counts the calls and names every fallback and escalation', async () => {
  await withStore(async (store) => {
    const base = toJobRouting(routeDeveloper({}));
    await store.publishJob('developer', devJob(base));
    const router = createAttemptRouter({
      store, role: 'developer', jobId: DEV_JOB, base, kind: 'developer', goal: GOAL, round: 1,
    });

    await runWithCapacity({
      store, role: 'developer', jobId: DEV_JOB, goal: GOAL, round: 1,
      resumeFrom: LOOP_STATES.DEVELOPER_RUNNING, clock: createFakeClock(NOW), router,
      invoke: async ({ attempt }) => (attempt === 1 ? ok(DEV_ESCALATES) : ok(DEV_DONE)),
    });

    const summary = summarizeRouting(await store.readEvents(), { goal: GOAL });
    assert.equal(summary.calls.sonnet, 1);
    assert.equal(summary.calls.opus, 1);
    assert.equal(summary.calls.fable, 0, 'the specialist was never needed here');
    assert.equal(summary.escalations.length, 1);
    assert.equal(summary.escalations[0].from, 'sonnet');
    assert.equal(summary.escalations[0].to, 'opus');
    assert.equal(summary.fallbacks.length, 0);

    const rendered = renderRoutingSummary(summary).join('\n');
    assert.match(rendered, /started on sonnet, ended on opus/);
    assert.match(rendered, /Escalations: 1/);

    // Another Goal's numbers can never leak into this one.
    assert.equal(summarizeRouting(await store.readEvents(), { goal: '999' }).totalCalls, 0);
  });
});

test('30. a fallback is granted once: a second capacity failure waits instead of finding a third model', async () => {
  await withStore(async (store) => {
    const base = toJobRouting(routeDeveloper({}));
    await store.publishJob('developer', devJob(base));
    const router = createAttemptRouter({
      store, role: 'developer', jobId: DEV_JOB, base, kind: 'developer', goal: GOAL, round: 1,
    });

    const modelsUsed = [];
    const run = await runWithCapacity({
      store, role: 'developer', jobId: DEV_JOB, goal: GOAL, round: 1,
      resumeFrom: LOOP_STATES.DEVELOPER_RUNNING,
      clock: createFakeClock(NOW),
      router,
      maxWaits: 1,
      invoke: async ({ attempt }) => {
        const { routing } = await router.current();
        modelsUsed.push(routing.modelKey);
        return attempt <= 2
          ? fail('NON_ZERO_EXIT', "You've hit your session limit · resets 3:10am")
          : ok(DEV_DONE);
      },
    });

    assert.equal(run.outcome, RUN_OUTCOMES.COMPLETED);
    assert.deepEqual(modelsUsed, ['sonnet', 'opus', 'opus'], 'the second limit waits on Opus, it does not reroute again');
  });
});
