/**
 * The Goal document's own "Status: ACCEPTED" line, closed deterministically.
 *
 * The incident this closes: Goal 011's closure documentation job wrote 7 real
 * documents but did not touch the Goal's own file (unlike Goal 010's
 * equivalent job, which did) — so `docs/migration/goals/011-...md` still read
 * READY after the implementation was already integrated onto main.
 * `closure-resume.mjs`'s RESUME_PLANNING gate (see closure-resume.test.mjs)
 * correctly refused to continue on that mismatch; what was missing was
 * anything that made the assumption ("integrated ⇒ document says ACCEPTED")
 * true on its own, without depending on a model remembering to write it.
 *
 * No model is called anywhere here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyAcceptedStatusTransition, ensureGoalAcceptedStatus } from '../lib/goal-status-transition.mjs';

const codeIs = (code) => (error) => error.code === code;

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-goal-status-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

const FULL_EVIDENCE = Object.freeze({
  reviewDecision: 'ACCEPTED',
  closureDocsJobId: '011-r3-tech_lead-fa051505',
  integratedClosureCommit: 'a87dd5bb3c2d0b43b19d877deeeccf15179eb178',
  newMigrationBaseline: 'a87dd5bb3c2d0b43b19d877deeeccf15179eb178',
});

const readyDoc = (rest = 'Executor: Developer Agent. Reviewer: Tech Lead Agent.') =>
  `# Goal 011 — Assistente\n\n**Status: READY.** ${rest}\n\nDeveloper execution profile: OPUS_MEDIUM\n`;

const acceptedDoc = (rest = 'Aceito em 2026-09-13 na rodada 3.') =>
  `# Goal 011 — Assistente\n\n**Status: ACCEPTED.** ${rest}\n\nDeveloper execution profile: OPUS_MEDIUM\n`;

// ===========================================================================
// applyAcceptedStatusTransition — the pure decision
// ===========================================================================

test('1. closure normal: the Tech Lead already wrote ACCEPTED — no-op', () => {
  const text = acceptedDoc();
  const result = applyAcceptedStatusTransition(text, FULL_EVIDENCE);
  assert.equal(result.changed, false);
  assert.equal(result.text, text, 'byte-identical — nothing was rewritten');
});

test('2. closure docs omitted the Goal doc, still READY — deterministic transition to ACCEPTED', () => {
  const before = readyDoc('Executor: Developer Agent. Reviewer: Tech Lead Agent, conforme AGENT_ROLES.');
  const result = applyAcceptedStatusTransition(before, FULL_EVIDENCE);
  assert.equal(result.changed, true);
  assert.match(result.text, /\*\*Status: ACCEPTED\.\*\*/);
  // Only the status word moved — the rest of that same sentence, and every
  // other line, is untouched. This is a mechanical fix, not a rewrite.
  assert.match(result.text, /\*\*Status: ACCEPTED\.\*\* Executor: Developer Agent\. Reviewer: Tech Lead Agent, conforme AGENT_ROLES\./);
  assert.match(result.text, /Developer execution profile: OPUS_MEDIUM/);
});

test('3. review is not ACCEPTED — repair forbidden', () => {
  assert.throws(
    () => applyAcceptedStatusTransition(readyDoc(), { ...FULL_EVIDENCE, reviewDecision: 'CHANGES_REQUIRED' }),
    codeIs('STATUS_TRANSITION_REFUSED'),
  );
  assert.throws(
    () => applyAcceptedStatusTransition(readyDoc(), { ...FULL_EVIDENCE, reviewDecision: null }),
    codeIs('STATUS_TRANSITION_REFUSED'),
  );
});

test('3b. closure documentation not recorded as done — repair forbidden', () => {
  assert.throws(
    () => applyAcceptedStatusTransition(readyDoc(), { ...FULL_EVIDENCE, closureDocsJobId: null }),
    codeIs('STATUS_TRANSITION_REFUSED'),
  );
});

test('4. integratedClosureCommit absent — repair forbidden', () => {
  assert.throws(
    () => applyAcceptedStatusTransition(readyDoc(), { ...FULL_EVIDENCE, integratedClosureCommit: null }),
    codeIs('STATUS_TRANSITION_REFUSED'),
  );
  assert.throws(
    () => applyAcceptedStatusTransition(readyDoc(), { ...FULL_EVIDENCE, newMigrationBaseline: null }),
    codeIs('STATUS_TRANSITION_REFUSED'),
    'the baseline half of integration proof is required too',
  );
});

test('5. document in an unexpected format — fails closed', () => {
  assert.throws(
    () => applyAcceptedStatusTransition('# Goal 011\n\nNo status line here at all.\n', FULL_EVIDENCE),
    codeIs('GOAL_STATUS_LINE_UNRECOGNISED'),
  );
  assert.throws(
    () => applyAcceptedStatusTransition('**Status: BLOCKED.** Something else entirely.\n', FULL_EVIDENCE),
    codeIs('GOAL_STATUS_UNEXPECTED'),
    'only a transition from the declared `from` (READY) is authorised',
  );
});

test('never alters functional content: acceptance-note prose written by a real closure survives untouched', () => {
  // If a FUTURE closure run's Tech Lead DOES write the rich acceptance note
  // (round, date, review link) directly, this function must never conflict
  // with or duplicate it — it only ever fires on a document still at `from`.
  const richlyAccepted = acceptedDoc('Aceito em 2026-09-13 na [rodada 3 do review011](../reviews/011-review.md).');
  const result = applyAcceptedStatusTransition(richlyAccepted, FULL_EVIDENCE);
  assert.equal(result.changed, false);
  assert.equal(result.text, richlyAccepted);
});

// ===========================================================================
// ensureGoalAcceptedStatus — the I/O wrapper
// ===========================================================================

test('ensureGoalAcceptedStatus rewrites the real file on disk exactly once', async () => {
  await withDir(async (dir) => {
    const goalsDir = join(dir, 'docs', 'migration', 'goals');
    await mkdir(goalsDir, { recursive: true });
    const goalPath = join(goalsDir, '011-assistente-politicas-estilos-evals.md');
    await writeFile(goalPath, readyDoc(), 'utf8');

    const first = await ensureGoalAcceptedStatus({ repoRoot: dir, goalId: '011', ...FULL_EVIDENCE });
    assert.equal(first.changed, true);
    assert.equal(first.path, goalPath);

    const onDisk = await readFile(goalPath, 'utf8');
    assert.match(onDisk, /\*\*Status: ACCEPTED\.\*\*/);

    // Idempotent: calling it again (a second `ia-loop:close -- 011`) touches nothing.
    const second = await ensureGoalAcceptedStatus({ repoRoot: dir, goalId: '011', ...FULL_EVIDENCE });
    assert.equal(second.changed, false);
    assert.equal(await readFile(goalPath, 'utf8'), onDisk);
  });
});

test('ensureGoalAcceptedStatus never writes anything under MIGRATION_STATUS.md, or reads it at all', async () => {
  await withDir(async (dir) => {
    const goalsDir = join(dir, 'docs', 'migration', 'goals');
    await mkdir(goalsDir, { recursive: true });
    await writeFile(join(goalsDir, '011-x.md'), readyDoc(), 'utf8');
    // Deliberately no MIGRATION_STATUS.md on disk at all — if this function
    // ever tried to read or write it, this would throw ENOENT.
    await ensureGoalAcceptedStatus({ repoRoot: dir, goalId: '011', ...FULL_EVIDENCE });
  });
});

// ===========================================================================
// Wiring in run-close.mjs — proven by source, the pattern already used in
// this codebase for the parts of the orchestrator that are not otherwise
// unit-testable (see e.g. "the runner never assigns the main checkpoint as
// an execution base" in reconcile.test.mjs).
// ===========================================================================

test('run-close.mjs applies the status fix before discoverGoal, only past FRESH, and commits it standalone', async () => {
  const source = await readFile(new URL('../run-close.mjs', import.meta.url), 'utf8');

  const fixAt = source.indexOf('ensureGoalAcceptedStatus({');
  const discoverAt = source.indexOf('await discoverGoal({');
  assert.ok(fixAt > 0 && discoverAt > fixAt, 'the deterministic fix must run before discoverGoal, not after');

  assert.match(source, /resumePoint !== CLOSURE_RESUME_POINTS\.FRESH/,
    'a FRESH closure (nothing integrated yet) must never attempt the fix — there is no evidence yet');

  // The commit this produces is independent: never `--amend`, never touching
  // the worktree, staged by the exact returned path only.
  assert.doesNotMatch(source, /--amend/);
  assert.match(source, /paths:\s*\[statusFix\.path\]/, 'only the one file this function itself changed is ever staged');
});

test('the fix never republishes closure documentation or a second planning job — those checks are unchanged', async () => {
  const source = await readFile(new URL('../run-close.mjs', import.meta.url), 'utf8');
  // These are the pre-existing idempotency guards this change must not
  // disturb: closure docs are skipped once closureDocsJobId is recorded, and
  // planning reuses the existing job before ever minting a new one.
  assert.match(source, /Closure documentation already done/);
  assert.match(source, /if \(!closure\.planningJobId\)/);
});

// ===========================================================================
// The full stop is optional — and the two parsers must agree about that
// ===========================================================================

const EVIDENCE = Object.freeze({
  reviewDecision: 'ACCEPTED',
  closureDocsJobId: '022-r2-tech_lead-abc',
  integratedClosureCommit: '0'.repeat(40),
  newMigrationBaseline: '0'.repeat(40),
});

test('a status line written WITHOUT the full stop is recognised, not refused', () => {
  // The exact shape Goal022's closure documentation wrote. The repair used to
  // require the stop inside the bold, so it threw GOAL_STATUS_LINE_UNRECOGNISED
  // on a document that already read ACCEPTED, and killed the run.
  const text = '# Goal 022 — Central\n\n**Status: ACCEPTED** na rodada 2 ([review](../reviews/022-review.md)).\n';
  const result = applyAcceptedStatusTransition(text, EVIDENCE);

  assert.equal(result.changed, false, 'already ACCEPTED is a no-op, never an error');
  assert.equal(result.text, text);
});

test('READY without the full stop is rewritten, and the sentence around it survives', () => {
  const text = '# Goal 022\n\n**Status: READY** na rodada 1, preparado pelo Tech Lead.\n\nresto\n';
  const result = applyAcceptedStatusTransition(text, EVIDENCE);

  assert.equal(result.changed, true);
  assert.match(result.text, /\*\*Status: ACCEPTED\*\* na rodada 1, preparado pelo Tech Lead\./);
  assert.match(result.text, /resto/, 'nothing outside the status word is touched');
});

test('READY with the full stop still works, unchanged', () => {
  const text = '# Goal 021\n\n**Status: READY.** Executor: Developer Agent.\n';
  const result = applyAcceptedStatusTransition(text, EVIDENCE);

  assert.equal(result.changed, true);
  assert.match(result.text, /\*\*Status: ACCEPTED\.\*\* Executor: Developer Agent\./);
});

test('the repair recognises exactly what discoverGoal recognises', () => {
  // The two regexes read the SAME line for the SAME purpose. When they
  // disagreed, discovery accepted a document the repair called unrecognised —
  // and only the repair was fatal.
  const discovery = /\*\*Status:\s*([A-Z_]+)\.?\*\*/;
  const shapes = [
    '**Status: READY.** Executor: x',
    '**Status: READY** na rodada 1',
    '**Status: ACCEPTED.**',
    '**Status: ACCEPTED** com nota',
  ];

  for (const shape of shapes) {
    const text = `# Goal 099\n\n${shape}\n`;
    assert.ok(discovery.test(text), `discovery should read ${shape}`);
    assert.doesNotThrow(
      () => applyAcceptedStatusTransition(text, EVIDENCE),
      `the repair must not refuse a shape discovery accepts: ${shape}`,
    );
  }
});

test('a document with no status line at all is still refused', () => {
  // Widening what is recognised must not turn into guessing where to write one.
  assert.throws(
    () => applyAcceptedStatusTransition('# Goal 099\n\nsem linha de status\n', EVIDENCE),
    /GOAL_STATUS_LINE_UNRECOGNISED|no "\*\*Status/,
  );
});
