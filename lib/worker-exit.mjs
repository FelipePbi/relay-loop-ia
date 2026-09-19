/**
 * IA Loop — why a worker stopped, as an exit code.
 *
 * A supervisor that restarts on any non-zero exit is worse than no supervisor:
 * it turns the two conditions a worker is DESIGNED to stop for — another
 * process already holds the role, and the code changed underneath it — into a
 * restart loop that hammers the same refusal every few seconds and buries the
 * one line explaining it.
 *
 * So the reason travels out of the process as a number, and the supervisor
 * decides from that alone. Four outcomes, three of which mean "stay down":
 *
 *   0   OK                 a shutdown that was asked for. Staying down IS the
 *                          requested outcome.
 *   1   CRASH              nothing planned this. Restarting is reasonable.
 *   20  IDENTITY_CONFLICT  another worker owns the role. Retrying cannot help
 *                          — the answer will be identical until a human acts.
 *   21  CODE_CHANGED       the sources moved under a running worker. A restart
 *                          would silently adopt code nobody chose to deploy.
 *   22  FATAL_CONFIG       the environment is wrong (no CLI, bad settings).
 *                          Retrying just repeats the same failure.
 */

export const WORKER_EXIT = Object.freeze({
  OK: 0,
  CRASH: 1,
  IDENTITY_CONFLICT: 20,
  CODE_CHANGED: 21,
  FATAL_CONFIG: 22,
});

/** Error codes that mean "another worker owns this role". */
const IDENTITY_CODES = Object.freeze([
  'WORKER_ALREADY_RUNNING',
  'WORKER_IDENTITY_UNCERTAIN',
  'WORKER_IDENTITY_RACE',
]);

/** Error codes that mean "this environment cannot run a worker at all". */
const CONFIG_CODES = Object.freeze([
  'EXECUTABLE_NOT_FOUND',
  'STORE_VERSION_MISMATCH',
  'INVALID_ARGS',
]);

/** The exit code a failed startup or run should carry. */
export function exitCodeForError(error) {
  const code = error?.code ?? null;
  if (code === 'WORKER_CODE_CHANGED') return WORKER_EXIT.CODE_CHANGED;
  if (IDENTITY_CODES.includes(code)) return WORKER_EXIT.IDENTITY_CONFLICT;
  if (CONFIG_CODES.includes(code)) return WORKER_EXIT.FATAL_CONFIG;
  return WORKER_EXIT.CRASH;
}

/**
 * Whether a supervisor should start the worker again, and why not when it
 * should not. The reason is returned rather than logged here so the supervisor
 * owns its own output.
 */
export function restartPolicyFor(exitCode) {
  switch (exitCode) {
    case WORKER_EXIT.OK:
      return { restart: false, reason: 'shutdown requested — staying down' };
    case WORKER_EXIT.IDENTITY_CONFLICT:
      return { restart: false, reason: 'another worker holds this role — retrying would repeat the same refusal' };
    case WORKER_EXIT.CODE_CHANGED:
      return { restart: false, reason: 'ia-loop code changed under the worker — restart manually once the change is intended' };
    case WORKER_EXIT.FATAL_CONFIG:
      return { restart: false, reason: 'the environment cannot run this worker — retrying repeats the same failure' };
    default:
      return { restart: true, reason: `unexpected exit (${exitCode}) — treating it as a crash` };
  }
}

/** A name for a code, for logs. */
export function nameForExitCode(exitCode) {
  const entry = Object.entries(WORKER_EXIT).find(([, value]) => value === exitCode);
  return entry ? entry[0] : `UNKNOWN(${exitCode})`;
}
