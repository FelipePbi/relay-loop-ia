/**
 * Tests for the SQLite usage ledger itself.
 *
 * The guarantees under test are the ones that decide whether the ledger can be
 * trusted later: the database creates and migrates itself, the same execution
 * can never be counted twice, a finished row is never rewritten, and a write
 * that fails does so as a status rather than as an exception.
 *
 * Every database here lives in a temp directory. Nothing touches `.state`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LEDGER_STATUS, openUsageLedger } from '../lib/usage-ledger.mjs';
import { COLLECTOR_VERSION, SCHEMA_VERSION, buildUsageRecord } from '../lib/usage-normalizer.mjs';
import { OPUS, successResult } from './fixtures/cli-envelopes.mjs';

/**
 * A temp directory plus every ledger opened in it.
 *
 * The handles are closed BEFORE the directory is removed: on Windows an open
 * SQLite file cannot be deleted, so a cleanup that ran the other way round
 * failed every test that had a live database.
 */
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ia-loop-ledger-'));
  const handles = [];
  t.after(() => {
    for (const handle of handles) handle.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return {
    dir,
    path: (...segments) => join(dir, ...(segments.length > 0 ? segments : ['usage.sqlite'])),
    open(...segments) {
      const ledger = openUsageLedger({ path: this.path(...segments) });
      handles.push(ledger);
      return ledger;
    },
  };
}

function rowFor({ status = 'STARTED', envelope = null, invocationId = null, ...context } = {}) {
  const record = buildUsageRecord({
    context: {
      goalId: '008', roundId: 1, jobId: 'job-1', attemptId: 'job-1#a1', attempt: 1,
      role: 'developer', stage: 'implementation', ...context,
    },
    capture: {
      invocationId,
      requestedModel: OPUS, sessionId: 'session-1', startedAt: '2026-09-09T10:00:00.000Z',
      envelope, structuredOutput: envelope !== null,
      resolvedPrimaryModel: envelope ? OPUS : null,
      counters: { assistantMessages: envelope ? 2 : 0, toolCallCount: 0 },
    },
  });
  record.status = status;
  return record;
}

test('the database, its schema and its version are created on first open', (t) => {
  const dir = scratch(t);
  const path = dir.path('nested', 'usage.sqlite');
  const ledger = dir.open('nested', 'usage.sqlite');

  assert.equal(ledger.status, LEDGER_STATUS.OK);
  assert.ok(existsSync(path), 'the directory is created too');
  assert.equal(ledger.schemaVersion(), SCHEMA_VERSION);

  const meta = ledger.query('SELECT key, value FROM meta ORDER BY key');
  const asMap = Object.fromEntries(meta.map((row) => [row.key, row.value]));
  assert.equal(asMap.collector_version, COLLECTOR_VERSION);
});

test('the tables, indexes and unique constraints the ledger depends on exist', (t) => {
  const ledger = scratch(t).open();

  const tables = ledger.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map((row) => row.name);
  for (const table of ['meta', 'model_usage', 'model_usage_correction', 'model_usage_event',
    'model_usage_integrity', 'model_usage_tool_call']) {
    assert.ok(tables.includes(table), `missing table ${table}`);
  }

  const indexes = ledger.query("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
    .map((row) => row.name);
  for (const index of ['idx_model_usage_goal', 'idx_model_usage_job', 'idx_model_usage_attempt',
    'idx_model_usage_model', 'idx_model_usage_run', 'idx_model_usage_status']) {
    assert.ok(indexes.includes(index), `missing index ${index}`);
  }
});

test('migration is idempotent: reopening an existing database changes nothing', (t) => {
  const dir = scratch(t);

  const first = dir.open();
  first.begin({ idempotencyKey: 'k1', record: rowFor() });
  first.close();

  const second = dir.open();
  assert.equal(second.status, LEDGER_STATUS.OK);
  assert.equal(second.schemaVersion(), SCHEMA_VERSION);
  assert.equal(second.query('SELECT COUNT(*) AS n FROM model_usage')[0].n, 1, 'the row survived');
});

test('a v1 database (no invocation_id) migrates to v2 in place, keeping its row', (t) => {
  const dir = scratch(t);

  const v1 = dir.open();
  const { id } = v1.begin({ idempotencyKey: 'legacy-key-1', record: rowFor() });
  // Roll the database back to what a real v1 database looked like: no
  // invocation_id column, and the meta row saying so.
  v1.query('ALTER TABLE model_usage DROP COLUMN invocation_id');
  v1.query('UPDATE meta SET value = ? WHERE key = ?', ['1', 'schema_version']);
  v1.close();

  const migrated = dir.open();
  assert.equal(migrated.status, LEDGER_STATUS.OK);
  assert.equal(migrated.schemaVersion(), SCHEMA_VERSION);
  const row = migrated.get(id);
  assert.equal(row.idempotency_key, 'legacy-key-1', 'the pre-existing row survives the migration');
  assert.equal(row.invocation_id, null, 'a row that predates the concept has no invocation id to report');

  // The column is real and usable for new rows, not just present.
  const after = migrated.begin({
    idempotencyKey: 'new-invocation-id',
    record: rowFor({ invocationId: 'new-invocation-id' }),
  });
  assert.equal(after.status, LEDGER_STATUS.OK);
  assert.equal(migrated.get(after.id).invocation_id, 'new-invocation-id');
});

test('reopening an already-migrated v2 database does not re-run the migration', (t) => {
  const dir = scratch(t);
  const first = dir.open();
  first.begin({ idempotencyKey: 'k1', record: rowFor() });
  first.close();

  // Opening it again must not attempt `ALTER TABLE ... ADD COLUMN` on a
  // column that already exists — that would throw, not silently succeed.
  const second = dir.open();
  assert.equal(second.status, LEDGER_STATUS.OK);
  assert.equal(second.schemaVersion(), SCHEMA_VERSION);
});

test('a database written by a newer collector is refused, not silently downgraded', (t) => {
  const dir = scratch(t);
  const first = dir.open();
  first.query('UPDATE meta SET value = ? WHERE key = ?', [String(SCHEMA_VERSION + 1), 'schema_version']);
  first.close();

  const second = dir.open();
  assert.equal(second.status, LEDGER_STATUS.UNAVAILABLE);
  assert.match(second.error, /newer than this collector/);
});

test('WAL mode and a busy timeout are configured, so two workers can write concurrently', (t) => {
  const ledger = scratch(t).open();
  assert.equal(String(ledger.query('PRAGMA journal_mode')[0].journal_mode).toLowerCase(), 'wal');
  assert.ok(ledger.query('PRAGMA busy_timeout')[0].timeout >= 1000);
});

test('a second ledger handle on the same file can write while the first is open', (t) => {
  const dir = scratch(t);
  const developer = dir.open();
  const techLead = dir.open();

  assert.equal(developer.begin({ idempotencyKey: 'dev', record: rowFor({ role: 'developer' }) }).status, LEDGER_STATUS.OK);
  assert.equal(techLead.begin({ idempotencyKey: 'lead', record: rowFor({ role: 'tech_lead', jobId: 'job-2' }) }).status, LEDGER_STATUS.OK);
  assert.equal(developer.query('SELECT COUNT(*) AS n FROM model_usage')[0].n, 2);
});

// --- idempotency -----------------------------------------------------------

test('the same execution recorded twice produces one row and reports ALREADY_RECORDED', (t) => {
  const ledger = scratch(t).open();

  const first = ledger.begin({ idempotencyKey: 'developer::job-1::job-1#a1', record: rowFor() });
  assert.equal(first.status, LEDGER_STATUS.OK);
  assert.equal(ledger.query('SELECT COUNT(*) AS n FROM model_usage')[0].n, 1);

  const second = ledger.begin({ idempotencyKey: 'developer::job-1::job-1#a1', record: rowFor() });
  assert.equal(second.status, LEDGER_STATUS.ALREADY_RECORDED);
  assert.equal(second.id, first.id, 'the caller is pointed at the row that already exists');
  assert.equal(ledger.query('SELECT COUNT(*) AS n FROM model_usage')[0].n, 1, 'no duplicate row');

  const flags = ledger.query('SELECT flag FROM model_usage_integrity');
  assert.deepEqual(flags.map((row) => row.flag), ['DUPLICATE_EXECUTION_KEY'],
    'the duplicate attempt is visible rather than silently dropped');
});

// --- lifecycle and immutability -------------------------------------------

test('finalising a STARTED row writes the usage, the tools and the event trail atomically', (t) => {
  const ledger = scratch(t).open();

  const { id } = ledger.begin({ idempotencyKey: 'k', record: rowFor() });
  const outcome = ledger.finalize({
    id,
    idempotencyKey: 'k',
    record: rowFor({ status: 'COMPLETED', envelope: successResult() }),
    toolCalls: [{ tool: 'Read', calls: 4, errors: 1 }],
    events: [{ index: 0, type: 'tool_use', at: '2026-09-09T10:00:01.000Z', metadata: { tool: 'Read' } }],
  });

  assert.equal(outcome.status, LEDGER_STATUS.OK);
  const row = ledger.get(id);
  assert.equal(row.status, 'COMPLETED');
  assert.equal(row.num_turns, 7);
  assert.equal(row.goal_id, '008', 'identity written when the row opened is untouched');
  assert.equal(ledger.query('SELECT calls, errors FROM model_usage_tool_call')[0].calls, 4);
  assert.equal(ledger.query('SELECT event_type FROM model_usage_event')[0].event_type, 'tool_use');
});

test('a finished row is never rewritten; a later reading becomes a correction beside it', (t) => {
  const ledger = scratch(t).open();

  const { id } = ledger.begin({ idempotencyKey: 'k', record: rowFor() });
  ledger.finalize({ id, idempotencyKey: 'k', record: rowFor({ status: 'COMPLETED', envelope: successResult() }) });

  const again = ledger.finalize({
    id,
    idempotencyKey: 'k',
    record: rowFor({ status: 'FAILED', envelope: successResult({ numTurns: 999 }) }),
  });

  assert.equal(again.status, LEDGER_STATUS.ALREADY_FINALIZED);
  const row = ledger.get(id);
  assert.equal(row.status, 'COMPLETED', 'history is preserved');
  assert.equal(row.num_turns, 7, 'and so are its figures');

  const corrections = ledger.query('SELECT kind FROM model_usage_correction');
  assert.deepEqual(corrections.map((c) => c.kind), ['FINALIZE_AFTER_TERMINAL']);
});

test('a crash leaves a STARTED row naming the Goal, the attempt and the model', (t) => {
  const dir = scratch(t);
  const before = dir.open();
  before.begin({ idempotencyKey: 'developer::job-1::job-1#a1', record: rowFor() });
  before.close(); // the process dies here, mid-inference

  const after = dir.open();
  const orphans = after.query("SELECT goal_id, attempt_id, requested_model, status FROM model_usage WHERE status = 'STARTED'");
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].goal_id, '008');
  assert.equal(orphans[0].attempt_id, 'job-1#a1');
  assert.equal(orphans[0].requested_model, OPUS);
});

test('integrity flags on a finalised record are persisted for later inspection', (t) => {
  const ledger = scratch(t).open();

  const { id } = ledger.begin({ idempotencyKey: 'k', record: rowFor() });
  const record = rowFor({ status: 'COMPLETED', envelope: successResult() });
  record.integrityFlags = ['THINKING_EXCEEDS_OUTPUT'];
  ledger.finalize({ id, idempotencyKey: 'k', record });

  assert.deepEqual(
    ledger.query('SELECT flag FROM model_usage_integrity').map((row) => row.flag),
    ['THINKING_EXCEEDS_OUTPUT'],
  );
});

// --- failure policy --------------------------------------------------------

test('an unusable ledger reports UNAVAILABLE and still answers every call', () => {
  const ledger = openUsageLedger({ path: null });
  assert.equal(ledger.status, LEDGER_STATUS.UNAVAILABLE);
  assert.equal(ledger.begin({ idempotencyKey: 'k', record: rowFor() }).status, LEDGER_STATUS.UNAVAILABLE);
  assert.equal(ledger.finalize({ id: null, record: rowFor() }).status, LEDGER_STATUS.UNAVAILABLE);
  assert.equal(ledger.get('x'), null);
  ledger.close();
});

test('a write failure is returned as a status, never thrown at the caller', (t) => {
  const ledger = scratch(t).open();

  // A row shaped so the insert cannot succeed: no key at all.
  const outcome = ledger.begin({ idempotencyKey: null, record: rowFor() });
  assert.equal(outcome.status, LEDGER_STATUS.WRITE_FAILED);
  assert.ok(outcome.error);
});
