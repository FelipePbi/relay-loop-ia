/**
 * IA Loop — wiring the resource registry into the harness's actual lifecycle.
 *
 * Three entry points, matching three different ways a temporary resource
 * stops being needed:
 *
 *   cleanupResourcesForAttempt   an attempt ended — however it ended.
 *                                COMPLETED, FAILED, USAGE_LIMIT, a thrown
 *                                harness error, all of them: whoever calls
 *                                this does not need to know which happened,
 *                                because a resource does not care why its
 *                                owner is done with it.
 *
 *   scavengeOrphans              a worker is starting up (fresh process,
 *                                recovery, or the autonomous loop). Any
 *                                resource left ACTIVE by an owner process
 *                                that provably no longer exists gets cleaned
 *                                here — this is what survives a crash,
 *                                Ctrl+C at the wrong instant, or a reboot,
 *                                none of which run a `finally`.
 *
 *   discoverLegacyCandidates     resources that existed before this registry
 *                                did. Investigation only — it NEVER cleans
 *                                anything; it produces evidence for a human
 *                                or for the dry-run CLI to act on.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { LIVENESS, createProcessInspector } from './process-inspector.mjs';
import { RESOURCE_STATUS } from './resource-registry.mjs';
import { provePostgresOwnership, isCleanable } from './postgres-ownership.mjs';
import { RESOURCE_TYPE_POSTGRES, stopTemporaryPostgres } from './temporary-postgres.mjs';
import { tempRootFor } from './resource-paths.mjs';

const execFileAsync = promisify(execFile);

const CLEANUP_DISPATCH = Object.freeze({
  [RESOURCE_TYPE_POSTGRES]: stopTemporaryPostgres,
});

async function cleanupOne(registry, resource, { tempRoot, inspector, commandLineFn, driver }) {
  const cleaner = CLEANUP_DISPATCH[resource.resourceType];
  if (!cleaner) {
    return { resourceId: resource.resourceId, cleaned: false, reason: 'NO_CLEANUP_HANDLER_FOR_TYPE' };
  }
  const outcome = await cleaner(registry, resource.resourceId, {
    tempRoot, inspector, ...(commandLineFn ? { commandLineFn } : {}), ...(driver ? { driver } : {}),
  });
  return { resourceId: resource.resourceId, ...outcome };
}

/**
 * Cleans up every live resource an attempt owns, whatever the attempt's
 * outcome was. Designed to sit in a `finally` alongside lease release, so it
 * runs on every code path out of an attempt — success, failure, a capacity
 * wait, or an uncaught error.
 */
export async function cleanupResourcesForAttempt(registry, attemptId, {
  stateDir, inspector = createProcessInspector(), commandLineFn, driver,
} = {}) {
  if (!attemptId) return { results: [] };
  const tempRoot = stateDir ? tempRootFor(stateDir) : undefined;
  const owned = (await registry.listByAttempt(attemptId))
    .filter((r) => r.status !== RESOURCE_STATUS.CLEANED);

  const results = [];
  for (const resource of owned) {
    // eslint-disable-next-line no-await-in-loop -- resources are cleaned one at a time, deliberately serial
    results.push(await cleanupOne(registry, resource, { tempRoot, inspector, commandLineFn, driver }));
  }
  return { results };
}

/** Evidence-gathering for whether a resource's OWNER PROCESS still exists. */
async function ownerProcessLooksAlive(resource, inspector) {
  const pid = resource.ownerProcessId;
  if (!Number.isInteger(pid) || pid <= 0) return { alive: null, detail: 'No owner process id recorded.' };

  const liveness = inspector.exists(pid);
  if (liveness === LIVENESS.GONE) return { alive: false, detail: `Owner process ${pid} does not exist.` };
  if (liveness !== LIVENESS.ALIVE) return { alive: null, detail: `Liveness of owner process ${pid} is unknown.` };

  if (!resource.ownerProcessStartTime) return { alive: null, detail: `Owner process ${pid} is alive but has no recorded start time to compare.` };
  const observed = await inspector.startedAt(pid);
  if (!observed) return { alive: null, detail: `Owner process ${pid}'s start time could not be observed.` };
  if (observed !== resource.ownerProcessStartTime) {
    return { alive: false, detail: `Owner process ${pid} started at ${observed}, not ${resource.ownerProcessStartTime} — the id was recycled.` };
  }
  return { alive: true, detail: `Owner process ${pid} is the same one that created this resource.` };
}

/**
 * Startup recovery. Every ACTIVE (or otherwise still-live) resource whose
 * owner process is provably gone is a suspect; it becomes a confirmed orphan
 * only when the resource's OWN process — the PostgreSQL server, not the
 * worker that spawned it — is separately proven cleanable. Two independent
 * proofs, because the worker dying tells us nothing by itself about whether
 * the server it started is still running under a live PID.
 */
export async function scavengeOrphans(registry, {
  stateDir, inspector = createProcessInspector(), commandLineFn, driver,
} = {}) {
  const tempRoot = stateDir ? tempRootFor(stateDir) : undefined;
  const live = (await registry.listActive());

  const report = [];
  for (const resource of live) {
    // eslint-disable-next-line no-await-in-loop -- resources are judged one at a time, deliberately serial
    const owner = await ownerProcessLooksAlive(resource, inspector);
    if (owner.alive !== false) {
      report.push({ resourceId: resource.resourceId, verdict: owner.alive === true ? 'OWNER_ALIVE' : 'UNKNOWN', detail: owner.detail });
      continue; // eslint-disable-line no-continue
    }

    // eslint-disable-next-line no-await-in-loop
    await registry.setStatus(resource.resourceId, RESOURCE_STATUS.ORPHAN_SUSPECTED, { detail: owner.detail }).catch(() => {});

    if (resource.resourceType !== RESOURCE_TYPE_POSTGRES) {
      report.push({ resourceId: resource.resourceId, verdict: 'ORPHAN_SUSPECTED', detail: `${owner.detail} No cleanup handler for resourceType ${resource.resourceType}.` });
      continue; // eslint-disable-line no-continue
    }

    // eslint-disable-next-line no-await-in-loop
    const proof = await provePostgresOwnership(resource, inspector, commandLineFn ? { commandLineFn } : {});
    if (!isCleanable(proof)) {
      report.push({ resourceId: resource.resourceId, verdict: 'ORPHAN_SUSPECTED', detail: `${owner.detail} ${proof.detail} (HUMAN_REQUIRED — not touched)` });
      continue; // eslint-disable-line no-continue
    }

    // eslint-disable-next-line no-await-in-loop
    await registry.setStatus(resource.resourceId, RESOURCE_STATUS.ORPHAN_CONFIRMED, { detail: proof.detail }).catch(() => {});
    // eslint-disable-next-line no-await-in-loop
    const cleanup = await stopTemporaryPostgres(registry, resource.resourceId, {
      tempRoot, inspector, ...(commandLineFn ? { commandLineFn } : {}), ...(driver ? { driver } : {}),
    });
    report.push({ resourceId: resource.resourceId, verdict: 'ORPHAN_CONFIRMED', cleaned: cleanup.stopped, detail: proof.detail });
  }

  return { report };
}

/**
 * Legacy discovery: PostgreSQL processes that were never registered because
 * they were created before this module existed (or by hand, following
 * VALIDATION_GATE.md's old raw recipe). Read-only. It surfaces candidates
 * with evidence; it never terminates a process or deletes a directory —
 * that is the manual-cleanup CLI's job, and only for evidence a human (or
 * `--apply`, after a CONFIRMED proof) decides to act on.
 *
 * `legacyDirectoryPatterns` matches the known naming convention from the
 * incident and from VALIDATION_GATE.md's recipe (`atendly-<label>`); a
 * process whose command line does not mention one of these, or any `PGDATA`
 * at all, is not reported — this is deliberately narrow rather than "every
 * postgres.exe on the machine".
 */
export async function discoverLegacyCandidates({
  legacyDirectoryPatterns = [/atendly-review/i, /atendly-goal/i, /atendly-pgtest/i],
  platform = process.platform,
} = {}) {
  if (platform !== 'win32') {
    return { candidates: [], skipped: 'LEGACY_DISCOVERY_ONLY_IMPLEMENTED_FOR_WINDOWS' };
  }

  let processes;
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='postgres.exe'\" | "
        + 'Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress',
    ], { timeout: 15_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const trimmed = stdout.trim();
    if (trimmed === '') return { candidates: [] };
    const parsed = JSON.parse(trimmed);
    processes = Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    return { candidates: [], error: `Could not enumerate postgres.exe processes: ${error.message}` };
  }

  const candidates = [];
  for (const proc of processes) {
    const commandLine = proc.CommandLine ?? '';
    const matched = legacyDirectoryPatterns.find((pattern) => pattern.test(commandLine));
    if (!matched) continue; // eslint-disable-line no-continue

    candidates.push({
      status: 'LEGACY_TEMP_RESOURCE_CANDIDATE',
      pid: proc.ProcessId,
      commandLine,
      creationDate: proc.CreationDate ?? null,
      matchedPattern: String(matched),
    });
  }
  return { candidates };
}
