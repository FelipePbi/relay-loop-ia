/**
 * IA Loop — turning one finished CLI invocation into one ledger row.
 *
 * Pure functions only: no I/O, no clock, no model. Everything below is either
 * copied from a field the Claude CLI already returned, tallied from events the
 * stream already emitted, or read off the ia-loop's own state. Nothing is
 * asked of a model, and nothing is guessed — a value we cannot establish is
 * null, and a sub-phase we cannot prove is UNKNOWN.
 *
 * What the runtime actually gives us (Claude Code 2.1.263, confirmed against
 * the CLI's own embedded event schema, not against a guess):
 *
 *   result envelope    duration_ms, duration_api_ms, ttft_ms?, is_error,
 *                      api_error_status?, num_turns, stop_reason,
 *                      total_cost_usd, usage, modelUsage, permission_denials,
 *                      terminal_reason?, subtype, uuid, session_id
 *
 *   usage              the raw Messages-API shape — input_tokens,
 *                      output_tokens, output_tokens_details.thinking_tokens,
 *                      cache_read_input_tokens, cache_creation_input_tokens,
 *                      cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens,
 *                      server_tool_use.*, service_tier. The CLI documents it as
 *                      MAIN AGENT LOOP ONLY: it excludes Task subagents,
 *                      sidechains and auxiliary calls.
 *
 *   modelUsage[model]  inputTokens, outputTokens, thinkingTokens?,
 *                      cacheReadInputTokens, cacheCreationInputTokens,
 *                      webSearchRequests, costUSD, contextWindow,
 *                      maxOutputTokens, canonicalModel?, provider?, costBasis?
 *                      The CLI names this the correct field for token/cost
 *                      accounting, which is why it is preferred here.
 *
 * Two semantics worth stating, because getting them wrong would double-count:
 *
 *   thinkingTokens is ALREADY INSIDE outputTokens (the CLI says so in the
 *   field's own description). Both are stored as returned; `total_tokens`
 *   never adds thinking on top.
 *
 *   input_tokens is the UNCACHED input. Cache reads and cache writes are
 *   reported beside it, not inside it, so the total is a sum of the four.
 */

import { classifyFailure, CAPACITY_REASONS } from './capacity-classifier.mjs';
import { familyFor } from './failure-taxonomy.mjs';
import { redactSecrets } from './telemetry.mjs';
import { operationForStage, UNKNOWN_PHASE, USAGE_OPERATIONS } from './usage-context.mjs';

/** Ledger schema this normalizer writes for. Bumped with any column change. */
/**
 * v1 -> v2: added `invocation_id`, the identity of one real model call.
 *
 * v1's uniqueness was role+job+attempt, which the ia-loop's own repair path
 * (ia-loop:reclassify + ia-loop:resume, which re-runs a failed attempt under
 * its ORIGINAL attemptId by design) can legitimately produce twice for two
 * different real calls — the second one collided with the first and was
 * silently discarded as an "already recorded" duplicate. v2's uniqueness is
 * the call itself, minted before the CLI is spawned; role/job/attempt remain
 * on every row for correlation, just no longer serving as the key.
 */
export const SCHEMA_VERSION = 2;

/** Bumped whenever the MEANING of a normalized field changes. */
export const COLLECTOR_VERSION = '2.0.0';

/** Hard cap on any single preserved raw payload, so a ledger cannot grow without bound. */
export const MAX_RAW_JSON_BYTES = 128 * 1024;

/** Terminal statuses a ledger row can hold. */
export const EXECUTION_STATUSES = Object.freeze({
  /** Written before the process is spawned; finalised afterwards. */
  STARTED: 'STARTED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
});

// ---------------------------------------------------------------------------
// Sanitisation
// ---------------------------------------------------------------------------

/**
 * Keys dropped from a preserved payload outright.
 *
 * Two reasons, kept apart deliberately. `result` and `structured_output` are
 * the model's own answer: heavy, and already persisted verbatim under
 * `.state/results/`, so copying them here would make the ledger a second
 * transcript rather than a ledger. The rest are credential-shaped names that
 * must never reach disk regardless of how they got into the payload.
 */
const DROPPED_KEYS = Object.freeze(new Set([
  'result',
  'structured_output',
  'deferred_tool_use',
  'errors',
]));

const SECRET_KEY = /(pass(wo?rd|wd)|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|cookie|authorization|session[_-]?key|auth)/i;

/**
 * Keys that merely COUNT tokens, which the pattern above would otherwise treat
 * as credentials.
 *
 * `inputTokens`, `output_tokens`, `cache_read_input_tokens` and
 * `maxOutputTokens` all contain "token"; redacting them would erase the exact
 * numbers this ledger exists to hold. A credential is never a token *count*,
 * and — see below — never a number at all.
 */
const TOKEN_COUNT_KEY = /tokens$/i;

/** True only where a value under this key could actually be a credential. */
function isSecretKey(key, value) {
  // A number or a boolean is not a secret, whatever it is called. This alone
  // saves every usage counter; the name check below is the second line.
  if (typeof value !== 'string') return false;
  if (TOKEN_COUNT_KEY.test(key)) return false;
  return SECRET_KEY.test(key);
}

/**
 * Deep-sanitises an arbitrary payload before it is preserved.
 *
 * Three passes, in this order: drop the heavy/answer keys, redact any value
 * under a credential-shaped key, then run every remaining string through the
 * SAME redaction table the terminal telemetry uses. A secret that arrives in an
 * unexpected place is still caught by the third pass.
 */
export function sanitizePayload(value, { depth = 0 } = {}) {
  if (depth > 12) return '«depth-limited»';
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizePayload(item, { depth: depth + 1 }));
  if (typeof value !== 'object') return String(value);

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (DROPPED_KEYS.has(key)) continue;
    if (isSecretKey(key, item)) {
      out[key] = '«redacted»';
      continue;
    }
    out[key] = sanitizePayload(item, { depth: depth + 1 });
  }
  return out;
}

/**
 * Serialises a sanitized payload, refusing to store one that is too large.
 *
 * A truncated JSON string is not a JSON document, so an oversized payload is
 * replaced by a marker naming its size rather than silently mangled.
 */
export function serializeRaw(value, { maxBytes = MAX_RAW_JSON_BYTES } = {}) {
  if (value === null || value === undefined) return null;
  let text;
  try {
    text = JSON.stringify(sanitizePayload(value));
  } catch {
    return JSON.stringify({ omitted: 'UNSERIALIZABLE' });
  }
  if (typeof text !== 'string') return null;
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    return JSON.stringify({ omitted: 'OVERSIZED', bytes: Buffer.byteLength(text, 'utf8'), maxBytes });
  }
  return text;
}

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

function int(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sum(values) {
  const present = values.filter((value) => value !== null);
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0);
}

/** One `modelUsage` entry, in the camelCase shape the CLI returns. */
export function tokensFromModelUsage(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    inputTokens: int(entry.inputTokens) ?? 0,
    outputTokens: int(entry.outputTokens) ?? 0,
    // Optional by contract: absent when no turn ran on a CLI recording it.
    thinkingTokens: int(entry.thinkingTokens),
    cacheReadTokens: int(entry.cacheReadInputTokens) ?? 0,
    cacheCreationTokens: int(entry.cacheCreationInputTokens) ?? 0,
    cacheCreationEphemeral5m: null,
    cacheCreationEphemeral1h: null,
    webSearchRequests: int(entry.webSearchRequests),
    costUsd: num(entry.costUSD),
    contextWindow: int(entry.contextWindow),
    maxOutputTokens: int(entry.maxOutputTokens),
    canonicalModel: typeof entry.canonicalModel === 'string' ? entry.canonicalModel : null,
    provider: typeof entry.provider === 'string' ? entry.provider : null,
    costBasis: typeof entry.costBasis === 'string' ? entry.costBasis : null,
  };
}

/** The top-level `usage`, in the snake_case Messages-API shape. */
export function tokensFromTopLevelUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    inputTokens: int(usage.input_tokens) ?? 0,
    outputTokens: int(usage.output_tokens) ?? 0,
    thinkingTokens: int(usage.output_tokens_details?.thinking_tokens),
    cacheReadTokens: int(usage.cache_read_input_tokens) ?? 0,
    cacheCreationTokens: int(usage.cache_creation_input_tokens) ?? 0,
    cacheCreationEphemeral5m: int(usage.cache_creation?.ephemeral_5m_input_tokens),
    cacheCreationEphemeral1h: int(usage.cache_creation?.ephemeral_1h_input_tokens),
    webSearchRequests: int(usage.server_tool_use?.web_search_requests),
    costUsd: null,
    contextWindow: null,
    maxOutputTokens: null,
    canonicalModel: null,
    provider: null,
    costBasis: null,
  };
}

const EMPTY_TOKENS = Object.freeze({
  inputTokens: null,
  outputTokens: null,
  thinkingTokens: null,
  cacheReadTokens: null,
  cacheCreationTokens: null,
  cacheCreationEphemeral5m: null,
  cacheCreationEphemeral1h: null,
  webSearchRequests: null,
  costUsd: null,
  contextWindow: null,
  maxOutputTokens: null,
  canonicalModel: null,
  provider: null,
  costBasis: null,
});

/**
 * Chooses which usage figures describe THE model this execution was routed to.
 *
 * `modelUsage` is the CLI's own recommended accounting field and is keyed by
 * model, so when the served model is known it answers exactly the question the
 * ledger asks. The fallbacks are ordered by how much they can be trusted:
 *
 *   SERVED_MODEL_USAGE   modelUsage[the model the stream said answered]
 *   SOLE_MODEL_USAGE     modelUsage had exactly one entry, so there is no
 *                        ambiguity about whose tokens those are
 *   TOP_LEVEL_USAGE      no usable modelUsage; the main-loop `usage` is what
 *                        is left, and it excludes subagents by contract
 *   NONE                 the envelope carried no usage at all
 *
 * The auxiliary entries are never merged into the primary: a Haiku helper call
 * billed inside an Opus review is a real cost, and hiding it inside the review's
 * own numbers would make the per-model question unanswerable.
 */
export function selectUsage({ envelope, servedModel = null } = {}) {
  const modelUsage = envelope?.modelUsage;
  const entries = modelUsage && typeof modelUsage === 'object' && !Array.isArray(modelUsage)
    ? Object.entries(modelUsage)
    : [];

  let source = 'NONE';
  let primaryModel = null;
  let primary = null;

  if (servedModel && entries.some(([model]) => model === servedModel)) {
    source = 'SERVED_MODEL_USAGE';
    primaryModel = servedModel;
    primary = tokensFromModelUsage(modelUsage[servedModel]);
  } else if (entries.length === 1) {
    source = 'SOLE_MODEL_USAGE';
    primaryModel = entries[0][0];
    primary = tokensFromModelUsage(entries[0][1]);
  } else if (envelope?.usage) {
    source = 'TOP_LEVEL_USAGE';
    primary = tokensFromTopLevelUsage(envelope.usage);
  }

  // The ephemeral cache split only ever exists on the top-level usage, so it is
  // carried across when the primary figures came from modelUsage. It describes
  // the same main-loop call, and losing it would drop the only breakdown of
  // WHICH cache tier was written.
  if (primary && source !== 'TOP_LEVEL_USAGE' && envelope?.usage) {
    const top = tokensFromTopLevelUsage(envelope.usage);
    primary = {
      ...primary,
      cacheCreationEphemeral5m: top?.cacheCreationEphemeral5m ?? null,
      cacheCreationEphemeral1h: top?.cacheCreationEphemeral1h ?? null,
      thinkingTokens: primary.thinkingTokens ?? top?.thinkingTokens ?? null,
    };
  }

  const auxiliary = entries
    .filter(([model]) => model !== primaryModel)
    .map(([model, entry]) => ({ model, ...tokensFromModelUsage(entry) }));

  return { source, primaryModel, primary: primary ?? { ...EMPTY_TOKENS }, auxiliary };
}

/**
 * Total tokens, when the breakdown supports one.
 *
 * Deliberately NOT input + output alone, and deliberately NOT including
 * thinking: cache reads and cache writes are real tokens billed separately from
 * `input_tokens`, and thinking is already counted inside `output_tokens`.
 */
export function totalTokensOf(tokens) {
  return sum([
    tokens?.inputTokens ?? null,
    tokens?.outputTokens ?? null,
    tokens?.cacheReadTokens ?? null,
    tokens?.cacheCreationTokens ?? null,
  ]);
}

// ---------------------------------------------------------------------------
// Result semantics
// ---------------------------------------------------------------------------

/**
 * Whether the model was actually reached.
 *
 * True only on positive evidence: the CLI reported an assistant turn, or the
 * envelope accounts for tokens. A local failure before any inference — bad CLI
 * arguments, a missing executable, a harness validation error — leaves this
 * false with zero tokens, which is what makes "tooling failure that cost
 * nothing" distinguishable from "attempt that burned tokens and failed".
 */
export function inferModelCallStarted({ counters, tokens, envelope }) {
  if ((counters?.assistantMessages ?? 0) > 0) return true;
  if ((totalTokensOf(tokens) ?? 0) > 0) return true;
  if (num(envelope?.total_cost_usd) > 0) return true;
  return false;
}

/**
 * Classifies a failed execution using the ia-loop's OWN taxonomy.
 *
 * `classifyFailure` and `familyFor` are the same deterministic functions the
 * capacity runner uses moments later, called here on the same outcome, so the
 * ledger and the event log can never disagree about why a call failed. This is
 * not a second taxonomy; it is the existing one, read twice.
 */
export function classifyExecution(outcome) {
  if (!outcome?.error) return { reason: null, code: null, family: null };
  const classification = classifyFailure(outcome);
  return {
    reason: classification.reason,
    code: classification.code,
    family: familyFor({ code: classification.code, reason: classification.reason }),
    diagnostic: classification.diagnostic ?? null,
  };
}

/**
 * Impossible states, recorded rather than thrown.
 *
 * A ledger that refuses a row because a duration came back negative loses the
 * tokens that row was carrying. Flagging is strictly better: the numbers are
 * kept and the inconsistency is visible.
 */
export function integrityFlagsFor(record) {
  const flags = [];
  const negative = [
    'inputTokens', 'outputTokens', 'thinkingTokens', 'cacheReadTokens',
    'cacheCreationTokens', 'numTurns', 'durationMs', 'durationApiMs',
  ].filter((field) => Number.isFinite(record[field]) && record[field] < 0);
  if (negative.length > 0) flags.push(`NEGATIVE_COUNT:${negative.join(',')}`);

  if (record.startedAt && record.finishedAt && record.finishedAt < record.startedAt) {
    flags.push('FINISHED_BEFORE_STARTED');
  }
  if (record.modelCallStarted && !record.resolvedModel && !record.rawModelPresent) {
    flags.push('UNKNOWN_MODEL_WITH_USAGE');
  }
  if (record.thinkingTokens !== null && record.outputTokens !== null
    && record.thinkingTokens > record.outputTokens) {
    // The CLI documents thinking as contained in output. A value that breaks
    // that is either a CLI change or a parsing bug, and either is worth seeing.
    flags.push('THINKING_EXCEEDS_OUTPUT');
  }
  if (!record.modelCallStarted && (totalTokensOf(record) ?? 0) > 0) {
    flags.push('TOKENS_WITHOUT_MODEL_CALL');
  }
  return flags;
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

/**
 * Builds the identity half of a row from the ambient ia-loop context.
 *
 * Every field is an id the state machine already owns. Nothing is minted here:
 * an id the harness does not have is null, exactly as §8 of the Goal requires.
 */
export function identityFrom(context = {}) {
  const stage = context.stage ?? null;
  return {
    projectId: context.projectId ?? null,
    runId: context.runId ?? null,
    goalId: context.goalId ?? null,
    roundId: Number.isFinite(context.roundId) ? context.roundId : null,
    stageId: stage,
    jobId: context.jobId ?? null,
    attemptId: context.attemptId ?? null,
    attempt: Number.isFinite(context.attempt) ? context.attempt : null,
    workUnitId: context.workUnitId ?? null,
    role: context.role ?? null,
    operation: context.operation ?? operationForStage(stage),
    stage,
    // Never inferred. See USAGE_PHASES: no worker can currently prove a
    // sub-phase, so claiming one would be fabricated data.
    phase: context.phase ?? UNKNOWN_PHASE,
  };
}

/**
 * The whole row, from the ia-loop context plus one finished CLI invocation.
 *
 * `capture` is what `invokeAgent` observed and nothing more: the arguments it
 * was given, the envelope the CLI printed, the tallies the stream parser kept,
 * and the wall-clock boundaries of the child process.
 */
export function buildUsageRecord({ context = {}, capture = {} } = {}) {
  const envelope = capture.envelope ?? null;
  const counters = capture.counters ?? null;
  const servedModel = capture.resolvedPrimaryModel ?? null;
  const usage = selectUsage({ envelope, servedModel });
  const identity = identityFrom(context);
  const classification = classifyExecution(capture);

  const tokens = usage.primary;
  const modelCallStarted = inferModelCallStarted({ counters, tokens, envelope });

  const failed = Boolean(capture.error) || capture.structuredOutput !== true;

  const record = {
    ...identity,
    // The identity of THIS invocation, distinct from attemptId. Generated by
    // the collector before the spawn (see usage-collector.mjs) and never
    // derived from job/attempt/session: those can legitimately repeat across
    // TWO real, separate model calls — a job repaired by ia-loop:reclassify
    // and requeued by ia-loop:resume is re-run under the SAME attemptId by
    // harness design (see README V21/V22) — and a key built from them would
    // make the second real call collide with the first and be silently
    // discarded as an ALREADY_RECORDED duplicate, exactly as it did before
    // this field existed. A fresh random id can never do that.
    invocationId: capture.invocationId ?? null,

    // --- model -----------------------------------------------------------
    provider: tokens.provider ?? null,
    modelKey: context.modelKey ?? null,
    modelFamily: context.modelFamily ?? null,
    requestedModel: capture.requestedModel ?? context.requestedModel ?? null,
    resolvedModel: servedModel ?? usage.primaryModel ?? null,
    canonicalModel: tokens.canonicalModel ?? null,
    effort: capture.requestedEffort ?? context.effort ?? null,
    observedModels: Array.isArray(capture.observedModels) ? [...capture.observedModels] : [],
    auxiliaryModels: Array.isArray(capture.auxiliaryModels) ? [...capture.auxiliaryModels] : [],

    // --- routing ---------------------------------------------------------
    complexity: context.complexity ?? null,
    riskScore: Number.isFinite(context.riskScore) ? context.riskScore : null,
    routingReason: context.routingReason ?? null,
    routingSignals: Array.isArray(context.routingSignals) ? [...context.routingSignals] : [],
    routingMode: context.routingMode ?? null,
    isFallback: context.isFallback === true,
    fallbackFromModel: context.fallbackFromModel ?? null,
    fallbackReason: context.fallbackReason ?? null,
    isEscalation: context.isEscalation === true,
    escalationFromModel: context.escalationFromModel ?? null,
    escalationReason: context.escalationReason ?? null,
    manualOverride: context.manualOverride ?? null,

    // --- lifecycle / result ----------------------------------------------
    status: failed ? EXECUTION_STATUSES.FAILED : EXECUTION_STATUSES.COMPLETED,
    modelCallStarted,
    resultType: envelope?.subtype ?? null,
    stopReason: envelope?.stop_reason ?? null,
    exitCode: int(capture.exitCode),
    timedOut: capture.timedOut === true,
    isError: envelope ? envelope.is_error === true : null,
    apiErrorStatus: int(envelope?.api_error_status),
    terminalReason: typeof envelope?.terminal_reason === 'string' ? envelope.terminal_reason : null,
    failureCode: capture.error?.code ?? null,
    failureReason: classification.reason,
    failureFamily: classification.family,
    failureDiagnostic: classification.diagnostic ?? null,
    structuredOutput: capture.structuredOutput === true,
    hasCandidatePayload: capture.hasCandidatePayload === true,
    // Semantic outcome is filled in only where the ia-loop already knows it
    // deterministically; nothing here judges an execution good or wasteful.
    outcome: context.outcome ?? null,

    // --- tokens ----------------------------------------------------------
    usageSource: usage.source,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    thinkingTokens: tokens.thinkingTokens,
    cacheReadTokens: tokens.cacheReadTokens,
    cacheCreationTokens: tokens.cacheCreationTokens,
    cacheCreationEphemeral5m: tokens.cacheCreationEphemeral5m,
    cacheCreationEphemeral1h: tokens.cacheCreationEphemeral1h,
    // The Messages API reports uncached input under `input_tokens`; cache reads
    // and writes are counted beside it, never inside it.
    uncachedInputTokens: tokens.inputTokens,
    webSearchRequests: tokens.webSearchRequests,
    contextWindow: tokens.contextWindow,
    maxOutputTokens: tokens.maxOutputTokens,
    totalTokens: totalTokensOf(tokens),

    // --- turns / tools ---------------------------------------------------
    numTurns: int(envelope?.num_turns),
    assistantMessages: int(counters?.assistantMessages),
    userMessages: int(counters?.userMessages),
    streamEvents: int(counters?.streamEvents),
    toolCallCount: int(counters?.toolCallCount),
    toolResultEvents: int(counters?.toolResultEvents),
    toolErrorEvents: int(counters?.toolErrorEvents),
    permissionDenials: Array.isArray(envelope?.permission_denials) ? envelope.permission_denials.length : null,
    queuedTurnCount: int(envelope?.queued_turn_count),

    // --- timing ----------------------------------------------------------
    startedAt: capture.startedAt ?? null,
    finishedAt: capture.finishedAt ?? null,
    durationMs: int(capture.durationMs),
    // The CLI's own two figures, kept apart from ours: `duration_ms` is the
    // query's, `duration_api_ms` the time actually spent in API calls, and our
    // wall clock includes process startup neither of them sees.
    cliDurationMs: int(envelope?.duration_ms),
    durationApiMs: int(envelope?.duration_api_ms),
    ttftMs: int(envelope?.ttft_ms),

    // --- session ---------------------------------------------------------
    sessionId: capture.sessionId ?? envelope?.session_id ?? null,
    resumeSessionId: capture.resumed === true ? (capture.sessionId ?? null) : null,
    resultUuid: typeof envelope?.uuid === 'string' ? envelope.uuid : null,
    envelopeSessionId: typeof envelope?.session_id === 'string' ? envelope.session_id : null,

    // --- cost ------------------------------------------------------------
    // Stored exactly as received. The CLI calls it an estimate, not an invoice,
    // and this Goal deliberately does no economics with it.
    providerReportedCostUsd: num(envelope?.total_cost_usd),
    primaryModelCostUsd: tokens.costUsd,
    costBasis: tokens.costBasis,

    // --- raw -------------------------------------------------------------
    rawResultJson: serializeRaw(envelope),
    rawUsageJson: serializeRaw(envelope?.usage ?? null),
    rawModelUsageJson: serializeRaw(envelope?.modelUsage ?? null),
    auxiliaryUsageJson: usage.auxiliary.length > 0 ? serializeRaw(usage.auxiliary) : null,
    toolCallsJson: counters?.toolCalls?.length ? serializeRaw(counters.toolCalls) : null,
    streamTypesJson: counters?.byType ? serializeRaw(counters.byType) : null,

    rawModelPresent: Boolean(envelope?.modelUsage && Object.keys(envelope.modelUsage).length > 0),
  };

  record.integrityFlags = integrityFlagsFor(record);
  return record;
}

export { CAPACITY_REASONS, USAGE_OPERATIONS };
