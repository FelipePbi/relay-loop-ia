/**
 * IA Loop — state machine.
 *
 * Transitions come exclusively from validated structured fields. The machine
 * never parses prose and never decides based on model output text.
 *
 * States, transitions and categories are DERIVED from lib/state-registry.mjs,
 * the single canonical definition. Nothing here re-declares a state or a
 * category — that duplication is what let CORRECTION_RUNNING exist in the graph
 * while being unknown to the resumable set.
 */

import { SpikeError } from './claude-process.mjs';
import {
  ALLOWED_TRANSITIONS,
  EXECUTION_STATES,
  LOOP_STATES,
  NOT_IMPLEMENTED_STATES,
  RESUMABLE_STATES,
  STATE_REGISTRY,
  agentFor,
  isKnownState,
  isResumable,
} from './state-registry.mjs';

export {
  ALLOWED_TRANSITIONS,
  EXECUTION_STATES,
  LOOP_STATES,
  NOT_IMPLEMENTED_STATES,
  RESUMABLE_STATES,
  STATE_REGISTRY,
  agentFor,
  isKnownState,
  isResumable,
};

/** Terminal state each review decision maps to. */
const DECISION_TO_STATE = Object.freeze({
  ACCEPTED: LOOP_STATES.ACCEPTED,
  CHANGES_REQUIRED: LOOP_STATES.CHANGES_REQUIRED,
  HUMAN_REQUIRED: LOOP_STATES.HUMAN_REQUIRED,
});

export function createLoopStateMachine({ initialState = LOOP_STATES.IDLE } = {}) {
  if (!isKnownState(initialState)) {
    throw new SpikeError('UNKNOWN_STATE', `Unknown initial state "${initialState}"`);
  }

  let current = initialState;
  const history = [];

  return {
    get state() { return current; },
    get history() { return history.map((entry) => ({ ...entry })); },

    canTransitionTo(next) {
      return (ALLOWED_TRANSITIONS[current] ?? []).includes(next);
    },

    transitionTo(next, meta = {}) {
      if (!isKnownState(next)) {
        throw new SpikeError('UNKNOWN_STATE', `Unknown target state "${next}"`, { from: current, to: next });
      }
      if (!this.canTransitionTo(next)) {
        throw new SpikeError(
          'INVALID_TRANSITION',
          `Transition ${current} -> ${next} is not allowed`,
          { from: current, to: next, allowed: [...(ALLOWED_TRANSITIONS[current] ?? [])] },
        );
      }

      const transition = { from: current, to: next, at: new Date().toISOString(), ...meta };
      history.push(transition);
      current = next;
      return { ...transition };
    },

    /**
     * Jumps directly to `next`, bypassing the ordinary transition graph.
     *
     * `transitionTo` models a process actually DOING the intermediate work —
     * WORKTREE_READY -> DEVELOPER_QUEUED -> ... -> ACCEPTED is a claim that
     * this process ran the Developer and the reviewer. A process that RESUMES
     * an execution whose review already completed, on an earlier attempt or a
     * prior run, never did that work and must never claim to have: walking the
     * graph one fake transition at a time is exactly the "fictitious lifecycle"
     * this exists to avoid, and skipping straight to ACCEPTED through
     * `transitionTo` is correctly refused as INVALID_TRANSITION — a resumed
     * WORKTREE_READY process never dispatched a reviewer in THIS run.
     *
     * `hydrateTo` is the one place allowed past that graph, and only under two
     * conditions that make it unable to become a generic bypass:
     *
     *   - it requires both `reason` and `evidence` — there is no "hydrate for
     *     no stated reason", so a caller cannot reach for this out of
     *     convenience the way an added graph edge would invite;
     *   - the CALLER is responsible for `evidence` actually proving the jump.
     *     This function does not and cannot verify it — see
     *     `assertGoalEligibleForClosure` in closure-eligibility.mjs for the one
     *     case that matters today (resuming an already-ACCEPTED Goal). Nothing
     *     here weakens `transitionTo`: every other caller, and every state this
     *     one is not explicitly used for, still fails exactly as before.
     *
     * The history entry is tagged `hydrated: true`, so an audit trail can always
     * tell a real, sequential transition from a reconciled jump.
     */
    hydrateTo(next, { reason, evidence } = {}) {
      if (!isKnownState(next)) {
        throw new SpikeError('UNKNOWN_STATE', `Unknown target state "${next}"`, { from: current, to: next });
      }
      if (!reason || evidence === undefined || evidence === null) {
        throw new SpikeError(
          'HYDRATION_EVIDENCE_REQUIRED',
          `Hydrating ${current} -> ${next} needs both a reason and evidence; a state jump is never asserted for free.`,
          { from: current, to: next },
        );
      }

      const transition = {
        from: current, to: next, at: new Date().toISOString(), hydrated: true, reason, evidence,
      };
      history.push(transition);
      current = next;
      return { ...transition };
    },
  };
}

export function stateForDecision(decision) {
  const state = DECISION_TO_STATE[decision];
  if (!state) {
    throw new SpikeError('UNSUPPORTED_DECISION', `No state defined for decision ${JSON.stringify(decision)}`);
  }
  return state;
}

/**
 * Where a verdict lands when the run is NOT continuing.
 *
 * V4 automates the correction rounds (loop-config.planAfterReview) and V5
 * automates the closure of an ACCEPTED Goal; this helper describes the
 * supervised stop that remains available in every case.
 */
export function planAfterDecision(decision) {
  switch (decision) {
    case 'ACCEPTED':
      return {
        decision,
        nextState: LOOP_STATES.AWAITING_HUMAN,
        deferredNextAction: 'CLOSE_GOAL',
        note: 'Closure is available; running it is an explicit step.',
      };
    case 'CHANGES_REQUIRED':
      return {
        decision,
        nextState: LOOP_STATES.AWAITING_HUMAN,
        deferredNextAction: 'RETURN_TO_DEVELOPER',
        note: 'Correction rounds run automatically while the round budget lasts.',
      };
    case 'HUMAN_REQUIRED':
      return {
        decision,
        nextState: LOOP_STATES.AWAITING_HUMAN,
        deferredNextAction: 'HUMAN_REQUIRED',
        note: 'The reviewer explicitly asked for a human.',
      };
    default:
      throw new SpikeError('UNSUPPORTED_DECISION', `Unknown decision ${JSON.stringify(decision)}`);
  }
}
