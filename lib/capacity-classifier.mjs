/**
 * IA Loop — capacity/failure classification.
 *
 * Turns whatever the Claude CLI reported into one of a small, fixed set of
 * causes, so policy decisions are made on a classification rather than on ad-hoc
 * string matching spread through the workers.
 *
 * Structured signals (our own error codes, the envelope's terminal_reason and
 * any HTTP status present) are preferred; text matching is the last resort.
 *
 * Nothing sensitive is retained: diagnostics are truncated and scrubbed.
 */

export const CAPACITY_REASONS = Object.freeze({
  RATE_LIMIT: 'RATE_LIMIT',
  USAGE_LIMIT: 'USAGE_LIMIT',
  AUTH_ERROR: 'AUTH_ERROR',
  BILLING_ERROR: 'BILLING_ERROR',
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  UNKNOWN_TRANSIENT: 'UNKNOWN_TRANSIENT',
  UNKNOWN_FATAL: 'UNKNOWN_FATAL',
  /**
   * The harness's OWN turn budget, reached — not a limit of the model, the
   * account or the machine.
   *
   * It exists as a separate reason because every other fatal one escalates to
   * a human, and this one must not: the operator set the ceiling on purpose,
   * the worktree holds whatever the unit managed to write, and the answer is
   * to record the unit as blocked and let the review see it. Classifying it as
   * UNKNOWN_FATAL would turn a cost control into a run-stopper.
   */
  TURN_BUDGET_EXHAUSTED: 'TURN_BUDGET_EXHAUSTED',
  /**
   * A local failure of the harness itself — a bad spawn, an argument list too
   * long, a missing executable. It is NOT a model or capacity limit and must
   * never be reported as one or waited out: no amount of waiting fixes it.
   */
  HARNESS_ERROR: 'HARNESS_ERROR',
});

/** True when the cause is local tooling rather than the model or its limits. */
export function isHarnessError(reason) {
  return reason === CAPACITY_REASONS.HARNESS_ERROR;
}

/**
 * Our own error codes map directly, without touching text.
 * A detected model fallback is fatal on purpose: it is a violated invariant,
 * never something to retry around.
 */
const CODE_MAP = Object.freeze({
  TIMEOUT: CAPACITY_REASONS.UNKNOWN_TRANSIENT,
  EMPTY_OUTPUT: CAPACITY_REASONS.UNKNOWN_TRANSIENT,
  INVALID_ENVELOPE_JSON: CAPACITY_REASONS.UNKNOWN_TRANSIENT,
  INVALID_AGENT_JSON: CAPACITY_REASONS.UNKNOWN_TRANSIENT,
  INVALID_AGENT_SHAPE: CAPACITY_REASONS.UNKNOWN_TRANSIENT,
  MISSING_RESULT: CAPACITY_REASONS.UNKNOWN_TRANSIENT,

  // Contract slips by the model. Retryable within the transient budget: the
  // schema is pinned, so a second attempt normally lands. Fatal would burn the
  // whole round over a wrong version number.
  UNSUPPORTED_PROTOCOL_VERSION: CAPACITY_REASONS.UNKNOWN_TRANSIENT,
  UNSUPPORTED_STATUS: CAPACITY_REASONS.UNKNOWN_TRANSIENT,
  UNSUPPORTED_DECISION: CAPACITY_REASONS.UNKNOWN_TRANSIENT,
  CONTRACT_FIELD_INVALID: CAPACITY_REASONS.UNKNOWN_TRANSIENT,
  ROLE_MISMATCH: CAPACITY_REASONS.UNKNOWN_TRANSIENT,
  JOB_ID_MISMATCH: CAPACITY_REASONS.UNKNOWN_TRANSIENT,
  GOAL_MISMATCH: CAPACITY_REASONS.UNKNOWN_TRANSIENT,
  ROUND_MISMATCH: CAPACITY_REASONS.UNKNOWN_TRANSIENT,
  DECISION_BLOCKERS_INCOHERENT: CAPACITY_REASONS.UNKNOWN_TRANSIENT,
  DECISION_NEXT_ACTION_INCOHERENT: CAPACITY_REASONS.UNKNOWN_TRANSIENT,
  CLOSURE_SCOPE_VIOLATION: CAPACITY_REASONS.UNKNOWN_TRANSIENT,

  // Local execution problems, not capacity. ENAMETOOLONG (argv over the OS
  // limit) was originally misreported as a capacity limit; it is a harness bug.
  EXECUTABLE_NOT_FOUND: CAPACITY_REASONS.HARNESS_ERROR,
  SPAWN_FAILED: CAPACITY_REASONS.HARNESS_ERROR,
  // An argv we refused to spawn, or one the CLI refused to accept. Local,
  // deterministic and ours to fix.
  INVALID_CLAUDE_CLI_ARGS: CAPACITY_REASONS.HARNESS_ERROR,
  UNSUPPORTED_EFFORT: CAPACITY_REASONS.HARNESS_ERROR,
  // A detected fallback is a violated invariant about WHICH model answered,
  // proven from explicit evidence (resolveServedPrimaryModel). Genuinely
  // fatal, never local tooling.
  MODEL_FALLBACK_DETECTED: CAPACITY_REASONS.UNKNOWN_FATAL,

  // Everything below is the harness failing to establish model identity, not
  // the model or a limit doing anything. Goal006 R1 stopped as UNKNOWN_FATAL
  // on exactly RESOLVED_MODEL_UNKNOWN — a byte-exact match between the
  // envelope's top-level `usage` and one `modelUsage` entry failing on turn 3
  // of a resumed session, while the CLI had already produced a valid
  // StructuredOutput. That token-accounting mechanism is now advisory only
  // (see claude-process.mjs's resolvePrimaryModel); these two codes are kept
  // for whatever still calls it directly, reclassified as local tooling
  // rather than an unknowable model failure.
  RESOLVED_MODEL_AMBIGUOUS: CAPACITY_REASONS.HARNESS_ERROR,
  RESOLVED_MODEL_UNKNOWN: CAPACITY_REASONS.HARNESS_ERROR,

  // The current mechanism: no explicit `message.model` evidence on the
  // response stream, or more than one distinct value. Never a capacity or
  // model problem — waiting cannot produce evidence that was never emitted.
  PRIMARY_MODEL_EVIDENCE_MISSING: CAPACITY_REASONS.HARNESS_ERROR,
  PRIMARY_MODEL_EVIDENCE_CONFLICT: CAPACITY_REASONS.HARNESS_ERROR,
});

/**
 * The Claude CLI rejecting our own argv or configuration.
 *
 * These are the CLI's LOCAL validation messages, produced before any request
 * leaves the machine: a flag that needs a companion flag, an unknown flag, an
 * invalid value, two flags that cannot be combined. They are deterministic
 * defects in the harness, and waiting cannot fix one.
 *
 * Goal 005 R1 stopped as UNKNOWN_FATAL on exactly this — "When using --print,
 * --output-format=stream-json requires --verbose" — which read as though
 * something unknowable had happened, when in fact our argv was simply wrong.
 * The stop was right; the diagnosis was not.
 *
 * Deliberately narrow. A non-zero exit is NOT evidence of an argument problem,
 * and nothing here matches on exit status: only on wording the CLI uses for its
 * own argument parsing.
 */
const CLI_ARGUMENT_REJECTION = new RegExp([
  // "When using --print, --output-format=stream-json requires --verbose"
  'when using --[a-z-]+,',
  '--?[a-z-]+ requires --',
  'requires (the )?--[a-z-]+',
  'only works with --',
  '(unknown|unrecognized|invalid|unexpected) (option|argument|flag|command)',
  'invalid value for --',
  'invalid value .* for --',
  '(unsupported|invalid) output format',
  'cannot be (used|combined) (with|together)',
  'mutually exclusive',
  'missing required (option|argument|flag)',
  'is not valid json', // --json-schema rejected locally by the CLI parser
  'must be a valid uuid',
  'invalid session id',
].join('|'), 'i');

/** Ordered: the first match wins, so the more specific patterns come first. */
const TEXT_PATTERNS = Object.freeze([
  // Checked before everything else: an argv the CLI refused is our bug, and it
  // must never be read as a model problem, a limit, or an unknown.
  [CAPACITY_REASONS.HARNESS_ERROR, CLI_ARGUMENT_REJECTION],
  // Then an OS-level spawn failure, which must never be read as a rate limit.
  [CAPACITY_REASONS.HARNESS_ERROR, /ENAMETOOLONG|E2BIG|argument list too long|ENOENT|EACCES|EMFILE|spawn \w+ E[A-Z]+/],
  [CAPACITY_REASONS.AUTH_ERROR, /not logged in|please run \/login|unauthorized|authentication_error|invalid[_ ]api[_ ]key|oauth|401\b/i],
  [CAPACITY_REASONS.BILLING_ERROR, /billing|payment|credit balance|insufficient (credit|funds|balance)|402\b/i],
  // The Claude CLI says "You've hit your session limit · resets 3:10am
  // (America/Sao_Paulo)". None of the earlier wording matched it, so the one
  // condition the loop is designed to WAIT OUT was classified UNKNOWN_FATAL and
  // stopped a Goal for a human 11 minutes before the quota reset itself.
  //
  // The patterns stay specific. "limit" on its own is deliberately not enough:
  // a round limit, a context limit and a retry limit are not quota.
  [CAPACITY_REASONS.USAGE_LIMIT, new RegExp([
    'session limit',
    'usage limit',
    'session usage limit',
    'hit your (session|usage) limit',
    // The PER-MODEL phrasing: "You've reached your Fable limit. Switch to
    // another model, or manage usage credits at claude.ai/settings/usage…".
    // Real production message (Goal 009, 2026-09-09): no "session"/"usage"
    // word next to "limit", no "reset" mentioned at all, so every pattern
    // above missed it and the job — which HAD fallbackAllowed: true — was
    // escalated to a human instead of falling back to another model. The
    // model name varies (Fable today, could be any family), so it is a
    // wildcard, not a fixed list.
    'reached your .{1,40}? limit',
    'manage usage credits',
    'quota',
    'out of (usage|credits)',
    'limit (will )?reset',
    // "resets 3:10am", "resets at 15:10", with or without a timezone.
    'resets?\\s+(at\\s+)?\\d{1,2}(:\\d{2})?\\s*(am|pm)?\\b',
    'weekly limit',
    '\\d+-hour limit',
    'upgrade to (a )?(higher|paid)',
  ].join('|'), 'i')],
  [CAPACITY_REASONS.RATE_LIMIT, /rate[_ ]?limit|too many requests|429\b|overloaded|529\b/i],
  [CAPACITY_REASONS.MODEL_UNAVAILABLE, /model[_ ]not[_ ]found|unknown model|model .*(not available|unavailable|not found)|not_found_error/i],
  [CAPACITY_REASONS.UNKNOWN_TRANSIENT, /timeout|timed out|econnreset|etimedout|socket hang up|network|temporarily|5\d\d\b|internal server error/i],
]);

/** Redacts anything that could carry a secret before we keep a diagnostic. */
export function sanitizeDiagnostic(text, { maxLength = 300 } = {}) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/sk-[A-Za-z0-9_\-]+/g, '<redacted>')
    .replace(/\b(Bearer|Token)\s+[^\s",}]+/gi, '$1 <redacted>')
    .replace(/\bAuthorization\b\s*[:=]\s*[^\s",}]+/gi, 'Authorization <redacted>')
    .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|password|secret)("?\s*[:=]\s*)("?)[^\s",}]+/gi, '$1$2$3<redacted>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/** A reset further out than a day is not a reading we trust. */
const MAX_RESET_WAIT_MS = 24 * 3_600_000;

/**
 * The wall clock right now in a named timezone.
 *
 * Returns null for a zone the runtime cannot resolve, which is the whole point:
 * an unreadable timezone means we do not know when the quota resets, and
 * guessing a wait is worse than falling back to the default interval.
 */
function wallClockIn(timeZone, nowMs) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(nowMs));
  } catch {
    return null;
  }

  const read = (type) => Number(parts.find((p) => p.type === type)?.value);
  // Some ICU versions render midnight as hour 24.
  const hour = read('hour') % 24;
  const minute = read('minute');
  const second = read('second');
  if (![hour, minute, second].every(Number.isInteger)) return null;
  return { hour, minute, second };
}

/**
 * Milliseconds until a reset time stated as a wall clock, e.g.
 * "resets 3:10am (America/Sao_Paulo)".
 *
 * Computed as a difference of wall clocks in the stated zone, so the next
 * occurrence is found without any date arithmetic: at 23:50 a 3:10am reset is
 * tomorrow, and the rollover falls out of the subtraction rather than being a
 * special case someone has to remember.
 *
 * Returns null whenever the reading is not unambiguous. Nothing is invented:
 * the caller falls back to the configured usage-limit interval.
 */
export function parseResetAt(source, { now = Date.now(), timeZone = null } = {}) {
  const text = typeof source === 'string' ? source : String(source?.message ?? '');
  if (!text) return null;

  const clause = text.match(/reset(?:s|ting)?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!clause) return null;

  const meridiem = clause[3]?.toLowerCase() ?? null;
  let hour = Number(clause[1]);
  const minute = clause[2] === undefined ? 0 : Number(clause[2]);
  if (minute > 59) return null;

  if (meridiem === 'am') {
    if (hour < 1 || hour > 12) return null;
    hour = hour % 12;
  } else if (meridiem === 'pm') {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + 12;
  } else if (hour > 23) {
    return null;
  }
  // Without a meridiem the hour is read literally on a 24-hour clock. That is
  // the stated time, not a guess about which half of the day was meant.

  // An explicit "(America/Sao_Paulo)" wins; otherwise whatever the loop was
  // configured with, and finally the machine's own zone.
  const stated = text.match(/\(([A-Za-z][A-Za-z_+-]*(?:\/[A-Za-z_+-]+)+)\)/);
  const zone = stated?.[1]
    ?? timeZone
    ?? process.env.IA_LOOP_TIMEZONE
    ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const wall = wallClockIn(zone, now);
  if (!wall) return null;

  let deltaMinutes = (hour * 60 + minute) - (wall.hour * 60 + wall.minute);
  // Already past, or exactly now: the reset being referred to is the next one.
  if (deltaMinutes <= 0) deltaMinutes += 24 * 60;

  const ms = deltaMinutes * 60_000 - wall.second * 1000;
  if (ms <= 0 || ms > MAX_RESET_WAIT_MS) return null;
  return ms;
}

/**
 * Extracts a server-provided wait, when the CLI surfaced one.
 * Returns milliseconds, or null when nothing reliable was found.
 */
export function extractRetryAfterMs(source, { now = Date.now(), timeZone = null } = {}) {
  if (source && typeof source === 'object') {
    // Prefer structured values when the envelope carries them.
    const structured = source.retryAfterMs ?? source.retry_after_ms;
    if (Number.isFinite(structured) && structured >= 0) return structured;

    const seconds = source.retryAfter ?? source.retry_after;
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }

  const text = typeof source === 'string' ? source : String(source?.message ?? '');
  if (!text) return null;

  const header = text.match(/retry[- ]after["'\s:=]+(\d+)/i);
  if (header) return Number(header[1]) * 1000;

  const phrase = text.match(/(?:try again|retry|available again)\s+in\s+(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|h|m|s)\b/i);
  if (phrase) {
    const amount = Number(phrase[1]);
    const unit = phrase[2].toLowerCase();
    if (unit.startsWith('h')) return amount * 3_600_000;
    if (unit.startsWith('m') && unit !== 's') return amount * 60_000;
    return amount * 1000;
  }

  // Last, because a relative wait the API stated outright is more reliable than
  // a wall clock we have to resolve against a timezone.
  return parseResetAt(text, { now, timeZone });
}

/**
 * Classifies a failed agent outcome.
 *
 * `outcome` is what invokeAgent returns; `envelope` is optional extra structure
 * when the caller has it.
 */
export function classifyFailure(outcome, { envelope = null, now = Date.now(), timeZone = null } = {}) {
  const code = outcome?.error?.code ?? null;
  const message = outcome?.error?.message ?? '';

  // Structured first: our own codes are unambiguous.
  let reason = code ? CODE_MAP[code] ?? null : null;

  // The CLI names this one in the envelope, so it never has to be matched out
  // of prose: `--max-turns` ends the loop with `subtype: "error_max_turns"`,
  // `is_error: true`, an empty `result` and exit 1. Measured, not assumed.
  // Checked before the text patterns because "Reached maximum number of turns"
  // otherwise falls through to UNKNOWN_FATAL, which escalates to a human — and
  // a budget the operator set is not something a human needs to resolve.
  if (!reason && envelope?.subtype === 'error_max_turns') {
    reason = CAPACITY_REASONS.TURN_BUDGET_EXHAUSTED;
  }

  // NON_ZERO_EXIT carries the CLI's own message, which is where API causes live.
  if (!reason) {
    const haystack = [message, envelope?.result, envelope?.terminal_reason]
      .filter((v) => typeof v === 'string')
      .join(' ');

    for (const [candidate, pattern] of TEXT_PATTERNS) {
      if (pattern.test(haystack)) {
        reason = candidate;
        break;
      }
    }
  }

  if (!reason) reason = CAPACITY_REASONS.UNKNOWN_FATAL;

  return {
    reason,
    code,
    retryAfterMs: extractRetryAfterMs(message, { now, timeZone })
      ?? extractRetryAfterMs(envelope, { now, timeZone }),
    // Kept only for debugging; scrubbed and truncated.
    diagnostic: sanitizeDiagnostic(message),
  };
}
