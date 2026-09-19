/**
 * IA Loop — logical identity of a unit of work.
 *
 * A job id is an ATTEMPT. `004-r1-developer-d8f21303` and
 * `004-r1-developer-69a88746` are two attempts at one and the same thing:
 * implement Goal 004, round 1. Nothing in the system said so, so when the
 * recorded id went missing the loop minted a fresh random one, found no result
 * under it, and dispatched Opus to redo work that was already finished and
 * already reviewed.
 *
 * The stage is the thing that can be complete. The attempt is one try at it.
 *
 *   stageKey   004:r1:implementation      what must happen once
 *   jobId      004-r1-developer-69a88746  one attempt at it
 *
 * Attempts stay unique — that is what makes leases and result fencing work.
 * Completion is a property of the STAGE, and no new attempt at a completed
 * stage is ever legitimate.
 */

import { SpikeError } from './claude-process.mjs';
import { TECH_LEAD_NON_REVIEW_JOB_TYPES } from './closure-contracts.mjs';

export const STAGES = Object.freeze({
  IMPLEMENTATION: 'implementation',
  CORRECTION: 'correction',
  REVIEW: 'review',
});

const STAGE_ROLES = Object.freeze({
  [STAGES.IMPLEMENTATION]: 'developer',
  [STAGES.CORRECTION]: 'developer',
  [STAGES.REVIEW]: 'tech_lead',
});

export function roleForStage(stage) {
  const role = STAGE_ROLES[stage];
  if (!role) throw new SpikeError('INVALID_ARGS', `Unknown stage ${JSON.stringify(stage)}`);
  return role;
}

/**
 * The Goal a job id belongs to, read from the id itself.
 *
 * Ids are minted as `${goal}-r${round}-${role}-${uuid}` and attempt ids append
 * `-a${n}`, so the Goal travels with the name. That makes a cross-Goal pointer
 * detectable without the store — which matters, because the pointer that leaked
 * (`004-r1-developer-69a88746` while executing Goal 005) had to be rejected
 * before anything went looking for a job file under it.
 *
 * Returns null for an id in any other shape: unknown is not the same as wrong.
 */
export function goalOfJobId(jobId) {
  if (typeof jobId !== 'string') return null;
  const match = /^(\d{3})-r\d+-/.exec(jobId);
  return match ? match[1] : null;
}

/** The stable name of a unit of work, independent of how many attempts it takes. */
export function stageKey({ goal, round, stage }) {
  if (!goal) throw new SpikeError('INVALID_ARGS', 'stageKey needs a goal');
  if (!Number.isInteger(round) || round < 1) {
    throw new SpikeError('INVALID_ARGS', `stageKey needs a round >= 1, got ${JSON.stringify(round)}`);
  }
  if (!Object.values(STAGES).includes(stage)) {
    throw new SpikeError('INVALID_ARGS', `Unknown stage ${JSON.stringify(stage)}`);
  }
  return `${goal}:r${round}:${stage}`;
}

/**
 * Which stage a stored job belongs to.
 *
 * Derived from the job's own contract fields — role, round and type — so it
 * works on every job already on disk, including those written before stages
 * had a name. A random attempt id can never disguise which stage it belongs to.
 */
export function stageOfJob(job) {
  if (!job) return null;
  const round = Number(job.round);
  if (!Number.isInteger(round) || round < 1) return null;

  if (job.role === 'tech_lead') {
    // The Tech Lead also does closure and planning, which are not review
    // stages of a round and are guarded by their own recorded artefacts.
    //
    // Read from the SAME constant the publishers write, and from the field they
    // actually write it to. This checked `job.kind === 'CLOSURE_DOCS' |
    // 'PLANNING'` — a field and two values that never existed on disk, since
    // run-close.mjs publishes `type: 'CLOSURE_DOCUMENTATION' |
    // 'NEXT_GOAL_PLANNING'`. Both jobs therefore claimed the round's REVIEW
    // stage key, collided with the real review in the ledger, and whichever
    // was enumerated first won it. After Goal006 closed, `ia-loop:status`
    // read the PLANNING job as the round-1 review, found `decision:
    // "NEXT_GOAL"` where a ReviewDecision was expected, and reported a
    // permanent AGENT_CONTRACT_ERROR for a Goal that was already accepted.
    if (TECH_LEAD_NON_REVIEW_JOB_TYPES.includes(job.type)) return null;
    return { goal: job.goal, round, stage: STAGES.REVIEW };
  }

  if (job.role === 'developer') {
    const stage = job.type === 'CORRECTION' ? STAGES.CORRECTION : STAGES.IMPLEMENTATION;
    return { goal: job.goal, round, stage };
  }

  return null;
}

export function stageKeyOfJob(job) {
  const stage = stageOfJob(job);
  return stage ? stageKey(stage) : null;
}
