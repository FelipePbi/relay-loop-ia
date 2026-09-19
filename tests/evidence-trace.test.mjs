/**
 * What this file proves: the tokens a blocker names and this round did not
 * touch are listed as a FACT, prose that names nothing is never reported as
 * suspicious, and nothing here can throw a review away.
 *
 * The incident: Goal023 round 2 answered all six blockers `met: true` with
 * truthful detail, and the reviewer found three of them unfinished — each
 * blocker named one more thing the unit had missed. Measured against that
 * round, the absent lists named two of those three.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TRACE_VERDICTS,
  blockersAsItems,
  extractCitations,
  extractGoalRequirements,
  summarizeBlockerTrace,
  traceAll,
  traceEvidence,
} from '../lib/evidence-trace.mjs';

// ===========================================================================
// Citations
// ===========================================================================

test('a backticked path with a line range is cited without the range', () => {
  const { paths } = extractCitations('o comentário de `apps/bff/src/clients/scheduling/index.ts:1480-1487` continua');
  assert.deepEqual(paths, ['apps/bff/src/clients/scheduling/index.ts']);
});

test('a backticked symbol is cited, and short noise is not', () => {
  const { symbols } = extractCitations('`store.materialize` usa `createMany` e `ok`');
  assert.ok(symbols.includes('store.materialize'));
  assert.ok(!symbols.includes('ok'), 'três caracteres é ruído, não citação');
});

test('a route keeps the part a diff would actually show', () => {
  assert.deepEqual(extractCitations('`GET /v1/settings/retention` está sob contexto').symbols, ['/v1/settings/retention']);
});

test('only backticked text counts', () => {
  // Reading unmarked prose would search the diff for ordinary words.
  const { paths, symbols } = extractCitations('a tela mudou em ProductSettingsScreen sem crase');
  assert.deepEqual([...paths, ...symbols], []);
});

// ===========================================================================
// The Goal023 round 2 shape — the case this exists for
// ===========================================================================

test('a token the blocker names and the round never touched is listed as absent', () => {
  const row = traceEvidence(
    { id: 'Blocker 3', text: '§7 incompleto: `RetentionState` não ganhou `updatedBy`' },
    { changedFiles: ['apps/bff/src/modules/retention/settings.ts'], diff: '+ retentionDaysOptions\n+ RetentionState' },
  );

  assert.equal(row.verdict, TRACE_VERDICTS.SOME_ABSENT);
  assert.deepEqual(row.absent, ['updatedBy'], 'exatamente o item que o revisor achou inacabado');
});

test('touching the blocker file is NOT enough to clear it', () => {
  // All six blockers of Goal023 round 2 had their files touched. Three were
  // unfinished anyway. File-level tracing was tried first and was useless.
  const row = traceEvidence(
    { id: 'Blocker 1', text: 'falta `updatedBy` em `apps/bff/x.ts`' },
    { changedFiles: ['apps/bff/x.ts'], diff: 'mudou outra coisa' },
  );

  assert.equal(row.verdict, TRACE_VERDICTS.SOME_ABSENT);
  assert.deepEqual(row.absent, ['updatedBy']);
});

test('a symbol anywhere in the diff counts as present, added or removed', () => {
  const row = traceEvidence(
    { id: 'B', text: 'falta `reopenResolvedConditions`' },
    { changedFiles: [], diff: '- export function reopenResolvedConditions()' },
  );

  assert.equal(row.verdict, TRACE_VERDICTS.ALL_PRESENT);
  assert.deepEqual(row.absent, []);
});

test('prose that names nothing is NO_CITATION, never reported as absent', () => {
  // The third unfinished item of Goal023 round 2 was described in prose. This
  // cannot catch it, and must not pretend otherwise by inventing a suspicion.
  const row = traceEvidence(
    { id: 'B', text: 'a nota da tela ainda promete o que o produto não faz' },
    { changedFiles: ['a.ts'], diff: 'x' },
  );

  assert.equal(row.verdict, TRACE_VERDICTS.NO_CITATION);
  assert.deepEqual(row.absent, []);
});

test('blockers become numbered items the way the review and the unit refer to them', () => {
  assert.deepEqual(blockersAsItems(['primeiro', 'segundo']).map((item) => item.id), ['Blocker 1', 'Blocker 2']);
  assert.deepEqual(blockersAsItems(null), []);
});

test('tracing never throws on malformed input', () => {
  assert.deepEqual(traceAll(null), []);
  assert.deepEqual(traceAll([null, {}, { text: '  ' }]), []);
  assert.doesNotThrow(() => traceEvidence({ id: 'x', text: 'a `b/c.ts`' }));
});

// ===========================================================================
// The Goal document, in the line endings it is actually stored with
// ===========================================================================

const GOAL_DOC_CRLF = [
  '# Goal 023 — Retenção',
  '',
  '## Objetivo e posição',
  '',
  'Prosa com `ruido.ts` que não deve virar item.',
  '',
  '## Escopo obrigatório',
  '',
  '### 1. O prazo é configuração do BFF',
  '',
  '### 6. Retenção técnica',
  '',
  '## Testes e critérios de aceite',
  '',
  '1. Existe `RetentionSettings` no BFF.',
  '2. Nenhuma copy promete exclusão.',
  '',
  '## Fora de escopo',
  '',
  '### 9. Isto não conta',
  '',
].join('\r\n');

test('the Goal document parses with CRLF, which is how this repository stores it', () => {
  // `\r` is a line TERMINATOR in JavaScript regex, so `.` never matches it and
  // `(.+)$` fails silently. An LF fixture passed while the real document
  // extracted zero of its sixty-four items.
  const found = extractGoalRequirements(GOAL_DOC_CRLF);

  assert.deepEqual(found.map((item) => item.id), ['§1', '§6', 'critério 1', 'critério 2']);
  assert.equal(found[0].kind, 'SCOPE');
  assert.equal(found[2].kind, 'CRITERION');
  assert.ok(!found.some((item) => /Isto não conta/.test(item.text)), 'seção fora dos dois cabeçalhos não é requisito');
});

test('LF parses identically, so the normalisation is not a CRLF-only special case', () => {
  assert.deepEqual(
    extractGoalRequirements(GOAL_DOC_CRLF.replace(/\r/g, '')).map((item) => item.id),
    ['§1', '§6', 'critério 1', 'critério 2'],
  );
});

test('an unparseable Goal document costs nothing', () => {
  assert.deepEqual(extractGoalRequirements(''), []);
  assert.deepEqual(extractGoalRequirements(null), []);
  assert.deepEqual(extractGoalRequirements('# Goal\n\nsem seções numeradas\n'), []);
});

// ===========================================================================
// The summary line
// ===========================================================================

test('the summary states the limit in the same breath as the fact', () => {
  const line = summarizeBlockerTrace([
    { verdict: TRACE_VERDICTS.ALL_PRESENT },
    { verdict: TRACE_VERDICTS.SOME_ABSENT },
  ]);

  assert.match(line, /NÃO aparece nesta rodada/);
  assert.match(line, /Ausência não prova blocker aberto/);
  assert.match(line, /alguns destes serão inofensivos/, 'o falso positivo é admitido onde o leitor o vê');
});

test('a round with no blockers says so rather than letting silence read as clean', () => {
  assert.match(summarizeBlockerTrace([]), /não corrige blockers/);
});

test('a round where everything cited is present says that plainly, with no warning tail', () => {
  const line = summarizeBlockerTrace([{ verdict: TRACE_VERDICTS.ALL_PRESENT }]);
  assert.match(line, /com tudo o que citam presente/);
  assert.ok(!/Ausência não prova/.test(line), 'sem cauda de alerta quando não há ausência');
});

test('a path:symbol citation is read as two citations, not one composite', () => {
  // `settings.ts:loadRetentionState` read whole is a token that exists in no
  // file and no diff — a false positive the tool would manufacture itself.
  const { paths, symbols } = extractCitations('`apps/bff/src/modules/retention/settings.ts:loadRetentionState` devolve');

  assert.deepEqual(paths, ['apps/bff/src/modules/retention/settings.ts']);
  assert.deepEqual(symbols, ['loadRetentionState']);
});

test('a path with a line range is still a path, not a path plus a symbol', () => {
  const { paths, symbols } = extractCitations('`apps/bff/x.ts:1480-1487` continua');
  assert.deepEqual(paths, ['apps/bff/x.ts']);
  assert.deepEqual(symbols, []);
});
