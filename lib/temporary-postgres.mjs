/**
 * IA Loop — the one place that starts and stops a temporary PostgreSQL
 * cluster.
 *
 * Before this module, `docs/migration/VALIDATION_GATE.md` was the only
 * "code" that created one: a manual recipe of raw `initdb`/`pg_ctl` shell
 * commands with a human-chosen directory name and a "descarte do cluster"
 * step at the very end that only runs if nothing goes wrong first. That
 * recipe is exactly how atendly-review-005-r2, atendly-goal006-pg and
 * atendly-pgtest were created — and exactly why nothing noticed when they
 * outlived the job that started them.
 *
 * Everything here goes through the resource registry: reserve → spawn →
 * ACTIVE, always in that order, so a crash between "spawned" and "ACTIVE"
 * still leaves a CREATING record behind instead of an invisible process.
 * Stopping always re-proves ownership before touching a PID or a directory.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm } from 'node:fs/promises';
import { createServer, Socket } from 'node:net';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { SpikeError } from './claude-process.mjs';
import { createProcessInspector, selfIdentity } from './process-inspector.mjs';
import { provePostgresOwnership, isKillable, isCleanable } from './postgres-ownership.mjs';
import { RESOURCE_STATUS } from './resource-registry.mjs';
import { assertSafeTempPath, ensureTempRoot, tempRootFor } from './resource-paths.mjs';

const execFileAsync = promisify(execFile);

export const RESOURCE_TYPE_POSTGRES = 'postgres';

export const TEMP_POSTGRES_CONFIG = Object.freeze({
  portRangeStart: Number(process.env.IA_LOOP_TEMP_POSTGRES_PORT_START ?? 55500),
  portRangeEnd: Number(process.env.IA_LOOP_TEMP_POSTGRES_PORT_END ?? 55599),
  maxPerAttempt: Number(process.env.IA_LOOP_MAX_TEMP_POSTGRES_PER_ATTEMPT ?? 1),
  maxPerJob: Number(process.env.IA_LOOP_MAX_TEMP_POSTGRES_PER_JOB ?? 1),
  maxGlobal: Number(process.env.IA_LOOP_MAX_TEMP_POSTGRES_GLOBAL ?? 2),
  startTimeoutMs: Number(process.env.IA_LOOP_TEMP_POSTGRES_START_TIMEOUT_MS ?? 30_000),
  gracefulStopTimeoutMs: Number(process.env.IA_LOOP_TEMP_POSTGRES_STOP_TIMEOUT_MS ?? 15_000),
  maxAgeMs: Number(process.env.IA_LOOP_TEMP_POSTGRES_MAX_AGE_MS ?? 2 * 60 * 60 * 1000),
});

function fail(code, message, details) {
  throw new SpikeError(code, message, details);
}

/** Finds the PostgreSQL bin directory the same way VALIDATION_GATE.md does. */
export function resolvePgBinDirectory({ env = process.env, fs = { existsSync, readdirSync } } = {}) {
  if (env.IA_LOOP_PG_BIN && fs.existsSync(env.IA_LOOP_PG_BIN)) return env.IA_LOOP_PG_BIN;

  const programsRoot = env.LOCALAPPDATA
    ? join(env.LOCALAPPDATA, 'Programs', 'PostgreSQL')
    : null;
  if (programsRoot && fs.existsSync(programsRoot)) {
    const versions = fs.readdirSync(programsRoot).sort().reverse();
    for (const version of versions) {
      const bin = join(programsRoot, version, 'pgsql', 'bin');
      if (fs.existsSync(bin)) return bin;
    }
  }
  return null; // resolved binaries fall back to PATH
}

function binPath(pgBin, name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  return pgBin ? join(pgBin, exe) : exe;
}

/** Probes whether a TCP port is free by trying to bind it, then releasing it. */
function isPortFree(port) {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once('error', () => resolvePort(false));
    server.once('listening', () => server.close(() => resolvePort(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function findFreePort({ start, end }) {
  for (let port = start; port <= end; port += 1) {
    // eslint-disable-next-line no-await-in-loop -- ports must be probed serially
    if (await isPortFree(port)) return port;
  }
  fail('NO_FREE_PORT', `No free port in range ${start}-${end}`);
}

function canConnect(port, { timeoutMs = 500 } = {}) {
  return new Promise((resolveConn) => {
    const socket = new Socket();
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; socket.destroy(); resolveConn(ok); } };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * The real driver: shells out to initdb/pg_ctl. Every method here is
 * read/write against the filesystem and OS process table only — nothing
 * touches the registry, which is what makes this injectable in tests.
 */
export function createPostgresDriver({ pgBin = resolvePgBinDirectory() } = {}) {
  return {
    pgBin,
    postgresExecutable: binPath(pgBin, 'postgres'),
    pgCtlExecutable: binPath(pgBin, 'pg_ctl'),

    async initdb({ dataDirectory, user }) {
      await execFileAsync(binPath(pgBin, 'initdb'), [
        '-D', dataDirectory, '-U', user, '-A', 'trust', '-E', 'UTF8', '--locale=C',
      ], { timeout: 60_000, windowsHide: true });
    },

    async start({ dataDirectory, port, logFile }) {
      await execFileAsync(binPath(pgBin, 'pg_ctl'), [
        '-D', dataDirectory, '-l', logFile, '-o', `-p ${port} -c listen_addresses=127.0.0.1`, '-w', 'start',
      ], { timeout: 30_000, windowsHide: true });
    },

    /** Graceful stop: `pg_ctl stop -m fast` waits for clients to finish. */
    async stopGraceful({ dataDirectory }) {
      await execFileAsync(binPath(pgBin, 'pg_ctl'), [
        '-D', dataDirectory, '-m', 'fast', '-w', 'stop',
      ], { timeout: 30_000, windowsHide: true });
    },

    /** Escalated stop: `pg_ctl stop -m immediate` — only after re-proving ownership. */
    async stopImmediate({ dataDirectory }) {
      await execFileAsync(binPath(pgBin, 'pg_ctl'), [
        '-D', dataDirectory, '-m', 'immediate', '-w', 'stop',
      ], { timeout: 15_000, windowsHide: true });
    },

    /** Last resort after a proven CONFIRMED ownership: kill the specific PID, never by name. */
    async killPid(pid) {
      if (process.platform === 'win32') {
        await execFileAsync('taskkill', ['/PID', String(pid), '/F'], { timeout: 10_000, windowsHide: true });
      } else {
        process.kill(pid, 'SIGKILL');
      }
    },

    /**
     * Creates one more database on a cluster this process already owns.
     *
     * `initdb` makes exactly one, and a gate that validates four services
     * needs four: pointing them all at the same database would let one
     * service's migrations decide another's schema, which is the opposite of
     * what an isolation gate is for.
     */
    async createDatabase({ port, user, database }) {
      await execFileAsync(binPath(pgBin, 'createdb'), [
        '-h', '127.0.0.1', '-p', String(port), '-U', user, database,
      ], { timeout: 30_000, windowsHide: true });
    },

    isReady(port) {
      return canConnect(port);
    },
  };
}

/**
 * A database name derived from an env var name: BFF_TEST_DATABASE_URL -> ia_bff_test.
 *
 * `scripts/validate-integration.mjs` refuses any database whose name does not
 * contain "test" as a delimited word — on purpose, so the gate can never fall
 * back to a shared or product database. The service prefix alone (`ia_bff`)
 * does not satisfy that guard, which is why `test` is appended here instead
 * of only trimmed off the source env var name.
 */
export function databaseNameForEnv(name) {
  const service = String(name).toLowerCase().replace(/_test_database_url$/, '').replace(/[^a-z0-9]+/g, '_');
  return `ia_${service}_test`;
}

/** Reads the postgres data directory's postmaster.pid for the live PID, if any. */
async function readPostmasterPid(dataDirectory) {
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(join(dataDirectory, 'postmaster.pid'), 'utf8');
    const pid = Number.parseInt(raw.split('\n')[0], 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function countActivePostgres(registry, { attemptId, jobId }) {
  const active = (await registry.listActive()).filter((r) => r.resourceType === RESOURCE_TYPE_POSTGRES);
  return {
    global: active.length,
    perAttempt: active.filter((r) => r.attemptId === attemptId).length,
    perJob: active.filter((r) => r.jobId === jobId).length,
    existingForAttempt: active.find((r) => r.attemptId === attemptId) ?? null,
  };
}

/**
 * Starts (or, idempotently, reuses) a temporary PostgreSQL cluster owned by
 * one attempt.
 *
 * Concurrency limits and idempotency are checked BEFORE anything is spawned:
 * a duplicate start for the same attempt reuses the existing ACTIVE resource
 * rather than creating a second cluster, and a limit that is already at
 * capacity fails with TEMP_RESOURCE_LIMIT_REACHED rather than queuing or
 * retrying — the caller decides what to do next.
 */
export async function startTemporaryPostgres({
  registry, stateDir, jobId, attemptId, goalId = null, round = null, stage = null, role = null,
}, {
  driver = createPostgresDriver(),
  config = TEMP_POSTGRES_CONFIG,
  tempRoot = tempRootFor(stateDir),
  identity = selfIdentity(),
  inspector = createProcessInspector(),
} = {}) {
  if (!attemptId) fail('INVALID_ARGS', 'attemptId is required to own a temporary PostgreSQL cluster');

  const counts = await countActivePostgres(registry, { attemptId, jobId });
  if (counts.existingForAttempt) {
    return { reused: true, resource: counts.existingForAttempt };
  }
  if (counts.perAttempt >= config.maxPerAttempt) {
    fail('TEMP_RESOURCE_LIMIT_REACHED', `Attempt ${attemptId} already has ${counts.perAttempt} active PostgreSQL resource(s)`);
  }
  if (jobId && counts.perJob >= config.maxPerJob) {
    fail('TEMP_RESOURCE_LIMIT_REACHED', `Job ${jobId} already has ${counts.perJob} active PostgreSQL resource(s)`);
  }
  if (counts.global >= config.maxGlobal) {
    fail('TEMP_RESOURCE_LIMIT_REACHED', `Global limit of ${config.maxGlobal} active PostgreSQL resource(s) reached`);
  }

  await ensureTempRoot(tempRoot);
  const resourceId = registry.newResourceId(RESOURCE_TYPE_POSTGRES);
  const dataDirectory = join(tempRoot, resourceId, 'data');
  const logFile = join(tempRoot, resourceId, 'server.log');
  await mkdir(join(tempRoot, resourceId), { recursive: true });

  await registry.reserve({
    resourceId,
    resourceType: RESOURCE_TYPE_POSTGRES,
    goalId, round, stage, role, jobId, attemptId,
    ownerWorkerId: identity.hostname,
    ownerProcessId: identity.pid,
    ownerProcessStartTime: identity.processStartedAt,
    cleanupPolicy: 'STOP_THEN_REMOVE_DIRECTORY',
    metadata: {
      dataDirectory, logFile,
      postgresExecutable: driver.postgresExecutable,
      pgCtlExecutable: driver.pgCtlExecutable,
      createdByCommand: 'temporary-postgres.mjs#startTemporaryPostgres',
    },
  });

  try {
    const port = await findFreePort({ start: config.portRangeStart, end: config.portRangeEnd });
    const user = 'iapgtest';
    const database = 'ia_loop_temp';

    await driver.initdb({ dataDirectory, user });
    await driver.start({ dataDirectory, port, logFile });

    const deadline = Date.now() + config.startTimeoutMs;
    let ready = false;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop -- readiness must be polled
      if (await driver.isReady(port)) { ready = true; break; }
      // eslint-disable-next-line no-await-in-loop
      await sleep(250);
    }
    if (!ready) fail('TEMP_POSTGRES_NOT_READY', `PostgreSQL on port ${port} did not become ready within ${config.startTimeoutMs}ms`);

    const postgresPid = await readPostmasterPid(dataDirectory);
    const postgresProcessStartTime = postgresPid ? await inspector.startedAt(postgresPid) : null;

    const record = await registry.setStatus(resourceId, RESOURCE_STATUS.ACTIVE, {
      detail: `Listening on 127.0.0.1:${port}`,
      metadataPatch: {
        port, user, database, postgresPid, postgresProcessStartTime,
        connectionString: `postgresql://${user}@127.0.0.1:${port}/${database}`,
      },
    });

    return { reused: false, resource: record, driver };
  } catch (error) {
    await registry.setStatus(resourceId, RESOURCE_STATUS.CLEANUP_FAILED, {
      detail: `Spawn failed: ${error.message}`,
    }).catch(() => {});
    // The half-started cluster is torn down best-effort; the record stays
    // CLEANUP_FAILED (auditable) rather than being silently forgotten.
    await driver.stopGraceful({ dataDirectory }).catch(() => {});
    throw error;
  }
}

/**
 * Stops a temporary PostgreSQL resource and removes its data directory.
 *
 * Ownership is re-proven here, independent of whoever is calling: this is
 * what makes the function safe to call from a startup scavenger recovering
 * a resource nobody currently "owns" in-process, not just from the attempt
 * that created it.
 */
export async function stopTemporaryPostgres(registry, resourceId, {
  driver = createPostgresDriver(),
  inspector = createProcessInspector(),
  commandLineFn,
  tempRoot,
  config = TEMP_POSTGRES_CONFIG,
} = {}) {
  const resource = await registry.get(resourceId);
  if (!resource) return { stopped: false, reason: 'RESOURCE_NOT_FOUND' };
  if (resource.status === RESOURCE_STATUS.CLEANED) return { stopped: true, reason: 'ALREADY_CLEANED', resource };

  await registry.setStatus(resourceId, RESOURCE_STATUS.STOPPING).catch(() => {});

  const proof = await provePostgresOwnership(resource, inspector, commandLineFn ? { commandLineFn } : {});
  const { dataDirectory } = resource.metadata ?? {};

  if (!isCleanable(proof)) {
    await registry.setStatus(resourceId, RESOURCE_STATUS.CLEANUP_FAILED, { detail: proof.detail }).catch(() => {});
    return { stopped: false, reason: 'OWNERSHIP_UNPROVEN', proof, resource };
  }

  let escalated = false;
  if (isKillable(proof)) {
    try {
      await driver.stopGraceful({ dataDirectory });
    } catch {
      // Escalation: re-prove ownership before anything more aggressive —
      // the graceful attempt may have taken long enough for the situation
      // on the machine to have changed.
      const reproof = await provePostgresOwnership(resource, inspector, commandLineFn ? { commandLineFn } : {});
      if (!isKillable(reproof)) {
        await registry.setStatus(resourceId, RESOURCE_STATUS.CLEANUP_FAILED, { detail: reproof.detail }).catch(() => {});
        return { stopped: false, reason: 'OWNERSHIP_CHANGED_DURING_ESCALATION', proof: reproof, resource };
      }
      escalated = true;
      try {
        await driver.stopImmediate({ dataDirectory });
      } catch {
        try {
          await driver.killPid(resource.metadata.postgresPid);
        } catch (killError) {
          await registry.setStatus(resourceId, RESOURCE_STATUS.CLEANUP_FAILED, {
            detail: `RESOURCE_CLEANUP_ESCALATED but the final kill failed: ${killError.message}`,
          }).catch(() => {});
          return { stopped: false, reason: 'ESCALATED_KILL_FAILED', resource };
        }
      }
    }
  }

  const pathCheck = tempRoot ? await assertSafeTempPath(dataDirectory, tempRoot) : { safe: true, resolved: dataDirectory };
  if (!pathCheck.safe) {
    await registry.setStatus(resourceId, RESOURCE_STATUS.CLEANUP_FAILED, {
      detail: `Refusing to remove ${dataDirectory}: ${pathCheck.reason}`,
    }).catch(() => {});
    return { stopped: true, reason: 'DIRECTORY_REMOVAL_REFUSED', pathCheck, resource };
  }

  const removalRoot = dataDirectory ? join(dataDirectory, '..') : null;
  if (removalRoot) {
    const rootCheck = tempRoot ? await assertSafeTempPath(removalRoot, tempRoot) : { safe: true };
    if (rootCheck.safe) await rm(removalRoot, { recursive: true, force: true });
    else await rm(dataDirectory, { recursive: true, force: true });
  }

  const cleaned = await registry.setStatus(resourceId, RESOURCE_STATUS.CLEANED, {
    detail: escalated ? `RESOURCE_CLEANUP_ESCALATED — ${proof.detail}` : proof.detail,
  });
  return { stopped: true, escalated, resource: cleaned };
}

/** Convenience wrapper for a single scoped use: start, run, always clean up. */
export async function withTemporaryPostgres(ctx, fn, opts = {}) {
  const { resource } = await startTemporaryPostgres(ctx, opts);
  try {
    return await fn(resource);
  } finally {
    await stopTemporaryPostgres(ctx.registry, resource.resourceId, opts);
  }
}

/**
 * Runs `fn` against a cluster carrying one database per requested env var.
 *
 * The gate scripts refuse to run unless every `*_TEST_DATABASE_URL` names a
 * disposable cluster — deliberately, so they can never fall back to an
 * inherited `DATABASE_URL` and write somewhere real. This is what makes that
 * refusal satisfiable from the orchestrator instead of only from a human at a
 * terminal.
 *
 * `fn` receives the env additions and nothing else: the caller never learns
 * the resource id, so it cannot keep the cluster alive past this call. Cleanup
 * is `withTemporaryPostgres`'s `finally`, and the worker loop's per-attempt
 * sweep is the net under that.
 */
export async function withTestDatabases(ctx, envNames, fn, opts = {}) {
  const names = [...new Set((envNames ?? []).filter((n) => typeof n === 'string' && n.trim() !== ''))];
  if (names.length === 0) return fn({});

  const driver = opts.driver ?? createPostgresDriver();
  return withTemporaryPostgres(ctx, async (resource) => {
    const { port, user } = resource.metadata;
    const env = {};
    for (const envName of names) {
      const database = databaseNameForEnv(envName);
      // eslint-disable-next-line no-await-in-loop -- createdb is serial by nature
      await driver.createDatabase({ port, user, database });
      env[envName] = `postgresql://${user}@127.0.0.1:${port}/${database}`;
    }
    return fn(env);
  }, { ...opts, driver });
}
