/**
 * Unit tests for the shadow benchmark infrastructure: the tagging contract,
 * the comparison logic, and — separately, in run-metrics.mjs's own suite —
 * that a benchmark-tagged row is excluded from normal metrics. Nothing here
 * spawns a model; `run-benchmark.mjs` (tested via its CLI functions) never
 * does either without `--confirm`, and not even then (see its own docstring).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BENCHMARK_VARIANTS, benchmarkContext, isKnownScenario, listBenchmarkScenarios, compareBenchmarkRun,
} from '../lib/benchmark.mjs';
import { parseBenchmarkArgs, renderBenchmarkPlan } from '../run-benchmark.mjs';

test('a known scenario is recognised, and the registry can be listed', () => {
  assert.ok(isKnownScenario('deterministic-vs-model'));
  assert.ok(listBenchmarkScenarios().some((s) => s.id === 'deterministic-vs-model'));
});

test('an unknown scenario is refused, not silently accepted', () => {
  assert.equal(isKnownScenario('nonsense-scenario'), false);
  assert.throws(() => benchmarkContext({ scenarioId: 'nonsense-scenario', variant: BENCHMARK_VARIANTS.MODEL }));
});

test('benchmarkContext stamps the tagging contract every benchmark call must carry', () => {
  const context = benchmarkContext({ scenarioId: 'deterministic-vs-model', variant: BENCHMARK_VARIANTS.MODEL });
  assert.equal(context.stage, 'benchmark');
  assert.equal(context.benchmark, true);
  assert.equal(context.benchmarkScenarioId, 'deterministic-vs-model');
  assert.equal(context.benchmarkVariant, BENCHMARK_VARIANTS.MODEL);
});

test('an unknown variant is refused', () => {
  assert.throws(() => benchmarkContext({ scenarioId: 'deterministic-vs-model', variant: 'NONSENSE' }));
});

// --- comparison logic ----------------------------------------------------

test('a comparison requires the SAME resultSignature on both sides — never a similarity guess', () => {
  const deterministic = { durationMs: 100, resultSignature: 'sig-a' };
  const model = { durationMs: 4000, resultSignature: 'sig-a', tokens: 500, costUsd: 0.01, model: 'claude-haiku-4-5' };
  const comparison = compareBenchmarkRun({ deterministic, model });
  assert.equal(comparison.status, 'OK');
  assert.equal(comparison.deterministic.modelCalls, 0);
  assert.equal(comparison.model.modelCalls, 1);
  assert.equal(comparison.durationDeltaMs, 3900);
});

test('mismatched result signatures never produce a verdict', () => {
  const comparison = compareBenchmarkRun({
    deterministic: { durationMs: 100, resultSignature: 'sig-a' },
    model: { durationMs: 100, resultSignature: 'sig-b' },
  });
  assert.equal(comparison.status, 'RESULTS_NOT_EQUIVALENT');
});

test('an incomplete pair (one side missing) is INCOMPLETE, not a crash', () => {
  assert.equal(compareBenchmarkRun({ deterministic: null, model: {} }).status, 'INCOMPLETE');
  assert.equal(compareBenchmarkRun({}).status, 'INCOMPLETE');
});

// --- 28: opt-in gating ---------------------------------------------------

test('28. without --confirm, the CLI plan always dry-runs and states nothing was spent', () => {
  const args = parseBenchmarkArgs(['n', 'x', '--scenario', 'deterministic-vs-model']);
  assert.equal(args.confirm, false);
  const plan = renderBenchmarkPlan(args);
  assert.match(plan, /DRY RUN/);
  assert.match(plan, /nothing was executed and nothing was spent/i);
});

test('--confirm alone is still not enough to make the CLI spend anything in this Goal', () => {
  const args = parseBenchmarkArgs(['n', 'x', '--scenario', 'deterministic-vs-model', '--confirm']);
  assert.equal(args.confirm, true);
  const plan = renderBenchmarkPlan(args);
  assert.match(plan, /nothing was executed and nothing was spent/i);
});

test('no --scenario given lists the known scenarios instead of guessing one', () => {
  const plan = renderBenchmarkPlan(parseBenchmarkArgs(['n', 'x']));
  assert.match(plan, /No --scenario given/);
  assert.match(plan, /deterministic-vs-model/);
});

test('an unknown --scenario is reported, not silently substituted for a known one', () => {
  const plan = renderBenchmarkPlan(parseBenchmarkArgs(['n', 'x', '--scenario', 'nonsense']));
  assert.match(plan, /Unknown scenario: nonsense/);
});
