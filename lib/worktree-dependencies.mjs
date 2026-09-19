/**
 * IA Loop — a Goal worktree that can actually run its own gates.
 *
 * `git worktree add` gives you the tracked files and nothing else.
 * `node_modules` is gitignored, so every Goal worktree is born with no
 * dependencies at all, and nothing in the harness ever put them there.
 *
 * What filled that gap until now was accident. A unit that edited `apps/bff`
 * and wanted to check its own work ran `npm install` there, so `apps/bff`
 * ended up provisioned — and a package no unit happened to touch did not.
 * Goal020's worktree reached its verification stage with four of six packages
 * installed and `packages/contracts` empty, which is where `validate:core`
 * dies first:
 *
 *     [validate:core] build:contracts: tsc -p tsconfig.json
 *     'tsc' is not recognised as an internal or external command
 *     failed build:contracts · not_run for the other sixteen steps
 *
 * That is why the GLOBAL gates (`validate-core`, `validate-integration`,
 * `validate-ui`) have a history of failing where the SCOPED ones
 * (`typecheck`, `lint`, `targeted-tests`) pass: a scoped gate only needs the
 * app its own unit just worked in, and that app is exactly the one somebody
 * installed. The long-running `validate:integration` failure was one instance
 * of this, not a problem of its own.
 *
 * The cost of leaving it lazy is not really the wasted minutes. A gate that
 * goes red for an environment reason is attributed like any other failure, and
 * the harness answers it by scheduling a unit that EDITS CODE. Goal020 got
 * away with it — the fix unit correctly diagnosed the missing install and ran
 * `npm ci` — but asking a model to repair a missing dependency by changing
 * source is a bad bet to keep taking.
 *
 * Deliberately narrow:
 *
 *   - Only packages carrying a `package-lock.json`. `npm ci` exists to install
 *     a lockfile exactly; without one there is nothing to be exact about, and
 *     guessing with `npm install` would write a lockfile into the worktree and
 *     put it in the Goal's diff.
 *   - Only packages with no `node_modules` yet. Re-running is a no-op, so
 *     resuming a Goal costs nothing and an install a unit did by hand is left
 *     alone.
 *   - The repository ROOT is never installed: it has no lockfile, and
 *     Goal020's worktree proved the gates do not need it — `validate:core`
 *     passed there with no root `node_modules` at all.
 *   - No shell, argv only, same as every other command this harness spawns.
 */

import { spawn } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveSpawnTarget } from './windows-command-resolver.mjs';

/** Where packages live. `apps/evolution-go` is Go and carries no lockfile. */
export const PACKAGE_ROOTS = Object.freeze(['apps', 'packages']);

/** Exactly what `npm ci` is for, with the noise turned off. */
export const INSTALL_ARGV = Object.freeze(['npm', 'ci', '--no-audit', '--no-fund']);

/** How long one package may take before we stop waiting for it. */
export const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Which of the discovered packages need installing.
 *
 * Pure, and the whole decision: a package qualifies when it can be installed
 * exactly (it has a lockfile) and has not been already (it has no
 * `node_modules`). Order is preserved so the log reads like the tree.
 */
export function selectPackagesNeedingInstall(packages = []) {
  if (!Array.isArray(packages)) return [];
  return packages
    .filter((entry) => entry && typeof entry.dir === 'string' && entry.dir !== '')
    .filter((entry) => entry.hasLockfile === true)
    .filter((entry) => entry.hasNodeModules !== true)
    .map((entry) => entry.dir);
}

const canRead = async (path) => access(path).then(() => true).catch(() => false);

/**
 * Every package under `roots`, with the two facts the selection needs.
 *
 * Paths are returned relative to the worktree, because that is what a log line
 * should say and what a caller joins back on.
 */
export async function discoverWorktreePackages(worktreePath, { roots = PACKAGE_ROOTS } = {}) {
  const found = [];
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(join(worktreePath, root), { withFileTypes: true });
    } catch {
      continue; // A root that does not exist is not an error; it is a repo shape.
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const dir = `${root}/${entry.name}`;
      const absolute = join(worktreePath, root, entry.name);
      if (!await canRead(join(absolute, 'package.json'))) continue;
      found.push({
        dir,
        hasLockfile: await canRead(join(absolute, 'package-lock.json')),
        hasNodeModules: await canRead(join(absolute, 'node_modules')),
      });
    }
  }
  return found;
}

/**
 * Installs what the worktree is missing, and reports what it did.
 *
 * Never throws on a failed install. A package that will not install is a fact
 * the gates are about to report anyway, in far more detail than this could —
 * and refusing to start the Goal over it would trade a red gate for a dead
 * run. The result says which packages failed so the caller can say so out loud.
 */
export async function provisionWorktreeDependencies({
  worktreePath,
  roots = PACKAGE_ROOTS,
  spawnFn = spawn,
  emit = () => {},
  timeoutMs = INSTALL_TIMEOUT_MS,
} = {}) {
  const packages = await discoverWorktreePackages(worktreePath, { roots });
  const pending = selectPackagesNeedingInstall(packages);
  // Everything discovery found that this run is not going to touch: already
  // provisioned, or carrying no lockfile to be exact about.
  const skipped = packages.map((entry) => entry.dir).filter((dir) => !pending.includes(dir));

  if (pending.length === 0) {
    emit(`Dependencies: all ${packages.length} package(s) already provisioned.`);
    return { installed: [], failed: [], skipped };
  }

  emit(`Dependencies: installing ${pending.length} of ${packages.length} package(s) — `
    + 'a worktree is born without node_modules, and the global gates need them.');

  const installed = [];
  const failed = [];

  for (const dir of pending) {
    const startedAt = Date.now();
    const outcome = await runInstall({ cwd: join(worktreePath, dir), spawnFn, timeoutMs });
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    if (outcome.ok) {
      installed.push(dir);
      emit(`  ${dir}: ok (${seconds}s)`);
    } else {
      failed.push({ dir, error: outcome.error, exitCode: outcome.exitCode });
      emit(`  ${dir}: FAILED (${seconds}s) — ${outcome.error ?? `exit ${outcome.exitCode}`}. `
        + 'Left for the gates to report.');
    }
  }

  return { installed, failed, skipped };
}

/** One `npm ci`, spawned as argv with no shell. */
function runInstall({ cwd, spawnFn, timeoutMs }) {
  return new Promise((resolve) => {
    // npm on Windows is a .cmd wrapper that `shell: false` cannot launch;
    // the resolver points at the JS entry point it would have delegated to.
    const target = resolveSpawnTarget(INSTALL_ARGV, { env: process.env });
    if (target.resolutionError) {
      resolve({ ok: false, exitCode: null, error: `SPAWN_FAILED: ${target.resolutionError}` });
      return;
    }

    let child;
    try {
      child = spawnFn(target.command, target.args, { cwd, shell: false, windowsHide: true });
    } catch (error) {
      resolve({ ok: false, exitCode: null, error: `SPAWN_FAILED: ${error.message}` });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, exitCode: null, error: `TIMEOUT after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);

    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish({ ok: false, exitCode: null, error: `SPAWN_FAILED: ${error.message}` }));
    child.on('close', (code) => finish({
      ok: code === 0,
      exitCode: code,
      error: code === 0 ? null : stderr.trim().split('\n').slice(-1)[0] || null,
    }));
  });
}
