/**
 * IA Loop — the ia-loop identity a model call runs under.
 *
 * The usage ledger has to answer "who called, why, in which Goal/Stage/Attempt"
 * for a call made deep inside `invokeAgent`, which knows none of that. The
 * alternative — threading eight more parameters through every worker, every
 * router and the persistent session — is exactly how a call gets added later
 * WITHOUT telemetry: whoever forgets one parameter simply loses the trail.
 *
 * So the context is ambient instead. Whoever knows the facts (the capacity
 * runner, which owns the attempt) publishes them around the call; the recording
 * point reads whatever is in force. A call made outside any context still gets
 * a row — with nulls and `operation = UNKNOWN` — because an unattributed
 * inference that is RECORDED is a bug we can see, and one that is skipped is a
 * bug we cannot.
 *
 * Nothing here influences a prompt, a model, or an argument vector.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What a model call is doing, derived from the routing stage the ia-loop
 * already decided. Never inferred from prose, never asked of a model.
 */
export const USAGE_OPERATIONS = Object.freeze({
  PLANNING: 'planning',
  IMPLEMENTATION: 'implementation',
  CORRECTION: 'correction',
  REVIEW: 'review',
  WORK_UNIT: 'work_unit',
  CLOSURE_DOCUMENTATION: 'closure_documentation',
  /**
   * A shadow-benchmark call (Goal 013's `lib/benchmark.mjs`) — real tokens,
   * deliberately never a production stage. `run-metrics.mjs` excludes this
   * operation from its default population, exactly BECAUSE it is a
   * recognised category rather than an unattributed one: an operational
   * report must never quietly include a comparison run in its totals.
   */
  BENCHMARK: 'benchmark',
  /** A real inference we could not attribute to a stage. Never silently dropped. */
  UNKNOWN: 'UNKNOWN',
});

/**
 * The sub-phase vocabulary the ledger is prepared for.
 *
 * Deliberately unused by the collector today: no worker can currently tell,
 * deterministically, whether a Developer call was analysing, implementing or
 * debugging, and guessing would put fabricated data in a ledger whose whole
 * point is that it does not contain any. Everything is recorded as UNKNOWN
 * until something in the harness can prove otherwise.
 */
export const USAGE_PHASES = Object.freeze([
  'planning.analysis',
  'planning.finalization',
  'development.analysis',
  'development.implementation',
  'development.testing',
  'development.debugging',
  'development.validation',
  'review.analysis',
  'review.validation',
  'review.finalization',
  'UNKNOWN',
]);

export const UNKNOWN_PHASE = 'UNKNOWN';

/** Routing stage → operation. One table, so nobody re-derives it by hand. */
const STAGE_TO_OPERATION = Object.freeze({
  planning: USAGE_OPERATIONS.PLANNING,
  review: USAGE_OPERATIONS.REVIEW,
  implementation: USAGE_OPERATIONS.IMPLEMENTATION,
  correction: USAGE_OPERATIONS.CORRECTION,
  work_unit: USAGE_OPERATIONS.WORK_UNIT,
  closure: USAGE_OPERATIONS.CLOSURE_DOCUMENTATION,
  benchmark: USAGE_OPERATIONS.BENCHMARK,
});

export function operationForStage(stage) {
  return STAGE_TO_OPERATION[stage] ?? USAGE_OPERATIONS.UNKNOWN;
}

const storage = new AsyncLocalStorage();

/**
 * Facts that hold for the whole process rather than for one call: which project
 * this is, which autonomous run (when there is one), which worker.
 *
 * Set once at startup. Merged UNDER the per-call context, so a call-scoped
 * value always wins.
 */
let base = Object.freeze({});

export function setBaseUsageContext(next) {
  base = Object.freeze({ ...base, ...(next ?? {}) });
  return base;
}

export function baseUsageContext() {
  return base;
}

/** Test seam. Production never needs to forget what it learned at startup. */
export function resetBaseUsageContext() {
  base = Object.freeze({});
}

/**
 * Runs `fn` with `context` in force for every await inside it.
 *
 * Merges with any enclosing context rather than replacing it, so an inner scope
 * can add the attempt without having to restate the Goal.
 */
export function withUsageContext(context, fn) {
  const merged = { ...(storage.getStore() ?? {}), ...(context ?? {}) };
  return storage.run(merged, fn);
}

/** The context in force, base facts included. Always an object. */
export function currentUsageContext() {
  return { ...base, ...(storage.getStore() ?? {}) };
}

/**
 * The routing facts a decision record carries, flattened for the ledger.
 *
 * Accepts either the record a job carries (`toJobRouting`) or the runtime
 * decision, because both shapes are the same fields under the same names.
 */
export function routingContext(routing) {
  if (!routing || typeof routing !== 'object') return {};
  return {
    stage: routing.stage ?? null,
    modelKey: routing.modelKey ?? null,
    modelFamily: routing.family ?? null,
    requestedModel: routing.model ?? null,
    effort: routing.effort ?? null,
    complexity: routing.complexity ?? null,
    riskScore: Number.isFinite(routing.riskScore) ? routing.riskScore : null,
    routingReason: routing.reason ?? null,
    routingSignals: Array.isArray(routing.signals) ? [...routing.signals] : [],
    routingMode: routing.mode ?? null,
  };
}
