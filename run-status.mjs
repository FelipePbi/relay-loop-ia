#!/usr/bin/env node
/**
 * IA Loop — status.
 *
 *   npm run ia-loop:status
 *
 * Reads only what is on disk. Calls no model, publishes nothing and changes
 * nothing, so it is safe to run at any time, including mid-wait.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SpikeError } from './lib/claude-process.mjs';
import { createJobStore } from './lib/job-store.mjs';
import { readWorkerHealth } from './lib/worker-registry.mjs';
import { readRuntimeStrict, remainingWaitMs } from './lib/capacity-state.mjs';
import { formatRemaining } from './lib/capacity-policy.mjs';
import { LOOP_STATES } from './lib/loop-state.mjs';
import { LEASE_STATUS, classifyLease, createLeaseStore } from './lib/leases.mjs';
import { LOOP_LEASE_KEY, RUN_STATUS, createAutonomousStore } from './lib/autonomous-state.mjs';
import { goalExecutionOf } from './lib/goal-execution.mjs';
import { goalOfJobId } from './lib/stage-identity.mjs';
import { createProcessInspector } from './lib/process-inspector.mjs';
import { OWNER_STATUS, collectOwnerEvidence, isRecoveryEligible, judgeOwner } from './lib/orphan-evidence.mjs';
import { createHandoffStore, HANDOFF_STATUS } from './lib/recovery-handoff.mjs';
import { SELECTABLE_DEVELOPER_PROFILES } from './lib/developer-profiles.mjs';
import { reconcileExecutionState } from './lib/reconcile.mjs';
import { renderRoutingSummary, summarizeRouting } from './lib/routing-summary.mjs';
import { STAGES } from './lib/stage-identity.mjs';
import { LOOP_CONFIG } from './lib/loop-config.mjs';
import { isDirectExecution } from './lib/direct-execution.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, '.state');

const TECH_LEAD_MODEL = process.env.IA_LOOP_TECH_LEAD_MODEL ?? 'claude-fable-5-1';
const DEVELOPER_MODEL = process.env.IA_LOOP_DEVELOPER_MODEL ?? 'claude-opus-5';

function duration(fromIso, now) {
  const started = Date.parse(fromIso);
  if (Number.isNaN(started)) return 'unknown';
  const s = Math.max(0, Math.round((now - started) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function shortSha(sha) {
  return typeof sha === 'string' && sha.length >= 8 ? `${sha.slice(0, 8)}…` : (sha ?? 'n/a');
}

function agentBlock({ label, model, health, runtime, now, profile = null, supportedProfiles = null }) {
  const lines = [`${label}:`];

  // The Developer's model is a per-Goal routing decision, so the profile is
  // reported first and the model is shown as its consequence. An idle worker
  // with nothing routed to it lists what it CAN run instead of claiming a model.
  if (profile) {
    // The persisted execution record names the profile in `profile`; a registry
    // entry names it in `name`. Reading only one of them printed "undefined".
    lines.push(`  Profile: ${profile.profile ?? profile.name}`);
    lines.push(`  Model: ${profile.model}`);
    lines.push(`  Effort: ${profile.effort ?? 'CLI default'}`);
    if (profile.source) lines.push(`  Selected by: ${profile.selectedBy ?? 'tech_lead'} (${profile.source})`);
  } else if (supportedProfiles) {
    lines.push('  Profile: none routed yet');
    lines.push(`  Supported profiles: ${supportedProfiles.join(', ')}`);
  } else {
    lines.push(`  Model: ${model}`);
  }

  const isBlocked = runtime?.blockedAgent === health.role;

  // A stale heartbeat file must not make a dead worker look IDLE: liveness
  // wins over the last state it managed to write.
  const state = health.health === 'OFFLINE' ? 'OFFLINE' : (health.state ?? 'UNKNOWN');
  lines.push(`  State: ${state}`);

  if (isBlocked && runtime?.capacity) {
    lines.push(`  Reason: ${runtime.capacity.reason}`);
    lines.push(`  Retry in: ${formatRemaining(remainingWaitMs(runtime, now))}`);
    lines.push(`  Attempt: ${runtime.capacity.attempt}`);
  } else if (runtime?.blockedAgent && !isBlocked) {
    // Limits are per agent: the other one is simply idle, not limited.
    lines.push(`  Reason: waiting for ${runtime.blockedAgent === 'tech_lead' ? 'Tech Lead' : 'Developer'}`);
  }

  if (health.health !== 'RUNNING' && health.health !== 'OFFLINE') {
    lines.push(`  Health: ${health.health}`);
  }
  return lines.join('\n');
}

/**
 * Whether the runtime still names a human gate the results have outlived.
 *
 * The one thing a status screen must never do is repeat a gate that is over.
 * It must also not INVENT one, and it used to: `AWAITING_HUMAN` was read as a
 * gate, and `AWAITING_HUMAN` is the ordinary supervised stop `run-goal` writes
 * at the end of EVERY run — including one whose review said ACCEPTED. So every
 * successfully accepted Goal was reported as "the runtime still records
 * HUMAN_REQUIRED", which it plainly did not, and the operator was told to
 * reconcile a state that was exactly what the design intends: closure is a
 * deliberate separate step, and a Goal waiting for it is not blocked.
 *
 * What makes a gate stale is the runtime naming a REASON the ledger has moved
 * past — a HUMAN_REQUIRED state or decision, or a recorded `humanRequired` /
 * `escalationReason`. Those are precisely the fields `run-goal` clears once it
 * has proven the run is not blocked, so reading them distinguishes "a person
 * still has to look at something" from "a person has to run the next step".
 *
 * Exported for the regression test; nothing else calls it.
 */
export function hasStaleHumanGate({ goalExecution, next }) {
  if (!next || next.kind === 'HUMAN_REQUIRED') return false;
  return goalExecution?.state === LOOP_STATES.HUMAN_REQUIRED
    || goalExecution?.decision === 'HUMAN_REQUIRED'
    || Boolean(goalExecution?.humanRequired)
    || Boolean(goalExecution?.escalationReason);
}

/**
 * Which Goal the loop is actually on.
 *
 * An autonomous run names the current Goal only while it is RUNNING. That
 * qualifier is the whole fix: the run's pointer legitimately runs AHEAD of
 * `current-goal.json` for a moment — `setCurrentGoal(next)` fires when planning
 * names the next Goal, before `run-goal` writes the live pointer for it — so a
 * driving run must keep priority. A run that is paused, stopped for a human or
 * completed is driving nothing, and its pointer is then a record of where it
 * stopped, not a statement about where the loop is.
 *
 * Read unconditionally, as it was, that record silently overrode reality: run
 * auto-987b6c55 stopped at Goal 007 on 2026-09-09T04:42 and was never resumed
 * (there is no AUTONOMOUS_RUN_RESUMED after it in the event log). The operator
 * went on supervised — Goal 007 was closed at 13:43 and Goal 008 executed to
 * ACCEPTED at 18:11, both writing `current-goal.json` — and the status screen
 * still announced "Current Goal: 007", offered 007's closure as the next step,
 * and dismissed Goal 008's live execution state as "historical, not current".
 * Exactly backwards, and acted upon.
 *
 * The paused run is NOT rewritten to say otherwise: no event says it advanced,
 * and inventing one would be worse than misreading it. It stays visible under
 * `Run:`, as the history it is.
 *
 * Exported for the regression test; nothing else calls it.
 */
export function resolveCurrentGoal({ autonomousRun = null, goal = null, runtime = null } = {}) {
  if (autonomousRun?.status === RUN_STATUS.RUNNING && autonomousRun.currentGoal) {
    return autonomousRun.currentGoal;
  }
  // The live pointer first: `run-goal` writes it for every execution, whoever
  // started it, so it is never staler than a run that is not driving.
  return goal?.goalId ?? runtime?.goal ?? autonomousRun?.currentGoal ?? null;
}

/**
 * Whether this Goal's closure already happened, from the closure record itself.
 *
 * Three different "current Goals" exist at once and the screen has to keep them
 * apart, because conflating them is how an operator is told to redo finished
 * work:
 *
 *   the autonomous run's Goal   where a run stopped. History once it is not
 *                               RUNNING (see resolveCurrentGoal).
 *   the RUNTIME Goal            the Goal whose execution state is on disk.
 *                               `current-goal.json` is written when a Goal is
 *                               STARTED and never rewritten at closure, so
 *                               after a close it names the Goal that just
 *                               FINISHED — not the one to work on.
 *   the NEXT Goal               written and marked READY by the closure's own
 *                               planning step, and not started.
 *
 * `reconcileExecutionState` derives the next step from the round ledger, which
 * ends at "review ACCEPTED -> CLOSE_GOAL" and knows nothing about the closure
 * that already ran. So a closed Goal was still advertised as needing its
 * closure — with the commits, the new baseline and the next Goal id sitting
 * right there in `closure`. This reads that record instead of re-deriving.
 *
 * Exported for the regression test; nothing else calls it.
 */
export function closureStateOf(goalExecution) {
  const closure = goalExecution?.closure ?? null;
  // Both halves must be present: documentation alone is not a closed Goal, and
  // planning is what produces the next one.
  const closed = Boolean(closure?.integratedClosureCommit && closure?.nextGoalId);
  return {
    closed,
    nextGoalId: closed ? closure.nextGoalId : null,
    nextGoalTitle: closed ? closure.nextGoalTitle ?? null : null,
    nextDeveloperProfile: closed ? closure.nextGoalDeveloperProfile ?? null : null,
    baseline: closed ? closure.newMigrationBaseline ?? null : null,
    closureCommit: closed ? closure.integratedClosureCommit : null,
  };
}

async function main() {
  const store = createJobStore(STATE_DIR);
  const leaseStore = createLeaseStore(STATE_DIR);

  const auto = createAutonomousStore(STATE_DIR);
  const handoffs = createHandoffStore(STATE_DIR);
  const inspector = createProcessInspector();

  const runtime = await readRuntimeStrict(store);
  const goal = await store.readCurrentGoal();
  const autonomousRun = await auto.read();
  const [techLeadHealth, developerHealth] = await Promise.all([
    readWorkerHealth(store, 'tech_lead'),
    readWorkerHealth(store, 'developer'),
  ]);
  const now = Date.now();

  const out = ['', 'ATENDLY IA LOOP', ''];

  if (!runtime && !goal) {
    out.push('No run recorded yet.');
    out.push('');
    out.push('Start with:');
    out.push('  npm run ia-loop:goal -- 003 --dry-run');
    console.log(out.join('\n'));
    return 0;
  }

  // The run and the Goal execution are two different things, and printing them
  // as one is what let a screen show Goal 005 next to Goal 004's job as though
  // the two belonged together. The execution block is only filled in when the
  // state on disk is that Goal's.
  const currentGoal = resolveCurrentGoal({ autonomousRun, goal, runtime });
  const goalExecution = goalExecutionOf(runtime, currentGoal);
  const previousGoal = (autonomousRun?.completedGoals ?? []).at(-1) ?? null;

  const closure = closureStateOf(goalExecution);

  // "Runtime Goal", not "Current Goal": after a closure this names the Goal
  // that just finished, and calling that "current" is what sent an operator
  // back to re-run a closure that had already happened.
  out.push(`Runtime Goal: ${currentGoal ?? 'n/a'}${closure.closed ? ' — CLOSED' : ''}`);
  out.push('Goal execution:');
  out.push(`  Round: ${goalExecution?.round ?? (currentGoal ? 1 : 'n/a')}`);
  out.push(`  State: ${goalExecution?.state ?? 'NOT_STARTED'}`);
  if (goalExecution?.mode) out.push(`  Mode: ${goalExecution.mode}`);
  if (goalExecution?.developerProfile) {
    out.push(`  Developer profile: ${goalExecution.developerProfile.profile}`);
  }
  if (!goalExecution && runtime?.goal) {
    // Said plainly rather than shown as this Goal's: it is the previous Goal's
    // record, and nothing here may act on it.
    out.push(`  Execution state on disk belongs to Goal ${runtime.goal} — historical, not current.`);
  }
  if (closure.closed) {
    out.push(`  Closed: closure commit ${String(closure.closureCommit).slice(0, 8)}`
      + ` · new baseline ${String(closure.baseline).slice(0, 8)}`);
  }
  if (previousGoal) out.push(`Previous Goal: ${previousGoal} (ACCEPTED)`);
  if (closure.closed) {
    out.push(`Next Goal: ${closure.nextGoalId} — READY, not started`
      + `${closure.nextGoalTitle ? ` (${closure.nextGoalTitle})` : ''}`);
  }
  out.push('');

  // An execution in flight is the most important thing on this screen: it is
  // what tells the operator whether work is still owned by a live attempt.
  //
  // Scoped to the current Goal. A lease from a closed Goal is history, and
  // showing it as the active job is how "Goal 005" and "004-r1-developer-…"
  // ended up on the same screen looking like one fact.
  const allLeases = (await leaseStore.listJobLeases()).filter(Boolean)
    .filter((l) => l.jobId !== LOOP_LEASE_KEY);
  const leases = currentGoal
    ? allLeases.filter((l) => goalOfJobId(l.jobId) === currentGoal)
    : allLeases;
  const otherGoalLeases = allLeases.filter((l) => !leases.includes(l));

  if (leases.length > 0) {
    out.push('Active job:');
    for (const lease of leases) {
      const { status, ageMs } = classifyLease(lease, { now });
      out.push(`  Job: ${lease.jobId}`);
      // A lease written before attempts were recorded says so, instead of
      // printing "undefined" and leaving the reader to guess.
      out.push(`  Attempt: ${lease.attemptId ?? 'not recorded (lease predates attempt ids)'}`);
      out.push(`  Worker: ${lease.agent ?? '?'} ${String(lease.workerInstanceId ?? '').slice(0, 12)}`);
      if (lease.worktree) out.push(`  Worktree: ${lease.worktree}`);
      out.push(`  Lease: ${status}`);
      out.push(`  Heartbeat age: ${Math.round((ageMs ?? 0) / 1000)}s`);
      out.push(`  Started: ${lease.acquiredAt}`);
      out.push(`  Duration: ${duration(lease.acquiredAt, now)}`);
    }
    out.push('');
  } else if (currentGoal) {
    out.push(`Active job: none for Goal ${currentGoal}.`);
    out.push('');
  }

  if (otherGoalLeases.length > 0) {
    out.push('Leases from other Goals (historical, never current):');
    for (const lease of otherGoalLeases) {
      out.push(`  ${lease.jobId} — Goal ${goalOfJobId(lease.jobId) ?? 'unknown'}, ${classifyLease(lease, { now }).status}`);
    }
    out.push('');
  }

  // --- What the jobs actually say ----------------------------------------
  //
  // Printed from the RESULTS, not from the runtime. The runtime is a cache of
  // what the orchestrator concluded, and it once concluded HUMAN_REQUIRED from
  // a dead attempt's envelope while the live attempt was still working. When
  // the two disagree, this block says so rather than repeating the cache.
  if (currentGoal) {
    const { ledger, next } = await reconcileExecutionState({ store, goal: currentGoal, maxRounds: LOOP_CONFIG.maxCorrectionRounds })
      .catch(() => ({ ledger: new Map(), next: null }));

    const reviews = [...ledger.values()]
      .filter((stage) => stage.stageKey.endsWith(`:${STAGES.REVIEW}`) && stage.result?.decision)
      .sort((a, b) => a.round - b.round);
    const latestReview = reviews.at(-1) ?? null;

    if (latestReview) {
      const attempt = latestReview.attempts.find((a) => a.jobId === latestReview.completedBy);
      out.push('Review:');
      out.push(`  Job: ${latestReview.completedBy}`);
      out.push(`  Attempt: ${attempt?.attemptId ?? 'not recorded'}`);
      out.push(`  Status: ${latestReview.status}`);
      out.push(`  Decision: ${latestReview.result.decision}`);
      if ((latestReview.result.blockers ?? []).length > 0) {
        out.push(`  Blockers: ${latestReview.result.blockers.length}`);
      }
      if (latestReview.result.nextDeveloperProfile) {
        out.push(`  Next developer profile: ${latestReview.result.nextDeveloperProfile}`);
      }
      out.push('');
    }

    if (closure.closed) {
      // The ledger still ends at "ACCEPTED -> CLOSE_GOAL", but the closure
      // record proves that step already ran. Repeating it here is how an
      // operator gets told to redo finished work.
      out.push('Next:');
      out.push(`  Goal ${closure.nextGoalId} — not started`);
      if (closure.nextDeveloperProfile) out.push(`  Developer profile: ${closure.nextDeveloperProfile}`);
      out.push(`  Start with: npm run ia-loop:goal -- ${closure.nextGoalId}`);
      out.push('');
    } else if (next) {
      out.push('Next:');
      out.push(`  ${currentGoal} R${next.round ?? '?'} ${next.kind}`);
      if (next.kind === 'CORRECTION') {
        const profile = goalExecution?.nextDeveloperProfile?.profile
          ?? latestReview?.result?.nextDeveloperProfile
          ?? goalExecution?.developerProfile?.profile
          ?? 'SONNET_MEDIUM';
        out.push(`  Developer profile: ${profile}`);
        out.push(`  Blockers: ${(next.blockers ?? []).length}`);
      }
      if (next.reason) out.push(`  Reason: ${next.reason}`);

      if (hasStaleHumanGate({ goalExecution, next })) {
        out.push('');
        out.push('  The runtime still records a human gate, but the jobs on disk do not support it.');
        out.push('  Reconcile with: npm run ia-loop:reconcile-runtime -- --goal ' + currentGoal);
      }
      out.push('');
    }
  }

  // --- What the router actually did ---------------------------------------
  //
  // Read from the routing events, so it answers the question this feature has
  // to keep answering: did the expensive models stay rare?
  if (currentGoal) {
    const summary = summarizeRouting(await store.readEvents(), { goal: currentGoal });
    if (summary.totalCalls > 0) {
      out.push(...renderRoutingSummary(summary));
      out.push('');
    }
  }

  // --- Run and orchestrator, kept apart ----------------------------------
  //
  // These used to be one block, and it could print "NOT HOLDING THE LOOP" while
  // ia-loop:auto refused to start because "the run owns the loop". They are two
  // different things: the run is a campaign that has not finished, the
  // orchestrator is a process that may or may not exist right now.
  const loopLease = await leaseStore.readJobLease(LOOP_LEASE_KEY);
  const handoff = await handoffs.read();

  if (autonomousRun) {
    out.push('Run:');
    out.push(`  ${autonomousRun.autonomousRunId}`);
    out.push(`  State: ${autonomousRun.status}`);
    // Labelled by what it means: a run that is not RUNNING stopped AT this
    // Goal, and the loop may have moved well past it supervised since.
    out.push(`  Goal: ${autonomousRun.currentGoal ?? 'n/a'}`
      + `${autonomousRun.status === RUN_STATUS.RUNNING ? '' : ' (where this run stopped — history)'}`);
    if (autonomousRun.recoveryCount) out.push(`  Recoveries: ${autonomousRun.recoveryCount}`);
    out.push('');
  }

  if (loopLease || autonomousRun) {
    out.push('Orchestrator:');
    if (!loopLease) {
      const ready = handoff?.status === HANDOFF_STATUS.READY_FOR_ATTACH
        && handoff.autonomousRunId === autonomousRun?.autonomousRunId;
      out.push(`  State: ${ready ? 'RECOVERED_READY' : (autonomousRun ? 'NONE' : 'none')}`);
      out.push('  Holding loop: NO');
      if (ready) {
        out.push('  Recovery: VALID');
        out.push(`  Recovered from: ${handoff.recoveredFromState}`);
        out.push(`  Next action: ${handoff.nextSafeAction}${handoff.jobId ? ` — ${handoff.jobId}` : ''}`);
        out.push('  Attach with: npm run ia-loop:auto');
      } else if (autonomousRun) {
        out.push('  Recovery: none recorded');
        out.push('  Check with: npm run ia-loop:recover -- --dry-run');
      }
    } else {
      const evidence = await collectOwnerEvidence(loopLease, inspector, { now });
      const verdict = judgeOwner({ lease: loopLease, evidence, now });
      const eligible = isRecoveryEligible(verdict);

      out.push(`  State: ${verdict.status === OWNER_STATUS.ACTIVE ? 'RUNNING' : verdict.status}`);
      out.push(`  Holding loop: ${verdict.status === OWNER_STATUS.ACTIVE ? 'YES' : 'NOT CONFIRMABLY'}`);
      out.push(`  Run: ${loopLease.autonomousRunId ?? 'unknown'}`);
      out.push(`  Owner: ${loopLease.workerInstanceId ?? 'unknown'}`);
      out.push(`  Attempt: ${loopLease.attemptId ?? 'not recorded (lease predates attempt ids)'}`);
      out.push(`  Last heartbeat: ${loopLease.heartbeatAt} (${Math.round((verdict.ageMs ?? 0) / 1000)}s ago)`);
      if (verdict.status !== OWNER_STATUS.ACTIVE) {
        out.push(`  Reason: ${verdict.detail}`);
        out.push(`  Recovery eligible: ${eligible ? 'YES' : 'NO'}`);
        if (eligible) out.push(`  Proof: ${verdict.proof}`);
        out.push(`  ${eligible ? 'Recover with: npm run ia-loop:recover' : 'Not recoverable yet: abandonment is not proven.'}`);
      }
    }
    if (goalExecution?.recovery) {
      out.push(`  Recovered: yes — ${goalExecution.recovery.action} from ${goalExecution.recovery.fromState} at ${goalExecution.recovery.at}`);
    }
    if (runtime?.mainGuardCheckpoint) {
      // Not the execution base, and labelled so nobody reads it as one.
      out.push(`  Main guard checkpoint: ${shortSha(runtime.mainGuardCheckpoint.head)} (${runtime.mainGuardCheckpoint.reason})`);
    }
    out.push('');
  }

  // The live record wins over the worker heartbeat: the heartbeat says what a
  // process believes, the runtime says what the Goal is routed to.
  const routedProfile = goalExecution?.developerProfile ?? null;
  out.push(agentBlock({
    label: 'Developer',
    model: DEVELOPER_MODEL,
    health: developerHealth,
    runtime: goalExecution,
    now,
    profile: routedProfile,
    supportedProfiles: routedProfile ? null : [...SELECTABLE_DEVELOPER_PROFILES],
  }));
  if (goalExecution?.nextDeveloperProfile) {
    out.push(`  Next round profile: ${goalExecution.nextDeveloperProfile.profile} `
      + `(round ${goalExecution.nextDeveloperProfile.round}, selected by tech_lead)`);
  }
  out.push('');
  out.push(agentBlock({ label: 'Tech Lead', model: TECH_LEAD_MODEL, health: techLeadHealth, runtime: goalExecution, now }));
  out.push('');

  // Read from the Goal execution, not the raw runtime: a capacity wait or a
  // human-required record belongs to the Goal that hit it.
  if (goalExecution?.state === LOOP_STATES.WAITING_FOR_CAPACITY) {
    out.push(`Resume from: ${goalExecution.resumeFrom}`);
    out.push(`Blocked job: ${goalExecution.blockedJobId ?? 'n/a'}`);
    out.push('');
  }

  if (goalExecution?.state === LOOP_STATES.HUMAN_REQUIRED && goalExecution.humanRequired) {
    out.push(`Human required: ${goalExecution.humanRequired.reason}`);
    if (goalExecution.humanRequired.note) out.push(`  ${goalExecution.humanRequired.note}`);
    out.push('');
  }

  out.push('Last accepted baseline:');
  // The runtime is the live record; current-goal is a snapshot from when the
  // run started and can lag behind a closure that already updated the baseline.
  out.push(`${shortSha(runtime?.migrationAcceptedBaseline ?? goal?.migrationAcceptedBaseline)}`);
  out.push('');

  // "No work lost" is a claim, so it is only made when the state actually
  // supports it. An in-flight or ambiguous execution says so instead.
  const activeLease = leases.find((l) => classifyLease(l, { now }).status === LEASE_STATUS.ACTIVE);
  const suspectLease = leases.find((l) => classifyLease(l, { now }).status === LEASE_STATUS.SUSPECTED_ORPHAN);
  const observerRunning = [techLeadHealth, developerHealth].some((h) => h.health === 'RUNNING');

  if (goalExecution?.state === LOOP_STATES.HUMAN_REQUIRED) {
    out.push('Awaiting human.');
  } else if (suspectLease) {
    out.push('ORCHESTRATOR/OBSERVER: unknown');
    out.push(`JOB: ${suspectLease.jobId} — lease SUSPECTED_ORPHAN`);
    out.push('WORKER: not confirmably alive');
    out.push('');
    out.push('State is AMBIGUOUS: an attempt may still be writing. Do not start a new one.');
    out.push('');
    out.push('Check whether the holder can still write: npm run ia-loop:recover -- --dry-run');
  } else if (activeLease) {
    out.push(`ORCHESTRATOR/OBSERVER: ${observerRunning ? 'attached' : 'OFFLINE'}`);
    out.push(`JOB: RUNNING (${activeLease.jobId}, attempt ${activeLease.attemptId})`);
    out.push('WORKER: HEALTHY');
    if (!observerRunning) {
      out.push('');
      out.push('The observer is gone but the work continues. Re-attach with: npm run ia-loop:resume');
    }
  } else {
    out.push('No work lost.');
  }

  console.log(out.join('\n'));
  return 0;
}

// Only when this file IS the program. Importing it — from a test, a doc
// generator, or an agent reading the tooling — must never start anything.
if (isDirectExecution(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      const code = error instanceof SpikeError ? error.code : 'UNEXPECTED_ERROR';
      console.error(`ATENDLY IA LOOP\n\nCannot read state: [${code}] ${error.message}`);
      process.exitCode = 1;
    });
}
