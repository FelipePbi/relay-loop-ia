/**
 * Provisioning the disposable databases a gate refuses to run without.
 *
 * `validate:integration` demands that every *_TEST_DATABASE_URL name a
 * throwaway cluster, so that it can never fall back to an inherited
 * DATABASE_URL and write somewhere real. The orchestrator started none, so on
 * Goal 014 the gate exited 2 instantly three times while the reviewer ran the
 * suite by hand.
 *
 * The thing these tests guard hardest is cleanup: three PostgreSQL clusters
 * once outlived the jobs that created them, which is why this module exists at
 * all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { databaseNameForEnv, withTestDatabases } from '../lib/temporary-postgres.mjs';

/**
 * Teardown was attempted and recorded.
 *
 * Asserted on the REGISTRY rather than on the driver: ownership is re-proven
 * before a PID is touched, and a stub cluster has no postmaster to prove, so
 * the run ends at CLEANUP_FAILED. That is the designed outcome, not a miss:
 * it is an auditable record the worker loop's scavenger picks up later, which
 * is precisely what an invisible orphaned process is not.
 */
const stopped = (log) => log.some((l) => l === 'status:STOPPING' || l === 'stop');

const USER = 'iapgtest';

/** A registry and driver that record what happened, without spawning anything. */
function harness({ failOn = null } = {}) {
  const log = [];
  const created = [];
  /** The registry's real surface, recorded rather than persisted. */
  let record = null;
  const registry = {
    newResourceId: () => 'postgres-test-1',
    async reserve(entry) {
      log.push('reserve');
      record = { ...entry, status: 'CREATING', metadata: { ...entry.metadata } };
    },
    async get() { return record; },
    async setStatus(_id, status, { metadataPatch = null } = {}) {
      log.push(`status:${status}`);
      record = { ...record, status, metadata: { ...record.metadata, ...(metadataPatch ?? {}) } };
      return record;
    },
    async list() { return record ? [record] : []; },
    // No cluster is already running for this attempt, job, or globally, so
    // every limit in TEMP_POSTGRES_CONFIG is clear and a new one is started.
    async listActive() { return []; },
  };
  const driver = {
    postgresExecutable: 'postgres', pgCtlExecutable: 'pg_ctl',
    initdb: async () => { log.push('initdb'); },
    start: async () => { log.push('start'); },
    stopGraceful: async () => { log.push('stop'); },
    stopImmediate: async () => { log.push('stopImmediate'); },
    killPid: async () => {},
    isReady: () => true,
    createDatabase: async ({ database }) => {
      if (database === failOn) throw new Error(`createdb refused ${database}`);
      created.push(database);
      log.push(`createdb:${database}`);
    },
  };
  return { registry, driver, log, created };
}

/**
 * Runs the body against a real temporary directory.
 *
 * The registry writes its reservation to disk BEFORE anything is spawned —
 * that ordering is what makes a crash leave a record instead of an invisible
 * process — so the tests give it somewhere real to write, and take it away
 * again afterwards.
 */
async function withTempRoot(body) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-pg-'));
  try {
    return await body({ stateDir: dir, tempRoot: join(dir, 'tmp') });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

// --- naming --------------------------------------------------------------

test('a database name is derived from the variable that asked for it', () => {
  assert.equal(databaseNameForEnv('BFF_TEST_DATABASE_URL'), 'ia_bff_test');
  assert.equal(databaseNameForEnv('AI_TEST_DATABASE_URL'), 'ia_ai_test');
  assert.equal(databaseNameForEnv('SCHEDULING_TEST_DATABASE_URL'), 'ia_scheduling_test');
});

/**
 * `scripts/validate-integration.mjs` recognises a database as disposable only
 * when its name contains "test" as a delimited word (DISPOSABLE_NAME there).
 * `ia_bff` alone once passed this file's assertions while failing that guard
 * for real — this test fails loudly if `test` is ever dropped again.
 */
test('every generated name satisfies the gate\'s DISPOSABLE_NAME guard', () => {
  const DISPOSABLE_NAME = /(?:^|[_-])test(?:[_-]|$)/iu;
  for (const envName of ['BFF_TEST_DATABASE_URL', 'AI_TEST_DATABASE_URL', 'SCHEDULING_TEST_DATABASE_URL']) {
    const database = databaseNameForEnv(envName);
    assert.match(database, DISPOSABLE_NAME, `${database} (from ${envName}) is not recognised as disposable`);
  }
});

test('each service gets its OWN database, so one migration cannot decide another schema', () => {
  const names = ['BFF_TEST_DATABASE_URL', 'AI_TEST_DATABASE_URL', 'EVOLUTION_TEST_DATABASE_URL']
    .map(databaseNameForEnv);
  assert.equal(new Set(names).size, 3);
});

// --- nothing to do -------------------------------------------------------

test('no variables requested means no cluster is ever started', async () => {
  await withTempRoot(async ({ stateDir, tempRoot }) => {
    const { registry, driver, log } = harness();
    let received = null;
    const out = await withTestDatabases(
      { registry, stateDir }, [], (env) => { received = env; return 'ran'; }, { driver, tempRoot },
    );

    assert.equal(out, 'ran');
    assert.deepEqual(received, {});
    assert.deepEqual(log, [], 'a gate that needs nothing must not pay for a cluster');
  });
});

// --- cleanup, which is the whole point ----------------------------------

test('the cluster is stopped after the action, on the happy path', async () => {
  await withTempRoot(async ({ stateDir, tempRoot }) => {
    const { registry, driver, log } = harness();
    await withTestDatabases(
      { registry, stateDir, attemptId: 'a1' }, ['BFF_TEST_DATABASE_URL'], () => 'ok', { driver, tempRoot },
    );
    assert.ok(stopped(log), 'the cluster must not outlive the action');
    assert.ok(log.indexOf('createdb:ia_bff_test') < log.findIndex((l) => l === 'status:STOPPING'));
  });
});

test('the cluster is stopped even when the action THROWS', async () => {
  await withTempRoot(async ({ stateDir, tempRoot }) => {
    const { registry, driver, log } = harness();
    await assert.rejects(
      () => withTestDatabases(
        { registry, stateDir, attemptId: 'a1' }, ['BFF_TEST_DATABASE_URL'],
        () => { throw new Error('the gate blew up'); }, { driver, tempRoot },
      ),
      /the gate blew up/,
    );
    assert.ok(stopped(log), 'a failing gate is exactly when a cluster gets orphaned');
  });
});

test('the cluster is stopped even when creating a database fails halfway', async () => {
  await withTempRoot(async ({ stateDir, tempRoot }) => {
    const { registry, driver, log, created } = harness({ failOn: 'ia_ai_test' });
    await assert.rejects(
      () => withTestDatabases(
        { registry, stateDir, attemptId: 'a1' },
        ['BFF_TEST_DATABASE_URL', 'AI_TEST_DATABASE_URL'],
        () => 'never reached', { driver, tempRoot },
      ),
      /createdb refused/,
    );
    assert.deepEqual(created, ['ia_bff_test'], 'the first one was made');
    assert.ok(stopped(log), 'and the cluster was still torn down');
  });
});

// --- what the action receives -------------------------------------------

test('the action receives one URL per variable, on the cluster that was started', async () => {
  await withTempRoot(async ({ stateDir, tempRoot }) => {
    const { registry, driver } = harness();
    let env = null;
    await withTestDatabases(
      { registry, stateDir, attemptId: 'a1' },
      ['BFF_TEST_DATABASE_URL', 'AI_TEST_DATABASE_URL'],
      (received) => { env = received; }, { driver, tempRoot },
    );

    assert.deepEqual(Object.keys(env), ['BFF_TEST_DATABASE_URL', 'AI_TEST_DATABASE_URL']);
    // The port is chosen from a free one in the configured range, so it is
    // asserted by shape rather than pinned to a number a parallel run could
    // legitimately take.
    assert.match(env.BFF_TEST_DATABASE_URL, new RegExp(`^postgresql://${USER}@127\\.0\\.0\\.1:555\\d\\d/ia_bff_test$`));
    assert.match(env.AI_TEST_DATABASE_URL, /\/ia_ai_test$/);
    const port = (url) => url.match(/:(\d+)\//)[1];
    assert.equal(port(env.BFF_TEST_DATABASE_URL), port(env.AI_TEST_DATABASE_URL),
      'both databases live on the ONE cluster that was started, not two');
    for (const url of Object.values(env)) {
      assert.match(url, /^postgresql:\/\//, 'the gate validates the protocol and rejects anything else');
      assert.match(url, /127\.0\.0\.1/, 'never a host that could be something real');
    }
  });
});

test('a repeated variable is one database, not two', async () => {
  await withTempRoot(async ({ stateDir, tempRoot }) => {
    const { registry, driver, created } = harness();
    await withTestDatabases(
      { registry, stateDir, attemptId: 'a1' },
      ['BFF_TEST_DATABASE_URL', 'BFF_TEST_DATABASE_URL', '  ', null],
      () => {}, { driver, tempRoot },
    );
    assert.deepEqual(created, ['ia_bff_test']);
  });
});
