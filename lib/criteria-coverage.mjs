/**
 * IA Loop — the Goal's own numbered items, judged against the diff, cheaply.
 *
 * Eleven of the eighteen blockers across Goals 020–023 are one shape: a
 * numbered criterion or a `§N` scope section the Goal document declares and
 * the diff does not deliver, or documentation claiming one is met when it is
 * not. The Goal document is a written specification with numbered items —
 * Goal023 carries sixty-four of them — and nothing cross-checked it against
 * the diff before a DEEP review in Opus was spent finding the gaps by reading.
 *
 * Why a model call and not a matcher. This was tried deterministically first
 * and the attempt is worth recording: tracing the artefacts a criterion names
 * against the diff flagged NOTHING on Goal023 round 1, where six criteria were
 * genuinely unmet. Forty-two of the sixty-four items name no artefact at all —
 * they are sentences about behaviour, copy and UX. Coverage is a judgement,
 * and a matcher that returns zero signal is worse than no field: it teaches
 * the reviewer to skip it.
 *
 * Why it is cheap. The question is narrow and mechanical — for each numbered
 * item, is there evidence in this diff — so it runs on the standard model, not
 * on the reviewer's tier. It costs a fraction of the round it is meant to save.
 *
 * What it is NOT. It does not decide and it does not gate. Its verdicts reach
 * the reviewer as one more fact next to `goalGates` and the blocker trace, and
 * the reviewer remains the one who accepts or refuses. Routing NOT_COVERED
 * items straight into a correction round would be the right next step ONLY
 * once this call's precision is known on real Goals; assuming it now would
 * repeat a mistake this harness has already paid for.
 */

import { SpikeError } from './claude-process.mjs';
import { PROTOCOL_VERSION_V2 } from './contracts-v2.mjs';

const fail = (code, message, details) => { throw new SpikeError(code, message, details); };

/** What the assessment may say about one numbered item. */
export const COVERAGE_VERDICTS = Object.freeze({
  /** The diff contains work that addresses it, and the evidence says where. */
  COVERED: 'COVERED',
  /** The diff contains nothing that addresses it. */
  NOT_COVERED: 'NOT_COVERED',
  /**
   * Cannot be told from the diff alone — it is about runtime behaviour, or
   * about something outside what a diff shows. Deliberately NOT a third way of
   * saying NOT_COVERED: a forced binary would turn every behavioural criterion
   * into a false alarm, and the alarms are what make a field worth reading.
   */
  UNCLEAR: 'UNCLEAR',
});

/** How many items go in one call, so a 64-item Goal stays one prompt. */
export const MAX_ITEMS = 120;

/**
 * The prompt. States the question, the vocabulary, and the one thing that
 * matters most: that guessing NOT_COVERED is worse than answering UNCLEAR.
 */
export function buildCriteriaCoveragePrompt({ goal, requirements, diffStat, diff, changedFiles = [] }) {
  const items = requirements.slice(0, MAX_ITEMS);

  return [
    `Você avalia COBERTURA do Goal ${goal}: para cada item numerado do documento do Goal,`,
    'diga se o diff desta rodada contém trabalho que o endereça.',
    '',
    'Esta NÃO é a revisão. Você não aprova, não recusa e não julga qualidade.',
    'Você responde uma pergunta só, item a item, e aponta onde está a evidência.',
    '',
    'Vocabulário:',
    '  COVERED     — o diff tem trabalho que endereça o item; cite arquivo ou símbolo.',
    '  NOT_COVERED — o diff não tem nada que o endereça.',
    '  UNCLEAR     — não dá para dizer só pelo diff (comportamento em execução, cópia, UX).',
    '',
    'IMPORTANTE: na dúvida responda UNCLEAR, nunca NOT_COVERED.',
    'Um NOT_COVERED errado gasta uma rodada inteira de correção atrás de nada,',
    'e ensina quem lê a ignorar este campo. UNCLEAR é uma resposta honesta e barata.',
    '',
    `Arquivos alterados nesta rodada (${changedFiles.length}):`,
    changedFiles.slice(0, 200).map((file) => `  - ${file}`).join('\n'),
    '',
    'Diffstat:',
    diffStat ?? '(ausente)',
    '',
    `ITENS NUMERADOS DO GOAL (${items.length}):`,
    ...items.map((item) => `  [${item.id}] ${item.text}`),
    '',
    'DIFF:',
    diff ?? '(ausente)',
  ].join('\n');
}

/** The JSON shape the call must answer in. */
export function criteriaCoverageSchemaFor({ jobId, goal }) {
  return {
    type: 'object',
    properties: {
      protocolVersion: { type: 'integer', enum: [PROTOCOL_VERSION_V2] },
      jobId: { type: 'string', enum: [jobId] },
      goal: { type: 'string', enum: [goal] },
      summary: { type: 'string' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            verdict: { type: 'string', enum: Object.values(COVERAGE_VERDICTS) },
            evidence: { type: 'string' },
          },
          required: ['id', 'verdict'],
          additionalProperties: false,
        },
      },
    },
    required: ['protocolVersion', 'jobId', 'goal', 'summary', 'items'],
    additionalProperties: false,
  };
}

/**
 * Validates the answer.
 *
 * Strict about shape and deliberately permissive about completeness: an
 * assessment that answered some of the items is still worth having, and
 * refusing it would turn a convenience into an outage on the review path.
 * How many it answered is reported, so a short answer cannot read as a clean one.
 */
export function validateCriteriaCoverage(payload, { jobId, goal }) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('CONTRACT_FIELD_INVALID', 'CriteriaCoverage is not a JSON object');
  }
  if (payload.protocolVersion !== PROTOCOL_VERSION_V2) {
    fail('UNSUPPORTED_PROTOCOL_VERSION', `Expected protocolVersion ${PROTOCOL_VERSION_V2}`);
  }
  if (payload.jobId !== jobId) fail('JOB_ID_MISMATCH', `Expected jobId "${jobId}"`);
  if (payload.goal !== goal) fail('GOAL_MISMATCH', `Expected goal "${goal}"`);
  if (typeof payload.summary !== 'string' || payload.summary.trim() === '') {
    fail('CONTRACT_FIELD_INVALID', 'Field "summary" must be a non-empty string');
  }
  if (!Array.isArray(payload.items)) {
    fail('CONTRACT_FIELD_INVALID', 'Field "items" must be an array');
  }

  const items = payload.items.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      fail('CONTRACT_FIELD_INVALID', 'Each coverage item must be an object');
    }
    if (typeof entry.id !== 'string' || entry.id.trim() === '') {
      fail('CONTRACT_FIELD_INVALID', 'Field "items[].id" must be a non-empty string');
    }
    if (!Object.values(COVERAGE_VERDICTS).includes(entry.verdict)) {
      fail('CONTRACT_FIELD_INVALID', `Verdict ${JSON.stringify(entry.verdict)} is not allowed`);
    }
    return Object.freeze({
      id: entry.id,
      verdict: entry.verdict,
      evidence: typeof entry.evidence === 'string' ? entry.evidence.slice(0, 400) : null,
    });
  });

  return Object.freeze({ ...payload, items: Object.freeze(items) });
}

/**
 * One line the reviewer cannot read as "nothing to report".
 *
 * `answered` is stated against `declared` because a call that answered six of
 * sixty-four items and found nothing missing must not look like a Goal with
 * nothing missing.
 */
export function summarizeCriteriaCoverage(coverage, declared = 0) {
  if (!coverage) return 'Cobertura de critérios não apurada nesta rodada.';

  const items = coverage.items ?? [];
  const notCovered = items.filter((item) => item.verdict === COVERAGE_VERDICTS.NOT_COVERED);
  const unclear = items.filter((item) => item.verdict === COVERAGE_VERDICTS.UNCLEAR).length;
  const covered = items.filter((item) => item.verdict === COVERAGE_VERDICTS.COVERED).length;

  const parts = [`${items.length} de ${declared} item(ns) numerado(s) avaliados:`];
  parts.push(`${covered} com trabalho no diff`);
  if (unclear > 0) parts.push(`${unclear} que o diff não decide (comportamento, cópia, UX)`);
  if (notCovered.length > 0) {
    parts.push(`**${notCovered.length} SEM nada no diff: ${notCovered.map((item) => item.id).join(', ')}**`);
  }
  if (items.length < declared) {
    parts.push(`**${declared - items.length} não respondido(s) — ausência de resposta não é cobertura**`);
  }

  return `${parts.join(' · ')}.${notCovered.length > 0
    ? ' Isto é uma leitura barata do diff, não a sua revisão: confirme antes de transformar em blocker.'
    : ''}`;
}
