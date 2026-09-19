/**
 * The two inspection/cleanup CLIs, tested as pure functions (same shape as
 * their `main()`): building/rendering the status report, and planning +
 * rendering a cleanup — dry-run performs zero mutation, --apply acts only on
 * CONFIRMED ownership.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createResourceRegistry, RESOURCE_STATUS } from '../lib/resource-registry.mjs';
import { LIVENESS } from '../lib/process-inspector.mjs';
import { startTemporaryPostgres, stopTemporaryPostgres, TEMP_POSTGRES_CONFIG } from '../lib/temporary-postgres.mjs';
import { buildResourceReport, renderResourceReport } from '../run-resources.mjs';
import { planCleanup, renderPlan } from '../run-resources-cleanup.mjs';

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-resources-cli-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

function fakeDriver() {
  let nextPid = 94000;
  const running = new Map();
  return {
    postgresExecutable: '/fake/bin/postgres',
    pgCtlExecutable: '/fake/bin/pg_ctl',
    running,
    async initdb({ dataDirectory }) { await mkdir(dataDirectory, { recursive: true }); },
    async start({ dataDirectory }) {
      const pid = nextPid++;
      running.set(dataDirectory, pid);
      await writeFile(join(dataDirectory, 'postmaster.pid'), `${pid}\n5432\n`, 'utf8');
    },
    async stopGraceful({ dataDirectory }) { running.delete(dataDirectory); },
    async stopImmediate({ dataDirectory }) { running.delete(dataDirectory); },
    async killPid(pid) { for (const [d, p] of running) if (p === pid) running.delete(d); },
    async isReady() { return true; },
  };
}

function fakeInspector(driver, { alive = true } = {}) {
  return {
    exists: (pid) => ([...driver.running.values()].includes(pid) && alive ? LIVENESS.ALIVE : LIVENESS.GONE),
    startedAt: async () => '2026-09-08T10:00:00.000Z',
  };
}

// 42. no resources shows none
test('42. an empty registry reports "Temporary resources: none"', () => withDir(async (dir) => {
  const registry = createResourceRegistry(dir);
  const report = await buildResourceReport({ registry, inspector: fakeInspector(fakeDriver()), now: Date.now() });
  assert.equal(renderResourceReport(report), 'Temporary resources: none');
}));

// 41. active resource shown
test('41. an ACTIVE resource is shown with pid, port, data dir and ownership', () => withDir(async (dir) => {
  const registry = createResourceRegistry(dir);
  const driver = fakeDriver();
  const config = { ...TEMP_POSTGRES_CONFIG, portRangeStart: 55600, portRangeEnd: 55600 };
  await startTemporaryPostgres(
    { registry, stateDir: dir, jobId: 'g007-r1-developer', attemptId: 'g007-r1-developer-a1', goalId: 'g007', round: 1, role: 'developer' },
    { driver, config, inspector: fakeInspector(driver) },
  );

  const commandLine = async () => `${driver.postgresExecutable} -D x`;
  const report = await buildResourceReport({
    registry,
    inspector: { exists: () => LIVENESS.ALIVE, startedAt: async () => '2026-09-08T10:00:00.000Z' },
    now: Date.now(),
  });
  const rendered = renderResourceReport(report);
  assert.match(rendered, /PostgreSQL: 1 tracked/);
  assert.match(rendered, /port: 55600/);
  assert.match(rendered, /owner: g007\/R1\/developer/);
  void commandLine;
}));

// 43. orphan shown clearly
test('43. an ORPHAN_SUSPECTED resource is labelled as such, not as ACTIVE', () => withDir(async (dir) => {
  const registry = createResourceRegistry(dir);
  await registry.reserve({ resourceId: 'postgres-orphan1', resourceType: 'postgres', attemptId: 'a1', metadata: {} });
  await registry.setStatus('postgres-orphan1', RESOURCE_STATUS.ORPHAN_SUSPECTED, { detail: 'owner gone' });

  const report = await buildResourceReport({ registry, inspector: fakeInspector(fakeDriver()), now: Date.now() });
  const rendered = renderResourceReport(report);
  assert.match(rendered, /state: ORPHAN_SUSPECTED/);
}));

// 44. dry-run performs zero mutation
test('44. planCleanup + dry-run rendering never calls stop or mutates the registry', () => withDir(async (dir) => {
  const registry = createResourceRegistry(dir);
  const driver = fakeDriver();
  const config = { ...TEMP_POSTGRES_CONFIG, portRangeStart: 55610, portRangeEnd: 55610 };
  const { resource } = await startTemporaryPostgres(
    { registry, stateDir: dir, jobId: 'g007-r1-developer', attemptId: 'g007-r1-developer-a1' },
    { driver, config, inspector: fakeInspector(driver) },
  );

  const plan = await planCleanup({ registry, inspector: fakeInspector(driver) });
  renderPlan(plan, { apply: false });

  const unchanged = await registry.get(resource.resourceId);
  assert.equal(unchanged.status, RESOURCE_STATUS.ACTIVE);
  assert.equal(driver.running.size, 1);
}));

// 45/46. apply cleans CONFIRMED only; UNKNOWN ownership skipped
test('45/46. --apply cleans the CONFIRMED resource and leaves the UNKNOWN one untouched', () => withDir(async (dir) => {
  const registry = createResourceRegistry(dir);
  const driver = fakeDriver();
  const config = { ...TEMP_POSTGRES_CONFIG, portRangeStart: 55620, portRangeEnd: 55621 };

  const confirmed = await startTemporaryPostgres(
    { registry, stateDir: dir, jobId: 'j1', attemptId: 'j1-a1' },
    { driver, config, inspector: fakeInspector(driver) },
  );
  const unknown = await startTemporaryPostgres(
    { registry, stateDir: dir, jobId: 'j2', attemptId: 'j2-a1' },
    { driver, config, inspector: fakeInspector(driver) },
  );

  const inspector = fakeInspector(driver);
  // Only the first resource's real data directory is on its command line —
  // simulating "we can read the OS command line for one pid but not the
  // other" without depending on real OS process enumeration in a test.
  const commandLineFn = async (pid) => {
    if (pid === confirmed.resource.metadata.postgresPid) {
      return `${driver.postgresExecutable} -D ${confirmed.resource.metadata.dataDirectory}`;
    }
    return null; // unreadable for the second — ownership stays UNKNOWN
  };

  const plan = await planCleanup({ registry, inspector, commandLineFn });
  const confirmedItem = plan.find((p) => p.resource.resourceId === confirmed.resource.resourceId);
  const unknownItem = plan.find((p) => p.resource.resourceId === unknown.resource.resourceId);
  assert.equal(confirmedItem.safeToClean, true);
  assert.equal(unknownItem.safeToClean, false);

  const rendered = renderPlan(plan, { apply: true });
  assert.match(rendered, /Ownership:\s*\n\s*CONFIRMED/);

  // Apply, exactly like main()'s --apply branch: only safeToClean items.
  const tempRoot = join(dir, '..', '.tmp', 'postgres');
  for (const item of plan.filter((p) => p.safeToClean)) {
    // eslint-disable-next-line no-await-in-loop
    await stopTemporaryPostgres(registry, item.resource.resourceId, { driver, tempRoot, inspector, commandLineFn });
  }

  const confirmedAfter = await registry.get(confirmed.resource.resourceId);
  const unknownAfter = await registry.get(unknown.resource.resourceId);
  assert.equal(confirmedAfter.status, RESOURCE_STATUS.CLEANED);
  assert.equal(unknownAfter.status, RESOURCE_STATUS.ACTIVE); // untouched
  assert.equal(driver.running.size, 1); // only the unknown one still runs
}));
