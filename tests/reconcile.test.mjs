/**
 * Reconcile before dispatch.
 *
 * The bug: round selection was derived from job ids recorded in the runtime.
 * Those ids are a hint and were treated as the authority. When the recorded id
 * was missing, the loop concluded nothing had been done, minted a fresh random
 * attempt id, found no result under a name that had never existed, and sent
 * Opus to re-implement Goal 004 round 1 — whose implementation AND review were
 * both already on disk, the review carrying four blockers.
 *
 * These tests state the invariant that makes it impossible: a stage with a
 * terminal result is finished, and no restart, recovery, attach, capacity
 * resume, missing pointer or fresh random id makes another attempt legitimate.
 *
 * No model is called anywhere here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DISPATCH_KINDS, STAGE_STATUS, STAGE_JOB_SOURCE, assertNoDuplicateStageDispatch,
  buildStageLedger, decideNextDispatch, isReviewStale, reconcileExecutionState, resolveStageJobId,
} from '../lib/reconcile.mjs';
import { STAGES, roleForStage, stageKey, stageKeyOfJob } from '../lib/stage-identity.mjs';
import { CLOSURE_JOB_TYPES } from '../lib/closure-contracts.mjs';
import { createJobStore } from '../lib/job-store.mjs';
import { createAutonomousStore } from '../lib/autonomous-state.mjs';
import { createHandoffStore } from '../lib/recovery-handoff.mjs';
import { RECOVERY_ACTIONS, planRecovery } from '../lib/recovery-plan.mjs';
import { OWNER_STATUS } from '../lib/orphan-evidence.mjs';
import { LOOP_STATES } from '../lib/loop-state.mjs';
import { PROTOCOL_VERSION_V2 } from '../lib/contracts-v2.mjs';

const codeIs = (code) => (error) => error.code === code;

const GOAL = '004';
const DEV_R1 = '004-r1-developer-d8f21303';
const REV_R1 = '004-r1-tech_lead-4ded365b';
const DUPE_R1 = '004-r1-developer-69a88746';
const EXECUTION_BASE = 'b3a019c94b8e89f48db5ab017866ff9e325d7d82';
const BASELINE = '588b70f575670eeda015750b400a09752ceb5490';

/** The four blockers the real review produced. */
const BLOCKERS = [
  { id: 'B1', title: 'inbox worker sem backoff' },
  { id: 'B2', title: 'outbox sem idempotência' },
  { id: 'B3', title: 'webhook sem verificação de assinatura' },
  { id: 'B4', title: 'migração sem ensaio' },
];

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-reconcile-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

const devJob = (jobId, round, type = 'IMPLEMENTATION') => ({
  role: 'developer', job: { jobId, role: 'developer', goal: GOAL, round, type },
});
const revJob = (jobId, round) => ({
  role: 'tech_lead', job: { jobId, role: 'tech_lead', goal: GOAL, round },
});
const withResult = (entry, result, status = 'COMPLETED') => ({ ...entry, status, result });

/** The exact situation on disk when the duplicate was published. */
const goal004Entries = () => [
  withResult(devJob(DEV_R1, 1), { status: 'REVIEW_REQUIRED', jobId: DEV_R1 }),
  withResult(revJob(REV_R1, 1), { decision: 'CHANGES_REQUIRED', blockers: BLOCKERS, jobId: REV_R1 }),
  { ...devJob(DUPE_R1, 1), status: 'RUNNING', result: null },
];

// ===========================================================================
// Stage identity
// ===========================================================================

test('a stage is named by what it is, not by which attempt ran it', () => {
  assert.equal(stageKey({ goal: GOAL, round: 1, stage: STAGES.IMPLEMENTATION }), '004:r1:implementation');
  assert.equal(stageKey({ goal: GOAL, round: 2, stage: STAGES.CORRECTION }), '004:r2:correction');
  assert.equal(roleForStage(STAGES.REVIEW), 'tech_lead');
  assert.equal(roleForStage(STAGES.CORRECTION), 'developer');
});

test('6. two random attempt ids resolve to the same logical stage', () => {
  // This is precisely what the harness could not see: d8f21303 and 69a88746 are
  // two attempts at one thing.
  const a = stageKeyOfJob({ jobId: DEV_R1, role: 'developer', goal: GOAL, round: 1, type: 'IMPLEMENTATION' });
  const b = stageKeyOfJob({ jobId: DUPE_R1, role: 'developer', goal: GOAL, round: 1, type: 'IMPLEMENTATION' });
  assert.equal(a, b);
  assert.equal(a, '004:r1:implementation');
});

test('a correction and an implementation of the same round are different stages', () => {
  assert.notEqual(
    stageKeyOfJob({ role: 'developer', goal: GOAL, round: 2, type: 'CORRECTION' }),
    stageKeyOfJob({ role: 'developer', goal: GOAL, round: 2, type: 'IMPLEMENTATION' }),
  );
});

test('closure and planning jobs are not round stages', () => {
  // Asserted against the field and the values the PUBLISHERS actually write
  // (run-close.mjs), read from the same shared constant. This test used to
  // assert `kind: 'CLOSURE_DOCS' | 'PLANNING'` — a shape that exists nowhere on
  // disk — so it passed while the real jobs were being misread as reviews.
  for (const type of CLOSURE_JOB_TYPES) {
    assert.equal(stageKeyOfJob({ role: 'tech_lead', goal: GOAL, round: 1, type }), null, type);
  }
  // A job carrying the old, never-written shape is NOT a closure job, and must
  // not be silently excluded from the ledger either.
  assert.equal(
    stageKeyOfJob({ role: 'tech_lead', goal: GOAL, round: 1, kind: 'PLANNING' }),
    stageKey({ goal: GOAL, round: 1, stage: STAGES.REVIEW }),
  );
});

// ===========================================================================
// 1, 2, 9. The ledger, and where Goal004 actually goes next
// ===========================================================================

test('1/2/9. implementation and review both complete: the next step is correction R2 with the four blockers', () => {
  const ledger = buildStageLedger(goal004Entries());
  const next = decideNextDispatch({ ledger, goal: GOAL });

  assert.equal(next.kind, DISPATCH_KINDS.CORRECTION);
  assert.equal(next.round, 2, 'round 2, not a second round 1');
  assert.equal(next.role, 'developer');
  assert.equal(next.stageKey, '004:r2:correction');
  assert.equal(next.blockers.length, 4, 'exactly the four the review produced');
  assert.deepEqual(next.blockers, BLOCKERS, 'carried verbatim, never rediscovered');
  assert.equal(next.fromReviewJobId, REV_R1);
});

// A real incident: Goal007 R1's review asked for changes AND escalated the
// next round to OPUS_MEDIUM, with a reason. The machine rebooted while that
// review was still parked on a capacity wait; by the time it finished, no
// run-goal.mjs process had ever been alive to read the decision and persist
// the escalation (the worker completed it on its own — see
// run-resume.mjs's reclaimBlockedJobLease). Recovery consumed the result cold,
// straight into round 2, and the escalation was silently dropped: the
// correction ran on the Goal's existing profile instead of the one the
// reviewer explicitly asked for, and the discrepancy was invisible until
// someone compared the review's own JSON against what actually got dispatched.
test('a review\'s escalation for the next round travels with the dispatch, exactly like its blockers', () => {
  const ledger = buildStageLedger([
    withResult(devJob(DEV_R1, 1), { status: 'REVIEW_REQUIRED' }),
    withResult(revJob(REV_R1, 1), {
      decision: 'CHANGES_REQUIRED', blockers: BLOCKERS,
      nextDeveloperProfile: 'OPUS_MEDIUM',
      nextDeveloperProfileReason: 'Correções atravessam três serviços com contrato em jogo.',
    }),
  ]);
  const next = decideNextDispatch({ ledger, goal: GOAL });

  assert.equal(next.kind, DISPATCH_KINDS.CORRECTION);
  assert.equal(next.nextDeveloperProfile, 'OPUS_MEDIUM');
  assert.equal(next.nextDeveloperProfileReason, 'Correções atravessam três serviços com contrato em jogo.');
});

test('a review that named no escalation carries none — silence is not promotion', () => {
  const ledger = buildStageLedger(goal004Entries());
  const next = decideNextDispatch({ ledger, goal: GOAL });
  assert.equal(next.nextDeveloperProfile, null);
  assert.equal(next.nextDeveloperProfileReason, null);
});

test('10/11. neither model is asked to redo round 1', () => {
  const ledger = buildStageLedger(goal004Entries());

  assert.throws(() => assertNoDuplicateStageDispatch({
    ledger, goal: GOAL, round: 1, stage: STAGES.IMPLEMENTATION, jobId: DUPE_R1,
  }), codeIs('DUPLICATE_COMPLETED_STAGE_DISPATCH'), 'Opus must not be called for R1');

  assert.throws(() => assertNoDuplicateStageDispatch({
    ledger, goal: GOAL, round: 1, stage: STAGES.REVIEW, jobId: '004-r1-tech_lead-newid',
  }), codeIs('DUPLICATE_COMPLETED_STAGE_DISPATCH'), 'Fable must not be called for R1');
});

test('12. the only legitimate next model call is the Developer on correction R2', () => {
  const ledger = buildStageLedger(goal004Entries());

  // R2 correction has no result, so dispatching it is allowed.
  assert.equal(assertNoDuplicateStageDispatch({
    ledger, goal: GOAL, round: 2, stage: STAGES.CORRECTION, jobId: 'new-attempt',
  }), true);

  const next = decideNextDispatch({ ledger, goal: GOAL });
  assert.equal(next.role, 'developer');
  assert.equal(next.round, 2);
});

// ===========================================================================
// The real Goal010 incident: a terminal BLOCKED result, reused across three
// rounds because `run-goal.mjs` reconciled once, before round 1, and kept
// asking that same stale object for round 2 and round 3's job ids.
//
// `DEVELOPER_STATUSES_V2` is `['REVIEW_REQUIRED', 'BLOCKED', 'ESCALATION_REQUIRED']`
// — BLOCKED is just as terminal a Developer result as REVIEW_REQUIRED. Nothing
// here should special-case it, and that is exactly the point: a Work Unit
// round can end BLOCKED with real completed work behind it (11 of 22 units, in
// the real incident) and still owe a genuine correction round, not a silent
// "nothing more to try."
// ===========================================================================

const GOAL_010 = '010';
const DEV_R1_010 = '010-r1-developer-5e17af67';
const REV_R1_010 = '010-r1-tech_lead-6d2efb1c';

const GOAL010_BLOCKERS = [
  { id: 'C1', title: 'importação sobrescreve confirmação já existente no mesmo horário' },
  { id: 'C2', title: 'schemas e serviço de migração ausentes no frontend' },
];

// `devJob`/`revJob` above hardcode `goal: GOAL` ('004') — fine for every
// Goal004 test, wrong here. Goal010's own incident is reproduced against its
// real goal id, not against whatever the shared fixtures happen to default to.
const devJob010 = (jobId, round, type = 'IMPLEMENTATION') => ({
  role: 'developer', job: { jobId, role: 'developer', goal: GOAL_010, round, type },
});
const revJob010 = (jobId, round, developerJobId = null) => ({
  role: 'tech_lead', job: { jobId, role: 'tech_lead', goal: GOAL_010, round, developerJobId },
});

test('R1 BLOCKED + CHANGES_REQUIRED: the next step is a NEW correction R2, never R1 replayed', () => {
  const ledger = buildStageLedger([
    withResult(devJob010(DEV_R1_010, 1), { status: 'BLOCKED', jobId: DEV_R1_010 }),
    withResult(revJob010(REV_R1_010, 1), { decision: 'CHANGES_REQUIRED', blockers: GOAL010_BLOCKERS, jobId: REV_R1_010 }),
  ], { goal: GOAL_010 });

  const next = decideNextDispatch({ ledger, goal: GOAL_010 });

  // 3. a new correction job is what's needed.
  assert.equal(next.kind, DISPATCH_KINDS.CORRECTION);
  assert.equal(next.round, 2, 'round 2, not a second round 1');
  assert.equal(next.stageKey, '010:r2:correction');
  // 4. the review's own blockers travel with it, verbatim.
  assert.deepEqual(next.blockers, GOAL010_BLOCKERS);
  // 5. nothing points back at the R1 job — there is no completed attempt for
  // R2's correction stage yet, so there is nothing to resume.
  assert.equal(next.resumeAttempt, null);
  assert.notEqual(next.resumeAttempt, DEV_R1_010);

  // The R1 stage itself is untouched: still exactly what it was, still
  // completed by the same job, never rewritten into looking like R2's.
  const r1 = ledger.get('010:r1:implementation');
  assert.equal(r1.completedBy, DEV_R1_010);
  assert.equal(r1.status, STAGE_STATUS.COMPLETED);
  // And R2's correction stage does not exist at all yet — not "completed by
  // R1's job", genuinely absent.
  assert.equal(ledger.get('010:r2:correction'), undefined);
});

test('6. R2 review cannot happen before R2 has its OWN completed correction result', () => {
  // Only what R1/R2 would credibly have on disk if the bug had never fired:
  // R1 done and reviewed, R2 correction dispatched but not yet finished.
  const DEV_R2_010 = '010-r2-correction-aaaa1111';
  const ledgerInFlight = buildStageLedger([
    withResult(devJob010(DEV_R1_010, 1), { status: 'BLOCKED', jobId: DEV_R1_010 }),
    withResult(revJob010(REV_R1_010, 1), { decision: 'CHANGES_REQUIRED', blockers: GOAL010_BLOCKERS, jobId: REV_R1_010 }),
    { ...devJob010(DEV_R2_010, 2, 'CORRECTION'), status: 'RUNNING', result: null },
  ], { goal: GOAL_010 });

  const stillCorrection = decideNextDispatch({ ledger: ledgerInFlight, goal: GOAL_010 });
  assert.equal(stillCorrection.kind, DISPATCH_KINDS.CORRECTION, 'no review yet: R2 correction has not produced a result');
  assert.equal(stillCorrection.round, 2);
  assert.equal(stillCorrection.resumeAttempt, DEV_R2_010, 'the in-flight R2 attempt is offered back, not a fresh id');

  // Now R2's correction genuinely completes, with ITS OWN job id.
  const ledgerDone = buildStageLedger([
    withResult(devJob010(DEV_R1_010, 1), { status: 'BLOCKED', jobId: DEV_R1_010 }),
    withResult(revJob010(REV_R1_010, 1), { decision: 'CHANGES_REQUIRED', blockers: GOAL010_BLOCKERS, jobId: REV_R1_010 }),
    withResult(devJob010(DEV_R2_010, 2, 'CORRECTION'), { status: 'REVIEW_REQUIRED', jobId: DEV_R2_010 }),
  ], { goal: GOAL_010 });

  const nowReview = decideNextDispatch({ ledger: ledgerDone, goal: GOAL_010 });
  assert.equal(nowReview.kind, DISPATCH_KINDS.REVIEW, 'only now does R2 review become legitimate');
  assert.equal(nowReview.round, 2);
  assert.equal(nowReview.implementationJobId, DEV_R2_010, 'the review is FOR the R2 job, not the R1 one');
});

test('reconciling twice across a round boundary must not answer round 2 with round 1\'s stale hint', () => {
  // This is the actual mechanism of the incident, reproduced directly: the
  // SAME kind of object `run-goal.mjs` used to cache once, before its loop,
  // and keep querying for every later round in the same process.
  //
  // Snapshot #1: taken when only R1's (interrupted, then completed) attempt
  // exists — legitimately resolves to something naming the R1 job.
  const snapshotAtStart = buildStageLedger([
    { ...devJob010(DEV_R1_010, 1), status: 'INTERRUPTED', attemptStatus: 'INTERRUPTED', result: null },
  ], { goal: GOAL_010 });
  const decisionAtStart = decideNextDispatch({ ledger: snapshotAtStart, goal: GOAL_010 });
  assert.equal(decisionAtStart.kind, DISPATCH_KINDS.IMPLEMENTATION);
  assert.equal(decisionAtStart.resumeAttempt, DEV_R1_010, 'legitimate for THIS decision: resuming R1 itself');

  // R1 finishes (BLOCKED) and is reviewed (CHANGES_REQUIRED) — all within the
  // same long-running process, without it ever restarting.
  const snapshotAfterR1 = buildStageLedger([
    withResult(devJob010(DEV_R1_010, 1), { status: 'BLOCKED', jobId: DEV_R1_010 }),
    withResult(revJob010(REV_R1_010, 1), { decision: 'CHANGES_REQUIRED', blockers: GOAL010_BLOCKERS, jobId: REV_R1_010 }),
  ], { goal: GOAL_010 });
  const decisionAfterR1 = decideNextDispatch({ ledger: snapshotAfterR1, goal: GOAL_010 });

  // The whole bug, in one assertion: re-deriving the ledger after R1 finished
  // gives a DIFFERENT decision than the one taken at start — proving that
  // holding on to `decisionAtStart` (or `snapshotAtStart`) and reusing it for
  // round 2 was never a caching optimisation, it was answering a question
  // nobody asked with an answer that used to be true.
  assert.notEqual(decisionAfterR1.kind, decisionAtStart.kind);
  assert.notEqual(decisionAfterR1.round, decisionAtStart.round);
  assert.notEqual(decisionAfterR1.resumeAttempt, decisionAtStart.resumeAttempt);
  assert.equal(decisionAfterR1.kind, DISPATCH_KINDS.CORRECTION);
  assert.equal(decisionAfterR1.round, 2);
  assert.equal(decisionAfterR1.resumeAttempt, null);
});

// ===========================================================================
// A stale R2 review on disk — a real review, genuinely completed, but FOR
// round 1's own result (published under round 2's label, the way the actual
// Goal010 incident's reviews were). Provenance is what tells them apart; the
// round number alone does not.
// ===========================================================================

test('an R2 review filed over R1\'s own result cannot satisfy R2, even once a genuine R2 correction exists', () => {
  // 1-2. R1 Developer BLOCKED, R1 review CHANGES_REQUIRED — the real starting
  // point of the incident.
  const r1Entries = [
    withResult(devJob010(DEV_R1_010, 1), { status: 'BLOCKED', jobId: DEV_R1_010 }),
    withResult(revJob010(REV_R1_010, 1, DEV_R1_010), { decision: 'CHANGES_REQUIRED', blockers: GOAL010_BLOCKERS, jobId: REV_R1_010 }),
  ];

  // 3. A stale R2 review exists — completed, filed under round 2, but its own
  // `developerJobId` names R1's job: exactly what a review published while
  // `reconciled` was stuck resuming R1 would look like on disk.
  const STALE_REV_R2 = '010-r2-tech_lead-staleaaaa';
  const staleLedger = buildStageLedger([
    ...r1Entries,
    withResult(revJob010(STALE_REV_R2, 2, DEV_R1_010), { decision: 'CHANGES_REQUIRED', blockers: GOAL010_BLOCKERS, jobId: STALE_REV_R2 }),
  ], { goal: GOAL_010 });

  // 4. Reconciliation still says R2 Developer correction is what's next — the
  // stale review filed under round 2 changes nothing, because the loop never
  // even reaches round 2 until round 1's own review sends it there, and it
  // sends it to CORRECTION, not to inspecting round 2's review.
  const beforeCorrection = decideNextDispatch({ ledger: staleLedger, goal: GOAL_010 });
  assert.equal(beforeCorrection.kind, DISPATCH_KINDS.CORRECTION);
  assert.equal(beforeCorrection.round, 2);
  assert.equal(beforeCorrection.resumeAttempt, null, 'nothing legitimate to resume for a correction that never ran');

  // 5. A genuine new R2 DeveloperResult is produced, under its OWN job id.
  const DEV_R2_010_NEW = '010-r2-correction-genuine1';
  const ledgerWithNewCorrection = buildStageLedger([
    ...r1Entries,
    withResult(revJob010(STALE_REV_R2, 2, DEV_R1_010), { decision: 'CHANGES_REQUIRED', blockers: GOAL010_BLOCKERS, jobId: STALE_REV_R2 }),
    withResult(devJob010(DEV_R2_010_NEW, 2, 'CORRECTION'), { status: 'REVIEW_REQUIRED', jobId: DEV_R2_010_NEW }),
  ], { goal: GOAL_010 });

  // 6-8. The stale review cannot satisfy R2's review stage: a NEW review is
  // what's next, and its provenance target is the NEW result, never the old one.
  const next = decideNextDispatch({ ledger: ledgerWithNewCorrection, goal: GOAL_010 });
  assert.equal(next.kind, DISPATCH_KINDS.REVIEW, 'the stale review is not reuse — a new review is owed');
  assert.equal(next.round, 2);
  assert.equal(next.implementationJobId, DEV_R2_010_NEW, 'provenance points at the genuine R2 result, never R1\'s');
  assert.notEqual(next.implementationJobId, DEV_R1_010);
  assert.equal(next.resumeAttempt, null, 'the stale review\'s own (completed) attempt is never offered back');

  // The staleness is visible directly, too — `reconcileExecutionState`'s own
  // supersede-queue integration test (below, using a real store) proves the
  // native supersede pipeline picks this up with no special-casing needed.
  const r2Review = ledgerWithNewCorrection.get('010:r2:review');
  const r2Correction = ledgerWithNewCorrection.get('010:r2:correction');
  assert.equal(isReviewStale({ implementation: r2Correction, review: r2Review }), true);
});

test('a review whose provenance is simply unrecorded (pre-existing history) is never treated as stale', () => {
  // Every review Goal003 through Goal009 ever produced predates
  // `developerJobId`. None of that accepted history is retroactively stale.
  const ledger = buildStageLedger([
    withResult(devJob010(DEV_R1_010, 1), { status: 'BLOCKED', jobId: DEV_R1_010 }),
    withResult(revJob010(REV_R1_010, 1 /* no developerJobId */), { decision: 'CHANGES_REQUIRED', blockers: GOAL010_BLOCKERS, jobId: REV_R1_010 }),
  ], { goal: GOAL_010 });

  assert.equal(isReviewStale({
    implementation: ledger.get('010:r1:implementation'),
    review: ledger.get('010:r1:review'),
  }), false);
});

test('a job marked SUPERSEDED never satisfies a stage again, even though its result file is untouched', () => {
  // The other half of the fix: buildStageLedger itself must stop crediting a
  // superseded job's (still-present, deliberately never deleted) result.
  const ledger = buildStageLedger([
    withResult(revJob010(REV_R1_010, 1), { decision: 'CHANGES_REQUIRED', blockers: GOAL010_BLOCKERS, jobId: REV_R1_010 }, 'SUPERSEDED'),
  ], { goal: GOAL_010 });

  const stage = ledger.get('010:r1:review');
  assert.equal(stage.status, STAGE_STATUS.NOT_STARTED, 'a superseded job\'s result no longer completes the stage');
  assert.equal(stage.completedBy, null);
  // The attempt itself stays visible in the record — nothing is deleted.
  assert.equal(stage.attempts.length, 1);
  assert.equal(stage.attempts[0].jobId, REV_R1_010);
});

test('5. a completed stage refuses a new attempt; the completing attempt is idempotent', () => {
  const ledger = buildStageLedger(goal004Entries());

  // Re-entering with the id that produced the result is reuse, not duplication.
  assert.equal(assertNoDuplicateStageDispatch({
    ledger, goal: GOAL, round: 1, stage: STAGES.IMPLEMENTATION, jobId: DEV_R1,
  }), true);

  // Any other id is a duplicate.
  for (const jobId of [DUPE_R1, 'anything-else', null]) {
    assert.throws(() => assertNoDuplicateStageDispatch({
      ledger, goal: GOAL, round: 1, stage: STAGES.IMPLEMENTATION, jobId,
    }), codeIs('DUPLICATE_COMPLETED_STAGE_DISPATCH'), String(jobId));
  }
});

test('8. an attempt still RUNNING at a completed stage is a duplicate', () => {
  const ledger = buildStageLedger(goal004Entries());
  const stage = ledger.get('004:r1:implementation');

  assert.equal(stage.status, STAGE_STATUS.COMPLETED);
  assert.equal(stage.completedBy, DEV_R1);
  assert.deepEqual(stage.duplicates, [DUPE_R1], 'the running attempt is named as the duplicate');
});

test('7. a currentJobId pointing at the duplicate does not change any of it', () => {
  // The runtime pointer is not an input to the ledger at all: it cannot make a
  // duplicate authoritative over the original result.
  const ledger = buildStageLedger(goal004Entries());
  const next = decideNextDispatch({ ledger, goal: GOAL });
  assert.equal(next.kind, DISPATCH_KINDS.CORRECTION);
  assert.equal(next.round, 2);
});

// ===========================================================================
// Other paths through the ledger
// ===========================================================================

test('implemented but not reviewed: the next step is the review of that round', () => {
  const ledger = buildStageLedger([
    withResult(devJob(DEV_R1, 1), { status: 'REVIEW_REQUIRED' }),
  ]);
  const next = decideNextDispatch({ ledger, goal: GOAL });
  assert.equal(next.kind, DISPATCH_KINDS.REVIEW);
  assert.equal(next.round, 1);
  assert.equal(next.implementationJobId, DEV_R1);
});

test('ACCEPTED sends the Goal to closure, not to another round', () => {
  const ledger = buildStageLedger([
    withResult(devJob(DEV_R1, 1), { status: 'REVIEW_REQUIRED' }),
    withResult(revJob(REV_R1, 1), { decision: 'ACCEPTED', blockers: [] }),
  ]);
  const next = decideNextDispatch({ ledger, goal: GOAL });
  assert.equal(next.kind, DISPATCH_KINDS.CLOSE_GOAL);
  assert.equal(next.decision, 'ACCEPTED');
});

test('nothing on disk: the Goal starts at implementation round 1', () => {
  const next = decideNextDispatch({ ledger: buildStageLedger([]), goal: GOAL });
  assert.equal(next.kind, DISPATCH_KINDS.IMPLEMENTATION);
  assert.equal(next.round, 1);
});

// --- Closure and planning are not the round's review ------------------------
//
// After Goal006 closed, `ia-loop:status` reported a permanent
// AGENT_CONTRACT_ERROR for a Goal that had been ACCEPTED, closed and whose
// next Goal was already written. stageOfJob read `job.kind === 'CLOSURE_DOCS' |
// 'PLANNING'` — a field and two values no publisher ever wrote — so both
// Tech Lead jobs claimed the round's REVIEW stage key, and the PLANNING job's
// `decision: "NEXT_GOAL"` was read as the review's answer.

const closureJob = (jobId, round) => ({
  role: 'tech_lead',
  job: { jobId, role: 'tech_lead', goal: GOAL, round, type: 'CLOSURE_DOCUMENTATION' },
});
const planningJob = (jobId, round) => ({
  role: 'tech_lead',
  job: { jobId, role: 'tech_lead', goal: GOAL, round, type: 'NEXT_GOAL_PLANNING' },
});

test('closure and planning jobs have no stage: they are not the round review', () => {
  assert.equal(stageKeyOfJob(closureJob('004-r1-tech_lead-aaa', 1).job), null);
  assert.equal(stageKeyOfJob(planningJob('004-r1-tech_lead-bbb', 1).job), null);
  // The real review still resolves, and to the review stage.
  assert.equal(stageKeyOfJob(revJob(REV_R1, 1).job), stageKey({ goal: GOAL, round: 1, stage: STAGES.REVIEW }));
});

test('a closed Goal whose planning already ran still reads as ACCEPTED, not as a contract error', () => {
  // Ordered exactly as a directory listing hands them over: the planning job's
  // id sorts first, which is precisely how it won the review slot.
  const ledger = buildStageLedger([
    withResult(planningJob('004-r1-tech_lead-3f7879f7', 1), { decision: 'NEXT_GOAL', nextGoalId: '005' }),
    withResult(closureJob('004-r1-tech_lead-6389eed2', 1), { documentsUpdated: ['docs/migration/x.md'] }),
    withResult(devJob(DEV_R1, 1), { status: 'REVIEW_REQUIRED' }),
    withResult(revJob(REV_R1, 1), { decision: 'ACCEPTED', blockers: [] }),
  ]);

  // Only ONE review stage exists, and it is the real review.
  const review = ledger.get(stageKey({ goal: GOAL, round: 1, stage: STAGES.REVIEW }));
  assert.equal(review.completedBy, REV_R1);
  assert.equal(review.result.decision, 'ACCEPTED');
  assert.deepEqual(review.duplicates, []);

  const next = decideNextDispatch({ ledger, goal: GOAL });
  assert.equal(next.kind, DISPATCH_KINDS.CLOSE_GOAL);
  assert.notEqual(next.reason, 'AGENT_CONTRACT_ERROR');
});

test('a review with no usable decision asks for a human instead of guessing', () => {
  const ledger = buildStageLedger([
    withResult(devJob(DEV_R1, 1), { status: 'REVIEW_REQUIRED' }),
    withResult(revJob(REV_R1, 1), { decision: 'MAYBE' }),
  ]);
  const next = decideNextDispatch({ ledger, goal: GOAL });
  assert.equal(next.kind, DISPATCH_KINDS.HUMAN_REQUIRED);
  assert.equal(next.reason, 'AGENT_CONTRACT_ERROR');
});

test('the round budget is respected without re-running anything', () => {
  const entries = [
    withResult(devJob(DEV_R1, 1), { status: 'REVIEW_REQUIRED' }),
    withResult(revJob(REV_R1, 1), { decision: 'CHANGES_REQUIRED', blockers: BLOCKERS }),
    withResult(devJob('004-r2-correction-x', 2, 'CORRECTION'), { status: 'REVIEW_REQUIRED' }),
    withResult(revJob('004-r2-tech_lead-y', 2), { decision: 'CHANGES_REQUIRED', blockers: BLOCKERS }),
    withResult(devJob('004-r3-correction-z', 3, 'CORRECTION'), { status: 'REVIEW_REQUIRED' }),
    withResult(revJob('004-r3-tech_lead-w', 3), { decision: 'CHANGES_REQUIRED', blockers: BLOCKERS }),
  ];
  const next = decideNextDispatch({ ledger: buildStageLedger(entries), goal: GOAL, maxRounds: 3 });
  assert.equal(next.kind, DISPATCH_KINDS.HUMAN_REQUIRED);
  assert.equal(next.reason, 'MAX_CORRECTION_ROUNDS_REACHED');
});

// ===========================================================================
// 15, 16. A genuinely interrupted stage may retry
// ===========================================================================

test('15/16. an interrupted stage with no result retries as a NEW attempt of the SAME stage', () => {
  const ledger = buildStageLedger([
    { ...devJob(DEV_R1, 1), status: 'INTERRUPTED', result: null },
  ]);
  const stage = ledger.get('004:r1:implementation');
  assert.notEqual(stage.status, STAGE_STATUS.COMPLETED, 'nothing was learned, so nothing is finished');

  // Dispatch is allowed, and it is the same logical stage.
  const next = decideNextDispatch({ ledger, goal: GOAL });
  assert.equal(next.kind, DISPATCH_KINDS.IMPLEMENTATION);
  assert.equal(next.stageKey, '004:r1:implementation', 'the same stage, a later attempt');
  assert.equal(assertNoDuplicateStageDispatch({
    ledger, goal: GOAL, round: 1, stage: STAGES.IMPLEMENTATION, jobId: 'attempt-2',
  }), true);
});

test('an attempt left in flight is offered back rather than replaced', () => {
  const ledger = buildStageLedger([
    { ...devJob(DEV_R1, 1), status: 'RUNNING', result: null },
  ]);
  const next = decideNextDispatch({ ledger, goal: GOAL });
  assert.equal(next.resumeAttempt, DEV_R1);
});

// ===========================================================================
// 13, 14. The two layers are independent
// ===========================================================================

test('13. with no handoff at all, the persisted results still block a duplicate', async () => {
  await withDir(async (dir) => {
    const handoffs = createHandoffStore(dir);
    assert.equal(await handoffs.read(), null, 'no handoff on disk');

    // The guard does not consult the handoff, by design.
    const ledger = buildStageLedger(goal004Entries());
    assert.throws(() => assertNoDuplicateStageDispatch({
      ledger, goal: GOAL, round: 1, stage: STAGES.IMPLEMENTATION, jobId: 'fresh',
    }), codeIs('DUPLICATE_COMPLETED_STAGE_DISPATCH'));
  });
});

test('14. a corrupt or foreign handoff fails closed and changes no dispatch decision', async () => {
  await withDir(async (dir) => {
    const handoffs = createHandoffStore(dir);
    await handoffs.write({
      autonomousRunId: 'auto-somebody-else', recoveryAttempt: 1,
      recoveredFromState: LOOP_STATES.DEVELOPER_RUNNING,
      nextSafeAction: RECOVERY_ACTIONS.REQUEUE_JOB, jobId: 'whatever',
    });

    const check = await handoffs.validateFor('auto-7b32c56a');
    assert.equal(check.valid, false);
    assert.equal(check.reason, 'HANDOFF_FOR_ANOTHER_RUN');

    // And the ledger still refuses the duplicate regardless of what it said.
    const ledger = buildStageLedger(goal004Entries());
    assert.throws(() => assertNoDuplicateStageDispatch({
      ledger, goal: GOAL, round: 1, stage: STAGES.IMPLEMENTATION, jobId: 'fresh',
    }), codeIs('DUPLICATE_COMPLETED_STAGE_DISPATCH'));
  });
});

// ===========================================================================
// 3, 4. THE INTEGRATION: reboot, recover, attach — and no duplicate
// ===========================================================================

test('THE INTEGRATION: R1 done and reviewed, reboot, recover, attach — next is correction R2', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    const auto = createAutonomousStore(dir);
    const handoffs = createHandoffStore(dir);

    // --- R1 ran and was reviewed, exactly as it really happened ------------
    await store.publishJob('developer', {
      protocolVersion: PROTOCOL_VERSION_V2, jobId: DEV_R1, role: 'developer',
      goal: GOAL, round: 1, type: 'IMPLEMENTATION',
    });
    await store.publishResult('developer', DEV_R1, {
      ok: true,
      result: {
        protocolVersion: PROTOCOL_VERSION_V2, jobId: DEV_R1, goal: GOAL, round: 1,
        status: 'REVIEW_REQUIRED', summary: 'transporte durável', implementationReport: 'R1',
      },
    }, { attemptId: (await store.readAttemptState('developer', DEV_R1))?.attemptId });
    await store.setJobStatus('developer', DEV_R1, 'COMPLETED');

    await store.publishJob('tech_lead', {
      protocolVersion: PROTOCOL_VERSION_V2, jobId: REV_R1, role: 'tech_lead', goal: GOAL, round: 1,
    });
    await store.publishResult('tech_lead', REV_R1, {
      ok: true,
      result: {
        protocolVersion: PROTOCOL_VERSION_V2, jobId: REV_R1, goal: GOAL, round: 1,
        decision: 'CHANGES_REQUIRED', blockers: BLOCKERS, summary: 'quatro blockers',
      },
    }, { attemptId: (await store.readAttemptState('tech_lead', REV_R1))?.attemptId });
    await store.setJobStatus('tech_lead', REV_R1, 'COMPLETED');

    const run = await auto.start({ fromGoal: GOAL, migrationAcceptedBaseline: BASELINE });
    await store.writeRuntime({
      mode: 'REAL_EXECUTION', goal: GOAL, round: 1, state: LOOP_STATES.REVIEWER_RUNNING,
      currentJobId: REV_R1, executionBase: EXECUTION_BASE, worktreeInitialHead: EXECUTION_BASE,
      migrationAcceptedBaseline: BASELINE,
    });

    // --- the machine reboots ------------------------------------------------
    await auto.releaseLoopLease();

    // --- recovery: what does it conclude? -----------------------------------
    const beforeRecovery = await reconcileExecutionState({ store, goal: GOAL });
    const reviewStage = beforeRecovery.ledger.get('004:r1:review');
    assert.equal(reviewStage.status, STAGE_STATUS.COMPLETED);

    const plan = planRecovery({
      runtime: await store.readRuntime(),
      autonomousRun: await auto.read(),
      ownerVerdict: { status: OWNER_STATUS.ORPHAN_CONFIRMED, proof: 'DIFFERENT_BOOT', detail: 'rebooted' },
      leaseExists: false,
      resultExists: reviewStage.status === STAGE_STATUS.COMPLETED,
      // Resolved from the ledger, exactly like resolveRecoveryJob does — never
      // from runtime.currentJobId, which planRecovery no longer falls back to.
      jobId: reviewStage.completedBy,
    });
    assert.equal(plan.action, RECOVERY_ACTIONS.CONSUME_RESULT);

    await handoffs.write({
      autonomousRunId: run.autonomousRunId, recoveryAttempt: 1,
      recoveredFromState: LOOP_STATES.REVIEWER_RUNNING,
      nextSafeAction: plan.action, jobId: REV_R1, agent: 'tech_lead', goal: GOAL, round: 1,
    });

    // --- attach: same run, no new one --------------------------------------
    const attached = await auto.attach();
    assert.equal(attached.attached, true);
    assert.equal(attached.run.autonomousRunId, run.autonomousRunId);
    const check = await handoffs.validateFor(attached.run.autonomousRunId);
    assert.equal(check.valid, true);
    await handoffs.consume({ nonce: check.handoff.nonce, consumedBy: 'orchestrator' });

    // --- and now the assertions that matter ---------------------------------
    const reconciled = await reconcileExecutionState({ store, goal: GOAL });

    assert.equal(reconciled.next.kind, DISPATCH_KINDS.CORRECTION);
    assert.equal(reconciled.next.round, 2, 'correction R2 is next');
    assert.equal(reconciled.next.blockers.length, 4);
    assert.deepEqual(reconciled.next.blockers, BLOCKERS);

    // No R1 developer publish.
    assert.throws(() => assertNoDuplicateStageDispatch({
      ledger: reconciled.ledger, goal: GOAL, round: 1, stage: STAGES.IMPLEMENTATION, jobId: 'would-be-new',
    }), codeIs('DUPLICATE_COMPLETED_STAGE_DISPATCH'));

    // No R1 reviewer publish.
    assert.throws(() => assertNoDuplicateStageDispatch({
      ledger: reconciled.ledger, goal: GOAL, round: 1, stage: STAGES.REVIEW, jobId: 'would-be-new',
    }), codeIs('DUPLICATE_COMPLETED_STAGE_DISPATCH'));

    // Nothing new was published to either worker by any of this.
    const ids = async (role) => (await store.listJobs(role)).map((n) => n.replace(/\.json$/, '')).sort();
    assert.deepEqual(await ids('developer'), [DEV_R1]);
    assert.deepEqual(await ids('tech_lead'), [REV_R1]);
  });
});

test('the same integration with the duplicate already published classifies it', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);

    for (const [role, jobId, extra] of [
      ['developer', DEV_R1, { type: 'IMPLEMENTATION' }],
      ['tech_lead', REV_R1, {}],
      ['developer', DUPE_R1, { type: 'IMPLEMENTATION' }],
    ]) {
      await store.publishJob(role, {
        protocolVersion: PROTOCOL_VERSION_V2, jobId, role, goal: GOAL, round: 1, ...extra,
      });
    }
    await store.publishResult('developer', DEV_R1, {
      ok: true,
      result: {
        protocolVersion: PROTOCOL_VERSION_V2, jobId: DEV_R1, goal: GOAL, round: 1,
        status: 'REVIEW_REQUIRED', summary: 's',
      },
    }, { attemptId: (await store.readAttemptState('developer', DEV_R1))?.attemptId });
    await store.setJobStatus('developer', DEV_R1, 'COMPLETED');
    await store.publishResult('tech_lead', REV_R1, {
      ok: true,
      result: {
        protocolVersion: PROTOCOL_VERSION_V2, jobId: REV_R1, goal: GOAL, round: 1,
        decision: 'CHANGES_REQUIRED', blockers: BLOCKERS, summary: 's',
      },
    }, { attemptId: (await store.readAttemptState('tech_lead', REV_R1))?.attemptId });
    await store.setJobStatus('tech_lead', REV_R1, 'COMPLETED');
    await store.setJobStatus('developer', DUPE_R1, 'RUNNING');

    const reconciled = await reconcileExecutionState({ store, goal: GOAL });

    assert.deepEqual(reconciled.duplicates, [
      { jobId: DUPE_R1, stageKey: '004:r1:implementation', completedBy: DEV_R1 },
    ]);
    assert.equal(reconciled.next.kind, DISPATCH_KINDS.CORRECTION);
    assert.equal(reconciled.next.round, 2);
  });
});

test('THE FULL INTEGRATION: a stale R2 review, filed over R1\'s result, reaches the supersede queue '
  + 'through reconcileExecutionState itself — the same pipeline run-goal.mjs already consumes', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    const DEV_R1_G = '010-r1-developer-real0001';
    const REV_R1_G = '010-r1-tech_lead-real0001';
    const STALE_REV_R2_G = '010-r2-tech_lead-stale001';
    const DEV_R2_G = '010-r2-correction-real0001';

    // R1: implemented (BLOCKED, same terminal status as the real incident)
    // and genuinely reviewed (CHANGES_REQUIRED).
    await store.publishJob('developer', {
      protocolVersion: PROTOCOL_VERSION_V2, jobId: DEV_R1_G, role: 'developer',
      goal: GOAL_010, round: 1, type: 'IMPLEMENTATION',
    });
    await store.publishResult('developer', DEV_R1_G, {
      ok: true,
      result: { protocolVersion: PROTOCOL_VERSION_V2, jobId: DEV_R1_G, goal: GOAL_010, round: 1, status: 'BLOCKED', summary: 's' },
    }, { attemptId: (await store.readAttemptState('developer', DEV_R1_G))?.attemptId });
    await store.setJobStatus('developer', DEV_R1_G, 'COMPLETED');

    await store.publishJob('tech_lead', {
      protocolVersion: PROTOCOL_VERSION_V2, jobId: REV_R1_G, role: 'tech_lead',
      goal: GOAL_010, round: 1, developerJobId: DEV_R1_G,
    });
    await store.publishResult('tech_lead', REV_R1_G, {
      ok: true,
      result: {
        protocolVersion: PROTOCOL_VERSION_V2, jobId: REV_R1_G, goal: GOAL_010, round: 1,
        decision: 'CHANGES_REQUIRED', blockers: GOAL010_BLOCKERS, summary: 's',
      },
    }, { attemptId: (await store.readAttemptState('tech_lead', REV_R1_G))?.attemptId });
    await store.setJobStatus('tech_lead', REV_R1_G, 'COMPLETED');

    // A stale R2 review: completed, filed under round 2, `developerJobId`
    // still naming R1's own job — the exact shape the incident left behind.
    await store.publishJob('tech_lead', {
      protocolVersion: PROTOCOL_VERSION_V2, jobId: STALE_REV_R2_G, role: 'tech_lead',
      goal: GOAL_010, round: 2, developerJobId: DEV_R1_G,
    });
    await store.publishResult('tech_lead', STALE_REV_R2_G, {
      ok: true,
      result: {
        protocolVersion: PROTOCOL_VERSION_V2, jobId: STALE_REV_R2_G, goal: GOAL_010, round: 2,
        decision: 'CHANGES_REQUIRED', blockers: GOAL010_BLOCKERS, summary: 's',
      },
    }, { attemptId: (await store.readAttemptState('tech_lead', STALE_REV_R2_G))?.attemptId });
    await store.setJobStatus('tech_lead', STALE_REV_R2_G, 'COMPLETED');

    // Before the genuine R2 correction exists: reconciliation still says
    // CORRECTION is next, exactly as if the stale review were not there.
    const beforeCorrection = await reconcileExecutionState({ store, goal: GOAL_010 });
    assert.equal(beforeCorrection.next.kind, DISPATCH_KINDS.CORRECTION);
    assert.equal(beforeCorrection.next.round, 2);

    // Now a genuine R2 correction runs and completes, under its own job id.
    await store.publishJob('developer', {
      protocolVersion: PROTOCOL_VERSION_V2, jobId: DEV_R2_G, role: 'developer',
      goal: GOAL_010, round: 2, type: 'CORRECTION',
    });
    await store.publishResult('developer', DEV_R2_G, {
      ok: true,
      result: { protocolVersion: PROTOCOL_VERSION_V2, jobId: DEV_R2_G, goal: GOAL_010, round: 2, status: 'REVIEW_REQUIRED', summary: 's' },
    }, { attemptId: (await store.readAttemptState('developer', DEV_R2_G))?.attemptId });
    await store.setJobStatus('developer', DEV_R2_G, 'COMPLETED');

    const after = await reconcileExecutionState({ store, goal: GOAL_010 });

    // The stale review does not satisfy R2: a fresh review is what's next,
    // pointed at the genuine result.
    assert.equal(after.next.kind, DISPATCH_KINDS.REVIEW);
    assert.equal(after.next.round, 2);
    assert.equal(after.next.implementationJobId, DEV_R2_G);

    // And it is queued for the caller to supersede through the exact
    // pipeline run-goal.mjs's own duplicate-superseding loop already reads.
    assert.deepEqual(after.duplicates, [
      { jobId: STALE_REV_R2_G, stageKey: '010:r2:review', completedBy: DEV_R2_G },
    ]);
  });
});

// ===========================================================================
// resolveStageJobId — the SECOND incident: a raw runtime.jobIdsByRound hint
// resurrecting a job the ledger had already moved past. Not a caching bug
// this time (that was fixed already) — a genuinely separate fallback that
// read the same wrong, historical, once-buggy-written field directly.
//
// The fix removed that fallback entirely, so these tests do not simulate a
// `runtime` object at all: `resolveStageJobId`'s signature does not accept
// one, which is itself the proof there is no channel left for a stale hint
// to reach the answer through.
// ===========================================================================

test('12-step reproduction: R2 correction resolves to NEW_JOB_REQUIRED, never round 1\'s BLOCKED result', () => {
  // 1. R1 Developer BLOCKED.
  // 2. R1 review CHANGES_REQUIRED.
  // 3-6. What a corrupted runtime.json.jobIdsByRound would have claimed for
  // rounds 2 and 3 (R1's own developer job; the two SUPERSEDED reviews) is
  // deliberately NOT represented anywhere below — there is no `runtime`
  // parameter for it to occupy.
  const ledger = buildStageLedger([
    withResult(devJob010(DEV_R1_010, 1), { status: 'BLOCKED', jobId: DEV_R1_010 }),
    withResult(revJob010(REV_R1_010, 1, DEV_R1_010), { decision: 'CHANGES_REQUIRED', blockers: GOAL010_BLOCKERS, jobId: REV_R1_010 }),
    // The two SUPERSEDED reviews genuinely exist on disk (as they do for the
    // real Goal010), filed under rounds 2 and 3 — SUPERSEDED status means
    // buildStageLedger already refuses to let them complete anything.
    { ...revJob010('010-r2-tech_lead-stale0001', 2, DEV_R1_010), status: 'SUPERSEDED', result: { decision: 'CHANGES_REQUIRED', blockers: GOAL010_BLOCKERS } },
    { ...revJob010('010-r3-tech_lead-stale0002', 3, DEV_R1_010), status: 'SUPERSEDED', result: { decision: 'CHANGES_REQUIRED', blockers: GOAL010_BLOCKERS } },
  ], { goal: GOAL_010 });

  // 7. Reconciliation returns CORRECTION, round 2.
  const next = decideNextDispatch({ ledger, goal: GOAL_010 });
  assert.equal(next.kind, DISPATCH_KINDS.CORRECTION);
  assert.equal(next.round, 2);
  assert.deepEqual(next.blockers, GOAL010_BLOCKERS);
  assert.equal(next.fromReviewJobId, REV_R1_010);

  // 8-9. Resolving R2's developer/correction stage: NEW_JOB_REQUIRED. Round
  // 1's job is never offered back, at either tier.
  const devResolved = resolveStageJobId({ ledger, goal: GOAL_010, round: 2, stage: STAGES.CORRECTION });
  assert.equal(devResolved.source, STAGE_JOB_SOURCE.NEW_JOB_REQUIRED);
  assert.equal(devResolved.jobId, null);
  assert.notEqual(devResolved.jobId, DEV_R1_010);

  // 10. Resolving R2's review stage: also NEW_JOB_REQUIRED — the SUPERSEDED
  // review is not offered back either, at either tier.
  const revResolved = resolveStageJobId({ ledger, goal: GOAL_010, round: 2, stage: STAGES.REVIEW });
  assert.equal(revResolved.source, STAGE_JOB_SOURCE.NEW_JOB_REQUIRED);
  assert.equal(revResolved.jobId, null);
  assert.notEqual(revResolved.jobId, '010-r2-tech_lead-stale0001');

  // Same for round 3 — it must never be reachable anyway once round 2 is
  // genuinely pending, but confirm it independently.
  const rev3Resolved = resolveStageJobId({ ledger, goal: GOAL_010, round: 3, stage: STAGES.REVIEW });
  assert.equal(rev3Resolved.source, STAGE_JOB_SOURCE.NEW_JOB_REQUIRED);
  assert.notEqual(rev3Resolved.jobId, '010-r3-tech_lead-stale0002');
});

test('11-12. once a genuine R2 DeveloperResult exists, review resolves to NEW_JOB_REQUIRED with the new job as its provenance target', () => {
  const DEV_R2_010_NEW = '010-r2-correction-genuine2';
  const ledger = buildStageLedger([
    withResult(devJob010(DEV_R1_010, 1), { status: 'BLOCKED', jobId: DEV_R1_010 }),
    withResult(revJob010(REV_R1_010, 1, DEV_R1_010), { decision: 'CHANGES_REQUIRED', blockers: GOAL010_BLOCKERS, jobId: REV_R1_010 }),
    { ...revJob010('010-r2-tech_lead-stale0001', 2, DEV_R1_010), status: 'SUPERSEDED', result: { decision: 'CHANGES_REQUIRED', blockers: GOAL010_BLOCKERS } },
    withResult(devJob010(DEV_R2_010_NEW, 2, 'CORRECTION'), { status: 'REVIEW_REQUIRED', jobId: DEV_R2_010_NEW }),
  ], { goal: GOAL_010 });

  // The correction is satisfied now — resolving it returns the genuine job.
  const devResolved = resolveStageJobId({ ledger, goal: GOAL_010, round: 2, stage: STAGES.CORRECTION });
  assert.equal(devResolved.source, STAGE_JOB_SOURCE.COMPLETED);
  assert.equal(devResolved.jobId, DEV_R2_010_NEW);

  // The review is still owed — a NEW one, never the superseded one.
  const revResolved = resolveStageJobId({ ledger, goal: GOAL_010, round: 2, stage: STAGES.REVIEW });
  assert.equal(revResolved.source, STAGE_JOB_SOURCE.NEW_JOB_REQUIRED);

  // And whatever review eventually gets published must name DEV_R2_010_NEW as
  // its developerJobId to ever satisfy this stage (isReviewStale enforces it).
  const implementation = ledger.get('010:r2:correction');
  assert.equal(implementation.completedBy, DEV_R2_010_NEW);
});

// ===========================================================================
// resolveStageJobId — legitimate crash recovery must keep working
// ===========================================================================

test('an interrupted attempt of the SAME stage is resumed, not replaced with a fresh mint', () => {
  const INTERRUPTED = '010-r2-correction-crashed01';
  const ledger = buildStageLedger([
    withResult(devJob010(DEV_R1_010, 1), { status: 'BLOCKED', jobId: DEV_R1_010 }),
    withResult(revJob010(REV_R1_010, 1, DEV_R1_010), { decision: 'CHANGES_REQUIRED', blockers: GOAL010_BLOCKERS, jobId: REV_R1_010 }),
    { ...devJob010(INTERRUPTED, 2, 'CORRECTION'), status: 'INTERRUPTED', attemptStatus: 'INTERRUPTED', result: null },
  ], { goal: GOAL_010 });

  const resolved = resolveStageJobId({ ledger, goal: GOAL_010, round: 2, stage: STAGES.CORRECTION });
  assert.equal(resolved.source, STAGE_JOB_SOURCE.RESUMED_ATTEMPT, 'the crashed attempt is resumed, not orphaned');
  assert.equal(resolved.jobId, INTERRUPTED);
});

test('a review still QUEUED when the process died is resumed under the same job id', () => {
  const QUEUED_REVIEW = '010-r1-tech_lead-inflight1';
  const ledger = buildStageLedger([
    withResult(devJob010(DEV_R1_010, 1), { status: 'REVIEW_REQUIRED', jobId: DEV_R1_010 }),
    { ...revJob010(QUEUED_REVIEW, 1, DEV_R1_010), status: 'QUEUED', attemptStatus: 'QUEUED', result: null },
  ], { goal: GOAL_010 });

  const resolved = resolveStageJobId({ ledger, goal: GOAL_010, round: 1, stage: STAGES.REVIEW });
  assert.equal(resolved.source, STAGE_JOB_SOURCE.RESUMED_ATTEMPT);
  assert.equal(resolved.jobId, QUEUED_REVIEW);
});

test('a review parked WAITING_FOR_CAPACITY is resumed too, not re-published under a new id', () => {
  // The exact shape a genuine capacity wait leaves: no result yet, and the
  // one thing that must never happen is paying for the packet twice.
  const CAPACITY_WAIT = '010-r1-tech_lead-capacitywait';
  const ledger = buildStageLedger([
    withResult(devJob010(DEV_R1_010, 1), { status: 'REVIEW_REQUIRED', jobId: DEV_R1_010 }),
    { ...revJob010(CAPACITY_WAIT, 1, DEV_R1_010), status: 'WAITING_FOR_CAPACITY', attemptStatus: 'WAITING_FOR_CAPACITY', result: null },
  ], { goal: GOAL_010 });

  const resolved = resolveStageJobId({ ledger, goal: GOAL_010, round: 1, stage: STAGES.REVIEW });
  assert.equal(resolved.source, STAGE_JOB_SOURCE.RESUMED_ATTEMPT);
  assert.equal(resolved.jobId, CAPACITY_WAIT);
});

test('nothing at all on disk for a stage resolves to NEW_JOB_REQUIRED, exactly like a fresh Goal', () => {
  const resolved = resolveStageJobId({ ledger: buildStageLedger([], { goal: GOAL_010 }), goal: GOAL_010, round: 1, stage: STAGES.IMPLEMENTATION });
  assert.equal(resolved.source, STAGE_JOB_SOURCE.NEW_JOB_REQUIRED);
  assert.equal(resolved.jobId, null);
});

// ===========================================================================
// 17–25. Everything that must keep holding
// ===========================================================================

test('18/19/20. reconciliation touches no base and no checkpoint', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    await store.writeRuntime({
      mode: 'REAL_EXECUTION', goal: GOAL, round: 1, state: LOOP_STATES.REVIEWER_RUNNING,
      executionBase: EXECUTION_BASE, worktreeInitialHead: EXECUTION_BASE,
      migrationAcceptedBaseline: BASELINE,
      mainGuardCheckpoint: { head: 'd03580a', reason: 'ORCHESTRATOR_ATTACH' },
    });

    await reconcileExecutionState({ store, goal: GOAL });

    const runtime = await store.readRuntime();
    assert.equal(runtime.executionBase, EXECUTION_BASE);
    assert.equal(runtime.worktreeInitialHead, EXECUTION_BASE);
    assert.equal(runtime.migrationAcceptedBaseline, BASELINE);
    assert.notEqual(runtime.mainGuardCheckpoint.head, runtime.executionBase);
  });
});

test('the runner never assigns the main checkpoint as an execution base', async () => {
  const source = await readFile(new URL('../run-goal.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /executionBase\s*[:=]\s*mainGuardCheckpoint/);
  assert.doesNotMatch(source, /executionBase\s*[:=]\s*mainHead/);
});

test('21/22/23. the gates recovery never opened are still shut', () => {
  const base = {
    mode: 'REAL_EXECUTION', goal: GOAL, round: 1, currentJobId: REV_R1,
    executionBase: EXECUTION_BASE, worktreeInitialHead: EXECUTION_BASE,
  };
  assert.equal(planRecovery({ runtime: { ...base, state: LOOP_STATES.HUMAN_REQUIRED } }).reason, 'HUMAN_REQUIRED');
  assert.equal(planRecovery({
    runtime: { ...base, state: LOOP_STATES.REVIEWER_RUNNING },
    autonomousRun: { autonomousRunId: 'auto-1', status: 'PAUSED_FOR_HUMAN' },
  }).reason, 'HUMAN_REQUIRED');
  assert.equal(planRecovery({ runtime: { ...base, state: LOOP_STATES.WAITING_FOR_CAPACITY } }).reason, 'CAPACITY_WAIT');
});

test('24. graceful shutdown gives back only the orchestrator lease, never another', async () => {
  const source = await readFile(new URL('../run-auto.mjs', import.meta.url), 'utf8');

  // Ctrl+C left the loop lease behind, because the finally block never runs on
  // a signal — which is how migration-loop-a3 became an orphan.
  assert.match(source, /process\.on\('SIGINT'/);
  assert.match(source, /process\.on\('SIGTERM'/);
  assert.doesNotMatch(source, /releaseLoopLease\(\{\s*force:\s*true/);
  // Job and worktree leases belong to work that may still be writing.
  assert.doesNotMatch(source, /releaseWorktree|releaseJob\(/);
});

test('25. nothing in the reconciliation path can reach a model', async () => {
  for (const file of ['../lib/reconcile.mjs', '../lib/stage-identity.mjs']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /runAgent|spawnClaude|--model|claude-opus|claude-fable|claude-sonnet|claude-haiku/,
      `${file} must not be able to invoke a model`);
  }
});

// ===========================================================================
// The invariant, stated once and checked against every route into a dispatch
// ===========================================================================

test('INVARIANT: a completed stage is never dispatched again, by any route', () => {
  const ledger = buildStageLedger(goal004Entries());

  // Each of these is a real path that has, at some point, produced a job id.
  const routes = {
    'a fresh random id': '004-r1-developer-ffffffff',
    'the duplicate that was actually published': DUPE_R1,
    'an id from a stale runtime pointer': '004-r1-tech_lead-4ded365b',
    'no id at all': null,
    'an id from a capacity resume': '004-r1-developer-capacity',
  };

  for (const [route, jobId] of Object.entries(routes)) {
    assert.throws(
      () => assertNoDuplicateStageDispatch({
        ledger, goal: GOAL, round: 1, stage: STAGES.IMPLEMENTATION, jobId,
      }),
      codeIs('DUPLICATE_COMPLETED_STAGE_DISPATCH'),
      `${route} must not reach a completed stage`,
    );
  }

  // The one exception, and only this one: the attempt that produced the result.
  assert.equal(assertNoDuplicateStageDispatch({
    ledger, goal: GOAL, round: 1, stage: STAGES.IMPLEMENTATION, jobId: DEV_R1,
  }), true);
});

test('7b. the recovery plan never falls back to the runtime pointer', () => {
  // planRecovery used to read runtime.currentJobId itself when the caller gave
  // no reconciled jobId, so a stale pointer — here, the duplicate attempt that
  // should never have been dispatched — was still treated as the attempt that
  // owns the stage. It no longer reads runtime.currentJobId at all: without a
  // reconciled answer, recovery admits it does not know rather than guessing
  // from the hint (see resolveRecoveryJob in lib/recovery-plan.mjs, which is
  // what a real caller uses to produce that answer).
  const runtime = {
    mode: 'REAL_EXECUTION', goal: GOAL, round: 1, state: LOOP_STATES.DEVELOPER_RUNNING,
    currentJobId: DUPE_R1, executionBase: EXECUTION_BASE, worktreeInitialHead: EXECUTION_BASE,
  };

  const withoutReconciliation = planRecovery({ runtime, resultExists: true, leaseExists: false });
  assert.equal(withoutReconciliation.action, RECOVERY_ACTIONS.BLOCKED);
  assert.equal(withoutReconciliation.reason, 'STATE_INCONSISTENT');
  assert.doesNotMatch(withoutReconciliation.message ?? '', new RegExp(DUPE_R1),
    'the stale pointer must never surface as the answer');

  const reconciledPlan = planRecovery({ runtime, resultExists: true, leaseExists: false, jobId: DEV_R1 });
  assert.equal(reconciledPlan.action, RECOVERY_ACTIONS.CONSUME_RESULT);
  assert.equal(reconciledPlan.jobId, DEV_R1, 'the attempt that actually produced the result');
  assert.match(reconciledPlan.message, new RegExp(DEV_R1));
});

test('recovery itself supersedes a duplicate attempt, and never deletes it', async () => {
  const source = await readFile(new URL('../run-recover.mjs', import.meta.url), 'utf8');
  assert.match(source, /reconciled\?\.duplicates/, 'recovery acts on the duplicates it found');
  assert.match(source, /setJobStatus\(role, duplicate\.jobId, 'SUPERSEDED'\)/);
  assert.match(source, /DUPLICATE_STAGE_ATTEMPT_SUPERSEDED/, 'and records it in the audit log');
  assert.doesNotMatch(source, /rm\(|unlink\(/, 'history is never deleted to tidy up');
});

test('the lease sweep is driven by the leases, not by the duplicate list', async () => {
  // Keyed on duplicates it could only fire once: after the first run the job is
  // SUPERSEDED, stops being reported as a duplicate, and the lease it failed to
  // release stays on disk for good.
  const source = await readFile(new URL('../run-recover.mjs', import.meta.url), 'utf8');
  assert.match(source, /for \(const held of \(await leaseStore\.listJobLeases\(\)\)/);
  assert.match(source, /if \(isClaimableJobStatus\(status\)\) continue;/,
    'a job that could still legitimately run keeps its lease');
  assert.match(source, /if \(!isRecoveryEligible\(heldVerdict\)\)/,
    'and so does one whose holder is not proven gone');
  assert.match(source, /retireWorktree/, 'the worktree lease goes with it');
});

test('recovery repairs consistency on every run, not only the first', async () => {
  // Superseding a duplicate and retiring a dead attempt's leases sat behind the
  // "already recovered" early return, so the re-run someone makes when
  // something is still stuck skipped exactly the repair it needed.
  const source = await readFile(new URL('../run-recover.mjs', import.meta.url), 'utf8');
  const repairs = source.indexOf('Attempts that should never have existed');
  const alreadyRecovered = source.indexOf('Already recovered and waiting');
  assert.ok(repairs > 0 && alreadyRecovered > 0);
  assert.ok(repairs < alreadyRecovered, 'repairs must run before the idempotent return');
  assert.match(source.slice(0, repairs), /if \(dryRun\)|if \(!dryRun\)/, 'and still write nothing on a dry run');
});

// ===========================================================================
// Only a review claims a round's review stage
// ===========================================================================

test('no Tech Lead job type other than a review claims the round review stage', async () => {
  // This failed twice, three years of commits apart, for the same reason: the
  // guard was keyed to a LIST named after one of its members instead of to the
  // question. After Goal006 it was CLOSURE_DOCS/PLANNING; in Goal025 round 3 it
  // was CRITERIA_COVERAGE, which won the stage over the real review and made
  // `reconcile` report "the review of round 3 carries no usable decision".
  const { TECH_LEAD_NON_REVIEW_JOB_TYPES } = await import('../lib/closure-contracts.mjs');
  const { stageOfJob } = await import('../lib/stage-identity.mjs');

  for (const type of TECH_LEAD_NON_REVIEW_JOB_TYPES) {
    assert.equal(
      stageOfJob({ role: 'tech_lead', goal: '025', round: 3, type }),
      null,
      `${type} must not claim the round's review stage`,
    );
  }
});

test('every kind the Tech Lead worker handles besides a review is excluded from the review stage', async () => {
  // The worker's handler table and the stage guard must name the same set.
  // Registering a kind in one and not the other is exactly how Goal025 broke.
  const { TECH_LEAD_NON_REVIEW_JOB_TYPES } = await import('../lib/closure-contracts.mjs');

  assert.ok(TECH_LEAD_NON_REVIEW_JOB_TYPES.includes('CRITERIA_COVERAGE'));
  assert.ok(TECH_LEAD_NON_REVIEW_JOB_TYPES.includes('CLOSURE_DOCUMENTATION'));
  assert.ok(TECH_LEAD_NON_REVIEW_JOB_TYPES.includes('NEXT_GOAL_PLANNING'));
});

test('a review still claims its stage, so the guard did not swallow everything', async () => {
  const { stageOfJob } = await import('../lib/stage-identity.mjs');
  const stage = stageOfJob({ role: 'tech_lead', goal: '025', round: 3, type: undefined });

  assert.equal(stage?.stage, 'review');
  assert.equal(stage?.round, 3);
});
