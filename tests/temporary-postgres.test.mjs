/**
 * The temporary PostgreSQL wrapper: concurrency limits, idempotency, and the
 * start/stop/escalation lifecycle — all against a FAKE driver. No real
 * PostgreSQL binary is invoked; that is reserved for an explicit, opt-in
 * smoke test, never for this suite.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createResourceRegistry, RESOURCE_STATUS } from '../lib/resource-registry.mjs';
import { LIVENESS } from '../lib/process-inspector.mjs';
import {
  startTemporaryPostgres, stopTemporaryPostgres, withTemporaryPostgres, TEMP_POSTGRES_CONFIG,
} from '../lib/temporary-postgres.mjs';

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-temp-pg-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

/** A fake driver: initdb/start create real directories and a fake postmaster.pid; nothing shells out. */
function fakeDriver({ startFails = false, stopGracefulFails = false, stopImmediateFails = false, killFails = false } = {}) {
  let nextPid = 91000;
  const running = new Map(); // dataDirectory -> pid
  return {
    postgresExecutable: '/fake/bin/postgres',
    pgCtlExecutable: '/fake/bin/pg_ctl',
    running,
    async initdb({ dataDirectory }) { await mkdir(dataDirectory, { recursive: true }); },
    async start({ dataDirectory }) {
      if (startFails) throw new Error('fake initdb/start failure');
      const pid = nextPid++;
      running.set(dataDirectory, pid);
      await writeFile(join(dataDirectory, 'postmaster.pid'), `${pid}\n5432\n`, 'utf8');
    },
    async stopGraceful({ dataDirectory }) {
      if (stopGracefulFails) throw new Error('fake graceful stop failure');
      running.delete(dataDirectory);
    },
    async stopImmediate({ dataDirectory }) {
      if (stopImmediateFails) throw new Error('fake immediate stop failure');
      running.delete(dataDirectory);
    },
    async killPid(pid) {
      if (killFails) throw new Error('fake kill failure');
      for (const [dir, p] of running) if (p === pid) running.delete(dir);
    },
    async isReady() { return true; },
  };
}

function fakeInspector(driver, { startTimeByPid = new Map() } = {}) {
  return {
    exists: (pid) => ([...driver.running.values()].includes(pid) ? LIVENESS.ALIVE : LIVENESS.GONE),
    startedAt: async (pid) => startTimeByPid.get(pid) ?? '2026-09-08T10:00:00.000Z',
  };
}

const fakeCommandLine = async (pid, driver) => {
  for (const [dataDirectory] of driver.running) return `${driver.postgresExecutable} -D ${dataDirectory}`;
  return null;
};

test('37/29/32. happy path: start, run, graceful stop, port and pid released, dir removed', () => withDir(async (dir) => {
  const registry = createResourceRegistry(dir);
  const driver = fakeDriver();
  const config = { ...TEMP_POSTGRES_CONFIG, portRangeStart: 55700, portRangeEnd: 55700 };

  const { resource } = await startTemporaryPostgres(
    { registry, stateDir: dir, jobId: 'j1', attemptId: 'j1-a1' },
    { driver, config, inspector: fakeInspector(driver) },
  );
  assert.equal(resource.status, RESOURCE_STATUS.ACTIVE);
  assert.equal(resource.metadata.port, 55700);
  assert.ok(driver.running.size === 1);

  const outcome = await stopTemporaryPostgres(registry, resource.resourceId, {
    driver, tempRoot: join(dir, '..', '.tmp', 'postgres'),
    inspector: fakeInspector(driver), commandLineFn: (pid) => fakeCommandLine(pid, driver),
  });

  assert.equal(outcome.stopped, true);
  assert.equal(outcome.resource.status, RESOURCE_STATUS.CLEANED);
  assert.equal(driver.running.size, 0);

  const dataParent = join(dir, '..', '.tmp', 'postgres', resource.resourceId);
  await assert.rejects(readdir(dataParent));
}));

test('38/39. escalation: graceful stop fails, ownership re-proven, immediate stop used, then success', () => withDir(async (dir) => {
  const registry = createResourceRegistry(dir);
  const driver = fakeDriver({ stopGracefulFails: true });
  const config = { ...TEMP_POSTGRES_CONFIG, portRangeStart: 55701, portRangeEnd: 55701 };

  const { resource } = await startTemporaryPostgres(
    { registry, stateDir: dir, jobId: 'j1', attemptId: 'j1-a2' },
    { driver, config, inspector: fakeInspector(driver) },
  );

  const outcome = await stopTemporaryPostgres(registry, resource.resourceId, {
    driver, tempRoot: join(dir, '..', '.tmp', 'postgres'),
    inspector: fakeInspector(driver), commandLineFn: (pid) => fakeCommandLine(pid, driver),
  });

  assert.equal(outcome.stopped, true);
  assert.equal(outcome.escalated, true);
  assert.match(outcome.resource.history.at(-1).detail, /RESOURCE_CLEANUP_ESCALATED/);
}));

test('escalation to the specific PID only happens after pg_ctl -m immediate also fails, and never kills by name', () => withDir(async (dir) => {
  const registry = createResourceRegistry(dir);
  const driver = fakeDriver({ stopGracefulFails: true, stopImmediateFails: true });
  const config = { ...TEMP_POSTGRES_CONFIG, portRangeStart: 55702, portRangeEnd: 55702 };

  const { resource } = await startTemporaryPostgres(
    { registry, stateDir: dir, jobId: 'j1', attemptId: 'j1-a3' },
    { driver, config, inspector: fakeInspector(driver) },
  );

  const outcome = await stopTemporaryPostgres(registry, resource.resourceId, {
    driver, tempRoot: join(dir, '..', '.tmp', 'postgres'),
    inspector: fakeInspector(driver), commandLineFn: (pid) => fakeCommandLine(pid, driver),
  });

  assert.equal(outcome.stopped, true);
  assert.equal(driver.running.size, 0); // killPid removed it from the fake's own bookkeeping
}));

// 40. port released
test('40. after stop, the port is free again', () => withDir(async (dir) => {
  const registry = createResourceRegistry(dir);
  const driver = fakeDriver();
  const config = { ...TEMP_POSTGRES_CONFIG, portRangeStart: 55703, portRangeEnd: 55703 };

  const { resource } = await startTemporaryPostgres(
    { registry, stateDir: dir, jobId: 'j1', attemptId: 'j1-a4' },
    { driver, config, inspector: fakeInspector(driver) },
  );
  await stopTemporaryPostgres(registry, resource.resourceId, {
    driver, tempRoot: join(dir, '..', '.tmp', 'postgres'),
    inspector: fakeInspector(driver), commandLineFn: (pid) => fakeCommandLine(pid, driver),
  });

  // The same range is immediately reusable by a second cluster.
  const second = await startTemporaryPostgres(
    { registry, stateDir: dir, jobId: 'j1', attemptId: 'j1-a5' },
    { driver, config, inspector: fakeInspector(driver) },
  );
  assert.equal(second.resource.metadata.port, 55703);
}));

// 29/30. one postgres per attempt; duplicate start reused
test('29/30. a second start for the SAME attempt reuses the existing ACTIVE resource', () => withDir(async (dir) => {
  const registry = createResourceRegistry(dir);
  const driver = fakeDriver();
  const config = { ...TEMP_POSTGRES_CONFIG, portRangeStart: 55710, portRangeEnd: 55719 };

  const first = await startTemporaryPostgres(
    { registry, stateDir: dir, jobId: 'j2', attemptId: 'j2-a1' },
    { driver, config, inspector: fakeInspector(driver) },
  );
  const second = await startTemporaryPostgres(
    { registry, stateDir: dir, jobId: 'j2', attemptId: 'j2-a1' },
    { driver, config, inspector: fakeInspector(driver) },
  );

  assert.equal(second.reused, true);
  assert.equal(second.resource.resourceId, first.resource.resourceId);
  assert.equal(driver.running.size, 1); // no second cluster was spawned
}));

// 31. global limit
test('31. the global concurrency limit refuses a third cluster', () => withDir(async (dir) => {
  const registry = createResourceRegistry(dir);
  const driver = fakeDriver();
  const config = { ...TEMP_POSTGRES_CONFIG, portRangeStart: 55720, portRangeEnd: 55729, maxGlobal: 2, maxPerAttempt: 1, maxPerJob: 1 };

  await startTemporaryPostgres({ registry, stateDir: dir, jobId: 'j3', attemptId: 'j3-a1' }, { driver, config, inspector: fakeInspector(driver) });
  await startTemporaryPostgres({ registry, stateDir: dir, jobId: 'j4', attemptId: 'j4-a1' }, { driver, config, inspector: fakeInspector(driver) });

  await assert.rejects(
    startTemporaryPostgres({ registry, stateDir: dir, jobId: 'j5', attemptId: 'j5-a1' }, { driver, config, inspector: fakeInspector(driver) }),
    (error) => error.code === 'TEMP_RESOURCE_LIMIT_REACHED',
  );
  assert.equal(driver.running.size, 2);
}));

// 32. capacity retry doesn't accumulate resources
test('32. stopping the first attempt frees a global slot for the next one (no accumulation across a capacity wait)', () => withDir(async (dir) => {
  const registry = createResourceRegistry(dir);
  const driver = fakeDriver();
  const config = { ...TEMP_POSTGRES_CONFIG, portRangeStart: 55730, portRangeEnd: 55739, maxGlobal: 1, maxPerAttempt: 1, maxPerJob: 1 };

  const attempt1 = await startTemporaryPostgres({ registry, stateDir: dir, jobId: 'j6', attemptId: 'j6-a1' }, { driver, config, inspector: fakeInspector(driver) });
  // Simulates USAGE_LIMIT ending attempt 1: cleanup runs before the retry.
  await stopTemporaryPostgres(registry, attempt1.resource.resourceId, {
    driver, tempRoot: join(dir, '..', '.tmp', 'postgres'), inspector: fakeInspector(driver), commandLineFn: (pid) => fakeCommandLine(pid, driver),
  });

  const attempt2 = await startTemporaryPostgres({ registry, stateDir: dir, jobId: 'j6', attemptId: 'j6-a2' }, { driver, config, inspector: fakeInspector(driver) });
  assert.equal(attempt2.reused, false);
  assert.equal(driver.running.size, 1);
  assert.deepEqual((await registry.listActive()).map((r) => r.resourceId), [attempt2.resource.resourceId]);
}));

test('withTemporaryPostgres always cleans up, even when the callback throws', () => withDir(async (dir) => {
  const registry = createResourceRegistry(dir);
  const driver = fakeDriver();
  const config = { ...TEMP_POSTGRES_CONFIG, portRangeStart: 55740, portRangeEnd: 55740 };
  const opts = { driver, config, inspector: fakeInspector(driver), tempRoot: join(dir, '..', '.tmp', 'postgres'), commandLineFn: (pid) => fakeCommandLine(pid, driver) };

  await assert.rejects(
    withTemporaryPostgres({ registry, stateDir: dir, jobId: 'j7', attemptId: 'j7-a1' }, async () => { throw new Error('boom'); }, opts),
    /boom/,
  );
  assert.equal(driver.running.size, 0);
  assert.deepEqual(await registry.listActive(), []);
}));

test('a spawn failure leaves the record CLEANUP_FAILED, not silently forgotten', () => withDir(async (dir) => {
  const registry = createResourceRegistry(dir);
  const driver = fakeDriver({ startFails: true });
  const config = { ...TEMP_POSTGRES_CONFIG, portRangeStart: 55750, portRangeEnd: 55750 };

  await assert.rejects(
    startTemporaryPostgres({ registry, stateDir: dir, jobId: 'j8', attemptId: 'j8-a1' }, { driver, config, inspector: fakeInspector(driver) }),
  );

  const [record] = await registry.list();
  assert.equal(record.status, RESOURCE_STATUS.CLEANUP_FAILED);
}));
