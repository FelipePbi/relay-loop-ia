#!/usr/bin/env node
/**
 * IA Loop — authorise one retry after a harness bug was fixed.
 *
 *   npm run ia-loop:authorize-retry -- --role tech_lead --job 005-r1-tech_lead-ca1d7bf4
 *   npm run ia-loop:authorize-retry -- --role tech_lead --job <id> \
 *     --reason "stream-json argv fixed" --fix-commit <sha> --apply
 *
 * Dry by default: without --apply it reads the evidence, re-runs it through the
 * current classifier and prints what would change, writing nothing.
 *
 * This is NOT `--resolved` and NOT `ia-loop:reclassify`.
 *
 *   --resolved            retires a run as though a person handled it.
 *   ia-loop:reclassify    says a "failure" was really a capacity WAIT.
 *   this                  keeps the failure a failure, and authorises exactly
 *                         one successor because the defect that caused it was
 *                         in our own tooling and has since been fixed.
 *
 * The failed attempt stays FAILED in the record, with its original
 * classification and its original error. Nothing is deleted.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SpikeError } from './lib/claude-process.mjs';
import { createJobStore } from './lib/job-store.mjs';
import { createAutonomousStore } from './lib/autonomous-state.mjs';
import {
  HARNESS_RETRY_OUTCOMES,
  assessHarnessFailure,
  authorizeRetryAfterHarnessFix,
  findExistingAuthorization,
  findHarnessFailure,
} from './lib/harness-retry.mjs';
import { LOOP_STATES } from './lib/loop-state.mjs';
import { ROLES } from './lib/contracts-v2.mjs';
import { isDirectExecution } from './lib/direct-execution.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, '.state');

/** Where an authorised attempt resumes: the state its own role works in. */
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
  const detail = valueOf('reason');

  if (!role || !ROLES.includes(role)) {
    throw new SpikeError('INVALID_ARGS', `--role must be one of ${ROLES.join(', ')}`);
  }
  if (!jobId) {
    throw new SpikeError('INVALID_ARGS',
      'Usage: --role <role> --job <jobId> --reason "<why>" [--fix-commit <sha>] [--apply]');
  }
  // An operator must say why. A retry with no stated reason is not auditable,
  // and this whole mechanism exists to be auditable.
  if (args.includes('--apply') && !detail) {
    throw new SpikeError('INVALID_ARGS', '--apply requires --reason "<what was fixed>"');
  }

  return { role, jobId, detail, fixCommit: valueOf('fix-commit'), apply: args.includes('--apply') };
}

async function main() {
  const emit = (line = '') => console.log(line);
  const { role, jobId, detail, fixCommit, apply } = parseArgs(process.argv);
  const store = createJobStore(STATE_DIR);
  const auto = createAutonomousStore(STATE_DIR);

  emit('');
  emit('IA Loop — retry authorisation after a harness fix');
  emit('');
  emit(`Mode:\n${apply ? 'APPLY' : 'DRY_RUN (nothing is written)'}`);
  emit('');

  // Asked BEFORE any evidence is read. Once a repair has run, the job is on
  // the successor attempt — which has no failure of its own — so reading
  // evidence first would report something misleading about an already-repaired
  // job instead of simply saying it is already repaired.
  const existing = await findExistingAuthorization(store, { role, jobId });
  if (existing) {
    emit('ALREADY_REPAIRED');
    emit(`  ${existing.sourceAttemptId} was authorised at ${existing.authorizedAt}`);
    emit(`  reason: ${existing.reason}${existing.detail ? ` — ${existing.detail}` : ''}`);
    emit(`  fix commit: ${existing.fixCommit ?? '(none recorded)'}`);
    emit(`  successor: ${existing.successorAttemptId}`);
    emit('');
    emit('No new attempt was created.');
    return 0;
  }

  const evidence = await findHarnessFailure(store, { role, jobId });
  emit('Failed attempt on disk:');
  emit(`  job: ${jobId}`);
  emit(`  attempt: ${evidence.attemptId}`);
  emit(`  status: ${evidence.attemptStatus}`);
  emit(`  recorded as: ${evidence.recordedReason}`);
  emit(`  failed at: ${evidence.failedAt}`);
  emit(`  original error: ${evidence.originalError}`);
  emit('');

  const verdict = assessHarnessFailure(evidence);
  emit('Re-read with the current classifier:');
  emit(`  from: ${verdict.from}`);
  emit(`  to: ${verdict.to}`);
  emit(`  is a harness failure: ${verdict.isHarnessError ? 'YES' : 'NO'}`);
  emit('');

  if (!verdict.isHarnessError) {
    emit(`This failure reads as ${verdict.to}, not HARNESS_ERROR. A retry is not authorised here.`);
    return 1;
  }

  if (!apply) {
    emit('Would authorise:');
    emit(`  ${evidence.attemptId}: stays FAILED (${verdict.from} → recorded as ${verdict.to})`);
    emit(`  successor: ${jobId}-a${evidence.attempt + 1} QUEUED`);
    emit(`  resume into: ${RESUME_STATE[role]}`);
    emit(`  fix commit: ${fixCommit ?? '(none given)'}`);
    emit('');
    emit('Re-run with --apply --reason "<what was fixed>" to write it.');
    return 0;
  }

  const applied = await authorizeRetryAfterHarnessFix(store, {
    role, jobId, detail, fixCommit, resumeFrom: RESUME_STATE[role], autonomousStore: auto,
  });

  if (applied.outcome === HARNESS_RETRY_OUTCOMES.ALREADY_REPAIRED) {
    emit('ALREADY_REPAIRED');
    emit(`  ${applied.authorization.sourceAttemptId} was authorised at ${applied.authorization.authorizedAt}`);
    emit(`  successor: ${applied.successorAttemptId}`);
    emit('  No new attempt was created.');
    return 0;
  }

  emit('Authorised:');
  emit(`  failed attempt: ${applied.authorization.sourceAttemptId} — FAILED (preserved)`);
  emit(`  original classification: ${applied.authorization.originalClassification}`);
  emit(`  corrected classification: ${applied.authorization.correctedClassification}`);
  emit(`  original error: ${applied.authorization.originalError}`);
  emit(`  successor: ${applied.successorAttemptId} QUEUED`);
  emit(`  fix commit: ${applied.authorization.fixCommit ?? '(none given)'}`);
  if (applied.run) emit(`  run ${applied.run.autonomousRunId}: ${applied.run.status}`);
  emit('');
  emit('The failure is preserved as a failure. The event log records both the');
  emit('reclassification and the authorisation.');
  return 0;
}

// Only when this file IS the program. Importing it — from a test, a doc
// generator, or an agent reading the tooling — must never start anything.
if (isDirectExecution(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      const code = error instanceof SpikeError ? error.code : 'UNEXPECTED_ERROR';
      console.error(`\nATENDLY IA LOOP\n\nCannot authorise a retry: [${code}] ${error.message}`);
      process.exitCode = 1;
    });
}
