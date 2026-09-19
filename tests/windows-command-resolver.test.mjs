/**
 * npm/npx on Windows cannot be spawned directly without a shell — they are
 * `.cmd` wrappers, and `child_process.spawn(..., { shell: false })` refuses
 * to start a command interpreter. The real Goal 011 execution hit exactly
 * this: every DETERMINISTIC unit that ran `npm run lint`/`npx tsc` failed in
 * 3ms with `SPAWN_FAILED: spawn npm ENOENT` — not because npm was missing,
 * but because argv[0] named a file Windows cannot exec without a shell.
 *
 * These tests are entirely in-memory: platform, env, execPath and the
 * filesystem are all injected, so the same suite proves both branches
 * (win32 resolved, everything else untouched) on any machine, including a
 * non-Windows CI runner.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';

import { resolveSpawnTarget } from '../lib/windows-command-resolver.mjs';

const NODE_EXE = 'C:\\Program Files\\nodejs\\node.exe';
const NODE_DIR = dirname(NODE_EXE);
const BUNDLED_NPM_CLI = join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npm-cli.js');
const BUNDLED_NPX_CLI = join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npx-cli.js');

/** A filesystem that only knows about the files this test lists. */
const fakeFs = (existingPaths) => ({ exists: (path) => existingPaths.includes(path) });

test('1. `npm run ...` on Windows resolves to node.exe + npm-cli.js, argv preserved', () => {
  const target = resolveSpawnTarget(['npm', 'run', 'lint'], {
    platform: 'win32',
    env: {},
    execPath: NODE_EXE,
    ...fakeFs([BUNDLED_NPM_CLI]),
  });
  assert.equal(target.command, NODE_EXE);
  assert.deepEqual(target.args, [BUNDLED_NPM_CLI, 'run', 'lint']);
  assert.equal(target.resolutionError, undefined);
});

test('2. `npx ...` on Windows resolves to node.exe + npx-cli.js', () => {
  const target = resolveSpawnTarget(['npx', 'tsc', '--noEmit'], {
    platform: 'win32',
    env: {},
    execPath: NODE_EXE,
    ...fakeFs([BUNDLED_NPX_CLI]),
  });
  assert.equal(target.command, NODE_EXE);
  assert.deepEqual(target.args, [BUNDLED_NPX_CLI, 'tsc', '--noEmit']);
});

test('3. a normal binary command (git) is never touched, on any platform', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const target = resolveSpawnTarget(['git', 'diff', '--check'], {
      platform,
      env: {},
      execPath: NODE_EXE,
      ...fakeFs([]),
    });
    assert.equal(target.command, 'git', platform);
    assert.deepEqual(target.args, ['diff', '--check'], platform);
    assert.equal(target.resolutionError, undefined, platform);
  }
});

test('4. non-Windows platforms leave npm/npx untouched too — real executables there', () => {
  for (const platform of ['linux', 'darwin']) {
    const target = resolveSpawnTarget(['npm', 'run', 'lint'], {
      platform,
      env: {},
      execPath: '/usr/bin/node',
      ...fakeFs([]),
    });
    assert.equal(target.command, 'npm', platform);
    assert.deepEqual(target.args, ['run', 'lint'], platform);
  }
});

test('5. `npm_execpath` is preferred when set — the exact npm this process is already running under', () => {
  const localExecpath = 'D:\\Projects\\repo\\node_modules\\npm\\bin\\npm-cli.js';
  const localNpxCli = 'D:\\Projects\\repo\\node_modules\\npm\\bin\\npx-cli.js';
  const target = resolveSpawnTarget(['npx', 'vitest', 'run'], {
    platform: 'win32',
    env: { npm_execpath: localExecpath },
    execPath: NODE_EXE,
    // Only the npm_execpath-derived path exists; the bundled fallback does not.
    ...fakeFs([localNpxCli]),
  });
  assert.equal(target.command, NODE_EXE);
  assert.deepEqual(target.args, [localNpxCli, 'vitest', 'run']);
});

test('6. falls back to the node-adjacent npm when npm_execpath does not resolve', () => {
  const target = resolveSpawnTarget(['npm', 'test'], {
    platform: 'win32',
    env: { npm_execpath: 'C:\\somewhere\\else\\npm-cli.js' },
    execPath: NODE_EXE,
    // Neither the npm_execpath sibling nor... wait, only the bundled one exists.
    ...fakeFs([BUNDLED_NPM_CLI]),
  });
  assert.equal(target.command, NODE_EXE);
  assert.deepEqual(target.args, [BUNDLED_NPM_CLI, 'test']);
});

test('7. paths with spaces survive as a single argv element, never concatenated', () => {
  const spacedNode = 'C:\\Program Files\\nodejs\\node.exe';
  const spacedCli = join(dirname(spacedNode), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const target = resolveSpawnTarget(['npm', 'run', 'build'], {
    platform: 'win32',
    env: {},
    execPath: spacedNode,
    ...fakeFs([spacedCli]),
  });
  assert.equal(target.command, spacedNode);
  assert.equal(target.args[0], spacedCli, 'the resolved path is one array element, not a joined string');
  assert.equal(target.args.length, 3, 'exactly [cliPath, "run", "build"] — nothing joined or split');
  assert.deepEqual(target.args, [spacedCli, 'run', 'build']);
});

test('8. arguments with special characters pass through completely unchanged', () => {
  const weird = ['run', '--grep', 'a "quoted" & tricky $arg; rm -rf /', '--pattern=**/*.test.ts'];
  const target = resolveSpawnTarget(['npm', ...weird], {
    platform: 'win32',
    env: {},
    execPath: NODE_EXE,
    ...fakeFs([BUNDLED_NPM_CLI]),
  });
  assert.deepEqual(target.args.slice(1), weird, 'every argument is preserved byte-for-byte as its own array element');
});

test('9. an unresolvable npm/npx on Windows reports a clear resolution error instead of a bare ENOENT', () => {
  const target = resolveSpawnTarget(['npm', 'run', 'lint'], {
    platform: 'win32',
    env: {},
    execPath: NODE_EXE,
    ...fakeFs([]), // nothing exists
  });
  assert.match(target.resolutionError, /Could not resolve a Windows entry point for "npm"/);
  assert.match(target.resolutionError, /npm-cli\.js/);
});

test('10. a genuinely missing command (not npm/npx) is left for spawn to report as ENOENT itself', () => {
  const target = resolveSpawnTarget(['definitely-not-a-real-binary', '--version'], {
    platform: 'win32',
    env: {},
    execPath: NODE_EXE,
    ...fakeFs([]),
  });
  assert.equal(target.command, 'definitely-not-a-real-binary');
  assert.equal(target.resolutionError, undefined, 'resolution is not responsible for commands it does not own');
});
