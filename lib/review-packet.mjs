/**
 * IA Loop — review packet.
 *
 * Builds what the Tech Lead receives after a real implementation. Every fact in
 * it is collected by the orchestrator from git, not taken from the Developer's
 * own claims: the repository is the authority on what changed.
 *
 * The functional diff is measured against `worktreeInitialHead`, NOT against
 * `migrationAcceptedBaseline`. Between the accepted baseline and the execution
 * base there are legitimate commits (IA Loop tooling, the Goal document, the
 * Tech Lead handoff) that are not part of this Goal's implementation. Both
 * baselines travel in the packet so the reviewer can tell them apart.
 */

import { SpikeError } from './claude-process.mjs';
import { summarizeGoalGateStatus } from './goal-gate-status.mjs';
import { blockersAsItems, summarizeBlockerTrace, traceAll } from './evidence-trace.mjs';
import { summarizeCriteriaCoverage } from './criteria-coverage.mjs';

/** Diff kept inline in the packet; the full diff stays on disk. */
const INLINE_DIFF_LIMIT = 200_000;

export function buildReviewPacket({
  goal,
  goalPath,
  round,
  reviewLevel,
  migrationAcceptedBaseline,
  executionBase,
  worktreeInitialHead,
  worktreePath,
  changes,
  developerResult,
  previousBlockers = [],
  diffPath = null,
  developerProfile = null,
  /**
   * Every gate this Goal declared, and whether it has run in ANY round.
   *
   * `validations` below answers a round-shaped question and goes empty in a
   * correction round by construction — it declares no gates. The decision
   * being made is goal-shaped, so this is the field that answers it.
   */
  goalGates = [],
  /**
   * The cheap reading of the Goal's numbered items against this diff, or null
   * when it did not run. Null and "nothing missing" are different answers and
   * `summarizeCriteriaCoverage` keeps them apart.
   */
  criteriaCoverage = null,
  /** How many numbered items the Goal declares, so a partial answer shows as one. */
  criteriaDeclared = 0,
}) {
  if (!goal) throw new SpikeError('INVALID_ARGS', 'goal is required');
  if (!worktreeInitialHead) throw new SpikeError('INVALID_ARGS', 'worktreeInitialHead is required');
  if (!changes) throw new SpikeError('INVALID_ARGS', 'collected changes are required');

  const inlineDiff = changes.diff.length > INLINE_DIFF_LIMIT
    ? `${changes.diff.slice(0, INLINE_DIFF_LIMIT)}\n\n[diff truncado — leia o arquivo completo em ${diffPath ?? 'diff.patch'}]`
    : changes.diff;

  return Object.freeze({
    goal,
    goalPath,
    round,
    reviewLevel,

    // Two distinct concepts, never collapsed.
    migrationAcceptedBaseline,
    executionBase,
    worktreeInitialHead,
    baselineNote:
      'migrationAcceptedBaseline é o último Goal funcional aceito. worktreeInitialHead/executionBase '
      + 'é a base imediata desta implementação. O review funcional deve focar no diff '
      + 'worktreeInitialHead → estado atual da worktree, que é o que este Goal produziu.',

    worktreePath,

    // Collected from git by the orchestrator.
    changedFiles: Object.freeze([...changes.changedFiles]),
    untrackedFiles: Object.freeze([...changes.untracked]),
    diffStat: changes.diffStat,
    diff: inlineDiff,
    diffTruncated: changes.diffTruncated || changes.diff.length > INLINE_DIFF_LIMIT,
    diffPath,
    commitsInWorktree: Object.freeze([...changes.commits]),

    // Reported by the Developer. May point at evidence, never replaces it.
    implementationReport: developerResult?.implementationReport ?? '',
    developerSummary: developerResult?.summary ?? '',
    validations: Object.freeze([...(developerResult?.validations ?? [])]),
    validationsNote:
      'validations é o que o plano DESTA rodada verificou. Numa rodada de correção ele é '
      + 'vazio por construção, porque a rodada tem uma unidade só e não declara gate algum. '
      + 'Para saber se esta árvore foi verificada, leia goalGates.',

    // The goal-shaped answer, and the summary line so a list of NEVER_RAN
    // cannot be skimmed as "nothing to report".
    goalGates: Object.freeze(goalGates.map((row) => Object.freeze({ ...row }))),
    goalGatesSummary: summarizeGoalGateStatus(goalGates),

    // What the previous round's blockers NAMED that this round's diff does not
    // contain. Computed here from the packet's own diff, so it costs no call
    // and cannot disagree with what the reviewer is reading.
    //
    // Never fatal: a failure to trace is a missing convenience, not a reason
    // for the review not to happen.
    ...(() => {
      try {
        const rows = traceAll(blockersAsItems(previousBlockers), {
          changedFiles: changes.changedFiles ?? [],
          diff: changes.diff ?? '',
        });
        return {
          blockerTrace: Object.freeze(rows),
          blockerTraceSummary: summarizeBlockerTrace(rows),
        };
      } catch {
        return { blockerTrace: Object.freeze([]), blockerTraceSummary: '(não apurado)' };
      }
    })(),

    // The Goal's own numbered items, read against this diff before the review.
    // A fact next to the others; the reviewer still decides.
    criteriaCoverage: criteriaCoverage ? Object.freeze({ ...criteriaCoverage }) : null,
    criteriaCoverageSummary: summarizeCriteriaCoverage(criteriaCoverage, criteriaDeclared),

    developerResult,

    previousBlockers: Object.freeze([...previousBlockers]),

    // The profile this round ran on, so the reviewer decides an escalation
    // against what actually happened rather than against an assumption.
    developerProfile: developerProfile ?? null,

    // How the round was actually executed. Null for a legacy round — one
    // model, one call — and the DAG for a round executed as Work Units.
    //
    // Summarised, never replayed: the reviewer gets the shape of the
    // execution (which units, on what, how many attempts, what each one
    // touched) because that is evidence about the change. It does not get the
    // units' full reports or their contexts, which would put the whole round's
    // history back into the one call the decomposition was meant to keep small.
    workUnitExecution: developerResult?.workUnitExecution
      ? summarizeWorkUnitExecution(developerResult.workUnitExecution)
      : null,
  });
}

/** The DAG, compressed to what a reviewer needs to judge the change. */
function summarizeWorkUnitExecution(execution) {
  return Object.freeze({
    source: execution.source,
    levels: Object.freeze((execution.levels ?? []).map((level) => Object.freeze([...level]))),
    telemetry: execution.telemetry ?? null,
    units: Object.freeze((execution.units ?? []).map((unit) => Object.freeze({
      id: unit.id,
      type: unit.type,
      state: unit.state,
      executor: unit.executor,
      model: unit.model,
      effort: unit.effort,
      tier: unit.tier,
      attempts: unit.attempts,
      escalations: unit.escalations,
      contextExpansions: unit.contextExpansions,
      changedFiles: Object.freeze([...(unit.changedFiles ?? [])]),
    }))),
  });
}

/**
 * The DAG, for the reviewer's prompt.
 *
 * The review stays at Goal level: this is context for judging ONE change, not
 * an invitation to review each unit. What it lets the reviewer do is notice
 * things a flat diff hides — that a unit escalated twice, that a verification
 * had to be re-run after a fix, that a unit reported files git never saw.
 */
function renderWorkUnitExecution(execution) {
  const lines = [
    'Execução por Work Units (o review continua sendo do Goal inteiro, não por unidade):',
    `  origem do plano: ${execution.source}`,
  ];

  for (const unit of execution.units) {
    const how = unit.executor === 'native'
      ? 'native (sem modelo)'
      : `${unit.model ?? 'model'}${unit.effort ? ` ${unit.effort}` : ''} · tier ${unit.tier}`;
    lines.push(
      `  - ${unit.id} [${unit.type}] ${unit.state} — ${how}`
      + ` · ${unit.attempts} tentativa(s)`
      + `${unit.escalations ? ` · ${unit.escalations} escalation(s)` : ''}`
      + `${unit.contextExpansions ? ` · ${unit.contextExpansions} expansão(ões) de contexto` : ''}`
      + ` · ${unit.changedFiles.length} arquivo(s)`,
    );
  }

  if (execution.telemetry) {
    const calls = execution.telemetry.modelCalls ?? {};
    lines.push(
      `  chamadas: native ${calls.native ?? 0} · haiku ${calls.haiku ?? 0}`
      + ` · sonnet ${calls.sonnet ?? 0} · opus ${calls.opus ?? 0}`,
    );
  }

  lines.push('');
  return lines;
}

/**
 * Renders the packet for the reviewer prompt.
 *
 * The diff is handed over as a path to read rather than pasted whole when it is
 * large, so the reviewer inspects the real file.
 */
export function renderReviewPrompt(packet) {
  return [
    'Você está atuando como Tech Lead revisando a implementação real de um Goal do Atendly.',
    '',
    `Goal: ${packet.goal} — leia ${packet.goalPath}. Ele é a autorização e o critério.`,
    `Round: ${packet.round}. Review level: ${packet.reviewLevel}.`,
    '',
    'Baselines (não confunda as duas):',
    `- migrationAcceptedBaseline: ${packet.migrationAcceptedBaseline}`,
    `- worktreeInitialHead (base desta implementação): ${packet.worktreeInitialHead}`,
    packet.baselineNote,
    '',
    `Worktree sob review: ${packet.worktreePath}`,
    `Arquivos alterados (${packet.changedFiles.length}), coletados do git pelo orchestrator:`,
    packet.changedFiles.map((f) => `  - ${f}`).join('\n') || '  (nenhum)',
    '',
    'Diff stat:',
    packet.diffStat || '(vazio)',
    '',
    packet.diffPath
      ? `O diff completo está em ${packet.diffPath}. Leia-o e inspecione os arquivos alterados na worktree.`
      : 'Diff:',
    packet.diffPath ? '' : packet.diff,
    '',
    ...(packet.workUnitExecution ? renderWorkUnitExecution(packet.workUnitExecution) : []),
    'Relatório de implementação do Developer (evidência declarada, não substitui inspeção):',
    packet.implementationReport || '(vazio)',
    '',
    'Validações declaradas NESTA rodada:',
    JSON.stringify(packet.validations, null, 2),
    packet.validationsNote ?? '',
    '',
    // Above the blockers and above the review instructions on purpose: it is
    // the one fact that decides whether the rest is being judged against a
    // verified tree or against a read of the diff alone.
    // Next to the gates, because the two answer the same worry from opposite
    // sides: the gates say whether the tree was verified, this says whether the
    // Goal's own written items were addressed.
    'COBERTURA DOS ITENS NUMERADOS DO GOAL (leitura barata do diff, NÃO é a sua revisão):',
    packet.criteriaCoverageSummary ?? '(não apurado)',
    ...(packet.criteriaCoverage?.items ?? [])
      .filter((item) => item.verdict === 'NOT_COVERED')
      .map((item) => `  - ${item.id}: sem nada no diff${item.evidence ? ` — ${item.evidence}` : ''}`),
    '',
    'ESTADO DOS GATES DESTE GOAL (todas as rodadas):',
    packet.goalGatesSummary ?? '(não apurado)',
    ...(packet.goalGates?.length
      ? packet.goalGates.map((g) => `  - ${g.id} ${g.action}${g.scope ? ` @ ${g.scope}` : ''}: ${g.outcome}`
        + (g.round ? ` (rodada ${g.round}${g.roundsStale > 0 ? `, ${g.roundsStale} rodada(s) atrás` : ''})` : '')
        + (g.outcome === 'FAILED' && g.exitCode !== null ? ` exit ${g.exitCode}` : ''))
      : []),
    '',
    packet.previousBlockers.length > 0
      ? `Blockers da rodada anterior:\n${packet.previousBlockers.map((b) => `  - ${b}`).join('\n')}`
      : 'Blockers anteriores: nenhum (primeira rodada).',
    // Right under the blockers, because it is about them and about nothing
    // else. A correction round can answer every blocker `met: true` truthfully
    // and still have missed the one thing each blocker named last.
    ...(packet.blockerTrace?.length
      ? [
        '',
        'O QUE OS BLOCKERS CITAM E ESTA RODADA NÃO TOCOU:',
        packet.blockerTraceSummary ?? '(não apurado)',
        ...packet.blockerTrace
          .filter((row) => row.absent?.length > 0)
          .map((row) => `  - ${row.id}: ${row.absent.join(', ')}`),
      ]
      : []),
    '',
    'Faça um review DEEP dirigido, conforme o próprio Goal exige:',
    '- inspecione o diff real e os arquivos alterados;',
    '- abra callers/consumers diretamente relacionados quando necessário;',
    '- rode verificações dirigidas se precisar de evidência;',
    '- use Graphify seletivamente para confirmar impacto.',
    '',
    'NÃO repita a auditoria global do Goal0, não leia o Product Vault inteiro, não faça discovery global',
    'e NÃO edite nenhum arquivo: você é read-only nesta etapa.',
    '',
    'Retorne exclusivamente o JSON do contrato ReviewDecision.',
    'Em CHANGES_REQUIRED, cada blocker deve ser específico e acionável.',
    '',
    // Routing rides on THIS call. There is no separate selection inference and
    // no automatic promotion by round number: either the Tech Lead says so
    // here, or the Goal keeps the profile it is already running on.
    `Perfil de execução do Developer nesta rodada: ${packet.developerProfile ?? 'SONNET_MEDIUM'}.`,
    'Em CHANGES_REQUIRED, você PODE definir nextDeveloperProfile para a próxima rodada de correção:',
    '- SONNET_MEDIUM: correção localizada, arquitetura já definida, risco baixo/médio;',
    '- OPUS_MEDIUM: multi-serviço, contrato relevante, domínio complexo, migration, concorrência;',
    '- OPUS_HIGH: segurança, auth/sessão, isolamento de tenant, dado crítico, race condition,',
    '  consistência distribuída, mudança arquitetural, alto custo de erro.',
    'Omita o campo para manter o perfil vigente. nextDeveloperProfileReason: no máximo uma frase curta.',
  ].join('\n');
}
