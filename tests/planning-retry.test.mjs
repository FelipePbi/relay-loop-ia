/**
 * What this file proves: a planning attempt whose ANSWER violated the contract
 * is owed one directed retry, everything else stops, and the decision does not
 * depend on which invocation of `ia-loop:close` is asking.
 *
 * The last point is the whole reason this module exists. The rule was already
 * written inside `run-close`, on the branch taken when a person re-ran the
 * command — so the same PLAN_INVALID was retried on a second invocation and
 * killed the autonomous run on the first. Goal020 stopped exactly there.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLANNING_FAILURE_ACTIONS,
  RETRYABLE_PLANNING_CODE,
  classifyPlanningFailure,
  findPlanningFailureEvent,
} from '../lib/planning-retry.mjs';

const JOB = '020-r2-tech_lead-42ce5a76';

/** The envelope a rejected planning answer leaves behind. */
const failedEnvelope = (code = 'UNKNOWN_FATAL', message = 'Unrecoverable failure') => ({
  ok: false, code, message,
});

/** The AGENT_FAILURE event that carries the real contract code. */
const failureEvent = (code, diagnostic = 'Work Unit id "WU1" is not in the expected shape') => ({
  type: 'AGENT_FAILURE', jobId: JOB, code, diagnostic,
});

// ===========================================================================
// The one retryable case
// ===========================================================================

test('a contract violation in the answer is owed one directed retry', () => {
  const decision = classifyPlanningFailure({
    envelope: failedEnvelope(),
    failureEvent: failureEvent(RETRYABLE_PLANNING_CODE),
    jobId: JOB,
  });

  assert.equal(decision.action, PLANNING_FAILURE_ACTIONS.RETRY_WITH_FEEDBACK);
  assert.equal(decision.code, RETRYABLE_PLANNING_CODE);
  assert.match(decision.diagnostic, /WU1/, 'the violation itself is what makes the retry directed');
  assert.match(decision.message, /retrying with the violation as explicit feedback/);
});

test('the envelope code is never mistaken for the contract code', () => {
  // The envelope says UNKNOWN_FATAL — the capacity taxonomy's label for
  // "inexplicable". Reading THAT as the contract code is what would make a
  // retryable violation look unrepairable.
  const decision = classifyPlanningFailure({
    envelope: failedEnvelope('UNKNOWN_FATAL'),
    failureEvent: failureEvent(RETRYABLE_PLANNING_CODE),
    jobId: JOB,
  });

  assert.equal(decision.action, PLANNING_FAILURE_ACTIONS.RETRY_WITH_FEEDBACK);
});

test('a violation whose diagnostic did not survive sanitisation still retries', () => {
  const event = { type: 'AGENT_FAILURE', jobId: JOB, code: RETRYABLE_PLANNING_CODE };
  const decision = classifyPlanningFailure({ envelope: failedEnvelope(), failureEvent: event, jobId: JOB });

  assert.equal(decision.action, PLANNING_FAILURE_ACTIONS.RETRY_WITH_FEEDBACK);
  assert.equal(decision.diagnostic, null, 'absent, not undefined — the caller must be able to test for it');
});

// ===========================================================================
// Everything else stops
// ===========================================================================

test('a failure that is not a contract violation stops, and says why', () => {
  const decision = classifyPlanningFailure({
    envelope: failedEnvelope('QUOTA_EXHAUSTED', 'out of quota'),
    failureEvent: failureEvent('AGENT_SESSION_FAILED'),
    jobId: JOB,
  });

  assert.equal(decision.action, PLANNING_FAILURE_ACTIONS.STOP);
  assert.match(decision.message, /QUOTA_EXHAUSTED: out of quota/);
  assert.match(decision.message, /not an automatically-retryable content violation/);
});

test('a failure with no AGENT_FAILURE event at all stops', () => {
  // Nothing recorded the contract code, so nothing proves it is retryable.
  // Guessing here would retry harness faults and quota walls forever.
  const decision = classifyPlanningFailure({ envelope: failedEnvelope(), failureEvent: null, jobId: JOB });

  assert.equal(decision.action, PLANNING_FAILURE_ACTIONS.STOP);
  assert.equal(decision.code, null);
});

test('a successful envelope is owed nothing, and does not throw', () => {
  const decision = classifyPlanningFailure({ envelope: { ok: true }, failureEvent: null, jobId: JOB });

  assert.equal(decision.action, PLANNING_FAILURE_ACTIONS.STOP);
  assert.match(decision.message, /did not fail/);
});

test('an absent envelope stops rather than being read as retryable', () => {
  const decision = classifyPlanningFailure({});

  assert.equal(decision.action, PLANNING_FAILURE_ACTIONS.STOP);
  assert.match(decision.message, /UNKNOWN/);
});

// ===========================================================================
// The asymmetry this module exists to remove
// ===========================================================================

test('the same violation decides the same way on the first attempt and on re-entry', () => {
  const event = failureEvent(RETRYABLE_PLANNING_CODE);

  // First attempt: the envelope was just awaited, in memory.
  const first = classifyPlanningFailure({ envelope: failedEnvelope(), failureEvent: event, jobId: JOB });
  // Re-entry: the identical envelope, read back from disk on a later run.
  const reentry = classifyPlanningFailure({ envelope: failedEnvelope(), failureEvent: event, jobId: JOB });

  assert.deepEqual(first, reentry, 'which invocation is asking must not change the answer');
  assert.equal(first.action, PLANNING_FAILURE_ACTIONS.RETRY_WITH_FEEDBACK);
});

// ===========================================================================
// Finding the event
// ===========================================================================

test('the failure event is the LAST one recorded for that job', () => {
  const events = [
    { type: 'AGENT_FAILURE', jobId: JOB, code: 'AGENT_SESSION_FAILED', diagnostic: 'first' },
    { type: 'GOAL_ACCEPTED', jobId: JOB },
    { type: 'AGENT_FAILURE', jobId: JOB, code: RETRYABLE_PLANNING_CODE, diagnostic: 'second' },
  ];

  assert.equal(findPlanningFailureEvent(events, JOB).diagnostic, 'second');
});

test('failures belonging to another job are never read as this one', () => {
  const events = [{ type: 'AGENT_FAILURE', jobId: 'other-job', code: RETRYABLE_PLANNING_CODE }];

  assert.equal(findPlanningFailureEvent(events, JOB), null);
});

test('a missing job id or a missing history yields null, not a throw', () => {
  assert.equal(findPlanningFailureEvent([], JOB), null);
  assert.equal(findPlanningFailureEvent(null, JOB), null);
  assert.equal(findPlanningFailureEvent([{ type: 'AGENT_FAILURE', jobId: JOB }], null), null);
});

// ===========================================================================
// The Goal020 story
// ===========================================================================

test('the Goal020 story: UNKNOWN_FATAL envelope, PLAN_INVALID event, retry rather than a stopped campaign', () => {
  // What the run actually recorded on 2026-09-15 at 07:00:53Z.
  const events = [
    {
      type: 'AGENT_FAILURE', goal: '020', round: 2, agent: 'tech_lead', jobId: JOB,
      reason: 'UNKNOWN_FATAL', code: 'PLAN_INVALID',
      diagnostic: 'Work Unit id "WU1" is not in the expected shape '
        + '(WU|VERIFY|FIX|DIAG followed by up to three digits, e.g. WU-001)',
    },
  ];

  const found = findPlanningFailureEvent(events, JOB);
  const decision = classifyPlanningFailure({ envelope: failedEnvelope(), failureEvent: found, jobId: JOB });

  assert.equal(decision.action, PLANNING_FAILURE_ACTIONS.RETRY_WITH_FEEDBACK);
  assert.match(decision.diagnostic, /expected shape/, 'the next prompt gets the rule it broke, not just "try again"');
});
