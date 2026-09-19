#!/usr/bin/env node
/**
 * IA Loop — resume.
 *
 *   npm run ia-loop:resume
 *
 * Picks up a run parked by a capacity limit, from disk alone. It resumes the
 * exact step that was blocked and never re-runs work that already produced a
 * result.
 *
 * It is not an override: a run in HUMAN_REQUIRED stays there.
 *
 * A capacity wait is not a crash, and ia-loop:recover correctly refuses to
 * touch one — but the PROCESS that was sleeping out the wait can still die
 * (the machine it ran on rebooted), and its lease then survives the wait it
 * was serving. The job's status genuinely is resumable (WAITING_FOR_CAPACITY
 * is in RETRYABLE_JOB_STATUSES), but the worker refuses it anyway: an
 * unrenewed lease it cannot prove abandoned reads as "a child process may
 * still be writing" forever, once a second per poll, and nothing here used to
 * clear it. Requeuing alone was not enough.
 *
 * This resumes the SAME logical job, at whatever attempt is current — it never
 * mints one itself. The worker's own retry loop is what advances the attempt
 * number, exactly as every other capacity retry already does.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SpikeError } from './lib/claude-process.mjs';
import { createJobStore } from './lib/job-store.mjs';
import {
  clearResolvedCapacityBlock, readRuntimeStrict, remainingWaitMs, validateWaitingRuntime,
} from './lib/capacity-state.mjs';
import { formatRemaining } from './lib/capacity-policy.mjs';
import { LOOP_STATES } from './lib/loop-state.mjs';
import { AGENT_EXECUTION_STATES } from './lib/recovery-plan.mjs';
import { readWorkerHealth, WORKER_HEALTH } from './lib/worker-registry.mjs';
import { createLeaseStore } from './lib/leases.mjs';
import { createProcessInspector } from './lib/process-inspector.mjs';
import { collectOwnerEvidence, isRecoveryEligible, judgeOwner } from './lib/orphan-evidence.mjs';
import { isDirectExecution } from './lib/direct-execution.mjs';

/**
 * Retires the blocked job's lease, but only when its holder is a PROVEN
 * orphan — the same standard of proof ia-loop:recover uses for its own lease
 * sweep, deliberately not relaxed here.
 *
 * Three outcomes:
 *   NO_LEASE     nothing to do — the common case, when nothing rebooted.
 *   RECLAIMED    the holder is confirmed gone; the lease (and any worktree
 *                lease it matches) is retired, auditably.
 *   NOT_PROVEN   a lease exists and abandonment could not be proven. Resume
 *                refuses to go further: forcing the job to QUEUED with a live
 *                lease still on it would just move the ambiguity, not resolve
 *                it, and a worker that finds the job unclaimable would be
 *                right to say so.
 */
export async function reclaimBlockedJobLease({ leaseStore, inspector, jobId, now = Date.now() }) {
  const lease = await leaseStore.readJobLease(jobId);
  if (!lease) return { outcome: 'NO_LEASE' };

  const evidence = await collectOwnerEvidence(lease, inspector, { now });
  const verdict = judgeOwner({ lease, evidence, now });
  if (!isRecoveryEligible(verdict)) {
    return { outcome: 'NOT_PROVEN', lease, verdict };
  }

  const retired = await leaseStore.retireJob(jobId, { expected: lease, proof: verdict.proof });
  if (!retired.retired) return { outcome: 'NOT_PROVEN', lease, verdict, reason: retired.reason };

  if (lease.worktree) {
    const wt = await leaseStore.readWorktreeLease(lease.worktree).catch(() => null);
    if (wt && wt.attemptId === lease.attemptId) {
      await leaseStore.retireWorktree(lease.worktree, { expected: wt, proof: verdict.proof }).catch(() => null);
    }
  }

  return { outcome: 'RECLAIMED', lease, proof: verdict.proof };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, '.state');

/**
 * Decides what resuming should do, from persisted state only.
 * Exported so the decision is unit-testable without touching disk twice.
 */
export function planResume(runtime, { now, workerHealth = {} }) {
  if (!runtime) {
    return { action: 'NOTHING_TO_RESUME', message: 'No run recorded yet.' };
  }

  if (runtime.state === LOOP_STATES.HUMAN_REQUIRED) {
    // Resume must never be a way to skip a human gate.
    return {
      action: 'BLOCKED_BY_HUMAN',
      message: `Run is HUMAN_REQUIRED (${runtime.humanRequired?.reason ?? 'unknown reason'}). Resume will not override it.`,
    };
  }

  if (runtime.state !== LOOP_STATES.WAITING_FOR_CAPACITY) {
    // Resume answers one question: has the capacity wait elapsed? A run stuck
    // in an execution state was not parked, it was interrupted — a different
    // problem with a different answer. Saying so beats reporting "nothing to
    // do" to someone whose machine just rebooted mid-run.
    const interrupted = AGENT_EXECUTION_STATES.includes(runtime.state);
    return {
      action: 'NOTHING_TO_RESUME',
      message: interrupted
        ? `Run is ${runtime.state}; nothing is parked waiting for capacity. An execution in that state that is `
          + 'no longer progressing was interrupted rather than rate-limited: npm run ia-loop:recover'
        : `Run is ${runtime.state}; nothing is parked waiting for capacity.`,
    };
  }

  validateWaitingRuntime(runtime);

  const remaining = remainingWaitMs(runtime, now);
  if (remaining > 0) {
    return {
      action: 'WAIT',
      remainingMs: remaining,
      message: `Still waiting for capacity: ${formatRemaining(remaining)} to go (${runtime.capacity.reason}).`,
      runtime,
    };
  }

  const health = workerHealth[runtime.blockedAgent];
  if (health && health.health === WORKER_HEALTH.OFFLINE) {
    return {
      action: 'WORKER_OFFLINE',
      message: `The ${runtime.blockedAgent} worker is not running. Start it, then resume.`,
      runtime,
    };
  }

  return {
    action: 'RESUME',
    resumeFrom: runtime.resumeFrom,
    jobId: runtime.blockedJobId,
    agent: runtime.blockedAgent,
    message: `Ready to resume ${runtime.goal}/R${runtime.round} at ${runtime.resumeFrom}.`,
    runtime,
  };
}

async function main() {
  const store = createJobStore(STATE_DIR);
  const runtime = await readRuntimeStrict(store);

  const [techLeadHealth, developerHealth] = await Promise.all([
    readWorkerHealth(store, 'tech_lead'),
    readWorkerHealth(store, 'developer'),
  ]);

  const plan = planResume(runtime, {
    now: Date.now(),
    workerHealth: { tech_lead: techLeadHealth, developer: developerHealth },
  });

  const out = ['', 'ATENDLY IA LOOP — RESUME', ''];

  if (plan.action === 'NOTHING_TO_RESUME') {
    out.push(plan.message);
    console.log(out.join('\n'));
    // Nothing to do is a normal outcome, not an error.
    return 0;
  }

  if (plan.action === 'BLOCKED_BY_HUMAN') {
    out.push(plan.message);
    out.push('');
    out.push('Resolve the underlying cause, then decide explicitly how to continue.');
    console.error(out.join('\n'));
    return 1;
  }

  out.push(`Goal: ${plan.runtime.goal}`);
  out.push(`Round: ${plan.runtime.round}`);
  out.push(`Blocked agent: ${plan.runtime.blockedAgent}`);
  out.push(`Reason: ${plan.runtime.capacity.reason}`);
  out.push(`Resume from: ${plan.runtime.resumeFrom}`);
  out.push('');

  if (plan.action === 'WAIT') {
    out.push(plan.message);
    out.push('');
    out.push('No model was called. The worker resumes on its own at the recorded deadline.');
    console.log(out.join('\n'));
    return 0;
  }

  if (plan.action === 'WORKER_OFFLINE') {
    out.push(plan.message);
    out.push('');
    out.push('  npm run ia-loop:tech-lead');
    out.push('  npm run ia-loop:developer');
    console.error(out.join('\n'));
    return 1;
  }

  // RESUME: the blocked job is still on disk with its status, so the worker
  // that owns it picks it up. If a result already exists, it is reused rather
  // than recomputed.
  const jobId = plan.jobId;
  const alreadyDone = jobId ? await store.hasCompletedResult(plan.agent, jobId) : false;

  if (alreadyDone) {
    out.push('A result for the blocked job already exists on disk.');
    out.push('The model will NOT be called again; the state machine advances from it.');
  } else {
    // The lease of whatever process was waiting out the capacity limit goes
    // first, and only with proof — the process that claimed it may simply
    // still be running (a long sleep, not a crash), and requeuing underneath
    // a live lease would make two things think they own the same attempt.
    const leaseStore = createLeaseStore(STATE_DIR);
    const reclaim = await reclaimBlockedJobLease({
      leaseStore, inspector: createProcessInspector(), jobId,
    });

    if (reclaim.outcome === 'NOT_PROVEN') {
      out.push(`The ${plan.agent} attempt still holds its lease and abandonment is not proven: ${reclaim.verdict?.detail ?? reclaim.reason ?? 'unknown'}`);
      out.push('');
      out.push('If that process is genuinely still working, let it finish. Otherwise investigate');
      out.push('before forcing anything — this is exactly the ambiguity ia-loop:recover refuses to guess through.');
      console.error(out.join('\n'));
      return 1;
    }

    if (reclaim.outcome === 'RECLAIMED') {
      await store.appendEvent({
        type: 'ORPHANED_LEASE_RETIRED',
        goal: plan.runtime.goal, round: plan.runtime.round, jobId,
        owner: reclaim.lease.workerInstanceId ?? null, proof: reclaim.proof,
        attemptId: reclaim.lease.attemptId ?? null,
      });
      out.push(`Retired the lease of ${reclaim.lease.attemptId ?? jobId} (${reclaim.proof}); its holder did not survive a restart.`);
    }

    await store.setJobStatus(plan.agent, jobId, 'QUEUED');
    out.push(plan.message);
    out.push('Job re-queued for its worker. No duplicate job was created.');
  }

  await store.appendEvent({
    type: 'CAPACITY_RESUME_REQUESTED',
    goal: plan.runtime.goal,
    round: plan.runtime.round,
    agent: plan.agent,
    jobId,
    resumeFrom: plan.resumeFrom,
    alreadyCompleted: alreadyDone,
  });

  // The wait this resume answers is over — requeued for its worker, or
  // already had a result. `runtime.capacity`/`blockedJobId` describing it as
  // still pending is now stale; `state` is left alone, since resume does not
  // know (and must not guess) what the job's real next state is — that is
  // read-status.mjs, and eventually ia-loop:goal, deriving it fresh from the
  // job's own status, exactly as they already do for a runtime.state that
  // disagrees with disk. History is preserved: CAPACITY_RESUME_REQUESTED,
  // just appended above, already recorded that this happened.
  await clearResolvedCapacityBlock(store, { jobId, now: Date.now() });

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
      console.error(`ATENDLY IA LOOP — RESUME\n\nBlocker: [${code}] ${error.message}`);
      process.exitCode = 1;
    });
}
