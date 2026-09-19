#!/usr/bin/env node
/**
 * IA Loop — Spike 1: Persistent Dual Session.
 *
 * Question: can we hold two independent, context-preserving agent sessions at
 * the same time — Fable as Tech Lead, Opus as Developer — sending several
 * messages to each over time without rebuilding context, and without either
 * session seeing the other's?
 *
 * Mechanism under test: the CLI's own session persistence. Each turn is a
 * separate short-lived process:
 *
 *   turn 1: --session-id <uuid>   (creates and persists the conversation)
 *   turn N: --resume <uuid>       (continues it, keeping the same id)
 *
 * Between turn 1 and turn 2 the orchestrator deliberately throws away its
 * in-memory handles and rebuilds them from the on-disk registry, which is what
 * proves the sessions survive the orchestrator (or its terminal) dying.
 *
 * Each agent is evaluated independently: one agent failing does not hide the
 * other's result, because the point of a spike is to measure real capability.
 *
 * Out of scope: Goal execution, correction loop, commits, worktrees.
 */

import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveClaudeExecutable, SpikeError } from './lib/claude-process.mjs';
import { createPersistentSession } from './lib/persistent-session.mjs';
import { isDirectExecution } from './lib/direct-execution.mjs';
import {
  assertSessionsAreIndependent,
  getSession,
  loadRegistry,
  saveRegistry,
  upsertSession,
} from './lib/session-registry.mjs';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

const STATE_DIR = join(HERE, '.state');
const REGISTRY_PATH = join(STATE_DIR, 'sessions.json');
const TIMEOUT_MS = Number(process.env.IA_LOOP_TIMEOUT_MS ?? 180_000);

const DEVELOPER_MODEL = process.env.IA_LOOP_DEVELOPER_MODEL ?? 'claude-opus-5';
const TECH_LEAD_MODEL = process.env.IA_LOOP_TECH_LEAD_MODEL ?? 'claude-fable-5-1';

const TASK_MARKER = 'OPUS-123';
const REVIEW_MARKER = 'FABLE-456';

/** Acknowledgement of the value the session was asked to remember. */
const ACK_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
};

/**
 * Two-field report, filled in from whatever the session holds.
 *
 * Phrasing matters. Asking "do you know the OTHER agent's marker?" or "list
 * everything you memorised" reads as an attempt to extract hidden context. A
 * form to fill in is a natural request and a stronger proof: one answer covers
 * both retention and isolation.
 */
const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    taskMarker: { type: ['string', 'null'] },
    reviewMarker: { type: ['string', 'null'] },
  },
  required: ['taskMarker', 'reviewMarker'],
  additionalProperties: false,
};

function assertAck(payload) {
  if (payload?.ok !== true) {
    throw new SpikeError('ACK_FAILED', `Expected ok === true but received ${JSON.stringify(payload?.ok)}`);
  }
}

function assertReportShape(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new SpikeError('INVALID_AGENT_SHAPE', 'Report payload is not a JSON object');
  }
  for (const field of ['taskMarker', 'reviewMarker']) {
    if (!(typeof payload[field] === 'string' || payload[field] === null)) {
      throw new SpikeError('INVALID_AGENT_SHAPE', `Field "${field}" must be a string or null`);
    }
  }
}

async function readCliVersion(executable) {
  try {
    const { stdout } = await execFileAsync(executable, ['--version'], { timeout: 60_000 });
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}

function failureOf(label, outcome) {
  if (outcome.error) return { code: outcome.error.code, message: `${label}: ${outcome.error.message}` };
  if (!outcome.available || !outcome.structuredOutput) {
    return { code: 'STEP_FAILED', message: `${label}: no valid structured answer` };
  }
  return null;
}

const AGENTS = [
  {
    label: 'Developer',
    role: 'developer',
    model: DEVELOPER_MODEL,
    expectedFamily: 'opus',
    ownMarker: TASK_MARKER,
    ownField: 'taskMarker',
    foreignMarker: REVIEW_MARKER,
    foreignField: 'reviewMarker',
    memorisePrompt: [
      'Estamos iniciando uma sessão de trabalho.',
      `Guarde este identificador de tarefa para o resto da conversa: TASK_MARKER=${TASK_MARKER}.`,
      'Confirme retornando apenas {"ok": true}.',
    ].join('\n'),
  },
  {
    label: 'Tech Lead',
    role: 'tech_lead',
    model: TECH_LEAD_MODEL,
    expectedFamily: 'fable',
    ownMarker: REVIEW_MARKER,
    ownField: 'reviewMarker',
    foreignMarker: TASK_MARKER,
    foreignField: 'taskMarker',
    memorisePrompt: [
      'Estamos iniciando uma sessão de revisão.',
      `Guarde este identificador de revisão para o resto da conversa: REVIEW_MARKER=${REVIEW_MARKER}.`,
      'Confirme retornando apenas {"ok": true}.',
    ].join('\n'),
  },
];

// Turn 2 deliberately adds context instead of asking for a recall: recall
// phrasings intermittently trip Opus 5's reasoning_extraction safeguard, and
// retention is proven more strongly in turn 3 anyway.
const CONTINUE_PROMPT = [
  'Continuando: registre que esta conversa está agora na fase 2 do trabalho.',
  'Confirme retornando apenas {"ok": true}.',
].join('\n');

const REPORT_PROMPT = [
  'Preencha o relatório desta conversa com dois campos.',
  'taskMarker: o identificador de tarefa definido nesta conversa, ou null se não houver.',
  'reviewMarker: o identificador de revisão definido nesta conversa, ou null se não houver.',
  'Responda apenas o JSON.',
].join('\n');

async function main() {
  let executable;
  try {
    executable = resolveClaudeExecutable();
  } catch (error) {
    console.error(`IA Loop — Persistent Dual Session Spike\n\nClaude CLI: NOT FOUND\n${error.message}\n\nOverall:\nFAIL`);
    return 1;
  }

  const version = await readCliVersion(executable.path);

  // The CLI persists sessions under a slug derived from the working directory,
  // so each role keeps a stable directory of its own, away from the repository.
  await rm(REGISTRY_PATH, { force: true });
  let registry = await loadRegistry(REGISTRY_PATH);

  const state = new Map();

  // --- Turn 1: create and persist each session -----------------------------
  for (const agent of AGENTS) {
    const cwd = join(STATE_DIR, 'workdirs', agent.role);
    await mkdir(cwd, { recursive: true });

    const session = createPersistentSession({
      executable: executable.path,
      role: agent.role,
      model: agent.model,
      expectedFamily: agent.expectedFamily,
      cwd,
      timeoutMs: TIMEOUT_MS,
    });

    const result = { primary: null, created: false, resumed: false, retained: false, isolated: false, report: null, error: null, turns: 0 };
    state.set(agent.role, result);

    const outcome = await session.send({
      prompt: agent.memorisePrompt,
      jsonSchema: ACK_SCHEMA,
      validatePayload: assertAck,
    });
    result.primary = outcome.resolvedPrimaryModel;
    result.turns = session.turns;

    const failure = failureOf(`${agent.label} turn 1`, outcome);
    if (failure) {
      result.error = failure;
    } else {
      result.created = true;
    }

    // The record is written even on failure, so the run stays diagnosable.
    registry = upsertSession(registry, agent.role, session.toRecord());
    assertSessionsAreIndependent(registry);
    await saveRegistry(REGISTRY_PATH, registry);
  }

  // --- Simulated orchestrator restart --------------------------------------
  // Every later turn addresses the sessions purely by what is on disk.
  const reloaded = await loadRegistry(REGISTRY_PATH);
  assertSessionsAreIndependent(reloaded);

  const devId = getSession(reloaded, 'developer')?.sessionId;
  const leadId = getSession(reloaded, 'tech_lead')?.sessionId;
  const idsIndependent = Boolean(devId) && Boolean(leadId) && devId !== leadId;

  // --- Turns 2 and 3: resume, accumulate, then report ----------------------
  for (const agent of AGENTS) {
    const result = state.get(agent.role);
    if (!result.created) continue;

    const record = getSession(reloaded, agent.role);
    const session = createPersistentSession({
      executable: executable.path,
      role: agent.role,
      model: record.model,
      expectedFamily: agent.expectedFamily,
      cwd: record.cwd,
      sessionId: record.sessionId,
      started: true,
      timeoutMs: TIMEOUT_MS,
    });

    const turn2 = await session.send({
      prompt: CONTINUE_PROMPT,
      jsonSchema: ACK_SCHEMA,
      validatePayload: assertAck,
    });
    result.turns = 1 + session.turns;
    registry = upsertSession(registry, agent.role, { ...session.toRecord(), turns: result.turns });
    await saveRegistry(REGISTRY_PATH, registry);

    const turn2Failure = failureOf(`${agent.label} turn 2`, turn2);
    if (turn2Failure) {
      result.error = turn2Failure;
      continue;
    }
    result.resumed = true;

    const turn3 = await session.send({
      prompt: REPORT_PROMPT,
      jsonSchema: REPORT_SCHEMA,
      validatePayload: assertReportShape,
    });
    result.turns = 1 + session.turns;
    registry = upsertSession(registry, agent.role, { ...session.toRecord(), turns: result.turns });
    await saveRegistry(REGISTRY_PATH, registry);

    const turn3Failure = failureOf(`${agent.label} turn 3`, turn3);
    if (turn3Failure) {
      result.error = turn3Failure;
      continue;
    }

    result.report = turn3.payload;
    result.retained = turn3.payload[agent.ownField] === agent.ownMarker;
    result.isolated = turn3.payload[agent.foreignField] !== agent.foreignMarker;
  }

  // --- Report --------------------------------------------------------------
  const out = [];
  const emit = (line = '') => out.push(line);

  emit('IA Loop — Persistent Dual Session Spike');
  emit('');
  emit(`Claude CLI: ${version}`);
  emit('');

  for (const agent of AGENTS) {
    const r = state.get(agent.role);
    const persistence = r.resumed ? 'OK (created, persisted, resumed by id)'
      : r.created ? 'PARTIAL (created and persisted; resume failed)'
        : 'FAIL (session not created)';

    emit(agent.label);
    emit(`  model: ${agent.model}`);
    emit(`  primary: ${r.primary ?? 'undetermined'}`);
    emit(`  session persistence: ${persistence}`);
    emit(`  turns completed: ${r.turns}`);
    emit(`  marker retained: ${r.retained ? 'YES' : 'NO'}`);
    emit(`  cross-session isolation: ${r.isolated ? 'OK' : r.report ? 'LEAKED' : 'NOT MEASURED'}`);
    if (r.report) emit(`  session report: ${JSON.stringify(r.report)}`);
    if (r.error) emit(`  blocker: [${r.error.code}] ${r.error.message.split('\n')[0]}`);
    emit('');
  }

  emit('Registry:');
  emit(`  ${REGISTRY_PATH}`);
  emit('  fields: role, model, sessionId, status, cwd, turns, lastActivity');
  emit(`  survives restart: ${idsIndependent ? 'OK (both ids reloaded from disk)' : 'FAIL'}`);
  emit(`  sessions independent: ${idsIndependent ? 'OK (distinct session ids)' : 'FAIL'}`);
  emit('');

  const passed = AGENTS.every((agent) => {
    const r = state.get(agent.role);
    return r.created && r.resumed && r.retained && r.isolated && r.primary;
  }) && idsIndependent;

  emit('Overall:');
  emit(passed ? 'PASS' : 'BLOCKED');

  const text = out.join('\n');
  if (passed) console.log(text); else console.error(text);
  return passed ? 0 : 1;
}

// Only when this file IS the program. Importing it — from a test, a doc
// generator, or an agent reading the tooling — must never start anything.
if (isDirectExecution(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(`IA Loop — Persistent Dual Session Spike\n\nUnexpected failure: ${error?.message ?? error}\n\nOverall:\nFAIL`);
      process.exitCode = 1;
    });
}
