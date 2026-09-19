/**
 * IA Loop — handing a recovered run to a new orchestrator.
 *
 * An autonomous run and the process driving it are two different things, and
 * conflating them is what stranded a run after a reboot:
 *
 *   run auto-7b32c56a   status RUNNING    the campaign is not finished
 *   orchestrator        NONE              no process is driving it
 *
 * That pair is a perfectly valid state after a crash. RUNNING means the
 * campaign has not finished; it does not mean anyone is working on it.
 *
 * So recovery does not become the orchestrator. It proves the old one is gone,
 * records what the next safe step is, and leaves a handoff behind — then exits
 * holding nothing. A lease that belongs to a process which has already ended is
 * phantom ownership: it reads as "someone is working" for as long as the expiry
 * window lasts, and blocks the very command recovery just told you to run.
 *
 * The handoff is a one-shot token. The next orchestrator claims the loop lease
 * atomically, then consumes the token; a token already consumed, or belonging to
 * a different run, is refused rather than reused.
 */

import { randomUUID } from 'node:crypto';

import { SpikeError } from './claude-process.mjs';
import { readJson, writeJsonAtomic } from './job-store.mjs';

export const HANDOFF_STATUS = Object.freeze({
  READY_FOR_ATTACH: 'READY_FOR_ATTACH',
  CONSUMED: 'CONSUMED',
});

export function createHandoffStore(stateDir) {
  const path = `${stateDir}/recovery-handoff.json`;

  return {
    path,

    read() {
      return readJson(path);
    },

    /**
     * Records that a run is recovered and waiting for an orchestrator.
     *
     * Everything the next process needs to verify the handoff belongs to it is
     * written here: which run, which recovery attempt, the state it was
     * recovered from, and the step that was judged safe.
     */
    async write({
      autonomousRunId,
      recoveryAttempt,
      recoveredFromState,
      nextSafeAction,
      jobId = null,
      agent = null,
      goal = null,
      round = null,
      supersededOwner = null,
      proof = null,
    }) {
      if (!autonomousRunId) throw new SpikeError('INVALID_ARGS', 'A handoff must name its run');
      if (!nextSafeAction) throw new SpikeError('INVALID_ARGS', 'A handoff must name the next safe action');

      const handoff = {
        status: HANDOFF_STATUS.READY_FOR_ATTACH,
        autonomousRunId,
        // The nonce is what makes the handoff one-shot: it is checked and
        // cleared together, so a second attach cannot replay the first.
        nonce: `handoff-${randomUUID().slice(0, 12)}`,
        recoveryAttempt,
        recoveredFromState,
        nextSafeAction,
        jobId,
        agent,
        goal,
        round,
        supersededOwner,
        proof,
        createdAt: new Date().toISOString(),
        consumedAt: null,
        consumedBy: null,
      };
      await writeJsonAtomic(path, handoff);
      return handoff;
    },

    /**
     * Is there a handoff this orchestrator may act on?
     *
     * Fails closed on every kind of mismatch: a handoff for another run, an
     * already consumed one, or a malformed one is never "close enough".
     */
    async validateFor(autonomousRunId) {
      const handoff = await this.read();
      if (!handoff) return { valid: false, reason: 'NO_HANDOFF', handoff: null };
      if (handoff.status === HANDOFF_STATUS.CONSUMED) {
        return { valid: false, reason: 'HANDOFF_ALREADY_CONSUMED', handoff };
      }
      if (handoff.status !== HANDOFF_STATUS.READY_FOR_ATTACH) {
        return { valid: false, reason: 'HANDOFF_MALFORMED', handoff };
      }
      if (handoff.autonomousRunId !== autonomousRunId) {
        return { valid: false, reason: 'HANDOFF_FOR_ANOTHER_RUN', handoff };
      }
      if (!handoff.nonce || !handoff.nextSafeAction) {
        return { valid: false, reason: 'HANDOFF_MALFORMED', handoff };
      }
      return { valid: true, reason: null, handoff };
    },

    /**
     * Consumes the handoff, once.
     *
     * The nonce read at validation time must still be the one on disk. The
     * orchestrator lease already serialises this — only its holder gets here —
     * but the check costs nothing and makes the one-shot property local instead
     * of something you have to trace through the lease to believe.
     */
    async consume({ nonce, consumedBy }) {
      const handoff = await this.read();
      if (!handoff) return { consumed: false, reason: 'NO_HANDOFF' };
      if (handoff.status === HANDOFF_STATUS.CONSUMED) {
        return { consumed: false, reason: 'HANDOFF_ALREADY_CONSUMED', handoff };
      }
      if (handoff.nonce !== nonce) {
        return { consumed: false, reason: 'HANDOFF_CHANGED', handoff };
      }

      const updated = {
        ...handoff,
        status: HANDOFF_STATUS.CONSUMED,
        consumedAt: new Date().toISOString(),
        consumedBy: consumedBy ?? null,
      };
      await writeJsonAtomic(path, updated);
      return { consumed: true, handoff: updated };
    },
  };
}

/**
 * Does an existing handoff already cover this situation?
 *
 * Running recovery twice on an unchanged run must not take the lease again or
 * mint a second token; it should say "already recovered" and stop.
 */
export function handoffCovers(handoff, { autonomousRunId, state, nextSafeAction }) {
  return Boolean(handoff)
    && handoff.status === HANDOFF_STATUS.READY_FOR_ATTACH
    && handoff.autonomousRunId === autonomousRunId
    && handoff.recoveredFromState === state
    && handoff.nextSafeAction === nextSafeAction;
}
