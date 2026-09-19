/**
 * IA Loop — deciding how `ia-loop:close` should resume a Goal closure.
 *
 * `discoverGoal()` gates on the Goal document's declared status, but that
 * status is a CONSEQUENCE of closure having run, not a precondition
 * `run-close.mjs` may assume fixed at READY. Once the closure commit is
 * integrated, the document legitimately reads ACCEPTED — closure documentation
 * put it there — and requiring READY at that point would treat the step that
 * already succeeded as a reason to refuse resuming.
 *
 * What decides the expected status, and whether there is anything left to do
 * at all, is the closure evidence already persisted in `runtime.closure`.
 * Never the document text, and never guessed: a Goal whose document happens to
 * read ACCEPTED without that evidence is not treated as resumable — it is
 * left for `discoverGoal`'s ordinary READY check to refuse, exactly as an
 * unrelated mismatch always was.
 */

export const CLOSURE_RESUME_POINTS = Object.freeze({
  /** No integrated closure yet: run the closure flow from the top. */
  FRESH: 'FRESH',
  /**
   * Closure integrated; the planning commit is not yet integrated into main.
   *
   * Covers the whole span between those two facts — planning not started,
   * planning failed, planning succeeded but not yet committed, or committed
   * but not yet cherry-picked — because MIGRATION_STATUS.md's row (and the
   * closure SHA in it) only lands in main with `planningIntegrationCommit`.
   * `nextGoalId` alone is NOT the boundary: it is written by
   * `applyPlanningResult`, in the planning WORKTREE, before that worktree's
   * own commit is even made, let alone integrated — a Goal 009 shape this was
   * built to handle correctly, not to guess past.
   */
  RESUME_PLANNING: 'RESUME_PLANNING',
  /** The planning commit is integrated into main: nothing left to do. */
  ALREADY_CLOSED: 'ALREADY_CLOSED',
});

/**
 * True once the closure commit is proven integrated.
 *
 * Both fields are written together, in `run-close.mjs`'s integration step, and
 * nowhere else — so together they are as strong a proof as the event log
 * itself that the cherry-pick onto main already happened.
 */
export function isClosureIntegrated(closure = {}) {
  return Boolean(closure?.integratedClosureCommit && closure?.newMigrationBaseline);
}

/**
 * The commit the planning worktree's diff must be taken against.
 *
 * It is the commit that worktree was BRANCHED FROM, which is not necessarily
 * the accepted baseline. The planning worktree is branched from main's tip so
 * that anything landing on main between integration and planning — the
 * deterministic Goal-status fix, a harness commit made while the run was
 * stopped — is already present, and the planning commit therefore cherry-picks
 * cleanly. Diffing such a worktree against the BASELINE instead would attribute
 * those commits to the planner and sweep them into its commit.
 *
 * `acceptedBaseline` is the fallback and exists only for closures recorded
 * before the branch point could move, which wrote the baseline into
 * `planningBase` because the two were then always the same commit. Resuming
 * one of those must behave exactly as it did.
 */
export function planningDiffBaseFor(closure = {}, acceptedBaseline = null) {
  const recorded = closure?.planningBase;
  return typeof recorded === 'string' && recorded !== '' ? recorded : acceptedBaseline;
}

/**
 * Where a `ia-loop:close` invocation should resume from, given only the
 * closure evidence already on disk.
 *
 * Deliberately blind to the Goal document: mixing the two would let a document
 * edited by hand change what this function concludes. The document is
 * `discoverGoal`'s concern, driven by `requiredGoalStatusFor` below — this
 * function must stay decidable from `runtime.closure` alone.
 */
export function resolveClosureResumePoint(closure = {}) {
  if (!isClosureIntegrated(closure)) return CLOSURE_RESUME_POINTS.FRESH;
  return closure.planningIntegrationCommit
    ? CLOSURE_RESUME_POINTS.ALREADY_CLOSED
    : CLOSURE_RESUME_POINTS.RESUME_PLANNING;
}

/**
 * The Goal document status `discoverGoal` must require for this resume point.
 *
 * FRESH expects READY: the Goal was reviewed and accepted, but closure has not
 * integrated anything yet, so the document must still be exactly what the
 * review left it at. RESUME_PLANNING and ALREADY_CLOSED both expect ACCEPTED:
 * the closure commit already exists on disk, and the document truly is what
 * closure documentation legitimately turned it into.
 *
 * There is no third code path for "ACCEPTED without integrated evidence" — an
 * arbitrary ACCEPTED Goal is not closure-in-progress. `resolveClosureResumePoint`
 * still calls it FRESH (no evidence), so this still requires READY, and
 * `discoverGoal` still refuses it. Failing closed is the answer, not something
 * this function repairs or guesses past.
 */
export function requiredGoalStatusFor(resumePoint) {
  return resumePoint === CLOSURE_RESUME_POINTS.FRESH ? 'READY' : 'ACCEPTED';
}

/**
 * The row `discoverGoal` must find for this Goal in MIGRATION_STATUS.md.
 *
 * Closure documentation moves the Goal DOCUMENT to ACCEPTED, but the
 * MIGRATION_STATUS row — and the closure commit SHA that goes with it — is
 * written later, by NEXT_GOAL_PLANNING, in the same commit that creates the
 * next Goal. So while planning is still pending the row legitimately still
 * reads READY even though the document has already moved on: this is not a
 * divergence to refuse, it is the known shape of this exact resume point.
 *
 * Every other resume point requires the row to already agree with the
 * document, exactly as `discoverGoal` always required — this only widens the
 * window for the one gap that is real and temporary.
 */
export function expectedMigrationStatusRowFor(resumePoint) {
  if (resumePoint === CLOSURE_RESUME_POINTS.RESUME_PLANNING) return 'READY';
  return requiredGoalStatusFor(resumePoint);
}
