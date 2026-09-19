/**
 * IA Loop — minimal supervised state machine (V1).
 *
 * Transitions are driven exclusively by validated structured fields. The
 * machine has no opinion about content and never parses prose.
 *
 * Implemented in V1:
 *
 *   START -> DEVELOPER_RUNNING -> REVIEW_REQUIRED -> REVIEWER_RUNNING
 *         -> ACCEPTED | CHANGES_REQUIRED | HUMAN_REQUIRED -> STOP
 *
 * Deliberately NOT implemented yet: the correction loop (going back to the
 * Developer) and CREATE_NEXT_GOAL. When the review asks for changes we record
 * the deferred action and stop.
 */

import { SpikeError } from './claude-process.mjs';

export const STATES = Object.freeze({
  START: 'START',
  DEVELOPER_RUNNING: 'DEVELOPER_RUNNING',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  REVIEWER_RUNNING: 'REVIEWER_RUNNING',
  ACCEPTED: 'ACCEPTED',
  CHANGES_REQUIRED: 'CHANGES_REQUIRED',
  HUMAN_REQUIRED: 'HUMAN_REQUIRED',
  STOP: 'STOP',
});

const ALLOWED_TRANSITIONS = Object.freeze({
  START: ['DEVELOPER_RUNNING'],
  DEVELOPER_RUNNING: ['REVIEW_REQUIRED'],
  REVIEW_REQUIRED: ['REVIEWER_RUNNING'],
  REVIEWER_RUNNING: ['ACCEPTED', 'CHANGES_REQUIRED', 'HUMAN_REQUIRED'],
  ACCEPTED: ['STOP'],
  CHANGES_REQUIRED: ['STOP'],
  HUMAN_REQUIRED: ['STOP'],
  STOP: [],
});

/** Terminal state each review decision leads to, before stopping. */
const DECISION_TO_STATE = Object.freeze({
  ACCEPTED: STATES.ACCEPTED,
  CHANGES_REQUIRED: STATES.CHANGES_REQUIRED,
  HUMAN_REQUIRED: STATES.HUMAN_REQUIRED,
});

export function createStateMachine({ initialState = STATES.START } = {}) {
  if (!Object.hasOwn(ALLOWED_TRANSITIONS, initialState)) {
    throw new SpikeError('UNKNOWN_STATE', `Unknown initial state "${initialState}"`);
  }

  let current = initialState;
  const history = [];

  return {
    get state() {
      return current;
    },

    /** Ordered list of transitions actually taken, for reporting. */
    get history() {
      return history.map((entry) => ({ ...entry }));
    },

    /** Whether a transition is legal, without performing it. */
    canTransitionTo(next) {
      return (ALLOWED_TRANSITIONS[current] ?? []).includes(next);
    },

    /** Performs a transition, failing closed on anything not allowed. */
    transitionTo(next) {
      if (!Object.hasOwn(ALLOWED_TRANSITIONS, next)) {
        throw new SpikeError('UNKNOWN_STATE', `Unknown target state "${next}"`, { from: current, to: next });
      }
      if (!this.canTransitionTo(next)) {
        throw new SpikeError(
          'INVALID_TRANSITION',
          `Transition ${current} -> ${next} is not allowed`,
          { from: current, to: next, allowed: [...(ALLOWED_TRANSITIONS[current] ?? [])] },
        );
      }

      const transition = { from: current, to: next };
      history.push(transition);
      current = next;
      return { ...transition };
    },
  };
}

/**
 * Maps a validated review decision to its state.
 * The decision must already have been contract-validated; this only translates.
 */
export function stateForDecision(decision) {
  const state = DECISION_TO_STATE[decision];
  if (!state) {
    throw new SpikeError('UNSUPPORTED_DECISION', `No state defined for decision ${JSON.stringify(decision)}`);
  }
  return state;
}

/**
 * What V1 would do next, without doing it.
 *
 * RETURN_TO_DEVELOPER is intentionally deferred: the correction loop is out of
 * scope, so the run records the intent and stops instead of calling the
 * Developer again.
 */
export function planNextAction(nextAction) {
  switch (nextAction) {
    case 'STOP':
      return { nextAction, deferred: false, note: 'Run complete.' };
    case 'RETURN_TO_DEVELOPER':
      return {
        nextAction,
        deferred: true,
        note: 'Correction loop is not implemented in V1; stopping instead of re-invoking the Developer.',
      };
    case 'HUMAN_REQUIRED':
      return { nextAction, deferred: true, note: 'Human decision required; stopping.' };
    default:
      throw new SpikeError('UNSUPPORTED_NEXT_ACTION', `Unknown nextAction ${JSON.stringify(nextAction)}`);
  }
}
