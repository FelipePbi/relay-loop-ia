/**
 * What this file proves: a Goal worktree gets exactly the installs it is
 * missing, never an install it cannot do exactly, and never one it already
 * has — and that an install that fails does not take the Goal down with it.
 *
 * The incident behind it: `git worktree add` gives you tracked files, and
 * `node_modules` is gitignored, so every Goal worktree is born empty. What
 * filled it was whichever unit happened to run `npm install` for its own
 * checking. Goal020 reached verification with `packages/contracts` empty and
 * `validate:core` died on its first step — `'tsc' is not recognised` — which
 * is then attributed like any other red gate and answered with a unit that
 * edits code.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  INSTALL_ARGV,
  discoverWorktreePackages,
  provisionWorktreeDependencies,
  selectPackagesNeedingInstall,
} from '../lib/worktree-dependencies.mjs';

// ===========================================================================
// The selection — the whole decision, and pure
// ===========================================================================

test('a package with a lockfile and no node_modules is installed', () => {
  assert.deepEqual(
    selectPackagesNeedingInstall([{ dir: 'packages/contracts', hasLockfile: true, hasNodeModules: false }]),
    ['packages/contracts'],
  );
});

test('a package that already has node_modules is left alone', () => {
  // Re-running must cost nothing: resuming a Goal reaches here again, and an
  // install a unit did by hand is not something to undo.
  assert.deepEqual(
    selectPackagesNeedingInstall([{ dir: 'apps/bff', hasLockfile: true, hasNodeModules: true }]),
    [],
  );
});

test('a package with no lockfile is never installed', () => {
  // `npm ci` exists to install a lockfile exactly. Falling back to
  // `npm install` would WRITE a lockfile into the worktree and put it in the
  // Goal's diff — the harness inventing a dependency decision.
  assert.deepEqual(
    selectPackagesNeedingInstall([{ dir: 'apps/evolution-go', hasLockfile: false, hasNodeModules: false }]),
    [],
  );
});

test('the Goal020 shape: only the gap is installed, in tree order', () => {
  const packages = [
    { dir: 'apps/ai-orchestrator', hasLockfile: true, hasNodeModules: false },
    { dir: 'apps/bff', hasLockfile: true, hasNodeModules: true },
    { dir: 'apps/evolution-go', hasLockfile: false, hasNodeModules: false },
    { dir: 'apps/frontend', hasLockfile: true, hasNodeModules: true },
    { dir: 'packages/contracts', hasLockfile: true, hasNodeModules: false },
  ];
  assert.deepEqual(
    selectPackagesNeedingInstall(packages),
    ['apps/ai-orchestrator', 'packages/contracts'],
  );
});

test('malformed entries are dropped rather than crashing the Goal start', () => {
  assert.deepEqual(selectPackagesNeedingInstall([null, {}, { dir: '' }, { dir: 42 }]), []);
  assert.deepEqual(selectPackagesNeedingInstall(), []);
  assert.deepEqual(selectPackagesNeedingInstall('nope'), []);
});

test('the install command is npm ci, exactly, with no shell metacharacters', () => {
  assert.deepEqual([...INSTALL_ARGV], ['npm', 'ci', '--no-audit', '--no-fund']);
  for (const argument of INSTALL_ARGV) assert.doesNotMatch(argument, /[;&|$`><]/);
});

// ===========================================================================
// Discovery, against a real directory tree
// ===========================================================================

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-deps-'));
  const make = async (relative, files) => {
    await mkdir(join(dir, relative), { recursive: true });
    for (const file of files) {
      if (file === 'node_modules') await mkdir(join(dir, relative, file), { recursive: true });
      else await writeFile(join(dir, relative, file), '{}', 'utf8');
    }
  };
  await make('apps/bff', ['package.json', 'package-lock.json', 'node_modules']);
  await make('apps/frontend', ['package.json', 'package-lock.json']);
  await make('apps/evolution-go', ['package.json']);
  await make('packages/contracts', ['package.json', 'package-lock.json']);
  await make('apps/not-a-package', []);
  return dir;
}

test('discovery reports the two facts the selection needs, for real directories', async () => {
  const dir = await fixture();
  try {
    const found = await discoverWorktreePackages(dir);
    const byDir = Object.fromEntries(found.map((entry) => [entry.dir, entry]));

    assert.deepEqual(byDir['apps/bff'], { dir: 'apps/bff', hasLockfile: true, hasNodeModules: true });
    assert.deepEqual(byDir['apps/frontend'], { dir: 'apps/frontend', hasLockfile: true, hasNodeModules: false });
    assert.deepEqual(byDir['apps/evolution-go'], { dir: 'apps/evolution-go', hasLockfile: false, hasNodeModules: false });
    assert.equal(byDir['apps/not-a-package'], undefined, 'a directory with no package.json is not a package');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing root is a repo shape, not an error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-deps-empty-'));
  try {
    assert.deepEqual(await discoverWorktreePackages(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// Provisioning
// ===========================================================================

/** A spawn that reports the given exit code, and records where it ran. */
function fakeSpawn(exitCodeFor = () => 0) {
  const calls = [];
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, shell: options.shell });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => child.emit('close', exitCodeFor(options.cwd)));
    return child;
  };
  return { spawnFn, calls };
}

test('only the missing packages are installed, and never through a shell', async () => {
  const dir = await fixture();
  try {
    const { spawnFn, calls } = fakeSpawn();
    const lines = [];
    const result = await provisionWorktreeDependencies({
      worktreePath: dir, spawnFn, emit: (line) => lines.push(line),
    });

    assert.deepEqual(result.installed, ['apps/frontend', 'packages/contracts']);
    assert.deepEqual(result.failed, []);
    assert.ok(result.skipped.includes('apps/bff'), 'already provisioned');
    assert.ok(result.skipped.includes('apps/evolution-go'), 'no lockfile');

    assert.equal(calls.length, 2, 'one spawn per missing package, and not one more');
    for (const call of calls) assert.equal(call.shell, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a worktree already provisioned spawns nothing at all', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-deps-done-'));
  try {
    await mkdir(join(dir, 'apps/bff/node_modules'), { recursive: true });
    await writeFile(join(dir, 'apps/bff/package.json'), '{}', 'utf8');
    await writeFile(join(dir, 'apps/bff/package-lock.json'), '{}', 'utf8');

    const { spawnFn, calls } = fakeSpawn();
    const result = await provisionWorktreeDependencies({ worktreePath: dir, spawnFn });

    assert.equal(calls.length, 0, 'resuming a Goal must cost nothing here');
    assert.deepEqual(result.installed, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed install is reported and does NOT stop the Goal', async () => {
  // The gates are about to report this in far more detail than provisioning
  // could. Refusing to start the Goal would trade a red gate for a dead run.
  const dir = await fixture();
  try {
    const { spawnFn } = fakeSpawn((cwd) => (cwd.includes('contracts') ? 1 : 0));
    const lines = [];
    const result = await provisionWorktreeDependencies({
      worktreePath: dir, spawnFn, emit: (line) => lines.push(line),
    });

    assert.deepEqual(result.installed, ['apps/frontend']);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].dir, 'packages/contracts');
    assert.ok(lines.some((line) => /FAILED/.test(line)), 'the failure is said out loud, not swallowed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a spawn that throws is a failure, not an exception escaping into the Goal start', async () => {
  const dir = await fixture();
  try {
    const result = await provisionWorktreeDependencies({
      worktreePath: dir,
      spawnFn: () => { throw new Error('ENOENT'); },
    });

    assert.deepEqual(result.installed, []);
    assert.equal(result.failed.length, 2);
    for (const failure of result.failed) assert.match(failure.error, /SPAWN_FAILED/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
