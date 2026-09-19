/**
 * IA Loop — deterministic Goal discovery.
 *
 * Reads the migration artefacts as the authority and refuses to guess. Nothing
 * here infers a baseline from HEAD: the accepted baseline is a documented fact
 * that must be stated by both the Goal and MIGRATION_STATUS, and the two must
 * agree.
 *
 * This module only reads. It never writes to docs/migration.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { SpikeError } from './claude-process.mjs';
import { assertSha } from './contracts-v2.mjs';
import { DEVELOPER_PROFILE_NAMES } from './developer-profiles.mjs';

export const GOAL_STATUSES = Object.freeze([
  'PLANNED', 'READY', 'IN_PROGRESS', 'IMPLEMENTED', 'REVIEW_REQUIRED', 'ACCEPTED', 'BLOCKED', 'SUPERSEDED',
]);

function fail(code, message, details = {}) {
  throw new SpikeError(code, message, details);
}

/** Locates exactly one `<id>-*.md` under the goals directory. */
export async function findGoalFile(goalsDir, goalId) {
  if (!/^\d{3}$/.test(goalId)) {
    fail('INVALID_GOAL_ID', `Goal id must be three digits, got ${JSON.stringify(goalId)}`);
  }

  let entries;
  try {
    entries = await readdir(goalsDir);
  } catch (error) {
    fail('GOALS_DIR_UNREADABLE', `Cannot read goals directory ${goalsDir}: ${error.message}`);
  }

  const matches = entries.filter((name) => name.startsWith(`${goalId}-`) && name.endsWith('.md')).sort();

  if (matches.length === 0) {
    fail('GOAL_NOT_FOUND', `No Goal file matching ${goalId}-*.md in ${goalsDir}`);
  }
  if (matches.length > 1) {
    fail('GOAL_AMBIGUOUS', `Expected exactly one Goal file for ${goalId} but found: ${matches.join(', ')}`);
  }

  return join(goalsDir, matches[0]);
}

/**
 * Extracts the declared facts from a Goal document.
 * Everything is anchored on explicit labels, never on position or prose.
 */
export function parseGoalDocument(text, goalId) {
  const title = text.match(new RegExp(`^#\\s*Goal\\s+${goalId}\\s*[—-]\\s*(.+)$`, 'm'));
  if (!title) fail('GOAL_TITLE_MISSING', `Goal ${goalId} has no "# Goal ${goalId} — <title>" heading`);

  const status = text.match(/\*\*Status:\s*([A-Z_]+)\.?\*\*/);
  if (!status) fail('GOAL_STATUS_MISSING', `Goal ${goalId} does not declare "**Status: <STATUS>.**"`);
  if (!GOAL_STATUSES.includes(status[1])) {
    fail('GOAL_STATUS_UNKNOWN', `Goal ${goalId} declares unknown status "${status[1]}"`);
  }

  const baseline = text.match(/Baseline aceita:\s*`([0-9a-f]{40})`/);
  if (!baseline) fail('GOAL_BASELINE_MISSING', `Goal ${goalId} does not declare "Baseline aceita: \`<sha>\`"`);

  const previousGoal = text.match(/Goal anterior:\s*(\d{3})\b/);
  const previousStatus = text.match(/Status anterior:\s*([A-Z_]+)/);

  // The Developer profile the Tech Lead chose for this Goal, written as a
  // human-readable mirror of the choice recorded in the profile store.
  // Optional: a Goal written before routing existed simply has no line, and an
  // unknown name is refused rather than silently downgraded.
  const profile = text.match(/Developer execution profile:\s*`?([A-Z_]+)`?/);
  if (profile && !DEVELOPER_PROFILE_NAMES.includes(profile[1])) {
    fail(
      'UNKNOWN_DEVELOPER_PROFILE',
      `Goal ${goalId} declares Developer execution profile "${profile[1]}", which is not in the registry`,
    );
  }

  return {
    goalId,
    title: title[1].trim(),
    status: status[1],
    declaredBaseline: baseline[1],
    previousGoalId: previousGoal ? previousGoal[1] : null,
    previousGoalStatus: previousStatus ? previousStatus[1] : null,
    declaredDeveloperProfile: profile ? profile[1] : null,
  };
}

/**
 * Extracts the current accepted baseline and the per-Goal status table from
 * MIGRATION_STATUS.md.
 */
export function parseMigrationStatus(text) {
  const baseline = text.match(/\*\*Baseline aceita vigente:\*\*\s*`([0-9a-f]{40})`/);
  if (!baseline) {
    fail('MIGRATION_BASELINE_MISSING', 'MIGRATION_STATUS.md does not declare "**Baseline aceita vigente:** `<sha>`"');
  }

  // Table rows look like: | 003 — Título | READY | ... |
  const rows = new Map();
  const rowPattern = /^\|\s*(\d{3})\s*[—-][^|]*\|\s*([A-Z_]+)\s*\|/gm;
  let match;
  while ((match = rowPattern.exec(text)) !== null) {
    rows.set(match[1], match[2]);
  }

  return { acceptedBaseline: baseline[1], goalStatuses: rows };
}

/**
 * Discovers a Goal and verifies coherence across the artefacts.
 *
 * `resolveSha` lets the caller prove a SHA really exists in this repository
 * (normally `git rev-parse --verify`); it is injectable so tests need no git.
 */
export async function discoverGoal({
  repoRoot,
  goalId,
  resolveSha,
  requiredStatus = 'READY',
  // Defaults to requiredStatus: by the time the check below runs, goal.status
  // has already been proven to equal requiredStatus, so this preserves the
  // original "row must equal the document" behavior for every caller that
  // does not know about a resumable, multi-commit closure in progress.
  expectedMigrationStatusRow = requiredStatus,
}) {
  const migrationDir = join(repoRoot, 'docs', 'migration');
  const goalsDir = join(migrationDir, 'goals');
  const statusPath = join(migrationDir, 'MIGRATION_STATUS.md');

  const goalPath = await findGoalFile(goalsDir, goalId);

  let goalText;
  let statusText;
  try {
    goalText = await readFile(goalPath, 'utf8');
  } catch (error) {
    fail('GOAL_UNREADABLE', `Cannot read ${goalPath}: ${error.message}`);
  }
  try {
    statusText = await readFile(statusPath, 'utf8');
  } catch (error) {
    fail('MIGRATION_STATUS_UNREADABLE', `Cannot read ${statusPath}: ${error.message}`);
  }

  const goal = parseGoalDocument(goalText, goalId);
  const migration = parseMigrationStatus(statusText);

  if (goal.status !== requiredStatus) {
    fail('GOAL_NOT_READY', `Goal ${goalId} is ${goal.status}, expected ${requiredStatus}`);
  }

  // The Goal and MIGRATION_STATUS must agree on the accepted baseline. A
  // divergence means an incomplete change somewhere, not something to pick a
  // winner for.
  if (goal.declaredBaseline !== migration.acceptedBaseline) {
    fail(
      'BASELINE_DIVERGENCE',
      `Goal ${goalId} declares baseline ${goal.declaredBaseline} but MIGRATION_STATUS declares ${migration.acceptedBaseline}`,
      { goalBaseline: goal.declaredBaseline, migrationBaseline: migration.acceptedBaseline },
    );
  }

  const tableStatus = migration.goalStatuses.get(goalId);
  if (!tableStatus) {
    fail('MIGRATION_STATUS_ROW_MISSING', `MIGRATION_STATUS.md has no row for Goal ${goalId}`);
  }
  if (tableStatus !== expectedMigrationStatusRow) {
    fail(
      'GOAL_STATUS_DIVERGENCE',
      `Goal ${goalId} declares ${goal.status} but MIGRATION_STATUS lists ${tableStatus}`,
    );
  }

  // The previous Goal must be formally accepted before this one may run.
  if (goal.previousGoalId) {
    const previousInTable = migration.goalStatuses.get(goal.previousGoalId);
    if (previousInTable !== 'ACCEPTED') {
      fail(
        'PREVIOUS_GOAL_NOT_ACCEPTED',
        `Goal ${goal.previousGoalId} is ${previousInTable ?? 'absent'} in MIGRATION_STATUS, expected ACCEPTED`,
      );
    }
    if (goal.previousGoalStatus && goal.previousGoalStatus !== 'ACCEPTED') {
      fail(
        'PREVIOUS_GOAL_NOT_ACCEPTED',
        `Goal ${goalId} declares previous status ${goal.previousGoalStatus}, expected ACCEPTED`,
      );
    }
  }

  assertSha(migration.acceptedBaseline, 'migrationAcceptedBaseline');

  // Prove the SHA exists here; a documented but unreachable baseline is not a
  // usable baseline.
  if (resolveSha) {
    const resolved = await resolveSha(migration.acceptedBaseline);
    if (!resolved) {
      fail(
        'BASELINE_NOT_IN_REPO',
        `Accepted baseline ${migration.acceptedBaseline} does not resolve in this repository`,
      );
    }
  }

  return Object.freeze({
    goalId,
    title: goal.title,
    status: goal.status,
    goalPath,
    previousGoalId: goal.previousGoalId,
    previousGoalStatus: goal.previousGoalStatus ?? migration.goalStatuses.get(goal.previousGoalId) ?? null,
    migrationAcceptedBaseline: migration.acceptedBaseline,
    // Null when the Goal predates routing, or when the Tech Lead recorded the
    // choice only in the profile store. The runner resolves the precedence.
    declaredDeveloperProfile: goal.declaredDeveloperProfile ?? null,
  });
}
