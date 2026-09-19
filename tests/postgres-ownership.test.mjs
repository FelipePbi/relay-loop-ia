/**
 * PostgreSQL ownership proof: PID + start time + executable + data directory,
 * ALL required before a process may be considered ours to touch.
 *
 * Every case injects a fake inspector/commandLine reader — never depends on
 * the machine it runs on, same discipline as orphan-evidence's tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { LIVENESS } from '../lib/process-inspector.mjs';
import { OWNERSHIP, isCleanable, isKillable, provePostgresOwnership } from '../lib/postgres-ownership.mjs';

const RESOURCE = Object.freeze({
  metadata: {
    postgresPid: 24648,
    postgresProcessStartTime: '2026-09-08T10:00:00.000Z',
    postgresExecutable: 'C:/pg/bin/postgres.exe',
    dataDirectory: 'C:/tmp/atendly-ia-loop/postgres/postgres-abc/data',
  },
});

function inspector({ liveness = LIVENESS.ALIVE, startedAt = RESOURCE.metadata.postgresProcessStartTime } = {}) {
  return { exists: () => liveness, startedAt: async () => startedAt };
}

// 7. PID correct + start time correct -> confirmed
test('7. matching pid, start time, executable and data dir -> CONFIRMED', async () => {
  const proof = await provePostgresOwnership(RESOURCE, inspector(), {
    commandLineFn: async () => '"C:/pg/bin/postgres.exe" -D "C:/tmp/atendly-ia-loop/postgres/postgres-abc/data"',
  });
  assert.equal(proof.ownership, OWNERSHIP.CONFIRMED);
  assert.ok(isKillable(proof));
  assert.ok(isCleanable(proof));
});

// 8. PID reused -> rejected
test('8. same pid, different start time -> PID_REUSED, never killable', async () => {
  const proof = await provePostgresOwnership(RESOURCE, inspector({ startedAt: '2026-09-08T18:40:00.000Z' }));
  assert.equal(proof.ownership, OWNERSHIP.PID_REUSED);
  assert.ok(!isKillable(proof));
  assert.ok(isCleanable(proof)); // safe to reclaim the directory; nothing of ours is running
});

// 9. wrong executable -> rejected
test('9. command line does not reference the recorded executable -> EXECUTABLE_MISMATCH', async () => {
  const proof = await provePostgresOwnership(RESOURCE, inspector(), {
    commandLineFn: async () => '"C:/Windows/System32/notepad.exe"',
  });
  assert.equal(proof.ownership, OWNERSHIP.EXECUTABLE_MISMATCH);
  assert.ok(!isKillable(proof));
  assert.ok(!isCleanable(proof));
});

// 10. wrong PGDATA -> rejected
test('10. command line references the right binary but a different data directory -> DATA_DIR_MISMATCH', async () => {
  const proof = await provePostgresOwnership(RESOURCE, inspector(), {
    commandLineFn: async () => '"C:/pg/bin/postgres.exe" -D "C:/somewhere/else/data"',
  });
  assert.equal(proof.ownership, OWNERSHIP.DATA_DIR_MISMATCH);
  assert.ok(!isCleanable(proof));
});

// 11. missing process -> orphan candidate (cleanable, nothing to kill)
test('11. pid does not exist -> PROCESS_GONE, cleanable but never killable', async () => {
  const proof = await provePostgresOwnership(RESOURCE, inspector({ liveness: LIVENESS.GONE }));
  assert.equal(proof.ownership, OWNERSHIP.PROCESS_GONE);
  assert.ok(!isKillable(proof));
  assert.ok(isCleanable(proof));
});

// 12. unknown ownership -> never kill
test('12. liveness cannot be determined -> UNKNOWN, never killable, never cleanable', async () => {
  const proof = await provePostgresOwnership(RESOURCE, inspector({ liveness: LIVENESS.UNKNOWN }));
  assert.equal(proof.ownership, OWNERSHIP.UNKNOWN);
  assert.ok(!isKillable(proof));
  assert.ok(!isCleanable(proof));
});

test('a resource with no postgresPid recorded is UNKNOWN, not PROCESS_GONE', async () => {
  const proof = await provePostgresOwnership({ metadata: {} }, inspector());
  assert.equal(proof.ownership, OWNERSHIP.UNKNOWN);
});

test('a live pid whose start time cannot be observed is UNKNOWN, not assumed confirmed', async () => {
  const proof = await provePostgresOwnership(RESOURCE, { exists: () => LIVENESS.ALIVE, startedAt: async () => null });
  assert.equal(proof.ownership, OWNERSHIP.UNKNOWN);
});

test('a live, correctly-timed pid whose command line cannot be read is UNKNOWN, not assumed confirmed', async () => {
  const proof = await provePostgresOwnership(RESOURCE, inspector(), { commandLineFn: async () => null });
  assert.equal(proof.ownership, OWNERSHIP.UNKNOWN);
});
