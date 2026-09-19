/**
 * IA Loop — repairing a failure the classifier read wrongly.
 *
 * A stop that a person has to clear is expensive, and one created by our own
 * misreading is worse than expensive: it looks exactly like a real problem.
 * Goal 005 stopped as UNKNOWN_FATAL eleven minutes before the quota it had hit
 * reset itself, because the classifier did not know the words the Claude CLI
 * uses for a session limit.
 *
 * Clearing that with `--resolved` would be the wrong instrument twice over: it
 * retires the run as though a person had fixed something, and it leaves the
 * state machine believing the failure was real. What is needed is narrower and
 * more honest — say what the failure ACTUALLY was, and let the ordinary
 * capacity path take it from there.
 *
 * The rules that keep this from being a way to wish failures away:
 *
 *   - the new classification is DERIVED, never asserted. The persisted
 *     diagnostic is re-run through the current classifier; if it still reads
 *     the same, there is nothing to repair and the repair refuses.
 *   - it only ever moves a failure to something the capacity policy would WAIT
 *     on. A fatal staying fatal is not a repair.
 *   - a stage that already completed is never touched.
 *   - nothing is deleted. The original status, the original classification and
 *     the original result envelope all survive, and the event log records the
 *     correction as its own fact.
 */

import { SpikeError } from './claude-process.mjs';
import { CAPACITY_REASONS, classifyFailure, parseResetAt } from './capacity-classifier.mjs';
import { CAPACITY_ACTIONS, decideCapacityAction } from './capacity-policy.mjs';
import { CAPACITY_CONFIG } from './capacity-config.mjs';
import { readJson, writeJsonAtomic, STORE_VERSION } from './job-store.mjs';
import { LOOP_STATES } from './state-registry.mjs';

/** Why a repair is being made. Open-ended prose is not a reason. */
export const REPAIR_REASONS = Object.freeze({
  CAPACITY_CLASSIFIER_BUG: 'CAPACITY_CLASSIFIER_BUG',
});

/**
 * Finds what the harness actually saw when the job failed.
 *
 * The result envelope records the CONCLUSION ("Unrecoverable failure"); the
 * event log records the EVIDENCE — the CLI's own message, sanitized. A repair
 * needs the evidence, so this returns both and refuses when they disagree.
 */
export async function findFailureEvidence(store, { role, jobId }) {
  const envelope = await readJson(store.paths.result(role, jobId));
  const result = envelope?.result ?? null;
  if (!result || result.ok !== false) {
    throw new SpikeError('NO_FAILURE_TO_RECLASSIFY',
      `${jobId} has no recorded failure to reclassify.`);
  }

  const events = await store.readEvents();
  // The last event about this job that carried a diagnostic IS what the
  // classifier saw. Anything earlier belongs to an attempt that is not this one.
  const evidence = [...events].reverse().find((e) => e.jobId === jobId && typeof e.diagnostic === 'string');
  if (!evidence) {
    throw new SpikeError('NO_FAILURE_EVIDENCE',
      `No diagnostic is recorded for ${jobId}; there is nothing to re-read, and a repair will not be guessed.`);
  }
  if (evidence.reason !== result.code) {
    throw new SpikeError('EVIDENCE_INCONSISTENT',
      `The event log classified ${jobId} as ${evidence.reason} but the result says ${result.code}. `
      + 'A repair needs the two to agree about what happened.');
  }

  return {
    jobId,
    role,
    diagnostic: evidence.diagnostic,
    recordedReason: result.code,
    eventAt: evidence.at,
    // The event is when the CLI's own message was produced, and "resets 3:10am"
    // is relative to exactly that instant. The result envelope is written a
    // moment later, when the harness has already drawn its conclusion.
    failedAt: evidence.at ?? envelope.publishedAt,
    resultPath: store.paths.result(role, jobId),
  };
}

/**
 * Re-reads the evidence with today's classifier.
 *
 * `now` is the moment the failure happened, not the present: "resets 3:10am"
 * meant 3:10am on the day the CLI said it. Anchoring the reading anywhere else
 * would compute the wrong reset, and for a reset already in the past would
 * invent a wait of nearly a day.
 */
export function reclassifyEvidence(evidence, { config = CAPACITY_CONFIG } = {}) {
  const failedAt = Date.parse(evidence.failedAt);
  if (Number.isNaN(failedAt)) {
    throw new SpikeError('EVIDENCE_INCONSISTENT', `${evidence.jobId} has no readable failure timestamp.`);
  }

  const classification = classifyFailure(
    { error: { code: 'NON_ZERO_EXIT', message: evidence.diagnostic }, structuredOutput: false },
    { now: failedAt },
  );
  const decision = decideCapacityAction({
    reason: classification.reason,
    attempt: 1,
    retryAfterMs: classification.retryAfterMs,
    now: failedAt,
    config,
  });

  // When the message states a reset, that instant is the fact — measured from
  // when the message was produced.
  const resetMs = parseResetAt(evidence.diagnostic, { now: failedAt });
  const resetAt = resetMs === null ? null : failedAt + resetMs;

  return {
    from: evidence.recordedReason,
    to: classification.reason,
    action: decision.action,
    resetAt: resetAt === null ? null : new Date(resetAt).toISOString(),
    changed: classification.reason !== evidence.recordedReason,
  };
}

/**
 * Applies the repair.
 *
 * Refuses everything it cannot justify from what is on disk, and writes nothing
 * before every check has passed.
 */
export async function reclassifyFailure(store, {
  role,
  jobId,
  repairReason = REPAIR_REASONS.CAPACITY_CLASSIFIER_BUG,
  resumeFrom,
  now = Date.now(),
  config = CAPACITY_CONFIG,
  autonomousStore = null,
}) {
  if (!Object.hasOwn(REPAIR_REASONS, repairReason)) {
    throw new SpikeError('INVALID_ARGS', `Unknown repair reason ${JSON.stringify(repairReason)}`);
  }
  if (!resumeFrom) throw new SpikeError('INVALID_ARGS', 'reclassifyFailure needs the state to resume into');

  const evidence = await findFailureEvidence(store, { role, jobId });
  const verdict = reclassifyEvidence(evidence, { config });

  if (!verdict.changed) {
    throw new SpikeError('NOTHING_TO_RECLASSIFY',
      `${jobId} still classifies as ${verdict.to}. The recorded failure stands; there is no bug to repair here.`);
  }
  if (verdict.action !== CAPACITY_ACTIONS.WAIT) {
    // A repair exists to turn a wrongly-fatal failure back into the wait it
    // always was. Moving one fatal reason to another changes nothing a person
    // still has to look at, so it is not something this may do quietly.
    throw new SpikeError('RECLASSIFICATION_NOT_A_WAIT',
      `${jobId} reclassifies as ${verdict.to}, which still needs a human. A repair does not clear that.`);
  }

  // A completed stage is never reopened, whatever its job's status says. This
  // is what stops a review repair from putting an implementation back in play.
  if (await store.hasCompletedResult(role, jobId)) {
    throw new SpikeError('STAGE_ALREADY_COMPLETED',
      `${jobId} already produced a result; a failure repair cannot apply to finished work.`);
  }

  const path = store.paths.job(role, jobId);
  const current = await readJson(path, { required: true });
  const attempt = Number.isInteger(current.attempt) && current.attempt >= 1 ? current.attempt : 1;
  const attemptId = current.currentAttemptId ?? `${jobId}-a${attempt}`;
  const originalStatus = current.status ?? null;
  const originalAttemptStatus = current.attemptStatus ?? originalStatus;

  if (originalStatus !== 'FAILED') {
    throw new SpikeError('NOT_A_FAILED_ATTEMPT',
      `${jobId} is ${originalStatus}, not FAILED. Only a recorded failure is reclassified.`);
  }

  const at = new Date(now).toISOString();
  const repair = {
    originalStatus,
    originalAttemptStatus,
    originalClassification: verdict.from,
    correctedSemanticStatus: 'WAITING_FOR_CAPACITY',
    correctedClassification: verdict.to,
    repairReason,
    sourceEvidence: {
      event: { at: evidence.eventAt, diagnostic: evidence.diagnostic },
      result: evidence.resultPath,
    },
    resetAt: verdict.resetAt,
    repairTimestamp: at,
    attemptId,
  };

  // The failure envelope is kept under its own name before anything can
  // overwrite it: the next attempt publishes over the result file, and the
  // record of what the harness concluded must outlive that.
  const archivedResult = `${store.paths.result(role, jobId)}`.replace(/\.json$/, `.failed-${attemptId}.json`);
  if (!await readJson(archivedResult)) {
    await writeJsonAtomic(archivedResult, {
      storeVersion: STORE_VERSION,
      archivedAt: at,
      reason: 'RECLASSIFIED_AS_CAPACITY_WAIT',
      original: await readJson(store.paths.result(role, jobId)),
      repair,
    });
  }
  // And cleared from the primary path, so the successor attempt this repair
  // enables cannot find the predecessor's envelope waiting there.
  await store.archiveResultForAttempt(role, jobId, attemptId, {
    reason: 'RECLASSIFIED_AS_CAPACITY_WAIT',
  });

  // The attempt becomes what it always was: one that ended because the model
  // said "not now". The stage stays unfinished and the same job keeps its id;
  // the successor attempt is materialised by the ordinary capacity path.
  await writeJsonAtomic(path, {
    ...current,
    status: 'WAITING_FOR_CAPACITY',
    attemptStatus: 'WAITING_FOR_CAPACITY',
    statusAt: at,
    // Appended, so a second repair of a different attempt does not erase this.
    reclassifications: [...(current.reclassifications ?? []), repair],
  });

  const retryIntervalMs = Math.max(0, (verdict.resetAt ? Date.parse(verdict.resetAt) : now) - now);
  const runtime = await store.readRuntime();
  const capacity = {
    reason: verdict.to,
    attempt,
    firstSeenAt: evidence.failedAt,
    lastAttemptAt: evidence.failedAt,
    // A reset already in the past makes the retry eligible now. That is the
    // persisted deadline having come and gone, not the policy being skipped.
    nextRetryAt: new Date(now + retryIntervalMs).toISOString(),
    retryIntervalMs,
  };

  await store.writeRuntime({
    ...runtime,
    state: LOOP_STATES.WAITING_FOR_CAPACITY,
    blockedAgent: role,
    blockedJobId: jobId,
    resumeFrom,
    capacity,
    // The stop this repair removes. The reason it happened lives in the event
    // log and in the archived envelope, so clearing the pointer loses nothing.
    humanRequired: null,
    decision: null,
    escalationReason: null,
  });

  await store.appendEvent({
    type: 'FAILURE_RECLASSIFIED',
    goal: runtime?.goal ?? null,
    round: runtime?.round ?? null,
    role,
    jobId,
    attemptId,
    from: verdict.from,
    to: verdict.to,
    reason: repairReason,
    resetAt: verdict.resetAt,
    nextRetryAt: capacity.nextRetryAt,
    evidenceAt: evidence.eventAt,
  });

  // The run stopped for the failure this repair just undid. Nothing else about
  // it changes: same run id, same baseline, same completed Goals.
  let run = null;
  if (autonomousStore) {
    run = await autonomousStore.read();
    if (run?.status === 'PAUSED_FOR_HUMAN' && run.humanRequired?.reason === verdict.from) {
      run = await autonomousStore.write({
        ...run,
        status: 'RUNNING',
        humanRequired: null,
        reclassifiedFrom: { reason: verdict.from, to: verdict.to, at, jobId },
      });
      await store.appendEvent({
        type: 'AUTONOMOUS_RUN_RESUMED',
        autonomousRunId: run.autonomousRunId, reason: 'FAILURE_RECLASSIFIED', jobId,
      });
    }
  }

  return { repair, capacity, verdict, evidence, run };
}

export { CAPACITY_REASONS };
