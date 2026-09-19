/**
 * IA Loop — process identity and liveness.
 *
 * Recovery needs to answer one question honestly: is the process that held this
 * lease still able to write? A stale heartbeat does not answer it — a long
 * inference, a paused VM or a slow disk all look identical to a crash.
 *
 * So a lease carries enough identity to be checked later:
 *
 *   hostname          which machine wrote it
 *   bootAt            when that machine last booted
 *   pid               the process id
 *   processStartedAt  when THAT process started
 *   instanceId        a value never reused across restarts
 *
 * `pid` alone is never enough: Windows and POSIX both reuse process ids, so a
 * live pid proves nothing without the start time to go with it.
 *
 * Every query fails CLOSED. When the OS cannot tell us, the answer is UNKNOWN,
 * and UNKNOWN never confirms an orphan.
 */

import { execFile } from 'node:child_process';
import { hostname, uptime } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const LIVENESS = Object.freeze({
  ALIVE: 'ALIVE',
  GONE: 'GONE',
  UNKNOWN: 'UNKNOWN',
});

/**
 * Two boot times within this distance are the same boot.
 *
 * `os.uptime()` is a whole number of seconds and is sampled at different
 * moments by different processes, so the derived boot instant drifts by a
 * second or two. The tolerance is far wider than that drift and far narrower
 * than any reboot, which is what makes "different boot" safe to act on.
 */
export const BOOT_TOLERANCE_MS = 120_000;

/** When this machine last booted, derived from uptime. */
export function currentBootAt(now = Date.now()) {
  return now - Math.round(uptime() * 1000);
}

/** Identity of the process running this code, for stamping onto a lease. */
export function selfIdentity({ now = Date.now() } = {}) {
  return {
    hostname: hostname(),
    bootAt: new Date(currentBootAt(now)).toISOString(),
    pid: process.pid,
    // process.uptime() is seconds since THIS process started.
    processStartedAt: new Date(now - Math.round(process.uptime() * 1000)).toISOString(),
  };
}

/** True when two recorded boot instants are close enough to be the same boot. */
export function sameBoot(a, b, { toleranceMs = BOOT_TOLERANCE_MS } = {}) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null; // unknowable, not equal
  return Math.abs(ta - tb) <= toleranceMs;
}

/**
 * Does a process with this id exist right now?
 *
 * Signal 0 performs the permission and existence check without delivering
 * anything, on Windows as well as POSIX. EPERM means the process exists and is
 * not ours to signal — still alive, which is what we asked.
 */
export function pidExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return LIVENESS.UNKNOWN;
  try {
    process.kill(pid, 0);
    return LIVENESS.ALIVE;
  } catch (error) {
    if (error.code === 'ESRCH') return LIVENESS.GONE;
    if (error.code === 'EPERM') return LIVENESS.ALIVE;
    return LIVENESS.UNKNOWN;
  }
}

/**
 * When did the process with this id start?
 *
 * Windows answers through CIM; POSIX through ps. Both are read-only queries.
 * A failure returns null rather than throwing: not knowing is a valid answer
 * here, and the caller is built to refuse rather than guess on null.
 */
export async function processStartedAt(pid, { platform = process.platform } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  try {
    if (platform === 'win32') {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToUniversalTime().ToString("o")`,
      ], { timeout: 10_000, windowsHide: true });
      const value = stdout.trim();
      return value === '' || Number.isNaN(Date.parse(value)) ? null : new Date(value).toISOString();
    }

    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 10_000 });
    const value = stdout.trim();
    return value === '' || Number.isNaN(Date.parse(value)) ? null : new Date(value).toISOString();
  } catch {
    return null;
  }
}

/**
 * The real inspector. Tests inject a fake with the same three methods, so no
 * test depends on the machine it runs on.
 */
export function createProcessInspector({ platform = process.platform } = {}) {
  return {
    self: (options) => selfIdentity(options),
    bootAt: (now) => new Date(currentBootAt(now)).toISOString(),
    hostname: () => hostname(),
    exists: (pid) => pidExists(pid),
    startedAt: (pid) => processStartedAt(pid, { platform }),
  };
}
