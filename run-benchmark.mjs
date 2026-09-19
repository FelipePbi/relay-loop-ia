#!/usr/bin/env node
/**
 * IA Loop — shadow benchmark CLI. Opt-in, never automatic.
 *
 *   npm run ia-loop:benchmark -- --scenario deterministic-vs-model
 *   npm run ia-loop:benchmark -- --scenario deterministic-vs-model --confirm
 *
 * Without `--confirm` this ALWAYS dry-runs: it describes what a real
 * benchmark would do and spends nothing. That is the default on purpose —
 * a benchmark's MODEL variant is a real, billed inference (Goal 013 §12).
 *
 * With `--confirm`, this still does not spawn a model. Actually running the
 * paired DETERMINISTIC/MODEL execution requires driving
 * `work-unit-executor.mjs` against a real worktree and job store, which this
 * Goal deliberately scopes OUT (see the Goal's "Fora de escopo": "executar
 * benchmarks pagos automaticamente"). What exists here — and is tested — is
 * the part that must exist BEFORE any such execution is safe to add: the
 * opt-in gate, the scenario registry, and the tagging contract
 * (`benchmarkContext`) that keeps a benchmark call identifiable and excluded
 * from `ia-loop:metrics`'s normal population (`operation: 'benchmark'`,
 * `lib/usage-context.mjs`). Wiring the actual dual execution is the
 * documented extension point for whoever picks this up next.
 */

import { SpikeError } from './lib/claude-process.mjs';
import { isDirectExecution } from './lib/direct-execution.mjs';
import {
  BENCHMARK_VARIANTS, benchmarkContext, isKnownScenario, listBenchmarkScenarios,
} from './lib/benchmark.mjs';

export function parseBenchmarkArgs(argv) {
  const args = argv.slice(2);
  const valueOf = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] ?? null : null;
  };
  return {
    scenarioId: valueOf('--scenario'),
    workUnitId: valueOf('--unit'),
    confirm: args.includes('--confirm'),
  };
}

export function renderBenchmarkPlan({ scenarioId, workUnitId, confirm }) {
  const out = ['IA-LOOP SHADOW BENCHMARK', ''];

  if (!scenarioId) {
    out.push('No --scenario given. Known scenarios:');
    for (const scenario of listBenchmarkScenarios()) out.push(`  ${scenario.id} — ${scenario.description}`);
    return out.join('\n');
  }

  if (!isKnownScenario(scenarioId)) {
    out.push(`Unknown scenario: ${scenarioId}`);
    out.push('Known scenarios:');
    for (const scenario of listBenchmarkScenarios()) out.push(`  ${scenario.id}`);
    return out.join('\n');
  }

  out.push(`Scenario: ${scenarioId}`);
  out.push(`Work Unit: ${workUnitId ?? '(none given — a real run would require one)'}`);
  out.push('');
  out.push('This WOULD run the Work Unit twice and compare them:');
  out.push(`  1. ${BENCHMARK_VARIANTS.DETERMINISTIC} — native execution, modelCalls = 0, tokens = 0 (OBSERVED)`);
  out.push(`  2. ${BENCHMARK_VARIANTS.MODEL} — a REAL, BILLED model call (OBSERVED, tagged operation='benchmark')`);
  out.push('  Compared only if both report the SAME resultSignature (lib/benchmark.mjs).');
  out.push('');
  out.push('Both variants would publish benchmarkContext({ scenarioId, variant }) as their usage');
  out.push('context, so the MODEL call lands in the ledger tagged benchmark=true / operation=\'benchmark\'');
  out.push('and ia-loop:metrics excludes it from normal totals by default.');

  if (!confirm) {
    out.push('');
    out.push('DRY RUN — nothing was executed and nothing was spent. Pass --confirm to proceed.');
  } else {
    out.push('');
    out.push('--confirm was given, but this Goal does not wire the actual dual execution (see this');
    out.push('file\'s own docstring): running it live means driving work-unit-executor.mjs against a');
    out.push('real worktree, which is out of scope here. Nothing was executed and nothing was spent.');
  }

  return out.join('\n');
}

async function main() {
  const args = parseBenchmarkArgs(process.argv);
  console.log(renderBenchmarkPlan(args));
  return 0;
}

if (isDirectExecution(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      const code = error instanceof SpikeError ? error.code : 'UNEXPECTED_ERROR';
      console.error(`ATENDLY IA LOOP — benchmark\n\nCannot build plan: [${code}] ${error.message}`);
      process.exitCode = 1;
    });
}
