/**
 * Unit tests for LEGACY_MONOLITHIC run matching and the context-reduction
 * baseline. The central discipline under test: sequence and repository
 * membership are NEVER treated as equivalence — only an explicit claim
 * (a rerun, a replay, or a declared overlapping operation set) is.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RUN_MATCH, classifyRunMatch, legacyMonolithicBaseline, legacyContextBaseline,
} from '../lib/legacy-baseline.mjs';

// --- run match classification (obrigatory cases 17-19) ----------------------

test('17. an explicit replay pairing is MATCHED', () => {
  const current = { runId: 'run-2', replayOf: 'run-1' };
  const candidate = { runId: 'run-1' };
  assert.equal(classifyRunMatch(current, candidate), RUN_MATCH.MATCHED);
});

test('a rerun of the literal same Goal (different run id) is MATCHED', () => {
  const current = { goalId: '010', runId: 'run-2' };
  const candidate = { goalId: '010', runId: 'run-1' };
  assert.equal(classifyRunMatch(current, candidate), RUN_MATCH.MATCHED);
});

test('18. an overlapping-but-not-identical operation set is only PARTIALLY_MATCHED', () => {
  const current = { goalId: '010', operationSet: ['planning', 'implementation', 'review'] };
  const candidate = { goalId: '009', operationSet: ['planning', 'implementation'] };
  assert.equal(classifyRunMatch(current, candidate), RUN_MATCH.PARTIALLY_MATCHED);
});

test('19. two runs sharing nothing (different Goal, no overlap, no replay claim) are UNMATCHED', () => {
  const current = { goalId: '010', operationSet: ['work_unit'] };
  const candidate = { goalId: '003', operationSet: ['planning'] };
  assert.equal(classifyRunMatch(current, candidate), RUN_MATCH.UNMATCHED);
});

test('sequence alone — an earlier Goal in the same repo — is never enough for a match', () => {
  // Exactly the invalid reasoning the Goal calls out: "Goal 003 used 4M
  // tokens, Goal 010 used 2M tokens, therefore ia-loop saved 50%".
  const current = { goalId: '010' };
  const candidate = { goalId: '003' };
  assert.equal(classifyRunMatch(current, candidate), RUN_MATCH.UNMATCHED);
});

// --- LEGACY_MONOLITHIC baseline ------------------------------------------

test('LEGACY_MONOLITHIC is OK only when a MATCHED candidate is supplied', () => {
  const current = { goalId: '010', runId: 'run-2' };
  const candidates = [{ goalId: '010', runId: 'run-1', allModelTokens: 100, calculatedCostUsd: 1 }];
  const result = legacyMonolithicBaseline({ current, candidates });
  assert.equal(result.baseline, 'LEGACY_MONOLITHIC');
  assert.equal(result.classification, 'ESTIMATED');
  assert.equal(result.status, 'OK');
  assert.deepEqual(result.matchedRunIds, ['run-1']);
});

test('LEGACY_MONOLITHIC reports PARTIALLY_MATCHED with LOW confidence and a caveat, never a strong savings figure', () => {
  const current = { goalId: '010', operationSet: ['planning', 'review'] };
  const candidates = [{ goalId: '009', runId: 'run-9', operationSet: ['planning', 'review', 'implementation'] }];
  const result = legacyMonolithicBaseline({ current, candidates });
  assert.equal(result.status, 'PARTIALLY_MATCHED');
  assert.equal(result.confidence, 'LOW');
  assert.ok(result.note);
});

test('with no candidates at all, LEGACY_MONOLITHIC is INSUFFICIENT_DATA — the expected outcome for this repo today', () => {
  const result = legacyMonolithicBaseline({ current: { goalId: '010' }, candidates: [] });
  assert.equal(result.status, 'INSUFFICIENT_DATA');
  assert.equal(result.classification, 'ESTIMATED');
});

test('candidates that are all UNMATCHED still resolve to INSUFFICIENT_DATA, not a forced comparison', () => {
  const current = { goalId: '010' };
  const candidates = [{ goalId: '003' }, { goalId: '005' }];
  const result = legacyMonolithicBaseline({ current, candidates });
  assert.equal(result.status, 'INSUFFICIENT_DATA');
});

// --- context reduction (obrigatory cases 20-21) -----------------------------

test('20. context chars reduction is CALCULATED from two observed distributions', () => {
  const legacyContextChars = [80000, 90000, 100000, 110000];
  const currentContextChars = [25000, 27000, 29000, 31000];
  const result = legacyContextBaseline({ legacyContextChars, currentContextChars });
  assert.equal(result.classification, 'CALCULATED');
  assert.equal(result.status, 'OK');
  assert.ok(result.reductionPercent > 0);
  assert.equal(result.differenceChars, result.legacyMedianChars - result.currentMedianChars);
});

test('21. context chars reduction is NEVER reported as a token-savings figure', () => {
  const result = legacyContextBaseline({ legacyContextChars: [100000], currentContextChars: [30000] });
  assert.match(result.note, /never converted to a token/i);
  assert.equal('tokensAvoided' in result, false);
  assert.equal('costUsdAvoided' in result, false);
});

test('context baseline is INSUFFICIENT_DATA when either side has no observations', () => {
  assert.equal(legacyContextBaseline({ legacyContextChars: [], currentContextChars: [100] }).status, 'INSUFFICIENT_DATA');
  assert.equal(legacyContextBaseline({ legacyContextChars: [100], currentContextChars: [] }).status, 'INSUFFICIENT_DATA');
  assert.equal(legacyContextBaseline({}).status, 'INSUFFICIENT_DATA');
});
