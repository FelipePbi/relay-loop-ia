/**
 * Developer profile ROUTING: who decides, and what survives.
 *
 * The properties proved here are the ones a restart can silently break —
 * a promotion being recalculated away, a correction round drifting back to the
 * Goal's original profile, a recovery reopening a decision that was already
 * made. No model is called; the whole cycle is exercised with fakes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { invokeAgent } from '../lib/claude-process.mjs';
import { resolveDeveloperProfile } from '../lib/developer-profiles.mjs';
import {
  PROFILE_SOURCES,
  isLegacyInFlight,
  resolveProfileForRound,
  toExecutionRecord,
} from '../lib/profile-routing.mjs';
import { initializeGoalExecutionState } from '../lib/goal-execution.mjs';
import { PER_GOAL_RUNTIME_FIELDS } from '../lib/job-store.mjs';
import { PROTOCOL_VERSION_V2, validateReviewDecision } from '../lib/contracts-v2.mjs';

const SONNET = 'claude-sonnet-5';
const OPUS = 'claude-opus-5';

/** The execution record `run-goal` persists after resolving a round. */
function executionWith(profileName, round, extra = {}) {
  return {
    goal: '006',
    round,
    developerProfile: toExecutionRecord(
      { profile: resolveDeveloperProfile(profileName), source: PROFILE_SOURCES.PLANNING_RECORD, selectedBy: 'tech_lead', reason: null },
      { goal: '006', round },
    ),
    ...extra,
  };
}

// --- 24-26. Nothing recalculates a profile that already exists ------------

test('24. a restart of the same round reuses the persisted profile', () => {
  const execution = executionWith('OPUS_HIGH', 2);

  const resolved = resolveProfileForRound({
    goalExecution: execution,
    round: 2,
    // A planning record that says something else must NOT win: the round has
    // already started, and its identity includes the profile.
    planningRecord: { profile: 'SONNET_MEDIUM' },
    declaredInGoal: 'SONNET_MEDIUM',
  });

  assert.equal(resolved.profile.name, 'OPUS_HIGH');
  assert.equal(resolved.source, PROFILE_SOURCES.PERSISTED);
  assert.equal(resolved.changed, false);
});

test('25. a capacity retry keeps the profile: the job is the authority', () => {
  // A capacity wait re-invokes with the SAME job, so the same profile is read
  // back. Simulated as two invocations of one job's profile.
  const job = { developerProfile: 'OPUS_HIGH' };
  const first = resolveDeveloperProfile(job.developerProfile);
  const second = resolveDeveloperProfile(job.developerProfile);

  assert.deepEqual(first, second);
  assert.equal(second.model, OPUS);
  assert.equal(second.effort, 'high');
});

test('26. recovery preserves the profile instead of recomputing it', () => {
  const recovered = {
    ...executionWith('OPUS_HIGH', 2),
    recovery: { action: 'RESUME', fromState: 'CORRECTION_RUNNING' },
    currentJobId: '006-r2-correction-aaaa1111',
  };

  const resolved = resolveProfileForRound({ goalExecution: recovered, round: 2 });
  assert.equal(resolved.profile.name, 'OPUS_HIGH');
  assert.equal(resolved.source, PROFILE_SOURCES.PERSISTED);
});

test('26b. a downgrade cannot sneak in through a stale planning record', () => {
  const execution = executionWith('OPUS_HIGH', 2);
  // Round 3 with no escalation: it keeps OPUS_HIGH, it does not fall back to
  // whatever the Goal was originally planned as.
  const resolved = resolveProfileForRound({
    goalExecution: execution,
    round: 3,
    planningRecord: { profile: 'SONNET_MEDIUM' },
  });
  assert.equal(resolved.profile.name, 'OPUS_HIGH');
});

// --- 27-29. Correction rounds --------------------------------------------

test('27. a correction keeps the profile when the Tech Lead does not change it', () => {
  const execution = executionWith('SONNET_MEDIUM', 1);
  const resolved = resolveProfileForRound({ goalExecution: execution, round: 2, techLeadEscalation: null });

  assert.equal(resolved.profile.name, 'SONNET_MEDIUM');
  assert.equal(resolved.changed, false);
  // The round number, on its own, promotes nothing.
  assert.notEqual(resolved.source, PROFILE_SOURCES.DEFAULT);
});

test('29. an escalation is recorded as a CHANGE, with its short reason', () => {
  const execution = executionWith('SONNET_MEDIUM', 1);
  const resolved = resolveProfileForRound({
    goalExecution: execution,
    round: 2,
    techLeadEscalation: { profile: 'OPUS_HIGH', reason: 'Tenant isolation touched.' },
  });

  assert.equal(resolved.profile.name, 'OPUS_HIGH');
  assert.equal(resolved.source, PROFILE_SOURCES.TECH_LEAD_ESCALATION);
  assert.equal(resolved.changed, true);
  assert.equal(resolved.previousProfile, 'SONNET_MEDIUM');
  assert.equal(resolved.selectedBy, 'tech_lead');

  const record = toExecutionRecord(resolved, { goal: '006', round: 2 });
  assert.equal(record.profile, 'OPUS_HIGH');
  assert.equal(record.model, OPUS);
  assert.equal(record.effort, 'high');
  assert.equal(record.round, 2);
  assert.ok(record.reason.length <= 200, 'the audit reason must stay short');
  assert.ok(Date.parse(record.at) > 0);
});

// --- 30. Status ------------------------------------------------------------

test('30. the routed profile is Goal-scoped state, so status can show it', () => {
  // Both fields must be per-Goal: a promotion decided for one Goal may never be
  // inherited by the next.
  assert.ok(PER_GOAL_RUNTIME_FIELDS.includes('developerProfile'));
  assert.ok(PER_GOAL_RUNTIME_FIELDS.includes('nextDeveloperProfile'));

  const fresh = initializeGoalExecutionState({
    previousRuntime: { goal: '006', developerProfile: { profile: 'OPUS_HIGH' }, nextDeveloperProfile: { profile: 'OPUS_HIGH' } },
    goal: '007',
  });
  assert.equal(fresh.developerProfile, null);
  assert.equal(fresh.nextDeveloperProfile, null);
});

// --- Default and legacy ----------------------------------------------------

test('a brand-new Goal with nobody saying anything runs on SONNET_HIGH', () => {
  const resolved = resolveProfileForRound({ goalExecution: null, round: 1 });
  assert.equal(resolved.profile.name, 'SONNET_HIGH');
  assert.equal(resolved.source, PROFILE_SOURCES.ADAPTIVE_DEFAULT);
});

test('adaptive routing starts on Sonnet even when planning asked for Opus', () => {
  // The Tech Lead's planning choice is recorded and reported, but it no longer
  // decides the FIRST attempt: a Goal that was hard to plan is often ordinary
  // to execute. Opus arrives through escalation, which carries evidence.
  const resolved = resolveProfileForRound({
    round: 1, planningRecord: { profile: 'OPUS_MEDIUM' }, declaredInGoal: 'OPUS_HIGH',
  });
  assert.equal(resolved.profile.name, 'SONNET_HIGH');
  assert.equal(resolved.source, PROFILE_SOURCES.ADAPTIVE_DEFAULT);
  assert.equal(resolved.plannedProfile, 'OPUS_MEDIUM', 'the choice is preserved for audit');
});

test('with adaptive routing off, the planning record beats the Goal document', () => {
  // The old precedence is intact and still tested: it is what an operator gets
  // by pinning routing, and what a legacy execution replays.
  assert.equal(
    resolveProfileForRound({
      round: 1, adaptive: false, planningRecord: { profile: 'OPUS_MEDIUM' }, declaredInGoal: 'SONNET_MEDIUM',
    }).profile.name,
    'OPUS_MEDIUM',
  );
  assert.equal(
    resolveProfileForRound({ round: 1, adaptive: false, declaredInGoal: 'OPUS_HIGH' }).source,
    PROFILE_SOURCES.GOAL_DOCUMENT,
  );
});

test('a Goal already in flight before routing existed keeps the model it started on', () => {
  const inFlight = { goal: '006', round: 2, currentJobId: '006-r2-correction-aaaa1111', jobIdsByRound: { 1: { developer: 'x' } } };
  assert.equal(isLegacyInFlight(inFlight), true);

  const resolved = resolveProfileForRound({ goalExecution: inFlight, round: 2 });
  assert.equal(resolved.profile.name, 'LEGACY_OPUS');
  assert.equal(resolved.profile.model, OPUS);
  // No --effort flag at all: byte-identical to how the execution began.
  assert.equal(resolved.profile.effort, null);
  assert.equal(resolved.source, PROFILE_SOURCES.LEGACY_IN_FLIGHT);

  // A Goal that merely EXISTS has not started, and gets the new default.
  const announced = { goal: '007', round: 1, jobIdsByRound: {} };
  assert.equal(isLegacyInFlight(announced), false);
  assert.equal(resolveProfileForRound({ goalExecution: announced, round: 1 }).profile.name, 'SONNET_HIGH');
});

// --- Integration: one Goal, two rounds, zero extra inferences -------------

test('integration: Sonnet R1 → CHANGES_REQUIRED → Opus High R2 → ACCEPTED', async () => {
  /** Every model call the fake cycle makes, in order. */
  const calls = [];

  function spawnServing(model, result) {
    return (executable, args) => {
      calls.push({
        model: args[args.indexOf('--model') + 1],
        effort: args.includes('--effort') ? args[args.indexOf('--effort') + 1] : null,
        usedFallbackFlag: args.includes('--fallback-model'),
      });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      setImmediate(() => {
        // The explicit evidence invokeAgent now reads: an `assistant` event
        // naming the served model, before the closing `result`.
        child.stdout.emit('data', `${JSON.stringify({
          type: 'assistant',
          message: { model, content: [{ type: 'text', text: 'ok' }] },
        })}\n`);
        child.stdout.emit('data', JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result,
          usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          modelUsage: { [model]: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
        }));
        child.emit('close', 0);
      });
      return child;
    };
  }

  /** One Developer round, exactly as the worker does it: profile from the job. */
  async function developerRound(job) {
    const profile = resolveDeveloperProfile(job.developerProfile);
    return invokeAgent({
      executable: 'claude',
      model: profile.model,
      effort: profile.effort,
      expectedFamily: profile.family,
      expectedRole: 'developer',
      prompt: 'implement',
      sessionId: '11111111-1111-4111-8111-111111111111',
      spawnFn: spawnServing(profile.model, '{"role":"developer","ok":true}'),
    });
  }

  /** One review, on the fixed Tech Lead model. */
  async function review(decision) {
    return invokeAgent({
      executable: 'claude',
      model: 'claude-fable-5-1',
      expectedFamily: 'fable',
      expectedRole: 'tech_lead',
      prompt: 'review',
      sessionId: '22222222-2222-4222-8222-222222222222',
      spawnFn: spawnServing('claude-fable-5-1', '{"role":"tech_lead","ok":true}'),
    }).then((outcome) => ({ outcome, decision }));
  }

  // --- Goal A: R1 starts on the standard executor --------------------------
  let execution = { goal: '006', round: 1 };
  const r1 = resolveProfileForRound({
    goalExecution: execution,
    round: 1,
    planningRecord: { profile: 'SONNET_MEDIUM', reason: 'Localized implementation with established architecture.' },
  });
  assert.equal(r1.profile.name, 'SONNET_HIGH');
  execution = { ...execution, developerProfile: toExecutionRecord(r1, { goal: '006', round: 1 }) };

  const devR1 = await developerRound({ developerProfile: r1.profile.name });
  assert.equal(devR1.resolvedPrimaryModel, SONNET);

  // --- The review asks for changes AND promotes the next round ------------
  const reviewR1 = validateReviewDecision({
    protocolVersion: PROTOCOL_VERSION_V2,
    jobId: 'j1', goal: '006', round: 1,
    decision: 'CHANGES_REQUIRED',
    blockers: ['tenant scoping missing on the session lookup'],
    nextAction: 'RETURN_TO_DEVELOPER',
    nextDeveloperProfile: 'OPUS_HIGH',
    nextDeveloperProfileReason: 'Tenant isolation and session ownership.',
  }, { jobId: 'j1', goal: '006', round: 1 });
  await review(reviewR1);

  // --- R2 runs on what the Tech Lead chose --------------------------------
  const r2 = resolveProfileForRound({
    goalExecution: execution,
    round: 2,
    techLeadEscalation: {
      profile: reviewR1.nextDeveloperProfile,
      reason: reviewR1.nextDeveloperProfileReason,
    },
  });
  assert.equal(r2.profile.name, 'OPUS_HIGH');
  assert.equal(r2.changed, true);
  execution = { ...execution, round: 2, developerProfile: toExecutionRecord(r2, { goal: '006', round: 2 }) };

  const devR2 = await developerRound({ developerProfile: r2.profile.name });
  assert.equal(devR2.resolvedPrimaryModel, OPUS);

  const reviewR2 = validateReviewDecision({
    protocolVersion: PROTOCOL_VERSION_V2,
    jobId: 'j2', goal: '006', round: 2,
    decision: 'ACCEPTED', blockers: [], nextAction: 'STOP',
  }, { jobId: 'j2', goal: '006', round: 2 });
  await review(reviewR2);
  assert.equal(reviewR2.decision, 'ACCEPTED');

  // --- The claims this whole feature rests on -----------------------------
  // Exactly the four calls the workflow already made: two Developer rounds and
  // two reviews. Selecting a model added none.
  assert.equal(calls.length, 4, `expected 4 inferences, got ${calls.length}`);
  assert.deepEqual(calls, [
    { model: SONNET, effort: 'high', usedFallbackFlag: false },
    { model: 'claude-fable-5-1', effort: null, usedFallbackFlag: false },
    { model: OPUS, effort: 'high', usedFallbackFlag: false },
    { model: 'claude-fable-5-1', effort: null, usedFallbackFlag: false },
  ]);

  // And a restart of R2 still finds OPUS_HIGH.
  assert.equal(resolveProfileForRound({ goalExecution: execution, round: 2 }).profile.name, 'OPUS_HIGH');
});

test('the status screen reads the profile name from the persisted record', () => {
  // The persisted record names the profile in `profile`; the registry entry
  // names it in `name`. Reading only `name` printed "Profile: undefined" on a
  // real, correctly repaired run.
  const record = toExecutionRecord(
    resolveProfileForRound({ round: 1, adaptive: false, planningRecord: { profile: 'OPUS_HIGH' } }),
    { goal: '006', round: 1 },
  );
  assert.equal(record.profile, 'OPUS_HIGH');
  assert.equal(record.name, undefined, 'the record has no `name` field to fall back on');
  assert.equal(record.profile ?? record.name, 'OPUS_HIGH');
});
