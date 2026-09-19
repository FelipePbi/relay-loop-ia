/**
 * Following an authorised successor attempt.
 *
 * `findAuthorizedSuccessor` is pure: it takes the shape `readAttemptState`
 * returns and says whether the CURRENT attempt is a provable, authorised
 * descendant of the one a waiter was told to wait for. No store, no I/O, no
 * model — every case here is a plain object.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { HANDOFF_REFUSALS, findAuthorizedSuccessor } from '../lib/attempt-handoff.mjs';

const JOB = '005-r2-tech_lead-8eec8bd3';
const a = (n) => `${JOB}-a${n}`;

function state(attempt, history) {
  return { attempt, attemptId: a(attempt), history };
}

test('already on the current attempt: nothing to hand off', () => {
  const s = state(1, []);
  assert.equal(findAuthorizedSuccessor(s, a(1)), null);
});

test('no expected attempt given: nothing to hand off', () => {
  const s = state(2, [{ attempt: 1, attemptId: a(1), status: 'INTERRUPTED' }]);
  assert.equal(findAuthorizedSuccessor(s, null), null);
});

// --- Authorised: the store's own retryable statuses -----------------------

test('capacity retry lineage: USAGE_LIMIT -> WAITING_FOR_CAPACITY is authorised', () => {
  const s = state(2, [{
    attempt: 1, attemptId: a(1), status: 'WAITING_FOR_CAPACITY', reason: 'USAGE_LIMIT',
  }]);
  const successor = findAuthorizedSuccessor(s, a(1));
  assert.equal(successor.authorized, true);
  assert.equal(successor.attemptId, a(2));
  assert.equal(successor.fromAttemptId, a(1));
  assert.equal(successor.endedReason, 'USAGE_LIMIT');
  assert.equal(successor.hops, 1);
});

test('rate limit lineage: same WAITING_FOR_CAPACITY door, different reason', () => {
  const s = state(2, [{ attempt: 1, attemptId: a(1), status: 'WAITING_FOR_CAPACITY', reason: 'RATE_LIMIT' }]);
  const successor = findAuthorizedSuccessor(s, a(1));
  assert.equal(successor.authorized, true);
  assert.equal(successor.endedReason, 'RATE_LIMIT');
});

test('interrupted retry lineage: a crash, a reboot, a closed terminal', () => {
  const s = state(2, [{ attempt: 1, attemptId: a(1), status: 'INTERRUPTED', reason: 'RECOVERED_INTERRUPTED_ATTEMPT' }]);
  const successor = findAuthorizedSuccessor(s, a(1));
  assert.equal(successor.authorized, true);
});

test('harness retry lineage: FAILED, but explicitly authorised', () => {
  const s = state(2, [{
    attempt: 1, attemptId: a(1), status: 'FAILED', reason: 'HARNESS_ERROR', retryAuthorizedBy: 'HARNESS_BUG_FIXED',
  }]);
  const successor = findAuthorizedSuccessor(s, a(1));
  assert.equal(successor.authorized, true);
  assert.equal(successor.endedReason, 'HARNESS_ERROR');
});

test('multi-hop chain: capacity wait, then a harness failure, then a repair', () => {
  const s = state(3, [
    { attempt: 1, attemptId: a(1), status: 'WAITING_FOR_CAPACITY', reason: 'USAGE_LIMIT' },
    { attempt: 2, attemptId: a(2), status: 'FAILED', reason: 'HARNESS_ERROR', retryAuthorizedBy: 'HARNESS_BUG_FIXED' },
  ]);
  const successor = findAuthorizedSuccessor(s, a(1));
  assert.equal(successor.authorized, true);
  assert.equal(successor.attemptId, a(3));
  assert.equal(successor.hops, 2);
});

test('waiting on the middle attempt of a multi-hop chain also hands off cleanly', () => {
  const s = state(3, [
    { attempt: 1, attemptId: a(1), status: 'WAITING_FOR_CAPACITY', reason: 'USAGE_LIMIT' },
    { attempt: 2, attemptId: a(2), status: 'INTERRUPTED', reason: 'RECOVERED_INTERRUPTED_ATTEMPT' },
  ]);
  const successor = findAuthorizedSuccessor(s, a(2));
  assert.equal(successor.authorized, true);
  assert.equal(successor.hops, 1);
});

// --- Refused: nothing in the store's own vocabulary authorises these ------

test('a plain FAILED with no retry authorisation refuses the handoff', () => {
  const s = state(2, [{ attempt: 1, attemptId: a(1), status: 'FAILED', reason: 'UNKNOWN_FATAL' }]);
  const successor = findAuthorizedSuccessor(s, a(1));
  assert.equal(successor.authorized, false);
  assert.equal(successor.reason, HANDOFF_REFUSALS.NOT_AUTHORIZED);
});

test('SUPERSEDED refuses the handoff', () => {
  const s = state(2, [{ attempt: 1, attemptId: a(1), status: 'SUPERSEDED' }]);
  const successor = findAuthorizedSuccessor(s, a(1));
  assert.equal(successor.authorized, false);
  assert.equal(successor.reason, HANDOFF_REFUSALS.NOT_AUTHORIZED);
});

test('an attempt this job never recorded refuses the handoff', () => {
  // Simulates "a3 without lineage": the job is on attempt 3, but nothing in
  // its history explains how attempt 1 (what the waiter has) got there.
  const s = state(3, [{ attempt: 2, attemptId: a(2), status: 'WAITING_FOR_CAPACITY', reason: 'USAGE_LIMIT' }]);
  const successor = findAuthorizedSuccessor(s, a(1));
  assert.equal(successor.authorized, false);
  assert.equal(successor.reason, HANDOFF_REFUSALS.UNKNOWN_ATTEMPT);
});

test('a gap in the chain refuses the handoff', () => {
  // attempt 1 ended legitimately, but there is no record of how attempt 2
  // ended even though the job is already on attempt 3.
  const s = state(3, [{ attempt: 1, attemptId: a(1), status: 'WAITING_FOR_CAPACITY', reason: 'USAGE_LIMIT' }]);
  const successor = findAuthorizedSuccessor(s, a(1));
  assert.equal(successor.authorized, false);
  assert.equal(successor.reason, HANDOFF_REFUSALS.BROKEN_LINEAGE);
  assert.equal(successor.brokenAtAttempt, 2);
});

test('a completed attempt would never be waited on, but if it were, no handoff is offered', () => {
  const s = state(1, []);
  assert.equal(findAuthorizedSuccessor(s, a(1)), null);
});

test('conflicting lineage — two history entries claiming the same attempt number — refuses', () => {
  // Not reachable through the store's own APIs (startNextAttempt serialises
  // every increment behind a lock file); this is the defensive check for a
  // hand-edited or corrupted job record. "Latest wins" is exactly the
  // shortcut this must refuse.
  const s = state(3, [
    { attempt: 1, attemptId: a(1), status: 'WAITING_FOR_CAPACITY', reason: 'USAGE_LIMIT' },
    { attempt: 2, attemptId: a(2), status: 'INTERRUPTED' },
    { attempt: 2, attemptId: `${JOB}-a2b`, status: 'INTERRUPTED' },
  ]);
  const successor = findAuthorizedSuccessor(s, a(1));
  assert.equal(successor.authorized, false);
  assert.equal(successor.reason, HANDOFF_REFUSALS.CONFLICTING_LINEAGE);
  assert.equal(successor.attempt, 2);
});

test('a missing state (job not found) never hands off', () => {
  assert.equal(findAuthorizedSuccessor(null, a(1)), null);
});
