/**
 * Adaptive model routing — the policy, as a pure function.
 *
 * What this file states: which model runs is decided by risk, from text and
 * state, with no model call anywhere. Nothing here spawns a process; the
 * integration side (a real store, real attempts, a fake CLI) lives in
 * model-routing-integration.test.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPLEXITY,
  ESCALATION_VERDICTS,
  MODELS,
  REROUTE_REASONS,
  RISK_THRESHOLDS,
  ROUTING_CONFIG,
  TEXT_SIGNAL_CAP,
  ROUTING_MODES,
  ROUTING_STAGES,
  authorizeDeveloperEscalation,
  authorizeReviewEscalation,
  classificationForScore,
  classifyPlanningComplexity,
  classifyReviewComplexity,
  isFallbackReason,
  planCapacityFallback,
  resolveRoutingForAttempt,
  resolveRoutingMode,
  routeDeveloper,
  routeTechLead,
  routingFromProfile,
  toRoutedRecord,
} from '../lib/model-routing.mjs';
import { CAPACITY_REASONS } from '../lib/capacity-classifier.mjs';
import { DEVELOPER_PROFILES, profileForModel } from '../lib/developer-profiles.mjs';

/** A classifier result, built directly so a routing test states its own input. */
const at = (classification, riskScore = 0, signals = []) => ({ classification, riskScore, signals });

// ===========================================================================
// 25. Routing tables
// ===========================================================================

test('25. planning goes to Opus at every complexity the classifier can produce', () => {
  for (const level of [COMPLEXITY.LOW, COMPLEXITY.MEDIUM, COMPLEXITY.HIGH, COMPLEXITY.CRITICAL]) {
    const routed = routeTechLead({ stage: ROUTING_STAGES.PLANNING, assessment: at(level) });
    assert.equal(routed.modelKey, 'opus', level);
    assert.equal(routed.effort, 'high', level);
    assert.equal(routed.fallbackAllowed, false, 'the standard model has nothing to fall back to');
  }
});

test('25. review routes on the same table as planning', () => {
  for (const level of [COMPLEXITY.LOW, COMPLEXITY.MEDIUM, COMPLEXITY.HIGH, COMPLEXITY.CRITICAL]) {
    assert.equal(routeTechLead({ stage: ROUTING_STAGES.REVIEW, assessment: at(level) }).modelKey, 'opus', level);
  }
});

test('25. the classification is recorded even though it no longer picks the model', () => {
  const routed = routeTechLead({
    stage: ROUTING_STAGES.REVIEW,
    assessment: at(COMPLEXITY.CRITICAL, 17, ['SECURITY', 'MIGRATION']),
  });
  assert.equal(routed.modelKey, 'opus');
  assert.equal(routed.complexity, COMPLEXITY.CRITICAL, 'the audit keeps what the classifier saw');
  assert.equal(routed.riskScore, 17);
  assert.deepEqual(routed.signals, ['SECURITY', 'MIGRATION']);
});

test('25. no assessment reaches the specialist by routing alone', () => {
  for (const stage of [ROUTING_STAGES.PLANNING, ROUTING_STAGES.REVIEW]) {
    for (const score of [0, 4, 7, 20, 99]) {
      const routed = routeTechLead({ stage, assessment: at(COMPLEXITY.CRITICAL, score) });
      assert.notEqual(routed.modelKey, 'fable', `${stage} @ ${score}`);
    }
  }
});

test('25. the Developer default is Sonnet, and escalation is Opus', () => {
  const base = routeDeveloper({});
  assert.equal(base.modelKey, 'sonnet');
  assert.equal(base.effort, 'high');
  assert.equal(base.fallbackAllowed, true, 'Sonnet may fall back to Opus on a quota');

  assert.equal(routeDeveloper({ level: 'escalation' }).modelKey, 'opus');
  assert.equal(routeDeveloper({ level: 'escalation' }).effort, 'high');
  assert.equal(routeDeveloper({ level: 'deepEscalation' }).effort, 'xhigh');
});

test('25. no routed decision ever selects max effort', () => {
  const efforts = [
    ...Object.values(ROUTING_CONFIG.tech_lead.planning),
    ...Object.values(ROUTING_CONFIG.tech_lead.review),
    ...Object.values(ROUTING_CONFIG.developer),
  ].map((entry) => entry.effort);
  assert.ok(!efforts.includes('max'), 'max stays a human decision, never the router\'s');
});

test('every routed model resolves to a profile the Developer worker can run', () => {
  for (const level of Object.keys(ROUTING_CONFIG.developer)) {
    const routed = routeDeveloper({ level });
    const profile = profileForModel({ model: routed.model, effort: routed.effort });
    assert.equal(profile.model, routed.model, level);
    assert.equal(profile.effort, routed.effort, level);
  }
});

// ===========================================================================
// Complexity classification
// ===========================================================================

test('thresholds map scores to levels, and are the only place the numbers live', () => {
  assert.equal(classificationForScore(0), COMPLEXITY.LOW);
  assert.equal(classificationForScore(RISK_THRESHOLDS.MEDIUM - 1), COMPLEXITY.LOW);
  assert.equal(classificationForScore(RISK_THRESHOLDS.MEDIUM), COMPLEXITY.MEDIUM);
  assert.equal(classificationForScore(RISK_THRESHOLDS.HIGH), COMPLEXITY.HIGH);
  assert.equal(classificationForScore(RISK_THRESHOLDS.CRITICAL), COMPLEXITY.CRITICAL);
  assert.equal(classificationForScore(99), COMPLEXITY.CRITICAL);
});

test('a plain Goal scores LOW and routes to the standard model', () => {
  const assessment = classifyPlanningComplexity({
    text: 'Ajustar o texto do botão de confirmação e o espaçamento do cabeçalho.',
  });
  assert.equal(assessment.classification, COMPLEXITY.LOW);
  assert.equal(routeTechLead({ stage: ROUTING_STAGES.PLANNING, assessment }).modelKey, 'opus');
});

test('prose alone never reaches HIGH, however alarming it sounds', () => {
  // The cap, stated as a property. Measured against the real documents in this
  // repository: uncapped, the roadmap scored 30 and every Goal came out
  // CRITICAL, because a long document about a migration project mentions
  // migrations. Text can argue for MEDIUM; it cannot buy the specialist.
  const assessment = classifyPlanningComplexity({
    text: 'Migração de schema com isolamento de tenant, concorrência entre workers, '
      + 'breaking change no contrato público, recovery e deploy.',
  });
  assert.ok(assessment.signals.includes('MIGRATION'));
  assert.ok(assessment.signals.includes('SECURITY'));
  assert.ok(assessment.textScore > TEXT_SIGNAL_CAP, 'the signals really are there');
  assert.equal(assessment.riskScore, TEXT_SIGNAL_CAP, 'but they are capped');
  assert.equal(assessment.classification, COMPLEXITY.MEDIUM);
  assert.equal(routeTechLead({ stage: ROUTING_STAGES.PLANNING, assessment }).modelKey, 'opus');
});

test('planning reaches HIGH when something actually went wrong', () => {
  // Evidence is not capped: a rejected round and an escalation that really
  // happened push the same text over the line.
  const assessment = classifyPlanningComplexity({
    text: 'Migração de schema com isolamento de tenant.',
    history: { previousRoundRejected: true, previousDeveloperEscalation: true },
  });
  assert.ok(assessment.riskScore >= RISK_THRESHOLDS.HIGH, `score ${assessment.riskScore}`);
});

test('a review reaches HIGH on evidence the diff carries, not on wording', () => {
  const worded = classifyReviewComplexity({
    changedFiles: ['apps/frontend/src/screens/Settings.tsx'],
    text: 'arquitetura, segurança, concorrência, migração de schema, breaking change, recovery',
  });
  assert.equal(worded.classification, COMPLEXITY.MEDIUM, 'talking about it is not doing it');

  const real = classifyReviewComplexity({
    changedFiles: [
      'apps/scheduling-service/prisma/migrations/20260101_x/migration.sql',
      'apps/bff/src/modules/session/routes.ts',
    ],
  });
  assert.ok(real.riskScore >= RISK_THRESHOLDS.HIGH, `score ${real.riskScore}`);
});

test('the classifier reads Portuguese and English alike', () => {
  const pt = classifyPlanningComplexity({ text: 'Mudança de arquitetura com concorrência entre workers.' });
  const en = classifyPlanningComplexity({ text: 'Architecture change with concurrency between workers.' });
  assert.equal(pt.classification, en.classification);
  assert.deepEqual([...pt.signals].sort(), [...en.signals].sort());
});

test('history raises risk even when the text says nothing alarming', () => {
  const quiet = classifyPlanningComplexity({ text: 'Pequeno ajuste de copy.' });
  const scarred = classifyPlanningComplexity({
    text: 'Pequeno ajuste de copy.',
    history: { previousRoundRejected: true, previousDeveloperEscalation: true },
  });
  assert.ok(scarred.riskScore > quiet.riskScore);
  assert.ok(scarred.signals.includes('PREVIOUS_DEVELOPER_ESCALATION'));
});

test('the same signal named twice is scored once', () => {
  const once = classifyPlanningComplexity({ text: 'migration' });
  const many = classifyPlanningComplexity({ text: 'migration migration migration schema migration' });
  assert.equal(many.riskScore, once.riskScore);
});

test('classification is deterministic: same input, same answer', () => {
  const input = { text: 'Refactor de infraestrutura com deploy e contrato de API.', history: { previousRoundRejected: true } };
  const a = classifyPlanningComplexity(input);
  const b = classifyPlanningComplexity(input);
  assert.deepEqual(a, b);
});

test('review risk is scored from the diff that exists, not from prose', () => {
  const assessment = classifyReviewComplexity({
    changedFiles: [
      'apps/scheduling-service/prisma/migrations/20260101_x/migration.sql',
      'apps/scheduling-service/src/modules/session/SessionService.ts',
      'apps/bff/src/modules/customers/routes.ts',
      'apps/frontend/src/data/services/X.ts',
    ],
    diffStat: '4 files changed, 900 insertions(+), 20 deletions(-)',
    text: '',
  });
  assert.ok(assessment.signals.includes('MIGRATION'), 'a migration path IS a migration');
  assert.ok(assessment.signals.includes('SECURITY'), 'a session file is security surface');
  assert.ok(assessment.signals.includes('CROSS_CUTTING'), 'three apps is cross-cutting');
  assert.ok(assessment.riskScore >= RISK_THRESHOLDS.HIGH, `score ${assessment.riskScore}`);
});

test('18. a Developer escalation raises the review risk by itself', () => {
  const files = ['apps/bff/src/modules/x/routes.ts'];
  const calm = classifyReviewComplexity({ changedFiles: files });
  const escalated = classifyReviewComplexity({ changedFiles: files, developerEscalated: true });
  assert.ok(escalated.riskScore > calm.riskScore);
  assert.ok(escalated.signals.includes('DEVELOPER_ESCALATED'));
});

// ===========================================================================
// 26. Fallback — availability only
// ===========================================================================

/**
 * A Fable review. Routing no longer produces one at any complexity — the
 * specialist is reachable only through an authorized escalation, so that is
 * how a test gets one.
 */
const fableReview = () => authorizeReviewEscalation({
  request: { reason: 'REVIEW_INCONCLUSIVE', evidence: ['two Opus rounds left the same question open'] },
  current: routeTechLead({ stage: ROUTING_STAGES.REVIEW, assessment: at(COMPLEXITY.HIGH) }),
}).decision;

test('26. Fable falls back to Opus on a usage limit, a rate limit and an unavailable model', () => {
  for (const reason of [CAPACITY_REASONS.USAGE_LIMIT, CAPACITY_REASONS.RATE_LIMIT, CAPACITY_REASONS.MODEL_UNAVAILABLE]) {
    assert.ok(isFallbackReason(reason), reason);
    const fallback = planCapacityFallback({ current: fableReview(), reason });
    assert.ok(fallback, `expected a fallback for ${reason}`);
    assert.equal(fallback.modelKey, 'opus', reason);
    assert.equal(fallback.effort, 'high', reason);
    assert.match(fallback.reason, /^CAPACITY_FALLBACK_/);
  }
});

test('26. a harness, auth, billing or unexplained failure NEVER falls back', () => {
  for (const reason of [
    CAPACITY_REASONS.HARNESS_ERROR,
    CAPACITY_REASONS.AUTH_ERROR,
    CAPACITY_REASONS.BILLING_ERROR,
    CAPACITY_REASONS.UNKNOWN_FATAL,
    CAPACITY_REASONS.UNKNOWN_TRANSIENT,
  ]) {
    assert.equal(planCapacityFallback({ current: fableReview(), reason }), null, reason);
  }
});

test('26. a fallback happens once: a second one would be a third model', () => {
  assert.equal(
    planCapacityFallback({ current: fableReview(), reason: CAPACITY_REASONS.USAGE_LIMIT, alreadyFellBack: true }),
    null,
  );
});

test('26. the standard model has no fallback of its own', () => {
  const opusReview = routeTechLead({ stage: ROUTING_STAGES.REVIEW, assessment: at(COMPLEXITY.LOW) });
  assert.equal(planCapacityFallback({ current: opusReview, reason: CAPACITY_REASONS.USAGE_LIMIT }), null);
});

test('15. Sonnet falls back to Opus on capacity, and that is not an escalation', () => {
  const fallback = planCapacityFallback({ current: routeDeveloper({}), reason: CAPACITY_REASONS.USAGE_LIMIT });
  assert.equal(fallback.modelKey, 'opus');
  assert.equal(fallback.reason, `CAPACITY_FALLBACK_${CAPACITY_REASONS.USAGE_LIMIT}`);
  assert.ok(!fallback.reason.includes('EXECUTION'), 'capacity and capability stay distinguishable');
});

// ===========================================================================
// 34. Escalation — the router decides, not the worker
// ===========================================================================

const REQUEST = Object.freeze({
  reason: 'REPEATED_EXECUTION_FAILURE',
  confidence: 'LOW',
  evidence: ['same assertion failed on three consecutive fix attempts'],
});

test('34. a Developer escalation with evidence is authorised, and lands on Opus high', () => {
  const verdict = authorizeDeveloperEscalation({ request: REQUEST, current: routeDeveloper({}) });
  assert.equal(verdict.verdict, ESCALATION_VERDICTS.AUTHORIZED);
  assert.equal(verdict.decision.modelKey, 'opus');
  assert.equal(verdict.decision.effort, 'high');
});

test('34. an escalation with no evidence is refused, however confident it sounds', () => {
  const verdict = authorizeDeveloperEscalation({
    request: { reason: 'LOW_CONFIDENCE', confidence: 'LOW', evidence: [] },
    current: routeDeveloper({}),
  });
  assert.equal(verdict.verdict, ESCALATION_VERDICTS.REFUSED);
  assert.match(verdict.reason, /evidence/i);
});

test('34. an unknown escalation reason is refused rather than interpreted', () => {
  const verdict = authorizeDeveloperEscalation({
    request: { reason: 'I_WOULD_PREFER_OPUS', evidence: ['because'] },
    current: routeDeveloper({}),
  });
  assert.equal(verdict.verdict, ESCALATION_VERDICTS.REFUSED);
});

test('30. an escalation already granted is not granted twice', () => {
  const verdict = authorizeDeveloperEscalation({
    request: REQUEST, current: routeDeveloper({ level: 'escalation' }), alreadyEscalated: true,
  });
  assert.equal(verdict.verdict, ESCALATION_VERDICTS.ALREADY_ESCALATED);
  assert.equal(verdict.decision, null);
});

test('14. Opus escalates to xhigh at most once, and never beyond', () => {
  const fromOpus = authorizeDeveloperEscalation({ request: REQUEST, current: routeDeveloper({ level: 'escalation' }) });
  assert.equal(fromOpus.verdict, ESCALATION_VERDICTS.AUTHORIZED);
  assert.equal(fromOpus.decision.effort, 'xhigh');

  const fromXHigh = authorizeDeveloperEscalation({ request: REQUEST, current: routeDeveloper({ level: 'deepEscalation' }) });
  assert.equal(fromXHigh.verdict, ESCALATION_VERDICTS.REFUSED);
  assert.match(fromXHigh.reason, /human/i);
});

test('19. an Opus Developer round is not a fallback just because Opus is running', () => {
  const opus = routeDeveloper({ level: 'escalation' });
  assert.equal(opus.fallbackAllowed, false);
  assert.equal(planCapacityFallback({ current: opus, reason: CAPACITY_REASONS.USAGE_LIMIT }), null);
});

test('19. an inconclusive Opus review may escalate to Fable, with evidence', () => {
  const opusReview = routeTechLead({ stage: ROUTING_STAGES.REVIEW, assessment: at(COMPLEXITY.MEDIUM, 3) });
  const verdict = authorizeReviewEscalation({
    request: { reason: 'ARCHITECTURAL_RISK_DISCOVERED', evidence: ['the lease renewal path has no fencing token'] },
    current: opusReview,
  });
  assert.equal(verdict.verdict, ESCALATION_VERDICTS.AUTHORIZED);
  assert.equal(verdict.decision.modelKey, 'fable');
  assert.equal(verdict.decision.complexity, COMPLEXITY.HIGH);
});

test('a Fable review has nowhere to escalate to, and says so', () => {
  const verdict = authorizeReviewEscalation({
    request: { reason: 'REVIEW_INCONCLUSIVE', evidence: ['x'] },
    current: fableReview(),
  });
  assert.equal(verdict.verdict, ESCALATION_VERDICTS.REFUSED);
});

// ===========================================================================
// 21. Manual override
// ===========================================================================

test('21. the default mode is AUTO, and an unknown mode is refused', () => {
  assert.equal(resolveRoutingMode({}), ROUTING_MODES.AUTO);
  assert.equal(resolveRoutingMode({ IA_LOOP_ROUTING_MODE: 'force_opus' }), ROUTING_MODES.FORCE_OPUS);
  assert.throws(() => resolveRoutingMode({ IA_LOOP_ROUTING_MODE: 'FORCE_HAIKU' }), (e) => e.code === 'INVALID_ROUTING_MODE');
});

test('21. an override pins the model and says so in the audit', () => {
  const routed = routeTechLead({
    stage: ROUTING_STAGES.REVIEW, assessment: at(COMPLEXITY.CRITICAL, 9), mode: ROUTING_MODES.FORCE_SONNET,
  });
  assert.equal(routed.modelKey, 'sonnet');
  assert.equal(routed.reason, 'MANUAL_OVERRIDE_FORCE_SONNET');
  // The assessment survives the override: what the router THOUGHT is still on
  // the record, which is the point of auditing an override at all.
  assert.equal(routed.complexity, COMPLEXITY.CRITICAL);
  assert.equal(routed.riskScore, 9);
});

test('21. a pinned model does not fall back or escalate behind the operator\'s back', () => {
  assert.equal(
    planCapacityFallback({ current: fableReview(), reason: CAPACITY_REASONS.USAGE_LIMIT, mode: ROUTING_MODES.FORCE_FABLE }),
    null,
  );
  assert.equal(
    authorizeDeveloperEscalation({ request: REQUEST, current: routeDeveloper({}), mode: ROUTING_MODES.FORCE_SONNET }).verdict,
    ESCALATION_VERDICTS.REFUSED,
  );
});

// ===========================================================================
// 31. Replay — a restart resolves, it does not re-decide
// ===========================================================================

test('31. with no history, the attempt runs on what the job says', () => {
  const base = routeDeveloper({});
  const { routing, fellBack, escalated } = resolveRoutingForAttempt({ base, attemptHistory: [] });
  assert.equal(routing.modelKey, 'sonnet');
  assert.equal(fellBack, false);
  assert.equal(escalated, false);
});

test('31. an escalation recorded in history is replayed, not re-decided', () => {
  const base = routeDeveloper({});
  const escalation = routeDeveloper({ level: 'escalation' });
  const { routing, escalated } = resolveRoutingForAttempt({
    base,
    attemptHistory: [
      { attempt: 1, reason: REROUTE_REASONS.MODEL_ESCALATION, routedTo: toRoutedRecord(escalation) },
    ],
  });
  assert.equal(routing.modelKey, 'opus');
  assert.equal(routing.effort, 'high');
  assert.equal(escalated, true, 'a second escalation must not be granted after a restart');
});

test('31. replay keeps what the classifier saw, even after the model changed', () => {
  const base = fableReview();
  const fallback = planCapacityFallback({ current: base, reason: CAPACITY_REASONS.USAGE_LIMIT });
  const { routing, fellBack } = resolveRoutingForAttempt({
    base,
    attemptHistory: [{ attempt: 1, reason: REROUTE_REASONS.MODEL_FALLBACK, routedTo: toRoutedRecord(fallback) }],
  });
  assert.equal(routing.modelKey, 'opus');
  assert.equal(routing.complexity, base.complexity, 'the risk did not change because the model did');
  assert.deepEqual([...routing.signals], [...base.signals]);
  assert.equal(fellBack, true);
});

test('31. history entries that name no model leave the routing alone', () => {
  const base = routeDeveloper({});
  const { routing } = resolveRoutingForAttempt({
    base,
    attemptHistory: [{ attempt: 1, reason: 'INTERRUPTED' }, { attempt: 2, reason: 'WAITING_FOR_CAPACITY' }],
  });
  assert.equal(routing.modelKey, 'sonnet');
});

// ===========================================================================
// Registry
// ===========================================================================

test('the registry is the only place a model id is written down', () => {
  assert.equal(MODELS.sonnet.model, DEVELOPER_PROFILES.SONNET_HIGH.model);
  assert.equal(MODELS.opus.model, DEVELOPER_PROFILES.OPUS_HIGH.model);
  assert.equal(MODELS.fable.family, 'fable');
});

test('a legacy profile still describes a routing decision that can be replayed', () => {
  const routed = routingFromProfile(DEVELOPER_PROFILES.LEGACY_OPUS);
  assert.equal(routed.modelKey, 'opus');
  assert.equal(routed.effort, null, 'no --effort flag, exactly as the execution began');
  assert.equal(routed.fallbackAllowed, false);
});
