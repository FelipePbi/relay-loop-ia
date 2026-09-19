/**
 * What earlier Work Units found out, carried to the next one.
 *
 * Across Goals 014-016 orientation held at ~60% of every agent action and did
 * not move. Each unit is a cold process, so it re-derives where things live —
 * and the sibling that just mapped the same module is no help unless the plan
 * happened to declare it a dependency.
 *
 * These tests pin the two properties that keep this from becoming the shared
 * session the architecture rejects: it carries FACTS (paths, and who touched
 * them) rather than prose or reasoning, and it is BOUNDED.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_ENTRIES,
  TOUCH,
  createFindingsLedger,
} from '../lib/findings-ledger.mjs';

const read = (ledger, unit, file) => ledger.observe(unit, { category: 'READ', detail: file });
const edit = (ledger, unit, file) => ledger.observe(unit, { category: 'EDIT', detail: file });

// --- what it collects ----------------------------------------------------

test('a file another unit merely READ is carried, which nothing did before', () => {
  const ledger = createFindingsLedger();
  read(ledger, 'WU-01', 'apps/bff/src/modules/status/routes.ts');

  assert.deepEqual(ledger.forPacket(), [
    { file: 'apps/bff/src/modules/status/routes.ts', touch: TOUCH.READ, by: ['WU-01'] },
  ]);
});

test('CHANGED outranks READ however the two arrive', () => {
  const a = createFindingsLedger();
  read(a, 'WU-01', 'src/app.ts');
  a.completeUnit('WU-02', { changedFiles: ['src/app.ts'] });

  const b = createFindingsLedger();
  b.completeUnit('WU-02', { changedFiles: ['src/app.ts'] });
  read(b, 'WU-01', 'src/app.ts');

  for (const ledger of [a, b]) {
    const [entry] = ledger.forPacket();
    assert.equal(entry.touch, TOUCH.CHANGED, 'a file this Goal edited never degrades back to READ');
    assert.deepEqual(entry.by, ['WU-01', 'WU-02']);
  }
});

test('one row per file, not one per observation', () => {
  const ledger = createFindingsLedger();
  for (let i = 0; i < 20; i += 1) read(ledger, 'WU-01', 'src/app.ts');
  assert.equal(ledger.size(), 1);
});

test('non-file events and junk are ignored without throwing', () => {
  const ledger = createFindingsLedger();
  for (const event of [
    null, undefined, {}, { category: 'BASH', detail: 'npm run lint' },
    { category: 'READ' }, { category: 'READ', detail: '' },
    { category: 'READ', detail: 'no-separator.ts' },
    { category: 'READ', detail: 'src/no-extension' },
    { category: 'READ', detail: 42 },
  ]) {
    assert.doesNotThrow(() => ledger.observe('WU-01', event));
  }
  assert.equal(ledger.size(), 0, 'only things that look like real paths become entries');
});

test('paths are normalised so Windows and git spellings are one entry', () => {
  const ledger = createFindingsLedger();
  read(ledger, 'WU-01', 'apps\\bff\\src\\app.ts');
  edit(ledger, 'WU-02', './apps/bff/src/app.ts');
  assert.equal(ledger.size(), 1);
  assert.equal(ledger.forPacket()[0].file, 'apps/bff/src/app.ts');
});

// --- what it refuses to carry -------------------------------------------

test('it carries no prose: an entry is a path, a touch and unit ids, nothing else', () => {
  const ledger = createFindingsLedger();
  edit(ledger, 'WU-01', 'src/app.ts');
  assert.deepEqual(Object.keys(ledger.forPacket()[0]).sort(), ['by', 'file', 'touch']);
});

// --- the bound -----------------------------------------------------------

test('changed files come first, because an edited file is the strongest pointer', () => {
  const ledger = createFindingsLedger();
  read(ledger, 'WU-01', 'src/aaa-read.ts');
  ledger.completeUnit('WU-02', { changedFiles: ['src/zzz-changed.ts'] });

  const [first] = ledger.forPacket();
  assert.equal(first.file, 'src/zzz-changed.ts', 'ordering is by value, not alphabetical');
});

test('the entry count is capped, and the cap bites the weaker end', () => {
  const ledger = createFindingsLedger();
  for (let i = 0; i < 100; i += 1) read(ledger, 'WU-01', `src/read${i}.ts`);
  ledger.completeUnit('WU-02', { changedFiles: ['src/changed.ts'] });

  const packet = ledger.forPacket();
  assert.equal(packet.length, MAX_ENTRIES);
  assert.equal(packet[0].file, 'src/changed.ts', 'the changed file survives the cap');
});

test('the character budget is honoured even when the entry count is not reached', () => {
  const ledger = createFindingsLedger();
  for (let i = 0; i < 40; i += 1) read(ledger, 'WU-01', `src/${'deep/'.repeat(20)}file${i}.ts`);

  const packet = ledger.forPacket({ maxChars: 500 });
  assert.ok(packet.length < MAX_ENTRIES, 'long paths exhaust the budget before the count');
  assert.ok(JSON.stringify(packet).length <= 600, 'and the rendered size stays near the budget');
});

// --- not repeating what the packet already says -------------------------

test('files the packet already lists are excluded, so the budget buys new information', () => {
  const ledger = createFindingsLedger();
  read(ledger, 'WU-01', 'src/already-known.ts');
  read(ledger, 'WU-01', 'src/new.ts');

  const packet = ledger.forPacket({ exclude: ['src/already-known.ts'] });
  assert.deepEqual(packet.map((e) => e.file), ['src/new.ts']);
});

test('exclusion normalises too, so a Windows spelling still matches', () => {
  const ledger = createFindingsLedger();
  read(ledger, 'WU-01', 'apps/bff/src/app.ts');
  assert.deepEqual(ledger.forPacket({ exclude: ['apps\\bff\\src\\app.ts'] }), []);
});

test('an empty ledger is an empty list, never null', () => {
  assert.deepEqual(createFindingsLedger().forPacket(), []);
});
