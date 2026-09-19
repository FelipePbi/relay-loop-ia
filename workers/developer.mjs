#!/usr/bin/env node
/**
 * IA Loop — Developer worker.
 *
 * ONE worker, many profiles. The model and the effort are NOT properties of
 * this process: they arrive on the job, chosen by the Tech Lead for that Goal
 * and that round. There is deliberately no `ia-loop:developer-sonnet` and no
 * `ia-loop:developer-opus` — a second worker would be a second place for the
 * routing decision to drift.
 *
 * The PROCESS is persistent; the INFERENCE is not.
 *
 * Every job gets a brand-new Claude session. There is no --resume, no session
 * registry entry, and no attempt to carry hidden conversation state between
 * tasks. Spike 1 established that Opus 5 does not sustain reliable multi-turn
 * conversation in this environment, so context is reinjected explicitly by the
 * orchestrator instead.
 *
 * This is deliberate. Do not "fix" it by adding resume.
 */

import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { SpikeError, invokeAgent, resolveClaudeExecutable } from '../lib/claude-process.mjs';
import { createJobStore } from '../lib/job-store.mjs';
import {
  createExecutionPlanStore,
  fallbackExecutionPlan,
  unitTypeForProfile,
} from '../lib/execution-plan-store.mjs';
import { executeWorkUnitPlan } from '../lib/work-unit-executor.mjs';
import { workUnitConfig } from '../lib/work-unit-config.mjs';
import { GOAL_SUMMARY_CHARS } from '../lib/work-unit-context.mjs';
import { SESSION_STRATEGY } from '../lib/worker-registry.mjs';
import { banner, log, runWorkerLoop } from '../lib/worker-loop.mjs';
import {
  SELECTABLE_DEVELOPER_PROFILES,
  assertProfileWasHonoured,
  describeProfile,
  profileForModel,
  resolveDeveloperProfile,
} from '../lib/developer-profiles.mjs';
import { ROUTING_STAGES, routingFromProfile } from '../lib/model-routing.mjs';
import { createAttemptRouter } from '../lib/routing-runtime.mjs';
import { createTelemetry, createTelemetryFileSink, resolveLogLevel } from '../lib/telemetry.mjs';
import { runWithCapacity, RUN_OUTCOMES } from '../lib/capacity-runner.mjs';
import { LOOP_STATES } from '../lib/loop-state.mjs';
import { developerResultSchemaFor, validateDeveloperJob, validateDeveloperResult } from '../lib/contracts-v2.mjs';
import { buildDeveloperContext, buildCorrectionContext } from '../lib/context-builders.mjs';
import { isDirectExecution } from '../lib/direct-execution.mjs';
import { exitCodeForError, nameForExitCode } from '../lib/worker-exit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, '..', '.state');

const ROLE = 'developer';
// A real Goal is hours of work, not minutes.
const TIMEOUT_MS = Number(process.env.IA_LOOP_DEVELOPER_TIMEOUT_MS ?? 4 * 60 * 60 * 1000);

const LOG_LEVEL = resolveLogLevel();
const PERSIST_TELEMETRY = process.env.IA_LOOP_TELEMETRY_PERSIST !== '0';
/**
 * Real-time telemetry is derived from the CLI's own event stream. Turning it
 * off falls back to the single-JSON output format; it never changes the prompt,
 * the schema, the model or the effort either way.
 */
const STREAM_EVENTS = process.env.IA_LOOP_STREAM_EVENTS !== '0';

/**
 * Execution profile for real work.
 *
 * The Developer needs to read, write and run commands inside its worktree.
 * Measured: only permission mode "auto" authorises both file writes and Bash
 * without a prompt. safeMode is off so the project's own CLAUDE.md and AGENTS.md
 * rules load, which the Goal explicitly requires the executor to follow.
 *
 * These guards detect, they do not sandbox: Bash can reach outside the
 * worktree. The orchestrator snapshots the repository before and after and
 * fails the run on any violation.
 */
const DEVELOPER_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'TodoWrite'];

const store = createJobStore(STATE_DIR);
const planStore = createExecutionPlanStore(STATE_DIR);

/**
 * Whether this process executes a round as a Work Unit DAG.
 *
 * Read once, at module scope, for the same reason the routing mode is: a
 * switch that could change halfway through a round would make the round
 * unauditable. Flipping it takes a worker restart, which is the honest cost of
 * changing what the Developer stage IS.
 */
const WORK_UNIT_CONFIG = workUnitConfig();

const telemetry = createTelemetry({
  level: LOG_LEVEL,
  role: ROLE,
  sink: createTelemetryFileSink({ stateDir: STATE_DIR, role: ROLE, enabled: PERSIST_TELEMETRY }),
});

let workerState = 'STARTING';
let currentJob = null;
// The profile the job in flight is running on. Read from the job, never
// decided here: this worker executes a routing choice, it does not make one.
let currentProfile = null;
// Kept so the heartbeat keeps reporting a live, waiting worker rather than
// looking stalled while a model limit is being waited out.
let capacityWait = null;

const getStatus = () => ({
  state: workerState,
  // What is actually running, not a constant. An IDLE worker has no model.
  model: currentProfile?.model ?? null,
  developerProfile: currentProfile?.name ?? null,
  effort: currentProfile?.effort ?? null,
  supportedProfiles: [...SELECTABLE_DEVELOPER_PROFILES],
  sessionStrategy: SESSION_STRATEGY.STATELESS,
  // No session id is ever retained between jobs; only the in-flight one is
  // reported, and truncated.
  sessionId: currentJob?.sessionId ?? null,
  detail: currentJob ? `${currentJob.goal}/R${currentJob.round}` : null,
  capacityReason: capacityWait?.reason ?? null,
  nextRetryAt: capacityWait?.nextRetryAt ?? null,
});

function onCapacityEvent(event) {
  if (event.type === 'CAPACITY_WAIT' || event.type === 'CAPACITY_WAIT_RESUMED_FROM_DISK') {
    capacityWait = { reason: event.reason, nextRetryAt: event.nextRetryAt ?? capacityWait?.nextRetryAt ?? null };
    workerState = 'WAITING_FOR_CAPACITY';
    log('CAPACITY LIMIT', `${event.reason} · retry in ${event.remaining}`);
    log('STATE', 'WAITING_FOR_CAPACITY · Goal state preserved');
    if (event.resumeFrom) log('RESUME', event.resumeFrom);
  } else if (event.type === 'CAPACITY_AVAILABLE') {
    log('CAPACITY AVAILABLE', 'resuming');
    capacityWait = null;
    workerState = 'WORKING';
  } else if (event.type === 'ALREADY_COMPLETED') {
    log('ALREADY COMPLETED', 'result on disk; model not called again');
  } else if (event.type === 'HUMAN_REQUIRED') {
    log('HUMAN REQUIRED', event.reason);
    capacityWait = null;
  }
}

/**
 * Prompt for a correction round.
 *
 * The blockers are the authority, not the Goal as a whole. The engine stays
 * generic: everything Goal-specific arrives inside the structured context.
 */
function buildCorrectionPrompt(context, job) {
  return [
    'Você está atuando como Developer em um pipeline automatizado do Atendly.',
    `Esta é a correction round ${context.round} do Goal ${context.goal}.`,
    '',
    `A implementação da rodada ${context.previousRound} PERMANECE na worktree. Ela não foi revertida.`,
    '',
    'Contexto explícito desta rodada (não há conversa anterior):',
    JSON.stringify(context, null, 2),
    '',
    `Trabalhe exclusivamente dentro de: ${job.worktree}`,
    '',
    'Corrija SOMENTE os blockers listados em blockers. Cada um foi registrado pelo Tech Lead',
    'na revisão da rodada anterior e é a autoridade desta rodada.',
    '',
    'NÃO reverta nem reimplemente partes sem relação com os blockers.',
    'Preserve os critérios do Goal que já foram atendidos.',
    '',
    'Antes de corrigir, inspecione o código real na worktree — não confie apenas na descrição.',
    'Leia o Goal em ' + context.goalPath + ' para confirmar o critério de cada ponto tocado.',
    '',
    'Depois de corrigir, execute os testes dirigidos das correções e em seguida as validações',
    'do Goal necessárias para provar ausência de regressão.',
    '',
    'Você NÃO PODE: criar commit, push, merge ou PR; mudar de branch; alterar o checkout',
    'principal; escrever fora da worktree; editar documentos de controle da migração',
    '(goals/, reviews/, MIGRATION_STATUS.md); declarar o Goal ACCEPTED; criar o próximo Goal.',
    'O orchestrator verifica isso no Git depois; violação encerra a execução.',
    '',
    `Retorne exclusivamente o JSON do contrato DeveloperResult, com protocolVersion 2,`,
    `jobId exatamente "${job.jobId}", goal "${job.goal}", round ${job.round}, e com o implementationReport`,
    `desta rodada (R${context.round}): o que mudou por blocker, comandos executados com`,
    'resultado, e limitações. Não invente resultado de validação que você não executou.',
  ].join('\n');
}

function buildPrompt(context, job) {
  return [
    'Você está atuando como Developer em um pipeline automatizado do Atendly.',
    'Esta é uma execução REAL: você deve implementar o Goal de verdade nesta worktree.',
    '',
    'Contexto explícito desta tarefa (não há conversa anterior; nada foi dito antes):',
    JSON.stringify(context, null, 2),
    '',
    `Trabalhe exclusivamente dentro de: ${job.worktree}`,
    '',
    'Autorização e critério: o próprio Goal, em ' + context.goalPath + '.',
    'Leia-o por inteiro antes de começar. Ele define escopo, pontos de implementação,',
    'o que é obrigatório e o que está fora de escopo. Não amplie o Goal.',
    '',
    'Leia também CLAUDE.md e AGENTS.md e siga as regras do projeto, inclusive',
    'consulta seletiva (Graphify para call paths, Product Vault sob demanda).',
    'Não carregue documentação inteira.',
    '',
    'Você PODE: ler código, usar Graphify, editar a worktree, criar migrations,',
    'criar/alterar testes e executar comandos, incluindo as validações que o Goal exigir.',
    '',
    'Você NÃO PODE, em nenhuma hipótese:',
    '- criar commit, push, merge ou PR;',
    '- mudar de branch ou alterar o checkout principal do repositório;',
    '- escrever fora da worktree indicada;',
    '- editar documentos de controle da migração (goals/, reviews/, MIGRATION_STATUS.md);',
    '- declarar o Goal ACCEPTED ou alterar a baseline aceita;',
    '- criar o próximo Goal.',
    'O orchestrator verifica isso no Git depois; violação encerra a execução.',
    '',
    'Ao terminar, retorne exclusivamente o JSON do contrato DeveloperResult, com:',
    '- protocolVersion: 2 (obrigatório, exatamente esse valor);',
    `- jobId: exatamente "${job.jobId}"; goal: "${job.goal}"; round: ${job.round};`,
    '- status: "REVIEW_REQUIRED" se implementou, "BLOCKED" se não pôde prosseguir;',
    '- summary: uma frase;',
    '- implementationReport: relatório conforme o Goal pede (diff inicial/final, arquivos e',
    '  consumers, decisões de escopo, migrations/compatibilidade, RED/GREEN dos casos negativos,',
    '  comandos executados com resultado, e limitações);',
    '- validations: lista de {name, passed, detail} com as validações que você realmente rodou.',
    '',
    'Não invente resultado de validação que você não executou.',
  ].join('\n');
}

/**
 * A few lines of the Goal, for a unit's context packet.
 *
 * Deliberately the HEAD of the document rather than a model-written summary:
 * it costs nothing, it cannot hallucinate, and the Goal documents open with
 * what the Goal is. A unit that needs more is told where the file is.
 */
async function readGoalSummary(goalPath) {
  try {
    const raw = await readFile(goalPath, 'utf8');
    return raw.slice(0, GOAL_SUMMARY_CHARS);
  } catch {
    // Not fatal: a missing summary makes a packet thinner, never wrong. The
    // unit still receives goalPath and can read the document itself.
    return null;
  }
}

/**
 * The plan this round executes, and where it came from.
 *
 * A recorded plan that no longer VALIDATES is deliberately not treated as an
 * absent plan: a cycle or an unknown dependency is a defect in something the
 * Tech Lead wrote, and quietly replacing it with a single unit would hide a
 * bug while still charging for the round. It fails the job instead.
 */
async function resolveRoundPlan(job) {
  const goalSummary = await readGoalSummary(job.goalPath);

  // The judgement the round already carries, translated into the vocabulary a
  // plan speaks. Without this, a reviewer's explicit "the next correction round
  // needs Opus" would be silently dropped the moment the flag was turned on.
  const { type: unitType, reason: unitTypeReason } = unitTypeForProfile(job.developerProfile);

  if (job.type === 'CORRECTION') {
    // The Goal's OWN gates, so this round can prove the tree it just changed.
    //
    // A correction round used to declare none, which meant the Goal's gates
    // aged one round every time the Developer touched anything and could never
    // be re-run. Goal025 closed that into a loop: the gate went red in round 1,
    // the fix landed in round 2, and four rounds ended at
    // MAX_CORRECTION_ROUNDS_REACHED over a gate that was already green.
    //
    // A plan that no longer validates degrades to no gates rather than failing
    // the round: an implementation round already ran on this plan, so a
    // correction is not the place to discover it is broken — and no gates is
    // exactly the behaviour every correction round had until now.
    const goalPlan = await planStore.read(job.goal).catch(() => null);

    return {
      plan: fallbackExecutionPlan({
        goal: job.goal, round: job.round, blockers: [...job.blockers], goalSummary,
        unitType, unitTypeReason,
        // Collected from git by the orchestrator, never claimed by a model.
        changedFiles: [...(job.changedFiles ?? [])],
        goalGates: (goalPlan?.workUnits ?? []).filter((unit) => unit.type === 'DETERMINISTIC'),
      }),
      goalSummary,
      planned: false,
    };
  }

  const planned = await planStore.read(job.goal);
  if (planned) return { plan: planned, goalSummary, planned: true };

  if (!WORK_UNIT_CONFIG.allowCompatibilityFallback) {
    throw new SpikeError(
      'EXECUTION_PLAN_MISSING',
      `Goal ${job.goal} carries no execution plan and the compatibility fallback is disabled.`,
      { goal: job.goal },
    );
  }

  return {
    plan: fallbackExecutionPlan({
      goal: job.goal, round: job.round, goalSummary, unitType, unitTypeReason,
    }),
    goalSummary,
    planned: false,
  };
}

/**
 * Executes one round as a Work Unit DAG.
 *
 * The round's own job, lease and worktree are unchanged and untouched: this
 * runs INSIDE the attempt the worker loop already claimed, which is what keeps
 * one worktree per Goal, one lease per round, and one review at the end.
 */
async function handleWorkUnitJob(job, { profile, isCorrection }) {
  // Round-level idempotency, checked here because the capacity runner — which
  // normally does it — is now called once per unit rather than once per round.
  if (await store.hasCompletedResult(ROLE, job.jobId)) {
    log('ALREADY COMPLETED', 'round result on disk; the DAG is not executed again');
    await store.appendEvent({ type: 'JOB_RESULT_REUSED', role: ROLE, jobId: job.jobId, goal: job.goal, round: job.round });
    currentJob = null; currentProfile = null; capacityWait = null; workerState = 'IDLE';
    return;
  }

  const { plan, goalSummary, planned } = await resolveRoundPlan(job);

  if (!planned) {
    // Never silent. "This Goal ran as one unit" is a fact a later comparison of
    // monolithic against decomposed execution has to be able to see.
    await store.appendEvent({
      type: 'WORK_UNIT_PLAN_FALLBACK',
      goal: job.goal, round: job.round, jobId: job.jobId,
      source: plan.source,
      reason: isCorrection ? 'CORRECTION_ROUND' : 'NO_EXECUTION_PLAN_RECORDED',
    });
    log('PLAN', `${plan.source} — ${plan.workUnits.length} unit(s)`);
  } else {
    log('PLAN', `Tech Lead execution plan — ${plan.workUnits.length} unit(s)`);
  }

  await store.writeRuntime({
    ...(await store.readRuntime()),
    state: isCorrection ? 'CORRECTION_RUNNING' : 'DEVELOPER_RUNNING',
    round: job.round,
    currentJobId: job.jobId,
  });

  const executable = resolveClaudeExecutable();

  const outcome = await executeWorkUnitPlan({
    store,
    plan,
    job,
    goal: job.goal,
    round: job.round,
    worktree: job.worktree,
    executionBase: job.worktreeInitialHead ?? job.executionBase,
    goalPath: job.goalPath,
    goalSummary,
    config: WORK_UNIT_CONFIG,
    resumeFrom: isCorrection ? LOOP_STATES.CORRECTION_RUNNING : LOOP_STATES.DEVELOPER_RUNNING,
    emit: (line) => log('DAG', line),

    /**
     * One unit, one inference.
     *
     * Identical in every safety-relevant respect to the round-level call this
     * replaces: a brand-new session per attempt (the Developer is stateless
     * and stays stateless), the model and effort read from the routing the
     * ROUTER produced rather than from anything this file knows, the family
     * checked against what actually served the call, and no `--fallback-model`.
     * What changed is the size of the prompt, not the guarantees around it.
     */
    invokeUnit: async ({ unit, prompt, routing, jsonSchema, validatePayload, timeoutMs, attempt, onToolEvent }) => {
      const attemptSessionId = randomUUID();
      currentJob.sessionId = attemptSessionId;
      currentProfile = { name: `WU_${routing.modelKey.toUpperCase()}`, model: routing.model, effort: routing.effort };

      telemetry.event('MODEL', `${unit.id} · ${routing.label} · ${routing.reason}`);
      if (attempt > 1) log('MODEL', `${unit.id} attempt ${attempt} runs on ${routing.label} (${routing.reason})`);

      return invokeAgent({
        executable: executable.path,
        model: routing.model,
        effort: routing.effort,
        expectedFamily: routing.family,
        expectedRole: ROLE,
        // One stream, two observers. The findings ledger must see tool events
        // even when stream telemetry is switched off, because it feeds the
        // next unit's packet rather than a log a human reads.
        onTelemetryEvent: (event) => {
          if (STREAM_EVENTS) telemetry.emit(event);
          onToolEvent?.(event);
        },
        telemetryRoot: job.worktree,
        prompt,
        jsonSchema,
        validatePayload,
        cwd: job.worktree,
        sessionId: attemptSessionId,
        persistSession: false,
        resume: false,
        tools: DEVELOPER_TOOLS,
        permissionMode: 'auto',
        addDirs: [job.worktree],
        safeMode: false,
        timeoutMs,
      });
    },
  });

  // Validated with the SAME contract a model-produced round result is validated
  // with. The aggregate is synthesised by the harness, which is exactly why it
  // must not be exempt: a synthesised result that could not have been produced
  // by the contract is a result the reviewer cannot trust either.
  const aggregate = validateDeveloperResult(outcome.aggregate, {
    jobId: job.jobId, goal: job.goal, round: job.round,
  });

  const attemptId = job.attemptId
    ?? (await store.readAttemptState(ROLE, job.jobId))?.attemptId
    ?? null;

  workerState = 'PUBLISHING';
  await store.publishResult(ROLE, job.jobId, { ok: true, result: aggregate }, { attemptId });
  await store.setJobStatus(ROLE, job.jobId, 'COMPLETED');

  await store.appendEvent({
    type: 'DEVELOPER_RESULT_PUBLISHED',
    jobId: job.jobId,
    goal: job.goal,
    round: job.round,
    status: aggregate.status,
    // The round no longer ran on ONE profile, so naming one here would be a
    // claim this worker is not entitled to make. The routing per unit is in
    // the aggregate and in the events.
    developerProfile: null,
    executionMode: 'WORK_UNITS',
    workUnits: outcome.telemetry.workUnitsTotal,
    modelCalls: outcome.telemetry.modelCalls,
    escalations: outcome.telemetry.escalations,
    contextExpansions: outcome.telemetry.contextExpansions,
    reused: false,
  });

  log(`RESULT ${aggregate.status}`, `${outcome.telemetry.workUnitsTotal} work unit(s)`);
  log('ROUTING', `native ${outcome.telemetry.modelCalls.native} · haiku ${outcome.telemetry.modelCalls.haiku}`
    + ` · sonnet ${outcome.telemetry.modelCalls.sonnet} · opus ${outcome.telemetry.modelCalls.opus}`);

  telemetry.clearContext();
  currentJob = null;
  currentProfile = null;
  capacityWait = null;
  workerState = 'IDLE';
}

async function handleJob(rawJob) {
  const job = validateDeveloperJob(rawJob);
  // Fails closed on an unknown name: a typo must stop the run, never quietly
  // land on some other model.
  const profile = resolveDeveloperProfile(job.developerProfile);
  currentJob = { goal: job.goal, round: job.round, sessionId: null };
  currentProfile = profile;
  workerState = 'WORKING';

  telemetry.setContext({ goal: job.goal, round: job.round, jobId: job.jobId });
  telemetry.event('JOB', `${job.goal}/R${job.round} ${job.type}`);
  telemetry.event('PROFILE', profile.name);
  telemetry.event('MODEL', `${profile.label} · effort ${profile.effortLabel}`);

  log(`JOB ${job.goal}/R${job.round} RECEIVED`, `type ${job.type}`);
  log('PROFILE', profile.name);
  log('MODEL', profile.label);
  log('EFFORT', profile.effortLabel);
  if (job.type === 'CORRECTION') log('CORRECTION SCOPE', `${job.blockers.length} blocker(s)`);
  await store.appendEvent({
    type: 'DEVELOPER_JOB_RECEIVED', jobId: job.jobId, goal: job.goal, round: job.round,
    developerProfile: profile.name, model: profile.model, effort: profile.effort,
  });

  const isCorrection = job.type === 'CORRECTION';

  // The one fork in this worker. With the flag off, everything below runs
  // exactly as it did before Work Units existed — same prompt, same schema,
  // same single call, same published result. With it on, the round is executed
  // as a DAG and the SAME DeveloperResult shape is published at the end, so
  // nothing downstream can tell which path produced it. That equivalence is
  // what makes rolling back a variable rather than a revert.
  if (WORK_UNIT_CONFIG.enabled) {
    await handleWorkUnitJob(job, { profile, isCorrection });
    return;
  }

  const context = isCorrection
    ? buildCorrectionContext({
      goal: job.goal,
      goalPath: job.goalPath,
      round: job.round,
      previousRound: job.round - 1,
      migrationAcceptedBaseline: job.migrationAcceptedBaseline,
      // Original baselines, unchanged across rounds.
      executionBase: job.executionBase,
      worktreeInitialHead: job.worktreeInitialHead,
      worktree: job.worktree,
      blockers: [...job.blockers],
      previousImplementationReport: job.previousImplementationReport ?? null,
      previousDecision: job.previousDecision ?? 'CHANGES_REQUIRED',
      changedFiles: job.changedFiles ?? [],
    })
    : buildDeveloperContext({
      goal: job.goal,
      goalPath: job.goalPath,
      round: job.round,
      type: job.type,
      migrationAcceptedBaseline: job.migrationAcceptedBaseline,
      executionBase: job.executionBase,
      worktree: job.worktree,
      blockers: [...job.blockers],
      previousImplementationReport: job.previousImplementationReport ?? null,
    });

  // Persist the running state BEFORE calling the model, so a crash mid-call
  // leaves the runtime saying what was actually happening.
  await store.writeRuntime({
    ...(await store.readRuntime()),
    state: isCorrection ? 'CORRECTION_RUNNING' : 'DEVELOPER_RUNNING',
    round: job.round,
    currentJobId: job.jobId,
  });

  // A fresh session id per job. This is the stateless invariant.
  const sessionId = randomUUID();
  currentJob.sessionId = sessionId;

  const executable = resolveClaudeExecutable();

  // What this job was routed to. The job is the authority; a job written before
  // adaptive routing carries only a profile, and that still describes a model.
  const baseRouting = job.routing ?? routingFromProfile(profile, {
    stage: isCorrection ? ROUTING_STAGES.CORRECTION : ROUTING_STAGES.IMPLEMENTATION,
  });
  const router = createAttemptRouter({
    store, role: ROLE, jobId: job.jobId, base: baseRouting, kind: 'developer',
    goal: job.goal, round: job.round,
  });

  log(`${profile.name} STARTED`, `session ${sessionId.slice(0, 8)} · worktree ${job.worktree}`);
  log('IMPLEMENTING', `${job.goal} round ${job.round} — pode levar horas`);

  // Each retry gets a brand-new session id: the Developer is stateless, so a
  // capacity retry re-sends the same explicit context, never a resumed chat.
  const run = await runWithCapacity({
    store,
    role: ROLE,
    jobId: job.jobId,
    goal: job.goal,
    round: job.round,
    resumeFrom: isCorrection ? LOOP_STATES.CORRECTION_RUNNING : LOOP_STATES.DEVELOPER_RUNNING,
    onEvent: onCapacityEvent,
    // Capacity fallback and authorised escalation both land here, and both
    // arrive as a NEW attempt rather than as a quiet change of model.
    router,
    invoke: async ({ attempt }) => {
      const attemptSessionId = randomUUID();
      currentJob.sessionId = attemptSessionId;

      // Re-read per attempt: a successor created by a fallback or an
      // escalation runs on the model the router chose, and a restart resolves
      // the same answer from the same history.
      const { routing } = await router.current();
      const active = routing ?? baseRouting;
      currentProfile = profileForModel({ model: active.model, effort: active.effort });
      if (attempt > 1) {
        log('MODEL', `attempt ${attempt} runs on ${currentProfile.name} (${active.reason})`);
        telemetry.event('MODEL', `attempt ${attempt} · ${currentProfile.name} · ${active.reason}`);
      }

      return invokeAgent({
        executable: executable.path,
        // From the routing on the attempt, not from a constant in this file.
        model: active.model,
        effort: active.effort,
        expectedFamily: active.family,
        expectedRole: ROLE,
        // Purely observational: derived from events the CLI already emits.
        onTelemetryEvent: STREAM_EVENTS ? (event) => telemetry.emit(event) : null,
        telemetryRoot: job.worktree,
        prompt: isCorrection ? buildCorrectionPrompt(context, job) : buildPrompt(context, job),
        jsonSchema: developerResultSchemaFor({ jobId: job.jobId, goal: job.goal, round: job.round }),
        validatePayload: (payload) => validateDeveloperResult(payload, {
          jobId: job.jobId,
          goal: job.goal,
          round: job.round,
        }),
        cwd: job.worktree,
        sessionId: attemptSessionId,
        // Explicitly NOT persisted and NOT resumed. `--fallback-model` is still
        // never passed: a model change here is a routed successor attempt, on
        // record, not the CLI silently answering with something else.
        persistSession: false,
        resume: false,
        // Real execution profile, scoped to the worktree.
        tools: DEVELOPER_TOOLS,
        permissionMode: 'auto',
        addDirs: [job.worktree],
        safeMode: false,
        timeoutMs: TIMEOUT_MS,
      }).then((agentOutcome) => {
        // Second, profile-aware proof that no substitution happened. invokeAgent
        // already refuses a wrong family; this makes the failure name the
        // profile that was promised, and keeps the guarantee true even if the
        // family check above is ever loosened.
        if (agentOutcome.resolvedPrimaryModel) {
          assertProfileWasHonoured({
            profile: currentProfile.name,
            resolvedPrimaryModel: agentOutcome.resolvedPrimaryModel,
          });
        }
        return agentOutcome;
      });
    },
  });

  log(`${profile.name} COMPLETED`, run.outcome);
  telemetry.event('JOB', `${job.goal}/R${job.round} ${run.outcome}`);

  if (run.outcome === RUN_OUTCOMES.HUMAN_REQUIRED) {
    await store.appendEvent({
      type: 'DEVELOPER_JOB_FAILED', jobId: job.jobId, code: run.reason,
      developerProfile: profile.name, model: profile.model, effort: profile.effort,
    });
    currentJob = null;
    currentProfile = null;
    capacityWait = null;
    workerState = 'IDLE';
    return;
  }

  workerState = 'PUBLISHING';
  await store.appendEvent({
    type: 'DEVELOPER_RESULT_PUBLISHED',
    jobId: job.jobId,
    goal: job.goal,
    round: job.round,
    status: run.result?.status ?? 'UNKNOWN',
    // The profile that actually served this result, recorded next to it.
    developerProfile: profile.name,
    model: profile.model,
    effort: profile.effort,
    reused: run.outcome === RUN_OUTCOMES.ALREADY_COMPLETED,
  });

  log(`RESULT ${run.result?.status ?? 'UNKNOWN'}`);
  telemetry.clearContext();
  currentJob = null;
  currentProfile = null;
  capacityWait = null;
  workerState = 'IDLE';
}

async function main() {
  // Deliberately NOT "Model: Claude Opus 5". An idle Developer has no model:
  // it has a set of profiles it can execute, and the Tech Lead picks one per
  // Goal. Printing a fixed model here is what made the routing invisible.
  // Built now, printed only once the role lease is actually held: a process
  // that is about to refuse to start must not first announce that it is
  // waiting for work.
  const readyBanner = banner({
    title: 'DEVELOPER',
    supportedProfiles: SELECTABLE_DEVELOPER_PROFILES.map(describeProfile),
    sessionLine: 'Session strategy: STATELESS',
    extra: [
      `Execution: ${WORK_UNIT_CONFIG.enabled ? 'WORK_UNITS' : 'MONOLITHIC_COMPAT'}`,
      `Log level: ${LOG_LEVEL}`,
    ],
  });

  workerState = 'IDLE';
  await runWorkerLoop({
    store,
    role: ROLE,
    getStatus,
    handleJob,
    onStarted: () => {
      console.log(readyBanner);
      console.log('Waiting for implementation task...\n');
    },
  });
}

// Only when this file IS the program. Importing it — from a test, a doc
// generator, or an agent reading the tooling — must never start anything.
if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    // The exit CODE is the message a supervisor reads: an identity conflict and
    // a changed codebase are deliberate stops, not crashes, and restarting into
    // either one just repeats it.
    const code = exitCodeForError(error);
    console.error(`Developer worker stopped [${nameForExitCode(code)}]: ${error?.message ?? error}`);
    process.exitCode = code;
  });
}
