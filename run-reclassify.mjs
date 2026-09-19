#!/usr/bin/env node
/**
 * IA Loop — repair a failure the classifier read wrongly.
 *
 *   npm run ia-loop:reclassify -- --role tech_lead --job 005-r1-tech_lead-ca1d7bf4
 *   npm run ia-loop:reclassify -- --role tech_lead --job <id> --apply
 *
 * Dry by default. Without --apply it reads the persisted evidence, re-runs it
 * through the current classifier and prints what would change, writing nothing.
 *
 * This is NOT `--resolved`. It does not retire a run or declare a problem
 * solved: it says what a failure actually was, on the evidence already on disk,
 * and lets the ordinary capacity path continue from there. If the evidence
 * still classifies the same way, there is nothing to repair and it refuses.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SpikeError } from './lib/claude-process.mjs';
import { createJobStore } from './lib/job-store.mjs';
import { createAutonomousStore } from './lib/autonomous-state.mjs';
import { findFailureEvidence, reclassifyEvidence, reclassifyFailure } from './lib/failure-reclassification.mjs';
import { LOOP_STATES } from './lib/loop-state.mjs';
import { ROLES } from './lib/contracts-v2.mjs';
import { isDirectExecution } from './lib/direct-execution.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, '.state');

/** Where a repaired attempt resumes: the state its own role works in. */
const RESUME_STATE = Object.freeze({
  tech_lead: LOOP_STATES.REVIEWER_RUNNING,
  developer: LOOP_STATES.DEVELOPER_RUNNING,
});

function parseArgs(argv) {
  const args = argv.slice(2);
  const valueOf = (name) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : null;
  };
  const role = valueOf('role');
  const jobId = valueOf('job');

  if (!role || !ROLES.includes(role)) {
    throw new SpikeError('INVALID_ARGS', `--role must be one of ${ROLES.join(', ')}`);
  }
  if (!jobId) throw new SpikeError('INVALID_ARGS', 'Usage: --role <role> --job <jobId> [--apply]');

  return { role, jobId, apply: args.includes('--apply') };
}

async function main() {
  const emit = (line = '') => console.log(line);
  const { role, jobId, apply } = parseArgs(process.argv);
  const store = createJobStore(STATE_DIR);
  const auto = createAutonomousStore(STATE_DIR);

  emit('');
  emit('IA Loop — failure reclassification');
  emit('');
  emit(`Mode:\n${apply ? 'APPLY' : 'DRY_RUN (nothing is written)'}`);
  emit('');

  const evidence = await findFailureEvidence(store, { role, jobId });
  emit('Evidence on disk:');
  emit(`  job: ${jobId}`);
  emit(`  failed at: ${evidence.failedAt}`);
  emit(`  recorded as: ${evidence.recordedReason}`);
  emit(`  diagnostic: ${evidence.diagnostic}`);
  emit('');

  const verdict = reclassifyEvidence(evidence);
  emit('Re-read with the current classifier:');
  emit(`  from: ${verdict.from}`);
  emit(`  to: ${verdict.to}`);
  emit(`  action: ${verdict.action}`);
  emit(`  reset stated: ${verdict.resetAt ?? 'none parseable'}`);
  emit(`  changed: ${verdict.changed ? 'YES' : 'NO'}`);
  emit('');

  if (!verdict.changed) {
    emit('The recorded classification still stands. Nothing to repair.');
    return 1;
  }

  if (!apply) {
    emit('Would repair:');
    emit(`  attempt status: FAILED → WAITING_FOR_CAPACITY`);
    emit(`  classification: ${verdict.from} → ${verdict.to}`);
    emit(`  resume into: ${RESUME_STATE[role]}`);
    emit('');
    emit('Re-run with --apply to write it.');
    return 0;
  }

  const applied = await reclassifyFailure(store, {
    role, jobId, resumeFrom: RESUME_STATE[role], autonomousStore: auto,
  });

  emit('Repaired:');
  emit(`  attempt: ${applied.repair.attemptId}`);
  emit(`  ${applied.repair.originalStatus}/${applied.repair.originalClassification}`
    + ` → ${applied.repair.correctedSemanticStatus}/${applied.repair.correctedClassification}`);
  emit(`  next retry at: ${applied.capacity.nextRetryAt}`);
  emit(`  eligible now: ${applied.capacity.retryIntervalMs === 0 ? 'YES' : 'NO'}`);
  if (applied.run) emit(`  run ${applied.run.autonomousRunId}: ${applied.run.status}`);
  emit('');
  emit('The original failure is preserved and the event log records the correction.');
  return 0;
}

// Only when this file IS the program. Importing it — from a test, a doc
// generator, or an agent reading the tooling — must never start anything.
if (isDirectExecution(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      const code = error instanceof SpikeError ? error.code : 'UNEXPECTED_ERROR';
      console.error(`\nATENDLY IA LOOP\n\nCannot reclassify: [${code}] ${error.message}`);
      process.exitCode = 1;
    });
}
