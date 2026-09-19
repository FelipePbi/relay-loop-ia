/**
 * What this file proves: the coverage answer is validated strictly on shape
 * and permissively on completeness, a partial answer can never read as a clean
 * one, and the prompt tells the model that UNCLEAR beats a guessed NOT_COVERED.
 *
 * Why the call exists: eleven of the eighteen blockers across Goals 020–023
 * are a numbered item the Goal declared and the diff did not deliver. A
 * deterministic matcher was tried first and flagged nothing on Goal023 round 1,
 * where six such items were genuinely unmet — forty-two of that Goal's
 * sixty-four items name no artefact at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COVERAGE_VERDICTS,
  buildCriteriaCoveragePrompt,
  criteriaCoverageSchemaFor,
  summarizeCriteriaCoverage,
  validateCriteriaCoverage,
} from '../lib/criteria-coverage.mjs';

const CTX = { jobId: '024-r1-tech_lead-abc', goal: '024' };
const ok = (items) => ({ protocolVersion: 2, ...CTX, summary: 'feito', items });

// ===========================================================================
// The prompt
// ===========================================================================

test('the prompt says plainly that UNCLEAR beats a guessed NOT_COVERED', () => {
  // A wrong NOT_COVERED costs a correction round chasing nothing, and teaches
  // the reader to skip the field. That instruction is the whole calibration.
  const prompt = buildCriteriaCoveragePrompt({
    goal: '024', requirements: [{ id: '§1', text: 'algo' }], diffStat: 'x', diff: 'y', changedFiles: ['a.ts'],
  });

  assert.match(prompt, /na dúvida responda UNCLEAR, nunca NOT_COVERED/);
  assert.match(prompt, /NÃO é a revisão/, 'não é convite a revisar: é uma pergunta só');
  assert.match(prompt, /\[§1\] algo/);
});

test('the prompt carries the changed files and the diff it is judging', () => {
  const prompt = buildCriteriaCoveragePrompt({
    goal: '024', requirements: [], diffStat: 'STAT', diff: 'DIFFTEXT', changedFiles: ['apps/bff/x.ts'],
  });

  assert.match(prompt, /apps\/bff\/x\.ts/);
  assert.match(prompt, /DIFFTEXT/);
  assert.match(prompt, /STAT/);
});

test('the schema allows exactly the three verdicts and nothing else', () => {
  const schema = criteriaCoverageSchemaFor(CTX);
  assert.deepEqual(schema.properties.items.items.properties.verdict.enum, ['COVERED', 'NOT_COVERED', 'UNCLEAR']);
  assert.equal(schema.additionalProperties, false);
});

// ===========================================================================
// Validation — strict on shape
// ===========================================================================

test('a well-formed answer validates and evidence is kept', () => {
  const result = validateCriteriaCoverage(
    ok([{ id: '§1', verdict: 'COVERED', evidence: 'apps/bff/x.ts' }]),
    CTX,
  );

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].evidence, 'apps/bff/x.ts');
});

test('an unknown verdict is refused rather than passed through', () => {
  assert.throws(() => validateCriteriaCoverage(ok([{ id: '§1', verdict: 'MAYBE' }]), CTX), /not allowed/);
});

test('a mismatched job or goal is refused', () => {
  assert.throws(() => validateCriteriaCoverage({ ...ok([]), jobId: 'outro' }, CTX), /JOB_ID_MISMATCH|jobId/);
  assert.throws(() => validateCriteriaCoverage({ ...ok([]), goal: '999' }, CTX), /GOAL_MISMATCH|goal/);
});

test('missing evidence is null, not absent, so a reader can test for it', () => {
  const result = validateCriteriaCoverage(ok([{ id: '§1', verdict: 'UNCLEAR' }]), CTX);
  assert.equal(result.items[0].evidence, null);
});

// ===========================================================================
// Validation — permissive on completeness, but never silent about it
// ===========================================================================

test('an answer covering only some items is accepted, because a partial reading still helps', () => {
  // Refusing it would turn a convenience into an outage on the review path.
  assert.doesNotThrow(() => validateCriteriaCoverage(ok([{ id: '§1', verdict: 'COVERED' }]), CTX));
});

test('a partial answer with no gaps must NOT read like a Goal with no gaps', () => {
  const coverage = validateCriteriaCoverage(ok([{ id: '§1', verdict: 'COVERED' }]), CTX);
  const line = summarizeCriteriaCoverage(coverage, 64);

  assert.match(line, /1 de 64/);
  assert.match(line, /63 não respondido/, 'o silêncio é contado, não omitido');
});

// ===========================================================================
// The summary
// ===========================================================================

test('items with nothing in the diff are named, with the caveat attached', () => {
  const coverage = validateCriteriaCoverage(ok([
    { id: '§1', verdict: 'COVERED' },
    { id: '§6', verdict: 'NOT_COVERED' },
    { id: 'critério 2', verdict: 'UNCLEAR' },
  ]), CTX);
  const line = summarizeCriteriaCoverage(coverage, 3);

  assert.match(line, /§6/);
  assert.match(line, /não decide \(comportamento, cópia, UX\)/);
  assert.match(line, /não a sua revisão/, 'o limite viaja junto com o achado');
});

test('a coverage that never ran says so, rather than reporting zero gaps', () => {
  const line = summarizeCriteriaCoverage(null, 64);
  assert.match(line, /não apurada/);
  assert.ok(!/0 SEM nada/.test(line));
});

test('a clean coverage carries no warning tail', () => {
  const coverage = validateCriteriaCoverage(ok([{ id: '§1', verdict: 'COVERED' }]), CTX);
  const line = summarizeCriteriaCoverage(coverage, 1);

  assert.ok(!/não a sua revisão/.test(line));
  assert.ok(!/não respondido/.test(line));
});

test('the verdict vocabulary is frozen, so a caller cannot invent a fourth', () => {
  assert.deepEqual(Object.values(COVERAGE_VERDICTS), ['COVERED', 'NOT_COVERED', 'UNCLEAR']);
  assert.throws(() => { COVERAGE_VERDICTS.MAYBE = 'MAYBE'; });
});
