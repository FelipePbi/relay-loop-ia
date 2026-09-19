/**
 * IA Loop — the one place a model execution becomes a ledger row.
 *
 * The pipeline this Goal asked for, in one object:
 *
 *   model execution finishes
 *         -> collector receives execution metadata   (begin/finalize)
 *         -> extract raw usage                       (usage-normalizer)
 *         -> normalize known fields                  (usage-normalizer)
 *         -> attach ia-loop context                  (usage-context)
 *         -> persist                                 (usage-ledger)
 *
 * No worker parses a token count, and no worker writes SQL. The only caller is
 * `invokeAgent`, because `invokeAgent` is the only thing in this package that
 * can start an inference — instrumenting there is what makes coverage a
 * property of the architecture rather than of everybody remembering.
 *
 * Two rules this module exists to hold:
 *
 *   ZERO TOKEN OVERHEAD   nothing here talks to a model, changes a prompt,
 *                         changes an argument vector, or adds a round trip.
 *                         Every number is copied, tallied or read off disk.
 *
 *   BEST EFFORT           telemetry failing is reported loudly and swallowed
 *                         operationally. A correctly finished Goal is never
 *                         failed because SQLite was busy.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { LEDGER_STATUS, openUsageLedger } from './usage-ledger.mjs';
import {
  EXECUTION_STATUSES,
  buildUsageRecord,
  COLLECTOR_VERSION,
  SCHEMA_VERSION,
} from './usage-normalizer.mjs';
import { baseUsageContext, currentUsageContext } from './usage-context.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE_DIR = resolve(HERE, '..', '.state');
const REPO_ROOT = resolve(HERE, '..');

export const USAGE_LEDGER_FILENAME = 'usage.sqlite';

export function defaultLedgerPath(stateDir = DEFAULT_STATE_DIR) {
  return join(stateDir, 'telemetry', USAGE_LEDGER_FILENAME);
}

/**
 * The idempotency key, built from ids the state machine already owns.
 *
 * `role + job + attempt` was tried first and is NOT enough: the ia-loop's own
 * repair path (ia-loop:reclassify moving a failure to WAITING_FOR_CAPACITY,
 * ia-loop:resume requeuing it) re-runs the SAME attemptId by design — see
 * README V21/V22 and `lib/leases.mjs`'s `canStartNewAttempt` — so a job that
 * failed and was legitimately retried produces TWO real model calls sharing
 * one role+job+attempt. A key built from those three alone made the second,
 * genuinely different call collide with the first in the UNIQUE constraint
 * and vanish as a false "already recorded" — the exact way a repaired retry's
 * real tokens and result were silently lost before this was found.
 *
 * The identity that is actually unique per real call is the call itself:
 * `generateInvocationId()` mints one, in the collector, before the CLI is
 * spawned — necessarily before the provider has produced anything of its own
 * (a `session_id` a persistent Fable conversation keeps across calls, a
 * `result.uuid` that does not exist until the call finishes) that could serve
 * instead. Two real calls always get two different ids; the harness identity
 * (role, jobId, attemptId) is preserved on the row for correlation, exactly
 * as before, just no longer doing duty as the uniqueness key.
 *
 * The single legitimate way two `begin()` calls should EVER resolve to the
 * same row is a future crash-recovery reconciliation explicitly reading an
 * orphaned STARTED row's own invocation id back off disk and passing it in to
 * finish that SAME row — never a fresh id computed from context.
 */
export function generateInvocationId() {
  return randomUUID();
}

/**
 * The autonomous run in force, when there is one.
 *
 * Read from the state the orchestrator already writes, never minted here: a
 * worker is started by a human in its own terminal and is not told which run it
 * belongs to, so the file is the only honest source. Cached briefly because a
 * run id changes far less often than model calls happen.
 *
 * Only a RUNNING run is reported. A run that stopped for a human, paused or
 * completed is a record of where it stopped, and work done supervised
 * afterwards does not belong to it. Reading it unconditionally is what stamped
 * `auto-987b6c55` onto Goal 008's closure — a call that run never made, in a
 * Goal it never reached. A supervised call legitimately has no run id, and the
 * column is nullable for exactly that reason.
 */
function createRunIdReader({ stateDir, ttlMs = 2000, now = () => Date.now() }) {
  let cachedAt = 0;
  let cached = null;
  return () => {
    if (now() - cachedAt < ttlMs) return cached;
    cachedAt = now();
    try {
      const parsed = JSON.parse(readFileSync(join(stateDir, 'autonomous-run.json'), 'utf8'));
      cached = parsed?.status === 'RUNNING' && typeof parsed.autonomousRunId === 'string'
        ? parsed.autonomousRunId
        : null;
    } catch {
      cached = null;
    }
    return cached;
  };
}

/** Where a telemetry write failure is reported when nobody is listening. */
function createFailureSink({ stateDir, write = (line) => process.stderr.write(`${line}\n`) }) {
  const path = join(stateDir, 'telemetry', 'usage-failures.jsonl');
  return (failure) => {
    const line = `[ia-loop] ${LEDGER_STATUS.WRITE_FAILED} ${failure.stage}: ${failure.error ?? failure.status}`;
    try {
      write(line);
    } catch {
      // Nothing left to do; a broken stderr cannot fail a Goal either.
    }
    try {
      mkdirSync(dirname(path), { recursive: true });
      // The marker goes into the record as well as the terminal line: an
      // operator greps this file long after the console has scrolled away.
      const record = { at: new Date().toISOString(), signal: LEDGER_STATUS.WRITE_FAILED, ...failure };
      appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // The whole point of this sink is that it cannot itself raise.
    }
  };
}

/**
 * Builds a collector.
 *
 * `enabled: false` produces a real object that records nothing, so callers
 * never branch. Nothing else in the package is allowed to know whether the
 * ledger is on.
 */
export function createUsageCollector({
  stateDir = DEFAULT_STATE_DIR,
  path = null,
  enabled = true,
  projectId = null,
  now = () => new Date().toISOString(),
  onFailure = null,
  ledger = null,
} = {}) {
  const failures = [];
  const reportFailure = onFailure ?? createFailureSink({ stateDir });

  if (!enabled) return nullCollector();

  const resolvedPath = path ?? defaultLedgerPath(stateDir);
  let store = ledger;
  let opened = Boolean(ledger);

  const readRunId = createRunIdReader({ stateDir });
  const project = projectId ?? process.env.IA_LOOP_PROJECT_ID ?? basename(REPO_ROOT);

  /** Opened on first use so importing this module never touches the disk. */
  function ledgerOf() {
    if (!opened) {
      store = openUsageLedger({ path: resolvedPath, now });
      opened = true;
      if (store.status !== LEDGER_STATUS.OK) {
        note({ stage: 'open', status: store.status, error: store.error });
      }
    }
    return store;
  }

  function note(failure) {
    failures.push(failure);
    try {
      reportFailure(failure);
    } catch {
      // ignore
    }
  }

  /** The facts in force, with the ones only this module can supply filled in. */
  function contextFor(overrides = {}) {
    return {
      projectId: project,
      runId: readRunId(),
      ...currentUsageContext(),
      ...overrides,
    };
  }

  return {
    enabled: true,
    path: resolvedPath,
    schemaVersion: SCHEMA_VERSION,
    collectorVersion: COLLECTOR_VERSION,

    /** Diagnostics for a caller that wants to assert the ledger is healthy. */
    status() {
      return { status: ledgerOf().status, path: resolvedPath, failures: failures.length };
    },

    failures() {
      return [...failures];
    },

    /**
     * Opens a row BEFORE the CLI is spawned.
     *
     * This is what makes a crash visible: a process killed mid-inference leaves
     * a STARTED row naming the Goal, the attempt and the model it was running,
     * instead of leaving nothing at all.
     *
     * `invocationId` defaults to a fresh id — the normal case, a real new call.
     * The only reason to pass one in explicitly is a future crash-recovery path
     * that read an orphaned STARTED row's own id back off disk and is
     * finishing that SAME row, never a caller trying to compute a key from
     * context: role+job+attempt can repeat across two genuinely different real
     * calls (a repaired attempt is re-run under its original attemptId), and
     * that repeat must never make the second call collide with the first.
     */
    beginModelExecution({ context: overrides = {}, request = {}, invocationId = generateInvocationId() } = {}) {
      const context = contextFor(overrides);
      const idempotencyKey = invocationId;
      const handle = {
        idempotencyKey, invocationId, context, id: null, recorded: false, startedAt: now(),
      };

      try {
        const record = buildUsageRecord({
          context,
          capture: {
            invocationId,
            requestedModel: request.model ?? null,
            requestedEffort: request.effort ?? null,
            sessionId: request.sessionId ?? null,
            resumed: request.resume === true,
            startedAt: handle.startedAt,
            // A row that has not finished yet reports nothing about its result.
            structuredOutput: false,
          },
        });
        record.status = EXECUTION_STATUSES.STARTED;
        record.modelCallStarted = false;
        record.failureReason = null;
        record.failureFamily = null;
        record.failureCode = null;

        const outcome = ledgerOf().begin({ idempotencyKey, record });
        handle.id = outcome.id ?? null;
        handle.recorded = outcome.status === LEDGER_STATUS.OK;
        handle.alreadyRecorded = outcome.status === LEDGER_STATUS.ALREADY_RECORDED;
        if (outcome.status === LEDGER_STATUS.WRITE_FAILED) {
          note({ stage: 'begin', status: outcome.status, error: outcome.error, idempotencyKey });
        }
      } catch (error) {
        note({ stage: 'begin', status: LEDGER_STATUS.WRITE_FAILED, error: error?.message ?? String(error), idempotencyKey });
      }
      return handle;
    },

    /**
     * Closes the row opened by `beginModelExecution`.
     *
     * `capture` is exactly what the invocation observed: the envelope the CLI
     * printed, the tallies the stream parser kept, the process boundaries. It
     * is normalised here and nowhere else.
     */
    finalizeModelExecution(handle, capture = {}) {
      if (!handle) return { status: LEDGER_STATUS.WRITE_FAILED, error: 'NO_HANDLE' };
      if (handle.alreadyRecorded) return { status: LEDGER_STATUS.ALREADY_RECORDED, id: handle.id };
      if (!handle.id) return { status: LEDGER_STATUS.WRITE_FAILED, error: 'NO_ROW' };

      try {
        const record = buildUsageRecord({
          context: handle.context,
          // The handle's own invocationId wins over anything a caller passed:
          // it is the row's actual identity, fixed at begin() time, and a
          // caller of finalizeModelExecution never needs to know it exists.
          capture: { ...capture, invocationId: handle.invocationId, startedAt: capture.startedAt ?? handle.startedAt },
        });
        const outcome = ledgerOf().finalize({
          id: handle.id,
          idempotencyKey: handle.idempotencyKey,
          record,
          toolCalls: capture.counters?.toolCalls ?? [],
          events: (capture.trail?.events ?? []).map((event) => ({
            index: event.index,
            type: event.type,
            at: event.at,
            // Metadata only: a tool NAME and a duration, never a tool input and
            // never its output. The ledger is not a second copy of the logs.
            metadata: {
              tool: event.tool ?? null,
              category: event.category ?? null,
              isError: event.isError ?? null,
              durationMs: event.durationMs ?? null,
              subtype: event.subtype ?? null,
            },
          })),
        });
        if (outcome.status === LEDGER_STATUS.WRITE_FAILED) {
          note({ stage: 'finalize', status: outcome.status, error: outcome.error, idempotencyKey: handle.idempotencyKey });
        }
        return { ...outcome, record };
      } catch (error) {
        note({
          stage: 'finalize', status: LEDGER_STATUS.WRITE_FAILED,
          error: error?.message ?? String(error), idempotencyKey: handle.idempotencyKey,
        });
        return { status: LEDGER_STATUS.WRITE_FAILED, error: error?.message ?? String(error) };
      }
    },

    /**
     * One-shot: an execution already finished, recorded in a single step.
     *
     * Used where there was no chance to open a row first — a reconciliation
     * replaying a result found on disk after a crash. Two outcomes, and the
     * difference between them is the whole point:
     *
     *   the row is still STARTED   the crashed process opened it and never
     *                              came back. This is the SAME logical
     *                              execution, so it is finalised in place —
     *                              one execution, one finalised record.
     *
     *   the row is terminal        it was already accounted for. Nothing is
     *                              written, ALREADY_RECORDED is returned, and
     *                              the tokens are not counted a second time.
     *
     * `invocationId` MUST be passed explicitly here to express "this is the
     * same execution being replayed" — reading it back from the STARTED row a
     * crash left behind, never recomputed from context. Left to its default, a
     * second call generates a fresh id and records a second, independent
     * execution, which is correct for two calls that just happen to share
     * context (see generateInvocationId's docstring) but wrong for a genuine
     * replay of the one this handle already opened.
     */
    recordModelExecution({ context: overrides = {}, capture = {}, invocationId } = {}) {
      const handle = this.beginModelExecution({
        context: overrides,
        invocationId,
        request: {
          model: capture.requestedModel ?? null,
          effort: capture.requestedEffort ?? null,
          sessionId: capture.sessionId ?? null,
          resume: capture.resumed === true,
        },
      });

      if (handle.alreadyRecorded) {
        const existing = ledgerOf().findByKey(handle.idempotencyKey);
        if (existing?.status !== 'STARTED') return { status: LEDGER_STATUS.ALREADY_RECORDED, id: handle.id };
        return this.finalizeModelExecution(
          { ...handle, id: existing.id, alreadyRecorded: false },
          capture,
        );
      }
      return this.finalizeModelExecution(handle, capture);
    },

    /** Append-only note beside an existing row. Never an overwrite. */
    recordCorrection(args) {
      return ledgerOf().recordCorrection(args);
    },

    /** Read-only access for the debugging CLI. No presentation lives here. */
    query(sql, params) {
      return ledgerOf().query(sql, params);
    },

    close() {
      if (opened && store) store.close();
    },
  };
}

/** A collector that records nothing and can be called exactly like a real one. */
export function nullCollector() {
  return {
    enabled: false,
    path: null,
    schemaVersion: SCHEMA_VERSION,
    collectorVersion: COLLECTOR_VERSION,
    status: () => ({ status: LEDGER_STATUS.UNAVAILABLE, path: null, failures: 0 }),
    failures: () => [],
    beginModelExecution: () => ({ id: null, recorded: false, context: baseUsageContext(), idempotencyKey: null }),
    finalizeModelExecution: () => ({ status: LEDGER_STATUS.UNAVAILABLE }),
    recordModelExecution: () => ({ status: LEDGER_STATUS.UNAVAILABLE }),
    recordCorrection: () => ({ status: LEDGER_STATUS.UNAVAILABLE }),
    query: () => ({ error: 'ledger disabled' }),
    close: () => {},
  };
}

/**
 * Whether the process-wide collector records.
 *
 * On by default, because a call that quietly goes unrecorded is the failure
 * this Goal exists to prevent. Off inside `node --test` unless a test names its
 * own database: a unit test must not append rows to the real ledger.
 */
export function usageLedgerEnabled(env = process.env) {
  if (env.IA_LOOP_USAGE_LEDGER === '0') return false;
  if (env.IA_LOOP_USAGE_LEDGER === '1') return true;
  if (env.NODE_TEST_CONTEXT && !env.IA_LOOP_TELEMETRY_DB) return false;
  return true;
}

let shared = null;

/**
 * The collector every unattributed call falls back to.
 *
 * Lazy so importing this module opens nothing, and memoised so a worker holds
 * one database handle rather than one per call.
 */
export function defaultUsageCollector(env = process.env) {
  if (shared) return shared;
  shared = createUsageCollector({
    enabled: usageLedgerEnabled(env),
    path: env.IA_LOOP_TELEMETRY_DB || null,
  });
  return shared;
}

/** Test seam: drops the memoised collector so the next call rebuilds it. */
export function resetDefaultUsageCollector() {
  if (shared) shared.close();
  shared = null;
}

export { LEDGER_STATUS };
