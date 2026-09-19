/**
 * IA Loop — the durable usage ledger.
 *
 * One SQLite database, opened lazily, holding one row per real model execution.
 * SQLite rather than a directory of JSON files because the questions this
 * ledger exists to answer later ("what did Goal 008 cost", "which model, which
 * stage, which retries") are joins and aggregates, and because a UNIQUE
 * constraint is a far better idempotency guarantee than a filename convention.
 *
 * Three properties the schema enforces rather than hopes for:
 *
 *   idempotent   `idempotency_key` is UNIQUE. Re-processing the same execution
 *                inserts nothing and reports ALREADY_RECORDED.
 *
 *   append-first A row is written STARTED before the CLI is spawned and
 *                finalised afterwards, so a crash leaves evidence instead of
 *                silence. Finalisation only ever moves STARTED -> terminal;
 *                anything that would rewrite a finished row becomes a
 *                correction record beside it, never an overwrite.
 *
 *   atomic       Finalisation writes the usage figures, the per-tool breakdown
 *                and the event trail inside ONE transaction, so a row can never
 *                hold tokens whose model or job is missing.
 *
 * Failure policy: this module never throws at its callers. Every entry point
 * returns a status object. Observability breaking must not break a Goal.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { COLLECTOR_VERSION, SCHEMA_VERSION } from './usage-normalizer.mjs';

/**
 * `node:sqlite` is core from Node 22.5 and stable in 24. It is imported
 * defensively anyway: an older runtime must degrade to "no ledger", not to a
 * crashed worker.
 */
let sqliteModule = null;
let sqliteError = null;
try {
  sqliteModule = await import('node:sqlite');
} catch (error) {
  sqliteError = error?.message ?? String(error);
}

export const LEDGER_STATUS = Object.freeze({
  OK: 'OK',
  UNAVAILABLE: 'UNAVAILABLE',
  WRITE_FAILED: 'TELEMETRY_WRITE_FAILED',
  ALREADY_RECORDED: 'ALREADY_RECORDED',
  ALREADY_FINALIZED: 'ALREADY_FINALIZED',
});

/**
 * Columns of `model_usage`, in one place.
 *
 * `key` is the field on the normalized record; `identity` marks the columns
 * written when the row is opened, which finalisation must not contradict.
 */
const COLUMNS = Object.freeze([
  // identity
  // The row's own identity — one real model call, never reused across two
  // genuinely different ones. See usage-collector.mjs's generateInvocationId.
  ['invocation_id', 'invocationId', true],
  ['project_id', 'projectId', true],
  ['run_id', 'runId', true],
  ['goal_id', 'goalId', true],
  ['round_id', 'roundId', true],
  ['stage_id', 'stageId', true],
  ['job_id', 'jobId', true],
  ['attempt_id', 'attemptId', true],
  ['attempt', 'attempt', true],
  ['work_unit_id', 'workUnitId', true],
  ['role', 'role', true],
  ['operation', 'operation', true],
  ['stage', 'stage', true],
  ['phase', 'phase', true],

  // model
  ['provider', 'provider'],
  ['model_key', 'modelKey', true],
  ['model_family', 'modelFamily', true],
  ['requested_model', 'requestedModel', true],
  ['resolved_model', 'resolvedModel'],
  ['canonical_model', 'canonicalModel'],
  ['effort', 'effort', true],
  ['observed_models_json', 'observedModelsJson'],
  ['auxiliary_models_json', 'auxiliaryModelsJson'],

  // routing
  ['complexity', 'complexity', true],
  ['risk_score', 'riskScore', true],
  ['routing_reason', 'routingReason', true],
  ['routing_signals_json', 'routingSignalsJson', true],
  ['routing_mode', 'routingMode', true],
  ['is_fallback', 'isFallback', true],
  ['fallback_from_model', 'fallbackFromModel', true],
  ['fallback_reason', 'fallbackReason', true],
  ['is_escalation', 'isEscalation', true],
  ['escalation_from_model', 'escalationFromModel', true],
  ['escalation_reason', 'escalationReason', true],
  ['manual_override', 'manualOverride', true],

  // lifecycle / result
  ['status', 'status'],
  ['model_call_started', 'modelCallStarted'],
  ['result_type', 'resultType'],
  ['stop_reason', 'stopReason'],
  ['exit_code', 'exitCode'],
  ['timed_out', 'timedOut'],
  ['is_error', 'isError'],
  ['api_error_status', 'apiErrorStatus'],
  ['terminal_reason', 'terminalReason'],
  ['failure_code', 'failureCode'],
  ['failure_reason', 'failureReason'],
  ['failure_family', 'failureFamily'],
  ['failure_diagnostic', 'failureDiagnostic'],
  ['structured_output', 'structuredOutput'],
  ['has_candidate_payload', 'hasCandidatePayload'],
  ['outcome', 'outcome'],

  // tokens
  ['usage_source', 'usageSource'],
  ['input_tokens', 'inputTokens'],
  ['output_tokens', 'outputTokens'],
  ['thinking_tokens', 'thinkingTokens'],
  ['cache_read_tokens', 'cacheReadTokens'],
  ['cache_creation_tokens', 'cacheCreationTokens'],
  ['cache_creation_ephemeral_5m', 'cacheCreationEphemeral5m'],
  ['cache_creation_ephemeral_1h', 'cacheCreationEphemeral1h'],
  ['uncached_input_tokens', 'uncachedInputTokens'],
  ['web_search_requests', 'webSearchRequests'],
  ['context_window', 'contextWindow'],
  ['max_output_tokens', 'maxOutputTokens'],
  ['total_tokens', 'totalTokens'],

  // turns / tools
  ['num_turns', 'numTurns'],
  ['assistant_messages', 'assistantMessages'],
  ['user_messages', 'userMessages'],
  ['stream_events', 'streamEvents'],
  ['tool_call_count', 'toolCallCount'],
  ['tool_result_events', 'toolResultEvents'],
  ['tool_error_events', 'toolErrorEvents'],
  ['permission_denials', 'permissionDenials'],
  ['queued_turn_count', 'queuedTurnCount'],

  // timing
  ['started_at', 'startedAt', true],
  ['finished_at', 'finishedAt'],
  ['duration_ms', 'durationMs'],
  ['cli_duration_ms', 'cliDurationMs'],
  ['duration_api_ms', 'durationApiMs'],
  ['ttft_ms', 'ttftMs'],

  // session
  ['session_id', 'sessionId', true],
  ['resume_session_id', 'resumeSessionId', true],
  ['envelope_session_id', 'envelopeSessionId'],
  ['result_uuid', 'resultUuid'],

  // cost
  ['provider_reported_cost_usd', 'providerReportedCostUsd'],
  ['primary_model_cost_usd', 'primaryModelCostUsd'],
  ['cost_basis', 'costBasis'],

  // raw
  ['raw_result_json', 'rawResultJson'],
  ['raw_usage_json', 'rawUsageJson'],
  ['raw_model_usage_json', 'rawModelUsageJson'],
  ['auxiliary_usage_json', 'auxiliaryUsageJson'],
  ['tool_calls_json', 'toolCallsJson'],
  ['stream_types_json', 'streamTypesJson'],

  // integrity
  ['integrity_flags_json', 'integrityFlagsJson'],
]);

const SQL_TYPE = Object.freeze({
  round_id: 'INTEGER', attempt: 'INTEGER', risk_score: 'INTEGER',
  is_fallback: 'INTEGER', is_escalation: 'INTEGER', model_call_started: 'INTEGER',
  timed_out: 'INTEGER', is_error: 'INTEGER', exit_code: 'INTEGER',
  api_error_status: 'INTEGER', structured_output: 'INTEGER', has_candidate_payload: 'INTEGER',
  input_tokens: 'INTEGER', output_tokens: 'INTEGER', thinking_tokens: 'INTEGER',
  cache_read_tokens: 'INTEGER', cache_creation_tokens: 'INTEGER',
  cache_creation_ephemeral_5m: 'INTEGER', cache_creation_ephemeral_1h: 'INTEGER',
  uncached_input_tokens: 'INTEGER', web_search_requests: 'INTEGER',
  context_window: 'INTEGER', max_output_tokens: 'INTEGER', total_tokens: 'INTEGER',
  num_turns: 'INTEGER', assistant_messages: 'INTEGER', user_messages: 'INTEGER',
  stream_events: 'INTEGER', tool_call_count: 'INTEGER', tool_result_events: 'INTEGER',
  tool_error_events: 'INTEGER', permission_denials: 'INTEGER', queued_turn_count: 'INTEGER',
  duration_ms: 'INTEGER', cli_duration_ms: 'INTEGER', duration_api_ms: 'INTEGER', ttft_ms: 'INTEGER',
  provider_reported_cost_usd: 'REAL', primary_model_cost_usd: 'REAL',
});

const IDENTITY_COLUMNS = COLUMNS.filter(([, , identity]) => identity === true).map(([column]) => column);

function columnDefinitions() {
  return COLUMNS.map(([column]) => `  ${column} ${SQL_TYPE[column] ?? 'TEXT'}`).join(',\n');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_usage (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL,
  collector_version TEXT NOT NULL,
${columnDefinitions()},
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_model_usage_goal ON model_usage (goal_id, round_id);
CREATE INDEX IF NOT EXISTS idx_model_usage_run ON model_usage (run_id);
CREATE INDEX IF NOT EXISTS idx_model_usage_job ON model_usage (job_id);
CREATE INDEX IF NOT EXISTS idx_model_usage_attempt ON model_usage (attempt_id);
CREATE INDEX IF NOT EXISTS idx_model_usage_model ON model_usage (resolved_model);
CREATE INDEX IF NOT EXISTS idx_model_usage_status ON model_usage (status);
CREATE INDEX IF NOT EXISTS idx_model_usage_started ON model_usage (started_at);

CREATE TABLE IF NOT EXISTS model_usage_tool_call (
  usage_id TEXT NOT NULL REFERENCES model_usage(id),
  tool TEXT NOT NULL,
  calls INTEGER NOT NULL,
  errors INTEGER NOT NULL,
  PRIMARY KEY (usage_id, tool)
);

CREATE TABLE IF NOT EXISTS model_usage_event (
  id TEXT PRIMARY KEY,
  usage_id TEXT NOT NULL REFERENCES model_usage(id),
  event_index INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  at TEXT,
  metadata_json TEXT,
  UNIQUE (usage_id, event_index, event_type)
);

CREATE INDEX IF NOT EXISTS idx_model_usage_event_usage ON model_usage_event (usage_id);

CREATE TABLE IF NOT EXISTS model_usage_correction (
  id TEXT PRIMARY KEY,
  usage_id TEXT REFERENCES model_usage(id),
  idempotency_key TEXT,
  kind TEXT NOT NULL,
  detail_json TEXT,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_usage_integrity (
  id TEXT PRIMARY KEY,
  usage_id TEXT,
  idempotency_key TEXT,
  flag TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL
);
`;

function bindable(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** JSON columns are produced here so the record itself stays plain data. */
function toRow(record) {
  return {
    ...record,
    observedModelsJson: record.observedModels?.length ? JSON.stringify(record.observedModels) : null,
    auxiliaryModelsJson: record.auxiliaryModels?.length ? JSON.stringify(record.auxiliaryModels) : null,
    routingSignalsJson: record.routingSignals?.length ? JSON.stringify(record.routingSignals) : null,
    integrityFlagsJson: record.integrityFlags?.length ? JSON.stringify(record.integrityFlags) : null,
  };
}

/**
 * Opens (and migrates) the ledger.
 *
 * Returns a handle whose `status` says whether it works. Callers never have to
 * branch on an exception.
 */
export function openUsageLedger({ path, now = () => new Date().toISOString() } = {}) {
  if (!path) return unavailable('NO_PATH');
  if (!sqliteModule) return unavailable(`node:sqlite unavailable: ${sqliteError}`);

  let db;
  try {
    mkdirSync(dirname(path), { recursive: true });
    db = new sqliteModule.DatabaseSync(path);
    // WAL so a Developer worker writing a row cannot block a Tech Lead worker
    // reading one, and a busy timeout so a brief overlap waits instead of
    // failing. No global lock: telemetry must never serialise the harness.
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(SCHEMA);
    migrate(db, now);
  } catch (error) {
    // The handle may already be open — a schema or migration failure happens
    // after the connection exists. Leaving it open would hold the file for the
    // life of the process, which on Windows means nobody can even delete it.
    try {
      db?.close();
    } catch {
      // Nothing further to do; the ledger is already being reported unusable.
    }
    return unavailable(error?.message ?? String(error));
  }

  const insertColumns = ['id', 'idempotency_key', 'schema_version', 'collector_version',
    ...COLUMNS.map(([column]) => column), 'created_at', 'updated_at'];
  const insertSql = `INSERT INTO model_usage (${insertColumns.join(', ')}) `
    + `VALUES (${insertColumns.map(() => '?').join(', ')})`;

  // Identity columns are excluded on purpose: what a call WAS is settled when
  // the row opens, and finalisation only reports what it produced.
  const finalizeBindings = COLUMNS.filter(([column]) => !IDENTITY_COLUMNS.includes(column));
  const finalizeSql = `UPDATE model_usage SET ${finalizeBindings.map(([c]) => `${c} = ?`).join(', ')}, `
    + 'updated_at = ? WHERE id = ? AND status = \'STARTED\'';

  const statements = {
    insert: db.prepare(insertSql),
    finalize: db.prepare(finalizeSql),
    byKey: db.prepare('SELECT id, status FROM model_usage WHERE idempotency_key = ?'),
    byId: db.prepare('SELECT * FROM model_usage WHERE id = ?'),
    tool: db.prepare('INSERT OR REPLACE INTO model_usage_tool_call (usage_id, tool, calls, errors) VALUES (?, ?, ?, ?)'),
    event: db.prepare('INSERT OR IGNORE INTO model_usage_event (id, usage_id, event_index, event_type, at, metadata_json) VALUES (?, ?, ?, ?, ?, ?)'),
    correction: db.prepare('INSERT INTO model_usage_correction (id, usage_id, idempotency_key, kind, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)'),
    integrity: db.prepare('INSERT INTO model_usage_integrity (id, usage_id, idempotency_key, flag, detail, at) VALUES (?, ?, ?, ?, ?, ?)'),
  };

  function insertIntegrity(usageId, key, flag, detail) {
    statements.integrity.run(randomUUID(), usageId, key, flag, detail ?? null, now());
  }

  return {
    status: LEDGER_STATUS.OK,
    path,
    error: null,

    schemaVersion() {
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
      return row ? Number(row.value) : null;
    },

    /**
     * Opens a row for an execution about to run.
     *
     * The UNIQUE key does the deduplication, so two processes racing on the
     * same attempt cannot both create a row and neither has to check first.
     */
    begin({ idempotencyKey, record }) {
      try {
        const row = toRow(record);
        const at = now();
        const id = randomUUID();
        const values = [
          id, idempotencyKey, SCHEMA_VERSION, COLLECTOR_VERSION,
          ...COLUMNS.map(([, key]) => bindable(row[key])),
          at, at,
        ];
        statements.insert.run(...values);
        return { status: LEDGER_STATUS.OK, id };
      } catch (error) {
        const existing = safeGet(statements.byKey, idempotencyKey);
        if (existing) {
          insertIntegrity(existing.id, idempotencyKey, 'DUPLICATE_EXECUTION_KEY', error?.message ?? null);
          return { status: LEDGER_STATUS.ALREADY_RECORDED, id: existing.id };
        }
        return { status: LEDGER_STATUS.WRITE_FAILED, id: null, error: error?.message ?? String(error) };
      }
    },

    /**
     * Closes a row with the figures the execution produced.
     *
     * Usage, per-tool counts and the event trail land in ONE transaction: a
     * crash mid-write leaves the row STARTED, never half-finalised.
     */
    finalize({ id, idempotencyKey = null, record, toolCalls = [], events = [] }) {
      try {
        const row = toRow(record);
        let applied = 0;
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = statements.finalize.run(
            ...finalizeBindings.map(([, key]) => bindable(row[key])),
            now(),
            id,
          );
          applied = result.changes ?? 0;

          if (applied > 0) {
            for (const call of toolCalls) {
              statements.tool.run(id, String(call.tool), Number(call.calls) || 0, Number(call.errors) || 0);
            }
            for (const event of events) {
              statements.event.run(
                randomUUID(), id, Number(event.index) || 0, String(event.type ?? 'unknown'),
                event.at ?? null, event.metadata ? JSON.stringify(event.metadata) : null,
              );
            }
            for (const flag of record.integrityFlags ?? []) {
              insertIntegrity(id, idempotencyKey, flag, null);
            }
          }
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }

        if (applied === 0) {
          // The row is already terminal. History is never rewritten: the newer
          // reading is kept beside it as a correction record.
          statements.correction.run(
            randomUUID(), id, idempotencyKey, 'FINALIZE_AFTER_TERMINAL',
            JSON.stringify({ status: record.status, totalTokens: record.totalTokens ?? null }), now(),
          );
          return { status: LEDGER_STATUS.ALREADY_FINALIZED, id };
        }
        return { status: LEDGER_STATUS.OK, id };
      } catch (error) {
        return { status: LEDGER_STATUS.WRITE_FAILED, id, error: error?.message ?? String(error) };
      }
    },

    /** An append-only note about a row that already exists. Never an overwrite. */
    recordCorrection({ usageId = null, idempotencyKey = null, kind, detail = null }) {
      try {
        statements.correction.run(
          randomUUID(), usageId, idempotencyKey, String(kind),
          detail === null ? null : JSON.stringify(detail), now(),
        );
        return { status: LEDGER_STATUS.OK };
      } catch (error) {
        return { status: LEDGER_STATUS.WRITE_FAILED, error: error?.message ?? String(error) };
      }
    },

    recordIntegrity({ usageId = null, idempotencyKey = null, flag, detail = null }) {
      try {
        insertIntegrity(usageId, idempotencyKey, String(flag), detail);
        return { status: LEDGER_STATUS.OK };
      } catch (error) {
        return { status: LEDGER_STATUS.WRITE_FAILED, error: error?.message ?? String(error) };
      }
    },

    /** Read-only helpers. Debugging and validation only; no presentation here. */
    get(id) {
      return safeGet(statements.byId, id);
    },

    findByKey(key) {
      return safeGet(statements.byKey, key);
    },

    query(sql, params = []) {
      try {
        return db.prepare(sql).all(...params.map(bindable));
      } catch (error) {
        return { error: error?.message ?? String(error) };
      }
    },

    close() {
      try {
        db.close();
      } catch {
        // A ledger that cannot close is not a reason to fail a Goal.
      }
    },
  };
}

function safeGet(statement, ...params) {
  try {
    return statement.get(...params) ?? null;
  } catch {
    return null;
  }
}

function unavailable(reason) {
  return {
    status: LEDGER_STATUS.UNAVAILABLE,
    path: null,
    error: reason,
    schemaVersion: () => null,
    begin: () => ({ status: LEDGER_STATUS.UNAVAILABLE, id: null }),
    finalize: () => ({ status: LEDGER_STATUS.UNAVAILABLE, id: null }),
    recordCorrection: () => ({ status: LEDGER_STATUS.UNAVAILABLE }),
    recordIntegrity: () => ({ status: LEDGER_STATUS.UNAVAILABLE }),
    get: () => null,
    findByKey: () => null,
    query: () => ({ error: reason }),
    close: () => {},
  };
}

/**
 * Migrations.
 *
 * Version 1 is the schema above. The function is idempotent by construction —
 * every statement is CREATE ... IF NOT EXISTS and the version row is upserted —
 * so running it on an existing database is a no-op, which is what makes it safe
 * to call on every open.
 */
/** True when `column` already exists on `table` — makes an ALTER idempotent. */
function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function migrate(db, now) {
  const upsert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const read = db.prepare('SELECT value FROM meta WHERE key = ?');

  const current = read.get('schema_version');
  if (!current) {
    // A brand-new database: CREATE TABLE (above) already built every column
    // this version defines, invocation_id included. Nothing to migrate.
    upsert.run('schema_version', String(SCHEMA_VERSION));
    upsert.run('created_at', now());
  } else if (Number(current.value) > SCHEMA_VERSION) {
    throw new Error(
      `usage ledger schema_version ${current.value} is newer than this collector understands (${SCHEMA_VERSION})`,
    );
  } else if (Number(current.value) < 2) {
    // v1 -> v2: an existing database predates invocation_id. CREATE TABLE IF
    // NOT EXISTS is a no-op on a table that already exists, so the column is
    // genuinely missing and needs adding — guarded, so re-running this on an
    // already-migrated v2 database (opened before the version row is written
    // below) is a no-op rather than a duplicate-column error.
    if (!hasColumn(db, 'model_usage', 'invocation_id')) {
      db.exec('ALTER TABLE model_usage ADD COLUMN invocation_id TEXT');
    }
    upsert.run('schema_version', String(SCHEMA_VERSION));
  }
  // Recorded on every open: which collector last wrote here is a fact about the
  // data, and it changes more often than the schema does.
  upsert.run('collector_version', COLLECTOR_VERSION);
  upsert.run('last_opened_at', now());
}
