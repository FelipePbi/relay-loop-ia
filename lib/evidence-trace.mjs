/**
 * IA Loop — what a blocker NAMED that this round did not touch.
 *
 * The problem, from Goal023 round 2. A correction round is handed the previous
 * review's blockers. It answered all six with `met: true` and specific,
 * TRUTHFUL detail — it really did build `inbox-retention.ts`, really did remove
 * `strictestCutoff`, really did add the env var. The reviewer then found three
 * of them unfinished: each blocker named one more thing, and the unit did the
 * main part and missed the detail. A whole round — an Opus correction unit and
 * a DEEP review — was spent discovering that, and it pushed the Goal to a third
 * round, one away from MAX_CORRECTION_ROUNDS_REACHED.
 *
 * So the check is NOT "did the unit tell the truth" — it did. And it is not
 * "did the round touch the blocker's files" — it did, for all six. It is:
 *
 *     which tokens does the blocker name that appear NOWHERE in what this
 *     round changed?
 *
 * Measured against that exact round before this was written. The absent lists
 * named `updatedBy` and `SchedulingClient.purgeNotificationIntentContent` —
 * two of the three items the reviewer went on to find unfinished. The third
 * was described in prose and named nothing, so nothing here could have caught
 * it. Four tokens across the other blockers were absent and harmless.
 *
 * That ratio is why this returns a LIST and never a verdict. A short list of
 * "look here first" survives false positives; a judgement does not. It is the
 * same shape as `goalGates`, which changed the reviewer's behaviour in four
 * consecutive Goals precisely because it states facts and concludes nothing.
 *
 * Pure: no store, no git, no clock.
 */

/** What the absent-token list amounts to for one item. */
export const TRACE_VERDICTS = Object.freeze({
  /** Everything it names appears somewhere in this round's changes. */
  ALL_PRESENT: 'ALL_PRESENT',
  /** It names things that appear nowhere. Information, not a verdict. */
  SOME_ABSENT: 'SOME_ABSENT',
  /** It names nothing checkable — prose about behaviour, copy or UX. */
  NO_CITATION: 'NO_CITATION',
});

/** Looks like a file path: has a separator and an extension. */
const PATH_LIKE = /^[\w./@-]+\/[\w./@-]+\.[a-z]{2,5}$/i;
/**
 * Looks like a symbol worth searching the diff for. Short words are noise.
 *
 * A leading `/` is allowed because routes are cited constantly and are exactly
 * the kind of artefact a blocker names — `GET /v1/settings/retention` must
 * yield the route, not nothing. Paths are caught by PATH_LIKE first.
 */
const SYMBOL_LIKE = /^[A-Za-z_$/][\w$.:/-]{3,}$/;

/**
 * Backticked tokens, split into paths and symbols.
 *
 * Only backticked text is read. Prose naming a file without marking it as code
 * is not a citation — treating it as one would search the diff for ordinary
 * words and report something for everything.
 */
export function extractCitations(text = '') {
  if (typeof text !== 'string' || text === '') return { paths: [], symbols: [] };

  const paths = new Set();
  const symbols = new Set();

  for (const match of text.matchAll(/`([^`\n]{2,200})`/g)) {
    const raw = match[1].trim();
    if (raw === '') continue;

    // `apps/bff/src/x.ts:1480-1487` — the line range is not part of the path.
    const withoutLines = raw.replace(/:\d+(?:[-–]\d+)?$/, '');

    if (PATH_LIKE.test(withoutLines)) {
      paths.add(withoutLines);
      continue;
    }

    // `apps/bff/src/retention/settings.ts:loadRetentionState` — a path and the
    // symbol inside it, which is TWO citations. Read as one, it becomes a
    // composite that exists nowhere and is absent from every diff by
    // construction: a false positive the tool manufactures itself.
    const qualified = /^(.+):([A-Za-z_$][\w$]*)$/.exec(withoutLines);
    if (qualified && PATH_LIKE.test(qualified[1])) {
      paths.add(qualified[1]);
      if (SYMBOL_LIKE.test(qualified[2])) symbols.add(qualified[2]);
      continue;
    }
    // `store.materialize`, `GET /v1/settings/retention`: keep the longest
    // identifier-ish part, which is what a diff would actually show.
    const candidate = withoutLines.split(/\s+/).filter((part) => SYMBOL_LIKE.test(part)).pop();
    if (candidate) symbols.add(candidate);
  }

  return { paths: [...paths], symbols: [...symbols] };
}

/** A path is present when the round touched it, or touched a file ending in it. */
const pathPresent = (cited, changedFiles) => changedFiles.some(
  (file) => file === cited || file.endsWith(`/${cited}`) || cited.endsWith(`/${file}`),
);

/**
 * The tokens one text names that appear nowhere in this round's changes.
 *
 * `diff` is searched as plain text on purpose: a symbol appearing anywhere —
 * added, removed, or in the context around a change — means the round went
 * near it. Absence is the signal; presence proves nothing about correctness.
 */
export function traceEvidence({ id, text }, { changedFiles = [], diff = '' } = {}) {
  const { paths, symbols } = extractCitations(text);

  const absent = [
    ...paths.filter((cited) => !pathPresent(cited, changedFiles)),
    ...symbols.filter((symbol) => !diff.includes(symbol)),
  ];
  const cited = paths.length + symbols.length;

  const verdict = cited === 0
    ? TRACE_VERDICTS.NO_CITATION
    : (absent.length > 0 ? TRACE_VERDICTS.SOME_ABSENT : TRACE_VERDICTS.ALL_PRESENT);

  return Object.freeze({
    id,
    verdict,
    cited,
    absent: Object.freeze(absent),
    // The opening words, so a reader knows which item this is.
    excerpt: String(text ?? '').replace(/\s+/g, ' ').slice(0, 180),
  });
}

/** Traces many texts, preserving order. Never throws on malformed input. */
export function traceAll(items = [], changes = {}) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && typeof item.text === 'string' && item.text.trim() !== '')
    .map((item) => traceEvidence(item, changes));
}

/**
 * The blockers of the previous round, as traceable items.
 *
 * They arrive as plain strings and are numbered from 1, which is how both the
 * review that wrote them and the unit that answered them refer to them.
 */
export function blockersAsItems(previousBlockers = []) {
  if (!Array.isArray(previousBlockers)) return [];
  return previousBlockers.map((blocker, index) => ({
    id: `Blocker ${index + 1}`,
    text: typeof blocker === 'string' ? blocker : JSON.stringify(blocker),
  }));
}

// ===========================================================================
// The Goal document's numbered items
// ===========================================================================

/**
 * The Goal's own numbered items, as written.
 *
 * Two lists, because the documents carry two and the blockers cite both:
 *   `### 6. Retenção técnica…` under `## Escopo obrigatório`  → §6
 *   `6. PATCH que aumente prazo não exige confirmação.` under
 *   `## Testes e critérios de aceite`                         → critério 6
 *
 * Returns [] for anything it cannot parse. A Goal document in an unexpected
 * shape must cost nothing: a parse failure is not a reason for a review not to
 * happen.
 */
export function extractGoalRequirements(goalText = '') {
  if (typeof goalText !== 'string' || goalText === '') return [];

  const requirements = [];
  // Line endings are normalised, not assumed. `\r` is a line TERMINATOR in
  // JavaScript regex, so `.` never matches it and every `(.+)$` below fails
  // silently on a CRLF file — returning zero requirements for a document full
  // of them. This repository is checked out with CRLF, and a fixture written
  // with LF passed while the real Goal document extracted nothing.
  const lines = goalText.replace(/\r\n?/g, '\n').split('\n');
  let section = null;

  for (const line of lines) {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      const title = heading[1].toLowerCase();
      if (/escopo obrigat/.test(title)) section = 'SCOPE';
      else if (/crit[ée]rio/.test(title)) section = 'CRITERION';
      else section = null;
      continue;
    }

    if (section === 'SCOPE') {
      const scope = /^###\s+(\d+)\.\s+(.+)$/.exec(line);
      if (scope) requirements.push({ kind: 'SCOPE', id: `§${scope[1]}`, text: scope[2].trim() });
      continue;
    }

    if (section === 'CRITERION') {
      const item = /^(\d+)\.\s+(.+)$/.exec(line);
      if (item) requirements.push({ kind: 'CRITERION', id: `critério ${item[1]}`, text: item[2].trim() });
    }
  }

  return requirements;
}

// ===========================================================================
// The summary line — a list of rows is exactly what gets skimmed
// ===========================================================================

/** One line about what the blockers named and this round did not touch. */
export function summarizeBlockerTrace(rows = []) {
  if (rows.length === 0) return 'Esta rodada não corrige blockers (não é rodada de correção).';

  const withAbsent = rows.filter((row) => row.verdict === TRACE_VERDICTS.SOME_ABSENT);
  const noCitation = rows.filter((row) => row.verdict === TRACE_VERDICTS.NO_CITATION).length;

  const parts = [`${rows.length} blocker(s) da rodada anterior:`];
  parts.push(`${rows.length - withAbsent.length - noCitation} com tudo o que citam presente no diff`);
  if (noCitation > 0) parts.push(`${noCitation} sem artefato citado para conferir`);
  if (withAbsent.length > 0) {
    parts.push(`**${withAbsent.length} citam algo que NÃO aparece nesta rodada**`);
  }

  return `${parts.join(' · ')}.${withAbsent.length > 0
    ? ' Ausência não prova blocker aberto — a correção pode estar sob outro nome, e alguns destes serão inofensivos. '
      + 'É a lista do que conferir primeiro antes de aceitar o relatório desta rodada.'
    : ''}`;
}
