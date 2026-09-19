/**
 * IA Loop — temporary resource registry.
 *
 * A PostgreSQL cluster spun up mid-attempt used to exist nowhere but in the
 * shell that started it. If that shell died — USAGE_LIMIT, a crash, Ctrl+C,
 * a reboot — the process and its data directory survived with no record
 * anywhere that they existed, let alone who owned them. That is how
 * atendly-review-005-r2, atendly-goal006-pg and atendly-pgtest ended up
 * running for hours after the job that created them was long gone.
 *
 * This registry is the fix: a resource is written here BEFORE it is spawned
 * and updated as it moves through its life, so a crash between "spawned" and
 * "cleaned" always leaves a readable, attributable trail — never an invisible
 * process.
 *
 * Persistence mirrors job-store.mjs: one file per resource under
 * tools/ia-loop/.state/resources/<resourceId>.json, written atomically
 * (temp file + rename) so a reader never sees a half-written record, and
 * reserved with an exclusive create (like leases.mjs) so two reservations of
 * the same id can never both succeed.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { SpikeError } from './claude-process.mjs';
import { readJson, writeJsonAtomic } from './job-store.mjs';

export const RESOURCE_STATUS = Object.freeze({
  CREATING: 'CREATING',
  ACTIVE: 'ACTIVE',
  CLEANUP_REQUESTED: 'CLEANUP_REQUESTED',
  STOPPING: 'STOPPING',
  STOPPED: 'STOPPED',
  CLEANED: 'CLEANED',
  CLEANUP_FAILED: 'CLEANUP_FAILED',
  ORPHAN_SUSPECTED: 'ORPHAN_SUSPECTED',
  ORPHAN_CONFIRMED: 'ORPHAN_CONFIRMED',
});

/** Not yet CLEANED — still occupies a slot against concurrency limits. */
export const LIVE_RESOURCE_STATUSES = Object.freeze([
  RESOURCE_STATUS.CREATING,
  RESOURCE_STATUS.ACTIVE,
  RESOURCE_STATUS.CLEANUP_REQUESTED,
  RESOURCE_STATUS.STOPPING,
  RESOURCE_STATUS.STOPPED,
  RESOURCE_STATUS.ORPHAN_SUSPECTED,
  RESOURCE_STATUS.ORPHAN_CONFIRMED,
]);

function fail(code, message, details) {
  throw new SpikeError(code, message, details);
}

function assertKnownStatus(status) {
  if (!Object.values(RESOURCE_STATUS).includes(status)) {
    fail('INVALID_RESOURCE_STATUS', `Unknown resource status ${JSON.stringify(status)}`);
  }
}

export function createResourceRegistry(stateDir) {
  const dir = join(stateDir, 'resources');
  const pathFor = (resourceId) => join(dir, `${resourceId}.json`);

  return {
    dir,

    newResourceId(resourceType) {
      return `${resourceType}-${randomUUID().slice(0, 12)}`;
    },

    /**
     * Reserves a resource record before anything is spawned.
     *
     * Ordering that matters to the caller: reserve() (CREATING) → spawn the
     * real thing → activate() (ACTIVE) with the process identity filled in.
     * If spawn throws in between, the record stays CREATING — auditable and
     * eligible for cleanup — instead of never having existed.
     */
    async reserve({
      resourceId, resourceType, goalId = null, round = null, stage = null, role = null,
      jobId = null, attemptId = null, ownerWorkerId = null, ownerProcessId = null,
      ownerProcessStartTime = null, cleanupPolicy = null, metadata = {},
    }) {
      if (!resourceId) fail('INVALID_RESOURCE', 'resourceId is required');
      if (!resourceType) fail('INVALID_RESOURCE', 'resourceType is required');
      await mkdir(dir, { recursive: true });

      const path = pathFor(resourceId);
      let handle;
      try {
        handle = await open(path, 'wx');
      } catch (error) {
        if (error.code === 'EEXIST') fail('DUPLICATE_RESOURCE', `Resource ${resourceId} already registered`);
        fail('RESOURCE_IO_FAILED', `Cannot reserve resource ${resourceId}: ${error.message}`);
      }

      const now = new Date().toISOString();
      const record = {
        resourceId,
        resourceType,
        goalId,
        round,
        stage,
        role,
        jobId,
        attemptId,
        createdAt: now,
        ownerWorkerId,
        ownerProcessId,
        ownerProcessStartTime,
        status: RESOURCE_STATUS.CREATING,
        statusAt: now,
        lastVerifiedAt: now,
        metadata,
        cleanupPolicy,
        history: [{ status: RESOURCE_STATUS.CREATING, at: now, detail: null }],
      };
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
      } finally {
        await handle.close();
      }
      return record;
    },

    async get(resourceId) {
      return readJson(pathFor(resourceId));
    },

    async getRequired(resourceId) {
      return readJson(pathFor(resourceId), { required: true });
    },

    /** Updates status (and optionally metadata), appending to history. */
    async setStatus(resourceId, status, { detail = null, metadataPatch = null } = {}) {
      assertKnownStatus(status);
      const record = await this.getRequired(resourceId);
      const now = new Date().toISOString();
      const next = {
        ...record,
        status,
        statusAt: now,
        lastVerifiedAt: now,
        metadata: metadataPatch ? { ...record.metadata, ...metadataPatch } : record.metadata,
        history: [...(record.history ?? []), { status, at: now, detail }],
      };
      await writeJsonAtomic(pathFor(resourceId), next);
      return next;
    },

    /** Bumps lastVerifiedAt without changing status — the watchdog's touch. */
    async touch(resourceId) {
      const record = await this.getRequired(resourceId);
      const next = { ...record, lastVerifiedAt: new Date().toISOString() };
      await writeJsonAtomic(pathFor(resourceId), next);
      return next;
    },

    async list() {
      let entries;
      try {
        entries = await readdir(dir);
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        fail('RESOURCE_IO_FAILED', `Cannot list resources: ${error.message}`);
      }
      const records = await Promise.all(
        entries.filter((e) => e.endsWith('.json')).map((e) => readJson(join(dir, e))),
      );
      return records.filter(Boolean);
    },

    async listByAttempt(attemptId) {
      return (await this.list()).filter((r) => r.attemptId === attemptId);
    },

    async listByJob(jobId) {
      return (await this.list()).filter((r) => r.jobId === jobId);
    },

    async listActive() {
      return (await this.list()).filter((r) => LIVE_RESOURCE_STATUSES.includes(r.status));
    },

    async listByType(resourceType) {
      return (await this.list()).filter((r) => r.resourceType === resourceType);
    },

    /**
     * Removes a resource's record entirely. Only ever called on a resource
     * already CLEANED (or a CREATING record whose spawn never happened) —
     * never a shortcut around proving ownership first.
     */
    async forget(resourceId) {
      await rm(pathFor(resourceId), { force: true });
    },
  };
}
