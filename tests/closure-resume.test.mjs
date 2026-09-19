/**
 * Resuming a partial Goal closure.
 *
 * `discoverGoal()` used to require the Goal document to read READY no matter
 * how far `ia-loop:close` had already gotten. Once closure documentation moved
 * the document to ACCEPTED — which happens BEFORE the closure commit even
 * exists — a crash or a NEXT_GOAL_PLANNING failure left no way back in: every
 * later re-run refused at the very first line.
 *
 * What this file proves: the resume point is derived only from the closure
 * evidence already on disk (never the document, never guessed), a Goal whose
 * document happens to read ACCEPTED without that evidence is still refused,
 * and the exact 009 story — READY, closure docs, integration, baseline,
 * PLAN_INVALID, restart, resume, valid plan, idempotent re-run — resolves the
 * way `ia-loop:close` needs it to at every one of those points.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLOSURE_RESUME_POINTS,
  expectedMigrationStatusRowFor,
  isClosureIntegrated,
  planningDiffBaseFor,
  requiredGoalStatusFor,
  resolveClosureResumePoint,
} from '../lib/closure-resume.mjs';

// ===========================================================================
// isClosureIntegrated
// ===========================================================================

test('isClosureIntegrated is false with nothing recorded at all', () => {
  assert.equal(isClosureIntegrated({}), false);
  assert.equal(isClosureIntegrated(undefined), false);
});

test('isClosureIntegrated needs BOTH the commit and the new baseline', () => {
  assert.equal(isClosureIntegrated({ integratedClosureCommit: 'a'.repeat(40) }), false);
  assert.equal(isClosureIntegrated({ newMigrationBaseline: 'a'.repeat(40) }), false);
  assert.equal(
    isClosureIntegrated({ integratedClosureCommit: 'a'.repeat(40), newMigrationBaseline: 'a'.repeat(40) }),
    true,
  );
});

test('isClosureIntegrated ignores earlier-stage fields on their own', () => {
  assert.equal(isClosureIntegrated({ closureDocsJobId: 'job-1', sourceClosureCommit: 'a'.repeat(40) }), false);
});

// ===========================================================================
// resolveClosureResumePoint / requiredGoalStatusFor
// ===========================================================================

test('no closure at all is FRESH, and FRESH requires READY', () => {
  assert.equal(resolveClosureResumePoint({}), CLOSURE_RESUME_POINTS.FRESH);
  assert.equal(requiredGoalStatusFor(CLOSURE_RESUME_POINTS.FRESH), 'READY');
});

test('closure docs done but not yet integrated is still FRESH', () => {
  const closure = { closureDocsJobId: 'job-1', sourceClosureCommit: 'a'.repeat(40) };
  assert.equal(resolveClosureResumePoint(closure), CLOSURE_RESUME_POINTS.FRESH);
  assert.equal(requiredGoalStatusFor(CLOSURE_RESUME_POINTS.FRESH), 'READY');
});

test('integrated with no next Goal yet is RESUME_PLANNING, which requires ACCEPTED', () => {
  const closure = { integratedClosureCommit: 'a'.repeat(40), newMigrationBaseline: 'a'.repeat(40) };
  assert.equal(resolveClosureResumePoint(closure), CLOSURE_RESUME_POINTS.RESUME_PLANNING);
  assert.equal(requiredGoalStatusFor(CLOSURE_RESUME_POINTS.RESUME_PLANNING), 'ACCEPTED');
});

test('a next Goal id, on its own, is still RESUME_PLANNING — the plan is not integrated yet', () => {
  // applyPlanningResult writes nextGoalId in the PLANNING WORKTREE, before that
  // worktree's own commit is even made, let alone cherry-picked into main.
  // Treating nextGoalId as "closed" would skip the commit/integrate steps that
  // are still genuinely pending — and MIGRATION_STATUS.md in main would not
  // yet carry the row NEXT_GOAL_PLANNING's commit puts there.
  const closure = {
    integratedClosureCommit: 'a'.repeat(40), newMigrationBaseline: 'a'.repeat(40), nextGoalId: '010',
  };
  assert.equal(resolveClosureResumePoint(closure), CLOSURE_RESUME_POINTS.RESUME_PLANNING);
});

test('nextGoalId AND a source planning commit, but not yet integrated, is still RESUME_PLANNING', () => {
  // The exact shape `ia-loop:close` leaves behind when it recovers a
  // successful planning result and commits the planning worktree, but the
  // main checkout is dirty and the cherry-pick has not run yet.
  const closure = {
    integratedClosureCommit: 'a'.repeat(40), newMigrationBaseline: 'a'.repeat(40),
    nextGoalId: '010', nextGoalTitle: 'x', nextGoalPath: 'docs/migration/goals/010-x.md',
    sourcePlanningCommit: 'c'.repeat(40),
  };
  const resumePoint = resolveClosureResumePoint(closure);
  assert.equal(resumePoint, CLOSURE_RESUME_POINTS.RESUME_PLANNING);
  assert.equal(expectedMigrationStatusRowFor(resumePoint), 'READY', 'main does not have the row yet either');
});

test('integrated AND the planning commit is integrated is ALREADY_CLOSED, which also requires ACCEPTED', () => {
  const closure = {
    integratedClosureCommit: 'a'.repeat(40), newMigrationBaseline: 'a'.repeat(40),
    nextGoalId: '010', sourcePlanningCommit: 'c'.repeat(40), planningIntegrationCommit: 'd'.repeat(40),
  };
  assert.equal(resolveClosureResumePoint(closure), CLOSURE_RESUME_POINTS.ALREADY_CLOSED);
  assert.equal(requiredGoalStatusFor(CLOSURE_RESUME_POINTS.ALREADY_CLOSED), 'ACCEPTED');
});

// ===========================================================================
// expectedMigrationStatusRowFor
// ===========================================================================

test('FRESH expects the MIGRATION_STATUS row to already agree with the document (READY)', () => {
  assert.equal(expectedMigrationStatusRowFor(CLOSURE_RESUME_POINTS.FRESH), 'READY');
});

test('RESUME_PLANNING expects the row to still read READY, even though the document is ACCEPTED', () => {
  // The row is written by NEXT_GOAL_PLANNING, not by closure documentation —
  // this is the gap that made GOAL_STATUS_DIVERGENCE fire on a legitimate resume.
  assert.equal(expectedMigrationStatusRowFor(CLOSURE_RESUME_POINTS.RESUME_PLANNING), 'READY');
});

test('ALREADY_CLOSED expects the row to have caught up to ACCEPTED', () => {
  assert.equal(expectedMigrationStatusRowFor(CLOSURE_RESUME_POINTS.ALREADY_CLOSED), 'ACCEPTED');
});

// ===========================================================================
// Inconsistent state: an arbitrary ACCEPTED Goal is never treated as resumable
// ===========================================================================

test('a Goal with no closure record at all stays FRESH even if its document says ACCEPTED', () => {
  // resolveClosureResumePoint never reads the document — this is the other
  // half of the invariant: nothing here can be talked into RESUME_PLANNING or
  // ALREADY_CLOSED by the document text, only by the persisted evidence.
  const resumePoint = resolveClosureResumePoint({});
  assert.equal(resumePoint, CLOSURE_RESUME_POINTS.FRESH);
  // discoverGoal is asked for READY; a document that actually reads ACCEPTED
  // here is refused by its ordinary mismatch check. Nothing repairs it.
  assert.equal(requiredGoalStatusFor(resumePoint), 'READY');
});

test('a next Goal id alone, without any closure integration evidence, does not count as closed', () => {
  // Guards against a future bug where nextGoalId is set by something other
  // than a completed integration (e.g. a stray write) being read as proof.
  const closure = { nextGoalId: '010' };
  assert.equal(resolveClosureResumePoint(closure), CLOSURE_RESUME_POINTS.FRESH);
  assert.equal(requiredGoalStatusFor(CLOSURE_RESUME_POINTS.FRESH), 'READY');
});

test('a partially-written integration (commit without baseline) is not integrated', () => {
  const closure = { integratedClosureCommit: 'a'.repeat(40), nextGoalId: '010' };
  assert.equal(resolveClosureResumePoint(closure), CLOSURE_RESUME_POINTS.FRESH);
});

test('a planning integration commit alone, without closure integration, does not count as closed', () => {
  // planningIntegrationCommit is only trustworthy once isClosureIntegrated is
  // also true — a lone value here would be a corrupt or hand-edited record.
  const closure = { planningIntegrationCommit: 'd'.repeat(40) };
  assert.equal(resolveClosureResumePoint(closure), CLOSURE_RESUME_POINTS.FRESH);
});

// ===========================================================================
// The Goal 009 story, step by step
// ===========================================================================

test('the 009 story: READY -> closure docs -> integrated -> ACCEPTED -> baseline advances -> '
  + 'PLAN_INVALID -> restart -> resume -> valid plan -> idempotent re-run', () => {
  // 1. Goal begins READY: nothing recorded yet.
  let closure = {};
  let resumePoint = resolveClosureResumePoint(closure);
  assert.equal(resumePoint, CLOSURE_RESUME_POINTS.FRESH);
  assert.equal(requiredGoalStatusFor(resumePoint), 'READY', 'step 1: the fresh flow expects READY');

  // 2. Closure documentation concludes.
  closure = { ...closure, closureDocsJobId: '009-r2-tech_lead-fb76f912', closureDocs: ['docs/migration/goals/009-x.md'] };
  resumePoint = resolveClosureResumePoint(closure);
  assert.equal(resumePoint, CLOSURE_RESUME_POINTS.FRESH, 'step 2: docs alone do not count as integrated');
  assert.equal(requiredGoalStatusFor(resumePoint), 'READY');

  // 3 & 4. Integration concludes, the Goal document becomes ACCEPTED, and the
  // baseline advances — both fields are written together by run-close.mjs's
  // integration step, which is exactly what isClosureIntegrated relies on.
  // MIGRATION_STATUS.md's row is NOT part of this step: it is written later,
  // by NEXT_GOAL_PLANNING, so it still reads READY at this point.
  closure = {
    ...closure,
    sourceClosureCommit: 'a'.repeat(40),
    integratedClosureCommit: 'b'.repeat(40),
    previousMigrationBaseline: 'z'.repeat(40),
    newMigrationBaseline: 'b'.repeat(40),
  };
  assert.equal(isClosureIntegrated(closure), true, 'step 3-4: commit and baseline are both on disk now');
  resumePoint = resolveClosureResumePoint(closure);
  assert.equal(resumePoint, CLOSURE_RESUME_POINTS.RESUME_PLANNING);
  assert.equal(requiredGoalStatusFor(resumePoint), 'ACCEPTED', 'the document legitimately reads ACCEPTED now');
  assert.equal(expectedMigrationStatusRowFor(resumePoint), 'READY', 'the ledger row has not caught up yet');

  // 5. NEXT_GOAL_PLANNING fails with PLAN_INVALID: a planning job id is on
  // disk, but no next Goal — exactly the shape a rejected attempt leaves.
  closure = { ...closure, planningJobId: '009-r2-tech_lead-ee6afa61' };
  resumePoint = resolveClosureResumePoint(closure);
  assert.equal(resumePoint, CLOSURE_RESUME_POINTS.RESUME_PLANNING, 'step 5: still only planning is pending');

  // 6. The process terminates. Nothing about the persisted closure changes —
  // this step exists in the story, not in the state.

  // 7 & 8. `ia-loop:close` is called again: the SAME closure evidence is read
  // from disk, so it resolves to the SAME resume point, required status, and
  // expected ledger row — this is the fix. Before it, discoverGoal always
  // asked for the document to read READY and for the row to match the
  // document exactly, and both checks rejected this exact, legitimate state.
  resumePoint = resolveClosureResumePoint(closure);
  assert.equal(resumePoint, CLOSURE_RESUME_POINTS.RESUME_PLANNING);
  assert.equal(requiredGoalStatusFor(resumePoint), 'ACCEPTED', 'step 8: does not ask for READY, so does not reject');
  assert.equal(expectedMigrationStatusRowFor(resumePoint), 'READY', 'step 8: does not demand a row that is not written yet');

  // 9. No completed phase is repeated: closureDocsJobId, sourceClosureCommit
  // and integratedClosureCommit are all already on `closure`, which is exactly
  // what run-close.mjs's own `if (!closure.X)` guards check before acting.
  assert.ok(closure.closureDocsJobId, 'closure documentation is not re-run');
  assert.ok(closure.sourceClosureCommit, 'no second source commit is created');
  assert.ok(closure.integratedClosureCommit, 'the baseline does not move a second time');

  // 10. Resumes only planning: RESUME_PLANNING is precisely "only
  // NEXT_GOAL_PLANNING is pending", asserted above.

  // 11 & 12. A valid plan is produced this time: Goal 010 is created READY,
  // and the closure record gains nextGoalId — but the planning worktree's own
  // commit, and its cherry-pick into main, are each their own later step.
  // Until the LATTER exists, MIGRATION_STATUS.md in main still has no row for
  // this, so this is still RESUME_PLANNING, not the end of the story.
  closure = { ...closure, nextGoalId: '010', nextGoalTitle: 'Novo goal', nextGoalPath: 'docs/migration/goals/010-x.md' };
  resumePoint = resolveClosureResumePoint(closure);
  assert.equal(resumePoint, CLOSURE_RESUME_POINTS.RESUME_PLANNING, 'step 11-12: nextGoalId alone does not close it');
  assert.equal(expectedMigrationStatusRowFor(resumePoint), 'READY', 'main has not received the row yet');

  closure = { ...closure, sourcePlanningCommit: 'c'.repeat(40) };
  assert.equal(resolveClosureResumePoint(closure), CLOSURE_RESUME_POINTS.RESUME_PLANNING,
    'committing the planning worktree is not integrating it');

  closure = { ...closure, planningIntegrationCommit: 'd'.repeat(40) };
  resumePoint = resolveClosureResumePoint(closure);
  assert.equal(resumePoint, CLOSURE_RESUME_POINTS.ALREADY_CLOSED, 'only the cherry-pick into main closes the story');

  // 13. A further `ia-loop:close` call is a no-op: same evidence, same
  // conclusion, every time — and by now the ledger row is expected to have
  // caught up too (NEXT_GOAL_PLANNING's own commit wrote it).
  assert.equal(resolveClosureResumePoint(closure), CLOSURE_RESUME_POINTS.ALREADY_CLOSED, 'step 13: idempotent');
  assert.equal(requiredGoalStatusFor(resolveClosureResumePoint(closure)), 'ACCEPTED');
  assert.equal(expectedMigrationStatusRowFor(resolveClosureResumePoint(closure)), 'ACCEPTED');
});

// ===========================================================================
// The planning worktree's diff base
// ===========================================================================

const BASELINE = 'a'.repeat(40);
const TIP = 'b'.repeat(40);

test('the planning diff is taken against the commit the worktree was branched from', () => {
  // Main moved after integration — the deterministic Goal-status fix, or a
  // harness commit landing while the run was stopped — so the worktree was
  // branched from the tip, not from the baseline.
  assert.equal(planningDiffBaseFor({ planningBase: TIP }, BASELINE), TIP);
});

test('a closure recorded before the branch point could move falls back to the baseline', () => {
  // Those closures wrote nothing into planningBase, or wrote the baseline,
  // because the two were then always the same commit. Resuming one must
  // behave exactly as it did.
  assert.equal(planningDiffBaseFor({}, BASELINE), BASELINE);
  assert.equal(planningDiffBaseFor({ planningBase: BASELINE }, BASELINE), BASELINE);
});

test('an empty or non-string planningBase is not read as a base', () => {
  // Diffing against '' means diffing against nothing, which would sweep the
  // whole tree into the planning commit.
  assert.equal(planningDiffBaseFor({ planningBase: '' }, BASELINE), BASELINE);
  assert.equal(planningDiffBaseFor({ planningBase: null }, BASELINE), BASELINE);
  assert.equal(planningDiffBaseFor({ planningBase: 42 }, BASELINE), BASELINE);
});

test('a missing closure is tolerated and yields the baseline', () => {
  assert.equal(planningDiffBaseFor(undefined, BASELINE), BASELINE);
  assert.equal(planningDiffBaseFor(), null);
});

test('the Goal020 shape: branching from the tip is what makes the cherry-pick clean', () => {
  // Goal020: the closure documentation omitted the status line, the NEXT
  // invocation corrected it on main, and the planning worktree had been
  // branched before that correction. Both sides then changed one line and the
  // planning commit stopped as CHERRY_PICK_CONFLICT.
  //
  // With the branch point at the tip, the correction is already IN the
  // worktree, and the diff against that same tip contains only what the
  // planner wrote.
  const statusFixOnMain = 'c'.repeat(40);
  const closure = { planningBase: statusFixOnMain };

  assert.equal(planningDiffBaseFor(closure, BASELINE), statusFixOnMain);
  assert.notEqual(planningDiffBaseFor(closure, BASELINE), BASELINE,
    'the accepted baseline stays a published fact; it is not the branch point');
});
