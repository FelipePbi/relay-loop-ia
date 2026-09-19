/**
 * Contract validation tests. No model calls are made here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROTOCOL_VERSION,
  buildReviewRequest,
  validateDeveloperResult,
  validateReviewDecision,
} from '../lib/contracts.mjs';

const TASK_ID = 'synthetic-001';

function developerResult(overrides = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    role: 'developer',
    taskId: TASK_ID,
    status: 'REVIEW_REQUIRED',
    summary: 'sum(a, b) returns the arithmetic sum of both arguments.',
    evidence: ['Two positive integers add normally.', 'Zero is the identity element.'],
    ...overrides,
  };
}

function reviewDecision(overrides = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    role: 'tech_lead',
    taskId: TASK_ID,
    decision: 'ACCEPTED',
    blockers: [],
    nextAction: 'STOP',
    ...overrides,
  };
}

const codeIs = (code) => (error) => error.code === code;

// --- Developer contract ----------------------------------------------------

test('a valid Developer result passes and is frozen', () => {
  const validated = validateDeveloperResult(developerResult(), { taskId: TASK_ID });

  assert.equal(validated.role, 'developer');
  assert.equal(validated.status, 'REVIEW_REQUIRED');
  assert.equal(validated.evidence.length, 2);
  assert.ok(Object.isFrozen(validated));
});

test('a Developer result with the wrong role is rejected', () => {
  assert.throws(
    () => validateDeveloperResult(developerResult({ role: 'tech_lead' }), { taskId: TASK_ID }),
    codeIs('ROLE_MISMATCH'),
  );
});

test('a diverging taskId is rejected', () => {
  assert.throws(
    () => validateDeveloperResult(developerResult({ taskId: 'synthetic-999' }), { taskId: TASK_ID }),
    codeIs('TASK_ID_MISMATCH'),
  );
});

test('an unexpected Developer status is rejected', () => {
  assert.throws(
    () => validateDeveloperResult(developerResult({ status: 'DONE' }), { taskId: TASK_ID }),
    codeIs('UNSUPPORTED_STATUS'),
  );
});

test('a wrong protocol version is rejected', () => {
  assert.throws(
    () => validateDeveloperResult(developerResult({ protocolVersion: 2 }), { taskId: TASK_ID }),
    codeIs('UNSUPPORTED_PROTOCOL_VERSION'),
  );
});

test('malformed Developer fields are rejected', () => {
  const cases = [
    developerResult({ summary: '   ' }),
    developerResult({ evidence: [] }),
    developerResult({ evidence: 'not an array' }),
    developerResult({ evidence: ['ok', ''] }),
  ];
  for (const payload of cases) {
    assert.throws(
      () => validateDeveloperResult(payload, { taskId: TASK_ID }),
      codeIs('CONTRACT_FIELD_INVALID'),
    );
  }
});

test('a non-object Developer payload is rejected', () => {
  for (const payload of ['nope', null, [1, 2]]) {
    assert.throws(
      () => validateDeveloperResult(payload, { taskId: TASK_ID }),
      codeIs('CONTRACT_FIELD_INVALID'),
    );
  }
});

// --- Reviewer contract -----------------------------------------------------

test('ACCEPTED with no blockers and STOP is valid', () => {
  const validated = validateReviewDecision(reviewDecision(), { taskId: TASK_ID });
  assert.equal(validated.decision, 'ACCEPTED');
  assert.equal(validated.nextAction, 'STOP');
  assert.deepEqual([...validated.blockers], []);
});

test('CHANGES_REQUIRED with blockers and RETURN_TO_DEVELOPER is valid', () => {
  const validated = validateReviewDecision(
    reviewDecision({
      decision: 'CHANGES_REQUIRED',
      blockers: ['Evidence does not mention invalid input.'],
      nextAction: 'RETURN_TO_DEVELOPER',
    }),
    { taskId: TASK_ID },
  );

  assert.equal(validated.decision, 'CHANGES_REQUIRED');
  assert.equal(validated.nextAction, 'RETURN_TO_DEVELOPER');
  assert.equal(validated.blockers.length, 1);
});

test('HUMAN_REQUIRED with HUMAN_REQUIRED is valid', () => {
  const validated = validateReviewDecision(
    reviewDecision({ decision: 'HUMAN_REQUIRED', nextAction: 'HUMAN_REQUIRED' }),
    { taskId: TASK_ID },
  );

  assert.equal(validated.decision, 'HUMAN_REQUIRED');
  assert.equal(validated.nextAction, 'HUMAN_REQUIRED');
});

test('ACCEPTED carrying blockers is incoherent', () => {
  assert.throws(
    () => validateReviewDecision(
      reviewDecision({ blockers: ['something is off'] }),
      { taskId: TASK_ID },
    ),
    codeIs('DECISION_BLOCKERS_INCOHERENT'),
  );
});

test('CHANGES_REQUIRED without blockers is incoherent', () => {
  assert.throws(
    () => validateReviewDecision(
      reviewDecision({ decision: 'CHANGES_REQUIRED', blockers: [], nextAction: 'RETURN_TO_DEVELOPER' }),
      { taskId: TASK_ID },
    ),
    codeIs('DECISION_BLOCKERS_INCOHERENT'),
  );
});

test('a decision incompatible with its nextAction is rejected', () => {
  const cases = [
    reviewDecision({ nextAction: 'RETURN_TO_DEVELOPER' }),
    reviewDecision({ decision: 'CHANGES_REQUIRED', blockers: ['x'], nextAction: 'STOP' }),
    reviewDecision({ decision: 'HUMAN_REQUIRED', nextAction: 'STOP' }),
  ];
  for (const payload of cases) {
    assert.throws(
      () => validateReviewDecision(payload, { taskId: TASK_ID }),
      codeIs('DECISION_NEXT_ACTION_INCOHERENT'),
    );
  }
});

test('an unknown decision or nextAction is rejected', () => {
  assert.throws(
    () => validateReviewDecision(reviewDecision({ decision: 'LGTM' }), { taskId: TASK_ID }),
    codeIs('UNSUPPORTED_DECISION'),
  );
  assert.throws(
    () => validateReviewDecision(reviewDecision({ nextAction: 'MERGE' }), { taskId: TASK_ID }),
    codeIs('UNSUPPORTED_NEXT_ACTION'),
  );
});

test('a Reviewer result with the wrong role or taskId is rejected', () => {
  assert.throws(
    () => validateReviewDecision(reviewDecision({ role: 'developer' }), { taskId: TASK_ID }),
    codeIs('ROLE_MISMATCH'),
  );
  assert.throws(
    () => validateReviewDecision(reviewDecision({ taskId: 'other' }), { taskId: TASK_ID }),
    codeIs('TASK_ID_MISMATCH'),
  );
});

test('blockers must be an array of non-empty strings', () => {
  assert.throws(
    () => validateReviewDecision(
      reviewDecision({ decision: 'CHANGES_REQUIRED', blockers: 'nope', nextAction: 'RETURN_TO_DEVELOPER' }),
      { taskId: TASK_ID },
    ),
    codeIs('CONTRACT_FIELD_INVALID'),
  );
});

// --- Hand-off --------------------------------------------------------------

test('buildReviewRequest carries the task and the validated Developer result', () => {
  const validated = validateDeveloperResult(developerResult(), { taskId: TASK_ID });
  const request = buildReviewRequest({
    taskId: TASK_ID,
    taskDescription: 'describe sum(a, b)',
    developerResult: validated,
  });

  assert.equal(request.taskId, TASK_ID);
  assert.equal(request.protocolVersion, PROTOCOL_VERSION);
  assert.equal(request.developerResult.summary, validated.summary);
  assert.ok(Object.isFrozen(request));
});

test('buildReviewRequest refuses a Developer result from another task', () => {
  const foreign = validateDeveloperResult(
    developerResult({ taskId: 'synthetic-999' }),
    { taskId: 'synthetic-999' },
  );

  assert.throws(
    () => buildReviewRequest({
      taskId: TASK_ID,
      taskDescription: 'describe sum(a, b)',
      developerResult: foreign,
    }),
    codeIs('TASK_ID_MISMATCH'),
  );
});
