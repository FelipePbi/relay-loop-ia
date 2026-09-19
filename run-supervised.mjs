#!/usr/bin/env node
/**
 * IA Loop — Supervised Vertical Slice V1.
 *
 * Proves end to end that a Node orchestrator can:
 *   call Opus 5 as Developer -> validate its structured result
 *   -> build a review request -> call Fable 5.1 as Tech Lead
 *   -> validate its structured decision -> validate the state transitions -> stop.
 *
 * It does NOT execute a real Goal, does not give the agents repository access,
 * does not implement the correction loop, and does not commit anything.
 *
 * The orchestrator never interprets prose: every transition comes from a
 * contract-validated field.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveClaudeExecutable, SpikeError } from './lib/claude-process.mjs';
import { buildReviewRequest } from './lib/contracts.mjs';
import { isDirectExecution } from './lib/direct-execution.mjs';
import {
  DEVELOPER_MODEL,
  TECH_LEAD_MODEL,
  runDeveloper,
  runTechLead,
} from './lib/agents.mjs';
import {
  STATES,
  createStateMachine,
  planNextAction,
  stateForDecision,
} from './lib/state-machine.mjs';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

const TASK_ID = 'synthetic-001';
const TIMEOUT_MS = Number(process.env.IA_LOOP_TIMEOUT_MS ?? 180_000);

async function readCliVersion(executable) {
  try {
    const { stdout } = await execFileAsync(executable, ['--version'], { timeout: 60_000 });
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}

/** Formats one agent block. Prompts are never printed by default. */
function formatAgentBlock({ label, requestedModel, outcome, extraLines = [] }) {
  const lines = [
    label,
    `  model: ${requestedModel}`,
    `  primary: ${outcome.resolvedPrimaryModel ?? 'undetermined'}`,
  ];
  if (outcome.auxiliaryModels.length > 0) {
    lines.push(`  auxiliary: ${outcome.auxiliaryModels.join(', ')}`);
  }
  lines.push(...extraLines);
  lines.push(`  contract: ${outcome.structuredOutput ? 'VALID' : 'INVALID'}`);
  if (outcome.error) {
    lines.push(`  blocker: [${outcome.error.code}] ${outcome.error.message}`);
  }
  return lines.join('\n');
}

function formatTransition(transition) {
  return `${transition.from} -> ${transition.to}`;
}

async function main() {
  const report = [];
  const emit = (line = '') => report.push(line);

  let executable;
  try {
    executable = resolveClaudeExecutable();
  } catch (error) {
    emit('IA Loop — Supervised V1');
    emit('');
    emit(`Claude CLI: NOT FOUND (${error instanceof SpikeError ? error.code : 'UNEXPECTED_ERROR'})`);
    emit(error.message);
    emit('');
    emit('Overall:');
    emit('FAIL');
    console.error(report.join('\n'));
    return 1;
  }

  const version = await readCliVersion(executable.path);
  const taskDescription = await readFile(join(HERE, 'fixtures', 'synthetic-goal.md'), 'utf8');

  // Both agents run from an empty temp directory, outside this repository.
  const workdir = await mkdtemp(join(tmpdir(), 'ia-loop-v1-'));
  const machine = createStateMachine();

  emit('IA Loop — Supervised V1');
  emit('');
  emit(`Claude CLI: ${version}`);
  emit('');
  emit('Task:');
  emit(TASK_ID);
  emit('');

  try {
    // --- Developer -------------------------------------------------------
    machine.transitionTo(STATES.DEVELOPER_RUNNING);

    const developer = await runDeveloper({
      executable: executable.path,
      taskId: TASK_ID,
      taskDescription,
      cwd: workdir,
      timeoutMs: TIMEOUT_MS,
    });

    emit(formatAgentBlock({
      label: 'Developer',
      requestedModel: DEVELOPER_MODEL,
      outcome: developer,
      extraLines: [`  status: ${developer.payload?.status ?? 'n/a'}`],
    }));
    emit('');

    if (!developer.available || !developer.structuredOutput) {
      emit('Overall:');
      emit('FAIL');
      console.error(report.join('\n'));
      return 1;
    }

    // The transition is driven by the validated status field, never by prose.
    if (developer.payload.status !== STATES.REVIEW_REQUIRED) {
      throw new SpikeError(
        'UNSUPPORTED_STATUS',
        `Developer status "${developer.payload.status}" has no transition in V1`,
      );
    }
    emit('Transition:');
    emit(formatTransition(machine.transitionTo(STATES.REVIEW_REQUIRED)));
    emit('');

    // --- Hand-off --------------------------------------------------------
    // The only channel between the two agents. No shared session, no resume.
    const reviewRequest = buildReviewRequest({
      taskId: TASK_ID,
      taskDescription,
      developerResult: developer.payload,
    });

    // --- Reviewer --------------------------------------------------------
    machine.transitionTo(STATES.REVIEWER_RUNNING);

    const reviewer = await runTechLead({
      executable: executable.path,
      reviewRequest,
      cwd: workdir,
      timeoutMs: TIMEOUT_MS,
    });

    emit(formatAgentBlock({
      label: 'Reviewer',
      requestedModel: TECH_LEAD_MODEL,
      outcome: reviewer,
      extraLines: [`  decision: ${reviewer.payload?.decision ?? 'n/a'}`],
    }));
    emit('');

    if (!reviewer.available || !reviewer.structuredOutput) {
      emit('Overall:');
      emit('FAIL');
      console.error(report.join('\n'));
      return 1;
    }

    const decision = reviewer.payload.decision;
    emit('Transition:');
    emit(formatTransition(machine.transitionTo(stateForDecision(decision))));
    emit('');

    if (reviewer.payload.blockers.length > 0) {
      emit('Blockers:');
      for (const blocker of reviewer.payload.blockers) emit(`  - ${blocker}`);
      emit('');
    }

    // --- Stop ------------------------------------------------------------
    const plan = planNextAction(reviewer.payload.nextAction);
    emit('Transition:');
    emit(formatTransition(machine.transitionTo(STATES.STOP)));
    emit('');

    emit('Review decision:');
    emit(decision);
    emit('');
    emit('Next action:');
    emit(plan.nextAction);
    if (plan.deferred) emit(`  (${plan.note})`);
    emit('');

    // A legitimate CHANGES_REQUIRED does not make the harness faulty: what is
    // being proven here is transport, contracts and state transitions.
    emit('Overall:');
    emit('PASS');
    console.log(report.join('\n'));
    return 0;
  } catch (error) {
    const code = error instanceof SpikeError ? error.code : 'UNEXPECTED_ERROR';
    emit(`Blocker: [${code}] ${error.message}`);
    emit('');
    emit(`State: ${machine.state}`);
    emit('');
    emit('Overall:');
    emit('FAIL');
    console.error(report.join('\n'));
    return 1;
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

// Only when this file IS the program. Importing it — from a test, a doc
// generator, or an agent reading the tooling — must never start anything.
if (isDirectExecution(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error('IA Loop — Supervised V1\n');
      console.error(`Unexpected failure: ${error?.message ?? error}`);
      console.error('\nOverall:\nFAIL');
      process.exitCode = 1;
    });
}
