/**
 * IA Loop — canonical state registry.
 *
 * ONE definition per state: its transitions and its properties live together.
 * Everything else — the transition graph, the resumable set, the observability
 * categories — is derived from here.
 *
 * This exists because of a real bug: CORRECTION_RUNNING was added to the state
 * machine but forgotten in a parallel hand-maintained list of resumable states,
 * so a capacity retry during a correction could not even be persisted. Two lists
 * that must agree, with nothing forcing them to, is the defect. Derivation is
 * the fix.
 *
 * Fields:
 *   to         states reachable from here (the transition graph)
 *   resumable  a run parked by a capacity wait may re-enter this state
 *   execution  an agent is doing work in this state
 *   agent      which role is working, when one is
 *   terminal   the run ends here
 */

export const STATE_REGISTRY = Object.freeze({
  IDLE: { to: ['GOAL_READY', 'STOPPED'] },
  GOAL_READY: { to: ['PREPARING_WORKTREE', 'STOPPED'] },
  PREPARING_WORKTREE: { to: ['WORKTREE_READY', 'HUMAN_REQUIRED', 'STOPPED'] },
  WORKTREE_READY: { to: ['DEVELOPER_QUEUED', 'CORRECTION_QUEUED', 'STOPPED'] },

  DEVELOPER_QUEUED: {
    to: ['DEVELOPER_RUNNING', 'WAITING_FOR_CAPACITY', 'HUMAN_REQUIRED', 'STOPPED'],
    resumable: true, agent: 'developer',
  },
  DEVELOPER_RUNNING: {
    to: ['REVIEW_REQUIRED', 'WAITING_FOR_CAPACITY', 'HUMAN_REQUIRED', 'STOPPED'],
    resumable: true, execution: true, agent: 'developer',
  },

  CORRECTION_QUEUED: {
    to: ['CORRECTION_RUNNING', 'WAITING_FOR_CAPACITY', 'HUMAN_REQUIRED', 'STOPPED'],
    resumable: true, agent: 'developer',
  },
  CORRECTION_RUNNING: {
    to: ['REVIEW_REQUIRED', 'WAITING_FOR_CAPACITY', 'HUMAN_REQUIRED', 'STOPPED'],
    resumable: true, execution: true, agent: 'developer',
  },

  REVIEW_REQUIRED: { to: ['REVIEWER_QUEUED', 'STOPPED'] },
  REVIEWER_QUEUED: {
    to: ['REVIEWER_RUNNING', 'WAITING_FOR_CAPACITY', 'HUMAN_REQUIRED', 'STOPPED'],
    resumable: true, agent: 'tech_lead',
  },
  REVIEWER_RUNNING: {
    to: ['ACCEPTED', 'CHANGES_REQUIRED', 'WAITING_FOR_CAPACITY', 'HUMAN_REQUIRED', 'STOPPED'],
    resumable: true, execution: true, agent: 'tech_lead',
  },

  // ACCEPTED proceeds to closure on its own. AWAITING_HUMAN stays reachable for
  // a supervised run, but is no longer where the happy path ends.
  ACCEPTED: { to: ['AWAITING_HUMAN', 'CLOSURE_PREPARING'] },
  CHANGES_REQUIRED: { to: ['AWAITING_HUMAN', 'CORRECTION_QUEUED'] },
  HUMAN_REQUIRED: { to: ['AWAITING_HUMAN'] },

  // --- Closure of an accepted Goal ---------------------------------------
  CLOSURE_PREPARING: { to: ['CLOSURE_DOCUMENTING', 'HUMAN_REQUIRED', 'STOPPED'] },
  CLOSURE_DOCUMENTING: {
    to: ['CLOSURE_READY', 'WAITING_FOR_CAPACITY', 'HUMAN_REQUIRED', 'STOPPED'],
    resumable: true, execution: true, agent: 'tech_lead',
  },
  CLOSURE_READY: { to: ['GOAL_COMMITTING', 'HUMAN_REQUIRED', 'STOPPED'] },
  GOAL_COMMITTING: { to: ['GOAL_COMMITTED', 'HUMAN_REQUIRED', 'STOPPED'] },
  GOAL_COMMITTED: { to: ['INTEGRATING_ACCEPTED', 'HUMAN_REQUIRED', 'STOPPED'] },
  INTEGRATING_ACCEPTED: { to: ['BASELINE_ACCEPTED', 'HUMAN_REQUIRED', 'STOPPED'] },
  BASELINE_ACCEPTED: { to: ['NEXT_GOAL_PLANNING', 'AWAITING_HUMAN', 'PAUSED', 'STOPPED'] },
  NEXT_GOAL_PLANNING: {
    to: ['NEXT_GOAL_READY', 'MIGRATION_COMPLETE', 'WAITING_FOR_CAPACITY', 'HUMAN_REQUIRED', 'STOPPED'],
    resumable: true, execution: true, agent: 'tech_lead',
  },
  // The autonomous path continues here instead of stopping.
  NEXT_GOAL_READY: { to: ['NEXT_GOAL_STARTING', 'AWAITING_HUMAN', 'PAUSED', 'STOPPED'] },
  NEXT_GOAL_STARTING: { to: ['PREPARING_WORKTREE', 'HUMAN_REQUIRED', 'PAUSED', 'STOPPED'] },

  // A capacity wait returns to whichever resumable state it came from; the
  // targets are DERIVED below, never hand-listed.
  WAITING_FOR_CAPACITY: { to: null },

  // A voluntary, resumable stop. Never the same as HUMAN_REQUIRED, which is a
  // problem to solve rather than a decision to reverse.
  PAUSED: { to: ['NEXT_GOAL_STARTING', 'PREPARING_WORKTREE', 'DEVELOPER_QUEUED', 'CORRECTION_QUEUED', 'REVIEWER_QUEUED', 'CLOSURE_PREPARING', 'NEXT_GOAL_PLANNING', 'STOPPED'] },

  // The migration is finished, declared explicitly and verified against the
  // repository — never inferred from the absence of a next Goal.
  MIGRATION_COMPLETE: { to: ['STOPPED'], terminal: true },

  AWAITING_HUMAN: { to: ['STOPPED'] },
  STOPPED: { to: [], terminal: true },
});

/** All canonical state names. */
export const LOOP_STATES = Object.freeze(
  Object.fromEntries(Object.keys(STATE_REGISTRY).map((s) => [s, s])),
);

/** States a capacity wait may resume into — derived, never maintained by hand. */
export const RESUMABLE_STATES = Object.freeze(
  Object.entries(STATE_REGISTRY).filter(([, def]) => def.resumable === true).map(([name]) => name),
);

/** States in which an agent is actively working. */
export const EXECUTION_STATES = Object.freeze(
  Object.entries(STATE_REGISTRY).filter(([, def]) => def.execution === true).map(([name]) => name),
);

/**
 * The transition graph, derived from the registry.
 * WAITING_FOR_CAPACITY's targets are exactly the resumable states plus the
 * escape hatches, so adding a resumable state can never leave it stranded.
 */
export const ALLOWED_TRANSITIONS = Object.freeze(
  Object.fromEntries(Object.entries(STATE_REGISTRY).map(([name, def]) => [
    name,
    Object.freeze(def.to === null
      ? [...RESUMABLE_STATES, 'HUMAN_REQUIRED', 'STOPPED']
      : [...def.to]),
  ])),
);

export function isKnownState(state) {
  return Object.hasOwn(STATE_REGISTRY, state);
}

export function isResumable(state) {
  return STATE_REGISTRY[state]?.resumable === true;
}

export function agentFor(state) {
  return STATE_REGISTRY[state]?.agent ?? null;
}

/** States explicitly NOT implemented. Named so the omission stays deliberate. */
export const NOT_IMPLEMENTED_STATES = Object.freeze(['AUTONOMOUS_NEXT_GOAL']);
