/**
 * IA Loop — the one directory temporary resources are allowed to delete from.
 *
 * Deleting "the data directory a model told us about" is how a leaked
 * PostgreSQL data dir becomes an arbitrary `rm -rf`. Every deletion in this
 * package goes through `assertSafeTempPath`, which resolves symlinks/
 * junctions and refuses anything that does not land, for real, inside this
 * root.
 */

import { realpath } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { resolve, sep, join } from 'node:path';

import { SpikeError } from './claude-process.mjs';

/**
 * Resolves the temp root for a given ia-loop state directory. Kept beside
 * `.state` (not inside it) so a wholesale `rm -rf .state` during debugging
 * never takes live data directories with it, and vice versa.
 */
export function tempRootFor(stateDir) {
  return join(resolve(stateDir), '..', '.tmp', 'postgres');
}

export async function ensureTempRoot(root) {
  await mkdir(root, { recursive: true });
  return root;
}

/**
 * True only when `candidatePath` resolves, symlinks and all, to somewhere
 * strictly inside `allowedRoot` — never the root itself, never outside it.
 *
 * A path that no longer exists is treated as already safe to "delete": rm
 * on a missing path is a no-op, and refusing to even try would turn a
 * double-cleanup into a hard failure.
 */
export async function assertSafeTempPath(candidatePath, allowedRoot) {
  if (!candidatePath) {
    return { safe: false, reason: 'EMPTY_PATH', resolved: null };
  }

  const resolvedRoot = resolve(allowedRoot);
  let realRoot;
  try {
    realRoot = await realpath(resolvedRoot);
  } catch {
    realRoot = resolvedRoot; // root does not exist yet — compare lexically
  }

  let real;
  try {
    real = await realpath(candidatePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Already gone. Still validate the LEXICAL path so a caller cannot be
      // tricked by a path that merely doesn't exist yet at check time.
      const lexical = resolve(candidatePath);
      const normalizedRoot = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
      if (lexical === realRoot || !`${lexical}${sep}`.startsWith(normalizedRoot)) {
        return { safe: false, reason: 'OUTSIDE_ALLOWED_ROOT', resolved: lexical };
      }
      return { safe: true, resolved: lexical, alreadyGone: true };
    }
    throw new SpikeError('PATH_CHECK_FAILED', `Cannot resolve ${candidatePath}: ${error.message}`);
  }

  const normalizedRoot = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  if (real === realRoot) {
    return { safe: false, reason: 'IS_ROOT_ITSELF', resolved: real };
  }
  if (!`${real}${sep}`.startsWith(normalizedRoot)) {
    return { safe: false, reason: 'OUTSIDE_ALLOWED_ROOT', resolved: real };
  }
  return { safe: true, resolved: real };
}
