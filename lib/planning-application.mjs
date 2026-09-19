/**
 * IA Loop — applying a validated NEXT_GOAL_PLANNING result.
 *
 * Extracted out of `run-close.mjs` so it is one function, called from every
 * place a validated `PlanningDecision` becomes available — a fresh planning
 * job, a directed PLAN_INVALID retry, or an envelope already on disk from a
 * job `run-close.mjs` itself did not have to wait for — rather than three
 * separate call sites that could each apply it slightly differently.
 *
 * That used to be exactly the gap: the "recover an already-completed
 * envelope" branch re-derived `nextGoalId` from a raw git diff instead of
 * calling this, so `planning.executionPlan` and `planning.developerProfile`
 * — sitting right there on the SAME validated envelope — were silently never
 * persisted. Goal010's first real round then ran the single-unit
 * compatibility fallback instead of the Tech Lead's own reviewed 20-unit DAG.
 * Never called on a failed envelope.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { SpikeError } from './claude-process.mjs';
import { assertMigrationComplete } from './planning-decision.mjs';
import { parseMigrationStatus } from './goal-discovery.mjs';
import { assertClosureScope as realAssertClosureScope } from './closure-contracts.mjs';
import { collectWorktreeChanges as realCollectWorktreeChanges } from './git-ops.mjs';
import { resolveDeveloperProfile } from './developer-profiles.mjs';

export async function applyPlanningResult({
  envelope,
  goalId,
  absPlan,
  /**
   * The commit the PLANNING WORKTREE was branched from — not the accepted
   * migration baseline, which is a different fact and was the name this
   * parameter used to carry.
   *
   * The two were the same commit until the worktree started branching from
   * main's tip, and the rename is the point: this value is used for exactly
   * one thing, the diff below, and calling it `newBaseline` is what hid a
   * second call site when the other one was fixed. Goal022 stopped as
   * TECH_LEAD_CLOSURE_SCOPE_VIOLATION naming three `tools/ia-loop/` files the
   * Tech Lead never touched — they were harness commits that landed on main
   * between the accepted baseline and the branch point, and diffing against
   * the baseline attributed them to the planner.
   */
  planningDiffBase,
  repoRoot,
  emit = () => {},
  machineState,
  persistClosure,
  profileStore,
  planStore,
  store,
  // Real git access by default; a test supplies a fake so this is checkable
  // without a real worktree, the same pattern `runDeterministicAction` uses
  // for `spawnFn`.
  collectWorktreeChanges = realCollectWorktreeChanges,
  assertClosureScope = realAssertClosureScope,
}) {
  const planChanges = await collectWorktreeChanges(absPlan, planningDiffBase);
  assertClosureScope(planChanges.changedFiles);

  const planning = envelope.result;

  if (planning.decision === 'HUMAN_REQUIRED') {
    throw new SpikeError('PRODUCT_DECISION',
      `The Tech Lead asked for a human before the next Goal: ${planning.reason}`);
  }

  if (planning.decision === 'MIGRATION_COMPLETE') {
    // The declaration is checked against the repository: a Goal still READY
    // means the migration demonstrably is not finished, whatever was claimed.
    const statusText = await fs.readFile(join(repoRoot, 'docs/migration/MIGRATION_STATUS.md'), 'utf8');
    const { goalStatuses } = parseMigrationStatus(statusText);
    goalStatuses.delete(goalId);
    assertMigrationComplete({ decision: planning, goalStatuses });

    emit(`  MIGRATION_COMPLETE: ${planning.reason}`);
    await persistClosure({
      migrationComplete: true,
      migrationCompleteReason: planning.reason,
      planningDocs: planChanges.changedFiles,
    }, machineState);
    return;
  }

  emit(`  next goal: ${planning.nextGoalId} — ${planning.nextGoalTitle}`);
  emit(`  developer profile: ${planning.developerProfile}`);
  emit(`  documents updated: ${planChanges.changedFiles.length}`);

  // The routing decision outlives this process: the Goal it applies to is
  // executed later, by `run-goal`. Recorded durably here so a restart in
  // between cannot lose it and nothing has to re-derive it from prose.
  await profileStore.write(planning.nextGoalId, {
    profile: planning.developerProfile,
    reason: planning.developerProfileReason,
    selectedBy: 'tech_lead',
    stage: 'NEXT_GOAL_PLANNING',
  });
  await store.appendEvent({
    type: 'DEVELOPER_PROFILE_SELECTED',
    goal: planning.nextGoalId,
    round: 1,
    stage: 'NEXT_GOAL_PLANNING',
    profile: planning.developerProfile,
    model: resolveDeveloperProfile(planning.developerProfile).model,
    effort: resolveDeveloperProfile(planning.developerProfile).effort,
    selectedBy: 'tech_lead',
    reason: planning.developerProfileReason ?? null,
  });

  // The Work Unit DAG, if the Tech Lead produced one. Same lifetime and same
  // failure modes as the profile above — written later, executed by a
  // different process — so it is carried by the same kind of durable
  // hand-off rather than re-derived from the Goal document.
  //
  // Absent is legitimate and recorded as such: the Goal then runs as a single
  // STANDARD unit, which is what every Goal did before this existed.
  if (planning.executionPlan) {
    const record = await planStore.write(planning.nextGoalId, {
      plan: planning.executionPlan,
      selectedBy: 'tech_lead',
      stage: 'NEXT_GOAL_PLANNING',
    });
    emit(`  execution plan: ${record.workUnitCount} work unit(s) `
      + `(${Object.entries(record.types).map(([type, count]) => `${count} ${type}`).join(', ')})`);
    await store.appendEvent({
      type: 'EXECUTION_PLAN_RECORDED',
      goal: planning.nextGoalId,
      stage: 'NEXT_GOAL_PLANNING',
      units: record.workUnitCount,
      types: record.types,
      fragmentation: record.fragmentation,
      selectedBy: 'tech_lead',
    });
  } else {
    emit('  execution plan: none — the Goal will run as a single STANDARD work unit.');
    await store.appendEvent({
      type: 'EXECUTION_PLAN_ABSENT',
      goal: planning.nextGoalId,
      stage: 'NEXT_GOAL_PLANNING',
      reason: 'PLANNING_PRODUCED_NO_PLAN',
    });
  }

  await persistClosure({
    nextGoalId: planning.nextGoalId,
    nextGoalTitle: planning.nextGoalTitle,
    nextGoalPath: planning.nextGoalPath,
    nextGoalDeveloperProfile: planning.developerProfile,
    planningDocs: planChanges.changedFiles,
  }, machineState);
}
