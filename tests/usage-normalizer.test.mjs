/**
 * Unit tests for usage normalisation.
 *
 * Every fixture is a shape the installed CLI actually produces; no test here
 * spawns anything or calls a model. These cover what the ledger is FOR: that a
 * token breakdown survives intact, that thinking is never added on top of
 * output, that a failure keeps whatever usage it managed to produce, and that a
 * credential can never reach the preserved payload.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildUsageRecord,
  integrityFlagsFor,
  inferModelCallStarted,
  sanitizePayload,
  selectUsage,
  serializeRaw,
  tokensFromModelUsage,
  tokensFromTopLevelUsage,
  totalTokensOf,
  MAX_RAW_JSON_BYTES,
} from '../lib/usage-normalizer.mjs';
import {
  FABLE, HAIKU, OPUS,
  errorResult, modelUsageEntry, successResult, topLevelUsage,
} from './fixtures/cli-envelopes.mjs';

const CONTEXT = Object.freeze({
  goalId: '008',
  roundId: 2,
  jobId: '008-r2-developer-abc',
  attemptId: '008-r2-developer-abc#a1',
  attempt: 1,
  role: 'developer',
  stage: 'implementation',
  modelKey: 'opus',
  modelFamily: 'opus',
});

function record(envelope, extra = {}) {
  return buildUsageRecord({
    context: CONTEXT,
    capture: {
      requestedModel: OPUS,
      requestedEffort: 'high',
      sessionId: 'session-1',
      startedAt: '2026-09-09T10:00:00.000Z',
      finishedAt: '2026-09-09T10:01:00.000Z',
      durationMs: 60_000,
      exitCode: 0,
      envelope,
      structuredOutput: true,
      resolvedPrimaryModel: OPUS,
      counters: { assistantMessages: 3, toolCallCount: 2, toolResultEvents: 2, streamEvents: 9 },
      ...extra,
    },
  });
}

// --- a normal completed result --------------------------------------------

test('a completed result keeps every token category the CLI reported', () => {
  const row = record(successResult({
    usage: topLevelUsage({ input: 120, output: 340, cacheRead: 8000, cacheCreation: 2000, ephemeral5m: 2000 }),
  }));

  assert.equal(row.status, 'COMPLETED');
  assert.equal(row.inputTokens, 120);
  assert.equal(row.outputTokens, 340);
  assert.equal(row.cacheReadTokens, 8000);
  assert.equal(row.cacheCreationTokens, 2000);
  assert.equal(row.cacheCreationEphemeral5m, 2000);
  assert.equal(row.numTurns, 7);
  assert.equal(row.stopReason, 'end_turn');
  assert.equal(row.resolvedModel, OPUS);
  assert.equal(row.usageSource, 'SERVED_MODEL_USAGE');
});

test('total_tokens sums the four billed categories and never adds thinking on top', () => {
  const row = record(successResult({
    usage: topLevelUsage({ input: 100, output: 50, thinking: 30, cacheRead: 900, cacheCreation: 300 }),
  }));

  assert.equal(row.thinkingTokens, 30);
  // 100 + 50 + 900 + 300. The 30 thinking tokens are INSIDE the 50 output ones,
  // which is exactly why adding them would be a fabrication.
  assert.equal(row.totalTokens, 1350);
});

test('uncached input is the API input figure, with cache reported beside it', () => {
  const row = record(successResult({
    usage: topLevelUsage({ input: 120, output: 10, cacheRead: 5000, cacheCreation: 100 }),
  }));
  assert.equal(row.uncachedInputTokens, 120);
  assert.equal(row.inputTokens, 120);
});

test('usage without thinking leaves the field null rather than zero', () => {
  const row = record(successResult({ usage: topLevelUsage({ input: 5, output: 5 }) }));
  assert.equal(row.thinkingTokens, null);
});

test('usage with cache keeps the ephemeral 5m/1h split', () => {
  const row = record(successResult({
    usage: topLevelUsage({ input: 1, output: 1, cacheCreation: 700, ephemeral5m: 500, ephemeral1h: 200 }),
  }));
  assert.equal(row.cacheCreationEphemeral5m, 500);
  assert.equal(row.cacheCreationEphemeral1h, 200);
});

test('a result without cost stores null, never zero', () => {
  const envelope = successResult();
  delete envelope.total_cost_usd;
  assert.equal(record(envelope).providerReportedCostUsd, null);
});

test('session ids are captured from both the request and the envelope', () => {
  const row = record(successResult({ sessionId: 'cli-session-9' }), { resumed: true });
  assert.equal(row.sessionId, 'session-1');
  assert.equal(row.envelopeSessionId, 'cli-session-9');
  assert.equal(row.resumeSessionId, 'session-1');
});

test('multiple turns are recorded as the CLI counted them', () => {
  assert.equal(record(successResult({ numTurns: 23 })).numTurns, 23);
});

// --- auxiliary models ------------------------------------------------------

test('an auxiliary model is kept apart from the model the call was routed to', () => {
  const envelope = successResult({
    models: {
      [OPUS]: modelUsageEntry({ input: 100, output: 200, costUSD: 0.4 }),
      [HAIKU]: modelUsageEntry({ input: 10, output: 5, costUSD: 0.001 }),
    },
  });
  const row = record(envelope);

  assert.equal(row.inputTokens, 100, 'the primary figures are the routed model, not a sum');
  const auxiliary = JSON.parse(row.auxiliaryUsageJson);
  assert.equal(auxiliary.length, 1);
  assert.equal(auxiliary[0].model, HAIKU);
  assert.equal(auxiliary[0].inputTokens, 10);
});

test('a sole modelUsage entry is used even when the served model is unknown', () => {
  const selection = selectUsage({
    envelope: successResult({ model: FABLE }),
    servedModel: null,
  });
  assert.equal(selection.source, 'SOLE_MODEL_USAGE');
  assert.equal(selection.primaryModel, FABLE);
});

test('with no usable modelUsage the main-loop usage is used and labelled as such', () => {
  const envelope = successResult({ models: {} });
  const selection = selectUsage({ envelope, servedModel: null });
  assert.equal(selection.source, 'TOP_LEVEL_USAGE');
  assert.equal(selection.primary.inputTokens, envelope.usage.input_tokens);
});

test('an envelope with no usage at all reports NONE and nulls, not zeros', () => {
  const selection = selectUsage({ envelope: { type: 'result' }, servedModel: null });
  assert.equal(selection.source, 'NONE');
  assert.equal(selection.primary.inputTokens, null);
  assert.equal(totalTokensOf(selection.primary), null);
});

// --- failures --------------------------------------------------------------

test('a usage limit keeps the partial usage the attempt already spent', () => {
  const row = record(
    errorResult({
      subtype: 'error_during_execution',
      usage: topLevelUsage({ input: 4000, output: 120 }),
      models: { [OPUS]: modelUsageEntry({ input: 4000, output: 120, costUSD: 0.09 }) },
      cost: 0.09,
    }),
    {
      structuredOutput: false,
      error: { code: 'NON_ZERO_EXIT', message: 'Claude usage limit reached. Your limit will reset at 3pm.' },
    },
  );

  assert.equal(row.status, 'FAILED');
  assert.equal(row.failureReason, 'USAGE_LIMIT');
  assert.equal(row.failureFamily, 'MODEL_CAPACITY');
  assert.equal(row.inputTokens, 4000, 'consumption is not discarded because the attempt failed');
  assert.equal(row.modelCallStarted, true);
});

test('a rate limit is classified by the same taxonomy the capacity runner uses', () => {
  const row = record(errorResult(), {
    structuredOutput: false,
    error: { code: 'NON_ZERO_EXIT', message: 'API Error: 429 rate_limit_error' },
  });
  assert.equal(row.failureReason, 'RATE_LIMIT');
  assert.equal(row.failureFamily, 'MODEL_CAPACITY');
});

test('a model that is not there is MODEL_UNAVAILABLE, not a capacity limit', () => {
  const row = record(errorResult(), {
    structuredOutput: false,
    error: { code: 'NON_ZERO_EXIT', message: 'model_not_found: unknown model' },
  });
  assert.equal(row.failureReason, 'MODEL_UNAVAILABLE');
});

test('an auth failure is recorded as AUTH_ERROR', () => {
  const row = record(errorResult(), {
    structuredOutput: false,
    error: { code: 'NON_ZERO_EXIT', message: 'Invalid API key · Please run /login' },
  });
  assert.equal(row.failureReason, 'AUTH_ERROR');
});

test('a harness failure before any inference records zero tokens and no model call', () => {
  const row = buildUsageRecord({
    context: CONTEXT,
    capture: {
      requestedModel: OPUS,
      sessionId: 'session-1',
      startedAt: '2026-09-09T10:00:00.000Z',
      finishedAt: '2026-09-09T10:00:00.100Z',
      durationMs: 100,
      envelope: null,
      counters: { assistantMessages: 0, streamEvents: 0 },
      structuredOutput: false,
      error: { code: 'EXECUTABLE_NOT_FOUND', message: 'no claude on PATH' },
    },
  });

  assert.equal(row.status, 'FAILED');
  assert.equal(row.failureFamily, 'HARNESS');
  assert.equal(row.modelCallStarted, false, 'nothing was inferred, so nothing was charged');
  assert.equal(row.inputTokens, null);
  assert.equal(row.totalTokens, null);
});

test('an interrupted process records the timeout and keeps the row attributable', () => {
  const row = record(null, {
    structuredOutput: false,
    timedOut: true,
    exitCode: null,
    error: { code: 'TIMEOUT', message: 'Process exceeded 1000ms and was killed' },
  });
  assert.equal(row.timedOut, true);
  assert.equal(row.goalId, '008');
  assert.equal(row.attemptId, '008-r2-developer-abc#a1');
});

test('an assistant turn alone proves the model was reached', () => {
  assert.equal(
    inferModelCallStarted({ counters: { assistantMessages: 1 }, tokens: {}, envelope: null }),
    true,
  );
  assert.equal(
    inferModelCallStarted({ counters: { assistantMessages: 0 }, tokens: {}, envelope: null }),
    false,
  );
});

// --- phase and operation ---------------------------------------------------

test('a sub-phase is never invented', () => {
  assert.equal(record(successResult()).phase, 'UNKNOWN');
});

test('the operation comes from the routing stage, and is UNKNOWN without one', () => {
  assert.equal(record(successResult()).operation, 'implementation');
  const unattributed = buildUsageRecord({ context: {}, capture: { envelope: successResult() } });
  assert.equal(unattributed.operation, 'UNKNOWN');
  assert.equal(unattributed.goalId, null);
});

// --- sanitisation ----------------------------------------------------------

test('credential-shaped values never reach the preserved payload', () => {
  const payload = sanitizePayload({
    apiKey: 'sk-abcdefghijklmnopqrst',
    Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payloadpayload.signature',
    cookie: 'session=abc123',
    nested: { GITHUB_TOKEN: 'ghp_abcdefghijklmnop', note: 'export MY_SECRET=supersecretvalue' },
    command: 'curl -H "Authorization: Bearer sk-livekeyvalue123456" https://x',
  });
  const text = JSON.stringify(payload);

  for (const leak of ['sk-abcdefghijklmnopqrst', 'ghp_abcdefghijklmnop', 'supersecretvalue',
    'sk-livekeyvalue123456', 'eyJhbGciOiJIUzI1NiJ9', 'abc123']) {
    assert.equal(text.includes(leak), false, `leaked ${leak}`);
  }
});

test('token COUNTS are not mistaken for credentials', () => {
  const payload = sanitizePayload({
    inputTokens: 100, output_tokens: 50, cache_read_input_tokens: 900, maxOutputTokens: 64000,
  });
  assert.deepEqual(payload, {
    inputTokens: 100, output_tokens: 50, cache_read_input_tokens: 900, maxOutputTokens: 64000,
  });
});

test('the model answer is dropped from the preserved envelope, not copied into it', () => {
  const raw = JSON.parse(serializeRaw(successResult({ payload: { role: 'developer', summary: 'x'.repeat(5000) } })));
  assert.equal('result' in raw, false);
  assert.equal('structured_output' in raw, false);
  assert.equal(raw.num_turns, 7, 'the metadata around it is kept');
});

test('an oversized payload is replaced by a marker rather than stored truncated', () => {
  const huge = { blob: 'x'.repeat(MAX_RAW_JSON_BYTES + 1000) };
  const stored = JSON.parse(serializeRaw(huge));
  assert.equal(stored.omitted, 'OVERSIZED');
  assert.ok(stored.bytes > MAX_RAW_JSON_BYTES);
});

// --- integrity -------------------------------------------------------------

test('impossible values are flagged rather than silently accepted', () => {
  assert.deepEqual(
    integrityFlagsFor({ inputTokens: -5, outputTokens: 1, modelCallStarted: true, resolvedModel: 'x' }),
    ['NEGATIVE_COUNT:inputTokens'],
  );
  assert.ok(integrityFlagsFor({
    startedAt: '2026-09-09T10:05:00.000Z',
    finishedAt: '2026-09-09T10:00:00.000Z',
    modelCallStarted: true,
    resolvedModel: 'x',
  }).includes('FINISHED_BEFORE_STARTED'));
  assert.ok(integrityFlagsFor({
    thinkingTokens: 900, outputTokens: 100, modelCallStarted: true, resolvedModel: 'x',
  }).includes('THINKING_EXCEEDS_OUTPUT'));
});

test('a clean record carries no integrity flags', () => {
  assert.deepEqual(record(successResult()).integrityFlags, []);
});

// --- raw preservation ------------------------------------------------------

test('the raw usage and modelUsage payloads are preserved for fields we do not normalise yet', () => {
  const row = record(successResult({
    usage: topLevelUsage({ input: 1, output: 1 }),
    extra: { some_future_field: 'kept' },
  }));

  assert.equal(JSON.parse(row.rawResultJson).some_future_field, 'kept');
  assert.equal(JSON.parse(row.rawUsageJson).service_tier, 'standard');
  assert.ok(JSON.parse(row.rawModelUsageJson)[OPUS]);
});

test('the camelCase and snake_case usage readers agree on the same call', () => {
  const fromModel = tokensFromModelUsage(modelUsageEntry({ input: 7, output: 9, cacheRead: 3, cacheCreation: 2 }));
  const fromTop = tokensFromTopLevelUsage(topLevelUsage({ input: 7, output: 9, cacheRead: 3, cacheCreation: 2 }));
  assert.equal(fromModel.inputTokens, fromTop.inputTokens);
  assert.equal(fromModel.cacheCreationTokens, fromTop.cacheCreationTokens);
});
