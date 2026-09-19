/**
 * The Work Unit router — the table, as a pure function.
 *
 * What this file states: the executor is decided from what the PLAN declared,
 * with no model call anywhere, and the cheap tiers cannot be reached for work
 * that is not cheap. The integration side — real attempts, real store, a fake
 * CLI — lives in work-unit-execution.test.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ESCALATION_VERDICTS,
  MIN_ATTEMPTS_FOR_REPEATED_FAILURE,
  MODELS,
  ROUTING_MODES,
  ROUTING_STAGES,
  WORK_UNIT_ESCALATION,
  WORK_UNIT_ESCALATION_REASONS,
  WORK_UNIT_EXECUTORS,
  WORK_UNIT_ROUTING,
  authorizeWorkUnitEscalation,
  routeWorkUnit,
} from '../lib/model-routing.mjs';
import { validateWorkUnit } from '../lib/work-units.mjs';

const unit = (over = {}) => validateWorkUnit({
  id: 'WU-001',
  objective: 'Implementar o NotificationService',
  type: 'STANDARD',
  dependencies: [],
  acceptanceCriteria: ['entrega registrada'],
  ...over,
});

const deterministic = (over = {}) => validateWorkUnit({
  id: 'VERIFY-001',
  objective: 'Rodar o typecheck',
  type: 'DETERMINISTIC',
  action: 'typecheck',
  scope: 'apps/bff',
  dependencies: [],
  acceptanceCriteria: [],
  ...over,
});

// ===========================================================================
// 47. The table
// ===========================================================================

test('47. DETERMINISTIC routes to no model at all', () => {
  const routed = routeWorkUnit({ unit: deterministic() });
  assert.equal(routed.executor, WORK_UNIT_EXECUTORS.NATIVE);
  assert.equal(routed.routing, null, 'there is no model decision to persist, because there is no model');
  assert.equal(routed.action, 'typecheck');
  assert.equal(routed.reason, 'DETERMINISTIC_WORK_UNIT');
});

test('47. MECHANICAL routes to Haiku', () => {
  const routed = routeWorkUnit({ unit: unit({ type: 'MECHANICAL' }) });
  assert.equal(routed.executor, WORK_UNIT_EXECUTORS.MODEL);
  assert.equal(routed.routing.modelKey, 'haiku');
  assert.equal(routed.routing.model, MODELS.haiku.model);
  assert.equal(routed.routing.effort, 'high');
  assert.equal(routed.reason, 'MECHANICAL_WORK_UNIT');
});

test('47. STANDARD routes to Sonnet', () => {
  const routed = routeWorkUnit({ unit: unit({ type: 'STANDARD' }) });
  assert.equal(routed.routing.modelKey, 'sonnet');
  assert.equal(routed.routing.effort, 'high');
});

test('47. COMPLEX routes to Opus', () => {
  const routed = routeWorkUnit({ unit: unit({ type: 'COMPLEX' }) });
  assert.equal(routed.routing.modelKey, 'opus');
  assert.equal(routed.routing.effort, 'high');
});

test('47. every routed decision carries the reason that produced it', () => {
  for (const type of ['MECHANICAL', 'STANDARD', 'COMPLEX']) {
    const routed = routeWorkUnit({ unit: unit({ type }) });
    assert.equal(routed.routing.stage, ROUTING_STAGES.WORK_UNIT);
    assert.ok(routed.routing.reason, `${type} carries a reason`);
    assert.ok(routed.routing.signals.includes(type));
  }
});

test('no work unit routing ever selects max effort', () => {
  for (const entry of Object.values(WORK_UNIT_ROUTING)) {
    assert.notEqual(entry.effort, 'max', 'max stays a human decision, not the router\'s');
  }
});

test('Opus is the top of the table and has nothing to fall back to', () => {
  assert.equal(routeWorkUnit({ unit: unit({ type: 'COMPLEX' }) }).routing.fallbackAllowed, false);
  assert.equal(routeWorkUnit({ unit: unit({ type: 'MECHANICAL' }) }).routing.fallbackAllowed, true);
  assert.equal(routeWorkUnit({ unit: unit({ type: 'STANDARD' }) }).routing.fallbackAllowed, true);
});

// ===========================================================================
// The risk floor: Haiku never decides architecture
// ===========================================================================

test('a MECHANICAL unit marked HIGH risk is not run on the cheap model', () => {
  const routed = routeWorkUnit({ unit: unit({ type: 'MECHANICAL', risk: 'HIGH' }) });
  assert.equal(routed.routing.modelKey, 'sonnet');
  assert.equal(routed.tier, 'STANDARD');
  assert.equal(routed.reason, 'MECHANICAL_RISK_FLOOR', 'the promotion is visible, not silent');
});

test('a MECHANICAL unit marked HIGH complexity is promoted too', () => {
  const routed = routeWorkUnit({ unit: unit({ type: 'MECHANICAL', complexity: 'HIGH' }) });
  assert.equal(routed.routing.modelKey, 'sonnet');
  assert.equal(routed.tier, 'STANDARD');
});

test('there is no symmetric rule promoting STANDARD to Opus on risk alone', () => {
  // Opus is reached by evidence, not by a planner marking a unit scary.
  const routed = routeWorkUnit({ unit: unit({ type: 'STANDARD', risk: 'HIGH', complexity: 'HIGH' }) });
  assert.equal(routed.routing.modelKey, 'sonnet');
});

// ===========================================================================
// 9 / 10 / 11. Escalation between tiers
// ===========================================================================

test('9. the escalation ladder is one step at a time and stops at COMPLEX', () => {
  assert.equal(WORK_UNIT_ESCALATION.MECHANICAL, 'STANDARD');
  assert.equal(WORK_UNIT_ESCALATION.STANDARD, 'COMPLEX');
  assert.equal(WORK_UNIT_ESCALATION.COMPLEX, null);
  assert.equal(WORK_UNIT_ESCALATION.DETERMINISTIC, null);
});

test('10. a MECHANICAL unit that turns out not to be mechanical is escalated to Sonnet', () => {
  const verdict = authorizeWorkUnitEscalation({
    currentTier: 'MECHANICAL',
    request: {
      reason: 'PATTERN_INSUFFICIENT',
      evidence: ['o padrão de OrderService não cobre reenvio; não há exemplo equivalente no repositório'],
    },
  });
  assert.equal(verdict.verdict, ESCALATION_VERDICTS.AUTHORIZED);
  assert.equal(verdict.toTier, 'STANDARD');
  assert.equal(verdict.decision.modelKey, 'sonnet');
});

test('10. low confidence is admissible for the cheap tier, where being wrong is cheap', () => {
  const verdict = authorizeWorkUnitEscalation({
    currentTier: 'MECHANICAL',
    request: { reason: 'LOW_CONFIDENCE', evidence: ['duas leituras possíveis do contrato, ambas plausíveis'] },
  });
  assert.equal(verdict.verdict, ESCALATION_VERDICTS.AUTHORIZED);
});

test('11. low confidence is NOT a reason to buy Opus', () => {
  const verdict = authorizeWorkUnitEscalation({
    currentTier: 'STANDARD',
    request: { reason: 'LOW_CONFIDENCE', evidence: ['não tenho certeza'] },
  });
  assert.equal(verdict.verdict, ESCALATION_VERDICTS.REFUSED);
  assert.match(verdict.reason, /does not justify/);
});

test('11. a concurrency problem discovered mid-unit does justify Opus', () => {
  const verdict = authorizeWorkUnitEscalation({
    currentTier: 'STANDARD',
    request: {
      reason: 'CONCURRENCY_ISSUE',
      evidence: ['dois workers podem materializar a mesma attempt; o lease não cobre o intervalo entre leitura e escrita'],
    },
  });
  assert.equal(verdict.verdict, ESCALATION_VERDICTS.AUTHORIZED);
  assert.equal(verdict.toTier, 'COMPLEX');
  assert.equal(verdict.decision.modelKey, 'opus');
});

test('11. "it failed repeatedly" must point at attempts that exist', () => {
  const request = {
    reason: 'REPEATED_EXECUTION_FAILURE',
    evidence: ['a mesma asserção falhou depois de duas correções distintas'],
  };

  const tooEarly = authorizeWorkUnitEscalation({ currentTier: 'STANDARD', request, failedAttempts: 1 });
  assert.equal(tooEarly.verdict, ESCALATION_VERDICTS.REFUSED);
  assert.match(tooEarly.reason, /at least 2 failed attempts/);

  const earned = authorizeWorkUnitEscalation({
    currentTier: 'STANDARD', request, failedAttempts: MIN_ATTEMPTS_FOR_REPEATED_FAILURE,
  });
  assert.equal(earned.verdict, ESCALATION_VERDICTS.AUTHORIZED);
});

test('an escalation with no evidence is refused; a stated confidence is not evidence', () => {
  const verdict = authorizeWorkUnitEscalation({
    currentTier: 'MECHANICAL',
    request: { reason: 'PATTERN_INSUFFICIENT', confidence: 'LOW', evidence: [] },
  });
  assert.equal(verdict.verdict, ESCALATION_VERDICTS.REFUSED);
  assert.match(verdict.reason, /evidence/);
});

test('a COMPLEX unit has nowhere to escalate to, and says so', () => {
  const verdict = authorizeWorkUnitEscalation({
    currentTier: 'COMPLEX',
    request: { reason: 'REPEATED_EXECUTION_FAILURE', evidence: ['a', 'b'] },
    failedAttempts: 5,
  });
  assert.equal(verdict.verdict, ESCALATION_VERDICTS.REFUSED);
  assert.match(verdict.reason, /human decision/);
});

test('a pinned routing mode makes escalation a human call', () => {
  const verdict = authorizeWorkUnitEscalation({
    currentTier: 'MECHANICAL',
    request: { reason: 'PATTERN_INSUFFICIENT', evidence: ['evidência concreta'] },
    mode: ROUTING_MODES.FORCE_SONNET,
  });
  assert.equal(verdict.verdict, ESCALATION_VERDICTS.REFUSED);
});

test('the two tiers admit different reasons, and the split is not accidental', () => {
  assert.ok(WORK_UNIT_ESCALATION_REASONS.MECHANICAL.includes('LOW_CONFIDENCE'));
  assert.ok(!WORK_UNIT_ESCALATION_REASONS.STANDARD.includes('LOW_CONFIDENCE'));
  assert.ok(WORK_UNIT_ESCALATION_REASONS.STANDARD.includes('CONCURRENCY_ISSUE'));
  assert.ok(WORK_UNIT_ESCALATION_REASONS.STANDARD.includes('STATE_INCONSISTENCY'));
});

// ===========================================================================
// Replay: the tier is derived, never remembered
// ===========================================================================

test('an escalated unit replays to the escalated tier from its history alone', () => {
  const mechanical = unit({ type: 'MECHANICAL' });
  assert.equal(routeWorkUnit({ unit: mechanical, escalations: 0 }).routing.modelKey, 'haiku');
  assert.equal(routeWorkUnit({ unit: mechanical, escalations: 1 }).routing.modelKey, 'sonnet');
  assert.equal(routeWorkUnit({ unit: mechanical, escalations: 2 }).routing.modelKey, 'opus');
  // Past the top of the ladder it stays at the top rather than inventing a tier.
  assert.equal(routeWorkUnit({ unit: mechanical, escalations: 5 }).routing.modelKey, 'opus');
});

test('a manual override pins the model without erasing what the plan declared', () => {
  const routed = routeWorkUnit({ unit: unit({ type: 'MECHANICAL' }), mode: ROUTING_MODES.FORCE_OPUS });
  assert.equal(routed.routing.modelKey, 'opus');
  assert.equal(routed.routing.reason, 'MANUAL_OVERRIDE_FORCE_OPUS');
  assert.equal(routed.unitType, 'MECHANICAL', 'what the plan said is still on the record');
});

test('an unknown unit type is refused rather than guessed', () => {
  assert.throws(
    () => routeWorkUnit({ unit: { id: 'WU-001', type: 'WHATEVER' } }),
    (error) => error.code === 'INVALID_ARGS',
  );
});
