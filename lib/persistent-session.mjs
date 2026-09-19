/**
 * IA Loop — persistent agent session.
 *
 * Context per agent is what matters, not a process that stays alive forever.
 * The Claude Code CLI already persists a conversation to disk and resumes it by
 * id, so each turn is a short-lived process:
 *
 *   turn 1: --session-id <uuid>   (creates and persists the conversation)
 *   turn N: --resume <uuid>       (continues it, keeping the same id)
 *
 * That is strictly more robust than holding a long-lived child process: it
 * survives the orchestrator dying, a reboot, or a machine handover, and the
 * same session can later be opened in a visible terminal.
 *
 * It also has no ceiling, no rotation and no compaction of its own — the CLI
 * compacts when the window fills, and the harness never intervenes. The Tech
 * Lead's conversation reached 23 MB and 922 turns across a week of Goals
 * before anybody looked, because nothing reported it: the turn counter reset
 * on every worker restart and no lifecycle event was ever emitted. Both are
 * fixed here. This module does not impose a limit — it makes the growth
 * visible so that deciding on one is possible.
 */

import { randomUUID } from 'node:crypto';

import { SpikeError, invokeAgent } from './claude-process.mjs';
import { SESSION_STATUS } from './session-registry.mjs';

/**
 * Creates a handle to one agent's persistent conversation.
 *
 * `sessionId` may come from a registry loaded off disk, in which case the first
 * send already resumes an existing conversation rather than creating one.
 */
export function createPersistentSession({
  executable,
  role,
  model,
  expectedFamily,
  cwd,
  sessionId = randomUUID(),
  started = false,
  turns: restoredTurns = 0,
  timeoutMs = 180_000,
  onLifecycle = null,
  invoke = invokeAgent,
}) {
  if (!role) throw new SpikeError('INVALID_ARGS', 'role is required');
  if (!model) throw new SpikeError('INVALID_ARGS', 'model is required');
  if (!cwd) throw new SpikeError('INVALID_ARGS', 'cwd is required');

  /**
   * Turns over the CONVERSATION's life, not this process's.
   *
   * It used to start at zero on every construction, so a worker restart reset
   * it and the registry recorded the count since the last restart. The Tech
   * Lead's registry said `turns: 2` for a conversation whose transcript on
   * disk held 922 — the one number that would have shown the session growing
   * was measuring something else. Seeding from the restored record is what
   * makes the field mean what it is named.
   */
  let turns = Number.isInteger(restoredTurns) && restoredTurns > 0 ? restoredTurns : 0;
  let hasConversation = started;
  let status = started ? SESSION_STATUS.ACTIVE : SESSION_STATUS.CREATED;
  let lastActivity = null;

  /**
   * Reports a lifecycle transition, if anybody is listening.
   *
   * Never lets an observer break the session: telemetry that can fail a review
   * is worse than no telemetry.
   */
  async function emit(type, extra = {}) {
    if (typeof onLifecycle !== 'function') return;
    try {
      await onLifecycle({ type, role, model, sessionId, turns, ...extra });
    } catch {
      // Intentionally swallowed.
    }
  }

  return {
    role,
    model,
    cwd,

    get sessionId() {
      return sessionId;
    },
    get turns() {
      return turns;
    },
    get status() {
      return status;
    },
    get lastActivity() {
      return lastActivity;
    },

    /** Snapshot for the durable registry. */
    toRecord() {
      return { role, model, sessionId, status, cwd, turns, lastActivity };
    },

    /**
     * Sends one message. The first send creates the conversation; every later
     * send resumes it, so context accumulates across separate processes.
     */
    async send({
      prompt, jsonSchema, validatePayload, timeoutMs: perCallTimeout,
      tools = '', permissionMode = null, addDirs = [], safeMode = true,
      // Observational only. Passing a sink switches the CLI to its event
      // stream; the prompt, the schema, the model and the session are
      // unchanged, and so is the envelope parsed at the end.
      onTelemetryEvent = null, telemetryRoot = null,
    }) {
      const outcome = await invoke({
        executable,
        model,
        expectedFamily,
        expectedRole: role,
        prompt,
        jsonSchema,
        validatePayload,
        cwd,
        sessionId,
        persistSession: true,
        resume: hasConversation,
        tools,
        permissionMode,
        addDirs,
        safeMode,
        onTelemetryEvent,
        telemetryRoot,
        timeoutMs: perCallTimeout ?? timeoutMs,
      });

      turns += 1;
      lastActivity = new Date().toISOString();

      if (outcome.error) {
        status = SESSION_STATUS.ERROR;
        // A session that starts failing is the one thing about it worth
        // interrupting someone for, and it was previously invisible: the
        // status went to ERROR in memory and reached the registry only if the
        // caller happened to persist afterwards.
        await emit('AGENT_SESSION_FAILED', { reason: outcome.reason ?? null });
        return outcome;
      }

      // Only mark the conversation as resumable once a turn actually landed;
      // otherwise a later send would try to resume something that never existed.
      hasConversation = true;
      status = SESSION_STATUS.ACTIVE;
      return outcome;
    },
  };
}
