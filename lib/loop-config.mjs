/**
 * IA Loop — loop configuration.
 *
 * Round limits live here so the boundary between "keep correcting" and "ask a
 * human" is one named value, not a number buried in the orchestrator.
 */

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

export const LOOP_CONFIG = Object.freeze({
  /**
   * Total rounds, counting the initial implementation.
   *
   * R1 = initial implementation + first review
   * R2 = first correction + review
   * R3 = second correction + review
   *
   * A CHANGES_REQUIRED after the R3 review escalates instead of starting R4.
   */
  maxCorrectionRounds: envInt('IA_LOOP_MAX_CORRECTION_ROUNDS', 3),

  reviewLevel: 'DEEP',
});

export const ESCALATION_REASONS = Object.freeze({
  MAX_CORRECTION_ROUNDS_REACHED: 'MAX_CORRECTION_ROUNDS_REACHED',
});

/**
 * Decides what follows a review decision.
 *
 * The round limit is the only thing that turns a repeated CHANGES_REQUIRED into
 * an escalation: the number of rounds is a budget, not evidence of a problem.
 */
export function planAfterReview({ decision, round, config = LOOP_CONFIG }) {
  if (decision === 'ACCEPTED') {
    return { action: 'STOP', decision, reason: null };
  }
  if (decision === 'HUMAN_REQUIRED') {
    return { action: 'STOP', decision, reason: 'REVIEWER_ASKED_FOR_HUMAN' };
  }
  if (decision !== 'CHANGES_REQUIRED') {
    return { action: 'STOP', decision, reason: 'UNKNOWN_DECISION' };
  }

  if (round >= config.maxCorrectionRounds) {
    return {
      action: 'STOP',
      decision: 'HUMAN_REQUIRED',
      reason: ESCALATION_REASONS.MAX_CORRECTION_ROUNDS_REACHED,
      note: `Review of round ${round} still asks for changes and the limit of ${config.maxCorrectionRounds} rounds was reached.`,
    };
  }

  return { action: 'CORRECT', decision, nextRound: round + 1, reason: null };
}
