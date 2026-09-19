/**
 * IA Loop — the boundary between two Goals.
 *
 * There are two different things inside one `runtime.json`, and until V7 they
 * were the same object:
 *
 *   the RUN        a campaign that crosses Goals — the run id, the accepted
 *                  migration baseline, the review level, the operational
 *                  checkpoint of main
 *   the EXECUTION  one Goal's attempt at its own work — round, blockers, job
 *                  ids, the review decision, the worktree, the closure record
 *
 * The bug this file exists for: Goal 004 was ACCEPTED, closed, its baseline
 * recorded, Goal 005 planned and created READY, and the loop continued on its
 * own. `run-auto` moved the run's pointer to 005, but the execution state left
 * on disk was still 004's — and `run-goal` then used it as a HINT for which job
 * id to dispatch. Goal 005 round 1 had nothing in its ledger, so the fallback
 * chain reached `jobIdsByRound["1"].developer` from the previous Goal and
 * dispatched `004-r1-developer-69a88746`, an attempt already marked SUPERSEDED.
 * The store refused it — correctly — with STAGE_NOT_RETRYABLE, and the run
 * stopped as UNKNOWN_FATAL, as though Goal 005 had failed. Goal 005 had never
 * run at all.
 *
 * So the rule is not "detect the leak". It is: an execution field belonging to
 * another Goal can never be SELECTED in the first place. Reading is gated on
 * identity (`goalExecutionOf`), starting a Goal builds a new object explicitly
 * (`initializeGoalExecutionState`) rather than spreading the old one, and
 * anything that still slips through fails closed as CROSS_GOAL_STATE_LEAK — a
 * harness error, never a verdict about the Goal.
 */

import { SpikeError } from './claude-process.mjs';
import { PER_GOAL_RUNTIME_FIELDS } from './job-store.mjs';
import { goalOfJobId } from './stage-identity.mjs';

/**
 * Fields that belong to the RUN and survive every Goal boundary.
 *
 * An allowlist, deliberately: a field nobody classified is dropped at the
 * boundary rather than inherited. Losing a field is visible and recoverable;
 * inheriting one is the failure this file was written for.
 */
export const RUN_SCOPED_RUNTIME_FIELDS = Object.freeze([
  'mode',
  'autonomousRunId',
  'migrationAcceptedBaseline',
  'reviewLevel',
  // Operational checkpoint of main. Not an execution base, and explicitly
  // labelled as such wherever it is printed.
  'mainGuardCheckpoint',
]);

/**
 * Fields that describe ONE Goal's execution.
 *
 * `PER_GOAL_RUNTIME_FIELDS` is the list the store already maintained; the
 * identity and worktree fields are added here because they are what makes an
 * execution state be *about* a Goal at all.
 */
export const GOAL_SCOPED_RUNTIME_FIELDS = Object.freeze([
  ...PER_GOAL_RUNTIME_FIELDS,
  'goal', 'state', 'executionBase', 'worktreePath', 'worktreeInitialHead',
]);

const RUN_SCOPED = new Set(RUN_SCOPED_RUNTIME_FIELDS);
const GOAL_SCOPED = new Set(GOAL_SCOPED_RUNTIME_FIELDS);

/** Envelope fields the store owns; they are neither run- nor Goal-scoped. */
const STORE_FIELDS = Object.freeze(['storeVersion', 'updatedAt']);

export function scopeOfRuntimeField(field) {
  if (STORE_FIELDS.includes(field)) return 'store';
  if (RUN_SCOPED.has(field)) return 'run';
  if (GOAL_SCOPED.has(field)) return 'goal';
  return 'unclassified';
}

/**
 * The execution state, but only if it is THIS Goal's.
 *
 * The single read gate. Everywhere a runner used to reach into the persisted
 * runtime for a hint — a job id, a round, a report, a resume point — it goes
 * through here, and gets `null` when the state on disk belongs to another Goal.
 * Null means "nothing is known about this Goal yet", which is the truth.
 */
export function goalExecutionOf(runtime, goalId) {
  if (!runtime || !goalId) return null;
  return runtime.goal === goalId ? runtime : null;
}

/**
 * Execution pointers left on disk that name another Goal.
 *
 * Reported, never repaired here: what the harness got wrong stays readable, and
 * the audit event carries only ids and field names.
 */
export function staleGoalPointers(runtime, goalId) {
  if (!runtime || !goalId) return [];

  const stale = [];
  const note = (field, value, goal) => stale.push({ field, value, goal: goal ?? null });

  // Ids first, and INDEPENDENTLY of what the runtime says its Goal is. A
  // runtime can name the right Goal and still carry the wrong ids — that is
  // precisely what the failed transition left on disk: `goal: "005"` next to
  // `currentJobId: "004-r1-developer-69a88746"`. Keying the whole report on
  // `runtime.goal` would have reported that record as clean.
  const noteId = (field, jobId) => {
    const owner = goalOfJobId(jobId);
    if (owner !== null && owner !== goalId) note(field, jobId, owner);
  };

  noteId('currentJobId', runtime.currentJobId);
  noteId('currentAttemptId', runtime.currentAttemptId);
  noteId('blockedJobId', runtime.blockedJobId);
  for (const [round, byRole] of Object.entries(runtime.jobIdsByRound ?? {})) {
    for (const [role, jobId] of Object.entries(byRole ?? {})) {
      noteId(`jobIdsByRound.${round}.${role}`, jobId);
    }
  }

  // The rest of the execution state is judged by the record's own identity:
  // these fields carry no Goal of their own, so the only thing that says who
  // they belong to is the Goal the runtime was written for.
  if (runtime.goal === goalId) return stale;

  note('goal', runtime.goal, runtime.goal);
  if (Number.isInteger(runtime.round)) note('round', runtime.round, runtime.goal);

  for (const field of ['blockers', 'decision', 'reviewDecision', 'correction', 'closure',
    'recovery', 'capacity', 'resumeFrom', 'acceptedSnapshot',
    'lastImplementationReport', 'worktreePath', 'humanRequired']) {
    const value = runtime[field];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    note(field, typeof value === 'object' ? '[recorded]' : value, runtime.goal);
  }

  return stale;
}

/**
 * Builds the execution state a Goal starts from.
 *
 * Explicit construction, never `{ ...oldRuntime, goal: '005' }`: a spread keeps
 * every field nobody thought about, which is precisely how a superseded attempt
 * from Goal 004 became Goal 005's first dispatch. Only the run-scoped fields
 * are carried, and every Goal-scoped field is written to its empty value so a
 * later reader sees "nothing has happened yet" rather than a missing key it
 * might resolve from somewhere else.
 */
export function initializeGoalExecutionState({ previousRuntime = null, goal, execution = {} } = {}) {
  const goalId = typeof goal === 'string' ? goal : goal?.goalId;
  if (!goalId) throw new SpikeError('INVALID_ARGS', 'initializeGoalExecutionState needs a goal');

  const carried = {};
  for (const field of RUN_SCOPED_RUNTIME_FIELDS) {
    if (previousRuntime?.[field] !== undefined) carried[field] = previousRuntime[field];
  }

  return {
    ...carried,

    // --- identity ---------------------------------------------------------
    goal: goalId,
    round: 1,

    // --- nothing has been attempted for this Goal -------------------------
    currentJobId: null,
    currentAttemptId: null,
    currentDeveloperJobId: null,
    currentReviewJobId: null,
    jobIdsByRound: {},
    roundsRun: null,

    // --- no verdict, no blockers, no correction ---------------------------
    decision: null,
    reviewDecision: null,
    blockers: [],
    correction: null,
    escalationReason: null,
    lastImplementationReport: null,
    policyViolations: null,
    deferredNextAction: null,
    humanRequired: null,

    // --- no closure, no acceptance ----------------------------------------
    closure: null,
    goalExecuted: false,
    goalCommitted: false,
    goalClosed: false,
    migrationBaselineUpdated: false,
    nextGoalCreated: false,
    nextGoalExecuted: false,
    acceptedSnapshot: null,

    // --- no Developer profile chosen for this Goal yet --------------------
    // Left null rather than defaulted here: the runner resolves the precedence
    // (persisted choice > Tech Lead escalation > Goal declaration > default)
    // and records what it resolved, so the choice is never recomputed twice.
    developerProfile: null,
    nextDeveloperProfile: null,

    // --- no continuation of anything --------------------------------------
    recovery: null,
    capacity: null,
    blockedAgent: null,
    blockedJobId: null,
    resumeFrom: null,
    capacityClearedAt: null,

    // --- whatever the caller genuinely knows about THIS Goal --------------
    ...execution,
  };
}

/**
 * Fails closed when an entity from another Goal is about to be used as current.
 *
 * A historical entity may exist in the store forever — that is what history is.
 * What it may never be is "current". The code is deliberately its own, so the
 * taxonomy can name it a harness error rather than a failure of the Goal.
 */
export function assertBelongsToGoal(entity, goalId, what = 'entity') {
  if (!entity) return entity;
  const entityGoal = typeof entity === 'string' ? goalOfJobId(entity) : entity.goal;
  if (entityGoal !== undefined && entityGoal !== null && entityGoal !== goalId) {
    throw new SpikeError(
      'CROSS_GOAL_STATE_LEAK',
      `Refusing to use ${what} from Goal ${entityGoal} while executing Goal ${goalId}. `
      + 'State from a closed Goal is history; it is never current.',
      { what, entityGoal, currentGoal: goalId, entity: typeof entity === 'string' ? entity : entity.jobId ?? null },
    );
  }
  return entity;
}

/**
 * A job id that may be reused for this Goal, or null.
 *
 * Syntactic, on purpose: job ids carry their Goal (`005-r1-developer-…`), so
 * this needs no store, works on a pointer whose job file is long gone, and can
 * be applied in a pure function such as `planRecovery`.
 */
export function jobIdForGoal(jobId, goalId) {
  if (!jobId || !goalId) return null;
  const owner = goalOfJobId(jobId);
  // An id in an older shape carries no Goal; it is not evidence of a leak.
  if (owner === null) return jobId;
  return owner === goalId ? jobId : null;
}

/**
 * Reads a stored job only when it belongs to this Goal.
 *
 * The store-backed half of the guard: an id can look right and name a job that
 * is not. Anything else fails closed.
 */
export async function readJobForGoal(store, role, jobId, goalId) {
  if (!jobId) return null;
  assertBelongsToGoal(jobId, goalId, `job id ${jobId}`);
  const job = await store.readJob(role, jobId).catch(() => null);
  if (!job) return null;
  assertBelongsToGoal(job, goalId, `job ${jobId}`);
  return job;
}
