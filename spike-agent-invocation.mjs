#!/usr/bin/env node
/**
 * IA Loop — Spike 0: Agent Invocation Bootstrap.
 *
 * Answers exactly one question, with executable evidence:
 *
 *   Using this machine's current Claude Code authentication, and WITHOUT
 *   configuring a separate paid API, can we programmatically invoke two
 *   independent agents (Tech Lead on Fable, Developer on Opus 5) and get
 *   reliable structured JSON back from both?
 *
 * Deliberately out of scope: orchestration, state machine, Goal execution,
 * reviews, commits, worktrees, and anything that touches the product runtime.
 *
 * Exit code is 0 only when BOTH agents are proven. There is no model fallback:
 * if Fable or Opus 5 cannot be selected, the Spike fails.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { invokeAgent, resolveClaudeExecutable, SpikeError } from './lib/claude-process.mjs';
import { isDirectExecution } from './lib/direct-execution.mjs';

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = Number(process.env.IA_LOOP_TIMEOUT_MS ?? 120_000);

const AGENTS = [
  {
    label: 'Tech Lead',
    expectedRole: 'tech_lead',
    // Requested model and the family token the resolved model MUST contain.
    requestedModel: process.env.IA_LOOP_TECH_LEAD_MODEL ?? 'claude-fable-5-1',
    expectedFamily: 'fable',
    prompt: [
      'Você está atuando como Tech Lead. Retorne exclusivamente o JSON solicitado,',
      'sem executar ferramentas ou alterar arquivos.',
      'JSON: {"role":"tech_lead","ok":true}',
    ].join(' '),
  },
  {
    label: 'Developer',
    expectedRole: 'developer',
    requestedModel: process.env.IA_LOOP_DEVELOPER_MODEL ?? 'claude-opus-5',
    expectedFamily: 'opus',
    prompt: [
      'Você está atuando como Developer. Retorne exclusivamente o JSON solicitado,',
      'sem executar ferramentas ou alterar arquivos.',
      'JSON: {"role":"developer","ok":true}',
    ].join(' '),
  },
];

async function readCliVersion(executable) {
  try {
    const { stdout } = await execFileAsync(executable, ['--version'], { timeout: 60_000 });
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}

function formatAgent(agent, outcome) {
  const auxiliary = outcome.auxiliaryModels.length > 0
    ? outcome.auxiliaryModels.join(', ')
    : 'none';

  const lines = [
    agent.label,
    `  requested: ${outcome.requestedModel}`,
    `  resolved primary: ${outcome.resolvedPrimaryModel ?? 'undetermined'}`,
    `  auxiliary: ${auxiliary}`,
    `  status: ${outcome.available ? 'AVAILABLE' : 'UNAVAILABLE'}`,
    `  structured output: ${outcome.structuredOutput ? 'OK' : 'FAIL'}`,
  ];
  if (outcome.error) {
    lines.push(`  blocker: [${outcome.error.code}] ${outcome.error.message}`);
    // Auxiliary models are only meaningful once a primary is identified; until
    // then, show the raw observation so the failure is diagnosable.
    if (!outcome.resolvedPrimaryModel && outcome.observedModels.length > 0) {
      lines.push(`  models reported by CLI: ${outcome.observedModels.join(', ')}`);
    }
  }
  return lines.join('\n');
}

async function main() {
  let executable;
  try {
    executable = resolveClaudeExecutable();
  } catch (error) {
    const spikeError = error instanceof SpikeError ? error : null;
    console.error('IA Loop — Agent Invocation Spike\n');
    console.error(`Claude CLI: NOT FOUND (${spikeError ? spikeError.code : 'UNEXPECTED_ERROR'})`);
    console.error(error.message);
    console.error('\nOverall:\nFAIL');
    return 1;
  }

  const version = await readCliVersion(executable.path);

  // Run each agent from its own empty temp directory: no project files in reach,
  // and nothing the invocation could modify in this repository.
  const workdir = await mkdtemp(join(tmpdir(), 'ia-loop-spike-'));

  try {
    // Two separate processes, two separate session ids, no shared conversation.
    const outcomes = [];
    for (const agent of AGENTS) {
      outcomes.push(
        await invokeAgent({
          executable: executable.path,
          model: agent.requestedModel,
          expectedFamily: agent.expectedFamily,
          expectedRole: agent.expectedRole,
          prompt: agent.prompt,
          cwd: workdir,
          timeoutMs: TIMEOUT_MS,
        }),
      );
    }

    const passed = outcomes.every((o) => o.available && o.structuredOutput && !o.error);

    console.log('IA Loop — Agent Invocation Spike\n');
    console.log(`Claude CLI: ${version} (${executable.source})\n`);
    AGENTS.forEach((agent, index) => {
      console.log(formatAgent(agent, outcomes[index]));
      console.log('');
    });
    console.log('Overall:');
    console.log(passed ? 'PASS' : 'FAIL');

    return passed ? 0 : 1;
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
      console.error('IA Loop — Agent Invocation Spike\n');
      console.error(`Unexpected failure: ${error?.message ?? error}`);
      console.error('\nOverall:\nFAIL');
      process.exitCode = 1;
    });
}
