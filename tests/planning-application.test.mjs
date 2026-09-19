/**
 * Applying a validated NEXT_GOAL_PLANNING result.
 *
 * The Goal010 incident, reproduced directly against the function itself: a
 * validated envelope carrying `developerProfile` and a 20-unit `executionPlan`
 * must have BOTH end up in their stores, no matter which of run-close.mjs's
 * three call sites reached it — a fresh planning job, a directed PLAN_INVALID
 * retry, or (the one that was actually broken) recovering an envelope that
 * had already completed. Before the fix, that third path re-derived
 * `nextGoalId` from a raw git diff instead of calling this function, so the
 * profile and the plan sitting right next to it on the SAME envelope were
 * silently dropped.
 *
 * No model is called anywhere here — `collectWorktreeChanges` and
 * `assertClosureScope` are injected fakes, exactly the pattern
 * `runDeterministicAction` uses for `spawnFn`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyPlanningResult } from '../lib/planning-application.mjs';
import { createJobStore } from '../lib/job-store.mjs';
import { createExecutionPlanStore } from '../lib/execution-plan-store.mjs';
import { createDeveloperProfileStore } from '../lib/developer-profiles.mjs';

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-planning-apply-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

const noopFakes = (changedFiles = ['docs/migration/goals/010-x.md']) => ({
  collectWorktreeChanges: async () => ({ changedFiles }),
  assertClosureScope: () => {},
});

const PLAN = Object.freeze({
  goalSummary: 'importação única',
  executionStrategy: 'tipos, serviço, integração, verificação',
  workUnits: [
    { id: 'WU-01', objective: 'a', type: 'COMPLEX', dependencies: [], acceptanceCriteria: ['x'] },
    { id: 'WU-02', objective: 'b', type: 'STANDARD', dependencies: ['WU-01'], acceptanceCriteria: ['y'] },
    {
      id: 'WU-03', objective: 'c', type: 'DETERMINISTIC', action: 'typecheck', scope: 'apps/bff',
      dependencies: ['WU-02'], acceptanceCriteria: [],
    },
  ],
});

function nextGoalEnvelope({ executionPlan = PLAN } = {}) {
  return {
    ok: true,
    result: {
      decision: 'NEXT_GOAL',
      nextGoalId: '010',
      nextGoalTitle: 'Importação única do Minha Agenda',
      nextGoalPath: 'docs/migration/goals/010-x.md',
      developerProfile: 'OPUS_HIGH',
      developerProfileReason: 'Corte de writer remoto, custo de erro alto.',
      executionPlan,
    },
  };
}

async function apply(dir, envelope, { changedFiles } = {}) {
  const store = createJobStore(dir);
  const planStore = createExecutionPlanStore(dir);
  const profileStore = createDeveloperProfileStore(dir);
  const persisted = [];
  const persistClosure = async (patch, state) => { persisted.push({ patch, state }); };

  await applyPlanningResult({
    envelope, goalId: '009', absPlan: '/irrelevant', planningDiffBase: 'b'.repeat(40),
    repoRoot: dir, emit: () => {}, machineState: 'NEXT_GOAL_PLANNING',
    persistClosure, profileStore, planStore, store,
    ...noopFakes(changedFiles),
  });

  return { store, planStore, profileStore, persisted };
}

test('a validated NEXT_GOAL envelope persists BOTH the developer profile and the execution plan', async () => {
  await withDir(async (dir) => {
    const { planStore, profileStore, persisted } = await apply(dir, nextGoalEnvelope());

    const profile = await profileStore.read('010');
    assert.equal(profile.profile, 'OPUS_HIGH');
    assert.equal(profile.reason, 'Corte de writer remoto, custo de erro alto.');
    assert.equal(profile.selectedBy, 'tech_lead');

    const plan = await planStore.readRaw('010');
    assert.equal(plan.workUnitCount, 3);
    assert.deepEqual(plan.types, { COMPLEX: 1, STANDARD: 1, DETERMINISTIC: 1 });

    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].patch.nextGoalId, '010');
    assert.equal(persisted[0].patch.nextGoalDeveloperProfile, 'OPUS_HIGH');
  });
});

test('the events an operator would audit are both there: profile selected, plan recorded', async () => {
  await withDir(async (dir) => {
    const { store } = await apply(dir, nextGoalEnvelope());
    const events = await store.readEvents();

    const profileEvent = events.find((e) => e.type === 'DEVELOPER_PROFILE_SELECTED');
    assert.ok(profileEvent, 'DEVELOPER_PROFILE_SELECTED must be recorded');
    assert.equal(profileEvent.profile, 'OPUS_HIGH');
    assert.equal(profileEvent.model, 'claude-opus-5');

    const planEvent = events.find((e) => e.type === 'EXECUTION_PLAN_RECORDED');
    assert.ok(planEvent, 'EXECUTION_PLAN_RECORDED must be recorded');
    assert.equal(planEvent.units, 3);
  });
});

test('this is EXACTLY the Goal010 regression: recovering an already-completed envelope must not skip the plan', async () => {
  // The bug's own shape: `priorEnvelope.ok === true`, read back from disk —
  // not a freshly-awaited one. If the caller ever again re-derives nextGoalId
  // from a git diff instead of handing this same envelope to this function,
  // this test starts failing because nothing ever calls applyPlanningResult.
  await withDir(async (dir) => {
    const priorEnvelope = nextGoalEnvelope();
    const { planStore, profileStore } = await apply(dir, priorEnvelope);

    assert.ok(await planStore.read('010'), 'the execution plan must exist — this is what silently never happened');
    assert.ok(await profileStore.read('010'), 'the developer profile must exist — this is what silently never happened');
  });
});

test('no executionPlan on the envelope is legitimate: recorded as absent, nothing written to planStore', async () => {
  await withDir(async (dir) => {
    const { planStore, store } = await apply(dir, nextGoalEnvelope({ executionPlan: null }));

    assert.equal(await planStore.read('010'), null);
    const events = await store.readEvents();
    assert.ok(events.find((e) => e.type === 'EXECUTION_PLAN_ABSENT'));
    assert.ok(!events.find((e) => e.type === 'EXECUTION_PLAN_RECORDED'));
  });
});

test('HUMAN_REQUIRED throws and persists nothing', async () => {
  await withDir(async (dir) => {
    const store = createJobStore(dir);
    const planStore = createExecutionPlanStore(dir);
    const profileStore = createDeveloperProfileStore(dir);
    let persistClosureCalled = false;

    await assert.rejects(
      applyPlanningResult({
        envelope: { ok: true, result: { decision: 'HUMAN_REQUIRED', reason: 'produto precisa decidir' } },
        goalId: '009', absPlan: '/irrelevant', planningDiffBase: 'b'.repeat(40), repoRoot: dir,
        machineState: 'NEXT_GOAL_PLANNING',
        persistClosure: async () => { persistClosureCalled = true; },
        profileStore, planStore, store, ...noopFakes(),
      }),
      (error) => error.code === 'PRODUCT_DECISION',
    );

    assert.equal(persistClosureCalled, false);
    assert.equal(await planStore.read('010'), null);
  });
});

// ===========================================================================
// The diff base — which commit the planner is judged against
// ===========================================================================

test('the planning diff is taken against the base it was GIVEN, not against any baseline', async () => {
  // Goal022 stopped as TECH_LEAD_CLOSURE_SCOPE_VIOLATION naming three
  // `tools/ia-loop/` files the Tech Lead never touched. They were harness
  // commits that landed on main between the accepted baseline and the commit
  // the planning worktree was branched from — and this function was still
  // diffing against the baseline, so it attributed them to the planner.
  //
  // `run-close` had already been fixed to pass the branch point; this call
  // site kept its own copy of the old behaviour behind a parameter named
  // `newBaseline`. The name is why it was missed, which is why it is now
  // named after what it is.
  const seen = [];
  const collectWorktreeChanges = async (absPlan, baseSha) => {
    seen.push({ absPlan, baseSha });
    return { changedFiles: ['docs/migration/MASTER_PLAN.md'] };
  };

  await applyPlanningResult({
    envelope: {
      ok: true,
      result: {
        decision: 'NEXT_GOAL', nextGoalId: '023', nextGoalTitle: 'x',
        nextGoalPath: 'docs/migration/goals/023-x.md',
        developerProfile: 'SONNET_HIGH', developerProfileReason: null,
      },
    },
    goalId: '022',
    absPlan: '/plan',
    planningDiffBase: 'f'.repeat(40),
    repoRoot: '/repo',
    emit: () => {},
    machineState: 'NEXT_GOAL_PLANNING',
    persistClosure: async () => {},
    profileStore: { write: async () => {} },
    planStore: { write: async () => ({ workUnitCount: 0, types: {}, fragmentation: null }) },
    store: { appendEvent: async () => {} },
    collectWorktreeChanges,
    assertClosureScope: () => true,
  });

  assert.equal(seen.length, 1, 'exactly one diff, so there is one answer to disagree with');
  assert.equal(seen[0].baseSha, 'f'.repeat(40), 'the branch point, whatever the accepted baseline happens to be');
  assert.equal(seen[0].absPlan, '/plan');
});
