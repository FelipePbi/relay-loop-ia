/**
 * Unit tests for the Spike 0 invocation library.
 *
 * These cover the local logic only, using a fake child process — no real model
 * calls are made here. The real two-model invocation is the Spike's own final
 * validation (npm run ia-loop:spike) and is never simulated.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  AGENT_SCHEMA,
  SpikeError,
  assertAgentPayload,
  assertNoSilentFallback,
  buildArgs,
  extractAgentPayload,
  invokeAgent,
  listObservedModels,
  parseEnvelope,
  resolveClaudeExecutable,
  resolvePrimaryModel,
  resolveServedPrimaryModel,
} from '../lib/claude-process.mjs';

/**
 * Builds a fake spawn() that emits the given stdout/stderr and exit code.
 * When `hang` is set the process never closes, so the timeout path can be tested.
 */
function fakeSpawn({ stdout = '', stderr = '', exitCode = 0, hang = false, onSpawn } = {}) {
  return (executable, args, options) => {
    onSpawn?.({ executable, args, options });

    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      child.emit('close', null);
      return true;
    };

    if (!hang) {
      setImmediate(() => {
        if (stdout) child.stdout.emit('data', stdout);
        if (stderr) child.stderr.emit('data', stderr);
        child.emit('close', exitCode);
      });
    }
    return child;
  };
}

/** Per-model usage entry, in the camelCase shape the CLI uses. */
function modelUsage({ input = 0, output = 0, cacheRead = 0, cacheCreation = 0 } = {}) {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
  };
}

/** Top-level usage, in the snake_case shape the CLI uses. */
function topLevelUsage({ input = 0, output = 0, cacheRead = 0, cacheCreation = 0 } = {}) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
  };
}

/** A single non-streamed envelope, as `--output-format json` would print it. */
function envelope({
  result,
  usage = topLevelUsage(),
  models = {},
  isError = false,
  omitUsage = false,
  omitModelUsage = false,
}) {
  const payload = {
    type: 'result',
    subtype: 'success',
    is_error: isError,
    result,
  };
  if (!omitUsage) payload.usage = usage;
  if (!omitModelUsage) payload.modelUsage = models;
  return JSON.stringify(payload);
}

/**
 * A real `--output-format stream-json` transcript: one `assistant` event per
 * served model (each "shaped like an Anthropic Messages API Message object …
 * id, model, content blocks …", per the installed CLI's own event schema),
 * followed by the closing `result` event carrying the same envelope `json`
 * would have printed. This is the explicit evidence `resolveServedPrimaryModel`
 * reads; `usage`/`modelUsage` stay purely advisory (see resolvePrimaryModel).
 *
 * `servedModels` — zero, one or several ids — is what a real CLI would put on
 * `message.model` for each assistant turn. Multiple entries with the SAME id
 * simulate several tool-round-trip turns in one invocation (the normal case);
 * several DIFFERENT ids simulate the "should never happen" conflicting case.
 */
function streamEnvelope({
  result,
  usage = topLevelUsage(),
  models = {},
  isError = false,
  omitUsage = false,
  omitModelUsage = false,
  servedModels = [],
  permissionDenials,
}) {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: '00000000-0000-4000-8000-000000000000' }),
    ...servedModels.map((model) => JSON.stringify({
      type: 'assistant',
      message: { model, content: [{ type: 'text', text: 'working…' }] },
    })),
  ];
  const resultPayload = { type: 'result', subtype: 'success', is_error: isError, result };
  if (!omitUsage) resultPayload.usage = usage;
  if (!omitModelUsage) resultPayload.modelUsage = models;
  if (permissionDenials !== undefined) resultPayload.permission_denials = permissionDenials;
  lines.push(JSON.stringify(resultPayload));
  return lines.join('\n');
}

// Real numbers captured from the authenticated host runs.
const OPUS_USAGE = { input: 2, output: 15, cacheRead: 15175, cacheCreation: 10113 };
const FABLE_USAGE = { input: 2, output: 18, cacheRead: 15177, cacheCreation: 10775 };
const HAIKU_AUX_USAGE = { input: 4, output: 7, cacheRead: 0, cacheCreation: 321 };

const HAIKU = 'claude-haiku-4-5-20251001';
const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5-1';

const TECH_LEAD = {
  executable: 'claude',
  model: FABLE,
  expectedFamily: 'fable',
  expectedRole: 'tech_lead',
  prompt: 'return the json',
  cwd: '.',
  sessionId: '00000000-0000-4000-8000-000000000000',
};

const DEVELOPER = {
  ...TECH_LEAD,
  model: OPUS,
  expectedFamily: 'opus',
  expectedRole: 'developer',
};

// ---------------------------------------------------------------------------
// Primary-model resolution — evidence-based (the point of this correction).
//
// Goal006 R1's review: turn 3 of a resumed Tech Lead session produced a valid
// StructuredOutput, but no `modelUsage` entry matched the top-level `usage`
// byte-for-byte, and that mismatch alone stopped the Goal as UNKNOWN_FATAL.
// Every test below proves the model's own explicit `message.model` — not
// token accounting — decides identity, and that accounting disagreeing never
// blocks a result on its own.
// ---------------------------------------------------------------------------

test('1. Opus primary with Haiku auxiliary passes and reports both roles correctly', async () => {
  const outcome = await invokeAgent({
    ...DEVELOPER,
    spawnFn: fakeSpawn({
      stdout: streamEnvelope({
        result: '{"role":"developer","ok":true}',
        usage: topLevelUsage(OPUS_USAGE),
        models: { [HAIKU]: modelUsage(HAIKU_AUX_USAGE), [OPUS]: modelUsage(OPUS_USAGE) },
        servedModels: [OPUS],
      }),
    }),
  });

  assert.equal(outcome.error, null);
  assert.equal(outcome.available, true);
  assert.equal(outcome.structuredOutput, true);
  assert.equal(outcome.resolvedPrimaryModel, OPUS);
  assert.deepEqual(outcome.auxiliaryModels, [HAIKU]);
  assert.deepEqual(outcome.observedModels, [HAIKU, OPUS]);
  assert.equal(outcome.usageAccounting.matched, true);
});

test('2. Fable primary with Haiku auxiliary passes', async () => {
  const outcome = await invokeAgent({
    ...TECH_LEAD,
    spawnFn: fakeSpawn({
      stdout: streamEnvelope({
        result: '{"role":"tech_lead","ok":true}',
        usage: topLevelUsage(FABLE_USAGE),
        models: { [HAIKU]: modelUsage(HAIKU_AUX_USAGE), [FABLE]: modelUsage(FABLE_USAGE) },
        servedModels: [FABLE],
      }),
    }),
  });

  assert.equal(outcome.error, null);
  assert.equal(outcome.available, true);
  assert.equal(outcome.structuredOutput, true);
  assert.equal(outcome.resolvedPrimaryModel, FABLE);
  assert.deepEqual(outcome.auxiliaryModels, [HAIKU]);
});

test("the CLI's own permission_denials record is surfaced on the outcome, verbatim", async () => {
  const denials = [
    { tool_name: 'Edit', tool_use_id: 'toolu_1', tool_input: { file_path: 'apps/x/y.ts' } },
    { tool_name: 'Bash', tool_use_id: 'toolu_2', tool_input: { command: 'rtk lint' } },
  ];
  const outcome = await invokeAgent({
    ...DEVELOPER,
    spawnFn: fakeSpawn({
      stdout: streamEnvelope({
        result: '{"role":"developer","ok":true}',
        usage: topLevelUsage(OPUS_USAGE),
        models: { [OPUS]: modelUsage(OPUS_USAGE) },
        servedModels: [OPUS],
        permissionDenials: denials,
      }),
    }),
  });

  assert.deepEqual(outcome.permissionDenials, denials);
});

test('permissionDenials defaults to an empty array when the CLI reported none', async () => {
  const outcome = await invokeAgent({
    ...DEVELOPER,
    spawnFn: fakeSpawn({
      stdout: streamEnvelope({
        result: '{"role":"developer","ok":true}',
        usage: topLevelUsage(OPUS_USAGE),
        models: { [OPUS]: modelUsage(OPUS_USAGE) },
        servedModels: [OPUS],
      }),
    }),
  });

  assert.deepEqual(outcome.permissionDenials, []);
});

test('7/8. multiple assistant turns naming the same served model are one identity, and an auxiliary never becomes a fallback', async () => {
  const outcome = await invokeAgent({
    ...TECH_LEAD,
    spawnFn: fakeSpawn({
      stdout: streamEnvelope({
        result: '{"role":"tech_lead","ok":true}',
        usage: topLevelUsage(FABLE_USAGE),
        models: { [HAIKU]: modelUsage(HAIKU_AUX_USAGE), [FABLE]: modelUsage(FABLE_USAGE) },
        // Several tool-round-trip turns, same served model each time — the
        // normal shape of a real review with many Bash/Read calls.
        servedModels: [FABLE, FABLE, FABLE],
      }),
    }),
  });

  assert.equal(outcome.error, null);
  assert.equal(outcome.available, true);
  assert.equal(outcome.resolvedPrimaryModel, FABLE);
});

test('3. requesting Opus but getting Haiku as primary is a detected fallback', async () => {
  const outcome = await invokeAgent({
    ...DEVELOPER,
    spawnFn: fakeSpawn({
      stdout: streamEnvelope({
        result: '{"role":"developer","ok":true}',
        usage: topLevelUsage(HAIKU_AUX_USAGE),
        models: { [HAIKU]: modelUsage(HAIKU_AUX_USAGE) },
        servedModels: [HAIKU],
      }),
    }),
  });

  assert.equal(outcome.available, false);
  assert.equal(outcome.error.code, 'MODEL_FALLBACK_DETECTED');
  assert.equal(outcome.resolvedPrimaryModel, HAIKU);
  // The candidate payload is still discarded here: a genuine fallback means
  // the WRONG model answered, so its content is never trustworthy.
  assert.equal(outcome.payload, null);
});

test('4. requesting Fable but getting Opus as primary is a detected fallback', async () => {
  const outcome = await invokeAgent({
    ...TECH_LEAD,
    spawnFn: fakeSpawn({
      stdout: streamEnvelope({
        result: '{"role":"tech_lead","ok":true}',
        usage: topLevelUsage(OPUS_USAGE),
        models: { [HAIKU]: modelUsage(HAIKU_AUX_USAGE), [OPUS]: modelUsage(OPUS_USAGE) },
        servedModels: [OPUS],
      }),
    }),
  });

  assert.equal(outcome.available, false);
  assert.equal(outcome.error.code, 'MODEL_FALLBACK_DETECTED');
  assert.equal(outcome.resolvedPrimaryModel, OPUS);
});

test('(evidence) no explicit model evidence on the stream leaves the primary unknown as a harness error', async () => {
  const outcome = await invokeAgent({
    ...DEVELOPER,
    spawnFn: fakeSpawn({
      stdout: streamEnvelope({
        result: '{"role":"developer","ok":true}',
        usage: topLevelUsage(OPUS_USAGE),
        models: { [OPUS]: modelUsage(OPUS_USAGE) },
        servedModels: [], // no assistant event carried message.model
      }),
    }),
  });

  assert.equal(outcome.available, false);
  assert.equal(outcome.error.code, 'PRIMARY_MODEL_EVIDENCE_MISSING');
  assert.equal(outcome.resolvedPrimaryModel, null);
});

test('(evidence) two different served models reported across the same turn fail closed as conflicting', async () => {
  const outcome = await invokeAgent({
    ...DEVELOPER,
    spawnFn: fakeSpawn({
      stdout: streamEnvelope({
        result: '{"role":"developer","ok":true}',
        usage: topLevelUsage(OPUS_USAGE),
        models: { [OPUS]: modelUsage(OPUS_USAGE) },
        servedModels: [OPUS, HAIKU], // should never happen — fail closed, do not guess
      }),
    }),
  });

  assert.equal(outcome.available, false);
  assert.equal(outcome.error.code, 'PRIMARY_MODEL_EVIDENCE_CONFLICT');
  assert.equal(outcome.resolvedPrimaryModel, null);
});

test('5/6/13. Goal006 R1 regression: accounting matching nothing never blocks a result explicit evidence answers', async () => {
  const outcome = await invokeAgent({
    ...TECH_LEAD,
    spawnFn: fakeSpawn({
      stdout: streamEnvelope({
        result: '{"role":"tech_lead","ok":true,"decision":"CHANGES_REQUIRED"}',
        // Neither entry reproduces this top-level usage — exactly Goal006 R1's
        // shape: an accounting-only resolver would throw RESOLVED_MODEL_UNKNOWN
        // here even though the CLI answered correctly.
        usage: topLevelUsage({ input: 2, output: 18, cacheRead: 99999, cacheCreation: 99999 }),
        models: { [HAIKU]: modelUsage(HAIKU_AUX_USAGE), [FABLE]: modelUsage(FABLE_USAGE) },
        servedModels: [FABLE],
      }),
    }),
  });

  assert.equal(outcome.error, null);
  assert.equal(outcome.available, true);
  assert.equal(outcome.resolvedPrimaryModel, FABLE);
  assert.equal(outcome.structuredOutput, true);
  assert.equal(outcome.payload.decision, 'CHANGES_REQUIRED');
  // Advisory only: the accounting mismatch is recorded, never thrown.
  assert.equal(outcome.usageAccounting.matched, false);
});

test('14/15. a valid candidate survives model-verification failure, but is never published as trusted', async () => {
  const outcome = await invokeAgent({
    ...TECH_LEAD,
    spawnFn: fakeSpawn({
      stdout: streamEnvelope({
        result: '{"role":"tech_lead","ok":true,"decision":"ACCEPTED"}',
        usage: topLevelUsage(FABLE_USAGE),
        models: { [FABLE]: modelUsage(FABLE_USAGE) },
        servedModels: [], // model verification will fail
      }),
    }),
  });

  assert.equal(outcome.error.code, 'PRIMARY_MODEL_EVIDENCE_MISSING');
  assert.equal(outcome.available, false);
  // Step 1 still ran and succeeded: the payload was structurally valid.
  assert.equal(outcome.structuredOutput, true);
  assert.deepEqual(outcome.candidatePayload, { role: 'tech_lead', ok: true, decision: 'ACCEPTED' });
  // Step 3: not trusted. This is what capacity-runner.mjs uses to decide
  // whether to publish a candidate result alongside the FAILED envelope.
  assert.equal(outcome.payload, null);
});

test('a missing top-level usage does not affect evidence-based resolution', async () => {
  const outcome = await invokeAgent({
    ...DEVELOPER,
    spawnFn: fakeSpawn({
      stdout: streamEnvelope({
        result: '{"role":"developer","ok":true}',
        omitUsage: true,
        models: { [OPUS]: modelUsage(OPUS_USAGE) },
        servedModels: [OPUS],
      }),
    }),
  });

  assert.equal(outcome.error, null);
  assert.equal(outcome.resolvedPrimaryModel, OPUS);
  // The OLD accounting mechanism has nothing to match against; recorded, not thrown.
  assert.equal(outcome.usageAccounting.error, 'RESOLVED_MODEL_UNKNOWN');
});

// ---------------------------------------------------------------------------
// resolveServedPrimaryModel — the pure function, without a fake process.
// ---------------------------------------------------------------------------

test('resolveServedPrimaryModel returns the single distinct evidence model', () => {
  assert.equal(resolveServedPrimaryModel({ evidenceModels: [FABLE, FABLE] }), FABLE);
});

test('resolveServedPrimaryModel fails closed with no evidence', () => {
  assert.throws(
    () => resolveServedPrimaryModel({ evidenceModels: [] }),
    (e) => e.code === 'PRIMARY_MODEL_EVIDENCE_MISSING',
  );
  assert.throws(
    () => resolveServedPrimaryModel(),
    (e) => e.code === 'PRIMARY_MODEL_EVIDENCE_MISSING',
  );
});

test('resolveServedPrimaryModel fails closed with conflicting evidence', () => {
  assert.throws(
    () => resolveServedPrimaryModel({ evidenceModels: [OPUS, HAIKU] }),
    (e) => e.code === 'PRIMARY_MODEL_EVIDENCE_CONFLICT' && e.details.observed.length === 2,
  );
});

test('resolvePrimaryModel separates primary from auxiliary without a hardcoded allowlist', () => {
  const resolution = resolvePrimaryModel({
    usage: topLevelUsage(FABLE_USAGE),
    modelUsage: {
      [HAIKU]: modelUsage(HAIKU_AUX_USAGE),
      [FABLE]: modelUsage(FABLE_USAGE),
      'some-future-helper-model': modelUsage({ input: 1 }),
    },
  });

  assert.equal(resolution.primary, FABLE);
  // Any unknown auxiliary is tolerated as auxiliary, none is special-cased.
  assert.deepEqual(resolution.auxiliary, [HAIKU, 'some-future-helper-model']);
});

test('resolvePrimaryModel treats absent usage counters as zero rather than guessing', () => {
  const resolution = resolvePrimaryModel({
    usage: { input_tokens: 0, output_tokens: 5 },
    modelUsage: { [OPUS]: { outputTokens: 5 } },
  });

  assert.equal(resolution.primary, OPUS);
  assert.deepEqual(resolution.auxiliary, []);
});

test('listObservedModels reports raw ids without interpreting them', () => {
  assert.deepEqual(listObservedModels({ modelUsage: { [HAIKU]: {}, [OPUS]: {} } }), [HAIKU, OPUS]);
  assert.deepEqual(listObservedModels({}), []);
  assert.deepEqual(listObservedModels({ modelUsage: [] }), []);
});

// ---------------------------------------------------------------------------
// Process-level safety. These must not weaken.
// ---------------------------------------------------------------------------

test('8. invalid envelope JSON is reported, not silently swallowed', async () => {
  const outcome = await invokeAgent({
    ...DEVELOPER,
    spawnFn: fakeSpawn({ stdout: 'this is not json' }),
  });

  assert.equal(outcome.error.code, 'INVALID_ENVELOPE_JSON');
  assert.equal(outcome.structuredOutput, false);
});

test('8b. invalid agent JSON inside a valid envelope is reported', async () => {
  const outcome = await invokeAgent({
    ...DEVELOPER,
    spawnFn: fakeSpawn({
      stdout: streamEnvelope({
        result: 'sure! here is your json',
        usage: topLevelUsage(OPUS_USAGE),
        models: { [OPUS]: modelUsage(OPUS_USAGE) },
        servedModels: [OPUS],
      }),
    }),
  });

  // The model was verified correctly; only the payload is unusable, and the
  // payload error wins because there is no candidate to prefer over it.
  assert.equal(outcome.available, true);
  assert.equal(outcome.structuredOutput, false);
  assert.equal(outcome.candidatePayload, null);
  assert.equal(outcome.error.code, 'INVALID_AGENT_JSON');
});

test('9. wrong role fails validation', async () => {
  const outcome = await invokeAgent({
    ...DEVELOPER,
    spawnFn: fakeSpawn({
      stdout: streamEnvelope({
        result: '{"role":"tech_lead","ok":true}',
        usage: topLevelUsage(OPUS_USAGE),
        models: { [OPUS]: modelUsage(OPUS_USAGE) },
        servedModels: [OPUS],
      }),
    }),
  });

  assert.equal(outcome.available, true);
  assert.equal(outcome.structuredOutput, false);
  assert.equal(outcome.error.code, 'ROLE_MISMATCH');
});

test('9b. ok:false fails validation', async () => {
  const outcome = await invokeAgent({
    ...DEVELOPER,
    spawnFn: fakeSpawn({
      stdout: streamEnvelope({
        result: '{"role":"developer","ok":false}',
        usage: topLevelUsage(OPUS_USAGE),
        models: { [OPUS]: modelUsage(OPUS_USAGE) },
        servedModels: [OPUS],
      }),
    }),
  });

  assert.equal(outcome.structuredOutput, false);
  assert.equal(outcome.error.code, 'OK_NOT_TRUE');
});

test('10. timeout kills the subprocess and reports TIMEOUT', async () => {
  const outcome = await invokeAgent({
    ...DEVELOPER,
    timeoutMs: 25,
    spawnFn: fakeSpawn({ hang: true }),
  });

  assert.equal(outcome.error.code, 'TIMEOUT');
  assert.equal(outcome.available, false);
  assert.equal(outcome.structuredOutput, false);
});

test('non-zero exit is reported and never treated as success', async () => {
  const outcome = await invokeAgent({
    ...DEVELOPER,
    spawnFn: fakeSpawn({
      exitCode: 1,
      stdout: envelope({ result: 'Not logged in · Please run /login', isError: true }),
    }),
  });

  assert.equal(outcome.available, false);
  assert.equal(outcome.structuredOutput, false);
  assert.equal(outcome.error.code, 'NON_ZERO_EXIT');
  assert.match(outcome.error.message, /Not logged in/);
});

test('a missing executable surfaces EXECUTABLE_NOT_FOUND', async () => {
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    setImmediate(() => {
      const error = new Error('spawn claude ENOENT');
      error.code = 'ENOENT';
      child.emit('error', error);
    });
    return child;
  };

  const outcome = await invokeAgent({ ...DEVELOPER, spawnFn });
  assert.equal(outcome.error.code, 'EXECUTABLE_NOT_FOUND');
});

test('result delivered as an object rather than a JSON string still validates', async () => {
  // A single JSON blob has no room for an `assistant` stream event, so there
  // is no model evidence here — an expected consequence of the fix, not a
  // regression: the payload still validates on its own merits either way.
  const stdout = JSON.stringify({
    is_error: false,
    result: { role: 'developer', ok: true },
    usage: topLevelUsage(OPUS_USAGE),
    modelUsage: { [OPUS]: modelUsage(OPUS_USAGE) },
  });
  const outcome = await invokeAgent({ ...DEVELOPER, spawnFn: fakeSpawn({ stdout }) });

  assert.equal(outcome.structuredOutput, true);
  assert.deepEqual(outcome.candidatePayload, { role: 'developer', ok: true });
  assert.equal(outcome.error.code, 'PRIMARY_MODEL_EVIDENCE_MISSING');
});

test('buildArgs enforces isolation and never bypasses permissions', () => {
  const args = buildArgs({
    prompt: 'p',
    model: FABLE,
    jsonSchema: AGENT_SCHEMA,
    sessionId: 'abc',
  });

  assert.ok(args.includes('--print'));
  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
  // Empty --tools removes every built-in tool.
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--model') + 1], FABLE);
  assert.equal(args[args.indexOf('--session-id') + 1], 'abc');
  for (const forbidden of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--fallback-model']) {
    assert.ok(!args.includes(forbidden), `${forbidden} must never be used`);
  }
});

test('buildArgs rejects incomplete input', () => {
  assert.throws(() => buildArgs({ model: FABLE, sessionId: 'a' }), SpikeError);
  assert.throws(() => buildArgs({ prompt: 'p', sessionId: 'a' }), SpikeError);
});

test('each agent runs in its own session id', async () => {
  const seen = [];
  const spawnFn = fakeSpawn({
    stdout: envelope({
      result: '{"role":"developer","ok":true}',
      usage: topLevelUsage(OPUS_USAGE),
      models: { [OPUS]: modelUsage(OPUS_USAGE) },
    }),
    onSpawn: ({ args }) => seen.push(args[args.indexOf('--session-id') + 1]),
  });

  await invokeAgent({ ...DEVELOPER, sessionId: undefined, spawnFn });
  await invokeAgent({ ...DEVELOPER, sessionId: undefined, spawnFn });

  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
});

test('parseEnvelope rejects empty and non-object output', () => {
  assert.throws(() => parseEnvelope('   '), (e) => e.code === 'EMPTY_OUTPUT');
  assert.throws(() => parseEnvelope('[1,2]'), (e) => e.code === 'INVALID_ENVELOPE_JSON');
});

test('extractAgentPayload surfaces a CLI-reported error', () => {
  assert.throws(
    () => extractAgentPayload({ is_error: true, result: 'Not logged in' }),
    (e) => e.code === 'CLI_REPORTED_ERROR',
  );
});

test('assertNoSilentFallback accepts a matching family and rejects a substitution', () => {
  assert.equal(
    assertNoSilentFallback({
      requestedModel: OPUS,
      resolvedPrimaryModel: OPUS,
      expectedFamily: 'opus',
    }),
    OPUS,
  );

  assert.throws(
    () => assertNoSilentFallback({
      requestedModel: OPUS,
      resolvedPrimaryModel: HAIKU,
      expectedFamily: 'opus',
    }),
    (e) => e.code === 'MODEL_FALLBACK_DETECTED',
  );

  assert.throws(
    () => assertNoSilentFallback({
      requestedModel: OPUS,
      resolvedPrimaryModel: null,
      expectedFamily: 'opus',
    }),
    (e) => e.code === 'RESOLVED_MODEL_UNKNOWN',
  );
});

test('assertAgentPayload rejects non-object payloads', () => {
  assert.throws(() => assertAgentPayload('nope', { expectedRole: 'developer' }), (e) => e.code === 'INVALID_AGENT_SHAPE');
  assert.throws(() => assertAgentPayload(null, { expectedRole: 'developer' }), (e) => e.code === 'INVALID_AGENT_SHAPE');
});

test('resolveClaudeExecutable honours an explicit override and rejects a missing one', () => {
  const fs = { existsSync: (p) => p === 'C:/fake/claude.exe', readdirSync: () => [] };

  assert.deepEqual(
    resolveClaudeExecutable({ IA_LOOP_CLAUDE_BIN: 'C:/fake/claude.exe' }, { fs }),
    { path: 'C:/fake/claude.exe', source: 'IA_LOOP_CLAUDE_BIN' },
  );

  assert.throws(
    () => resolveClaudeExecutable({ IA_LOOP_CLAUDE_BIN: 'C:/missing/claude.exe' }, { fs }),
    (e) => e.code === 'EXECUTABLE_NOT_FOUND',
  );
});

test('resolveClaudeExecutable fails cleanly when nothing is installed', () => {
  const fs = { existsSync: () => false, readdirSync: () => [] };
  assert.throws(
    () => resolveClaudeExecutable({ PATH: '/usr/bin' }, { fs }),
    (e) => e.code === 'EXECUTABLE_NOT_FOUND',
  );
});
