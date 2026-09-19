/**
 * IA Loop — executing a Work Unit DAG inside one Developer round.
 *
 * This is where the architecture actually pays off, and it is deliberately the
 * only new place that decides anything about execution order.
 *
 * What it does NOT do is as important as what it does:
 *
 *   - it does not create a worktree. Every unit of a round works in the SAME
 *     worktree, held by the SAME lease, owned by the SAME Developer job. One
 *     worktree per unit would multiply the isolation cost by the number of
 *     units and turn one merge into fifteen.
 *   - it does not run a review. The Tech Lead reviews the ROUND, once, at the
 *     end. A review per unit would spend the specialist on every DTO and undo
 *     the saving twice over.
 *   - it does not keep state beside the store. A unit's identity is a job in
 *     the store's Work Unit namespace, with the store's own idempotent result,
 *     numbered attempts and preserved history. A restart re-reads exactly what
 *     a first run wrote.
 *   - it does not decide which model runs. `routeWorkUnit` does, from the
 *     plan's declared type, and every change of model goes through the same
 *     router machinery that already produces MODEL_ROUTED / MODEL_ESCALATED /
 *     MODEL_FALLBACK events.
 *
 * The result of the whole DAG is ONE DeveloperResult, published under the
 * round's own job id by the caller. Everything downstream — the review packet,
 * the reconciler, the closure, the recovery path — sees exactly what it saw
 * before, which is why the feature flag can be flipped either way at any time.
 */

import { SpikeError } from './claude-process.mjs';
import { git } from './git-ops.mjs';
import { WORK_UNIT_NAMESPACE } from './job-store.mjs';
import { PROTOCOL_VERSION_V2 } from './contracts-v2.mjs';
import {
  ROUTING_STAGES,
  WORK_UNIT_EXECUTORS,
  resolveRoutingMode,
  routeWorkUnit,
  toJobRouting,
} from './model-routing.mjs';
import { createWorkUnitAttemptRouter } from './routing-runtime.mjs';
import { runWithCapacity, RUN_OUTCOMES } from './capacity-runner.mjs';
import { validateWorkUnitResult, workUnitResultSchemaFor } from './work-unit-contracts.mjs';
import {
  MAX_CONTEXT_EXPANSIONS,
  applyContextExpansion,
  buildWorkUnitContextPacket,
  buildWorkUnitPrompt,
} from './work-unit-context.mjs';
import {
  attributeFailure,
  runDeterministicAction,
  toDeterministicResult,
} from './deterministic-executor.mjs';
import { DETERMINISTIC_ACTIONS } from './deterministic-actions.mjs';
import { createResourceRegistry } from './resource-registry.mjs';
import { withTestDatabases } from './temporary-postgres.mjs';
import { workUnitConfig } from './work-unit-config.mjs';
import { validateWorkUnit } from './work-units.mjs';
import { resolveGraphOrientation } from './graph-orientation.mjs';
import { createFindingsLedger } from './findings-ledger.mjs';

/**
 * The job id of one execution of one unit.
 *
 * DETERMINISTIC on purpose, unlike a round's job id: a unit's identity is
 * (goal, round, unitId), so a restart looks under exactly the name the
 * previous process wrote and finds the result instead of minting a new one.
 * That is what makes "do not execute WU-001 again" true without a handoff file.
 *
 * `generation` exists for the one case where the SAME unit legitimately runs
 * twice in a round: a verification step re-run after a corrective unit. The
 * unit id does not change — VERIFY-001 is still VERIFY-001 — but each run gets
 * its own idempotent record, so the first failure stays readable next to the
 * second pass.
 */
export function workUnitJobId({ goal, round, unitId, generation = 1 }) {
  const slug = unitId.toLowerCase();
  return generation > 1
    ? `${goal}-r${round}-unit-${slug}-g${generation}`
    : `${goal}-r${round}-unit-${slug}`;
}

/** Files git says are changed in the worktree right now. */
async function snapshotChangedFiles(worktree, baseSha) {
  const opts = { cwd: worktree };
  const tracked = await git(['diff', '--name-only', baseSha, '--'], opts);
  const untracked = await git(['ls-files', '--others', '--exclude-standard'], opts);
  return new Set([
    ...(tracked === '' ? [] : tracked.split('\n').filter(Boolean)),
    ...(untracked === '' ? [] : untracked.split('\n').filter(Boolean)),
  ]);
}

/**
 * What one unit changed, decided by git rather than claimed by a model.
 *
 * Two sources, combined because neither alone is enough:
 *
 *   the DELTA        files that were not in the changed set before this unit
 *                    and are now. Unambiguous, and it needs nobody's word.
 *   the CONFIRMED    files the unit REPORTED, kept only if git also has them
 *   REPORT           in the changed set. This catches the case the delta
 *                    cannot see — a unit editing a file an earlier unit had
 *                    already touched, so the set membership never changed.
 *
 * A reported file git does not know about is dropped, and dropped silently is
 * wrong, so it is returned separately: a unit claiming to have written a file
 * that does not exist is worth seeing in the report.
 */
export function collectUnitChanges({ before, after, reported = [] }) {
  const delta = [...after].filter((file) => !before.has(file));
  const confirmed = reported.filter((file) => after.has(file) && !delta.includes(file));
  const unconfirmed = reported.filter((file) => !after.has(file));
  return {
    changedFiles: [...delta, ...confirmed].sort(),
    delta,
    confirmed,
    unconfirmed,
  };
}

/**
 * The paths a packet is already going to carry in `relevantFiles`.
 *
 * Mirrors what `buildWorkUnitContextPacket` derives, so the findings ledger can
 * exclude them and spend its budget on what the unit has NOT been told.
 */
function packetRelevantFiles(unit, records) {
  const fromDependencies = (unit.dependencies ?? [])
    .flatMap((id) => records.get(id)?.changedFiles ?? []);
  return [...(unit.expectedFiles ?? []), ...(unit.relevantFiles ?? []), ...fromDependencies];
}

/** The next unused FIX/DIAG id, so a corrective unit never collides. */
function nextDynamicId(prefix, used) {
  for (let n = 1; n <= 999; n += 1) {
    const id = `${prefix}-${String(n).padStart(3, '0')}`;
    if (!used.has(id)) return id;
  }
  throw new SpikeError('PLAN_INVALID', `Exhausted ${prefix} ids`);
}

/**
 * The corrective unit a failed verification earns.
 *
 * STANDARD, not COMPLEX: "a test went red" is ordinary work, and handing every
 * red test to the strongest model is exactly the habit this architecture
 * exists to break. It becomes COMPLEX only the way anything else does — by
 * escalating, with evidence.
 *
 * When attribution is unambiguous the unit is scoped to the files the guilty
 * unit actually changed. When it is not, the unit is a DIAGNOSIS: it is told
 * that the source is unknown and given the candidates, rather than being
 * pointed confidently at the wrong place.
 */
export function buildCorrectiveUnit({ verification, failure, attribution, usedIds }) {
  const ambiguous = attribution.attributed === null;
  const prefix = ambiguous ? 'DIAG' : 'FIX';
  const id = nextDynamicId(prefix, usedIds);

  const evidence = (failure.report ?? '').slice(-2000);
  const suspects = attribution.attributed
    ? [attribution.attributed.unitId]
    : attribution.candidates;

  return validateWorkUnit({
    id,
    title: ambiguous
      ? `Diagnosticar e corrigir a falha de ${verification.action}`
      : `Corrigir a falha de ${verification.action} introduzida por ${attribution.attributed.unitId}`,
    objective: [
      `A verificação determinística "${verification.action}" (${verification.id}) falhou nesta rodada.`,
      ambiguous
        ? `A origem não é atribuível com segurança${suspects.length ? ` (candidatos: ${suspects.join(', ')})` : ''};`
          + ' diagnostique antes de corrigir.'
        : `A falha aponta para o que ${attribution.attributed.unitId} alterou.`,
      'Corrija a causa. Não desabilite, não pule e não afrouxe a verificação.',
      '',
      'Saída da verificação (final):',
      evidence,
    ].join('\n'),
    type: 'STANDARD',
    complexity: ambiguous ? 'MEDIUM' : 'LOW',
    risk: 'MEDIUM',
    dependencies: [],
    relevantFiles: attribution.attributed?.files ?? failure.failurePaths ?? [],
    acceptanceCriteria: [
      `A verificação "${verification.action}" passa (exit 0) sem que ela própria tenha sido alterada, desabilitada ou afrouxada.`,
      'Nenhum critério de aceite já atendido por outra Work Unit foi revertido.',
    ],
  });
}

/**
 * Executes a whole plan and returns the record of what happened.
 *
 * `invokeUnit` performs the actual inference. It is injected for the same
 * reason the capacity runner injects `invoke`: every branch of this scheduler
 * — including the branch that proves a DETERMINISTIC unit never reaches a
 * model provider — has to be testable without spending quota.
 */
export async function executeWorkUnitPlan({
  store,
  plan,
  job,
  goal,
  round,
  worktree,
  executionBase,
  goalPath,
  goalSummary = null,
  invokeUnit,
  runAction = runDeterministicAction,
  changedFilesSnapshot = snapshotChangedFiles,
  config = workUnitConfig(),
  mode = resolveRoutingMode(),
  resumeFrom,
  emit = () => {},
}) {
  if (!store) throw new SpikeError('INVALID_ARGS', 'store is required');
  if (!plan) throw new SpikeError('INVALID_ARGS', 'an execution plan is required');
  if (typeof invokeUnit !== 'function') throw new SpikeError('INVALID_ARGS', 'invokeUnit must be a function');

  const unitsById = new Map(plan.workUnits.map((unit) => [unit.id, unit]));
  const usedIds = new Set(unitsById.keys());
  const records = new Map();
  const queue = [...plan.order];
  const generations = new Map();
  const fixesByVerification = new Map();
  let fixBudget = config.maxFixUnitsPerRound;
  // Scoped to this round's plan, which is scoped to this Goal's worktree. An
  // entry only ever describes a tree that is still the one being edited.
  const findings = createFindingsLedger();

  await store.appendEvent({
    type: 'WORK_UNIT_PLAN_RESOLVED',
    goal,
    round,
    jobId: job.jobId,
    source: plan.source,
    units: plan.workUnits.length,
    order: [...plan.order],
    levels: plan.levels.map((level) => [...level]),
    types: countTypes(plan.workUnits),
    fragmentation: plan.fragmentation,
    merges: plan.merges,
  });

  emit(`Execution plan: ${plan.workUnits.length} work unit(s) — ${describeTypes(plan.workUnits)} · source ${plan.source}`);
  for (const merge of plan.merges) {
    emit(`  normalised: ${merge.absorbed} merged into ${merge.into} (too small to be worth its own context)`);
  }

  while (queue.length > 0) {
    const unitId = queue.shift();
    const unit = unitsById.get(unitId);
    if (!unit) throw new SpikeError('PLAN_INVALID', `Scheduler reached unknown unit ${unitId}`);

    // A unit whose dependency did not complete can never become READY. It is
    // BLOCKED, not FAILED: nothing was attempted, and recording it as a
    // failure would make the report claim work that never ran.
    //
    // A GATE is the exception, because a gate does not build the tree — it
    // OBSERVES it. `VERIFY-001 depends on WU-004` states an order (typecheck
    // after the code is written); the scheduler used to read it as a
    // condition (if WU-004 did not complete, never typecheck at all).
    //
    // Goal019 is what that cost. One refused escalation left eight of fifteen
    // units with zero attempts, six of them gates, and the reviewer went
    // through 84 changed files across three rounds with no typecheck, no lint
    // and no suite in the packet — so the only way left to find a defect was
    // Opus reading the diff by hand. It found real ones, at the highest price
    // the harness can charge.
    const unmet = unit.dependencies.filter((dependency) => records.get(dependency)?.state !== 'COMPLETED');
    const isGate = unit.type === 'DETERMINISTIC';
    if (unmet.length > 0 && !isGate) {
      records.set(unitId, blockedRecord(unit, `Depende de ${unmet.join(', ')}, que não completou.`));
      await store.appendEvent({
        type: 'WORK_UNIT_BLOCKED', goal, round, workUnitId: unitId, blockedBy: unmet,
      });
      emit(`  ${unitId} BLOCKED — depende de ${unmet.join(', ')}`);
      continue;
    }
    // Carried so the answer is never mistaken for a verdict: what a gate says
    // about a half-built tree is information, not acceptance.
    const incompleteTree = unmet.length > 0 ? [...unmet] : null;

    const generation = generations.get(unitId) ?? 1;
    const unitJobId = workUnitJobId({ goal, round, unitId, generation });

    const record = unit.type === 'DETERMINISTIC'
      ? await executeDeterministicUnit({
        store, unit, unitJobId, goal, round, worktree, runAction, emit,
      })
      : await executeModelUnit({
        store, plan, unit, unitJobId, job, goal, round, worktree, executionBase, goalPath,
        goalSummary, invokeUnit, changedFilesSnapshot, config, mode, resumeFrom, emit, records, findings,
      });

    // OBSERVED, never COMPLETED — and that is the whole safety of running it.
    // A green gate over a tree whose upstream unit never ran has not verified
    // the Goal, and leaving it COMPLETED would let anything depending on the
    // gate read it as one.
    if (incompleteTree && record.state !== 'SKIPPED') {
      record.state = 'OBSERVED';
      record.incompleteTree = incompleteTree;
      record.blockedReason = `Rodou sobre árvore incompleta (${incompleteTree.join(', ')} não completou): `
        + `exit ${record.exitCode ?? 'n/a'}. Informativo, não é veredito.`;
    }

    records.set(unitId, record);

    // A gate whose precondition the harness cannot meet never ran, so there is
    // nothing to attribute and nothing for a fix unit to repair. Recorded as
    // its own event so the round stays honest about what was and was not
    // verified, and skipped over rather than counted as a red gate.
    if (unit.type === 'DETERMINISTIC' && record.state === 'SKIPPED') {
      await store.appendEvent({
        type: 'WORK_UNIT_VERIFICATION_SKIPPED',
        goal, round, workUnitId: unitId, action: unit.action,
        missingEnv: record.missingEnv ?? [],
      });
      emit(`  ${unitId} SKIPPED — pré-condição ausente; o gate não rodou e nenhuma correção é criada.`);
      continue;
    }

    // It ran, and what it found reaches the reviewer. What it does NOT do is
    // create a fix unit: the failure it reports may well be the missing work
    // upstream, and attributing that to a file this round touched would send a
    // corrective unit chasing a symptom.
    if (record.state === 'OBSERVED') {
      await store.appendEvent({
        type: 'WORK_UNIT_VERIFICATION_ON_INCOMPLETE_TREE',
        goal, round, workUnitId: unitId, action: unit.action,
        blockedBy: record.incompleteTree,
        exitCode: record.exitCode ?? null,
        passed: record.exitCode === 0,
      });
      emit(`  ${unitId} OBSERVED — ${unit.action ?? 'gate'} rodou sobre árvore incompleta `
        + `(${record.incompleteTree.join(', ')} não completou): exit ${record.exitCode ?? 'n/a'}. `
        + 'Informativo, não é veredito; nenhuma correção é criada.');
      continue;
    }

    // A failed verification is the one thing that can change the plan while it
    // runs. Everything else is decided before execution starts.
    if (unit.type === 'DETERMINISTIC' && record.state !== 'COMPLETED') {
      const usedForThis = fixesByVerification.get(unitId) ?? 0;
      const canFix = fixBudget > 0 && usedForThis < config.maxFixUnitsPerVerification;

      const attribution = attributeFailure({
        paths: record.failurePaths ?? [],
        unitChanges: new Map([...records.entries()].map(([id, entry]) => [id, entry.changedFiles ?? []])),
      });

      await store.appendEvent({
        type: 'WORK_UNIT_VERIFICATION_FAILED',
        goal, round, workUnitId: unitId, action: unit.action,
        attributedTo: attribution.attributed?.unitId ?? null,
        ambiguous: attribution.ambiguous,
        candidates: attribution.candidates,
        fixScheduled: canFix,
      });

      if (canFix) {
        const corrective = buildCorrectiveUnit({
          verification: { id: unitId, action: unit.action },
          failure: record,
          attribution,
          usedIds,
        });
        usedIds.add(corrective.id);
        unitsById.set(corrective.id, corrective);
        fixesByVerification.set(unitId, usedForThis + 1);
        fixBudget -= 1;
        generations.set(unitId, generation + 1);

        // The corrective unit runs next, then the verification runs again.
        // Pushed to the FRONT rather than appended: a verification that stays
        // red must stop the round here, not after everything downstream of it
        // has been built on top of a broken tree.
        queue.unshift(corrective.id, unitId);

        await store.appendEvent({
          type: 'WORK_UNIT_FIX_CREATED',
          goal, round, workUnitId: corrective.id, forVerification: unitId,
          attributedTo: attribution.attributed?.unitId ?? null,
          ambiguous: attribution.ambiguous,
        });
        emit(`  ${unitId} FAILED → ${corrective.id} (${corrective.type})`
          + `${attribution.attributed ? ` · atribuída a ${attribution.attributed.unitId}` : ' · origem ambígua'}`);
        continue;
      }

      emit(`  ${unitId} FAILED — orçamento de correção esgotado; a rodada segue para review com a falha registrada.`);
    }
  }

  return summarise({ plan, records, goal, round, jobId: job.jobId, unitsById });
}

function blockedRecord(unit, reason) {
  return {
    id: unit.id,
    type: unit.type,
    state: 'BLOCKED',
    executor: null,
    model: null,
    effort: null,
    tier: unit.type,
    attempts: 0,
    escalations: 0,
    contextExpansions: 0,
    summary: reason,
    report: reason,
    changedFiles: [],
    acceptance: [],
    blockedReason: reason,
    durationMs: 0,
  };
}

/**
 * Runs a DETERMINISTIC unit.
 *
 * No router, no model, no capacity runner — there is no inference to wait for
 * and no quota to hit. The result is still written to the store, because
 * idempotency is not about models: a restart must not re-run a fifteen-minute
 * build whose answer is already on disk.
 */
/**
 * Runs a deterministic action, provisioning the databases it declares.
 *
 * The gate scripts refuse to run without a disposable cluster, and until now
 * the orchestrator started none — so `validate:integration` exited 2 instantly
 * on every attempt and the reviewer ran the suite by hand. This starts one,
 * creates a database per declared variable, and tears it down in a `finally`
 * whose net is the worker loop's per-attempt resource sweep.
 *
 * Provisioning that FAILS is not an error of the Goal: the action falls
 * through to the ordinary run, where the missing variables are detected before
 * the spawn and the unit is recorded as SKIPPED with them named. A machine
 * without PostgreSQL installed reports that, rather than failing the round.
 */
async function runActionWithDatabases({ store, unit, worktree, attemptId, goal, round, unitJobId, runAction, emit }) {
  const spec = DETERMINISTIC_ACTIONS[unit.action];
  const required = spec?.requiresEnv ?? [];
  const missing = required.filter((name) => (process.env[name] ?? '').trim() === '');
  if (missing.length === 0 || !attemptId) return runAction({ unit, worktree });

  try {
    return await withTestDatabases(
      {
        registry: createResourceRegistry(store.paths.root),
        stateDir: store.paths.root,
        jobId: unitJobId,
        attemptId,
        goalId: goal,
        round,
        stage: 'work_unit',
        role: 'developer',
      },
      missing,
      (env) => {
        emit(`    provisionando PostgreSQL descartável para ${missing.join(', ')}`);
        return runAction({ unit, worktree, env: { ...process.env, ...env } });
      },
    );
  } catch (error) {
    emit(`    PostgreSQL descartável indisponível (${error.message}); o gate será pulado por pré-condição.`);
    return runAction({ unit, worktree });
  }
}

async function executeDeterministicUnit({ store, unit, unitJobId, goal, round, worktree, runAction, emit }) {
  if (await store.hasCompletedResult(WORK_UNIT_NAMESPACE, unitJobId)) {
    const existing = await store.readResult(WORK_UNIT_NAMESPACE, unitJobId);
    emit(`  ${unit.id} (${unit.action}) — resultado já em disco; o comando NÃO é executado de novo.`);
    return fromPersisted(unit, existing?.result?.result ?? existing?.result, { reused: true });
  }

  await store.dispatchJob(WORK_UNIT_NAMESPACE, unitJobDocument({ unit, unitJobId, goal, round, worktree, routing: null }));
  const attemptId = (await store.readAttemptState(WORK_UNIT_NAMESPACE, unitJobId))?.attemptId ?? null;
  await store.setJobStatus(WORK_UNIT_NAMESPACE, unitJobId, 'RUNNING');

  await store.appendEvent({
    type: 'WORK_UNIT_STARTED',
    goal, round, workUnitId: unit.id, jobId: unitJobId,
    unitType: unit.type, executor: WORK_UNIT_EXECUTORS.NATIVE, action: unit.action,
  });
  emit(`  ${unit.id} DETERMINISTIC → native (${unit.action}${unit.scope ? ` @ ${unit.scope}` : ''})`);

  const outcome = await runActionWithDatabases({
    store, unit, worktree, attemptId, goal, round, unitJobId, runAction, emit,
  });
  const result = toDeterministicResult({ unit, outcome, goal, round, jobId: unitJobId });

  // A skipped gate is not a failed job: leaving it FAILED would make a
  // resume treat an unmet precondition as work that could be retried.
  const jobStatus = outcome.skipped ? 'SKIPPED' : (outcome.ok ? 'COMPLETED' : 'FAILED');
  await store.publishResult(WORK_UNIT_NAMESPACE, unitJobId, { ok: outcome.ok, result }, { attemptId });
  await store.setJobStatus(WORK_UNIT_NAMESPACE, unitJobId, jobStatus);

  await store.appendEvent({
    type: 'WORK_UNIT_DETERMINISTIC_EXECUTED',
    goal, round, workUnitId: unit.id, jobId: unitJobId,
    action: unit.action, ok: outcome.ok, skipped: outcome.skipped ?? false,
    missingEnv: outcome.missingEnv ?? [], exitCode: outcome.exitCode,
    signal: outcome.signal, durationMs: outcome.durationMs,
    // Stated explicitly because it is the whole point of the type.
    modelCalls: 0,
  });
  emit(`    ${outcome.skipped ? 'SKIP' : (outcome.ok ? 'PASS' : 'FAIL')}`
    + ` — ${outcome.skipped ? `faltam ${(outcome.missingEnv ?? []).join(', ')}` : `exit ${outcome.exitCode ?? 'n/a'}`}`
    + ` (${outcome.durationMs}ms)`);

  return fromPersisted(unit, result, { reused: false });
}

/** A store-persisted unit result, back in scheduler shape. */
function fromPersisted(unit, result, { reused }) {
  return {
    id: unit.id,
    type: unit.type,
    state: result?.status === 'COMPLETED' ? 'COMPLETED' : (result?.status ?? 'FAILED'),
    executor: result?.executor ?? (unit.type === 'DETERMINISTIC' ? 'native' : 'model'),
    model: result?.model ?? null,
    effort: result?.effort ?? null,
    tier: result?.tier ?? unit.type,
    attempts: result?.attempts ?? 1,
    escalations: result?.escalations ?? 0,
    contextExpansions: result?.contextExpansions ?? 0,
    summary: result?.summary ?? null,
    report: result?.report ?? null,
    changedFiles: [...(result?.changedFiles ?? [])],
    acceptance: [...(result?.acceptance ?? [])],
    blockedReason: result?.blockedReason ?? null,
    action: result?.action ?? unit.action ?? null,
    exitCode: result?.exitCode ?? null,
    durationMs: result?.durationMs ?? 0,
    failurePaths: [...(result?.failurePaths ?? [])],
    missingEnv: [...(result?.missingEnv ?? [])],
    reused,
  };
}

/** The job document a unit's store entry carries. */
function unitJobDocument({ unit, unitJobId, goal, round, worktree, routing, parentJobId = null, goalPath = null }) {
  return {
    protocolVersion: PROTOCOL_VERSION_V2,
    jobId: unitJobId,
    role: WORK_UNIT_NAMESPACE,
    goal,
    round,
    workUnitId: unit.id,
    unitType: unit.type,
    complexity: unit.complexity,
    risk: unit.risk,
    action: unit.action,
    scope: unit.scope,
    worktree,
    goalPath,
    parentJobId,
    routing,
  };
}

/**
 * Runs a MECHANICAL, STANDARD or COMPLEX unit.
 *
 * Everything that makes a round-level Developer call safe applies here
 * unchanged, because it is the same machinery: an idempotent result, numbered
 * attempts, capacity waits, an authorised escalation as a successor attempt,
 * a routing event per attempt. The only additions are the context packet and
 * the expansion loop.
 */
async function executeModelUnit({
  store, plan, unit, unitJobId, job, goal, round, worktree, executionBase, goalPath,
  goalSummary, invokeUnit, changedFilesSnapshot, config, mode, resumeFrom, emit, records, findings,
}) {
  if (await store.hasCompletedResult(WORK_UNIT_NAMESPACE, unitJobId)) {
    const existing = await store.readResult(WORK_UNIT_NAMESPACE, unitJobId);
    emit(`  ${unit.id} — resultado já em disco; o modelo NÃO é chamado de novo.`);
    return fromPersisted(unit, existing?.result?.result ?? existing?.result, { reused: true });
  }

  const initialRouting = routeWorkUnit({ unit, escalations: 0, mode });
  const baseRouting = toJobRouting(initialRouting.routing);

  await store.dispatchJob(
    WORK_UNIT_NAMESPACE,
    unitJobDocument({
      unit, unitJobId, goal, round, worktree, goalPath,
      routing: baseRouting, parentJobId: job.jobId,
    }),
    { reason: 'RECOVERED_INTERRUPTED_UNIT_ATTEMPT' },
  );

  const router = createWorkUnitAttemptRouter({ store, jobId: unitJobId, unit, goal, round, mode });

  // Carried across attempts of THIS unit only. Rebuilt from nothing on a cold
  // restart, which is correct: an expansion the previous process granted is
  // recorded on the attempt history, and re-earning it costs one attempt
  // rather than risking a packet that claims context the unit never asked for.
  let expansions = [];
  let contextExpansions = 0;

  await store.appendEvent({
    type: 'WORK_UNIT_STARTED',
    goal, round, workUnitId: unit.id, jobId: unitJobId,
    unitType: unit.type, executor: WORK_UNIT_EXECUTORS.MODEL,
    tier: initialRouting.tier, model: initialRouting.routing.modelKey,
    effort: initialRouting.routing.effort, reason: initialRouting.reason,
  });
  emit(`  ${unit.id} ${unit.type} → ${initialRouting.routing.label} effort ${initialRouting.routing.effort}`
    + ` (${initialRouting.reason})`);

  const before = await changedFilesSnapshot(worktree, executionBase);
  const startedAt = Date.now();
  let lastPacket = null;

  // Set once, when the router refuses an escalation because there is nothing
  // above this unit. Carried into the next packet so the unit is TOLD, rather
  // than left to ask a second time for something nobody can grant.
  let ceiling = null;

  const run = await runWithCapacity({
    store,
    role: WORK_UNIT_NAMESPACE,
    // The thing that actually holds the lease and that a human would go and
    // look at is the Developer worker this unit runs inside.
    blockedAgent: 'developer',
    jobId: unitJobId,
    goal,
    round,
    resumeFrom,
    router,
    // The unit id is the one identifier the capacity runner cannot see, and it
    // is what makes per-unit consumption answerable later.
    usageContext: { workUnitId: unit.id },
    onEvent: (event) => {
      if (event.type === 'MODEL_ESCALATED') {
        emit(`    ${unit.id} escalated: ${event.from} → ${event.to} (${event.reason})`);
      } else if (event.type === 'MODEL_FALLBACK') {
        emit(`    ${unit.id} capacity fallback: ${event.from} → ${event.to} (${event.reason})`);
      } else if (event.type === 'CONTEXT_EXPANDED') {
        emit(`    ${unit.id} asked for more context (${event.reason})`);
      } else if (event.type === 'CEILING_DECLARED') {
        emit(`    ${unit.id} pediu modelo mais forte e não há; última tentativa no mesmo modelo, ciente disso`);
      }
    },

    /**
     * The unit asked for a stronger model and the router answered that there
     * is none. That refusal is correct and stays — what changes is that it no
     * longer ENDS the unit.
     *
     * Bounded at exactly one: the second telling would carry nothing the first
     * did not, and an unbounded version would be a COMPLEX unit retrying
     * itself on Opus for as long as it kept asking. If the extra attempt still
     * cannot finish, the unit's own answer is what gets published — which is
     * the honest outcome, now with whatever it managed to deliver in the tree
     * and its unmet criteria named for the reviewer.
     */
    finalAttemptFor: async ({ result }) => {
      if (result?.status !== 'ESCALATION_REQUIRED') return null;
      if (ceiling) return null;

      const refusal = router.lastRefusal();
      if (!refusal?.atTopOfTable) return null;

      ceiling = {
        tier: unit.type,
        requested: refusal.requested ?? result?.escalation?.reason ?? null,
        reason: refusal.reason,
      };
      return {
        reason: refusal.reason,
        detail: { workUnitId: unit.id, requested: ceiling.requested },
        event: { workUnitId: unit.id, tier: ceiling.tier, requested: ceiling.requested },
      };
    },

    /**
     * A unit that says its context was too narrow gets a wider packet and
     * another attempt on the SAME model — bounded, because "ask for more
     * files" must never become an unbounded retry. At the budget it stops
     * being a continuation and becomes the unit's answer, which the summary
     * then reports as BLOCKED: the harness could not give it what it needed,
     * and pretending otherwise would hide the very measurement this exists to
     * produce.
     */
    continuationFor: async ({ result }) => {
      if (result?.status !== 'CONTEXT_EXPANSION_REQUIRED') return null;
      if (contextExpansions >= Math.min(config.maxContextExpansions, MAX_CONTEXT_EXPANSIONS)) return null;

      const applied = applyContextExpansion({ current: expansions, request: result.contextRequest, unit });
      if (applied.added.length === 0) {
        // Every file it asked for was already in the packet. Granting that
        // would be spending an attempt to hand it the same context twice.
        return null;
      }

      expansions = applied.expansions;
      contextExpansions += 1;
      return {
        reason: result.contextRequest.reason,
        detail: {
          workUnitId: unit.id,
          requested: [...result.contextRequest.files],
          added: applied.added,
          redundant: applied.redundant,
        },
        event: {
          workUnitId: unit.id,
          requested: [...result.contextRequest.files],
          added: applied.added,
          redundant: applied.redundant,
          expansion: contextExpansions,
        },
      };
    },

    invoke: async ({ attempt }) => {
      const { routing } = await router.current();
      // Resolved here, not inside the builder: the builder stays pure and
      // synchronous, and a retry of the same unit re-runs the query against
      // whatever the previous attempts already wrote into the worktree.
      const graphOrientation = await resolveGraphOrientation({
        // relevantFiles first: they already exist, so they have nodes.
        // expectedFiles often name files this unit is about to create, which
        // the graph cannot know about yet and simply skips.
        files: [...(unit.relevantFiles ?? []), ...(unit.expectedFiles ?? [])],
        cwd: worktree,
      });
      // Recorded per attempt, because otherwise the change is unmeasurable:
      // the ledger already carries this unit's turns and tokens, and this is
      // the row that says whether it started with a map or without one. A
      // NO_GRAPH or EMPTY status is exactly as interesting as an OK.
      await store.appendEvent({
        type: 'WORK_UNIT_ORIENTED',
        goal,
        round,
        workUnitId: unit.id,
        jobId: unitJobId,
        attempt,
        status: graphOrientation.status,
        nodes: graphOrientation.nodes ?? [],
        chars: graphOrientation.text?.length ?? 0,
        partial: graphOrientation.partial ?? false,
        durationMs: graphOrientation.durationMs ?? null,
        reason: graphOrientation.reason ?? null,
      });
      const packet = buildWorkUnitContextPacket({
        goal,
        goalPath,
        goalSummary: goalSummary ?? plan.goalSummary,
        executionStrategy: plan.executionStrategy,
        round,
        unit,
        worktree,
        dependencyResults: new Map([...records.entries()]),
        previousFailures: await previousFailuresFor(store, unitJobId),
        expansions,
        graphOrientation,
        ceiling,
        // Resolved per attempt, so a retry sees what the units that ran in
        // between discovered. `relevantFiles` is excluded: repeating what the
        // packet already lists would spend the budget saying nothing.
        findingsLedger: findings?.forPacket({ exclude: packetRelevantFiles(unit, records) }) ?? [],
      });
      lastPacket = packet;

      const unitJob = { jobId: unitJobId, goal, round, worktree };
      return invokeUnit({
        unit,
        packet,
        prompt: buildWorkUnitPrompt(packet, unitJob),
        routing,
        unitJobId,
        attempt,
        timeoutMs: config.unitTimeoutMs,
        // Observational only: the ledger reads the tool stream as it goes, so
        // what this unit opens is available to the next one without anybody
        // being asked to summarise it.
        onToolEvent: (event) => findings?.observe(unit.id, event),
        jsonSchema: workUnitResultSchemaFor({ jobId: unitJobId, goal, round, workUnitId: unit.id }),
        validatePayload: (payload) => validateWorkUnitResult(payload, {
          jobId: unitJobId,
          goal,
          round,
          workUnitId: unit.id,
          acceptanceCriteria: unit.acceptanceCriteria,
        }),
      });
    },
  });

  const after = await changedFilesSnapshot(worktree, executionBase);
  const payload = run.result ?? null;
  const changes = collectUnitChanges({
    before,
    after,
    reported: payload?.changedFiles ?? [],
  });
  // Recorded from git, so a unit that reported a file it never wrote does not
  // get to put it in front of the next unit.
  findings?.completeUnit(unit.id, { changedFiles: changes.changedFiles });

  const attemptState = await store.readAttemptState(WORK_UNIT_NAMESPACE, unitJobId);
  const { routing: finalRouting, tier, escalations } = await router.current();

  const state = run.outcome === RUN_OUTCOMES.HUMAN_REQUIRED
    ? 'FAILED'
    : (payload?.status === 'COMPLETED' ? 'COMPLETED' : (payload?.status ?? 'FAILED'));

  const record = {
    id: unit.id,
    type: unit.type,
    state,
    executor: 'model',
    model: finalRouting?.modelKey ?? null,
    effort: finalRouting?.effort ?? null,
    tier,
    attempts: attemptState?.attempt ?? run.attempts ?? 1,
    escalations,
    contextExpansions,
    summary: payload?.summary ?? run.note ?? run.reason ?? null,
    report: payload?.report ?? run.note ?? null,
    changedFiles: changes.changedFiles,
    unconfirmedFiles: changes.unconfirmed,
    acceptance: [...(payload?.acceptance ?? [])],
    blockedReason: payload?.blockedReason ?? (run.outcome === RUN_OUTCOMES.HUMAN_REQUIRED ? run.reason : null),
    contextSize: lastPacket ? JSON.stringify(lastPacket).length : null,
    relevantFilesGiven: lastPacket ? lastPacket.relevantFiles.length : null,
    durationMs: Date.now() - startedAt,
    action: null,
    exitCode: null,
    failurePaths: [],
    reused: run.outcome === RUN_OUTCOMES.ALREADY_COMPLETED,
  };

  await store.appendEvent({
    type: 'WORK_UNIT_COMPLETED',
    goal, round, workUnitId: unit.id, jobId: unitJobId,
    state: record.state,
    unitType: unit.type,
    tier: record.tier,
    model: record.model,
    effort: record.effort,
    attempts: record.attempts,
    escalations: record.escalations,
    contextExpansions: record.contextExpansions,
    changedFiles: record.changedFiles.length,
    contextChars: record.contextSize,
    durationMs: record.durationMs,
  });
  emit(`    ${unit.id} ${record.state} — ${record.attempts} attempt(s), ${record.changedFiles.length} file(s)`
    + `${record.escalations > 0 ? `, ${record.escalations} escalation(s)` : ''}`
    + `${record.contextExpansions > 0 ? `, ${record.contextExpansions} context expansion(s)` : ''}`);

  return record;
}

/**
 * This unit's OWN earlier failures, for its next attempt's packet.
 *
 * Only this unit's. Handing a unit the round's whole failure history is how a
 * deliberately narrow context quietly becomes the whole round again.
 */
async function previousFailuresFor(store, unitJobId) {
  const state = await store.readAttemptState(WORK_UNIT_NAMESPACE, unitJobId);
  return (state?.history ?? [])
    .filter((entry) => entry.reason && entry.reason !== 'CONTEXT_EXPANDED')
    .map((entry) => ({
      attempt: entry.attempt,
      model: entry.fromModel ?? entry.routedTo?.modelKey ?? null,
      reason: entry.reason,
      detail: typeof entry.detail === 'string' ? entry.detail : null,
    }));
}

function countTypes(units) {
  return units.reduce((counts, unit) => {
    counts[unit.type] = (counts[unit.type] ?? 0) + 1;
    return counts;
  }, {});
}

function describeTypes(units) {
  const counts = countTypes(units);
  return Object.entries(counts).map(([type, count]) => `${count} ${type}`).join(', ');
}

/**
 * Turns the DAG's records into the ONE answer the round publishes.
 *
 * The status rule is deliberately strict: a round is REVIEW_REQUIRED only when
 * every unit that ran completed. A round with a red verification or a blocked
 * unit is BLOCKED, and the reviewer is told so — a partially finished round
 * that reports itself as ready for review is exactly how a failure reaches an
 * ACCEPTED decision.
 */
export function summarise({ plan, records, goal, round, jobId, unitsById }) {
  const ordered = [...records.values()];
  const failed = ordered.filter((record) => record.state !== 'COMPLETED');

  // `passed` keeps meaning exactly what it always meant — did the command
  // exit 0 — because the contract requires a boolean and a gate's exit code
  // is a fact either way. What CHANGES over an incomplete tree is what that
  // fact licenses, so the caveat rides in the name, where nothing reading the
  // packet can miss it.
  const validations = ordered
    .filter((record) => record.executor === 'native')
    .map((record) => ({
      name: record.incompleteTree
        ? `${record.action ?? record.id} (árvore incompleta: ${record.incompleteTree.join(', ')})`
        : (record.action ?? record.id),
      passed: record.incompleteTree
        ? record.exitCode === 0
        : record.state === 'COMPLETED',
      detail: `${record.id}: exit ${record.exitCode ?? 'n/a'} (${record.durationMs}ms)`
        + (record.incompleteTree ? ' — observado, não é veredito' : ''),
    }));

  const routing = {
    native: ordered.filter((record) => record.executor === 'native').length,
    haiku: ordered.filter((record) => record.model === 'haiku').length,
    sonnet: ordered.filter((record) => record.model === 'sonnet').length,
    opus: ordered.filter((record) => record.model === 'opus').length,
    fable: ordered.filter((record) => record.model === 'fable').length,
  };

  const telemetry = {
    workUnitsTotal: ordered.length,
    workUnitsByType: countTypes(ordered.map((record) => ({ type: record.type }))),
    workUnitsByState: ordered.reduce((counts, record) => {
      counts[record.state] = (counts[record.state] ?? 0) + 1;
      return counts;
    }, {}),
    modelCalls: routing,
    escalations: ordered.reduce((total, record) => total + (record.escalations ?? 0), 0),
    contextExpansions: ordered.reduce((total, record) => total + (record.contextExpansions ?? 0), 0),
    attempts: ordered.reduce((total, record) => total + (record.attempts ?? 0), 0),
    reusedResults: ordered.filter((record) => record.reused).length,
    // Averaged over the units that actually built a packet, so deterministic
    // units — which have no context at all — do not flatter the number.
    averageContextChars: averageContext(ordered),
    dynamicUnits: ordered.filter((record) => /^(FIX|DIAG)-/.test(record.id)).map((record) => record.id),
  };

  const changedFiles = [...new Set(ordered.flatMap((record) => record.changedFiles ?? []))].sort();

  const report = [
    `# Execução por Work Units — Goal ${goal}, rodada ${round}`,
    '',
    `Plano: ${plan.workUnits.length} unidade(s) declarada(s), ${ordered.length} executada(s). Fonte: ${plan.source}.`,
    plan.executionStrategy ? `Estratégia: ${plan.executionStrategy}` : null,
    '',
    '## Unidades',
    '',
    ...ordered.map((record) => renderUnit(record, unitsById.get(record.id))),
    '',
    '## Verificação determinística',
    '',
    validations.length === 0
      ? '(o plano não declarou nenhuma verificação determinística)'
      : validations.map((entry) => `- ${entry.name}: ${entry.passed ? 'PASS' : 'FAIL'} — ${entry.detail}`).join('\n'),
    '',
    '## Roteamento',
    '',
    `- native (sem modelo): ${routing.native}`,
    `- haiku: ${routing.haiku} · sonnet: ${routing.sonnet} · opus: ${routing.opus}`,
    `- escalations: ${telemetry.escalations} · context expansions: ${telemetry.contextExpansions}`,
    `- tentativas totais: ${telemetry.attempts} · resultados reaproveitados de disco: ${telemetry.reusedResults}`,
    failed.length > 0 ? '' : null,
    failed.length > 0 ? '## Não concluído' : null,
    failed.length > 0
      ? failed.map((record) => `- ${record.id} (${record.state}): ${record.blockedReason ?? record.summary ?? 'sem detalhe'}`).join('\n')
      : null,
  ].filter((line) => line !== null).join('\n');

  return {
    records,
    order: ordered.map((record) => record.id),
    changedFiles,
    telemetry,
    aggregate: {
      protocolVersion: PROTOCOL_VERSION_V2,
      jobId,
      goal,
      round,
      status: failed.length === 0 ? 'REVIEW_REQUIRED' : 'BLOCKED',
      summary: failed.length === 0
        ? `${ordered.length} work unit(s) concluída(s): ${routing.native} determinística(s), `
          + `${routing.haiku} em Haiku, ${routing.sonnet} em Sonnet, ${routing.opus} em Opus.`
        : `${failed.length} de ${ordered.length} work unit(s) não concluíram: ${failed.map((r) => r.id).join(', ')}.`,
      implementationReport: report,
      validations,
      // Carried so the review packet can show the DAG without recomputing it.
      workUnitExecution: {
        source: plan.source,
        units: ordered.map((record) => ({
          id: record.id,
          type: record.type,
          state: record.state,
          executor: record.executor,
          model: record.model,
          effort: record.effort,
          tier: record.tier,
          attempts: record.attempts,
          escalations: record.escalations,
          contextExpansions: record.contextExpansions,
          changedFiles: record.changedFiles,
        })),
        levels: plan.levels.map((level) => [...level]),
        telemetry,
      },
    },
  };
}

function averageContext(records) {
  const sized = records.filter((record) => Number.isFinite(record.contextSize));
  if (sized.length === 0) return null;
  return Math.round(sized.reduce((total, record) => total + record.contextSize, 0) / sized.length);
}

function renderUnit(record, unit) {
  const head = `### ${record.id} — ${record.state}`;
  const how = record.executor === 'native'
    ? `executor: native (${record.action}), exit ${record.exitCode ?? 'n/a'}`
    : `executor: ${record.model ?? 'model'}${record.effort ? ` (${record.effort})` : ''}, tier ${record.tier}`;

  const acceptance = (record.acceptance ?? []).length > 0
    ? ['', 'Critérios de aceite:', ...record.acceptance.map((entry) => `- ${entry.met ? 'OK' : 'NÃO ATENDIDO'}: ${entry.criterion}`
      + (entry.detail ? ` — ${entry.detail}` : ''))]
    : [];

  return [
    head,
    '',
    unit?.objective ? `Objetivo: ${unit.objective.split('\n')[0]}` : null,
    `${how} · ${record.attempts} tentativa(s)`
    + `${record.escalations ? ` · ${record.escalations} escalation(s)` : ''}`
    + `${record.contextExpansions ? ` · ${record.contextExpansions} expansão(ões) de contexto` : ''}`,
    record.changedFiles?.length
      ? `Arquivos alterados (${record.changedFiles.length}): ${record.changedFiles.slice(0, 15).join(', ')}`
      : 'Arquivos alterados: nenhum',
    record.unconfirmedFiles?.length
      ? `Declarados mas não confirmados pelo git: ${record.unconfirmedFiles.join(', ')}`
      : null,
    ...acceptance,
    '',
    record.report ? record.report.slice(0, 4000) : '(sem relatório)',
    '',
  ].filter((line) => line !== null).join('\n');
}
