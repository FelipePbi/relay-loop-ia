/**
 * Work Unit execution, against a real job store.
 *
 * The properties here are the ones that make decomposition safe rather than
 * merely cheaper: a deterministic unit never reaches a model provider, a
 * mechanical unit that succeeds never touches Sonnet or Opus, an escalation
 * keeps the same unit / Goal / round / worktree with the earlier attempt
 * intact, a restart does not re-run what is already on disk, and running the
 * whole thing twice manufactures nothing.
 *
 * No model is called. `invokeUnit` is a fake returning invokeAgent-shaped
 * outcomes, and the deterministic runner is faked too, so every branch is
 * exercised for zero tokens.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJobStore, WORK_UNIT_NAMESPACE } from '../lib/job-store.mjs';
import { LOOP_STATES } from '../lib/loop-state.mjs';
import { PROTOCOL_VERSION_V2 } from '../lib/contracts-v2.mjs';
import { validateExecutionPlan } from '../lib/work-units.mjs';
import { executeWorkUnitPlan, workUnitJobId, collectUnitChanges } from '../lib/work-unit-executor.mjs';
import { validateWorkUnitResult } from '../lib/work-unit-contracts.mjs';
import { workUnitConfig } from '../lib/work-unit-config.mjs';
import { renderRoutingSummary, summarizeRouting } from '../lib/routing-summary.mjs';

const GOAL = '008';
const ROUND = 1;
const WORKTREE = '.ai-worktrees/goal-008';
const BASE = 'a'.repeat(40);
const PARENT_JOB = '008-r1-developer-aaaa1111';

const job = { jobId: PARENT_JOB, goal: GOAL, round: ROUND, worktree: WORKTREE };

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-wu-'));
  try {
    return await run(createJobStore(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** An invokeAgent-shaped success, with the contract actually applied. */
function ok(payload, validatePayload) {
  if (validatePayload) validatePayload(payload);
  return { error: null, structuredOutput: true, available: true, payload };
}

const completed = (unitJobId, unit, over = {}) => ({
  protocolVersion: PROTOCOL_VERSION_V2,
  jobId: unitJobId,
  goal: GOAL,
  round: ROUND,
  workUnitId: unit.id,
  status: 'COMPLETED',
  summary: `${unit.id} feito`,
  report: `relatório de ${unit.id}`,
  changedFiles: [],
  acceptance: unit.acceptanceCriteria.map((criterion) => ({ criterion, met: true })),
  ...over,
});

const escalates = (unitJobId, unit, reason, evidence) => ({
  protocolVersion: PROTOCOL_VERSION_V2,
  jobId: unitJobId,
  goal: GOAL,
  round: ROUND,
  workUnitId: unit.id,
  status: 'ESCALATION_REQUIRED',
  summary: `${unit.id} precisa de um tier acima`,
  report: 'o padrão existente não cobre este caso',
  escalation: { reason, evidence },
});

const asksForContext = (unitJobId, unit, files) => ({
  protocolVersion: PROTOCOL_VERSION_V2,
  jobId: unitJobId,
  goal: GOAL,
  round: ROUND,
  workUnitId: unit.id,
  status: 'CONTEXT_EXPANSION_REQUIRED',
  summary: `${unit.id} precisa de mais contexto`,
  report: 'os arquivos do packet não bastam',
  contextRequest: { reason: 'MISSING_TYPE_OR_CONTRACT', files },
});

const plan = (units, over = {}) => validateExecutionPlan({ goal: GOAL, workUnits: units, ...over }, { goal: GOAL });

const standard = (id, over = {}) => ({
  id,
  objective: `Implementar ${id}`,
  type: 'STANDARD',
  dependencies: [],
  acceptanceCriteria: [`${id} entregue`],
  ...over,
});

const mechanical = (id, over = {}) => standard(id, { type: 'MECHANICAL', ...over });

const verify = (id, over = {}) => ({
  id,
  objective: 'Rodar o typecheck',
  type: 'DETERMINISTIC',
  action: 'typecheck',
  scope: 'apps/bff',
  dependencies: [],
  acceptanceCriteria: [],
  ...over,
});

/** A deterministic runner that never spawns anything. */
const fakeAction = ({ ok: passes = true, stdout = '', stderr = '' } = {}) => async ({ unit }) => ({
  unitId: unit.id,
  action: unit.action,
  label: unit.action,
  argv: ['fake', unit.action],
  cwd: WORKTREE,
  durationMs: 5,
  ok: passes,
  exitCode: passes ? 0 : 1,
  signal: null,
  error: null,
  stdout,
  stderr,
});

/** A changed-file snapshot that reports whatever the test says git would. */
const fakeSnapshot = (sequence) => {
  let index = 0;
  return async () => {
    const value = sequence[Math.min(index, sequence.length - 1)];
    index += 1;
    return new Set(value);
  };
};

const noChanges = async () => new Set();

const run = (store, over = {}) => executeWorkUnitPlan({
  store,
  job,
  goal: GOAL,
  round: ROUND,
  worktree: WORKTREE,
  executionBase: BASE,
  goalPath: 'docs/migration/goals/008-x.md',
  goalSummary: 'resumo curto do Goal',
  resumeFrom: LOOP_STATES.DEVELOPER_RUNNING,
  changedFilesSnapshot: noChanges,
  runAction: fakeAction(),
  config: workUnitConfig({}),
  ...over,
});

// ===========================================================================
// 48. Deterministic execution never reaches a model provider
// ===========================================================================

test('48. a DETERMINISTIC unit runs the command and calls no model at all', async () => {
  await withStore(async (store) => {
    let modelCalls = 0;
    const outcome = await run(store, {
      plan: plan([verify('VERIFY-001'), verify('VERIFY-002', { action: 'git-diff-check', scope: undefined, dependencies: ['VERIFY-001'] })]),
      invokeUnit: async () => { modelCalls += 1; throw new Error('a deterministic unit must never call a model'); },
    });

    assert.equal(modelCalls, 0, 'no inference was requested');
    assert.equal(outcome.telemetry.modelCalls.native, 2);
    assert.equal(outcome.telemetry.modelCalls.haiku, 0);
    assert.equal(outcome.telemetry.modelCalls.sonnet, 0);
    assert.equal(outcome.telemetry.modelCalls.opus, 0);
    assert.equal(outcome.aggregate.status, 'REVIEW_REQUIRED');

    // The verification appears as a validation the reviewer can read.
    assert.deepEqual(
      outcome.aggregate.validations.map((entry) => [entry.name, entry.passed]),
      [['typecheck', true], ['git-diff-check', true]],
    );

    const events = await store.readEvents();
    const executed = events.filter((event) => event.type === 'WORK_UNIT_DETERMINISTIC_EXECUTED');
    assert.equal(executed.length, 2);
    for (const event of executed) assert.equal(event.modelCalls, 0);
    assert.equal(events.filter((event) => event.type === 'MODEL_ROUTED').length, 0);
  });
});

test('48. a failing deterministic unit blocks the round instead of reporting it ready', async () => {
  await withStore(async (store) => {
    const outcome = await run(store, {
      plan: plan([verify('VERIFY-001')]),
      runAction: fakeAction({ ok: false, stderr: 'src/notifications/service.ts(12,3): error TS2345' }),
      invokeUnit: async () => { throw new Error('unreachable'); },
      // No budget for a corrective unit: this test is about the verdict, not
      // about the fix loop.
      config: { ...workUnitConfig({}), maxFixUnitsPerRound: 0 },
    });

    assert.equal(outcome.aggregate.status, 'BLOCKED');
    assert.equal(outcome.aggregate.validations[0].passed, false);
  });
});

// ===========================================================================
// 49. A mechanical unit that succeeds costs one Haiku call
// ===========================================================================

test('49. MECHANICAL success runs on Haiku only — no Sonnet, no Opus', async () => {
  await withStore(async (store) => {
    const seen = [];
    const outcome = await run(store, {
      plan: plan([mechanical('WU-001')]),
      invokeUnit: async ({ unit, routing, unitJobId, validatePayload }) => {
        seen.push(routing.modelKey);
        return ok(completed(unitJobId, unit), validatePayload);
      },
    });

    assert.deepEqual(seen, ['haiku']);
    assert.equal(outcome.records.get('WU-001').state, 'COMPLETED');
    assert.equal(outcome.telemetry.modelCalls.haiku, 1);
    assert.equal(outcome.telemetry.modelCalls.sonnet, 0);
    assert.equal(outcome.telemetry.modelCalls.opus, 0);
    assert.equal(outcome.telemetry.escalations, 0);

    // The routing decision is on the record for every call, exactly as it is
    // for a role-level one.
    const routed = (await store.readEvents()).filter((event) => event.type === 'MODEL_ROUTED');
    assert.equal(routed.length, 1);
    assert.equal(routed[0].selectedModel, 'haiku');
    assert.equal(routed[0].stage, 'work_unit');
  });
});

// ===========================================================================
// 50. Haiku -> Sonnet, as a successor attempt
// ===========================================================================

test('50. an authorised escalation keeps the same unit and preserves attempt 1', async () => {
  await withStore(async (store) => {
    const unitId = workUnitJobId({ goal: GOAL, round: ROUND, unitId: 'WU-001' });
    const seen = [];

    const outcome = await run(store, {
      plan: plan([mechanical('WU-001')]),
      invokeUnit: async ({ unit, routing, unitJobId, validatePayload }) => {
        seen.push(routing.modelKey);
        if (routing.modelKey === 'haiku') {
          return ok(escalates(unitJobId, unit, 'PATTERN_INSUFFICIENT', [
            'não existe padrão equivalente para reenvio no repositório',
          ]));
        }
        return ok(completed(unitJobId, unit), validatePayload);
      },
    });

    assert.deepEqual(seen, ['haiku', 'sonnet'], 'one step up, not two');

    const record = outcome.records.get('WU-001');
    assert.equal(record.state, 'COMPLETED');
    assert.equal(record.escalations, 1);
    assert.equal(record.tier, 'STANDARD');
    assert.equal(record.model, 'sonnet');

    // Same Work Unit, same Goal, same round, same worktree, same job.
    const stored = await store.readJob(WORK_UNIT_NAMESPACE, unitId);
    assert.equal(stored.workUnitId, 'WU-001');
    assert.equal(stored.goal, GOAL);
    assert.equal(stored.round, ROUND);
    assert.equal(stored.worktree, WORKTREE);
    assert.equal(stored.parentJobId, PARENT_JOB);

    // Attempt 1 is intact, with the model it ran on and why it ended.
    const state = await store.readAttemptState(WORK_UNIT_NAMESPACE, unitId);
    assert.equal(state.attempt, 2);
    assert.equal(state.history.length, 1);
    assert.equal(state.history[0].attempt, 1);
    assert.equal(state.history[0].status, 'REROUTED');
    assert.equal(state.history[0].routedTo.modelKey, 'sonnet');

    // And the answer that asked for help was kept, not thrown away.
    const candidate = await store.readCandidateResult(WORK_UNIT_NAMESPACE, unitId, `${unitId}-a1`);
    assert.equal(candidate.payload.status, 'ESCALATION_REQUIRED');

    const escalated = (await store.readEvents()).filter((event) => event.type === 'MODEL_ESCALATED');
    assert.equal(escalated.length, 1);
    assert.equal(escalated[0].from, 'haiku');
    assert.equal(escalated[0].to, 'sonnet');
    assert.equal(escalated[0].reason, 'PATTERN_INSUFFICIENT');
  });
});

test('50. an escalation the router refuses does not change the model', async () => {
  await withStore(async (store) => {
    const seen = [];
    await run(store, {
      plan: plan([standard('WU-001')]),
      invokeUnit: async ({ unit, routing, unitJobId, validatePayload }) => {
        seen.push(routing.modelKey);
        if (seen.length === 1) {
          // LOW_CONFIDENCE does not justify Opus. The unit answers again on
          // the same model, and the refusal is on the record.
          return ok(escalates(unitJobId, unit, 'LOW_CONFIDENCE', ['não tenho certeza']));
        }
        return ok(completed(unitJobId, unit), validatePayload);
      },
    });

    assert.deepEqual(seen, ['sonnet'], 'a refused escalation publishes the answer it already had');
    const refused = (await store.readEvents()).filter((event) => event.type === 'MODEL_ESCALATION_REFUSED');
    assert.equal(refused.length, 1);
    assert.equal(refused[0].workUnitId, 'WU-001');
  });
});

// ===========================================================================
// Haiku BLOCKED with a real permission denial — the Goal010/Goal011 incident
// ===========================================================================

const blocked = (unitJobId, unit, blockedReason) => ({
  protocolVersion: PROTOCOL_VERSION_V2,
  jobId: unitJobId,
  goal: GOAL,
  round: ROUND,
  workUnitId: unit.id,
  status: 'BLOCKED',
  summary: `${unit.id} bloqueada`,
  report: 'não foi possível prosseguir',
  changedFiles: [],
  blockedReason,
});

const PERMISSION_DENIALS = Object.freeze([
  { tool_name: 'Edit', tool_use_id: 'toolu_edit_1', tool_input: { file_path: 'apps/x/y.ts' } },
  { tool_name: 'Bash', tool_use_id: 'toolu_bash_1', tool_input: { command: 'rtk lint' } },
]);

test('a MECHANICAL unit BLOCKED with real permission denials escalates Haiku -> Sonnet as a new attempt', async () => {
  await withStore(async (store) => {
    const unitId = workUnitJobId({ goal: GOAL, round: ROUND, unitId: 'WU-001' });
    const seen = [];

    const outcome = await run(store, {
      plan: plan([mechanical('WU-001')]),
      invokeUnit: async ({ unit, routing, unitJobId, validatePayload }) => {
        seen.push(routing.modelKey);
        if (routing.modelKey === 'haiku') {
          // Exactly what invokeAgent hands back for a real denied attempt:
          // a structurally valid BLOCKED payload, plus the CLI's own
          // permission_denials record — never a status the model chose to
          // call "ESCALATION_REQUIRED" itself.
          return {
            error: null, structuredOutput: true, available: true,
            payload: blocked(unitJobId, unit, 'Edit tool requires approval not available in this session.'),
            permissionDenials: PERMISSION_DENIALS,
          };
        }
        return ok(completed(unitJobId, unit), validatePayload);
      },
    });

    assert.deepEqual(seen, ['haiku', 'sonnet'], 'promoted exactly one step, on real evidence');

    const record = outcome.records.get('WU-001');
    assert.equal(record.state, 'COMPLETED');
    assert.equal(record.escalations, 1);
    assert.equal(record.tier, 'STANDARD');
    assert.equal(record.model, 'sonnet');

    // 3. The Haiku attempt's history is preserved, not overwritten.
    const state = await store.readAttemptState(WORK_UNIT_NAMESPACE, unitId);
    assert.equal(state.attempt, 2, '4. a new attempt number, not a retry under the same one');
    assert.equal(state.history.length, 1);
    assert.equal(state.history[0].attempt, 1);
    assert.equal(state.history[0].status, 'REROUTED');
    assert.equal(state.history[0].routedTo.modelKey, 'sonnet');

    const candidate = await store.readCandidateResult(WORK_UNIT_NAMESPACE, unitId, `${unitId}-a1`);
    assert.equal(candidate.payload.status, 'BLOCKED', 'the BLOCKED answer itself is kept, not discarded');

    // 4. A distinct job/attempt for the Sonnet retry — same unit job id (a
    // Work Unit's identity is (goal, round, unitId), not a new job entirely),
    // but a genuinely new, numbered attempt the worker can claim.
    assert.equal(state.attemptId, `${unitId}-a2`);

    // 5. Telemetry records why the promotion happened.
    const escalated = (await store.readEvents()).filter((event) => event.type === 'MODEL_ESCALATED');
    assert.equal(escalated.length, 1);
    assert.equal(escalated[0].from, 'haiku');
    assert.equal(escalated[0].to, 'sonnet');
    assert.equal(escalated[0].reason, 'TOOLING_PERMISSION_DENIED');
  });
});

test('a MECHANICAL unit BLOCKED with no permission-denial evidence never escalates automatically', async () => {
  await withStore(async (store) => {
    const seen = [];
    const outcome = await run(store, {
      plan: plan([mechanical('WU-001')]),
      invokeUnit: async ({ unit, routing, unitJobId }) => {
        seen.push(routing.modelKey);
        // A perfectly ordinary BLOCKED — the model just could not do the
        // work — with no permission_denials at all. This must stay BLOCKED
        // on Haiku, exactly as it always did before this fix, and go to
        // review as a real gap rather than being quietly promoted.
        return {
          error: null, structuredOutput: true, available: true,
          payload: blocked(unitJobId, unit, 'Could not determine the correct fix.'),
          permissionDenials: [],
        };
      },
    });

    assert.deepEqual(seen, ['haiku'], 'never retried on a stronger model without real evidence');
    const record = outcome.records.get('WU-001');
    assert.equal(record.state, 'BLOCKED');
    assert.equal(record.escalations, 0);
    assert.equal(record.model, 'haiku');

    const escalated = (await store.readEvents()).filter((event) => event.type === 'MODEL_ESCALATED');
    assert.equal(escalated.length, 0);
  });
});

test('a MECHANICAL unit that COMPLETES is never escalated even if permission_denials happened along the way', async () => {
  await withStore(async (store) => {
    // A unit can hit and recover from a transient denial within the same
    // attempt and still finish the job — permission_denials describes the
    // attempt's history, not its outcome, and only a BLOCKED outcome is ever
    // a candidate for this escalation.
    const outcome = await run(store, {
      plan: plan([mechanical('WU-001')]),
      invokeUnit: async ({ unit, unitJobId, validatePayload }) => ({
        error: null, structuredOutput: true, available: true,
        payload: (() => { validatePayload?.(completed(unitJobId, unit)); return completed(unitJobId, unit); })(),
        permissionDenials: PERMISSION_DENIALS,
      }),
    });

    const record = outcome.records.get('WU-001');
    assert.equal(record.state, 'COMPLETED');
    assert.equal(record.model, 'haiku');
    assert.equal(record.escalations, 0);
  });
});

// ===========================================================================
// 51. Sonnet -> Opus
// ===========================================================================

test('51. complexity discovered mid-unit escalates STANDARD to Opus', async () => {
  await withStore(async (store) => {
    const seen = [];
    const outcome = await run(store, {
      plan: plan([standard('WU-001')]),
      invokeUnit: async ({ unit, routing, unitJobId, validatePayload }) => {
        seen.push(routing.modelKey);
        if (routing.modelKey === 'sonnet') {
          return ok(escalates(unitJobId, unit, 'STATE_INCONSISTENCY', [
            'a reconciliação lê o ponteiro antes do lease e pode materializar duas attempts',
          ]));
        }
        return ok(completed(unitJobId, unit), validatePayload);
      },
    });

    assert.deepEqual(seen, ['sonnet', 'opus']);
    assert.equal(outcome.records.get('WU-001').tier, 'COMPLEX');
    assert.equal(outcome.telemetry.modelCalls.opus, 1);
  });
});

// ===========================================================================
// 52. Context slicing
// ===========================================================================

test('52. a unit receives its own context and not the round\'s', async () => {
  await withStore(async (store) => {
    const packets = new Map();

    await run(store, {
      plan: plan([
        standard('WU-001', {
          expectedFiles: ['src/notifications/types.ts'],
          acceptanceCriteria: ['tipos existem'],
        }),
        standard('WU-002', {
          dependencies: ['WU-001'],
          relevantFiles: ['src/orders/service.ts'],
          acceptanceCriteria: ['serviço envia'],
        }),
        standard('WU-003', {
          expectedFiles: ['src/billing/invoice.ts'],
          acceptanceCriteria: ['fatura emitida'],
        }),
      ]),
      changedFilesSnapshot: fakeSnapshot([
        [], ['src/notifications/types.ts'],
        ['src/notifications/types.ts'], ['src/notifications/types.ts', 'src/notifications/service.ts'],
        ['src/notifications/types.ts', 'src/notifications/service.ts'],
        ['src/notifications/types.ts', 'src/notifications/service.ts', 'src/billing/invoice.ts'],
      ]),
      invokeUnit: async ({ unit, packet, unitJobId, validatePayload }) => {
        packets.set(unit.id, packet);
        return ok(completed(unitJobId, unit, {
          changedFiles: unit.id === 'WU-002' ? ['src/notifications/service.ts'] : [],
        }), validatePayload);
      },
    });

    const second = packets.get('WU-002');

    // What it DOES get: its own objective, its own criteria, its dependency's
    // summary and the files that dependency actually changed.
    assert.equal(second.workUnit.id, 'WU-002');
    assert.deepEqual([...second.workUnit.acceptanceCriteria], ['serviço envia']);
    assert.equal(second.dependenciesCompleted.length, 1);
    assert.equal(second.dependenciesCompleted[0].id, 'WU-001');
    assert.ok(second.relevantFiles.includes('src/orders/service.ts'));
    assert.ok(
      second.relevantFiles.includes('src/notifications/types.ts'),
      'a dependency\'s real output is the most reliable pointer there is',
    );

    // What it does NOT get: a sibling's WORK. Its report, its summary, its
    // objective and its attempt history all stay where they were produced.
    //
    // A sibling's FILE PATHS may now reach it, and only through the findings
    // ledger — the deliberate, bounded relaxation this invariant took so that
    // a unit stops re-deriving what the unit before it just opened. The line
    // moved from "no trace of another unit" to "no other unit's reasoning",
    // and that is what is asserted here.
    const flattened = JSON.stringify(second);
    assert.ok(!flattened.includes('relatório de WU-001'), 'a dependency\'s full report is summarised, not shipped');

    const withoutLedger = JSON.stringify({ ...second, findingsLedger: [] });
    assert.ok(!withoutLedger.includes('WU-003'), 'outside the ledger, an unrelated unit leaves no trace');

    // WU-003 runs before WU-002 (it has no dependencies), so what it touched
    // is what the ledger has to offer here.
    const sibling = second.findingsLedger.find((entry) => entry.by.includes('WU-003'));
    assert.ok(sibling, 'a sibling\'s file IS carried — that is the point of the ledger');
    assert.deepEqual(Object.keys(sibling).sort(), ['by', 'file', 'touch'],
      'as a path, a touch and unit ids — never prose, never a report');
    assert.equal(sibling.touch, 'CHANGED', 'collected from git, not claimed by the unit');

    // A unit with no dependencies gets no dependency context at all.
    assert.equal(packets.get('WU-001').dependenciesCompleted.length, 0);

    // The Goal is pointed at, not pasted: exploration stays possible.
    assert.equal(second.goalPath, 'docs/migration/goals/008-x.md');
    assert.equal(second.goalSummary, 'resumo curto do Goal');
  });
});

// ===========================================================================
// 53. Context expansion
// ===========================================================================

test('53. a unit that says its context is too narrow gets a wider one and continues', async () => {
  await withStore(async (store) => {
    const packets = [];
    const outcome = await run(store, {
      plan: plan([standard('WU-001', { relevantFiles: ['src/a.ts'] })]),
      invokeUnit: async ({ unit, packet, unitJobId, validatePayload }) => {
        packets.push(packet);
        if (packets.length === 1) {
          return ok(asksForContext(unitJobId, unit, ['src/contracts/notification.ts']));
        }
        return ok(completed(unitJobId, unit), validatePayload);
      },
    });

    assert.equal(packets.length, 2);
    assert.deepEqual([...packets[0].expandedContext], []);
    assert.deepEqual([...packets[1].expandedContext], ['src/contracts/notification.ts']);

    const record = outcome.records.get('WU-001');
    assert.equal(record.state, 'COMPLETED');
    assert.equal(record.contextExpansions, 1);
    assert.equal(record.escalations, 0, 'more context is not the same as a bigger model');
    assert.equal(outcome.telemetry.contextExpansions, 1);

    const events = await store.readEvents();
    const expanded = events.filter((event) => event.type === 'WORK_UNIT_CONTEXT_EXPANDED');
    assert.equal(expanded.length, 1);
    assert.equal(expanded[0].workUnitId, 'WU-001');
    assert.equal(expanded[0].reason, 'MISSING_TYPE_OR_CONTRACT');
    assert.deepEqual(expanded[0].added, ['src/contracts/notification.ts']);

    // The attempt that asked is preserved as its own attempt, on the same model.
    const state = await store.readAttemptState(WORK_UNIT_NAMESPACE, workUnitJobId({ goal: GOAL, round: ROUND, unitId: 'WU-001' }));
    assert.equal(state.attempt, 2);
    assert.equal(state.history[0].status, 'CONTEXT_EXPANDED');
  });
});

test('53. asking for context it already had is not granted', async () => {
  await withStore(async (store) => {
    const calls = [];
    const outcome = await run(store, {
      plan: plan([standard('WU-001', { relevantFiles: ['src/a.ts'] })]),
      invokeUnit: async ({ unit, unitJobId }) => {
        calls.push(unit.id);
        return ok(asksForContext(unitJobId, unit, ['src/a.ts']));
      },
    });

    assert.equal(calls.length, 1, 'a second attempt handing over the same files would learn nothing');
    assert.equal(outcome.records.get('WU-001').state, 'CONTEXT_EXPANSION_REQUIRED');
    assert.equal(outcome.aggregate.status, 'BLOCKED');
  });
});

test('53. expansion is bounded; at the budget the unit is not COMPLETED', async () => {
  await withStore(async (store) => {
    let call = 0;
    const outcome = await run(store, {
      plan: plan([standard('WU-001')]),
      config: { ...workUnitConfig({}), maxContextExpansions: 1 },
      invokeUnit: async ({ unit, unitJobId }) => {
        call += 1;
        return ok(asksForContext(unitJobId, unit, [`src/file-${call}.ts`]));
      },
    });

    assert.equal(call, 2, 'one expansion granted, then the answer stands');
    assert.equal(outcome.records.get('WU-001').state, 'CONTEXT_EXPANSION_REQUIRED');
    assert.equal(outcome.aggregate.status, 'BLOCKED');
  });
});

// ===========================================================================
// 54 / 55. DAG execution
// ===========================================================================

test('54. the DAG is executed in topological order', async () => {
  await withStore(async (store) => {
    const order = [];
    await run(store, {
      plan: plan([
        verify('VERIFY-001', { dependencies: ['WU-002'] }),
        standard('WU-002', { dependencies: ['WU-001'] }),
        standard('WU-001'),
      ]),
      runAction: async ({ unit }) => {
        order.push(unit.id);
        return fakeAction()({ unit });
      },
      invokeUnit: async ({ unit, unitJobId, validatePayload }) => {
        order.push(unit.id);
        return ok(completed(unitJobId, unit), validatePayload);
      },
    });

    assert.deepEqual(order, ['WU-001', 'WU-002', 'VERIFY-001']);
  });
});

test('55. independent units are scheduled on the same level and both run', async () => {
  await withStore(async (store) => {
    const executed = [];
    const built = plan([
      standard('WU-001'),
      standard('WU-002', { dependencies: ['WU-001'] }),
      standard('WU-003', { dependencies: ['WU-001'] }),
      standard('WU-004', { dependencies: ['WU-002', 'WU-003'] }),
    ]);

    assert.deepEqual(built.levels.map((level) => [...level]), [['WU-001'], ['WU-002', 'WU-003'], ['WU-004']]);

    await run(store, {
      plan: built,
      invokeUnit: async ({ unit, unitJobId, validatePayload }) => {
        executed.push(unit.id);
        return ok(completed(unitJobId, unit), validatePayload);
      },
    });

    // Serial today, by design: correctness first. What the DAG guarantees is
    // that WU-004 comes after both of its dependencies, whichever order the
    // scheduler picks for the pair.
    assert.equal(executed.length, 4);
    assert.equal(executed[0], 'WU-001');
    assert.equal(executed[3], 'WU-004');
    assert.deepEqual(executed.slice(1, 3).sort(), ['WU-002', 'WU-003']);
  });
});

test('a unit whose dependency failed is BLOCKED, never attempted', async () => {
  await withStore(async (store) => {
    const attempted = [];
    const outcome = await run(store, {
      plan: plan([standard('WU-001'), standard('WU-002', { dependencies: ['WU-001'] })]),
      invokeUnit: async ({ unit, unitJobId, validatePayload }) => {
        attempted.push(unit.id);
        if (unit.id === 'WU-001') {
          return ok({
            ...completed(unitJobId, unit),
            status: 'BLOCKED',
            acceptance: [],
            blockedReason: 'a migration necessária não existe',
          }, validatePayload);
        }
        return ok(completed(unitJobId, unit), validatePayload);
      },
    });

    assert.deepEqual(attempted, ['WU-001'], 'nothing was spent on a unit that could not run');
    assert.equal(outcome.records.get('WU-002').state, 'BLOCKED');
    assert.equal(outcome.aggregate.status, 'BLOCKED');
    const blocked = (await store.readEvents()).filter((event) => event.type === 'WORK_UNIT_BLOCKED');
    assert.deepEqual(blocked[0].blockedBy, ['WU-001']);
  });
});

// ===========================================================================
// 30 / 31. A failed verification earns a corrective unit
// ===========================================================================

test('30. a failed verification creates a FIX unit and re-runs the verification', async () => {
  await withStore(async (store) => {
    const executed = [];
    let verifyRuns = 0;

    const outcome = await run(store, {
      plan: plan([
        standard('WU-001', { expectedFiles: ['src/notifications/service.ts'] }),
        verify('VERIFY-001', { dependencies: ['WU-001'] }),
      ]),
      changedFilesSnapshot: fakeSnapshot([[], ['src/notifications/service.ts']]),
      runAction: async ({ unit }) => {
        executed.push(unit.id);
        verifyRuns += 1;
        return fakeAction({
          ok: verifyRuns > 1,
          stderr: 'src/notifications/service.ts(12,3): error TS2345: Argument of type ...',
        })({ unit });
      },
      invokeUnit: async ({ unit, unitJobId, validatePayload }) => {
        executed.push(unit.id);
        return ok(completed(unitJobId, unit, {
          changedFiles: unit.id === 'WU-001' ? ['src/notifications/service.ts'] : [],
        }), validatePayload);
      },
    });

    assert.deepEqual(executed, ['WU-001', 'VERIFY-001', 'FIX-001', 'VERIFY-001']);
    assert.equal(outcome.aggregate.status, 'REVIEW_REQUIRED');
    assert.equal(outcome.telemetry.dynamicUnits.length, 1);

    // 31: the failure is attributed to the unit whose files it names, and the
    // corrective unit is STANDARD — not Opus.
    const events = await store.readEvents();
    const failure = events.find((event) => event.type === 'WORK_UNIT_VERIFICATION_FAILED');
    assert.equal(failure.attributedTo, 'WU-001');
    assert.equal(failure.ambiguous, false);
    const created = events.find((event) => event.type === 'WORK_UNIT_FIX_CREATED');
    assert.equal(created.workUnitId, 'FIX-001');
    assert.equal(outcome.records.get('FIX-001').model, 'sonnet');
  });
});

test('31. an unattributable failure produces a DIAGNOSIS unit, not a confident accusation', async () => {
  await withStore(async (store) => {
    let verifyRuns = 0;
    const outcome = await run(store, {
      plan: plan([standard('WU-001'), verify('VERIFY-001', { dependencies: ['WU-001'] })]),
      runAction: async ({ unit }) => {
        verifyRuns += 1;
        return fakeAction({ ok: verifyRuns > 1, stderr: 'algo quebrou, sem caminho de arquivo' })({ unit });
      },
      invokeUnit: async ({ unit, unitJobId, validatePayload }) => ok(completed(unitJobId, unit), validatePayload),
    });

    assert.ok(outcome.records.has('DIAG-001'));
    assert.equal(outcome.records.get('DIAG-001').type, 'STANDARD');
    const failure = (await store.readEvents()).find((event) => event.type === 'WORK_UNIT_VERIFICATION_FAILED');
    assert.equal(failure.attributedTo, null);
  });
});

test('the fix loop is bounded: a verification that stays red stops the round', async () => {
  await withStore(async (store) => {
    let verifyRuns = 0;
    const outcome = await run(store, {
      plan: plan([standard('WU-001'), verify('VERIFY-001', { dependencies: ['WU-001'] })]),
      config: { ...workUnitConfig({}), maxFixUnitsPerVerification: 1, maxFixUnitsPerRound: 4 },
      runAction: async ({ unit }) => {
        verifyRuns += 1;
        return fakeAction({ ok: false, stderr: 'ainda vermelho' })({ unit });
      },
      invokeUnit: async ({ unit, unitJobId, validatePayload }) => ok(completed(unitJobId, unit), validatePayload),
    });

    assert.equal(verifyRuns, 2, 'one fix, one re-run, then it stops');
    assert.equal(outcome.aggregate.status, 'BLOCKED');
  });
});

// ===========================================================================
// 56 / 57. Restart and idempotency
// ===========================================================================

test('56. a restart does not re-run a unit whose result is already on disk', async () => {
  await withStore(async (store) => {
    const built = plan([standard('WU-001'), standard('WU-002', { dependencies: ['WU-001'] })]);

    // First process: WU-001 completes, then the process dies during WU-002.
    const firstRun = [];
    await assert.rejects(() => run(store, {
      plan: built,
      invokeUnit: async ({ unit, unitJobId, validatePayload }) => {
        firstRun.push(unit.id);
        if (unit.id === 'WU-002') throw new Error('process died');
        return ok(completed(unitJobId, unit), validatePayload);
      },
    }));
    assert.deepEqual(firstRun, ['WU-001', 'WU-002']);

    // Second process: same plan, same store, nothing else carried over.
    const secondRun = [];
    const outcome = await run(store, {
      plan: built,
      invokeUnit: async ({ unit, unitJobId, validatePayload }) => {
        secondRun.push(unit.id);
        return ok(completed(unitJobId, unit), validatePayload);
      },
    });

    assert.deepEqual(secondRun, ['WU-002'], 'WU-001 is not executed again');
    assert.equal(outcome.records.get('WU-001').reused, true);
    assert.equal(outcome.records.get('WU-001').state, 'COMPLETED');
    assert.equal(outcome.records.get('WU-002').state, 'COMPLETED');

    // WU-002 continued under the job it already had — same unit, same id, no
    // second job under a different name.
    const unitJob = workUnitJobId({ goal: GOAL, round: ROUND, unitId: 'WU-002' });
    const stored = await store.readJob(WORK_UNIT_NAMESPACE, unitJob);
    assert.equal(stored.workUnitId, 'WU-002');

    // Deliberately NOT asserted here: that the resume produced attempt 2.
    // Nothing has yet declared the crashed attempt interrupted, and the
    // executor must not decide that on its own — from inside this process a
    // crashed attempt and one still running in another process look identical.
    // That verdict belongs to the lease layer, and the next test is what it
    // looks like once it has been reached.
    const jobIds = await store.listJobs(WORK_UNIT_NAMESPACE);
    assert.equal(jobIds.length, 2, 'two units, two jobs — a resume adds none');
  });
});

test('56. once recovery declares the attempt interrupted, the unit resumes as attempt 2', async () => {
  await withStore(async (store) => {
    const built = plan([standard('WU-001')]);

    await assert.rejects(() => run(store, {
      plan: built,
      invokeUnit: async () => { throw new Error('process died'); },
    }));

    // What the lease layer concludes when it can prove the owner is gone.
    const unitJob = workUnitJobId({ goal: GOAL, round: ROUND, unitId: 'WU-001' });
    await store.setJobStatus(WORK_UNIT_NAMESPACE, unitJob, 'INTERRUPTED');

    const outcome = await run(store, {
      plan: built,
      invokeUnit: async ({ unit, unitJobId, validatePayload }) => ok(completed(unitJobId, unit), validatePayload),
    });

    assert.equal(outcome.records.get('WU-001').state, 'COMPLETED');
    const state = await store.readAttemptState(WORK_UNIT_NAMESPACE, unitJob);
    assert.equal(state.attempt, 2, 'a successor attempt, not a second job');
    assert.equal(state.history[0].attempt, 1);
    assert.equal(state.history[0].status, 'INTERRUPTED');
  });
});

test('56. a deterministic unit is not re-executed after a restart either', async () => {
  await withStore(async (store) => {
    const built = plan([verify('VERIFY-001')]);
    let runs = 0;
    const counting = async ({ unit }) => { runs += 1; return fakeAction()({ unit }); };

    await run(store, { plan: built, runAction: counting, invokeUnit: async () => { throw new Error('unreachable'); } });
    await run(store, { plan: built, runAction: counting, invokeUnit: async () => { throw new Error('unreachable'); } });

    assert.equal(runs, 1, 'a fifteen-minute build is not re-run because a process restarted');
  });
});

test('57. running the same plan repeatedly manufactures no extra attempt', async () => {
  await withStore(async (store) => {
    const built = plan([standard('WU-001'), verify('VERIFY-001', { dependencies: ['WU-001'] })]);
    const invoke = async ({ unit, unitJobId, validatePayload }) => ok(completed(unitJobId, unit), validatePayload);

    const first = await run(store, { plan: built, invokeUnit: invoke });
    const second = await run(store, { plan: built, invokeUnit: invoke });
    const third = await run(store, { plan: built, invokeUnit: invoke });

    for (const outcome of [first, second, third]) {
      assert.equal(outcome.aggregate.status, 'REVIEW_REQUIRED');
      assert.equal(outcome.records.size, 2);
    }

    const unitJob = workUnitJobId({ goal: GOAL, round: ROUND, unitId: 'WU-001' });
    const state = await store.readAttemptState(WORK_UNIT_NAMESPACE, unitJob);
    assert.equal(state.attempt, 1, 'one attempt, three reconciliations');

    const events = await store.readEvents();
    assert.equal(events.filter((event) => event.type === 'MODEL_ROUTED').length, 1);
    assert.equal(events.filter((event) => event.type === 'WORK_UNIT_DETERMINISTIC_EXECUTED').length, 1);
  });
});

// ===========================================================================
// 28. What a unit changed is decided by git
// ===========================================================================

test('28. a unit\'s changed files come from git, and an unconfirmed claim is reported', () => {
  const changes = collectUnitChanges({
    before: new Set(['src/a.ts']),
    after: new Set(['src/a.ts', 'src/b.ts']),
    reported: ['src/b.ts', 'src/a.ts', 'src/never-written.ts'],
  });

  assert.deepEqual(changes.delta, ['src/b.ts'], 'git alone is enough for a new file');
  assert.deepEqual(changes.confirmed, ['src/a.ts'], 'a file an earlier unit had already touched');
  assert.deepEqual(changes.unconfirmed, ['src/never-written.ts'], 'a claim git does not support is not silently dropped');
  assert.deepEqual(changes.changedFiles, ['src/a.ts', 'src/b.ts']);
});

// ===========================================================================
// The aggregate is the round's answer, under the round's contract
// ===========================================================================

test('the aggregate reports the DAG so the review can stay at Goal level', async () => {
  await withStore(async (store) => {
    const outcome = await run(store, {
      plan: plan([
        mechanical('WU-001'),
        standard('WU-002', { dependencies: ['WU-001'] }),
        verify('VERIFY-001', { dependencies: ['WU-002'] }),
      ]),
      invokeUnit: async ({ unit, unitJobId, validatePayload }) => ok(completed(unitJobId, unit), validatePayload),
    });

    const execution = outcome.aggregate.workUnitExecution;
    assert.equal(execution.units.length, 3);
    assert.deepEqual(execution.units.map((unit) => unit.executor), ['model', 'model', 'native']);
    assert.deepEqual(execution.units.map((unit) => unit.model), ['haiku', 'sonnet', null]);
    assert.equal(execution.telemetry.workUnitsTotal, 3);
    assert.equal(execution.telemetry.modelCalls.native, 1);

    // And it is a valid DeveloperResult, which is what lets the review, the
    // reconciler and the closure stay exactly as they were.
    assert.equal(outcome.aggregate.protocolVersion, PROTOCOL_VERSION_V2);
    assert.equal(outcome.aggregate.jobId, PARENT_JOB);
    assert.ok(outcome.aggregate.implementationReport.includes('WU-001'));
    assert.ok(outcome.aggregate.implementationReport.includes('VERIFY-001'));
  });
});

// ===========================================================================
// 43. Telemetry, derived from the event log rather than accumulated
// ===========================================================================

test('43. the routing summary counts the DAG, the models and the calls avoided', async () => {
  await withStore(async (store) => {
    await run(store, {
      plan: plan([
        mechanical('WU-001'),
        standard('WU-002', { dependencies: ['WU-001'] }),
        verify('VERIFY-001', { dependencies: ['WU-002'] }),
        verify('VERIFY-002', { action: 'git-diff-check', scope: undefined, dependencies: ['VERIFY-001'] }),
      ]),
      invokeUnit: async ({ unit, unitJobId, routing, validatePayload }) => {
        if (unit.id === 'WU-001' && routing.modelKey === 'haiku') {
          return ok(escalates(unitJobId, unit, 'PATTERN_INSUFFICIENT', ['sem padrão equivalente']));
        }
        return ok(completed(unitJobId, unit), validatePayload);
      },
    });

    const summary = summarizeRouting(await store.readEvents(), { goal: GOAL });

    assert.equal(summary.calls.haiku, 1);
    assert.equal(summary.calls.sonnet, 2, 'the escalated WU-001 plus WU-002');
    assert.equal(summary.calls.opus, 0);
    assert.equal(summary.calls.fable, 0);
    assert.equal(summary.escalations.length, 1);

    assert.equal(summary.workUnits.plans, 1);
    assert.deepEqual(summary.workUnits.byType, { MECHANICAL: 1, STANDARD: 1, DETERMINISTIC: 2 });
    assert.equal(summary.workUnits.deterministicRuns, 2);
    assert.equal(summary.workUnits.deterministicSuccesses, 2);
    assert.equal(summary.workUnits.deterministicFailures, 0);
    assert.equal(summary.workUnits.modelCallsAvoided, 2, 'two commands the old architecture would have paid a model for');

    // Each unit gets its own row instead of the last one standing in for the round.
    const unitRows = summary.stages.filter((stage) => stage.stage === 'work_unit');
    assert.equal(unitRows.length, 2, 'the two model units; deterministic units are not routed');
    assert.deepEqual(unitRows.map((row) => row.unit).sort(), ['WU-001', 'WU-002']);

    const rendered = renderRoutingSummary(summary).join('\n');
    assert.ok(rendered.includes('haiku 1'));
    assert.ok(rendered.includes('2 succeeded · 0 failed'));
    assert.ok(rendered.includes('model calls avoided (successful only): 2'));
    assert.ok(rendered.includes('Work Unit WU-001'));
  });
});

test('a DETERMINISTIC unit that fails every attempt is never counted as a model call avoided', async () => {
  // The Goal 011 shape exactly: 10 attempts at native `npm`/`npx` actions,
  // every one of them SPAWN_FAILED (Windows ENOENT), zero successes. The
  // old metric reported "model calls avoided: 10" — a Windows spawn bug
  // presented as a savings win, because it only ever counted attempts, never
  // outcomes.
  await withStore(async (store) => {
    // A realistic Goal also has at least one routed model call — otherwise
    // renderRoutingSummary takes its own "nothing routed at all" short
    // circuit before ever reaching the Work Units block, which is a
    // property of the renderer this test is not about.
    await store.appendEvent({
      type: 'MODEL_ROUTED', goal: GOAL, round: 1, agent: 'work_unit', jobId: `${GOAL}-r1-unit-wu-standard`,
      attempt: 1, attemptId: `${GOAL}-r1-unit-wu-standard-a1`, stage: 'work_unit',
      complexity: 'MEDIUM', selectedModel: 'sonnet', effort: 'high', reason: 'STANDARD_WORK_UNIT', mode: 'AUTO',
    });
    await store.appendEvent({
      type: 'WORK_UNIT_PLAN_RESOLVED', goal: GOAL, round: 1, jobId: `${GOAL}-r1-developer-x`,
      source: 'TECH_LEAD_PLAN', units: 10, order: [], levels: [], types: { DETERMINISTIC: 10 },
    });
    for (let i = 0; i < 10; i += 1) {
      await store.appendEvent({
        type: 'WORK_UNIT_DETERMINISTIC_EXECUTED',
        goal: GOAL, round: 1, workUnitId: `WU-${i}`, jobId: `${GOAL}-r1-unit-wu-${i}`,
        action: 'lint', ok: false, exitCode: null, signal: null, durationMs: 3, modelCalls: 0,
      });
    }

    const summary = summarizeRouting(await store.readEvents(), { goal: GOAL });
    assert.equal(summary.workUnits.deterministicRuns, 10, 'every attempt is still counted — a model genuinely was not called');
    assert.equal(summary.workUnits.deterministicFailures, 10);
    assert.equal(summary.workUnits.deterministicSuccesses, 0);
    assert.equal(summary.workUnits.modelCallsAvoided, 0, 'nothing was actually avoided: no check ran to completion');

    const rendered = renderRoutingSummary(summary).join('\n');
    assert.ok(rendered.includes('10 attempt(s)'));
    assert.ok(rendered.includes('0 succeeded · 10 failed'));
    assert.ok(rendered.includes('model calls avoided (successful only): 0'));
  });
});

test('a mix of successful and failed DETERMINISTIC attempts only credits the successes', async () => {
  await withStore(async (store) => {
    await store.appendEvent({
      type: 'WORK_UNIT_PLAN_RESOLVED', goal: GOAL, round: 1, jobId: `${GOAL}-r1-developer-x`,
      source: 'TECH_LEAD_PLAN', units: 2, order: [], levels: [], types: { DETERMINISTIC: 2 },
    });
    await store.appendEvent({
      type: 'WORK_UNIT_DETERMINISTIC_EXECUTED', goal: GOAL, round: 1, workUnitId: 'WU-1',
      jobId: `${GOAL}-r1-unit-wu-1`, action: 'lint', ok: true, exitCode: 0, modelCalls: 0,
    });
    await store.appendEvent({
      type: 'WORK_UNIT_DETERMINISTIC_EXECUTED', goal: GOAL, round: 1, workUnitId: 'WU-2',
      jobId: `${GOAL}-r1-unit-wu-2`, action: 'typecheck', ok: false, exitCode: 1, modelCalls: 0,
    });

    const summary = summarizeRouting(await store.readEvents(), { goal: GOAL });
    assert.equal(summary.workUnits.deterministicRuns, 2);
    assert.equal(summary.workUnits.deterministicSuccesses, 1);
    assert.equal(summary.workUnits.deterministicFailures, 1);
    assert.equal(summary.workUnits.modelCallsAvoided, 1);
  });
});

test('43. a legacy run reports no Work Unit block rather than a row of zeros', async () => {
  await withStore(async (store) => {
    const summary = summarizeRouting(await store.readEvents(), { goal: GOAL });
    assert.equal(summary.workUnits, null);
    assert.ok(!renderRoutingSummary(summary).join('\n').includes('Work Units:'));
  });
});

test('a unit result that claims COMPLETED with an unmet criterion is refused by the contract', () => {
  assert.throws(
    () => validateWorkUnitResult({
      protocolVersion: PROTOCOL_VERSION_V2,
      jobId: 'x', goal: GOAL, round: ROUND, workUnitId: 'WU-001',
      status: 'COMPLETED', summary: 's', report: 'r',
      acceptance: [{ criterion: 'a', met: true }, { criterion: 'b', met: false }],
    }, { jobId: 'x', goal: GOAL, round: ROUND, workUnitId: 'WU-001', acceptanceCriteria: ['a', 'b'] }),
    (error) => error.code === 'ACCEPTANCE_NOT_MET',
  );
});

test('a unit result that skips a criterion cannot claim COMPLETED', () => {
  assert.throws(
    () => validateWorkUnitResult({
      protocolVersion: PROTOCOL_VERSION_V2,
      jobId: 'x', goal: GOAL, round: ROUND, workUnitId: 'WU-001',
      status: 'COMPLETED', summary: 's', report: 'r',
      acceptance: [{ criterion: 'a', met: true }],
    }, { jobId: 'x', goal: GOAL, round: ROUND, workUnitId: 'WU-001', acceptanceCriteria: ['a', 'b'] }),
    (error) => error.code === 'ACCEPTANCE_INCOMPLETE',
  );
});
