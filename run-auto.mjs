#!/usr/bin/env node
/**
 * IA Loop — autonomous goal-to-goal execution.
 *
 *   npm run ia-loop:auto -- --from 004
 *   npm run ia-loop:auto              (continues an existing run)
 *
 * Carries the migration forward without a human in the normal path:
 *
 *   Goal READY → Developer → review → corrections → ACCEPTED → closure
 *   → commit → integration → new baseline → planning → next Goal → repeat
 *
 * It stops only for a real reason: a condition that needs a person, a requested
 * pause, or the migration being declared complete.
 *
 * Each phase runs as its own process, reusing run-goal and run-close unchanged.
 * That keeps every guarantee already proven — leases, snapshots, idempotency —
 * instead of reimplementing them here.
 */

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SpikeError } from './lib/claude-process.mjs';
import { createJobStore } from './lib/job-store.mjs';
import { discoverGoal, parseMigrationStatus } from './lib/goal-discovery.mjs';
import { evaluateGoalBoundary } from './lib/goal-boundary.mjs';
import { createGitProbe } from './lib/git-ops.mjs';
import { readWorkerHealth, WORKER_HEALTH } from './lib/worker-registry.mjs';
import {
  RUN_STATUS,
  createAutonomousStore,
  isCapacityWait,
  requiresHuman,
  shouldPauseAt,
} from './lib/autonomous-state.mjs';
import { RECONCILIATION_ACTIONS, reconcileCampaignPosition } from './lib/campaign-reconciliation.mjs';
import { goalExecutionOf, initializeGoalExecutionState, staleGoalPointers } from './lib/goal-execution.mjs';
import { LOOP_STATES } from './lib/loop-state.mjs';
import { startLeaseHeartbeat } from './lib/leases.mjs';
import { createHandoffStore } from './lib/recovery-handoff.mjs';
import { readFile } from 'node:fs/promises';
import { isDirectExecution } from './lib/direct-execution.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE);
const STATE_DIR = join(HERE, '.state');

const probe = createGitProbe(REPO_ROOT);

/**
 * The boundary between two Goals, made explicit.
 *
 *   FINALIZE → ARCHIVE → INITIALIZE → DISPATCH
 *
 * Until V7 this was a single line — move the run's pointer to the next Goal —
 * and the execution state stayed exactly as the closed Goal left it. `run-goal`
 * then read it as a hint for Goal 005 and dispatched `004-r1-developer-…`, an
 * attempt already SUPERSEDED, so the store refused it and the run stopped as if
 * Goal 005 had failed. Nothing of Goal 005 had run.
 *
 * Crossing is idempotent: it is safe to call again after a crash between the
 * closure of one Goal and the start of the next, and does nothing at all once
 * the next Goal's execution state is already on disk.
 */
async function crossGoalBoundary({ store, fromGoal, toGoal, baseline, runId, emit }) {
  const runtime = await store.readRuntime();

  if (goalExecutionOf(runtime, toGoal)) {
    // Already crossed — a restart landing here must not rewind the Goal that
    // has since started working.
    return { crossed: false, reason: 'ALREADY_INITIALIZED' };
  }

  const leaked = staleGoalPointers(runtime, toGoal);
  const archived = await store.archiveGoalExecution(runtime);
  await store.appendEvent({
    type: 'GOAL_EXECUTION_ARCHIVED',
    autonomousRunId: runId, previousGoal: fromGoal, nextGoal: toGoal,
    baseline, archived: archived.archived, reason: archived.reason ?? null,
  });

  await store.writeRuntime(initializeGoalExecutionState({
    previousRuntime: runtime,
    goal: toGoal,
    execution: {
      // The next Goal is READY and nothing has been attempted for it. run-goal
      // takes it from here and owns every later transition.
      state: LOOP_STATES.GOAL_READY,
      migrationAcceptedBaseline: baseline,
      // The worktree of the next Goal is not this boundary's business: it is
      // planned, verified and created by run-goal, which is the only place
      // allowed to decide between reuse and creation.
      executionBase: null, worktreePath: null, worktreeInitialHead: null,
    },
  }));

  await store.appendEvent({
    type: 'NEXT_GOAL_EXECUTION_INITIALIZED',
    autonomousRunId: runId, previousGoal: fromGoal, nextGoal: toGoal,
    baseline, round: 1,
  });

  if (leaked.length > 0) {
    emit(`Goal ${fromGoal} execution archived; ${leaked.length} pointer(s) retired with it.`);
  }
  return { crossed: true, leaked };
}

/**
 * Every failure between taking the loop lease and entering the main try block
 * goes through here.
 *
 * A run that threw before its own try once left attach()'s lease behind and
 * locked the loop out of itself. One exit means one place to get right, instead
 * of a rule each new throw has to remember.
 *
 * It releases WITHOUT force, on purpose. The forced version released whatever
 * lease was on disk, including one belonging to another process — so refusing
 * to start because someone else owned the loop also deleted their lease. That
 * turned "another orchestrator owns this" into "nobody owns this" in the same
 * breath, which is exactly the contradiction that stranded a recovered run.
 * A non-owner release throws LEASE_NOT_OWNED, which is the correct no-op here.
 */
async function failAfterAttach(auto, code, message) {
  await auto.releaseLoopLease().catch(() => {});
  throw new SpikeError(code, message);
}
const emit = (line = '') => console.log(line);

function parseArgs(argv) {
  const args = argv.slice(2);
  const valueOf = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] ?? null : null;
  };
  return {
    fromGoal: valueOf('--from'),
    // Declaring a HUMAN_REQUIRED stop resolved is a person's decision, stated
    // explicitly and recorded. The loop can never do it for itself.
    resolvedNote: valueOf('--resolved'),
  };
}

/** Runs one phase as a child process, inheriting stdio so progress is visible. */
function runPhase(script, args) {
  return new Promise((resolvePhase) => {
    const child = spawn(process.execPath, [join(HERE, script), ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, IA_LOOP_AUTONOMOUS: '1' },
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('close', (code) => resolvePhase({ code }));
    child.on('error', (error) => resolvePhase({ code: 1, error }));
  });
}

/**
 * Gathers the facts a Goal boundary is judged on. The judgement itself lives in
 * lib/goal-boundary.mjs so it can be tested without a repository.
 */
async function goalBoundaryPreflight({ goalId, expectedBaseline }) {
  let discoveryError = null;
  const goal = await discoverGoal({
    repoRoot: REPO_ROOT, goalId, resolveSha: (sha) => probe.commitExists(sha),
  }).catch((error) => { discoveryError = error.message; return null; });

  const dirtyFiles = await probe.isDirty() ? await probe.relevantDirtyFiles() : [];

  const { problems, resuming } = evaluateGoalBoundary({
    goalId,
    goal,
    discoveryError,
    expectedBaseline,
    dirtyFiles,
    branchExists: await probe.branchExists(`ai-loop/goal-${goalId}`),
    worktreeExists: await probe.pathExists(`.ai-worktrees/goal-${goalId}`),
  });

  return { goal, problems, resuming };
}

async function main() {
  const { fromGoal, resolvedNote } = parseArgs(process.argv);
  const store = createJobStore(STATE_DIR);
  const auto = createAutonomousStore(STATE_DIR);
  const handoffs = createHandoffStore(STATE_DIR);

  emit('');
  emit('ATENDLY IA LOOP — AUTONOMOUS');
  emit('');

  // Both workers must be up: they are the execution interface.
  const [tl, dev] = await Promise.all([
    readWorkerHealth(store, 'tech_lead'), readWorkerHealth(store, 'developer'),
  ]);
  if (tl.health === WORKER_HEALTH.OFFLINE || dev.health === WORKER_HEALTH.OFFLINE) {
    throw new SpikeError('WORKERS_NOT_RUNNING',
      'Both workers must be running: npm run ia-loop:tech-lead and npm run ia-loop:developer');
  }

  // --- Acquire or re-attach to the run ------------------------------------
  let run;
  /** A retired run's pause intent, so `--from` does not silently disarm it. */
  let retiredPauseIntent = null;
  const attached = await auto.attach();

  if (attached && !attached.attached) {
    if (attached.reason === 'RECOVERY_REQUIRED') {
      await failAfterAttach(auto, 'RECOVERY_REQUIRED',
        `Run ${attached.run.autonomousRunId} left a lease whose holder is not heartbeating. `
        + 'Starting here would assume the old orchestrator is dead. Run ia-loop:recover, which proves it first.');
    }

    await failAfterAttach(auto, 'AUTONOMOUS_RUN_ALREADY_ACTIVE',
      `Run ${attached.lease?.autonomousRunId ?? attached.run.autonomousRunId} owns the loop. `
      + 'A second orchestrator would race it for Goals.');
  }

  if (attached?.attached) {
    run = attached.run;
    emit(`Re-attached to run ${run.autonomousRunId} (started ${run.startedAt}).`);

    // --- A run that was recovered is picked up, never replaced -------------
    //
    // status RUNNING means the campaign is unfinished, not that a process is
    // driving it. When recovery has proven the previous orchestrator gone and
    // left a handoff, this process becomes the new orchestrator OF THE SAME
    // RUN: same id, same history, a later attempt.
    const check = await handoffs.validateFor(run.autonomousRunId);
    if (check.handoff && !check.valid && check.reason !== 'HANDOFF_ALREADY_CONSUMED') {
      // A handoff that does not belong here is never "close enough".
      await store.appendEvent({
        type: 'ORCHESTRATOR_ATTACH_FAILED', runId: run.autonomousRunId,
        reason: check.reason, handoffRunId: check.handoff.autonomousRunId ?? null,
      });
      await failAfterAttach(auto, 'RECOVERY_HANDOFF_INVALID',
        `A recovery handoff is on disk but does not apply here (${check.reason}). `
        + 'Run ia-loop:recover to produce one for this run, rather than guessing.');
    }

    if (check.valid) {
      const lease = await auto.readLoopLease();
      await store.appendEvent({
        type: 'ORCHESTRATOR_ATTACH_STARTED', runId: run.autonomousRunId,
        goal: check.handoff.goal, round: check.handoff.round,
        recoveryAttempt: check.handoff.recoveryAttempt,
        orchestratorAttempt: lease?.attemptId ?? null,
        previousOwner: check.handoff.supersededOwner, newOwner: lease?.workerInstanceId ?? null,
        nextSafeAction: check.handoff.nextSafeAction,
      });

      const consumed = await handoffs.consume({
        nonce: check.handoff.nonce, consumedBy: lease?.workerInstanceId ?? null,
      });
      if (!consumed.consumed) {
        await store.appendEvent({
          type: 'ORCHESTRATOR_ATTACH_FAILED', runId: run.autonomousRunId, reason: consumed.reason,
        });
        await failAfterAttach(auto, 'ORCHESTRATOR_ALREADY_ATTACHED',
          `Another orchestrator consumed this recovery handoff first (${consumed.reason}).`);
      }

      emit('');
      emit(`ATTACH EXISTING RUN: ${run.autonomousRunId}`);
      emit('  Owner: NONE / RECOVERED');
      emit(`  Recovery: VALID (from ${check.handoff.recoveredFromState}${check.handoff.proof ? `, ${check.handoff.proof}` : ''})`);
      emit(`  Attaching orchestrator: ${lease?.attemptId ?? 'unknown attempt'}`);
      emit(`  Next safe action: ${check.handoff.nextSafeAction}${check.handoff.jobId ? ` — ${check.handoff.jobId}` : ''}`);
      emit('');

      await store.appendEvent({
        type: 'ORCHESTRATOR_ATTACH_SUCCEEDED', runId: run.autonomousRunId,
        goal: check.handoff.goal, round: check.handoff.round,
        orchestratorAttempt: lease?.attemptId ?? null, newOwner: lease?.workerInstanceId ?? null,
        nextSafeAction: check.handoff.nextSafeAction,
      });
      await store.appendEvent({
        type: 'RECOVERED_RUN_RESUMED', runId: run.autonomousRunId,
        goal: check.handoff.goal, round: check.handoff.round,
        recoveryAttempt: check.handoff.recoveryAttempt, nextSafeAction: check.handoff.nextSafeAction,
      });

      // The operational checkpoint of main moves with the attach; the Goal's
      // execution base does not.
      const runtimeNow = await store.readRuntime();
      const mainHead = await probe.head().catch(() => null);
      if (mainHead) {
        await store.writeRuntime({
          ...runtimeNow,
          mainGuardCheckpoint: {
            head: mainHead, at: new Date().toISOString(), reason: 'ORCHESTRATOR_ATTACH',
            note: 'operational checkpoint, not the execution base',
          },
        });
      }
    }
    if (run.status === RUN_STATUS.PAUSED) {
      run = await auto.clearPause();
      await store.appendEvent({ type: 'AUTONOMOUS_RUN_RESUMED', autonomousRunId: run.autonomousRunId });
      emit('Resuming from PAUSED.');
    }
    if (run.status === RUN_STATUS.PAUSED_FOR_HUMAN) {
      // Resume must not walk past an unresolved problem — only an explicit
      // human statement that it was resolved retires the stopped run.
      if (!resolvedNote) {
        await failAfterAttach(auto, 'HUMAN_REQUIRED',
          `Run ${run.autonomousRunId} is stopped for a human: ${run.humanRequired?.reason}. `
          + 'Resolve it, then start a new run with --from <goal> --resolved "<what was resolved>".');
      }
      const archived = await auto.archiveRun({ resolvedBy: 'operator', note: resolvedNote });
      // attach() took the loop lease for the retired run; the new run claims
      // its own, so this one has to go first.
      await auto.releaseLoopLease();
      await store.appendEvent({
        type: 'AUTONOMOUS_RUN_ARCHIVED', autonomousRunId: archived.autonomousRunId,
        reason: archived.humanRequired?.reason ?? null, note: resolvedNote,
      });
      emit(`Run ${archived.autonomousRunId} retired: ${resolvedNote}`);
      // The operator armed the stop against the campaign, not against this run
      // id, so it travels to the run that replaces this one.
      retiredPauseIntent = archived;
      if (archived.pauseRequested) {
        emit(`  Pause intent carried over: ${archived.pauseAfterGoal ? 'after the current Goal' : 'at the next safe boundary'}.`);
      }
      run = null;
    }
  }

  // A fresh run: no run existed, or the stopped one was just retired.
  if (!run) {
    const migrationText = await readFile(join(REPO_ROOT, 'docs/migration/MIGRATION_STATUS.md'), 'utf8');
    const { acceptedBaseline } = parseMigrationStatus(migrationText);
    const startGoal = fromGoal ?? null;
    if (!startGoal) {
      await failAfterAttach(auto, 'INVALID_ARGS', 'Pass --from <goalId> to start a new autonomous run');
    }

    run = await auto.start({
      fromGoal: startGoal,
      migrationAcceptedBaseline: acceptedBaseline,
      inheritPause: retiredPauseIntent,
    });
    await store.appendEvent({
      type: 'AUTONOMOUS_RUN_STARTED', autonomousRunId: run.autonomousRunId,
      fromGoal: startGoal, baseline: acceptedBaseline,
    });
    emit(`Started run ${run.autonomousRunId} from Goal ${startGoal}.`);
  }

  // The loop lease is renewed for as long as this orchestrator lives.
  const stopLeaseHeartbeat = startLeaseHeartbeat(auto.leases, { jobId: 'migration-loop' });
  const finish = async () => { await stopLeaseHeartbeat(); await auto.releaseLoopLease().catch(() => {}); };

  // Ctrl+C used to leave the loop lease behind: the finally block never runs
  // when the process is signalled, so the lease aged into a suspected orphan
  // and the next run had to prove a death that had not happened.
  //
  // Only THIS lease is given back, and only without force. The loop lease
  // governs decisions, not writes in flight — an agent mid-inference keeps its
  // own job and worktree leases, which is what stops a second writer. Those
  // are deliberately not touched here: a signal to the orchestrator says
  // nothing about whether a child model process has stopped writing.
  let shuttingDown = false;
  const onSignal = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    emit(`\nStopping on ${signal}. Giving the loop lease back; work in flight keeps its own leases.`);
    void finish()
      .then(() => store.appendEvent({
        type: 'ORCHESTRATOR_SHUTDOWN', signal,
        runId: run?.autonomousRunId ?? null, goal: run?.currentGoal ?? null,
      }))
      .catch(() => {})
      .finally(() => { process.exit(130); });
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  emit(`Baseline: ${run.migrationAcceptedBaseline}`);
  emit('');

  try {
    // ===================== The loop ========================================
    for (;;) {
      // Before the boundary is judged: did the Goal this run is pointing at
      // already close without it? A closure integrated into HEAD that names the
      // next Goal is evidence, not ambiguity, and the record can catch up.
      // Without this the run stops as GOAL_BOUNDARY_AMBIGUOUS and stays stopped,
      // because nothing but this loop ever writes the campaign position.
      const recordedClosure = (await store.readRuntime())?.closure ?? null;
      const reconciliation = reconcileCampaignPosition({
        run,
        closure: recordedClosure,
        closureIntegrated: await probe
          .isAncestorOfHead(recordedClosure?.integratedClosureCommit)
          .catch(() => false),
      });
      if (reconciliation.action === RECONCILIATION_ACTIONS.ADVANCE) {
        run = await auto.recordGoalCompleted(reconciliation.completedGoal, reconciliation.baseline);
        run = await auto.setCurrentGoal(reconciliation.nextGoal);
        await store.appendEvent({
          type: 'CAMPAIGN_POSITION_RECONCILED', autonomousRunId: run.autonomousRunId,
          goal: reconciliation.completedGoal, nextGoal: reconciliation.nextGoal,
          baseline: reconciliation.baseline, evidence: reconciliation.evidence,
        });
        emit(`Goal ${reconciliation.completedGoal} closed outside this run; `
          + `campaign moved to Goal ${reconciliation.nextGoal} (${reconciliation.evidence}).`);
      }

      const goalId = run.currentGoal;
      emit('');
      emit(`══ Goal ${goalId} ══`);

      // --- Boundary preflight ---------------------------------------------
      const preflight = await goalBoundaryPreflight({
        goalId, expectedBaseline: run.migrationAcceptedBaseline,
      });
      if (preflight.problems.length > 0) {
        await auto.markHumanRequired('GOAL_BOUNDARY_AMBIGUOUS', preflight.problems.join(' | '));
        await store.appendEvent({
          type: 'AUTONOMOUS_RUN_HUMAN_REQUIRED', autonomousRunId: run.autonomousRunId,
          goal: goalId, reason: 'GOAL_BOUNDARY_AMBIGUOUS', problems: preflight.problems,
        });
        emit('Goal boundary is ambiguous; stopping instead of guessing:');
        for (const p of preflight.problems) emit(`  - ${p}`);
        return 1;
      }

      // --- The Goal boundary ------------------------------------------------
      //
      // Crossed here rather than at the moment the pointer moved, because this
      // is the point every path reaches: continuing automatically, resuming
      // from a pause, and restarting after a crash between one Goal's closure
      // and the next Goal's start. It is idempotent, so arriving twice costs
      // nothing and rewinds nothing.
      const runtimeBefore = await store.readRuntime();
      if (runtimeBefore?.goal && runtimeBefore.goal !== goalId) {
        await crossGoalBoundary({
          store, fromGoal: runtimeBefore.goal, toGoal: goalId,
          baseline: run.migrationAcceptedBaseline, runId: run.autonomousRunId, emit,
        });
        emit(`Goal ${runtimeBefore.goal} execution closed. Goal ${goalId} starts at round 1 with no inherited state.`);
      }

      await store.appendEvent({ type: 'GOAL_STARTED', autonomousRunId: run.autonomousRunId, goal: goalId });

      // --- Implementation, review and corrections --------------------------
      const goalPhase = await runPhase('run-goal.mjs', [goalId]);
      const runtimeAfterGoal = await store.readRuntime();
      // A decision counts only if it belongs to the Goal that just ran. Reading
      // one left by an earlier Goal is how a loop congratulates itself for work
      // it did not do.
      const decision = runtimeAfterGoal?.goal === goalId ? (runtimeAfterGoal.decision ?? null) : null;

      if (goalPhase.code !== 0 || decision !== 'ACCEPTED') {
        const reason = runtimeAfterGoal?.escalationReason ?? decision ?? 'UNKNOWN_FATAL';

        if (isCapacityWait(reason)) {
          // Never an intervention: the workers wait it out themselves.
          emit(`Waiting for capacity (${reason}); the run stays active.`);
          continue;
        }

        const humanReason = requiresHuman(reason) ? reason
          : decision === 'HUMAN_REQUIRED' ? 'REVIEWER_ASKED_FOR_HUMAN'
            : 'UNKNOWN_FATAL';
        await auto.markHumanRequired(humanReason, `Goal ${goalId} ended as ${decision ?? 'failed'}`);
        await store.appendEvent({
          type: 'AUTONOMOUS_RUN_HUMAN_REQUIRED', autonomousRunId: run.autonomousRunId,
          goal: goalId, reason: humanReason,
        });
        emit('');
        emit(`Goal ${goalId} needs a human: ${humanReason}`);
        return 1;
      }

      await store.appendEvent({ type: 'GOAL_ACCEPTED', autonomousRunId: run.autonomousRunId, goal: goalId });
      emit(`Goal ${goalId}: ACCEPTED`);

      // Safe boundary: after a decision, before any further inference.
      const pauseAfterDecision = shouldPauseAt(await auto.read(), { boundary: 'AFTER_DECISION' });
      if (pauseAfterDecision.pause) {
        await auto.markPaused(pauseAfterDecision.reason);
        await store.appendEvent({ type: 'AUTONOMOUS_RUN_PAUSED', autonomousRunId: run.autonomousRunId, boundary: 'AFTER_DECISION' });
        emit('Paused at a safe boundary, after the review decision.');
        return 0;
      }

      // --- Closure, integration and planning -------------------------------
      const closePhase = await runPhase('run-close.mjs', [goalId]);
      const runtimeAfterClose = await store.readRuntime();
      // Same rule for the closure: a closure record for another Goal proves
      // nothing about this one, and its baseline would be the wrong one.
      const recorded = runtimeAfterClose?.closure ?? {};
      const closure = recorded.goal === goalId ? recorded : {};

      if (closePhase.code !== 0) {
        const reason = runtimeAfterClose?.humanRequired?.reason ?? 'UNKNOWN_FATAL';
        if (isCapacityWait(reason)) { emit('Waiting for capacity during closure.'); continue; }

        await auto.markHumanRequired(requiresHuman(reason) ? reason : 'UNKNOWN_FATAL',
          `Closure of Goal ${goalId} did not complete`);
        await store.appendEvent({
          type: 'AUTONOMOUS_RUN_HUMAN_REQUIRED', autonomousRunId: run.autonomousRunId,
          goal: goalId, reason, phase: 'CLOSURE',
        });
        emit(`Closure of Goal ${goalId} needs a human: ${reason}`);
        return 1;
      }

      const newBaseline = closure.newMigrationBaseline ?? runtimeAfterClose?.migrationAcceptedBaseline;
      run = await auto.recordGoalCompleted(goalId, newBaseline);
      await store.appendEvent({
        type: 'MIGRATION_BASELINE_UPDATED', autonomousRunId: run.autonomousRunId,
        goal: goalId, baseline: newBaseline,
      });
      emit(`Goal ${goalId} closed. New baseline: ${newBaseline}`);

      // --- What did planning decide? ---------------------------------------
      if (closure.migrationComplete) {
        await auto.markCompleted(closure.migrationCompleteReason ?? 'Declared by the Tech Lead');
        await store.appendEvent({ type: 'MIGRATION_COMPLETE', autonomousRunId: run.autonomousRunId, goal: goalId });
        emit('');
        emit('MIGRATION COMPLETE — declared by the Tech Lead and verified against the repository.');
        return 0;
      }

      const nextGoalId = closure.nextGoalId;
      if (!nextGoalId) {
        // Absence of a next Goal is never read as completion.
        await auto.markHumanRequired('BASELINE_INCONSISTENT',
          'Planning produced neither a next Goal nor an explicit MIGRATION_COMPLETE');
        emit('Planning produced no next Goal and did not declare completion; stopping.');
        return 1;
      }

      // Safe boundary: the whole Goal is finished and the tree is inspectable.
      const pauseAfterGoal = shouldPauseAt(await auto.read(), { boundary: 'GOAL_BOUNDARY' });
      if (pauseAfterGoal.pause) {
        run = await auto.setCurrentGoal(nextGoalId);
        await auto.markPaused(pauseAfterGoal.reason);
        await store.appendEvent({ type: 'AUTONOMOUS_RUN_PAUSED', autonomousRunId: run.autonomousRunId, boundary: 'GOAL_BOUNDARY' });
        emit(`Paused after Goal ${goalId}. The next Goal (${nextGoalId}) is READY and will start on resume.`);
        return 0;
      }

      await store.appendEvent({
        type: 'GOAL_TRANSITION', autonomousRunId: run.autonomousRunId,
        from: goalId, to: nextGoalId, baseline: newBaseline,
      });
      run = await auto.setCurrentGoal(nextGoalId);
      emit(`→ Continuing automatically with Goal ${nextGoalId}.`);
    }
  } finally {
    await finish();
  }
}

// Only when this file IS the program. Importing it — from a test, a doc
// generator, or an agent reading the tooling — must never start anything.
if (isDirectExecution(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      const code = error instanceof SpikeError ? error.code : 'UNEXPECTED_ERROR';
      console.error(`\nATENDLY IA LOOP — AUTONOMOUS\n\nBlocker: [${code}] ${error.message}`);
      process.exitCode = 1;
    });
}
