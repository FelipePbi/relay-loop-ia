/**
 * A gate observes the tree; it does not build it.
 *
 * The scheduler used to read `VERIFY-001 depends on WU-004` as a condition —
 * if WU-004 did not complete, never typecheck at all. Goal019 is what that
 * cost: one refused escalation left eight of fifteen units with zero attempts,
 * six of them gates, and the reviewer went through 84 changed files across
 * three rounds with no typecheck, no lint and no suite in the packet. The only
 * way left to find a defect was Opus reading the diff by hand. It found real
 * ones, at the highest price the harness can charge.
 *
 * These tests pin both halves of the fix: the gate RUNS, and its answer is
 * never mistaken for acceptance.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJobStore } from '../lib/job-store.mjs';
import { LOOP_STATES } from '../lib/loop-state.mjs';
import { PROTOCOL_VERSION_V2 } from '../lib/contracts-v2.mjs';
import { validateExecutionPlan } from '../lib/work-units.mjs';
import { executeWorkUnitPlan } from '../lib/work-unit-executor.mjs';
import { workUnitConfig } from '../lib/work-unit-config.mjs';

const GOAL = '019';
const ROUND = 1;
const WORKTREE = '.ai-worktrees/goal-019';
const BASE = 'b'.repeat(40);
const job = { jobId: '019-r1-developer-bbbb2222', goal: GOAL, round: ROUND, worktree: WORKTREE };

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-gate-'));
  try {
    return await run(createJobStore(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

const ok = (payload, validatePayload) => {
  if (validatePayload) validatePayload(payload);
  return { error: null, structuredOutput: true, available: true, payload };
};

const answer = (unitJobId, unit, over = {}) => ({
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

const standard = (id, over = {}) => ({
  id,
  objective: `Implementar ${id}`,
  type: 'STANDARD',
  dependencies: [],
  acceptanceCriteria: [`${id} entregue`],
  ...over,
});

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

const fakeAction = ({ ok: passes = true } = {}) => async ({ unit }) => ({
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
  stdout: passes ? '' : 'apps/bff/src/app.ts(12,3): error TS2345',
  stderr: '',
});

const run = (store, over = {}) => executeWorkUnitPlan({
  store,
  job,
  goal: GOAL,
  round: ROUND,
  worktree: WORKTREE,
  executionBase: BASE,
  goalPath: 'docs/migration/goals/019-x.md',
  goalSummary: 'resumo curto do Goal',
  resumeFrom: LOOP_STATES.DEVELOPER_RUNNING,
  changedFilesSnapshot: async () => new Set(),
  runAction: fakeAction(),
  config: workUnitConfig({}),
  ...over,
});

/** A plan where WU-001 does not complete, and both kinds of unit wait on it. */
const cascade = () => validateExecutionPlan({
  goal: GOAL,
  workUnits: [
    standard('WU-001'),
    standard('WU-002', { dependencies: ['WU-001'] }),
    verify('VERIFY-001', { dependencies: ['WU-001'] }),
  ],
}, { goal: GOAL });

const failsFirstUnit = ({ unit, unitJobId, validatePayload }) => ok(
  unit.id === 'WU-001'
    ? answer(unitJobId, unit, {
      status: 'BLOCKED',
      acceptance: [],
      blockedReason: 'a migration necessária não existe',
      changedFiles: ['apps/bff/src/app.ts'],
    })
    : answer(unitJobId, unit),
  validatePayload,
);

// --- the gate runs ---------------------------------------------------------

test('a gate whose dependency did not complete still runs, and reaches the reviewer', async () => {
  await withStore(async (store) => {
    let gateRuns = 0;
    const outcome = await run(store, {
      plan: cascade(),
      invokeUnit: failsFirstUnit,
      runAction: async (args) => {
        gateRuns += 1;
        return fakeAction()(args);
      },
    });

    assert.equal(gateRuns, 1, 'the typecheck actually ran over the half-built tree');
    assert.equal(outcome.records.get('VERIFY-001').state, 'OBSERVED');
    assert.deepEqual(outcome.records.get('VERIFY-001').incompleteTree, ['WU-001']);

    // The whole point: the reviewer no longer gets an empty validations list.
    assert.equal(outcome.aggregate.validations.length, 1);
  });
});

test('a gate that fails over an incomplete tree reports the failure rather than hiding it', async () => {
  await withStore(async (store) => {
    const outcome = await run(store, {
      plan: cascade(),
      invokeUnit: failsFirstUnit,
      runAction: fakeAction({ ok: false }),
    });

    const [validation] = outcome.aggregate.validations;
    assert.equal(validation.passed, false);
    assert.match(validation.detail, /exit 1/);
  });
});

// --- and is never mistaken for acceptance ---------------------------------

test('a green gate over an incomplete tree is OBSERVED, never COMPLETED', async () => {
  await withStore(async (store) => {
    const outcome = await run(store, { plan: cascade(), invokeUnit: failsFirstUnit });

    const record = outcome.records.get('VERIFY-001');
    assert.equal(record.exitCode, 0, 'the command itself was green');
    assert.notEqual(record.state, 'COMPLETED', 'which is exactly what must not be recorded as done');
    assert.equal(record.state, 'OBSERVED');
  });
});

test('the caveat rides in the validation name, where nothing reading the packet can miss it', async () => {
  await withStore(async (store) => {
    const outcome = await run(store, { plan: cascade(), invokeUnit: failsFirstUnit });

    const [validation] = outcome.aggregate.validations;
    assert.match(validation.name, /árvore incompleta/);
    assert.match(validation.name, /WU-001/);
    assert.match(validation.detail, /não é veredito/);
  });
});

test('an OBSERVED gate creates no fix unit, because the fault may be the work that never ran', async () => {
  await withStore(async (store) => {
    const outcome = await run(store, {
      plan: cascade(),
      invokeUnit: failsFirstUnit,
      runAction: fakeAction({ ok: false }),
    });

    assert.deepEqual(outcome.telemetry.dynamicUnits, [], 'no FIX unit chased a symptom');
    const events = await store.readEvents();
    assert.equal(events.filter((event) => event.type === 'WORK_UNIT_FIX_CREATED').length, 0);
  });
});

test('it is recorded under its own event, with what the gate said and what it waited on', async () => {
  await withStore(async (store) => {
    await run(store, { plan: cascade(), invokeUnit: failsFirstUnit });

    const events = await store.readEvents();
    const [observed] = events.filter((event) => event.type === 'WORK_UNIT_VERIFICATION_ON_INCOMPLETE_TREE');
    assert.ok(observed, 'the round says which gates were merely observed');
    assert.equal(observed.workUnitId, 'VERIFY-001');
    assert.deepEqual(observed.blockedBy, ['WU-001']);
    assert.equal(observed.passed, true);
    assert.equal(observed.exitCode, 0);
  });
});

// --- what did NOT change ---------------------------------------------------

test('a MODEL unit whose dependency did not complete is still BLOCKED, never attempted', async () => {
  await withStore(async (store) => {
    const attempted = [];
    const outcome = await run(store, {
      plan: cascade(),
      invokeUnit: (args) => {
        attempted.push(args.unit.id);
        return failsFirstUnit(args);
      },
    });

    assert.deepEqual(attempted, ['WU-001'], 'relaxing the gate must not relax the model units');
    assert.equal(outcome.records.get('WU-002').state, 'BLOCKED');
    const events = await store.readEvents();
    assert.deepEqual(
      events.filter((event) => event.type === 'WORK_UNIT_BLOCKED').map((event) => event.workUnitId),
      ['WU-002'],
    );
  });
});

test('a gate whose dependencies all completed is untouched by any of this', async () => {
  await withStore(async (store) => {
    const outcome = await run(store, {
      plan: validateExecutionPlan({
        goal: GOAL,
        workUnits: [standard('WU-001'), verify('VERIFY-001', { dependencies: ['WU-001'] })],
      }, { goal: GOAL }),
      invokeUnit: ({ unit, unitJobId, validatePayload }) => ok(answer(unitJobId, unit), validatePayload),
    });

    const record = outcome.records.get('VERIFY-001');
    assert.equal(record.state, 'COMPLETED');
    assert.equal(record.incompleteTree, undefined);
    assert.deepEqual(
      outcome.aggregate.validations.map((entry) => [entry.name, entry.passed]),
      [['typecheck', true]],
    );
    assert.equal(outcome.aggregate.status, 'REVIEW_REQUIRED');
  });
});
