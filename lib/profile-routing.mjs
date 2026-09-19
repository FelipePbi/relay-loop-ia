/**
 * IA Loop — resolving which Developer profile a round runs on.
 *
 * A pure function, deliberately: the precedence is the whole safety property
 * of this feature, and it must be testable without a store, a git repository
 * or a model.
 *
 * The order, most authoritative first:
 *
 *   1. What this Goal is ALREADY running on, when the round has not changed.
 *      A restart, a recovery and a capacity wait all land here. The profile is
 *      part of the attempt's identity, so it is re-read, never recomputed.
 *   2. What the Tech Lead asked the NEXT correction round to run on, stated in
 *      the review that produced the blockers. Silence keeps the current
 *      profile: nothing promotes on round number alone.
 *   3. Under adaptive routing (the default), the standard executor —
 *      SONNET_HIGH. What the Tech Lead chose while PLANNING is recorded and
 *      reported, but no longer decides the first attempt: a Goal that is hard
 *      to plan is often ordinary to execute once the plan exists, and Opus is
 *      reached through escalation, which carries evidence.
 *   4. With adaptive routing off (`adaptive: false`), the older precedence
 *      applies instead: the planning record, then the Goal document, then the
 *      default. That is what an operator gets by pinning routing.
 *
 * And one compatibility rule that overrides 2–4 but not 1: a Goal that was
 * ALREADY IN FLIGHT before routing existed keeps the model it started on.
 * Rewriting a running execution's identity is exactly what this must not do.
 */

import {
  DEFAULT_DEVELOPER_PROFILE,
  LEGACY_DEVELOPER_PROFILE,
  resolveDeveloperProfile,
} from './developer-profiles.mjs';

export const PROFILE_SOURCES = Object.freeze({
  PERSISTED: 'PERSISTED_EXECUTION',
  TECH_LEAD_ESCALATION: 'TECH_LEAD_ESCALATION',
  PLANNING_RECORD: 'PLANNING_RECORD',
  GOAL_DOCUMENT: 'GOAL_DOCUMENT',
  LEGACY_IN_FLIGHT: 'LEGACY_IN_FLIGHT',
  ADAPTIVE_DEFAULT: 'ADAPTIVE_DEFAULT',
  DEFAULT: 'DEFAULT',
});

/**
 * True when an execution state predates routing but has already started.
 *
 * "Already started" is evidenced by work on disk — a round beyond the first, a
 * recorded job id, or a recorded round table — not by the record merely
 * existing. A Goal that has only been announced has not started.
 */
export function isLegacyInFlight(execution) {
  if (!execution) return false;
  if (execution.developerProfile) return false;
  const startedRounds = Object.keys(execution.jobIdsByRound ?? {}).length > 0;
  return Boolean(
    execution.currentJobId
    || execution.currentDeveloperJobId
    || execution.currentAttemptId
    || startedRounds
    || (Number.isInteger(execution.round) && execution.round > 1),
  );
}

/**
 * Decides the profile for one round.
 *
 * Returns the resolved profile, where it came from, and whether it differs from
 * what the Goal was previously running on — the audit trail is derived here so
 * every caller reports the same thing.
 */
export function resolveProfileForRound({
  goalExecution = null,
  round,
  // The escalation the Tech Lead attached to the review that produced this
  // correction round, if any.
  techLeadEscalation = null,
  // The record the planning call wrote for this Goal, if any.
  planningRecord = null,
  // The line mirrored in the Goal document, if any.
  declaredInGoal = null,
  defaultProfile = DEFAULT_DEVELOPER_PROFILE,
  /**
   * Adaptive routing: the FIRST attempt of a Goal starts on the standard
   * executor whatever the planning call chose for it.
   *
   * Not a downgrade, and not ignoring the Tech Lead. A Goal can be hard to
   * PLAN — architecture, contracts, a migration strategy — and ordinary to
   * EXECUTE once that plan exists, and paying the strongest executor for every
   * such Goal is exactly what this stopped doing. The Tech Lead still promotes,
   * but through the path that carries evidence: the escalation attached to a
   * review that saw the work fail (rule 2), or the Developer's own escalation
   * request during a round.
   */
  adaptive = true,
} = {}) {
  const persisted = goalExecution?.developerProfile ?? null;
  const previous = persisted?.profile ?? null;

  // 1. The round already has an identity. Recovery re-reads it; it never
  //    recalculates, so a promotion decided for R2 survives a restart of R2.
  if (persisted && persisted.round === round && persisted.profile) {
    return {
      profile: resolveDeveloperProfile(persisted.profile),
      source: PROFILE_SOURCES.PERSISTED,
      reason: persisted.reason ?? null,
      selectedBy: persisted.selectedBy ?? 'tech_lead',
      previousProfile: previous,
      changed: false,
    };
  }

  // 2. The Tech Lead escalated (or de-escalated) for this correction round.
  if (techLeadEscalation?.profile) {
    const profile = resolveDeveloperProfile(techLeadEscalation.profile);
    return {
      profile,
      source: PROFILE_SOURCES.TECH_LEAD_ESCALATION,
      reason: techLeadEscalation.reason ?? null,
      selectedBy: 'tech_lead',
      previousProfile: previous,
      changed: previous !== null && previous !== profile.name,
    };
  }

  // 3. A round beyond the first with no escalation KEEPS what the Goal is on.
  //    This is the "preserve unless the Tech Lead says otherwise" rule, and it
  //    is checked before any Goal-level default so a correction round can never
  //    silently fall back to the Goal's original choice being re-derived.
  if (previous) {
    return {
      profile: resolveDeveloperProfile(previous),
      source: PROFILE_SOURCES.PERSISTED,
      reason: persisted?.reason ?? null,
      selectedBy: persisted?.selectedBy ?? 'tech_lead',
      previousProfile: previous,
      changed: false,
    };
  }

  // 4. A Goal already running from before routing existed keeps its model.
  if (isLegacyInFlight(goalExecution)) {
    return {
      profile: resolveDeveloperProfile(LEGACY_DEVELOPER_PROFILE),
      source: PROFILE_SOURCES.LEGACY_IN_FLIGHT,
      reason: 'Execution started before Developer routing existed; its model is preserved.',
      selectedBy: 'compatibility',
      previousProfile: null,
      changed: false,
    };
  }

  // 5. What the Tech Lead chose when it planned this Goal — honoured only when
  //    adaptive routing is off. Under adaptive routing the choice is still
  //    recorded and still visible in status; it simply does not decide the
  //    first attempt any more.
  if (adaptive) {
    return {
      profile: resolveDeveloperProfile(defaultProfile),
      source: PROFILE_SOURCES.ADAPTIVE_DEFAULT,
      reason: planningRecord?.profile
        ? `Planning chose ${planningRecord.profile}; adaptive routing starts on ${defaultProfile} and escalates on evidence.`
        : null,
      selectedBy: 'router',
      previousProfile: null,
      changed: false,
      plannedProfile: planningRecord?.profile ?? declaredInGoal ?? null,
    };
  }

  if (planningRecord?.profile) {
    return {
      profile: resolveDeveloperProfile(planningRecord.profile),
      source: PROFILE_SOURCES.PLANNING_RECORD,
      reason: planningRecord.reason ?? null,
      selectedBy: planningRecord.selectedBy ?? 'tech_lead',
      previousProfile: null,
      changed: false,
    };
  }

  if (declaredInGoal) {
    return {
      profile: resolveDeveloperProfile(declaredInGoal),
      source: PROFILE_SOURCES.GOAL_DOCUMENT,
      reason: null,
      selectedBy: 'tech_lead',
      previousProfile: null,
      changed: false,
    };
  }

  // 6. Nobody said anything. Sonnet, not Opus.
  return {
    profile: resolveDeveloperProfile(defaultProfile),
    source: PROFILE_SOURCES.DEFAULT,
    reason: null,
    selectedBy: 'default',
    previousProfile: null,
    changed: false,
  };
}

/** The record persisted on the Goal execution, and read back by rule 1. */
export function toExecutionRecord(resolution, { goal, round }) {
  return {
    goal,
    round,
    profile: resolution.profile.name,
    model: resolution.profile.model,
    effort: resolution.profile.effort,
    source: resolution.source,
    selectedBy: resolution.selectedBy,
    reason: typeof resolution.reason === 'string' ? resolution.reason.slice(0, 200) : null,
    at: new Date().toISOString(),
  };
}
