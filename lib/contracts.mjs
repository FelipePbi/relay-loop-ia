/**
 * IA Loop — contracts exchanged between the orchestrator and the agents.
 *
 * The orchestrator must never infer intent from prose. Every decision it makes
 * comes from a validated structured field, so validation here is deliberately
 * strict and fails closed.
 */

import { SpikeError } from './claude-process.mjs';

export const PROTOCOL_VERSION = 1;

/** Developer statuses accepted in V1. The correction loop does not exist yet. */
export const DEVELOPER_STATUSES = Object.freeze(['REVIEW_REQUIRED']);

export const REVIEW_DECISIONS = Object.freeze(['ACCEPTED', 'CHANGES_REQUIRED', 'HUMAN_REQUIRED']);

export const NEXT_ACTIONS = Object.freeze(['STOP', 'RETURN_TO_DEVELOPER', 'HUMAN_REQUIRED']);

/**
 * The only next action coherent with each decision.
 * Anything else is a contract violation, not a judgement call.
 */
const DECISION_TO_NEXT_ACTION = Object.freeze({
  ACCEPTED: 'STOP',
  CHANGES_REQUIRED: 'RETURN_TO_DEVELOPER',
  HUMAN_REQUIRED: 'HUMAN_REQUIRED',
});

/** JSON Schema handed to the CLI so the model is steered toward the shape. */
export const DEVELOPER_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    protocolVersion: { type: 'integer' },
    role: { type: 'string' },
    taskId: { type: 'string' },
    status: { type: 'string', enum: [...DEVELOPER_STATUSES] },
    summary: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' }, minItems: 1 },
  },
  required: ['protocolVersion', 'role', 'taskId', 'status', 'summary', 'evidence'],
  additionalProperties: false,
});

export const REVIEWER_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    protocolVersion: { type: 'integer' },
    role: { type: 'string' },
    taskId: { type: 'string' },
    decision: { type: 'string', enum: [...REVIEW_DECISIONS] },
    blockers: { type: 'array', items: { type: 'string' } },
    nextAction: { type: 'string', enum: [...NEXT_ACTIONS] },
  },
  required: ['protocolVersion', 'role', 'taskId', 'decision', 'blockers', 'nextAction'],
  additionalProperties: false,
});

function fail(code, message, details = {}) {
  throw new SpikeError(code, message, details);
}

function assertObject(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('CONTRACT_FIELD_INVALID', 'Payload is not a JSON object');
  }
}

function assertEnvelopeBasics(payload, { expectedRole, expectedTaskId }) {
  if (payload.protocolVersion !== PROTOCOL_VERSION) {
    fail(
      'UNSUPPORTED_PROTOCOL_VERSION',
      `Expected protocolVersion ${PROTOCOL_VERSION} but received ${JSON.stringify(payload.protocolVersion)}`,
    );
  }
  if (payload.role !== expectedRole) {
    fail('ROLE_MISMATCH', `Expected role "${expectedRole}" but received ${JSON.stringify(payload.role)}`);
  }
  if (payload.taskId !== expectedTaskId) {
    fail(
      'TASK_ID_MISMATCH',
      `Expected taskId "${expectedTaskId}" but received ${JSON.stringify(payload.taskId)}`,
    );
  }
}

function assertNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('CONTRACT_FIELD_INVALID', `Field "${field}" must be a non-empty string`);
  }
}

function assertStringArray(value, field) {
  if (!Array.isArray(value)) {
    fail('CONTRACT_FIELD_INVALID', `Field "${field}" must be an array`);
  }
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      fail('CONTRACT_FIELD_INVALID', `Field "${field}" must contain only non-empty strings`);
    }
  }
}

/**
 * Validates the Developer's structured result.
 * Returns a frozen copy so downstream code cannot mutate what was validated.
 */
export function validateDeveloperResult(payload, { taskId }) {
  assertObject(payload);
  assertEnvelopeBasics(payload, { expectedRole: 'developer', expectedTaskId: taskId });

  if (!DEVELOPER_STATUSES.includes(payload.status)) {
    fail(
      'UNSUPPORTED_STATUS',
      `Status ${JSON.stringify(payload.status)} is not supported in V1 (expected one of: ${DEVELOPER_STATUSES.join(', ')})`,
    );
  }

  assertNonEmptyString(payload.summary, 'summary');
  assertStringArray(payload.evidence, 'evidence');
  if (payload.evidence.length === 0) {
    fail('CONTRACT_FIELD_INVALID', 'Field "evidence" must contain at least one entry');
  }

  return Object.freeze({
    protocolVersion: payload.protocolVersion,
    role: payload.role,
    taskId: payload.taskId,
    status: payload.status,
    summary: payload.summary,
    evidence: Object.freeze([...payload.evidence]),
  });
}

/**
 * Validates the Tech Lead's structured review decision, including coherence
 * between `decision`, `blockers` and `nextAction`.
 */
export function validateReviewDecision(payload, { taskId }) {
  assertObject(payload);
  assertEnvelopeBasics(payload, { expectedRole: 'tech_lead', expectedTaskId: taskId });

  if (!REVIEW_DECISIONS.includes(payload.decision)) {
    fail(
      'UNSUPPORTED_DECISION',
      `Decision ${JSON.stringify(payload.decision)} is not allowed (expected one of: ${REVIEW_DECISIONS.join(', ')})`,
    );
  }

  if (!NEXT_ACTIONS.includes(payload.nextAction)) {
    fail(
      'UNSUPPORTED_NEXT_ACTION',
      `nextAction ${JSON.stringify(payload.nextAction)} is not allowed (expected one of: ${NEXT_ACTIONS.join(', ')})`,
    );
  }

  assertStringArray(payload.blockers, 'blockers');

  if (payload.decision === 'ACCEPTED' && payload.blockers.length > 0) {
    fail('DECISION_BLOCKERS_INCOHERENT', 'ACCEPTED must come with an empty blockers list');
  }
  if (payload.decision === 'CHANGES_REQUIRED' && payload.blockers.length === 0) {
    fail('DECISION_BLOCKERS_INCOHERENT', 'CHANGES_REQUIRED must list at least one blocker');
  }

  const expectedNextAction = DECISION_TO_NEXT_ACTION[payload.decision];
  if (payload.nextAction !== expectedNextAction) {
    fail(
      'DECISION_NEXT_ACTION_INCOHERENT',
      `Decision "${payload.decision}" requires nextAction "${expectedNextAction}" but received "${payload.nextAction}"`,
    );
  }

  return Object.freeze({
    protocolVersion: payload.protocolVersion,
    role: payload.role,
    taskId: payload.taskId,
    decision: payload.decision,
    blockers: Object.freeze([...payload.blockers]),
    nextAction: payload.nextAction,
  });
}

/**
 * Builds the hand-off payload the Reviewer receives.
 *
 * This is the ONLY channel between the two agents: they never share a session,
 * so everything the Reviewer knows is what the orchestrator puts here.
 */
export function buildReviewRequest({ taskId, taskDescription, developerResult }) {
  assertNonEmptyString(taskId, 'taskId');
  assertNonEmptyString(taskDescription, 'taskDescription');
  if (developerResult?.taskId !== taskId) {
    fail('TASK_ID_MISMATCH', 'Developer result does not belong to this task');
  }

  return Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    taskId,
    taskDescription,
    developerResult,
  });
}
