/**
 * What the Claude CLI actually accepts.
 *
 * Goal 005 R1 attempt a2 died on
 *
 *   Error: When using --print, --output-format=stream-json requires --verbose
 *
 * after the harness switched to the event stream. Every existing test passed,
 * because every one of them used a fake spawn: they proved what argv we BUILD,
 * never what the CLI ACCEPTS. These tests close that gap on the side we can
 * close it without spending an inference — a canonical, pre-spawn validator
 * that refuses combinations we already know are invalid.
 *
 * No model is called anywhere in this file, and no CLI subprocess is started:
 * proving the CLI's behaviour would need a real session, so the constraint is
 * encoded here instead, from the CLI's own message.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLI_EFFORT_LEVELS,
  assertArgvCompatible,
  buildArgs,
  validateClaudeCliArgs,
} from '../lib/claude-process.mjs';
import { classifyFailure, CAPACITY_REASONS } from '../lib/capacity-classifier.mjs';

const OPUS = 'claude-opus-5';
const SCHEMA = { type: 'object' };

const base = (overrides = {}) => ({
  prompt: 'p',
  model: OPUS,
  jsonSchema: SCHEMA,
  sessionId: '11111111-1111-4111-8111-111111111111',
  ...overrides,
});

const valueOf = (args, flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const countOf = (args, flag) => args.filter((a) => a === flag).length;

// --- 1-8. buildArgs -------------------------------------------------------

test('1. stream-json with --print always carries --verbose', () => {
  const args = buildArgs(base({ outputFormat: 'stream-json' }));
  assert.ok(args.includes('--print'));
  assert.ok(args.includes('--verbose'), 'the CLI rejects stream-json under --print without --verbose');
  assert.equal(valueOf(args, '--output-format'), 'stream-json');
});

test('2. plain json needs no --verbose, and does not get one', () => {
  const args = buildArgs(base({ outputFormat: 'json' }));
  assert.equal(valueOf(args, '--output-format'), 'json');
  assert.ok(!args.includes('--verbose'), '--verbose is a stream-json requirement, not a default');
});

test('3. stream-json keeps --json-schema', () => {
  const args = buildArgs(base({ outputFormat: 'stream-json' }));
  assert.equal(valueOf(args, '--json-schema'), JSON.stringify(SCHEMA));
});

test('4. stream-json keeps --resume and drops --session-id', () => {
  const args = buildArgs(base({ outputFormat: 'stream-json', persistSession: true, resume: true }));
  assert.equal(valueOf(args, '--resume'), '11111111-1111-4111-8111-111111111111');
  assert.ok(!args.includes('--session-id'));
  assert.ok(!args.includes('--no-session-persistence'));
});

test('5. stream-json keeps --model', () => {
  assert.equal(valueOf(buildArgs(base({ outputFormat: 'stream-json' })), '--model'), OPUS);
});

test('6. stream-json keeps --effort', () => {
  const args = buildArgs(base({ outputFormat: 'stream-json', effort: 'high' }));
  assert.equal(valueOf(args, '--effort'), 'high');
  for (const level of CLI_EFFORT_LEVELS) {
    assert.equal(valueOf(buildArgs(base({ outputFormat: 'stream-json', effort: level })), '--effort'), level);
  }
});

test('7. argument order is stable and produces no duplicates', () => {
  const args = buildArgs(base({
    outputFormat: 'stream-json', effort: 'medium', persistSession: true, resume: true,
    tools: ['Read', 'Bash'], permissionMode: 'auto', addDirs: ['E:/wt'], safeMode: false,
  }));
  for (const flag of ['--print', '--model', '--output-format', '--json-schema', '--tools', '--effort', '--resume']) {
    assert.equal(countOf(args, flag), 1, `${flag} must appear exactly once`);
  }
  // Built twice, identical twice: nothing here depends on call order or time.
  assert.deepEqual(args, buildArgs(base({
    outputFormat: 'stream-json', effort: 'medium', persistSession: true, resume: true,
    tools: ['Read', 'Bash'], permissionMode: 'auto', addDirs: ['E:/wt'], safeMode: false,
  })));
});

test('8. --verbose is never emitted twice', () => {
  assert.equal(countOf(buildArgs(base({ outputFormat: 'stream-json' })), '--verbose'), 1);
  // And a hand-assembled argv carrying it twice is refused rather than shipped.
  assert.throws(
    () => assertArgvCompatible(['--print', '--output-format', 'stream-json', '--verbose', '--verbose']),
    (error) => error.code === 'INVALID_CLAUDE_CLI_ARGS' && /duplicated/i.test(error.message),
  );
});

// --- 12-13. The canonical validator ---------------------------------------

test('12. print + stream-json without verbose is INVALID_CLAUDE_CLI_ARGS', () => {
  assert.throws(
    () => validateClaudeCliArgs({ print: true, outputFormat: 'stream-json', verbose: false }),
    (error) => error.code === 'INVALID_CLAUDE_CLI_ARGS' && /requires --verbose/.test(error.message),
  );
  // And the same combination coming from an already-built argv.
  assert.throws(
    () => assertArgvCompatible(['--print', '--output-format', 'stream-json']),
    (error) => error.code === 'INVALID_CLAUDE_CLI_ARGS',
  );
});

test('13. print + stream-json + verbose is valid', () => {
  assert.equal(validateClaudeCliArgs({ print: true, outputFormat: 'stream-json', verbose: true }), true);
  assert.deepEqual(
    assertArgvCompatible(['--print', '--output-format', 'stream-json', '--verbose']),
    ['--print', '--output-format', 'stream-json', '--verbose'],
  );
});

test('13b. the validator also refuses the other combinations we know are invalid', () => {
  assert.throws(
    () => validateClaudeCliArgs({ outputFormat: 'yaml' }),
    (error) => error.code === 'INVALID_CLAUDE_CLI_ARGS',
  );
  assert.throws(
    () => validateClaudeCliArgs({ effort: 'ultra' }),
    (error) => error.code === 'INVALID_CLAUDE_CLI_ARGS',
  );
  assert.throws(
    () => validateClaudeCliArgs({ resume: true, persistSession: false }),
    (error) => error.code === 'INVALID_CLAUDE_CLI_ARGS',
  );
});

test('13c. every argv this harness builds passes its own compatibility check', () => {
  // Defence in depth: the builder validates, and what it returns is validated
  // again. A future flag cannot slip past by being added after the check.
  for (const outputFormat of ['json', 'stream-json']) {
    for (const effort of [null, ...CLI_EFFORT_LEVELS]) {
      for (const resume of [false, true]) {
        const args = buildArgs(base({ outputFormat, effort, resume, persistSession: resume }));
        assert.doesNotThrow(() => assertArgvCompatible(args));
      }
    }
  }
});

// --- 14-21. Classification ------------------------------------------------

const classify = (message, code = 'NON_ZERO_EXIT') =>
  classifyFailure({ error: { code, message } }).reason;

test('14. "requires --verbose" is a HARNESS_ERROR, not an unknown', () => {
  // The literal message that stopped Goal 005 R1 a2.
  assert.equal(
    classify('CLI exited with code 1: Error: When using --print, --output-format=stream-json requires --verbose'),
    CAPACITY_REASONS.HARNESS_ERROR,
  );
});

test('15. "unknown option" is a HARNESS_ERROR', () => {
  assert.equal(classify("error: unknown option '--foo'"), CAPACITY_REASONS.HARNESS_ERROR);
  assert.equal(classify('Error: unrecognized argument --bar'), CAPACITY_REASONS.HARNESS_ERROR);
});

test('16. an invalid flag value is a HARNESS_ERROR', () => {
  assert.equal(classify('Error: invalid value for --effort'), CAPACITY_REASONS.HARNESS_ERROR);
  assert.equal(classify('Error: unsupported output format "yaml"'), CAPACITY_REASONS.HARNESS_ERROR);
  assert.equal(classify('Error: --json-schema is not valid JSON: unexpected token'), CAPACITY_REASONS.HARNESS_ERROR);
  assert.equal(classify('Error: --resume cannot be used with --session-id'), CAPACITY_REASONS.HARNESS_ERROR);
  assert.equal(classify('Error: --print and --ide are mutually exclusive'), CAPACITY_REASONS.HARNESS_ERROR);
});

test('16b. our own pre-spawn refusal classifies as a HARNESS_ERROR too', () => {
  assert.equal(
    classifyFailure({ error: { code: 'INVALID_CLAUDE_CLI_ARGS', message: 'refused before spawn' } }).reason,
    CAPACITY_REASONS.HARNESS_ERROR,
  );
  assert.equal(
    classifyFailure({ error: { code: 'UNSUPPORTED_EFFORT', message: 'effort "ultra"' } }).reason,
    CAPACITY_REASONS.HARNESS_ERROR,
  );
});

test('17. a session limit is still USAGE_LIMIT', () => {
  assert.equal(
    classify("CLI exited with code 1: You've hit your session limit \u00b7 resets 3:10am (America/Sao_Paulo)"),
    CAPACITY_REASONS.USAGE_LIMIT,
  );
  assert.equal(classify('You have hit your usage limit'), CAPACITY_REASONS.USAGE_LIMIT);
});

test('17b. a per-model limit is USAGE_LIMIT too, not UNKNOWN_FATAL', () => {
  // Real production message, Goal 009, 2026-09-09: no "session"/"usage" word
  // next to "limit", no "reset" mentioned. Every earlier pattern missed it, so
  // the job \u2014 which had fallbackAllowed: true \u2014 was escalated to a human
  // instead of falling back to another model.
  assert.equal(
    classify(
      "CLI exited with code 1: You've reached your Fable limit. Switch to another model, "
      + 'or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.',
    ),
    CAPACITY_REASONS.USAGE_LIMIT,
  );
  // The model name is a wildcard, not a fixed list.
  assert.equal(classify("You've reached your Opus limit. Switch to another model."), CAPACITY_REASONS.USAGE_LIMIT);
});

test('17c. an unrelated "limit" is still not mistaken for capacity', () => {
  // The new per-model pattern requires "reached your \u2026 limit"; a turn count or
  // a context-size limit must not collide with it.
  assert.equal(classify('Reached maximum number of turns (50)'), CAPACITY_REASONS.UNKNOWN_FATAL);
  assert.equal(classify('context limit exceeded, please shorten the prompt'), CAPACITY_REASONS.UNKNOWN_FATAL);
});

test('18. a rate limit is still RATE_LIMIT', () => {
  assert.equal(classify('429 Too Many Requests'), CAPACITY_REASONS.RATE_LIMIT);
  assert.equal(classify('Error: model is overloaded'), CAPACITY_REASONS.RATE_LIMIT);
});

test('19. an auth error is still AUTH_ERROR', () => {
  assert.equal(classify('Not logged in. Please run /login'), CAPACITY_REASONS.AUTH_ERROR);
  assert.equal(classify('401 unauthorized'), CAPACITY_REASONS.AUTH_ERROR);
});

test('20. an unavailable model is still MODEL_UNAVAILABLE', () => {
  assert.equal(classify('Error: unknown model claude-nope-9'), CAPACITY_REASONS.MODEL_UNAVAILABLE);
  assert.equal(classify('model claude-x is not available'), CAPACITY_REASONS.MODEL_UNAVAILABLE);
});

test('21. an arbitrary failure does NOT become a HARNESS_ERROR just for exiting 1', () => {
  // The whole risk of a broader pattern set: nothing here matches on exit
  // status, only on wording the CLI uses for its own argument parsing.
  for (const message of [
    'CLI exited with code 1: something went wrong',
    'CLI exited with code 1: the agent produced no answer',
    'CLI exited with code 1: Error: the review could not be completed',
    'CLI exited with code 1',
  ]) {
    assert.equal(classify(message), CAPACITY_REASONS.UNKNOWN_FATAL, `"${message}" must stay UNKNOWN_FATAL`);
  }
});

test('21b. a model-side error is never captured by the argument patterns', () => {
  assert.equal(classify('Error: request timed out'), CAPACITY_REASONS.UNKNOWN_TRANSIENT);
  assert.equal(classify('credit balance is too low'), CAPACITY_REASONS.BILLING_ERROR);
});
