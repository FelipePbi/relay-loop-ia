/**
 * IA Loop — telling a harness bug apart from a model-driven outcome.
 *
 * A `SpikeError` thrown by `run-goal.mjs` almost always describes something
 * real about the Goal — a worker offline, a policy violation, a contract the
 * model broke. `INVALID_TRANSITION` and `UNKNOWN_STATE` are different in
 * kind: they say the ORCHESTRATOR'S OWN state machine was asked to do
 * something the machine itself refuses, which is never a fact about the
 * Goal — it is a defect in this tooling.
 *
 * Left unclassified, that defect used to surface to `run-auto.mjs` as
 * `UNKNOWN_FATAL`, the same label a genuinely inexplicable model failure gets.
 * The two need different responses: `UNKNOWN_FATAL` invites "try the model
 * again"; a state-machine defect needs a code fix, the way `HARNESS_ERROR`
 * already does for a rejected CLI argv (see harness-retry.mjs). Naming it
 * `HARNESS_ERROR` here reuses that existing, already-understood vocabulary
 * instead of inventing a third label for the same kind of problem.
 */

/**
 * SpikeError codes that can only mean the orchestrator's own state machine
 * usage was wrong — never a fact about the Goal, the worker, or the model.
 *
 * `CONTRACT_FIELD_INVALID` looks like it should belong to the model instead —
 * `validateDeveloperResult`/`validateReviewDecision` throw the very same code
 * for a contract a MODEL broke. But those two are only ever called as
 * `invokeAgent`'s `validatePayload`, which catches everything it throws and
 * folds it into `agentOutcome.error` — it never reaches this catch. The only
 * way `CONTRACT_FIELD_INVALID` (or a sibling like `UNSUPPORTED_JOB_TYPE` or
 * `ROLE_MISMATCH`) gets here is from `validateDeveloperJob`/`validateReviewJob`,
 * called directly in run-goal.mjs on a job THIS PROCESS is building to send
 * OUT — never on anything a model produced. A real incident: reconciliation
 * resumed Goal007 straight into REVIEW (Developer R2 already COMPLETED), but
 * the loop still built a hypothetical CORRECTION job from an empty blocker
 * list to decide whether to reuse it, and `validateDeveloperJob` correctly
 * refused that shape. The refusal was about this tooling's own bookkeeping,
 * not about Goal007, and reporting it as an unrelated stale POLICY_VIOLATION
 * (see run-auto.mjs's fallback) was worse than reporting nothing.
 */
export const ORCHESTRATOR_FAULT_CODES = Object.freeze([
  'INVALID_TRANSITION', 'UNKNOWN_STATE', 'HYDRATION_EVIDENCE_REQUIRED', 'CONTRACT_FIELD_INVALID',
]);

/** Pure: does this error describe an orchestrator-internal defect? */
export function classifyOrchestratorFault(error) {
  if (!error || typeof error.code !== 'string') return null;
  return ORCHESTRATOR_FAULT_CODES.includes(error.code) ? 'HARNESS_ERROR' : null;
}

/**
 * Records the classification, if any, so a caller in another process
 * (`run-auto.mjs`, reading only exit code and disk) can tell this apart from
 * an ordinary escalation.
 *
 * Scoped to the Goal the runtime already names: a fault while resuming Goal
 * 006 must never be attributed to whatever Goal 005 left in `runtime.json`.
 * Silent when the error is not an orchestrator fault, or when `goal` is
 * unknown — this never invents an escalation reason for something else.
 */
export async function recordOrchestratorFault(store, { goal, error }) {
  const classification = classifyOrchestratorFault(error);
  if (!classification || !goal || !store) return { recorded: false, classification };

  const runtime = await store.readRuntime();
  await store.appendEvent({
    type: 'ORCHESTRATOR_FAULT', goal, code: error.code, message: error.message, classification,
  });
  if (runtime?.goal === goal) {
    await store.writeRuntime({ ...runtime, escalationReason: classification });
  }
  return { recorded: true, classification };
}
