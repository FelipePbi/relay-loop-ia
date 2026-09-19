/**
 * A unit that asks for a model the table does not have.
 *
 * Refusing the request is right — there IS nothing above COMPLEX, and putting
 * a tier there would be a human's decision. What was wrong was ENDING the unit
 * over it: in Goal019 one such refusal published ESCALATION_REQUIRED as a
 * COMPLEX unit's answer, and the eight units behind it ended the round with
 * zero attempts.
 *
 * So the refusal stays and the unit is told, once, that the ceiling is real.
 * These tests pin that the telling happens, that it is bounded, and that it is
 * never confused with the two things it sits between: changing the model, and
 * changing the context.
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
import { buildWorkUnitContextPacket, buildWorkUnitPrompt } from '../lib/work-unit-context.mjs';
import { authorizeWorkUnitEscalation } from '../lib/model-routing.mjs';

const GOAL = '019';
const ROUND = 1;
const WORKTREE = '.ai-worktrees/goal-019';
const BASE = 'c'.repeat(40);
const job = { jobId: '019-r1-developer-cccc3333', goal: GOAL, round: ROUND, worktree: WORKTREE };

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-ceiling-'));
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

const base = (unitJobId, unit) => ({
  protocolVersion: PROTOCOL_VERSION_V2,
  jobId: unitJobId,
  goal: GOAL,
  round: ROUND,
  workUnitId: unit.id,
});

const escalates = (unitJobId, unit) => ({
  ...base(unitJobId, unit),
  status: 'ESCALATION_REQUIRED',
  summary: `${unit.id} atravessa módulos que o plano não previu`,
  report: 'a mudança cruza scheduling e ai-orchestrator',
  escalation: {
    reason: 'CROSS_MODULE_IMPACT_DISCOVERED',
    confidence: 'HIGH',
    detail: 'a remoção toca duas FKs com ON DELETE RESTRICT',
    evidence: ['prisma/schema.prisma:514 referencia Appointment com onDelete: Restrict'],
  },
});

const delivers = (unitJobId, unit, over = {}) => ({
  ...base(unitJobId, unit),
  status: 'COMPLETED',
  summary: `${unit.id} entregue`,
  report: 'feito',
  changedFiles: [],
  acceptance: unit.acceptanceCriteria.map((criterion) => ({ criterion, met: true })),
  ...over,
});

const complex = (id, over = {}) => ({
  id,
  objective: `Implementar ${id}`,
  type: 'COMPLEX',
  dependencies: [],
  acceptanceCriteria: [`${id} entregue`],
  ...over,
});

const standard = (id, over = {}) => complex(id, { type: 'STANDARD', ...over });

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
  runAction: async () => { throw new Error('no deterministic unit in these plans'); },
  config: workUnitConfig({}),
  ...over,
});

// --- the verdict says WHY, machine-readably --------------------------------

test('running out of table is flagged, not merely phrased', () => {
  const verdict = authorizeWorkUnitEscalation({
    currentTier: 'COMPLEX',
    request: { reason: 'CROSS_MODULE_IMPACT_DISCOVERED', evidence: ['schema.prisma:514'] },
  });

  assert.equal(verdict.verdict, 'REFUSED');
  assert.equal(verdict.atTopOfTable, true);
});

test('every other refusal is the unit asking badly, and is NOT flagged', () => {
  const noEvidence = authorizeWorkUnitEscalation({
    currentTier: 'STANDARD',
    request: { reason: 'CROSS_MODULE_IMPACT_DISCOVERED', evidence: [] },
  });
  assert.equal(noEvidence.verdict, 'REFUSED');
  assert.notEqual(noEvidence.atTopOfTable, true, 'asking without evidence is the unit\'s fault');

  const badReason = authorizeWorkUnitEscalation({
    currentTier: 'STANDARD',
    request: { reason: 'NOT_A_REAL_REASON', evidence: ['alguma coisa'] },
  });
  assert.equal(badReason.verdict, 'REFUSED');
  assert.notEqual(badReason.atTopOfTable, true);
});

// --- the unit is told, and gets one more attempt ---------------------------

test('a COMPLEX unit refused at the top of the table is not ended; it runs again', async () => {
  await withStore(async (store) => {
    const seen = [];
    const outcome = await run(store, {
      plan: validateExecutionPlan({ goal: GOAL, workUnits: [complex('WU-001')] }, { goal: GOAL }),
      invokeUnit: ({ unit, unitJobId, packet, validatePayload }) => {
        seen.push(packet.modelCeiling);
        return ok(
          seen.length === 1 ? escalates(unitJobId, unit) : delivers(unitJobId, unit),
          validatePayload,
        );
      },
    });

    assert.equal(seen.length, 2, 'the refusal bought an attempt instead of ending the unit');
    assert.equal(seen[0], null, 'the first attempt knows nothing about a ceiling it has not hit');
    assert.equal(seen[1].tier, 'COMPLEX');
    assert.equal(seen[1].requested, 'CROSS_MODULE_IMPACT_DISCOVERED');
    assert.match(seen[1].reason, /top of the table/);

    assert.equal(outcome.records.get('WU-001').state, 'COMPLETED');
  });
});

test('the unit that was told can now deliver half and name the other half', async () => {
  await withStore(async (store) => {
    let attempt = 0;
    // git confirms the file from the second snapshot on — a declared change
    // the tree does not have is not a change, and the executor is right to
    // drop it. Here the unit really did write it.
    let snapshots = 0;
    const outcome = await run(store, {
      changedFilesSnapshot: async () => {
        snapshots += 1;
        return snapshots === 1
          ? new Set()
          : new Set(['apps/ai-orchestrator/src/modules/activation-test/Cleanup.ts']);
      },
      plan: validateExecutionPlan({
        goal: GOAL,
        workUnits: [complex('WU-001', { acceptanceCriteria: ['a limpeza remove o que criou', 'a agenda fica limpa'] })],
      }, { goal: GOAL }),
      invokeUnit: ({ unit, unitJobId, validatePayload }) => {
        attempt += 1;
        if (attempt === 1) return ok(escalates(unitJobId, unit), validatePayload);
        return ok(delivers(unitJobId, unit, {
          status: 'BLOCKED',
          blockedReason: 'onDelete: Restrict impede a remoção; precisa de migration',
          changedFiles: ['apps/ai-orchestrator/src/modules/activation-test/Cleanup.ts'],
          acceptance: [
            { criterion: 'a limpeza remove o que criou', met: true },
            { criterion: 'a agenda fica limpa', met: false, detail: 'FK ON DELETE RESTRICT' },
          ],
        }), validatePayload);
      },
    });

    const record = outcome.records.get('WU-001');
    assert.equal(record.state, 'BLOCKED');
    // The point of the whole change: work reached the tree, and the reviewer
    // is told precisely what did not.
    assert.deepEqual(record.changedFiles, ['apps/ai-orchestrator/src/modules/activation-test/Cleanup.ts']);
    assert.deepEqual(record.acceptance.map((entry) => entry.met), [true, false]);
  });
});

// --- bounded ---------------------------------------------------------------

test('exactly one telling: a unit that asks again ends with its own answer', async () => {
  await withStore(async (store) => {
    let attempts = 0;
    const outcome = await run(store, {
      plan: validateExecutionPlan({ goal: GOAL, workUnits: [complex('WU-001')] }, { goal: GOAL }),
      invokeUnit: ({ unit, unitJobId, validatePayload }) => {
        attempts += 1;
        return ok(escalates(unitJobId, unit), validatePayload);
      },
    });

    assert.equal(attempts, 2, 'the second telling would carry nothing the first did not');
    assert.equal(outcome.records.get('WU-001').state, 'ESCALATION_REQUIRED');

    const events = await store.readEvents();
    assert.equal(events.filter((event) => event.type === 'WORK_UNIT_CEILING_DECLARED').length, 1);
    assert.equal(
      events.filter((event) => event.type === 'MODEL_ESCALATION_REFUSED').length,
      2,
      'both refusals stay on record; only the first buys an attempt',
    );
  });
});

test('a granted escalation still changes the model, and never becomes a retry in place', async () => {
  await withStore(async (store) => {
    const models = [];
    await run(store, {
      // STANDARD has a tier above it, so this request is AUTHORIZED — with a
      // reason STANDARD actually admits, which is a separate policy from the
      // ceiling and stays exactly as it was.
      plan: validateExecutionPlan({ goal: GOAL, workUnits: [standard('WU-001')] }, { goal: GOAL }),
      invokeUnit: ({ unit, unitJobId, routing, validatePayload }) => {
        models.push(routing.modelKey);
        return ok(
          models.length === 1
            ? {
              ...escalates(unitJobId, unit),
              escalation: {
                reason: 'COMPLEXITY_DISCOVERED',
                confidence: 'HIGH',
                detail: 'a mudança é maior do que o plano classificou',
                evidence: ['prisma/schema.prisma:514 referencia Appointment com onDelete: Restrict'],
              },
            }
            : delivers(unitJobId, unit),
          validatePayload,
        );
      },
    });

    assert.notEqual(models[0], models[1], 'the successor ran on a different model, as a reroute');
    const events = await store.readEvents();
    assert.equal(events.filter((event) => event.type === 'MODEL_ESCALATED').length, 1);
    assert.equal(
      events.filter((event) => event.type === 'WORK_UNIT_CEILING_DECLARED').length,
      0,
      'nothing here is a ceiling: the table had a tier above and the router used it',
    );
  });
});

// --- the telling is unmistakable in the prompt -----------------------------

test('the prompt stops inviting an escalation and asks for unmet criteria instead', () => {
  const unit = {
    id: 'WU-001',
    title: 'Limpeza',
    objective: 'Remover o que a execução criou',
    type: 'COMPLEX',
    complexity: 'HIGH',
    risk: 'HIGH',
    dependencies: [],
    acceptanceCriteria: ['a limpeza remove o que criou'],
    expectedFiles: [],
    relevantFiles: [],
    implementationHints: null,
  };
  const args = { goal: GOAL, goalPath: 'docs/x.md', round: ROUND, unit, worktree: WORKTREE };

  const before = buildWorkUnitPrompt(buildWorkUnitContextPacket(args), job);
  assert.match(before, /"ESCALATION_REQUIRED"/, 'an ordinary attempt may still ask');

  const after = buildWorkUnitPrompt(
    buildWorkUnitContextPacket({
      ...args,
      ceiling: { tier: 'COMPLEX', requested: 'CROSS_MODULE_IMPACT_DISCOVERED', reason: 'already at the top of the table' },
    }),
    job,
  );
  assert.match(after, /Não existe modelo acima deste/);
  assert.match(after, /met: false/);
  assert.match(after, /nunca "ESCALATION_REQUIRED" de novo/);
});
