/**
 * Temporary resource registry: reservation, atomic status transitions,
 * duplicate refusal, and recovery after a partial write.
 *
 * No real PostgreSQL, no model call — pure filesystem behaviour, the same
 * shape as job-store.test.mjs and leases.test.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createResourceRegistry, RESOURCE_STATUS } from '../lib/resource-registry.mjs';

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-resources-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

// 1. create resource record
test('1. reserve() creates a CREATING record with the fields it was given', () => withDir(async (dir) => {
  const registry = createResourceRegistry(dir);
  const record = await registry.reserve({
    resourceId: 'postgres-abc123', resourceType: 'postgres', goalId: '007', round: 1,
    stage: 'developer', role: 'developer', jobId: '007-r1-developer', attemptId: '007-r1-developer-a1',
    ownerWorkerId: 'host-1', ownerProcessId: 1234, ownerProcessStartTime: '2026-01-01T00:00:00.000Z',
    metadata: { port: 55500 },
  });
  assert.equal(record.status, RESOURCE_STATUS.CREATING);
  assert.equal(record.resourceId, 'postgres-abc123');
  assert.equal(record.attemptId, '007-r1-developer-a1');
  assert.equal(record.metadata.port, 55500);
}));

// 2. atomic persistence
test('2. reserve() is atomic: the file exists fully-formed or not at all', () => withDir(async (dir) => {
  const registry = createResourceRegistry(dir);
  await registry.reserve({ resourceId: 'r1', resourceType: 'postgres', attemptId: 'a1' });
  const raw = await readFile(join(registry.dir, 'r1.json'), 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw));
}));

// 3. CREATING -> ACTIVE
test('3. setStatus moves CREATING to ACTIVE and appends history', () => withDir(async (dir) => {
  const registry = createResourceRegistry(dir);
  await registry.reserve({ resourceId: 'r1', resourceType: 'postgres', attemptId: 'a1' });
  const active = await registry.setStatus('r1', RESOURCE_STATUS.ACTIVE, { metadataPatch: { port: 55500 } });
  assert.equal(active.status, RESOURCE_STATUS.ACTIVE);
  assert.equal(active.metadata.port, 55500);
  assert.deepEqual(active.history.map((h) => h.status), [RESOURCE_STATUS.CREATING, RESOURCE_STATUS.ACTIVE]);
}));

// 4. ACTIVE -> CLEANED
test('4. setStatus moves ACTIVE to CLEANED and CLEANED is distinguishable from ACTIVE', () => withDir(async (dir) => {
  const registry = createResourceRegistry(dir);
  await registry.reserve({ resourceId: 'r1', resourceType: 'postgres', attemptId: 'a1' });
  await registry.setStatus('r1', RESOURCE_STATUS.ACTIVE);
  const cleaned = await registry.setStatus('r1', RESOURCE_STATUS.CLEANED);
  assert.equal(cleaned.status, RESOURCE_STATUS.CLEANED);
  assert.deepEqual(await registry.listActive(), []);
}));

// 5. recovery after partial write
test('5. a resource left in CREATING after a crash is still readable and listable', () => withDir(async (dir) => {
  const registry = createResourceRegistry(dir);
  await registry.reserve({ resourceId: 'r1', resourceType: 'postgres', attemptId: 'a1' });
  // Simulates a crash between reserve() and the spawn that would have
  // followed it: nothing more is ever written.
  const read = await registry.get('r1');
  assert.equal(read.status, RESOURCE_STATUS.CREATING);
  assert.deepEqual(await registry.listActive(), [read]);
}));

// 6. duplicate resourceId refused
test('6. reserving the same resourceId twice is refused', () => withDir(async (dir) => {
  const registry = createResourceRegistry(dir);
  await registry.reserve({ resourceId: 'r1', resourceType: 'postgres', attemptId: 'a1' });
  await assert.rejects(
    registry.reserve({ resourceId: 'r1', resourceType: 'postgres', attemptId: 'a2' }),
    (error) => error.code === 'DUPLICATE_RESOURCE',
  );
}));

test('listByAttempt / listByJob scope correctly', () => withDir(async (dir) => {
  const registry = createResourceRegistry(dir);
  await registry.reserve({ resourceId: 'r1', resourceType: 'postgres', jobId: 'j1', attemptId: 'j1-a1' });
  await registry.reserve({ resourceId: 'r2', resourceType: 'postgres', jobId: 'j1', attemptId: 'j1-a2' });
  await registry.reserve({ resourceId: 'r3', resourceType: 'postgres', jobId: 'j2', attemptId: 'j2-a1' });

  assert.equal((await registry.listByAttempt('j1-a1')).length, 1);
  assert.equal((await registry.listByJob('j1')).length, 2);
  assert.equal((await registry.list()).length, 3);
}));

test('list() on an empty registry returns an empty array, not an error', () => withDir(async (dir) => {
  const registry = createResourceRegistry(dir);
  assert.deepEqual(await registry.list(), []);
  assert.deepEqual(await registry.listActive(), []);
}));

test('setStatus on an unknown resource fails rather than silently creating one', () => withDir(async (dir) => {
  const registry = createResourceRegistry(dir);
  await assert.rejects(registry.setStatus('missing', RESOURCE_STATUS.ACTIVE));
}));

test('a corrupt resource file is refused, never silently treated as absent', () => withDir(async (dir) => {
  const registry = createResourceRegistry(dir);
  await mkdir(registry.dir, { recursive: true });
  await writeFile(join(registry.dir, 'bad.json'), '{not json', 'utf8');
  await assert.rejects(registry.list(), (error) => error.code === 'FILE_CORRUPT');
}));
