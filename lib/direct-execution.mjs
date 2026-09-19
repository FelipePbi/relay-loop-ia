/**
 * IA Loop — "was this module run, or merely imported?"
 *
 * Every runner and worker in this tool used to call `main()` at the bottom of
 * the file, unconditionally. That makes the module and the program the same
 * thing: importing `workers/developer.mjs` to read a constant STARTED a worker
 * — heartbeat, job polling, lease claims and all.
 *
 * That is not hypothetical. During an introspection of this very tooling, both
 * workers were started by an `import()` meant only to check for circular
 * dependencies. Nothing was claimed and nothing was lost, but only by luck: the
 * Tech Lead worker had already begun polling for jobs.
 *
 * So the entry points guard themselves. A test, a doc generator or an agent
 * reading the code can import any of them and get functions, not a running
 * process.
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * True only when `moduleUrl` names the file Node was asked to run.
 *
 * Resolved through `realpath` on both sides so a symlinked bin, a relative
 * argv and Windows path casing all still compare equal. Anything unresolvable
 * answers false: refusing to run is the safe direction, since the cost of a
 * false negative is a program that does not start, and the cost of a false
 * positive is a worker nobody asked for.
 */
export function isDirectExecution(moduleUrl, entryPath = process.argv[1]) {
  if (!moduleUrl || !entryPath) return false;

  const canonical = (path) => {
    try {
      return pathToFileURL(realpathSync(resolve(path))).href;
    } catch {
      try {
        return pathToFileURL(resolve(path)).href;
      } catch {
        return null;
      }
    }
  };

  let selfPath;
  try {
    selfPath = fileURLToPath(moduleUrl);
  } catch {
    return false;
  }

  const self = canonical(selfPath);
  const entry = canonical(entryPath);
  if (self === null || entry === null) return false;
  return self === entry;
}

/**
 * Runs `main()` only when this module IS the program.
 *
 * The error handling is the same one every runner had inline, kept in one place
 * so a new entry point cannot forget half of it.
 */
export function runAsScript(moduleUrl, main, { onError = null } = {}) {
  if (!isDirectExecution(moduleUrl)) return false;
  Promise.resolve()
    .then(() => main())
    .catch((error) => {
      if (onError) onError(error);
      else console.error(error?.message ?? String(error));
      process.exitCode = 1;
    });
  return true;
}
