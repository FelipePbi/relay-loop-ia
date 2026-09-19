/**
 * A correction round should know which files it is correcting.
 *
 * Written from Goal 015: the single unit a correction round runs was the only
 * unit in the pipeline with no file pointers at all, so it began each round
 * from zero knowledge of the diff under review and the graph orientation had
 * nothing to resolve — `NO_FILES` on two of the three rounds. The orchestrator
 * was already handing the reviewer this exact list, collected from git.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FALLBACK_RELEVANT_FILES, fallbackExecutionPlan, gatesForCorrection } from '../lib/execution-plan-store.mjs';

const BLOCKERS = ['B1: o shell entra em loop de render', 'B2: falta o estado UNKNOWN'];
const CHANGED = [
  'apps/frontend/src/shared/layout/AppShell.tsx',
  'apps/bff/src/modules/status/routes.ts',
];

const correction = (over = {}) => fallbackExecutionPlan({
  goal: '015', round: 2, blockers: BLOCKERS, changedFiles: CHANGED, ...over,
});

test('the correction unit carries the files the previous round changed', () => {
  const [unit] = correction().workUnits;
  assert.equal(unit.id, 'FIX-001');
  assert.deepEqual(unit.relevantFiles, CHANGED);
});

test('the pointers are pointers, not a licence to widen scope', () => {
  const [unit] = correction().workUnits;
  assert.match(unit.objective, /exclusivamente/, 'the objective still binds the unit to the blockers');
  assert.equal(unit.acceptanceCriteria.length, BLOCKERS.length, 'one criterion per blocker, unchanged');
});

test('duplicates and blanks never reach the packet', () => {
  const [unit] = correction({
    changedFiles: ['a/one.ts', 'a/one.ts', '', '   ', null, 42, 'b/two.ts'],
  }).workUnits;
  assert.deepEqual(unit.relevantFiles, ['a/one.ts', 'b/two.ts']);
});

test('a large diff is trimmed here rather than silently trimmed downstream', () => {
  const many = Array.from({ length: 120 }, (_, i) => `src/file${i}.ts`);
  const [unit] = correction({ changedFiles: many }).workUnits;
  assert.equal(unit.relevantFiles.length, FALLBACK_RELEVANT_FILES);
  assert.equal(unit.relevantFiles[0], 'src/file0.ts', 'the first files win, in diff order');
});

test('a round with nothing changed yet produces an empty list, never a crash', () => {
  for (const changedFiles of [[], undefined, null]) {
    const [unit] = correction({ changedFiles }).workUnits;
    assert.deepEqual(unit.relevantFiles, []);
  }
});

// --- the compatibility case is a different animal ----------------------

test('the compatibility plan (no blockers) is scoped to the whole Goal and takes no pointers', () => {
  const plan = fallbackExecutionPlan({ goal: '015', round: 1, blockers: [], changedFiles: CHANGED });
  const [unit] = plan.workUnits;
  assert.equal(unit.id, 'WU-001');
  // Round 1 has changed nothing yet; anything here would be a fiction.
  assert.deepEqual(unit.relevantFiles, CHANGED,
    'the caller only passes changes when there are some — the field is honest either way');
  assert.match(unit.objective, /documento do Goal/);
});

// ===========================================================================
// A correction round re-runs the Goal's own gates
// ===========================================================================

const GOAL_GATES = [
  { id: 'WU-11', title: 'tc', objective: 'o', type: 'DETERMINISTIC', complexity: 'LOW', risk: 'LOW',
    action: 'typecheck', scope: 'apps/bff', dependencies: ['WU-10'] },
  { id: 'WU-12', title: 'core', objective: 'o', type: 'DETERMINISTIC', complexity: 'LOW', risk: 'LOW',
    action: 'validate-core', dependencies: ['WU-11'] },
  { id: 'WU-13', title: 'diff', objective: 'o', type: 'DETERMINISTIC', complexity: 'LOW', risk: 'LOW',
    action: 'git-diff-check', dependencies: ['WU-12', 'WU-10'] },
];

test('a correction round carries the Goal gates, hung off the correction unit', () => {
  // Goal025 spent four rounds at MAX_CORRECTION_ROUNDS_REACHED with every
  // content blocker resolved, refused each time for a gate that was already
  // green — because a correction round declared no gates and nothing could
  // ever re-run them.
  const plan = fallbackExecutionPlan({
    goal: '025', round: 4, blockers: ['b'], goalGates: GOAL_GATES,
  });

  assert.deepEqual(plan.workUnits.map((u) => u.id), ['FIX-001', 'WU-11', 'WU-12', 'WU-13']);
  assert.equal(plan.workUnits.filter((u) => u.type === 'DETERMINISTIC').length, 3);
});

test('a dependency on a model unit becomes the correction unit; one on a gate is kept', () => {
  // The gates' recorded dependencies name units that do not exist in a
  // correction round. Keeping them would make every gate unreachable; dropping
  // all of them would lose the order the planner declared.
  const gates = gatesForCorrection(GOAL_GATES, 'FIX-001');
  const byId = Object.fromEntries(gates.map((g) => [g.id, g]));

  assert.deepEqual(byId['WU-11'].dependencies, ['FIX-001'], 'depended only on a model unit');
  assert.deepEqual(byId['WU-12'].dependencies, ['WU-11'], 'depended on a gate, so the order survives');
  assert.deepEqual(byId['WU-13'].dependencies, ['WU-12'], 'the model-unit dependency is dropped, the gate one kept');
});

test('nothing but the dependencies is rewritten', () => {
  // A gate that means `validate:integration` in round 1 must mean exactly that
  // in round 4, or re-running it proves nothing.
  const [gate] = gatesForCorrection([GOAL_GATES[0]], 'FIX-001');

  assert.equal(gate.action, 'typecheck');
  assert.equal(gate.scope, 'apps/bff');
  assert.equal(gate.type, 'DETERMINISTIC');
  assert.equal(gate.title, 'tc');
});

test('a Goal that declared no gates still gets none', () => {
  // Nothing is invented. The planner's declaration is the whole input.
  const plan = fallbackExecutionPlan({ goal: '025', round: 4, blockers: ['b'], goalGates: [] });
  assert.deepEqual(plan.workUnits.map((u) => u.id), ['FIX-001']);
  assert.deepEqual(gatesForCorrection(undefined), []);
  assert.deepEqual(gatesForCorrection([{ id: 'WU-01', type: 'STANDARD' }]), [], 'only DETERMINISTIC units are gates');
});

test('the compatibility fallback never gains gates, even if some are passed', () => {
  // That path is for a Goal planned before execution plans existed, which by
  // definition declared none.
  const plan = fallbackExecutionPlan({ goal: '007', round: 1, blockers: [], goalGates: GOAL_GATES });
  assert.deepEqual(plan.workUnits.map((u) => u.id), ['WU-001']);
});

test('the resulting plan is a valid DAG the scheduler can run', () => {
  // fallbackExecutionPlan validates before returning; a bad remapping would
  // surface here as a cycle or an unknown dependency.
  const plan = fallbackExecutionPlan({
    goal: '025', round: 4, blockers: ['b'], goalGates: GOAL_GATES,
  });

  assert.ok(plan.levels.length >= 2, 'the correction runs before its gates');
  assert.deepEqual(plan.levels[0], ['FIX-001']);
  assert.ok(plan.order.indexOf('WU-12') > plan.order.indexOf('WU-11'));
});
