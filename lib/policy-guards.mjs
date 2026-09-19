/**
 * IA Loop — policy guards for real execution.
 *
 * Snapshots the repository before and after each agent runs, and reports what
 * an agent was not allowed to do.
 *
 * Honest limitation: these guards DETECT violations, they do not prevent them.
 * An agent with Bash can reach outside its working directory. The mitigation is
 * layered — a separate worktree, a scoped --add-dir, and these checks — but the
 * checks are the last line, not a sandbox.
 */

import { SpikeError } from './claude-process.mjs';

export const VIOLATIONS = Object.freeze({
  DEVELOPER_COMMITTED: 'DEVELOPER_COMMITTED',
  DEVELOPER_CHANGED_BRANCH: 'DEVELOPER_CHANGED_BRANCH',
  DEVELOPER_MOVED_HEAD: 'DEVELOPER_MOVED_HEAD',
  MAIN_CHECKOUT_MUTATED: 'MAIN_CHECKOUT_MUTATED',
  REVIEWER_MUTATED_WORKTREE: 'REVIEWER_MUTATED_WORKTREE',
  GOAL_DOC_MUTATED: 'GOAL_DOC_MUTATED',
});

/** Snapshot used for before/after comparison. */
export async function captureSnapshot({ probe, worktreePath, collect, fingerprint }) {
  const [mainHead, mainBranch, mainDirty] = await Promise.all([
    probe.head(),
    probe.currentBranch(),
    probe.relevantDirtyFiles(),
  ]);

  const snapshot = { mainHead, mainBranch, mainDirty: mainDirty.sort() };

  if (worktreePath && fingerprint) {
    snapshot.worktree = await fingerprint(worktreePath);
  }
  if (worktreePath && collect) {
    snapshot.changes = await collect(worktreePath);
  }
  return snapshot;
}

/**
 * Checks what the Developer was not allowed to do.
 *
 * Returns a list of violations; an empty list means the run stayed in bounds.
 */
export function checkDeveloperPolicy({ before, after, worktreeInitialHead, changes }) {
  const violations = [];

  if (changes.commits.length > 0) {
    violations.push({
      code: VIOLATIONS.DEVELOPER_COMMITTED,
      detail: `The Developer created ${changes.commits.length} commit(s): ${changes.commits.slice(0, 3).join(' | ')}`,
    });
  }

  if (changes.head !== worktreeInitialHead) {
    violations.push({
      code: VIOLATIONS.DEVELOPER_MOVED_HEAD,
      detail: `Worktree HEAD moved from ${worktreeInitialHead} to ${changes.head}`,
    });
  }

  if (after.mainHead !== before.mainHead) {
    violations.push({
      code: VIOLATIONS.MAIN_CHECKOUT_MUTATED,
      detail: `Main checkout HEAD moved from ${before.mainHead} to ${after.mainHead}`,
    });
  }

  if (after.mainBranch !== before.mainBranch) {
    violations.push({
      code: VIOLATIONS.DEVELOPER_CHANGED_BRANCH,
      detail: `Main checkout branch changed from ${before.mainBranch} to ${after.mainBranch}`,
    });
  }

  // New dirt in the MAIN checkout means the agent wrote outside its worktree.
  const newMainDirt = after.mainDirty.filter((f) => !before.mainDirty.includes(f));
  if (newMainDirt.length > 0) {
    violations.push({
      code: VIOLATIONS.MAIN_CHECKOUT_MUTATED,
      detail: `New changes in the main checkout: ${newMainDirt.slice(0, 5).join(', ')}`,
    });
  }

  // The Developer implements the Goal; it does not rewrite the Goal or the
  // migration status that authorises it.
  const forbidden = changes.changedFiles.filter((f) =>
    f.startsWith('docs/migration/goals/')
    || f === 'docs/migration/MIGRATION_STATUS.md'
    || f.startsWith('docs/migration/reviews/'));
  if (forbidden.length > 0) {
    violations.push({
      code: VIOLATIONS.GOAL_DOC_MUTATED,
      detail: `The Developer modified migration control documents: ${forbidden.join(', ')}`,
    });
  }

  return violations;
}

/**
 * The reviewer is read-only. Any mutation invalidates the review, because the
 * thing that was reviewed is no longer the thing that was delivered.
 */
export function checkReviewerPolicy({ before, after }) {
  const violations = [];

  if (!before.worktree || !after.worktree) {
    throw new SpikeError('INVALID_ARGS', 'Reviewer policy check needs worktree fingerprints');
  }

  if (before.worktree.head !== after.worktree.head) {
    violations.push({
      code: VIOLATIONS.REVIEWER_MUTATED_WORKTREE,
      detail: `Worktree HEAD changed during review: ${before.worktree.head} -> ${after.worktree.head}`,
    });
  }

  if (before.worktree.status !== after.worktree.status) {
    violations.push({
      code: VIOLATIONS.REVIEWER_MUTATED_WORKTREE,
      detail: 'The worktree working set changed during the review.',
    });
  }

  if (after.mainHead !== before.mainHead) {
    violations.push({
      code: VIOLATIONS.MAIN_CHECKOUT_MUTATED,
      detail: `Main checkout HEAD moved during review: ${before.mainHead} -> ${after.mainHead}`,
    });
  }

  const newMainDirt = after.mainDirty.filter((f) => !before.mainDirty.includes(f));
  if (newMainDirt.length > 0) {
    violations.push({
      code: VIOLATIONS.MAIN_CHECKOUT_MUTATED,
      detail: `New changes in the main checkout during review: ${newMainDirt.slice(0, 5).join(', ')}`,
    });
  }

  return violations;
}

export function formatViolations(violations) {
  return violations.map((v) => `[${v.code}] ${v.detail}`);
}
