/**
 * Running one DETERMINISTIC Work Unit — exit code, stdout/stderr, and the
 * Windows npm/npx resolution this file wires in.
 *
 * `spawnFn` is always a fake here: no real process is ever started, and no
 * model is ever reachable from this path (see the header of
 * deterministic-executor.mjs for why NO SHELL is the point, not an oversight).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { runDeterministicAction } from '../lib/deterministic-executor.mjs';

/** A fake child_process.ChildProcess, controllable from the test. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

const unit = (over = {}) => ({ id: 'WU-11', action: 'typecheck', scope: 'apps/ai-orchestrator', ...over });

test('1. a clean exit (code 0) reports ok: true', async () => {
  const calls = [];
  const spawnFn = (command, args, opts) => {
    calls.push({ command, args, opts });
    const child = fakeChild();
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('all good\n'));
      child.emit('close', 0, null);
    });
    return child;
  };

  const result = await runDeterministicAction({ unit: unit(), worktree: '/repo/worktree', spawnFn });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.error, null);
  assert.match(result.stdout, /all good/);
});

test('2. a non-zero exit reports ok: false with the real exit code, not a guess', async () => {
  const spawnFn = () => {
    const child = fakeChild();
    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from('2 errors\n'));
      child.emit('close', 1, null);
    });
    return child;
  };

  const result = await runDeterministicAction({ unit: unit(), worktree: '/repo/worktree', spawnFn });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.error, null, 'a clean process exit that failed is not a SPAWN error');
  assert.match(result.stderr, /2 errors/);
});

test('3. stdout and stderr are captured independently and in full for ordinary output', async () => {
  const spawnFn = () => {
    const child = fakeChild();
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('line1\n'));
      child.stdout.emit('data', Buffer.from('line2\n'));
      child.stderr.emit('data', Buffer.from('warn1\n'));
      child.emit('close', 0, null);
    });
    return child;
  };

  const result = await runDeterministicAction({ unit: unit(), worktree: '/repo/worktree', spawnFn });
  assert.equal(result.stdout, 'line1\nline2\n');
  assert.equal(result.stderr, 'warn1\n');
});

test("4. a genuine spawn error (child_process 'error' event) is reported as SPAWN_FAILED, not silently swallowed", async () => {
  const spawnFn = () => {
    const child = fakeChild();
    queueMicrotask(() => child.emit('error', new Error('spawn npm ENOENT')));
    return child;
  };

  const result = await runDeterministicAction({ unit: unit(), worktree: '/repo/worktree', spawnFn });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, null);
  assert.match(result.error, /SPAWN_FAILED/);
  assert.match(result.error, /ENOENT/);
});

test('5. spawnFn throwing synchronously is caught the same way as an async error event', async () => {
  const spawnFn = () => { throw new Error('spawn git ENOENT'); };
  const result = await runDeterministicAction({ unit: unit(), worktree: '/repo/worktree', spawnFn });
  assert.equal(result.ok, false);
  assert.match(result.error, /SPAWN_FAILED: spawn git ENOENT/);
});

test('6. shell is never requested, on any platform, for any action', async () => {
  const seenOpts = [];
  const spawnFn = (command, args, opts) => {
    seenOpts.push(opts);
    const child = fakeChild();
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  };

  await runDeterministicAction({ unit: unit(), worktree: '/repo/worktree', spawnFn });
  assert.equal(seenOpts.length, 1);
  assert.equal(seenOpts[0].shell, false);
});

test('7. argv is reported as the logical command, not the Windows-resolved one', async () => {
  // `lint` in the registry is ['npm', 'run', 'lint']. Even when the actual
  // spawn target was resolved to node.exe + npm-cli.js for Windows, the
  // persisted `argv` stays the command a human/reviewer actually asked for.
  const spawnFn = () => {
    const child = fakeChild();
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  };
  const resolveTarget = (argv) => ({ command: 'C:\\node.exe', args: ['C:\\npm-cli.js', ...argv.slice(1)] });

  const result = await runDeterministicAction({
    unit: unit({ action: 'lint' }), worktree: '/repo/worktree', spawnFn, resolveTarget,
  });
  assert.deepEqual(result.argv, ['npm', 'run', 'lint']);
});

test('8. on Windows, npm/npx is actually spawned through the resolved node.exe target — the fix under real conditions', async () => {
  const seen = [];
  const spawnFn = (command, args, opts) => {
    seen.push({ command, args, cwd: opts.cwd, shell: opts.shell });
    const child = fakeChild();
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('tsc: no errors\n'));
      child.emit('close', 0, null);
    });
    return child;
  };
  // The real resolver, with a fake filesystem/env standing in for Windows —
  // exactly what tests 1-10 in windows-command-resolver.test.mjs prove in
  // isolation; this proves the executor actually calls it.
  const resolveTarget = (argv, { env }) => {
    if (argv[0] === 'npx') {
      return { command: 'C:\\nodejs\\node.exe', args: ['C:\\nodejs\\node_modules\\npm\\bin\\npx-cli.js', ...argv.slice(1)] };
    }
    return { command: argv[0], args: argv.slice(1) };
  };

  const result = await runDeterministicAction({
    unit: unit({ action: 'typecheck', scope: 'apps/ai-orchestrator' }),
    worktree: '/repo/worktree', spawnFn, resolveTarget,
  });

  assert.equal(result.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].command, 'C:\\nodejs\\node.exe', 'spawned node.exe directly, never npx.cmd');
  assert.deepEqual(seen[0].args, ['C:\\nodejs\\node_modules\\npm\\bin\\npx-cli.js', 'tsc', '--noEmit']);
  assert.equal(seen[0].shell, false, 'still no shell, even for the Windows-resolved target');
});

test('9. an unresolvable npm/npx on Windows fails closed before ever calling spawnFn', async () => {
  let spawnCalled = false;
  const spawnFn = () => { spawnCalled = true; return fakeChild(); };
  const resolveTarget = () => ({
    command: 'npm', args: ['run', 'lint'],
    resolutionError: 'Could not resolve a Windows entry point for "npm" (tried: C:\\a\\npm-cli.js)',
  });

  const result = await runDeterministicAction({
    unit: unit({ action: 'lint' }), worktree: '/repo/worktree', spawnFn, resolveTarget,
  });

  assert.equal(spawnCalled, false, 'never spawns a command it already knows cannot resolve');
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, null);
  assert.match(result.error, /SPAWN_FAILED: Could not resolve a Windows entry point for "npm"/);
});

test('10. a timeout kills the process and is reported distinctly from a real failure', async () => {
  const spawnFn = () => {
    const child = fakeChild();
    // Real child_process 'close' always arrives asynchronously, after the OS
    // has actually reaped the process — never synchronously inside kill()
    // itself. A fake that closed synchronously would race the timeout's own
    // finish() call in a way a real process never does.
    child.kill = () => { setImmediate(() => child.emit('close', null, 'SIGKILL')); };
    // Never closes on its own — only the timeout below ends it.
    return child;
  };

  const result = await runDeterministicAction({
    unit: unit(), worktree: '/repo/worktree', spawnFn, timeoutMs: 10,
  });
  assert.equal(result.ok, false);
  assert.equal(result.signal, 'SIGKILL');
  assert.match(result.error, /TIMEOUT/);
});
