/**
 * IA Loop — shadow benchmark infrastructure. Opt-in, never auto-run.
 *
 * Comparing a DETERMINISTIC Work Unit against an equivalent MODEL-executed
 * one costs real tokens, so nothing here executes a model on its own — this
 * module is pure description and comparison logic. `run-benchmark.mjs` is
 * the ONLY place that may actually spawn a model, and only behind an
 * explicit `--confirm` flag (see that file's own guard).
 *
 * Every benchmark invocation MUST publish `benchmarkContext(...)` as its
 * usage context, which stamps `stage: 'benchmark'` — mapped to
 * `operation: 'benchmark'` in `usage-context.mjs` — so its ledger row (a
 * MODEL variant makes a real call and gets one; a DETERMINISTIC variant, like
 * any deterministic Work Unit, makes none) is identifiable and excluded from
 * ordinary metrics by construction, not by a name it happens to carry.
 */

export const BENCHMARK_VARIANTS = Object.freeze({
  DETERMINISTIC: 'DETERMINISTIC',
  MODEL: 'MODEL',
});

export const BENCHMARK_SCENARIOS = Object.freeze({
  'deterministic-vs-model': Object.freeze({
    id: 'deterministic-vs-model',
    description: 'Runs one Work Unit both DETERMINISTIC (native) and MODEL, and compares '
      + 'duration/tokens/cost when — and only when — the two produce a semantically equivalent result.',
  }),
});

export function listBenchmarkScenarios() {
  return Object.values(BENCHMARK_SCENARIOS);
}

export function isKnownScenario(scenarioId) {
  return Boolean(BENCHMARK_SCENARIOS[scenarioId]);
}

/**
 * The usage context every benchmark call must carry. Throws on an unknown
 * scenario/variant rather than tagging a call ambiguously — a benchmark row
 * that cannot be traced to a known scenario cannot be excluded reliably
 * either.
 */
export function benchmarkContext({ scenarioId, variant }) {
  if (!isKnownScenario(scenarioId)) throw new Error(`Unknown benchmark scenario: ${JSON.stringify(scenarioId)}`);
  if (!BENCHMARK_VARIANTS[variant]) throw new Error(`Unknown benchmark variant: ${JSON.stringify(variant)}`);
  return {
    stage: 'benchmark',
    benchmark: true,
    benchmarkScenarioId: scenarioId,
    benchmarkVariant: variant,
  };
}

/**
 * Compares the two variants' measurements. Produces a verdict ONLY when both
 * sides report the same `resultSignature` — a caller-supplied, deterministic
 * fingerprint of the semantic result (never text similarity, never an LLM
 * judgement). Without equivalence, "compared" would just mean "two unrelated
 * numbers next to each other".
 */
export function compareBenchmarkRun({ deterministic, model } = {}) {
  if (!deterministic || !model) return { status: 'INCOMPLETE' };
  if (deterministic.resultSignature !== model.resultSignature) {
    return { status: 'RESULTS_NOT_EQUIVALENT' };
  }
  return {
    status: 'OK',
    deterministic: { durationMs: deterministic.durationMs ?? null, modelCalls: 0, tokens: 0 },
    model: {
      durationMs: model.durationMs ?? null,
      modelCalls: 1,
      tokens: model.tokens ?? null,
      costUsd: model.costUsd ?? null,
      model: model.model ?? null,
    },
    durationDeltaMs: (Number.isFinite(model.durationMs) && Number.isFinite(deterministic.durationMs))
      ? model.durationMs - deterministic.durationMs
      : null,
  };
}
