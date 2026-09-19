/**
 * The feature flag, the plan hand-off, and the compatibility path.
 *
 * What this file states: Work Unit execution is now the standard path and
 * requires no env var to be on, an explicit `IA_LOOP_WORK_UNIT_EXECUTION=0`
 * still leaves the Developer exactly as it was before Work Units existed, ON
 * does not require every Goal to have been planned for it, and the plan that
 * carries a Goal across the gap between planning and execution is durable and
 * validated at both ends.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  WORK_UNIT_EXECUTION_FLAG,
  isWorkUnitExecutionEnabled,
  workUnitConfig,
} from '../lib/work-unit-config.mjs';
import {
  SINGLE_UNIT_PLAN_SOURCES,
  createExecutionPlanStore,
  fallbackExecutionPlan,
  unitTypeForProfile,
} from '../lib/execution-plan-store.mjs';
import { validatePlanningDecision, planningDecisionSchemaFor } from '../lib/planning-decision.mjs';
import { PROTOCOL_VERSION_V2 } from '../lib/contracts-v2.mjs';
import { runDeterministicAction } from '../lib/deterministic-executor.mjs';
import { validateWorkUnit } from '../lib/work-units.mjs';
import { buildReviewPacket, renderReviewPrompt } from '../lib/review-packet.mjs';

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-plan-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

const PLAN = Object.freeze({
  goalSummary: 'notificações de cancelamento',
  executionStrategy: 'tipos, serviço, integração, verificação',
  workUnits: [
    {
      id: 'WU-001',
      objective: 'Criar os tipos de notificação',
      type: 'MECHANICAL',
      dependencies: [],
      expectedFiles: ['src/notifications/types.ts'],
      acceptanceCriteria: ['NotificationType existe e é exportado'],
    },
    {
      id: 'WU-002',
      objective: 'Implementar o NotificationService',
      type: 'STANDARD',
      dependencies: ['WU-001'],
      acceptanceCriteria: ['envia e registra a entrega'],
    },
    {
      id: 'VERIFY-001',
      objective: 'Typecheck do BFF',
      type: 'DETERMINISTIC',
      action: 'typecheck',
      scope: 'apps/bff',
      dependencies: ['WU-002'],
      acceptanceCriteria: [],
    },
  ],
});

// ===========================================================================
// 37 / 58. The feature flag
// ===========================================================================

test('37. Work Unit execution is ON by default, with no env var set at all', () => {
  assert.equal(isWorkUnitExecutionEnabled({}), true);
  assert.equal(workUnitConfig({}).enabled, true);
});

test('37. IA_LOOP_WORK_UNIT_EXECUTION=0 is an explicit, working rollback', () => {
  assert.equal(isWorkUnitExecutionEnabled({ [WORK_UNIT_EXECUTION_FLAG]: '0' }), false);
  assert.equal(workUnitConfig({ [WORK_UNIT_EXECUTION_FLAG]: '0' }).enabled, false);
});

test('37. the flag accepts the usual spellings and nothing else', () => {
  for (const value of ['1', 'true', 'on', 'yes', 'TRUE']) {
    assert.equal(isWorkUnitExecutionEnabled({ [WORK_UNIT_EXECUTION_FLAG]: value }), true, value);
  }
  for (const value of ['0', 'false', 'off', 'no', 'maybe']) {
    assert.equal(isWorkUnitExecutionEnabled({ [WORK_UNIT_EXECUTION_FLAG]: value }), false, value);
  }
  // An explicitly empty value is the same as "not set": it falls back to the
  // default (ON), it does not mean "off".
  assert.equal(isWorkUnitExecutionEnabled({ [WORK_UNIT_EXECUTION_FLAG]: '' }), true);
});

test('58. with the flag explicitly off, nothing about the legacy Developer contract changes', async () => {
  // The legacy path is the one the existing suite already proves end to end.
  // What matters here is that the switch is the ONLY thing that selects it,
  // and that reading the config never has a side effect on the old path.
  const legacy = workUnitConfig({ [WORK_UNIT_EXECUTION_FLAG]: '0' });
  assert.equal(legacy.enabled, false);

  const { validateDeveloperResult, DEVELOPER_STATUSES_V2 } = await import('../lib/contracts-v2.mjs');
  assert.deepEqual([...DEVELOPER_STATUSES_V2], ['REVIEW_REQUIRED', 'BLOCKED', 'ESCALATION_REQUIRED']);

  const result = validateDeveloperResult({
    protocolVersion: PROTOCOL_VERSION_V2,
    jobId: 'j', goal: '008', round: 1,
    status: 'REVIEW_REQUIRED', summary: 's', implementationReport: 'r', validations: [],
  }, { jobId: 'j', goal: '008', round: 1 });
  assert.equal(result.status, 'REVIEW_REQUIRED');
});

test('the loop budget is configurable without touching the model policy', () => {
  const config = workUnitConfig({
    IA_LOOP_WU_MAX_CONTEXT_EXPANSIONS: '0',
    IA_LOOP_WU_MAX_FIX_UNITS: '1',
    IA_LOOP_WU_ALLOW_FALLBACK: '0',
  });
  assert.equal(config.maxContextExpansions, 0);
  assert.equal(config.maxFixUnitsPerVerification, 1);
  assert.equal(config.allowCompatibilityFallback, false);
  // Nothing in this object names a model: that policy lives in model-routing.
  assert.ok(!JSON.stringify(config).match(/haiku|sonnet|opus|fable/i));
});

// ===========================================================================
// The durable Goal -> plan hand-off
// ===========================================================================

test('a recorded plan survives the gap between planning and execution', async () => {
  await withDir(async (dir) => {
    const store = createExecutionPlanStore(dir);
    assert.equal(await store.read('008'), null, 'nothing recorded means null, not an error');

    const record = await store.write('008', { plan: PLAN });
    assert.equal(record.workUnitCount, 3);
    assert.deepEqual(record.types, { MECHANICAL: 1, STANDARD: 1, DETERMINISTIC: 1 });

    const read = await store.read('008');
    assert.deepEqual([...read.order], ['WU-001', 'WU-002', 'VERIFY-001']);
    assert.equal(read.source, 'TECH_LEAD_PLAN');
    assert.equal(read.goal, '008');
  });
});

test('a plan that could never execute is refused by the process that still knows why', async () => {
  await withDir(async (dir) => {
    const store = createExecutionPlanStore(dir);
    await assert.rejects(
      () => store.write('008', {
        plan: {
          workUnits: [
            { id: 'WU-001', objective: 'a', type: 'STANDARD', dependencies: ['WU-002'], acceptanceCriteria: ['x'] },
            { id: 'WU-002', objective: 'b', type: 'STANDARD', dependencies: ['WU-001'], acceptanceCriteria: ['y'] },
          ],
        },
      }),
      (error) => error.code === 'PLAN_CYCLE',
    );
    assert.equal(await store.read('008'), null, 'and nothing was written');
  });
});

test('plans for different Goals do not overwrite one another', async () => {
  await withDir(async (dir) => {
    const store = createExecutionPlanStore(dir);
    await store.write('008', { plan: PLAN });
    await store.write('009', { plan: { workUnits: [{ ...PLAN.workUnits[1], dependencies: [] }] } });

    assert.equal((await store.read('008')).workUnits.length, 3);
    assert.equal((await store.read('009')).workUnits.length, 1);
  });
});

// ===========================================================================
// 38. Compatibility
// ===========================================================================

test('38. a Goal planned before execution plans existed runs as one STANDARD unit', () => {
  const plan = fallbackExecutionPlan({ goal: '007', round: 1, goalSummary: 'catálogo' });
  assert.equal(plan.workUnits.length, 1);
  assert.equal(plan.workUnits[0].type, 'STANDARD');
  assert.equal(plan.workUnits[0].id, 'WU-001');
  assert.equal(plan.source, SINGLE_UNIT_PLAN_SOURCES.COMPATIBILITY);
  assert.ok(plan.workUnits[0].acceptanceCriteria.length > 0);
});

test('38. a correction round is one STANDARD unit scoped to the blockers', () => {
  const plan = fallbackExecutionPlan({
    goal: '007',
    round: 3,
    blockers: ['R2-01: a contagem pós-constraints inclui as sondas', 'R2-02: falta o teste negativo'],
  });

  assert.equal(plan.workUnits.length, 1);
  assert.equal(plan.workUnits[0].id, 'FIX-001');
  assert.equal(plan.source, SINGLE_UNIT_PLAN_SOURCES.CORRECTION);
  assert.equal(plan.workUnits[0].acceptanceCriteria.length, 2, 'one criterion per blocker');
  assert.ok(plan.workUnits[0].acceptanceCriteria[0].includes('R2-01'));
});

test('38. a Tech Lead escalation survives the switch, translated into a tier', () => {
  // The reviewer said the next round needs Opus. Under Work Unit execution the
  // profile no longer decides the model — but its JUDGEMENT must not be lost.
  const escalated = unitTypeForProfile('OPUS_HIGH');
  assert.equal(escalated.type, 'COMPLEX');
  assert.ok(escalated.reason.includes('OPUS_HIGH'));

  const plan = fallbackExecutionPlan({
    goal: '007', round: 3, blockers: ['R2-01: a contagem inclui as sondas'],
    unitType: escalated.type, unitTypeReason: escalated.reason,
  });
  assert.equal(plan.workUnits[0].type, 'COMPLEX');
  assert.equal(plan.workUnits[0].complexity, 'HIGH');
  assert.ok(plan.executionStrategy.includes('OPUS_HIGH'));

  // And the plan still names no model: the router decides from the type.
  assert.ok(!JSON.stringify(plan.workUnits[0]).match(/opus|sonnet|haiku/i)
    || plan.workUnits[0].model === undefined);
  assert.equal(plan.workUnits[0].action, null);
});

test('38. an ordinary profile keeps the single unit at STANDARD', () => {
  for (const profile of ['SONNET_HIGH', 'SONNET_MEDIUM', undefined, null]) {
    assert.equal(unitTypeForProfile(profile).type, 'STANDARD', String(profile));
  }
});

// ===========================================================================
// 13. The planning contract carries the DAG — and never a model
// ===========================================================================

const planning = (over = {}) => ({
  protocolVersion: PROTOCOL_VERSION_V2,
  jobId: 'job-1',
  goal: '007',
  decision: 'NEXT_GOAL',
  summary: 'próximo Goal escrito',
  nextGoalId: '008',
  nextGoalTitle: 'Notificações',
  nextGoalPath: 'docs/migration/goals/008-notificacoes.md',
  documentsUpdated: ['docs/migration/MIGRATION_STATUS.md'],
  developerProfile: 'SONNET_HIGH',
  ...over,
});

test('13. planning may carry an execution plan, and it is validated there', () => {
  const decision = validatePlanningDecision(planning({ executionPlan: PLAN }), { jobId: 'job-1', goal: '007' });
  assert.equal(decision.executionPlanSummary.units, 3);
  assert.deepEqual([...decision.executionPlanSummary.order], ['WU-001', 'WU-002', 'VERIFY-001']);
  assert.ok(decision.executionPlan, 'the raw plan travels on for the store to validate again');
});

test('13. a planning result with no execution plan is still valid', () => {
  const decision = validatePlanningDecision(planning(), { jobId: 'job-1', goal: '007' });
  assert.equal(decision.executionPlan, null);
  assert.equal(decision.executionPlanSummary, null);
});

test('13. a cycle in the plan fails at PLANNING, not at execution', () => {
  assert.throws(
    () => validatePlanningDecision(planning({
      executionPlan: {
        workUnits: [
          { id: 'WU-001', objective: 'a', type: 'STANDARD', dependencies: ['WU-002'], acceptanceCriteria: ['x'] },
          { id: 'WU-002', objective: 'b', type: 'STANDARD', dependencies: ['WU-001'], acceptanceCriteria: ['y'] },
        ],
      },
    }), { jobId: 'job-1', goal: '007' }),
    (error) => error.code === 'PLAN_CYCLE',
  );
});

test('14. the planning schema gives the Tech Lead no way to name a model per unit', () => {
  const schema = planningDecisionSchemaFor({ jobId: 'job-1', goal: '007' });
  const unitProperties = Object.keys(schema.properties.executionPlan.properties.workUnits.items.properties);
  for (const forbidden of ['model', 'modelKey', 'profile', 'developerProfile', 'effort', 'executor']) {
    assert.ok(!unitProperties.includes(forbidden), `${forbidden} must not be offered`);
  }
  assert.ok(unitProperties.includes('type'));
  assert.ok(unitProperties.includes('complexity'));
  assert.ok(unitProperties.includes('risk'));
  assert.equal(schema.properties.executionPlan.properties.workUnits.items.additionalProperties, false);
});

// ===========================================================================
// The deterministic runner spawns argv, never a shell
// ===========================================================================

test('a deterministic action is spawned as argv with no shell', async () => {
  let observed = null;
  const fakeSpawn = (command, args, options) => {
    observed = { command, args, options };
    return {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (event, handler) => { if (event === 'close') setImmediate(() => handler(0, null)); },
      kill: () => {},
    };
  };

  const unit = validateWorkUnit({
    id: 'VERIFY-001',
    objective: 'testes dirigidos',
    type: 'DETERMINISTIC',
    action: 'targeted-tests',
    scope: 'apps/bff',
    pattern: 'tests/notifications',
    dependencies: [],
    acceptanceCriteria: [],
  });

  // Identity passthrough: this test is about argv/no-shell in general, not
  // about Windows npm/npx resolution specifically — that has its own
  // dedicated coverage in windows-command-resolver.test.mjs and
  // deterministic-executor.test.mjs, and runs differently depending on the
  // platform this suite happens to execute on.
  const resolveTarget = (argv) => ({ command: argv[0], args: argv.slice(1) });

  const outcome = await runDeterministicAction({ unit, worktree: '/tmp/wt', spawnFn: fakeSpawn, resolveTarget });

  assert.equal(observed.command, 'npx');
  assert.deepEqual(observed.args, ['vitest', 'run', 'tests/notifications']);
  assert.equal(observed.options.shell, false, 'no shell means no metacharacter can mean anything');
  assert.ok(observed.options.cwd.endsWith(join('wt', 'apps', 'bff')));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.exitCode, 0);
});

test('a spawn failure is reported, never swallowed', async () => {
  const unit = validateWorkUnit({
    id: 'VERIFY-001', objective: 'lint', type: 'DETERMINISTIC', action: 'git-diff-check',
    dependencies: [], acceptanceCriteria: [],
  });

  const outcome = await runDeterministicAction({
    unit,
    worktree: '/tmp/wt',
    spawnFn: () => { throw new Error('ENOENT'); },
  });

  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /SPAWN_FAILED/);
});

// ===========================================================================
// 33. The review packet shows the DAG
// ===========================================================================

test('33. the review packet carries the DAG, summarised rather than replayed', () => {
  const packet = buildReviewPacket({
    goal: '008',
    goalPath: 'docs/migration/goals/008-x.md',
    round: 1,
    reviewLevel: 'DEEP',
    migrationAcceptedBaseline: 'a'.repeat(40),
    executionBase: 'b'.repeat(40),
    worktreeInitialHead: 'b'.repeat(40),
    worktreePath: '/tmp/wt',
    changes: { changedFiles: ['src/a.ts'], untracked: [], commits: [], diffStat: '1 file', diff: '', diffTruncated: false },
    developerResult: {
      implementationReport: 'relatório agregado',
      summary: 'feito',
      validations: [],
      workUnitExecution: {
        source: 'TECH_LEAD_PLAN',
        levels: [['WU-001'], ['VERIFY-001']],
        telemetry: { modelCalls: { native: 1, haiku: 1, sonnet: 0, opus: 0 } },
        units: [
          {
            id: 'WU-001', type: 'MECHANICAL', state: 'COMPLETED', executor: 'model',
            model: 'haiku', effort: 'high', tier: 'MECHANICAL', attempts: 1,
            escalations: 0, contextExpansions: 0, changedFiles: ['src/a.ts'],
          },
          {
            id: 'VERIFY-001', type: 'DETERMINISTIC', state: 'COMPLETED', executor: 'native',
            model: null, effort: null, tier: 'DETERMINISTIC', attempts: 1,
            escalations: 0, contextExpansions: 0, changedFiles: [],
          },
        ],
      },
    },
  });

  assert.equal(packet.workUnitExecution.units.length, 2);

  const prompt = renderReviewPrompt(packet);
  assert.ok(prompt.includes('WU-001 [MECHANICAL] COMPLETED — haiku high'));
  assert.ok(prompt.includes('VERIFY-001 [DETERMINISTIC] COMPLETED — native (sem modelo)'));
  assert.ok(prompt.includes('o review continua sendo do Goal inteiro'));
});

test('33. a legacy round carries no DAG, and the prompt does not invent one', () => {
  const packet = buildReviewPacket({
    goal: '007',
    goalPath: 'docs/migration/goals/007-x.md',
    round: 1,
    reviewLevel: 'DEEP',
    migrationAcceptedBaseline: 'a'.repeat(40),
    executionBase: 'b'.repeat(40),
    worktreeInitialHead: 'b'.repeat(40),
    worktreePath: '/tmp/wt',
    changes: { changedFiles: [], untracked: [], commits: [], diffStat: '', diff: '', diffTruncated: false },
    developerResult: { implementationReport: 'relatório', summary: 's', validations: [] },
  });

  assert.equal(packet.workUnitExecution, null);
  assert.ok(!renderReviewPrompt(packet).includes('Execução por Work Units'));
});
