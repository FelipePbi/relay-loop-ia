/**
 * IA Loop — V2 contracts.
 *
 * Protocol version 2 carries what the hybrid architecture needs that V1 did
 * not: a real Goal id, the two distinct baselines, the worktree, and the
 * correction round. Validation stays strict and fails closed.
 *
 * The V1 contracts remain in contracts.mjs, still used by the synthetic
 * supervised slice.
 */

import { SpikeError } from './claude-process.mjs';
import {
  DEFAULT_DEVELOPER_PROFILE,
  SELECTABLE_DEVELOPER_PROFILES,
  assertSelectableProfile,
  resolveDeveloperProfile,
} from './developer-profiles.mjs';

export const PROTOCOL_VERSION_V2 = 2;

export const JOB_TYPES = Object.freeze(['IMPLEMENTATION', 'CORRECTION']);
export const REVIEW_LEVELS = Object.freeze(['STANDARD', 'DEEP']);

/**
 * ESCALATION_REQUIRED is a real outcome, not a failure.
 *
 * The Developer reached the limit of what it could decide on its own and says
 * so in the contract, with evidence. Reading that intent out of free text — "I
 * think I need Opus" — would put a state-machine transition behind a regex,
 * which is exactly what this avoids.
 */
export const DEVELOPER_STATUSES_V2 = Object.freeze(['REVIEW_REQUIRED', 'BLOCKED', 'ESCALATION_REQUIRED']);
export const REVIEW_DECISIONS_V2 = Object.freeze(['ACCEPTED', 'CHANGES_REQUIRED', 'HUMAN_REQUIRED']);

/** Reasons a Developer may give for asking to be escalated. Closed on purpose. */
export const DEVELOPER_ESCALATION_REASONS = Object.freeze([
  'REPEATED_EXECUTION_FAILURE',
  'PLAN_MISMATCH',
  'ARCHITECTURAL_DECISION_REQUIRED',
  'LOW_CONFIDENCE',
]);

/** Reasons a reviewer may give for asking the specialist to take the review. */
export const REVIEW_ESCALATION_REASONS = Object.freeze([
  'REVIEW_INCONCLUSIVE',
  'ARCHITECTURAL_RISK_DISCOVERED',
  'SECURITY_RISK_DISCOVERED',
]);

export const CONFIDENCE_LEVELS = Object.freeze(['LOW', 'MEDIUM', 'HIGH']);

/** Roles that can own a job queue. */
export const ROLES = Object.freeze(['developer', 'tech_lead']);

const SHA_PATTERN = /^[0-9a-f]{40}$/;

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

function assertStringArray(value, field) {
  if (!Array.isArray(value)) fail('CONTRACT_FIELD_INVALID', `Field "${field}" must be an array`);
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      fail('CONTRACT_FIELD_INVALID', `Field "${field}" must contain only non-empty strings`);
    }
  }
}

export function assertSha(value, field) {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) {
    fail('INVALID_SHA', `Field "${field}" must be a 40-character hex SHA, got ${JSON.stringify(value)}`);
  }
  return value;
}

function assertProtocol(payload) {
  if (payload.protocolVersion !== PROTOCOL_VERSION_V2) {
    fail(
      'UNSUPPORTED_PROTOCOL_VERSION',
      `Expected protocolVersion ${PROTOCOL_VERSION_V2} but received ${JSON.stringify(payload.protocolVersion)}`,
    );
  }
}

function assertRound(value) {
  if (!Number.isInteger(value) || value < 1) {
    fail('CONTRACT_FIELD_INVALID', `Field "round" must be an integer >= 1, got ${JSON.stringify(value)}`);
  }
}

/**
 * The two baselines are conceptually different and must never collapse:
 *
 * - migrationAcceptedBaseline: SHA of the last formally ACCEPTED Goal. It is
 *   what the functional diff stays traceable against.
 * - executionBase: the tree the work actually runs on, which also carries the
 *   Goal documentation and the IA Loop tooling.
 *
 * They are normally different, and that is expected, not an error.
 */
function assertBaselines(payload) {
  assertSha(payload.migrationAcceptedBaseline, 'migrationAcceptedBaseline');
  assertSha(payload.executionBase, 'executionBase');
}

// --- DeveloperJob ----------------------------------------------------------

export function validateDeveloperJob(payload) {
  assertObject(payload, 'DeveloperJob');
  assertProtocol(payload);
  assertNonEmptyString(payload.jobId, 'jobId');
  assertNonEmptyString(payload.goal, 'goal');
  assertRound(payload.round);

  if (!JOB_TYPES.includes(payload.type)) {
    fail('UNSUPPORTED_JOB_TYPE', `Job type ${JSON.stringify(payload.type)} is not allowed (expected one of: ${JOB_TYPES.join(', ')})`);
  }
  if (payload.role !== 'developer') {
    fail('ROLE_MISMATCH', `DeveloperJob must target role "developer", got ${JSON.stringify(payload.role)}`);
  }

  assertBaselines(payload);
  assertNonEmptyString(payload.worktree, 'worktree');
  assertNonEmptyString(payload.goalPath, 'goalPath');

  // A correction round must say what to fix; an implementation round must not
  // pretend to carry blockers it never received.
  assertStringArray(payload.blockers ?? [], 'blockers');
  if (payload.type === 'CORRECTION' && (payload.blockers ?? []).length === 0) {
    fail('CONTRACT_FIELD_INVALID', 'A CORRECTION job must carry at least one blocker');
  }
  if (payload.type === 'IMPLEMENTATION' && (payload.blockers ?? []).length > 0) {
    fail('CONTRACT_FIELD_INVALID', 'An IMPLEMENTATION job must not carry blockers');
  }

  // Which Developer profile this job runs on. The job is the authority: the
  // worker reads it here rather than deciding for itself, and a restart or a
  // capacity retry re-reads the same file, so the choice cannot drift.
  //
  // Absent means the default, which is what a job written before routing
  // existed will look like. An unknown name is refused: guessing would be a
  // silent downgrade.
  const developerProfile = payload.developerProfile ?? DEFAULT_DEVELOPER_PROFILE;
  resolveDeveloperProfile(developerProfile);

  return Object.freeze({
    ...payload,
    developerProfile,
    developerProfileReason: payload.developerProfileReason ?? null,
    routing: assertJobRouting(payload.routing, 'developer'),
    blockers: Object.freeze([...(payload.blockers ?? [])]),
  });
}

/**
 * The routing decision a job carries.
 *
 * The job is the authority on which model an attempt runs: a worker executes
 * this, it does not decide it. Absent is allowed and means "whatever the role's
 * standing default is" — that is what a job written before adaptive routing
 * looks like, and re-deciding one of those on read would rewrite history.
 */
function assertJobRouting(routing, role) {
  if (routing === undefined || routing === null) return null;
  assertObject(routing, 'routing');
  if (routing.role !== undefined && routing.role !== role) {
    fail('ROLE_MISMATCH', `Routing targets role ${JSON.stringify(routing.role)} on a ${role} job`);
  }
  assertNonEmptyString(routing.model, 'routing.model');
  assertNonEmptyString(routing.modelKey, 'routing.modelKey');
  assertNonEmptyString(routing.family, 'routing.family');
  return Object.freeze({
    ...routing,
    signals: Object.freeze([...(routing.signals ?? [])]),
  });
}

// --- DeveloperResult -------------------------------------------------------

export function validateDeveloperResult(payload, { jobId, goal, round }) {
  assertObject(payload, 'DeveloperResult');
  assertProtocol(payload);

  if (payload.jobId !== jobId) {
    fail('JOB_ID_MISMATCH', `Expected jobId "${jobId}" but received ${JSON.stringify(payload.jobId)}`);
  }
  if (payload.goal !== goal) {
    fail('GOAL_MISMATCH', `Expected goal "${goal}" but received ${JSON.stringify(payload.goal)}`);
  }
  if (payload.round !== round) {
    fail('ROUND_MISMATCH', `Expected round ${round} but received ${JSON.stringify(payload.round)}`);
  }
  if (!DEVELOPER_STATUSES_V2.includes(payload.status)) {
    fail('UNSUPPORTED_STATUS', `Status ${JSON.stringify(payload.status)} is not allowed (expected one of: ${DEVELOPER_STATUSES_V2.join(', ')})`);
  }

  assertNonEmptyString(payload.summary, 'summary');
  assertNonEmptyString(payload.implementationReport, 'implementationReport');
  if (!Array.isArray(payload.validations)) {
    fail('CONTRACT_FIELD_INVALID', 'Field "validations" must be an array');
  }
  for (const validation of payload.validations) {
    assertObject(validation, 'validation entry');
    assertNonEmptyString(validation.name, 'validations[].name');
    if (typeof validation.passed !== 'boolean') {
      fail('CONTRACT_FIELD_INVALID', 'Field "validations[].passed" must be a boolean');
    }
  }

  const escalation = validateEscalationRequest(payload.escalation, {
    field: 'escalation',
    reasons: DEVELOPER_ESCALATION_REASONS,
    // Asking is not the same as being granted: the router decides, and it
    // refuses a request that carries no evidence. Requiring the evidence HERE
    // means a request that could never be granted is rejected before it is
    // mistaken for one that could.
    required: payload.status === 'ESCALATION_REQUIRED',
  });
  if (escalation && payload.status !== 'ESCALATION_REQUIRED') {
    fail('CONTRACT_FIELD_INVALID', 'Field "escalation" only applies to status ESCALATION_REQUIRED');
  }

  return Object.freeze({
    ...payload,
    escalation,
    validations: Object.freeze([...payload.validations]),
  });
}

/**
 * Shared shape of an escalation request, for both roles.
 *
 * Evidence is mandatory and must be concrete. A `confidence` field alone is a
 * feeling; the router is explicitly told not to trust it on its own.
 */
function validateEscalationRequest(value, { field, reasons, required }) {
  if (value === undefined || value === null) {
    if (required) fail('CONTRACT_FIELD_INVALID', `Field "${field}" is required for this status`);
    return null;
  }
  assertObject(value, field);
  if (!reasons.includes(value.reason)) {
    fail(
      'CONTRACT_FIELD_INVALID',
      `Field "${field}.reason" must be one of: ${reasons.join(', ')} (got ${JSON.stringify(value.reason)})`,
    );
  }
  assertStringArray(value.evidence ?? [], `${field}.evidence`);
  if ((value.evidence ?? []).length === 0) {
    fail('CONTRACT_FIELD_INVALID', `Field "${field}.evidence" must carry at least one concrete observation`);
  }
  if (value.confidence !== undefined && value.confidence !== null
    && !CONFIDENCE_LEVELS.includes(value.confidence)) {
    fail(
      'CONTRACT_FIELD_INVALID',
      `Field "${field}.confidence" must be one of: ${CONFIDENCE_LEVELS.join(', ')}`,
    );
  }

  return Object.freeze({
    reason: value.reason,
    confidence: value.confidence ?? null,
    detail: typeof value.detail === 'string' ? value.detail.slice(0, 500) : null,
    evidence: Object.freeze([...value.evidence]),
  });
}

// --- ReviewJob -------------------------------------------------------------

export function validateReviewJob(payload) {
  assertObject(payload, 'ReviewJob');
  assertProtocol(payload);
  assertNonEmptyString(payload.jobId, 'jobId');
  assertNonEmptyString(payload.goal, 'goal');
  assertRound(payload.round);
  // Which developer/correction job this review is actually FOR. Required, not
  // inferred from the round number: a round number is not proof a review
  // reviewed THIS round's result rather than an earlier one reused under it.
  assertNonEmptyString(payload.developerJobId, 'developerJobId');

  if (payload.role !== 'tech_lead') {
    fail('ROLE_MISMATCH', `ReviewJob must target role "tech_lead", got ${JSON.stringify(payload.role)}`);
  }
  if (!REVIEW_LEVELS.includes(payload.reviewLevel)) {
    fail('UNSUPPORTED_REVIEW_LEVEL', `Review level ${JSON.stringify(payload.reviewLevel)} is not allowed (expected one of: ${REVIEW_LEVELS.join(', ')})`);
  }

  assertBaselines(payload);
  assertNonEmptyString(payload.worktree, 'worktree');
  assertNonEmptyString(payload.goalPath, 'goalPath');

  // The repository stays the authority: the reviewer must receive the real
  // change surface rather than relying on its own session memory.
  assertStringArray(payload.changedFiles ?? [], 'changedFiles');
  assertNonEmptyString(payload.implementationReport, 'implementationReport');
  assertStringArray(payload.previousBlockers ?? [], 'previousBlockers');

  return Object.freeze({
    ...payload,
    routing: assertJobRouting(payload.routing, 'tech_lead'),
    changedFiles: Object.freeze([...(payload.changedFiles ?? [])]),
    previousBlockers: Object.freeze([...(payload.previousBlockers ?? [])]),
  });
}

// --- ReviewDecision --------------------------------------------------------

const DECISION_TO_NEXT_ACTION = Object.freeze({
  ACCEPTED: 'STOP',
  CHANGES_REQUIRED: 'RETURN_TO_DEVELOPER',
  HUMAN_REQUIRED: 'HUMAN_REQUIRED',
});

export function validateReviewDecision(payload, { jobId, goal, round }) {
  assertObject(payload, 'ReviewDecision');
  assertProtocol(payload);

  if (payload.jobId !== jobId) {
    fail('JOB_ID_MISMATCH', `Expected jobId "${jobId}" but received ${JSON.stringify(payload.jobId)}`);
  }
  if (payload.goal !== goal) {
    fail('GOAL_MISMATCH', `Expected goal "${goal}" but received ${JSON.stringify(payload.goal)}`);
  }
  if (payload.round !== round) {
    fail('ROUND_MISMATCH', `Expected round ${round} but received ${JSON.stringify(payload.round)}`);
  }
  if (!REVIEW_DECISIONS_V2.includes(payload.decision)) {
    fail('UNSUPPORTED_DECISION', `Decision ${JSON.stringify(payload.decision)} is not allowed (expected one of: ${REVIEW_DECISIONS_V2.join(', ')})`);
  }

  assertStringArray(payload.blockers, 'blockers');

  // Same invariants proven in V1, preserved here.
  if (payload.decision === 'ACCEPTED' && payload.blockers.length > 0) {
    fail('DECISION_BLOCKERS_INCOHERENT', 'ACCEPTED must come with an empty blockers list');
  }
  if (payload.decision === 'CHANGES_REQUIRED' && payload.blockers.length === 0) {
    fail('DECISION_BLOCKERS_INCOHERENT', 'CHANGES_REQUIRED must list at least one blocker');
  }

  const expected = DECISION_TO_NEXT_ACTION[payload.decision];
  if (payload.nextAction !== expected) {
    fail(
      'DECISION_NEXT_ACTION_INCOHERENT',
      `Decision "${payload.decision}" requires nextAction "${expected}" but received ${JSON.stringify(payload.nextAction)}`,
    );
  }

  // Correction escalation. Optional on purpose: silence means "keep the profile
  // this Goal is already running on", never an automatic promotion. Nothing
  // here reads the round number — the Tech Lead decides, or nothing changes.
  if (payload.nextDeveloperProfile !== undefined && payload.nextDeveloperProfile !== null) {
    assertSelectableProfile(payload.nextDeveloperProfile, 'nextDeveloperProfile');
    if (payload.decision !== 'CHANGES_REQUIRED') {
      fail(
        'CONTRACT_FIELD_INVALID',
        `nextDeveloperProfile only applies to a CHANGES_REQUIRED decision, got "${payload.decision}"`,
      );
    }
  }

  // A reviewer that could not reach a confident verdict says so structurally,
  // and only alongside HUMAN_REQUIRED: it is asking for a stronger reviewer
  // BEFORE a person is asked to look. The router decides whether that is
  // legitimate; an ACCEPTED or CHANGES_REQUIRED review has already concluded
  // and has nothing to escalate.
  const escalationRequest = validateEscalationRequest(payload.escalationRequest, {
    field: 'escalationRequest',
    reasons: REVIEW_ESCALATION_REASONS,
    required: false,
  });
  if (escalationRequest && payload.decision !== 'HUMAN_REQUIRED') {
    fail(
      'CONTRACT_FIELD_INVALID',
      `escalationRequest only applies to a HUMAN_REQUIRED decision, got "${payload.decision}"`,
    );
  }

  return Object.freeze({
    ...payload,
    nextDeveloperProfile: payload.nextDeveloperProfile ?? null,
    nextDeveloperProfileReason: payload.nextDeveloperProfileReason ?? null,
    escalationRequest,
    blockers: Object.freeze([...payload.blockers]),
  });
}

// --- JSON Schemas handed to the CLI ---------------------------------------

export const DEVELOPER_RESULT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    // Pinned, not just typed: an open integer let a model answer with version 1
    // and the mismatch only surfaced after the inference had been paid for.
    protocolVersion: { type: 'integer', enum: [PROTOCOL_VERSION_V2] },
    jobId: { type: 'string' },
    goal: { type: 'string' },
    round: { type: 'integer' },
    status: { type: 'string', enum: [...DEVELOPER_STATUSES_V2] },
    summary: { type: 'string' },
    implementationReport: { type: 'string' },
    validations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          passed: { type: 'boolean' },
          detail: { type: 'string' },
        },
        required: ['name', 'passed'],
        additionalProperties: false,
      },
    },
    // Only with status ESCALATION_REQUIRED. Evidence is what makes the request
    // reviewable: the router refuses one that carries none.
    escalation: {
      type: 'object',
      properties: {
        reason: { type: 'string', enum: [...DEVELOPER_ESCALATION_REASONS] },
        confidence: { type: 'string', enum: [...CONFIDENCE_LEVELS] },
        detail: { type: 'string', maxLength: 500 },
        evidence: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
      required: ['reason', 'evidence'],
      additionalProperties: false,
    },
  },
  required: ['protocolVersion', 'jobId', 'goal', 'round', 'status', 'summary', 'implementationReport', 'validations'],
  additionalProperties: false,
});

export const REVIEW_DECISION_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    protocolVersion: { type: 'integer', enum: [PROTOCOL_VERSION_V2] },
    jobId: { type: 'string' },
    goal: { type: 'string' },
    round: { type: 'integer' },
    decision: { type: 'string', enum: [...REVIEW_DECISIONS_V2] },
    blockers: { type: 'array', items: { type: 'string' } },
    nextAction: { type: 'string', enum: ['STOP', 'RETURN_TO_DEVELOPER', 'HUMAN_REQUIRED'] },
    summary: { type: 'string' },
    // Optional, and only meaningful with CHANGES_REQUIRED: the profile the
    // NEXT correction round should run on. Rides on the review inference the
    // cycle already performs; it costs no extra call.
    nextDeveloperProfile: { type: 'string', enum: [...SELECTABLE_DEVELOPER_PROFILES] },
    // Kept short deliberately: this must not grow the output in any
    // meaningful way.
    nextDeveloperProfileReason: { type: 'string', maxLength: 200 },
    // Only with HUMAN_REQUIRED: "I could not conclude this safely" is a request
    // for a stronger reviewer, considered before a person is asked.
    escalationRequest: {
      type: 'object',
      properties: {
        reason: { type: 'string', enum: [...REVIEW_ESCALATION_REASONS] },
        confidence: { type: 'string', enum: [...CONFIDENCE_LEVELS] },
        detail: { type: 'string', maxLength: 500 },
        evidence: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
      required: ['reason', 'evidence'],
      additionalProperties: false,
    },
  },
  required: ['protocolVersion', 'jobId', 'goal', 'round', 'decision', 'blockers', 'nextAction'],
  additionalProperties: false,
});

/**
 * Builds a DeveloperResult schema with the identity fields pinned.
 *
 * A model answered with jobId "003" (the goal) instead of the job id, and with
 * protocolVersion 1. Both slipped past an open schema and only failed local
 * validation after the inference had been paid for. Pinning them lets the CLI
 * reject the shape at the source.
 */
export function developerResultSchemaFor({ jobId, goal, round }) {
  return {
    ...DEVELOPER_RESULT_SCHEMA,
    properties: {
      ...DEVELOPER_RESULT_SCHEMA.properties,
      protocolVersion: { type: 'integer', enum: [PROTOCOL_VERSION_V2] },
      jobId: { type: 'string', enum: [jobId] },
      goal: { type: 'string', enum: [goal] },
      round: { type: 'integer', enum: [round] },
    },
  };
}

export function reviewDecisionSchemaFor({ jobId, goal, round }) {
  return {
    ...REVIEW_DECISION_SCHEMA,
    properties: {
      ...REVIEW_DECISION_SCHEMA.properties,
      protocolVersion: { type: 'integer', enum: [PROTOCOL_VERSION_V2] },
      jobId: { type: 'string', enum: [jobId] },
      goal: { type: 'string', enum: [goal] },
      round: { type: 'integer', enum: [round] },
    },
  };
}
