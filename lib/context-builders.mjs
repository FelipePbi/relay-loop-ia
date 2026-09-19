/**
 * IA Loop — explicit context packages for each agent.
 *
 * The two builders are asymmetric on purpose, mirroring the session strategies
 * proven in Spike 1:
 *
 * - The Developer (Opus 5) is stateless. Everything it needs must be in the
 *   package, and the package must never contain a previous Opus conversation.
 *   It gets pointers and is expected to consult Graphify, the Product Vault and
 *   the code selectively, following the project's own rules.
 *
 * - The Tech Lead (Fable 5.1) has a persistent session, but the repository
 *   stays the authority. Its session provides recent continuity, not a system
 *   of record, so every ReviewJob restates the facts.
 */

import { SpikeError } from './claude-process.mjs';

function fail(code, message) {
  throw new SpikeError(code, message);
}

/**
 * Builds the Developer package.
 *
 * Deliberately NOT included: any prior Opus conversation, transcript or hidden
 * state. Re-injecting a full history is exactly what Spike 1 showed to be
 * unsupported, and it would also make the run unauditable.
 */
export function buildDeveloperContext({
  goal,
  round,
  type,
  migrationAcceptedBaseline,
  executionBase,
  worktree,
  goalPath,
  blockers = [],
  previousImplementationReport = null,
}) {
  if (!goal) fail('INVALID_ARGS', 'goal is required');
  if (!Number.isInteger(round) || round < 1) fail('INVALID_ARGS', 'round must be an integer >= 1');
  if (type === 'CORRECTION' && blockers.length === 0) {
    fail('INVALID_ARGS', 'A CORRECTION context must carry the blockers to address');
  }

  const context = {
    role: 'developer',
    goal,
    goalPath,
    round,
    type,
    // Two distinct baselines, never collapsed into one.
    migrationAcceptedBaseline,
    executionBase,
    worktree,
    mustRead: [
      'CLAUDE.md',
      'AGENTS.md',
      goalPath,
    ],
    consultSelectively: [
      'graphify query "<pergunta>" --budget 800 para call paths e impacto',
      'docs/product-vault/ para regra de negócio, sob demanda',
      'docs/architecture/ e AGENTS.md dos apps tocados',
    ],
    blockers: [...blockers],
  };

  // The previous report is only relevant when fixing something, and even then
  // it is a summary produced by the harness, not a replayed conversation.
  if (type === 'CORRECTION' && previousImplementationReport) {
    context.previousImplementationReport = previousImplementationReport;
  }

  return Object.freeze(context);
}

/**
 * Builds the Tech Lead review package.
 *
 * Carries the real change surface so the reviewer never has to rely on its own
 * memory for facts it can be told.
 */
export function buildTechLeadContext({
  goal,
  round,
  reviewLevel,
  migrationAcceptedBaseline,
  executionBase,
  worktree,
  goalPath,
  changedFiles = [],
  diffStat = null,
  implementationReport,
  validations = [],
  previousBlockers = [],
  graphOrientation = null,
}) {
  if (!goal) fail('INVALID_ARGS', 'goal is required');
  if (!Number.isInteger(round) || round < 1) fail('INVALID_ARGS', 'round must be an integer >= 1');
  if (!implementationReport) fail('INVALID_ARGS', 'implementationReport is required');

  return Object.freeze({
    role: 'tech_lead',
    goal,
    goalPath,
    round,
    reviewLevel,
    migrationAcceptedBaseline,
    executionBase,
    worktree,
    changedFiles: [...changedFiles],
    diffStat,
    implementationReport,
    validations: [...validations],
    previousBlockers: [...previousBlockers],

    // What the changed files reach, answered from the graph before the review
    // starts. A reviewer that has to grep for blast radius spends its budget
    // rediscovering the map instead of judging the diff.
    graphOrientation,

    mustRead: ['AGENTS.md', goalPath],
    note: 'O repositório é a autoridade. A sessão persistente serve para continuidade recente, não como registro oficial.',
  });
}

/**
 * Builds the package for a correction round.
 *
 * The scope is the reviewer's blockers, NOT the Goal as a whole. The
 * implementation from the previous round stays in the worktree and must be
 * preserved: a correction is a targeted fix, not a reimplementation.
 *
 * The original baselines travel unchanged, so the functional diff keeps being
 * measured against the commit the work actually started from.
 */
export function buildCorrectionContext({
  goal,
  goalPath,
  round,
  previousRound,
  migrationAcceptedBaseline,
  executionBase,
  worktreeInitialHead,
  worktree,
  blockers,
  previousImplementationReport,
  previousDecision,
  changedFiles = [],
}) {
  if (!goal) fail('INVALID_ARGS', 'goal is required');
  if (!Number.isInteger(round) || round < 2) {
    fail('INVALID_ARGS', 'a correction round is always >= 2');
  }
  if (!Array.isArray(blockers) || blockers.length === 0) {
    fail('INVALID_ARGS', 'a correction round requires the blockers it must address');
  }

  return Object.freeze({
    role: 'developer',
    type: 'CORRECTION',
    goal,
    goalPath,
    round,
    previousRound,

    // Unchanged across rounds, on purpose.
    migrationAcceptedBaseline,
    executionBase,
    worktreeInitialHead,
    worktree,

    // The authority for this round.
    blockers: [...blockers],
    previousDecision,
    previousImplementationReport,
    // Collected from git by the orchestrator, not claimed by the model.
    changedFiles: [...changedFiles],

    mustRead: ['CLAUDE.md', 'AGENTS.md', goalPath],
    consultSelectively: [
      'graphify query "<pergunta>" --budget 800 para confirmar impacto das correções',
      'os arquivos realmente alterados, listados em changedFiles',
    ],
    scope:
      'Corrigir SOMENTE os blockers listados. Preservar o que já foi aceito. '
      + 'Não reverter nem reimplementar partes sem relação com os blockers.',
  });
}
