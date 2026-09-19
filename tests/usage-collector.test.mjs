/**
 * Integration tests for model-usage telemetry, from `invokeAgent` down to a row.
 *
 * Nothing here spawns a real CLI or spends a token: every invocation is a fake
 * child process replaying a stream captured from the CLI's own documented event
 * shapes. What is being proved is that a call cannot happen without a row, that
 * the row says who called and why, and that no arrangement of retries, reroutes,
 * crashes or replays can make the same tokens count twice.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { invokeAgent } from '../lib/claude-process.mjs';
import { createUsageCollector, generateInvocationId, usageLedgerEnabled } from '../lib/usage-collector.mjs';
import { LEDGER_STATUS } from '../lib/usage-ledger.mjs';
import { withUsageContext, routingContext } from '../lib/usage-context.mjs';
import { runWithCapacity } from '../lib/capacity-runner.mjs';
import {
  FABLE, HAIKU, OPUS, SONNET,
  errorResult, modelUsageEntry, streamOf, successResult, topLevelUsage,
} from './fixtures/cli-envelopes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..');

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ia-loop-usage-'));
  const collectors = [];
  t.after(() => {
    for (const collector of collectors) collector.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return {
    dir,
    collector(options = {}) {
      const collector = createUsageCollector({
        stateDir: dir,
        path: join(dir, 'usage.sqlite'),
        onFailure: () => {},
        ...options,
      });
      collectors.push(collector);
      return collector;
    },
  };
}

function fakeSpawn({ stdout = '', stderr = '', exitCode = 0, hang = false } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.emit('close', null); return true; };
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

const DEVELOPER_PAYLOAD = { protocolVersion: 2, role: 'developer', ok: true };

function invoke({ collector, context = {}, model = OPUS, family = 'opus', stdout, exitCode = 0, ...rest }) {
  return withUsageContext(context, () => invokeAgent({
    executable: 'claude',
    model,
    expectedFamily: family,
    expectedRole: 'developer',
    prompt: 'do the thing',
    cwd: PACKAGE_ROOT,
    validatePayload: () => {},
    spawnFn: fakeSpawn({ stdout, exitCode }),
    usageCollector: collector,
    ...rest,
  }));
}

function rows(collector) {
  return collector.query('SELECT * FROM model_usage ORDER BY created_at, started_at');
}

// --- one call, one row -----------------------------------------------------

test('an invocation records exactly one row carrying its identity, routing and usage', async (t) => {
  const collector = scratch(t).collector();

  const context = {
    goalId: '008',
    roundId: 2,
    jobId: '008-r2-developer-abc',
    attemptId: '008-r2-developer-abc#a2',
    attempt: 2,
    role: 'developer',
    ...routingContext({
      stage: 'implementation', modelKey: 'opus', family: 'opus', model: OPUS, effort: 'high',
      complexity: 'HIGH', riskScore: 6, reason: 'SECURITY_SURFACE', signals: ['auth', 'tenant'], mode: 'AUTO',
    }),
  };

  const outcome = await invoke({
    collector,
    context,
    effort: 'high',
    stdout: streamOf({
      tools: [{ name: 'Read', input: { file_path: 'a.ts' } }, { name: 'Bash', input: { command: 'npm test' } }],
      result: successResult({ payload: DEVELOPER_PAYLOAD }),
    }),
  });

  assert.equal(outcome.error, null);
  const [row] = rows(collector);
  assert.ok(row, 'the call produced a ledger row');

  assert.equal(row.goal_id, '008');
  assert.equal(row.round_id, 2);
  assert.equal(row.job_id, '008-r2-developer-abc');
  assert.equal(row.attempt_id, '008-r2-developer-abc#a2');
  assert.equal(row.attempt, 2);
  assert.equal(row.role, 'developer');
  assert.equal(row.operation, 'implementation');
  assert.equal(row.phase, 'UNKNOWN');

  assert.equal(row.requested_model, OPUS);
  assert.equal(row.resolved_model, OPUS);
  assert.equal(row.model_key, 'opus');
  assert.equal(row.effort, 'high');

  assert.equal(row.complexity, 'HIGH');
  assert.equal(row.risk_score, 6);
  assert.equal(row.routing_reason, 'SECURITY_SURFACE');
  assert.deepEqual(JSON.parse(row.routing_signals_json), ['auth', 'tenant']);
  assert.equal(row.routing_mode, 'AUTO');

  assert.equal(row.status, 'COMPLETED');
  assert.equal(row.model_call_started, 1);
  assert.equal(row.num_turns, 7);
  assert.equal(row.tool_call_count, 2);
  assert.equal(row.assistant_messages, 3, 'one text turn plus one per tool call');
  assert.ok(row.duration_ms >= 0);
  assert.equal(row.cli_duration_ms, 61_000);
  assert.equal(row.duration_api_ms, 54_000);
  assert.equal(row.provider_reported_cost_usd, 0.4212);
  assert.ok(row.session_id, 'the session the call ran under is recorded');
});

test('tool calls are broken down per tool, without storing any tool output', async (t) => {
  const collector = scratch(t).collector();

  await invoke({
    collector,
    stdout: streamOf({
      tools: [
        { name: 'Read', input: { file_path: 'a.ts' } },
        { name: 'Read', input: { file_path: 'b.ts' } },
        { name: 'Bash', input: { command: 'echo SUPER_SECRET=abc' }, isError: true },
      ],
      result: successResult({ payload: DEVELOPER_PAYLOAD }),
    }),
  });

  const breakdown = collector.query('SELECT tool, calls, errors FROM model_usage_tool_call ORDER BY tool');
  assert.deepEqual(breakdown.map((row) => ({ ...row })), [
    { tool: 'Bash', calls: 1, errors: 1 },
    { tool: 'Read', calls: 2, errors: 0 },
  ]);

  const events = collector.query('SELECT metadata_json FROM model_usage_event');
  const text = events.map((event) => event.metadata_json).join('');
  assert.equal(text.includes('SUPER_SECRET'), false, 'the trail is metadata, never a command');
  assert.equal(text.includes('a.ts'), false, 'and never a path a tool touched');
});

// --- routing metadata ------------------------------------------------------

test('planning, development, escalation and review each record their own model and reason', async (t) => {
  const collector = scratch(t).collector();

  const calls = [
    {
      label: 'planning',
      model: FABLE, family: 'fable',
      context: {
        goalId: '009', roundId: 0, jobId: 'p1', attemptId: 'p1#a1', role: 'tech_lead',
        ...routingContext({ stage: 'planning', modelKey: 'fable', family: 'fable', model: FABLE, complexity: 'HIGH', reason: 'PLANNING_RISK', signals: [], mode: 'AUTO' }),
      },
    },
    {
      label: 'developer',
      model: SONNET, family: 'sonnet',
      context: {
        goalId: '009', roundId: 1, jobId: 'd1', attemptId: 'd1#a1', role: 'developer',
        ...routingContext({ stage: 'implementation', modelKey: 'sonnet', family: 'sonnet', model: SONNET, reason: 'DEFAULT_PROFILE', signals: [], mode: 'AUTO' }),
      },
    },
    {
      label: 'developer escalation',
      model: OPUS, family: 'opus',
      context: {
        goalId: '009', roundId: 1, jobId: 'd1', attemptId: 'd1#a2', role: 'developer',
        ...routingContext({ stage: 'implementation', modelKey: 'opus', family: 'opus', model: OPUS, reason: 'MODEL_ESCALATION', signals: [], mode: 'AUTO' }),
        isEscalation: true, escalationFromModel: 'sonnet', escalationReason: 'REPEATED_FAILURE',
      },
    },
    {
      label: 'review',
      model: OPUS, family: 'opus',
      context: {
        goalId: '009', roundId: 1, jobId: 'r1', attemptId: 'r1#a1', role: 'tech_lead',
        ...routingContext({ stage: 'review', modelKey: 'opus', family: 'opus', model: OPUS, reason: 'REVIEW_STANDARD', signals: [], mode: 'AUTO' }),
      },
    },
  ];

  for (const call of calls) {
    // eslint-disable-next-line no-await-in-loop -- ordering is what is under test
    await invoke({
      collector,
      context: call.context,
      model: call.model,
      family: call.family,
      stdout: streamOf({ model: call.model, result: successResult({ model: call.model, payload: DEVELOPER_PAYLOAD }) }),
    });
  }

  const recorded = rows(collector);
  assert.equal(recorded.length, 4);
  assert.deepEqual(
    recorded.map((row) => [row.operation, row.role, row.resolved_model, row.routing_reason]),
    [
      ['planning', 'tech_lead', FABLE, 'PLANNING_RISK'],
      ['implementation', 'developer', SONNET, 'DEFAULT_PROFILE'],
      ['implementation', 'developer', OPUS, 'MODEL_ESCALATION'],
      ['review', 'tech_lead', OPUS, 'REVIEW_STANDARD'],
    ],
  );

  const escalated = recorded[2];
  assert.equal(escalated.is_escalation, 1);
  assert.equal(escalated.escalation_from_model, 'sonnet');
  assert.equal(escalated.escalation_reason, 'REPEATED_FAILURE');
  assert.equal(recorded[1].is_escalation, 0);
});

test('a capacity fallback is recorded as a fallback, with the model it came from', async (t) => {
  const collector = scratch(t).collector();

  await invoke({
    collector,
    model: OPUS,
    context: {
      goalId: '009', roundId: 1, jobId: 'r1', attemptId: 'r1#a2', role: 'tech_lead',
      ...routingContext({ stage: 'review', modelKey: 'opus', family: 'opus', model: OPUS, reason: 'MODEL_FALLBACK', signals: [], mode: 'AUTO' }),
      isFallback: true, fallbackFromModel: 'fable', fallbackReason: 'USAGE_LIMIT',
    },
    stdout: streamOf({ result: successResult({ payload: DEVELOPER_PAYLOAD }) }),
  });

  const [row] = rows(collector);
  assert.equal(row.is_fallback, 1);
  assert.equal(row.fallback_from_model, 'fable');
  assert.equal(row.fallback_reason, 'USAGE_LIMIT');
  assert.equal(row.is_escalation, 0);
});

// --- failures --------------------------------------------------------------

test('an attempt that hit a usage limit keeps its partial consumption', async (t) => {
  const collector = scratch(t).collector();

  await invoke({
    collector,
    exitCode: 1,
    context: { goalId: '009', roundId: 1, jobId: 'd1', attemptId: 'd1#a1', role: 'developer' },
    stdout: streamOf({
      tools: [{ name: 'Read', input: { file_path: 'a.ts' } }],
      result: errorResult({
        usage: topLevelUsage({ input: 5200, output: 90 }),
        models: { [OPUS]: modelUsageEntry({ input: 5200, output: 90, costUSD: 0.11 }) },
        cost: 0.11,
        extra: { result: 'Claude usage limit reached. Your limit will reset at 4pm (America/Sao_Paulo).' },
      }),
    }),
  });

  const [row] = rows(collector);
  assert.equal(row.status, 'FAILED');
  assert.equal(row.failure_reason, 'USAGE_LIMIT');
  assert.equal(row.failure_family, 'MODEL_CAPACITY');
  assert.equal(row.model_call_started, 1);
  assert.equal(row.input_tokens, 5200);
  assert.equal(row.provider_reported_cost_usd, 0.11);
});

test('a harness failure before any inference is recorded with zero tokens and no model call', async (t) => {
  const collector = scratch(t).collector();

  // An effort value the CLI does not accept: buildArgs refuses before spawning,
  // so nothing is ever inferred and nothing can have been charged.
  const outcome = await invoke({
    collector,
    effort: 'nonsense',
    context: { goalId: '009', roundId: 1, jobId: 'd1', attemptId: 'd1#a1', role: 'developer' },
    stdout: '',
  });

  assert.ok(outcome.error);
  const [row] = rows(collector);
  assert.equal(row.status, 'FAILED');
  assert.equal(row.failure_family, 'HARNESS');
  assert.equal(row.model_call_started, 0);
  assert.equal(row.input_tokens, null);
  assert.equal(row.total_tokens, null);
});

test('an interrupted process still leaves an attributable row', async (t) => {
  const collector = scratch(t).collector();

  const outcome = await withUsageContext(
    { goalId: '009', roundId: 1, jobId: 'd1', attemptId: 'd1#a1', role: 'developer' },
    () => invokeAgent({
      executable: 'claude',
      model: OPUS,
      expectedFamily: 'opus',
      expectedRole: 'developer',
      prompt: 'x',
      cwd: PACKAGE_ROOT,
      timeoutMs: 15,
      spawnFn: fakeSpawn({ hang: true }),
      usageCollector: collector,
    }),
  );

  assert.equal(outcome.error.code, 'TIMEOUT');
  const [row] = rows(collector);
  assert.equal(row.timed_out, 1);
  assert.equal(row.goal_id, '009');
  assert.equal(row.attempt_id, 'd1#a1');
  assert.equal(row.status, 'FAILED');
});

// --- idempotency and recovery ---------------------------------------------

test('every real call mints its own invocation id, even under identical role/job/attempt', () => {
  const a = generateInvocationId();
  const b = generateInvocationId();
  assert.notEqual(a, b);
  // A UUID, not a string built from role/job/attempt: role+job+attempt is
  // exactly what TWO real calls can legitimately share (see the collision
  // test below), so it must never be what makes them the same row.
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('two REAL calls under the identical role/job/attempt are both recorded, independently', async (t) => {
  // The scenario that lost data before this fix existed: ia-loop:reclassify
  // moves a FAILED job to WAITING_FOR_CAPACITY and ia-loop:resume requeues it
  // to QUEUED, and by harness design (canStartNewAttempt / startNextAttempt,
  // see README V21/V22) the retry runs under the SAME attemptId as the
  // original failure — not a new one. A key built from role+job+attempt alone
  // made the retry's real tokens collide with the failure's row and vanish as
  // an "already recorded" duplicate.
  const collector = scratch(t).collector();
  const context = { goalId: '009', roundId: 1, jobId: 'r1', attemptId: 'r1-a1', attempt: 1, role: 'tech_lead' };

  // Call #1: fails before any served-model evidence arrives (a 429 rejected
  // ahead of streaming, as the real Goal 009 incident did).
  const h1 = collector.beginModelExecution({ context, request: { model: 'claude-fable-5-1', sessionId: 'sess-fable' } });
  collector.finalizeModelExecution(h1, {
    requestedModel: 'claude-fable-5-1', sessionId: 'sess-fable',
    envelope: errorResult({ extra: { api_error_status: 429 } }),
    structuredOutput: false,
    error: { code: 'NON_ZERO_EXIT', message: 'CLI exited with code 1: transient' },
    counters: { assistantMessages: 0, toolCallCount: 0, toolCalls: [] },
  });

  // ia-loop:reclassify + ia-loop:resume happen here — no model call, job doc
  // FAILED -> WAITING_FOR_CAPACITY -> QUEUED, SAME attemptId throughout.

  // Call #2: the SAME persistent Fable session (sessionId unchanged too, so
  // NOTHING in role/job/attempt/session distinguishes this from call #1) —
  // genuinely different, and succeeds.
  const h2 = collector.beginModelExecution({ context, request: { model: 'claude-fable-5-1', sessionId: 'sess-fable', resume: true } });
  assert.notEqual(h2.id, h1.id, 'a distinct row is opened for the retry');
  const outcome2 = collector.finalizeModelExecution(h2, {
    requestedModel: 'claude-fable-5-1', sessionId: 'sess-fable', resumed: true,
    envelope: successResult({ model: 'claude-fable-5-1', payload: { decision: 'ACCEPTED' } }),
    structuredOutput: true,
    resolvedPrimaryModel: 'claude-fable-5-1',
    counters: { assistantMessages: 40, toolCallCount: 30, toolCalls: [] },
  });
  assert.equal(outcome2.status, LEDGER_STATUS.OK, 'not ALREADY_RECORDED — this is a real, different call');

  const recorded = rows(collector);
  assert.equal(recorded.length, 2, 'both real calls are on record');
  assert.deepEqual(recorded.map((r) => [r.job_id, r.attempt_id]), [['r1', 'r1-a1'], ['r1', 'r1-a1']],
    'harness correlation (job/attempt) is identical on both, exactly as the harness reports it');
  assert.notEqual(recorded[0].invocation_id, recorded[1].invocation_id, 'their own identity is not');
  assert.equal(recorded[0].status, 'FAILED', 'the original failure is preserved exactly as it was');
  assert.equal(recorded[1].status, 'COMPLETED');
  assert.equal(collector.query('SELECT COUNT(*) AS n FROM model_usage_integrity')[0].n, 0,
    'two real calls colliding on job/attempt is not an anomaly to flag; it is the harness working as designed');
});

test('processing the same result twice leaves exactly one row and counts nothing twice', async (t) => {
  const collector = scratch(t).collector();
  const context = { goalId: '009', roundId: 1, jobId: 'd1', attemptId: 'd1#a1', role: 'developer' };
  const capture = {
    requestedModel: OPUS,
    sessionId: 'session-1',
    startedAt: '2026-09-09T10:00:00.000Z',
    finishedAt: '2026-09-09T10:01:00.000Z',
    durationMs: 60_000,
    exitCode: 0,
    envelope: successResult({ payload: DEVELOPER_PAYLOAD }),
    structuredOutput: true,
    resolvedPrimaryModel: OPUS,
    counters: { assistantMessages: 2, toolCallCount: 0, toolCalls: [] },
  };
  // "The same result" means the SAME execution replayed — expressed by
  // reusing the invocation id explicitly, never by role/job/attempt alone
  // (which two DIFFERENT real calls can also share; see the collision test).
  const invocationId = generateInvocationId();

  const first = collector.recordModelExecution({ context, capture, invocationId });
  assert.equal(first.status, LEDGER_STATUS.OK);
  const before = rows(collector);
  assert.equal(before.length, 1);

  const second = collector.recordModelExecution({ context, capture, invocationId });
  assert.equal(second.status, LEDGER_STATUS.ALREADY_RECORDED);

  const after = rows(collector);
  assert.equal(after.length, 1, 'rows before = 1, rows after = 1');
  assert.equal(after[0].input_tokens, before[0].input_tokens, 'and the tokens are unchanged');
});

test('a crash mid-inference leaves a STARTED row that reconciliation finalises exactly once', async (t) => {
  const dir = scratch(t);
  const context = { goalId: '009', roundId: 1, jobId: 'd1', attemptId: 'd1#a1', role: 'developer' };

  // The worker opens the row and is killed before the CLI answers.
  const crashed = dir.collector();
  crashed.beginModelExecution({ context, request: { model: OPUS, sessionId: 'session-1' } });
  crashed.close();

  // A new process starts, finds the orphan, and replays the recovered result.
  // It recovers the SAME invocation id from the orphaned row on disk — that,
  // not role/job/attempt, is what proves this is the execution being
  // finished rather than a new one.
  const restarted = dir.collector();
  const orphans = restarted.query("SELECT id, status, attempt_id, invocation_id FROM model_usage WHERE status = 'STARTED'");
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].attempt_id, 'd1#a1');
  assert.ok(orphans[0].invocation_id, 'the orphan carries the identity a recovery reads back');

  const recovered = restarted.recordModelExecution({
    context,
    invocationId: orphans[0].invocation_id,
    capture: {
      requestedModel: OPUS,
      sessionId: 'session-1',
      envelope: successResult({ payload: DEVELOPER_PAYLOAD }),
      structuredOutput: true,
      resolvedPrimaryModel: OPUS,
      counters: { assistantMessages: 2, toolCallCount: 0, toolCalls: [] },
    },
  });
  assert.equal(recovered.status, LEDGER_STATUS.OK);

  const all = rows(restarted);
  assert.equal(all.length, 1, 'one logical execution');
  assert.equal(all[0].status, 'COMPLETED', 'one finalised usage record');

  // A second reconciliation pass — same recovered id — must change nothing.
  const again = restarted.recordModelExecution({
    context, invocationId: orphans[0].invocation_id,
    capture: { requestedModel: OPUS, sessionId: 'session-1' },
  });
  assert.equal(again.status, LEDGER_STATUS.ALREADY_RECORDED);
  assert.equal(rows(restarted).length, 1);
  assert.equal(rows(restarted)[0].status, 'COMPLETED');
});

// --- failure policy --------------------------------------------------------

test('a ledger that cannot be written reports the failure and never fails the inference', async (t) => {
  const dir = scratch(t);
  const failures = [];
  // The path is the temp DIRECTORY, which SQLite cannot open as a database.
  // Every write therefore fails, which is exactly the condition under test.
  const broken = dir.collector({ path: dir.dir, onFailure: (failure) => failures.push(failure) });

  const outcome = await invoke({
    collector: broken,
    context: { goalId: '009', jobId: 'd1', attemptId: 'd1#a1', role: 'developer' },
    stdout: streamOf({ result: successResult({ payload: DEVELOPER_PAYLOAD }) }),
  });

  assert.equal(outcome.error, null, 'the model answer is returned regardless');
  assert.equal(outcome.structuredOutput, true);
  assert.ok(failures.length > 0, 'and the telemetry failure is reported, never swallowed silently');
});

test('a telemetry write failure is also left on disk for an operator to find', (t) => {
  const dir = scratch(t);
  const collector = createUsageCollector({ stateDir: dir.dir, path: dir.dir });
  t.after(() => collector.close());

  collector.beginModelExecution({ context: {}, request: { model: OPUS, sessionId: 's' } });

  const files = readdirSync(join(dir.dir, 'telemetry'));
  assert.ok(files.includes('usage-failures.jsonl'));
  const contents = readFileSync(join(dir.dir, 'telemetry', 'usage-failures.jsonl'), 'utf8');
  assert.match(contents, /TELEMETRY_WRITE_FAILED/);
});

test('only a RUNNING autonomous run stamps its id on a call', async (t) => {
  const dir = scratch(t);
  const runFile = join(dir.dir, 'autonomous-run.json');

  // A run that stopped for a human is a record of where it stopped. Work done
  // supervised afterwards is not its work — reading this file unconditionally
  // stamped auto-987b6c55 onto a Goal 008 closure that run never made.
  writeFileSync(runFile, JSON.stringify({ autonomousRunId: 'auto-stopped', status: 'PAUSED_FOR_HUMAN' }), 'utf8');
  const paused = dir.collector({ path: join(dir.dir, 'paused.sqlite') });
  await invoke({
    collector: paused,
    context: { goalId: '009', jobId: 'j1', attemptId: 'j1#a1', role: 'tech_lead' },
    stdout: streamOf({ result: successResult({ payload: DEVELOPER_PAYLOAD }) }),
  });
  assert.equal(paused.query('SELECT run_id FROM model_usage')[0].run_id, null);

  writeFileSync(runFile, JSON.stringify({ autonomousRunId: 'auto-live', status: 'RUNNING' }), 'utf8');
  const running = dir.collector({ path: join(dir.dir, 'running.sqlite') });
  await invoke({
    collector: running,
    context: { goalId: '009', jobId: 'j2', attemptId: 'j2#a1', role: 'tech_lead' },
    stdout: streamOf({ result: successResult({ payload: DEVELOPER_PAYLOAD }) }),
  });
  assert.equal(running.query('SELECT run_id FROM model_usage')[0].run_id, 'auto-live');
});

test('the ledger is off inside node --test unless a test names its own database', () => {
  assert.equal(usageLedgerEnabled({ NODE_TEST_CONTEXT: 'child-v8' }), false);
  assert.equal(usageLedgerEnabled({ NODE_TEST_CONTEXT: 'child-v8', IA_LOOP_TELEMETRY_DB: '/tmp/x' }), true);
  assert.equal(usageLedgerEnabled({}), true);
  assert.equal(usageLedgerEnabled({ IA_LOOP_USAGE_LEDGER: '0' }), false);
});

// --- coverage --------------------------------------------------------------

test('the CLI is spawned from exactly one place, so instrumenting it covers everything', () => {
  const sources = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.state' || entry.name === '.tmp') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')) sources.push(full);
    }
  };
  walk(PACKAGE_ROOT);

  const callers = sources.filter((file) => /\brunClaudeProcess\s*\(/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(
    callers.map((file) => file.replace(PACKAGE_ROOT, '').replace(/\\/g, '/')),
    ['/lib/claude-process.mjs'],
    'a new spawn site outside claude-process.mjs would bypass the ledger',
  );
});

test('invokeAgent records unconditionally: no flag, no branch, no opt-out', () => {
  const source = readFileSync(join(PACKAGE_ROOT, 'lib', 'claude-process.mjs'), 'utf8');
  assert.match(source, /usageCollector = defaultUsageCollector\(\)/,
    'the collector is defaulted, so a caller cannot forget to pass one');
  const finishes = source.match(/return finish\(\);/g) ?? [];
  assert.equal(finishes.length, 5, 'every exit from invokeAgent closes the ledger row');
  assert.equal(/return outcome;\n\}/.test(source.slice(source.indexOf('export async function invokeAgent'))), false,
    'no exit from invokeAgent returns without recording');
});

test('an unattributed call is still recorded, as UNKNOWN rather than not at all', async (t) => {
  const collector = scratch(t).collector();

  await invokeAgent({
    executable: 'claude',
    model: HAIKU,
    expectedFamily: 'haiku',
    expectedRole: 'developer',
    prompt: 'x',
    cwd: PACKAGE_ROOT,
    validatePayload: () => {},
    spawnFn: fakeSpawn({ stdout: streamOf({ model: HAIKU, result: successResult({ model: HAIKU, payload: DEVELOPER_PAYLOAD }) }) }),
    usageCollector: collector,
  });

  const [row] = rows(collector);
  assert.ok(row, 'a call made outside any ia-loop context is not invisible');
  assert.equal(row.operation, 'UNKNOWN');
  assert.equal(row.goal_id, null);
  assert.equal(row.resolved_model, HAIKU);
  // The row still gets its own identity — a fresh invocation id — even with
  // no ia-loop context to correlate it to; unattributed is not un-identified.
  assert.ok(row.invocation_id, 'unattributed does not mean un-identified');
  assert.equal(row.idempotency_key, row.invocation_id);
});

// --- through the capacity runner ------------------------------------------

test('the capacity runner publishes the attempt identity every call is recorded under', async (t) => {
  const collector = scratch(t).collector();
  const seen = [];

  const store = {
    async readRuntime() { return {}; },
    async hasCompletedResult() { return false; },
    async readResult() { return null; },
    async readAttemptState() { return { attempt: 1, attemptId: 'j1#a1', attemptStatus: 'QUEUED', status: 'QUEUED', history: [] }; },
    async setJobStatus() {},
    async appendEvent() {},
    async publishResult() {},
    async publishCandidateResult() {},
    async startNextAttempt() { return { created: false }; },
    async writeRuntime() {},
  };

  await runWithCapacity({
    store,
    role: 'work_unit',
    blockedAgent: 'developer',
    jobId: 'j1',
    goal: '009',
    round: 3,
    resumeFrom: 'DEVELOPER_RUNNING',
    usageContext: { workUnitId: 'WU-2' },
    router: {
      current: async () => ({
        routing: {
          stage: 'work_unit', modelKey: 'sonnet', family: 'sonnet', model: SONNET,
          effort: 'medium', complexity: 'MEDIUM', riskScore: 2, reason: 'STANDARD_UNIT',
          signals: [], mode: 'AUTO',
        },
      }),
    },
    invoke: async ({ attempt }) => {
      seen.push(attempt);
      return invokeAgent({
        executable: 'claude',
        model: SONNET,
        expectedFamily: 'sonnet',
        expectedRole: 'developer',
        prompt: 'x',
        cwd: PACKAGE_ROOT,
        validatePayload: () => {},
        spawnFn: fakeSpawn({ stdout: streamOf({ model: SONNET, result: successResult({ model: SONNET, payload: DEVELOPER_PAYLOAD }) }) }),
        usageCollector: collector,
      });
    },
  });

  assert.deepEqual(seen, [1]);
  const [row] = rows(collector);
  assert.equal(row.goal_id, '009');
  assert.equal(row.round_id, 3);
  assert.equal(row.job_id, 'j1');
  assert.equal(row.attempt_id, 'j1#a1');
  assert.equal(row.role, 'developer', 'the worker that ran it, not the store namespace');
  assert.equal(row.work_unit_id, 'WU-2');
  assert.equal(row.operation, 'work_unit');
  assert.equal(row.model_key, 'sonnet');
  assert.equal(row.routing_reason, 'STANDARD_UNIT');
});
