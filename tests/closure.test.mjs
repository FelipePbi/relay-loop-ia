/**
 * V5 closure: state registry integrity, failure taxonomy, accepted snapshot and
 * the closure/planning contracts. No model is called; git integration is
 * exercised against throwaway repositories.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ALLOWED_TRANSITIONS,
  EXECUTION_STATES,
  LOOP_STATES,
  RESUMABLE_STATES,
  STATE_REGISTRY,
  isResumable,
} from '../lib/state-registry.mjs';
import { createLoopStateMachine } from '../lib/loop-state.mjs';
import { FAILURE_FAMILIES, eventTypeFor, familyFor, producesCapacityEvent } from '../lib/failure-taxonomy.mjs';
import { CAPACITY_REASONS } from '../lib/capacity-classifier.mjs';
import {
  assertSnapshotUnchanged,
  backfillFromReviewPacket,
  buildAcceptedSnapshot,
  diffSnapshots,
} from '../lib/accepted-snapshot.mjs';
import {
  assertClosureScope,
  validateClosureDocResult,
  validatePlanningResult,
  closureDocSchemaFor,
  planningSchemaFor,
} from '../lib/closure-contracts.mjs';
import { PROTOCOL_VERSION_V2 } from '../lib/contracts-v2.mjs';
import { git, stageAndCommit, cherryPick, isAlreadyIntegrated } from '../lib/git-ops.mjs';

const codeIs = (code) => (error) => error.code === code;
const INITIAL_HEAD = '99a7210101f481b994a008a57c4f663bc3d5c566';

// ===========================================================================
// State registry — single source of truth
// ===========================================================================

test('every state referenced in the graph exists in the registry', () => {
  for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
    assert.ok(Object.hasOwn(STATE_REGISTRY, from), `${from} must be registered`);
    for (const to of targets) {
      assert.ok(Object.hasOwn(STATE_REGISTRY, to), `${from} -> ${to}: ${to} must be registered`);
    }
  }
});

test('the resumable set is derived, not hand-maintained', () => {
  const derived = Object.entries(STATE_REGISTRY)
    .filter(([, def]) => def.resumable === true)
    .map(([name]) => name)
    .sort();
  assert.deepEqual([...RESUMABLE_STATES].sort(), derived);

  // The bug this prevents: a state in the graph but unknown to capacity resume.
  assert.equal(isResumable(LOOP_STATES.CORRECTION_RUNNING), true);
  assert.equal(isResumable(LOOP_STATES.CORRECTION_QUEUED), true);
});

test('capacity-state consumes the derived set instead of declaring its own', async () => {
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync('lib/capacity-state.mjs', 'utf8'));

  // A second literal list of resumable states is exactly the defect being fixed.
  assert.ok(!/const RESUMABLE_STATES\s*=\s*Object\.freeze\(\[/.test(source),
    'capacity-state must not declare its own resumable list');
  assert.match(source, /RESUMABLE_STATES/, 'it should import the derived one');
});

test('WAITING_FOR_CAPACITY can return to every resumable state', () => {
  const targets = ALLOWED_TRANSITIONS[LOOP_STATES.WAITING_FOR_CAPACITY];
  for (const state of RESUMABLE_STATES) {
    assert.ok(targets.includes(state), `must be able to resume into ${state}`);
  }
});

test('the closure states form a coherent path', () => {
  const m = createLoopStateMachine({ initialState: LOOP_STATES.ACCEPTED });
  for (const next of [
    LOOP_STATES.CLOSURE_PREPARING, LOOP_STATES.CLOSURE_DOCUMENTING, LOOP_STATES.CLOSURE_READY,
    LOOP_STATES.GOAL_COMMITTING, LOOP_STATES.GOAL_COMMITTED, LOOP_STATES.INTEGRATING_ACCEPTED,
    LOOP_STATES.BASELINE_ACCEPTED, LOOP_STATES.NEXT_GOAL_PLANNING, LOOP_STATES.NEXT_GOAL_READY,
    LOOP_STATES.AWAITING_HUMAN,
  ]) {
    m.transitionTo(next);
  }
  assert.equal(m.state, LOOP_STATES.AWAITING_HUMAN);
});

test('the long-running closure states are resumable and marked as execution', () => {
  for (const state of [LOOP_STATES.CLOSURE_DOCUMENTING, LOOP_STATES.NEXT_GOAL_PLANNING]) {
    assert.ok(RESUMABLE_STATES.includes(state), `${state} must be resumable`);
    assert.ok(EXECUTION_STATES.includes(state), `${state} is agent work`);
  }
});

// ===========================================================================
// Failure taxonomy
// ===========================================================================

test('only genuine model limits produce a capacity event', () => {
  for (const reason of [CAPACITY_REASONS.RATE_LIMIT, CAPACITY_REASONS.USAGE_LIMIT]) {
    assert.equal(familyFor({ reason }), FAILURE_FAMILIES.MODEL_CAPACITY, reason);
    assert.equal(producesCapacityEvent({ reason }), true, reason);
    assert.equal(eventTypeFor({ reason }), 'CAPACITY_LIMIT_REACHED');
  }
});

test('harness failures never produce a capacity event', () => {
  for (const code of ['SPAWN_FAILED', 'EXECUTABLE_NOT_FOUND', 'INVALID_TRANSITION', 'CAPACITY_STATE_CORRUPT']) {
    assert.equal(familyFor({ code }), FAILURE_FAMILIES.HARNESS, code);
    assert.equal(producesCapacityEvent({ code }), false, code);
    assert.equal(eventTypeFor({ code }), 'HARNESS_ERROR');
  }
  assert.equal(producesCapacityEvent({ reason: CAPACITY_REASONS.HARNESS_ERROR }), false);
});

test('agent contract errors never produce a capacity event', () => {
  // These are exactly the episodes that were logged as CAPACITY_LIMIT_REACHED.
  for (const code of ['UNSUPPORTED_PROTOCOL_VERSION', 'JOB_ID_MISMATCH', 'ROUND_MISMATCH', 'INVALID_AGENT_JSON']) {
    assert.equal(familyFor({ code }), FAILURE_FAMILIES.AGENT_CONTRACT, code);
    assert.equal(producesCapacityEvent({ code }), false, code);
    assert.equal(eventTypeFor({ code }), 'AGENT_CONTRACT_ERROR');
  }
});

test('a state machine error is never reported as a quota problem', () => {
  assert.equal(producesCapacityEvent({ code: 'INVALID_TRANSITION' }), false);
  assert.notEqual(eventTypeFor({ code: 'INVALID_TRANSITION' }), 'CAPACITY_LIMIT_REACHED');
});

// ===========================================================================
// Accepted snapshot
// ===========================================================================

const changes = (o = {}) => ({
  base: INITIAL_HEAD,
  head: INITIAL_HEAD,
  branch: 'ai-loop/goal-003',
  changedFiles: ['a.ts', 'b.ts'],
  untracked: ['b.ts'],
  commits: [],
  diff: 'diff --git a/a.ts b/a.ts\n+one',
  diffStat: '',
  ...o,
});

test('an unchanged worktree passes the closure gate', () => {
  const accepted = buildAcceptedSnapshot({ changes: changes(), round: 2 });
  const current = buildAcceptedSnapshot({ changes: changes(), round: 2 });
  assert.deepEqual(diffSnapshots(accepted, current), []);
  assert.equal(assertSnapshotUnchanged(accepted, current), true);
});

test('a file changed after the acceptance blocks the closure', () => {
  const accepted = buildAcceptedSnapshot({ changes: changes(), round: 2 });
  const current = buildAcceptedSnapshot({ changes: changes({ diff: 'diff --git a/a.ts b/a.ts\n+two' }), round: 2 });

  assert.throws(() => assertSnapshotUnchanged(accepted, current), codeIs('ACCEPTED_WORKTREE_CHANGED'));
});

test('an untracked file added after the acceptance is detected', () => {
  const accepted = buildAcceptedSnapshot({ changes: changes(), round: 2 });
  const current = buildAcceptedSnapshot({
    changes: changes({ changedFiles: ['a.ts', 'b.ts', 'sneaky.ts'], untracked: ['b.ts', 'sneaky.ts'] }),
    round: 2,
  });

  const differences = diffSnapshots(accepted, current);
  assert.ok(differences.some((d) => d.includes('file set changed')));
  assert.throws(() => assertSnapshotUnchanged(accepted, current), codeIs('ACCEPTED_WORKTREE_CHANGED'));
});

test('a diverging initialHead blocks the closure', () => {
  const accepted = buildAcceptedSnapshot({ changes: changes(), round: 2 });
  const current = buildAcceptedSnapshot({ changes: changes({ base: 'f'.repeat(40) }), round: 2 });
  assert.throws(() => assertSnapshotUnchanged(accepted, current), codeIs('ACCEPTED_WORKTREE_CHANGED'));
});

test('a commit appearing in the worktree is detected', () => {
  const accepted = buildAcceptedSnapshot({ changes: changes(), round: 2 });
  const current = buildAcceptedSnapshot({ changes: changes({ commits: ['abc wip'] }), round: 2 });
  assert.throws(() => assertSnapshotUnchanged(accepted, current), codeIs('ACCEPTED_WORKTREE_CHANGED'));
});

test('the fingerprint is content-based, not time-based', () => {
  const a = buildAcceptedSnapshot({ changes: changes(), round: 2 });
  const b = buildAcceptedSnapshot({ changes: changes(), round: 2 });
  // Captured at different instants, identical content.
  assert.equal(a.diffHash, b.diffHash);
  assert.equal(a.filesHash, b.filesHash);
  assert.deepEqual(diffSnapshots(a, b), []);
});

test('backfill succeeds when the review packet still matches the worktree', () => {
  const current = changes();
  const packet = { changedFiles: ['a.ts', 'b.ts'], worktreeInitialHead: INITIAL_HEAD };
  const snapshot = backfillFromReviewPacket({ packet, currentChanges: current, savedDiff: current.diff, round: 2 });

  assert.equal(snapshot.backfilled, true);
  assert.equal(snapshot.fileCount, 2);
});

test('backfill refuses when the worktree drifted from the reviewed packet', () => {
  const current = changes({ diff: 'something else' });
  const packet = { changedFiles: ['a.ts', 'b.ts'], worktreeInitialHead: INITIAL_HEAD };

  assert.throws(
    () => backfillFromReviewPacket({ packet, currentChanges: current, savedDiff: 'diff --git a/a.ts b/a.ts\n+one', round: 2 }),
    codeIs('SNAPSHOT_BACKFILL_UNSUPPORTED'),
  );
});

// ===========================================================================
// Closure contracts
// ===========================================================================

test('closure scope is limited to docs/migration', () => {
  assert.equal(assertClosureScope(['docs/migration/CURRENT_STATE.md']), true);
  assert.throws(() => assertClosureScope(['apps/bff/src/index.ts']), codeIs('TECH_LEAD_CLOSURE_SCOPE_VIOLATION'));
  assert.throws(() => assertClosureScope(['tools/ia-loop/lib/x.mjs']), codeIs('TECH_LEAD_CLOSURE_SCOPE_VIOLATION'));
});

test('a closure doc result claiming a file outside the scope is refused', () => {
  const base = { protocolVersion: PROTOCOL_VERSION_V2, jobId: 'j', goal: '003', summary: 's' };
  assert.throws(
    () => validateClosureDocResult({ ...base, documentsUpdated: ['apps/x.ts'] }, { jobId: 'j', goal: '003' }),
    codeIs('CLOSURE_SCOPE_VIOLATION'),
  );
  const ok = validateClosureDocResult(
    { ...base, documentsUpdated: ['docs/migration/CURRENT_STATE.md'] }, { jobId: 'j', goal: '003' },
  );
  assert.equal(ok.documentsUpdated.length, 1);
});

test('planning must name exactly one next Goal, different from the closed one', () => {
  const base = {
    protocolVersion: PROTOCOL_VERSION_V2, jobId: 'j', goal: '003',
    nextGoalTitle: 'Transporte durável', nextGoalPath: 'docs/migration/goals/004-x.md',
    summary: 's', documentsUpdated: ['docs/migration/MIGRATION_STATUS.md'],
  };

  const ok = validatePlanningResult({ ...base, nextGoalId: '004' }, { jobId: 'j', goal: '003' });
  assert.equal(ok.nextGoalId, '004');

  assert.throws(() => validatePlanningResult({ ...base, nextGoalId: '003' }, { jobId: 'j', goal: '003' }),
    codeIs('CONTRACT_FIELD_INVALID'));
  assert.throws(() => validatePlanningResult({ ...base, nextGoalId: '4' }, { jobId: 'j', goal: '003' }),
    codeIs('CONTRACT_FIELD_INVALID'));
});

test('closure and planning schemas pin the identity fields', () => {
  for (const schema of [closureDocSchemaFor({ jobId: 'j', goal: '003' }), planningSchemaFor({ jobId: 'j', goal: '003' })]) {
    assert.deepEqual(schema.properties.jobId.enum, ['j']);
    assert.deepEqual(schema.properties.goal.enum, ['003']);
    assert.deepEqual(schema.properties.protocolVersion.enum, [PROTOCOL_VERSION_V2]);
  }
});

// ===========================================================================
// Integration against throwaway repositories
// ===========================================================================

async function withRepo(run) {
  const root = await mkdtemp(join(tmpdir(), 'ia-loop-git-'));
  const cwd = root;
  await git(['init', '-q', '-b', 'main'], { cwd });
  await git(['config', 'user.email', 't@t'], { cwd });
  await git(['config', 'user.name', 'test'], { cwd });
  await writeFile(join(cwd, 'base.txt'), 'base\n', 'utf8');
  await git(['add', '-A'], { cwd });
  await git(['commit', '-qm', 'init'], { cwd });
  try { return await run(cwd); } finally { await rm(root, { recursive: true, force: true }); }
}

test('a clean cherry-pick integrates and yields a different SHA', async () => {
  await withRepo(async (cwd) => {
    const base = await git(['rev-parse', 'HEAD'], { cwd });

    await git(['checkout', '-q', '-b', 'topic'], { cwd });
    await writeFile(join(cwd, 'feature.txt'), 'feature\n', 'utf8');
    const { sha: sourceSha } = await stageAndCommit({ cwd, paths: ['feature.txt'], message: 'feat: thing' });

    // main advances independently, exactly like the tooling did.
    await git(['checkout', '-q', 'main'], { cwd });
    await writeFile(join(cwd, 'tooling.txt'), 'tooling\n', 'utf8');
    await stageAndCommit({ cwd, paths: ['tooling.txt'], message: 'chore: tooling' });

    const { after } = await cherryPick({ repoRoot: cwd, sha: sourceSha });

    assert.notEqual(after, sourceSha, 'the integrated commit is a new SHA');
    assert.notEqual(after, base);
    // Both the feature and the later tooling are present.
    const files = await git(['ls-tree', '--name-only', 'HEAD'], { cwd });
    assert.ok(files.includes('feature.txt'));
    assert.ok(files.includes('tooling.txt'));
  });
});

test('a conflicting cherry-pick is aborted, never resolved automatically', async () => {
  await withRepo(async (cwd) => {
    await git(['checkout', '-q', '-b', 'topic'], { cwd });
    await writeFile(join(cwd, 'base.txt'), 'topic version\n', 'utf8');
    const { sha } = await stageAndCommit({ cwd, paths: ['base.txt'], message: 'topic edit' });

    await git(['checkout', '-q', 'main'], { cwd });
    await writeFile(join(cwd, 'base.txt'), 'main version\n', 'utf8');
    await stageAndCommit({ cwd, paths: ['base.txt'], message: 'main edit' });
    const before = await git(['rev-parse', 'HEAD'], { cwd });

    await assert.rejects(cherryPick({ repoRoot: cwd, sha }), codeIs('CHERRY_PICK_CONFLICT'));

    // Aborted cleanly: HEAD untouched and no half-finished state left behind.
    assert.equal(await git(['rev-parse', 'HEAD'], { cwd }), before);
    assert.equal(await git(['status', '--porcelain'], { cwd }), '');
  });
});

test('an already integrated commit is detectable, so closure does not repeat it', async () => {
  await withRepo(async (cwd) => {
    await git(['checkout', '-q', '-b', 'topic'], { cwd });
    await writeFile(join(cwd, 'f.txt'), 'x\n', 'utf8');
    const { sha } = await stageAndCommit({ cwd, paths: ['f.txt'], message: 'feat: f' });
    await git(['checkout', '-q', 'main'], { cwd });

    assert.equal(await isAlreadyIntegrated({ repoRoot: cwd, sha }), false);
    await cherryPick({ repoRoot: cwd, sha });
    assert.equal(await isAlreadyIntegrated({ repoRoot: cwd, sha }), true);
  });
});

test('staging is explicit and refuses an empty commit', async () => {
  await withRepo(async (cwd) => {
    await assert.rejects(
      stageAndCommit({ cwd, paths: ['base.txt'], message: 'nothing changed' }),
      codeIs('NOTHING_TO_COMMIT'),
    );
  });
});

test('excluded paths never enter the closure commit', async () => {
  await withRepo(async (cwd) => {
    await mkdir(join(cwd, 'graphify-out'), { recursive: true });
    await writeFile(join(cwd, 'graphify-out', 'graph.json'), '{}', 'utf8');
    await writeFile(join(cwd, 'impl.txt'), 'impl\n', 'utf8');

    const { stagedFiles } = await stageAndCommit({
      cwd,
      paths: ['impl.txt', 'graphify-out/graph.json'],
      message: 'feat: impl',
      excludePaths: ['graphify-out'],
    });

    assert.deepEqual(stagedFiles, ['impl.txt']);
  });
});

test('a path reported by the model is normalised, not treated as a breach', async () => {
  // Regression: the reviewer answered with an absolute worktree path and the
  // validator called it a scope violation, failing a correct planning run.
  const { normalizeReportedPath } = await import('../lib/closure-contracts.mjs');

  for (const reported of [
    'docs/migration/goals/004-x.md',
    './docs/migration/goals/004-x.md',
    'E:/repo/.ai-worktrees/plan-next-goal/docs/migration/goals/004-x.md',
    ['E:', 'repo', '.ai-worktrees', 'plan-next-goal', 'docs', 'migration', 'goals', '004-x.md'].join(String.fromCharCode(92)),
  ]) {
    assert.equal(normalizeReportedPath(reported), 'docs/migration/goals/004-x.md', reported);
  }

  const ok = validatePlanningResult({
    protocolVersion: PROTOCOL_VERSION_V2, jobId: 'j', goal: '003', nextGoalId: '004',
    nextGoalTitle: 'T', nextGoalPath: 'E:/repo/.ai-worktrees/plan/docs/migration/goals/004-x.md',
    summary: 's', documentsUpdated: ['./docs/migration/MIGRATION_STATUS.md'],
  }, { jobId: 'j', goal: '003' });

  assert.equal(ok.nextGoalPath, 'docs/migration/goals/004-x.md');
  assert.deepEqual([...ok.documentsUpdated], ['docs/migration/MIGRATION_STATUS.md']);
});

test('a genuine out-of-scope path is still refused after normalisation', () => {
  assert.throws(() => validatePlanningResult({
    protocolVersion: PROTOCOL_VERSION_V2, jobId: 'j', goal: '003', nextGoalId: '004',
    nextGoalTitle: 'T', nextGoalPath: 'apps/bff/src/goal.md',
    summary: 's', documentsUpdated: [],
  }, { jobId: 'j', goal: '003' }), codeIs('CLOSURE_SCOPE_VIOLATION'));

  // And the git-evidence guard stays strict regardless of formatting.
  assert.throws(() => assertClosureScope(['apps/bff/src/index.ts']), codeIs('TECH_LEAD_CLOSURE_SCOPE_VIOLATION'));
});
