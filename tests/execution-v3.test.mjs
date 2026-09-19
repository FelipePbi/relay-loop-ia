/**
 * V3 real-execution guards: policy violations, review packet baselines and the
 * mandatory supervised stop. No model is called and no repository is touched —
 * git state is injected as fixtures.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VIOLATIONS,
  checkDeveloperPolicy,
  checkReviewerPolicy,
  formatViolations,
} from '../lib/policy-guards.mjs';
import { buildReviewPacket, renderReviewPrompt } from '../lib/review-packet.mjs';
import { LOOP_STATES, createLoopStateMachine, planAfterDecision, stateForDecision } from '../lib/loop-state.mjs';
import { buildArgs } from '../lib/claude-process.mjs';

const BASELINE = '1e874e2785d2bc78860db0eb571ea901a4395c17';
const EXEC_BASE = '575d75531b363a4952fe839f7b1bc32e61a35ae0';
const INITIAL_HEAD = EXEC_BASE;

const snapshot = (o = {}) => ({
  mainHead: EXEC_BASE,
  mainBranch: 'main',
  mainDirty: [],
  ...o,
});

const changes = (o = {}) => ({
  base: INITIAL_HEAD,
  head: INITIAL_HEAD,
  branch: 'ai-loop/goal-003',
  changedFiles: ['apps/bff/src/lib/auth.ts'],
  untracked: [],
  commits: [],
  diffStat: ' apps/bff/src/lib/auth.ts | 10 +++',
  diff: 'diff --git a/apps/bff/src/lib/auth.ts b/apps/bff/src/lib/auth.ts',
  diffTruncated: false,
  statusPorcelain: ' M apps/bff/src/lib/auth.ts',
  clean: false,
  ...o,
});

// --- Developer policy ------------------------------------------------------

test('a clean implementation inside the worktree produces no violations', () => {
  const violations = checkDeveloperPolicy({
    before: snapshot(),
    after: snapshot(),
    worktreeInitialHead: INITIAL_HEAD,
    changes: changes(),
  });
  assert.deepEqual(violations, []);
});

test('the Developer creating a commit is a violation', () => {
  const violations = checkDeveloperPolicy({
    before: snapshot(),
    after: snapshot(),
    worktreeInitialHead: INITIAL_HEAD,
    changes: changes({ commits: ['abc1234 wip'], head: 'abc1234'.padEnd(40, '0') }),
  });
  assert.ok(violations.some((v) => v.code === VIOLATIONS.DEVELOPER_COMMITTED));
});

test('the Developer moving the worktree HEAD is a violation', () => {
  const violations = checkDeveloperPolicy({
    before: snapshot(),
    after: snapshot(),
    worktreeInitialHead: INITIAL_HEAD,
    changes: changes({ head: 'f'.repeat(40) }),
  });
  assert.ok(violations.some((v) => v.code === VIOLATIONS.DEVELOPER_MOVED_HEAD));
});

test('the Developer touching the main checkout is a violation', () => {
  const movedHead = checkDeveloperPolicy({
    before: snapshot(),
    after: snapshot({ mainHead: 'a'.repeat(40) }),
    worktreeInitialHead: INITIAL_HEAD,
    changes: changes(),
  });
  assert.ok(movedHead.some((v) => v.code === VIOLATIONS.MAIN_CHECKOUT_MUTATED));

  const dirtied = checkDeveloperPolicy({
    before: snapshot(),
    after: snapshot({ mainDirty: ['apps/bff/src/index.ts'] }),
    worktreeInitialHead: INITIAL_HEAD,
    changes: changes(),
  });
  assert.ok(dirtied.some((v) => v.code === VIOLATIONS.MAIN_CHECKOUT_MUTATED));

  const branched = checkDeveloperPolicy({
    before: snapshot(),
    after: snapshot({ mainBranch: 'other' }),
    worktreeInitialHead: INITIAL_HEAD,
    changes: changes(),
  });
  assert.ok(branched.some((v) => v.code === VIOLATIONS.DEVELOPER_CHANGED_BRANCH));
});

test('preexisting main dirt is not blamed on the Developer', () => {
  const violations = checkDeveloperPolicy({
    before: snapshot({ mainDirty: ['already.txt'] }),
    after: snapshot({ mainDirty: ['already.txt'] }),
    worktreeInitialHead: INITIAL_HEAD,
    changes: changes(),
  });
  assert.deepEqual(violations, []);
});

test('the Developer rewriting migration control documents is a violation', () => {
  for (const file of [
    'docs/migration/goals/003-tenant-sessao-vinculo-whatsapp.md',
    'docs/migration/MIGRATION_STATUS.md',
    'docs/migration/reviews/003-review.md',
  ]) {
    const violations = checkDeveloperPolicy({
      before: snapshot(),
      after: snapshot(),
      worktreeInitialHead: INITIAL_HEAD,
      changes: changes({ changedFiles: [file] }),
    });
    assert.ok(violations.some((v) => v.code === VIOLATIONS.GOAL_DOC_MUTATED), file);
  }
});

// --- Reviewer policy -------------------------------------------------------

const wt = (o = {}) => ({ head: INITIAL_HEAD, status: ' M a.ts', treeHash: 'h1', ...o });

test('a read-only review produces no violations', () => {
  const violations = checkReviewerPolicy({
    before: { ...snapshot(), worktree: wt() },
    after: { ...snapshot(), worktree: wt() },
  });
  assert.deepEqual(violations, []);
});

test('the reviewer mutating the worktree invalidates the review', () => {
  const changedStatus = checkReviewerPolicy({
    before: { ...snapshot(), worktree: wt() },
    after: { ...snapshot(), worktree: wt({ status: ' M a.ts\n M b.ts' }) },
  });
  assert.ok(changedStatus.some((v) => v.code === VIOLATIONS.REVIEWER_MUTATED_WORKTREE));

  const changedHead = checkReviewerPolicy({
    before: { ...snapshot(), worktree: wt() },
    after: { ...snapshot(), worktree: wt({ head: 'b'.repeat(40) }) },
  });
  assert.ok(changedHead.some((v) => v.code === VIOLATIONS.REVIEWER_MUTATED_WORKTREE));
});

test('formatViolations renders code and detail', () => {
  const lines = formatViolations([{ code: 'X', detail: 'why' }]);
  assert.deepEqual(lines, ['[X] why']);
});

// --- Review packet ---------------------------------------------------------

test('the packet measures the diff against worktreeInitialHead, not the migration baseline', () => {
  const packet = buildReviewPacket({
    goal: '003',
    goalPath: 'docs/migration/goals/003-x.md',
    round: 1,
    reviewLevel: 'DEEP',
    migrationAcceptedBaseline: BASELINE,
    executionBase: EXEC_BASE,
    worktreeInitialHead: INITIAL_HEAD,
    worktreePath: '/repo/.ai-worktrees/goal-003',
    changes: changes(),
    developerResult: { implementationReport: 'rel', summary: 's', validations: [] },
    diffPath: '/state/implementation.patch',
  });

  assert.equal(packet.worktreeInitialHead, INITIAL_HEAD);
  assert.equal(packet.migrationAcceptedBaseline, BASELINE);
  assert.notEqual(packet.migrationAcceptedBaseline, packet.worktreeInitialHead);
  assert.equal(packet.changes, undefined, 'raw collection is not leaked wholesale');
  assert.deepEqual([...packet.changedFiles], ['apps/bff/src/lib/auth.ts']);

  const prompt = renderReviewPrompt(packet);
  assert.match(prompt, /worktreeInitialHead \(base desta implementação\)/);
  assert.match(prompt, /migrationAcceptedBaseline/);
  assert.match(prompt, /NÃO edite nenhum arquivo/);
});

test('the packet carries the change surface collected from git, not the model claim', () => {
  const collected = changes({ changedFiles: ['a.ts', 'b.ts'], untracked: ['b.ts'] });
  const packet = buildReviewPacket({
    goal: '003',
    goalPath: 'p.md',
    round: 1,
    reviewLevel: 'DEEP',
    migrationAcceptedBaseline: BASELINE,
    executionBase: EXEC_BASE,
    worktreeInitialHead: INITIAL_HEAD,
    worktreePath: '/w',
    changes: collected,
    // The model claims something different; the packet must ignore it.
    developerResult: { implementationReport: 'r', summary: 's', validations: [], changedFiles: ['lies.ts'] },
  });

  assert.deepEqual([...packet.changedFiles], ['a.ts', 'b.ts']);
  assert.ok(!packet.changedFiles.includes('lies.ts'));
});

test('a packet without a collected change set is refused', () => {
  assert.throws(
    () => buildReviewPacket({ goal: '003', worktreeInitialHead: INITIAL_HEAD }),
    (e) => e.code === 'INVALID_ARGS',
  );
});

// --- Supervised stop -------------------------------------------------------

function toVerdict() {
  const m = createLoopStateMachine();
  m.transitionTo(LOOP_STATES.GOAL_READY);
  m.transitionTo(LOOP_STATES.PREPARING_WORKTREE);
  m.transitionTo(LOOP_STATES.WORKTREE_READY);
  m.transitionTo(LOOP_STATES.DEVELOPER_QUEUED);
  m.transitionTo(LOOP_STATES.DEVELOPER_RUNNING);
  m.transitionTo(LOOP_STATES.REVIEW_REQUIRED);
  m.transitionTo(LOOP_STATES.REVIEWER_QUEUED);
  m.transitionTo(LOOP_STATES.REVIEWER_RUNNING);
  return m;
}

test('every decision stops at AWAITING_HUMAN and never re-queues the Developer', () => {
  for (const decision of ['ACCEPTED', 'CHANGES_REQUIRED', 'HUMAN_REQUIRED']) {
    const m = toVerdict();
    m.transitionTo(stateForDecision(decision));
    m.transitionTo(LOOP_STATES.AWAITING_HUMAN);

    assert.equal(m.state, LOOP_STATES.AWAITING_HUMAN, decision);
    assert.equal(m.canTransitionTo(LOOP_STATES.DEVELOPER_QUEUED), false, decision);
    assert.equal(m.canTransitionTo(LOOP_STATES.REVIEWER_QUEUED), false, decision);

    const plan = planAfterDecision(decision);
    assert.equal(plan.nextState, LOOP_STATES.AWAITING_HUMAN);
  }
});

test('AWAITING_HUMAN only leads to STOPPED', () => {
  const m = toVerdict();
  m.transitionTo(LOOP_STATES.ACCEPTED);
  m.transitionTo(LOOP_STATES.AWAITING_HUMAN);

  for (const state of Object.values(LOOP_STATES)) {
    if (state === LOOP_STATES.STOPPED) continue;
    assert.equal(m.canTransitionTo(state), false, `must not reach ${state}`);
  }
  assert.equal(m.canTransitionTo(LOOP_STATES.STOPPED), true);
});

// --- Execution profiles ----------------------------------------------------

test('the default profile still has no tools and cannot act', () => {
  const args = buildArgs({ prompt: 'p', model: 'm', sessionId: 's' });
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.ok(args.includes('--safe-mode'));
  assert.ok(!args.includes('--permission-mode'));
  assert.ok(!args.includes('--add-dir'));
});

test('the Developer profile scopes tools and directory, without bypassing permissions', () => {
  const args = buildArgs({
    prompt: 'p', model: 'claude-opus-5', sessionId: 's',
    tools: ['Read', 'Write', 'Edit', 'Bash'],
    permissionMode: 'auto',
    addDirs: ['/repo/.ai-worktrees/goal-003'],
    safeMode: false,
  });

  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Write,Edit,Bash');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'auto');
  assert.equal(args[args.indexOf('--add-dir') + 1], '/repo/.ai-worktrees/goal-003');
  assert.ok(!args.includes('--safe-mode'));
  // Never a bypass, and never a fallback model.
  for (const forbidden of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--fallback-model']) {
    assert.ok(!args.includes(forbidden), forbidden);
  }
  // Still cannot hang on a prompt.
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
});

test('the reviewer profile has no write tools', () => {
  const args = buildArgs({
    prompt: 'p', model: 'claude-fable-5-1', sessionId: 's',
    tools: ['Read', 'Glob', 'Grep', 'Bash'],
    permissionMode: 'auto',
    safeMode: false,
  });

  const toolList = args[args.indexOf('--tools') + 1];
  assert.ok(!toolList.includes('Write'));
  assert.ok(!toolList.includes('Edit'));
  assert.ok(toolList.includes('Read'));
});

// --- Prompt transport ------------------------------------------------------

test('the prompt never travels in argv', () => {
  // Regression: a real review packet (65 changed files, a ~30KB implementation
  // report) exceeded the ~32KB Windows command-line limit and the spawn failed
  // with ENAMETOOLONG. The prompt now goes over stdin.
  const bigPrompt = 'x'.repeat(40_000);
  const args = buildArgs({ prompt: bigPrompt, model: 'm', sessionId: 's' });

  assert.ok(!args.includes(bigPrompt), 'the prompt must not appear in argv');
  assert.ok(args.every((a) => a.length < 32_000), 'no argument may approach the command-line limit');

  // --print stays, but as a bare flag followed by the next option.
  assert.equal(args[args.indexOf('--print') + 1], '--model');
});
