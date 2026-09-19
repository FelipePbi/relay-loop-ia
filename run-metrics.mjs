#!/usr/bin/env node
/**
 * IA Loop — savings & counterfactual analytics on top of the usage ledger.
 *
 *   npm run ia-loop:metrics
 *   npm run ia-loop:metrics -- --goal 010
 *   npm run ia-loop:metrics -- --goal 010 --json
 *   npm run ia-loop:metrics -- --goal 010 --pricing-snapshot claude-ledger-calibrated-2026-09
 *   npm run ia-loop:metrics -- --goal 010 --group-by operation
 *   npm run ia-loop:metrics -- --goal 010 --deterministic-savings   (verbose ESTIMATED evidence)
 *   npm run ia-loop:metrics -- --goal 010 --baseline legacy         (verbose LEGACY_MONOLITHIC evidence)
 *
 * Three classes of number, and every one of them says which it is:
 *
 *   OBSERVED    directly recorded by the runtime (tokens, models, cache,
 *               provider cost, failures/retries/fallbacks/escalations,
 *               deterministic Work Units, model calls, duration, context
 *               size). Reused verbatim from `run-usage.mjs` and `events.jsonl`
 *               — this file invents none of it.
 *
 *   CALCULATED  deterministic arithmetic over OBSERVED data under an
 *               explicit, versioned, PROVENANCE-labelled pricing snapshot
 *               (`lib/pricing-registry.mjs`, `lib/pricing-engine.mjs`,
 *               `lib/cost-baselines.mjs`, `lib/model-outcomes.mjs`). ALL_OPUS
 *               reprices the SAME observed tokens; it never guesses how many
 *               tokens a different model would have produced.
 *
 *   ESTIMATED   requires inferring behaviour that never happened: how many
 *               tokens a deterministic Work Unit would have used on a model
 *               (`lib/deterministic-savings.mjs`, matched against comparable
 *               history — `lib/work-unit-matching.mjs`), or comparing to a
 *               pre-Work-Unit Goal (`lib/legacy-baseline.mjs`). Every
 *               ESTIMATED figure carries its own method, sample size,
 *               confidence and a lower/central/upper range — never a single
 *               point number, and `INSUFFICIENT_DATA`/`BASELINE_REQUIRED` are
 *               reported honestly rather than invented.
 *
 * Read-only, like `run-usage.mjs`: it opens the ledger, reads `events.jsonl`,
 * computes, and prints. Zero model calls, zero writes to the ledger. Rows
 * tagged `operation: 'benchmark'` (Goal 013's shadow benchmark, `lib/benchmark.mjs`)
 * are excluded from the default population — this is an OPERATIONAL report,
 * not a benchmark result.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SpikeError } from './lib/claude-process.mjs';
import { LEDGER_STATUS, openUsageLedger } from './lib/usage-ledger.mjs';
import { defaultLedgerPath } from './lib/usage-collector.mjs';
import { isDirectExecution } from './lib/direct-execution.mjs';
import { buildUsageQuery, summarise, summariseWorkUnits } from './run-usage.mjs';
import {
  computeCostBaselines, computeEfficiency, savingsBreakdown, modelRoutingBreakdown,
} from './lib/cost-baselines.mjs';
import { DEFAULT_PRICING_SNAPSHOT_ID, getPricingSnapshot, resolveCanonicalModel } from './lib/pricing-registry.mjs';
import { groupIntoWorkUnits, percentileStats } from './lib/historical-distributions.mjs';
import { estimateDeterministicSavings } from './lib/deterministic-savings.mjs';
import { legacyMonolithicBaseline, legacyContextBaseline } from './lib/legacy-baseline.mjs';
import { computeModelOutcomes, costPerSuccessfulWorkUnit } from './lib/model-outcomes.mjs';
import { combineArchitectureSavings, describeSavingsDelta } from './lib/architecture-savings.mjs';
import {
  computeModelEffectiveness, detectCohortImbalance, computeResolutionChains,
  computeEscalationROI, computeRetryROI, computeTerminalFailureCost,
} from './lib/model-effectiveness.mjs';
import { computeStageTelemetryCoverage, computeStageCallsByModel } from './lib/stage-telemetry.mjs';
import { createJobStore } from './lib/job-store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, '.state');

/** Fields a `--group-by` value may pick, mapped to the ledger column it reads. */
const GROUP_BY_FIELDS = Object.freeze({
  goal: (row) => row.goal_id,
  run: (row) => row.run_id,
  round: (row) => row.round_id,
  role: (row) => row.role,
  operation: (row) => row.operation,
  stage: (row) => row.stage,
  workUnit: (row) => row.work_unit_id,
  model: (row) => row.resolved_model ?? row.requested_model,
});

export function parseMetricsArgs(argv) {
  const args = argv.slice(2);
  const valueOf = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] ?? null : null;
  };
  const limit = Number(valueOf('--limit'));
  const groupBy = valueOf('--group-by');
  return {
    goal: valueOf('--goal'),
    run: valueOf('--run'),
    job: valueOf('--job'),
    model: valueOf('--model'),
    role: valueOf('--role'),
    // Analytics must aggregate the WHOLE filtered population, never a display
    // page of it — a silently truncated total would misreport every number
    // downstream of it. `ia-loop:usage`'s 200-row default is right for a
    // table you read; wrong for a sum you trust.
    limit: Number.isInteger(limit) && limit > 0 ? limit : 1_000_000,
    json: args.includes('--json'),
    pricingSnapshotId: valueOf('--pricing-snapshot') ?? DEFAULT_PRICING_SNAPSHOT_ID,
    groupBy: groupBy && GROUP_BY_FIELDS[groupBy] ? groupBy : 'operation',
    verboseDeterministic: args.includes('--deterministic-savings'),
    verboseLegacy: valueOf('--baseline') === 'legacy',
  };
}

function fmtCost(value) {
  return value === null || value === undefined ? 'n/a' : `$${value.toFixed(4)}`;
}

function fmtPercent(value) {
  return value === null || value === undefined ? 'n/a' : `${value}%`;
}

function fmtRange(range) {
  if (!range) return 'n/a';
  return `${fmtCost(range.lower)} – ${fmtCost(range.upper)} (central ${fmtCost(range.central)})`;
}

/** `—` for genuinely absent data, per Goal 014 §32 — never a false zero. */
function dash(value, fmt = (v) => v) {
  return (value === null || value === undefined) ? '—' : fmt(value);
}

function fmtRatePct(value) {
  return dash(value, (v) => `${Math.round(v * 1000) / 10}%`);
}

/** Rows a normal operational report must never fold in — see this file's own docstring. */
function excludeBenchmarkRows(rows) {
  return rows.filter((row) => row.operation !== 'benchmark');
}

/**
 * Builds the whole report from ledger rows and Work Unit events. Pure aside
 * from its inputs — the same rows and events always produce the same
 * report, and no step here can write anything back.
 *
 * `populationRows` is the (larger, typically unfiltered-by-Goal) set used to
 * find historical matches for deterministic savings — a Work Unit's
 * comparable history is not bounded by whichever `--goal` filter scopes THIS
 * report.
 */
export function buildMetricsReport({
  rows, workUnits, events = [], populationRows = rows, pricingSnapshotId,
}) {
  const scoped = excludeBenchmarkRows(rows);
  const population = excludeBenchmarkRows(populationRows);

  const usage = summarise(scoped);
  const baselines = computeCostBaselines(scoped, { pricingSnapshotId });
  const efficiency = computeEfficiency(usage);
  const byOperation = savingsBreakdown(scoped, { pricingSnapshotId }, GROUP_BY_FIELDS.operation);
  const routingBreakdown = modelRoutingBreakdown(scoped, { pricingSnapshotId });
  const modelOutcomes = computeModelOutcomes(scoped, { pricingSnapshotId });
  const snapshot = getPricingSnapshot(pricingSnapshotId);

  const currentUnits = groupIntoWorkUnits(scoped);
  const costPerUnit = costPerSuccessfulWorkUnit(currentUnits, { pricingSnapshotId });

  const deterministicEvents = events.filter((event) => event.type === 'WORK_UNIT_DETERMINISTIC_EXECUTED');
  const historicalModelUnits = groupIntoWorkUnits(population).filter((unit) => unit.operation === 'work_unit');
  const deterministicSavings = estimateDeterministicSavings(
    deterministicEvents.map((event) => ({ operation: 'work_unit', deterministicAction: event.action })),
    historicalModelUnits,
    { pricingSnapshotId },
  );

  const contextChars = events
    .filter((event) => event.type === 'WORK_UNIT_COMPLETED' && Number.isFinite(event.contextChars))
    .map((event) => event.contextChars);
  const contextStats = percentileStats(contextChars);
  // No source of PRE-Work-Unit context size exists in this ledger yet (see
  // README) — an empty legacy sample is the honest input, not a placeholder.
  const contextSavings = legacyContextBaseline({ legacyContextChars: [], currentContextChars: contextChars });

  const legacyArchitectureSavings = legacyMonolithicBaseline({
    current: { goalId: rows[0]?.goal_id ?? null, runId: null },
    candidates: [],
  });

  const totalArchitectureSavings = combineArchitectureSavings({
    routingSavingsUsd: baselines.routingSavingsUsd,
    deterministicSavings,
  });

  const effectivenessByModel = computeModelEffectiveness(scoped, events, { pricingSnapshotId }).byModel;
  const cohortImbalance = detectCohortImbalance(scoped);
  const effectiveness = {
    byModel: effectivenessByModel,
    byCohort: { complexityImbalance: cohortImbalance },
    resolutionChains: computeResolutionChains(scoped, { pricingSnapshotId }),
    escalations: computeEscalationROI(scoped, { pricingSnapshotId }),
    retries: computeRetryROI(scoped, { pricingSnapshotId }),
    terminalFailures: computeTerminalFailureCost(scoped, { pricingSnapshotId }),
  };

  // Work-Unit call counts per model — the OTHER half of "Fable: 0 Work Unit
  // calls, N stage calls" (Goal 015 §21). Deliberately a raw count of rows
  // carrying a `work_unit_id`, not `effectivenessByModel`'s `sample.calls`
  // (which counts EVERY call for that model, stage and Work Unit alike).
  const workUnitCallCounts = {};
  for (const row of scoped) {
    if (!row.work_unit_id) continue;
    const model = resolveCanonicalModel(row.resolved_model ?? row.requested_model) ?? (row.resolved_model ?? row.requested_model ?? 'UNKNOWN');
    workUnitCallCounts[model] = (workUnitCallCounts[model] ?? 0) + 1;
  }
  const stageTelemetry = {
    coverage: computeStageTelemetryCoverage(scoped, events),
    byModel: computeStageCallsByModel(scoped, { workUnitCallCounts }),
  };

  const observed = {
    executions: usage.executions,
    primaryTokens: usage.primaryTotalTokens,
    auxiliaryTokens: usage.auxiliaryTotalTokens,
    allModelTokens: usage.allModelTokens,
    byModel: usage.byModel,
    providerReportedCostUsd: usage.providerReportedCostUsd,
    executionsWithProviderCost: usage.executionsWithProviderCost,
    executionsWithoutProviderCost: usage.executionsWithoutProviderCost,
    providerCostCoveragePercent: usage.providerCostCoveragePercent,
    modelUnits: workUnits.modelUnits,
    deterministicUnits: workUnits.deterministicUnits,
    deterministicDurationMs: workUnits.deterministicDurationMs,
    deterministicModelCalls: workUnits.deterministicModelCalls,
    contextChars: contextStats,
    failureOverheadTokens: usage.failedTokens,
    failureOverheadCostUsd: usage.failedCostUsd,
    retryOverheadTokens: usage.retryTokens,
    retryOverheadCostUsd: usage.retryCostUsd,
    fallbackOverheadTokens: usage.fallbackTokens,
    fallbackOverheadCostUsd: usage.fallbackCostUsd,
    escalationOverheadTokens: usage.escalationTokens,
    escalationOverheadCostUsd: usage.escalationCostUsd,
    efficiency,
    integrityFlags: usage.integrityFlags,
  };

  const calculated = {
    pricingSnapshotId: baselines.pricingSnapshotId,
    pricingEffectiveDate: baselines.pricingEffectiveDate,
    routingSavingsUsd: baselines.routingSavingsUsd,
    routingSavingsPercent: baselines.routingSavingsPercent,
    routingImpact: describeSavingsDelta(baselines.routingSavingsUsd, { positiveLabel: 'savings', negativeLabel: 'additional cost' }),
    savingsByModel: baselines.savingsByModel,
    savingsByOperation: byOperation,
    modelRoutingBreakdown: routingBreakdown,
    modelOutcomes,
    costPerSuccessfulWorkUnit: costPerUnit,
    providerVsCalculated: baselines.providerVsCalculated,
    unknownModels: baselines.unknownModels,
    integrityFlags: baselines.integrityFlags,
  };

  const estimated = {
    deterministicSavings,
    legacyArchitectureSavings,
    contextSavings,
    totalArchitectureSavings,
  };

  const integrityFlags = new Set([...usage.integrityFlags, ...baselines.integrityFlags]);
  if (cohortImbalance.flag) integrityFlags.add(cohortImbalance.flag);

  return {
    observed,
    calculated,
    estimated,
    effectiveness,
    stageTelemetry,
    baselines: { ACTUAL: baselines.actual, ALL_OPUS: baselines.allOpus },
    pricing: snapshot ? {
      snapshotId: snapshot.id, provider: snapshot.provider, effectiveFrom: snapshot.effectiveFrom,
      provenance: snapshot.provenance, derivedFrom: snapshot.derivedFrom ?? null,
      sampleRows: snapshot.sampleRows ?? null, validatedAt: snapshot.validatedAt ?? null,
    } : null,
    benchmarks: { excludedRows: rows.length - scoped.length },
    confidence: {
      deterministicSavings: deterministicSavings.confidence ?? deterministicSavings.status,
      legacyArchitectureSavings: legacyArchitectureSavings.confidence ?? legacyArchitectureSavings.status,
      totalArchitectureSavings: totalArchitectureSavings.classification,
      byModel: Object.fromEntries(Object.entries(effectivenessByModel).map(([model, record]) => [model, record.confidence])),
    },
    integrity: { flags: [...integrityFlags] },
  };
}

export function renderMetricsReport(report, { goal = null, verboseDeterministic = false, verboseLegacy = false } = {}) {
  const out = ['IA-LOOP EFFICIENCY REPORT'];
  if (goal) out.push(`Goal ${goal}`);
  out.push('');

  out.push('OBSERVED');
  out.push('─'.repeat(40));
  out.push(`Model calls                 ${report.observed.executions}`);
  out.push(`Primary tokens       ${report.observed.primaryTokens}`);
  out.push(`Auxiliary tokens        ${report.observed.auxiliaryTokens}`);
  out.push(`All-model tokens      ${report.observed.allModelTokens}`);
  out.push('');
  out.push(`Deterministic units          ${report.observed.deterministicUnits}`);
  out.push(`Deterministic model calls     ${report.observed.deterministicModelCalls}`);
  if (report.observed.contextChars) {
    out.push(`Median context (chars)       ${report.observed.contextChars.p50}`);
  }
  out.push('');
  out.push(`Provider cost              ${fmtCost(report.observed.providerReportedCostUsd)}`);
  out.push(`Cost coverage              ${fmtPercent(report.observed.providerCostCoveragePercent)}`);
  out.push('');
  out.push(`Failure overhead tokens    ${report.observed.failureOverheadTokens} (cost ${fmtCost(report.observed.failureOverheadCostUsd)})`);
  out.push(`Retry overhead tokens      ${report.observed.retryOverheadTokens} (cost ${fmtCost(report.observed.retryOverheadCostUsd)})`);
  out.push(`Fallback overhead tokens   ${report.observed.fallbackOverheadTokens} (cost ${fmtCost(report.observed.fallbackOverheadCostUsd)})`);
  out.push(`Escalation overhead tokens ${report.observed.escalationOverheadTokens} (cost ${fmtCost(report.observed.escalationOverheadCostUsd)})`);
  out.push('');
  out.push(`Token efficiency  successful ${fmtPercent(report.observed.efficiency.successfulTokenSharePercent)}`
    + ` · failed ${fmtPercent(report.observed.efficiency.failedTokenSharePercent)}`
    + ` · retries ${fmtPercent(report.observed.efficiency.retryTokenSharePercent)}`
    + ' (not exclusive partitions)');

  out.push('');
  out.push('CALCULATED');
  out.push('─'.repeat(40));
  if (!report.pricing) {
    out.push(`Pricing snapshot unavailable: ${report.calculated.pricingSnapshotId} (PRICING_SNAPSHOT_MISSING)`);
  } else {
    out.push(`Pricing snapshot   ${report.pricing.snapshotId} (effective ${report.pricing.effectiveFrom})`);
    out.push(`Source             ${report.pricing.provenance}`
      + `${report.pricing.sampleRows ? ` (calibrated against ${report.pricing.sampleRows} production rows)` : ''}`);
    out.push('');
    out.push(`Actual routing cost        ${fmtCost(report.baselines.ACTUAL.costUsd)}`
      + ` (${report.baselines.ACTUAL.pricedInvocations}/${report.baselines.ACTUAL.totalInvocations} invocations priced)`);
    out.push(`All-Opus baseline          ${fmtCost(report.baselines.ALL_OPUS.costUsd)}`);
    out.push('');
    if (report.calculated.routingImpact) {
      out.push(`Routing ${report.calculated.routingImpact.label === 'savings' ? 'savings' : 'delta'}: ${report.calculated.routingImpact.text}`);
    }
    out.push(`Routing reduction          ${fmtPercent(report.calculated.routingSavingsPercent)}`);
    if (Object.keys(report.calculated.savingsByModel).length > 0) {
      out.push('');
      out.push('Savings by model (negative = routing cost MORE than all-Opus for that model)');
      for (const [model, savings] of Object.entries(report.calculated.savingsByModel)) {
        out.push(`  ${model.padEnd(28)} ${fmtCost(savings)}`);
      }
    }
    if (report.calculated.providerVsCalculated) {
      const p = report.calculated.providerVsCalculated;
      out.push('');
      out.push('Provider reported vs. calculated (diagnostic, not a correction)');
      out.push(`  Provider reported: ${fmtCost(p.providerReportedCostUsd)}`);
      out.push(`  Calculated:        ${fmtCost(p.calculatedCostUsd)}`);
      out.push(`  Difference:        ${fmtCost(p.differenceUsd)} (${fmtPercent(p.differencePercent)})`);
    }
    if (report.calculated.costPerSuccessfulWorkUnit?.status === 'OK') {
      const c = report.calculated.costPerSuccessfulWorkUnit;
      out.push('');
      out.push(`Cost per successful Work Unit: ${fmtCost(c.costPerSuccessfulWorkUnit)}`
        + ` (${c.callsPerSuccessfulWorkUnit.toFixed(2)} calls, ${Math.round(c.tokensPerSuccessfulWorkUnit)} tokens — ${c.successfulUnits} units)`);
    }
    if (report.calculated.unknownModels.length > 0) {
      out.push('');
      out.push(`Unpriced models (PRICING_MODEL_UNKNOWN): ${report.calculated.unknownModels.join(', ')}`);
    }
  }

  out.push('');
  out.push('ARCHITECTURAL SAVINGS');
  out.push('─'.repeat(40));
  const det = report.estimated.deterministicSavings;
  out.push(`Deterministic savings      ${det.status}`
    + (det.status === 'OK' ? ` (${det.confidence} confidence, n=${det.sampleSize}, ${det.matchTier} match)` : ''));
  if (det.status === 'OK') {
    out.push(`  Model calls avoided (est.): ${det.totalModelCallsAvoided?.toFixed(1) ?? 'n/a'}`);
    out.push(`  Cost avoided (est.):        ${fmtRange(det.totalCostUsdAvoided)}`);
    if (verboseDeterministic) {
      out.push(`  Method: ${det.method}`);
      out.push(`  Sample Work Unit ids: ${det.sampleWorkUnitIds.join(', ')}`);
      out.push(`  Tokens avoided (est.):      ${det.totalTokensAvoided ? `${det.totalTokensAvoided.lower} – ${det.totalTokensAvoided.upper} (central ${det.totalTokensAvoided.central})` : 'n/a'}`);
    }
  }
  out.push('');
  const legacy = report.estimated.legacyArchitectureSavings;
  out.push(`Legacy comparison          ${legacy.status}`);
  if (verboseLegacy) {
    out.push(`  Method: ${legacy.method}`);
    if (legacy.note) out.push(`  Note: ${legacy.note}`);
  }
  out.push('');
  const ctx = report.estimated.contextSavings;
  out.push(`Context reduction          ${ctx.status}`
    + (ctx.status === 'OK' ? ` (${ctx.reductionPercent}% fewer chars — NOT a token-savings figure)` : ''));
  out.push('');
  const total = report.estimated.totalArchitectureSavings;
  out.push(`Total architecture savings ${total.status}`
    + (total.status === 'OK' ? ` [${total.classification}] ${fmtRange(total.totalEstimatedSavingsUsd)}` : ''));
  if (total.missing?.length > 0) out.push(`  Missing components: ${total.missing.join(', ')}`);

  const models = Object.keys(report.effectiveness.byModel);
  if (models.length > 0) {
    out.push('');
    out.push('MODEL EFFECTIVENESS');
    out.push('─'.repeat(40));
    const shortLabel = (model) => model.replace(/^claude-/, '').replace(/-\d.*$/, '');
    const labels = models.map(shortLabel);
    const colWidth = Math.max(10, ...labels.map((l) => l.length + 2));
    const labelWidth = 22;
    const col = (label, pick, fmt = (v) => v) => `${label.padEnd(labelWidth)}${models.map((m) => String(dash(pick(report.effectiveness.byModel[m]), fmt)).padStart(colWidth)).join('')}`;
    out.push(`${''.padEnd(labelWidth)}${labels.map((l) => l.padStart(colWidth)).join('')}`);
    out.push(col('Calls', (r) => r.sample.calls));
    out.push(col('Cost', (r) => r.cost.totalUsd, (v) => fmtCost(v)));
    out.push(col('Successful units', (r) => r.sample.successfulWorkUnits));
    out.push('');
    out.push(col('First-pass success', (r) => r.quality.firstPassSuccessRate, fmtRatePct));
    out.push(col('Retry rate', (r) => r.quality.retryRate, fmtRatePct));
    out.push(col('Repair rate', (r) => r.quality.repairRate, fmtRatePct));
    out.push(col('Acceptance rate', (r) => r.quality.acceptanceRate, fmtRatePct));
    out.push('');
    out.push(col('Cost / success', (r) => r.cost.perSuccessfulWorkUnitUsd, fmtCost));
    out.push(col('Cost / accepted', (r) => r.cost.perAcceptedWorkUnitUsd, fmtCost));
    out.push('');
    const shortConfidence = { HIGH_CONFIDENCE: 'HIGH', MEDIUM_CONFIDENCE: 'MED', LOW_CONFIDENCE: 'LOW', INSUFFICIENT_DATA: 'INSUF.' };
    out.push(col('Confidence', (r) => shortConfidence[r.confidence] ?? r.confidence));
    if (report.effectiveness.byCohort.complexityImbalance.flagged) {
      out.push('');
      out.push('  MODEL_COHORT_IMBALANCE: these models are not receiving equivalent workloads');
      out.push('  (complexity distribution differs sharply) — comparisons above are directional only.');
    }
  }

  const chains = Object.values(report.effectiveness.resolutionChains);
  if (chains.length > 0) {
    out.push('');
    out.push('RESOLUTION CHAINS');
    out.push('─'.repeat(40));
    for (const chain of [...chains].sort((a, b) => b.units - a.units)) {
      out.push(`${chain.chain.padEnd(32)} ${chain.units} unit(s), ${chain.resolvedUnits} resolved, `
        + `${fmtCost(chain.costPerResolvedUsd)}/resolved (${chain.confidence})`);
    }
  }

  const stageModels = Object.keys(report.stageTelemetry.byModel);
  if (stageModels.length > 0) {
    out.push('');
    out.push('STAGE TELEMETRY (observational — no effectiveness ranking; see Goal 015)');
    out.push('─'.repeat(40));
    const stageLabels = stageModels.map((m) => m.replace(/^claude-/, '').replace(/-\d.*$/, ''));
    const stageColWidth = Math.max(10, ...stageLabels.map((l) => l.length + 2));
    const stageCol = (label, pick) => `${label.padEnd(22)}${stageModels.map((m) => String(dash(pick(report.stageTelemetry.byModel[m]))).padStart(stageColWidth)).join('')}`;
    out.push(`${''.padEnd(22)}${stageLabels.map((l) => l.padStart(stageColWidth)).join('')}`);
    // Zero is a real, computed count here (Goal 015 §23's own example prints
    // it as `0`) — `dash()` is reserved for values genuinely not computed at
    // all, never for "the count came to zero".
    out.push(stageCol('Work Unit calls', (r) => r.workUnitCalls));
    out.push(stageCol('Stage calls', (r) => r.stageCalls));
    out.push(stageCol('Planning calls', (r) => r.planning));
    out.push(stageCol('Review calls', (r) => r.review));
    out.push(stageCol('Repair calls', (r) => r.repair));
    out.push(stageCol('Closure calls', (r) => r.closure));
    out.push('');
    out.push(stageCol('Capacity failures', (r) => r.capacityFailures));
    out.push(stageCol('Quality failures', (r) => r.qualityFailures));
    out.push('');
    const cov = report.stageTelemetry.coverage;
    out.push(`Stage executions: ${cov.stageExecutions}`
      + ` · with outcome: ${cov.withStageOutcome}/${cov.stageExecutions}`
      + ` · legacy-reconstructed: ${cov.correlationQuality.LEGACY_RECONSTRUCTED} · unattributed: ${cov.correlationQuality.UNATTRIBUTED}`);
  }

  if (report.integrity.flags.length > 0) {
    out.push('');
    out.push(`Diagnostics: ${report.integrity.flags.join(' · ')}`);
  }

  return out.join('\n');
}

async function main() {
  const filters = parseMetricsArgs(process.argv);
  const path = process.env.IA_LOOP_TELEMETRY_DB || defaultLedgerPath(STATE_DIR);
  const ledger = openUsageLedger({ path });

  if (ledger.status !== LEDGER_STATUS.OK) {
    console.error(`Usage ledger unavailable: ${ledger.error}`);
    return 1;
  }

  const { sql, params } = buildUsageQuery(filters);
  const rows = ledger.query(sql, params);
  if (!Array.isArray(rows)) {
    console.error(`Query failed: ${rows.error}`);
    return 1;
  }

  // The comparable-history population for deterministic-savings matching is
  // deliberately NOT scoped to `--goal`: a Work Unit's comparable history
  // lives wherever a matching signature occurred, not only in this Goal.
  const { sql: populationSql, params: populationParams } = buildUsageQuery({ ...filters, goal: null });
  const populationRows = ledger.query(populationSql, populationParams);

  const store = createJobStore(STATE_DIR);
  const allEvents = await store.readEvents().catch(() => []);
  const events = filters.goal ? allEvents.filter((event) => event.goal === filters.goal) : allEvents;

  const workUnits = await summariseWorkUnits({ stateDir: STATE_DIR, goal: filters.goal });
  const report = buildMetricsReport({
    rows, workUnits, events, populationRows: Array.isArray(populationRows) ? populationRows : rows,
    pricingSnapshotId: filters.pricingSnapshotId,
  });

  if (filters.json) {
    console.log(JSON.stringify({ path, filters, ...report }, null, 2));
  } else {
    console.log(renderMetricsReport(report, {
      goal: filters.goal, verboseDeterministic: filters.verboseDeterministic, verboseLegacy: filters.verboseLegacy,
    }));
  }
  ledger.close();
  return 0;
}

if (isDirectExecution(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      const code = error instanceof SpikeError ? error.code : 'UNEXPECTED_ERROR';
      console.error(`ATENDLY IA LOOP — metrics\n\nCannot build report: [${code}] ${error.message}`);
      process.exitCode = 1;
    });
}
