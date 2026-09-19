/**
 * IA Loop — from suspicion to proof.
 *
 * V6 established that an expired lease is SUSPECTED_ORPHAN and never "dead":
 * expiry alone is not evidence, and acting on it is how two writers end up on
 * one worktree. That was right, and it left a gap — there was no way to ever
 * reach proof, so a machine that rebooted mid-run could not be recovered
 * without deleting a lease by hand.
 *
 * This closes the gap without weakening the rule. A lease becomes
 * ORPHAN_CONFIRMED only when something makes it IMPOSSIBLE for the old holder
 * to write again:
 *
 *   DIFFERENT_BOOT  the machine booted after the lease was taken, so no process
 *                   that held it survived — the strongest proof available, and
 *                   the only one that also works on a lease written before this
 *                   module existed
 *   PROCESS_GONE    the pid does not exist
 *   PID_REUSED      the pid exists but started at a different time, so it is a
 *                   different process wearing a recycled number
 *
 * Everything else stays SUSPECTED_ORPHAN. Absence of evidence is never taken
 * for evidence of absence.
 */

import { LIVENESS, sameBoot } from './process-inspector.mjs';
import { LEASE_STATUS, classifyLease } from './leases.mjs';

export const OWNER_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  SUSPECTED_ORPHAN: 'SUSPECTED_ORPHAN',
  ORPHAN_CONFIRMED: 'ORPHAN_CONFIRMED',
  OWNER_ALIVE: 'OWNER_ALIVE',
  FOREIGN_HOST: 'FOREIGN_HOST',
});

export const ORPHAN_PROOFS = Object.freeze([
  'DIFFERENT_BOOT', 'PROCESS_GONE', 'PID_REUSED',
]);

/**
 * Gathers evidence about a lease's holder. Async only because asking the OS for
 * another process's start time is; the judgement itself is the pure function
 * below, so every branch is testable without a machine.
 */
export async function collectOwnerEvidence(lease, inspector, { now = Date.now(), config } = {}) {
  if (!lease) return null;

  // A live heartbeat settles the question by itself, so nothing is asked of the
  // operating system. This keeps ia-loop:status free of process queries during
  // normal operation, where it is run most often.
  const { status } = classifyLease(lease, { now, ...(config ? { config } : {}) });
  if (status === LEASE_STATUS.ACTIVE) {
    return {
      currentHostname: inspector.hostname(),
      currentBootAt: inspector.bootAt(now),
      leaseHostname: lease.hostname ?? null,
      leaseBootAt: lease.bootAt ?? null,
      leasePid: Number.isInteger(lease.pid) ? lease.pid : null,
      leaseProcessStartedAt: lease.processStartedAt ?? null,
      pidLiveness: null,
      observedProcessStartedAt: null,
      skipped: 'HEARTBEAT_FRESH',
    };
  }

  const evidence = {
    currentHostname: inspector.hostname(),
    currentBootAt: inspector.bootAt(now),
    leaseHostname: lease.hostname ?? null,
    leaseBootAt: lease.bootAt ?? null,
    leasePid: Number.isInteger(lease.pid) ? lease.pid : null,
    leaseProcessStartedAt: lease.processStartedAt ?? null,
    pidLiveness: null,
    observedProcessStartedAt: null,
  };

  // A lease from another machine is not ours to reason about at all, so we do
  // not waste a process query on it.
  if (evidence.leaseHostname && evidence.leaseHostname !== evidence.currentHostname) {
    return evidence;
  }

  if (evidence.leasePid !== null) {
    evidence.pidLiveness = inspector.exists(evidence.leasePid);
    if (evidence.pidLiveness === LIVENESS.ALIVE) {
      evidence.observedProcessStartedAt = await inspector.startedAt(evidence.leasePid);
    }
  }

  return evidence;
}

/**
 * Judges the holder of a lease.
 *
 * Order matters. Liveness of the heartbeat is checked first because a fresh
 * heartbeat settles the question on its own — a process that wrote a second ago
 * is alive, whatever else we might infer.
 */
export function judgeOwner({ lease, evidence, now = Date.now(), config }) {
  if (!lease) return { status: null, proof: null, detail: 'No lease.' };

  const { status: ageStatus, ageMs } = classifyLease(lease, { now, ...(config ? { config } : {}) });
  const ageSeconds = Math.round((ageMs ?? 0) / 1000);

  if (ageStatus === LEASE_STATUS.ACTIVE) {
    return {
      status: OWNER_STATUS.ACTIVE,
      proof: null,
      ageMs,
      detail: `Heartbeat is ${ageSeconds}s old; the holder is alive.`,
    };
  }

  const suspected = (detail) => ({ status: OWNER_STATUS.SUSPECTED_ORPHAN, proof: null, ageMs, detail });

  if (!evidence) return suspected(`Heartbeat expired ${ageSeconds}s ago and no evidence was collected.`);

  if (evidence.leaseHostname && evidence.leaseHostname !== evidence.currentHostname) {
    return {
      status: OWNER_STATUS.FOREIGN_HOST,
      proof: null,
      ageMs,
      detail:
        `The lease was written by ${evidence.leaseHostname} and this is ${evidence.currentHostname}. `
        + 'Liveness of a process on another machine cannot be checked from here.',
    };
  }

  // 1. The machine rebooted after the lease was taken.
  //
  // This is checked against acquiredAt, not the recorded bootAt, so it holds
  // for a lease written before leases carried identity at all — which is
  // exactly the lease a first reboot leaves behind.
  const acquiredAt = Date.parse(lease.acquiredAt);
  const bootAt = Date.parse(evidence.currentBootAt);
  if (!Number.isNaN(acquiredAt) && !Number.isNaN(bootAt) && bootAt > acquiredAt) {
    return {
      status: OWNER_STATUS.ORPHAN_CONFIRMED,
      proof: 'DIFFERENT_BOOT',
      ageMs,
      detail:
        `The machine booted at ${evidence.currentBootAt}, after this lease was taken at ${lease.acquiredAt}. `
        + 'No process holding it survived the reboot.',
    };
  }

  // Same check stated against the recorded boot, for a lease that carries one.
  if (evidence.leaseBootAt) {
    const same = sameBoot(evidence.leaseBootAt, evidence.currentBootAt);
    if (same === false) {
      return {
        status: OWNER_STATUS.ORPHAN_CONFIRMED,
        proof: 'DIFFERENT_BOOT',
        ageMs,
        detail: `The lease was taken during a different boot (${evidence.leaseBootAt} vs ${evidence.currentBootAt}).`,
      };
    }
  }

  // 2. The process is simply not there.
  if (evidence.pidLiveness === LIVENESS.GONE) {
    return {
      status: OWNER_STATUS.ORPHAN_CONFIRMED,
      proof: 'PROCESS_GONE',
      ageMs,
      detail: `Process ${evidence.leasePid} does not exist, and the heartbeat expired ${ageSeconds}s ago.`,
    };
  }

  // 3. The pid is alive but it is not the same process.
  if (evidence.pidLiveness === LIVENESS.ALIVE) {
    if (evidence.leaseProcessStartedAt && evidence.observedProcessStartedAt) {
      if (evidence.leaseProcessStartedAt !== evidence.observedProcessStartedAt) {
        return {
          status: OWNER_STATUS.ORPHAN_CONFIRMED,
          proof: 'PID_REUSED',
          ageMs,
          detail:
            `Process ${evidence.leasePid} exists but started at ${evidence.observedProcessStartedAt}, `
            + `not ${evidence.leaseProcessStartedAt}. The id was recycled; the holder is gone.`,
        };
      }
      return {
        status: OWNER_STATUS.OWNER_ALIVE,
        proof: null,
        ageMs,
        detail:
          `Process ${evidence.leasePid} is the same one that took the lease (started ${evidence.observedProcessStartedAt}). `
          + 'The heartbeat is stale but the holder is running and may still write.',
      };
    }

    return suspected(
      `Process ${evidence.leasePid} exists, but there is no start time to tell whether it is the same process. `
      + 'The pid may have been recycled, or the holder may be alive.',
    );
  }

  return suspected(
    `Heartbeat expired ${ageSeconds}s ago and the holder could not be inspected `
    + `(pid ${evidence.leasePid ?? 'unknown'}).`,
  );
}

/** Only a proven orphan may have its lease taken. */
export function isRecoveryEligible(verdict) {
  return verdict?.status === OWNER_STATUS.ORPHAN_CONFIRMED && ORPHAN_PROOFS.includes(verdict.proof);
}
