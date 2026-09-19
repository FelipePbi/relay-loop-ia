/**
 * Recovering from a failure this tooling caused.
 *
 * The property that matters is uncomfortable on purpose: a retry must be
 * possible WITHOUT pretending the attempt did not fail. Goal 005 R1 a2 really
 * did fail — our argv was rejected — and softening that into an interruption or
 * a capacity wait would lose the one fact worth keeping.
 *
 * Also covered here: importing an entry point must not start it. That defect
 * was found the hard way, by an `import()` that started both workers.
 *
 * No model is called anywhere in this file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJobStore, writeJsonAtomic, readJson, STORE_VERSION } from '../lib/job-store.mjs';
import {
  HARNESS_RETRY_OUTCOMES,
  assessHarnessFailure,
  authorizeRetryAfterHarnessFix,
  findExistingAuthorization,
  findHarnessFailure,
} from '../lib/harness-retry.mjs';
import { LOOP_STATES } from '../lib/loop-state.mjs';
import { isDirectExecution } from '../lib/direct-execution.mjs';

const ARGV_ERROR = 'CLI exited with code 1: Error: When using --print, --output-format=stream-json requires --verbose';
const QUOTA_ERROR = "CLI exited with code 1: You've hit your session limit \u00b7 resets 3:10am (America/Sao_Paulo)";

const JOB_ID = '005-r1-tech_lead-ca1d7bf4';

/**
 * Builds a store on disk that looks exactly like Goal 005 did after a2 failed:
 * a job on attempt 2 marked FAILED, a failure envelope, and an event carrying
 * the CLI's own message.
 */
async function makeFailedState({
  attempt = 2,
  attemptStatus = 'FAILED',
  diagnostic = ARGV_ERROR,
  recordedReason = 'UNKNOWN_FATAL',
  runState = LOOP_STATES.HUMAN_REQUIRED,
  withResult = false,
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-harness-'));
  const store = createJobStore(dir);
  const attemptId = `${JOB_ID}-a${attempt}`;

  await mkdir(store.paths.jobsDir('tech_lead'), { recursive: true });
  await mkdir(store.paths.resultsDir('tech_lead'), { recursive: true });

  await writeJsonAtomic(store.paths.job('tech_lead', JOB_ID), {
    storeVersion: STORE_VERSION,
    publishedAt: '2026-09-08T02:58:46.281Z',
    status: attemptStatus,
    attempt,
    currentAttemptId: attemptId,
    attemptStatus,
    attemptHistory: [{ attempt: 1, attemptId: `${JOB_ID}-a1`, status: 'WAITING_FOR_CAPACITY' }],
    job: { jobId: JOB_ID, role: 'tech_lead', goal: '005', round: 1 },
  });

  await writeJsonAtomic(store.paths.result('tech_lead', JOB_ID), {
    storeVersion: STORE_VERSION,
    publishedAt: '2026-09-08T14:41:57.700Z',
    result: withResult
      ? { ok: true, result: { decision: 'ACCEPTED' } }
      : { ok: false, code: recordedReason, message: 'Unrecoverable failure; a human must look at it.', escalation: 'HUMAN_REQUIRED' },
  });

  await store.appendEvent({
    type: 'AGENT_FAILURE', goal: '005', round: 1, agent: 'tech_lead',
    jobId: JOB_ID, attemptId, reason: recordedReason, code: 'NON_ZERO_EXIT', diagnostic,
  });

  await store.writeRuntime({
    goal: '005', round: 1, state: runState,
    decision: 'HUMAN_REQUIRED', escalationReason: recordedReason,
    blockedAgent: 'tech_lead', blockedJobId: JOB_ID,
  });

  return { dir, store, attemptId };
}

const authorize = (store, extra = {}) => authorizeRetryAfterHarnessFix(store, {
  role: 'tech_lead',
  jobId: JOB_ID,
  detail: 'stream-json argv fixed',
  fixCommit: 'abc1234',
  resumeFrom: LOOP_STATES.REVIEWER_RUNNING,
  ...extra,
});

// --- The evidence is read, not asserted -----------------------------------

test('the failure is judged on the CLI message, re-read with the current classifier', async () => {
  const { dir, store, attemptId } = await makeFailedState();
  try {
    const evidence = await findHarnessFailure(store, { role: 'tech_lead', jobId: JOB_ID });
    assert.equal(evidence.attemptId, attemptId);
    assert.equal(evidence.attemptStatus, 'FAILED');
    assert.equal(evidence.recordedReason, 'UNKNOWN_FATAL');
    assert.equal(evidence.originalError, ARGV_ERROR);

    const verdict = assessHarnessFailure(evidence);
    assert.equal(verdict.from, 'UNKNOWN_FATAL');
    assert.equal(verdict.to, 'HARNESS_ERROR');
    assert.equal(verdict.isHarnessError, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- The failure stays a failure ------------------------------------------

test('a3 is authorised and a2 stays FAILED, with its original error preserved', async () => {
  const { dir, store, attemptId } = await makeFailedState();
  try {
    const applied = await authorize(store);
    assert.equal(applied.outcome, HARNESS_RETRY_OUTCOMES.AUTHORIZED);
    assert.equal(applied.successorAttemptId, `${JOB_ID}-a3`);

    const job = await readJson(store.paths.job('tech_lead', JOB_ID));
    assert.equal(job.attempt, 3);
    assert.equal(job.currentAttemptId, `${JOB_ID}-a3`);
    assert.equal(job.attemptStatus, 'QUEUED');

    // The line that must never soften: a2 is in the history AS A FAILURE.
    const a2 = job.attemptHistory.find((h) => h.attemptId === attemptId);
    assert.equal(a2.status, 'FAILED');
    assert.equal(a2.originalClassification, 'UNKNOWN_FATAL');
    assert.equal(a2.correctedClassification, 'HARNESS_ERROR');
    assert.equal(a2.originalError, ARGV_ERROR);
    assert.notEqual(a2.status, 'INTERRUPTED');
    assert.notEqual(a2.status, 'WAITING_FOR_CAPACITY');

    // And the authorisation is its own record, not folded into the history.
    assert.equal(job.retryAuthorizations.length, 1);
    assert.deepEqual(
      { source: job.retryAuthorizations[0].sourceAttemptId, reason: job.retryAuthorizations[0].reason, fix: job.retryAuthorizations[0].fixCommit },
      { source: attemptId, reason: 'HARNESS_BUG_FIXED', fix: 'abc1234' },
    );

    // The failure envelope survives the successor publishing over it.
    const archived = await readJson(store.paths.result('tech_lead', JOB_ID).replace(/\.json$/, `.failed-${attemptId}.json`));
    assert.equal(archived.original.result.code, 'UNKNOWN_FATAL');

    const events = await store.readEvents();
    const reclassified = events.find((e) => e.type === 'FAILURE_RECLASSIFIED');
    assert.equal(reclassified.from, 'UNKNOWN_FATAL');
    assert.equal(reclassified.to, 'HARNESS_ERROR');
    assert.equal(reclassified.toolingFixCommit, 'abc1234');
    const authorized = events.find((e) => e.type === 'RETRY_AUTHORIZED_AFTER_HARNESS_FIX');
    assert.equal(authorized.sourceAttemptId, attemptId);
    assert.equal(authorized.successorAttemptId, `${JOB_ID}-a3`);

    // The run is released from its stop and points at the review again.
    const runtime = await store.readRuntime();
    assert.equal(runtime.state, LOOP_STATES.REVIEWER_RUNNING);
    assert.equal(runtime.humanRequired, null);
    assert.equal(runtime.escalationReason, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Idempotency ----------------------------------------------------------

test('authorising twice does not create a fourth attempt', async () => {
  const { dir, store } = await makeFailedState();
  try {
    const first = await authorize(store);
    assert.equal(first.outcome, HARNESS_RETRY_OUTCOMES.AUTHORIZED);

    const second = await authorize(store);
    assert.equal(second.outcome, HARNESS_RETRY_OUTCOMES.ALREADY_REPAIRED);
    assert.equal(second.successorAttemptId, `${JOB_ID}-a3`);

    const job = await readJson(store.paths.job('tech_lead', JOB_ID));
    assert.equal(job.attempt, 3, 'a second authorisation must not produce a4');
    assert.equal(job.retryAuthorizations.length, 1);

    // The operator-facing path must reach the same conclusion, and reach it
    // WITHOUT reading evidence: the successor attempt has no failure of its own.
    const existing = await findExistingAuthorization(store, { role: 'tech_lead', jobId: JOB_ID });
    assert.equal(existing.sourceAttemptId, `${JOB_ID}-a2`);
    assert.equal(existing.successorAttemptId, `${JOB_ID}-a3`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('evidence is never borrowed from another attempt', async () => {
  // The real shape of Goal 005: a1 ended on a quota message, a2 on an argv
  // rejection. Reading a1's diagnostic as a2's would classify a harness bug as
  // a capacity wait — and, after a repair, would describe the queued successor
  // as a USAGE_LIMIT failure it never had.
  const { dir, store } = await makeFailedState();
  try {
    await store.appendEvent({
      type: 'AGENT_FAILURE', jobId: JOB_ID, attemptId: `${JOB_ID}-a1`,
      reason: 'USAGE_LIMIT', diagnostic: QUOTA_ERROR,
    });

    // a2's own evidence still wins, even though a1's event is newer on disk.
    const evidence = await findHarnessFailure(store, { role: 'tech_lead', jobId: JOB_ID });
    assert.equal(evidence.attemptId, `${JOB_ID}-a2`);
    assert.equal(evidence.originalError, ARGV_ERROR);
    assert.equal(assessHarnessFailure(evidence).to, 'HARNESS_ERROR');

    await authorize(store);

    // And once the job is on a3, the repair reports itself done rather than
    // reaching back for whichever diagnostic happens to be last.
    const second = await authorize(store);
    assert.equal(second.outcome, HARNESS_RETRY_OUTCOMES.ALREADY_REPAIRED);
    // The repair also CLEARS the primary result path, so there is no longer a
    // failure envelope sitting there for the successor to be judged by — which
    // is the whole point: a3 must not inherit a2's answer.
    await assert.rejects(
      () => findHarnessFailure(store, { role: 'tech_lead', jobId: JOB_ID }),
      (e) => e.code === 'NO_FAILURE_TO_REPAIR' || e.code === 'NO_FAILURE_EVIDENCE',
      'a queued successor has no failure of its own, and may borrow none',
    );
    assert.equal(await store.readResult('tech_lead', JOB_ID), null,
      'the primary result path is empty while the successor runs');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Fail closed ----------------------------------------------------------

test('a capacity failure is refused: that is a wait, not a harness bug', async () => {
  const { dir, store } = await makeFailedState({ diagnostic: QUOTA_ERROR });
  try {
    await assert.rejects(() => authorize(store), (e) => e.code === 'NOT_A_HARNESS_FAILURE');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an attempt that is not FAILED is refused', async () => {
  const { dir, store } = await makeFailedState({ attemptStatus: 'WAITING_FOR_CAPACITY' });
  try {
    await assert.rejects(() => authorize(store), (e) => e.code === 'NOT_A_FAILED_ATTEMPT');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a completed stage is never retried', async () => {
  const { dir, store } = await makeFailedState({ withResult: true });
  try {
    await assert.rejects(
      () => authorize(store),
      (e) => e.code === 'STAGE_ALREADY_COMPLETED' || e.code === 'NO_FAILURE_TO_REPAIR',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a run that is not awaiting a human is refused', async () => {
  const { dir, store } = await makeFailedState({ runState: LOOP_STATES.REVIEWER_RUNNING });
  try {
    await assert.rejects(() => authorize(store), (e) => e.code === 'RUN_NOT_AWAITING_HUMAN');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unknown reason is refused, and nothing is written', async () => {
  const { dir, store } = await makeFailedState();
  try {
    await assert.rejects(() => authorize(store, { reason: 'BECAUSE_I_SAID_SO' }), (e) => e.code === 'INVALID_ARGS');
    const job = await readJson(store.paths.job('tech_lead', JOB_ID));
    assert.equal(job.attempt, 2, 'a refused authorisation writes nothing');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failure with no recorded evidence is refused rather than guessed at', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-harness-'));
  try {
    const store = createJobStore(dir);
    await mkdir(store.paths.jobsDir('tech_lead'), { recursive: true });
    await mkdir(store.paths.resultsDir('tech_lead'), { recursive: true });
    await writeJsonAtomic(store.paths.job('tech_lead', JOB_ID), {
      storeVersion: STORE_VERSION, status: 'FAILED', attempt: 2,
      currentAttemptId: `${JOB_ID}-a2`, attemptStatus: 'FAILED', job: {},
    });
    await writeJsonAtomic(store.paths.result('tech_lead', JOB_ID), {
      storeVersion: STORE_VERSION, result: { ok: false, code: 'UNKNOWN_FATAL', message: 'x' },
    });
    await assert.rejects(
      () => findHarnessFailure(store, { role: 'tech_lead', jobId: JOB_ID }),
      (e) => e.code === 'NO_FAILURE_EVIDENCE',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Importing an entry point must not run it -----------------------------

const ENTRY_POINTS = [
  '../workers/developer.mjs',
  '../workers/tech-lead.mjs',
  '../run-goal.mjs',
  '../run-close.mjs',
  '../run-auto.mjs',
  '../run-status.mjs',
  '../run-resume.mjs',
  '../run-recover.mjs',
  '../run-pause.mjs',
  '../run-reclassify.mjs',
  '../run-authorize-retry.mjs',
  '../run-supervised.mjs',
];

test('importing an entry point starts nothing', async () => {
  // The regression this guards: an `import()` meant to check for circular
  // dependencies STARTED both workers — heartbeat, job polling and all.
  const logged = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args) => logged.push(args.join(' '));
  console.error = (...args) => logged.push(args.join(' '));

  try {
    for (const entry of ENTRY_POINTS) {
      await import(new URL(entry, import.meta.url).href);
    }
  } finally {
    console.log = realLog;
    console.error = realError;
  }

  assert.deepEqual(logged, [], `importing an entry point printed:\n${logged.join('\n')}`);
});

test('isDirectExecution only says yes for the file Node was told to run', async () => {
  const { fileURLToPath } = await import('node:url');
  const self = import.meta.url;

  assert.equal(isDirectExecution(self, fileURLToPath(self)), true, 'this very file, named as the entry');
  assert.equal(isDirectExecution(self, fileURLToPath(new URL('./telemetry.test.mjs', self))), false);
  // `null`, not `undefined`: omitting the argument deliberately falls back to
  // process.argv[1], which is the whole point of the default.
  assert.equal(isDirectExecution(self, null), false);
  assert.equal(isDirectExecution(null, 'anything'), false);
  assert.equal(isDirectExecution(self, 'E:/nowhere/at/all.mjs'), false, 'an unresolvable entry is not a match');
});
