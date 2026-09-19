/**
 * Whether this Goal's tree was ever verified, answered across every round.
 *
 * These tests pin the two real incidents the field exists for:
 *
 *   - Goal019 declared seven gates, ran one, and was accepted on round 4 with
 *     `validations: []`;
 *   - Goal018 ran its gates green in round 1 and was accepted in round 3, also
 *     with `validations: []`, because a correction round is one unit and
 *     declares no gates at all.
 *
 * Both read as "nothing to report". Neither was.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GATE_OUTCOMES,
  deriveGoalGateStatus,
  summarizeGoalGateStatus,
} from '../lib/goal-gate-status.mjs';

const executed = (round, workUnitId, action, over = {}) => ({
  type: 'WORK_UNIT_DETERMINISTIC_EXECUTED',
  goal: '019', round, workUnitId, action, ok: true, skipped: false, exitCode: 0, ...over,
});

const observedOn = (round, workUnitId, action, exitCode = 0) => ({
  type: 'WORK_UNIT_VERIFICATION_ON_INCOMPLETE_TREE',
  goal: '019', round, workUnitId, action, exitCode, passed: exitCode === 0,
});

const gate = (id, action, scope = null) => ({ id, action, scope });
const byId = (rows, id) => rows.find((row) => row.id === id);

// --- the Goal019 case ------------------------------------------------------

const GOAL019_GATES = [
  gate('VERIFY-001', 'typecheck'),
  gate('VERIFY-002', 'lint'),
  gate('VERIFY-004', 'validate-core'),
  gate('VERIFY-005', 'validate-integration'),
  gate('VERIFY-006', 'validate-ui'),
];

test('a declared gate that never executed in any round is NEVER_RAN, not absent', () => {
  const rows = deriveGoalGateStatus({
    declaredGates: GOAL019_GATES,
    events: [executed(1, 'VERIFY-003', 'tooling-tests')],
    currentRound: 4,
  });

  for (const { id } of GOAL019_GATES) {
    assert.equal(byId(rows, id).outcome, GATE_OUTCOMES.NEVER_RAN, `${id} never ran`);
  }
  // A gate that ran without being declared is still a fact about this tree.
  assert.equal(byId(rows, 'VERIFY-003').outcome, GATE_OUTCOMES.PASSED);
});

test('the summary says it in words, because a list of NEVER_RAN can be skimmed', () => {
  const summary = summarizeGoalGateStatus(deriveGoalGateStatus({
    declaredGates: GOAL019_GATES,
    events: [executed(1, 'VERIFY-003', 'tooling-tests')],
    currentRound: 4,
  }));

  assert.match(summary, /5 NUNCA rodou/);
  assert.match(summary, /não rodou não é um gate que passou/);
});

// --- one row per UNIT, which is why the keying changed --------------------

test('three typecheck units are three rows: one app green never answers for another', () => {
  const rows = deriveGoalGateStatus({
    declaredGates: [
      gate('VERIFY-001', 'typecheck', 'apps/bff'),
      gate('VERIFY-002', 'typecheck', 'apps/ai-orchestrator'),
      gate('VERIFY-003', 'typecheck', 'apps/frontend'),
    ],
    events: [executed(1, 'VERIFY-001', 'typecheck')],
    currentRound: 1,
  });

  assert.equal(rows.length, 3);
  assert.equal(byId(rows, 'VERIFY-001').outcome, GATE_OUTCOMES.PASSED);
  assert.equal(byId(rows, 'VERIFY-002').outcome, GATE_OUTCOMES.NEVER_RAN);
  assert.equal(byId(rows, 'VERIFY-003').outcome, GATE_OUTCOMES.NEVER_RAN);
  assert.equal(byId(rows, 'VERIFY-002').scope, 'apps/ai-orchestrator', 'the scope says which app');
});

// --- the Goal018 case: green, but about an older tree ---------------------

test('a gate that passed in an earlier round is carried, with how stale it is', () => {
  const rows = deriveGoalGateStatus({
    declaredGates: [gate('VERIFY-001', 'typecheck')],
    events: [executed(1, 'VERIFY-001', 'typecheck')],
    currentRound: 3,
  });

  const row = byId(rows, 'VERIFY-001');
  assert.equal(row.outcome, GATE_OUTCOMES.PASSED);
  assert.equal(row.round, 1);
  assert.equal(row.roundsStale, 2, 'the tree moved twice after this gate spoke');
});

test('a gate answering about the tree under review is not stale', () => {
  const rows = deriveGoalGateStatus({
    declaredGates: [gate('VERIFY-001', 'typecheck')],
    events: [executed(2, 'VERIFY-001', 'typecheck')],
    currentRound: 2,
  });
  assert.equal(byId(rows, 'VERIFY-001').roundsStale, 0);
});

// --- the outcomes it distinguishes ----------------------------------------

test('a red gate is FAILED and carries its exit code', () => {
  const rows = deriveGoalGateStatus({
    declaredGates: [gate('VERIFY-004', 'validate-core')],
    events: [executed(1, 'VERIFY-004', 'validate-core', { ok: false, exitCode: 1 })],
    currentRound: 1,
  });

  const row = byId(rows, 'VERIFY-004');
  assert.equal(row.outcome, GATE_OUTCOMES.FAILED);
  assert.equal(row.exitCode, 1);
});

test('a gate the harness could not set up is SKIPPED, which is not FAILED', () => {
  const rows = deriveGoalGateStatus({
    declaredGates: [gate('VERIFY-005', 'validate-integration')],
    events: [executed(1, 'VERIFY-005', 'validate-integration', { ok: false, skipped: true, exitCode: null })],
    currentRound: 1,
  });
  assert.equal(byId(rows, 'VERIFY-005').outcome, GATE_OUTCOMES.SKIPPED);
});

test('a green gate over an incomplete tree is OBSERVED, never PASSED', () => {
  const rows = deriveGoalGateStatus({
    declaredGates: [gate('VERIFY-001', 'typecheck')],
    events: [
      executed(1, 'VERIFY-001', 'typecheck', { ok: true, exitCode: 0 }),
      observedOn(1, 'VERIFY-001', 'typecheck', 0),
    ],
    currentRound: 1,
  });

  assert.equal(
    byId(rows, 'VERIFY-001').outcome,
    GATE_OUTCOMES.OBSERVED,
    'exiting 0 over a tree an upstream unit never built is not acceptance',
  );
});

test('the downgrade is per run, so the same gate green in a later round is PASSED', () => {
  const rows = deriveGoalGateStatus({
    declaredGates: [gate('VERIFY-001', 'typecheck')],
    events: [
      executed(1, 'VERIFY-001', 'typecheck'),
      observedOn(1, 'VERIFY-001', 'typecheck'),
      executed(2, 'VERIFY-001', 'typecheck'),
    ],
    currentRound: 2,
  });

  const row = byId(rows, 'VERIFY-001');
  assert.equal(row.outcome, GATE_OUTCOMES.PASSED);
  assert.equal(row.round, 2);
});

// --- the most recent run is the one that answers --------------------------

test('a gate re-run after a corrective unit reports the LATEST round, not the first', () => {
  const rows = deriveGoalGateStatus({
    declaredGates: [gate('VERIFY-002', 'lint')],
    events: [
      executed(1, 'VERIFY-002', 'lint', { ok: false, exitCode: 1 }),
      executed(2, 'VERIFY-002', 'lint', { ok: true, exitCode: 0 }),
    ],
    currentRound: 2,
  });

  const row = byId(rows, 'VERIFY-002');
  assert.equal(row.outcome, GATE_OUTCOMES.PASSED, 'the newer tree is the one under review');
  assert.equal(row.round, 2);
});

// --- edges -----------------------------------------------------------------

test('a Goal that declared no gates says so rather than looking verified', () => {
  assert.match(summarizeGoalGateStatus([]), /não declarou nenhuma verificação/);
  assert.deepEqual(deriveGoalGateStatus({}), []);
});

test('events from other types and malformed rows are ignored without throwing', () => {
  const rows = deriveGoalGateStatus({
    declaredGates: [gate('VERIFY-001', 'typecheck'), null, { action: 'no-id' }],
    events: [
      { type: 'WORK_UNIT_BLOCKED', goal: '019', round: 1, workUnitId: 'VERIFY-001' },
      { type: 'MODEL_ROUTED', goal: '019', round: 1 },
      null,
      { type: 'WORK_UNIT_DETERMINISTIC_EXECUTED', goal: '019', round: 1 },
    ],
    currentRound: 1,
  });

  assert.equal(rows.length, 1, 'a gate with no id is not a gate');
  assert.equal(byId(rows, 'VERIFY-001').outcome, GATE_OUTCOMES.NEVER_RAN);
});

test('an all-green Goal reads as such, with no warning tacked on', () => {
  const summary = summarizeGoalGateStatus(deriveGoalGateStatus({
    declaredGates: [gate('VERIFY-001', 'typecheck'), gate('VERIFY-002', 'lint')],
    events: [executed(2, 'VERIFY-001', 'typecheck'), executed(2, 'VERIFY-002', 'lint')],
    currentRound: 2,
  }));

  assert.match(summary, /2 passou/);
  assert.doesNotMatch(summary, /NUNCA/);
  assert.doesNotMatch(summary, /não rodou não é um gate que passou/);
});
