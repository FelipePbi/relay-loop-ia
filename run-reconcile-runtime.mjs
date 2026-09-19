#!/usr/bin/env node
/**
 * IA Loop — make the derived runtime agree with the jobs on disk.
 *
 *   npm run ia-loop:reconcile-runtime -- --goal 005
 *   npm run ia-loop:reconcile-runtime -- --goal 005 --apply
 *
 * Dry by default. Without --apply it reads the jobs, their results and the
 * runtime, prints the divergence, and writes nothing.
 *
 * This is NOT `--resolved`, NOT `ia-loop:reclassify` and NOT
 * `ia-loop:authorize-retry`. It creates no attempt, calls no model and repairs
 * no failure. It only corrects a CACHE — `runtime.json` — that recorded a
 * conclusion the facts never supported, and it refuses whenever the facts still
 * call for a person.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SpikeError } from './lib/claude-process.mjs';
import { createJobStore } from './lib/job-store.mjs';
import { createAutonomousStore } from './lib/autonomous-state.mjs';
import { assessRuntimeDivergence, reconcileRuntimeFromResults } from './lib/runtime-reconciliation.mjs';
import { LOOP_CONFIG } from './lib/loop-config.mjs';
import { isDirectExecution } from './lib/direct-execution.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, '.state');

function parseArgs(argv) {
  const args = argv.slice(2);
  const at = args.indexOf('--goal');
  const goal = at >= 0 ? args[at + 1] : args.find((a) => /^\d{3}$/.test(a));
  if (!goal || !/^\d{3}$/.test(goal)) {
    throw new SpikeError('INVALID_ARGS', 'Usage: --goal <goalId> [--apply]');
  }
  return { goal, apply: args.includes('--apply') };
}

async function main() {
  const emit = (line = '') => console.log(line);
  const { goal, apply } = parseArgs(process.argv);
  const store = createJobStore(STATE_DIR);
  const auto = createAutonomousStore(STATE_DIR);

  emit('');
  emit('IA Loop — runtime reconciliation');
  emit('');
  emit(`Mode:\n${apply ? 'APPLY' : 'DRY_RUN (nothing is written)'}`);
  emit('');

  const assessment = await assessRuntimeDivergence(store, { goal, maxRounds: LOOP_CONFIG.maxCorrectionRounds });

  emit('Runtime says:');
  emit(`  state: ${assessment.runtimeState ?? 'n/a'}`);
  emit(`  decision: ${assessment.runtimeDecision ?? 'n/a'}`);
  emit(`  reason: ${assessment.runtimeReason ?? 'n/a'}`);
  emit('');

  emit('Jobs and results say:');
  if (assessment.latestReview) {
    emit(`  review round ${assessment.latestReview.round}: ${assessment.latestReview.decision}`);
    emit(`  job: ${assessment.latestReview.jobId}`);
    emit(`  attempt: ${assessment.latestReview.attemptId ?? 'not recorded'}`);
    emit(`  blockers: ${assessment.latestReview.blockers.length}`);
    emit(`  next developer profile: ${assessment.latestReview.nextDeveloperProfile ?? '(unchanged)'}`);
  } else {
    emit('  no completed review on disk');
  }
  emit(`  next: ${assessment.next.kind}${assessment.next.round ? ` round ${assessment.next.round}` : ''}`);
  emit('');

  if (!assessment.diverged) {
    emit(assessment.factsSayHuman
      ? 'The facts genuinely call for a human. The runtime is not wrong; nothing to reconcile.'
      : 'The runtime already agrees with the jobs on disk. Nothing to reconcile.');
    return 1;
  }

  emit('DIVERGENCE: the runtime holds a human gate the results do not support.');
  emit('');

  if (!apply) {
    emit('Would reconcile:');
    emit(`  state: ${assessment.runtimeState} → ${assessment.next.kind}`);
    emit(`  round: ${assessment.execution?.round ?? 'n/a'} → ${assessment.next.round ?? 'n/a'}`);
    emit(`  decision: ${assessment.runtimeDecision} → ${assessment.latestReview?.decision ?? 'null'}`);
    emit(`  blockers: ${(assessment.next.blockers ?? []).length} carried from the review`);
    emit(`  human gate: cleared`);
    emit('');
    emit('No attempt is created, no model is called. Re-run with --apply to write it.');
    return 0;
  }

  const applied = await reconcileRuntimeFromResults(store, {
    goal, maxRounds: LOOP_CONFIG.maxCorrectionRounds, autonomousStore: auto,
  });

  emit('Reconciled:');
  emit(`  state: ${applied.runtime.state}`);
  emit(`  round: ${applied.runtime.round}`);
  emit(`  decision (last reviewed round): ${applied.runtime.decision ?? 'none'}`);
  emit(`  blockers carried: ${(applied.runtime.blockers ?? []).length}`);
  emit(`  next developer profile: ${applied.runtime.nextDeveloperProfile?.profile ?? '(unchanged)'}`);
  emit(`  human gate: ${applied.runtime.humanRequired === null ? 'cleared' : 'kept'}`);
  if (applied.run) emit(`  run ${applied.run.autonomousRunId}: ${applied.run.status}`);
  emit('');
  emit('No attempt was created and no model was called. The event log records the correction.');
  return 0;
}

// Only when this file IS the program. Importing it — from a test, a doc
// generator, or an agent reading the tooling — must never start anything.
if (isDirectExecution(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      const code = error instanceof SpikeError ? error.code : 'UNEXPECTED_ERROR';
      console.error(`\nATENDLY IA LOOP\n\nCannot reconcile: [${code}] ${error.message}`);
      process.exitCode = 1;
    });
}
