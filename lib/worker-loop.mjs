/**
 * IA Loop — shared worker plumbing.
 *
 * The two workers share transport, heartbeat and the job polling loop. They do
 * NOT share session lifecycle: that difference lives in each worker and is the
 * whole point of the hybrid architecture.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SpikeError } from './claude-process.mjs';
import { startHeartbeat } from './worker-registry.mjs';
import {
  acquireWorkerIdentity,
  codeChangedSince,
  computeCodeVersion,
  describeHolder,
  startWorkerIdentityHeartbeat,
} from './worker-identity.mjs';
import {
  attemptIdFor,
  canStartNewAttempt,
  createLeaseStore,
  startLeaseHeartbeat,
  workerInstanceId,
} from './leases.mjs';
import { isClaimableJobStatus } from './job-store.mjs';
import { createResourceRegistry } from './resource-registry.mjs';
import { cleanupResourcesForAttempt, scavengeOrphans } from './resource-lifecycle.mjs';
import { logResourceEvent } from './shutdown-hooks.mjs';

/** Moderate polling. No file watcher needed at this cadence, no busy loop. */
export const POLL_INTERVAL_MS = 1_000;

/** The ia-loop package root, used to fingerprint the code this worker runs. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The idle banner.
 *
 * A worker whose model is fixed prints it. A worker whose model is chosen per
 * job prints the profiles it CAN execute instead — stating a single model
 * there would be a claim the worker is not entitled to make.
 */
export function banner({ title, model = null, supportedProfiles = null, sessionLine, extra = [] }) {
  const identity = supportedProfiles
    ? ['Supported profiles:', ...supportedProfiles.map((profile) => `  ${profile}`)]
    : [`Model: ${model}`];

  return [
    '',
    `ATENDLY IA LOOP — ${title}`,
    '',
    ...identity,
    ...extra,
    sessionLine,
    'State: IDLE',
    '',
  ].join('\n');
}

export function log(tag, message = '') {
  const time = new Date().toISOString().slice(11, 19);
  console.log(`${time} [${tag}]${message ? ` ${message}` : ''}`);
}

// Deliberately NOT unref'd: this timer is what keeps the worker process alive
// between polls. The heartbeat timer is unref'd precisely because it must not
// be the thing holding the process open.
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Decides whether a job is worth looking at again, and names why when it is
 * not — persisted state, never an in-memory Set, decides eligibility.
 *
 * `seen` is a cache of "nothing has changed here since I last looked", keyed
 * by the exact persisted facts that decide eligibility. It is deliberately NOT
 * "this worker has permanently dealt with this job" — that reading is what let
 * a job repaired from outside the process (ia-loop:reclassify moving FAILED to
 * WAITING_FOR_CAPACITY, ia-loop:resume moving that to QUEUED, all on the SAME
 * attempt number) go silently unnoticed by a worker that never restarted: the
 * old key was jobId+attempt alone, so the SAME key it had already cached at
 * claim time for attempt 1 matched again after the repair, and the job was
 * skipped at the very first line, before any status was even re-read.
 *
 * The key is attempt + status + statusAt, not attempt + status alone — status
 * by itself is not enough, because a repaired job legitimately returns to the
 * EXACT SAME status string it started at: QUEUED is both "freshly dispatched,
 * never attempted" and "just requeued by ia-loop:resume after a repair", and
 * attempt does not change either — creating attempt 2 is what the resumed
 * attempt is FOR, via startNextAttempt, not something that has already
 * happened by the time this job is looked at again. `statusAt` is what tells
 * the two apart: every write that changes status — setJobStatus, and the
 * repair's own direct write — stamps a fresh one, so a job that went
 * QUEUED -> RUNNING -> FAILED -> WAITING_FOR_CAPACITY -> QUEUED never revisits
 * a `statusAt` it already used, however many times `status` itself repeats.
 *
 * Any of the three changing produces a different key, so the cache misses and
 * the job is evaluated fresh from disk — no restart required, and the
 * persisted job/attempt/lease state is what actually decides, exactly as it
 * does for a request that arrives while the worker was never polling at all.
 * Concurrency safety does not come from this cache at all: it comes from
 * `canStartNewAttempt`'s lease check below, which is authoritative across
 * processes and untouched by anything cached in memory.
 */
export async function evaluateJobEligibility({ store, leaseStore, role, jobId, seen }) {
  const attemptState = await store.readAttemptState(role, jobId);
  if (!attemptState) {
    // The file does not exist yet, or is mid-write between listJobs() and this
    // read. Not a state worth caching: it resolves itself on the next poll.
    return { eligible: false, cache: false, reason: 'JOB_FILE_UNREADABLE' };
  }

  const seenKey = `${jobId}#a${attemptState.attempt}:${attemptState.attemptStatus}@${attemptState.statusAt}`;
  if (seen.has(seenKey)) {
    // Already evaluated and already logged, for this exact persisted state.
    // Silence here is correct, not a gap: nothing has changed to report.
    return { eligible: false, cache: 'HIT', seenKey, attemptState, reason: 'ALREADY_EVALUATED' };
  }

  // A job that reached a terminal status is never re-run: only an explicit
  // transition (a new jobId, or a repair tool moving the SAME attempt back to
  // a claimable status) may make it eligible again, and either one changes
  // this attemptState and therefore this key.
  if (!isClaimableJobStatus(attemptState.status)) {
    return {
      eligible: false, cache: 'ADD', seenKey, attemptState,
      reason: 'TERMINAL', detail: `${jobId} is ${attemptState.status}`,
    };
  }

  // The CURRENT ATTEMPT may be unclaimable even when the job-level status
  // looks fine (a REROUTED job mid-transition, for instance). Not cached: the
  // next attempt materialising is exactly what this worker should notice
  // without needing the status to change first.
  if (!isClaimableJobStatus(attemptState.attemptStatus)) {
    return {
      eligible: false, cache: false, seenKey, attemptState,
      reason: 'ATTEMPT_NOT_CLAIMABLE',
      detail: `${attemptState.attemptId} is ${attemptState.attemptStatus}`,
    };
  }

  // Ownership, decided by the filesystem lease rather than by anything cached
  // here. This is the actual concurrency guard — the one thing two workers (or
  // two polls) racing for the same job cannot both win.
  const lease = await leaseStore.readJobLease(jobId);
  const verdict = canStartNewAttempt({ lease, jobStatus: attemptState.status });
  if (!verdict.allowed) {
    return {
      eligible: false, cache: false, seenKey, attemptState, lease, verdict,
      reason: 'LEASE_BLOCKED',
      detail: `${jobId}: ${verdict.reason} — ${verdict.detail ?? ''}`,
    };
  }

  return { eligible: true, cache: 'ADD', seenKey, attemptState, lease, verdict };
}

/**
 * Runs the worker until the process is asked to stop.
 *
 * `handleJob(job)` is called for each queued job; the worker returns to IDLE
 * afterwards regardless of the outcome, so one bad job never wedges the loop.
 */
export async function runWorkerLoop({
  store,
  role,
  getStatus,
  handleJob,
  pollIntervalMs = POLL_INTERVAL_MS,
  leaseStore = createLeaseStore(store.paths.root),
  resourceRegistry = createResourceRegistry(store.paths.root),
  /**
   * The role's singleton guard. On by default and only ever disabled by a test
   * that drives the loop directly: two workers of one role is precisely the
   * condition this exists to make impossible.
   */
  enforceIdentity = true,
  packageRoot = PACKAGE_ROOT,
  /**
   * Announces the worker as ready. Called ONLY once the role lease is held,
   * because a process that is about to refuse to start must not first print a
   * banner saying it is waiting for work.
   */
  onStarted = () => {},
}) {
  await mkdir(store.paths.jobsDir(role), { recursive: true });
  log('WORKER', `instance ${workerInstanceId()}`);

  // Claimed BEFORE anything else this worker does. A second process of the
  // same role must fail here, loudly, rather than coexist: on 2026-09-09 two
  // Tech Leads polled the same queue for five hours, each correctly refusing
  // the other's jobs, and the work silently landed in the older one.
  let releaseIdentity = async () => {};
  let bootCodeVersion = null;
  if (enforceIdentity) {
    const codeVersion = await computeCodeVersion({ root: packageRoot });
    bootCodeVersion = codeVersion.version;

    const identity = await acquireWorkerIdentity({
      leaseStore, role, repoRoot: packageRoot, codeVersion,
    });
    if (!identity.acquired) {
      log('REFUSING TO START', `${identity.reason} — held by ${describeHolder(identity.heldBy)}`);
      throw new SpikeError(
        identity.reason,
        `Another ${role} worker holds this role (${describeHolder(identity.heldBy)}). `
        + `Stop it before starting another, or run ia-loop:recover if it is gone. [${identity.verdict}: ${identity.detail}]`,
      );
    }
    if (identity.tookOver) {
      log('IDENTITY', `took over from ${describeHolder(identity.replaced)} — ${identity.verdict}`);
      await store.appendEvent({
        type: 'WORKER_IDENTITY_TAKEOVER', role,
        from: identity.replaced?.workerInstanceId ?? null,
        verdict: identity.verdict,
      }).catch(() => {});
    }
    log('IDENTITY', `${role} held by ${workerInstanceId()} · code ${bootCodeVersion} (${codeVersion.fileCount} files)`);

    const stopIdentityHeartbeat = startWorkerIdentityHeartbeat(leaseStore, role, {
      onError: (error) => log('ERROR', `identity heartbeat: ${error.message}`),
    });
    releaseIdentity = async () => {
      await stopIdentityHeartbeat();
      await leaseStore.releaseWorker(role).catch(() => {});
    };
  }

  // Crash recovery: anything a PREVIOUS instance of this worker left ACTIVE
  // (a crash, a killed terminal, a reboot — none of which run a `finally`)
  // is judged and, if provably orphaned, cleaned before this instance claims
  // any work. Best-effort: a scavenger failure must never block startup.
  try {
    const { report } = await scavengeOrphans(resourceRegistry, { stateDir: store.paths.root });
    for (const entry of report) {
      if (entry.verdict === 'ORPHAN_CONFIRMED') {
        logResourceEvent(log, 'TEMP_RESOURCE_ORPHAN_CONFIRMED', `${entry.resourceId} cleaned=${entry.cleaned}`);
      } else if (entry.verdict === 'ORPHAN_SUSPECTED') {
        logResourceEvent(log, 'TEMP_RESOURCE_ORPHAN_SUSPECTED', `${entry.resourceId} — ${entry.detail}`);
      }
    }
  } catch (error) {
    log('ERROR', `startup resource scavenger failed: ${error.message}`);
  }

  // Past this point the role is genuinely ours, so saying so is true.
  onStarted();

  const stopHeartbeat = startHeartbeat(store, role, getStatus);
  let running = true;

  // Tracks the attempt currently in flight (if any) so a signal mid-attempt
  // can clean up what THAT attempt owns instead of exiting and leaving it
  // behind. Cleared the moment the normal per-attempt cleanup already ran.
  let inFlightAttemptId = null;

  const shutdown = async (signal) => {
    if (!running) return;
    running = false;
    log('STOPPING', `signal ${signal}`);
    if (inFlightAttemptId) {
      try {
        const { results } = await cleanupResourcesForAttempt(resourceRegistry, inFlightAttemptId, { stateDir: store.paths.root });
        for (const result of results) logResourceEvent(log, 'TEMP_RESOURCE_CLEANUP_STARTED', `${result.resourceId} (shutdown)`);
      } catch (error) {
        log('ERROR', `resource cleanup on shutdown failed: ${error.message}`);
      }
    }
    await stopHeartbeat();
    // Released last, so nothing can claim the role while this process is still
    // cleaning up what its attempt owned.
    await releaseIdentity();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  const seen = new Set();
  /**
   * A reason to stop that is NOT a crash, carried out of the loop so the
   * process can exit with a code that says so. Thrown after the loop unwinds,
   * never from inside it: the per-job catch there would log it as a failed job.
   */
  let fatal = null;

  while (running) {
    let files = [];
    try {
      files = await store.listJobs(role);
    } catch (error) {
      log('ERROR', `cannot list jobs: ${error.message}`);
    }

    // Eligibility is decided fresh from persisted state every time — see
    // evaluateJobEligibility. `seen` only remembers "nothing has changed since
    // I looked", keyed by attempt AND status, so a repair applied from outside
    // this process (ia-loop:reclassify, ia-loop:resume) is never invisible to
    // a worker that never restarted: it changes the status, which changes the
    // key, which is exactly what makes the cache miss and the job get looked
    // at again.
    for (const file of files) {
      const jobId = file.replace(/\.json$/, '');
      const eligibility = await evaluateJobEligibility({ store, leaseStore, role, jobId, seen });

      if (eligibility.cache === 'HIT') continue;

      if (!eligibility.eligible) {
        if (eligibility.cache === 'ADD') seen.add(eligibility.seenKey);
        if (eligibility.reason === 'LEASE_BLOCKED') {
          log('SKIP', eligibility.detail);
          if (eligibility.verdict?.escalate) {
            await store.appendEvent({ type: 'ORPHANED_EXECUTION_UNCERTAIN', role, jobId, detail: eligibility.verdict.detail });
          }
        } else if (eligibility.detail) {
          // TERMINAL and ATTEMPT_NOT_CLAIMABLE both carry a ready-made detail
          // line; JOB_FILE_UNREADABLE carries none because it is transient —
          // the file existing or not by the next poll is the only fact that
          // matters, and logging a race on every listing would be noise, not
          // observability.
          log('SKIP', eligibility.detail);
        }
        continue;
      }

      const { attemptState } = eligibility;
      let claimed = null;
      let stopLeaseHeartbeat = null;
      // Declared here, not inside the try: the finally block below needs it
      // to clean up this attempt's resources, and a `const` scoped to the
      // try would not be visible there.
      let attemptId = null;
      try {
        const job = await store.readJob(role, jobId);

        // The last gate before this worker commits to executing something.
        //
        // Checked here rather than every poll because it costs a directory
        // walk, and here it costs one only when there is actually work to
        // take. A worker whose sources changed underneath it keeps its lease
        // and stops accepting jobs: it must not execute a version nobody can
        // reason about, and it must not release the role to a process that
        // would then race it.
        if (bootCodeVersion) {
          const { changed, current } = await codeChangedSince({ root: packageRoot, bootVersion: bootCodeVersion });
          if (changed) {
            log('CODE CHANGED', `booted with ${bootCodeVersion}, on disk ${current?.version} — stopping before taking this job`);
            await store.appendEvent({
              type: 'WORKER_CODE_STALE', role,
              bootCodeVersion, currentCodeVersion: current?.version ?? null,
            }).catch(() => {});
            // Stopping rather than idling forever: a worker that keeps its role
            // while refusing every job is a role nobody else can take. Exiting
            // releases it, and the dedicated exit code stops a supervisor from
            // restarting into code the operator has not chosen to deploy.
            fatal = new SpikeError(
              'WORKER_CODE_CHANGED',
              `ia-loop code changed since this ${role} booted `
              + `(${bootCodeVersion} -> ${current?.version ?? 'unknown'}). Restart the worker to pick it up.`,
            );
            running = false;
            break;
          }
        }

        seen.add(eligibility.seenKey);

        // The attempt number lives on the job. Hardcoding 1 meant a second
        // attempt at an interrupted stage would have carried the first
        // attempt's id, and result fencing could not have told them apart.
        attemptId = attemptIdFor(jobId, attemptState.attempt);
        claimed = await leaseStore.claimJob(jobId, {
          attemptId, agent: role, goal: job.goal, round: job.round, worktree: job.worktree,
        });
        if (!claimed.acquired) {
          // Another worker won the race. Exactly one claim survives.
          log('SKIP', `${jobId}: ${claimed.reason} by ${claimed.heldBy?.workerInstanceId ?? 'unknown'}`);
          continue;
        }

        // A job that may WRITE also needs exclusive ownership of the worktree.
        if (job.worktree) {
          const wt = await leaseStore.claimWorktree(job.worktree, { attemptId, jobId, agent: role });
          if (!wt.acquired) {
            log('SKIP', `${jobId}: WORKTREE_BUSY (held by ${wt.heldBy?.attemptId ?? 'unknown'})`);
            await leaseStore.releaseJob(jobId);
            claimed = null;
            continue;
          }
        }

        // Renewed throughout the inference, however long it runs.
        stopLeaseHeartbeat = startLeaseHeartbeat(leaseStore, { jobId, worktreePath: job.worktree });

        // Visible to shutdown() for the duration of the inference, so a
        // signal arriving mid-attempt cleans up what THIS attempt owns
        // instead of exiting and leaving it running.
        inFlightAttemptId = attemptId;

        await handleJob({ ...job, attemptId, workerInstanceId: workerInstanceId() });
      } catch (error) {
        log('ERROR', `job ${jobId}: [${error.code ?? 'UNEXPECTED'}] ${error.message}`);
        await store.appendEvent({ type: 'JOB_FAILED', role, jobId, code: error.code ?? 'UNEXPECTED', message: error.message });
      } finally {
        // Whatever this attempt created — however it ended: COMPLETED,
        // FAILED, WAITING_FOR_CAPACITY, or the catch above — is cleaned up
        // before the lease is released. A resource must never outlive the
        // attempt that owns it, and this `finally` runs on every path out.
        if (attemptId) {
          try {
            const { results } = await cleanupResourcesForAttempt(resourceRegistry, attemptId, { stateDir: store.paths.root });
            for (const result of results) logResourceEvent(log, 'TEMP_RESOURCE_CLEANUP_STARTED', `${result.resourceId} (attempt ended)`);
          } catch (error) {
            log('ERROR', `resource cleanup for ${attemptId} failed: ${error.message}`);
          }
        }
        inFlightAttemptId = null;

        // Released only once the execution really ended, so nothing else can
        // start while this attempt might still be writing.
        if (stopLeaseHeartbeat) await stopLeaseHeartbeat();
        if (claimed?.acquired) {
          const job = await store.readJob(role, jobId).catch(() => null);
          if (job?.worktree) await leaseStore.releaseWorktree(job.worktree).catch(() => {});
          await leaseStore.releaseJob(jobId).catch(() => {});
        }
      }
      log('IDLE');
    }

    if (running) await sleep(pollIntervalMs);
  }

  // Reached only by a deliberate stop; `shutdown` exits the process directly.
  await stopHeartbeat();
  await releaseIdentity();
  if (fatal) throw fatal;
}
