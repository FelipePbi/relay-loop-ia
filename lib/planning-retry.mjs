/**
 * IA Loop — when a failed planning attempt is owed another sample.
 *
 * Planning is the one stage whose failure can freeze the whole campaign. A
 * closure that names no next Goal is read as a STOP by
 * `reconcileCampaignPosition` — deliberately, because "planning did not
 * finish" must never be mistaken for "the migration is over" — so whatever
 * stops planning stops the run until a person intervenes.
 *
 * That makes it worth being exact about which failures deserve a retry.
 *
 *   PLAN_INVALID   the inference COMPLETED and the Tech Lead answered; the
 *                  answer violated the contract. A unit id shaped `WU1`
 *                  instead of `WU-001`, a gate declared with no scope. The
 *                  violation is a fact the next prompt can carry, which is
 *                  what makes the retry DIRECTED rather than a reroll — and
 *                  the reason a second sample is likely to be well-formed.
 *
 *   everything     a harness fault, a quota wall, a crashed worker, a model
 *   else           that never answered. None of those are repaired by asking
 *                  the same question again, and each has its own path
 *                  (`harness-retry`, the capacity classifier, `ia-loop:recover`).
 *
 * The distinction was already encoded in `run-close`, but only on the path
 * taken when a PERSON re-ran `ia-loop:close`. The first attempt threw on any
 * failure at all, so the identical violation was retried on a second
 * invocation and stopped the autonomous run on the first. Goal020 ended there:
 * `Work Unit id "WU1" is not in the expected shape`, seven minutes of Opus
 * discarded, HUMAN_REQUIRED, and the campaign position frozen behind it.
 *
 * Pure: no store, no clock, no process. It decides, and the caller acts.
 */

/** What to do about a planning attempt that did not produce a usable plan. */
export const PLANNING_FAILURE_ACTIONS = Object.freeze({
  /** Ask again, carrying the violation as explicit correction context. */
  RETRY_WITH_FEEDBACK: 'RETRY_WITH_FEEDBACK',
  /** Not automatically repairable: the run stops and a person looks. */
  STOP: 'STOP',
});

/**
 * The only contract violation a directed retry can address.
 *
 * Kept as a constant rather than inlined so the one place that decides is
 * greppable from the validator that raises it (`work-units.mjs`).
 */
export const RETRYABLE_PLANNING_CODE = 'PLAN_INVALID';

const stop = (message) => Object.freeze({
  action: PLANNING_FAILURE_ACTIONS.STOP,
  code: null,
  diagnostic: null,
  message,
});

/**
 * Decides what a failed planning attempt is owed.
 *
 * `envelope` is the result envelope recorded for the job. Its `code` is the
 * capacity/failure-taxonomy REASON (typically `UNKNOWN_FATAL`) and NOT the
 * contract code — that lives only on the `AGENT_FAILURE` event, which is also
 * the only place carrying the sanitized diagnostic text a directed retry needs.
 * Passing both is therefore not redundant: one says how the run classified the
 * failure, the other says what the planner actually got wrong.
 *
 * A successful envelope returns STOP rather than throwing: this answers "what
 * is this failure owed", and a non-failure is owed nothing. Callers check
 * `envelope.ok` before asking.
 */
export function classifyPlanningFailure({ envelope = null, failureEvent = null, jobId = null } = {}) {
  const where = jobId ? `Planning job ${jobId}` : 'The planning job';

  if (envelope?.ok === true) return stop(`${where} did not fail; there is nothing to retry.`);

  if (failureEvent?.code !== RETRYABLE_PLANNING_CODE) {
    return stop(
      `${where} did not complete successfully `
      + `(${envelope?.code ?? 'UNKNOWN'}: ${envelope?.message ?? 'no diagnostic recorded'}) `
      + 'and is not an automatically-retryable content violation. Resolve manually.',
    );
  }

  return Object.freeze({
    action: PLANNING_FAILURE_ACTIONS.RETRY_WITH_FEEDBACK,
    code: failureEvent.code,
    // May legitimately be absent: an AGENT_FAILURE is still evidence of the
    // violation even when the diagnostic did not survive sanitisation, and a
    // retry without the text is strictly better than a stop.
    diagnostic: failureEvent.diagnostic ?? null,
    message: `${where} failed ${RETRYABLE_PLANNING_CODE}; retrying with the violation as explicit feedback.`,
  });
}

/**
 * The failure event for a planning job, newest first.
 *
 * A job that was retried has more than one `AGENT_FAILURE` across the run's
 * history; the decision is always about the LAST thing that happened to it.
 */
export function findPlanningFailureEvent(events = [], jobId = null) {
  if (!Array.isArray(events) || !jobId) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'AGENT_FAILURE' && event.jobId === jobId) return event;
  }
  return null;
}
