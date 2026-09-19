/**
 * IA Loop — running a DETERMINISTIC Work Unit.
 *
 * No model is involved at any point in this file, and that is its entire
 * value. `npm run typecheck` has one right answer, the orchestrator can read
 * the exit code as well as any model can, and paying an inference to type the
 * command and a second one to read the output is the single clearest waste the
 * monolithic Developer had.
 *
 * Two properties:
 *
 *   NO SHELL      every action is spawned as argv from the closed registry in
 *                 deterministic-actions.mjs. There is no command string to
 *                 build, so there is no quoting mistake to become an
 *                 injection, and a plan cannot smuggle one in through `scope`
 *                 or `pattern` — both are validated against narrow patterns
 *                 before they get here.
 *   BOUNDED       output is captured with a cap and a timeout. A verification
 *                 step that produces a hundred megabytes of test output must
 *                 not become the reason the run dies.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { SpikeError } from './claude-process.mjs';
import { ACTION_CWD, assertDeterministicAction } from './deterministic-actions.mjs';
import { resolveSpawnTarget } from './windows-command-resolver.mjs';

/** Output kept per stream. Enough to diagnose, far from enough to exhaust memory. */
export const OUTPUT_LIMIT = 64_000;

/** Output kept in the persisted result, which several later readers carry around. */
export const PERSISTED_OUTPUT_LIMIT = 8_000;

export const DEFAULT_ACTION_TIMEOUT_MS = Number(
  process.env.IA_LOOP_DETERMINISTIC_TIMEOUT_MS ?? 30 * 60 * 1000,
);

/** The last N characters, which is where a failure almost always is. */
function tail(text, limit) {
  if (text.length <= limit) return text;
  return `[…${text.length - limit} characters omitted…]\n${text.slice(-limit)}`;
}

/**
 * Runs one deterministic action.
 *
 * `spawnFn` is injected so tests can prove the whole path — including that no
 * model provider is ever reached — without running a real build.
 */
export async function runDeterministicAction({
  unit,
  worktree,
  timeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
  spawnFn = spawn,
  env = process.env,
  resolveTarget = resolveSpawnTarget,
}) {
  const spec = assertDeterministicAction(unit.action, `${unit.id}.action`);
  if (!worktree) throw new SpikeError('INVALID_ARGS', 'a worktree is required to run a deterministic action');

  const cwd = spec.cwd === ACTION_CWD.SCOPE
    ? join(worktree, unit.scope)
    : worktree;

  const argv = [...spec.command, ...(spec.appendPattern && unit.pattern ? [unit.pattern] : [])];
  const startedAt = Date.now();

  // A precondition the harness cannot satisfy is not a failure of the Goal,
  // and answering it as one costs a fix unit per attempt on a defect no model
  // can repair. Checked BEFORE the spawn: the command would only exit
  // instantly anyway, and the exit code would say nothing about why.
  const missingEnv = (spec.requiresEnv ?? []).filter((name) => {
    const value = env[name];
    return typeof value !== 'string' || value.trim() === '';
  });
  if (missingEnv.length > 0) {
    return Object.freeze({
      unitId: unit.id,
      action: spec.name,
      label: spec.label,
      argv: Object.freeze([...argv]),
      cwd,
      durationMs: 0,
      ok: false,
      skipped: true,
      missingEnv: Object.freeze(missingEnv),
      exitCode: null,
      signal: null,
      error: null,
      stdout: '',
      stderr: '',
    });
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(Object.freeze({
        unitId: unit.id,
        action: spec.name,
        label: spec.label,
        // Reported as argv, never re-joined into a string: what ran is exactly
        // this list, and printing it as a shell line would suggest otherwise.
        argv: Object.freeze([...argv]),
        cwd,
        durationMs: Date.now() - startedAt,
        ...outcome,
        stdout: tail(stdout, OUTPUT_LIMIT),
        stderr: tail(stderr, OUTPUT_LIMIT),
      }));
    };

    // npm/npx on Windows are .cmd wrappers, not something `shell: false` can
    // launch directly — resolved to the real JS entry point they would have
    // delegated to and run under node.exe instead. Every other platform and
    // every other command (git, and anything else the registry ever adds)
    // passes through unchanged. See windows-command-resolver.mjs.
    const target = resolveTarget(argv, { env });
    if (target.resolutionError) {
      finish({ ok: false, exitCode: null, signal: null, error: `SPAWN_FAILED: ${target.resolutionError}` });
      return;
    }

    let child;
    try {
      child = spawnFn(target.command, target.args, {
        cwd,
        env,
        // Never a shell. See the header.
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      finish({ ok: false, exitCode: null, signal: null, error: `SPAWN_FAILED: ${error.message}` });
      return;
    }

    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('error', (error) => {
      finish({ ok: false, exitCode: null, signal: null, error: `SPAWN_FAILED: ${error.message}` });
    });

    child.on('close', (code, signal) => {
      finish({ ok: code === 0, exitCode: code, signal: signal ?? null, error: null });
    });

    timer = setTimeout(() => {
      // Killed, and reported as killed. A timeout that resolved as "failed"
      // would be indistinguishable from a real failure, and the two need
      // different answers: one is a fix, the other is a budget.
      try { child.kill('SIGKILL'); } catch { /* the process is already gone */ }
      finish({ ok: false, exitCode: null, signal: 'SIGKILL', error: `TIMEOUT after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
  });
}

/**
 * File paths named in a failed action's output.
 *
 * Used for failure attribution: a verification step that fails somewhere is
 * much more useful when it can say which unit's change it is failing ON. This
 * is a heuristic and is treated as one by every caller — an ambiguous
 * attribution produces a diagnosis unit, never a confident accusation.
 *
 * Deliberately conservative about what counts as a path: a token must have a
 * known source extension and at least one directory separator, so ordinary
 * prose and version numbers do not become "evidence".
 */
const PATH_TOKEN = /(?:^|[\s("'[])((?:[A-Za-z0-9._-]+[\\/])+[A-Za-z0-9._-]+\.(?:ts|tsx|js|jsx|mjs|cjs|go|sql|json|prisma))(?=[\s():;"',\]]|$)/gm;

export function extractFailurePaths(output, { limit = 25 } = {}) {
  const text = typeof output === 'string' ? output : '';
  const found = new Set();
  for (const match of text.matchAll(PATH_TOKEN)) {
    // Normalised to forward slashes so a Windows-shaped path from a tool
    // still matches the git-shaped paths every other part of the loop uses.
    const path = match[1].replace(/\\/g, '/').replace(/^\.\//, '');
    found.add(path);
    if (found.size >= limit) break;
  }
  return [...found];
}

/**
 * Which Work Unit a failure most likely belongs to.
 *
 * Attribution is by overlap between the paths the failure names and the files
 * each unit actually changed — collected from git, not claimed by a model.
 *
 * Returns the single best candidate only when it is unambiguous. A tie, or no
 * overlap at all, returns `null` with the candidates listed: the caller turns
 * that into a STANDARD diagnosis unit rather than guessing, because guessing
 * wrong sends a correction to the wrong place and then reports it as fixed.
 */
export function attributeFailure({ paths, unitChanges }) {
  const scores = [];
  for (const [unitId, changed] of unitChanges.entries()) {
    const overlap = (changed ?? []).filter((file) => paths.includes(file));
    if (overlap.length > 0) scores.push({ unitId, overlap: overlap.length, files: overlap });
  }
  scores.sort((a, b) => b.overlap - a.overlap);

  if (scores.length === 0) return { attributed: null, ambiguous: false, candidates: [] };
  if (scores.length > 1 && scores[0].overlap === scores[1].overlap) {
    return { attributed: null, ambiguous: true, candidates: scores.map((entry) => entry.unitId) };
  }
  return { attributed: scores[0], ambiguous: false, candidates: scores.map((entry) => entry.unitId) };
}

/**
 * The record persisted for a deterministic unit.
 *
 * Shaped like a Work Unit result so the aggregate report does not need two
 * code paths, but honest about its origin: `executor: 'native'` and no model
 * anywhere, which is exactly what the telemetry counts.
 */
export function toDeterministicResult({ unit, outcome, goal, round, jobId }) {
  const detail = outcome.ok
    ? tail(outcome.stdout, PERSISTED_OUTPUT_LIMIT)
    : tail(`${outcome.stdout}\n${outcome.stderr}`.trim(), PERSISTED_OUTPUT_LIMIT);

  // Three states, not two. A gate that never ran is not a gate that failed,
  // and collapsing them is what made Goal 014 report "4 FAILED" for a Goal
  // whose product code was fine.
  if (outcome.skipped) {
    const names = [...(outcome.missingEnv ?? [])].join(', ');
    return Object.freeze({
      protocolVersion: 2,
      jobId,
      goal,
      round,
      workUnitId: unit.id,
      status: 'SKIPPED',
      executor: 'native',
      action: outcome.action,
      argv: outcome.argv,
      exitCode: null,
      signal: null,
      durationMs: outcome.durationMs,
      summary: `${outcome.label} não rodou: pré-condição ausente (${names}).`,
      report:
        `O comando não foi executado. Ele exige ${names}, que o orchestrator não provisiona.\n`
        + 'Isto é uma limitação do harness, não uma falha desta implementação: '
        + 'nenhuma correção no código do produto faria este gate passar.',
      changedFiles: Object.freeze([]),
      acceptance: Object.freeze([]),
      escalation: null,
      contextRequest: null,
      blockedReason: null,
      missingEnv: Object.freeze([...(outcome.missingEnv ?? [])]),
      failurePaths: Object.freeze([]),
    });
  }

  return Object.freeze({
    protocolVersion: 2,
    jobId,
    goal,
    round,
    workUnitId: unit.id,
    status: outcome.ok ? 'COMPLETED' : 'BLOCKED',
    executor: 'native',
    action: outcome.action,
    argv: outcome.argv,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    durationMs: outcome.durationMs,
    summary: outcome.ok
      ? `${outcome.label} passou (exit 0, ${outcome.durationMs}ms).`
      : `${outcome.label} falhou (${outcome.error ?? `exit ${outcome.exitCode}`}).`,
    report: detail || '(sem saída)',
    changedFiles: Object.freeze([]),
    acceptance: Object.freeze([]),
    escalation: null,
    contextRequest: null,
    blockedReason: outcome.ok ? null : (outcome.error ?? `exit ${outcome.exitCode}`),
    // Kept for attribution; the full output stays out of everything that gets
    // carried around, and the tail is what a human or a fix unit needs.
    failurePaths: Object.freeze(outcome.ok ? [] : extractFailurePaths(`${outcome.stdout}\n${outcome.stderr}`)),
  });
}
