/**
 * IA Loop — running one inference under capacity control.
 *
 * Wraps a single agent call so that a model limit parks the run instead of
 * ending it. The same model always resumes: there is no fallback path here, by
 * design and by test.
 *
 * The loop is: check for an existing result (idempotency) → call → on failure,
 * classify → decide → either persist a wait and sleep to the deadline, or
 * escalate to a human.
 */

import { SpikeError } from './claude-process.mjs';
import { REROUTE_REASONS } from './model-routing.mjs';
import { CAPACITY_CONFIG } from './capacity-config.mjs';
import { classifyFailure } from './capacity-classifier.mjs';
import { CAPACITY_ACTIONS, decideCapacityAction, formatRemaining } from './capacity-policy.mjs';
import { eventTypeFor, producesCapacityEvent } from './failure-taxonomy.mjs';
import { RETRYABLE_JOB_STATUSES } from './job-store.mjs';
import {
  clearCapacityWait,
  persistCapacityWait,
  persistHumanRequired,
  remainingWaitMs,
} from './capacity-state.mjs';
import { systemClock } from './clock.mjs';
import { routingContext, withUsageContext } from './usage-context.mjs';

export const RUN_OUTCOMES = Object.freeze({
  COMPLETED: 'COMPLETED',
  HUMAN_REQUIRED: 'HUMAN_REQUIRED',
  ALREADY_COMPLETED: 'ALREADY_COMPLETED',
});

/**
 * Ends the current attempt because the ROUTER moved the work, and records why.
 *
 * One implementation for both reasons a model changes mid-job, because both
 * must leave the same trail: the predecessor keeps its status, its model and
 * its result; the successor is a real, separate attempt; and the event log says
 * which model went to which, on what grounds.
 *
 * Nothing here decides anything. The decision arrives already made and already
 * authorised — a worker that wants a stronger model cannot reach this function.
 */
async function rerouteAttempt({
  store, role, jobId, goal, round, attempt, attemptId,
  kind, decision, from, reason, evidence, candidate, agentOutcome, onEvent,
}) {
  // The answer that asked for help is preserved BEFORE the attempt is closed,
  // so a crash between the two leaves the payload readable rather than lost.
  if (candidate) {
    await store.publishCandidateResult(role, jobId, {
      requestedModel: agentOutcome?.requestedModel ?? null,
      modelVerificationError: null,
      observedModels: agentOutcome?.observedModels ?? [],
      payload: candidate,
    }, { attemptId });
  }

  await store.setJobStatus(role, jobId, 'REROUTED');
  await store.appendEvent({
    type: kind === REROUTE_REASONS.MODEL_ESCALATION ? 'MODEL_ESCALATED' : 'MODEL_FALLBACK',
    goal,
    round,
    agent: role,
    jobId,
    attemptId,
    attempt,
    from: from ?? null,
    to: decision.modelKey,
    model: decision.model,
    effort: decision.effort,
    reason,
    // Short and concrete: what the request was believed on. Never prose.
    evidence: (evidence ?? []).slice(0, 5).map((item) => String(item).slice(0, 200)),
  });
  onEvent({
    type: kind === REROUTE_REASONS.MODEL_ESCALATION ? 'MODEL_ESCALATED' : 'MODEL_FALLBACK',
    jobId, attempt, from: from ?? null, to: decision.modelKey, reason,
  });
}

/**
 * Executes one agent call, waiting out capacity limits.
 *
 * `invoke()` performs the actual inference and returns an invokeAgent-shaped
 * outcome. It is injected so tests can exercise every policy branch without
 * spending quota.
 *
 * `onEvent` receives sanitized progress notifications for the terminal.
 *
 * `router` is optional and, when given, may move the work to a DIFFERENT MODEL
 * rather than waiting or failing:
 *
 *   fallbackFor({ reason, code, attempt })   availability only — a quota, a
 *                                            rate limit, a model that is not
 *                                            there. Never a harness bug.
 *   escalationFor({ result, attempt })       a structurally valid result that
 *                                            asked for a stronger model, with
 *                                            evidence the router believed.
 *
 * Both return a routing decision or null, and BOTH produce a successor attempt
 * through the same machinery a retry uses: the predecessor keeps its identity,
 * its model and its place in the history. Nothing is rewritten.
 */
export async function runWithCapacity({
  store,
  role,
  jobId,
  goal,
  round,
  resumeFrom,
  invoke,
  router = null,
  clock = systemClock(),
  config = CAPACITY_CONFIG,
  onEvent = () => {},
  maxWaits = Infinity,
  /**
   * The AGENT the persisted runtime records as blocked.
   *
   * Normally the same as `role`, and defaulted to it. They come apart for a
   * Work Unit: `role` is the store namespace the unit's job lives in, but the
   * thing that is actually blocked — that holds the lease, that a human would
   * go and look at, that `resumeFrom` describes — is the Developer worker the
   * unit is running inside. Writing `work_unit` into `blockedAgent` would name
   * a process nobody can find.
   */
  blockedAgent = role,
  /**
   * A structurally valid answer that is nevertheless NOT the stage's answer,
   * and that owes a successor attempt on the SAME model.
   *
   * Exactly one caller today: a Work Unit reporting CONTEXT_EXPANSION_REQUIRED.
   * The unit answered under contract; it simply says the context it was
   * deliberately given was too narrow and names what is missing. Publishing
   * that as the unit's result would record "the unit is done" for a unit that
   * did nothing, and the next reader would believe it.
   *
   * Deliberately shaped like `router.escalationFor`: return null to publish
   * normally, or `{ reason, detail, candidate }` to end this attempt and let a
   * successor run. The difference between the two hooks is the whole point —
   * one changes the model, this one changes the CONTEXT — and keeping them
   * apart is what makes the telemetry able to tell "the tier was too low" from
   * "the slice was too narrow".
   */
  continuationFor = null,
  /**
   * An answer that asked for a model the table does not have above it.
   *
   * The third hook, and the one that changes LEAST: `escalationFor` changes
   * the model, `continuationFor` changes the context, and this one changes
   * neither. It changes what the unit knows — that no stronger model is
   * coming — and gives it one more attempt on the same model to deliver what
   * it can and declare the rest as unmet criteria.
   *
   * It exists because the alternative was measured. In Goal019 one refusal at
   * the top of the table published ESCALATION_REQUIRED as a COMPLEX unit's
   * answer; eight of the round's fifteen units were behind it and ended with
   * zero attempts, six of them gates. Refusing the request is right — there
   * IS nothing above COMPLEX — but ending the unit over it threw away work
   * the unit had already done and everything downstream of it.
   *
   * Same shape as the other two: null to publish normally, or
   * `{ reason, detail, event }` to end this attempt and let a successor run.
   */
  finalAttemptFor = null,
  /**
   * Extra ia-loop facts the ledger should attribute this call to, for whatever
   * only the caller knows. One caller today: a Work Unit, which is the only
   * thing here that has an id the runner cannot see. Never influences routing,
   * prompts or execution.
   */
  usageContext = {},
}) {
  if (!store) throw new SpikeError('INVALID_ARGS', 'store is required');
  if (!jobId) throw new SpikeError('INVALID_ARGS', 'jobId is required');
  if (typeof invoke !== 'function') throw new SpikeError('INVALID_ARGS', 'invoke must be a function');

  // Idempotency, checked BEFORE anything else: if a previous attempt already
  // produced a result for this job, the model must not be called again.
  if (await store.hasCompletedResult(role, jobId)) {
    const existing = await store.readResult(role, jobId);
    onEvent({ type: 'ALREADY_COMPLETED', jobId });
    return { outcome: RUN_OUTCOMES.ALREADY_COMPLETED, result: existing?.result ?? null, attempts: 0 };
  }

  let attempt = 0;
  let waits = 0;
  let capacityWaits = 0;
  // What ended the previous attempt, carried into the successor's history.
  let pendingRetry = null;

  for (;;) {
    // Honour a deadline persisted by an earlier process: a restart must not
    // retry sooner than the state says.
    const runtime = await store.readRuntime();
    if (runtime?.blockedJobId === jobId) {
      const remaining = remainingWaitMs(runtime, clock.now());
      if (remaining > 0) {
        onEvent({
          type: 'CAPACITY_WAIT_RESUMED_FROM_DISK',
          jobId,
          reason: runtime.capacity?.reason,
          remaining: formatRemaining(remaining),
        });
        await clock.sleep(remaining);
      }
    }

    attempt += 1;

    // Every real call to the model is its own attempt.
    //
    // Before this, a capacity retry re-entered the SAME attempt: one attemptId
    // covered a call that hit a quota wall and a later call that did the work,
    // so result fencing could not tell them apart and the history showed one
    // try where there had been two. The stage and the job stay exactly as they
    // were — what a retry creates is a successor attempt, nothing else.
    const before = await store.readAttemptState(role, jobId);
    if (before && RETRYABLE_JOB_STATUSES.includes(before.attemptStatus)) {
      const started = await store.startNextAttempt(role, jobId, {
        reason: pendingRetry?.reason ?? before.attemptStatus,
        detail: pendingRetry?.detail ?? null,
      });
      if (started.created) {
        await store.appendEvent({
          type: 'JOB_ATTEMPT_STARTED',
          goal, round, agent: role, jobId,
          attempt: started.attempt,
          attemptId: started.attemptId,
          previousAttemptId: started.previousAttemptId,
          reason: pendingRetry?.reason ?? before.attemptStatus,
        });
      }
    }
    // What ended the PREVIOUS attempt is what this one exists for, so it is
    // read before the slot is cleared: a successor created by a capacity
    // fallback or an authorised escalation must be recorded as such, not as a
    // plain retry that happened to run on a different model.
    const attemptOrigin = pendingRetry;
    pendingRetry = null;

    await store.setJobStatus(role, jobId, 'RUNNING');

    // Read AFTER the attempt has been materialised and the job marked RUNNING,
    // so it is the attempt this invocation actually belongs to. Every result
    // published below is fenced by it.
    const currentAttemptId = (await store.readAttemptState(role, jobId))?.attemptId ?? null;

    // Recorded here rather than in each worker: the audit answer to "why this
    // model?" must exist for every routed call, and a second place to emit it
    // is a second place to forget.
    let activeRouting = null;
    if (router?.current) {
      const { routing } = await router.current();
      activeRouting = routing ?? null;
      if (routing) {
        await store.appendEvent({
          type: 'MODEL_ROUTED',
          goal, round, agent: role, jobId, attempt, attemptId: currentAttemptId,
          stage: routing.stage ?? null,
          complexity: routing.complexity ?? null,
          riskScore: routing.riskScore ?? null,
          selectedModel: routing.modelKey,
          effort: routing.effort ?? null,
          reason: routing.reason ?? null,
          signals: [...(routing.signals ?? [])],
          mode: routing.mode ?? null,
        });
      }
    }

    // The ledger's identity half, published around the call rather than passed
    // into it. `invokeAgent` records the row; this is the only place that knows
    // which Goal, round, job and attempt the call belongs to, and what the
    // router decided. Purely observational: `invoke` is called exactly as it
    // was, with the same argument, in the same order.
    const agentOutcome = await withUsageContext({
      goalId: goal ?? null,
      roundId: Number.isFinite(round) ? round : null,
      jobId,
      attemptId: currentAttemptId,
      attempt,
      // The worker that actually ran it. For a Work Unit these differ: `role`
      // is the store namespace, `blockedAgent` is the Developer it ran inside.
      role: blockedAgent,
      namespace: role,
      ...routingContext(activeRouting),
      isFallback: attemptOrigin?.reason === REROUTE_REASONS.MODEL_FALLBACK,
      fallbackFromModel: attemptOrigin?.reason === REROUTE_REASONS.MODEL_FALLBACK
        ? attemptOrigin.detail?.fromModel ?? null
        : null,
      fallbackReason: attemptOrigin?.reason === REROUTE_REASONS.MODEL_FALLBACK
        ? attemptOrigin.detail?.classification ?? null
        : null,
      isEscalation: attemptOrigin?.reason === REROUTE_REASONS.MODEL_ESCALATION,
      escalationFromModel: attemptOrigin?.reason === REROUTE_REASONS.MODEL_ESCALATION
        ? attemptOrigin.detail?.fromModel ?? null
        : null,
      escalationReason: attemptOrigin?.reason === REROUTE_REASONS.MODEL_ESCALATION
        ? attemptOrigin.detail?.escalationReason ?? null
        : null,
      ...usageContext,
    }, () => invoke({ attempt }));

    const failed = Boolean(agentOutcome?.error) || !agentOutcome?.structuredOutput;

    // The model answered, under contract, and asked for a stronger one. That
    // is not a failure and must not be published as the stage's answer: the
    // request is judged by the router, and a granted one becomes a successor
    // attempt on the escalated model.
    if (!failed && router?.escalationFor) {
      const escalation = await router.escalationFor({
        result: agentOutcome.payload, attempt, permissionDenials: agentOutcome.permissionDenials,
      });
      if (escalation) {
        await rerouteAttempt({
          store, role, jobId, goal, round, attempt, attemptId: currentAttemptId,
          kind: REROUTE_REASONS.MODEL_ESCALATION,
          decision: escalation.decision,
          from: escalation.from ?? null,
          reason: escalation.reason,
          evidence: escalation.evidence ?? [],
          // The answer that asked for help is kept in full, auditable and
          // recoverable, next to the attempt that produced it.
          candidate: agentOutcome.payload,
          agentOutcome,
          onEvent,
        });
        pendingRetry = {
          reason: REROUTE_REASONS.MODEL_ESCALATION,
          detail: {
            role,
            escalationReason: escalation.reason,
            routedTo: escalation.routed,
            fromModel: escalation.from ?? null,
          },
        };
        continue;
      }
    }

    // Reachable only when the escalation hook refused, which is what makes it
    // safe: a request the router GRANTED has already left through `continue`
    // above, so nothing here can turn an authorised escalation into a retry on
    // the model the unit was trying to leave.
    if (!failed && typeof finalAttemptFor === 'function') {
      const final = await finalAttemptFor({ result: agentOutcome.payload, attempt });
      if (final) {
        // Preserved before the attempt closes, for the same reason a reroute
        // and an expansion preserve theirs: a crash between the two must leave
        // the answer readable rather than lost.
        await store.publishCandidateResult(role, jobId, {
          requestedModel: agentOutcome?.requestedModel ?? null,
          modelVerificationError: null,
          observedModels: agentOutcome?.observedModels ?? [],
          payload: agentOutcome.payload,
        }, { attemptId: currentAttemptId });

        await store.setJobStatus(role, jobId, 'CEILING_DECLARED');
        await store.appendEvent({
          type: 'WORK_UNIT_CEILING_DECLARED',
          goal, round, agent: role, jobId, attempt, attemptId: currentAttemptId,
          reason: final.reason ?? null,
          ...(final.event ?? {}),
        });
        onEvent({ type: 'CEILING_DECLARED', jobId, attempt, reason: final.reason ?? null });

        pendingRetry = { reason: 'CEILING_DECLARED', detail: final.detail ?? null };
        continue;
      }
    }

    // Checked AFTER the escalation hook, and that order is deliberate: a unit
    // that both cannot proceed and needs a stronger model has really asked for
    // the stronger model, and answering it with more files would spend an
    // attempt learning nothing.
    if (!failed && typeof continuationFor === 'function') {
      const continuation = await continuationFor({ result: agentOutcome.payload, attempt });
      if (continuation) {
        // The answer is preserved BEFORE the attempt is closed, exactly as a
        // reroute preserves the answer that asked for help: a crash between
        // the two must leave the payload readable rather than lost.
        await store.publishCandidateResult(role, jobId, {
          requestedModel: agentOutcome?.requestedModel ?? null,
          modelVerificationError: null,
          observedModels: agentOutcome?.observedModels ?? [],
          payload: agentOutcome.payload,
        }, { attemptId: currentAttemptId });

        await store.setJobStatus(role, jobId, 'CONTEXT_EXPANDED');
        await store.appendEvent({
          type: 'WORK_UNIT_CONTEXT_EXPANDED',
          goal, round, agent: role, jobId, attempt, attemptId: currentAttemptId,
          reason: continuation.reason ?? null,
          ...(continuation.event ?? {}),
        });
        onEvent({ type: 'CONTEXT_EXPANDED', jobId, attempt, reason: continuation.reason ?? null });

        pendingRetry = { reason: 'CONTEXT_EXPANDED', detail: continuation.detail ?? null };
        continue;
      }
    }

    if (!failed) {
      await store.publishResult(role, jobId, { ok: true, result: agentOutcome.payload }, {
        attemptId: currentAttemptId,
      });
      await store.setJobStatus(role, jobId, 'COMPLETED');

      // Only a genuine capacity wait ends with a capacity event. A retry after
      // an unexplained transient failure is not the quota coming back.
      if (capacityWaits > 0) {
        await store.appendEvent({ type: 'CAPACITY_AVAILABLE', goal, round, agent: role, jobId, attempt });
        await store.appendEvent({ type: 'CAPACITY_WAIT_ENDED', goal, round, agent: role, jobId, attempt });
        onEvent({ type: 'CAPACITY_AVAILABLE', jobId, attempt });
      } else if (waits > 0) {
        await store.appendEvent({ type: 'AGENT_RETRY_SUCCEEDED', goal, round, agent: role, jobId, attempt });
        onEvent({ type: 'AGENT_RETRY_SUCCEEDED', jobId, attempt });
      }
      await clearCapacityWait(store, { state: resumeFrom, now: clock.now() });
      return { outcome: RUN_OUTCOMES.COMPLETED, result: agentOutcome.payload, attempts: attempt };
    }

    const classification = classifyFailure(agentOutcome, { now: clock.now() });
    const decision = decideCapacityAction({
      reason: classification.reason,
      attempt,
      retryAfterMs: classification.retryAfterMs,
      now: clock.now(),
      config,
    });

    // The event is named by the taxonomy, not by a local ternary.
    //
    // The ternary this replaces knew only "harness or capacity", so every other
    // family — an unexplained fatal, a contract slip — was logged as
    // CAPACITY_LIMIT_REACHED. The real history carries four of those, each one
    // a claim that a model limit was hit when none was. failure-taxonomy exists
    // precisely to stop that, and now it is the thing that decides.
    const isCapacity = producesCapacityEvent({ code: classification.code, reason: decision.reason });
    await store.appendEvent({
      type: eventTypeFor({ code: classification.code, reason: decision.reason }),
      goal,
      round,
      agent: role,
      jobId,
      attemptId: currentAttemptId,
      reason: decision.reason,
      code: classification.code,
      attempt,
      // Sanitized and truncated by the classifier; never the full response.
      diagnostic: classification.diagnostic,
    });

    // Availability, not correctness: a quota window closing is a reason to run
    // the SAME work on another model, and a harness bug never is. The router
    // owns that distinction; the runner only asks. Checked before the wait, so
    // a weekly Fable limit does not park a pipeline that Opus could finish.
    if (router?.fallbackFor) {
      const fallback = await router.fallbackFor({
        reason: classification.reason, code: classification.code, attempt,
      });
      if (fallback) {
        await rerouteAttempt({
          store, role, jobId, goal, round, attempt, attemptId: currentAttemptId,
          kind: REROUTE_REASONS.MODEL_FALLBACK,
          decision: fallback.decision,
          from: fallback.from ?? null,
          reason: classification.reason,
          evidence: [],
          candidate: null,
          agentOutcome,
          onEvent,
        });
        pendingRetry = {
          reason: REROUTE_REASONS.MODEL_FALLBACK,
          detail: {
            role,
            classification: classification.reason,
            code: classification.code,
            routedTo: fallback.routed,
            fromModel: fallback.from ?? null,
          },
        };
        continue;
      }
    }

    if (decision.action === CAPACITY_ACTIONS.HUMAN_REQUIRED) {
      await store.setJobStatus(role, jobId, 'FAILED');
      await persistHumanRequired(store, {
        blockedAgent,
        reason: decision.reason,
        note: decision.note,
        jobId,
        now: clock.now(),
      });

      // The CLI may have already answered correctly: model-identity
      // verification failing is not evidence the payload itself was bad. When
      // invokeAgent kept a structurally-valid candidate, preserve it
      // alongside the FAILED result — an audit trail a harness fix can read
      // back later, never something published as trusted on its own.
      if (agentOutcome?.candidatePayload) {
        await store.publishCandidateResult(role, jobId, {
          requestedModel: agentOutcome.requestedModel ?? null,
          modelVerificationError: agentOutcome.error ?? null,
          observedModels: agentOutcome.observedModels ?? [],
          payload: agentOutcome.candidatePayload,
        }, { attemptId: currentAttemptId });
      }

      await store.publishResult(role, jobId, {
        ok: false,
        code: decision.reason,
        message: decision.note ?? 'Escalated to a human.',
        escalation: 'HUMAN_REQUIRED',
      }, { attemptId: currentAttemptId });
      await store.appendEvent({ type: 'HUMAN_REQUIRED', goal, round, agent: role, jobId, reason: decision.reason });
      onEvent({ type: 'HUMAN_REQUIRED', jobId, reason: decision.reason, note: decision.note });

      return { outcome: RUN_OUTCOMES.HUMAN_REQUIRED, reason: decision.reason, note: decision.note, attempts: attempt };
    }

    // WAIT: persist first, then sleep. If the process dies during the sleep,
    // the deadline is already on disk and the restart honours it.
    await store.setJobStatus(role, jobId, 'WAITING_FOR_CAPACITY');
    await persistCapacityWait(store, {
      goal,
      round,
      blockedAgent,
      resumeFrom,
      jobId,
      decision,
      now: clock.now(),
    });

    if (isCapacity) {
      if (capacityWaits === 0) {
        await store.appendEvent({ type: 'CAPACITY_WAIT_STARTED', goal, round, agent: role, jobId, reason: decision.reason });
      }
      capacityWaits += 1;
    }
    waits += 1;

    // Handed to the successor attempt so its history says why it exists.
    pendingRetry = {
      reason: decision.reason,
      detail: {
        classification: classification.reason,
        code: classification.code,
        retryReason: decision.reason,
        nextRetryAt: decision.nextRetryAt,
        capacityWait: isCapacity,
        role,
      },
    };

    onEvent({
      type: 'CAPACITY_WAIT',
      jobId,
      reason: decision.reason,
      attempt,
      nextRetryAt: decision.nextRetryAt,
      remaining: formatRemaining(decision.retryIntervalMs),
      resumeFrom,
    });

    if (waits > maxWaits) {
      // Test/diagnostic escape hatch only; production runs pass Infinity.
      throw new SpikeError('CAPACITY_WAIT_LIMIT', `Exceeded ${maxWaits} capacity waits for job ${jobId}`);
    }

    await store.appendEvent({
      type: isCapacity ? 'CAPACITY_RETRY' : 'AGENT_RETRY',
      goal, round, agent: role, jobId, attempt, reason: decision.reason, nextRetryAt: decision.nextRetryAt,
    });
    await clock.sleep(decision.retryIntervalMs);
  }
}
