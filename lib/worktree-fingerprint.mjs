/**
 * IA Loop — a fingerprint that covers the whole worktree.
 *
 * The forensic gap this closes is a real one. After a duplicate Opus attempt
 * was published against Goal 004, the tracked content could be proven
 * byte-identical to what the reviewer had seen — the diff was saved and hashed.
 * The twenty UNTRACKED files could not: `git diff` does not include them, and
 * the older fingerprint hashed only tracked content (`git stash create`). So
 * 60% of the tree was provable and 40% was not, and the honest verdict for
 * those files had to be UNPROVEN.
 *
 * Nothing here retroactively proves that earlier state. It makes the next one
 * provable:
 *
 *   trackedDiffHash   sha256 of the diff against the base
 *   untracked[]       every untracked path with the sha256 of its CONTENT
 *   head, branch, worktreeInitialHead, base
 *
 * Content, never timestamps. An mtime says when a file was written by whoever
 * happened to write it; a hash says what is in it.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { SpikeError } from './claude-process.mjs';
import { git } from './git-ops.mjs';

export const FINGERPRINT_VERSION = 1;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/**
 * Hashes a file's bytes.
 *
 * Read as a Buffer, not as text: normalising line endings here would make two
 * genuinely different files hash the same, which is the one thing a fingerprint
 * must never do.
 */
async function hashFile(path) {
  const bytes = await readFile(path);
  return { sha256: sha256(bytes), bytes: bytes.length };
}

/**
 * Captures the complete content identity of a worktree.
 *
 * @param worktreePath  absolute path to the worktree
 * @param baseSha       the base the diff is taken against
 * @param worktreeInitialHead  the head the worktree started at, carried through
 */
export async function fullWorktreeFingerprint(worktreePath, baseSha, { worktreeInitialHead = null } = {}) {
  if (!worktreePath) throw new SpikeError('INVALID_ARGS', 'worktreePath is required');
  if (!baseSha) throw new SpikeError('INVALID_ARGS', 'baseSha is required');

  const opts = { cwd: worktreePath };

  const head = await git(['rev-parse', 'HEAD'], opts);
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], opts);
  const diff = await git(['diff', baseSha, '--'], opts, { maxBuffer: 64 * 1024 * 1024 });

  const trackedRaw = await git(['diff', '--name-only', baseSha, '--'], opts);
  const tracked = trackedRaw === '' ? [] : trackedRaw.split('\n').filter(Boolean).sort();

  const untrackedRaw = await git(['ls-files', '--others', '--exclude-standard'], opts);
  const untrackedPaths = untrackedRaw === '' ? [] : untrackedRaw.split('\n').filter(Boolean).sort();

  const untracked = [];
  for (const path of untrackedPaths) {
    try {
      const info = await stat(join(worktreePath, path));
      if (!info.isFile()) continue;
      untracked.push({ path, ...(await hashFile(join(worktreePath, path))) });
    } catch (error) {
      // A file that cannot be read is recorded as unreadable rather than
      // silently dropped: a gap in the evidence has to be visible as a gap.
      untracked.push({ path, sha256: null, bytes: null, unreadable: error.code ?? 'UNKNOWN' });
    }
  }

  // One value that changes if ANY untracked file changes, is added or removed.
  const untrackedHash = sha256(untracked.map((f) => `${f.path}:${f.sha256 ?? 'UNREADABLE'}`).join('\n'));

  return Object.freeze({
    fingerprintVersion: FINGERPRINT_VERSION,
    capturedAt: new Date().toISOString(),
    base: baseSha,
    worktreeInitialHead,
    head,
    branch,
    trackedDiffHash: sha256(diff),
    trackedFileCount: tracked.length,
    trackedFiles: Object.freeze(tracked),
    untrackedHash,
    untrackedFileCount: untracked.length,
    untracked: Object.freeze(untracked),
    // The whole tree in one value, for a single comparison.
    contentHash: sha256(`${sha256(diff)}\n${untrackedHash}\n${head}`),
  });
}

/**
 * Compares two fingerprints and says exactly what moved.
 *
 * Returns the deltas rather than a bare boolean: "something changed" is not
 * actionable, and after the duplicate-attempt incident what was needed was the
 * list of paths.
 */
export function compareFingerprints(before, after) {
  if (!before || !after) {
    return { comparable: false, reason: 'MISSING_FINGERPRINT', identical: false };
  }
  if (before.fingerprintVersion !== after.fingerprintVersion) {
    return { comparable: false, reason: 'FINGERPRINT_VERSION_MISMATCH', identical: false };
  }

  const byPath = (list) => new Map((list ?? []).map((f) => [f.path, f]));
  const b = byPath(before.untracked);
  const a = byPath(after.untracked);

  const untrackedAdded = [...a.keys()].filter((p) => !b.has(p));
  const untrackedRemoved = [...b.keys()].filter((p) => !a.has(p));
  const untrackedModified = [...a.keys()]
    .filter((p) => b.has(p) && b.get(p).sha256 !== a.get(p).sha256);

  const trackedChanged = before.trackedDiffHash !== after.trackedDiffHash;
  const headMoved = before.head !== after.head;

  return {
    comparable: true,
    identical: !trackedChanged && !headMoved
      && untrackedAdded.length === 0 && untrackedRemoved.length === 0 && untrackedModified.length === 0,
    trackedChanged,
    headMoved,
    untrackedAdded,
    untrackedRemoved,
    untrackedModified,
  };
}
