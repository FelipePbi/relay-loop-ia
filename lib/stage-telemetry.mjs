/**
 * IA Loop — stage telemetry coverage, model applicability, and the
 * observational per-model stage breakdown (Goal 015 §20-23).
 *
 * Deliberately NOT an effectiveness ranking: this Goal verifies coverage and
 * correlation, and explicitly stops short of concluding which model is
 * "better" at planning/review/closure — that is the next Goal's job, once
 * the correct unit of analysis (this one) exists to build it on.
 */

import {
  groupIntoStageExecutions, indexStageOutcomeEvents, attributeStageOutcome,
  isStageOperation, stageTypeOfOperation, CORRELATION_QUALITY, STAGE_OUTCOMES,
} from './stage-execution.mjs';
import { resolveCanonicalModel } from './pricing-registry.mjs';

function canonicalOf(row) {
  return resolveCanonicalModel(row.resolved_model ?? row.requested_model) ?? (row.resolved_model ?? row.requested_model ?? 'UNKNOWN');
}

/**
 * Coverage of the stage-execution correlation itself — Goal 015 §20. Every
 * count here is a fact about HOW MUCH of the ledger this module could
 * correlate, never about how "good" any model is.
 */
export function computeStageTelemetryCoverage(rows, events) {
  const executions = groupIntoStageExecutions(rows);
  const outcomeEventsByJobId = indexStageOutcomeEvents(events);

  const withTerminalStatus = executions.filter((e) => e.stageResolutionSuccess !== null).length;
  const attributed = executions.map((e) => attributeStageOutcome(e, outcomeEventsByJobId));
  const withStageOutcome = attributed.filter((a) => a.outcome !== STAGE_OUTCOMES.UNKNOWN).length;
  const withRoundCorrelation = executions.filter((e) => e.goalId !== null && e.roundId !== null).length;

  const correlationQuality = { [CORRELATION_QUALITY.EXACT]: 0, [CORRELATION_QUALITY.LEGACY_RECONSTRUCTED]: 0, [CORRELATION_QUALITY.UNATTRIBUTED]: 0 };
  for (const execution of executions) correlationQuality[execution.correlationQuality] += 1;

  return {
    stageExecutions: executions.length,
    withInvocationLinks: executions.filter((e) => e.rows.length > 0).length,
    withTerminalStatus,
    withStageOutcome,
    withRoundCorrelation,
    correlationQuality,
  };
}

/**
 * Which "unit of analysis" a metric belongs to, and whether a model can be
 * measured by it AT ALL — distinct from whether the SAMPLE is big enough.
 *
 * `NOT_APPLICABLE`   the model has ZERO calls in the scope this metric
 *                    measures (e.g. Fable + a Work-Unit-scoped metric — it
 *                    never runs one). No amount of additional data changes
 *                    this; it is a structural fact about what the model does.
 * `INSUFFICIENT_DATA` the model DOES operate in that scope, just not enough
 *                    (yet) to trust the number — more data COULD resolve this.
 * `APPLICABLE`       enough same-scope calls exist to compute the metric.
 *
 * Never used to justify a routing or ranking conclusion (Goal 015 §24) —
 * only to keep a report from silently measuring the wrong thing.
 */
const WORK_UNIT_SCOPED_METRICS = new Set([
  'costPerSuccessfulWorkUnit', 'costPerAcceptedWorkUnit', 'tokensPerAcceptedWorkUnit',
  'callsPerAcceptedWorkUnit', 'firstPassSuccessRate', 'workUnitRetryRate', 'workUnitRepairRate',
]);
const STAGE_SCOPED_METRICS = new Set([
  'reviewStageResolution', 'planningStageResolution', 'closureStageResolution',
  'repairStageResolution', 'stageRetryRate', 'stageFallbackRate', 'stageOutcome',
]);

export function metricApplicability(metric, { workUnitCallCount = 0, stageCallCount = 0, minSample = 5 } = {}) {
  if (WORK_UNIT_SCOPED_METRICS.has(metric)) {
    if (workUnitCallCount === 0) return 'NOT_APPLICABLE';
    return workUnitCallCount >= minSample ? 'APPLICABLE' : 'INSUFFICIENT_DATA';
  }
  if (STAGE_SCOPED_METRICS.has(metric)) {
    if (stageCallCount === 0) return 'NOT_APPLICABLE';
    return stageCallCount >= minSample ? 'APPLICABLE' : 'INSUFFICIENT_DATA';
  }
  // An unrecognised metric name is conservatively NOT_APPLICABLE, never
  // silently APPLICABLE — a typo in a metric name must not manufacture a
  // false-positive "yes, measurable".
  return 'NOT_APPLICABLE';
}

/**
 * Per-model call counts by stage type, PLUS the Work Unit call count for the
 * same model — side by side, specifically so a report can show "Fable: 0
 * Work Unit calls, 21 stage calls" in one place (Goal 015 §21) rather than
 * requiring two separate reports to notice the gap.
 */
export function computeStageCallsByModel(rows, { workUnitCallCounts = {} } = {}) {
  const byModel = {};
  for (const row of rows) {
    if (!isStageOperation(row.operation)) continue;
    const model = canonicalOf(row);
    const stageType = stageTypeOfOperation(row.operation);
    byModel[model] = byModel[model] ?? {
      model, workUnitCalls: workUnitCallCounts[model] ?? 0, stageCalls: 0,
      planning: 0, review: 0, repair: 0, closure: 0,
      capacityFailures: 0, qualityFailures: 0,
    };
    byModel[model].stageCalls += 1;
    byModel[model][stageType.toLowerCase()] += 1;
    if (row.status === 'FAILED') {
      const relevant = row.failure_family === 'AGENT_CONTRACT';
      const capacity = row.failure_family === 'MODEL_CAPACITY' || row.timed_out === 1 || row.timed_out === true;
      if (capacity) byModel[model].capacityFailures += 1;
      else if (relevant) byModel[model].qualityFailures += 1;
    }
  }
  // Models that only ever appear in Work Units (workUnitCallCounts) but never
  // in a stage still deserve a row, with stageCalls explicitly 0 — never
  // omitted, so "this model has no stage presence" is a visible fact.
  for (const [model, count] of Object.entries(workUnitCallCounts)) {
    if (!byModel[model]) {
      byModel[model] = {
        model, workUnitCalls: count, stageCalls: 0, planning: 0, review: 0, repair: 0, closure: 0,
        capacityFailures: 0, qualityFailures: 0,
      };
    }
  }
  return byModel;
}
