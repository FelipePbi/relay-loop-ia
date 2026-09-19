/**
 * Wiring the registry into the harness's actual lifecycle: attempt cleanup
 * (whatever the attempt's outcome), and the startup scavenger that recovers
 * a resource whose owning process is provably gone — a crash, a killed
 * terminal, or a reboot, none of which run a `finally`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createResourceRegistry, RESOURCE_STATUS } from '../lib/resource-registry.mjs';
import { LIVENESS } from '../lib/process-inspector.mjs';
import { cleanupResourcesForAttempt, scavengeOrphans, discoverLegacyCandidates } from '../lib/resource-lifecycle.mjs';
import { startTemporaryPostgres, TEMP_POSTGRES_CONFIG } from '../lib/temporary-postgres.mjs';

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-resource-lifecycle-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

function fakeDriver() {
  let nextPid = 92000;
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

function fakeInspector(driver, { ownerAlive = true, ownerPid = process.pid, postgresStillAlive = true } = {}) {
  const postgresPids = new Set(driver.running.values());
  return {
    exists: (pid) => {
      if (pid === ownerPid) return ownerAlive ? LIVENESS.ALIVE : LIVENESS.GONE;
      if (postgresPids.has(pid)) return postgresStillAlive ? LIVENESS.ALIVE : LIVENESS.GONE;
      return LIVENESS.GONE;
    },
    startedAt: async (pid) => (pid === ownerPid ? '2026-09-08T09:00:00.000Z' : '2026-09-08T10:00:00.000Z'),
  };
}

const fakeCommandLine = async (pid, driver) => {
  for (const [dataDirectory] of driver.running) return `${driver.postgresExecutable} -D ${dataDirectory}`;
  return null;
};

async function makeResource(dir, driver, { jobId, attemptId, ownerProcessId = process.pid, ownerProcessStartTime = '2026-09-08T09:00:00.000Z' }) {
  const registry = createResourceRegistry(dir);
  const config = { ...TEMP_POSTGRES_CONFIG, portRangeStart: 55800 + Math.floor(Math.random() * 90), portRangeEnd: 55899 };
  const { resource } = await startTemporaryPostgres(
    { registry, stateDir: dir, jobId, attemptId },
    { driver, config, inspector: fakeInspector(driver), identity: { hostname: 'host', pid: ownerProcessId, processStartedAt: ownerProcessStartTime } },
  );
  return { registry, resource };
}

// 13-20. attempt cleanup, regardless of terminal outcome
for (const outcome of ['COMPLETED', 'FAILED', 'HARNESS_ERROR', 'USAGE_LIMIT', 'RATE_LIMIT', 'HUMAN_REQUIRED', 'CORRECTION', 'REVIEW']) {
  test(`13-20. cleanupResourcesForAttempt cleans up on ${outcome}`, () => withDir(async (dir) => {
    const driver = fakeDriver();
    const { registry, resource } = await makeResource(dir, driver, { jobId: 'j1', attemptId: `j1-a1-${outcome}` });

    const { results } = await cleanupResourcesForAttempt(registry, `j1-a1-${outcome}`, {
      stateDir: dir, inspector: fakeInspector(driver), commandLineFn: (pid) => fakeCommandLine(pid, driver), driver,
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].resource.status, RESOURCE_STATUS.CLEANED);
    assert.equal(driver.running.size, 0);
  }));
}

test('cleanupResourcesForAttempt is a no-op when the attempt owns nothing', () => withDir(async (dir) => {
  const registry = createResourceRegistry(dir);
  const { results } = await cleanupResourcesForAttempt(registry, 'no-such-attempt', { stateDir: dir });
  assert.deepEqual(results, []);
}));

test('cleanupResourcesForAttempt never touches a resource belonging to a DIFFERENT attempt', () => withDir(async (dir) => {
  const driver = fakeDriver();
  // Different jobIds: two attempts of the SAME job would collide with the
  // per-job concurrency limit (Part I), which is a different guarantee than
  // the one this test is checking (attempt-scoped cleanup).
  const { registry } = await makeResource(dir, driver, { jobId: 'j1', attemptId: 'j1-a1' });
  await makeResource(dir, driver, { jobId: 'j2', attemptId: 'j2-a1' });

  await cleanupResourcesForAttempt(registry, 'j1-a1', {
    stateDir: dir, inspector: fakeInspector(driver), commandLineFn: (pid) => fakeCommandLine(pid, driver), driver,
  });

  const remaining = await registry.listActive();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].attemptId, 'j2-a1');
}));

// 24-28. crash/restart recovery via the startup scavenger
test('24-27. a resource whose OWNER process is gone and whose postgres is confirmed ownable is cleaned by the scavenger', () => withDir(async (dir) => {
  const driver = fakeDriver();
  const deadOwnerPid = 55555;
  const { registry, resource } = await makeResource(dir, driver, { jobId: 'j2', attemptId: 'j2-a1', ownerProcessId: deadOwnerPid });

  // The worker that created this resource is gone (crash); the postgres
  // server it started is still running — exactly what a scavenger on a
  // NEW worker instance discovers at startup.
  const inspector = fakeInspector(driver, { ownerAlive: false, ownerPid: deadOwnerPid });

  const { report } = await scavengeOrphans(registry, {
    stateDir: dir, inspector, commandLineFn: (pid) => fakeCommandLine(pid, driver), driver,
  });

  assert.equal(report.length, 1);
  assert.equal(report[0].verdict, 'ORPHAN_CONFIRMED');
  assert.equal(report[0].cleaned, true);

  const final = await registry.get(resource.resourceId);
  assert.equal(final.status, RESOURCE_STATUS.CLEANED);
  assert.equal(driver.running.size, 0);
}));

// 28. no duplicate cleanup
test('28. running the scavenger a second time performs no duplicate cleanup', () => withDir(async (dir) => {
  const driver = fakeDriver();
  const deadOwnerPid = 55556;
  const { registry } = await makeResource(dir, driver, { jobId: 'j3', attemptId: 'j3-a1', ownerProcessId: deadOwnerPid });
  const inspector = fakeInspector(driver, { ownerAlive: false, ownerPid: deadOwnerPid });
  const opts = { stateDir: dir, inspector, commandLineFn: (pid) => fakeCommandLine(pid, driver), driver };

  const first = await scavengeOrphans(registry, opts);
  assert.equal(first.report[0].verdict, 'ORPHAN_CONFIRMED');

  const second = await scavengeOrphans(registry, opts);
  assert.deepEqual(second.report, []); // already CLEANED — no longer "live", nothing to judge again
}));

test('an owner process still alive is left completely untouched by the scavenger', () => withDir(async (dir) => {
  const driver = fakeDriver();
  const { registry, resource } = await makeResource(dir, driver, { jobId: 'j4', attemptId: 'j4-a1' });
  const inspector = fakeInspector(driver, { ownerAlive: true });

  const { report } = await scavengeOrphans(registry, { stateDir: dir, inspector, commandLineFn: (pid) => fakeCommandLine(pid, driver), driver });

  assert.equal(report[0].verdict, 'OWNER_ALIVE');
  const unchanged = await registry.get(resource.resourceId);
  assert.equal(unchanged.status, RESOURCE_STATUS.ACTIVE);
  assert.equal(driver.running.size, 1);
}));

// 11/12 restated at the scavenger level: unknown ownership never authorises a kill
test('owner gone but postgres ownership cannot be proven -> ORPHAN_SUSPECTED, never cleaned', () => withDir(async (dir) => {
  const driver = fakeDriver();
  const deadOwnerPid = 55557;
  const { registry, resource } = await makeResource(dir, driver, { jobId: 'j5', attemptId: 'j5-a1', ownerProcessId: deadOwnerPid });
  const inspector = fakeInspector(driver, { ownerAlive: false, ownerPid: deadOwnerPid });

  // No commandLineFn override: the real OS lookup for a fake pid returns
  // null, so ownership of the postgres process itself cannot be proven.
  const { report } = await scavengeOrphans(registry, { stateDir: dir, inspector, driver });

  assert.equal(report[0].verdict, 'ORPHAN_SUSPECTED');
  assert.match(report[0].detail, /HUMAN_REQUIRED/);
  const unchanged = await registry.get(resource.resourceId);
  assert.equal(unchanged.status, RESOURCE_STATUS.ORPHAN_SUSPECTED);
  assert.equal(driver.running.size, 1); // untouched
}));

test('legacy discovery is read-only and skips cleanly off Windows', async () => {
  const { candidates, skipped } = await discoverLegacyCandidates({ platform: 'linux' });
  assert.deepEqual(candidates, []);
  assert.equal(skipped, 'LEGACY_DISCOVERY_ONLY_IMPLEMENTED_FOR_WINDOWS');
});
