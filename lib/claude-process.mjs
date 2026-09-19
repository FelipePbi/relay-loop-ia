/**
 * IA Loop — Spike 0 support library.
 *
 * Minimal, dependency-free wrapper around headless (--print) invocations of the
 * Claude Code CLI. Scope is deliberately limited to what Spike 0 must prove:
 * that two independent agents can be launched programmatically, with an
 * explicitly selected model, returning structured output.
 *
 * This is NOT an orchestrator and must not grow into one.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createStreamParser } from './stream-telemetry.mjs';
import { defaultUsageCollector } from './usage-collector.mjs';

/** Error carrying a stable machine-readable code, so callers never regex prose. */
export class SpikeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SpikeError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Locates the Claude Code executable.
 *
 * Order: explicit override, then PATH, then the versioned bundle shipped with
 * the Claude desktop app (highest version wins).
 */
export function resolveClaudeExecutable(env = process.env, { fs = { existsSync, readdirSync } } = {}) {
  const override = env.IA_LOOP_CLAUDE_BIN;
  if (override) {
    if (!fs.existsSync(override)) {
      throw new SpikeError('EXECUTABLE_NOT_FOUND', `IA_LOOP_CLAUDE_BIN points to a missing file: ${override}`);
    }
    return { path: override, source: 'IA_LOOP_CLAUDE_BIN' };
  }

  const pathValue = env.PATH || env.Path || '';
  const pathDirs = pathValue.split(process.platform === 'win32' ? ';' : ':');
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const name of names) {
      const full = join(dir, name);
      if (fs.existsSync(full)) return { path: full, source: 'PATH' };
    }
  }

  const appData = env.APPDATA;
  if (appData) {
    const bundleRoot = join(appData, 'Claude', 'claude-code');
    if (fs.existsSync(bundleRoot)) {
      const versions = fs
        .readdirSync(bundleRoot)
        .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
        .sort(compareSemverDesc);
      for (const version of versions) {
        const full = join(bundleRoot, version, 'claude.exe');
        if (fs.existsSync(full)) return { path: full, source: `claude-desktop-bundle@${version}` };
      }
    }
  }

  throw new SpikeError(
    'EXECUTABLE_NOT_FOUND',
    'Claude Code executable not found on PATH, and no desktop-app bundle was located. Set IA_LOOP_CLAUDE_BIN.',
  );
}

function compareSemverDesc(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pb[i] - pa[i];
  }
  return 0;
}

/** JSON Schema both agents must satisfy. */
export const AGENT_SCHEMA = {
  type: 'object',
  properties: {
    role: { type: 'string' },
    ok: { type: 'boolean' },
  },
  required: ['role', 'ok'],
  additionalProperties: false,
};

/**
 * Builds the headless argument vector.
 *
 * Isolation is intentional and layered: no tools at all, no MCP servers, no
 * skills, no user/project customizations, nothing that can prompt, and no
 * session persistence. We deliberately do NOT use any permission-bypass flag —
 * the goal is an agent that cannot act, not one allowed to act unchecked.
 */
/**
 * Effort levels the installed CLI accepts (`claude --help`, 2.1.263).
 *
 * The single source of truth: the profile registry imports it from here. The
 * CLI only WARNS about an unknown value and then runs at default effort, which
 * is a silent downgrade — so the check happens before spawn, not after.
 */
export const CLI_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/** Output formats this wrapper knows how to parse back into an envelope. */
export const OUTPUT_FORMATS = Object.freeze(['json', 'stream-json']);

/**
 * Validates a Claude CLI invocation BEFORE anything is spawned.
 *
 * This exists because of a real, expensive failure. Goal 005's review died with
 *
 *   Error: When using --print, --output-format=stream-json requires --verbose
 *
 * after the harness switched to the event stream without adding `--verbose`.
 * Every test passed, because every test used a fake spawn: they proved what
 * argv we BUILD, never what the CLI ACCEPTS. A pre-flight probe missed it too,
 * because an invalid `--session-id` short-circuits the CLI's validation before
 * this constraint is ever reached.
 *
 * So the rule is not "let the CLI tell us". A combination we already know is
 * invalid must fail here, deterministically, as our own bug — with a stable
 * code the classifier can read — rather than as a mysterious non-zero exit
 * after an attempt has already been consumed.
 *
 * Only combinations that are DOCUMENTED constraints of the CLI belong here.
 * This is not a place to guess.
 */
export function validateClaudeCliArgs({
  print = true,
  outputFormat = 'json',
  verbose = false,
  effort = null,
  resume = false,
  persistSession = false,
} = {}) {
  const problems = [];

  if (!OUTPUT_FORMATS.includes(outputFormat)) {
    problems.push(`--output-format ${JSON.stringify(outputFormat)} is not one of: ${OUTPUT_FORMATS.join(', ')}`);
  }

  // The constraint that broke Goal 005 R1 a2. Stated by the CLI itself:
  // "When using --print, --output-format=stream-json requires --verbose".
  if (print && outputFormat === 'stream-json' && !verbose) {
    problems.push('--print with --output-format stream-json requires --verbose');
  }

  if (effort !== null && effort !== undefined && !CLI_EFFORT_LEVELS.includes(effort)) {
    problems.push(`--effort ${JSON.stringify(effort)} is not one of: ${CLI_EFFORT_LEVELS.join(', ')}`);
  }

  if (resume && !persistSession) {
    problems.push('--resume requires a persisted session; a non-persisted session cannot be resumed');
  }

  if (problems.length > 0) {
    throw new SpikeError(
      'INVALID_CLAUDE_CLI_ARGS',
      `Refusing to spawn the Claude CLI with arguments it rejects: ${problems.join('; ')}`,
      { problems, outputFormat, verbose, effort, print },
    );
  }

  return true;
}

/**
 * Re-checks an argv that was already built.
 *
 * Defence in depth against drift between what `validateClaudeCliArgs` was told
 * and what actually ended up in the array — the exact gap that let a missing
 * `--verbose` reach a real run.
 */
export function assertArgvCompatible(args) {
  const argv = Array.isArray(args) ? args : [];
  const has = (flag) => argv.includes(flag);
  const valueOf = (flag) => (has(flag) ? argv[argv.indexOf(flag) + 1] : null);

  validateClaudeCliArgs({
    print: has('--print'),
    outputFormat: valueOf('--output-format') ?? 'json',
    verbose: has('--verbose'),
    effort: valueOf('--effort'),
    resume: has('--resume'),
    // `--resume` in the argv already implies the session is persisted: the
    // builder never emits both `--resume` and `--no-session-persistence`.
    persistSession: !has('--no-session-persistence'),
  });

  // A duplicated flag is a builder bug, and a silent one: the CLI would take
  // the last occurrence and the argv would no longer say what we think it says.
  const duplicated = ['--verbose', '--output-format', '--model', '--effort', '--print', '--json-schema', '--max-turns']
    .filter((flag) => argv.filter((a) => a === flag).length > 1);
  if (duplicated.length > 0) {
    throw new SpikeError(
      'INVALID_CLAUDE_CLI_ARGS',
      `Refusing to spawn the Claude CLI with duplicated arguments: ${duplicated.join(', ')}`,
      { duplicated },
    );
  }

  return argv;
}

export function buildArgs({
  prompt,
  model,
  jsonSchema,
  sessionId,
  // Reasoning effort for this call. Part of the Developer profile; null means
  // "do not pass the flag", which is what every pre-routing execution did.
  effort = null,
  /**
   * `stream-json` makes the CLI emit its events as they happen, which is what
   * real-time telemetry is derived from. The final `result` event carries the
   * same envelope `json` would have produced, so the structured output the
   * orchestrator validates is unchanged.
   *
   * This is NOT a function of the log level: the argument vector must be
   * identical at every level.
   */
  outputFormat = 'json',
  // One-shot by default: the conversation is discarded when the process exits.
  // Persistent sessions opt in, because `--no-session-persistence` is exactly
  // what makes a conversation impossible to resume later.
  persistSession = false,
  resume = false,
  // Execution profile. The default is the fully isolated one used by the spikes
  // and the synthetic slice: no tools at all, nothing that can act. Real Goal
  // execution opts in explicitly.
  tools = '',
  permissionMode = null,
  addDirs = [],
  safeMode = true,
  /**
   * Ceiling on agent turns, or null for none.
   *
   * A budget rather than a deadline: `timeoutMs` bounds the wall clock, and
   * this bounds the token cost, which grows with the SQUARE of the turn count
   * because every turn re-reads the whole accumulated transcript.
   */
  maxTurns = null,
}) {
  if (!prompt) throw new SpikeError('INVALID_ARGS', 'prompt is required');
  if (!model) throw new SpikeError('INVALID_ARGS', 'model is required');
  if (!sessionId) throw new SpikeError('INVALID_ARGS', 'sessionId is required');
  if (resume && !persistSession) {
    throw new SpikeError('INVALID_ARGS', 'resume requires persistSession: a non-persisted session cannot be resumed');
  }
  if (effort !== null && effort !== undefined && !CLI_EFFORT_LEVELS.includes(effort)) {
    throw new SpikeError(
      'UNSUPPORTED_EFFORT',
      `Effort ${JSON.stringify(effort)} is not accepted by this CLI (expected one of: ${CLI_EFFORT_LEVELS.join(', ')})`,
      { effort, supported: CLI_EFFORT_LEVELS },
    );
  }

  // `--print --output-format stream-json` is only accepted alongside
  // `--verbose`. This is a LOCAL output-shape requirement of the CLI: it
  // changes how the process prints what it was already going to produce, and
  // nothing about the prompt, the context, the model or the effort.
  const verbose = outputFormat === 'stream-json';

  // Checked before the array is built, so an invalid combination never reaches
  // a spawn and never consumes an attempt.
  validateClaudeCliArgs({ print: true, outputFormat, verbose, effort, resume, persistSession });

  const args = [
    // The prompt goes over stdin, never in argv: a real review packet exceeds
    // the ~32KB Windows command-line limit and the spawn fails with
    // ENAMETOOLONG. Measured on the first real Goal003 run.
    '--print',
    '--model', model,
    '--output-format', outputFormat,
    // Emitted only for stream-json, and only because the CLI demands it there.
    // It affects the shape of this process's stdout, never the inference.
    ...(verbose ? ['--verbose'] : []),
    '--json-schema', JSON.stringify(jsonSchema ?? AGENT_SCHEMA),
    // Tool surface. An empty string removes every built-in tool.
    '--tools', Array.isArray(tools) ? tools.join(',') : tools,
    // Nothing may block on a prompt. Combined with an explicit permission mode
    // this authorises the profile's tools while still never hanging.
    '--permission-prompts', 'none',
    '--strict-mcp-config',
    '--disable-slash-commands',
  ];

  // Only when the profile asks for one. Omitting the flag is what every
  // pre-routing execution did, and is how a legacy Goal keeps its behaviour.
  if (effort !== null && effort !== undefined) args.push('--effort', effort);

  // Let the CLI stop itself. Killing the process at turn N would leave the
  // worktree edited with no report and no envelope to read; `--max-turns` ends
  // the loop cleanly and still emits the result, so the unit can be recorded
  // as having hit its budget rather than as a harness failure.
  if (Number.isInteger(maxTurns) && maxTurns > 0) args.push('--max-turns', String(maxTurns));

  if (safeMode) args.push('--safe-mode');
  // Measured: only "auto" authorises both file writes and Bash without a
  // prompt; acceptEdits denies Bash and dontAsk denies Write.
  if (permissionMode) args.push('--permission-mode', permissionMode);
  for (const dir of addDirs) args.push('--add-dir', dir);

  if (resume) {
    // Resuming keeps the same session id, so the registry stays valid.
    args.push('--resume', sessionId);
  } else {
    // A caller-chosen session id keeps agents in separate conversations.
    args.push('--session-id', sessionId);
  }

  if (!persistSession) args.push('--no-session-persistence');

  // Last gate. Nothing leaves this function that we already know the CLI would
  // reject, and nothing leaves it with a flag emitted twice.
  return assertArgvCompatible(args);
}

/**
 * Spawns one headless invocation and returns the raw process outcome.
 * Never rejects on a non-zero exit; the caller decides what that means.
 */
export function runClaudeProcess({
  executable,
  args,
  cwd,
  timeoutMs = 120_000,
  env = process.env,
  spawnFn = spawn,
  stdinData = null,
  /**
   * Called with each stdout fragment as it arrives. Purely observational: the
   * chunk is still accumulated and returned, so the caller's parsing is
   * unaffected whether or not anybody is watching.
   */
  onStdoutChunk = null,
}) {
  return new Promise((resolve, reject) => {
    // Recorded here because this is the only place that knows when the child
    // actually started: the CLI's own `duration_ms` excludes process startup,
    // so the two figures answer different questions and the ledger keeps both.
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    let child;
    try {
      child = spawnFn(executable, args, { cwd, env, windowsHide: true });
    } catch (error) {
      reject(new SpikeError('SPAWN_FAILED', `Failed to spawn ${executable}: ${error.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    if (stdinData !== null && child.stdin) {
      // A broken pipe here must not crash the orchestrator; the process error
      // handler already reports a failed spawn.
      child.stdin.on('error', () => {});
      child.stdin.end(stdinData);
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      if (!onStdoutChunk) return;
      try {
        onStdoutChunk(String(chunk));
      } catch {
        // An observer must never be able to fail an inference.
      }
    });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const code = error.code === 'ENOENT' ? 'EXECUTABLE_NOT_FOUND' : 'SPAWN_FAILED';
      reject(new SpikeError(code, `Failed to run ${executable}: ${error.message}`));
    });

    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
        timeoutMs,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
      });
    });
  });
}

/**
 * Parses the CLI's envelope, from either output format.
 *
 * `--output-format json` prints one object. `--output-format stream-json`
 * prints one object per line and ends with a `{"type":"result",…}` that carries
 * the SAME fields. Reading the last result event therefore yields exactly the
 * envelope the non-streaming call would have produced, so switching format
 * changes nothing downstream.
 */
export function parseEnvelope(stdout) {
  const trimmed = (stdout || '').trim();
  if (!trimmed) throw new SpikeError('EMPTY_OUTPUT', 'CLI produced no stdout');

  let envelope;
  let wholeParseError = null;
  try {
    envelope = JSON.parse(trimmed);
  } catch (error) {
    wholeParseError = error;
  }

  if (wholeParseError === null) {
    if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
      throw new SpikeError('INVALID_ENVELOPE_JSON', 'CLI envelope is not a JSON object');
    }
    return envelope;
  }

  // Not one object: try the event stream.
  const events = [];
  for (const line of trimmed.split('\n')) {
    const candidate = line.trim();
    if (candidate === '') continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) events.push(parsed);
    } catch {
      // A stray non-JSON line (a warning, for example) is not the envelope.
    }
  }

  const result = events.filter((event) => event.type === 'result').at(-1);
  if (result) return result;

  throw new SpikeError(
    'INVALID_ENVELOPE_JSON',
    `CLI envelope is not valid JSON: ${wholeParseError.message}`,
  );
}

/**
 * Canonical usage field names, mapped from the top-level `usage` object (snake
 * case) to the per-model `modelUsage` entries (camel case).
 */
const USAGE_FIELDS = {
  inputTokens: 'input_tokens',
  outputTokens: 'output_tokens',
  cacheReadInputTokens: 'cache_read_input_tokens',
  cacheCreationInputTokens: 'cache_creation_input_tokens',
};

function toCount(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeTopLevelUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const normalized = {};
  for (const [canonical, snakeCase] of Object.entries(USAGE_FIELDS)) {
    normalized[canonical] = toCount(usage[snakeCase]);
  }
  return normalized;
}

function normalizeModelUsage(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const normalized = {};
  for (const canonical of Object.keys(USAGE_FIELDS)) {
    normalized[canonical] = toCount(entry[canonical]);
  }
  return normalized;
}

function usageMatches(a, b) {
  return Object.keys(USAGE_FIELDS).every((field) => a[field] === b[field]);
}

/**
 * Reconciles token accounting against a single `modelUsage` entry.
 *
 * ADVISORY ONLY. This is NOT how the served model is verified — see
 * `resolveServedPrimaryModel`, which uses the CLI's explicit `message.model`
 * evidence instead. Token counts are not proof of identity: the installed
 * CLI's own field documentation states `modelUsage` and the top-level `usage`
 * it is checked against "share a lifecycle" that is "cumulative across turns
 * in streaming … each result carries the running total so far" and "resumed
 * sessions start fresh" — behaviour a persistent multi-turn session (the Tech
 * Lead's) can legitimately hit, with no fallback involved. Goal006 R1's
 * review was lost this way: the CLI produced a valid StructuredOutput on turn
 * 3 of a resumed session, but no single `modelUsage` entry reproduced the
 * top-level counters, and the mismatch was (wrongly) treated as fatal.
 *
 * Kept for observability: a caller may compare its result against
 * `resolveServedPrimaryModel`'s explicit answer and emit
 * `MODEL_USAGE_ACCOUNTING_OBSERVED` when they disagree, without ever letting
 * the disagreement block a result. `modelUsage` legitimately contains
 * auxiliary models the CLI uses internally (Haiku for its own bookkeeping,
 * for example); their presence alone is not a fallback.
 *
 * Fails closed: never guesses when the evidence is missing or ambiguous.
 */
export function resolvePrimaryModel(envelope) {
  const modelUsage = envelope?.modelUsage;
  const observedModels = modelUsage && typeof modelUsage === 'object' && !Array.isArray(modelUsage)
    ? Object.keys(modelUsage)
    : [];

  if (observedModels.length === 0) {
    throw new SpikeError(
      'RESOLVED_MODEL_UNKNOWN',
      'CLI reported no modelUsage, so the primary model cannot be determined',
      { observedModels },
    );
  }

  const topLevelUsage = normalizeTopLevelUsage(envelope?.usage);
  if (topLevelUsage === null) {
    throw new SpikeError(
      'RESOLVED_MODEL_UNKNOWN',
      'CLI reported no top-level usage to match modelUsage against',
      { observedModels },
    );
  }

  const matches = observedModels.filter((id) => {
    const entry = normalizeModelUsage(modelUsage[id]);
    return entry !== null && usageMatches(topLevelUsage, entry);
  });

  if (matches.length === 0) {
    throw new SpikeError(
      'RESOLVED_MODEL_UNKNOWN',
      'No modelUsage entry accounts for the top-level usage, so the primary model cannot be determined',
      { observedModels },
    );
  }

  if (matches.length > 1) {
    throw new SpikeError(
      'RESOLVED_MODEL_AMBIGUOUS',
      `Several models match the top-level usage indistinguishably: ${matches.join(', ')}`,
      { observedModels, matches },
    );
  }

  const primary = matches[0];
  return {
    primary,
    auxiliary: observedModels.filter((id) => id !== primary),
    observedModels,
  };
}

/**
 * Determines which model produced the visible conversation turn, from
 * EXPLICIT evidence only — never from token accounting.
 *
 * `evidenceModels` is the set of distinct `message.model` values observed on
 * `assistant` stream events for this invocation (see `stream-telemetry.mjs`).
 * Every `assistant` event is "shaped like an Anthropic Messages API Message
 * object … id, model, content blocks …" per the installed CLI's own event
 * schema, so `message.model` is the model that actually served that turn —
 * not an inference from `usage`/`modelUsage`, which legitimately contains
 * auxiliary models (Haiku for the CLI's own bookkeeping, for example) and can
 * carry cumulative or running-total semantics across turns/resumes. Token
 * accounting is kept for observability only (see `resolvePrimaryModel`); it
 * is deliberately never consulted here.
 *
 * Fails closed: never guesses when the evidence is missing or conflicting.
 */
export function resolveServedPrimaryModel({ evidenceModels = [] } = {}) {
  const distinct = [...new Set((Array.isArray(evidenceModels) ? evidenceModels : []).filter(Boolean))];

  if (distinct.length === 0) {
    throw new SpikeError(
      'PRIMARY_MODEL_EVIDENCE_MISSING',
      'No explicit model identity was observed on the response stream (no assistant event carried message.model), so the served model cannot be verified',
    );
  }

  if (distinct.length > 1) {
    throw new SpikeError(
      'PRIMARY_MODEL_EVIDENCE_CONFLICT',
      `The response stream reported more than one served model, indistinguishably: ${distinct.join(', ')}`,
      { observed: distinct },
    );
  }

  return distinct[0];
}

/** Lists every model id the CLI reported, without interpreting them. */
export function listObservedModels(envelope) {
  const modelUsage = envelope?.modelUsage;
  if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) return [];
  return Object.keys(modelUsage);
}

/** Extracts the agent's own payload from the envelope's result field. */
export function extractAgentPayload(envelope) {
  if (envelope.is_error === true) {
    throw new SpikeError('CLI_REPORTED_ERROR', String(envelope.result ?? 'CLI reported an error'), {
      terminalReason: envelope.terminal_reason ?? null,
    });
  }

  const result = envelope.result;
  if (result && typeof result === 'object' && !Array.isArray(result)) return result;

  if (typeof result !== 'string' || result.trim() === '') {
    throw new SpikeError('MISSING_RESULT', 'CLI envelope has no usable result field');
  }

  try {
    return JSON.parse(result.trim());
  } catch (error) {
    throw new SpikeError('INVALID_AGENT_JSON', `Agent output is not valid JSON: ${error.message}`);
  }
}

/**
 * Fails loudly on silent model substitution.
 *
 * Spike 0 exists to measure real capability. If we ask for Fable and get
 * something else, that is a FAIL, never a fallback.
 */
export function assertNoSilentFallback({ requestedModel, resolvedPrimaryModel, expectedFamily }) {
  if (resolvedPrimaryModel === null || resolvedPrimaryModel === undefined) {
    throw new SpikeError(
      'RESOLVED_MODEL_UNKNOWN',
      `CLI did not report which model served "${requestedModel}", so a silent fallback cannot be ruled out`,
      { requestedModel, expectedFamily },
    );
  }
  if (!String(resolvedPrimaryModel).toLowerCase().includes(expectedFamily.toLowerCase())) {
    throw new SpikeError(
      'MODEL_FALLBACK_DETECTED',
      `Requested "${requestedModel}" (family "${expectedFamily}") but the main inference came from "${resolvedPrimaryModel}"`,
      { requestedModel, resolvedPrimaryModel, expectedFamily },
    );
  }
  return resolvedPrimaryModel;
}

/** Validates the agent payload against the contract this Spike asserts. */
export function assertAgentPayload(payload, { expectedRole }) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new SpikeError('INVALID_AGENT_SHAPE', 'Agent payload is not a JSON object');
  }
  if (payload.role !== expectedRole) {
    throw new SpikeError('ROLE_MISMATCH', `Expected role "${expectedRole}" but received ${JSON.stringify(payload.role)}`);
  }
  if (payload.ok !== true) {
    throw new SpikeError('OK_NOT_TRUE', `Expected ok === true but received ${JSON.stringify(payload.ok)}`);
  }
  return payload;
}

/**
 * Runs one agent end to end and returns an already-validated outcome.
 * Errors are captured as data so the caller can still report on both agents.
 */
export async function invokeAgent({
  executable,
  model,
  expectedFamily,
  expectedRole,
  prompt,
  cwd,
  timeoutMs = 120_000,
  env = process.env,
  spawnFn = spawn,
  sessionId = randomUUID(),
  jsonSchema = AGENT_SCHEMA,
  // Optional contract validator. Defaults to the Spike's role/ok assertion so
  // existing callers keep their behaviour unchanged.
  validatePayload = null,
  persistSession = false,
  resume = false,
  tools = '',
  permissionMode = null,
  addDirs = [],
  safeMode = true,
  // Developer profile effort. null keeps the CLI's default and passes no flag.
  effort = null,
  // Turn budget. null keeps the CLI's default and passes no flag.
  maxTurns = null,
  /**
   * Observational telemetry sink. Purely a forwarding target: when given, the
   * events the CLI stream was already producing are reported as they arrive.
   * No prompt, context, schema or model changes, and it does NOT decide
   * whether the CLI is asked for its event stream — that happens
   * unconditionally now (see below), because the stream is also where the
   * served-model evidence comes from.
   */
  onTelemetryEvent = null,
  telemetryRoot = null,
  /**
   * The usage ledger this invocation records itself in.
   *
   * Defaulted rather than optional, and unconditional below: every real model
   * call in this package goes through this function, so recording HERE is what
   * makes "no inference happens without a trail" a property of the code rather
   * than a habit. A test injects its own; production gets the shared one.
   */
  usageCollector = defaultUsageCollector(),
  /**
   * ia-loop facts this call could not know on its own. Normally empty: the
   * capacity runner publishes the Goal/round/job/attempt/routing ambiently
   * (see lib/usage-context.mjs), and this parameter only exists so a caller
   * outside that machinery can still attribute its call.
   */
  usageContext = {},
}) {
  const outcome = {
    requestedModel: model,
    // Recorded so the runtime can report what was actually asked for, not just
    // what a profile said in some earlier file.
    requestedEffort: effort ?? null,
    expectedRole,
    resolvedPrimaryModel: null,
    auxiliaryModels: [],
    observedModels: [],
    sessionId,
    available: false,
    structuredOutput: false,
    payload: null,
    // The structurally-valid candidate, kept EVEN WHEN model verification
    // fails or the caller decides not to trust it yet. This is what lets a
    // harness-side accounting/verification bug be fixed later without paying
    // for a second inference: the model's own answer is never thrown away
    // just because a later step about model identity, not content, failed.
    candidatePayload: null,
    // Advisory only, from the OLD token-accounting mechanism. Never gates
    // anything; see resolvePrimaryModel's docstring.
    usageAccounting: { matched: null, resolvedByAccounting: null, error: null },
    error: null,
    // The CLI's own record of which tool_use calls it denied — real
    // infrastructure evidence, not the model's textual account of what
    // happened. See work-unit-executor.mjs's use of this for why a BLOCKED
    // MECHANICAL unit may only escalate on THIS, never on the model's prose.
    permissionDenials: [],
  };

  // Always requested: this is the only channel that carries the CLI's
  // explicit `message.model` evidence (see resolveServedPrimaryModel). Whether
  // a telemetry sink is attached only decides whether those same events are
  // ALSO rendered/persisted for a human; it never decided the wire format.
  const parser = createStreamParser({
    onEvent: typeof onTelemetryEvent === 'function' ? onTelemetryEvent : () => {},
    root: telemetryRoot ?? cwd,
  });

  // The row is opened BEFORE the process is spawned, so a worker killed
  // mid-inference leaves a STARTED record naming the Goal, the attempt and the
  // model it was running on, rather than leaving no trace of a call that was
  // still paid for. See usage-ledger.mjs for how those are recovered.
  const invocationStartedAt = new Date().toISOString();
  const invocationStartedMs = Date.now();
  const execution = usageCollector.beginModelExecution({
    context: usageContext,
    request: { model, effort: effort ?? null, sessionId, resume },
  });

  let processResult = null;
  let envelope = null;

  /**
   * Closes the ledger row and hands the outcome back unchanged.
   *
   * Every exit from this function goes through here. It cannot alter the
   * outcome and it cannot throw: telemetry may not change, delay or fail an
   * inference, so a ledger problem is reported by the collector and the agent's
   * own answer is returned exactly as it was.
   */
  const finish = () => {
    try {
      usageCollector.finalizeModelExecution(execution, {
        requestedModel: model,
        requestedEffort: effort ?? null,
        sessionId,
        resumed: resume === true,
        startedAt: processResult?.startedAt ?? invocationStartedAt,
        finishedAt: processResult?.finishedAt ?? new Date().toISOString(),
        durationMs: processResult?.durationMs ?? (Date.now() - invocationStartedMs),
        exitCode: processResult?.exitCode ?? null,
        timedOut: processResult?.timedOut === true,
        envelope,
        counters: parser.counters(),
        trail: parser.trail(),
        error: outcome.error,
        structuredOutput: outcome.structuredOutput,
        resolvedPrimaryModel: outcome.resolvedPrimaryModel,
        observedModels: outcome.observedModels,
        auxiliaryModels: outcome.auxiliaryModels,
        hasCandidatePayload: outcome.candidatePayload !== null,
      });
    } catch {
      // Unreachable by design - the collector already swallows its own
      // failures - and caught anyway, because this must never be the thing
      // that loses a model's answer.
    }
    return outcome;
  };

  try {
    processResult = await runClaudeProcess({
      executable,
      args: buildArgs({
        prompt, model, jsonSchema, sessionId, persistSession, resume,
        tools, permissionMode, addDirs, safeMode, effort, maxTurns,
        outputFormat: 'stream-json',
      }),
      stdinData: prompt,
      cwd,
      timeoutMs,
      env,
      spawnFn,
      onStdoutChunk: (chunk) => parser.push(chunk),
    });
    parser.end();
  } catch (error) {
    outcome.error = toReportableError(error);
    return finish();
  }

  if (processResult.timedOut) {
    outcome.error = {
      code: 'TIMEOUT',
      message: `Process exceeded ${processResult.timeoutMs}ms and was killed`,
    };
    return finish();
  }

  // The envelope is worth parsing even on a non-zero exit: it usually carries
  // the real reason (for example "Not logged in").
  let envelopeError = null;
  try {
    envelope = parseEnvelope(processResult.stdout);
  } catch (error) {
    envelopeError = toReportableError(error);
  }

  // Captured regardless of exit code or payload validity: a denial is a fact
  // about what happened during the run, not a property of whether the model's
  // final answer parsed.
  if (Array.isArray(envelope?.permission_denials)) {
    outcome.permissionDenials = envelope.permission_denials;
  }

  if (processResult.exitCode !== 0) {
    const reason = envelope && typeof envelope.result === 'string'
      ? envelope.result
      : firstLine(processResult.stderr);
    outcome.error = {
      code: 'NON_ZERO_EXIT',
      message: `CLI exited with code ${processResult.exitCode}${reason ? `: ${reason}` : ''}`,
    };
    return finish();
  }

  if (envelopeError) {
    outcome.error = envelopeError;
    return finish();
  }

  // Step 1 — structural candidate: extract and validate the payload on its
  // own merits, independent of model identity. This is what Goal006 R1 got
  // wrong: a valid StructuredOutput existed but was discarded because a LATER
  // step (model-identity verification) failed first in the same try block.
  let payloadError = null;
  try {
    const payload = extractAgentPayload(envelope);
    if (validatePayload) {
      validatePayload(payload);
    } else {
      assertAgentPayload(payload, { expectedRole });
    }
    outcome.candidatePayload = payload;
    outcome.structuredOutput = true;
  } catch (error) {
    payloadError = toReportableError(error);
  }

  // Step 2 — model identity, from explicit evidence only. Recorded even when
  // it fails, so a blocked run still shows what the CLI reported.
  outcome.observedModels = listObservedModels(envelope);

  // Advisory accounting cross-check. Never thrown, never gates anything — see
  // resolvePrimaryModel's docstring for why token counts cannot be trusted.
  try {
    const accounting = resolvePrimaryModel(envelope);
    outcome.usageAccounting.resolvedByAccounting = accounting.primary;
  } catch (error) {
    outcome.usageAccounting.error = error instanceof SpikeError ? error.code : 'UNEXPECTED_ERROR';
  }

  let modelError = null;
  try {
    const servedPrimaryModel = resolveServedPrimaryModel({ evidenceModels: parser.servedModels() });
    // Recorded even when the family check below then rejects it as a
    // fallback: a diagnosis needs to show WHICH model answered, not just that
    // it was the wrong one.
    outcome.resolvedPrimaryModel = servedPrimaryModel;
    outcome.auxiliaryModels = outcome.observedModels.filter((id) => id !== servedPrimaryModel);
    outcome.usageAccounting.matched = outcome.usageAccounting.resolvedByAccounting === servedPrimaryModel;

    assertNoSilentFallback({
      requestedModel: model,
      resolvedPrimaryModel: servedPrimaryModel,
      expectedFamily,
    });
    outcome.available = true;
  } catch (error) {
    modelError = toReportableError(error);
  }

  // Step 3 — only a verified model AND a valid candidate together produce a
  // trusted result. Model identity wins when both fail: a response we cannot
  // attribute is not trustworthy regardless of its shape.
  if (modelError) {
    outcome.error = modelError;
  } else if (payloadError) {
    outcome.error = payloadError;
  } else {
    outcome.payload = outcome.candidatePayload;
  }

  return finish();
}

function toReportableError(error) {
  if (error instanceof SpikeError) return { code: error.code, message: error.message };
  return { code: 'UNEXPECTED_ERROR', message: error?.message ?? String(error) };
}

function firstLine(text) {
  return (text || '').trim().split('\n')[0] ?? '';
}
