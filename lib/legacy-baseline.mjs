/**
 * IA Loop — LEGACY_MONOLITHIC and context-reduction baselines.
 *
 * The Goal is explicit about the failure mode this file exists to refuse:
 * "Goal 003 used 4M tokens, Goal 010 used 2M tokens, therefore ia-loop saved
 * 50%" is invalid reasoning, because the two Goals are different workloads.
 * Sequence and repository membership are never treated as equivalence.
 * Equivalence must be an EXPLICIT claim (the same Goal rerun, an explicit
 * replay pairing, or a declared overlapping operation set) that the CALLER
 * supplies and this module only grades — it never infers one from timing.
 */

import { percentileStats } from './historical-distributions.mjs';

export const RUN_MATCH = Object.freeze({
  MATCHED: 'MATCHED',
  PARTIALLY_MATCHED: 'PARTIALLY_MATCHED',
  UNMATCHED: 'UNMATCHED',
});

/**
 * Grades whether `candidate` is a defensible stand-in for `current`.
 *
 * `current`/`candidate` shape: `{ goalId, runId, replayOf, operationSet }`.
 * `replayOf` is an explicit pointer ("this run IS a replay of that run id"),
 * never inferred. `operationSet` is the distinct set of `operation` values
 * the run touched (e.g. `['planning','implementation','review']`) — an
 * overlap is PARTIALLY_MATCHED at best, never MATCHED, because sharing
 * operation types is not the same claim as being the same workload.
 */
export function classifyRunMatch(current, candidate) {
  if (!current || !candidate) return RUN_MATCH.UNMATCHED;
  if (current.replayOf && current.replayOf === candidate.runId) return RUN_MATCH.MATCHED;
  if (candidate.replayOf && candidate.replayOf === current.runId) return RUN_MATCH.MATCHED;
  if (current.goalId && candidate.goalId && current.goalId === candidate.goalId && current.runId !== candidate.runId) {
    return RUN_MATCH.MATCHED;
  }

  const currentOps = new Set(current.operationSet ?? []);
  const candidateOps = new Set(candidate.operationSet ?? []);
  if (currentOps.size === 0 || candidateOps.size === 0) return RUN_MATCH.UNMATCHED;
  const overlap = [...currentOps].filter((op) => candidateOps.has(op));
  if (overlap.length / currentOps.size >= 0.5) return RUN_MATCH.PARTIALLY_MATCHED;
  return RUN_MATCH.UNMATCHED;
}

/**
 * LEGACY_MONOLITHIC: comparing the current Work-Unit architecture against
 * whatever ran before Work Units existed (a single Developer round handling
 * the whole Goal). Only ever `OK` when the caller supplies at least one
 * `MATCHED` candidate (an explicit rerun/replay) — an `UNMATCHED` population,
 * however tempting to compare "because it's an earlier Goal in this repo",
 * produces `INSUFFICIENT_DATA` instead. That is the intended, common
 * outcome: this repository's Goals before Work Units existed measure a
 * different workload each, with no rerun of any of them on record.
 */
export function legacyMonolithicBaseline({ current, candidates = [] } = {}) {
  const graded = candidates.map((candidate) => ({ candidate, match: classifyRunMatch(current, candidate) }));
  const matched = graded.filter((g) => g.match === RUN_MATCH.MATCHED).map((g) => g.candidate);

  if (matched.length > 0) {
    return {
      baseline: 'LEGACY_MONOLITHIC',
      classification: 'ESTIMATED',
      method: 'MATCHED_HISTORICAL_RUNS',
      status: 'OK',
      matchedRunIds: matched.map((m) => m.runId ?? m.goalId ?? null),
      allModelTokens: percentileStats(matched.map((m) => m.allModelTokens)),
      calculatedCostUsd: percentileStats(matched.map((m) => m.calculatedCostUsd)),
    };
  }

  const partial = graded.filter((g) => g.match === RUN_MATCH.PARTIALLY_MATCHED).map((g) => g.candidate);
  if (partial.length > 0) {
    return {
      baseline: 'LEGACY_MONOLITHIC',
      classification: 'ESTIMATED',
      method: 'MATCHED_HISTORICAL_RUNS',
      status: 'PARTIALLY_MATCHED',
      confidence: 'LOW',
      partiallyMatchedRunIds: partial.map((m) => m.runId ?? m.goalId ?? null),
      note: 'Overlapping operation types only — not the same workload. Not strong enough for a savings figure.',
    };
  }

  return {
    baseline: 'LEGACY_MONOLITHIC',
    classification: 'ESTIMATED',
    method: 'MATCHED_HISTORICAL_RUNS',
    status: 'INSUFFICIENT_DATA',
  };
}

/**
 * Context-size reduction, in CHARACTERS ONLY. Deliberately never converted
 * to a token figure (Goal §17): a shorter packet is not proof of proportionally
 * fewer input tokens, and conflating the two would smuggle an ESTIMATED token
 * number in through a CALCULATED character one.
 *
 * `CALCULATED`, not `ESTIMATED`, when both sides are non-empty: character
 * counts are OBSERVED (`WORK_UNIT_COMPLETED`'s `contextChars`, Goal 018), and
 * a median-to-median difference over them is deterministic arithmetic, not a
 * guess about behaviour that never happened.
 */
export function legacyContextBaseline({ legacyContextChars = [], currentContextChars = [] } = {}) {
  const legacy = percentileStats(legacyContextChars);
  const current = percentileStats(currentContextChars);
  if (!legacy || !current) {
    return { classification: 'CALCULATED', status: 'INSUFFICIENT_DATA', legacy, current };
  }
  const differenceChars = legacy.p50 - current.p50;
  const reductionPercent = legacy.p50 > 0 ? Math.round((differenceChars / legacy.p50) * 1000) / 10 : null;
  return {
    classification: 'CALCULATED',
    status: 'OK',
    legacyMedianChars: legacy.p50,
    currentMedianChars: current.p50,
    differenceChars,
    reductionPercent,
    note: 'Character counts, never converted to a token or cost figure — see Goal 013 §17.',
  };
}
