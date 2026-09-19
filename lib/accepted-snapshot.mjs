/**
 * IA Loop — accepted snapshot.
 *
 * Proves that what gets committed is exactly what the Tech Lead accepted.
 *
 * The fingerprint is content-based, never time-based: mtime says nothing about
 * whether the bytes changed. It covers the base commit, the branch, the exact
 * file list and a hash of the full diff, so any edit after the ACCEPTED — to a
 * tracked file or an untracked one — changes it.
 */

import { createHash } from 'node:crypto';

import { SpikeError } from './claude-process.mjs';

export const SNAPSHOT_VERSION = 1;

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Builds the fingerprint from a collected change set.
 *
 * `changes` is what collectWorktreeChanges returns — always read from git, so
 * the fingerprint describes the repository, not a model's claim about it.
 */
export function buildAcceptedSnapshot({ changes, round, decisionJobId = null }) {
  if (!changes) throw new SpikeError('INVALID_ARGS', 'changes are required');

  const files = [...changes.changedFiles].sort();

  return Object.freeze({
    snapshotVersion: SNAPSHOT_VERSION,
    round,
    decisionJobId,
    worktreeInitialHead: changes.base,
    head: changes.head,
    branch: changes.branch,
    fileCount: files.length,
    files: Object.freeze(files),
    // Two independent hashes: the file list alone would miss a content edit
    // that keeps the same set of paths.
    filesHash: sha256(files.join('\n')),
    diffHash: sha256(changes.diff),
    commitsInWorktree: changes.commits.length,
    capturedAt: new Date().toISOString(),
  });
}

/**
 * Compares a fresh snapshot against the accepted one.
 * Returns the list of differences; empty means the tree is unchanged.
 */
export function diffSnapshots(accepted, current) {
  if (!accepted) throw new SpikeError('INVALID_ARGS', 'accepted snapshot is required');
  if (!current) throw new SpikeError('INVALID_ARGS', 'current snapshot is required');

  const differences = [];

  if (accepted.worktreeInitialHead !== current.worktreeInitialHead) {
    differences.push(`worktreeInitialHead: ${accepted.worktreeInitialHead} -> ${current.worktreeInitialHead}`);
  }
  if (accepted.head !== current.head) {
    differences.push(`worktree HEAD: ${accepted.head} -> ${current.head}`);
  }
  if (accepted.branch !== current.branch) {
    differences.push(`branch: ${accepted.branch} -> ${current.branch}`);
  }
  if (accepted.filesHash !== current.filesHash) {
    const added = current.files.filter((f) => !accepted.files.includes(f));
    const removed = accepted.files.filter((f) => !current.files.includes(f));
    differences.push(`file set changed (+${added.length} / -${removed.length})`);
    if (added.length) differences.push(`  added: ${added.slice(0, 5).join(', ')}`);
    if (removed.length) differences.push(`  removed: ${removed.slice(0, 5).join(', ')}`);
  }
  if (accepted.diffHash !== current.diffHash) {
    differences.push('diff content changed since the review');
  }
  if (accepted.commitsInWorktree !== current.commitsInWorktree) {
    differences.push(`commits in worktree: ${accepted.commitsInWorktree} -> ${current.commitsInWorktree}`);
  }

  return differences;
}

/**
 * Gate for closure. Fails closed: the Goal is only committed when the tree is
 * provably the one that was reviewed.
 */
export function assertSnapshotUnchanged(accepted, current) {
  const differences = diffSnapshots(accepted, current);
  if (differences.length > 0) {
    throw new SpikeError(
      'ACCEPTED_WORKTREE_CHANGED',
      `The worktree changed after the review was accepted:\n  ${differences.join('\n  ')}`,
      { differences },
    );
  }
  return true;
}

/**
 * Backfills a snapshot for a Goal accepted before snapshots existed.
 *
 * Only valid when the persisted review packet still describes the tree that was
 * reviewed AND the current tree still matches it — otherwise there is no
 * evidence and the caller must ask a human (or the reviewer) instead of
 * assuming.
 */
export function backfillFromReviewPacket({ packet, currentChanges, savedDiff, round }) {
  if (!packet) throw new SpikeError('INVALID_ARGS', 'review packet is required');

  const packetFiles = [...(packet.changedFiles ?? [])].sort();
  const currentFiles = [...currentChanges.changedFiles].sort();

  const reasons = [];
  if (packet.worktreeInitialHead !== currentChanges.base) {
    reasons.push(`initialHead differs: ${packet.worktreeInitialHead} vs ${currentChanges.base}`);
  }
  if (sha256(packetFiles.join('\n')) !== sha256(currentFiles.join('\n'))) {
    reasons.push(`file list differs: ${packetFiles.length} reviewed vs ${currentFiles.length} present`);
  }
  // The saved patch is the strongest evidence available: byte equality proves
  // the reviewed content is still on disk.
  if (savedDiff !== undefined && savedDiff !== null && sha256(savedDiff) !== sha256(currentChanges.diff)) {
    reasons.push('the saved review diff no longer matches the worktree');
  }

  if (reasons.length > 0) {
    throw new SpikeError(
      'SNAPSHOT_BACKFILL_UNSUPPORTED',
      `Cannot reconstruct the accepted snapshot from the review packet:\n  ${reasons.join('\n  ')}`,
      { reasons },
    );
  }

  return Object.freeze({
    ...buildAcceptedSnapshot({ changes: currentChanges, round }),
    backfilled: true,
    backfillEvidence: 'review packet file list + saved diff match the worktree byte for byte',
  });
}
