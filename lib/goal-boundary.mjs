/**
 * IA Loop — Goal boundary evaluation.
 *
 * The boundary between two Goals is the one place an autonomous loop can
 * quietly do the wrong thing: start a Goal on the wrong baseline, reuse a
 * worktree that belongs to an earlier run, or re-commit work that already
 * landed. So the boundary is evaluated deterministically, nothing is repaired,
 * and anything ambiguous stops the run.
 *
 * This is a pure function over facts already gathered from git and disk,
 * separate from the gathering, so every branch of it is testable without a
 * repository.
 */

export const BOUNDARY_VERDICTS = Object.freeze({
  START: 'START',
  RESUME: 'RESUME',
  HUMAN_REQUIRED: 'HUMAN_REQUIRED',
});

/**
 * @param facts.goal            the discovered Goal, or null if discovery failed
 * @param facts.discoveryError  why discovery failed, when it did
 * @param facts.expectedBaseline the baseline the autonomous run believes is accepted
 * @param facts.dirtyFiles      relevant dirty paths in the main checkout
 * @param facts.branchExists    the Goal's branch exists
 * @param facts.worktreeExists  the Goal's worktree path exists
 */
export function evaluateGoalBoundary({
  goalId,
  goal,
  discoveryError = null,
  expectedBaseline,
  dirtyFiles = [],
  branchExists = false,
  worktreeExists = false,
}) {
  const problems = [];

  if (discoveryError) problems.push(`goal discovery: ${discoveryError}`);

  if (goal) {
    if (goal.status !== 'READY') {
      problems.push(`Goal ${goalId} is ${goal.status}, expected READY`);
    }
    if (goal.migrationAcceptedBaseline !== expectedBaseline) {
      // Either the closure of the previous Goal did not finish recording, or a
      // commit landed outside the loop. Both are for a human.
      problems.push(
        `Goal declares baseline ${goal.migrationAcceptedBaseline} but the current accepted baseline is ${expectedBaseline}`,
      );
    }
  }

  if (dirtyFiles.length > 0) {
    problems.push(`main checkout is dirty: ${dirtyFiles.slice(0, 5).join(', ')}`);
  }

  // A leftover branch or worktree is acceptable only when both are this Goal's
  // own, which is the resume case. One without the other is a half-finished
  // state nobody can interpret safely.
  if (branchExists !== worktreeExists) {
    problems.push(
      `branch ai-loop/goal-${goalId} and worktree .ai-worktrees/goal-${goalId} disagree `
      + `(${branchExists} vs ${worktreeExists})`,
    );
  }

  const resuming = branchExists && worktreeExists;
  return {
    verdict: problems.length > 0
      ? BOUNDARY_VERDICTS.HUMAN_REQUIRED
      : (resuming ? BOUNDARY_VERDICTS.RESUME : BOUNDARY_VERDICTS.START),
    problems,
    resuming,
  };
}
