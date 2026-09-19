#!/usr/bin/env node
/**
 * IA Loop — Tech Lead worker.
 *
 * ONE worker, two models. Which one runs is NOT a property of this process: it
 * arrives on the job, decided by the router (`lib/model-routing.mjs`). Opus is
 * the Tech Lead for every planning and review, whatever the risk score says;
 * Fable is a specialist the router never selects on its own, reached only by an
 * authorized escalation from a review Opus could not conclude.
 *
 * The session strategy follows the model, because the models differ:
 *
 * - Fable sustains multi-turn conversation reliably (Spike 1), so its session
 *   is persistent, kept in the durable registry and resumed across reviews.
 * - Opus does NOT sustain it in this environment (Spike 1: `reasoning_extraction`
 *   from the second or third turn), so an Opus job is one stateless call. That
 *   costs nothing here: the review packet is already the authority, and the
 *   prompt says so — the repository is, never the reviewer's memory.
 *
 * Restart policy for the persistent side, which differs by state on purpose:
 *
 * - IDLE: if a stored session cannot be resumed, starting a fresh one is fine
 *   and is recorded as an event.
 * - Mid-review: a failed resume must NOT silently become a new session. Losing
 *   the reviewer's continuity in the middle of a review changes what is being
 *   reviewed, so the job goes to HUMAN_REQUIRED instead.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { SpikeError, invokeAgent, resolveClaudeExecutable } from '../lib/claude-process.mjs';
import {
  MODELS,
  ROUTING_CONFIG,
  ROUTING_STAGES,
  resolveModel,
  resolveRoutingMode,
  routeClosureDocumentation,
  toJobRouting,
} from '../lib/model-routing.mjs';
import { DETERMINISTIC_ACTION_NAMES } from '../lib/deterministic-actions.mjs';
import { createAttemptRouter } from '../lib/routing-runtime.mjs';
import { createJobStore } from '../lib/job-store.mjs';
import { createPersistentSession } from '../lib/persistent-session.mjs';
import {
  assertSessionsAreIndependent,
  getSession,
  loadRegistry,
  saveRegistry,
  upsertSession,
} from '../lib/session-registry.mjs';
import { SESSION_STRATEGY } from '../lib/worker-registry.mjs';
import { banner, log, runWorkerLoop } from '../lib/worker-loop.mjs';
import { createTelemetry, createTelemetryFileSink, resolveLogLevel } from '../lib/telemetry.mjs';
import { runWithCapacity, RUN_OUTCOMES } from '../lib/capacity-runner.mjs';
import { LOOP_STATES } from '../lib/loop-state.mjs';
import { reviewDecisionSchemaFor, validateReviewJob, validateReviewDecision } from '../lib/contracts-v2.mjs';
import { buildTechLeadContext } from '../lib/context-builders.mjs';
import { resolveGraphOrientation } from '../lib/graph-orientation.mjs';
import { renderReviewPrompt } from '../lib/review-packet.mjs';
import {
  CLOSURE_WRITE_PREFIX,
  TECH_LEAD_NON_REVIEW_JOB_TYPES,
  closureDocSchemaFor,
  validateClosureDocResult,
} from '../lib/closure-contracts.mjs';
import { planningDecisionSchemaFor, validatePlanningDecision } from '../lib/planning-decision.mjs';
import {
  buildCriteriaCoveragePrompt,
  criteriaCoverageSchemaFor,
  validateCriteriaCoverage,
} from '../lib/criteria-coverage.mjs';
import { readJson } from '../lib/job-store.mjs';
import { isDirectExecution } from '../lib/direct-execution.mjs';
import { exitCodeForError, nameForExitCode } from '../lib/worker-exit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, '..', '.state');
const REGISTRY_PATH = join(STATE_DIR, 'sessions.json');
const SESSION_CWD = join(STATE_DIR, 'workdirs', 'tech-lead');

const ROLE = 'tech_lead';
/**
 * The specialist's model, and the only one this worker keeps a session for.
 * The standard model arrives on the job like any other routing decision.
 */
const SPECIALIST_MODEL = process.env.IA_LOOP_TECH_LEAD_MODEL ?? MODELS.fable.model;
const TIMEOUT_MS = Number(process.env.IA_LOOP_TECH_LEAD_TIMEOUT_MS ?? 2 * 60 * 60 * 1000);

const LOG_LEVEL = resolveLogLevel();
const PERSIST_TELEMETRY = process.env.IA_LOOP_TELEMETRY_PERSIST !== '0';
const STREAM_EVENTS = process.env.IA_LOOP_STREAM_EVENTS !== '0';

/**
 * Review profile: read-only by tool surface.
 *
 * Bash is included because a DEEP review needs directed verification (git diff,
 * targeted test runs, graphify). There is no Write or Edit tool, and the
 * orchestrator fingerprints the worktree before and after: any mutation
 * invalidates the review rather than being tolerated.
 */
const REVIEWER_TOOLS = ['Read', 'Glob', 'Grep', 'Bash'];

/**
 * Closure and planning need to WRITE, unlike a review.
 *
 * The write surface is narrowed by policy rather than by tools alone: the
 * orchestrator collects the changed files from git afterwards and fails the job
 * if anything outside docs/migration was touched.
 */
const CLOSURE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'];

/** Job kinds this worker handles besides a review. */
const CLOSURE_KINDS = TECH_LEAD_NON_REVIEW_JOB_TYPES;

/**
 * Which of those kinds OWN a stage of the loop.
 *
 * The two closure kinds are stages: they move the state machine and say so.
 * CRITERIA_COVERAGE is not — it runs inside a round that is still being
 * implemented and reviewed, and writing a closure state there would tell
 * `resolveClosureResumePoint` that a Goal nobody has reviewed is being closed.
 *
 * One place decides this, read before the kind table exists and again by it.
 */
const KIND_OWNS_LOOP_STAGE = Object.freeze({
  CLOSURE_DOCUMENTATION: true,
  NEXT_GOAL_PLANNING: true,
  CRITERIA_COVERAGE: false,
});

/**
 * The routing a job carries, or the stage's default when it does not carry
 * one.
 *
 * The job's own `routing` field is always authoritative when present — that is
 * how an explicit escalation or an operator override survives a restart. When
 * it is absent, the default is NOT the same answer for every stage:
 *
 *   REVIEW / PLANNING   an absent `routing` here really does mean "written
 *                       before adaptive routing existed" — every real Tech
 *                       Lead job of these kinds has carried one since V14, so
 *                       one that does not is a genuine legacy job, and Fable
 *                       is what it actually ran on. Re-deciding it on read
 *                       would change what a restart is resuming.
 *
 *   CLOSURE             a closure documentation job never carries `routing`,
 *                       by construction — it is bookkeeping over a decision
 *                       already taken, never risk-classified, so there was
 *                       never a decision to attach. Reading that absence as
 *                       "legacy" ran every closure through the specialist for
 *                       no reason. `routeClosureDocumentation` is the single
 *                       place that answer lives; this function only asks it.
 *
 * Exported for the regression test; nothing else calls it.
 */
export function routingOf(job, stage) {
  if (job?.routing?.model) return job.routing;

  if (stage === ROUTING_STAGES.CLOSURE) {
    return toJobRouting(routeClosureDocumentation({ mode: resolveRoutingMode() }));
  }

  const specialist = resolveModel('fable');
  return {
    role: ROLE,
    stage,
    modelKey: specialist.key,
    model: SPECIALIST_MODEL,
    family: specialist.family,
    effort: ROUTING_CONFIG.tech_lead[stage]?.specialist.effort ?? null,
    complexity: null,
    riskScore: null,
    signals: [],
    reason: 'LEGACY_UNROUTED_JOB',
    fallbackAllowed: false,
    mode: resolveRoutingMode(),
  };
}

/**
 * Runs one Tech Lead call on the model the router chose.
 *
 * Fable keeps its persistent conversation; Opus gets a fresh, stateless call,
 * because it cannot hold one. Everything else — prompt, schema, tools,
 * permission mode, telemetry — is identical, so the two paths differ in
 * transport only, never in what is asked.
 */
async function sendRouted({ routing, prompt, jsonSchema, validatePayload, tools, worktree }) {
  const shared = {
    prompt,
    jsonSchema,
    validatePayload,
    tools,
    permissionMode: 'auto',
    addDirs: worktree ? [worktree] : [],
    safeMode: false,
    ...telemetryOptions(worktree),
  };

  if (routing.family === MODELS.fable.family) {
    const outcome = await session.send(shared);
    await persistSession();
    return outcome;
  }

  const executable = resolveClaudeExecutable();
  return invokeAgent({
    ...shared,
    executable: executable.path,
    model: routing.model,
    effort: routing.effort,
    expectedFamily: routing.family,
    expectedRole: ROLE,
    cwd: SESSION_CWD,
    // Stateless by necessity, not by preference: see the header.
    sessionId: randomUUID(),
    persistSession: false,
    resume: false,
    timeoutMs: TIMEOUT_MS,
  });
}

/**
 * Guarantees the specialist's session exists before a Fable job uses it.
 *
 * Only the specialist has one. Creating it costs nothing — a session id is a
 * uuid until a call actually resumes it — but a job routed to Opus must never
 * depend on it existing.
 */
async function ensureSessionFor(routing) {
  if (routing.family !== MODELS.fable.family) return;
  if (session) return;
  await restoreSession(resolveClaudeExecutable().path);
  await persistSession();
}

/**
 * Shows which model is about to run and why.
 *
 * The AUDIT record is written once by the capacity runner, for every routed
 * call of either role. This is the human-facing half only.
 */
function announceRouting({ routing }) {
  currentRouting = routing;
  const label = resolveModel(routing.modelKey).label;
  log('MODEL', `${label}${routing.effort ? ` · effort ${routing.effort}` : ''} — ${routing.reason}`);
  if (routing.complexity) {
    log('COMPLEXITY', `${routing.complexity} (score ${routing.riskScore ?? '?'})`);
  }
  telemetry.event('MODEL', `${label} · ${routing.complexity ?? 'n/a'} · ${routing.reason}`);
}

function buildClosureDocPrompt(job) {
  return [
    'Você está atuando como Tech Lead no FECHAMENTO de um Goal já aceito.',
    '',
    'Isto NÃO é um review. A decisão ACCEPTED já foi tomada por você na rodada anterior',
    'e não deve ser reaberta, reavaliada nem revertida.',
    '',
    'Contexto do fechamento:',
    JSON.stringify(job.closureContext, null, 2),
    '',
    `Trabalhe dentro de: ${job.worktree}`,
    '',
    'Tarefa: registrar de forma factual e seletiva o que este Goal mudou.',
    '',
    `Você pode escrever SOMENTE em ${CLOSURE_WRITE_PREFIX}. Qualquer alteração fora disso`,
    'encerra o fechamento e exige intervenção humana.',
    '',
    'Atualize apenas os documentos realmente afetados. Candidatos, quando pertinente:',
    '  docs/migration/reviews/003-review.md (o review desta execução)',
    '  CURRENT_STATE.md, GAP_ANALYSIS.md, REUSE_ANALYSIS.md, DATA_MIGRATION.md,',
    '  DECISIONS.md, TARGET_ARCHITECTURE.md, MASTER_PLAN.md',
    '',
    'NÃO faça agora, em hipótese alguma:',
    '- criar o próximo Goal;',
    '- marcar qualquer Goal como READY;',
    '- registrar o novo SHA de baseline (ele ainda não existe);',
    '- atualizar MIGRATION_STATUS para o fechamento (é etapa posterior);',
    '- tocar em código, testes, tooling ou configuração.',
    '',
    'Não atualize um documento só para mexer em data ou formatação: registre substância.',
    '',
    'Retorne exclusivamente o JSON do contrato ClosureDocResult, listando em',
    'documentsUpdated os caminhos que você realmente alterou.',
  ].join('\n');
}

/** Exported for the regression test below; nothing else calls it. */
export function buildPlanningPrompt(job) {
  return [
    'Você está atuando como Tech Lead no PLANEJAMENTO do próximo Goal.',
    '',
    'O Goal anterior já foi aceito, fechado e integrado. A nova baseline aceita já existe',
    'e está no contexto abaixo. Use exatamente esse SHA.',
    '',
    'Contexto do planejamento:',
    JSON.stringify(job.planningContext, null, 2),
    '',
    ...(job.planningContext?.priorAttemptFeedback ? [
      '⚠ RETRY DIRIGIDO: sua tentativa anterior de planejamento foi REJEITADA pelo contrato',
      `(job ${job.planningContext.priorAttemptFeedback.previousJobId}, código `
      + `${job.planningContext.priorAttemptFeedback.code}). O motivo exato foi:`,
      '',
      `  ${job.planningContext.priorAttemptFeedback.diagnostic}`,
      '',
      'Essa violação é a autoridade desta tentativa. Corrija especificamente o que ela aponta —',
      'por exemplo, se uma Work Unit nomeou um scope inválido (mais de um caminho, ou um caminho',
      'que não é apps/<nome>, packages/<nome>, tools/<nome> ou scripts/<nome>), reavalie essa Work',
      'Unit e, se o trabalho dela realmente atravessar múltiplos workspaces, divida-a em várias',
      'Work Units, cada uma com EXATAMENTE um scope válido. Não invente um scope só para passar',
      'no schema, e não mude requisito funcional do Goal para evitar o problema.',
      '',
      'O restante do plano pode estar correto — reavalie o plano inteiro, mas não introduza',
      'mudanças não relacionadas a este motivo.',
      '',
    ] : []),
    `Trabalhe dentro de: ${job.worktree}`,
    `Você pode escrever SOMENTE em ${CLOSURE_WRITE_PREFIX}.`,
    '',
    'Reavalie o roadmap de forma INCREMENTAL, à luz do que o Goal fechado revelou.',
    'Não repita o Goal0, não releia o Product Vault inteiro, não refaça discovery',
    'de arquitetura sem evidência concreta.',
    '',
    'Faça, nesta ordem:',
    '1. atualizar MIGRATION_STATUS: o Goal fechado como ACCEPTED, com o commit/baseline correto;',
    '2. registrar o que o fechamento exigir de administrativo;',
    '3. atualizar MASTER_PLAN somente se a evidência exigir;',
    '4. registrar nova decisão apenas se houver evidência concreta nova;',
    '5. escrever SOMENTE o próximo Goal executável;',
    '6. marcar READY apenas esse próximo Goal;',
    '7. declarar nele a baseline aceita, com o SHA exato do contexto.',
    '',
    'O roadmap vigente aponta para o próximo Goal esperado, mas você NÃO é obrigado a',
    'mantê-lo: se a evidência do Goal fechado justificar inserir, reordenar ou superseder,',
    'faça — e registre o motivo. Preserve IDs e histórico.',
    '',
    'Não detalhe Goals posteriores. Apenas um próximo Goal, e só ele READY.',
    '',
    // Developer routing. It rides on THIS call — a call the cycle already
    // makes — precisely so that choosing a model costs no extra inference.
    'Escolha também o perfil de execução do Developer para o Goal que você está escrevendo.',
    'O padrão é SONNET_MEDIUM: não use Opus quando Sonnet for suficiente.',
    '- SONNET_MEDIUM: implementação localizada, CRUD, UI, adapters, testes, refactor simples,',
    '  arquitetura já definida, risco baixo/médio, poucas fronteiras entre serviços;',
    '- OPUS_MEDIUM: mudança multi-serviço, contrato importante, domínio complexo, migration,',
    '  debugging difícil, concorrência, mudança com vários consumers;',
    '- OPUS_HIGH: segurança, auth/sessão, isolamento de tenant, dado crítico, race condition,',
    '  consistência/sistemas distribuídos, migration delicada, mudança arquitetural, alta',
    '  superfície, alto custo de erro.',
    'São critérios, não regra rígida: a decisão é sua.',
    'Informe developerProfile e um developerProfileReason de UMA frase curta.',
    'Registre a mesma escolha no documento do Goal, em uma linha exatamente assim:',
    '  Developer execution profile: <PERFIL>',
    '',
    // The Work Unit DAG. It rides on THIS call for the same reason the profile
    // does: decomposing the Goal must not cost a separate inference.
    'Produza também o executionPlan do Goal que você está escrevendo: as Work Units em que ele',
    'será executado, com as dependências entre elas.',
    '',
    'Uma Work Unit é autocontida o bastante para ser executada, pequena o bastante para receber',
    'contexto restrito, e grande o bastante para entregar algo coerente. NÃO crie microtarefas',
    '("adicionar import", "criar variável", "adicionar return"): elas serão fundidas antes de rodar.',
    'Para um Goal pequeno espere 1–3 unidades; médio 3–8; grande 5–15.',
    '',
    'Classifique cada unidade em type:',
    '- DETERMINISTIC: um COMANDO, sem modelo nenhum. Informe action, scope quando a action',
    '  exigir (ex.: apps/bff) e pattern quando for targeted-tests.',
    // Derived, never retyped. This list was hardcoded and drifted the moment an
    // action was added: the registry knew about `validate-ui` and the prompt did
    // not, so the planner could not name a gate that existed.
    `  As actions que existem são exatamente estas: ${DETERMINISTIC_ACTION_NAMES.join(', ')}.`,
    '  Não invente linha de comando: o registro é fechado e nada fora dessa lista roda.',
    '- MECHANICAL: comportamento já definido e padrão já existente no código — boilerplate,',
    '  DTO totalmente especificado, export, rota trivial seguindo padrão, mock simples, rename.',
    '- STANDARD: implementação normal — regra de negócio, service, repository, integração,',
    '  tratamento de erro, teste comportamental, refactor de tamanho moderado.',
    '- COMPLEX: só onde errar é caro — concorrência, máquina de estados, recovery, coordenação',
    '  distribuída, consistência de dados, complexidade algorítmica, mudança arquitetural transversal.',
    '',
    'Informe também complexity (LOW/MEDIUM/HIGH), risk (LOW/MEDIUM/HIGH), dependencies (ids),',
    'expectedFiles, relevantFiles, acceptanceCriteria (obrigatório para tudo que não é',
    'DETERMINISTIC) e, quando útil, implementationHints.',
    '',
    'Você NÃO escolhe modelo. Não escreva model, modelKey, profile, effort nem executor dentro de',
    'uma Work Unit: o router decide a partir de type/complexity/risk, e um plano que nomeia modelo',
    'é recusado. O que você declara é a NATUREZA do trabalho.',
    '',
    'Ordene com dependências reais (é um DAG, sem ciclos: um ciclo invalida o plano inteiro).',
    'Coloque a verificação determinística no fim: primeiro as dirigidas (typecheck/lint/targeted-tests',
    'do que foi tocado), depois as globais (validate-core, build) se o Goal exigir.',
    '',
    'Se o Goal tocar apps/frontend, inclua uma unidade DETERMINISTIC com action validate-ui,',
    'depois de validate-core. É o gate renderizado: Playwright nas larguras 360, 390, 768, 1024',
    'e 1440, medindo overflow horizontal, touch target (mínimo AA de 24px), contraste real',
    'computado, foco visível e prefers-reduced-motion — tudo que jsdom não alcança porque não',
    'tem layout nem cascata. Depende de validate-core porque é ele que produz o build servido.',
    'Critério de aceite que fale de largura, contraste, foco ou estado de tela deve apontar para',
    'esse gate; o que ele NÃO decide é fidelidade visual à referência aprovada, que continua',
    'sendo conferência humana e não pode ser declarada como provada por teste.',
    '',
    'Retorne exclusivamente o JSON do contrato PlanningDecision, com um destes:',
    '',
    '- decision "NEXT_GOAL": há um próximo Goal executável. Informe nextGoalId,',
    '  nextGoalTitle e nextGoalPath. Escreva SOMENTE esse Goal e marque só ele READY.',
    '',
    '- decision "MIGRATION_COMPLETE": a migração terminou. Isto é uma AFIRMAÇÃO que você',
    '  precisa justificar em reason, com remainingCriticalGaps vazio. Não declare',
    '  completa apenas porque não encontrou um próximo Goal óbvio: se restar qualquer',
    '  Goal READY, IN_PROGRESS ou gap crítico conhecido, ela não está completa.',
    '',
    '- decision "HUMAN_REQUIRED": há decisão de produto ou arquitetura que cabe a uma',
    '  pessoa. Explique em reason.',
  ].join('\n');
}

async function handleClosureJob(job) {
  const kind = job.type;
  currentJob = { goal: job.goal, round: job.round ?? 0 };
  workerState = 'WORKING';

  log(`${kind} ${job.goal} RECEIVED`);
  telemetry.setContext({ goal: job.goal, round: job.round ?? 0, jobId: job.jobId });
  telemetry.event('JOB', `${job.goal} ${kind}`);
  await store.appendEvent({ type: `${kind}_RECEIVED`, jobId: job.jobId, goal: job.goal });

  // A kind that does not own a stage of the loop must not move the loop. The
  // two closure kinds ARE stages and say so; CRITERIA_COVERAGE runs inside a
  // round that is still being implemented and reviewed.
  if (KIND_OWNS_LOOP_STAGE[kind] !== false) {
    await store.writeRuntime({
      ...(await store.readRuntime()),
      state: kind === 'CLOSURE_DOCUMENTATION' ? 'CLOSURE_DOCUMENTING' : 'NEXT_GOAL_PLANNING',
      currentJobId: job.jobId,
    });
  }

  const isPlanning = kind === 'NEXT_GOAL_PLANNING';
  // A table rather than nested ternaries: a third kind is data here, not
  // another branch every future reader has to unpick.
  const KINDS = {
    NEXT_GOAL_PLANNING: {
      prompt: () => buildPlanningPrompt(job),
      schema: () => planningDecisionSchemaFor({ jobId: job.jobId, goal: job.goal }),
      validate: (p) => validatePlanningDecision(p, { jobId: job.jobId, goal: job.goal }),
    },
    CLOSURE_DOCUMENTATION: {
      prompt: () => buildClosureDocPrompt(job),
      schema: () => closureDocSchemaFor({ jobId: job.jobId, goal: job.goal }),
      validate: (p) => validateClosureDocResult(p, { jobId: job.jobId, goal: job.goal }),
    },
    CRITERIA_COVERAGE: {
      prompt: () => buildCriteriaCoveragePrompt({
        goal: job.goal,
        requirements: job.coverageContext?.requirements ?? [],
        diffStat: job.coverageContext?.diffStat ?? null,
        diff: job.coverageContext?.diff ?? null,
        changedFiles: job.coverageContext?.changedFiles ?? [],
      }),
      schema: () => criteriaCoverageSchemaFor({ jobId: job.jobId, goal: job.goal }),
      validate: (p) => validateCriteriaCoverage(p, { jobId: job.jobId, goal: job.goal }),
      // Read-only. Coverage reads a diff and answers a question; it has no
      // business writing, and CLOSURE_TOOLS carries Write and Edit.
      tools: ['Read', 'Glob', 'Grep'],
      // It runs mid-round, before the review — NOT during closure. Writing a
      // closure state here would tell `resolveClosureResumePoint` that a Goal
      // it has not finished reviewing is being closed.
      resumeFrom: LOOP_STATES.REVIEW_REQUIRED,
    },
  };
  const handler = KINDS[kind];
  if (!handler) throw new SpikeError('UNSUPPORTED_JOB_TYPE', `Closure kind ${kind} has no handler`);

  const prompt = handler.prompt();
  const schema = handler.schema();
  const validate = handler.validate;

  // Planning is routed by risk; closure documentation is bookkeeping over a
  // decision already taken, so it runs on the standard model unless the job
  // says otherwise. CLOSURE is its own stage, not REVIEW — the two answer
  // different questions when the job carries no `routing`.
  const stage = isPlanning ? ROUTING_STAGES.PLANNING : ROUTING_STAGES.CLOSURE;
  const baseRouting = routingOf(job, stage);
  const router = createAttemptRouter({
    store, role: ROLE, jobId: job.jobId, base: baseRouting, kind: 'closure',
    goal: job.goal, round: job.round ?? 0,
  });

  const run = await runWithCapacity({
    store,
    role: ROLE,
    jobId: job.jobId,
    goal: job.goal,
    round: job.round ?? 0,
    resumeFrom: handler.resumeFrom
      ?? (isPlanning ? LOOP_STATES.NEXT_GOAL_PLANNING : LOOP_STATES.CLOSURE_DOCUMENTING),
    onEvent: onCapacityEvent,
    router,
    invoke: async ({ attempt }) => {
      const { routing } = await router.current();
      const active = routing ?? baseRouting;
      announceRouting({ routing: active });
      await ensureSessionFor(active);
      return sendRouted({
        routing: active,
        prompt,
        jsonSchema: schema,
        validatePayload: validate,
        tools: handler.tools ?? CLOSURE_TOOLS,
        worktree: job.worktree,
      });
    },
  });

  log(`${kind} COMPLETED`, run.outcome);

  if (run.outcome === RUN_OUTCOMES.HUMAN_REQUIRED) {
    workerState = 'ERROR';
    await store.appendEvent({ type: `${kind}_FAILED`, jobId: job.jobId, code: run.reason });
    currentJob = null; capacityWait = null; workerState = 'IDLE';
    return;
  }

  workerState = 'PUBLISHING';
  await store.appendEvent({
    type: `${kind}_PUBLISHED`, jobId: job.jobId, goal: job.goal,
    documents: run.result?.documentsUpdated?.length ?? 0,
    nextGoalId: run.result?.nextGoalId ?? null,
    planningDecision: run.result?.decision ?? null,
    reused: run.outcome === RUN_OUTCOMES.ALREADY_COMPLETED,
  });
  log(`${kind} DONE`, isPlanning
    ? `${run.result?.decision}${run.result?.nextGoalId ? ` ${run.result.nextGoalId}` : ''}`
    : `${run.result?.documentsUpdated?.length ?? 0} docs`);
  currentJob = null; capacityWait = null; workerState = 'IDLE';
}


const store = createJobStore(STATE_DIR);

const telemetry = createTelemetry({
  level: LOG_LEVEL,
  role: ROLE,
  sink: createTelemetryFileSink({ stateDir: STATE_DIR, role: ROLE, enabled: PERSIST_TELEMETRY }),
});

/**
 * Observational telemetry for the reviewer's own tool use.
 *
 * The Tech Lead reads files, greps and runs directed commands during a DEEP
 * review; all of that already streams out of the CLI. Nothing is asked of the
 * model to produce it.
 */
const telemetryOptions = (worktree) => (STREAM_EVENTS
  ? { onTelemetryEvent: (event) => telemetry.emit(event), telemetryRoot: worktree ?? null }
  : {});

let workerState = 'STARTING';
let session = null;
let currentJob = null;
let capacityWait = null;
// The model the job in flight is actually running on. Read from the routing on
// the job, never decided here: this worker executes a routing choice.
let currentRouting = null;

const getStatus = () => ({
  state: workerState,
  // What is running, not a constant. An IDLE Tech Lead is on no model at all.
  model: currentRouting?.model ?? null,
  // Follows the model: only the specialist holds a conversation.
  sessionStrategy: currentRouting && currentRouting.family !== MODELS.fable.family
    ? SESSION_STRATEGY.STATELESS
    : SESSION_STRATEGY.PERSISTENT,
  sessionId: session?.sessionId ?? null,
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
    log('ALREADY COMPLETED', 'decision on disk; model not called again');
  } else if (event.type === 'HUMAN_REQUIRED') {
    log('HUMAN REQUIRED', event.reason);
    capacityWait = null;
  }
}

/**
 * Restores the session from the durable registry, or creates one.
 * Returns whether an existing session was resumed.
 */
async function restoreSession(executable) {
  await mkdir(SESSION_CWD, { recursive: true });

  const registry = await loadRegistry(REGISTRY_PATH);
  const record = getSession(registry, ROLE);
  const resumed = Boolean(record?.sessionId);

  session = createPersistentSession({
    executable,
    role: ROLE,
    // The session belongs to the specialist. A conversation cannot change
    // model halfway: an Opus job never resumes this one, it runs stateless.
    model: SPECIALIST_MODEL,
    expectedFamily: MODELS.fable.family,
    cwd: record?.cwd ?? SESSION_CWD,
    sessionId: record?.sessionId,
    started: resumed,
    // Lifetime count, so a restart continues it instead of restarting it.
    turns: record?.turns,
    timeoutMs: TIMEOUT_MS,
    onLifecycle: (event) => store.appendEvent(event),
  });

  // The only periodic signal there is about this conversation's size. A
  // persistent session has no ceiling and no rotation, so the count carried
  // here is how an operator finds out it has grown to thousands of turns
  // before a compaction silently drops what a review depended on.
  await store.appendEvent({
    type: 'AGENT_SESSION_OPENED',
    role: ROLE,
    sessionId: session.sessionId,
    model: SPECIALIST_MODEL,
    resumed,
    turns: session.turns,
  });

  return resumed;
}

async function persistSession() {
  const registry = await loadRegistry(REGISTRY_PATH);
  const next = upsertSession(registry, ROLE, session.toRecord());
  // Guards the invariant that the Tech Lead and the Developer can never end up
  // on the same conversation.
  assertSessionsAreIndependent(next);
  await saveRegistry(REGISTRY_PATH, next);
}

function buildPrompt(context) {
  return [
    'Você está atuando como Tech Lead revisando uma entrega no pipeline do Atendly.',
    '',
    'Pacote de review (o repositório é a autoridade, não a sua memória):',
    JSON.stringify(context, null, 2),
    '',
    'graphOrientation traz o que os arquivos alterados alcançam, já consultado no grafo de',
    'código pelo harness. Use-o para julgar impacto em vez de procurar por grep; só consulte',
    'o grafo por conta própria para uma pergunta que ele não responde.',
    '',
    'Avalie a entrega contra o Goal e os guardrails do AGENTS.md.',
    '',
    'Retorne exclusivamente o JSON do contrato ReviewDecision.',
  ].join('\n');
}

async function handleJob(rawJob) {
  // Closure and planning are not reviews and use their own contracts.
  if (CLOSURE_KINDS.includes(rawJob?.type)) {
    await handleClosureJob(rawJob);
    return;
  }

  const job = validateReviewJob(rawJob);
  currentJob = { goal: job.goal, round: job.round };
  workerState = 'WORKING';

  log(`REVIEW ${job.goal}/R${job.round} RECEIVED`, `level ${job.reviewLevel}`);
  telemetry.setContext({ goal: job.goal, round: job.round, jobId: job.jobId });
  telemetry.event('JOB', `${job.goal}/R${job.round} REVIEW ${job.reviewLevel}`);
  await store.appendEvent({ type: 'REVIEW_JOB_RECEIVED', jobId: job.jobId, goal: job.goal, round: job.round });

  const graphOrientation = await resolveGraphOrientation({
    files: job.changedFiles,
    cwd: job.worktree,
  });
  await store.appendEvent({
    type: 'REVIEW_ORIENTED',
    jobId: job.jobId,
    goal: job.goal,
    round: job.round,
    status: graphOrientation.status,
    nodes: graphOrientation.nodes ?? [],
    chars: graphOrientation.text?.length ?? 0,
  });

  const context = buildTechLeadContext({
    goal: job.goal,
    goalPath: job.goalPath,
    round: job.round,
    reviewLevel: job.reviewLevel,
    migrationAcceptedBaseline: job.migrationAcceptedBaseline,
    executionBase: job.executionBase,
    worktree: job.worktree,
    changedFiles: [...job.changedFiles],
    diffStat: job.diffStat ?? null,
    implementationReport: job.implementationReport,
    validations: job.validations ?? [],
    previousBlockers: [...job.previousBlockers],
    graphOrientation,
  });

  // A real review reads the packet the orchestrator persisted, which carries
  // the change surface collected from git rather than claimed by the Developer.
  // Persist the running state BEFORE the model call, for the same reason.
  await store.writeRuntime({
    ...(await store.readRuntime()),
    state: 'REVIEWER_RUNNING',
    round: job.round,
    currentJobId: job.jobId,
  });

  const packet = job.packetPath ? await readJson(job.packetPath, { required: true }) : null;
  const prompt = packet ? renderReviewPrompt(packet) : buildPrompt(context);

  if (packet) log('DEEP REVIEW', `${packet.changedFiles.length} arquivos alterados`);

  const baseRouting = routingOf(job, ROUTING_STAGES.REVIEW);
  const router = createAttemptRouter({
    store, role: ROLE, jobId: job.jobId, base: baseRouting, kind: 'review',
    goal: job.goal, round: job.round,
  });

  // A capacity limit never costs the reviewer its continuity: the SAME session
  // is resumed on every retry of the same model. What CAN change the model is
  // the router — a Fable quota falling back to Opus, or an Opus review that
  // could not conclude escalating to Fable — and either one is a new attempt.
  const run = await runWithCapacity({
    store,
    role: ROLE,
    jobId: job.jobId,
    goal: job.goal,
    round: job.round,
    resumeFrom: LOOP_STATES.REVIEWER_RUNNING,
    onEvent: onCapacityEvent,
    router,
    invoke: async ({ attempt }) => {
      const { routing } = await router.current();
      const active = routing ?? baseRouting;
      announceRouting({ routing: active });
      await ensureSessionFor(active);
      return sendRouted({
        routing: active,
        prompt,
        jsonSchema: reviewDecisionSchemaFor({ jobId: job.jobId, goal: job.goal, round: job.round }),
        validatePayload: (payload) => validateReviewDecision(payload, {
          jobId: job.jobId,
          goal: job.goal,
          round: job.round,
        }),
        tools: REVIEWER_TOOLS,
        worktree: job.worktree,
      });
    },
  });

  log('REVIEW COMPLETED', run.outcome);

  if (run.outcome === RUN_OUTCOMES.HUMAN_REQUIRED) {
    workerState = 'ERROR';
    log('DECISION HUMAN_REQUIRED', run.reason);
    await store.appendEvent({ type: 'REVIEW_JOB_FAILED', jobId: job.jobId, code: run.reason, escalation: 'HUMAN_REQUIRED' });
    currentJob = null;
    capacityWait = null;
    workerState = 'IDLE';
    return;
  }

  workerState = 'PUBLISHING';
  await store.appendEvent({
    type: 'REVIEW_DECISION_PUBLISHED',
    jobId: job.jobId,
    goal: job.goal,
    round: job.round,
    decision: run.result?.decision ?? 'UNKNOWN',
    // Recorded next to the decision that produced it: the escalation is the
    // Tech Lead's, and it is auditable as such.
    nextDeveloperProfile: run.result?.nextDeveloperProfile ?? null,
    reused: run.outcome === RUN_OUTCOMES.ALREADY_COMPLETED,
  });

  log(`DECISION ${run.result?.decision ?? 'UNKNOWN'}`);
  telemetry.event('DECISION', run.result?.decision ?? 'UNKNOWN');
  if (run.result?.nextDeveloperProfile) {
    log('NEXT DEVELOPER PROFILE', run.result.nextDeveloperProfile);
    telemetry.event('PROFILE', `next round → ${run.result.nextDeveloperProfile}`);
  }
  telemetry.clearContext();
  currentJob = null;
  capacityWait = null;
  workerState = 'IDLE';
}

async function main() {
  const executable = resolveClaudeExecutable();
  const resumed = await restoreSession(executable.path);

  const mode = resolveRoutingMode();
  // Built now, printed only once the role lease is actually held: a process
  // that is about to refuse to start must not first announce that it is
  // waiting for work.
  const readyBanner = banner({
    title: 'TECH LEAD',
    model: 'adaptive — routed per job',
    sessionLine: `Specialist session: ${session.sessionId.slice(0, 8)} (${resumed ? 'resumed from registry' : 'new'})`,
    extra: [
      `Standard: ${resolveModel(ROUTING_CONFIG.tech_lead.review.standard.model).label}`
      + ` · effort ${ROUTING_CONFIG.tech_lead.review.standard.effort} (stateless) — every planning and review`,
      `Specialist: ${resolveModel(ROUTING_CONFIG.tech_lead.review.specialist.model).label}`
      + ` · effort ${ROUTING_CONFIG.tech_lead.review.specialist.effort} (persistent session) — escalation only`,
      `Routing mode: ${mode}`,
      `Log level: ${LOG_LEVEL}`,
    ],
  });

  await persistSession();
  workerState = 'IDLE';
  await runWorkerLoop({
    store,
    role: ROLE,
    getStatus,
    handleJob,
    onStarted: () => {
      console.log(readyBanner);
      console.log('Waiting for review task...\n');
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
    console.error(`Tech Lead worker stopped [${nameForExitCode(code)}]: ${error?.message ?? error}`);
    process.exitCode = code;
  });
}
