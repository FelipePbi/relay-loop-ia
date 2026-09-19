/**
 * IA Loop — zero-token observational telemetry.
 *
 * The whole point of this module is what it does NOT do.
 *
 * Every event it renders is DERIVED from something that already happened:
 * a tool the CLI already decided to use, a tool result it already produced,
 * a process that already exited, a job that already changed state. Nothing
 * here asks the model for anything — no progress messages, no summaries, no
 * explanations, no reasoning. The agent's prompt, its context and its argument
 * vector are byte-identical whatever the log level is; the level only decides
 * what this process prints from a stream it was already receiving.
 *
 * It is a SIDE CHANNEL. The state machine never reads it: the orchestrator's
 * authority stays the structured output and the files on disk. If this module
 * throws, the agent keeps running — every emission is wrapped, by design.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Ordered from quietest to loudest; the index IS the threshold. */
export const LOG_LEVELS = Object.freeze(['minimal', 'normal', 'verbose']);

export const DEFAULT_LOG_LEVEL = 'normal';

/**
 * Categories a safe event can carry.
 *
 * READ/SEARCH/EDIT/WRITE/DELETE/BASH/TEST/GIT describe what the agent's own
 * tools did. RESULT is a tool or command outcome. STATE, CAPACITY, JOB, WORKER,
 * PROFILE, MODEL and DECISION are the harness's own lifecycle, which was always
 * observable. TOOL is the catch-all for a tool with no dedicated category.
 */
export const TELEMETRY_CATEGORIES = Object.freeze([
  'READ', 'SEARCH', 'EDIT', 'WRITE', 'DELETE', 'BASH', 'TEST', 'GIT',
  'RESULT', 'STATE', 'CAPACITY', 'JOB', 'WORKER', 'PROFILE', 'MODEL',
  'DECISION', 'ERROR', 'TOOL',
]);

/**
 * The minimum level at which each category is printed.
 *
 * minimal  job lifecycle, worker lifecycle, model/profile, decision, capacity,
 *          errors — the things a human needs to know the run is alive.
 * normal   + what the agent is touching: files, searches, commands, tests, git.
 * verbose  + every remaining safe event, tool starts/ends and successful
 *          results with their durations.
 */
const CATEGORY_MIN_LEVEL = Object.freeze({
  JOB: 'minimal',
  WORKER: 'minimal',
  CAPACITY: 'minimal',
  PROFILE: 'minimal',
  MODEL: 'minimal',
  DECISION: 'minimal',
  ERROR: 'minimal',

  STATE: 'normal',
  READ: 'normal',
  SEARCH: 'normal',
  EDIT: 'normal',
  WRITE: 'normal',
  DELETE: 'normal',
  BASH: 'normal',
  TEST: 'normal',
  GIT: 'normal',

  RESULT: 'verbose',
  TOOL: 'verbose',
});

export function normalizeLogLevel(value, fallback = DEFAULT_LOG_LEVEL) {
  const candidate = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return LOG_LEVELS.includes(candidate) ? candidate : fallback;
}

/** The level this process runs at. Read once, so it cannot drift mid-run. */
export function resolveLogLevel(env = process.env) {
  return normalizeLogLevel(env.IA_LOOP_LOG_LEVEL);
}

/**
 * Whether an event is printed at a level.
 *
 * A failing RESULT is promoted to `normal`: a command that exited non-zero is
 * progress a human needs, not verbose detail.
 */
export function shouldEmit(event, level) {
  const active = normalizeLogLevel(level);
  const category = event?.category;
  let min = CATEGORY_MIN_LEVEL[category] ?? 'verbose';
  if (category === 'RESULT' && event.isError === true) min = 'normal';
  return LOG_LEVELS.indexOf(active) >= LOG_LEVELS.indexOf(min);
}

// --- Sanitisation ----------------------------------------------------------

/** Hard cap on anything rendered, so no file content can ever leak through. */
export const MAX_DETAIL_LENGTH = 160;

/**
 * Patterns replaced before anything reaches a terminal or a log file.
 *
 * Deliberately aggressive and ordered from most specific to least: a redacted
 * command is still perfectly readable as telemetry, while a leaked credential
 * is unrecoverable.
 */
const REDACTIONS = Object.freeze([
  // The whole header VALUE, not just its first token: `Authorization: Bearer x`
  // leaked the token when only `\S+` was consumed.
  [/\b(authorization|proxy-authorization)\s*:\s*[^"'\n]*/gi, '$1: «redacted»'],
  [/\bbearer\s+[\w.\-~+/]+=*/gi, 'Bearer «redacted»'],
  [/\bbasic\s+[A-Za-z0-9+/]{8,}={0,2}/gi, 'Basic «redacted»'],
  // Known credential shapes, whatever they are called.
  [/\bsk-[A-Za-z0-9_\-]{8,}/g, '«redacted»'],
  [/\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{8,}/g, '«redacted»'],
  [/\bxox[abposr]-[A-Za-z0-9-]{8,}/g, '«redacted»'],
  [/\bAKIA[0-9A-Z]{12,}/g, '«redacted»'],
  [/\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]*/g, '«redacted»'],
  // Anything NAMED like a secret, however it is spelled or assigned.
  [
    /\b([A-Za-z0-9_.\-]*(?:passwo?rd|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|cookie|session[_-]?key|auth)[A-Za-z0-9_.\-]*)\s*([:=])\s*("[^"]*"|'[^']*'|\S+)/gi,
    '$1$2«redacted»',
  ],
  // Command-line flags carrying a secret.
  [
    /(--?[A-Za-z0-9-]*(?:passwo?rd|secret|token|api-?key|credential|auth)[A-Za-z0-9-]*)(\s+|=)(\S+)/gi,
    '$1$2«redacted»',
  ],
  // Credentials embedded in a URL.
  [/\b([a-z][a-z0-9+.\-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1«redacted»@'],
  // Set-and-run: FOO_TOKEN=... cmd, already covered above; this catches the
  // generic `export NAME=value` where the NAME is not obviously a secret but
  // the value looks like one.
  [/\b([A-Z][A-Z0-9_]{4,})=([A-Za-z0-9+/_\-]{24,}={0,2})\b/g, '$1=«redacted»'],
]);

/**
 * Applies the redaction table and nothing else.
 *
 * Split out of `sanitize` because the usage ledger needs the SAME credential
 * patterns over a JSON payload it must not collapse or truncate: collapsing
 * whitespace would corrupt the document and a 160-character cap would destroy
 * it. One table, two consumers, so a pattern added for the terminal also
 * protects what is written to the ledger.
 */
export function redactSecrets(value) {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : String(value);
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
  return text;
}

/**
 * Makes an arbitrary string safe to print.
 *
 * Redacts, collapses whitespace (a multi-line heredoc must never become fifty
 * terminal lines) and truncates. Never returns file content: callers only ever
 * pass paths, patterns and commands.
 */
export function sanitize(value, { maxLength = MAX_DETAIL_LENGTH } = {}) {
  if (value === null || value === undefined) return '';
  let text = redactSecrets(value).replace(/\s+/g, ' ').trim();
  if (text.length > maxLength) text = `${text.slice(0, maxLength - 1)}…`;
  return text;
}

/**
 * Shortens a path for display without hiding which file it is.
 * Absolute worktree paths are relativised when the root is known.
 */
export function shortenPath(value, { root = null, maxLength = MAX_DETAIL_LENGTH } = {}) {
  if (typeof value !== 'string' || value === '') return '';
  let path = value.replace(/\\/g, '/');
  if (root) {
    const normalizedRoot = String(root).replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalizedRoot && path.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)) {
      path = path.slice(normalizedRoot.length + 1);
    }
  }
  return sanitize(path, { maxLength });
}

// --- Rendering -------------------------------------------------------------

function clockOf(at) {
  const date = at instanceof Date ? at : new Date(at ?? Date.now());
  return Number.isNaN(date.getTime())
    ? new Date().toISOString().slice(11, 19)
    : date.toISOString().slice(11, 19);
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

/** One terminal line. Timestamp, category, detail — nothing else. */
export function renderEvent(event, level = DEFAULT_LOG_LEVEL) {
  const parts = [`[${clockOf(event.at)}]`, event.category];
  if (event.detail) parts.push(event.detail);
  if (normalizeLogLevel(level) === 'verbose') {
    const duration = formatDuration(event.durationMs);
    if (duration) parts.push(`(${duration})`);
  }
  return parts.join(' ');
}

// --- Persistence -----------------------------------------------------------

/**
 * Appends observational events to disk.
 *
 * Only what is already rendered: category, short detail, timestamps. Never a
 * payload, never file content, never a model's reasoning. Failures are
 * swallowed — telemetry may not break an execution.
 */
export function createTelemetryFileSink({ stateDir, role, enabled = true }) {
  if (!enabled || !stateDir) return null;
  const dir = join(stateDir, 'telemetry');
  const day = new Date().toISOString().slice(0, 10);
  const path = join(dir, `${role ?? 'ia-loop'}-${day}.jsonl`);
  let ready = null;

  return async (event) => {
    try {
      ready ??= mkdir(dir, { recursive: true });
      await ready;
      const record = {
        at: event.at ?? new Date().toISOString(),
        role: role ?? null,
        goal: event.goal ?? null,
        round: event.round ?? null,
        jobId: event.jobId ?? null,
        category: event.category,
        detail: event.detail ?? null,
        tool: event.tool ?? null,
        durationMs: Number.isFinite(event.durationMs) ? Math.round(event.durationMs) : null,
        isError: event.isError ?? null,
      };
      await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // Intentionally silent: a full disk must not fail a Goal.
    }
  };
}

/**
 * The telemetry channel a worker holds for the whole run.
 *
 * `emit` never throws and never returns a promise the caller must await: an
 * agent's execution path must not be able to fail here, and must not be slowed
 * down waiting for a log line either.
 */
export function createTelemetry({
  level = resolveLogLevel(),
  role = null,
  write = (line) => console.log(line),
  sink = null,
  clock = () => new Date(),
} = {}) {
  const activeLevel = normalizeLogLevel(level);
  let context = {};

  const emit = (event) => {
    try {
      if (!event || !event.category) return;
      const enriched = { ...context, ...event, at: event.at ?? clock().toISOString() };
      if (shouldEmit(enriched, activeLevel)) write(renderEvent(enriched, activeLevel));
      if (sink) {
        // Persisted at every level: the file is the audit trail, the terminal
        // is the view. Deliberately not awaited.
        Promise.resolve(sink(enriched)).catch(() => {});
      }
    } catch {
      // A telemetry failure is never an execution failure.
    }
  };

  return {
    level: activeLevel,
    role,

    /** Facts every subsequent event inherits (goal, round, jobId). */
    setContext(next) {
      try {
        context = { ...context, ...next };
      } catch {
        // ignore
      }
    },

    clearContext() {
      context = {};
    },

    emit,

    /** Convenience for the harness's own lifecycle lines. */
    event(category, detail, extra = {}) {
      emit({ category, detail: detail ? sanitize(detail) : '', ...extra });
    },
  };
}

/** A telemetry object that emits nothing. Used wherever a channel is optional. */
export const NULL_TELEMETRY = Object.freeze({
  level: 'minimal',
  role: null,
  setContext() {},
  clearContext() {},
  emit() {},
  event() {},
});
