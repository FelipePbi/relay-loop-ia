/**
 * Closure documentation routing.
 *
 * Found while closing Goal 007 for real: `ia-loop:close` published the
 * CLOSURE_DOCUMENTATION job the way it always has — with no `routing` field,
 * because closure documentation is bookkeeping over a decision already taken
 * and was never risk-classified — and the Tech Lead worker resolved that
 * absence as `stage: REVIEW`, which is the compatibility path built for an
 * actual review written before adaptive routing existed. Every closure job
 * therefore ran on Fable, reason `LEGACY_UNROUTED_JOB`, which contradicts the
 * comment sitting right above the call site: "closure documentation … runs on
 * the standard model unless the job says otherwise."
 *
 * The fix gives closure its own stage (`ROUTING_STAGES.CLOSURE`) and its own
 * policy function (`routeClosureDocumentation`), centralised in
 * model-routing.mjs exactly like every other routing decision. The worker's
 * `routingOf` asks that function for CLOSURE and keeps the old fallback,
 * unchanged, for the stages it was actually built for.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ESCALATION_VERDICTS,
  MODELS,
  ROUTING_MODES,
  ROUTING_STAGES,
  authorizeReviewEscalation,
  routeClosureDocumentation,
  routeTechLead,
} from '../lib/model-routing.mjs';
import { routingOf } from '../workers/tech-lead.mjs';

// ===========================================================================
// The policy function
// ===========================================================================

test('closure documentation defaults to the standard Tech Lead tier, not Fable', () => {
  const routed = routeClosureDocumentation();
  assert.equal(routed.stage, ROUTING_STAGES.CLOSURE);
  assert.equal(routed.modelKey, 'opus');
  assert.equal(routed.model, MODELS.opus.model);
  assert.equal(routed.effort, 'high');
  assert.equal(routed.reason, 'CLOSURE_DOCUMENTATION_STANDARD');
  assert.notEqual(routed.reason, 'LEGACY_UNROUTED_JOB');
});

test('closure documentation carries no risk classification — there is nothing to classify', () => {
  const routed = routeClosureDocumentation();
  assert.equal(routed.complexity, null);
  assert.equal(routed.riskScore, null);
  assert.deepEqual([...routed.signals], []);
});

test('a manual override still pins closure documentation, including to Fable if asked', () => {
  const opus = routeClosureDocumentation({ mode: ROUTING_MODES.FORCE_OPUS });
  assert.equal(opus.modelKey, 'opus');
  assert.equal(opus.reason, 'MANUAL_OVERRIDE_FORCE_OPUS');

  const fable = routeClosureDocumentation({ mode: ROUTING_MODES.FORCE_FABLE });
  assert.equal(fable.modelKey, 'fable');
  assert.equal(fable.reason, 'MANUAL_OVERRIDE_FORCE_FABLE');
  assert.equal(fable.fallbackAllowed, true, 'a forced Fable may still fall back on its own quota');
});

test('the default Opus routing has nothing to fall back to', () => {
  assert.equal(routeClosureDocumentation().fallbackAllowed, false);
});

// ===========================================================================
// The worker's resolution — the exact bug, reproduced and fixed
// ===========================================================================

/** A closure documentation job exactly as run-close.mjs actually publishes it. */
const closureJobAsPublished = () => ({
  jobId: '007-r3-tech_lead-31209003',
  role: 'tech_lead',
  goal: '007',
  round: 3,
  type: 'CLOSURE_DOCUMENTATION',
  // No `routing` field — never has one, by construction.
});

test('a closure documentation job with no routing field resolves to Opus, not Fable', () => {
  const routed = routingOf(closureJobAsPublished(), ROUTING_STAGES.CLOSURE);
  assert.equal(routed.modelKey, 'opus');
  assert.equal(routed.reason, 'CLOSURE_DOCUMENTATION_STANDARD');
  assert.notEqual(routed.reason, 'LEGACY_UNROUTED_JOB', 'this is the exact bug: closure read as a legacy review');
  assert.notEqual(routed.model, MODELS.fable.model);
});

test('an explicit routing on the closure job is still honoured over the default', () => {
  const explicit = {
    role: 'tech_lead', stage: ROUTING_STAGES.CLOSURE,
    modelKey: 'fable', model: MODELS.fable.model, family: 'fable', effort: 'high',
    complexity: null, riskScore: null, signals: [], reason: 'HUMAN_OVERRIDE',
    fallbackAllowed: true, mode: ROUTING_MODES.AUTO,
  };
  const routed = routingOf({ ...closureJobAsPublished(), routing: explicit }, ROUTING_STAGES.CLOSURE);
  assert.equal(routed, explicit, 'the job\'s own routing is returned untouched, not re-derived');
});

test('an actual REVIEW job with no routing field still replays on Fable — the true legacy path', () => {
  // This is the case `LEGACY_UNROUTED_JOB` exists for: Goal 003–006 review
  // jobs, written before V14, which really did all run on the specialist.
  const legacyReview = { jobId: '003-r1-tech_lead-7fe99508', role: 'tech_lead', goal: '003', round: 1 };
  const routed = routingOf(legacyReview, ROUTING_STAGES.REVIEW);
  assert.equal(routed.modelKey, 'fable');
  assert.equal(routed.reason, 'LEGACY_UNROUTED_JOB');
});

test('a real (routed) review job is unaffected — its own routing is returned untouched', () => {
  const own = routeTechLead({ stage: ROUTING_STAGES.REVIEW, assessment: { classification: 'LOW', riskScore: 0, signals: [] } });
  const routed = routingOf({ jobId: 'x', routing: own }, ROUTING_STAGES.REVIEW);
  assert.equal(routed, own);
});

// ===========================================================================
// Closure documentation stays out of the review-escalation policy
// ===========================================================================

test('closure documentation has no escalation path of its own — that policy is for reviews', () => {
  // authorizeReviewEscalation is keyed on an actual REVIEW decision's
  // escalationRequest; closure documentation never produces one, so nothing
  // here should accidentally authorise a closure job onto Fable through it.
  const verdict = authorizeReviewEscalation({
    request: { reason: 'REVIEW_INCONCLUSIVE', evidence: ['n/a'] },
    current: routeClosureDocumentation(),
  });
  // Still authorised in principle (Opus -> Fable is a legitimate review
  // escalation) — the point is that nothing routes a closure job there
  // automatically; only an explicit request would, exactly like a review.
  assert.equal(verdict.verdict, ESCALATION_VERDICTS.AUTHORIZED);
  assert.equal(verdict.decision.modelKey, 'fable');
});
