/**
 * Which of this Goal's gates have actually run, across every round.
 *
 * The review packet already carried `validations`, and that field answers a
 * ROUND-shaped question: what did the plan of this round verify. The decision
 * the reviewer is making is GOAL-shaped — is this tree fit to become the
 * migration baseline — and the two came apart badly:
 *
 *   - Goal019 ran one gate of the seven it declared. One refused escalation
 *     blocked the chain and six gates never ran. The packet said
 *     `validations: []` for rounds 2, 3 and 4, the reviewer accepted on the
 *     fourth, and the tree became the baseline having been verified by
 *     `tooling-tests` alone.
 *   - Goal018 ran eight gates in round 1, all green, and was accepted in
 *     round 3 — where the packet again said `validations: []`, because a
 *     correction round is a single unit and declares no gates at all. The
 *     information existed and did not reach the decision.
 *
 * An empty list reads as "nothing to report", never as "nothing was verified",
 * and nothing in the packet distinguished the two. This says it outright.
 *
 * It states facts and draws no conclusion: a gate that has not run is reported
 * as NEVER_RAN, a gate that passed three rounds ago is reported with how stale
 * it is, and what to do about either stays the reviewer's call.
 */

/** What is known about one gate, at the moment the packet is built. */
export const GATE_OUTCOMES = Object.freeze({
  /** Ran in this Goal and exited 0. */
  PASSED: 'PASSED',
  /** Ran and did not exit 0. */
  FAILED: 'FAILED',
  /**
   * The harness could not meet its precondition — a missing environment
   * variable, typically a disposable database — so nothing was spawned.
   */
  SKIPPED: 'SKIPPED',
  /**
   * Ran over a tree an upstream unit left incomplete. Its answer is real and
   * it is NOT acceptance, which is why it is not PASSED even when it exits 0.
   */
  OBSERVED: 'OBSERVED',
  /** Declared by the plan and never executed in any round. */
  NEVER_RAN: 'NEVER_RAN',
});

const EXECUTED = 'WORK_UNIT_DETERMINISTIC_EXECUTED';
const ON_INCOMPLETE_TREE = 'WORK_UNIT_VERIFICATION_ON_INCOMPLETE_TREE';

const keyOf = (event) => `${event.round}:${event.workUnitId}`;

/**
 * Derives the per-gate status of a Goal.
 *
 * `declaredGates` comes from the Goal's execution plan — `{ id, action, scope }`
 * per DETERMINISTIC unit the Tech Lead said this Goal needs. `events` is the
 * Goal's event history, which is where every execution is recorded. Pure: it
 * reads no store and no clock, so the same inputs always produce the same
 * answer.
 */
export function deriveGoalGateStatus({ declaredGates = [], events = [], currentRound = 1 } = {}) {
  const forGoal = events.filter((event) => event?.type === EXECUTED || event?.type === ON_INCOMPLETE_TREE);

  // A gate run over an incomplete tree emits BOTH events — it really did run,
  // and it really is not a verdict. The second is what downgrades it.
  const observed = new Set(forGoal.filter((event) => event.type === ON_INCOMPLETE_TREE).map(keyOf));

  // Keyed by UNIT, not by action. Goal018 declares three `typecheck` units,
  // one per app; collapsing them into a single `typecheck` row would let one
  // app's green answer for another app that never ran.
  const latest = new Map();
  for (const event of forGoal) {
    if (event.type !== EXECUTED) continue;
    const unitId = event.workUnitId;
    if (!unitId) continue;
    const previous = latest.get(unitId);
    // The most recent run wins: a gate re-run after a corrective unit is
    // answering about a newer tree than the run that failed before it.
    if (previous && previous.round > (event.round ?? 0)) continue;
    latest.set(unitId, event);
  }

  const declared = declaredGates
    .filter((gate) => gate && typeof gate.id === 'string' && gate.id !== '')
    .map((gate) => ({ id: gate.id, action: gate.action ?? null, scope: gate.scope ?? null }));
  const declaredIds = new Set(declared.map((gate) => gate.id));
  // A gate that ran without being declared is still a fact about this tree.
  const extra = [...latest.keys()]
    .filter((id) => !declaredIds.has(id))
    .map((id) => ({ id, action: latest.get(id).action ?? null, scope: null }));

  return [...declared, ...extra].map(({ id, action, scope }) => {
    const event = latest.get(id);
    if (!event) {
      return Object.freeze({
        id, action, scope, outcome: GATE_OUTCOMES.NEVER_RAN, round: null, exitCode: null, roundsStale: null,
      });
    }

    const round = event.round ?? null;
    const outcome = event.skipped
      ? GATE_OUTCOMES.SKIPPED
      : observed.has(keyOf(event))
        ? GATE_OUTCOMES.OBSERVED
        : (event.ok ? GATE_OUTCOMES.PASSED : GATE_OUTCOMES.FAILED);

    return Object.freeze({
      id,
      action,
      scope,
      outcome,
      round,
      exitCode: event.exitCode ?? null,
      // How many rounds of edits have landed since this gate last spoke. Zero
      // means it answered about the tree under review; anything above zero
      // means the tree moved after it did.
      roundsStale: Number.isInteger(round) ? Math.max(0, currentRound - round) : null,
    });
  });
}

/**
 * One line the reviewer cannot read as "nothing to report".
 *
 * Returned beside the rows because the rows alone repeat the failure they
 * exist to fix: a reviewer skimming a list of five NEVER_RAN needs the same
 * sentence a person would say out loud.
 */
export function summarizeGoalGateStatus(rows = []) {
  if (rows.length === 0) return 'Este Goal não declarou nenhuma verificação determinística.';

  const count = (outcome) => rows.filter((row) => row.outcome === outcome).length;
  const never = count(GATE_OUTCOMES.NEVER_RAN);
  const failed = count(GATE_OUTCOMES.FAILED);
  const skipped = count(GATE_OUTCOMES.SKIPPED);
  const observed = count(GATE_OUTCOMES.OBSERVED);
  const passed = count(GATE_OUTCOMES.PASSED);
  const stale = rows.filter((row) => row.outcome === GATE_OUTCOMES.PASSED && row.roundsStale > 0).length;

  const parts = [`${rows.length} gate(s) declarado(s) neste Goal:`];
  parts.push(`${passed} passou(ram)${stale > 0 ? ` (${stale} sobre árvore de rodada anterior)` : ''}`);
  if (failed > 0) parts.push(`${failed} falhou(ram)`);
  if (observed > 0) parts.push(`${observed} apenas observado(s) sobre árvore incompleta`);
  if (skipped > 0) parts.push(`${skipped} com pré-condição ausente`);
  if (never > 0) parts.push(`**${never} NUNCA rodou(ram) em rodada alguma**`);

  const tail = never > 0 || observed > 0 || skipped > 0
    ? ' Um gate que não rodou não é um gate que passou: se aceitar assim, diga no relatório o que está aceitando sem prova.'
    : '';

  return `${parts.join(' · ')}.${tail}`;
}
