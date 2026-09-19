/**
 * Tests for the usage ledger's debugging CLI.
 *
 * It exists to VALIDATE the ledger, so its own filtering and summing have to be
 * right — a wrong total here would be read as a wrong total in the data. What is
 * deliberately absent is anything resembling analysis: no pricing, no ratios,
 * no savings. Those belong to a later piece of work, on top of this data.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildUsageQuery, parseUsageArgs, renderUsageReport, summarise, summariseWorkUnits,
} from '../run-usage.mjs';
import { createJobStore } from '../lib/job-store.mjs';

function row(overrides = {}) {
  return {
    started_at: '2026-09-09T10:00:00.000Z', goal_id: '008', round_id: 1, role: 'developer',
    operation: 'implementation', resolved_model: 'claude-sonnet-5', status: 'COMPLETED',
    input_tokens: 100, output_tokens: 200, thinking_tokens: 40, cache_read_tokens: 1000,
    cache_creation_tokens: 50, total_tokens: 1350, num_turns: 5, tool_call_count: 3,
    duration_ms: 4000, provider_reported_cost_usd: 0.25, primary_model_cost_usd: 0.25,
    is_fallback: 0, is_escalation: 0, attempt: 1, auxiliary_usage_json: null,
    ...overrides,
  };
}

const ROWS = [
  row(),
  row({
    started_at: '2026-09-09T10:10:00.000Z', role: 'tech_lead', operation: 'review',
    resolved_model: 'claude-opus-5', status: 'FAILED',
    input_tokens: 10, output_tokens: 20, thinking_tokens: null, cache_read_tokens: 0,
    cache_creation_tokens: 0, total_tokens: 30, num_turns: 1, tool_call_count: 0,
    duration_ms: 1000, provider_reported_cost_usd: 0.01, primary_model_cost_usd: 0.01, is_fallback: 1,
  }),
];

test('filters are parsed, with a sane default limit', () => {
  assert.deepEqual(parseUsageArgs(['node', 'run-usage.mjs', '--goal', '008', '--json']), {
    goal: '008', run: null, job: null, model: null, role: null,
    limit: 200, json: true, started: false, integrity: false,
  });
  assert.equal(parseUsageArgs(['node', 'x', '--limit', '5']).limit, 5);
  assert.equal(parseUsageArgs(['node', 'x', '--limit', 'nonsense']).limit, 200);
});

test('every filter becomes a bound parameter, never interpolated text', () => {
  const { sql, params } = buildUsageQuery(parseUsageArgs(['n', 'x', '--goal', "008'; DROP TABLE model_usage; --"]));
  assert.match(sql, /WHERE goal_id = \?/);
  assert.equal(sql.includes('DROP TABLE'), false);
  assert.deepEqual(params, ["008'; DROP TABLE model_usage; --", 200]);
});

test('--started selects only rows that were opened and never finalised', () => {
  const { sql } = buildUsageQuery(parseUsageArgs(['n', 'x', '--started']));
  assert.match(sql, /status = 'STARTED'/);
});

// --- run/job/model/role filters keep working -------------------------------

test('run, job, model and role each become their own bound clause', () => {
  const filters = parseUsageArgs(['n', 'x', '--run', 'auto-1', '--job', 'j1', '--model', 'claude-opus-5', '--role', 'developer']);
  const { sql, params } = buildUsageQuery(filters);
  assert.match(sql, /run_id = \?/);
  assert.match(sql, /job_id = \?/);
  assert.match(sql, /resolved_model = \?/);
  assert.match(sql, /role = \?/);
  assert.deepEqual(params, ['auto-1', 'j1', 'claude-opus-5', 'developer', 200]);
});

// --- primary / auxiliary / all-model tokens ---------------------------------

test('primary totals sum the token categories and never add thinking on top', () => {
  const totals = summarise(ROWS);
  assert.equal(totals.executions, 2);
  assert.equal(totals.primaryInputTokens, 110);
  assert.equal(totals.primaryOutputTokens, 220);
  assert.equal(totals.primaryThinkingTokens, 40, 'a null thinking figure counts as nothing, not as zero output');
  assert.equal(totals.primaryCacheReadTokens, 1000);
  assert.equal(totals.primaryTotalTokens, 1380, 'the sum of the rows own totals, which exclude thinking');
  assert.deepEqual(totals.byStatus, { COMPLETED: 1, FAILED: 1 });
  assert.deepEqual(totals.byOperation, { implementation: 1, review: 1 });
});

test('with no auxiliary usage anywhere, auxiliary totals are zero and all-model equals primary', () => {
  const totals = summarise(ROWS);
  assert.equal(totals.auxiliaryTotalTokens, 0);
  assert.deepEqual(totals.auxiliaryByModel, {});
  assert.equal(totals.allModelTokens, totals.primaryTotalTokens);
});

test('auxiliary usage from several rows is folded into one byModel breakdown, and ALL = PRIMARY + AUXILIARY', () => {
  const aux1 = JSON.stringify([{ model: 'claude-haiku-4-5', inputTokens: 100, outputTokens: 10, costUsd: 0.001 }]);
  const aux2 = JSON.stringify([
    { model: 'claude-haiku-4-5', inputTokens: 50, outputTokens: 5, costUsd: 0.0005 },
    { model: 'claude-sonnet-5', inputTokens: 200, outputTokens: 20 },
  ]);
  const rows = [row({ auxiliary_usage_json: aux1 }), row({ auxiliary_usage_json: aux2 })];
  const totals = summarise(rows);

  assert.equal(totals.auxiliaryByModel['claude-haiku-4-5'].inputTokens, 150);
  assert.equal(totals.auxiliaryByModel['claude-sonnet-5'].inputTokens, 200);
  // haiku: 100+10 + 50+5 = 165; sonnet: 200+20 = 220; total auxiliary = 385
  assert.equal(totals.auxiliaryTotalTokens, 385);
  assert.equal(totals.auxiliaryModelCostUsd, 0.0015, 'the sonnet entry has no cost, so only the defined ones sum');
  assert.equal(totals.allModelTokens, totals.primaryTotalTokens + totals.auxiliaryTotalTokens);
  assert.deepEqual(totals.integrityFlags, [], 'nothing here is invalid or mismatched');
});

test('thinking tokens are never counted twice when rolling up to allModelTokens', () => {
  const totals = summarise([row({ thinking_tokens: 900, total_tokens: 1350 })]);
  assert.equal(totals.allModelTokens, 1350, 'thinking is inside output/total already; it must not be added again');
});

// --- cost coverage -----------------------------------------------------

test('a row with no provider_reported_cost_usd is missing that figure, never treated as $0', () => {
  const totals = summarise([row({ provider_reported_cost_usd: null, primary_model_cost_usd: null })]);
  assert.equal(totals.providerReportedCostUsd, null);
  assert.equal(totals.executionsWithProviderCost, 0);
  assert.equal(totals.executionsWithoutProviderCost, 1);
  assert.equal(totals.providerCostCoveragePercent, 0);
  assert.ok(totals.integrityFlags.includes('PROVIDER_COST_MISSING'));
});

test('full cost coverage reports 100% and no missing-cost diagnostic', () => {
  const totals = summarise([row(), row({ provider_reported_cost_usd: 0.5, primary_model_cost_usd: 0.5 })]);
  assert.equal(totals.executionsWithProviderCost, 2);
  assert.equal(totals.executionsWithoutProviderCost, 0);
  assert.equal(totals.providerCostCoveragePercent, 100);
  assert.equal(totals.integrityFlags.includes('PROVIDER_COST_MISSING'), false);
});

test('partial cost coverage reports the exact fraction, matching the CLI report example (17/19 = 89.5%)', () => {
  const withCost = Array.from({ length: 17 }, () => row({ provider_reported_cost_usd: 0.1, primary_model_cost_usd: 0.1 }));
  const withoutCost = Array.from({ length: 2 }, () => row({ provider_reported_cost_usd: null, primary_model_cost_usd: null }));
  const totals = summarise([...withCost, ...withoutCost]);
  assert.equal(totals.executionsWithProviderCost, 17);
  assert.equal(totals.executionsWithoutProviderCost, 2);
  assert.equal(totals.providerCostCoveragePercent, 89.5);
  assert.ok(Math.abs(totals.providerReportedCostUsd - 1.7) < 1e-9);
  assert.ok(totals.integrityFlags.includes('PROVIDER_COST_MISSING'));
});

test('zero executions carry any cost: the total stays null, coverage is 0%, nothing crashes', () => {
  const totals = summarise([
    row({ provider_reported_cost_usd: null, primary_model_cost_usd: null }),
    row({ provider_reported_cost_usd: null, primary_model_cost_usd: null }),
  ]);
  assert.equal(totals.providerReportedCostUsd, null);
  assert.equal(totals.primaryModelCostUsd, null);
  assert.equal(totals.allModelCostUsd, null);
  assert.equal(totals.providerCostCoveragePercent, 0);
});

test('provider cost vs primary+auxiliary cost that genuinely disagree are flagged, never silently reconciled', () => {
  const totals = summarise([row({ provider_reported_cost_usd: 5, primary_model_cost_usd: 1 })]);
  assert.equal(totals.providerReportedCostUsd, 5);
  assert.equal(totals.allModelCostUsd, 1);
  assert.ok(Math.abs(totals.costAccountingDeltaUsd - 4) < 1e-9);
  assert.ok(totals.integrityFlags.includes('COST_ACCOUNTING_MISMATCH'));
});

test('provider cost and primary+auxiliary cost that agree within tolerance are not flagged', () => {
  const totals = summarise([row({ provider_reported_cost_usd: 0.25, primary_model_cost_usd: 0.25 })]);
  assert.equal(totals.integrityFlags.includes('COST_ACCOUNTING_MISMATCH'), false);
});

// --- outcome buckets, not mutually exclusive --------------------------------

test('a FAILED call keeps whatever tokens and cost it consumed', () => {
  const totals = summarise([row({ status: 'FAILED', total_tokens: 500, provider_reported_cost_usd: 0.2, primary_model_cost_usd: 0.2 })]);
  assert.equal(totals.failedCalls, 1);
  assert.equal(totals.failedTokens, 500);
  assert.equal(totals.failedCostUsd, 0.2);
  assert.equal(totals.completedCalls, 0);
});

test('a retry (attempt > 1) is counted with its own consumption, independent of attempt 1', () => {
  const totals = summarise([
    row({ attempt: 1, total_tokens: 100, provider_reported_cost_usd: 0.1, primary_model_cost_usd: 0.1 }),
    row({ attempt: 2, total_tokens: 300, provider_reported_cost_usd: 0.3, primary_model_cost_usd: 0.3 }),
  ]);
  assert.equal(totals.retryCalls, 1);
  assert.equal(totals.retryTokens, 300, 'only the retry attempt, not attempt 1 merged in');
  assert.equal(totals.retryCostUsd, 0.3);
  assert.equal(totals.allModelTokens, 400, 'both real calls are still counted toward the total');
});

test('a fallback call is counted under fallback, with its own tokens and cost', () => {
  const totals = summarise([row({ is_fallback: 1, total_tokens: 700, provider_reported_cost_usd: 0.7, primary_model_cost_usd: 0.7 })]);
  assert.equal(totals.fallbackCalls, 1);
  assert.equal(totals.fallbackTokens, 700);
  assert.equal(totals.fallbackCostUsd, 0.7);
});

test('escalation calls are counted with their own consumption', () => {
  const totals = summarise([row({ is_escalation: 1, total_tokens: 900, provider_reported_cost_usd: 0.9, primary_model_cost_usd: 0.9 })]);
  assert.equal(totals.escalationCalls, 1);
  assert.equal(totals.escalationTokens, 900);
  assert.equal(totals.escalationCostUsd, 0.9);
});

test('a single call can land in several outcome buckets at once (FAILED + retry + fallback)', () => {
  const totals = summarise([row({
    status: 'FAILED', attempt: 2, is_fallback: 1, total_tokens: 250,
    provider_reported_cost_usd: 0.05, primary_model_cost_usd: 0.05,
  })]);
  assert.equal(totals.failedCalls, 1);
  assert.equal(totals.retryCalls, 1);
  assert.equal(totals.fallbackCalls, 1);
  assert.equal(totals.failedTokens, 250);
  assert.equal(totals.retryTokens, 250);
  assert.equal(totals.fallbackTokens, 250);
});

// --- legacy rows --------------------------------------------------------

test('a row shaped like an old schema (no attempt, no cost columns, no aux json) still summarises safely', () => {
  const legacyRow = {
    started_at: '2026-01-01T00:00:00.000Z', goal_id: '001', round_id: 1, role: 'developer',
    operation: 'implementation', resolved_model: 'claude-sonnet-5', status: 'COMPLETED',
    input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 15,
    num_turns: 1, tool_call_count: 0, duration_ms: 100,
    // no attempt, no is_fallback/is_escalation, no provider_reported_cost_usd,
    // no primary_model_cost_usd, no auxiliary_usage_json — exactly a v1 row.
  };
  const totals = summarise([legacyRow]);
  assert.equal(totals.executions, 1);
  assert.equal(totals.primaryTotalTokens, 15);
  assert.equal(totals.providerReportedCostUsd, null);
  assert.equal(totals.retryCalls, 0, 'a missing attempt is never mistaken for a retry');
  assert.equal(totals.fallbackCalls, 0);
  assert.equal(totals.escalationCalls, 0);
  assert.deepEqual(totals.auxiliaryByModel, {});
});

// --- rendering ---------------------------------------------------------

test('the report names the models, the reroute, and labels cost as an estimate', () => {
  const text = renderUsageReport({ rows: ROWS, totals: summarise(ROWS), path: '/tmp/usage.sqlite' });
  assert.match(text, /claude-sonnet-5/);
  assert.match(text, /claude-opus-5/);
  assert.match(text, /·fallback/);
  assert.match(text, /thinking 40 \(inside output\)/);
  assert.match(text, /estimate/);
});

test('an empty ledger says so rather than printing an empty table', () => {
  const text = renderUsageReport({ rows: [], totals: summarise([]), path: '/tmp/usage.sqlite' });
  assert.match(text, /No model executions recorded/);
});

test('the text report and the JSON totals agree on every headline number', () => {
  const totals = summarise(ROWS);
  const text = renderUsageReport({ rows: ROWS, totals, path: '/tmp/usage.sqlite' });
  for (const value of [
    totals.primaryTotalTokens, totals.auxiliaryTotalTokens, totals.allModelTokens,
    totals.executionsWithProviderCost, totals.executionsWithoutProviderCost,
    totals.failedCalls, totals.fallbackCalls,
  ]) {
    assert.match(text, new RegExp(`\\b${value}\\b`), `${value} should appear somewhere in the rendered report`);
  }
});

test('Work Units render alongside the ledger report when supplied', () => {
  const workUnits = { modelUnits: 11, deterministicUnits: 8, deterministicDurationMs: 42300, deterministicModelCalls: 0, error: null };
  const text = renderUsageReport({ rows: ROWS, totals: summarise(ROWS), path: '/tmp/usage.sqlite', workUnits });
  assert.match(text, /model units:\s+11/);
  assert.match(text, /deterministic units:\s+8/);
  assert.match(text, /deterministic calls:\s+0/);
});

test('an unreadable event log is reported, not thrown, and the rest of the report still renders', () => {
  const workUnits = { modelUnits: null, deterministicUnits: null, deterministicDurationMs: null, deterministicModelCalls: null, error: 'boom' };
  const text = renderUsageReport({ rows: ROWS, totals: summarise(ROWS), path: '/tmp/usage.sqlite', workUnits });
  assert.match(text, /unavailable: boom/);
  assert.match(text, /claude-sonnet-5/, 'the ledger-backed section is unaffected');
});

// --- Work Units, from events.jsonl ------------------------------------------

function scratchStateDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ia-loop-usage-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

test('a DETERMINISTIC work unit reports zero model calls, read from its own event', async (t) => {
  const dir = scratchStateDir(t);
  const store = createJobStore(dir);
  await store.appendEvent({
    type: 'WORK_UNIT_DETERMINISTIC_EXECUTED', goal: '011', round: 1, workUnitId: 'WU-1',
    ok: true, durationMs: 120, modelCalls: 0,
  });
  await store.appendEvent({
    type: 'WORK_UNIT_DETERMINISTIC_EXECUTED', goal: '011', round: 1, workUnitId: 'WU-2',
    ok: true, durationMs: 30, modelCalls: 0,
  });
  await store.appendEvent({ type: 'WORK_UNIT_COMPLETED', goal: '011', round: 1, workUnitId: 'WU-3', state: 'COMPLETED' });

  const summary = await summariseWorkUnits({ stateDir: dir, goal: '011' });
  assert.equal(summary.deterministicUnits, 2);
  assert.equal(summary.deterministicDurationMs, 150);
  assert.equal(summary.deterministicModelCalls, 0);
  assert.equal(summary.modelUnits, 1);
  assert.equal(summary.error, null);
});

test('Work Units are scoped by --goal, matching the model_usage filter', async (t) => {
  const dir = scratchStateDir(t);
  const store = createJobStore(dir);
  await store.appendEvent({ type: 'WORK_UNIT_DETERMINISTIC_EXECUTED', goal: '011', workUnitId: 'a', durationMs: 5, modelCalls: 0 });
  await store.appendEvent({ type: 'WORK_UNIT_DETERMINISTIC_EXECUTED', goal: '012', workUnitId: 'b', durationMs: 50, modelCalls: 0 });

  const scoped = await summariseWorkUnits({ stateDir: dir, goal: '011' });
  assert.equal(scoped.deterministicUnits, 1);
  assert.equal(scoped.deterministicDurationMs, 5);

  const unscoped = await summariseWorkUnits({ stateDir: dir, goal: null });
  assert.equal(unscoped.deterministicUnits, 2);
});

test('no events.jsonl at all is zero Work Units, not an error', async (t) => {
  const dir = scratchStateDir(t);
  const summary = await summariseWorkUnits({ stateDir: dir, goal: null });
  assert.equal(summary.deterministicUnits, 0);
  assert.equal(summary.modelUnits, 0);
  assert.equal(summary.error, null);
});
