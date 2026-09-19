#!/usr/bin/env node
/**
 * IA Loop — supervising one worker, by exit code.
 *
 *   npm run ia-loop:worker -- tech_lead
 *   npm run ia-loop:worker -- developer
 *
 * The naive supervisor is `until node worker.mjs; do sleep 10; done`, and it is
 * actively harmful: it restarts on ANY non-zero exit, so the two conditions a
 * worker is DESIGNED to stop for — another process already owns the role, and
 * the code changed underneath it — become a loop that repeats the same refusal
 * every ten seconds and buries the one line explaining it.
 *
 * So this restarts a CRASH and nothing else. Every other exit is a decision the
 * worker made, and the supervisor's job is to respect it and say why.
 *
 * It is deliberately small: spawn, read the exit code, consult one table, log.
 * No daemon, no pid files, no config. Running a worker directly still works and
 * is unchanged — this only adds a supervisor for people who want one.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SpikeError } from './lib/claude-process.mjs';
import { WORKER_EXIT, nameForExitCode, restartPolicyFor } from './lib/worker-exit.mjs';
import { isDirectExecution } from './lib/direct-execution.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const WORKERS = Object.freeze({
  tech_lead: 'workers/tech-lead.mjs',
  developer: 'workers/developer.mjs',
});

/** Wait before restarting a crash, so a boot-time failure cannot spin. */
export const RESTART_DELAY_MS = Number(process.env.IA_LOOP_RESTART_DELAY_MS ?? 5_000);
/** More crashes than this inside the window means the crash is not transient. */
export const CRASH_LIMIT = Number(process.env.IA_LOOP_CRASH_LIMIT ?? 5);
export const CRASH_WINDOW_MS = Number(process.env.IA_LOOP_CRASH_WINDOW_MS ?? 5 * 60_000);

function log(tag, message = '') {
  const time = new Date().toISOString().slice(11, 19);
  console.log(`${time} [supervisor:${tag}]${message ? ` ${message}` : ''}`);
}

export function parseWorkerArgs(argv) {
  const role = argv.slice(2).find((arg) => !arg.startsWith('-')) ?? null;
  if (!role || !WORKERS[role]) {
    throw new SpikeError(
      'INVALID_ARGS',
      `Usage: npm run ia-loop:worker -- <${Object.keys(WORKERS).join('|')}>`,
    );
  }
  return { role, script: WORKERS[role] };
}

/**
 * Whether a crash should still be retried, given how recent the others were.
 *
 * Restarting forever through a failure that reproduces every time is just a
 * slower version of the loop this file exists to remove.
 */
export function crashBudget(timestamps, { now = Date.now(), limit = CRASH_LIMIT, windowMs = CRASH_WINDOW_MS } = {}) {
  const recent = timestamps.filter((at) => now - at < windowMs);
  return { recent, exhausted: recent.length >= limit };
}

function runOnce(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, script), ...args], {
      cwd: HERE,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('close', (code, signal) => resolve({ code: code ?? WORKER_EXIT.CRASH, signal }));
    child.on('error', () => resolve({ code: WORKER_EXIT.CRASH, signal: null }));
  });
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export async function superviseWorker({ role, script, args = [], run = runOnce, now = () => Date.now(), delayMs = RESTART_DELAY_MS }) {
  const crashes = [];

  for (;;) {
    const { code, signal } = await run(script, args);
    const policy = restartPolicyFor(code);
    const label = signal ? `${nameForExitCode(code)} (signal ${signal})` : nameForExitCode(code);

    if (!policy.restart) {
      log('STOPPED', `${role} exited ${label} — ${policy.reason}`);
      return code;
    }

    crashes.push(now());
    const { recent, exhausted } = crashBudget(crashes, { now: now() });
    if (exhausted) {
      log('GIVING UP', `${role} crashed ${recent.length} times in ${Math.round(CRASH_WINDOW_MS / 60_000)}min — not a transient failure`);
      return code;
    }

    log('RESTARTING', `${role} exited ${label} — ${policy.reason}; retry ${recent.length}/${CRASH_LIMIT} in ${Math.round(delayMs / 1000)}s`);
    await sleep(delayMs);
  }
}

async function main() {
  const { role, script } = parseWorkerArgs(process.argv);
  log('START', `supervising ${role} (crash restarts only)`);
  return superviseWorker({ role, script });
}

if (isDirectExecution(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(`ATENDLY IA LOOP — worker supervisor\n\n[${error.code ?? 'UNEXPECTED_ERROR'}] ${error.message}`);
      process.exitCode = 1;
    });
}
