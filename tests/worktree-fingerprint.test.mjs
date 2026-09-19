/**
 * A fingerprint that covers the whole worktree.
 *
 * Written because a forensic comparison could only reach a verdict for part of
 * a tree. After a duplicate Opus attempt was published against Goal 004, the
 * tracked content was provably byte-identical to what the reviewer had seen —
 * the diff was saved and hashed. The twenty UNTRACKED files were not covered by
 * `git diff`, and the older fingerprint hashed tracked content only, so their
 * verdict had to be UNPROVEN.
 *
 * These run against real, temporary git repositories: the thing under test is
 * exactly the interaction with git, so faking it would test nothing. No model
 * is called.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git } from '../lib/git-ops.mjs';
import {
  FINGERPRINT_VERSION, compareFingerprints, fullWorktreeFingerprint,
} from '../lib/worktree-fingerprint.mjs';

async function withRepo(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-fp-'));
  try {
    const opts = { cwd: dir };
    await git(['init', '-b', 'main'], opts);
    await git(['config', 'user.email', 'test@example.com'], opts);
    await git(['config', 'user.name', 'Test'], opts);
    await writeFile(join(dir, 'tracked.txt'), 'original\n', 'utf8');
    await git(['add', '.'], opts);
    await git(['commit', '-m', 'base'], opts);
    const base = await git(['rev-parse', 'HEAD'], opts);
    return await run({ dir, base, opts });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test('the fingerprint records what the older one could not: untracked CONTENT', async () => {
  await withRepo(async ({ dir, base }) => {
    await writeFile(join(dir, 'tracked.txt'), 'changed\n', 'utf8');
    await writeFile(join(dir, 'new-file.ts'), 'export const a = 1;\n', 'utf8');

    const fp = await fullWorktreeFingerprint(dir, base, { worktreeInitialHead: base });

    assert.equal(fp.fingerprintVersion, FINGERPRINT_VERSION);
    assert.equal(fp.base, base);
    assert.equal(fp.worktreeInitialHead, base);
    assert.equal(fp.head, base, 'no commit was made in the worktree');
    assert.equal(fp.branch, 'main');

    assert.ok(fp.trackedDiffHash, 'the tracked diff is hashed');
    assert.deepEqual(fp.trackedFiles, ['tracked.txt']);

    assert.equal(fp.untrackedFileCount, 1);
    assert.equal(fp.untracked[0].path, 'new-file.ts');
    assert.ok(fp.untracked[0].sha256, 'the CONTENT of the untracked file is hashed');
    assert.equal(fp.untracked[0].bytes, 'export const a = 1;\n'.length);
    assert.ok(fp.contentHash, 'and one value covers the whole tree');
  });
});

test('an untracked file changing in place is detected — the gap that made a verdict impossible', async () => {
  await withRepo(async ({ dir, base }) => {
    await writeFile(join(dir, 'untracked.ts'), 'first\n', 'utf8');
    const before = await fullWorktreeFingerprint(dir, base);

    // Same path, same count, same tracked diff. Only the content moved: exactly
    // the change the old evidence could not have seen.
    await writeFile(join(dir, 'untracked.ts'), 'second\n', 'utf8');
    const after = await fullWorktreeFingerprint(dir, base);

    assert.equal(before.untrackedFileCount, after.untrackedFileCount, 'the count is unchanged');
    assert.equal(before.trackedDiffHash, after.trackedDiffHash, 'and so is the tracked diff');
    assert.notEqual(before.untrackedHash, after.untrackedHash, 'but the content hash moves');
    assert.notEqual(before.contentHash, after.contentHash);

    const delta = compareFingerprints(before, after);
    assert.equal(delta.identical, false);
    assert.deepEqual(delta.untrackedModified, ['untracked.ts'], 'and it names the exact path');
    assert.deepEqual(delta.untrackedAdded, []);
    assert.deepEqual(delta.untrackedRemoved, []);
  });
});

test('an unchanged tree fingerprints identically twice', async () => {
  await withRepo(async ({ dir, base }) => {
    await writeFile(join(dir, 'tracked.txt'), 'changed\n', 'utf8');
    await writeFile(join(dir, 'untracked.ts'), 'x\n', 'utf8');

    const a = await fullWorktreeFingerprint(dir, base);
    const b = await fullWorktreeFingerprint(dir, base);

    assert.equal(a.contentHash, b.contentHash);
    assert.equal(compareFingerprints(a, b).identical, true);
  });
});

test('added and removed untracked files are named separately from modified ones', async () => {
  await withRepo(async ({ dir, base }) => {
    await writeFile(join(dir, 'keep.ts'), 'k\n', 'utf8');
    await writeFile(join(dir, 'gone.ts'), 'g\n', 'utf8');
    const before = await fullWorktreeFingerprint(dir, base);

    await rm(join(dir, 'gone.ts'));
    await writeFile(join(dir, 'added.ts'), 'a\n', 'utf8');
    const after = await fullWorktreeFingerprint(dir, base);

    const delta = compareFingerprints(before, after);
    assert.deepEqual(delta.untrackedAdded, ['added.ts']);
    assert.deepEqual(delta.untrackedRemoved, ['gone.ts']);
    assert.deepEqual(delta.untrackedModified, []);
    assert.equal(delta.trackedChanged, false);
  });
});

test('a tracked change is reported as a tracked change', async () => {
  await withRepo(async ({ dir, base }) => {
    const before = await fullWorktreeFingerprint(dir, base);
    await writeFile(join(dir, 'tracked.txt'), 'moved\n', 'utf8');
    const after = await fullWorktreeFingerprint(dir, base);

    const delta = compareFingerprints(before, after);
    assert.equal(delta.trackedChanged, true);
    assert.equal(delta.identical, false);
  });
});

test('nested untracked files are covered, not just the top level', async () => {
  await withRepo(async ({ dir, base }) => {
    await mkdir(join(dir, 'src', 'inbox'), { recursive: true });
    await writeFile(join(dir, 'src', 'inbox', 'InboxStore.ts'), 'store\n', 'utf8');

    const fp = await fullWorktreeFingerprint(dir, base);
    assert.deepEqual(fp.untracked.map((f) => f.path), ['src/inbox/InboxStore.ts']);
    assert.ok(fp.untracked[0].sha256);
  });
});

test('content is hashed as bytes, so line endings are a real difference', async () => {
  await withRepo(async ({ dir, base }) => {
    await writeFile(join(dir, 'u.ts'), 'a\nb\n', 'utf8');
    const lf = await fullWorktreeFingerprint(dir, base);
    await writeFile(join(dir, 'u.ts'), 'a\r\nb\r\n', 'utf8');
    const crlf = await fullWorktreeFingerprint(dir, base);

    // Normalising here would let two genuinely different files hash the same,
    // which is the one thing a fingerprint must never do.
    assert.notEqual(lf.untracked[0].sha256, crlf.untracked[0].sha256);
  });
});

test('comparing against a missing or differently versioned fingerprint is refused, not guessed', () => {
  assert.equal(compareFingerprints(null, {}).comparable, false);
  assert.equal(compareFingerprints({}, null).identical, false);
  assert.equal(
    compareFingerprints({ fingerprintVersion: 1 }, { fingerprintVersion: 2 }).reason,
    'FINGERPRINT_VERSION_MISMATCH',
  );
});

test('the fingerprint needs a worktree and a base, and says so', async () => {
  await assert.rejects(fullWorktreeFingerprint(null, 'abc'), (e) => e.code === 'INVALID_ARGS');
  await assert.rejects(fullWorktreeFingerprint('/tmp', null), (e) => e.code === 'INVALID_ARGS');
});

test('the runner captures a fingerprint before the inference and with the review', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../run-goal.mjs', import.meta.url), 'utf8');

  assert.match(source, /worktree-fingerprint-before\.json/, 'before the agent runs');
  assert.match(source, /worktree-fingerprint-reviewed\.json/, 'and for the tree that was reviewed');
  assert.match(source, /worktreeFingerprint: reviewedFingerprint/, 'carried in the review packet');
  assert.match(source, /WORKTREE_FINGERPRINT_CAPTURED/, 'and recorded in the audit log');
});
