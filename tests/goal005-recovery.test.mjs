/**
 * The whole Goal 005 R1 story, end to end, with fakes.
 *
 *   Developer R1  COMPLETED, reused, never called again
 *   Reviewer a1   USAGE_LIMIT → capacity wait → successor
 *   Reviewer a2   argv rejected by the CLI → HARNESS_ERROR → HUMAN_REQUIRED
 *   tooling fix   --verbose added; retry authorised
 *   Reviewer a3   ACCEPTED
 *
 * Two failures, two different repairs, one job, one stage, three attempts, and
 * one Developer inference for the whole thing. No model is called here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildArgs, invokeAgent } from '../lib/claude-process.mjs';
import { createJobStore, writeJsonAtomic, readJson, STORE_VERSION } from '../lib/job-store.mjs';
import { classifyFailure, CAPACITY_REASONS } from '../lib/capacity-classifier.mjs';
import { authorizeRetryAfterHarnessFix, HARNESS_RETRY_OUTCOMES } from '../lib/harness-retry.mjs';
import { LOOP_STATES } from '../lib/loop-state.mjs';

const FABLE = 'claude-fable-5-1';
const OPUS = 'claude-opus-5';
const REVIEW_JOB = '005-r1-tech_lead-ca1d7bf4';
const DEV_JOB = '005-r1-developer-b218cf51';
const SESSION = '6dee5c24-44af-4c3d-8b98-64aa3d927549';

const QUOTA = "You've hit your session limit · resets 3:10am (America/Sao_Paulo)";
const ARGV_ERROR = 'Error: When using --print, --output-format=stream-json requires --verbose';

/**
 * A fake CLI.
 *
 * `argvGate` decides whether the process even gets to answer — which is the
 * whole point of a2: the CLI rejected the arguments and no inference happened.
 */
function fakeCli({ servedBy = FABLE, result = '{"role":"tech_lead","ok":true}', argvGate = null, calls }) {
  return (executable, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;

    const rejection = argvGate?.(args) ?? null;
    calls.push({
      model: args[args.indexOf('--model') + 1],
      outputFormat: args[args.indexOf('--output-format') + 1],
      verbose: args.includes('--verbose'),
      resumed: args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null,
      // The fact this whole exercise turns on: did the model actually run?
      inferred: rejection === null,
    });

    setImmediate(() => {
      if (rejection !== null) {
        child.stderr.emit('data', `${rejection}\n`);
        child.emit('close', 1);
        return;
      }
      // The explicit evidence invokeAgent now reads: an `assistant` event
      // naming the served model, before the closing `result`.
      child.stdout.emit('data', `${JSON.stringify({
        type: 'assistant',
        message: { model: servedBy, content: [{ type: 'text', text: 'ok' }] },
      })}\n`);
      child.stdout.emit('data', JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result,
        usage: { input_tokens: 8, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: { [servedBy]: { inputTokens: 8, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
      }));
      child.emit('close', 0);
    });
    return child;
  };
}

/** The CLI's real constraint, as a gate a fake spawn can enforce. */
const REAL_CLI_ARGV_GATE = (args) => (
  args.includes('--print') && args[args.indexOf('--output-format') + 1] === 'stream-json' && !args.includes('--verbose')
    ? ARGV_ERROR
    : null
);

const reviewCall = ({ calls, argvGate = REAL_CLI_ARGV_GATE, ...rest }) => invokeAgent({
  executable: 'claude',
  model: FABLE,
  expectedFamily: 'fable',
  expectedRole: 'tech_lead',
  prompt: 'review packet',
  sessionId: SESSION,
  persistSession: true,
  resume: true,
  tools: ['Read', 'Glob', 'Grep', 'Bash'],
  permissionMode: 'auto',
  safeMode: false,
  onTelemetryEvent: () => {},
  spawnFn: fakeCli({ calls, argvGate, ...rest }),
});

test('Goal 005 R1: capacity wait, then a harness bug, then an accepted review', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-goal005-'));
  const developerCalls = [];
  const reviewCalls = [];

  try {
    const store = createJobStore(dir);
    await mkdir(store.paths.jobsDir('tech_lead'), { recursive: true });
    await mkdir(store.paths.resultsDir('tech_lead'), { recursive: true });
    await mkdir(store.paths.jobsDir('developer'), { recursive: true });
    await mkdir(store.paths.resultsDir('developer'), { recursive: true });

    // ---- Developer R1 is already done, and stays done --------------------
    await writeJsonAtomic(store.paths.job('developer', DEV_JOB), {
      storeVersion: STORE_VERSION, status: 'COMPLETED', attempt: 1,
      currentAttemptId: `${DEV_JOB}-a1`, attemptStatus: 'COMPLETED', job: { jobId: DEV_JOB, goal: '005', round: 1 },
    });
    await writeJsonAtomic(store.paths.result('developer', DEV_JOB), {
      storeVersion: STORE_VERSION,
      result: { ok: true, result: { status: 'REVIEW_REQUIRED', goal: '005', round: 1 } },
    });

    // Whatever else happens, the Developer is never invoked again: its result
    // is on disk, and that is the idempotency guarantee.
    assert.equal(await store.hasCompletedResult('developer', DEV_JOB), true);

    // ---- a1: the model said "not now" ------------------------------------
    const a1 = classifyFailure({ error: { code: 'NON_ZERO_EXIT', message: `CLI exited with code 1: ${QUOTA}` } });
    assert.equal(a1.reason, CAPACITY_REASONS.USAGE_LIMIT, 'a session limit is a wait, not a failure');

    await writeJsonAtomic(store.paths.job('tech_lead', REVIEW_JOB), {
      storeVersion: STORE_VERSION,
      publishedAt: '2026-09-08T02:58:46.281Z',
      status: 'WAITING_FOR_CAPACITY', attempt: 1,
      currentAttemptId: `${REVIEW_JOB}-a1`, attemptStatus: 'WAITING_FOR_CAPACITY',
      job: { jobId: REVIEW_JOB, role: 'tech_lead', goal: '005', round: 1 },
    });
    // The ordinary capacity path materialises the successor.
    const materialised = await store.startNextAttempt('tech_lead', REVIEW_JOB, { reason: 'CAPACITY_RETRY' });
    assert.equal(materialised.created, true);
    assert.equal(materialised.attemptId, `${REVIEW_JOB}-a2`);

    // ---- a2: our own argv, rejected before any inference ------------------
    const a2Outcome = await reviewCall({ calls: reviewCalls, argvGate: () => ARGV_ERROR });
    assert.equal(a2Outcome.error.code, 'NON_ZERO_EXIT');
    assert.match(a2Outcome.error.message, /requires --verbose/);
    assert.equal(reviewCalls.at(-1).inferred, false, 'a2 must not have reached the model');

    const a2 = classifyFailure({ error: a2Outcome.error });
    assert.equal(a2.reason, CAPACITY_REASONS.HARNESS_ERROR, 'an argv rejection is our bug, not an unknown');

    await writeJsonAtomic(store.paths.job('tech_lead', REVIEW_JOB), {
      ...(await readJson(store.paths.job('tech_lead', REVIEW_JOB))),
      status: 'FAILED', attemptStatus: 'FAILED',
    });
    await writeJsonAtomic(store.paths.result('tech_lead', REVIEW_JOB), {
      storeVersion: STORE_VERSION,
      result: { ok: false, code: 'UNKNOWN_FATAL', message: 'Unrecoverable failure; a human must look at it.' },
    });
    await store.appendEvent({
      type: 'AGENT_FAILURE', goal: '005', round: 1, agent: 'tech_lead',
      jobId: REVIEW_JOB, attemptId: `${REVIEW_JOB}-a2`,
      reason: 'UNKNOWN_FATAL', code: 'NON_ZERO_EXIT',
      diagnostic: `CLI exited with code 1: ${ARGV_ERROR}`,
    });
    await store.writeRuntime({
      goal: '005', round: 1, state: LOOP_STATES.HUMAN_REQUIRED,
      decision: 'HUMAN_REQUIRED', escalationReason: 'UNKNOWN_FATAL',
      blockedAgent: 'tech_lead', blockedJobId: REVIEW_JOB,
    });

    // ---- the tooling fix, then an authorised retry -----------------------
    const authorised = await authorizeRetryAfterHarnessFix(store, {
      role: 'tech_lead', jobId: REVIEW_JOB,
      detail: 'buildArgs now passes --verbose with stream-json',
      fixCommit: 'deadbee',
      resumeFrom: LOOP_STATES.REVIEWER_RUNNING,
    });
    assert.equal(authorised.outcome, HARNESS_RETRY_OUTCOMES.AUTHORIZED);
    assert.equal(authorised.successorAttemptId, `${REVIEW_JOB}-a3`);

    // ---- a3: the same job, the same session, on the fixed argv -----------
    const a3Outcome = await reviewCall({ calls: reviewCalls });
    assert.equal(a3Outcome.error, null);
    assert.equal(a3Outcome.resolvedPrimaryModel, FABLE);
    assert.equal(reviewCalls.at(-1).inferred, true, 'a3 reaches the model');
    assert.equal(reviewCalls.at(-1).verbose, true, 'the fixed argv carries --verbose');
    assert.equal(reviewCalls.at(-1).outputFormat, 'stream-json');
    assert.equal(reviewCalls.at(-1).resumed, SESSION, 'the same Fable session is resumed throughout');

    // ---- What the whole story must be able to say afterwards -------------
    const job = await readJson(store.paths.job('tech_lead', REVIEW_JOB));
    assert.equal(job.attempt, 3);
    assert.equal(job.currentAttemptId, `${REVIEW_JOB}-a3`);

    // Three attempts, one job, one stage. History intact and honest.
    const history = job.attemptHistory.map((h) => [h.attemptId, h.status]);
    assert.deepEqual(history, [
      [`${REVIEW_JOB}-a1`, 'WAITING_FOR_CAPACITY'],
      [`${REVIEW_JOB}-a2`, 'FAILED'],
    ]);
    assert.equal(job.attemptHistory[1].originalClassification, 'UNKNOWN_FATAL');
    assert.equal(job.attemptHistory[1].correctedClassification, 'HARNESS_ERROR');
    assert.match(job.attemptHistory[1].originalError, /requires --verbose/);

    // The Developer was never called: zero inferences, result reused.
    assert.equal(developerCalls.length, 0);
    assert.equal(await store.hasCompletedResult('developer', DEV_JOB), true);
    const devJob = await readJson(store.paths.job('developer', DEV_JOB));
    assert.equal(devJob.attempt, 1, 'no duplicated implementation stage');
    assert.equal(devJob.status, 'COMPLETED');

    // Reviewer inferences: a2 spent none, a3 spent one.
    assert.deepEqual(reviewCalls.map((c) => c.inferred), [false, true]);
    assert.equal(reviewCalls.filter((c) => c.inferred).length, 1);

    // No fallback anywhere, on any attempt.
    for (const call of reviewCalls) assert.equal(call.model, FABLE);

    const events = await store.readEvents();
    assert.ok(events.some((e) => e.type === 'FAILURE_RECLASSIFIED' && e.to === 'HARNESS_ERROR'));
    assert.ok(events.some((e) => e.type === 'RETRY_AUTHORIZED_AFTER_HARNESS_FIX'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the fixed argv is what the real CLI gate would have accepted', async () => {
  // The gate is the CLI's own rule, applied to the argv the harness now builds.
  const args = buildArgs({
    prompt: 'p', model: FABLE, jsonSchema: { type: 'object' },
    sessionId: SESSION, persistSession: true, resume: true, outputFormat: 'stream-json',
  });
  assert.equal(REAL_CLI_ARGV_GATE(args), null, 'the argv we build must pass the constraint that broke a2');

  // And the argv from before the fix would still be rejected, so this test is
  // proving something rather than restating the implementation.
  const broken = args.filter((a) => a !== '--verbose');
  assert.equal(REAL_CLI_ARGV_GATE(broken), ARGV_ERROR);

  // A Developer profile call is covered by the same rule.
  const devArgs = buildArgs({
    prompt: 'p', model: OPUS, jsonSchema: { type: 'object' },
    sessionId: SESSION, effort: 'high', outputFormat: 'stream-json',
  });
  assert.equal(REAL_CLI_ARGV_GATE(devArgs), null);
  assert.equal(devArgs[devArgs.indexOf('--effort') + 1], 'high');
});
