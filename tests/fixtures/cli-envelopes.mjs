/**
 * Fixtures reproducing the shapes the Claude Code CLI actually emits.
 *
 * These are not invented. Every field name, nesting level and optionality below
 * was read off the installed CLI's own embedded event schema (Claude Code
 * 2.1.263) during the audit for the usage ledger — including the two semantics
 * that decide whether the ledger double-counts:
 *
 *   thinkingTokens is documented as "already counted inside outputTokens";
 *   the top-level `usage` is documented as MAIN AGENT LOOP ONLY, with
 *   `modelUsage` named as the correct field for token/cost accounting.
 *
 * Nothing here makes a real model call, and no test built on these does.
 */

export const OPUS = 'claude-opus-5';
export const FABLE = 'claude-fable-5-1';
export const SONNET = 'claude-sonnet-5';
export const HAIKU = 'claude-haiku-4-5-20251001';

/** One `modelUsage` entry, camelCase, as the CLI returns it. */
export function modelUsageEntry({
  input = 0, output = 0, thinking = null, cacheRead = 0, cacheCreation = 0,
  webSearch = 0, costUSD = 0, contextWindow = 200_000, maxOutputTokens = 64_000,
  canonicalModel = null, provider = 'firstParty', costBasis = 'list',
} = {}) {
  const entry = {
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
    webSearchRequests: webSearch,
    costUSD,
    contextWindow,
    maxOutputTokens,
    provider,
    costBasis,
  };
  // Optional by contract: absent when no turn ran on a CLI that records it.
  if (thinking !== null) entry.thinkingTokens = thinking;
  if (canonicalModel !== null) entry.canonicalModel = canonicalModel;
  return entry;
}

/** The top-level `usage`, snake_case, in the Messages-API shape. */
export function topLevelUsage({
  input = 0, output = 0, thinking = null, cacheRead = 0, cacheCreation = 0,
  ephemeral5m = null, ephemeral1h = null, webSearch = 0,
} = {}) {
  const usage = {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
    server_tool_use: { web_search_requests: webSearch, web_fetch_requests: 0 },
    service_tier: 'standard',
  };
  if (thinking !== null) usage.output_tokens_details = { thinking_tokens: thinking };
  if (ephemeral5m !== null || ephemeral1h !== null) {
    usage.cache_creation = {
      ephemeral_5m_input_tokens: ephemeral5m ?? 0,
      ephemeral_1h_input_tokens: ephemeral1h ?? 0,
    };
  }
  return usage;
}

/** A successful `result` event. */
export function successResult({
  model = OPUS,
  payload = { protocolVersion: 2, role: 'developer', ok: true },
  usage = topLevelUsage({ input: 120, output: 340, cacheRead: 8000, cacheCreation: 2000 }),
  models = null,
  cost = 0.4212,
  numTurns = 7,
  durationMs = 61_000,
  durationApiMs = 54_000,
  sessionId = 'session-1',
  stopReason = 'end_turn',
  permissionDenials = [],
  extra = {},
} = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: durationMs,
    duration_api_ms: durationApiMs,
    num_turns: numTurns,
    stop_reason: stopReason,
    total_cost_usd: cost,
    usage,
    modelUsage: models ?? {
      [model]: modelUsageEntry({
        input: usage.input_tokens,
        output: usage.output_tokens,
        thinking: usage.output_tokens_details?.thinking_tokens ?? null,
        cacheRead: usage.cache_read_input_tokens,
        cacheCreation: usage.cache_creation_input_tokens,
        costUSD: cost,
        canonicalModel: model,
      }),
    },
    permission_denials: permissionDenials,
    result: JSON.stringify(payload),
    uuid: 'result-uuid-1',
    session_id: sessionId,
    ...extra,
  };
}

/** An error `result` event, in one of the CLI's four error subtypes. */
export function errorResult({
  subtype = 'error_during_execution',
  errors = ['something went wrong'],
  usage = topLevelUsage(),
  models = {},
  cost = 0,
  numTurns = 0,
  stopReason = null,
  extra = {},
} = {}) {
  return {
    type: 'result',
    subtype,
    is_error: true,
    duration_ms: 1200,
    duration_api_ms: 800,
    num_turns: numTurns,
    stop_reason: stopReason,
    total_cost_usd: cost,
    usage,
    modelUsage: models,
    permission_denials: [],
    errors,
    uuid: 'result-uuid-err',
    session_id: 'session-err',
    ...extra,
  };
}

/**
 * Renders a stream: an init event, one assistant turn per tool call, the
 * matching tool results, then the result envelope. Exactly the ordering the
 * CLI produces with `--output-format stream-json`.
 */
export function streamOf({ model = OPUS, tools = [], result, sessionId = 'session-1' } = {}) {
  const lines = [
    { type: 'system', subtype: 'init', session_id: sessionId, model },
    // Every assistant turn the CLI emits carries `message.model`, and that is
    // the only explicit evidence of which model actually served the call. A
    // stream without one is not a shape the CLI produces.
    { type: 'assistant', message: { model, content: [{ type: 'text', text: 'working' }] } },
  ];
  tools.forEach((tool, index) => {
    lines.push({
      type: 'assistant',
      message: {
        model,
        content: [{ type: 'tool_use', id: `tool-${index}`, name: tool.name, input: tool.input ?? {} }],
      },
    });
    lines.push({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: `tool-${index}`, is_error: tool.isError === true }],
      },
    });
  });
  if (result) lines.push(result);
  return lines.map((line) => JSON.stringify(line)).join('\n');
}
