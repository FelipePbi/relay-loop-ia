/**
 * IA Loop — Developer execution profiles.
 *
 * The Developer is no longer a fixed model. For each Goal, and for each
 * correction round, the Tech Lead states which profile the work needs. That
 * choice rides on an inference the cycle ALREADY performs (the planning call
 * that writes the next Goal, and the review call that decides the round), so
 * routing costs no extra model call.
 *
 * Three rules make this safe:
 *
 *   1. The registry is closed. An unknown name is an error, never a guess —
 *      the CLI silently ignores an unknown `--effort`, so validating here is
 *      what stops a typo from quietly downgrading the run.
 *   2. There is no fallback. If the selected model is unavailable the run stops
 *      for a human; it never lands on a different model.
 *   3. A choice is part of the attempt's identity. Recovery, restart and a
 *      capacity wait re-read it; they never recompute it.
 */

import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { CLI_EFFORT_LEVELS, SpikeError } from './claude-process.mjs';

/**
 * Effort levels the installed Claude CLI accepts.
 *
 * Re-exported, not redeclared: the argument layer owns what the CLI accepts,
 * and two copies of that list is exactly how a profile ends up declaring an
 * effort the CLI silently ignores.
 */
export { CLI_EFFORT_LEVELS };

/**
 * The profiles the Tech Lead may choose from.
 *
 * `family` is what the fallback detector matches the resolved primary model
 * against; it is not decoration.
 */
export const DEVELOPER_PROFILES = Object.freeze({
  SONNET_MEDIUM: Object.freeze({
    name: 'SONNET_MEDIUM',
    model: 'claude-sonnet-5',
    effort: 'medium',
    family: 'sonnet',
    label: 'Claude Sonnet 5',
    effortLabel: 'Medium',
    selectable: true,
  }),
  /**
   * The default under adaptive routing: Sonnet is the standard executor, and
   * `high` is what it gets, because the point is to give it a real chance to
   * finish the work rather than to hand the first difficulty to Opus.
   */
  SONNET_HIGH: Object.freeze({
    name: 'SONNET_HIGH',
    model: 'claude-sonnet-5',
    effort: 'high',
    family: 'sonnet',
    label: 'Claude Sonnet 5',
    effortLabel: 'High',
    selectable: true,
  }),
  OPUS_MEDIUM: Object.freeze({
    name: 'OPUS_MEDIUM',
    model: 'claude-opus-5',
    effort: 'medium',
    family: 'opus',
    label: 'Claude Opus 5',
    effortLabel: 'Medium',
    selectable: true,
  }),
  OPUS_HIGH: Object.freeze({
    name: 'OPUS_HIGH',
    model: 'claude-opus-5',
    effort: 'high',
    family: 'opus',
    label: 'Claude Opus 5',
    effortLabel: 'High',
    selectable: true,
  }),
  /**
   * Deep escalation only: an Opus attempt that itself hit something
   * exceptional. Never a first answer, and never `max` — that stays a human's
   * decision, not the router's.
   */
  OPUS_XHIGH: Object.freeze({
    name: 'OPUS_XHIGH',
    model: 'claude-opus-5',
    effort: 'xhigh',
    family: 'opus',
    label: 'Claude Opus 5',
    effortLabel: 'XHigh',
    selectable: true,
  }),

  /**
   * Compatibility only, and never selectable.
   *
   * A Goal that started before routing existed ran on Opus with the CLI's
   * default effort and NO `--effort` flag at all. Adopting it keeps such an
   * execution byte-identical to how it began, instead of rewriting its history
   * into one of the new profiles.
   */
  LEGACY_OPUS: Object.freeze({
    name: 'LEGACY_OPUS',
    model: 'claude-opus-5',
    effort: null,
    family: 'opus',
    label: 'Claude Opus 5',
    effortLabel: 'CLI default',
    selectable: false,
  }),
});

/** What the Tech Lead is allowed to name. LEGACY_OPUS is deliberately absent. */
export const SELECTABLE_DEVELOPER_PROFILES = Object.freeze(
  Object.values(DEVELOPER_PROFILES).filter((p) => p.selectable).map((p) => p.name),
);

export const DEVELOPER_PROFILE_NAMES = Object.freeze(Object.keys(DEVELOPER_PROFILES));

/**
 * The profile a new Goal gets when nobody said otherwise.
 *
 * Sonnet, not Opus: the point of routing is to stop paying Opus for work that
 * does not need it. Under adaptive routing this is also the ONLY way a
 * Developer round starts — the Tech Lead's planning choice no longer promotes
 * it, because a Goal that was architecturally hard to PLAN is often ordinary to
 * EXECUTE once the plan exists. Opus arrives through escalation, on evidence.
 */
export const DEFAULT_DEVELOPER_PROFILE = 'SONNET_HIGH';

export const LEGACY_DEVELOPER_PROFILE = 'LEGACY_OPUS';

function fail(code, message, details = {}) {
  throw new SpikeError(code, message, details);
}

/** Resolves a profile by name. Fails closed: an unknown name is never guessed. */
export function resolveDeveloperProfile(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    fail('UNKNOWN_DEVELOPER_PROFILE', `Developer profile must be a non-empty string, got ${JSON.stringify(name)}`);
  }
  const profile = DEVELOPER_PROFILES[name.trim()];
  if (!profile) {
    fail(
      'UNKNOWN_DEVELOPER_PROFILE',
      `Unknown Developer profile ${JSON.stringify(name)} (known: ${DEVELOPER_PROFILE_NAMES.join(', ')})`,
      { name, known: DEVELOPER_PROFILE_NAMES },
    );
  }
  if (profile.effort !== null && !CLI_EFFORT_LEVELS.includes(profile.effort)) {
    fail('UNSUPPORTED_EFFORT', `Profile ${profile.name} declares effort "${profile.effort}", which this CLI does not accept`);
  }
  return profile;
}

/**
 * The profile that names a (model, effort) pair.
 *
 * The bridge between the router — which decides in models and efforts — and
 * the job contract, which speaks profile names. One registry, two vocabularies,
 * no second table to drift.
 */
export function profileForModel({ model, effort }) {
  const match = Object.values(DEVELOPER_PROFILES)
    .find((p) => p.selectable && p.model === model && p.effort === effort);
  if (!match) {
    fail(
      'UNKNOWN_DEVELOPER_PROFILE',
      `No Developer profile declares model ${JSON.stringify(model)} at effort ${JSON.stringify(effort)}`,
      { model, effort },
    );
  }
  return match;
}

/** Resolves a name that may be absent, falling back to the default. */
export function developerProfileOrDefault(name, fallback = DEFAULT_DEVELOPER_PROFILE) {
  if (name === null || name === undefined || name === '') return resolveDeveloperProfile(fallback);
  return resolveDeveloperProfile(name);
}

/** Validates a name the Tech Lead proposed. LEGACY_OPUS is refused here. */
export function assertSelectableProfile(name, what = 'developerProfile') {
  const profile = resolveDeveloperProfile(name);
  if (!profile.selectable) {
    fail(
      'UNKNOWN_DEVELOPER_PROFILE',
      `${what} ${JSON.stringify(name)} is a compatibility profile and cannot be selected (allowed: ${SELECTABLE_DEVELOPER_PROFILES.join(', ')})`,
      { name, allowed: SELECTABLE_DEVELOPER_PROFILES },
    );
  }
  return profile;
}

/**
 * Proves the model that actually served the call is the one the profile asked
 * for. Any divergence is a fallback, and a fallback is a failure here.
 */
export function assertProfileWasHonoured({ profile, resolvedPrimaryModel }) {
  const known = resolveDeveloperProfile(typeof profile === 'string' ? profile : profile?.name);
  if (resolvedPrimaryModel === null || resolvedPrimaryModel === undefined) {
    fail(
      'RESOLVED_MODEL_UNKNOWN',
      `CLI did not report which model served profile ${known.name}, so a silent fallback cannot be ruled out`,
      { profile: known.name },
    );
  }
  if (!String(resolvedPrimaryModel).toLowerCase().includes(known.family)) {
    fail(
      'MODEL_FALLBACK_DETECTED',
      `Profile ${known.name} requires the "${known.family}" family but the main inference came from "${resolvedPrimaryModel}"`,
      { profile: known.name, expectedFamily: known.family, resolvedPrimaryModel },
    );
  }
  return resolvedPrimaryModel;
}

/** A one-line description for a terminal or a status screen. */
export function describeProfile(name) {
  const profile = resolveDeveloperProfile(name);
  return `${profile.name} · ${profile.label} · effort ${profile.effortLabel}`;
}

/**
 * A durable Goal → profile handoff.
 *
 * The planning call that writes the next Goal is where the Tech Lead states the
 * profile, but the Goal itself is only executed later, by a different process.
 * A tiny store carries the choice across that gap so it survives a restart, and
 * so nothing has to re-derive it from prose.
 */
export function createDeveloperProfileStore(stateDir) {
  const path = join(stateDir, 'developer-profiles.json');

  async function readAll() {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw new SpikeError('FILE_UNREADABLE', `Cannot read ${path}: ${error.message}`);
    }
  }

  return {
    path,

    async read(goalId) {
      const all = await readAll();
      return all[goalId] ?? null;
    },

    /** Records the Tech Lead's choice for a Goal that has not started yet. */
    async write(goalId, { profile, reason = null, selectedBy = 'tech_lead', stage = null }) {
      assertSelectableProfile(profile, 'developerProfile');
      const all = await readAll();
      const record = {
        goal: goalId,
        profile,
        reason: typeof reason === 'string' ? reason.slice(0, 200) : null,
        selectedBy,
        stage,
        at: new Date().toISOString(),
      };
      await mkdir(stateDir, { recursive: true });
      const temporary = `${path}.${randomUUID().slice(0, 8)}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ ...all, [goalId]: record }, null, 2)}\n`, 'utf8');
      await rename(temporary, path);
      return record;
    },
  };
}
