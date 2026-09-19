#!/usr/bin/env node
/**
 * IA Loop — orchestrator entry point.
 *
 *   npm run ia-loop:goal -- 003 --dry-run   plan only, no side effects
 *   npm run ia-loop:goal -- 003             real supervised execution
 *
 * The orchestrator is the ONLY component that decides who works next. The
 * models never call each other: every hand-off is validated and recorded here.
 *
 * V4 automates the correction rounds. A run keeps going while the reviewer asks
 * for changes and the round budget lasts, then stops at AWAITING_HUMAN whatever
 * the verdict. It never commits the Goal, never updates the migration baseline,
 * never creates the next Goal and never removes the worktree.
 */

import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SpikeError } from './lib/claude-process.mjs';
import { JOB_DISPATCH, createJobStore, readJson } from './lib/job-store.mjs';
import {
  DISPATCH_KINDS, assertNoDuplicateStageDispatch, reconcileExecutionState, resolveStageJobId,
} from './lib/reconcile.mjs';
import {
  assertBelongsToGoal, goalExecutionOf, initializeGoalExecutionState,
  readJobForGoal, staleGoalPointers,
} from './lib/goal-execution.mjs';
import { STAGES } from './lib/stage-identity.mjs';
import { fullWorktreeFingerprint } from './lib/worktree-fingerprint.mjs';
import { discoverGoal } from './lib/goal-discovery.mjs';
import { planWorktree, createWorktreeForGoal, branchNameFor } from './lib/worktree-manager.mjs';
import { provisionWorktreeDependencies } from './lib/worktree-dependencies.mjs';
import { readWorkerHealth, WORKER_HEALTH, SESSION_STRATEGY } from './lib/worker-registry.mjs';
import { LOOP_STATES, createLoopStateMachine, stateForDecision } from './lib/loop-state.mjs';
import { LOOP_CONFIG, planAfterReview } from './lib/loop-config.mjs';
import { PROTOCOL_VERSION_V2, validateDeveloperJob, validateReviewJob } from './lib/contracts-v2.mjs';
import {
  createGitProbe,
  createWorktree as gitCreateWorktree,
  collectWorktreeChanges,
  worktreeFingerprint,
} from './lib/git-ops.mjs';
import { captureSnapshot, checkDeveloperPolicy, checkReviewerPolicy, formatViolations } from './lib/policy-guards.mjs';
import { createLeaseStore } from './lib/leases.mjs';
import { buildReviewPacket } from './lib/review-packet.mjs';
import { extractGoalRequirements } from './lib/evidence-trace.mjs';
import { createExecutionPlanStore } from './lib/execution-plan-store.mjs';
import { deriveGoalGateStatus } from './lib/goal-gate-status.mjs';
import { createDeveloperProfileStore } from './lib/developer-profiles.mjs';
import { PROFILE_SOURCES, resolveProfileForRound, toExecutionRecord } from './lib/profile-routing.mjs';
import { renderRoutingSummary, summarizeRouting } from './lib/routing-summary.mjs';
import {
  ROUTING_STAGES,
  classifyReviewComplexity,
  resolveRoutingMode,
  routeTechLead,
  routingFromProfile,
  toJobRouting,
} from './lib/model-routing.mjs';
import { isDirectExecution } from './lib/direct-execution.mjs';
import { waitForResult } from './lib/result-waiter.mjs';
import { assertGoalEligibleForClosure } from './lib/closure-eligibility.mjs';
import { recordOrchestratorFault } from './lib/orchestrator-fault.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE);
const STATE_DIR = join(HERE, '.state');

const TECH_LEAD_MODEL = process.env.IA_LOOP_TECH_LEAD_MODEL ?? 'claude-fable-5-1';
const DEVELOPER_MODEL = process.env.IA_LOOP_DEVELOPER_MODEL ?? 'claude-opus-5';
const REVIEW_LEVEL = LOOP_CONFIG.reviewLevel;
/** Read once, here: an override is a property of the run, not of a worker. */
const routingMode = resolveRoutingMode();

const RESULT_TIMEOUT_MS = Number(process.env.IA_LOOP_RESULT_TIMEOUT_MS ?? 6 * 60 * 60 * 1000);

const probe = createGitProbe(REPO_ROOT);

/**
 * Whether the Developer had to be escalated during this round.
 *
 * Evidence about the CHANGE, not about the Developer: work that turned out to
 * need a stronger executor than the plan expected is work a reviewer benefits
 * from reading more carefully, so it raises the review's risk score.
 */
async function developerEscalatedThisRound(jobStore, devJobId) {
  const envelope = await readJson(jobStore.paths.job('developer', devJobId));
  return (envelope?.attemptHistory ?? []).some((entry) => entry?.reason === 'MODEL_ESCALATION');
}

// Created once, at module scope rather than inside main(): the top-level
// catch below needs the SAME store to record a harness fault, and a fresh
// createJobStore(STATE_DIR) here does no I/O of its own — it only builds path
// helpers — so hoisting it costs nothing and does not change when main()
// starts touching disk.
const store = createJobStore(STATE_DIR);
// Set once discoverGoal resolves inside main(). The top-level catch runs
// OUTSIDE main()'s scope and has no other way to know which Goal a thrown
// error belongs to.
let currentGoalId = null;

function parseArgs(argv) {
  const args = argv.slice(2);
  const goalId = args.find((a) => /^\d{3}$/.test(a));
  if (!goalId) throw new SpikeError('INVALID_ARGS', 'Usage: npm run ia-loop:goal -- <goalId> [--dry-run]');
  return { goalId, dryRun: args.includes('--dry-run') };
}

function formatHealth(h) {
  if (h.health === WORKER_HEALTH.OFFLINE) return 'OFFLINE (worker not running)';
  const age = h.ageMs === null ? '?' : `${Math.round(h.ageMs / 1000)}s ago`;
  return `${h.health} (state ${h.state}, heartbeat ${age})`;
}

/** Says what a dispatch actually did, so the log never claims more than it did. */
function dispatchMessage(dispatched, label) {
  switch (dispatched.outcome) {
    case JOB_DISPATCH.PUBLISHED:
      return `${label} job published: ${dispatched.jobId}`;
    case JOB_DISPATCH.NEW_ATTEMPT:
      return `${label} job ${dispatched.jobId} — attempt ${dispatched.attempt} after an interrupted one.`;
    case JOB_DISPATCH.ALREADY_QUEUED:
      return `${label} job ${dispatched.jobId} is already queued; waiting rather than publishing it twice.`;
    case JOB_DISPATCH.ALREADY_RUNNING:
      return `${label} job ${dispatched.jobId} is already running; waiting for that attempt.`;
    default:
      return `${label} job ${dispatched.jobId}: ${dispatched.outcome}`;
  }
}

/**
 * Records a role's job id for a round without disturbing the others.
 *
 * `jobIdsByRound` is written here for the same reason it always was —
 * display, audit, and the one legitimate reader left: `staleGoalPointers`,
 * which reports a pointer naming another Goal, never resurrects one. Nothing
 * in this file reads it back as a candidate job id any more: the ledger is
 * comprehensive over the same job files this was ever derived from, and a
 * fallback that trusted it is what let a wrong id, once written for a round,
 * keep answering for that round forever — see the fix at devJobId/revJobId.
 */
function withJobId(runtime, round, role, jobId) {
  const byRound = { ...(runtime?.jobIdsByRound ?? {}) };
  byRound[String(round)] = { ...(byRound[String(round)] ?? {}), [role]: jobId };
  return { jobIdsByRound: byRound };
}

async function main() {
  const emit = (line = '') => console.log(line);
  const { goalId, dryRun } = parseArgs(process.argv);
  const leaseStore = createLeaseStore(STATE_DIR);
  const profileStore = createDeveloperProfileStore(STATE_DIR);
  const machine = createLoopStateMachine();

  emit('');
  emit('IA Loop — Goal Runner');
  emit('');
  emit(`Mode:\n${dryRun ? 'DRY_RUN' : 'REAL_EXECUTION'}`);
  emit('');

  const goal = await discoverGoal({
    repoRoot: REPO_ROOT, goalId, resolveSha: (sha) => probe.commitExists(sha),
  });
  currentGoalId = goal.goalId;
  machine.transitionTo(LOOP_STATES.GOAL_READY, { goal: goal.goalId });

  emit('Goal discovery:');
  emit('PASS');
  emit(`  goal: ${goal.goalId} — ${goal.title}`);
  emit(`  status: ${goal.status}`);
  emit(`  previous goal: ${goal.previousGoalId ?? 'n/a'} (${goal.previousGoalStatus ?? 'n/a'})`);
  emit('');

  const headNow = await probe.head();
  emit('Migration baseline (accepted):');
  emit(`  ${goal.migrationAcceptedBaseline}`);
  emit('Execution base (current HEAD):');
  emit(`  ${headNow}`);
  emit('');
  emit(`Tech Lead:\n  ${TECH_LEAD_MODEL}\n  ${SESSION_STRATEGY.PERSISTENT}`);
  emit(`Developer:\n  ${DEVELOPER_MODEL}\n  ${SESSION_STRATEGY.STATELESS}`);
  emit('');

  // ======================= DRY RUN ========================================
  if (dryRun) {
    machine.transitionTo(LOOP_STATES.PREPARING_WORKTREE);
    const plan = await planWorktree({ goalId, executionBase: headNow, git: probe });

    emit('Worktree plan:');
    emit(`  path: ${plan.path}`);
    emit(`  branch: ${plan.branch}`);
    emit(`  base: ${plan.executionBase}`);
    emit(`  current branch (untouched): ${plan.currentBranch}`);
    emit('  created: NO (dry run)');
    if (plan.blockers.length > 0) {
      emit('  blockers:');
      for (const b of plan.blockers) emit(`    - [${b.code}] ${b.message}`);
    } else emit('  blockers: none');
    emit('');

    if (plan.safe) machine.transitionTo(LOOP_STATES.WORKTREE_READY);

    const [tl, dev] = await Promise.all([
      readWorkerHealth(store, 'tech_lead'), readWorkerHealth(store, 'developer'),
    ]);
    emit(`Workers:\n  tech-lead: ${formatHealth(tl)}\n  developer: ${formatHealth(dev)}`);
    emit('');
    emit(`Review:\n  ${REVIEW_LEVEL}`);
    emit('');

    await store.appendEvent({ type: 'DRY_RUN_COMPLETED', goal: goal.goalId, state: machine.state, worktreeSafe: plan.safe });

    const devJobs = await store.listJobs('developer');
    const revJobs = await store.listJobs('tech_lead');
    emit('Goal executed:\nNO');
    emit('');
    emit('Overall:');
    const passed = goal.status === 'READY';
    emit(passed ? 'PASS' : 'FAIL');
    return passed ? 0 : 1;
  }

  // ===================== REAL EXECUTION ===================================
  const [tlHealth, devHealth] = await Promise.all([
    readWorkerHealth(store, 'tech_lead'), readWorkerHealth(store, 'developer'),
  ]);
  emit(`Workers:\n  tech-lead: ${formatHealth(tlHealth)}\n  developer: ${formatHealth(devHealth)}`);
  emit('');
  if (tlHealth.health === WORKER_HEALTH.OFFLINE || devHealth.health === WORKER_HEALTH.OFFLINE) {
    throw new SpikeError('WORKERS_NOT_RUNNING',
      'Both workers must be running: npm run ia-loop:tech-lead and npm run ia-loop:developer');
  }

  // --- Worktree: reuse when an execution is already in progress ------------
  machine.transitionTo(LOOP_STATES.PREPARING_WORKTREE);
  const persistedRuntime = await store.readRuntime();

  // THE read gate. Everything below that wants to know what already happened
  // asks this, never the persisted runtime: it is null unless the state on disk
  // is this Goal's own. A closed Goal's execution is history — readable in the
  // store and in the archive, never an input to what happens next.
  const priorGoalExecution = goalExecutionOf(persistedRuntime, goal.goalId);

  const leaked = staleGoalPointers(persistedRuntime, goal.goalId);
  if (leaked.length > 0) {
    // Not a repair and not a failure: the pointers are simply not used, and the
    // fact that they were there is recorded with what they named.
    emit(persistedRuntime.goal === goal.goalId
      ? `Execution state carries ${leaked.length} pointer(s) from another Goal; they are history and are not used.`
      : `Execution state on disk belongs to Goal ${persistedRuntime.goal}; it is history, not this Goal's state.`);
    for (const pointer of leaked.slice(0, 8)) {
      emit(`  stale: ${pointer.field} = ${pointer.value}${pointer.goal ? ` (Goal ${pointer.goal})` : ''}`);
    }
    await store.appendEvent({
      type: 'CROSS_GOAL_STATE_LEAK_DETECTED',
      goal: goal.goalId, previousGoal: persistedRuntime.goal,
      pointers: leaked.map(({ field, value, goal: owner }) => ({ field, value, goal: owner })),
    });
    emit('');
  }

  const resuming = priorGoalExecution?.mode === 'REAL_EXECUTION'
    && Boolean(priorGoalExecution.worktreeInitialHead)
    && Boolean(priorGoalExecution.worktreePath)
    && await probe.pathExists(priorGoalExecution.worktreePath);

  let worktree;
  if (resuming) {
    emit('Resuming an execution already in progress — the worktree is reused, not recreated.');
    worktree = {
      path: priorGoalExecution.worktreePath,
      branch: branchNameFor(goalId),
      worktreeInitialHead: priorGoalExecution.worktreeInitialHead,
      absolutePath: join(REPO_ROOT, priorGoalExecution.worktreePath),
    };
  } else {
    emit('Creating worktree…');
    worktree = await createWorktreeForGoal({
      goalId, executionBase: headNow, git: probe, repoRoot: REPO_ROOT, createFn: gitCreateWorktree,
    });
  }
  machine.transitionTo(LOOP_STATES.WORKTREE_READY);

  // The base of record never moves, even though the tooling checkout advanced.
  const executionBase = resuming
    ? (priorGoalExecution.executionBase ?? worktree.worktreeInitialHead)
    : headNow;
  const absWorktree = worktree.absolutePath;

  emit('Worktree:');
  emit(`  path: ${worktree.path}`);
  emit(`  branch: ${worktree.branch}`);
  emit(`  initialHead: ${worktree.worktreeInitialHead}`);
  emit(`  executionBase (original): ${executionBase}`);
  emit('');

  // `node_modules` is gitignored, so the worktree is born with none. Until
  // now the gap was filled by accident — whichever unit ran `npm install` to
  // check its own work — which is why the GLOBAL gates have a history of
  // dying on a missing dependency while the scoped ones pass. Deterministic,
  // idempotent, and placed after the resume branch on purpose: a resumed
  // worktree can be missing them just as easily as a new one.
  const provisioning = await provisionWorktreeDependencies({ worktreePath: absWorktree, emit });
  if (provisioning.failed.length > 0) {
    // Not fatal. Whatever will not install is something the gates are about to
    // report in far more detail, and stopping here would trade a red gate for
    // a dead run.
    await store.appendEvent({
      type: 'WORKTREE_DEPENDENCIES_INCOMPLETE',
      goal: goalId,
      packages: provisioning.failed.map((failure) => failure.dir),
    });
  }
  emit('');

  await store.writeCurrentGoal({
    goalId: goal.goalId, title: goal.title, status: goal.status, goalPath: goal.goalPath,
    migrationAcceptedBaseline: goal.migrationAcceptedBaseline, executionBase,
    worktreePath: worktree.path, worktreeInitialHead: worktree.worktreeInitialHead,
  });
  await store.appendEvent({
    type: resuming ? 'WORKTREE_REUSED' : 'WORKTREE_CREATED',
    goal: goal.goalId, path: worktree.path, branch: worktree.branch,
    initialHead: worktree.worktreeInitialHead,
  });

  const baseRuntime = {
    mode: 'REAL_EXECUTION', goal: goal.goalId, state: machine.state,
    migrationAcceptedBaseline: goal.migrationAcceptedBaseline, executionBase,
    worktreePath: worktree.path, worktreeInitialHead: worktree.worktreeInitialHead,
    reviewLevel: REVIEW_LEVEL, goalExecuted: false,
  };
  // Continuing THIS Goal keeps its own execution state; starting a Goal builds
  // a new one explicitly. The difference matters more than it looks: a spread
  // of the previous runtime keeps every field nobody thought about, and that is
  // exactly how Goal 004's job ids arrived in Goal 005's dispatch.
  if (priorGoalExecution) {
    await store.writeRuntime({ ...priorGoalExecution, ...baseRuntime });
  } else {
    if (persistedRuntime?.goal) {
      const archived = await store.archiveGoalExecution(persistedRuntime);
      await store.appendEvent({
        type: 'GOAL_EXECUTION_ARCHIVED',
        previousGoal: persistedRuntime.goal, nextGoal: goal.goalId,
        baseline: goal.migrationAcceptedBaseline, archived: archived.archived,
      });
    }
    await store.writeRuntime(initializeGoalExecutionState({
      previousRuntime: persistedRuntime, goal: goal.goalId, execution: baseRuntime,
    }));
    await store.appendEvent({
      type: 'NEXT_GOAL_EXECUTION_INITIALIZED',
      previousGoal: persistedRuntime?.goal ?? null, nextGoal: goal.goalId,
      baseline: goal.migrationAcceptedBaseline, round: 1,
    });
  }

  // --- Reconcile before dispatch -------------------------------------------
  //
  // Where the round comes from. It used to be read off ids recorded in the
  // runtime, which are a hint and were treated as the authority: when the
  // recorded id was missing, the loop concluded nothing had been done, minted a
  // fresh attempt id, found no result under a name that had never existed, and
  // sent Opus to re-implement a round whose work AND review were both already
  // on disk.
  //
  // Completion is now derived from the results, the only durable proof that an
  // inference happened.
  let reconciled = await reconcileExecutionState({
    store, goal: goal.goalId, maxRounds: LOOP_CONFIG.maxCorrectionRounds,
  });

  for (const duplicate of reconciled.duplicates) {
    // An attempt that should never have existed is recorded as superseded, not
    // deleted: what the harness did wrong stays readable.
    emit(`Superseding duplicate attempt ${duplicate.jobId} — ${duplicate.stageKey} completed as ${duplicate.completedBy}.`);
    const role = duplicate.stageKey.endsWith(STAGES.REVIEW) ? 'tech_lead' : 'developer';
    await store.setJobStatus(role, duplicate.jobId, 'SUPERSEDED').catch(() => {});
    await store.appendEvent({
      type: 'DUPLICATE_STAGE_ATTEMPT_SUPERSEDED', goal: goal.goalId,
      jobId: duplicate.jobId, stageKey: duplicate.stageKey, completedBy: duplicate.completedBy,
    });
  }

  emit(`Reconciled: next is ${reconciled.next.kind}${reconciled.next.round ? ` at round ${reconciled.next.round}` : ''}.`);
  emit('');

  if (reconciled.next.kind === DISPATCH_KINDS.HUMAN_REQUIRED) {
    // The machine is at WORKTREE_READY here — this branch fires the moment
    // reconciliation reads the ledger, before any dispatch — and WORKTREE_READY
    // legally leads only to DEVELOPER_QUEUED/CORRECTION_QUEUED/STOPPED. This is
    // never this process discovering HUMAN_REQUIRED by doing the work; it is
    // the ledger already proving it (a round budget exhausted, a review that
    // asked for a human, an unusable decision) on a resumed or freshly
    // attached run. `hydrateTo` records that distinction instead of forcing a
    // transition the graph correctly refuses.
    machine.hydrateTo(LOOP_STATES.HUMAN_REQUIRED, {
      reason: reconciled.next.reason,
      evidence: { kind: reconciled.next.kind, round: reconciled.next.round ?? null, detail: reconciled.next.detail ?? null },
    });
    machine.transitionTo(LOOP_STATES.AWAITING_HUMAN);
    emit(`Goal ${goal.goalId} needs a human: ${reconciled.next.reason}`);
    if (reconciled.next.detail) emit(`  ${reconciled.next.detail}`);
    await store.writeRuntime({
      ...(await store.readRuntime()),
      state: machine.state,
      humanRequired: {
        reason: reconciled.next.reason,
        note: reconciled.next.detail ?? null,
        at: new Date().toISOString(),
      },
    });
    return 0;
  }

  if (reconciled.next.kind === DISPATCH_KINDS.CLOSE_GOAL) {
    emit(`Round ${reconciled.next.round} was ACCEPTED; the Goal is ready for closure.`);
    // Independent, fenced re-proof — never trusted from `reconciled.next`
    // alone — that this exact review job, round and attempt earned ACCEPTED.
    // Its return value IS the evidence `hydrateTo` requires: this jump is
    // legitimate only because a completed, unblocked, correctly-scoped review
    // says so, not because the ledger's first pass said so.
    const closureEvidence = await assertGoalEligibleForClosure(store, {
      goal: goal.goalId, round: reconciled.next.round, reviewJobId: reconciled.next.reviewJobId,
    });
    // See the HUMAN_REQUIRED branch above: WORKTREE_READY cannot legally reach
    // ACCEPTED through `transitionTo`, and should not be able to — a Goal
    // without a proven review must never slip through as though it had one.
    machine.hydrateTo(LOOP_STATES.ACCEPTED, {
      reason: 'AUTHORITATIVE_REVIEW_ACCEPTED', evidence: closureEvidence,
    });
    await store.writeRuntime({
      ...(await store.readRuntime()),
      state: machine.state, round: reconciled.next.round, decision: 'ACCEPTED',
    });
    return 0;
  }

  // Reconciliation just proved the run is NOT blocked (neither of the two
  // branches above fired) — so whatever `escalationReason`/`decision`/
  // `humanRequired` are still sitting in runtime.json describe a gate a human
  // already resolved, not this attempt. Left alone, a stale reason survives a
  // completely different NEW failure: Goal007 R2 crashed on
  // CONTRACT_FIELD_INVALID (this file building an invalid job), but the
  // terminal surfaced the PREVIOUS run's POLICY_VIOLATION because nothing
  // had ever cleared it. A future failure earns its own reason; it does not
  // inherit one a person already closed out.
  const stalePriorRuntime = await store.readRuntime();
  if (stalePriorRuntime?.escalationReason || stalePriorRuntime?.humanRequired || stalePriorRuntime?.decision === 'HUMAN_REQUIRED') {
    await store.appendEvent({
      type: 'STALE_HUMAN_REASON_CLEARED', goal: goal.goalId,
      previousReason: stalePriorRuntime.escalationReason ?? null,
      previousDecision: stalePriorRuntime.decision ?? null,
    });
    await store.writeRuntime({
      ...stalePriorRuntime, escalationReason: null, humanRequired: null,
      decision: stalePriorRuntime.decision === 'HUMAN_REQUIRED' ? null : stalePriorRuntime.decision,
    });
  }

  let round = reconciled.next.round;
  // Blockers travel with the review that produced them; they are never
  // rediscovered by asking the Tech Lead again.
  // `let`, because the loop below reassigns both when a review asks for a
  // correction round. They were `const`, which made the in-process continuation
  // after CHANGES_REQUIRED throw before it could start the next round.
  let pendingBlockers = reconciled.next.blockers ?? [];
  let startAsCorrection = reconciled.next.kind === DISPATCH_KINDS.CORRECTION;

  // The Developer profile the Tech Lead chose for this Goal when it planned it.
  // Read once: `run-goal` never asks a model which profile to use.
  const plannedProfile = await profileStore.read(goal.goalId);
  // Carried across rounds inside this process. A review may replace it; silence
  // preserves it. Nothing here promotes on round number.
  //
  // Seeded from disk: a run interrupted between "the Tech Lead escalated" and
  // "the correction round started" must resume on the escalated profile, not on
  // the one the previous round happened to use.
  const persistedEscalation = priorGoalExecution?.nextDeveloperProfile ?? null;
  // A wider crash than the one above: no process ever reached the write that
  // seeds `persistedEscalation` at all — the review completed with nobody's
  // orchestrator alive to read it (recovery consumed the result cold, straight
  // into round `reconciled.next.round`). The escalation the reviewer actually
  // made is not lost, though: it is sitting on the review's own persisted
  // result, and `reconcileExecutionState` already carries it on `next` for
  // exactly this reason — the same way it already carries `blockers`.
  const reconciledEscalation = startAsCorrection && reconciled.next.nextDeveloperProfile
    ? { profile: reconciled.next.nextDeveloperProfile, reason: reconciled.next.nextDeveloperProfileReason ?? null }
    : null;
  let pendingProfileEscalation = persistedEscalation?.round === round
    ? persistedEscalation
    : reconciledEscalation;

  if (startAsCorrection && pendingBlockers.length > 0) {
    emit(`Correction round ${round} carries ${pendingBlockers.length} blocker(s) from review ${reconciled.next.fromReviewJobId ?? 'on disk'}.`);
    emit('');
  }


  const roundsRun = [];
  let finalDecision = null;
  let finalReason = null;
  let lastChanges = null;
  let lastDevResult = null;

  for (;;) {
    // Refreshed every pass, never trusted from before the loop started: this
    // process may carry several rounds in one run (a correction dispatched,
    // reviewed and requeued without ever restarting), and the ledger built
    // once, before round 1, is what round 1 completing changed. A snapshot
    // taken then keeps answering for round 2, 3, ... with round 1's own
    // resumable attempt — `reconciled.next.resumeAttempt` for THAT round is a
    // completely different stage from this round's, but the fallback chain
    // below cannot tell a stale hint from a fresh one, only a present value
    // from an absent one. Rebuilt from the job/result files on disk, which is
    // exactly what `reconcileExecutionState` already does and exactly why it
    // is idempotent and cheap to call again: no model call, no dispatch, only
    // reads. Only `.ledger` and `.next.resumeAttempt` are read below;
    // duplicate-superseding and the HUMAN_REQUIRED/CLOSE_GOAL short-circuit
    // stay one-time, above the loop — the loop's own decision after each
    // review is what actually governs whether another round happens.
    reconciled = await reconcileExecutionState({
      store, goal: goal.goalId, maxRounds: LOOP_CONFIG.maxCorrectionRounds,
    });

    const isCorrection = startAsCorrection || round > 1;
    const phaseQueued = isCorrection ? LOOP_STATES.CORRECTION_QUEUED : LOOP_STATES.DEVELOPER_QUEUED;
    const phaseRunning = isCorrection ? LOOP_STATES.CORRECTION_RUNNING : LOOP_STATES.DEVELOPER_RUNNING;

    emit(`── Round ${round} ${isCorrection ? '(correction)' : '(implementation)'} ──`);

    // --- Developer routing -------------------------------------------------
    // Resolved BEFORE the job is built, from state only. A recovered round
    // re-reads the profile it already had; it is never recalculated, so a
    // promotion to OPUS_HIGH cannot be downgraded by a restart.
    const currentExecution = goalExecutionOf(await store.readRuntime(), goal.goalId);
    const routing = resolveProfileForRound({
      goalExecution: currentExecution,
      round,
      techLeadEscalation: pendingProfileEscalation,
      planningRecord: plannedProfile,
      declaredInGoal: goal.declaredDeveloperProfile,
    });
    const profileRecord = toExecutionRecord(routing, { goal: goal.goalId, round });

    if (routing.source !== PROFILE_SOURCES.PERSISTED) {
      await store.writeRuntime({
        ...(await store.readRuntime()), developerProfile: profileRecord, nextDeveloperProfile: null,
      });
      await store.appendEvent({
        type: routing.changed ? 'DEVELOPER_PROFILE_CHANGED' : 'DEVELOPER_PROFILE_SELECTED',
        goal: goal.goalId,
        round,
        stage: isCorrection ? STAGES.CORRECTION : STAGES.IMPLEMENTATION,
        profile: routing.profile.name,
        previousProfile: routing.previousProfile,
        model: routing.profile.model,
        effort: routing.profile.effort,
        selectedBy: routing.selectedBy,
        source: routing.source,
        // Short by contract: the audit trail records a choice, not an argument.
        reason: routing.reason,
      });
    }
    // Consumed: an escalation applies to exactly one round.
    pendingProfileEscalation = null;

    emit(`Developer profile: ${routing.profile.name} (${routing.profile.model}, effort ${routing.profile.effort ?? 'CLI default'}) — ${routing.source}`);
    if (routing.reason) emit(`  reason: ${routing.reason}`);

    const beforeDev = await captureSnapshot({ probe });


    // A distinct job id per round is what makes idempotency meaningful — and it
    // is recorded per ROLE, not just per round. A single currentJobId could not
    // survive a crash during review: the id left on disk was the reviewer's, so
    // on resume the Developer step adopted it, found no Developer result under
    // it, and would have re-run Opus under a job id that belonged to the Tech
    // Lead. Two inferences, one of them already paid for.
    // The attempt to use: the one the ledger says already completed this stage,
    // then whichever was left in flight, then a new one — `resolveStageJobId`,
    // and the ledger ALONE. There used to be a third fallback here that read
    // `runtime.jobIdsByRound` directly, and it is gone on purpose: that field
    // is written by this very step, so once a bug (or a stale process) ever
    // wrote a wrong id into it for a round, the fallback would keep
    // resurrecting that wrong id forever, on every future resume, even after
    // the ledger itself had been fixed. That is exactly how Goal010's round 2
    // and round 3 kept reusing round 1's own BLOCKED result — the ledger
    // correctly said nothing had been dispatched, and the raw hint answered
    // anyway. A resumable attempt is still found, from the same job files a
    // hint was ever derived from — that is the only thing a hint could have
    // offered for free. A freshly minted id is the answer whenever nothing
    // legitimate survives — never an inherited one.
    const devStage = isCorrection ? STAGES.CORRECTION : STAGES.IMPLEMENTATION;
    const devResolved = resolveStageJobId({ ledger: reconciled.ledger, goal: goal.goalId, round, stage: devStage });
    const devJobId = devResolved.jobId
      ?? store.newJobId(goal.goalId, round, isCorrection ? 'correction' : 'developer');
    assertBelongsToGoal(devJobId, goal.goalId, `developer job ${devJobId}`);
    await readJobForGoal(store, 'developer', devJobId, goal.goalId);

    const alreadyDone = await store.hasCompletedResult('developer', devJobId);

    // Built and validated ONLY when a job might actually be published below.
    // `pendingBlockers` is meaningless here when reconciliation resumed
    // straight into REVIEW — nothing repopulates it for a round whose
    // Developer stage is already COMPLETED, and it is never asked to: no new
    // job is being built. Validating a hypothetical CORRECTION shaped from an
    // empty blocker list was the bug — `validateDeveloperJob` correctly
    // refuses that shape (a CORRECTION must carry at least one blocker), but
    // the refusal fired before `alreadyDone` below ever got to reuse the
    // result that already existed, on a round that needed no new job at all.
    const buildDevJob = () => validateDeveloperJob({
      protocolVersion: PROTOCOL_VERSION_V2,
      jobId: devJobId,
      role: 'developer',
      goal: goal.goalId,
      round,
      type: isCorrection ? 'CORRECTION' : 'IMPLEMENTATION',
      migrationAcceptedBaseline: goal.migrationAcceptedBaseline,
      executionBase,
      worktreeInitialHead: worktree.worktreeInitialHead,
      worktree: absWorktree,
      goalPath: goal.goalPath,
      blockers: isCorrection ? pendingBlockers.map(blockerText) : [],
      previousImplementationReport: lastDevResult?.implementationReport ?? priorGoalExecution?.lastImplementationReport ?? null,
      previousDecision: isCorrection ? 'CHANGES_REQUIRED' : undefined,
      changedFiles: lastChanges?.changedFiles ?? [],
      // The job is what the worker reads. Putting the profile here — rather
      // than letting the worker decide — is what makes a restart, a capacity
      // retry and a recovery all run on the same model.
      developerProfile: routing.profile.name,
      developerProfileReason: routing.reason,
      // The same choice in the router's own vocabulary, so a fallback or an
      // escalation can be replayed from the job without re-deriving it.
      routing: toJobRouting(routingFromProfile(routing.profile, {
        stage: isCorrection ? ROUTING_STAGES.CORRECTION : ROUTING_STAGES.IMPLEMENTATION,
        mode: routingMode,
      })),
    });

    // Two different callers can legitimately need the machine sitting in
    // `phaseQueued` here, and only one of them has actually not arrived yet.
    // A cold process resuming a correction round starts this loop from
    // WORKTREE_READY (line ~275) and has never touched the machine before —
    // for that caller this transition is the ONLY queuing step, and it is
    // required. But when THIS SAME process just decided CHANGES_REQUIRED
    // (below, `machine.transitionTo(LOOP_STATES.CORRECTION_QUEUED)` at the
    // CHANGES_REQUIRED -> CORRECTION_QUEUED edge — the one edge the registry
    // defines for CHANGES_REQUIRED) and looped back via `continue`, the
    // machine is already exactly here: queuing is already done, persisted
    // with the round/blockers/profile that decision carried, and this call
    // would ask for CORRECTION_QUEUED -> CORRECTION_QUEUED — a state the
    // registry correctly has no edge for, because self-transitions are not a
    // real step. Goal007 R2->R3 crashed on exactly that: CHANGES_REQUIRED was
    // real, the queue was already prepared, and this line re-asked for it.
    //
    // This does not add a self-transition to the graph — every OTHER caller
    // of `transitionTo` in this file (there are 18) still fails exactly as
    // before if it targets a state the machine cannot legally reach. This
    // guard only recognises that `machine` is a single object owned by this
    // process, so if it is already sitting in `phaseQueued`, the only thing
    // that could have put it there is the CHANGES_REQUIRED branch below,
    // which already did every bit of preparation this round needs.
    if (machine.state !== phaseQueued) machine.transitionTo(phaseQueued);
    await store.writeRuntime({
      ...(await store.readRuntime()), state: machine.state, round,
      currentJobId: devJobId, ...withJobId(await store.readRuntime(), round, 'developer', devJobId),
    });

    let devEnvelope;
    if (alreadyDone) {
      emit(`Developer already completed ${devJobId} — reusing the persisted result. The model is NOT called again.`);
      machine.transitionTo(phaseRunning);
      devEnvelope = await store.readResult('developer', devJobId);
    } else {
      // Fails closed rather than paying for an inference already on disk.
      assertNoDuplicateStageDispatch({
        ledger: reconciled.ledger, goal: goal.goalId, round, stage: devStage, jobId: devJobId,
      });
      const devJob = buildDevJob();
      // Dispatch, not publish: the job for this stage may already exist —
      // queued, or interrupted and owed another attempt. Publishing blindly
      // is what turned every resume into DUPLICATE_JOB.
      const dispatched = await store.dispatchJob('developer', devJob, {
        reason: 'RECOVERED_INTERRUPTED_ATTEMPT',
      });
      emit(dispatchMessage(dispatched, isCorrection ? 'Correction' : 'Developer'));

      // The complete content identity of the tree this attempt is handed,
      // captured before the model runs and named by ATTEMPT. A single
      // worktree-fingerprint-before.json was overwritten on every pass, so the
      // state a given attempt actually started from was lost the moment the
      // next one ran — and reconstructing that is the whole reason to capture
      // it. Earlier snapshots are never rewritten.
      const attemptNumber = dispatched.attempt ?? 1;
      const fingerprintBefore = await fullWorktreeFingerprint(absWorktree, executionBase, {
        worktreeInitialHead: worktree.worktreeInitialHead,
      });
      await fs.mkdir(join(STATE_DIR, 'artefacts', `${goal.goalId}-r${round}`), { recursive: true });
      await fs.writeFile(
        join(STATE_DIR, 'artefacts', `${goal.goalId}-r${round}`, `worktree-fingerprint-before-a${attemptNumber}.json`),
        JSON.stringify({ ...fingerprintBefore, attempt: attemptNumber, jobId: devJobId }, null, 2), 'utf8',
      );
      await store.appendEvent({
        type: 'WORKTREE_FINGERPRINT_CAPTURED', goal: goal.goalId, round,
        phase: 'BEFORE_DEVELOPER', attempt: attemptNumber, jobId: devJobId,
        contentHash: fingerprintBefore.contentHash,
        trackedDiffHash: fingerprintBefore.trackedDiffHash,
        untrackedHash: fingerprintBefore.untrackedHash,
        untrackedFileCount: fingerprintBefore.untrackedFileCount,
      });
      if (dispatched.outcome === JOB_DISPATCH.NEW_ATTEMPT) {
        await store.appendEvent({
          type: 'JOB_ATTEMPT_STARTED', role: 'developer', jobId: devJobId,
          goal: goal.goalId, round, stage: devStage, attempt: dispatched.attempt,
        });
      }
      machine.transitionTo(phaseRunning);
      emit('Waiting for the Developer…');
      // Which attempt this run is waiting on, read from the job the dispatch
      // just settled. Without it the wait would accept any attempt's result.
      const devAttemptId = (await store.readAttemptState('developer', devJobId))?.attemptId ?? null;
      emit(`  attempt: ${devAttemptId ?? 'unknown'}`);
      const observed = await waitForResult(store, 'developer', devJobId, {
        emit, leaseStore, expectedAttemptId: devAttemptId,
        goal: goal.goalId, round, resultTimeoutMs: RESULT_TIMEOUT_MS,
      });
      if (observed.observerTimeout || observed.workerOffline) {
        await reportObserverStop({ store, emit, role: 'developer', jobId: devJobId, observed, goal: goal.goalId, round });
        return 0;
      }
      devEnvelope = observed.envelope;
    }

    if (!devEnvelope.ok) {
      emit(`Developer failed: [${devEnvelope.code}] ${devEnvelope.message}`);
      machine.transitionTo(LOOP_STATES.HUMAN_REQUIRED);
      finalDecision = 'HUMAN_REQUIRED';
      finalReason = devEnvelope.code;
      break;
    }

    lastDevResult = devEnvelope.result;
    emit(`Developer result: ${lastDevResult.status}`);

    // --- Real state, collected from git -----------------------------------
    const changes = await collectWorktreeChanges(absWorktree, worktree.worktreeInitialHead);
    lastChanges = changes;
    const afterDev = await captureSnapshot({ probe });
    const devViolations = checkDeveloperPolicy({
      before: beforeDev, after: afterDev,
      worktreeInitialHead: worktree.worktreeInitialHead, changes,
    });

    emit(`  changed files: ${changes.changedFiles.length} · commits: ${changes.commits.length} · violations: ${devViolations.length}`);
    for (const v of formatViolations(devViolations)) emit(`    - ${v}`);

    const artefactDir = join(STATE_DIR, 'artefacts', `${goal.goalId}-r${round}`);
    await fs.mkdir(artefactDir, { recursive: true });
    const diffPath = join(artefactDir, 'implementation.patch');
    await fs.writeFile(diffPath, changes.diff, 'utf8');

    if (devViolations.length > 0) {
      await store.appendEvent({ type: 'POLICY_VIOLATION', goal: goal.goalId, round, agent: 'developer', violations: devViolations });
      machine.transitionTo(LOOP_STATES.HUMAN_REQUIRED);
      finalDecision = 'HUMAN_REQUIRED';
      finalReason = 'POLICY_VIOLATION';
      break;
    }

    machine.transitionTo(LOOP_STATES.REVIEW_REQUIRED);

    // --- Review ------------------------------------------------------------
    //
    // Read across the WHOLE Goal, not this round: the gates live in the round-1
    // plan, and by the round that accepts the Goal that plan is several rounds
    // behind. Asking the round is what let Goal019 become the baseline having
    // run one gate of seven.
    const goalPlan = await createExecutionPlanStore(STATE_DIR).read(goal.goalId).catch(() => null);
    const goalGates = deriveGoalGateStatus({
      declaredGates: (goalPlan?.workUnits ?? [])
        .filter((unit) => unit.type === 'DETERMINISTIC')
        .map((unit) => ({ id: unit.id, action: unit.action, scope: unit.scope ?? null })),
      events: (await store.readEvents()).filter((event) => event.goal === goal.goalId),
      currentRound: round,
    });

    // --- Criteria coverage, before the expensive review --------------------
    //
    // Eleven of the eighteen blockers across Goals 020–023 are one shape: a
    // numbered item the Goal document declares and the diff does not deliver.
    // A DEEP review in Opus found each of them by reading. This asks the same
    // question first, narrowly and on the standard model, so the answer is a
    // fact in the packet rather than something the reviewer has to derive.
    //
    // Entirely optional. It never gates, never refuses, and any failure leaves
    // `criteriaCoverage` null — a missing convenience must not cost a review.
    const coverage = await assessCriteriaCoverage({
      store, goal, round, changes, worktree: absWorktree, emit, leaseStore,
    }).catch(async (error) => {
      emit(`  cobertura de critérios não apurada: ${error.message}`);
      await store.appendEvent({
        type: 'CRITERIA_COVERAGE_SKIPPED', goal: goal.goalId, round, reason: error.code ?? 'UNKNOWN',
      }).catch(() => {});
      return null;
    });

    const packet = buildReviewPacket({
      goal: goal.goalId, goalPath: goal.goalPath, round, reviewLevel: REVIEW_LEVEL,
      criteriaCoverage: coverage?.result ?? null,
      criteriaDeclared: coverage?.declared ?? 0,
      migrationAcceptedBaseline: goal.migrationAcceptedBaseline,
      executionBase, worktreeInitialHead: worktree.worktreeInitialHead,
      worktreePath: absWorktree, changes, developerResult: lastDevResult,
      previousBlockers: pendingBlockers.map(blockerText), diffPath,
      // So the reviewer decides an escalation against the profile that
      // actually ran, not against an assumption.
      developerProfile: routing.profile.name,
      goalGates,
    });
    // The exact tree being reviewed, hashed in full. The review packet already
    // carried the tracked diff; what was missing was the content of untracked
    // files, which is why a later forensic comparison could only reach a verdict
    // for part of the tree.
    const reviewedFingerprint = await fullWorktreeFingerprint(absWorktree, executionBase, {
      worktreeInitialHead: worktree.worktreeInitialHead,
    });
    const fingerprintPath = join(artefactDir, 'worktree-fingerprint-reviewed.json');
    await fs.writeFile(fingerprintPath, JSON.stringify(reviewedFingerprint, null, 2), 'utf8');

    const packetPath = join(artefactDir, 'review-packet.json');
    await fs.writeFile(
      packetPath,
      JSON.stringify({ ...packet, worktreeFingerprint: reviewedFingerprint, fingerprintPath }, null, 2),
      'utf8',
    );
    await store.appendEvent({
      type: 'WORKTREE_FINGERPRINT_CAPTURED', goal: goal.goalId, round, phase: 'REVIEWED',
      contentHash: reviewedFingerprint.contentHash,
      trackedDiffHash: reviewedFingerprint.trackedDiffHash,
      untrackedHash: reviewedFingerprint.untrackedHash,
      untrackedFileCount: reviewedFingerprint.untrackedFileCount,
    });

    // The reviewer's job id was previously minted fresh on every pass, so any
    // resume re-published the review and called Fable again — even when its
    // answer was already on disk. It is now recorded and reused like the
    // Developer's — through the ledger alone, via `resolveStageJobId`. This
    // used to fall back to a raw `runtime.jobIdsByRound` hint, which is
    // exactly what let Goal010 reuse a SUPERSEDED review across rounds 2 and
    // 3: the hint named a real job, but one the ledger had already excluded
    // from completing this stage, and nothing here asked the ledger before
    // trusting it.
    const revResolved = resolveStageJobId({ ledger: reconciled.ledger, goal: goal.goalId, round, stage: STAGES.REVIEW });
    const revJobId = revResolved.jobId ?? store.newJobId(goal.goalId, round, 'tech_lead');
    assertBelongsToGoal(revJobId, goal.goalId, `review job ${revJobId}`);
    await readJobForGoal(store, 'tech_lead', revJobId, goal.goalId);
    const reviewAlreadyDone = await store.hasCompletedResult('tech_lead', revJobId);

    // --- Review routing ----------------------------------------------------
    // Scored on the change that now EXISTS, not on what the Goal said it would
    // be: files, migrations, how many apps were touched, and whether the
    // Developer itself had to escalate. Deterministic and zero-token — no model
    // is called to decide which model reviews.
    const reviewAssessment = classifyReviewComplexity({
      changedFiles: changes.changedFiles,
      diffStat: changes.diffStat,
      text: `${lastDevResult.summary ?? ''}\n${lastDevResult.implementationReport ?? ''}`,
      developerEscalated: await developerEscalatedThisRound(store, devJobId),
      previousBlockers: pendingBlockers.map(blockerText),
    });
    const reviewRouting = routeTechLead({
      stage: ROUTING_STAGES.REVIEW,
      assessment: reviewAssessment,
      mode: routingMode,
    });
    emit(`Review routing: ${reviewAssessment.classification} (score ${reviewAssessment.riskScore})`
      + ` → ${reviewRouting.label} effort ${reviewRouting.effort}`);
    if (reviewAssessment.signals.length > 0) emit(`  signals: ${reviewAssessment.signals.join(', ')}`);

    const revJob = validateReviewJob({
      protocolVersion: PROTOCOL_VERSION_V2,
      jobId: revJobId, role: 'tech_lead', goal: goal.goalId, round,
      // The developer/correction job this review is actually FOR — not just
      // "some result exists under this round number". Reconciliation cross-
      // checks this against whichever job genuinely completed the round's
      // implementation stage, so a review can never outlive the result it
      // reviewed (see lib/reconcile.mjs's isReviewStale).
      developerJobId: devJobId,
      reviewLevel: REVIEW_LEVEL,
      routing: toJobRouting(reviewRouting),
      migrationAcceptedBaseline: goal.migrationAcceptedBaseline,
      executionBase, worktreeInitialHead: worktree.worktreeInitialHead,
      worktree: absWorktree, goalPath: goal.goalPath,
      changedFiles: changes.changedFiles, diffStat: changes.diffStat,
      implementationReport: lastDevResult.implementationReport,
      validations: lastDevResult.validations,
      previousBlockers: pendingBlockers.map(blockerText),
      packetPath,
    });

    const beforeReview = await captureSnapshot({ probe, worktreePath: absWorktree, fingerprint: worktreeFingerprint });

    machine.transitionTo(LOOP_STATES.REVIEWER_QUEUED);
    await store.writeRuntime({
      ...(await store.readRuntime()), state: machine.state, round,
      currentJobId: revJobId, ...withJobId(await store.readRuntime(), round, 'tech_lead', revJobId),
    });

    let revEnvelope;
    if (reviewAlreadyDone) {
      emit(`Tech Lead already completed ${revJobId} — reusing the persisted review. The model is NOT called again.`);
      machine.transitionTo(LOOP_STATES.REVIEWER_RUNNING);
      revEnvelope = await store.readResult('tech_lead', revJobId);
      await store.appendEvent({ type: 'JOB_RESULT_REUSED', role: 'tech_lead', jobId: revJobId, goal: goal.goalId, round });
    } else {
      assertNoDuplicateStageDispatch({
        ledger: reconciled.ledger, goal: goal.goalId, round, stage: STAGES.REVIEW, jobId: revJobId,
      });
      const dispatchedReview = await store.dispatchJob('tech_lead', revJob, {
        reason: 'RECOVERED_INTERRUPTED_ATTEMPT',
      });
      emit(dispatchMessage(dispatchedReview, 'Review'));
      if (dispatchedReview.outcome === JOB_DISPATCH.NEW_ATTEMPT) {
        await store.appendEvent({
          type: 'JOB_ATTEMPT_STARTED', role: 'tech_lead', jobId: revJobId,
          goal: goal.goalId, round, stage: STAGES.REVIEW, attempt: dispatchedReview.attempt,
        });
      }
      machine.transitionTo(LOOP_STATES.REVIEWER_RUNNING);
      emit('Waiting for the Tech Lead…');

      const revAttemptId = (await store.readAttemptState('tech_lead', revJobId))?.attemptId ?? null;
      emit(`  attempt: ${revAttemptId ?? 'unknown'}`);
      const observedReview = await waitForResult(store, 'tech_lead', revJobId, {
        emit, leaseStore, expectedAttemptId: revAttemptId,
        goal: goal.goalId, round, resultTimeoutMs: RESULT_TIMEOUT_MS,
      });
      if (observedReview.observerTimeout || observedReview.workerOffline) {
        await reportObserverStop({ store, emit, role: 'tech_lead', jobId: revJobId, observed: observedReview, goal: goal.goalId, round });
        return 0;
      }
      revEnvelope = observedReview.envelope;
    }
    const afterReview = await captureSnapshot({ probe, worktreePath: absWorktree, fingerprint: worktreeFingerprint });
    const revViolations = checkReviewerPolicy({ before: beforeReview, after: afterReview });

    if (revViolations.length > 0) {
      await store.appendEvent({ type: 'POLICY_VIOLATION', goal: goal.goalId, round, agent: 'tech_lead', violations: revViolations });
      emit('REVIEWER_MUTATED_WORKTREE — the review is not accepted.');
      machine.transitionTo(LOOP_STATES.HUMAN_REQUIRED);
      finalDecision = 'HUMAN_REQUIRED';
      finalReason = 'REVIEWER_MUTATED_WORKTREE';
      break;
    }

    if (!revEnvelope.ok) {
      emit(`Review failed: [${revEnvelope.code}] ${revEnvelope.message}`);
      machine.transitionTo(LOOP_STATES.HUMAN_REQUIRED);
      finalDecision = 'HUMAN_REQUIRED';
      finalReason = revEnvelope.code;
      break;
    }

    const decision = revEnvelope.result;
    emit(`Decision R${round}: ${decision.decision}`);
    emit('');
    roundsRun.push({ round, decision: decision.decision, blockers: decision.blockers.length, changedFiles: changes.changedFiles.length });

    await store.writeRuntime({
      ...(await store.readRuntime()),
      round, decision: decision.decision, blockers: decision.blockers,
      lastImplementationReport: lastDevResult.implementationReport,
    });

    // --- What follows -----------------------------------------------------
    const plan = planAfterReview({ decision: decision.decision, round });

    if (plan.action === 'CORRECT') {
      machine.transitionTo(LOOP_STATES.CHANGES_REQUIRED);
      machine.transitionTo(LOOP_STATES.CORRECTION_QUEUED);

      // The Tech Lead's escalation for the NEXT round, if it made one. Absent
      // means the correction keeps the profile it is on — the round number
      // decides nothing.
      pendingProfileEscalation = decision.nextDeveloperProfile
        ? { profile: decision.nextDeveloperProfile, reason: decision.nextDeveloperProfileReason ?? null }
        : null;
      if (pendingProfileEscalation) {
        emit(`Tech Lead selected ${pendingProfileEscalation.profile} for round ${plan.nextRound}.`);
        // Persisted before the next round starts, so a crash in between does
        // not lose the escalation and resume the correction on the old profile.
        await store.writeRuntime({
          ...(await store.readRuntime()),
          nextDeveloperProfile: { ...pendingProfileEscalation, round: plan.nextRound, selectedBy: 'tech_lead' },
        });
      }

      await store.appendEvent({
        type: 'CORRECTION_ROUND_STARTED', goal: goal.goalId,
        fromRound: round, toRound: plan.nextRound, blockers: decision.blockers.length,
        nextDeveloperProfile: decision.nextDeveloperProfile ?? null,
      });
      pendingBlockers = decision.blockers;
      round = plan.nextRound;
      startAsCorrection = true;
      // The machine is already in CORRECTION_QUEUED; the next iteration
      // transitions from there.
      continue;
    }

    finalDecision = plan.decision;
    finalReason = plan.reason;
    if (plan.reason === 'MAX_CORRECTION_ROUNDS_REACHED') {
      emit(plan.note);
      machine.transitionTo(LOOP_STATES.HUMAN_REQUIRED);
    } else {
      machine.transitionTo(stateForDecision(plan.decision));
    }
    break;
  }

  machine.transitionTo(LOOP_STATES.AWAITING_HUMAN);

  const previous = (await store.readRuntime()) ?? {};
  await store.writeRuntime({
    ...previous,
    state: machine.state,
    round,
    decision: finalDecision,
    escalationReason: finalReason,
    roundsRun,
    goalExecuted: true,
    goalCommitted: false,
    migrationBaselineUpdated: false,
    nextGoalCreated: false,
  });
  await store.appendEvent({
    type: 'SUPERVISED_STOP', goal: goal.goalId, state: machine.state,
    decision: finalDecision, reason: finalReason, rounds: roundsRun.length,
  });

  emit('State:');
  for (const t of machine.history) emit(`  ${t.from} -> ${t.to}`);
  emit('');
  emit(`Goal: ${goal.goalId}`);
  emit(`Final round: ${round}`);
  for (const r of roundsRun) emit(`  R${r.round}: ${r.decision} (${r.blockers} blockers, ${r.changedFiles} files)`);
  emit(`Worktree: ${worktree.path} (branch ${worktree.branch})`);
  emit(`Migration baseline: ${goal.migrationAcceptedBaseline}`);
  emit(`Execution base (original): ${executionBase}`);
  emit(`Decision: ${finalDecision}`);
  if (finalReason) emit(`Reason: ${finalReason}`);

  const lastRound = roundsRun[roundsRun.length - 1];
  if (lastRound && lastRound.blockers > 0) {
    const runtime = await store.readRuntime();
    emit('Blockers:');
    for (const b of runtime.blockers ?? []) emit(`  - ${blockerText(b)}`);
  }

  // What the router chose, and what it cost. Derived from the events written
  // when each decision was taken, so this reports the run rather than a
  // running total someone kept.
  emit('');
  for (const line of renderRoutingSummary(summarizeRouting(await store.readEvents(), { goal: goal.goalId }))) {
    emit(line);
  }

  emit('');
  emit(`State: ${machine.state}`);
  emit('');
  emit('Goal committed: NO');
  emit('Migration baseline updated: NO');
  emit('Next Goal created: NO');
  emit('Worktree kept for human inspection.');

  return 0;
}

/**
 * Reports that the OBSERVER stopped watching, leaving the job untouched.
 *
 * Nothing is failed, nothing is released, nothing is re-queued: the attempt
 * keeps ownership and `ia-loop:resume` re-attaches to it.
 */
async function reportObserverStop({ store, emit, role, jobId, observed, goal, round }) {
  await store.appendEvent({
    type: 'OBSERVER_STOPPED', goal, round, role, jobId,
    reason: observed.workerOffline ? 'WORKER_OFFLINE' : 'OBSERVER_TIMEOUT',
    leaseStatus: observed.leaseStatus ?? null,
  });

  emit('');
  emit(observed.workerOffline
    ? `The ${role} worker is no longer heartbeating.`
    : `Stopped observing ${jobId} after the observer window.`);
  emit('');
  emit('The job was NOT failed and NOT re-queued. The attempt keeps its lease.');
  if (observed.lease) {
    emit(`  attempt: ${observed.lease.attemptId} · lease: ${observed.leaseStatus} `
      + `(heartbeat ${Math.round((observed.leaseAgeMs ?? 0) / 1000)}s ago)`);
  }
  emit('');
  emit('Check with:  npm run ia-loop:status');
  emit('Re-attach with:  npm run ia-loop:resume');
}

/** Blockers may be plain strings or structured records; both must render. */
/**
 * Asks the standard model which of the Goal's numbered items this diff covers.
 *
 * Runs before the review and reports into its packet. It is a cheap reading of
 * the diff against a written specification, NOT a second review: it answers one
 * question per item and points at evidence.
 *
 * Returns null whenever it cannot answer — no requirements parsed out of the
 * Goal document, the worker refused, the call failed. Every one of those is a
 * missing convenience, and the caller treats it as such.
 */
async function assessCriteriaCoverage({ store, goal, round, changes, worktree, emit, leaseStore }) {
  const goalText = await fs.readFile(goal.goalPath, 'utf8').catch(() => '');
  const requirements = extractGoalRequirements(goalText);
  if (requirements.length === 0) {
    emit('  cobertura de critérios: o documento não declara itens numerados; nada a apurar.');
    return null;
  }

  const jobId = store.newJobId(goal.goalId, round, 'tech_lead');
  emit(`Cobertura de critérios: ${requirements.length} item(ns) → ${jobId}`);

  await store.publishJob('tech_lead', {
    protocolVersion: PROTOCOL_VERSION_V2,
    jobId, role: 'tech_lead', type: 'CRITERIA_COVERAGE',
    goal: goal.goalId, round,
    worktree,
    coverageContext: {
      requirements,
      changedFiles: changes.changedFiles,
      diffStat: changes.diffStat,
      diff: changes.diff,
    },
  });

  // `waitForResult` returns an OBSERVATION — `{ envelope, observerTimeout,
  // workerOffline }` — not the envelope. Reading `.ok` off the observation
  // made every coverage answer look unusable: both calls of Goal024 produced
  // forty-five valid verdicts and both were thrown away here, so the reviewer
  // saw "não apurada" while the work sat completed on disk.
  const observed = await waitForResult(store, 'tech_lead', jobId, {
    emit, leaseStore, goal: goal.goalId, round,
  });
  if (observed?.observerTimeout || observed?.workerOffline) {
    emit('  cobertura de critérios: o worker não respondeu; seguindo sem ela.');
    return null;
  }

  const envelope = observed?.envelope;
  if (!envelope?.ok) {
    emit(`  cobertura de critérios: sem resposta utilizável (${envelope?.code ?? 'desconhecido'}).`);
    return null;
  }

  // The envelope carries `{ ok, result }`; the coverage itself is the inner
  // `result`, which is what `buildReviewPacket` renders.
  return { result: envelope.result, declared: requirements.length };
}

function blockerText(blocker) {
  if (typeof blocker === 'string') return blocker;
  const id = blocker.id ? `${blocker.id}: ` : '';
  const severity = blocker.severity ? `[${blocker.severity}] ` : '';
  const scope = blocker.correctionScope ? ` — escopo: ${blocker.correctionScope}` : '';
  return `${severity}${id}${blocker.description ?? JSON.stringify(blocker)}${scope}`;
}

// Only when this file IS the program. Importing it — from a test, a doc
// generator, or an agent reading the tooling — must never start anything.
if (isDirectExecution(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch(async (error) => {
      const code = error instanceof SpikeError ? error.code : 'UNEXPECTED_ERROR';
      // A state-machine defect (INVALID_TRANSITION and friends) is never a
      // fact about the Goal, so it must never read as UNKNOWN_FATAL to
      // run-auto.mjs — a separate process that only sees this exit code and
      // whatever is on disk. Best-effort: a failure to record this must never
      // hide the ORIGINAL error.
      await recordOrchestratorFault(store, { goal: currentGoalId, error }).catch(() => {});
      console.error(`\nIA Loop — Goal Runner\n\nBlocker: [${code}] ${error.message}\n\nOverall:\nFAIL`);
      process.exitCode = 1;
    });
}
