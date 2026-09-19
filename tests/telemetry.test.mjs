/**
 * Zero-token telemetry.
 *
 * The central claim under test is negative: telemetry changes NOTHING the model
 * sees. The level knob may only change what this process prints. No real model
 * is called anywhere in this file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { buildArgs, invokeAgent, parseEnvelope } from '../lib/claude-process.mjs';
import { createStreamParser, categorizeCommand, describeToolUse } from '../lib/stream-telemetry.mjs';
import {
  LOG_LEVELS,
  createTelemetry,
  normalizeLogLevel,
  renderEvent,
  sanitize,
  shouldEmit,
} from '../lib/telemetry.mjs';

const OPUS = 'claude-opus-5';

function fakeSpawn({ stdout = '', exitCode = 0, onSpawn } = {}) {
  return (executable, args, options) => {
    onSpawn?.({ executable, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', stdout);
      child.emit('close', exitCode);
    });
    return child;
  };
}

/** A minimal but realistic stream: init, a Read, its result, then the envelope. */
function streamOf(events) {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

function resultEvent({ result = '{"role":"developer","ok":true}', usage, models } = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result,
    usage: usage ?? { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: models ?? {
      [OPUS]: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    },
  };
}

const AGENT_CALL = {
  executable: 'claude',
  model: OPUS,
  expectedFamily: 'opus',
  expectedRole: 'developer',
  prompt: 'implement the goal',
  sessionId: '11111111-1111-4111-8111-111111111111',
  cwd: 'E:/wt',
};

// --- 1-4. The level never reaches the model -------------------------------

test('1-3. every log level sends byte-identical args, prompt and context', async () => {
  const captured = new Map();

  for (const level of LOG_LEVELS) {
    const telemetry = createTelemetry({ level, write: () => {} });
    const spawnFn = fakeSpawn({
      stdout: streamOf([resultEvent()]),
      onSpawn: ({ args, options }) => captured.set(level, { args, options }),
    });

    await invokeAgent({
      ...AGENT_CALL,
      spawnFn,
      onTelemetryEvent: (event) => telemetry.emit(event),
    });
  }

  const [minimal, normal, verbose] = LOG_LEVELS.map((level) => captured.get(level));
  assert.deepEqual(minimal.args, normal.args);
  assert.deepEqual(normal.args, verbose.args);
  // Byte equality, not just structural: the argv is what the CLI bills on.
  assert.equal(minimal.args.join('\u0000'), verbose.args.join('\u0000'));
});

test('4. the model, schema and prompt are identical across levels', () => {
  const argsFor = () => buildArgs({
    prompt: 'p',
    model: OPUS,
    jsonSchema: { type: 'object' },
    sessionId: 'abc',
    outputFormat: 'stream-json',
  });

  // buildArgs has no level parameter at all — the property is structural, not
  // a coincidence of the current defaults.
  assert.deepEqual(argsFor(), argsFor());
  assert.ok(!JSON.stringify(argsFor()).includes('IA_LOOP_LOG_LEVEL'));

  const streamed = buildArgs({ prompt: 'p', model: OPUS, sessionId: 'abc', outputFormat: 'stream-json' });
  const plain = buildArgs({ prompt: 'p', model: OPUS, sessionId: 'abc', outputFormat: 'json' });

  // Streaming differs ONLY in how this process is told to print: the output
  // format, and the `--verbose` the CLI demands alongside it. Everything that
  // reaches the model is untouched.
  const LOCAL_OUTPUT_FLAGS = new Set(['--verbose', 'stream-json', 'json']);
  assert.equal(
    streamed.filter((a) => !LOCAL_OUTPUT_FLAGS.has(a)).join('|'),
    plain.filter((a) => !LOCAL_OUTPUT_FLAGS.has(a)).join('|'),
  );

  // Named explicitly, so a future flag cannot be smuggled in under this test.
  const inferenceArgs = (args) => ['--model', '--json-schema', '--tools', '--effort', '--permission-mode',
    '--session-id', '--resume', '--append-system-prompt', '--system-prompt']
    .flatMap((flag) => (args.includes(flag) ? [flag, args[args.indexOf(flag) + 1]] : []));
  assert.deepEqual(inferenceArgs(streamed), inferenceArgs(plain));
});

test('4b. no telemetry text is ever appended to the prompt', async () => {
  let sentPrompt = null;
  const spawnFn = (executable, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { on() {}, end(data) { sentPrompt = data; } };
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.emit('data', streamOf([resultEvent()]));
      child.emit('close', 0);
    });
    assert.ok(!args.includes('--append-system-prompt'));
    return child;
  };

  await invokeAgent({ ...AGENT_CALL, spawnFn, onTelemetryEvent: () => {} });
  assert.equal(sentPrompt, AGENT_CALL.prompt);
});

// --- 5-6. Tool events -----------------------------------------------------

test('5. a Read tool_use becomes a READ event with only the path', () => {
  const seen = [];
  const parser = createStreamParser({ onEvent: (event) => seen.push(event), root: 'E:/wt' });

  parser.push(streamOf([{
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'I will now read the service to understand it' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'E:/wt/apps/bff/src/session.ts' } },
      ],
    },
  }]));

  assert.equal(seen.length, 1, 'the text block must not produce an event');
  assert.equal(seen[0].category, 'READ');
  assert.equal(seen[0].detail, 'apps/bff/src/session.ts');
});

test('6. an Edit tool_use becomes an EDIT event and never carries content', () => {
  const seen = [];
  const parser = createStreamParser({ onEvent: (event) => seen.push(event), root: 'E:/wt' });

  parser.push(streamOf([{
    type: 'assistant',
    message: {
      content: [{
        type: 'tool_use',
        id: 't2',
        name: 'Edit',
        input: {
          file_path: 'E:/wt/apps/bff/src/ConversationService.ts',
          old_string: 'const SECRET = "abc"',
          new_string: 'const SECRET = process.env.X',
        },
      }],
    },
  }]));

  assert.equal(seen[0].category, 'EDIT');
  assert.equal(seen[0].detail, 'apps/bff/src/ConversationService.ts');
  assert.ok(!JSON.stringify(seen[0]).includes('old_string'));
  assert.ok(!JSON.stringify(seen[0]).includes('process.env.X'));
});

test('6b. a Write never leaks the file it is writing', () => {
  const described = describeToolUse({
    name: 'Write',
    input: { file_path: '/wt/a.ts', content: 'the entire file body\nline two\n' },
  }, { root: '/wt' });

  assert.equal(described.category, 'WRITE');
  assert.equal(described.detail, 'a.ts');
  assert.ok(!described.detail.includes('line two'));
});

// --- 7-8. Bash and secrets ------------------------------------------------

test('7. a Bash command is categorised and rendered sanitized', () => {
  assert.equal(categorizeCommand('pnpm test apps/bff'), 'TEST');
  assert.equal(categorizeCommand('git diff --stat'), 'GIT');
  assert.equal(categorizeCommand('rm -rf build'), 'DELETE');
  assert.equal(categorizeCommand('ls -la'), 'BASH');

  const described = describeToolUse({ name: 'Bash', input: { command: 'npm run validate:core' } });
  assert.equal(described.category, 'TEST');
  assert.equal(described.detail, 'npm run validate:core');
});

test('8. secrets are removed from anything rendered', () => {
  const cases = [
    ['curl -H "Authorization: Bearer abc123def456" https://api', /abc123def456/],
    ['export API_KEY=supersecretvalue123', /supersecretvalue123/],
    ['psql --password=hunter2 -h db', /hunter2/],
    ['echo sk-ant-0123456789abcdef', /sk-ant-0123456789abcdef/],
    ['git push https://user:tokenvalue@github.com/x', /tokenvalue/],
    ['curl -H "Cookie: session=abcdefghij"', /abcdefghij/],
    ['export GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaa', /ghp_aaaaaaaaaaaaaaaaaaaa/],
  ];

  for (const [input, leak] of cases) {
    const safe = sanitize(input);
    assert.ok(!leak.test(safe), `"${input}" leaked through as "${safe}"`);
    assert.ok(safe.includes('redacted'), `"${input}" was not visibly redacted: "${safe}"`);
  }
});

test('8b. a sanitized command is still truncated, so no payload can be printed', () => {
  const safe = sanitize('x'.repeat(5_000));
  assert.ok(safe.length <= 160);
});

// --- 9. Command result ----------------------------------------------------

test('9. a tool result reports its outcome and duration, never its content', () => {
  const seen = [];
  let clock = 1_000;
  const parser = createStreamParser({
    onEvent: (event) => seen.push(event),
    root: '/wt',
    now: () => clock,
  });

  parser.push(streamOf([{
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'npm test' } }] },
  }]));
  clock = 3_500;
  parser.push(streamOf([{
    type: 'user',
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: 't9',
        is_error: false,
        content: 'Tests: 513 passed\nEVERY LINE OF OUTPUT',
      }],
    },
  }]));

  const result = seen.find((event) => event.category === 'RESULT');
  assert.ok(result, 'a RESULT event must be produced');
  assert.equal(result.isError, false);
  assert.equal(result.durationMs, 2_500);
  assert.ok(!JSON.stringify(result).includes('EVERY LINE OF OUTPUT'));
});

test('9b. a failing tool result is visible at normal level, a passing one only at verbose', () => {
  assert.equal(shouldEmit({ category: 'RESULT', isError: false }, 'normal'), false);
  assert.equal(shouldEmit({ category: 'RESULT', isError: true }, 'normal'), true);
  assert.equal(shouldEmit({ category: 'RESULT', isError: false }, 'verbose'), true);
  // minimal shows the run is alive and nothing more.
  assert.equal(shouldEmit({ category: 'READ' }, 'minimal'), false);
  assert.equal(shouldEmit({ category: 'JOB' }, 'minimal'), true);
  assert.equal(shouldEmit({ category: 'READ' }, 'normal'), true);
});

// --- 10. Failure isolation ------------------------------------------------

test('10. a telemetry failure never fails the agent execution', async () => {
  const spawnFn = fakeSpawn({
    stdout: streamOf([
      { type: 'assistant', message: { model: OPUS, content: [{ type: 'tool_use', id: 'x', name: 'Read', input: { file_path: 'a.ts' } }] } },
      resultEvent(),
    ]),
  });

  const outcome = await invokeAgent({
    ...AGENT_CALL,
    spawnFn,
    onTelemetryEvent: () => { throw new Error('the terminal exploded'); },
  });

  assert.equal(outcome.error, null);
  assert.equal(outcome.structuredOutput, true);
  assert.equal(outcome.resolvedPrimaryModel, OPUS);
});

test('10b. a throwing sink and a throwing writer are both swallowed', () => {
  const telemetry = createTelemetry({
    level: 'verbose',
    write: () => { throw new Error('stdout is gone'); },
    sink: () => { throw new Error('disk is full'); },
  });
  assert.doesNotThrow(() => telemetry.emit({ category: 'READ', detail: 'a.ts' }));
});

// --- The envelope stays the authority -------------------------------------

test('the streamed envelope is the same envelope the non-streaming format gives', () => {
  const single = resultEvent();
  const fromStream = parseEnvelope(streamOf([
    { type: 'system', subtype: 'init', session_id: 'abc' },
    { type: 'assistant', message: { content: [] } },
    single,
  ]));
  assert.deepEqual(fromStream, parseEnvelope(JSON.stringify(single)));
});

test('a stream with no result event is refused rather than guessed at', () => {
  assert.throws(
    () => parseEnvelope(streamOf([{ type: 'assistant', message: { content: [] } }, { type: 'user', message: {} }])),
    (error) => error.code === 'INVALID_ENVELOPE_JSON',
  );
});

test('partial chunks are reassembled, so a split line is not lost', () => {
  const seen = [];
  const parser = createStreamParser({ onEvent: (event) => seen.push(event), root: '/wt' });
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'p', name: 'Grep', input: { pattern: 'SessionService', path: '/wt/apps' } }] },
  });

  parser.push(line.slice(0, 30));
  assert.equal(seen.length, 0);
  parser.push(`${line.slice(30)}\n`);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].category, 'SEARCH');
  assert.equal(seen[0].detail, 'SessionService in apps');
});

test('thinking blocks are never rendered', () => {
  const seen = [];
  const parser = createStreamParser({ onEvent: (event) => seen.push(event) });
  parser.push(streamOf([{
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: 'the private chain of thought' }] },
  }]));
  assert.equal(seen.length, 0);
});

/**
 * The counters the usage ledger reads.
 *
 * Every one of these is a tally of an event the CLI emitted anyway, so counting
 * them costs nothing and asks the model for nothing. They are asserted here
 * rather than in the ledger tests because this is where they are produced.
 */
test('the stream parser counts what the stream carried, deterministically', () => {
  const parser = createStreamParser({ now: () => 0 });
  const lines = [
    { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-opus-5' },
    { type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'thinking out loud' }] } },
    {
      type: 'assistant',
      message: {
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } }],
      },
    },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] } },
    {
      type: 'assistant',
      message: {
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }],
      },
    },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true }] } },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 4 },
  ];
  parser.push(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  parser.end();

  const counters = parser.counters();
  assert.equal(counters.streamEvents, 7);
  assert.equal(counters.assistantMessages, 3);
  assert.equal(counters.userMessages, 2);
  assert.equal(counters.toolCallCount, 2);
  assert.equal(counters.toolResultEvents, 2);
  assert.equal(counters.toolErrorEvents, 1);
  assert.equal(counters.initSessionId, 'sess-1');
  assert.deepEqual(
    counters.toolCalls.sort((a, b) => a.tool.localeCompare(b.tool)),
    [{ tool: 'Bash', calls: 1, errors: 1 }, { tool: 'Read', calls: 1, errors: 0 }],
  );
  assert.deepEqual(counters.byType, { system: 1, assistant: 3, user: 2, result: 1 });
});

test('the event trail is metadata only, and is bounded', () => {
  const parser = createStreamParser({ maxTrailEvents: 2, now: () => 0 });
  for (let index = 0; index < 5; index += 1) {
    parser.push(`${JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: `t${index}`, name: 'Write', input: { file_path: 'secret.env', content: 'API_KEY=abc' } }],
      },
    })}\n`);
  }
  parser.end();

  const trail = parser.trail();
  assert.equal(trail.events.length, 2, 'the trail cannot grow without limit');
  assert.equal(trail.dropped, 3, 'and says how much it dropped');
  const text = JSON.stringify(trail.events);
  assert.equal(text.includes('API_KEY'), false);
  assert.equal(text.includes('secret.env'), false);
  assert.match(text, /"tool":"Write"/);
});

test('lines that are not stream events are counted rather than silently ignored', () => {
  const parser = createStreamParser();
  parser.push('a npm warning on stdout\n');
  parser.push(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false })}\n`);
  parser.end();
  assert.equal(parser.counters().unparsableLines, 1);
  assert.equal(parser.counters().streamEvents, 1);
});

test('renderEvent produces one timestamped line and nothing else', () => {
  const line = renderEvent({ category: 'READ', detail: 'a.ts', at: '2026-09-08T10:31:02.000Z' }, 'normal');
  assert.equal(line, '[10:31:02] READ a.ts');
  assert.equal(normalizeLogLevel('BOGUS'), 'normal');
  assert.equal(normalizeLogLevel('VERBOSE'), 'verbose');
});
