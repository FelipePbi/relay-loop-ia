#!/usr/bin/env node
/**
 * IA Loop — reading the model usage ledger.
 *
 *   npm run ia-loop:usage
 *   npm run ia-loop:usage -- --goal 008
 *   npm run ia-loop:usage -- --goal 008 --json
 *   npm run ia-loop:usage -- --started        (rows opened and never finalised)
 *   npm run ia-loop:usage -- --integrity      (recorded inconsistencies)
 *
 * Debugging and validation ONLY. This is deliberately a table and a JSON dump,
 * not a dashboard: this Goal builds the ledger, and the analytics that read it
 * are a later, separate piece of work. Nothing here computes a price, a saving
 * or a counterfactual — the data is stored so those become possible, not so
 * they can be smuggled in now.
 *
 * Read-only. It opens the database, selects, and prints.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SpikeError } from './lib/claude-process.mjs';
import { LEDGER_STATUS, openUsageLedger } from './lib/usage-ledger.mjs';
import { defaultLedgerPath } from './lib/usage-collector.mjs';
import { isDirectExecution } from './lib/direct-execution.mjs';
import { normalizeAuxiliaryUsage, sumDefined } from './lib/auxiliary-usage.mjs';
import { createJobStore } from './lib/job-store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, '.state');

/**
 * How far a provider's own reported cost may drift from PRIMARY + AUXILIARY
 * model cost before it is worth calling out. Both figures are estimates from
 * the same CLI, drawn from different fields (`total_cost_usd` vs each
 * `modelUsage[model].costUSD`) that the CLI documents separately and this
 * Goal deliberately does not assume agree — see COST_ACCOUNTING_MISMATCH.
 */
const COST_MISMATCH_TOLERANCE_USD = 0.01;

export function parseUsageArgs(argv) {
  const args = argv.slice(2);
  const valueOf = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] ?? null : null;
  };
  const limit = Number(valueOf('--limit'));
  return {
    goal: valueOf('--goal'),
    run: valueOf('--run'),
    job: valueOf('--job'),
    model: valueOf('--model'),
    role: valueOf('--role'),
    limit: Number.isInteger(limit) && limit > 0 ? limit : 200,
    json: args.includes('--json'),
    started: args.includes('--started'),
    integrity: args.includes('--integrity'),
  };
}

/** Builds the WHERE clause from the filters, with no string interpolation of values. */
export function buildUsageQuery(filters) {
  const where = [];
  const params = [];
  if (filters.goal) { where.push('goal_id = ?'); params.push(filters.goal); }
  if (filters.run) { where.push('run_id = ?'); params.push(filters.run); }
  if (filters.job) { where.push('job_id = ?'); params.push(filters.job); }
  if (filters.model) { where.push('resolved_model = ?'); params.push(filters.model); }
  if (filters.role) { where.push('role = ?'); params.push(filters.role); }
  if (filters.started) where.push("status = 'STARTED'");
  const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
  return {
    sql: `SELECT * FROM model_usage${clause} ORDER BY started_at ASC LIMIT ?`,
    params: [...params, filters.limit],
  };
}

function n(value) {
  return Number.isFinite(value) ? value : 0;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isTrue(value) {
  return value === 1 || value === true;
}

/** Folds one row's auxiliary-model breakdown into the running aggregate. */
function mergeAuxiliaryByModel(target, addition) {
  for (const [model, tokens] of Object.entries(addition)) {
    const existing = target[model];
    if (!existing) {
      target[model] = { ...tokens };
    } else {
      existing.inputTokens += tokens.inputTokens;
      existing.outputTokens += tokens.outputTokens;
      existing.cacheReadTokens += tokens.cacheReadTokens;
      existing.cacheCreationTokens += tokens.cacheCreationTokens;
      existing.totalTokens += tokens.totalTokens;
      existing.costUsd = sumDefined([existing.costUsd, tokens.costUsd]);
    }
  }
}

/**
 * Deterministic sums only. No pricing, no ratios, no judgement.
 *
 * Two rules the shape below exists to hold:
 *
 *   PRIMARY / AUXILIARY / ALL are always kept apart. `allModelTokens` is
 *   `primaryTotalTokens + auxiliaryTotalTokens`, never a third independent
 *   count — see `ALL_MODEL_TOTAL_MISMATCH` for the self-check that guards it.
 *
 *   Cost is never defaulted to zero. A row with no `provider_reported_cost_usd`
 *   is missing that figure; the coverage counters exist so a report can never
 *   look complete when it is not.
 */
export function summarise(rows) {
  const totals = {
    executions: rows.length,

    // --- primary model usage ---------------------------------------------
    primaryInputTokens: 0,
    primaryOutputTokens: 0,
    primaryThinkingTokens: 0,
    primaryCacheReadTokens: 0,
    primaryCacheCreationTokens: 0,
    primaryTotalTokens: 0,

    // --- auxiliary model usage ---------------------------------------------
    auxiliaryInputTokens: 0,
    auxiliaryOutputTokens: 0,
    auxiliaryCacheReadTokens: 0,
    auxiliaryCacheCreationTokens: 0,
    auxiliaryTotalTokens: 0,
    auxiliaryByModel: {},

    // --- all models combined ---------------------------------------------
    allModelTokens: 0,

    // --- turns / tools / timing --------------------------------------------
    numTurns: 0,
    toolCalls: 0,
    durationMs: 0,

    // --- cost, with explicit coverage --------------------------------------
    providerReportedCostUsd: null,
    executionsWithProviderCost: 0,
    executionsWithoutProviderCost: 0,
    providerCostCoveragePercent: null,
    primaryModelCostUsd: null,
    auxiliaryModelCostUsd: null,
    allModelCostUsd: null,
    costAccountingDeltaUsd: null,

    // --- outcome, NOT mutually exclusive -----------------------------------
    completedCalls: 0,
    failedCalls: 0,
    completedTokens: 0,
    failedTokens: 0,
    retryCalls: 0,
    retryTokens: 0,
    fallbackCalls: 0,
    fallbackTokens: 0,
    escalationCalls: 0,
    escalationTokens: 0,
    failedCostUsd: null,
    retryCostUsd: null,
    fallbackCostUsd: null,
    escalationCostUsd: null,

    byStatus: {},
    byModel: {},
    byOperation: {},

    // Report-level diagnostics, derived here and never persisted: see
    // "Persistência" in the Goal — nothing here duplicates ledger columns.
    integrityFlags: [],
  };

  const flags = new Set();
  const addCost = (key, value) => {
    if (!isFiniteNumber(value)) return;
    totals[key] = (totals[key] ?? 0) + value;
  };

  for (const row of rows) {
    // primary --------------------------------------------------------------
    totals.primaryInputTokens += n(row.input_tokens);
    totals.primaryOutputTokens += n(row.output_tokens);
    totals.primaryThinkingTokens += n(row.thinking_tokens);
    totals.primaryCacheReadTokens += n(row.cache_read_tokens);
    totals.primaryCacheCreationTokens += n(row.cache_creation_tokens);
    const primaryTotal = n(row.total_tokens);
    totals.primaryTotalTokens += primaryTotal;

    // auxiliary --------------------------------------------------------------
    const aux = normalizeAuxiliaryUsage(row.auxiliary_usage_json);
    for (const flag of aux.flags) flags.add(flag);
    for (const tokens of Object.values(aux.byModel)) {
      totals.auxiliaryInputTokens += tokens.inputTokens;
      totals.auxiliaryOutputTokens += tokens.outputTokens;
      totals.auxiliaryCacheReadTokens += tokens.cacheReadTokens;
      totals.auxiliaryCacheCreationTokens += tokens.cacheCreationTokens;
    }
    mergeAuxiliaryByModel(totals.auxiliaryByModel, aux.byModel);
    const auxTotal = aux.totalTokens ?? 0;
    totals.auxiliaryTotalTokens += auxTotal;

    const rowAllTotal = primaryTotal + auxTotal;
    totals.allModelTokens += rowAllTotal;

    // turns / tools / timing -------------------------------------------------
    totals.numTurns += n(row.num_turns);
    totals.toolCalls += n(row.tool_call_count);
    totals.durationMs += n(row.duration_ms);

    // cost --------------------------------------------------------------
    const providerCost = row.provider_reported_cost_usd;
    if (isFiniteNumber(providerCost)) {
      addCost('providerReportedCostUsd', providerCost);
      totals.executionsWithProviderCost += 1;
    } else {
      totals.executionsWithoutProviderCost += 1;
    }
    addCost('primaryModelCostUsd', row.primary_model_cost_usd);
    addCost('auxiliaryModelCostUsd', aux.costUsd);

    // breakdowns --------------------------------------------------------------
    totals.byStatus[row.status] = (totals.byStatus[row.status] ?? 0) + 1;
    const model = row.resolved_model ?? row.requested_model ?? 'UNKNOWN';
    totals.byModel[model] = (totals.byModel[model] ?? 0) + 1;
    totals.byOperation[row.operation ?? 'UNKNOWN'] = (totals.byOperation[row.operation ?? 'UNKNOWN'] ?? 0) + 1;

    // outcome — a row can land in several of these at once (e.g. a FAILED
    // retry that was also a fallback), so none of these are `else if`.
    if (row.status === 'COMPLETED') {
      totals.completedCalls += 1;
      totals.completedTokens += rowAllTotal;
    }
    if (row.status === 'FAILED') {
      totals.failedCalls += 1;
      totals.failedTokens += rowAllTotal;
      addCost('failedCostUsd', providerCost);
    }
    if (n(row.attempt) > 1) {
      totals.retryCalls += 1;
      totals.retryTokens += rowAllTotal;
      addCost('retryCostUsd', providerCost);
    }
    if (isTrue(row.is_fallback)) {
      totals.fallbackCalls += 1;
      totals.fallbackTokens += rowAllTotal;
      addCost('fallbackCostUsd', providerCost);
    }
    if (isTrue(row.is_escalation)) {
      totals.escalationCalls += 1;
      totals.escalationTokens += rowAllTotal;
      addCost('escalationCostUsd', providerCost);
    }
  }

  totals.providerCostCoveragePercent = totals.executions > 0
    ? Math.round((totals.executionsWithProviderCost / totals.executions) * 1000) / 10
    : null;
  if (totals.executionsWithoutProviderCost > 0) flags.add('PROVIDER_COST_MISSING');

  totals.allModelCostUsd = sumDefined([totals.primaryModelCostUsd, totals.auxiliaryModelCostUsd]);
  if (totals.providerReportedCostUsd !== null && totals.allModelCostUsd !== null) {
    totals.costAccountingDeltaUsd = totals.providerReportedCostUsd - totals.allModelCostUsd;
    // Divergence is expected, not corrected: `total_cost_usd` and
    // `modelUsage[model].costUSD` are two different CLI fields that can
    // legitimately disagree (e.g. a row whose modelUsage lacked cost data).
    // This only records that the two do not currently reconcile.
    if (Math.abs(totals.costAccountingDeltaUsd) > COST_MISMATCH_TOLERANCE_USD) flags.add('COST_ACCOUNTING_MISMATCH');
  }

  // A self-check on our OWN arithmetic, not on the CLI's: allModelTokens is
  // defined as primary + auxiliary, so this can only fire if a future change
  // makes the two running sums drift from that definition.
  if (totals.allModelTokens !== totals.primaryTotalTokens + totals.auxiliaryTotalTokens) {
    flags.add('ALL_MODEL_TOTAL_MISMATCH');
  }

  totals.integrityFlags = [...flags];
  return totals;
}

/**
 * Work Units the harness executed, read from `events.jsonl` — the ONE record
 * the Work Unit executor itself already produces (see work-unit-executor.mjs).
 * Nothing here estimates a token saving; a DETERMINISTIC unit's own event
 * states `modelCalls: 0` and this simply reports that fact back.
 *
 * Read-only and best-effort: a report the ledger can still answer must not be
 * lost because the event log happened to be unreadable.
 */
export async function summariseWorkUnits({ stateDir, goal = null }) {
  try {
    const store = createJobStore(stateDir);
    const events = await store.readEvents();
    const scoped = goal ? events.filter((event) => event.goal === goal) : events;

    const modelUnits = scoped.filter((event) => event.type === 'WORK_UNIT_COMPLETED').length;
    const deterministic = scoped.filter((event) => event.type === 'WORK_UNIT_DETERMINISTIC_EXECUTED');

    return {
      modelUnits,
      deterministicUnits: deterministic.length,
      deterministicDurationMs: deterministic.reduce((sum, event) => sum + n(event.durationMs), 0),
      // Summed from the executor's own events rather than hardcoded, so a
      // future change that made a deterministic unit call a model would show
      // up here instead of being asserted away.
      deterministicModelCalls: deterministic.reduce((sum, event) => sum + n(event.modelCalls), 0),
      error: null,
    };
  } catch (error) {
    return {
      modelUnits: null, deterministicUnits: null, deterministicDurationMs: null, deterministicModelCalls: null,
      error: error?.message ?? String(error),
    };
  }
}

function fmtCost(value) {
  return value === null ? 'n/a' : `$${value.toFixed(4)}`;
}

export function renderUsageReport({ rows, totals, integrity = [], path, workUnits = null }) {
  const out = [`Usage ledger: ${path}`, ''];

  if (rows.length === 0) {
    out.push('No model executions recorded for this filter.');
  } else {
    out.push('  started              goal/round  role        operation      model                          '
      + 'in      out  think    cache_r  turns  tools  status');
    for (const row of rows) {
      out.push([
        `  ${String(row.started_at ?? '').slice(0, 19).padEnd(19)}`,
        `${String(row.goal_id ?? '-')}/${row.round_id ?? '-'}`.padEnd(11),
        String(row.role ?? '-').padEnd(11),
        String(row.operation ?? '-').padEnd(14),
        String(row.resolved_model ?? row.requested_model ?? '-').padEnd(30),
        String(n(row.input_tokens)).padStart(7),
        String(n(row.output_tokens)).padStart(8),
        String(row.thinking_tokens ?? '-').padStart(6),
        String(n(row.cache_read_tokens)).padStart(10),
        String(row.num_turns ?? '-').padStart(6),
        String(row.tool_call_count ?? '-').padStart(6),
        `  ${row.status}${row.is_fallback ? ' ·fallback' : ''}${row.is_escalation ? ' ·escalation' : ''}`,
      ].join(' '));
    }

    out.push('');
    out.push(`  executions: ${totals.executions}`);
    out.push(`  by status: ${Object.entries(totals.byStatus).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    out.push(`  by model: ${Object.entries(totals.byModel).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    out.push(`  by operation: ${Object.entries(totals.byOperation).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    out.push(`  turns: ${totals.numTurns} · tool calls: ${totals.toolCalls} · wall clock: ${Math.round(totals.durationMs / 1000)}s`);

    out.push('');
    out.push('  Model usage');
    out.push(`    primary tokens:    ${totals.primaryTotalTokens} `
      + `(input ${totals.primaryInputTokens} · output ${totals.primaryOutputTokens} `
      + `· thinking ${totals.primaryThinkingTokens} (inside output))`);
    out.push(`    auxiliary tokens:  ${totals.auxiliaryTotalTokens}`
      + `${Object.keys(totals.auxiliaryByModel).length > 0
        ? ` (${Object.entries(totals.auxiliaryByModel).map(([m, t]) => `${m} ${t.totalTokens}`).join(' · ')})`
        : ''}`);
    out.push(`    all-model tokens:  ${totals.allModelTokens}`);

    out.push('');
    out.push('  Cache');
    out.push(`    read:  ${totals.primaryCacheReadTokens + totals.auxiliaryCacheReadTokens}`);
    out.push(`    write: ${totals.primaryCacheCreationTokens + totals.auxiliaryCacheCreationTokens}`);

    out.push('');
    out.push('  Cost (estimates the provider reported, never an invoice)');
    out.push(`    provider reported: ${fmtCost(totals.providerReportedCostUsd)}`);
    out.push(`    coverage:          ${totals.executionsWithProviderCost}/${totals.executions}`
      + `${totals.providerCostCoveragePercent !== null ? ` (${totals.providerCostCoveragePercent}%)` : ''}`);
    out.push(`    missing cost:      ${totals.executionsWithoutProviderCost} execution(s)`);
    out.push(`    primary cost:      ${fmtCost(totals.primaryModelCostUsd)}`);
    out.push(`    auxiliary cost:    ${fmtCost(totals.auxiliaryModelCostUsd)}`);
    out.push(`    all-model cost:    ${fmtCost(totals.allModelCostUsd)}`);

    out.push('');
    out.push('  Execution (categories are not mutually exclusive)');
    out.push(`    completed calls:   ${totals.completedCalls} (tokens ${totals.completedTokens})`);
    out.push(`    failed calls:      ${totals.failedCalls} (tokens ${totals.failedTokens}`
      + `, cost ${fmtCost(totals.failedCostUsd)})`);
    out.push(`    retry calls:       ${totals.retryCalls} (tokens ${totals.retryTokens}`
      + `, cost ${fmtCost(totals.retryCostUsd)})`);
    out.push(`    fallback calls:    ${totals.fallbackCalls} (tokens ${totals.fallbackTokens}`
      + `, cost ${fmtCost(totals.fallbackCostUsd)})`);
    out.push(`    escalation calls:  ${totals.escalationCalls} (tokens ${totals.escalationTokens}`
      + `, cost ${fmtCost(totals.escalationCostUsd)})`);
  }

  if (workUnits) {
    out.push('');
    out.push('  Work Units');
    if (workUnits.error) {
      out.push(`    unavailable: ${workUnits.error}`);
    } else {
      out.push(`    model units:         ${workUnits.modelUnits}`);
      out.push(`    deterministic units: ${workUnits.deterministicUnits}`
        + ` (${workUnits.deterministicDurationMs}ms native execution)`);
      out.push(`    deterministic calls: ${workUnits.deterministicModelCalls}`);
    }
  }

  if (rows.length > 0 && totals.integrityFlags.length > 0) {
    out.push('');
    out.push(`  diagnostics: ${totals.integrityFlags.join(' · ')}`);
  }

  if (integrity.length > 0) {
    out.push('');
    out.push('  integrity flags (ledger):');
    for (const flag of integrity) out.push(`    ${flag.at} ${flag.flag} ${flag.usage_id ?? ''}`);
  }
  return out.join('\n');
}

async function main() {
  const filters = parseUsageArgs(process.argv);
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

  const integrity = filters.integrity
    ? ledger.query('SELECT * FROM model_usage_integrity ORDER BY at DESC LIMIT ?', [filters.limit])
    : [];

  const totals = summarise(rows);
  const workUnits = await summariseWorkUnits({ stateDir: STATE_DIR, goal: filters.goal });
  if (filters.json) {
    console.log(JSON.stringify({
      path,
      schemaVersion: ledger.schemaVersion(),
      filters,
      totals,
      workUnits,
      rows,
      integrity: Array.isArray(integrity) ? integrity : [],
    }, null, 2));
  } else {
    console.log(renderUsageReport({
      rows, totals, integrity: Array.isArray(integrity) ? integrity : [], path, workUnits,
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
      console.error(`ATENDLY IA LOOP — usage\n\nCannot read ledger: [${code}] ${error.message}`);
      process.exitCode = 1;
    });
}
