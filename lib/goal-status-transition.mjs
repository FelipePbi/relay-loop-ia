/**
 * IA Loop — the Goal document's own status line, closed deterministically.
 *
 * "Status: ACCEPTED" in the Goal document is not a model's memory to trust —
 * it is a STRUCTURAL FACT, entailed by evidence already persisted before this
 * ever runs: a final ACCEPTED review, closure documentation recorded as
 * done, and the implementation proven integrated onto main
 * (integratedClosureCommit + newMigrationBaseline, written together by
 * run-close.mjs's integration step — see closure-resume.mjs). When all four
 * hold, the document must read ACCEPTED, and getting there costs no model
 * call: it is one deterministic line rewrite, gated tightly enough that it
 * can never fire on anything less than the full evidence set.
 *
 * What this closes: Goal 011's closure documentation job wrote 7 real
 * documents but happened not to touch the Goal's own file this time (Goal
 * 010's equivalent job had). Nothing downstream noticed until
 * closure-resume.mjs's own RESUME_PLANNING gate — which assumes the document
 * already says ACCEPTED once integration is proven — refused to continue.
 * The gate was correct to refuse; the gap was that nothing made the
 * assumption true on its own.
 *
 * MIGRATION_STATUS.md is a different fact on a different clock (finalized
 * only when NEXT_GOAL_PLANNING integrates — see
 * closure-resume.mjs#expectedMigrationStatusRowFor) and is never touched
 * here.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SpikeError } from './claude-process.mjs';
import { findGoalFile } from './goal-discovery.mjs';

/**
 * The status line, recognised exactly as `discoverGoal` recognises it.
 *
 * The full stop is OPTIONAL, and that single character is not a detail. Both
 * shapes are written in practice — `**Status: READY.** Executor: …` by the
 * Goal template, `**Status: ACCEPTED** na rodada 2 (…)` by the closure
 * documentation — and `goal-discovery.mjs:60` has always accepted both
 * (`\.?\*\*`). This regex required it, so the two parsers disagreed about the
 * same line: discovery read the document fine while the repair refused it as
 * unrecognised.
 *
 * That disagreement was unreachable while the repair only ran on a RESUMED
 * closure. The moment it also ran inside a fresh one — right after
 * integration, so an omitted status is caught in the same run — Goal022 hit
 * it and stopped as GOAL_STATUS_LINE_UNRECOGNISED with its document ALREADY
 * reading ACCEPTED. The repair had nothing to repair and killed the run over
 * a full stop.
 *
 * Group 3 keeps whatever followed the status word, including the `**`, so a
 * rewrite preserves the sentence the closure wrote around it.
 */
const STATUS_LINE = /^(\*\*Status:\s*)([A-Z_]+)(\.?\*\*.*)$/m;

/**
 * Pure decision: given the document's current text and the evidence for one
 * Goal, what (if anything) should the status line become.
 *
 * Never touches anything but the status word itself — the rest of that
 * sentence, and everything else in the document, is untouched, so a
 * hand-authored acceptance note (dates, round, review link) some closures
 * write is neither required nor erased by this function.
 *
 * @returns { text, changed } — `text` is the input unchanged, or with the
 * status line rewritten; `changed` says which. A document that already
 * reads `to` is a no-op (not an error): idempotency is not "the unexpected".
 * Every other case that is not exactly the authorised transition throws,
 * failing closed rather than guessing.
 */
export function applyAcceptedStatusTransition(goalText, {
  reviewDecision,
  closureDocsJobId,
  integratedClosureCommit,
  newMigrationBaseline,
  from = 'READY',
  to = 'ACCEPTED',
} = {}) {
  if (reviewDecision !== 'ACCEPTED') {
    throw new SpikeError(
      'STATUS_TRANSITION_REFUSED',
      `Refusing to mark the Goal document ${to}: the final review decision is `
      + `${reviewDecision ?? 'unknown'}, not ACCEPTED.`,
    );
  }
  if (!closureDocsJobId) {
    throw new SpikeError(
      'STATUS_TRANSITION_REFUSED',
      `Refusing to mark the Goal document ${to}: no closure documentation job is recorded as done.`,
    );
  }
  if (!integratedClosureCommit || !newMigrationBaseline) {
    throw new SpikeError(
      'STATUS_TRANSITION_REFUSED',
      `Refusing to mark the Goal document ${to}: the closure commit is not proven integrated `
      + `(integratedClosureCommit=${integratedClosureCommit ?? 'null'}, newMigrationBaseline=${newMigrationBaseline ?? 'null'}).`,
    );
  }

  const match = STATUS_LINE.exec(goalText);
  if (!match) {
    throw new SpikeError(
      'GOAL_STATUS_LINE_UNRECOGNISED',
      'The Goal document has no "**Status: X.**" line in the expected shape; refusing to guess where to write one.',
    );
  }

  const current = match[2];
  if (current === to) return { text: goalText, changed: false };
  if (current !== from) {
    throw new SpikeError(
      'GOAL_STATUS_UNEXPECTED',
      `Refusing to move the Goal document from ${current} to ${to}: only a transition from ${from} is authorised here.`,
    );
  }

  const rewritten = `${match[1]}${to}${match[3]}`;
  const text = goalText.slice(0, match.index) + rewritten + goalText.slice(match.index + match[0].length);
  return { text, changed: true };
}

/**
 * The I/O wrapper `run-close.mjs` actually calls: reads the Goal document,
 * applies the pure transition above, and writes it back only when something
 * changed. Reuses `findGoalFile` so this never disagrees with `discoverGoal`
 * about which file a Goal's document is.
 *
 * @returns { changed, path } — `changed` false covers both "already
 * ACCEPTED" and "evidence incomplete for this resume point" (the latter
 * checked by the caller before calling this at all; see run-close.mjs).
 */
export async function ensureGoalAcceptedStatus({
  repoRoot, goalId, reviewDecision, closureDocsJobId, integratedClosureCommit, newMigrationBaseline, emit = () => {},
}) {
  const goalsDir = join(repoRoot, 'docs', 'migration', 'goals');
  const goalPath = await findGoalFile(goalsDir, goalId);
  const goalText = await readFile(goalPath, 'utf8');

  const { text, changed } = applyAcceptedStatusTransition(goalText, {
    reviewDecision, closureDocsJobId, integratedClosureCommit, newMigrationBaseline,
  });

  if (changed) {
    await writeFile(goalPath, text, 'utf8');
    emit(`Goal document status was READY; closure evidence proves ACCEPTED — corrected deterministically, no model call.`);
  }

  return { changed, path: goalPath };
}
