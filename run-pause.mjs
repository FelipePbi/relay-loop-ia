#!/usr/bin/env node
/**
 * IA Loop — request a graceful pause.
 *
 *   npm run ia-loop:pause
 *   npm run ia-loop:pause -- --after-goal
 *
 * This never kills anything. It records a request; the loop stops at the next
 * safe boundary, and an inference already running is allowed to finish. Killing
 * a child mid-write is exactly what the leases exist to prevent.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SpikeError } from './lib/claude-process.mjs';
import { createAutonomousStore } from './lib/autonomous-state.mjs';
import { createJobStore } from './lib/job-store.mjs';
import { isDirectExecution } from './lib/direct-execution.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, '.state');

async function main() {
  const afterGoal = process.argv.includes('--after-goal');
  const auto = createAutonomousStore(STATE_DIR);
  const store = createJobStore(STATE_DIR);

  const run = await auto.read();
  if (!run) {
    console.log('\nATENDLY IA LOOP — PAUSE\n\nThere is no autonomous run to pause.');
    return 0;
  }

  await auto.requestPause({ afterGoal });
  await store.appendEvent({
    type: 'AUTONOMOUS_RUN_PAUSE_REQUESTED',
    autonomousRunId: run.autonomousRunId,
    afterGoal,
  });

  console.log('');
  console.log('ATENDLY IA LOOP — PAUSE');
  console.log('');
  console.log(`Run: ${run.autonomousRunId}`);
  console.log(`Pause requested: YES${afterGoal ? ' (after the current Goal finishes)' : ''}`);
  console.log('');
  console.log('Nothing was killed. Any inference in flight finishes, and the loop stops');
  console.log(afterGoal
    ? 'once the current Goal is fully closed.'
    : 'at the next safe boundary.');
  console.log('');
  console.log('Check with:  npm run ia-loop:status');
  console.log('Continue with:  npm run ia-loop:resume');
  return 0;
}

// Only when this file IS the program. Importing it — from a test, a doc
// generator, or an agent reading the tooling — must never start anything.
if (isDirectExecution(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      const code = error instanceof SpikeError ? error.code : 'UNEXPECTED_ERROR';
      console.error(`\nATENDLY IA LOOP — PAUSE\n\nBlocker: [${code}] ${error.message}`);
      process.exitCode = 1;
    });
}
