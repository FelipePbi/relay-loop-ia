/**
 * IA Loop — autonomous run state.
 *
 * An autonomous run carries the migration from one Goal to the next without a
 * human in the normal path. It survives the process: the run lives on disk, and
 * a restart re-attaches to it rather than starting a second one.
 *
 * Three things are kept apart on purpose:
 *
 *   orchestrator lease  who is allowed to decide global transitions
 *   job / worktree lease (V6)  who owns one execution
 *   pause request       a voluntary, resumable stop
 *
 * PAUSED is a decision. PAUSED_FOR_HUMAN is a problem. They are never the same.
 */

import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';

import { SpikeError } from './claude-process.mjs';
import { readJson, writeJsonAtomic } from './job-store.mjs';
import { attemptIdFor, createLeaseStore, classifyLease, LEASE_STATUS } from './leases.mjs';

export const RUN_MODES = Object.freeze({ SUPERVISED: 'SUPERVISED', AUTONOMOUS: 'AUTONOMOUS' });

export const RUN_STATUS = Object.freeze({
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  PAUSED_FOR_HUMAN: 'PAUSED_FOR_HUMAN',
  COMPLETED: 'COMPLETED',
});

/** The orchestrator lease is a single, well-known key. */
export const LOOP_LEASE_KEY = 'migration-loop';

/**
 * Identity stamped on the orchestrator lease.
 *
 * The loop lease used to carry no attempt at all, so status printed
 * "Attempt: undefined" and nothing in the record distinguished the orchestrator
 * that started a run from the one that recovered it. Every attempt is now
 * numbered and named, which is what makes recovery auditable.
 */
function loopLeasePayload({ autonomousRunId, attempt }) {
  return {
    autonomousRunId,
    attemptId: attemptIdFor(LOOP_LEASE_KEY, attempt),
    attempt,
    agent: 'orchestrator',
    ownerKind: 'orchestrator',
  };
}

/**
 * Conditions that genuinely need a person. Everything else keeps going.
 *
 * Capacity limits are deliberately absent: a rate or usage limit is a wait, not
 * an intervention, and treating it as one would stop the loop every night.
 */
export const HUMAN_REQUIRED_REASONS = Object.freeze([
  'REVIEWER_ASKED_FOR_HUMAN',
  'MAX_CORRECTION_ROUNDS_REACHED',
  'AUTH_ERROR',
  'BILLING_ERROR',
  'MODEL_UNAVAILABLE',
  'UNKNOWN_FATAL',
  'HARNESS_ERROR',
  // Our own state crossing a Goal boundary. A harness error, and one nobody
  // should be able to mistake for a verdict about the Goal that was starting.
  'CROSS_GOAL_STATE_LEAK',
  'AGENT_CONTRACT_ERROR',
  'POLICY_VIOLATION',
  'CHERRY_PICK_CONFLICT',
  'ACCEPTED_WORKTREE_CHANGED',
  'ORPHANED_EXECUTION_UNCERTAIN',
  'GOAL_BOUNDARY_AMBIGUOUS',
  'BASELINE_INCONSISTENT',
  'PRODUCT_DECISION',
  'ARCHITECTURE_DECISION',
]);

export function requiresHuman(reason) {
  return HUMAN_REQUIRED_REASONS.includes(reason);
}

/** Capacity waits never stop an autonomous run. */
export function isCapacityWait(reason) {
  return reason === 'RATE_LIMIT' || reason === 'USAGE_LIMIT';
}

export function createAutonomousStore(stateDir) {
  const path = `${stateDir}/autonomous-run.json`;
  const leases = createLeaseStore(stateDir);

  return {
    path,
    leases,

    async read() {
      return readJson(path);
    },

    async write(run) {
      await writeJsonAtomic(path, run);
      return run;
    },

    /**
     * Starts a run, but only if no healthy orchestrator already owns the loop.
     * The claim is the same atomic filesystem primitive used for jobs.
     */
    async start({ fromGoal, migrationAcceptedBaseline, inheritPause = null }) {
      const existing = await this.read();
      const lease = await leases.readJobLease(LOOP_LEASE_KEY);

      if (lease) {
        const { status } = classifyLease(lease);
        if (status === LEASE_STATUS.ACTIVE) {
          throw new SpikeError(
            'AUTONOMOUS_RUN_ALREADY_ACTIVE',
            `Run ${lease.autonomousRunId} already owns the loop (heartbeat is healthy). `
            + 'A second autonomous orchestrator would race it for Goals.',
          );
        }
        // A stale loop lease is not proof the other orchestrator stopped.
        throw new SpikeError(
          'ORPHANED_EXECUTION_UNCERTAIN',
          `A loop lease from run ${lease.autonomousRunId} is stale but not confirmably dead. `
          + 'Run ia-loop:recover, which checks whether that process can still write before taking the loop over.',
        );
      }

      if (existing?.status === RUN_STATUS.RUNNING) {
        // RUNNING is about the campaign, not about ownership: it means the
        // migration has not finished, and says nothing about whether a process
        // is driving it. A run with no lease has no orchestrator — which is a
        // perfectly ordinary state after a crash — and the answer is to attach
        // to it, never to open a second run beside it.
        throw new SpikeError(
          'AUTONOMOUS_RUN_NEEDS_ATTACH',
          `Run ${existing.autonomousRunId} is unfinished (${existing.currentGoal ? `Goal ${existing.currentGoal}` : 'no Goal recorded'}) `
          + 'and no orchestrator holds the loop. Attach to it instead of starting a second run: '
          + 'ia-loop:recover if it was interrupted, then ia-loop:auto.',
        );
      }

      // The pause intent survives the run that carried it. `pauseAfterGoal`
      // only means anything while `pauseRequested` holds, so it is never
      // inherited on its own.
      const source = inheritPause ?? existing ?? null;
      const inherited = {
        pauseRequested: source?.pauseRequested === true,
        pauseAfterGoal: source?.pauseRequested === true && source?.pauseAfterGoal === true,
      };

      const autonomousRunId = `auto-${randomUUID().slice(0, 8)}`;
      const claim = await leases.claimJob(LOOP_LEASE_KEY, loopLeasePayload({ autonomousRunId, attempt: 1 }));
      if (!claim.acquired) {
        throw new SpikeError('AUTONOMOUS_RUN_ALREADY_ACTIVE',
          `Another orchestrator claimed the loop first (${claim.heldBy?.autonomousRunId ?? 'unknown'}).`);
      }

      const run = {
        runMode: RUN_MODES.AUTONOMOUS,
        autonomousRunId,
        status: RUN_STATUS.RUNNING,
        startedAt: new Date().toISOString(),
        currentGoal: fromGoal,
        completedGoals: [],
        migrationAcceptedBaseline,
        // Inherited from the run this one replaces, because the operator armed
        // it against the CAMPAIGN, not against a run id. `--from` archives the
        // previous run — which deletes the live record, so `existing` is null
        // on that path and the caller passes the archived intent instead.
        // A fresh `false` here silently disarmed the stop: on Goal 014 the loop
        // closed the Goal it was asked to close and then started the next one
        // by itself.
        pauseRequested: inherited.pauseRequested,
        pauseAfterGoal: inherited.pauseAfterGoal,
        attempt: 1,
        ownerInstanceId: claim.lease.workerInstanceId,
      };
      await this.write(run);
      return run;
    },

    /** Re-attaches after a restart. Never creates a second run. */
    async attach() {
      const run = await this.read();
      if (!run || run.status === RUN_STATUS.COMPLETED) return null;

      const lease = await leases.readJobLease(LOOP_LEASE_KEY);
      if (lease) {
        const { status } = classifyLease(lease);
        if (status === LEASE_STATUS.ACTIVE) {
          return { run, attached: false, reason: 'AUTONOMOUS_RUN_ALREADY_ACTIVE', lease };
        }
        // An aged lease used to be force-released right here, which is exactly
        // the "delete it and try again" that a stale heartbeat does not justify:
        // a long inference, a paused machine and a crash all look the same from
        // the outside. Proving abandonment is ia-loop:recover's job, and it is
        // the only thing allowed to take this lease over.
        return { run, attached: false, reason: 'RECOVERY_REQUIRED', lease };
      }

      const claim = await leases.claimJob(
        LOOP_LEASE_KEY,
        loopLeasePayload({ autonomousRunId: run.autonomousRunId, attempt: (run.attempt ?? 1) }),
      );
      if (!claim.acquired) {
        return { run, attached: false, reason: 'AUTONOMOUS_RUN_ALREADY_ACTIVE', lease: claim.heldBy };
      }
      return { run, attached: true };
    },

    /**
     * Takes the loop over from an orchestrator proven to be gone.
     *
     * The proof is made elsewhere; this only performs the swap, and only
     * against the exact lease that was judged. A new attempt number is recorded
     * so the history reads as "attempt 2 recovered attempt 1", never as a
     * second run of the same one.
     */
    async takeoverLoopLease({ expected, proof }) {
      const run = await this.read();
      if (!run) throw new SpikeError('NO_AUTONOMOUS_RUN', 'There is no autonomous run to take over');

      const attempt = (run.attempt ?? 1) + 1;
      const result = await leases.takeoverJob(LOOP_LEASE_KEY, {
        expected,
        proof,
        payload: loopLeasePayload({ autonomousRunId: run.autonomousRunId, attempt }),
      });
      if (!result.acquired) return result;

      const updated = await this.write({
        ...run,
        attempt,
        ownerInstanceId: result.lease.workerInstanceId,
        recoveredAt: new Date().toISOString(),
        recoveryCount: (run.recoveryCount ?? 0) + 1,
        lastRecovery: { proof: proof ?? null, from: expected?.workerInstanceId ?? null, at: new Date().toISOString() },
      });
      return { ...result, run: updated };
    },

    renewLoopLease() { return leases.renewJob(LOOP_LEASE_KEY).catch(() => null); },
    readLoopLease() { return leases.readJobLease(LOOP_LEASE_KEY); },
    releaseLoopLease(options) { return leases.releaseJob(LOOP_LEASE_KEY, options); },

    async requestPause({ afterGoal = false } = {}) {
      const run = await this.read();
      if (!run) throw new SpikeError('NO_AUTONOMOUS_RUN', 'There is no autonomous run to pause');
      // A pause request is a flag, never a kill: an inference in flight finishes.
      return this.write({ ...run, pauseRequested: true, pauseAfterGoal: afterGoal });
    },

    async markPaused(reason) {
      const run = await this.read();
      return this.write({
        ...run, status: RUN_STATUS.PAUSED, pausedAt: new Date().toISOString(), pauseReason: reason ?? null,
      });
    },

    async markHumanRequired(reason, detail) {
      const run = await this.read();
      return this.write({
        ...run,
        status: RUN_STATUS.PAUSED_FOR_HUMAN,
        humanRequired: { reason, detail: detail ?? null, at: new Date().toISOString() },
      });
    },

    async markCompleted(reason) {
      const run = await this.read();
      return this.write({
        ...run, status: RUN_STATUS.COMPLETED, completedAt: new Date().toISOString(), completionReason: reason ?? null,
      });
    },

    async recordGoalCompleted(goalId, baseline) {
      const run = await this.read();
      const completedGoals = [...(run.completedGoals ?? [])];
      // Idempotent: a resumed run must not count the same Goal twice.
      if (!completedGoals.includes(goalId)) completedGoals.push(goalId);
      return this.write({ ...run, completedGoals, migrationAcceptedBaseline: baseline });
    },

    async setCurrentGoal(goalId) {
      const run = await this.read();
      return this.write({ ...run, currentGoal: goalId });
    },

    /**
     * Retires a run stopped for a human, recording who said the problem was
     * resolved and why.
     *
     * This is the ONLY way past PAUSED_FOR_HUMAN, and it is deliberately not
     * something the loop can do to itself: the archived file is the audit trail
     * of a person's decision. The run is never merely deleted.
     */
    async archiveRun({ resolvedBy, note }) {
      const run = await this.read();
      if (!run) throw new SpikeError('NO_AUTONOMOUS_RUN', 'There is no autonomous run to archive');
      if (run.status === RUN_STATUS.RUNNING) {
        throw new SpikeError('AUTONOMOUS_RUN_ALREADY_ACTIVE',
          `Run ${run.autonomousRunId} is still RUNNING; pause or resolve it before archiving.`);
      }
      if (!note || String(note).trim() === '') {
        throw new SpikeError('INVALID_ARGS', 'Archiving a stopped run requires a note saying what was resolved');
      }

      const archived = {
        ...run,
        archivedAt: new Date().toISOString(),
        resolvedBy: resolvedBy ?? 'unknown',
        resolutionNote: note,
      };
      await writeJsonAtomic(`${stateDir}/autonomous-runs/${run.autonomousRunId}.json`, archived);
      await rm(path, { force: true });
      return archived;
    },

    async clearPause() {
      const run = await this.read();
      return this.write({
        ...run, status: RUN_STATUS.RUNNING, pauseRequested: false, pauseAfterGoal: false, pauseReason: null,
      });
    },
  };
}

/**
 * Decides whether the loop may cross a safe boundary.
 *
 * Called only AT boundaries, never mid-inference: a pause must not interrupt a
 * write or kill a child process.
 */
export function shouldPauseAt(run, { boundary }) {
  if (!run?.pauseRequested) return { pause: false };

  if (run.pauseAfterGoal) {
    // Wait for the whole Goal to finish, which is what makes the tree
    // inspectable when the loop stops.
    if (boundary === 'GOAL_BOUNDARY') {
      return { pause: true, reason: 'PAUSE_REQUESTED_AFTER_GOAL' };
    }
    return { pause: false };
  }

  return { pause: true, reason: 'PAUSE_REQUESTED' };
}
