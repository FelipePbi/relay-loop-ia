/**
 * IA Loop — resolving npm/npx to something Windows can actually spawn.
 *
 * `child_process.spawn('npm', [...], { shell: false })` fails on Windows with
 * ENOENT, always, for every installation — not because npm is missing, but
 * because `npm`/`npx` on Windows are `.cmd` wrappers (a tiny batch script
 * that locates and re-invokes the real JS entry point through `node.exe`),
 * and spawning a `.cmd` file directly requires a command interpreter, which
 * `shell: false` deliberately refuses to start (see deterministic-executor.mjs
 * for why: a shell is exactly the thing this executor must never need, since
 * every argument here comes from a closed, validated registry and a shell is
 * the only thing that could turn one of them into an injection).
 *
 * The fix is not `shell: true` — that reintroduces the exact risk the no-shell
 * design exists to remove, for every action in the registry, not just the two
 * that need it. Instead: resolve the SAME JS file the `.cmd` wrapper would
 * have delegated to (`npm-cli.js` / `npx-cli.js`, both shipped next to npm's
 * own `package.json`), and run it directly under `process.execPath`
 * (`node.exe`). argv stays an array, nothing is parsed by anything, and the
 * only thing gained is finding a file — the same file the wrapper finds.
 *
 * Two ways to find it, most specific first:
 *
 *   npm_execpath   set by npm itself, for the whole life of any `npm run` /
 *                  `npm exec` process — which is how this harness is always
 *                  started (`npm run ia-loop:developer`, etc.) — to the exact
 *                  npm-cli.js that IS running. Its sibling is npx-cli.js.
 *   next to node   the layout of a bundled/global npm install: `<node
 *                  dir>/node_modules/npm/bin/<cli>.js`. Works even when a
 *                  child process was not itself launched via `npm run`.
 *
 * Non-Windows platforms are untouched: npm/npx there are real executables (or
 * shebang scripts the kernel already knows how to run), and this function
 * returns the argv it was given, unchanged.
 */

import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

/** The only commands Windows cannot spawn directly without a shell. */
const WRAPPED_COMMANDS = new Set(['npm', 'npx']);

/**
 * @param argv     the logical command, e.g. ['npm', 'run', 'lint']
 * @returns { command, args } to actually spawn, or additionally
 *          `resolutionError` when platform is win32, the command is wrapped,
 *          and no entry point could be found anywhere.
 */
export function resolveSpawnTarget(argv, {
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
  exists = existsSync,
} = {}) {
  const [command, ...rest] = argv;

  if (platform !== 'win32' || !WRAPPED_COMMANDS.has(command)) {
    return { command, args: rest };
  }

  const cliFile = `${command}-cli.js`;
  const candidates = [];

  if (typeof env.npm_execpath === 'string' && env.npm_execpath !== '') {
    candidates.push(join(dirname(env.npm_execpath), cliFile));
  }
  candidates.push(join(dirname(execPath), 'node_modules', 'npm', 'bin', cliFile));

  const resolved = candidates.find((path) => exists(path));
  if (!resolved) {
    return {
      command,
      args: rest,
      resolutionError:
        `Could not resolve a Windows entry point for "${command}" `
        + `(tried: ${candidates.join(', ')})`,
    };
  }

  return { command: execPath, args: [resolved, ...rest] };
}
