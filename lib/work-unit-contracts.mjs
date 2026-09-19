/**
 * IA Loop — the contract one Work Unit answers under.
 *
 * The Developer contract (contracts-v2.mjs) describes a whole ROUND: an
 * implementation report, the validations that were run, and a status the
 * orchestrator turns into a state transition. A Work Unit is smaller and its
 * answer has to carry three things a round's answer never had to:
 *
 *   ACCEPTANCE   the unit was given explicit acceptance criteria, so it must
 *                say, criterion by criterion, whether it met them. Without
 *                this a unit's result is the model's own opinion of its work,
 *                and the aggregate report would inherit that opinion silently.
 *   ESCALATION   "this is not as mechanical as the plan thought" is a real
 *                outcome, not a failure — same reasoning as the round-level
 *                ESCALATION_REQUIRED, one tier down.
 *   CONTEXT      "I was given a small context on purpose and it is genuinely
 *                not enough" must be sayable STRUCTURALLY. Context slicing is
 *                only safe if the sliced-out case has a way back, and reading
 *                that intent out of prose would put a re-dispatch behind a
 *                regex.
 *
 * Everything is validated strictly and fails closed, exactly like V2.
 */

import { SpikeError } from './claude-process.mjs';
import { PROTOCOL_VERSION_V2 } from './contracts-v2.mjs';
import { ALL_WORK_UNIT_ESCALATION_REASONS } from './model-routing.mjs';

export const WORK_UNIT_STATUSES = Object.freeze([
  'COMPLETED', 'BLOCKED', 'ESCALATION_REQUIRED', 'CONTEXT_EXPANSION_REQUIRED',
]);

export const CONFIDENCE_LEVELS = Object.freeze(['LOW', 'MEDIUM', 'HIGH']);

/**
 * Why a unit says its context was insufficient. Closed, so an expansion is
 * something the harness can count and reason about later — an expansion rate
 * is how you find out the slicing went too far.
 */
export const CONTEXT_REQUEST_REASONS = Object.freeze([
  'MISSING_TYPE_OR_CONTRACT',
  'MISSING_CALLER_OR_CONSUMER',
  'MISSING_EXISTING_PATTERN',
  'MISSING_TEST_FIXTURE',
  'DEPENDENCY_OUTPUT_INSUFFICIENT',
]);

/** How many extra files one expansion request may ask for. */
export const MAX_REQUESTED_FILES = 12;

function fail(code, message, details = {}) {
  throw new SpikeError(code, message, details);
}

function assertObject(payload, what) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('CONTRACT_FIELD_INVALID', `${what} is not a JSON object`);
  }
}

function assertNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('CONTRACT_FIELD_INVALID', `Field "${field}" must be a non-empty string`);
  }
}

function assertStringArray(value, field, { maxItems = 200 } = {}) {
  if (!Array.isArray(value)) fail('CONTRACT_FIELD_INVALID', `Field "${field}" must be an array`);
  if (value.length > maxItems) {
    fail('CONTRACT_FIELD_INVALID', `Field "${field}" carries ${value.length} entries; the limit is ${maxItems}`);
  }
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      fail('CONTRACT_FIELD_INVALID', `Field "${field}" must contain only non-empty strings`);
    }
  }
}

/**
 * Validates one Work Unit's answer.
 *
 * The identity fields are checked against what was dispatched, for the same
 * reason the V2 contracts do it: a model that answers with the Goal id where a
 * job id belongs must be refused, not reconciled.
 */
export function validateWorkUnitResult(payload, { jobId, goal, round, workUnitId, acceptanceCriteria = [] }) {
  assertObject(payload, 'WorkUnitResult');

  if (payload.protocolVersion !== PROTOCOL_VERSION_V2) {
    fail(
      'UNSUPPORTED_PROTOCOL_VERSION',
      `Expected protocolVersion ${PROTOCOL_VERSION_V2} but received ${JSON.stringify(payload.protocolVersion)}`,
    );
  }
  if (payload.jobId !== jobId) {
    fail('JOB_ID_MISMATCH', `Expected jobId "${jobId}" but received ${JSON.stringify(payload.jobId)}`);
  }
  if (payload.goal !== goal) {
    fail('GOAL_MISMATCH', `Expected goal "${goal}" but received ${JSON.stringify(payload.goal)}`);
  }
  if (payload.round !== round) {
    fail('ROUND_MISMATCH', `Expected round ${round} but received ${JSON.stringify(payload.round)}`);
  }
  if (payload.workUnitId !== workUnitId) {
    fail('WORK_UNIT_MISMATCH', `Expected workUnitId "${workUnitId}" but received ${JSON.stringify(payload.workUnitId)}`);
  }
  if (!WORK_UNIT_STATUSES.includes(payload.status)) {
    fail(
      'UNSUPPORTED_STATUS',
      `Status ${JSON.stringify(payload.status)} is not allowed (expected one of: ${WORK_UNIT_STATUSES.join(', ')})`,
    );
  }

  assertNonEmptyString(payload.summary, 'summary');
  assertNonEmptyString(payload.report, 'report');
  assertStringArray(payload.changedFiles ?? [], 'changedFiles', { maxItems: 100 });

  const acceptance = validateAcceptance(payload.acceptance, {
    // Only a COMPLETED unit is claiming it finished, so only a COMPLETED unit
    // owes an answer for every criterion. A unit that escalated or asked for
    // more context has explicitly NOT finished, and demanding a verdict on
    // criteria it never reached would only teach it to invent one.
    required: payload.status === 'COMPLETED',
    acceptanceCriteria,
  });

  const escalation = validateEscalation(payload.escalation, {
    required: payload.status === 'ESCALATION_REQUIRED',
  });
  if (escalation && payload.status !== 'ESCALATION_REQUIRED') {
    fail('CONTRACT_FIELD_INVALID', 'Field "escalation" only applies to status ESCALATION_REQUIRED');
  }

  const contextRequest = validateContextRequest(payload.contextRequest, {
    required: payload.status === 'CONTEXT_EXPANSION_REQUIRED',
  });
  if (contextRequest && payload.status !== 'CONTEXT_EXPANSION_REQUIRED') {
    fail('CONTRACT_FIELD_INVALID', 'Field "contextRequest" only applies to status CONTEXT_EXPANSION_REQUIRED');
  }

  if (payload.status === 'BLOCKED') {
    assertNonEmptyString(payload.blockedReason, 'blockedReason');
  }

  return Object.freeze({
    ...payload,
    changedFiles: Object.freeze([...(payload.changedFiles ?? [])]),
    acceptance,
    escalation,
    contextRequest,
    blockedReason: payload.blockedReason ?? null,
  });
}

/**
 * Every acceptance criterion, answered.
 *
 * A COMPLETED unit that skipped a criterion is not completed; it is a unit
 * whose report happens to sound finished. The check is on COUNT, not on
 * wording: the criteria are given in order and answered in order, so a model
 * cannot satisfy this by paraphrasing one of them twice.
 */
function validateAcceptance(value, { required, acceptanceCriteria }) {
  if (value === undefined || value === null) {
    if (required && acceptanceCriteria.length > 0) {
      fail('CONTRACT_FIELD_INVALID', 'A COMPLETED Work Unit must answer its acceptance criteria');
    }
    return Object.freeze([]);
  }
  if (!Array.isArray(value)) fail('CONTRACT_FIELD_INVALID', 'Field "acceptance" must be an array');

  for (const entry of value) {
    assertObject(entry, 'acceptance entry');
    assertNonEmptyString(entry.criterion, 'acceptance[].criterion');
    if (typeof entry.met !== 'boolean') {
      fail('CONTRACT_FIELD_INVALID', 'Field "acceptance[].met" must be a boolean');
    }
  }

  if (required && value.length < acceptanceCriteria.length) {
    fail(
      'ACCEPTANCE_INCOMPLETE',
      `The unit declares COMPLETED but answered ${value.length} of ${acceptanceCriteria.length} acceptance criteria`,
      { answered: value.length, expected: acceptanceCriteria.length },
    );
  }
  if (required && value.some((entry) => entry.met === false)) {
    fail(
      'ACCEPTANCE_NOT_MET',
      'The unit declares COMPLETED while reporting an acceptance criterion it did not meet. '
      + 'A criterion that was not met is BLOCKED or ESCALATION_REQUIRED, never COMPLETED.',
      { unmet: value.filter((entry) => entry.met === false).map((entry) => entry.criterion) },
    );
  }

  return Object.freeze(value.map((entry) => Object.freeze({
    criterion: entry.criterion,
    met: entry.met,
    detail: typeof entry.detail === 'string' ? entry.detail.slice(0, 500) : null,
  })));
}

function validateEscalation(value, { required }) {
  if (value === undefined || value === null) {
    if (required) fail('CONTRACT_FIELD_INVALID', 'Field "escalation" is required for status ESCALATION_REQUIRED');
    return null;
  }
  assertObject(value, 'escalation');
  if (!ALL_WORK_UNIT_ESCALATION_REASONS.includes(value.reason)) {
    fail(
      'CONTRACT_FIELD_INVALID',
      `Field "escalation.reason" must be one of: ${ALL_WORK_UNIT_ESCALATION_REASONS.join(', ')} `
      + `(got ${JSON.stringify(value.reason)})`,
    );
  }
  assertStringArray(value.evidence ?? [], 'escalation.evidence', { maxItems: 10 });
  if ((value.evidence ?? []).length === 0) {
    fail('CONTRACT_FIELD_INVALID', 'Field "escalation.evidence" must carry at least one concrete observation');
  }
  if (value.confidence !== undefined && value.confidence !== null
    && !CONFIDENCE_LEVELS.includes(value.confidence)) {
    fail('CONTRACT_FIELD_INVALID', `Field "escalation.confidence" must be one of: ${CONFIDENCE_LEVELS.join(', ')}`);
  }
  return Object.freeze({
    reason: value.reason,
    confidence: value.confidence ?? null,
    detail: typeof value.detail === 'string' ? value.detail.slice(0, 500) : null,
    evidence: Object.freeze([...value.evidence]),
  });
}

function validateContextRequest(value, { required }) {
  if (value === undefined || value === null) {
    if (required) {
      fail('CONTRACT_FIELD_INVALID', 'Field "contextRequest" is required for status CONTEXT_EXPANSION_REQUIRED');
    }
    return null;
  }
  assertObject(value, 'contextRequest');
  if (!CONTEXT_REQUEST_REASONS.includes(value.reason)) {
    fail(
      'CONTRACT_FIELD_INVALID',
      `Field "contextRequest.reason" must be one of: ${CONTEXT_REQUEST_REASONS.join(', ')} `
      + `(got ${JSON.stringify(value.reason)})`,
    );
  }
  assertStringArray(value.files ?? [], 'contextRequest.files', { maxItems: MAX_REQUESTED_FILES });
  if ((value.files ?? []).length === 0) {
    fail('CONTRACT_FIELD_INVALID', 'Field "contextRequest.files" must name at least one file');
  }
  return Object.freeze({
    reason: value.reason,
    detail: typeof value.detail === 'string' ? value.detail.slice(0, 500) : null,
    files: Object.freeze([...value.files]),
  });
}

/**
 * The schema handed to the CLI, with the identity fields pinned.
 *
 * Pinned for the same reason the V2 schemas pin theirs: an open `jobId` let a
 * model answer with the Goal id, and the mismatch only surfaced after the
 * inference had been paid for.
 */
export function workUnitResultSchemaFor({ jobId, goal, round, workUnitId }) {
  return {
    type: 'object',
    properties: {
      protocolVersion: { type: 'integer', enum: [PROTOCOL_VERSION_V2] },
      jobId: { type: 'string', enum: [jobId] },
      goal: { type: 'string', enum: [goal] },
      round: { type: 'integer', enum: [round] },
      workUnitId: { type: 'string', enum: [workUnitId] },
      status: { type: 'string', enum: [...WORK_UNIT_STATUSES] },
      summary: { type: 'string', maxLength: 400 },
      report: { type: 'string' },
      changedFiles: { type: 'array', items: { type: 'string' } },
      acceptance: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            criterion: { type: 'string' },
            met: { type: 'boolean' },
            detail: { type: 'string', maxLength: 500 },
          },
          required: ['criterion', 'met'],
          additionalProperties: false,
        },
      },
      blockedReason: { type: 'string', maxLength: 500 },
      escalation: {
        type: 'object',
        properties: {
          reason: { type: 'string', enum: [...ALL_WORK_UNIT_ESCALATION_REASONS] },
          confidence: { type: 'string', enum: [...CONFIDENCE_LEVELS] },
          detail: { type: 'string', maxLength: 500 },
          evidence: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
        required: ['reason', 'evidence'],
        additionalProperties: false,
      },
      contextRequest: {
        type: 'object',
        properties: {
          reason: { type: 'string', enum: [...CONTEXT_REQUEST_REASONS] },
          detail: { type: 'string', maxLength: 500 },
          files: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_REQUESTED_FILES },
        },
        required: ['reason', 'files'],
        additionalProperties: false,
      },
    },
    required: ['protocolVersion', 'jobId', 'goal', 'round', 'workUnitId', 'status', 'summary', 'report'],
    additionalProperties: false,
  };
}
