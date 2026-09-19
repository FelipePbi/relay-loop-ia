/**
 * IA Loop — proof that a PID is really the PostgreSQL server a resource
 * record describes, not a recycled id wearing the same number.
 *
 * Same fail-closed shape as orphan-evidence.mjs: anything the OS cannot
 * confirm comes back UNKNOWN, and UNKNOWN never authorises touching the
 * process. Ownership requires ALL of:
 *
 *   pid exists
 *   + its start time matches what was recorded when we spawned it
 *   + its command line references the executable we launched
 *   + its command line references the data directory we gave it
 *
 * Any single mismatch is enough to refuse. This is what stands between
 * "clean up our leaked temp cluster" and "kill some other process that
 * happens to have PID 24648 right now".
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { LIVENESS } from './process-inspector.mjs';

const execFileAsync = promisify(execFile);

export const OWNERSHIP = Object.freeze({
  CONFIRMED: 'CONFIRMED',
  PID_REUSED: 'PID_REUSED',
  PROCESS_GONE: 'PROCESS_GONE',
  EXECUTABLE_MISMATCH: 'EXECUTABLE_MISMATCH',
  DATA_DIR_MISMATCH: 'DATA_DIR_MISMATCH',
  UNKNOWN: 'UNKNOWN',
});

/** Ownership outcomes under which the PROCESS itself may be signalled/killed. */
export const KILLABLE_OWNERSHIP = Object.freeze([OWNERSHIP.CONFIRMED]);

/**
 * Ownership outcomes under which it is safe to forget the resource (remove
 * its data directory, mark it CLEANED) — because either it is genuinely
 * ours, or the process we would have killed is already gone.
 */
export const CLEANABLE_OWNERSHIP = Object.freeze([
  OWNERSHIP.CONFIRMED, OWNERSHIP.PROCESS_GONE, OWNERSHIP.PID_REUSED,
]);

export function isKillable(proof) {
  return KILLABLE_OWNERSHIP.includes(proof?.ownership);
}

export function isCleanable(proof) {
  return CLEANABLE_OWNERSHIP.includes(proof?.ownership);
}

/** Reads a process's full command line. Read-only; null when unknowable. */
export async function commandLineOf(pid, { platform = process.platform } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'win32') {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ], { timeout: 10_000, windowsHide: true });
      const value = stdout.trim();
      return value === '' ? null : value;
    }

    const { stdout } = await execFileAsync('ps', ['-o', 'command=', '-p', String(pid)], { timeout: 10_000 });
    const value = stdout.trim();
    return value === '' ? null : value;
  } catch {
    return null;
  }
}

function normalizePath(value) {
  return typeof value === 'string' ? value.replace(/\\/g, '/').toLowerCase() : value;
}

/**
 * Judges whether `resource` (a registry record with resourceType 'postgres')
 * is really the process running right now.
 *
 * `inspector` is process-inspector.mjs's `{ exists(pid), startedAt(pid) }` —
 * injectable so tests never depend on the machine they run on.
 * `commandLineFn` defaults to commandLineOf, also injectable.
 */
export async function provePostgresOwnership(resource, inspector, { commandLineFn = commandLineOf } = {}) {
  const meta = resource?.metadata ?? {};
  const pid = meta.postgresPid;

  if (!Number.isInteger(pid) || pid <= 0) {
    return { ownership: OWNERSHIP.UNKNOWN, detail: 'Resource carries no postgresPid.' };
  }

  const liveness = inspector.exists(pid);
  if (liveness === LIVENESS.GONE) {
    return { ownership: OWNERSHIP.PROCESS_GONE, detail: `Process ${pid} does not exist.` };
  }
  if (liveness !== LIVENESS.ALIVE) {
    return { ownership: OWNERSHIP.UNKNOWN, detail: `Liveness of process ${pid} could not be determined.` };
  }

  const observedStartedAt = await inspector.startedAt(pid);
  if (!observedStartedAt || !meta.postgresProcessStartTime) {
    return {
      ownership: OWNERSHIP.UNKNOWN,
      detail: `Process ${pid} is alive but its start time cannot be compared (observed=${observedStartedAt ?? 'unknown'}).`,
    };
  }
  if (observedStartedAt !== meta.postgresProcessStartTime) {
    return {
      ownership: OWNERSHIP.PID_REUSED,
      detail: `Process ${pid} started at ${observedStartedAt}, not ${meta.postgresProcessStartTime}. The id was recycled; our server is gone.`,
    };
  }

  const commandLine = await commandLineFn(pid);
  if (!commandLine) {
    return {
      ownership: OWNERSHIP.UNKNOWN,
      detail: `Process ${pid} is the recorded process by start time, but its command line could not be read.`,
    };
  }

  const cl = normalizePath(commandLine);
  if (meta.postgresExecutable && !cl.includes(normalizePath(meta.postgresExecutable))) {
    return {
      ownership: OWNERSHIP.EXECUTABLE_MISMATCH,
      detail: `Command line of ${pid} does not reference ${meta.postgresExecutable}.`,
    };
  }
  if (meta.dataDirectory && !cl.includes(normalizePath(meta.dataDirectory))) {
    return {
      ownership: OWNERSHIP.DATA_DIR_MISMATCH,
      detail: `Command line of ${pid} does not reference ${meta.dataDirectory}.`,
    };
  }

  return {
    ownership: OWNERSHIP.CONFIRMED,
    detail: `Process ${pid} (started ${observedStartedAt}) matches the registered PostgreSQL server exactly.`,
  };
}
