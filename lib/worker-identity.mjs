/**
 * IA Loop — one worker per role, proven rather than assumed.
 *
 * The architecture has always assumed a single Tech Lead and a single
 * Developer. Nothing enforced it. On 2026-09-09 two Tech Lead processes ran
 * side by side for five hours: a restart started a new one and the old one was
 * never terminated. Everything downstream behaved CORRECTLY — the job lease let
 * exactly one of them execute, and the other refused the job once a second with
 * ATTEMPT_ALREADY_RUNNING — but the operator saw an endless SKIP loop, and the
 * work landed in the older process, which was running pre-telemetry code and
 * therefore recorded nothing.
 *
 * That is the gap this module closes. A job lease answers "is this job being
 * executed?"; a worktree lease answers "is anyone writing here?". Neither
 * answers "is another worker of this role alive?", and that is the question
 * whose absence let two processes coexist indefinitely.
 *
 * Two guarantees:
 *
 *   IDENTITY    a role holds one lease. A second process of the same role
 *               fails at STARTUP, naming who holds it, instead of running
 *               silently forever.
 *
 *   FRESHNESS   a worker records the code version it booted with and refuses
 *               NEW jobs once the ia-loop source has changed underneath it.
 *               The duplicate above executed a Goal on code from before the
 *               telemetry existed; a worker that keeps taking jobs after its
 *               own code was replaced is running a version nobody can reason
 *               about.
 *
 * Liveness is never decided from a pid alone: both Windows and POSIX recycle
 * them. A holder is only declared gone on positive evidence — the machine
 * rebooted since the lease was written, the pid is absent, or the pid exists
 * but belongs to a process that started at a different time. Anything else
 * fails closed, because two workers is exactly what we are preventing.
 */

import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { SpikeError } from './claude-process.mjs';
import { LEASE_CONFIG, classifyLease, workerInstanceId } from './leases.mjs';
import { LIVENESS, createProcessInspector, sameBoot } from './process-inspector.mjs';

/** Why a role's lease could not be taken. */
export const IDENTITY_VERDICTS = Object.freeze({
  /** Free, or provably abandoned. */
  AVAILABLE: 'AVAILABLE',
  /** Someone is alive and heartbeating. This process must not start. */
  HELD_BY_LIVE_WORKER: 'HELD_BY_LIVE_WORKER',
  /** Stale lease, holder provably gone. Safe to take over. */
  HOLDER_GONE: 'HOLDER_GONE',
  /** Stale lease from before a reboot: the holder cannot exist. */
  STALE_AFTER_REBOOT: 'STALE_AFTER_REBOOT',
  /** The pid was reused by an unrelated process, so the holder is gone. */
  PID_RECYCLED: 'PID_RECYCLED',
  /** Alive but not heartbeating, or liveness unknowable. Fails closed. */
  UNCERTAIN: 'UNCERTAIN',
});

/**
 * Sources whose change means "this worker is running code that no longer
 * exists" — and only those.
 *
 * `lib/` and `workers/` are exactly what a worker process loads. The `run-*.mjs`
 * entrypoints at the root are operator and orchestrator CLIs that run in their
 * own processes; editing `run-status.mjs` cannot change what a running worker
 * executes, and treating it as if it could would stop workers for a change that
 * never reached them. A false restart is cheap but not free, and a guard that
 * fires for the wrong reason is one people learn to ignore.
 */
const CODE_DIRS = Object.freeze(['lib', 'workers']);
const CODE_FILE = /\.mjs$/;
/** Tests never affect what a worker executes, so editing one must not force a restart. */
const CODE_EXCLUDE = new Set(['tests', 'fixtures', '.state', '.tmp', 'node_modules']);

/**
 * A fingerprint of the ia-loop code this process would execute.
 *
 * Size and mtime rather than content: it has to be cheap enough to run before
 * every job, and any edit, checkout or pull moves both. It answers exactly one
 * question — "has the code changed since I booted?" — and answering it
 * conservatively (a false positive costs a restart) is the right bias.
 */
export async function computeCodeVersion({ root, now = null } = {}) {
  if (!root) throw new SpikeError('INVALID_ARGS', 'root is required');
  const parts = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // a missing directory is not a version
    }
    for (const entry of entries) {
      if (CODE_EXCLUDE.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (CODE_FILE.test(entry.name)) {
        const info = await stat(full).catch(() => null);
        if (info) parts.push(`${relative(root, full).replace(/\\/g, '/')}:${info.size}:${Math.round(info.mtimeMs)}`);
      }
    }
  }

  for (const dir of CODE_DIRS) await walk(join(root, dir));

  parts.sort();
  const digest = createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
  return { version: digest, fileCount: parts.length, computedAt: new Date(now ?? Date.now()).toISOString() };
}

/**
 * Decides whether a role's existing lease may be taken over.
 *
 * Order matters, and every branch that allows a takeover rests on POSITIVE
 * evidence that the holder cannot still be running.
 */
export async function judgeWorkerLease({
  lease,
  inspector = createProcessInspector(),
  now = Date.now(),
  config = LEASE_CONFIG,
} = {}) {
  if (!lease) return { verdict: IDENTITY_VERDICTS.AVAILABLE, detail: 'no lease' };

  const { status, ageMs } = classifyLease(lease, { now, config });
  if (status === 'ACTIVE') {
    return {
      verdict: IDENTITY_VERDICTS.HELD_BY_LIVE_WORKER,
      detail: `heartbeat ${Math.round(ageMs / 1000)}s ago`,
      heldBy: lease,
    };
  }

  // The machine rebooted since this lease was written, so its process is gone
  // whatever its pid says. Checked FIRST: after a reboot a pid comparison is
  // meaningless, and this is the cheapest certain answer.
  const boot = sameBoot(lease.bootAt, inspector.bootAt(now));
  if (boot === false) {
    return {
      verdict: IDENTITY_VERDICTS.STALE_AFTER_REBOOT,
      detail: `lease predates the current boot (${lease.bootAt})`,
      heldBy: lease,
    };
  }

  if (!Number.isInteger(lease.pid)) {
    return { verdict: IDENTITY_VERDICTS.UNCERTAIN, detail: 'lease records no pid', heldBy: lease };
  }

  // `exists` answers with a THREE-state liveness, not a boolean: ALIVE, GONE,
  // or UNKNOWN when the OS would not say. Treating it as a boolean is how the
  // first version of this function never reached the branch below — `'GONE'`
  // is a truthy string, so a provably dead holder was judged UNCERTAIN and the
  // role stayed locked until a human intervened.
  const liveness = inspector.exists(lease.pid);
  if (liveness === LIVENESS.GONE) {
    return { verdict: IDENTITY_VERDICTS.HOLDER_GONE, detail: `pid ${lease.pid} no longer exists`, heldBy: lease };
  }
  if (liveness !== LIVENESS.ALIVE) {
    return {
      verdict: IDENTITY_VERDICTS.UNCERTAIN,
      detail: `liveness of pid ${lease.pid} could not be established`,
      heldBy: lease,
    };
  }

  // The pid exists — but a pid is not an identity. If the process behind it
  // started at a different time, it is a DIFFERENT process wearing a recycled
  // number, and the real holder is gone.
  const startedAt = await inspector.startedAt(lease.pid).catch(() => null);
  if (startedAt && lease.processStartedAt) {
    const same = sameBoot(startedAt, lease.processStartedAt, { toleranceMs: 2000 });
    if (same === false) {
      return {
        verdict: IDENTITY_VERDICTS.PID_RECYCLED,
        detail: `pid ${lease.pid} now belongs to a process started at ${startedAt}`,
        heldBy: lease,
      };
    }
  }

  // Alive, same process, but silent. Fails closed on purpose: a worker paused
  // by the OS, or one whose disk stalled, is still a worker.
  return {
    verdict: IDENTITY_VERDICTS.UNCERTAIN,
    detail: `pid ${lease.pid} is alive but its lease is ${Math.round(ageMs / 1000)}s stale`,
    heldBy: lease,
  };
}

/** Verdicts that permit this process to take the role. */
const TAKEOVER_ALLOWED = Object.freeze([
  IDENTITY_VERDICTS.HOLDER_GONE,
  IDENTITY_VERDICTS.STALE_AFTER_REBOOT,
  IDENTITY_VERDICTS.PID_RECYCLED,
]);

/**
 * Claims the singleton identity for a role, or refuses to start.
 *
 * Acquisition is atomic — the lease file is created with `wx`, so two processes
 * racing cannot both win — and the loser does not retry: it reports who holds
 * the role and lets the caller fail the startup.
 */
export async function acquireWorkerIdentity({
  leaseStore,
  role,
  repoRoot = null,
  codeVersion = null,
  inspector = createProcessInspector(),
  now = () => Date.now(),
  config = LEASE_CONFIG,
}) {
  if (!leaseStore) throw new SpikeError('INVALID_ARGS', 'leaseStore is required');
  if (!role) throw new SpikeError('INVALID_ARGS', 'role is required');

  const payload = {
    role,
    repoRoot,
    bootCodeVersion: codeVersion?.version ?? null,
    bootCodeFileCount: codeVersion?.fileCount ?? null,
    startedAt: new Date(now()).toISOString(),
  };

  const first = await leaseStore.claimWorker(role, payload);
  if (first.acquired) {
    return { acquired: true, lease: first.lease, verdict: IDENTITY_VERDICTS.AVAILABLE, tookOver: false };
  }

  const judgement = await judgeWorkerLease({ lease: first.heldBy, inspector, now: now(), config });
  if (!TAKEOVER_ALLOWED.includes(judgement.verdict)) {
    return {
      acquired: false,
      reason: judgement.verdict === IDENTITY_VERDICTS.HELD_BY_LIVE_WORKER
        ? 'WORKER_ALREADY_RUNNING'
        : 'WORKER_IDENTITY_UNCERTAIN',
      verdict: judgement.verdict,
      detail: judgement.detail,
      heldBy: first.heldBy,
    };
  }

  // Provably abandoned. The takeover is compare-and-swap against the exact
  // lease that was judged, so a holder that came back between the judgement
  // and the swap keeps the role.
  const takeover = await leaseStore.takeoverWorker(role, {
    expected: first.heldBy,
    payload,
    proof: { verdict: judgement.verdict, detail: judgement.detail },
  });
  if (!takeover.acquired) {
    return {
      acquired: false,
      reason: 'WORKER_IDENTITY_RACE',
      verdict: judgement.verdict,
      detail: takeover.reason ?? 'the lease changed while it was being judged',
      heldBy: takeover.heldBy ?? first.heldBy,
    };
  }
  return {
    acquired: true,
    lease: takeover.lease,
    verdict: judgement.verdict,
    tookOver: true,
    replaced: first.heldBy,
  };
}

/** Human-readable "who owns this role", for a refused startup. */
export function describeHolder(lease) {
  if (!lease) return 'nobody';
  const parts = [
    `instance ${lease.workerInstanceId}`,
    `pid ${lease.pid}`,
    lease.hostname ? `on ${lease.hostname}` : null,
    lease.startedAt ? `started ${lease.startedAt}` : null,
    lease.heartbeatAt ? `last heartbeat ${lease.heartbeatAt}` : null,
    lease.bootCodeVersion ? `code ${lease.bootCodeVersion}` : null,
  ];
  return parts.filter(Boolean).join(', ');
}

/**
 * Keeps the role lease fresh while the worker lives.
 *
 * Unref'd: this timer must never be the reason a process stays alive. Stopping
 * it is awaited so a shutdown cannot race a renew into a released lease.
 */
export function startWorkerIdentityHeartbeat(leaseStore, role, { intervalMs = LEASE_CONFIG.heartbeatMs, onError = () => {} } = {}) {
  let stopped = false;
  let inFlight = Promise.resolve();

  const timer = setInterval(() => {
    if (stopped) return;
    inFlight = leaseStore.renewWorker(role).catch((error) => {
      // A lost lease is not survivable: something else owns the role now.
      onError(error);
    });
  }, intervalMs);
  timer.unref?.();

  return async () => {
    stopped = true;
    clearInterval(timer);
    await inFlight.catch(() => {});
  };
}

/**
 * Whether the code changed since this worker booted.
 *
 * Checked before accepting a NEW job, never in the middle of one: interrupting
 * an inference because a file was touched would waste it. A worker that has
 * gone stale keeps its lease and stops taking work, so nothing else starts in
 * its place until a human restarts it.
 */
export async function codeChangedSince({ root, bootVersion, now = null }) {
  if (!bootVersion) return { changed: false, current: null };
  const current = await computeCodeVersion({ root, now });
  return { changed: current.version !== bootVersion, current };
}
