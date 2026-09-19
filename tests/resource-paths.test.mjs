/**
 * Filesystem safety for temporary resource cleanup: only a path that
 * resolves, symlinks and all, strictly inside the allowed temp root may ever
 * be deleted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertSafeTempPath } from '../lib/resource-paths.mjs';

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-path-safety-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

// 33. temp dir under allowed root cleaned
test('33. a directory genuinely inside the allowed root is safe', () => withDir(async (dir) => {
  const root = join(dir, 'root');
  const target = join(root, 'postgres-abc', 'data');
  await mkdir(target, { recursive: true });
  const check = await assertSafeTempPath(target, root);
  assert.equal(check.safe, true);
}));

// 34. arbitrary external dir rejected
test('34. a directory outside the allowed root is refused', () => withDir(async (dir) => {
  const root = join(dir, 'root');
  const outside = join(dir, 'elsewhere');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  const check = await assertSafeTempPath(outside, root);
  assert.equal(check.safe, false);
  assert.equal(check.reason, 'OUTSIDE_ALLOWED_ROOT');
}));

// 35. symlink/junction escape rejected
test('35. a symlink inside the root pointing outside it is refused', async (t) => {
  await withDir(async (dir) => {
    const root = join(dir, 'root');
    const outside = join(dir, 'real-target');
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });

    const link = join(root, 'escape');
    try {
      await symlink(outside, link, 'junction');
    } catch (error) {
      t.skip(`symlink not permitted in this environment: ${error.message}`);
      return;
    }

    const check = await assertSafeTempPath(link, root);
    assert.equal(check.safe, false);
    assert.equal(check.reason, 'OUTSIDE_ALLOWED_ROOT');
  });
});

// 36. primary DB dir never deleted (the root itself is never a valid target)
test('36. the allowed root itself is never a valid deletion target', () => withDir(async (dir) => {
  const root = join(dir, 'root');
  await mkdir(root, { recursive: true });
  const check = await assertSafeTempPath(root, root);
  assert.equal(check.safe, false);
  assert.equal(check.reason, 'IS_ROOT_ITSELF');
}));

test('a path that no longer exists but was lexically inside the root is still safe (idempotent cleanup)', () => withDir(async (dir) => {
  const root = join(dir, 'root');
  await mkdir(root, { recursive: true });
  const check = await assertSafeTempPath(join(root, 'already-gone'), root);
  assert.equal(check.safe, true);
  assert.equal(check.alreadyGone, true);
}));

test('a path that no longer exists but was lexically outside the root is refused', () => withDir(async (dir) => {
  const root = join(dir, 'root');
  await mkdir(root, { recursive: true });
  const check = await assertSafeTempPath(join(dir, 'never-existed'), root);
  assert.equal(check.safe, false);
}));

test('an empty path is refused outright', () => withDir(async (dir) => {
  const check = await assertSafeTempPath('', dir);
  assert.equal(check.safe, false);
  assert.equal(check.reason, 'EMPTY_PATH');
}));
