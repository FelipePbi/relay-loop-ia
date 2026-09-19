/**
 * IA Loop — job ownership and leases.
 *
 * Enforces one invariant: for a logical operation, there is never more than one
 * concurrent agent execution.
 *
 * This exists because of a real incident. A runner gave up waiting on a job
 * while the worker was still running it; a second correction was then queued for
 * the same round, and two Opus inferences worked on the same worktree at once.
 * Nothing broke that time, which is exactly why it needed fixing.
 *
 * Vocabulary:
 *   logical job      the operation itself — goal003 / correction / round 2
 *   attempt          one concrete execution of it — <jobId>-a1, -a2, …
 *   worker instance  one live worker process, never reused across restarts
 *   lease            durable proof that an attempt owns the job or the worktree
 *
 * The claim is a real filesystem primitive (exclusive create), not a
 * read-check-write, because two processes can both pass a check.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { SpikeError } from './claude-process.mjs';
import { selfIdentity } from './process-inspector.mjs';
import { isTerminalJobStatus } from './job-store.mjs';

export const LEASE_CONFIG = Object.freeze({
  /** How often a holder renews while the model is running. */
  heartbeatMs: Number(process.env.IA_LOOP_LEASE_HEARTBEAT_MS ?? 10_000),
  /**
   * A lease older than this is SUSPECT, not dead. Several heartbeats wide, so a
   * slow disk or a long inference never looks like an orphan.
   */
  expiryMs: Number(process.env.IA_LOOP_LEASE_EXPIRY_MS ?? 90_000),
});

export const LEASE_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  SUSPECTED_ORPHAN: 'SUSPECTED_ORPHAN',
  RELEASED: 'RELEASED',
});

/** Identity of THIS process. Never reused after a restart. */
const WORKER_INSTANCE_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;
export function workerInstanceId() {
  return WORKER_INSTANCE_ID;
}

/** Stable id for a logical job, independent of how many attempts it takes. */
export function logicalJobId({ goal, round, kind }) {
  if (!goal || !kind) throw new SpikeError('INVALID_ARGS', 'goal and kind are required');
  return round ? `${goal}-r${round}-${kind}` : `${goal}-${kind}`;
}

export function attemptIdFor(jobId, attemptNumber) {
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    throw new SpikeError('INVALID_ARGS', 'attemptNumber must be an integer >= 1');
  }
  return `${jobId}-a${attemptNumber}`;
}

/** Filesystem-safe key for a worktree path. */
export function worktreeKey(path) {
  return createHash('sha256').update(String(path).replace(/\\/g, '/')).digest('hex').slice(0, 16);
}

/** Why a lease of each kind could not be acquired. */
const BUSY_REASON = Object.freeze({
  job: 'JOB_ALREADY_CLAIMED',
  worktree: 'WORKTREE_BUSY',
  worker: 'WORKER_ALREADY_RUNNING',
});

/** How long a reader waits for an in-flight claim to finish writing itself. */
const CLAIM_SETTLE_ATTEMPTS = 20;
const CLAIM_SETTLE_DELAY_MS = 25;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Has the lease moved since it was judged?
 *
 * The version answers it exactly. heartbeatAt is kept as the fallback for a
 * lease written before versions existed, where it is the best available
 * signal — and being the FALLBACK is the point: on its own it once let a
 * renew inside the same millisecond pass unnoticed.
 */
export function leaseMoved(current, expected) {
  if (!expected) return true;
  if (current.workerInstanceId !== expected.workerInstanceId) return true;

  if (Number.isInteger(current.version) && Number.isInteger(expected.version)) {
    return current.version !== expected.version;
  }
  return current.heartbeatAt !== expected.heartbeatAt;
}

export function createLeaseStore(stateDir, { config = LEASE_CONFIG } = {}) {
  const jobsDir = join(stateDir, 'leases', 'jobs');
  const worktreesDir = join(stateDir, 'leases', 'worktrees');
  /**
   * A third kind, for the SINGLETON identity of a worker role.
   *
   * A job lease answers "is this job being executed?" and a worktree lease
   * answers "is anyone writing here?". Neither answers "is another Tech Lead
   * process alive?", which is why two of them could coexist indefinitely: each
   * one refused the other's JOBS, correctly, while both kept polling forever.
   */
  const workersDir = join(stateDir, 'leases', 'workers');

  const DIRS = { job: jobsDir, worktree: worktreesDir, worker: workersDir };
  const pathFor = (kind, key) => join(DIRS[kind] ?? worktreesDir, `${key}.lock`);

  /**
   * Acquires a lease by creating its file EXCLUSIVELY.
   *
   * `open(path, 'wx')` fails when the file exists, and the check-and-create is
   * a single syscall — that atomicity is the whole point. A read-then-write
   * would let two processes both decide the lease is free.
   */
  async function acquire(kind, key, payload) {
    const path = pathFor(kind, key);
    await mkdir(dirname(path), { recursive: true });

    const now = new Date();
    // Identity is stamped here, on every lease, so recovery can later ask
    // whether the holder can still write. A pid alone would not answer it:
    // both Windows and POSIX recycle process ids.
    const identity = selfIdentity({ now: now.getTime() });
    const lease = {
      ...payload,
      kind,
      key,
      workerInstanceId: WORKER_INSTANCE_ID,
      ...identity,
      status: LEASE_STATUS.ACTIVE,
      // A monotonic version, because a timestamp is not one. heartbeatAt has
      // millisecond resolution, so a claim and a renew inside the same
      // millisecond are indistinguishable — and a compare-and-swap that
      // cannot tell them apart will overwrite a lease that moved.
      version: 1,
      acquiredAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + config.expiryMs).toISOString(),
    };

    let handle;
    try {
      handle = await open(path, 'wx');
    } catch (error) {
      if (error.code === 'EEXIST') {
        const held = await read(kind, key);
        return { acquired: false, heldBy: held, reason: BUSY_REASON[kind] ?? 'WORKTREE_BUSY' };
      }
      throw new SpikeError('LEASE_IO_FAILED', `Cannot acquire ${kind} lease ${key}: ${error.message}`);
    }

    try {
      await handle.writeFile(`${JSON.stringify(lease, null, 2)}\n`, 'utf8');
    } finally {
      await handle.close();
    }
    return { acquired: true, lease };
  }

  /**
   * Reads a lease.
   *
   * A zero-length file is not corruption: exclusive creation and the write of
   * the content are two steps, so a reader that arrives between them sees an
   * empty file. That window is exactly what the loser of a claim race hits, and
   * calling it LEASE_CORRUPT would turn a correct refusal into a fatal error.
   * It is read as "a claim is in flight" and retried briefly; a file that stays
   * empty past the window is genuinely corrupt.
   */
  async function read(kind, key, { attempt = 0 } = {}) {
    try {
      const raw = await readFile(pathFor(kind, key), 'utf8');
      if (raw.trim() === '') {
        if (attempt < CLAIM_SETTLE_ATTEMPTS) {
          await sleep(CLAIM_SETTLE_DELAY_MS);
          return read(kind, key, { attempt: attempt + 1 });
        }
        throw new SpikeError('LEASE_CORRUPT',
          `Lease ${kind}/${key} is empty after ${CLAIM_SETTLE_ATTEMPTS} reads; a claim was left half-written`);
      }
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error instanceof SpikeError) throw error;
      if (error instanceof SyntaxError) {
        throw new SpikeError('LEASE_CORRUPT', `Lease ${kind}/${key} is not valid JSON`);
      }
      throw new SpikeError('LEASE_IO_FAILED', `Cannot read ${kind} lease ${key}: ${error.message}`);
    }
  }

  /** Renews only if this process still owns it. Written atomically. */
  async function renew(kind, key) {
    const lease = await read(kind, key);
    if (!lease) throw new SpikeError('LEASE_LOST', `Lease ${kind}/${key} no longer exists`);
    if (lease.workerInstanceId !== WORKER_INSTANCE_ID) {
      throw new SpikeError('LEASE_NOT_OWNED', `Lease ${kind}/${key} belongs to ${lease.workerInstanceId}`);
    }

    const now = new Date();
    const updated = {
      ...lease,
      version: (lease.version ?? 1) + 1,
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + config.expiryMs).toISOString(),
    };

    const path = pathFor(kind, key);
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
    await rename(temp, path);
    return updated;
  }

  /** Releases a lease this process owns. Never removes someone else's. */
  async function release(kind, key, { force = false } = {}) {
    const lease = await read(kind, key);
    if (!lease) return false;
    if (!force && lease.workerInstanceId !== WORKER_INSTANCE_ID) {
      throw new SpikeError('LEASE_NOT_OWNED',
        `Refusing to release ${kind} lease ${key}: it belongs to ${lease.workerInstanceId}`);
    }
    await rm(pathFor(kind, key), { force: true });
    return true;
  }

  /**
   * Takes a lease over from a holder proven to be gone.
   *
   * Recovery is never "delete the lease and try again". Exactly one process may
   * win, so the winner is decided by the same primitive that decides a claim:
   * exclusive creation of a file. Only the process that creates the takeover
   * marker touches the lease at all.
   *
   * The compare-and-swap is against the exact lease the caller judged. If it
   * changed between that judgement and this call, someone else acted on it and
   * the takeover aborts rather than overwriting their work.
   */
  async function takeover(kind, key, { expected, payload, proof }) {
    const path = pathFor(kind, key);
    const markerPath = `${path}.takeover`;
    await mkdir(dirname(path), { recursive: true });

    let marker;
    try {
      marker = await open(markerPath, 'wx');
    } catch (error) {
      if (error.code === 'EEXIST') {
        return { acquired: false, reason: 'RECOVERY_IN_PROGRESS' };
      }
      throw new SpikeError('LEASE_IO_FAILED', `Cannot start takeover of ${kind} lease ${key}: ${error.message}`);
    }

    try {
      const current = await read(kind, key);
      if (!current) return { acquired: false, reason: 'LEASE_ALREADY_GONE' };

      if (leaseMoved(current, expected)) {
        return { acquired: false, reason: 'LEASE_CHANGED_SINCE_JUDGEMENT', heldBy: current };
      }

      // History is archived, never overwritten: the superseded lease is the
      // record of who held the run before recovery.
      const supersededAt = new Date().toISOString();
      await writeFile(
        `${path}.superseded`,
        `${JSON.stringify({ ...current, status: 'SUPERSEDED', supersededAt, supersededProof: proof ?? null }, null, 2)}
`,
        'utf8',
      );
      await rm(path, { force: true });

      const claimed = await acquire(kind, key, payload);
      if (!claimed.acquired) return { acquired: false, reason: 'RECLAIM_FAILED', heldBy: claimed.heldBy };
      return { acquired: true, lease: claimed.lease, superseded: current };
    } finally {
      await marker.close();
      await rm(markerPath, { force: true });
    }
  }

  /**
   * Retires a lease whose holder is proven gone, leaving no lease behind.
   *
   * Takeover hands ownership to a new attempt; this ends ownership instead —
   * what a superseded attempt needs. The attempt it belonged to will never
   * run again, so claiming its lease for someone would be a lie, and leaving
   * it there blocks the worktree for work that is legitimately next.
   *
   * Same atomicity and the same compare-and-swap as takeover, and the lease is
   * archived rather than deleted.
   */
  async function retire(kind, key, { expected, proof }) {
    const path = pathFor(kind, key);
    const markerPath = `${path}.takeover`;
    await mkdir(dirname(path), { recursive: true });

    let marker;
    try {
      marker = await open(markerPath, 'wx');
    } catch (error) {
      if (error.code === 'EEXIST') return { retired: false, reason: 'RECOVERY_IN_PROGRESS' };
      throw new SpikeError('LEASE_IO_FAILED', `Cannot retire ${kind} lease ${key}: ${error.message}`);
    }

    try {
      const current = await read(kind, key);
      if (!current) return { retired: false, reason: 'LEASE_ALREADY_GONE' };
      if (leaseMoved(current, expected)) {
        return { retired: false, reason: 'LEASE_CHANGED_SINCE_JUDGEMENT', heldBy: current };
      }

      await writeFile(
        `${path}.superseded`,
        `${JSON.stringify({ ...current, status: 'SUPERSEDED', supersededAt: new Date().toISOString(), supersededProof: proof ?? null }, null, 2)}\n`,
        'utf8',
      );
      await rm(path, { force: true });
      return { retired: true, lease: current };
    } finally {
      await marker.close();
      await rm(markerPath, { force: true });
    }
  }

  return {
    paths: { jobsDir, worktreesDir, workersDir, pathFor },

    claimJob(jobId, payload) { return acquire('job', jobId, { jobId, ...payload }); },
    /** The singleton lease for a worker ROLE. One holder, process-wide. */
    claimWorker(role, payload) { return acquire('worker', role, { role, ...payload }); },
    readWorkerLease(role) { return read('worker', role); },
    renewWorker(role) { return renew('worker', role); },
    releaseWorker(role, options) { return release('worker', role, options); },
    takeoverWorker(role, options) { return takeover('worker', role, options); },
    retireWorker(role, options) { return retire('worker', role, options); },
    claimWorktree(path, payload) {
      return acquire('worktree', worktreeKey(path), { worktreePath: path, ...payload });
    },

    readJobLease(jobId) { return read('job', jobId); },
    readWorktreeLease(path) { return read('worktree', worktreeKey(path)); },

    renewJob(jobId) { return renew('job', jobId); },
    renewWorktree(path) { return renew('worktree', worktreeKey(path)); },

    takeoverJob(jobId, options) { return takeover('job', jobId, options); },
    retireJob(jobId, options) { return retire('job', jobId, options); },
    retireWorktree(path, options) { return retire('worktree', worktreeKey(path), options); },
    takeoverWorktree(path, options) { return takeover('worktree', worktreeKey(path), options); },

    releaseJob(jobId, options) { return release('job', jobId, options); },
    releaseWorktree(path, options) { return release('worktree', worktreeKey(path), options); },

    async listJobLeases() {
      try {
        const entries = await readdir(jobsDir);
        return Promise.all(entries.filter((e) => e.endsWith('.lock'))
          .map((e) => read('job', e.replace(/\.lock$/, ''))));
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw new SpikeError('LEASE_IO_FAILED', `Cannot list job leases: ${error.message}`);
      }
    },
  };
}

/**
 * Classifies a lease by age. Deliberately never returns "dead".
 *
 * An expired lease is SUSPECTED_ORPHAN, not a failure: expiry alone is not
 * evidence that the worker stopped, and acting on it is how two writers end up
 * on one worktree.
 */
export function classifyLease(lease, { now = Date.now(), config = LEASE_CONFIG } = {}) {
  if (!lease) return { status: null, ageMs: null, live: false };

  const beat = Date.parse(lease.heartbeatAt);
  if (Number.isNaN(beat)) {
    throw new SpikeError('LEASE_CORRUPT', `Lease has an unparseable heartbeat: ${lease.heartbeatAt}`);
  }

  const ageMs = now - beat;
  const live = ageMs < config.expiryMs;
  return {
    status: live ? LEASE_STATUS.ACTIVE : LEASE_STATUS.SUSPECTED_ORPHAN,
    ageMs,
    live,
  };
}

/**
 * Decides whether a NEW attempt may start for a logical job.
 *
 * Fails closed: when it cannot be proven that the previous execution finished
 * and will not write again, a human decides. Two agents writing the same
 * worktree is worse than waiting.
 */
export function canStartNewAttempt({ lease, jobStatus, workerHealth, now = Date.now(), config = LEASE_CONFIG }) {
  // No lease and a terminal job: the previous attempt is done.
  if (!lease) {
    // The terminal vocabulary lives in ONE place. Spelling it out here as a
    // literal list is how SKIPPED came to be terminal in `job-store` and still
    // ambiguous here — a third copy of the same decision, which is the shape
    // of bug this harness keeps paying for.
    if (isTerminalJobStatus(jobStatus) || jobStatus === 'QUEUED' || jobStatus === null || jobStatus === undefined) {
      return { allowed: true, reason: 'NO_ACTIVE_LEASE' };
    }
    // RUNNING without a lease is ambiguous: the holder may have died mid-write.
    return {
      allowed: false,
      reason: 'ORPHANED_EXECUTION_UNCERTAIN',
      escalate: true,
      detail: `Job status is ${jobStatus} but no lease exists; cannot prove the previous execution stopped.`,
    };
  }

  const { status, ageMs } = classifyLease(lease, { now, config });

  if (status === LEASE_STATUS.ACTIVE) {
    return {
      allowed: false,
      reason: 'ATTEMPT_ALREADY_RUNNING',
      escalate: false,
      detail: `Attempt ${lease.attemptId} is running (heartbeat ${Math.round(ageMs / 1000)}s ago).`,
    };
  }

  // Expired lease. Liveness of the worker decides, and only a clear answer counts.
  if (workerHealth?.health === 'RUNNING') {
    return {
      allowed: false,
      reason: 'ATTEMPT_ALREADY_RUNNING',
      escalate: false,
      detail: 'The lease looks stale but the worker is heartbeating; the execution is alive.',
    };
  }

  return {
    allowed: false,
    reason: 'ORPHANED_EXECUTION_UNCERTAIN',
    escalate: true,
    detail:
      `Lease for attempt ${lease.attemptId} expired ${Math.round(ageMs / 1000)}s ago and the worker is not `
      + 'confirmably alive. A child process may still be writing, so a human must confirm before a new attempt.',
  };
}

/**
 * Result fencing: only the authorised attempt may advance the state machine.
 *
 * A late result from a superseded attempt is recorded for audit and ignored.
 */
export function isResultAuthorised({ result, expectedAttemptId }) {
  if (!expectedAttemptId) return true;
  return result?.attemptId === expectedAttemptId;
}

export function startLeaseHeartbeat(leaseStore, { jobId, worktreePath }, { intervalMs = LEASE_CONFIG.heartbeatMs } = {}) {
  let stopped = false;

  const beat = async () => {
    if (stopped) return;
    // A failed renewal must not kill the worker; the lease simply ages and the
    // orchestrator treats it as suspect rather than dead.
    try { if (jobId) await leaseStore.renewJob(jobId); } catch { /* observed as ageing */ }
    try { if (worktreePath) await leaseStore.renewWorktree(worktreePath); } catch { /* idem */ }
  };

  void beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref?.();

  return async () => { stopped = true; clearInterval(timer); };
}
