/**
 * IA Loop — incremental parsing of the Claude CLI event stream.
 *
 * `--output-format stream-json` makes the CLI emit one JSON object per line
 * WHILE it works: a session init, one message per assistant turn (whose content
 * blocks include the tools it decided to use), one message per tool result, and
 * finally a `result` object carrying exactly the same envelope that
 * `--output-format json` would have printed at the end.
 *
 * So this module buys real-time progress for zero extra tokens: the stream is
 * produced whether or not anybody parses it, and the final envelope is
 * preserved byte-for-byte as the orchestrator's authority.
 *
 * What it deliberately never surfaces:
 *
 *   - assistant text or thinking blocks (that is reasoning, not telemetry);
 *   - tool INPUTS beyond a path, a pattern or a sanitized command;
 *   - tool RESULT content (that would be file content).
 *
 * Unknown event types are ignored rather than guessed at, so a future CLI
 * version can add events without this becoming a parser bug.
 */

import { sanitize, shortenPath } from './telemetry.mjs';

/** Tool name → telemetry category. Anything unlisted falls back to TOOL. */
const TOOL_CATEGORY = Object.freeze({
  Read: 'READ',
  NotebookRead: 'READ',
  Grep: 'SEARCH',
  Glob: 'SEARCH',
  WebSearch: 'SEARCH',
  Edit: 'EDIT',
  MultiEdit: 'EDIT',
  NotebookEdit: 'EDIT',
  Write: 'WRITE',
  Bash: 'BASH',
  PowerShell: 'BASH',
  TodoWrite: 'STATE',
});

/** Commands that are really a test run, so they read as TEST, not as BASH. */
const TEST_COMMAND = /(^|\s|&&|\|\||;)(npm|pnpm|yarn|node)\s+(run\s+)?(test|validate|typecheck|lint)|(^|\s)(vitest|jest|pytest|go\s+test|cargo\s+test|dotnet\s+test)\b|--test\b/i;
const GIT_COMMAND = /(^|\s|&&|\|\||;)git\s+/i;
const DELETE_COMMAND = /(^|\s|&&|\|\||;)(rm|rmdir|del|Remove-Item)\s+/i;

/** Classifies a Bash command without ever guessing at its effect. */
export function categorizeCommand(command) {
  const text = typeof command === 'string' ? command : '';
  if (DELETE_COMMAND.test(text)) return 'DELETE';
  if (TEST_COMMAND.test(text)) return 'TEST';
  if (GIT_COMMAND.test(text)) return 'GIT';
  return 'BASH';
}

/**
 * Turns one tool_use block into a safe {category, detail} pair.
 *
 * Only named, known-safe fields are read out of the input. Everything else in
 * the tool's input is dropped: a Write's `content`, an Edit's `new_string` and
 * a tool result's payload never reach a terminal or a log file.
 */
export function describeToolUse({ name, input = {} }, { root = null } = {}) {
  const category = TOOL_CATEGORY[name] ?? 'TOOL';

  if (category === 'READ' || category === 'WRITE' || category === 'EDIT') {
    const path = input.file_path ?? input.path ?? input.notebook_path ?? '';
    return { category, detail: shortenPath(path, { root }) || sanitize(name) };
  }

  if (category === 'SEARCH') {
    const pattern = input.pattern ?? input.query ?? '';
    const where = input.path ?? input.glob ?? '';
    const parts = [sanitize(pattern, { maxLength: 80 })];
    if (where) parts.push(`in ${shortenPath(where, { root, maxLength: 60 })}`);
    return { category, detail: parts.filter(Boolean).join(' ') || sanitize(name) };
  }

  if (category === 'BASH') {
    const command = input.command ?? '';
    return { category: categorizeCommand(command), detail: sanitize(command) };
  }

  if (category === 'STATE') {
    // Never the todo text itself: it is the model's own planning prose.
    const count = Array.isArray(input.todos) ? input.todos.length : null;
    return { category, detail: count === null ? 'todo' : `todo · ${count} item(s)` };
  }

  return { category, detail: sanitize(name) };
}

/**
 * Builds the incremental parser.
 *
 * `push(chunk)` may be called with arbitrary fragments; lines are reassembled
 * internally. `end()` flushes whatever is left. `envelope()` returns the final
 * `result` object — the structured output the orchestrator validates.
 */
export const MAX_TRAIL_EVENTS = 500;

export function createStreamParser({
  onEvent = () => {},
  root = null,
  now = () => Date.now(),
  /**
   * How many stream events keep a metadata entry in the trail. The trail is
   * metadata ONLY - a type, an index, a tool name, a duration - and exists so
   * the usage ledger can say what a call did without duplicating the logs the
   * harness already keeps. Bounded so a very long agent turn cannot grow it
   * without limit.
   */
  maxTrailEvents = MAX_TRAIL_EVENTS,
  clock = () => new Date().toISOString(),
} = {}) {
  let buffer = '';
  let envelope = null;
  /**
   * Deterministic counts of what the stream carried.
   *
   * Every one of these is a tally of an event the CLI emitted anyway. Nothing
   * is asked of the model to produce them, and nothing here is inferred: an
   * event either arrived or it did not.
   */
  const counts = {
    streamEvents: 0,
    unparsableLines: 0,
    byType: Object.create(null),
    assistantMessages: 0,
    userMessages: 0,
    toolUseEvents: 0,
    toolResultEvents: 0,
    toolErrorEvents: 0,
  };
  /** Tool name to { calls, errors }. The breakdown the ledger records. */
  const toolCalls = new Map();
  /** Bounded metadata trail, never content. */
  const trail = [];
  let trailDropped = 0;
  let initSessionId = null;
  let initModel = null;

  function pushTrail(entry) {
    if (trail.length >= maxTrailEvents) {
      trailDropped += 1;
      return;
    }
    trail.push({ index: counts.streamEvents, at: clock(), ...entry });
  }

  function countTool(name, { error = false } = {}) {
    const key = typeof name === 'string' && name !== '' ? name : 'UNKNOWN';
    const record = toolCalls.get(key) ?? { calls: 0, errors: 0 };
    if (error) record.errors += 1;
    else record.calls += 1;
    toolCalls.set(key, record);
  }
  // tool_use id → { category, detail, startedAt }, so a result can report the
  // duration of the call it belongs to.
  const pending = new Map();
  // Distinct `message.model` values seen on `assistant` events, in the order
  // first observed. This is the ONLY explicit, CLI-reported identity of which
  // model produced the visible conversation turn: every `assistant` stream
  // event is "shaped like an Anthropic Messages API Message object … id,
  // model, content blocks …" (confirmed from the installed CLI's own event
  // schema). Unlike `usage`/`modelUsage`, it is never inferred from token
  // accounting.
  const servedModelsSeen = [];

  const safeEmit = (event) => {
    try {
      onEvent(event);
    } catch {
      // Telemetry must never break the process reading the stream.
    }
  };

  function handleAssistant(message) {
    const servedModel = typeof message?.model === 'string' && message.model !== '' ? message.model : null;
    if (servedModel && !servedModelsSeen.includes(servedModel)) servedModelsSeen.push(servedModel);

    counts.assistantMessages += 1;

    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      // text and thinking blocks are skipped on purpose.
      if (block?.type !== 'tool_use') continue;
      const described = describeToolUse({ name: block.name, input: block.input ?? {} }, { root });
      pending.set(block.id, { ...described, startedAt: now(), name: block.name ?? null });
      counts.toolUseEvents += 1;
      countTool(block.name);
      pushTrail({ type: 'tool_use', tool: block.name ?? null, category: described.category });
      safeEmit({ ...described, tool: block.name ?? null });
    }
  }

  function handleUser(message) {
    counts.userMessages += 1;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      const started = pending.get(block.tool_use_id);
      pending.delete(block.tool_use_id);
      const isError = block.is_error === true;
      counts.toolResultEvents += 1;
      if (isError) {
        counts.toolErrorEvents += 1;
        countTool(started?.name, { error: true });
      }
      pushTrail({
        type: 'tool_result',
        tool: started?.name ?? null,
        category: started?.category ?? null,
        isError,
        durationMs: started ? now() - started.startedAt : null,
      });
      // The result CONTENT is never rendered — only whether it failed.
      safeEmit({
        category: 'RESULT',
        detail: `${started?.category ?? 'TOOL'}${started?.detail ? ` ${started.detail}` : ''} — ${isError ? 'error' : 'ok'}`,
        tool: started?.category ?? null,
        isError,
        durationMs: started ? now() - started.startedAt : null,
      });
    }
  }

  function handle(event) {
    if (!event || typeof event !== 'object') return;

    counts.streamEvents += 1;
    const type = typeof event.type === 'string' ? event.type : 'unknown';
    counts.byType[type] = (counts.byType[type] ?? 0) + 1;

    switch (event.type) {
      case 'system':
        if (event.subtype === 'init') {
          initSessionId = typeof event.session_id === 'string' ? event.session_id : initSessionId;
          initModel = typeof event.model === 'string' ? event.model : initModel;
          pushTrail({ type: 'system.init' });
          safeEmit({ category: 'STATE', detail: `session ${String(event.session_id ?? '').slice(0, 8)} started` });
        }
        break;
      case 'assistant':
        handleAssistant(event.message);
        break;
      case 'user':
        handleUser(event.message);
        break;
      case 'result':
        // The authority. Kept verbatim; the orchestrator validates it exactly
        // as it validates a non-streamed envelope.
        envelope = event;
        pushTrail({ type: 'result', subtype: event.subtype ?? null, isError: event.is_error === true });
        safeEmit({
          category: 'RESULT',
          detail: `agent finished — ${event.is_error === true ? 'error' : 'ok'}`,
          isError: event.is_error === true,
          durationMs: Number.isFinite(event.duration_ms) ? event.duration_ms : null,
        });
        break;
      default:
        // Unknown event types are not guessed at.
        break;
    }
  }

  function consumeLine(line) {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Not a stream event (a warning on stdout, for example). Ignored, but
      // counted: a stream that produced only noise is a fact worth having.
      counts.unparsableLines += 1;
      return;
    }
    handle(parsed);
  }

  return {
    push(chunk) {
      buffer += String(chunk);
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        consumeLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
    },

    end() {
      if (buffer.trim() !== '') consumeLine(buffer);
      buffer = '';
    },

    /** The final `result` event, or null if the stream never produced one. */
    envelope() {
      return envelope;
    },

    /**
     * Distinct `message.model` ids observed on `assistant` events, in first-seen
     * order. This is the explicit evidence `resolveServedPrimaryModel` uses; it
     * is never derived from `usage`/`modelUsage`.
     */
    servedModels() {
      return [...servedModelsSeen];
    },

    /**
     * Deterministic tallies of the stream, for the usage ledger.
     *
     * Counts of events that were emitted regardless; no inference, no model
     * involvement, and no content. `toolCalls` is the per-tool breakdown.
     */
    counters() {
      return {
        ...counts,
        byType: { ...counts.byType },
        toolCallCount: counts.toolUseEvents,
        toolCalls: [...toolCalls.entries()].map(([tool, record]) => ({ tool, ...record })),
        initSessionId,
        initModel,
      };
    },

    /** Bounded metadata trail of the stream. Never prompts, never content. */
    trail() {
      return { events: [...trail], dropped: trailDropped };
    },
  };
}
