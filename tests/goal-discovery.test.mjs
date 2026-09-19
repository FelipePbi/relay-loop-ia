/**
 * Goal discovery tests. Reads fixtures on disk; no model calls, no git needed
 * (SHA resolution is injected).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  discoverGoal,
  findGoalFile,
  parseGoalDocument,
  parseMigrationStatus,
} from '../lib/goal-discovery.mjs';

const codeIs = (code) => (error) => error.code === code;

const BASELINE = '1e874e2785d2bc78860db0eb571ea901a4395c17';
const OTHER_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function goalDoc({ status = 'READY', baseline = BASELINE, previous = '002', previousStatus = 'ACCEPTED' } = {}) {
  return [
    '# Goal 003 — Tenant, sessão e vínculo WhatsApp',
    '',
    `**Status: ${status}.** Executor: Claude Code / Opus.`,
    '',
    '## Baseline aceita',
    '',
    `Baseline aceita: \`${baseline}\``,
    '',
    `Goal anterior: ${previous} — Base de validação reproduzível`,
    '',
    `Status anterior: ${previousStatus}`,
    '',
  ].join('\n');
}

function migrationDoc({ baseline = BASELINE, goal003 = 'READY', goal002 = 'ACCEPTED' } = {}) {
  return [
    '# Migration status',
    '',
    `**Baseline aceita vigente:** \`${baseline}\` — commit de fechamento do Goal002.`,
    '',
    '| Goal | Status | Commit | Review | Notas |',
    '| --- | --- | --- | --- | --- |',
    `| 001 — Autorizar alvo | ACCEPTED | — | Astra | ok |`,
    `| 002 — Base de validação | ${goal002} | \`${BASELINE}\` | Astra | ok |`,
    `| 003 — Tenant/sessão | ${goal003} | — | Prompt003 | ok |`,
    '',
  ].join('\n');
}

async function withRepo(run, { goal = goalDoc(), migration = migrationDoc(), fileName = '003-tenant-sessao-vinculo-whatsapp.md', extraGoalFiles = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ia-loop-goal-'));
  const goalsDir = join(root, 'docs', 'migration', 'goals');
  await mkdir(goalsDir, { recursive: true });
  await writeFile(join(goalsDir, fileName), goal, 'utf8');
  for (const extra of extraGoalFiles) {
    await writeFile(join(goalsDir, extra), goal, 'utf8');
  }
  await writeFile(join(root, 'docs', 'migration', 'MIGRATION_STATUS.md'), migration, 'utf8');
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const alwaysResolves = async () => true;

test('discovers a READY Goal and reports the accepted baseline', async () => {
  await withRepo(async (root) => {
    const goal = await discoverGoal({ repoRoot: root, goalId: '003', resolveSha: alwaysResolves });

    assert.equal(goal.goalId, '003');
    assert.equal(goal.status, 'READY');
    assert.equal(goal.title, 'Tenant, sessão e vínculo WhatsApp');
    assert.equal(goal.migrationAcceptedBaseline, BASELINE);
    assert.equal(goal.previousGoalId, '002');
    assert.equal(goal.previousGoalStatus, 'ACCEPTED');
  });
});

test('a missing Goal is reported, never guessed', async () => {
  await withRepo(async (root) => {
    await assert.rejects(
      discoverGoal({ repoRoot: root, goalId: '004', resolveSha: alwaysResolves }),
      codeIs('GOAL_NOT_FOUND'),
    );
  });
});

test('two files for the same Goal are ambiguous and refused', async () => {
  await withRepo(
    async (root) => {
      await assert.rejects(
        discoverGoal({ repoRoot: root, goalId: '003', resolveSha: alwaysResolves }),
        codeIs('GOAL_AMBIGUOUS'),
      );
    },
    { extraGoalFiles: ['003-duplicate.md'] },
  );
});

test('a Goal that is not READY does not run', async () => {
  await withRepo(
    async (root) => {
      await assert.rejects(
        discoverGoal({ repoRoot: root, goalId: '003', resolveSha: alwaysResolves }),
        codeIs('GOAL_NOT_READY'),
      );
    },
    { goal: goalDoc({ status: 'PLANNED' }), migration: migrationDoc({ goal003: 'PLANNED' }) },
  );
});

test('a baseline divergence between Goal and MIGRATION_STATUS fails closed', async () => {
  await withRepo(
    async (root) => {
      await assert.rejects(
        discoverGoal({ repoRoot: root, goalId: '003', resolveSha: alwaysResolves }),
        codeIs('BASELINE_DIVERGENCE'),
      );
    },
    { goal: goalDoc({ baseline: OTHER_SHA }) },
  );
});

test('a status divergence between Goal and MIGRATION_STATUS fails closed', async () => {
  await withRepo(
    async (root) => {
      await assert.rejects(
        discoverGoal({ repoRoot: root, goalId: '003', resolveSha: alwaysResolves }),
        codeIs('GOAL_STATUS_DIVERGENCE'),
      );
    },
    { migration: migrationDoc({ goal003: 'IN_PROGRESS' }) },
  );
});

test('a caller that knows it is resuming a closure may accept a document ahead of the ledger row', async () => {
  // Exactly the Goal009 shape: closure documentation already moved the
  // document to ACCEPTED, but MIGRATION_STATUS's row is written later, by
  // NEXT_GOAL_PLANNING, so it still reads READY. A caller that KNOWS this
  // (run-close.mjs, mid-resume) may say so explicitly.
  await withRepo(
    async (root) => {
      const goal = await discoverGoal({
        repoRoot: root, goalId: '003', resolveSha: alwaysResolves,
        requiredStatus: 'ACCEPTED', expectedMigrationStatusRow: 'READY',
      });
      assert.equal(goal.status, 'ACCEPTED');
    },
    { goal: goalDoc({ status: 'ACCEPTED' }), migration: migrationDoc({ goal003: 'READY' }) },
  );
});

test('without that explicit opt-in, the same gap still fails closed exactly as before', async () => {
  await withRepo(
    async (root) => {
      await assert.rejects(
        discoverGoal({
          repoRoot: root, goalId: '003', resolveSha: alwaysResolves, requiredStatus: 'ACCEPTED',
        }),
        codeIs('GOAL_STATUS_DIVERGENCE'),
      );
    },
    { goal: goalDoc({ status: 'ACCEPTED' }), migration: migrationDoc({ goal003: 'READY' }) },
  );
});

test('a previous Goal that is not ACCEPTED blocks the run', async () => {
  await withRepo(
    async (root) => {
      await assert.rejects(
        discoverGoal({ repoRoot: root, goalId: '003', resolveSha: alwaysResolves }),
        codeIs('PREVIOUS_GOAL_NOT_ACCEPTED'),
      );
    },
    { migration: migrationDoc({ goal002: 'REVIEW_REQUIRED' }) },
  );
});

test('a baseline that does not resolve in the repository is refused', async () => {
  await withRepo(async (root) => {
    await assert.rejects(
      discoverGoal({ repoRoot: root, goalId: '003', resolveSha: async () => false }),
      codeIs('BASELINE_NOT_IN_REPO'),
    );
  });
});

test('the accepted baseline is never inferred from HEAD', async () => {
  await withRepo(async (root) => {
    // Even when the caller could resolve anything, the value comes from the
    // documents, not from the repository state.
    const goal = await discoverGoal({ repoRoot: root, goalId: '003', resolveSha: alwaysResolves });
    assert.equal(goal.migrationAcceptedBaseline, BASELINE);
    assert.notEqual(goal.migrationAcceptedBaseline, OTHER_SHA);
  });
});

test('parseGoalDocument rejects documents missing required declarations', () => {
  assert.throws(() => parseGoalDocument('# Nope', '003'), codeIs('GOAL_TITLE_MISSING'));
  assert.throws(
    () => parseGoalDocument('# Goal 003 — X\n\nsem status', '003'),
    codeIs('GOAL_STATUS_MISSING'),
  );
  assert.throws(
    () => parseGoalDocument('# Goal 003 — X\n\n**Status: READY.**\n\nsem baseline', '003'),
    codeIs('GOAL_BASELINE_MISSING'),
  );
  assert.throws(
    () => parseGoalDocument('# Goal 003 — X\n\n**Status: BOGUS.**\n', '003'),
    codeIs('GOAL_STATUS_UNKNOWN'),
  );
});

test('parseMigrationStatus extracts the baseline and the status table', () => {
  const parsed = parseMigrationStatus(migrationDoc());
  assert.equal(parsed.acceptedBaseline, BASELINE);
  assert.equal(parsed.goalStatuses.get('003'), 'READY');
  assert.equal(parsed.goalStatuses.get('002'), 'ACCEPTED');

  assert.throws(() => parseMigrationStatus('sem baseline'), codeIs('MIGRATION_BASELINE_MISSING'));
});

test('findGoalFile rejects a malformed goal id', async () => {
  await withRepo(async (root) => {
    await assert.rejects(
      findGoalFile(join(root, 'docs', 'migration', 'goals'), '3'),
      codeIs('INVALID_GOAL_ID'),
    );
  });
});
