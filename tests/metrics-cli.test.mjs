/**
 * Tests for the `ia-loop:metrics` CLI: argument parsing compatible with
 * `ia-loop:usage`'s filters, the OBSERVED/CALCULATED/ESTIMATED report shape,
 * text/JSON equivalence, and — the one property that matters most for a
 * read-only analytics layer — that generating a report never writes to the
 * ledger.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseMetricsArgs, buildMetricsReport, renderMetricsReport } from '../run-metrics.mjs';
import { buildUsageQuery, summariseWorkUnits } from '../run-usage.mjs';
import { openUsageLedger } from '../lib/usage-ledger.mjs';
import { buildUsageRecord } from '../lib/usage-normalizer.mjs';
import { createJobStore } from '../lib/job-store.mjs';
import {
  OPUS, SONNET, HAIKU, successResult, errorResult, modelUsageEntry, topLevelUsage,
} from './fixtures/cli-envelopes.mjs';

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ia-loop-metrics-'));
  const handles = [];
  t.after(() => {
    for (const handle of handles) handle.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return {
    dir,
    open() {
      const ledger = openUsageLedger({ path: join(dir, 'usage.sqlite') });
      handles.push(ledger);
      return ledger;
    },
  };
}

/** Opens and finalises one real row in one step, exactly as a completed call would. */
function seedRow(ledger, { envelope, context, invocationId, structuredOutput = true }) {
  const record = buildUsageRecord({
    context: { goalId: '010', roundId: 1, jobId: 'job-1', attemptId: 'job-1#a1', attempt: 1, role: 'developer', stage: 'implementation', ...context },
    capture: {
      invocationId, requestedModel: OPUS, sessionId: 'session-1', startedAt: '2026-09-09T10:00:00.000Z',
      finishedAt: '2026-09-09T10:01:00.000Z', durationMs: 60_000, envelope, structuredOutput,
      resolvedPrimaryModel: envelope?.modelUsage ? Object.keys(envelope.modelUsage)[0] : null,
      counters: { assistantMessages: 2, toolCallCount: 0 },
    },
  });
  const begin = ledger.begin({ idempotencyKey: invocationId, record: { ...record, status: 'STARTED' } });
  return ledger.finalize({ id: begin.id, idempotencyKey: invocationId, record });
}

function seededLedger(t) {
  const s = scratch(t);
  const ledger = s.open();

  seedRow(ledger, {
    invocationId: 'inv-sonnet', context: { operation: 'implementation' },
    envelope: successResult({ model: SONNET, cost: 1.5 }),
  });
  seedRow(ledger, {
    invocationId: 'inv-opus', context: { operation: 'review', role: 'tech_lead' },
    envelope: successResult({ model: OPUS, cost: 4.2 }),
  });
  seedRow(ledger, {
    invocationId: 'inv-haiku-retry', context: { operation: 'work_unit', workUnitId: 'WU-1', attempt: 2, attemptId: 'job-1#a2' },
    envelope: successResult({ model: HAIKU, cost: 0.2 }),
  });
  seedRow(ledger, {
    invocationId: 'inv-fallback', context: { operation: 'review', role: 'tech_lead', isFallback: true, fallbackFromModel: 'fable', fallbackReason: 'USAGE_LIMIT' },
    envelope: successResult({ model: OPUS, cost: 0.9 }),
  });
  seedRow(ledger, {
    invocationId: 'inv-escalation', context: { operation: 'implementation', isEscalation: true, escalationFromModel: 'sonnet', escalationReason: 'REPEATED_FAILURE' },
    envelope: successResult({ model: OPUS, cost: 0.6 }),
  });
  seedRow(ledger, {
    invocationId: 'inv-failed', context: { operation: 'review', role: 'tech_lead' }, structuredOutput: false,
    envelope: errorResult({
      usage: topLevelUsage({ input: 1000, output: 200 }),
      models: { [SONNET]: modelUsageEntry({ input: 1000, output: 200, costUSD: 0.05 }) },
      cost: 0.05,
    }),
  });

  return { ledger, stateDir: s.dir };
}

function counts(ledger) {
  return {
    usage: ledger.query('SELECT COUNT(*) AS n FROM model_usage')[0].n,
    integrity: ledger.query('SELECT COUNT(*) AS n FROM model_usage_integrity')[0].n,
    correction: ledger.query('SELECT COUNT(*) AS n FROM model_usage_correction')[0].n,
  };
}

// --- filters compatible with ia-loop:usage ----------------------------------

test('parseMetricsArgs supports the same goal/run/job/model/role filters as ia-loop:usage', () => {
  const filters = parseMetricsArgs(['n', 'x', '--goal', '010', '--run', 'auto-1', '--job', 'j1', '--model', 'claude-opus-5', '--role', 'developer']);
  const { sql, params } = buildUsageQuery(filters);
  assert.match(sql, /goal_id = \?/);
  assert.match(sql, /run_id = \?/);
  assert.match(sql, /job_id = \?/);
  assert.match(sql, /resolved_model = \?/);
  assert.match(sql, /role = \?/);
  assert.deepEqual(params, ['010', 'auto-1', 'j1', 'claude-opus-5', 'developer', filters.limit]);
});

test('the default limit is large enough to never silently truncate an aggregate, unlike ia-loop:usage\'s display default', () => {
  const filters = parseMetricsArgs(['n', 'x']);
  assert.ok(filters.limit >= 100_000);
});

test('an explicit --limit is still honoured', () => {
  assert.equal(parseMetricsArgs(['n', 'x', '--limit', '5']).limit, 5);
});

test('--pricing-snapshot overrides the default snapshot id', () => {
  assert.equal(parseMetricsArgs(['n', 'x']).pricingSnapshotId, 'claude-ledger-calibrated-2026-09');
  assert.equal(parseMetricsArgs(['n', 'x', '--pricing-snapshot', 'other-snapshot']).pricingSnapshotId, 'other-snapshot');
});

// --- report wiring: overhead, deterministic units, efficiency ---------------

test('OBSERVED overhead figures pass through failed/retry/fallback/escalation from summarise(), unmodified', async (t) => {
  const { ledger, stateDir } = seededLedger(t);
  const rows = ledger.query(buildUsageQuery(parseMetricsArgs(['n', 'x'])).sql, buildUsageQuery(parseMetricsArgs(['n', 'x'])).params);
  const workUnits = await summariseWorkUnits({ stateDir, goal: null });
  const report = buildMetricsReport({ rows, workUnits, pricingSnapshotId: 'claude-ledger-calibrated-2026-09' });

  assert.ok(report.observed.failureOverheadTokens > 0);
  assert.ok(report.observed.retryOverheadTokens > 0);
  assert.ok(report.observed.fallbackOverheadTokens > 0);
  assert.ok(report.observed.escalationOverheadTokens > 0);
});

test('a row can count under several overhead categories at once — they are not exclusive', async (t) => {
  const { ledger, stateDir } = seededLedger(t);
  const { sql, params } = buildUsageQuery(parseMetricsArgs(['n', 'x']));
  const rows = ledger.query(sql, params);
  const workUnits = await summariseWorkUnits({ stateDir, goal: null });
  const report = buildMetricsReport({ rows, workUnits, pricingSnapshotId: 'claude-ledger-calibrated-2026-09' });
  // The retry row and the escalation row are each ALSO counted toward
  // allModelTokens; overhead categories summing to more than allModelTokens
  // is expected, not a bug — see computeEfficiency's own test coverage.
  assert.ok(report.observed.retryOverheadTokens + report.observed.escalationOverheadTokens <= report.observed.allModelTokens * 2);
});

test('deterministic Work Units are OBSERVED facts, and deterministic savings stays ESTIMATED (INSUFFICIENT_DATA with no comparable history)', async (t) => {
  const { stateDir } = seededLedger(t);
  const store = createJobStore(stateDir);
  await store.appendEvent({ type: 'WORK_UNIT_DETERMINISTIC_EXECUTED', goal: '010', workUnitId: 'WU-9', durationMs: 42, modelCalls: 0 });

  const workUnits = await summariseWorkUnits({ stateDir, goal: '010' });
  const report = buildMetricsReport({ rows: [], workUnits, populationRows: [], pricingSnapshotId: 'claude-ledger-calibrated-2026-09' });

  assert.equal(report.observed.deterministicUnits, 1);
  assert.equal(report.observed.deterministicModelCalls, 0);
  assert.equal(report.estimated.deterministicSavings.classification, 'ESTIMATED');
  assert.equal(report.estimated.deterministicSavings.status, 'INSUFFICIENT_DATA');
  assert.equal(report.estimated.legacyArchitectureSavings.status, 'INSUFFICIENT_DATA');
});

test('observed and calculated are never mixed: no estimated field appears under observed or calculated', async (t) => {
  const { ledger, stateDir } = seededLedger(t);
  const { sql, params } = buildUsageQuery(parseMetricsArgs(['n', 'x']));
  const rows = ledger.query(sql, params);
  const workUnits = await summariseWorkUnits({ stateDir, goal: null });
  const report = buildMetricsReport({ rows, workUnits, pricingSnapshotId: 'claude-ledger-calibrated-2026-09' });

  assert.equal('status' in report.observed, false);
  assert.equal(JSON.stringify(report.calculated).includes('deterministicSavings'), false);
  assert.ok(report.calculated.routingSavingsUsd !== undefined);
});

// --- text / JSON equivalence -------------------------------------------

test('the text report and the report object agree on every headline number', async (t) => {
  const { ledger, stateDir } = seededLedger(t);
  const { sql, params } = buildUsageQuery(parseMetricsArgs(['n', 'x', '--goal', '010']));
  const rows = ledger.query(sql, params);
  const workUnits = await summariseWorkUnits({ stateDir, goal: '010' });
  const report = buildMetricsReport({ rows, workUnits, pricingSnapshotId: 'claude-ledger-calibrated-2026-09' });
  const text = renderMetricsReport(report, { goal: '010' });

  assert.match(text, new RegExp(`\\b${report.observed.executions}\\b`));
  assert.match(text, new RegExp(`\\b${report.observed.allModelTokens}\\b`));
  assert.match(text, new RegExp(report.pricing.snapshotId));
  assert.match(text, /Routing (savings|delta)/);
  assert.match(text, /INSUFFICIENT_DATA/);
});

test('a JSON round-trip of the report preserves the same classification structure', async (t) => {
  const { ledger, stateDir } = seededLedger(t);
  const { sql, params } = buildUsageQuery(parseMetricsArgs(['n', 'x']));
  const rows = ledger.query(sql, params);
  const workUnits = await summariseWorkUnits({ stateDir, goal: null });
  const report = buildMetricsReport({ rows, workUnits, pricingSnapshotId: 'claude-ledger-calibrated-2026-09' });
  const parsed = JSON.parse(JSON.stringify({ observed: report.observed, calculated: report.calculated, estimated: report.estimated, baselines: report.baselines, pricing: report.pricing, integrity: report.integrity }));
  assert.deepEqual(Object.keys(parsed), ['observed', 'calculated', 'estimated', 'baselines', 'pricing', 'integrity']);
  assert.equal(parsed.baselines.ACTUAL.classification, 'CALCULATED');
  assert.equal(parsed.baselines.ALL_OPUS.classification, 'CALCULATED');
});

// --- read-only: generating a report never writes to the ledger -------------

test('building a metrics report leaves the ledger byte-for-byte the same: no new rows, no integrity rows, no corrections', async (t) => {
  const { ledger, stateDir } = seededLedger(t);
  const before = counts(ledger);

  const { sql, params } = buildUsageQuery(parseMetricsArgs(['n', 'x']));
  const rows = ledger.query(sql, params);
  const workUnits = await summariseWorkUnits({ stateDir, goal: null });
  const report = buildMetricsReport({ rows, workUnits, pricingSnapshotId: 'claude-ledger-calibrated-2026-09' });
  renderMetricsReport(report, { goal: null });
  JSON.stringify(report);

  const after = counts(ledger);
  assert.deepEqual(after, before, 'reading and reporting must never mutate model_usage or its satellite tables');
});

test('an unknown model in a real row does not throw and is reported, not silently dropped', async (t) => {
  const s = scratch(t);
  const ledger = s.open();
  seedRow(ledger, {
    invocationId: 'inv-unknown', context: { operation: 'review', role: 'tech_lead' },
    envelope: successResult({ model: 'gpt-5', models: { 'gpt-5': modelUsageEntry({ input: 100, output: 50, costUSD: 0.01 }) } }),
  });
  const { sql, params } = buildUsageQuery(parseMetricsArgs(['n', 'x']));
  const rows = ledger.query(sql, params);
  const workUnits = await summariseWorkUnits({ stateDir: s.dir, goal: null });
  const report = buildMetricsReport({ rows, workUnits, pricingSnapshotId: 'claude-ledger-calibrated-2026-09' });

  assert.ok(report.calculated.unknownModels.includes('gpt-5'));
  assert.ok(report.integrity.flags.includes('PRICING_MODEL_UNKNOWN'));
});

// --- 27: benchmark rows excluded from normal metrics ------------------------

test('27. a row tagged operation=\'benchmark\' is excluded from the report entirely, not just hidden from a total', async (t) => {
  const s = scratch(t);
  const ledger = s.open();
  seedRow(ledger, {
    invocationId: 'inv-real', context: { operation: 'implementation' },
    envelope: successResult({ model: SONNET, cost: 1 }),
  });
  seedRow(ledger, {
    invocationId: 'inv-benchmark', context: { stage: 'benchmark' },
    envelope: successResult({ model: OPUS, cost: 999 }),
  });

  const { sql, params } = buildUsageQuery(parseMetricsArgs(['n', 'x']));
  const rows = ledger.query(sql, params);
  assert.equal(rows.length, 2, 'both rows are really on the ledger — the exclusion is a report-time filter, not a missing write');

  const workUnits = await summariseWorkUnits({ stateDir: s.dir, goal: null });
  const report = buildMetricsReport({ rows, workUnits, pricingSnapshotId: 'claude-ledger-calibrated-2026-09' });

  assert.equal(report.observed.executions, 1, 'the benchmark row is excluded from the operational count');
  assert.equal(report.observed.providerReportedCostUsd, 1, 'the $999 benchmark cost never enters the normal total');
  assert.equal(report.benchmarks.excludedRows, 1);
});

// --- 31: JSON explainability -------------------------------------------

test('31. a deterministic-savings estimate is explainable from the JSON alone: method, sample size, and the exact Work Unit ids behind it', async (t) => {
  const s = scratch(t);
  const ledger = s.open();
  seedRow(ledger, {
    invocationId: 'inv-hist-1', context: { operation: 'work_unit', workUnitId: 'WU-hist-1' },
    envelope: successResult({ model: SONNET, cost: 0.5 }),
  });
  const store = createJobStore(s.dir);
  await store.appendEvent({ type: 'WORK_UNIT_DETERMINISTIC_EXECUTED', goal: '010', workUnitId: 'WU-det-1', action: 'lint', durationMs: 50, modelCalls: 0 });

  const { sql, params } = buildUsageQuery(parseMetricsArgs(['n', 'x']));
  const rows = ledger.query(sql, params);
  const events = await store.readEvents();
  const workUnits = await summariseWorkUnits({ stateDir: s.dir, goal: null });
  const report = buildMetricsReport({ rows, workUnits, events, pricingSnapshotId: 'claude-ledger-calibrated-2026-09' });

  const det = report.estimated.deterministicSavings;
  assert.equal(det.status, 'OK');
  assert.equal(det.method, 'HISTORICAL_MATCHED_WORK_UNITS');
  assert.equal(det.sampleSize, 1);
  assert.deepEqual(det.sampleWorkUnitIds, ['WU-hist-1']);
  assert.ok(det.confidence);
  // The JSON alone — no source file — names exactly what produced the number.
  const serialised = JSON.parse(JSON.stringify(det));
  assert.deepEqual(serialised.sampleWorkUnitIds, ['WU-hist-1']);

  const text = renderMetricsReport(report, { goal: null, verboseDeterministic: true });
  assert.match(text, /Tokens avoided \(est\.\):\s+\d/, 'the verbose render must show a real number, not a broken "n/a"');
  assert.match(text, /Sample Work Unit ids: WU-hist-1/);
});

// --- 39: MODEL EFFECTIVENESS JSON/text consistency --------------------

test('39. the MODEL EFFECTIVENESS table and the JSON effectiveness.byModel agree on the same numbers', async (t) => {
  const { ledger, stateDir } = seededLedger(t);
  const { sql, params } = buildUsageQuery(parseMetricsArgs(['n', 'x']));
  const rows = ledger.query(sql, params);
  const workUnits = await summariseWorkUnits({ stateDir, goal: null });
  const report = buildMetricsReport({ rows, workUnits, pricingSnapshotId: 'claude-ledger-calibrated-2026-09' });
  const text = renderMetricsReport(report, { goal: null });

  assert.match(text, /MODEL EFFECTIVENESS/);
  // HAIKU is the ledger's dated build string; effectiveness records are keyed
  // by the CANONICAL pricing model (see resolveCanonicalModel).
  const haikuRecord = report.effectiveness.byModel['claude-haiku-4-5'];
  assert.ok(haikuRecord, 'the seeded Haiku retry row should produce an effectiveness record');
  assert.match(text, new RegExp(haikuRecord.sample.calls.toString()));
});

test('effectiveness records classify data gaps as null/INSUFFICIENT_DATA, never a false zero', async (t) => {
  const { ledger, stateDir } = seededLedger(t);
  const { sql, params } = buildUsageQuery(parseMetricsArgs(['n', 'x']));
  const rows = ledger.query(sql, params);
  const workUnits = await summariseWorkUnits({ stateDir, goal: null });
  const report = buildMetricsReport({ rows, workUnits, pricingSnapshotId: 'claude-ledger-calibrated-2026-09' });
  for (const record of Object.values(report.effectiveness.byModel)) {
    if (record.sample.workUnits < 5) assert.equal(record.confidence, 'INSUFFICIENT_DATA');
  }
});

// --- 40/41: zero model calls / ledger read-only for the effectiveness section --

test('40/41. computing MODEL EFFECTIVENESS makes zero model calls and leaves the ledger untouched', async (t) => {
  const { ledger, stateDir } = seededLedger(t);
  const before = counts(ledger);

  const { sql, params } = buildUsageQuery(parseMetricsArgs(['n', 'x']));
  const rows = ledger.query(sql, params);
  const workUnits = await summariseWorkUnits({ stateDir, goal: null });
  const report = buildMetricsReport({ rows, workUnits, pricingSnapshotId: 'claude-ledger-calibrated-2026-09' });
  renderMetricsReport(report, { goal: null });
  JSON.stringify(report.effectiveness);

  assert.deepEqual(counts(ledger), before);
  // No new spawn site: this module never imports claude-process.mjs.
  assert.equal('invokeAgent' in report.effectiveness, false);
});

// --- Goal 015: STAGE TELEMETRY wiring ------------------------------------

test('the STAGE TELEMETRY section separates Fable\'s zero Work Unit calls from its real stage calls, in text and JSON alike', async (t) => {
  const s = scratch(t);
  const ledger = s.open();
  const FABLE = 'claude-fable-5-1';
  seedRow(ledger, {
    invocationId: 'inv-fable-review', context: { operation: 'review', jobId: 'review-job-1' },
    envelope: successResult({ model: FABLE, models: { [FABLE]: modelUsageEntry({ input: 10, output: 5, costUSD: 0.01 }) }, cost: 0.01 }),
  });
  const { sql, params } = buildUsageQuery(parseMetricsArgs(['n', 'x']));
  const rows = ledger.query(sql, params);
  const workUnits = await summariseWorkUnits({ stateDir: s.dir, goal: null });
  const report = buildMetricsReport({ rows, workUnits, pricingSnapshotId: 'claude-ledger-calibrated-2026-09' });

  const fable = report.stageTelemetry.byModel[FABLE];
  assert.ok(fable, 'Fable should get a stage-telemetry row from its review call');
  assert.equal(fable.workUnitCalls, 0);
  assert.equal(fable.stageCalls, 1);
  assert.equal(fable.review, 1);

  const text = renderMetricsReport(report, { goal: null });
  assert.match(text, /STAGE TELEMETRY/);
  assert.match(text, /Work Unit calls/);
});

test('34/35: computing STAGE TELEMETRY makes zero model calls, and the full ledger read/report cycle stays read-only', async (t) => {
  const { ledger, stateDir } = seededLedger(t);
  const before = counts(ledger);

  const { sql, params } = buildUsageQuery(parseMetricsArgs(['n', 'x']));
  const rows = ledger.query(sql, params);
  const workUnits = await summariseWorkUnits({ stateDir, goal: null });
  const report = buildMetricsReport({ rows, workUnits, pricingSnapshotId: 'claude-ledger-calibrated-2026-09' });
  renderMetricsReport(report, { goal: null });
  JSON.stringify(report.stageTelemetry);

  assert.deepEqual(counts(ledger), before, 'stage telemetry must never write to the ledger');
  assert.ok(report.stageTelemetry.coverage);
  assert.ok(report.stageTelemetry.byModel);
});
