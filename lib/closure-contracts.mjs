/**
 * IA Loop — closure and planning contracts.
 *
 * Two new Tech Lead jobs, both write-limited to docs/migration:
 *
 *   CLOSURE_DOCUMENTATION  record factually what the accepted Goal changed
 *   NEXT_GOAL_PLANNING     re-evaluate the roadmap and write the next Goal
 *
 * Neither is a review. The acceptance already happened and is not revisited.
 */

import { SpikeError } from './claude-process.mjs';
import { PROTOCOL_VERSION_V2 } from './contracts-v2.mjs';

export const CLOSURE_JOB_TYPES = Object.freeze(['CLOSURE_DOCUMENTATION', 'NEXT_GOAL_PLANNING']);

/**
 * Every Tech Lead job type that is NOT a round's review.
 *
 * `stageOfJob` asks exactly this question, and it used to ask it through
 * `CLOSURE_JOB_TYPES` — a list whose NAME is about closure and whose only
 * real job was answering "does this claim the round's review stage". The two
 * drifted the moment a third kind of Tech Lead job existed.
 *
 * CRITERIA_COVERAGE is that third kind. It carries the same `goal` and `round`
 * as the review it runs before, so without this it claimed the round's review
 * stage, collided with the real review in the ledger, and whichever the ledger
 * enumerated first won. Goal025 round 3 is where that landed: the coverage job
 * won, `reconcile` read a result with no `decision`, and a Goal whose review
 * had said CHANGES_REQUIRED was reported as AGENT_CONTRACT_ERROR — "the review
 * of round 3 carries no usable decision (undefined)".
 *
 * That is the SAME failure the comment in `stage-identity` already describes
 * for CLOSURE_DOCS/PLANNING after Goal006. It recurred because the guard was
 * keyed to a list named after one of its members instead of to the question.
 */
export const TECH_LEAD_NON_REVIEW_JOB_TYPES = Object.freeze([
  ...CLOSURE_JOB_TYPES,
  'CRITERIA_COVERAGE',
]);

/** The only tree the Tech Lead may write to during closure or planning. */
export const CLOSURE_WRITE_PREFIX = 'docs/migration/';

function fail(code, message, details = {}) {
  throw new SpikeError(code, message, details);
}

/**
 * Normalises a path reported BY A MODEL.
 *
 * The model writes prose, not git output: it may answer with a backslash
 * separator, a leading "./", or the absolute path inside the worktree. Rejecting
 * those as scope violations confuses a formatting difference with an actual
 * breach — which is exactly what happened on the first real planning run.
 *
 * Paths collected FROM GIT are never passed through here; those stay strict,
 * because git is the authority on what really changed.
 */
export function normalizeReportedPath(path) {
  if (typeof path !== 'string') return path;
  const slashed = path.replace(/\\/g, '/');
  const index = slashed.indexOf(CLOSURE_WRITE_PREFIX);
  // Anchor on the allowed prefix wherever it appears, so an absolute worktree
  // path collapses to the repository-relative one.
  return index >= 0 ? slashed.slice(index) : slashed.replace(/^\.\//, '');
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

function assertProtocol(payload) {
  if (payload?.protocolVersion !== PROTOCOL_VERSION_V2) {
    fail('UNSUPPORTED_PROTOCOL_VERSION',
      `Expected protocolVersion ${PROTOCOL_VERSION_V2} but received ${JSON.stringify(payload?.protocolVersion)}`);
  }
}

// --- Closure documentation -------------------------------------------------

export function validateClosureDocResult(payload, { jobId, goal }) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('CONTRACT_FIELD_INVALID', 'ClosureDocResult is not a JSON object');
  }
  assertProtocol(payload);
  if (payload.jobId !== jobId) fail('JOB_ID_MISMATCH', `Expected jobId "${jobId}"`);
  if (payload.goal !== goal) fail('GOAL_MISMATCH', `Expected goal "${goal}"`);

  assertNonEmptyString(payload.summary, 'summary');
  assertStringArray(payload.documentsUpdated, 'documentsUpdated');

  const documentsUpdated = payload.documentsUpdated.map(normalizeReportedPath);
  for (const path of documentsUpdated) {
    if (!path.startsWith(CLOSURE_WRITE_PREFIX)) {
      fail('CLOSURE_SCOPE_VIOLATION',
        `ClosureDocResult claims a document outside ${CLOSURE_WRITE_PREFIX}: ${path}`);
    }
  }

  return Object.freeze({ ...payload, documentsUpdated: Object.freeze(documentsUpdated) });
}

export function closureDocSchemaFor({ jobId, goal }) {
  return {
    type: 'object',
    properties: {
      protocolVersion: { type: 'integer', enum: [PROTOCOL_VERSION_V2] },
      jobId: { type: 'string', enum: [jobId] },
      goal: { type: 'string', enum: [goal] },
      summary: { type: 'string' },
      documentsUpdated: { type: 'array', items: { type: 'string' } },
      notes: { type: 'string' },
    },
    required: ['protocolVersion', 'jobId', 'goal', 'summary', 'documentsUpdated'],
    additionalProperties: false,
  };
}

// --- Next goal planning ----------------------------------------------------

export function validatePlanningResult(payload, { jobId, goal }) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('CONTRACT_FIELD_INVALID', 'PlanningResult is not a JSON object');
  }
  assertProtocol(payload);
  if (payload.jobId !== jobId) fail('JOB_ID_MISMATCH', `Expected jobId "${jobId}"`);
  if (payload.goal !== goal) fail('GOAL_MISMATCH', `Expected closed goal "${goal}"`);

  assertNonEmptyString(payload.nextGoalId, 'nextGoalId');
  if (!/^\d{3}$/.test(payload.nextGoalId)) {
    fail('CONTRACT_FIELD_INVALID', `nextGoalId must be three digits, got ${JSON.stringify(payload.nextGoalId)}`);
  }
  if (payload.nextGoalId === goal) {
    fail('CONTRACT_FIELD_INVALID', 'The next Goal cannot be the one just closed');
  }

  assertNonEmptyString(payload.nextGoalTitle, 'nextGoalTitle');
  assertNonEmptyString(payload.nextGoalPath, 'nextGoalPath');
  const nextGoalPath = normalizeReportedPath(payload.nextGoalPath);
  if (!nextGoalPath.startsWith(CLOSURE_WRITE_PREFIX)) {
    fail('CLOSURE_SCOPE_VIOLATION',
      `nextGoalPath must live under ${CLOSURE_WRITE_PREFIX}, got ${JSON.stringify(payload.nextGoalPath)}`);
  }
  assertNonEmptyString(payload.summary, 'summary');
  assertStringArray(payload.documentsUpdated, 'documentsUpdated');

  const documentsUpdated = payload.documentsUpdated.map(normalizeReportedPath);
  for (const path of documentsUpdated) {
    if (!path.startsWith(CLOSURE_WRITE_PREFIX)) {
      fail('CLOSURE_SCOPE_VIOLATION', `PlanningResult claims a document outside ${CLOSURE_WRITE_PREFIX}: ${path}`);
    }
  }

  return Object.freeze({ ...payload, nextGoalPath, documentsUpdated: Object.freeze(documentsUpdated) });
}

export function planningSchemaFor({ jobId, goal }) {
  return {
    type: 'object',
    properties: {
      protocolVersion: { type: 'integer', enum: [PROTOCOL_VERSION_V2] },
      jobId: { type: 'string', enum: [jobId] },
      goal: { type: 'string', enum: [goal] },
      nextGoalId: { type: 'string' },
      nextGoalTitle: { type: 'string' },
      nextGoalPath: { type: 'string' },
      summary: { type: 'string' },
      documentsUpdated: { type: 'array', items: { type: 'string' } },
      roadmapChanged: { type: 'boolean' },
      notes: { type: 'string' },
    },
    required: ['protocolVersion', 'jobId', 'goal', 'nextGoalId', 'nextGoalTitle', 'nextGoalPath', 'summary', 'documentsUpdated'],
    additionalProperties: false,
  };
}

/**
 * Verifies that only docs/migration was touched.
 *
 * The contract check above trusts what the model reported; this one reads git.
 * Both exist because the model's claim is not evidence.
 */
export function assertClosureScope(changedFiles) {
  const outside = changedFiles.filter((f) => !f.startsWith(CLOSURE_WRITE_PREFIX));
  if (outside.length > 0) {
    fail(
      'TECH_LEAD_CLOSURE_SCOPE_VIOLATION',
      `The Tech Lead changed files outside ${CLOSURE_WRITE_PREFIX}: ${outside.slice(0, 8).join(', ')}`,
      { outside },
    );
  }
  return true;
}
