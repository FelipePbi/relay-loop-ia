/**
 * IA Loop — normalizing one ledger row's auxiliary model usage.
 *
 * `auxiliary_usage_json` holds whatever usage-normalizer.mjs's `selectUsage`
 * put there: an array of per-model token entries for every model the CLI
 * reported usage for besides the one the call was routed to (a Haiku helper
 * spawned inside an Opus review, for instance — see usage-normalizer.mjs).
 * This module never touches the ledger, the CLI or a clock. It takes that
 * stored value, exactly as read off a row, and turns it into per-model totals
 * a report can sum across many rows.
 *
 * Absence is never zero: a row with no auxiliary calls at all reports null
 * totals, not zero ones, because "there was nothing to add" and "we counted
 * and it came to nothing" are different facts — the same principle the Goal
 * applies to provider cost.
 */

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Sums only the values that are actually there; null when none are. */
export function sumDefined(values) {
  const present = values.filter((value) => value !== null && value !== undefined);
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0);
}

const TOKEN_FIELDS = Object.freeze(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens']);

const EMPTY_RESULT = Object.freeze({
  byModel: Object.freeze({}), totalTokens: null, costUsd: null, flags: Object.freeze([]),
});

/**
 * Parses whatever is stored under `auxiliary_usage_json`, never throwing.
 *
 * Accepts the ledger's own shape (a JSON string), an already-parsed array (a
 * caller that read the row and parsed it once), and null/undefined/empty
 * (no auxiliary usage — never itself an error). Anything else — a legacy or
 * corrupt payload — is flagged rather than thrown on.
 */
function parsePayload(raw) {
  if (raw === null || raw === undefined) return { entries: [], flags: [] };
  if (Array.isArray(raw)) return { entries: raw, flags: [] };
  if (typeof raw !== 'string') return { entries: [], flags: ['AUXILIARY_USAGE_INVALID'] };
  if (raw.trim() === '') return { entries: [], flags: [] };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { entries: [], flags: ['AUXILIARY_USAGE_INVALID'] };
  }
  if (!Array.isArray(parsed)) return { entries: [], flags: ['AUXILIARY_USAGE_INVALID'] };
  return { entries: parsed, flags: [] };
}

/** One entry's token counts. An absent field is 0, matching the collector's own convention. */
function readCounts(entry, flags) {
  const counts = {};
  let negative = false;
  for (const field of TOKEN_FIELDS) {
    const value = entry[field];
    if (value === null || value === undefined) {
      counts[field] = 0;
    } else if (!isFiniteNumber(value)) {
      flags.push('AUXILIARY_USAGE_INVALID');
      counts[field] = 0;
    } else {
      if (value < 0) negative = true;
      counts[field] = value;
    }
  }
  if (negative) flags.push('AUXILIARY_NEGATIVE_COUNT');
  return counts;
}

/**
 * Normalizes one row's `auxiliary_usage_json` into a byModel breakdown.
 *
 * Zero, one or many auxiliary models are all valid input. Two entries naming
 * the SAME model within one row are summed rather than one overwriting the
 * other — the shape the collector writes today never produces this (see
 * `selectUsage` in usage-normalizer.mjs, keyed by `Object.entries`), but a
 * legacy or future payload doing so must still add up rather than silently
 * lose one entry.
 */
export function normalizeAuxiliaryUsage(raw) {
  const { entries, flags: parseFlags } = parsePayload(raw);
  if (entries.length === 0) return { ...EMPTY_RESULT, flags: parseFlags };

  const flags = [...parseFlags];
  const byModel = {};
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.model !== 'string' || entry.model === '') {
      flags.push('AUXILIARY_USAGE_INVALID');
      continue;
    }
    const counts = readCounts(entry, flags);
    const totalTokens = TOKEN_FIELDS.reduce((sum, field) => sum + counts[field], 0);
    const costUsd = isFiniteNumber(entry.costUsd) ? entry.costUsd : null;

    const existing = byModel[entry.model];
    if (!existing) {
      byModel[entry.model] = { ...counts, totalTokens, costUsd };
    } else {
      for (const field of TOKEN_FIELDS) existing[field] += counts[field];
      existing.totalTokens += totalTokens;
      existing.costUsd = sumDefined([existing.costUsd, costUsd]);
    }
  }

  const models = Object.values(byModel);
  if (models.length === 0) return { byModel: {}, totalTokens: null, costUsd: null, flags: [...new Set(flags)] };

  return {
    byModel,
    totalTokens: models.reduce((sum, model) => sum + model.totalTokens, 0),
    costUsd: sumDefined(models.map((model) => model.costUsd)),
    flags: [...new Set(flags)],
  };
}
