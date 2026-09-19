/**
 * Work Units and the execution DAG — the plan, as a pure function.
 *
 * What this file states: a plan that could execute unsafely is refused BEFORE
 * anything is dispatched. A cycle discovered by a worker is a worker that
 * never finishes, so the cycle has to be found here.
 *
 * Nothing here touches disk, spawns a process or calls a model.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FRAGMENTATION_LIMITS,
  WORK_UNIT_TYPES,
  describeFragmentation,
  executionLevels,
  findUnit,
  normalizeWorkUnits,
  topologicalOrder,
  validateExecutionPlan,
  validateWorkUnit,
} from '../lib/work-units.mjs';
import {
  ACTION_CWD,
  DETERMINISTIC_ACTION_NAMES,
  assertDeterministicAction,
} from '../lib/deterministic-actions.mjs';

const unit = (over = {}) => ({
  id: 'WU-001',
  objective: 'Implementar o NotificationService',
  type: 'STANDARD',
  dependencies: [],
  acceptanceCriteria: ['O serviço envia a notificação e registra a entrega.'],
  ...over,
});

const plan = (units, over = {}) => ({ goal: '008', workUnits: units, ...over });

// ===========================================================================
// A valid unit
// ===========================================================================

test('a valid Work Unit keeps everything the plan declared', () => {
  const validated = validateWorkUnit(unit({
    complexity: 'MEDIUM',
    risk: 'LOW',
    expectedFiles: ['src/notifications/service.ts'],
    relevantFiles: ['src/notifications/types.ts'],
    verification: ['typecheck'],
    implementationHints: 'siga o padrão de OrderService',
  }));

  assert.equal(validated.id, 'WU-001');
  assert.equal(validated.type, 'STANDARD');
  assert.equal(validated.complexity, 'MEDIUM');
  assert.equal(validated.risk, 'LOW');
  assert.deepEqual([...validated.expectedFiles], ['src/notifications/service.ts']);
  assert.deepEqual([...validated.verification], ['typecheck']);
  assert.equal(validated.implementationHints, 'siga o padrão de OrderService');
});

test('complexity defaults from the TYPE, never to LOW', () => {
  // A COMPLEX unit with no stated complexity is not a low-complexity unit, and
  // reading it as one would undo the classification the planner did make.
  assert.equal(validateWorkUnit(unit({ type: 'COMPLEX' })).complexity, 'HIGH');
  assert.equal(validateWorkUnit(unit({ type: 'MECHANICAL' })).complexity, 'LOW');
  assert.equal(validateWorkUnit(unit({ type: 'STANDARD' })).complexity, 'MEDIUM');
  assert.equal(validateWorkUnit(unit({ risk: undefined })).risk, 'LOW');
});

// ===========================================================================
// 46. Invalid units
// ===========================================================================

test('46. an unknown type is refused', () => {
  assert.throws(
    () => validateWorkUnit(unit({ type: 'TRIVIAL' })),
    (error) => error.code === 'PLAN_INVALID' && /TRIVIAL/.test(error.message),
  );
  for (const type of WORK_UNIT_TYPES) {
    assert.doesNotThrow(() => validateWorkUnit(unit({
      type,
      ...(type === 'DETERMINISTIC' ? { action: 'git-diff-check', acceptanceCriteria: [] } : {}),
    })));
  }
});

test('46. a unit a model executes must state what "done" means', () => {
  assert.throws(
    () => validateWorkUnit(unit({ acceptanceCriteria: [] })),
    (error) => error.code === 'PLAN_INVALID' && /acceptanceCriteria/.test(error.message),
  );
});

test('46. an id outside the known shape is refused', () => {
  for (const id of ['wu-001', 'WU1', 'TASK-001', 'WU-0001', '']) {
    assert.throws(() => validateWorkUnit(unit({ id })), (error) => error.code === 'PLAN_INVALID');
  }
  for (const id of ['WU-001', 'VERIFY-002', 'FIX-010', 'DIAG-1']) {
    assert.doesNotThrow(() => validateWorkUnit(unit({ id })));
  }
});

test('46. a duplicate id is refused at plan level', () => {
  assert.throws(
    () => validateExecutionPlan(plan([unit(), unit({ objective: 'outra coisa' })])),
    (error) => error.code === 'PLAN_DUPLICATE_ID',
  );
});

test('46. a dependency the plan does not declare is refused', () => {
  assert.throws(
    () => validateExecutionPlan(plan([unit({ dependencies: ['WU-999'] })])),
    (error) => error.code === 'PLAN_UNKNOWN_DEPENDENCY' && /WU-999/.test(error.message),
  );
});

// ===========================================================================
// 14 / 69. The plan declares nature, never a model
// ===========================================================================

test('14. a plan that names a model is refused, not silently stripped', () => {
  for (const field of ['model', 'modelKey', 'profile', 'developerProfile', 'effort', 'executor']) {
    assert.throws(
      () => validateWorkUnit(unit({ [field]: 'haiku' })),
      (error) => error.code === 'PLAN_DECLARES_MODEL' && error.message.includes(field),
      `expected ${field} to be refused`,
    );
  }
});

test('a deterministic unit may only name an action from the closed registry', () => {
  assert.throws(
    () => validateWorkUnit(unit({ type: 'DETERMINISTIC', action: 'rm -rf /', acceptanceCriteria: [] })),
    (error) => error.code === 'UNKNOWN_DETERMINISTIC_ACTION',
  );
  assert.throws(
    () => validateWorkUnit(unit({ type: 'DETERMINISTIC', acceptanceCriteria: [] })),
    (error) => error.code === 'PLAN_INVALID' && /action/.test(error.message),
  );

  const validated = validateWorkUnit(unit({
    id: 'VERIFY-001', type: 'DETERMINISTIC', action: 'typecheck', scope: 'apps/bff', acceptanceCriteria: [],
  }));
  assert.equal(validated.action, 'typecheck');
  assert.equal(validated.scope, 'apps/bff');
});

test('a deterministic action that needs a scope must be given a workspace one', () => {
  assert.throws(
    () => validateWorkUnit(unit({ id: 'VERIFY-001', type: 'DETERMINISTIC', action: 'typecheck', acceptanceCriteria: [] })),
    (error) => error.code === 'PLAN_INVALID' && /scope/.test(error.message),
  );
  for (const scope of ['../etc', '/etc', 'apps/../..', 'docs/migration']) {
    assert.throws(
      () => validateWorkUnit(unit({
        id: 'VERIFY-001', type: 'DETERMINISTIC', action: 'typecheck', scope, acceptanceCriteria: [],
      })),
      (error) => error.code === 'PLAN_INVALID',
      `expected scope ${scope} to be refused`,
    );
  }
});

test('a test pattern that could mean something to a shell is refused', () => {
  for (const pattern of ['tests/a.test.ts; rm -rf .', 'tests/$(whoami).ts', 'tests/`id`.ts', 'a|b']) {
    assert.throws(
      () => validateWorkUnit(unit({
        id: 'VERIFY-001', type: 'DETERMINISTIC', action: 'targeted-tests',
        scope: 'apps/bff', pattern, acceptanceCriteria: [],
      })),
      (error) => error.code === 'PLAN_INVALID',
      `expected pattern ${pattern} to be refused`,
    );
  }

  assert.doesNotThrow(() => validateWorkUnit(unit({
    id: 'VERIFY-001', type: 'DETERMINISTIC', action: 'targeted-tests',
    scope: 'apps/bff', pattern: 'tests/notifications/*.test.ts', acceptanceCriteria: [],
  })));
});

test('every registered deterministic action is nameable by a plan', () => {
  assert.ok(DETERMINISTIC_ACTION_NAMES.length > 0);
  assert.ok(DETERMINISTIC_ACTION_NAMES.includes('typecheck'));
  assert.ok(DETERMINISTIC_ACTION_NAMES.includes('git-diff-check'));
});

test('the rendered UI gate runs the gate script, at the worktree root, as a global step', () => {
  // The registry being closed is the security property, so what each entry
  // actually spawns is pinned rather than trusted: an action is argv, and this
  // one must stay `npm run validate:ui` and nothing else.
  const spec = assertDeterministicAction('validate-ui');
  assert.deepEqual([...spec.command], ['npm', 'run', 'validate:ui']);
  assert.equal(spec.cwd, ACTION_CWD.WORKTREE);
  assert.equal(spec.requiresScope, false);
  // Global, not targeted: it serves the built app, so a plan places it once,
  // after the build exists, never per unit.
  assert.equal(spec.targeted, false);
});

// ===========================================================================
// 40. Cycle detection — before a worker starts
// ===========================================================================

test('40. WU-1 -> WU-2 -> WU-1 is rejected, and the error names the cycle', () => {
  assert.throws(
    () => validateExecutionPlan(plan([
      unit({ id: 'WU-001', dependencies: ['WU-002'] }),
      unit({ id: 'WU-002', dependencies: ['WU-001'] }),
    ])),
    (error) => error.code === 'PLAN_CYCLE'
      && error.details.cycle.includes('WU-001')
      && error.details.cycle.includes('WU-002'),
  );
});

test('40. a unit depending on itself is a cycle', () => {
  assert.throws(
    () => validateWorkUnit(unit({ dependencies: ['WU-001'] })),
    (error) => error.code === 'PLAN_CYCLE',
  );
});

test('40. a longer cycle is caught too, and the acyclic part is not blamed', () => {
  assert.throws(
    () => validateExecutionPlan(plan([
      unit({ id: 'WU-001', dependencies: [] }),
      unit({ id: 'WU-002', dependencies: ['WU-001', 'WU-004'] }),
      unit({ id: 'WU-003', dependencies: ['WU-002'] }),
      unit({ id: 'WU-004', dependencies: ['WU-003'] }),
    ])),
    (error) => error.code === 'PLAN_CYCLE' && !error.details.cycle.includes('WU-001'),
  );
});

// ===========================================================================
// 54 / 55. Order and levels
// ===========================================================================

test('54. topological order respects every dependency', () => {
  const units = [
    unit({ id: 'VERIFY-001', type: 'DETERMINISTIC', action: 'git-diff-check', dependencies: ['WU-002'], acceptanceCriteria: [] }),
    unit({ id: 'WU-002', dependencies: ['WU-001'] }),
    unit({ id: 'WU-001', dependencies: [] }),
  ].map((raw) => validateWorkUnit(raw));

  const { order } = topologicalOrder(units);
  assert.deepEqual(order.map((entry) => entry.id), ['WU-001', 'WU-002', 'VERIFY-001']);
});

test('55. units with no dependency between them land on the same level', () => {
  const units = [
    unit({ id: 'WU-001' }),
    unit({ id: 'WU-002', dependencies: ['WU-001'] }),
    unit({ id: 'WU-003', dependencies: ['WU-001'] }),
    unit({ id: 'WU-004', dependencies: ['WU-002', 'WU-003'] }),
  ].map((raw) => validateWorkUnit(raw));

  assert.deepEqual(executionLevels(units), [['WU-001'], ['WU-002', 'WU-003'], ['WU-004']]);
});

test('order is stable: the same plan schedules the same thing next, every time', () => {
  const units = [
    unit({ id: 'WU-003' }),
    unit({ id: 'WU-001' }),
    unit({ id: 'WU-002' }),
  ].map((raw) => validateWorkUnit(raw));

  const first = topologicalOrder(units).order.map((entry) => entry.id);
  const second = topologicalOrder(units).order.map((entry) => entry.id);
  assert.deepEqual(first, second);
  assert.deepEqual(first, ['WU-003', 'WU-001', 'WU-002'], 'declaration order breaks the tie');
});

// ===========================================================================
// 41. Fragmentation
// ===========================================================================

test('41. an absurdly fragmented plan is refused', () => {
  const many = Array.from({ length: FRAGMENTATION_LIMITS.hardMax + 1 }, (_, index) => unit({
    id: `WU-${String(index + 1).padStart(3, '0')}`,
  }));
  assert.throws(
    () => validateExecutionPlan(plan(many)),
    (error) => error.code === 'PLAN_FRAGMENTATION_EXCESSIVE',
  );
});

test('41. the bands are reported, not enforced', () => {
  assert.equal(describeFragmentation(2).band, 'SMALL');
  assert.equal(describeFragmentation(6).band, 'MEDIUM');
  assert.equal(describeFragmentation(12).band, 'LARGE');
  assert.equal(describeFragmentation(18).withinGuidance, false);

  // 18 is over guidance and still executes: "this Goal genuinely has eighteen
  // units" must stay possible.
  const many = Array.from({ length: 18 }, (_, index) => unit({ id: `WU-${String(index + 1).padStart(3, '0')}` }));
  const validated = validateExecutionPlan(plan(many));
  assert.equal(validated.fragmentation.withinGuidance, false);
  assert.equal(validated.workUnits.length, 18);
});

// ===========================================================================
// 42. Merging units too small to be worth their overhead
// ===========================================================================

test('42. a chain of trivial mechanical units is merged before execution', () => {
  const units = [
    unit({ id: 'WU-001', type: 'MECHANICAL', objective: 'criar o tipo NotificationType', acceptanceCriteria: ['existe'] }),
    unit({
      id: 'WU-002', type: 'MECHANICAL', objective: 'adicionar o export de NotificationType',
      dependencies: ['WU-001'], acceptanceCriteria: ['exportado'],
    }),
    unit({
      id: 'WU-003', type: 'MECHANICAL', objective: 'adicionar o import em service.ts',
      dependencies: ['WU-002'], acceptanceCriteria: ['importado'],
    }),
  ].map((raw) => validateWorkUnit(raw));

  const { units: merged, merges } = normalizeWorkUnits(units);
  assert.equal(merged.length, 1, 'three edits become one deliverable');
  assert.equal(merged[0].id, 'WU-001', 'the parent id survives, so dependency edges stay valid');
  assert.deepEqual([...merged[0].mergedFrom], ['WU-002', 'WU-003']);
  assert.equal(merged[0].acceptanceCriteria.length, 3, 'nothing the planner asked for is dropped');
  assert.equal(merges.length, 2);
});

test('42. a real unit is never merged away, however small', () => {
  const units = [
    unit({ id: 'WU-001', type: 'MECHANICAL', objective: 'criar o tipo NotificationType', acceptanceCriteria: ['existe'] }),
    unit({
      id: 'WU-002', type: 'STANDARD', objective: 'implementar o envio com retry e backoff',
      dependencies: ['WU-001'], acceptanceCriteria: ['reenvia'],
    }),
  ].map((raw) => validateWorkUnit(raw));

  const { units: merged } = normalizeWorkUnits(units);
  assert.equal(merged.length, 2, 'a STANDARD unit is a deliverable, not an edit');
});

test('42. a merge never drops a branch of the DAG', () => {
  // WU-001 has two dependents, so absorbing one of them into it would orphan
  // the other. The conservative rule declines the merge entirely.
  const units = [
    unit({ id: 'WU-001', type: 'MECHANICAL', objective: 'criar o tipo Base', acceptanceCriteria: ['existe'] }),
    unit({
      id: 'WU-002', type: 'MECHANICAL', objective: 'adicionar o export de Base',
      dependencies: ['WU-001'], acceptanceCriteria: ['exportado'],
    }),
    unit({
      id: 'WU-003', type: 'MECHANICAL', objective: 'adicionar o import de Base',
      dependencies: ['WU-001'], acceptanceCriteria: ['importado'],
    }),
  ].map((raw) => validateWorkUnit(raw));

  const { units: merged } = normalizeWorkUnits(units);
  assert.equal(merged.length, 3);
});

test('42. dependency edges follow the merge instead of dangling', () => {
  const validated = validateExecutionPlan(plan([
    unit({ id: 'WU-001', type: 'MECHANICAL', objective: 'criar o tipo Base', acceptanceCriteria: ['existe'] }),
    unit({
      id: 'WU-002', type: 'MECHANICAL', objective: 'adicionar o export de Base',
      dependencies: ['WU-001'], acceptanceCriteria: ['exportado'],
    }),
    unit({ id: 'WU-003', type: 'STANDARD', dependencies: ['WU-002'] }),
  ]));

  assert.equal(validated.workUnits.length, 2);
  const downstream = findUnit(validated, 'WU-003');
  assert.deepEqual([...downstream.dependencies], ['WU-001'], 'the edge moved to the absorbing unit');
  assert.deepEqual([...validated.order], ['WU-001', 'WU-003']);
});

// ===========================================================================
// The plan as a whole
// ===========================================================================

test('a plan carries its order, its levels and where it came from', () => {
  const validated = validateExecutionPlan(plan([
    unit({ id: 'WU-001', type: 'MECHANICAL', objective: 'Criar os tipos de notificação', acceptanceCriteria: ['tipos existem'] }),
    unit({ id: 'WU-002', dependencies: ['WU-001'] }),
    unit({
      id: 'VERIFY-001', type: 'DETERMINISTIC', action: 'typecheck', scope: 'apps/bff',
      dependencies: ['WU-002'], acceptanceCriteria: [],
    }),
  ], { goalSummary: 'notificações de cancelamento', executionStrategy: 'tipos, serviço, verificação' }));

  assert.deepEqual([...validated.order], ['WU-001', 'WU-002', 'VERIFY-001']);
  assert.deepEqual(validated.levels.map((level) => [...level]), [['WU-001'], ['WU-002'], ['VERIFY-001']]);
  assert.equal(validated.source, 'TECH_LEAD_PLAN');
  assert.equal(validated.goal, '008');
  assert.equal(validated.goalSummary, 'notificações de cancelamento');
});

test('a plan for another Goal is refused when read for this one', () => {
  assert.throws(
    () => validateExecutionPlan(plan([unit()], { goal: '009' }), { goal: '008' }),
    (error) => error.code === 'PLAN_INVALID' && /009/.test(error.message),
  );
});

test('an empty plan is refused', () => {
  assert.throws(() => validateExecutionPlan(plan([])), (error) => error.code === 'PLAN_INVALID');
  assert.throws(() => validateExecutionPlan(null), (error) => error.code === 'PLAN_INVALID');
});
