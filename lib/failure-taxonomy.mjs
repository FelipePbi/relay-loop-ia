/**
 * IA Loop — failure taxonomy.
 *
 * Three families, kept apart on purpose, because conflating them made the event
 * log lie: contract slips and a spawn failure were recorded as
 * CAPACITY_LIMIT_REACHED, which would mislead any later analysis of how often
 * real model limits were actually hit.
 *
 *   MODEL_CAPACITY  the model or the plan said "not now" — waiting helps
 *   HARNESS         our own tooling broke — waiting never helps
 *   AGENT_CONTRACT  the model answered outside the agreed shape — retry may help
 *
 * Only MODEL_CAPACITY may produce a capacity event.
 */

import { CAPACITY_REASONS } from './capacity-classifier.mjs';

export const FAILURE_FAMILIES = Object.freeze({
  MODEL_CAPACITY: 'MODEL_CAPACITY',
  HARNESS: 'HARNESS',
  AGENT_CONTRACT: 'AGENT_CONTRACT',
  UNCLASSIFIED: 'UNCLASSIFIED',
});

/** Reasons that genuinely mean "the model has no capacity right now". */
const MODEL_CAPACITY_REASONS = Object.freeze([
  CAPACITY_REASONS.RATE_LIMIT,
  CAPACITY_REASONS.USAGE_LIMIT,
]);

/** Local tooling failures. Never a quota problem. */
const HARNESS_REASONS = Object.freeze([
  CAPACITY_REASONS.HARNESS_ERROR,
]);

/** Error codes that mean the agent broke the contract, not that it is limited. */
const AGENT_CONTRACT_CODES = Object.freeze([
  'UNSUPPORTED_PROTOCOL_VERSION',
  'UNSUPPORTED_STATUS',
  'UNSUPPORTED_DECISION',
  'UNSUPPORTED_JOB_TYPE',
  'UNSUPPORTED_REVIEW_LEVEL',
  'UNSUPPORTED_NEXT_ACTION',
  'CONTRACT_FIELD_INVALID',
  'ROLE_MISMATCH',
  'JOB_ID_MISMATCH',
  'GOAL_MISMATCH',
  'ROUND_MISMATCH',
  'DECISION_BLOCKERS_INCOHERENT',
  'DECISION_NEXT_ACTION_INCOHERENT',
  'INVALID_AGENT_JSON',
  'INVALID_AGENT_SHAPE',
  'INVALID_ENVELOPE_JSON',
  'MISSING_RESULT',
  'EMPTY_OUTPUT',
  'ACK_FAILED',
  'OK_NOT_TRUE',
  // A path reported in the wrong format is a contract slip. The real scope
  // breach is TECH_LEAD_CLOSURE_SCOPE_VIOLATION, raised from git evidence.
  'CLOSURE_SCOPE_VIOLATION',
]);

/** Local codes that are the harness's own fault. */
const HARNESS_CODES = Object.freeze([
  'EXECUTABLE_NOT_FOUND',
  'SPAWN_FAILED',
  'INVALID_TRANSITION',
  'UNKNOWN_STATE',
  'CAPACITY_STATE_CORRUPT',
  'STORE_VERSION_MISMATCH',
  'FILE_CORRUPT',
  'FILE_UNREADABLE',
  'EVENT_LOG_CORRUPT',
  'INVALID_JOB_STATUS',
  'DUPLICATE_JOB',
  // Execution state from a closed Goal reaching the next one. Ours, always:
  // no model produced it and no Goal is at fault for it. Recorded under its own
  // name so a run that stopped for it can never be read as "Goal 005 failed".
  'CROSS_GOAL_STATE_LEAK',
  // Reached only when a leak got as far as the store: a superseded attempt
  // cannot be retried, and being asked to is a bug in whoever chose the id.
  'STAGE_NOT_RETRYABLE',
  // The harness failing to establish which model served a call — never the
  // model or a limit doing anything. RESOLVED_MODEL_UNKNOWN/AMBIGUOUS are the
  // old token-accounting mechanism (now advisory only); PRIMARY_MODEL_EVIDENCE_*
  // are the current evidence-based one. See claude-process.mjs.
  'RESOLVED_MODEL_UNKNOWN',
  'RESOLVED_MODEL_AMBIGUOUS',
  'PRIMARY_MODEL_EVIDENCE_MISSING',
  'PRIMARY_MODEL_EVIDENCE_CONFLICT',
]);

/**
 * Classifies a failure into a family.
 *
 * `code` is our own error code when we have one; `reason` is the capacity
 * classification. The code wins, because it is the more specific signal.
 */
export function familyFor({ code = null, reason = null } = {}) {
  if (code && HARNESS_CODES.includes(code)) return FAILURE_FAMILIES.HARNESS;
  if (code && AGENT_CONTRACT_CODES.includes(code)) return FAILURE_FAMILIES.AGENT_CONTRACT;
  if (reason && HARNESS_REASONS.includes(reason)) return FAILURE_FAMILIES.HARNESS;
  if (reason && MODEL_CAPACITY_REASONS.includes(reason)) return FAILURE_FAMILIES.MODEL_CAPACITY;
  return FAILURE_FAMILIES.UNCLASSIFIED;
}

/**
 * Whether this failure may be recorded as a capacity event.
 *
 * The single gate: only a genuine model-capacity family qualifies. Everything
 * else gets an event named after what actually happened.
 */
export function producesCapacityEvent({ code = null, reason = null } = {}) {
  return familyFor({ code, reason }) === FAILURE_FAMILIES.MODEL_CAPACITY;
}

/** Event type to record for a failure, so the log names the real cause. */
export function eventTypeFor({ code = null, reason = null } = {}) {
  switch (familyFor({ code, reason })) {
    case FAILURE_FAMILIES.MODEL_CAPACITY: return 'CAPACITY_LIMIT_REACHED';
    case FAILURE_FAMILIES.HARNESS: return 'HARNESS_ERROR';
    case FAILURE_FAMILIES.AGENT_CONTRACT: return 'AGENT_CONTRACT_ERROR';
    default: return 'AGENT_FAILURE';
  }
}
