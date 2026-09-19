/**
 * IA Loop — authorising ONE retry after a harness bug is fixed.
 *
 * There are two different reasons an attempt can be owed a successor, and they
 * must not be told apart by feel:
 *
 *   CAPACITY   the model said "not now". The attempt did not fail — it was
 *              parked. `failure-reclassification.mjs` handles that, and the
 *              ordinary capacity path materialises the retry.
 *
 *   HARNESS    the attempt genuinely FAILED, because of a defect in this
 *              tooling. Goal 005 R1 a2 died on
 *              "When using --print, --output-format=stream-json requires
 *              --verbose": our own argv, rejected before a single token was
 *              spent. Waiting cannot fix that; a person had to change code.
 *
 * The second case is what this file is for, and the design constraint is
 * uncomfortable on purpose: the retry must be possible WITHOUT pretending the
 * attempt did not fail. So nothing here rewrites a2 into INTERRUPTED or into a
 * capacity wait. The attempt stays FAILED in the history, with its original
 * classification and its original error, and a separate `retryAuthorization`
 * record says why a successor is legitimate and who authorised it.
 *
 * Everything else is a fail-closed precondition. This is a narrow instrument,
 * not a way to retry any failure that happens to be inconvenient.
 */

import { SpikeError } from './claude-process.mjs';
import { CAPACITY_REASONS, classifyFailure } from './capacity-classifier.mjs';
import { readJson, writeJsonAtomic, attemptIdOf, STORE_VERSION } from './job-store.mjs';
import { LOOP_STATES } from './state-registry.mjs';

/** Why a retry is being authorised. Free prose is not a reason. */
export const HARNESS_RETRY_REASONS = Object.freeze({
  HARNESS_BUG_FIXED: 'HARNESS_BUG_FIXED',
});

/** What the authorisation returns when it declines to do anything. */
export const HARNESS_RETRY_OUTCOMES = Object.freeze({
  AUTHORIZED: 'AUTHORIZED',
  ALREADY_REPAIRED: 'ALREADY_REPAIRED',
});

/** Run states from which a harness repair may be authorised. */
const REPAIRABLE_RUN_STATES = Object.freeze([
  LOOP_STATES.HUMAN_REQUIRED,
  LOOP_STATES.AWAITING_HUMAN,
]);

function fail(code, message, details = {}) {
  throw new SpikeError(code, message, details);
}

/**
 * The authorisation already recorded for the attempt the job is now on, if any.
 *
 * Separate from `findHarnessFailure` on purpose: after a repair the job points
 * at the successor, which has no failure to read. Asking this first is what
 * makes a second run a clean no-op rather than a confusing error.
 */
export async function findExistingAuthorization(store, { role, jobId }) {
  const job = await readJson(store.paths.job(role, jobId), { required: true });
  const currentAttemptId = job.currentAttemptId ?? attemptIdOf(jobId, job.attempt ?? 1);
  return (job.retryAuthorizations ?? []).find((a) => a.successorAttemptId === currentAttemptId) ?? null;
}

/**
 * Collects what is on disk about the failed attempt.
 *
 * The result envelope holds the CONCLUSION the harness drew; the event log
 * holds the EVIDENCE — the CLI's own words. A repair is judged on the evidence,
 * never on the conclusion, so both are read and they must agree.
 */
export async function findHarnessFailure(store, { role, jobId }) {
  const jobPath = store.paths.job(role, jobId);
  const job = await readJson(jobPath, { required: true });

  const envelope = await readJson(store.paths.result(role, jobId));
  const result = envelope?.result ?? null;
  if (!result || result.ok !== false) {
    fail('NO_FAILURE_TO_REPAIR', `${jobId} has no recorded failure; there is nothing to authorise a retry for.`);
  }

  const attempt = Number.isInteger(job.attempt) && job.attempt >= 1 ? job.attempt : 1;
  const attemptId = job.currentAttemptId ?? attemptIdOf(jobId, attempt);

  const events = await store.readEvents();
  const diagnostics = [...events].reverse()
    .filter((event) => event.jobId === jobId && typeof event.diagnostic === 'string');

  // Scoped to THIS attempt, strictly. Accepting an event that names no attempt
  // is only safe when NO event for this job names one — otherwise a1's quota
  // message gets read as a2's evidence, which is exactly what happened the
  // first time this was tried: the second run of the repair reported the job
  // as a USAGE_LIMIT because it had picked up the wrong attempt's diagnostic.
  const anyAttemptScoped = diagnostics.some((event) => typeof event.attemptId === 'string');
  const evidence = diagnostics.find((event) => (anyAttemptScoped
    ? event.attemptId === attemptId
    : true));

  if (!evidence) {
    fail('NO_FAILURE_EVIDENCE',
      `No diagnostic is recorded for ${attemptId}; a retry will not be authorised on a failure nobody can read.`);
  }

  return {
    role,
    jobId,
    jobPath,
    attempt,
    attemptId,
    status: job.status ?? null,
    attemptStatus: job.attemptStatus ?? job.status ?? null,
    recordedReason: result.code ?? null,
    diagnostic: evidence.diagnostic,
    originalError: evidence.diagnostic,
    failedAt: evidence.at ?? envelope.publishedAt ?? null,
    existingAuthorizations: job.retryAuthorizations ?? [],
    resultPath: store.paths.result(role, jobId),
  };
}

/**
 * Re-reads the evidence with the CURRENT classifier.
 *
 * Derived, never asserted: an operator cannot declare a failure to be a harness
 * bug. If the fixed classifier does not read it as HARNESS_ERROR, the repair
 * refuses — which is exactly what stops this becoming a way to retry anything.
 */
export function assessHarnessFailure(evidence) {
  const failedAt = Date.parse(evidence.failedAt ?? '');
  const classification = classifyFailure(
    { error: { code: 'NON_ZERO_EXIT', message: evidence.diagnostic }, structuredOutput: false },
    { now: Number.isNaN(failedAt) ? Date.now() : failedAt },
  );

  return {
    from: evidence.recordedReason,
    to: classification.reason,
    isHarnessError: classification.reason === CAPACITY_REASONS.HARNESS_ERROR,
    changed: classification.reason !== evidence.recordedReason,
    diagnostic: classification.diagnostic,
  };
}

/**
 * Authorises exactly one successor attempt.
 *
 * Preconditions, all fail-closed:
 *
 *   - the attempt is recorded as FAILED;
 *   - its failure reads as HARNESS_ERROR with the current classifier;
 *   - the run is stopped for a human;
 *   - an operator gave a reason;
 *   - no successor exists yet;
 *   - the stage is still incomplete and has no valid result.
 *
 * Running it twice does NOT produce a third attempt: the second call reports
 * ALREADY_REPAIRED and writes nothing.
 */
export async function authorizeRetryAfterHarnessFix(store, {
  role,
  jobId,
  reason = HARNESS_RETRY_REASONS.HARNESS_BUG_FIXED,
  detail = null,
  fixCommit = null,
  resumeFrom,
  now = Date.now(),
  autonomousStore = null,
}) {
  if (!Object.hasOwn(HARNESS_RETRY_REASONS, reason)) {
    fail('INVALID_ARGS', `Unknown retry reason ${JSON.stringify(reason)}`);
  }
  if (!resumeFrom) fail('INVALID_ARGS', 'authorizeRetryAfterHarnessFix needs the state to resume into');

  // --- Idempotency, before ANY other read --------------------------------
  // A repair that already ran left its mark on the job, and the job has since
  // moved on to the successor attempt. Looking for the failed attempt's
  // evidence first would fail on the successor — which HAS no failure — and
  // turn a harmless second run into an error instead of a no-op.
  const job = await readJson(store.paths.job(role, jobId), { required: true });
  const authorizations = job.retryAuthorizations ?? [];
  const currentAttemptId = job.currentAttemptId ?? attemptIdOf(jobId, job.attempt ?? 1);
  const already = authorizations.find((a) => a.successorAttemptId === currentAttemptId);
  if (already) {
    return {
      outcome: HARNESS_RETRY_OUTCOMES.ALREADY_REPAIRED,
      authorization: already,
      evidence: null,
      successorAttemptId: already.successorAttemptId,
    };
  }

  const evidence = await findHarnessFailure(store, { role, jobId });

  // The same attempt authorised twice within one attempt number: also a no-op.
  const repeated = evidence.existingAuthorizations.find((a) => a.sourceAttemptId === evidence.attemptId);
  if (repeated) {
    return {
      outcome: HARNESS_RETRY_OUTCOMES.ALREADY_REPAIRED,
      authorization: repeated,
      evidence,
      successorAttemptId: repeated.successorAttemptId,
    };
  }

  // --- The stage must still be unfinished --------------------------------
  if (await store.hasCompletedResult(role, jobId)) {
    fail('STAGE_ALREADY_COMPLETED',
      `${jobId} already produced a valid result; finished work is never retried.`);
  }

  // --- The attempt must really have failed -------------------------------
  if (evidence.attemptStatus !== 'FAILED') {
    fail('NOT_A_FAILED_ATTEMPT',
      `${evidence.attemptId} is ${evidence.attemptStatus}, not FAILED. `
      + 'A capacity wait is repaired with ia-loop:reclassify, not with a harness retry.');
  }

  // --- The failure must actually be ours ---------------------------------
  const verdict = assessHarnessFailure(evidence);
  if (!verdict.isHarnessError) {
    fail('NOT_A_HARNESS_FAILURE',
      `${evidence.attemptId} reads as ${verdict.to}, not HARNESS_ERROR. `
      + 'A retry is only authorised for a failure this tooling caused.',
      { from: verdict.from, to: verdict.to });
  }

  // --- The run must be stopped for a human -------------------------------
  const runtime = await store.readRuntime();
  if (!REPAIRABLE_RUN_STATES.includes(runtime?.state)) {
    fail('RUN_NOT_AWAITING_HUMAN',
      `The run is ${runtime?.state ?? 'unknown'}. A harness retry is authorised only while it waits for a person.`);
  }
  if (runtime?.goal && !jobId.startsWith(`${runtime.goal}-`)) {
    fail('CROSS_GOAL_STATE_LEAK',
      `${jobId} does not belong to Goal ${runtime.goal}; a repair never reaches across Goals.`);
  }

  // --- No successor may already exist ------------------------------------
  const state = await store.readAttemptState(role, jobId);
  if (state && state.attempt > evidence.attempt) {
    fail('SUCCESSOR_ALREADY_EXISTS',
      `${jobId} is already on attempt ${state.attempt}; a second authorisation would create a third.`);
  }

  const at = new Date(now).toISOString();
  const nextAttempt = evidence.attempt + 1;
  const successorAttemptId = attemptIdOf(jobId, nextAttempt);

  const authorization = {
    sourceAttemptId: evidence.attemptId,
    successorAttemptId,
    reason,
    detail: typeof detail === 'string' ? detail.slice(0, 300) : null,
    fixCommit: fixCommit ?? null,
    // What the failure WAS and what it should have been called. Both survive.
    originalClassification: verdict.from,
    correctedClassification: verdict.to,
    originalError: evidence.originalError,
    authorizedAt: at,
  };

  // The failure envelope is preserved under the attempt's own name AND removed
  // from the primary path.
  //
  // Copying alone was not enough, and the cost of learning that was a whole
  // review: a2's failure stayed on the primary path while a3 ran, and the
  // orchestrator — arriving six seconds after the worker — read it as a3's
  // answer and stopped the Goal for a human 4.5 minutes before a3 actually
  // finished with CHANGES_REQUIRED.
  const archivedResult = evidence.resultPath.replace(/\.json$/, `.failed-${evidence.attemptId}.json`);
  if (!await readJson(archivedResult)) {
    await writeJsonAtomic(archivedResult, {
      storeVersion: STORE_VERSION,
      archivedAt: at,
      reason: 'RETRY_AUTHORIZED_AFTER_HARNESS_FIX',
      original: await readJson(evidence.resultPath),
      authorization,
    });
  }
  await store.archiveResultForAttempt(role, jobId, evidence.attemptId, {
    reason: 'RETRY_AUTHORIZED_AFTER_HARNESS_FIX',
  });

  const current = await readJson(evidence.jobPath, { required: true });
  await writeJsonAtomic(evidence.jobPath, {
    ...current,
    status: 'QUEUED',
    attempt: nextAttempt,
    currentAttemptId: successorAttemptId,
    attemptStatus: 'QUEUED',
    statusAt: at,
    attemptStartedAt: at,
    requeuedAt: at,
    // The failed attempt enters the history AS A FAILURE. This is the line
    // that must never be softened: a2 failed, and the record says so forever.
    attemptHistory: [
      ...(current.attemptHistory ?? []),
      {
        attempt: evidence.attempt,
        attemptId: evidence.attemptId,
        status: 'FAILED',
        reason: 'HARNESS_ERROR',
        originalClassification: verdict.from,
        correctedClassification: verdict.to,
        originalError: evidence.originalError,
        startedAt: current.attemptStartedAt ?? current.requeuedAt ?? current.publishedAt ?? null,
        endedAt: evidence.failedAt ?? at,
        retryAuthorizedBy: reason,
        fixCommit: fixCommit ?? null,
      },
    ],
    // Kept separately from the history so an audit can ask "who authorised a
    // successor, and on what grounds" without reconstructing it from prose.
    retryAuthorizations: [...evidence.existingAuthorizations, authorization],
  });

  // The stop this repair clears. What caused it survives in the event log, in
  // the archived envelope and in the attempt history, so dropping the pointer
  // loses nothing.
  await store.writeRuntime({
    ...runtime,
    state: resumeFrom,
    blockedAgent: null,
    blockedJobId: null,
    resumeFrom,
    capacity: null,
    humanRequired: null,
    decision: null,
    escalationReason: null,
  });

  // Two events, because two different things happened: the failure was named
  // correctly, and a successor was authorised.
  await store.appendEvent({
    type: 'FAILURE_RECLASSIFIED',
    goal: runtime?.goal ?? null,
    round: runtime?.round ?? null,
    role,
    jobId,
    attemptId: evidence.attemptId,
    from: verdict.from,
    to: verdict.to,
    reason: detail ?? reason,
    toolingFixCommit: fixCommit ?? null,
    evidenceAt: evidence.failedAt,
  });
  await store.appendEvent({
    type: 'RETRY_AUTHORIZED_AFTER_HARNESS_FIX',
    goal: runtime?.goal ?? null,
    round: runtime?.round ?? null,
    role,
    jobId,
    sourceAttemptId: evidence.attemptId,
    successorAttemptId,
    reason,
    detail: authorization.detail,
    fixCommit: fixCommit ?? null,
    resumeFrom,
  });

  // The run stopped for the failure this repair just accounted for.
  let run = null;
  if (autonomousStore) {
    run = await autonomousStore.read();
    if (run?.status === 'PAUSED_FOR_HUMAN') {
      run = await autonomousStore.write({
        ...run,
        status: 'RUNNING',
        humanRequired: null,
        repairedBy: { kind: 'HARNESS_RETRY', jobId, sourceAttemptId: evidence.attemptId, at },
      });
      await store.appendEvent({
        type: 'AUTONOMOUS_RUN_RESUMED',
        autonomousRunId: run.autonomousRunId,
        reason: 'RETRY_AUTHORIZED_AFTER_HARNESS_FIX',
        jobId,
      });
    }
  }

  return {
    outcome: HARNESS_RETRY_OUTCOMES.AUTHORIZED,
    authorization,
    evidence,
    verdict,
    successorAttemptId,
    run,
  };
}
