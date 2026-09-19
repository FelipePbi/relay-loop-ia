/**
 * IA Loop — agent definitions and prompt construction (V1).
 *
 * Two fixed roles, each pinned to a model family. Prompt building lives here so
 * the orchestrator stays free of any semantic interpretation: it builds input,
 * calls, validates, and records.
 */

import { invokeAgent } from './claude-process.mjs';
import {
  DEVELOPER_SCHEMA,
  PROTOCOL_VERSION,
  REVIEWER_SCHEMA,
  REVIEW_DECISIONS,
  validateDeveloperResult,
  validateReviewDecision,
} from './contracts.mjs';

export const DEVELOPER_MODEL = process.env.IA_LOOP_DEVELOPER_MODEL ?? 'claude-opus-5';
export const TECH_LEAD_MODEL = process.env.IA_LOOP_TECH_LEAD_MODEL ?? 'claude-fable-5-1';

const DEVELOPER_FAMILY = 'opus';
const TECH_LEAD_FAMILY = 'fable';

export function buildDeveloperPrompt({ taskId, taskDescription }) {
  return [
    'Você está atuando como Developer em um pipeline automatizado.',
    'Não execute ferramentas, não escreva arquivos e não acesse repositório algum.',
    '',
    `taskId: ${taskId}`,
    '',
    'Tarefa:',
    taskDescription,
    '',
    'Retorne exclusivamente um JSON com exatamente estes campos:',
    `- protocolVersion: ${PROTOCOL_VERSION}`,
    '- role: "developer"',
    `- taskId: "${taskId}"`,
    '- status: "REVIEW_REQUIRED"',
    '- summary: uma frase curta descrevendo o que você concluiu',
    '- evidence: lista com 1 a 3 strings curtas justificando a conclusão',
    '',
    'Nenhum texto fora do JSON.',
  ].join('\n');
}

export function buildReviewerPrompt({ reviewRequest }) {
  return [
    'Você está atuando como Tech Lead revisando o resultado de um Developer.',
    'Não execute ferramentas, não escreva arquivos e não acesse repositório algum.',
    '',
    `taskId: ${reviewRequest.taskId}`,
    '',
    'Tarefa original:',
    reviewRequest.taskDescription,
    '',
    'Resultado estruturado do Developer:',
    JSON.stringify(reviewRequest.developerResult, null, 2),
    '',
    'Avalie se o resultado do Developer é coerente com a tarefa original.',
    '',
    'Retorne exclusivamente um JSON com exatamente estes campos:',
    `- protocolVersion: ${PROTOCOL_VERSION}`,
    '- role: "tech_lead"',
    `- taskId: "${reviewRequest.taskId}"`,
    `- decision: um de ${REVIEW_DECISIONS.map((d) => `"${d}"`).join(', ')}`,
    '- blockers: lista de strings; vazia se ACCEPTED, com pelo menos um item se CHANGES_REQUIRED',
    '- nextAction: "STOP" se ACCEPTED, "RETURN_TO_DEVELOPER" se CHANGES_REQUIRED, "HUMAN_REQUIRED" se HUMAN_REQUIRED',
    '',
    'Nenhum texto fora do JSON.',
  ].join('\n');
}

/**
 * Runs the Developer agent. Every isolation guarantee from Spike 0 is inherited
 * from invokeAgent/buildArgs: no tools, safe mode, no MCP, fresh session id, no
 * persistence, and a temp working directory chosen by the caller.
 */
export function runDeveloper({ executable, taskId, taskDescription, cwd, timeoutMs }) {
  return invokeAgent({
    executable,
    model: DEVELOPER_MODEL,
    expectedFamily: DEVELOPER_FAMILY,
    expectedRole: 'developer',
    prompt: buildDeveloperPrompt({ taskId, taskDescription }),
    jsonSchema: DEVELOPER_SCHEMA,
    validatePayload: (payload) => validateDeveloperResult(payload, { taskId }),
    cwd,
    timeoutMs,
  });
}

/**
 * Runs the Tech Lead agent in its own process and session. It receives the
 * Developer's output only through the review request the orchestrator built —
 * there is no shared conversation and no session resume between models.
 */
export function runTechLead({ executable, reviewRequest, cwd, timeoutMs }) {
  return invokeAgent({
    executable,
    model: TECH_LEAD_MODEL,
    expectedFamily: TECH_LEAD_FAMILY,
    expectedRole: 'tech_lead',
    prompt: buildReviewerPrompt({ reviewRequest }),
    jsonSchema: REVIEWER_SCHEMA,
    validatePayload: (payload) => validateReviewDecision(payload, { taskId: reviewRequest.taskId }),
    cwd,
    timeoutMs,
  });
}
