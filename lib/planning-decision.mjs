/**
 * IA Loop — planning decision contract.
 *
 * In an autonomous run the planning step decides whether the migration
 * continues. Exactly three answers are allowed, and "no next Goal found" is not
 * one of them: silence must never be read as completion.
 *
 *   NEXT_GOAL           one, and only one, next executable Goal
 *   MIGRATION_COMPLETE  an explicit, justified declaration
 *   HUMAN_REQUIRED      the Tech Lead wants a person
 */

import { SpikeError } from './claude-process.mjs';
import { PROTOCOL_VERSION_V2 } from './contracts-v2.mjs';
import { CLOSURE_WRITE_PREFIX, normalizeReportedPath } from './closure-contracts.mjs';
import { DEFAULT_DEVELOPER_PROFILE, SELECTABLE_DEVELOPER_PROFILES, assertSelectableProfile } from './developer-profiles.mjs';
import { EXECUTION_PLAN_SCHEMA, validateExecutionPlan } from './work-units.mjs';

export const PLANNING_DECISIONS = Object.freeze(['NEXT_GOAL', 'MIGRATION_COMPLETE', 'HUMAN_REQUIRED']);

function fail(code, message, details = {}) {
  throw new SpikeError(code, message, details);
}

function assertNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('CONTRACT_FIELD_INVALID', `Field "${field}" must be a non-empty string`);
  }
}

function assertStringArray(value, field) {
  if (!Array.isArray(value)) fail('CONTRACT_FIELD_INVALID', `Field "${field}" must be an array`);
  for (const item of value) {
    if (typeof item !== 'string') fail('CONTRACT_FIELD_INVALID', `Field "${field}" must contain strings`);
  }
}

export function validatePlanningDecision(payload, { jobId, goal }) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('CONTRACT_FIELD_INVALID', 'PlanningDecision is not a JSON object');
  }
  if (payload.protocolVersion !== PROTOCOL_VERSION_V2) {
    fail('UNSUPPORTED_PROTOCOL_VERSION',
      `Expected protocolVersion ${PROTOCOL_VERSION_V2} but received ${JSON.stringify(payload.protocolVersion)}`);
  }
  if (payload.jobId !== jobId) fail('JOB_ID_MISMATCH', `Expected jobId "${jobId}"`);
  if (payload.goal !== goal) fail('GOAL_MISMATCH', `Expected closed goal "${goal}"`);

  if (!PLANNING_DECISIONS.includes(payload.decision)) {
    fail('UNSUPPORTED_DECISION',
      `Planning decision ${JSON.stringify(payload.decision)} is not allowed (expected one of: ${PLANNING_DECISIONS.join(', ')})`);
  }
  assertNonEmptyString(payload.summary, 'summary');
  assertStringArray(payload.documentsUpdated ?? [], 'documentsUpdated');

  const documentsUpdated = (payload.documentsUpdated ?? []).map(normalizeReportedPath);
  for (const path of documentsUpdated) {
    if (!path.startsWith(CLOSURE_WRITE_PREFIX)) {
      fail('CLOSURE_SCOPE_VIOLATION', `PlanningDecision claims a document outside ${CLOSURE_WRITE_PREFIX}: ${path}`);
    }
  }

  if (payload.decision === 'NEXT_GOAL') {
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
      fail('CLOSURE_SCOPE_VIOLATION', `nextGoalPath must live under ${CLOSURE_WRITE_PREFIX}`);
    }

    // Which Developer profile the Goal being written needs. Stated here, in
    // the planning call that already runs — no separate selection inference.
    // Absent means the default, so an older planning result stays valid.
    const developerProfile = payload.developerProfile ?? DEFAULT_DEVELOPER_PROFILE;
    assertSelectableProfile(developerProfile, 'developerProfile');

    // The Work Unit DAG for the Goal being written. Optional, and absent is
    // NOT an error: a planning call made before execution plans existed, or
    // one the Tech Lead chose not to decompose, still produces a valid Goal —
    // it simply runs as a single unit, which is what the previous architecture
    // did for every Goal.
    //
    // Present-but-invalid is a different matter and fails here, in the process
    // that still has the planning context to say why. A cycle discovered later,
    // by the worker about to execute it, is a cycle discovered too late.
    const executionPlan = payload.executionPlan
      ? validateExecutionPlan({ ...payload.executionPlan, goal: payload.nextGoalId }, { goal: payload.nextGoalId })
      : null;

    return Object.freeze({
      ...payload,
      nextGoalPath,
      developerProfile,
      developerProfileReason: payload.developerProfileReason ?? null,
      // The RAW plan travels on, not the normalised one: the store validates
      // again on read, so freezing one version of the normaliser into the
      // record would mean a later fix to it silently did not apply.
      executionPlan: payload.executionPlan ?? null,
      executionPlanSummary: executionPlan
        ? Object.freeze({
          units: executionPlan.workUnits.length,
          order: Object.freeze([...executionPlan.order]),
          fragmentation: executionPlan.fragmentation,
        })
        : null,
      documentsUpdated: Object.freeze(documentsUpdated),
    });
  }

  if (payload.decision === 'MIGRATION_COMPLETE') {
    // Completion is a claim that must be argued, not a default.
    assertNonEmptyString(payload.reason, 'reason');
    assertStringArray(payload.remainingCriticalGaps ?? [], 'remainingCriticalGaps');
    if ((payload.remainingCriticalGaps ?? []).length > 0) {
      fail('MIGRATION_NOT_COMPLETE',
        `MIGRATION_COMPLETE declared with ${payload.remainingCriticalGaps.length} remaining critical gap(s)`);
    }
    return Object.freeze({ ...payload, documentsUpdated: Object.freeze(documentsUpdated) });
  }

  // HUMAN_REQUIRED
  assertNonEmptyString(payload.reason, 'reason');
  return Object.freeze({ ...payload, documentsUpdated: Object.freeze(documentsUpdated) });
}

/**
 * Verifies a MIGRATION_COMPLETE claim against the repository.
 *
 * The model's declaration alone is not enough: if a Goal is still READY or
 * IN_PROGRESS, the migration is demonstrably not finished, whatever was said.
 */
export function assertMigrationComplete({ decision, goalStatuses }) {
  if (decision.decision !== 'MIGRATION_COMPLETE') {
    fail('INVALID_ARGS', 'assertMigrationComplete expects a MIGRATION_COMPLETE decision');
  }

  const unfinished = [...goalStatuses.entries()]
    .filter(([, status]) => status === 'READY' || status === 'IN_PROGRESS' || status === 'REVIEW_REQUIRED' || status === 'CHANGES_REQUIRED');

  if (unfinished.length > 0) {
    fail(
      'MIGRATION_NOT_COMPLETE',
      `MIGRATION_COMPLETE was declared but these Goals are unfinished: `
      + unfinished.map(([id, s]) => `${id}=${s}`).join(', '),
      { unfinished },
    );
  }
  return true;
}

export function planningDecisionSchemaFor({ jobId, goal }) {
  return {
    type: 'object',
    properties: {
      protocolVersion: { type: 'integer', enum: [PROTOCOL_VERSION_V2] },
      jobId: { type: 'string', enum: [jobId] },
      goal: { type: 'string', enum: [goal] },
      decision: { type: 'string', enum: [...PLANNING_DECISIONS] },
      nextGoalId: { type: 'string' },
      nextGoalTitle: { type: 'string' },
      nextGoalPath: { type: 'string' },
      reason: { type: 'string' },
      remainingCriticalGaps: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string' },
      documentsUpdated: { type: 'array', items: { type: 'string' } },
      // Developer routing for the Goal being written. Two extra fields on an
      // output that already exists; the reason is capped so the output does
      // not grow in any meaningful way.
      developerProfile: { type: 'string', enum: [...SELECTABLE_DEVELOPER_PROFILES] },
      developerProfileReason: { type: 'string', maxLength: 200 },
      // The Work Unit DAG for the Goal being written. It rides on the planning
      // call the cycle already makes, so decomposing a Goal costs no extra
      // inference — the same reasoning that put developerProfile here.
      //
      // Note what the schema does NOT contain: any field naming a model. The
      // plan states type, complexity and risk; the router decides the rest.
      executionPlan: EXECUTION_PLAN_SCHEMA,
    },
    required: ['protocolVersion', 'jobId', 'goal', 'decision', 'summary'],
    additionalProperties: false,
  };
}
