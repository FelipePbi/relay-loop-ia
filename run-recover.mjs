#!/usr/bin/env node
/**
 * IA Loop — recovery after a process restart.
 *
 *   npm run ia-loop:recover            inspect and recover
 *   npm run ia-loop:recover -- --dry-run   inspect only, change nothing
 *
 * For the case a crash actually leaves behind: the machine rebooted, the
 * terminal was closed, the orchestrator was killed. The lease is still on disk,
 * its heartbeat has aged, the runtime still says an agent was running, and
 * nothing can move.
 *
 * This is deliberately NOT ia-loop:resume. Resume is for a run parked by a
 * usage limit, where nothing was interrupted and the deadline decides when work
 * continues. Recovery is for a run whose owner disappeared. Folding them
 * together would make "the model is rate-limited" and "the process died" the
 * same event, and they need opposite answers.
 *
 * It never deletes a lease to get moving. A lease is taken over only when the
 * old holder is PROVEN unable to write again, and the swap is atomic.
 *
 * It calls no model, and never resolves a human gate.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SpikeError } from './lib/claude-process.mjs';
import { createJobStore, isClaimableJobStatus } from './lib/job-store.mjs';
import { createLeaseStore } from './lib/leases.mjs';
import { createAutonomousStore, LOOP_LEASE_KEY } from './lib/autonomous-state.mjs';
import { createProcessInspector } from './lib/process-inspector.mjs';
import { OWNER_STATUS, collectOwnerEvidence, isRecoveryEligible, judgeOwner } from './lib/orphan-evidence.mjs';
import { RECOVERY_ACTIONS, planRecovery, resolveRecoveryJob, stageForState } from './lib/recovery-plan.mjs';
import { reconcileExecutionState } from './lib/reconcile.mjs';
import { STAGES } from './lib/stage-identity.mjs';
import { LOOP_CONFIG } from './lib/loop-config.mjs';
import { createHandoffStore, handoffCovers } from './lib/recovery-handoff.mjs';
import { readRuntimeStrict } from './lib/capacity-state.mjs';
import { createGitProbe } from './lib/git-ops.mjs';
import { isDirectExecution } from './lib/direct-execution.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, '.state');
const REPO_ROOT = join(HERE);

const emit = (line = '') => console.log(line);

function parseArgs(argv) {
  const args = argv.slice(2);
  return { dryRun: args.includes('--dry-run') };
}

/** The next command to run, once the state is consistent again. */
function continuationFor() {
  // Every phase continues the same way: the orchestrator attaches to the
  // recovered run and takes it from there.
  return 'npm run ia-loop:auto';
}

async function main() {
  const { dryRun } = parseArgs(process.argv);
  const store = createJobStore(STATE_DIR);
  const leaseStore = createLeaseStore(STATE_DIR);
  const auto = createAutonomousStore(STATE_DIR);
  const handoffs = createHandoffStore(STATE_DIR);
  const inspector = createProcessInspector();

  const runtime = await readRuntimeStrict(store);
  const autonomousRun = await auto.read();
  const lease = await leaseStore.readJobLease(LOOP_LEASE_KEY);
  const now = Date.now();

  emit('');
  emit('ATENDLY IA LOOP — RECOVERY');
  emit('');
  emit(`Goal: ${runtime?.goal ?? 'n/a'}`);
  emit(`Round: ${runtime?.round ?? 'n/a'}`);
  emit(`Stored state: ${runtime?.state ?? 'n/a'}`);
  if (autonomousRun) emit(`Autonomous run: ${autonomousRun.autonomousRunId} (${autonomousRun.status})`);
  emit('');

  // --- Who held the loop, and can they still write? -------------------------
  let verdict = null;
  if (lease) {
    emit('Lease:');
    emit(`  Owner: ${lease.workerInstanceId ?? 'unknown'}`);
    emit(`  Attempt: ${lease.attemptId ?? 'not recorded (lease predates attempt ids)'}`);
    emit(`  Last heartbeat: ${lease.heartbeatAt}`);
    emit('');
    emit('Checking previous owner…');

    const evidence = await collectOwnerEvidence(lease, inspector, { now });
    verdict = judgeOwner({ lease, evidence, now });

    emit(`  Process ${evidence.leasePid ?? '?'}: ${evidence.pidLiveness ?? 'not checked'}`);
    emit(`  Boot: lease ${lease.acquiredAt} · machine booted ${evidence.currentBootAt}`);
    emit('');
    emit(`${verdict.status}${verdict.proof ? ` (${verdict.proof})` : ''}`);
    emit(`  ${verdict.detail}`);
    emit('');

    // Recorded only when we are actually acting: --dry-run writes nothing,
    // not even history, so it is safe to run at any moment.
    if (!dryRun) await store.appendEvent({
      type: verdict.status === OWNER_STATUS.ORPHAN_CONFIRMED
        ? 'ORCHESTRATOR_ORPHAN_CONFIRMED' : 'ORCHESTRATOR_ORPHAN_SUSPECTED',
      goal: runtime?.goal ?? null,
      round: runtime?.round ?? null,
      state: runtime?.state ?? null,
      runId: autonomousRun?.autonomousRunId ?? null,
      attemptId: lease.attemptId ?? null,
      owner: lease.workerInstanceId ?? null,
      proof: verdict.proof ?? null,
      detail: verdict.detail,
    });
  } else {
    emit('Lease: none on disk.');
    emit('');
  }

  // --- What is actually finished, and what is genuinely left? ---------------
  //
  // Read from the results, never from currentJobId. That pointer is exactly
  // what a crash leaves aimed at the wrong thing — here it points at a
  // duplicate attempt that should never have been published, and trusting it
  // would make the duplicate more authoritative than the original result.
  const reconciled = await reconcileExecutionState({
    store, goal: runtime?.goal, maxRounds: LOOP_CONFIG.maxCorrectionRounds,
  }).catch(() => null);

  if (reconciled) {
    emit('Stages on disk:');
    for (const stage of [...reconciled.ledger.values()].sort((a, b) => a.stageKey.localeCompare(b.stageKey))) {
      const decision = stage.result?.decision ? ` — ${stage.result.decision}` : '';
      const blockers = Array.isArray(stage.result?.blockers) && stage.result.blockers.length > 0
        ? ` (${stage.result.blockers.length} blocker(s))` : '';
      emit(`  ${stage.stageKey}: ${stage.status}${stage.completedBy ? ` — ${stage.completedBy}` : ''}${decision}${blockers}`);
    }
    for (const duplicate of reconciled.duplicates) {
      emit(`  DUPLICATE ATTEMPT: ${duplicate.jobId} — ${duplicate.stageKey} already completed as ${duplicate.completedBy}`);
    }
    emit('');
  }

  // The stage the stored state claims to have been in, and the job that owns
  // it — both resolved from the ledger alone, the same way a fresh dispatch
  // would (resolveStageJobId). runtime.currentJobId is never consulted as a
  // fallback: see the note on resolveRecoveryJob for why.
  const { jobId, resultExists } = resolveRecoveryJob({ reconciled, runtime });
  const roleForState = stageForState(runtime?.state) === STAGES.REVIEW ? 'tech_lead' : 'developer';
  const jobStatus = jobId ? await store.readJobStatus(roleForState, jobId).catch(() => null) : null;

  const plan = planRecovery({
    runtime,
    autonomousRun,
    ownerVerdict: verdict,
    leaseExists: Boolean(lease),
    resultExists,
    jobStatus,
    jobId,
  });

  if (plan.action === RECOVERY_ACTIONS.NOTHING_TO_RECOVER) {
    emit(plan.message);
    return 0;
  }

  if (plan.action === RECOVERY_ACTIONS.BLOCKED) {
    emit('RECOVERY_BLOCKED');
    emit(`  ${plan.reason}: ${plan.message}`);
    if (!dryRun) await store.appendEvent({
      type: 'RECOVERY_BLOCKED',
      goal: runtime?.goal ?? null, round: runtime?.round ?? null, state: runtime?.state ?? null,
      runId: autonomousRun?.autonomousRunId ?? null, reason: plan.reason,
    });
    return 1;
  }

  // Consistency first, and on every run — not only the first one.
  //
  // Superseding a duplicate and retiring the leases of a dead attempt are
  // repairs, not part of the handoff. Behind the "already recovered" return
  // they would be skipped by exactly the re-run someone makes when something
  // is still stuck — and a worktree lease held by a process that no longer
  // exists blocks the round that is legitimately next.
  if (!dryRun) {
    // --- Attempts that should never have existed ------------------------------
    //
    // Recorded as SUPERSEDED, never deleted: what the harness did wrong stays
    // readable, and the attempt stops looking live to anything that reads the
    // store. A worker will not pick it up again, and reconciliation already
    // refuses to treat it as authoritative over the result it duplicates.
    for (const duplicate of reconciled?.duplicates ?? []) {
      const role = duplicate.stageKey.endsWith('review') ? 'tech_lead' : 'developer';
      await store.setJobStatus(role, duplicate.jobId, 'SUPERSEDED').catch(() => {});
      await store.appendEvent({
        type: 'DUPLICATE_STAGE_ATTEMPT_SUPERSEDED',
        goal: runtime.goal, round: runtime.round,
        runId: autonomousRun?.autonomousRunId ?? null,
        jobId: duplicate.jobId, stageKey: duplicate.stageKey, completedBy: duplicate.completedBy,
      });
      emit(`Superseded duplicate attempt ${duplicate.jobId} — ${duplicate.stageKey} completed as ${duplicate.completedBy}.`);

    }

    // --- Leases held by attempts that will never run again ------------------
    //
    // Driven by the leases themselves, not by the list of duplicates. Once a
    // duplicate is marked SUPERSEDED it stops being reported as one, so a
    // cleanup keyed on that list can only ever fire on the first run — and the
    // lease it failed to release then stays on disk for good. A worktree lease
    // held by a dead attempt blocks the round that is legitimately next with
    // WORKTREE_BUSY, by a process that no longer exists.
    //
    // The bar stays high: the job must be one that can no longer be claimed AND
    // its holder must be a confirmed orphan. An attempt that could still
    // legitimately run keeps its lease, whatever state it is in.
    for (const held of (await leaseStore.listJobLeases()).filter(Boolean)) {
      if (held.jobId === LOOP_LEASE_KEY) continue;

      const role = held.agent === 'tech_lead' ? 'tech_lead' : 'developer';
      const status = await store.readJobStatus(role, held.jobId).catch(() => null);
      if (isClaimableJobStatus(status)) continue;

      const heldEvidence = await collectOwnerEvidence(held, inspector, { now });
      const heldVerdict = judgeOwner({ lease: held, evidence: heldEvidence, now });
      if (!isRecoveryEligible(heldVerdict)) {
        emit(`Lease for ${held.jobId} (${status}) is kept: ${heldVerdict.detail}`);
        continue;
      }

      const retired = await leaseStore.retireJob(held.jobId, { expected: held, proof: heldVerdict.proof });
      if (!retired.retired) continue;

      if (held.worktree) {
        const wt = await leaseStore.readWorktreeLease(held.worktree).catch(() => null);
        if (wt && wt.attemptId === held.attemptId) {
          await leaseStore.retireWorktree(held.worktree, { expected: wt, proof: heldVerdict.proof }).catch(() => null);
        }
      }

      await store.appendEvent({
        type: 'ORPHANED_LEASE_RETIRED', jobId: held.jobId, jobStatus: status,
        goal: runtime.goal, round: runtime.round,
        runId: autonomousRun?.autonomousRunId ?? null,
        owner: held.workerInstanceId ?? null, proof: heldVerdict.proof,
        worktree: held.worktree ?? null,
      });
      emit(`Retired the lease of ${held.jobId} (${status}, ${heldVerdict.proof}); the worktree is free for the next round.`);
    }

  }

  // Running recovery again on an unchanged run must not take a lease again or
  // mint a second token. Saying "already recovered" is the whole job.
  const existingHandoff = await handoffs.read();
  if (handoffCovers(existingHandoff, {
    autonomousRunId: autonomousRun?.autonomousRunId,
    state: runtime.state,
    nextSafeAction: plan.action,
  })) {
    emit('Already recovered and waiting for an orchestrator.');
    emit(`  Run: ${existingHandoff.autonomousRunId}`);
    emit(`  Next safe action: ${existingHandoff.nextSafeAction}${existingHandoff.jobId ? ` — ${existingHandoff.jobId}` : ''}`);
    emit('');
    emit(`Continue with: ${continuationFor()}`);
    return 0;
  }

  emit(`${plan.agent === 'tech_lead' ? 'ReviewResult' : plan.agent === 'developer' ? 'DeveloperResult' : 'Phase'}:`);
  emit(`  ${plan.message}`);
  emit('');
  emit('Next safe action:');
  emit(`  ${plan.action}${plan.jobId ? ` — ${plan.jobId}` : ''}`);
  if (reconciled) {
    // What the run will actually do next, derived the same way the runner
    // will derive it — so the plan printed here and the plan executed later
    // cannot disagree.
    const next = reconciled.next;
    emit(`  then: ${next.kind}${next.round ? ` at round ${next.round}` : ''}`
      + `${next.blockers?.length ? ` with ${next.blockers.length} blocker(s) carried from ${next.fromReviewJobId}` : ''}`);
  }
  emit('');

  if (dryRun) {
    emit('--dry-run: nothing was changed, no lease was taken.');
    return 0;
  }

  // --- Take the loop over, atomically ---------------------------------------
  if (lease) {
    if (!isRecoveryEligible(verdict)) {
      emit('RECOVERY_BLOCKED');
      emit('  Abandonment was not proven; the lease stays where it is.');
      return 1;
    }

    const taken = await auto.takeoverLoopLease({ expected: lease, proof: verdict.proof });
    if (!taken.acquired) {
      emit('RECOVERY_BLOCKED');
      emit(`  LEASE_TAKEOVER_FAILED: ${taken.reason}. Another process is recovering this run.`);
      await store.appendEvent({
        type: 'LEASE_TAKEOVER_FAILED',
        runId: autonomousRun?.autonomousRunId ?? null, reason: taken.reason, oldOwner: lease.workerInstanceId ?? null,
      });
      return 1;
    }

    await store.appendEvent({
      type: 'LEASE_TAKEOVER_SUCCEEDED',
      runId: autonomousRun?.autonomousRunId ?? null,
      oldOwner: lease.workerInstanceId ?? null,
      newOwner: taken.lease.workerInstanceId,
      attemptId: taken.lease.attemptId,
      proof: verdict.proof,
    });
    emit(`Lease acquired by: ${taken.lease.workerInstanceId} (${taken.lease.attemptId})`);
  }

  await store.appendEvent({
    type: 'RECOVERY_STARTED',
    goal: runtime.goal, round: runtime.round, state: runtime.state,
    runId: autonomousRun?.autonomousRunId ?? null, action: plan.action, jobId: plan.jobId ?? null,
  });

  // --- Put the interrupted work into a state the loop can continue from -----
  if (plan.action === RECOVERY_ACTIONS.CONSUME_RESULT) {
    // Nothing to change: the result is on disk and the runner reuses it by job
    // id. Saying so explicitly is the point — this is the case that used to
    // cost a second inference.
    await store.appendEvent({
      type: 'JOB_RESULT_REUSED', role: plan.agent, jobId: plan.jobId,
      goal: runtime.goal, round: runtime.round, runId: autonomousRun?.autonomousRunId ?? null,
    });
  }

  if (plan.action === RECOVERY_ACTIONS.REQUEUE_JOB) {
    // Requeuing the logical job and creating its next attempt are different
    // acts, and only the second produces something a worker can claim. This
    // used to set the job back to QUEUED while it still pointed at the
    // interrupted attempt: the job looked ready, nothing was, and the
    // Developer sat IDLE against it forever.
    const before = await store.readAttemptState(plan.agent, plan.jobId);

    // The lease of the attempt being retired goes first, and only with proof.
    // Left in place it is what makes the worker refuse the job — the new
    // attempt would be as unclaimable as the old one.
    const heldByOldAttempt = await leaseStore.readJobLease(plan.jobId).catch(() => null);
    if (heldByOldAttempt) {
      const heldEvidence = await collectOwnerEvidence(heldByOldAttempt, inspector, { now });
      const heldVerdict = judgeOwner({ lease: heldByOldAttempt, evidence: heldEvidence, now });
      if (isRecoveryEligible(heldVerdict)) {
        await leaseStore.retireJob(plan.jobId, { expected: heldByOldAttempt, proof: heldVerdict.proof });
        if (heldByOldAttempt.worktree) {
          const wt = await leaseStore.readWorktreeLease(heldByOldAttempt.worktree).catch(() => null);
          if (wt && wt.attemptId === heldByOldAttempt.attemptId) {
            await leaseStore.retireWorktree(heldByOldAttempt.worktree, { expected: wt, proof: heldVerdict.proof })
              .catch(() => null);
          }
        }
        await store.appendEvent({
          type: 'ORPHANED_LEASE_RETIRED', jobId: plan.jobId,
          goal: runtime.goal, round: runtime.round,
          runId: autonomousRun?.autonomousRunId ?? null,
          owner: heldByOldAttempt.workerInstanceId ?? null, proof: heldVerdict.proof,
          attemptId: heldByOldAttempt.attemptId ?? null,
        });
        emit(`Retired the lease of ${heldByOldAttempt.attemptId ?? plan.jobId} (${heldVerdict.proof}).`);
      } else {
        emit(`RECOVERY_BLOCKED`);
        emit(`  The attempt still holds its lease and abandonment is not proven: ${heldVerdict.detail}`);
        return 1;
      }
    }

    if (before?.attemptStatus !== 'INTERRUPTED') {
      await store.setJobStatus(plan.agent, plan.jobId, 'INTERRUPTED');
      await store.appendEvent({
        type: 'JOB_INTERRUPTED', role: plan.agent, jobId: plan.jobId,
        attemptId: before?.attemptId ?? null,
        goal: runtime.goal, round: runtime.round, runId: autonomousRun?.autonomousRunId ?? null,
      });
    }

    const started = await store.startNextAttempt(plan.agent, plan.jobId, {
      reason: verdict?.proof ?? 'ORCHESTRATOR_GONE',
    });

    if (started.created) {
      await store.appendEvent({
        type: 'JOB_ATTEMPT_MATERIALISED', role: plan.agent, jobId: plan.jobId,
        attemptId: started.attemptId, attempt: started.attempt,
        previousAttemptId: started.previousAttemptId,
        goal: runtime.goal, round: runtime.round, runId: autonomousRun?.autonomousRunId ?? null,
      });
      emit(`New attempt ${started.attemptId} is queued; ${started.previousAttemptId} stays in the record as INTERRUPTED.`);
    } else {
      emit(`Attempt ${started.attemptId ?? before?.attemptId} is already ${started.reason}; no second one was created.`);
    }

    await store.appendEvent({
      type: 'JOB_REQUEUED_AFTER_RECOVERY', role: plan.agent, jobId: plan.jobId,
      attemptId: started.attemptId ?? before?.attemptId ?? null,
      goal: runtime.goal, round: runtime.round, runId: autonomousRun?.autonomousRunId ?? null,
    });
  }

  // The stored state is left exactly as it was: the runner re-enters it and
  // decides from the artefacts. Recovery restores ownership and consistency; it
  // does not move the state machine on the runner's behalf.
  //
  // The main guard checkpoint is recorded here and is NOT the execution base.
  // Tooling commits land on main while a Goal sits interrupted, and the next
  // execution must not read them as the Developer having written outside its
  // worktree. executionBase, worktreeInitialHead and migrationAcceptedBaseline
  // are deliberately untouched: the diff of record is still measured against
  // the original tree.
  const mainHead = await createGitProbe(REPO_ROOT).head().catch(() => null);
  await store.writeRuntime({
    ...(await store.readRuntime()),
    recovery: {
      at: new Date().toISOString(),
      fromState: runtime.state,
      action: plan.action,
      proof: verdict?.proof ?? null,
      attempt: (autonomousRun?.recoveryCount ?? 0) + (lease ? 1 : 0),
    },
    mainGuardCheckpoint: mainHead
      ? { head: mainHead, at: new Date().toISOString(), reason: 'RECOVERY', note: 'operational checkpoint, not the execution base' }
      : (await store.readRuntime())?.mainGuardCheckpoint ?? null,
  });

  await store.appendEvent({
    type: 'RECOVERY_COMPLETED',
    goal: runtime.goal, round: runtime.round, state: runtime.state,
    runId: autonomousRun?.autonomousRunId ?? null, action: plan.action, jobId: plan.jobId ?? null,
  });

  // --- Hand the run over, and hold nothing ----------------------------------
  //
  // Recovery is not the orchestrator. Keeping the lease it just took would be
  // phantom ownership: the process ends here, but the lease reads as a healthy
  // owner for the whole expiry window, and blocks the very command this prints.
  const handoff = await handoffs.write({
    autonomousRunId: autonomousRun?.autonomousRunId ?? null,
    recoveryAttempt: autonomousRun?.recoveryCount ?? 1,
    recoveredFromState: runtime.state,
    nextSafeAction: plan.action,
    jobId: plan.jobId ?? null,
    agent: plan.agent ?? null,
    goal: runtime.goal,
    round: runtime.round,
    supersededOwner: lease?.workerInstanceId ?? null,
    proof: verdict?.proof ?? null,
  });

  await auto.releaseLoopLease().catch(() => {});

  await store.appendEvent({
    type: 'RECOVERY_READY_FOR_ATTACH',
    goal: runtime.goal, round: runtime.round, state: runtime.state,
    runId: handoff.autonomousRunId, recoveryAttempt: handoff.recoveryAttempt,
    nextSafeAction: handoff.nextSafeAction, jobId: handoff.jobId,
    previousOwner: handoff.supersededOwner,
  });

  emit('');
  emit('RECOVERY COMPLETE — the run is ready for an orchestrator to attach.');
  emit(`  Run: ${handoff.autonomousRunId} (no orchestrator holds the loop)`);
  emit(`  Next safe action: ${handoff.nextSafeAction}${handoff.jobId ? ` — ${handoff.jobId}` : ''}`);
  emit('');
  emit(`Continue with: ${continuationFor()}`);
  return 0;
}

// Only when this file IS the program. Importing it — from a test, a doc
// generator, or an agent reading the tooling — must never start anything.
if (isDirectExecution(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      const code = error instanceof SpikeError ? error.code : 'UNEXPECTED_ERROR';
      console.error(`\nATENDLY IA LOOP — RECOVERY\n\nBlocker: [${code}] ${error.message}`);
      process.exitCode = 1;
    });
}
