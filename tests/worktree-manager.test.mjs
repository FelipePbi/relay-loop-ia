/**
 * Worktree planning tests. Git is injected as a read-only probe, so no
 * repository is touched and nothing is ever created.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  branchNameFor,
  createWorktreeForGoal,
  planWorktree,
  worktreePathFor,
} from '../lib/worktree-manager.mjs';

const codeIs = (code) => (error) => error.code === code;
const BASE = '0e77cb6cddc1da015e188cf7cdb55a5ff3b2ce60';

function gitProbe(overrides = {}) {
  return {
    currentBranch: async () => 'main',
    isDirty: async () => false,
    branchExists: async () => false,
    worktrees: async () => [],
    pathExists: async () => false,
    ...overrides,
  };
}

test('a clean repository yields a safe plan with the agreed conventions', async () => {
  const plan = await planWorktree({ goalId: '003', executionBase: BASE, git: gitProbe() });

  assert.equal(plan.path, '.ai-worktrees/goal-003');
  assert.equal(plan.branch, 'ai-loop/goal-003');
  assert.equal(plan.executionBase, BASE);
  assert.equal(plan.currentBranch, 'main');
  assert.equal(plan.safe, true);
  assert.deepEqual([...plan.blockers], []);
});

test('the planned command never forces, resets or deletes', async () => {
  const plan = await planWorktree({ goalId: '003', executionBase: BASE, git: gitProbe() });

  assert.equal(plan.plannedCommand, `git worktree add -b ai-loop/goal-003 .ai-worktrees/goal-003 ${BASE}`);
  for (const dangerous of ['--force', '-f ', 'reset', 'delete', 'remove', 'prune', 'checkout main']) {
    assert.ok(!plan.plannedCommand.includes(dangerous), `plan must not contain "${dangerous}"`);
  }
});

test('an existing branch is a blocker, not something to overwrite', async () => {
  const plan = await planWorktree({
    goalId: '003',
    executionBase: BASE,
    git: gitProbe({ branchExists: async () => true }),
  });

  assert.equal(plan.safe, false);
  assert.ok(plan.blockers.some((b) => b.code === 'BRANCH_ALREADY_EXISTS'));
});

test('a dirty main checkout is a blocker', async () => {
  const plan = await planWorktree({
    goalId: '003',
    executionBase: BASE,
    git: gitProbe({ isDirty: async () => true }),
  });

  assert.equal(plan.safe, false);
  assert.ok(plan.blockers.some((b) => b.code === 'MAIN_CHECKOUT_DIRTY'));
});

test('an already registered worktree is a blocker', async () => {
  const plan = await planWorktree({
    goalId: '003',
    executionBase: BASE,
    git: gitProbe({
      worktrees: async () => [{ path: 'E:/repo/.ai-worktrees/goal-003', branch: 'refs/heads/ai-loop/goal-003' }],
    }),
  });

  assert.equal(plan.safe, false);
  assert.ok(plan.blockers.some((b) => b.code === 'WORKTREE_ALREADY_REGISTERED'));
});

test('an unknown directory occupying the path is a blocker, never removed', async () => {
  const plan = await planWorktree({
    goalId: '003',
    executionBase: BASE,
    git: gitProbe({ pathExists: async () => true }),
  });

  assert.equal(plan.safe, false);
  assert.ok(plan.blockers.some((b) => b.code === 'PATH_OCCUPIED_BY_UNKNOWN'));
});

test('several ambiguities accumulate instead of short-circuiting', async () => {
  const plan = await planWorktree({
    goalId: '003',
    executionBase: BASE,
    git: gitProbe({ isDirty: async () => true, branchExists: async () => true, pathExists: async () => true }),
  });

  assert.equal(plan.safe, false);
  assert.equal(plan.blockers.length, 3);
});

test('a malformed goal id is refused', async () => {
  await assert.rejects(
    planWorktree({ goalId: '3', executionBase: BASE, git: gitProbe() }),
    codeIs('INVALID_GOAL_ID'),
  );
});

test('creating a worktree requires a plan with no blockers', async () => {
  let called = false;
  const createFn = async () => { called = true; return { path: 'p', branch: 'b', head: BASE }; };

  await assert.rejects(
    createWorktreeForGoal({
      goalId: '003',
      executionBase: BASE,
      git: gitProbe({ branchExists: async () => true }),
      repoRoot: '/repo',
      createFn,
    }),
    codeIs('WORKTREE_PLAN_UNSAFE'),
  );
  assert.equal(called, false, 'nothing may be created while the plan is unsafe');
});

test('a safe plan creates the worktree at the execution base', async () => {
  const calls = [];
  const created = await createWorktreeForGoal({
    goalId: '003',
    executionBase: BASE,
    git: gitProbe(),
    repoRoot: '/repo',
    createFn: async (args) => {
      calls.push(args);
      return { path: '/repo/.ai-worktrees/goal-003', branch: 'ai-loop/goal-003', head: BASE };
    },
  });

  assert.equal(created.created, true);
  // worktreeInitialHead equals executionBase by definition at creation time.
  assert.equal(created.worktreeInitialHead, BASE);
  assert.equal(created.branch, 'ai-loop/goal-003');
  assert.deepEqual(calls, [{
    repoRoot: '/repo',
    path: '.ai-worktrees/goal-003',
    branch: 'ai-loop/goal-003',
    base: BASE,
  }]);
});

test('a worktree that did not start at the execution base is refused', async () => {
  await assert.rejects(
    createWorktreeForGoal({
      goalId: '003',
      executionBase: BASE,
      git: gitProbe(),
      repoRoot: '/repo',
      createFn: async () => ({ path: 'p', branch: 'ai-loop/goal-003', head: 'deadbeef'.repeat(5) }),
    }),
    codeIs('WORKTREE_HEAD_MISMATCH'),
  );
});

test('a dirty main checkout blocks creation', async () => {
  await assert.rejects(
    createWorktreeForGoal({
      goalId: '003',
      executionBase: BASE,
      git: gitProbe({ isDirty: async () => true }),
      repoRoot: '/repo',
      createFn: async () => { throw new Error('must not be called'); },
    }),
    codeIs('WORKTREE_PLAN_UNSAFE'),
  );
});

test('an existing path blocks creation', async () => {
  await assert.rejects(
    createWorktreeForGoal({
      goalId: '003',
      executionBase: BASE,
      git: gitProbe({ pathExists: async () => true }),
      repoRoot: '/repo',
      createFn: async () => { throw new Error('must not be called'); },
    }),
    codeIs('WORKTREE_PLAN_UNSAFE'),
  );
});

test('naming conventions are stable', () => {
  assert.equal(worktreePathFor('003'), '.ai-worktrees/goal-003');
  assert.equal(branchNameFor('003'), 'ai-loop/goal-003');
});
