/**
 * Tests for the worker supervisor's restart policy.
 *
 * The rule under test is one distinction: a CRASH is worth retrying, and every
 * other exit is a decision the worker made. `until node worker.mjs; do sleep 10;
 * done` could not tell them apart, so an identity conflict and a changed
 * codebase — the two conditions a worker is designed to stop for — became loops
 * that repeated the same refusal every ten seconds.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { WORKER_EXIT, exitCodeForError, nameForExitCode, restartPolicyFor } from '../lib/worker-exit.mjs';
import { crashBudget, parseWorkerArgs, superviseWorker } from '../run-worker.mjs';
import { SpikeError } from '../lib/claude-process.mjs';

test('an error maps to the exit code that describes why the worker stopped', () => {
  assert.equal(exitCodeForError(new SpikeError('WORKER_ALREADY_RUNNING', 'x')), WORKER_EXIT.IDENTITY_CONFLICT);
  assert.equal(exitCodeForError(new SpikeError('WORKER_IDENTITY_UNCERTAIN', 'x')), WORKER_EXIT.IDENTITY_CONFLICT);
  assert.equal(exitCodeForError(new SpikeError('WORKER_CODE_CHANGED', 'x')), WORKER_EXIT.CODE_CHANGED);
  assert.equal(exitCodeForError(new SpikeError('EXECUTABLE_NOT_FOUND', 'x')), WORKER_EXIT.FATAL_CONFIG);
  assert.equal(exitCodeForError(new Error('anything else')), WORKER_EXIT.CRASH);
});

test('only a crash is restarted, and every refusal explains itself', () => {
  assert.equal(restartPolicyFor(WORKER_EXIT.CRASH).restart, true);
  assert.equal(restartPolicyFor(WORKER_EXIT.OK).restart, false);
  assert.equal(restartPolicyFor(WORKER_EXIT.IDENTITY_CONFLICT).restart, false);
  assert.equal(restartPolicyFor(WORKER_EXIT.CODE_CHANGED).restart, false);
  assert.equal(restartPolicyFor(WORKER_EXIT.FATAL_CONFIG).restart, false);

  for (const code of Object.values(WORKER_EXIT)) {
    assert.ok(restartPolicyFor(code).reason.length > 10, `${nameForExitCode(code)} must say why`);
  }
});

test('an unrecognised exit code is treated as a crash, not as a decision', () => {
  const policy = restartPolicyFor(137); // SIGKILL, say
  assert.equal(policy.restart, true);
  assert.match(policy.reason, /crash/);
});

// --- the loop --------------------------------------------------------------

/** A worker that returns a scripted sequence of exit codes. */
function scriptedWorker(codes) {
  const seen = [];
  return {
    seen,
    run: async () => {
      seen.push(1);
      return { code: codes[seen.length - 1] ?? WORKER_EXIT.OK, signal: null };
    },
  };
}

test('a requested shutdown stays down', async () => {
  const worker = scriptedWorker([WORKER_EXIT.OK]);
  const code = await superviseWorker({ role: 'tech_lead', script: 'x', run: worker.run, delayMs: 0 });
  assert.equal(code, WORKER_EXIT.OK);
  assert.equal(worker.seen.length, 1, 'started exactly once');
});

test('an identity conflict is not retried every ten seconds', async () => {
  const worker = scriptedWorker([WORKER_EXIT.IDENTITY_CONFLICT]);
  const code = await superviseWorker({ role: 'tech_lead', script: 'x', run: worker.run, delayMs: 0 });
  assert.equal(code, WORKER_EXIT.IDENTITY_CONFLICT);
  assert.equal(worker.seen.length, 1, 'retrying would repeat the same refusal forever');
});

test('a changed codebase stops instead of restarting into code nobody deployed', async () => {
  const worker = scriptedWorker([WORKER_EXIT.CODE_CHANGED]);
  const code = await superviseWorker({ role: 'developer', script: 'x', run: worker.run, delayMs: 0 });
  assert.equal(code, WORKER_EXIT.CODE_CHANGED);
  assert.equal(worker.seen.length, 1);
});

test('a crash is restarted, and a later clean exit ends the supervision', async () => {
  const worker = scriptedWorker([WORKER_EXIT.CRASH, WORKER_EXIT.CRASH, WORKER_EXIT.OK]);
  const code = await superviseWorker({ role: 'developer', script: 'x', run: worker.run, delayMs: 0 });
  assert.equal(code, WORKER_EXIT.OK);
  assert.equal(worker.seen.length, 3, 'two crashes restarted, the clean exit did not');
});

test('a crash that reproduces every time is given up on, not looped forever', async () => {
  const worker = scriptedWorker(Array.from({ length: 20 }, () => WORKER_EXIT.CRASH));
  const code = await superviseWorker({ role: 'developer', script: 'x', run: worker.run, delayMs: 0 });
  assert.equal(code, WORKER_EXIT.CRASH);
  assert.ok(worker.seen.length <= 6, `gave up after ${worker.seen.length} starts instead of spinning`);
});

test('a crash budget only counts crashes inside the window', () => {
  const now = 1_000_000;
  const old = [now - 10 * 60_000, now - 9 * 60_000];
  assert.equal(crashBudget(old, { now, limit: 2, windowMs: 60_000 }).exhausted, false);
  assert.equal(crashBudget([now - 1000, now - 2000], { now, limit: 2, windowMs: 60_000 }).exhausted, true);
});

// --- CLI -------------------------------------------------------------------

test('the supervisor only accepts roles it can actually run', () => {
  assert.deepEqual(parseWorkerArgs(['node', 'run-worker.mjs', 'tech_lead']), {
    role: 'tech_lead', script: 'workers/tech-lead.mjs',
  });
  assert.equal(parseWorkerArgs(['node', 'run-worker.mjs', 'developer']).role, 'developer');
  assert.throws(() => parseWorkerArgs(['node', 'run-worker.mjs']), /Usage/);
  assert.throws(() => parseWorkerArgs(['node', 'run-worker.mjs', 'reviewer']), /Usage/);
});
