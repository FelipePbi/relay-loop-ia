#!/usr/bin/env node
/**
 * IA Loop — accepted Goal closure and next-Goal planning.
 *
 *   npm run ia-loop:close -- 003
 *
 * The IA Loop does NOT decide that a Goal is accepted. It mechanises the
 * closure only after finding a persisted, valid ReviewDecision with
 * decision = ACCEPTED. No new review happens here, and the Developer is never
 * called.
 *
 * Every step records its SHA, so a crash or restart resumes instead of
 * repeating: no duplicate commit, no duplicate cherry-pick, no second next Goal.
 */

import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SpikeError } from './lib/claude-process.mjs';
import { createJobStore, readJson } from './lib/job-store.mjs';
import {
  ROUTING_STAGES,
  classifyPlanningComplexity,
  resolveRoutingMode,
  routeTechLead,
  toJobRouting,
} from './lib/model-routing.mjs';
import { discoverGoal } from './lib/goal-discovery.mjs';
import { ensureGoalAcceptedStatus } from './lib/goal-status-transition.mjs';
import {
  CLOSURE_RESUME_POINTS, expectedMigrationStatusRowFor, planningDiffBaseFor, requiredGoalStatusFor,
  resolveClosureResumePoint,
} from './lib/closure-resume.mjs';
import { readWorkerHealth, WORKER_HEALTH } from './lib/worker-registry.mjs';
import { LOOP_STATES, createLoopStateMachine } from './lib/loop-state.mjs';
import { PROTOCOL_VERSION_V2 } from './lib/contracts-v2.mjs';
import { assertClosureScope, CLOSURE_WRITE_PREFIX } from './lib/closure-contracts.mjs';
import { createDeveloperProfileStore } from './lib/developer-profiles.mjs';
import { createExecutionPlanStore } from './lib/execution-plan-store.mjs';
import { classifyLease, createLeaseStore } from './lib/leases.mjs';
import { applyPlanningResult } from './lib/planning-application.mjs';
import {
  PLANNING_FAILURE_ACTIONS,
  classifyPlanningFailure,
  findPlanningFailureEvent,
} from './lib/planning-retry.mjs';
import { isDirectExecution } from './lib/direct-execution.mjs';
import {
  createGitProbe,
  createWorktree as gitCreateWorktree,
  collectWorktreeChanges,
  stageAndCommit,
  cherryPick,
  isAlreadyIntegrated,
  git,
} from './lib/git-ops.mjs';
import {
  assertSnapshotUnchanged,
  backfillFromReviewPacket,
  buildAcceptedSnapshot,
} from './lib/accepted-snapshot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE);
const STATE_DIR = join(HERE, '.state');

/** Cap on the text handed to the classifier. It reads signals, not documents. */
const RISK_TEXT_LIMIT = 40_000;

/**
 * The text the planning risk is scored from.
 *
 * The roadmap the planner is about to re-evaluate, plus the Goal it just
 * closed — the two documents that actually say what comes next and how hard it
 * was to get here. Missing files are not an error: a signal that cannot be read
 * simply does not fire, and the score falls back to what can.
 */
async function readPlanningRiskText({ goal, closure }) {
  const candidates = [
    join(REPO_ROOT, 'docs', 'migration', 'MASTER_PLAN.md'),
    goal?.goalPath ?? null,
    ...(closure?.closureDocs ?? [])
      .filter((doc) => doc.includes('review'))
      .map((doc) => join(REPO_ROOT, doc)),
  ].filter(Boolean);

  const parts = [];
  for (const path of candidates) {
    try {
      parts.push(await fs.readFile(path, 'utf8'));
    } catch {
      // Unreadable or absent: no signal, not a failure.
    }
  }
  return parts.join('\n').slice(0, RISK_TEXT_LIMIT);
}

/** Whether any Developer round of this Goal had to be escalated to a stronger model. */
async function goalHadDeveloperEscalation(store, goalId) {
  // listJobs returns file names; the job id is the name without its extension.
  const fileNames = await store.listJobs('developer').catch(() => []);
  for (const fileName of fileNames) {
    const jobId = String(fileName).replace(/\.json$/, '');
    if (!jobId.startsWith(`${goalId}-`)) continue;
    const envelope = await readJson(store.paths.job('developer', jobId));
    if ((envelope?.attemptHistory ?? []).some((entry) => entry?.reason === 'MODEL_ESCALATION')) return true;
  }
  return false;
}
const RESULT_TIMEOUT_MS = Number(process.env.IA_LOOP_RESULT_TIMEOUT_MS ?? 3 * 60 * 60 * 1000);
const POLL_MS = 5_000;

const probe = createGitProbe(REPO_ROOT);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const emit = (line = '') => console.log(line);

function parseArgs(argv) {
  const goalId = argv.slice(2).find((a) => /^\d{3}$/.test(a));
  if (!goalId) throw new SpikeError('INVALID_ARGS', 'Usage: npm run ia-loop:close -- <goalId>');
  return { goalId };
}

/**
 * Waits for a result. An observer timeout never fails the job — same reasoning
 * as in run-goal. Closure and planning write to docs, so a duplicate execution
 * here is as harmful as a duplicate implementation.
 */
async function waitForResult(store, role, jobId, { leaseStore } = {}) {
  const startedAt = Date.now();
  let lastState = null;
  for (;;) {
    const envelope = await store.readResult(role, jobId);
    if (envelope) return envelope;

    if (Date.now() - startedAt > RESULT_TIMEOUT_MS) {
      const lease = await leaseStore?.readJobLease(jobId);
      const { status } = lease ? classifyLease(lease) : { status: null };
      throw new SpikeError(
        'OBSERVER_TIMEOUT',
        `Stopped observing ${jobId}. The job was NOT failed and keeps its lease (${status ?? 'no lease'}). `
        + 'Re-run the closure once it finishes; it resumes instead of repeating.',
      );
    }

    const health = await readWorkerHealth(store, role);
    if (health.state !== lastState) {
      lastState = health.state;
      const suffix = health.capacityReason ? ` (${health.capacityReason})` : '';
      emit(`  … ${role}: ${health.state ?? 'unknown'}${suffix}`);
    }
    if (health.health === WORKER_HEALTH.OFFLINE) {
      throw new SpikeError('WORKER_OFFLINE',
        `The "${role}" worker stopped heartbeating. The attempt keeps its lease; no new attempt is started.`);
    }
    await sleep(POLL_MS);
  }
}

/** Reads the persisted acceptance. Never re-derives it, never re-reviews. */
async function findAcceptedDecision(store, runtime, goalId) {
  if (runtime?.decision !== 'ACCEPTED') {
    throw new SpikeError(
      'GOAL_NOT_ACCEPTED',
      `Closure requires a persisted ACCEPTED decision; the run is ${runtime?.decision ?? 'unknown'}.`,
    );
  }
  if (runtime.goal !== goalId) {
    throw new SpikeError('GOAL_MISMATCH', `Runtime holds goal ${runtime.goal}, not ${goalId}`);
  }

  // Locate the review result that carries the acceptance.
  const files = await store.listJobs('tech_lead');
  let accepted = null;
  for (const file of files) {
    const jobId = file.replace(/\.json$/, '');
    const envelope = await store.readResult('tech_lead', jobId);
    const decision = envelope?.result;
    if (envelope?.ok && decision?.decision === 'ACCEPTED' && decision.goal === goalId) {
      if (!accepted || (decision.round ?? 0) >= (accepted.decision.round ?? 0)) {
        accepted = { jobId, decision };
      }
    }
  }
  if (!accepted) {
    throw new SpikeError('ACCEPTED_DECISION_NOT_FOUND', `No persisted ACCEPTED review found for Goal ${goalId}`);
  }
  return accepted;
}

async function main() {
  const { goalId } = parseArgs(process.argv);
  const store = createJobStore(STATE_DIR);
  const leaseStore = createLeaseStore(STATE_DIR);
  const profileStore = createDeveloperProfileStore(STATE_DIR);
  const planStore = createExecutionPlanStore(STATE_DIR);
  const machine = createLoopStateMachine({ initialState: LOOP_STATES.ACCEPTED });

  emit('');
  emit('IA Loop — Goal Closure');
  emit('');

  const runtime = await store.readRuntime();
  const priorClosure = runtime.closure ?? {};
  const resumePoint = resolveClosureResumePoint(priorClosure);

  // Closure already integrated AND the next Goal's planning already integrated:
  // nothing left to verify against the documents at all. `discoverGoal`'s
  // baseline check in particular could never pass here on purpose — the
  // planning commit that just ran is what advanced MIGRATION_STATUS.md's
  // global baseline past what Goal009's OWN document still (correctly,
  // permanently) declares it was written against. Idempotent means returning
  // before touching the documents or the event log at all, not discovering
  // a "divergence" this closure itself just produced.
  if (resumePoint === CLOSURE_RESUME_POINTS.ALREADY_CLOSED) {
    emit(`Goal ${goalId} is already closed. Nothing to do.`);
    emit(`  integratedClosureCommit: ${priorClosure.integratedClosureCommit}`);
    emit(`  newMigrationBaseline:    ${priorClosure.newMigrationBaseline}`);
    emit(`  next Goal:               ${priorClosure.nextGoalId} — ${priorClosure.nextGoalTitle ?? ''}`);
    emit('');
    return 0;
  }

  // The Goal document's own "Status: ACCEPTED" line is structural fact once
  // the closure commit is proven integrated — not something a closure
  // documentation model call is trusted to remember to write (see
  // lib/goal-status-transition.mjs for the incident this closes).
  //
  // It is checked at the two moments the evidence can first be complete, and
  // only those. HERE, before discoverGoal, for a run that resumes one already
  // integrated — so discoverGoal's own requiredStatus check for that resume
  // point can pass. And again immediately AFTER integration further down, for
  // a FRESH run, which cannot be checked at this point because nothing is
  // integrated yet and the document must still read exactly what the review
  // left it.
  const accepted = await findAcceptedDecision(store, runtime, goalId);

  /**
   * The Goal document's status line, made true on main and committed if it
   * was not already.
   *
   * Shared by the two moments the evidence can first be complete: the top of
   * a RESUMED run, and the instant integration proves it inside a FRESH one.
   * `ensureGoalAcceptedStatus` refuses to act on anything less than the full
   * evidence set, so calling it at both is safe and the second is a no-op
   * whenever the first already fired.
   */
  async function commitAcceptedStatusIfMissing({
    closureDocsJobId, integratedClosureCommit, newMigrationBaseline,
  }) {
    const statusFix = await ensureGoalAcceptedStatus({
      repoRoot: REPO_ROOT, goalId,
      reviewDecision: runtime.decision,
      closureDocsJobId, integratedClosureCommit, newMigrationBaseline,
      emit,
    });
    // A new, independent commit — never amending the integration commit
    // already on main, never touching the worktree or the baseline. Staged
    // by exact path, so nothing else that happens to be dirty on this
    // checkout is swept in.
    if (!statusFix.changed) return null;
    const fix = await stageAndCommit({
      cwd: REPO_ROOT,
      paths: [statusFix.path],
      message: `docs(migration): mark Goal ${goalId} ACCEPTED (closure documentation omitted it)`,
    });
    emit(`  committed: ${fix.sha}`);
    return fix.sha;
  }

  if (resumePoint !== CLOSURE_RESUME_POINTS.FRESH) {
    await commitAcceptedStatusIfMissing({
      closureDocsJobId: priorClosure.closureDocsJobId,
      integratedClosureCommit: priorClosure.integratedClosureCommit,
      newMigrationBaseline: priorClosure.newMigrationBaseline,
    });
  }

  const goal = await discoverGoal({
    repoRoot: REPO_ROOT, goalId, resolveSha: (sha) => probe.commitExists(sha),
    requiredStatus: requiredGoalStatusFor(resumePoint),
    expectedMigrationStatusRow: expectedMigrationStatusRowFor(resumePoint),
  });

  emit(`Goal ${goalId}: ACCEPTED (round ${accepted.decision.round}, review job ${accepted.jobId})`);
  emit('No new review is performed and the Developer is not called.');
  emit('');

  if (resumePoint === CLOSURE_RESUME_POINTS.RESUME_PLANNING) {
    emit(`Closure already integrated (${priorClosure.integratedClosureCommit}); resuming only NEXT_GOAL_PLANNING.`);
    emit('');
  }

  const worktreePath = runtime.worktreePath;
  const absWorktree = join(REPO_ROOT, worktreePath);
  const initialHead = runtime.worktreeInitialHead;
  const previousBaseline = goal.migrationAcceptedBaseline;

  // Everything already done is recorded here; each step checks before acting.
  const closure = { ...priorClosure, goal: goalId, round: accepted.decision.round };
  const persistClosure = async (patch, state) => {
    Object.assign(closure, patch);
    await store.writeRuntime({ ...(await store.readRuntime()), state, closure });
  };

  // ---------- Accepted snapshot ------------------------------------------
  // The gate protects the moment BEFORE the closure commit. Once that commit
  // exists the snapshot has already been verified and consumed, and the tree has
  // legitimately moved on — closure docs were added and the work was committed.
  // Re-checking here would block every resume.
  machine.transitionTo(LOOP_STATES.CLOSURE_PREPARING);

  const currentChanges = await collectWorktreeChanges(absWorktree, initialHead);
  let snapshot = closure.acceptedSnapshot ?? null;

  if (closure.sourceClosureCommit) {
    emit(`Accepted snapshot already verified and committed as ${closure.sourceClosureCommit}.`);
    emit(`  files: ${snapshot?.fileCount ?? 'n/a'} · diffHash: ${(snapshot?.diffHash ?? '').slice(0, 16)}`);
    emit('');
  } else if (!snapshot) {
    emit('Verifying the accepted snapshot…');
    // Backfill for a Goal accepted before snapshots existed. Only valid when the
    // persisted review packet still matches the worktree byte for byte.
    const artefactDir = join(STATE_DIR, 'artefacts', `${goalId}-r${accepted.decision.round}`);
    const packet = JSON.parse(await fs.readFile(join(artefactDir, 'review-packet.json'), 'utf8'));
    const savedDiff = await fs.readFile(join(artefactDir, 'implementation.patch'), 'utf8');

    snapshot = backfillFromReviewPacket({
      packet, currentChanges, savedDiff, round: accepted.decision.round,
    });
    emit('  snapshot backfilled from the persisted review packet (file list + diff match byte for byte)');
    await persistClosure({ acceptedSnapshot: snapshot }, machine.state);
    emit(`  files: ${snapshot.fileCount} · diffHash: ${snapshot.diffHash.slice(0, 16)}`);
    emit('');
  } else {
    emit('Verifying the accepted snapshot…');
    assertSnapshotUnchanged(snapshot, buildAcceptedSnapshot({
      changes: currentChanges, round: accepted.decision.round,
    }));
    emit('  snapshot unchanged since the acceptance');
    emit(`  files: ${snapshot.fileCount} · diffHash: ${snapshot.diffHash.slice(0, 16)}`);
    emit('');
  }

  // ---------- Closure documentation --------------------------------------
  if (!closure.closureDocsJobId) {
    machine.transitionTo(LOOP_STATES.CLOSURE_DOCUMENTING);
    const jobId = store.newJobId(goalId, accepted.decision.round, 'tech_lead');

    const before = await collectWorktreeChanges(absWorktree, initialHead);
    await store.publishJob('tech_lead', {
      protocolVersion: PROTOCOL_VERSION_V2,
      jobId, role: 'tech_lead', type: 'CLOSURE_DOCUMENTATION',
      goal: goalId, round: accepted.decision.round,
      worktree: absWorktree,
      closureContext: {
        goal: goalId, goalPath: goal.goalPath,
        decision: 'ACCEPTED', finalRound: accepted.decision.round,
        previousMigrationBaseline: previousBaseline,
        executionBase: runtime.executionBase,
        worktreeInitialHead: initialHead,
        acceptedSnapshot: { files: snapshot.fileCount, diffHash: snapshot.diffHash },
        changedFiles: before.changedFiles,
        roundsRun: runtime.roundsRun ?? [],
        writeScope: CLOSURE_WRITE_PREFIX,
      },
    });
    emit(`Closure documentation job published: ${jobId}`);
    await persistClosure({ closureDocsJobId: jobId }, machine.state);

    const envelope = await waitForResult(store, 'tech_lead', jobId, { leaseStore });
    if (!envelope.ok) {
      throw new SpikeError('CLOSURE_DOCS_FAILED', `[${envelope.code}] ${envelope.message}`);
    }

    // The model reported what it changed; git says what actually changed.
    const after = await collectWorktreeChanges(absWorktree, initialHead);
    const newFiles = after.changedFiles.filter((f) => !before.changedFiles.includes(f));
    const docScope = [...new Set([...newFiles, ...(envelope.result.documentsUpdated ?? [])])];
    assertClosureScope(docScope);

    emit(`  documents updated: ${envelope.result.documentsUpdated.length}`);
    for (const d of envelope.result.documentsUpdated) emit(`    - ${d}`);
    emit('');
    await persistClosure({ closureDocs: envelope.result.documentsUpdated }, machine.state);
  } else {
    emit(`Closure documentation already done (job ${closure.closureDocsJobId}).`);
    machine.transitionTo(LOOP_STATES.CLOSURE_DOCUMENTING);
  }

  machine.transitionTo(LOOP_STATES.CLOSURE_READY);

  // ---------- Source commit on the Goal branch ----------------------------
  if (!closure.sourceClosureCommit) {
    machine.transitionTo(LOOP_STATES.GOAL_COMMITTING);
    emit('Committing the accepted implementation on the Goal branch…');

    const changes = await collectWorktreeChanges(absWorktree, initialHead);
    const paths = changes.changedFiles.filter((f) => !f.startsWith('graphify-out/') && !f.startsWith('tools/ia-loop/'));

    const { sha, stagedFiles } = await stageAndCommit({
      cwd: absWorktree,
      paths,
      // Derived from the Goal being closed, never a fixed string. The subject
      // was hardcoded to one Goal's subject — "tenant session whatsapp
      // ownership" — so every closure from Goal015 to Goal020 went into the
      // history describing work it did not contain. `goal.title` is mandatory
      // (`discoverGoal` fails GOAL_TITLE_MISSING without it), so there is
      // nothing to fall back to and no way for this to go empty.
      message: `feat(migration): complete goal ${goalId} - ${goal.title}`,
      excludePaths: ['graphify-out', 'tools/ia-loop'],
    });

    emit(`  sourceClosureCommit: ${sha} (${stagedFiles.length} files)`);
    await persistClosure({ sourceClosureCommit: sha, stagedFiles: stagedFiles.length }, LOOP_STATES.GOAL_COMMITTED);
    machine.transitionTo(LOOP_STATES.GOAL_COMMITTED);
  } else {
    emit(`Source closure commit already exists: ${closure.sourceClosureCommit}`);
    machine.transitionTo(LOOP_STATES.GOAL_COMMITTING);
    machine.transitionTo(LOOP_STATES.GOAL_COMMITTED);
  }
  emit('');

  // ---------- Integrate into the main checkout ----------------------------
  if (!closure.integratedClosureCommit) {
    machine.transitionTo(LOOP_STATES.INTEGRATING_ACCEPTED);

    if (await isAlreadyIntegrated({ repoRoot: REPO_ROOT, sha: closure.sourceClosureCommit })) {
      throw new SpikeError('ALREADY_INTEGRATED',
        `${closure.sourceClosureCommit} is already in main but was not recorded; refusing to integrate twice.`);
    }
    if (await probe.isDirty()) {
      throw new SpikeError('MAIN_CHECKOUT_DIRTY', 'The main checkout must be clean before integrating.');
    }

    emit('Integrating into the main checkout (cherry-pick)…');
    const { after } = await cherryPick({ repoRoot: REPO_ROOT, sha: closure.sourceClosureCommit });
    emit(`  integratedClosureCommit: ${after}`);
    emit('');

    await persistClosure({
      integratedClosureCommit: after,
      previousMigrationBaseline: previousBaseline,
      newMigrationBaseline: after,
    }, LOOP_STATES.BASELINE_ACCEPTED);
    machine.transitionTo(LOOP_STATES.BASELINE_ACCEPTED);
  } else {
    emit(`Already integrated: ${closure.integratedClosureCommit}`);
    machine.transitionTo(LOOP_STATES.INTEGRATING_ACCEPTED);
    machine.transitionTo(LOOP_STATES.BASELINE_ACCEPTED);
  }

  const newBaseline = closure.newMigrationBaseline;
  emit('Migration baseline:');
  emit(`  previous: ${previousBaseline}`);
  emit(`  new:      ${newBaseline}`);
  emit('');

  // Integration just proved the last piece of evidence the status line needs,
  // so this is the earliest moment a FRESH run can know the closure
  // documentation omitted it — and the last moment before the planning
  // worktree exists.
  //
  // Detecting it later is what produced the Goal020 conflict. The omission
  // went unnoticed for a whole run; the NEXT invocation corrected it on main,
  // by which time the planner had already written its own (richer) ACCEPTED
  // sentence into a worktree branched before the correction. Two commits
  // changing one line, and the cherry-pick of the planning commit stopped as
  // CHERRY_PICK_CONFLICT with "a human must integrate it".
  //
  // Never fatal HERE, and only here. The closure commit is already on main at
  // this point: dying over a document the repair could not parse would leave
  // the Goal integrated, the campaign unable to advance, and a person holding
  // a run that stopped for a full stop — which is exactly what Goal022 did,
  // with its document already reading ACCEPTED. The repair is a repair; when
  // it cannot act, the fact is recorded and the closure carries on. The
  // resume-path call above keeps throwing, because there the document is
  // about to be checked by `discoverGoal` anyway.
  try {
    await commitAcceptedStatusIfMissing({
      closureDocsJobId: closure.closureDocsJobId,
      integratedClosureCommit: closure.integratedClosureCommit,
      newMigrationBaseline: newBaseline,
    });
  } catch (error) {
    if (error?.code !== 'GOAL_STATUS_LINE_UNRECOGNISED') throw error;
    emit(`Goal document status not repairable: ${error.message}`);
    emit('  Continuing: the closure is already integrated, and this is a repair, not a gate.');
    await store.appendEvent({
      type: 'GOAL_STATUS_LINE_UNRECOGNISED', goal: goalId, stage: 'POST_INTEGRATION_REPAIR',
    });
  }

  // ---------- Next Goal planning -----------------------------------------
  // A deterministic, unique name per Goal. Reusing one generic path across
  // cycles would collide the moment the loop runs unattended, and would lose the
  // audit trail of which planning produced which Goal.
  const planPath = `.ai-worktrees/plan-after-goal-${goalId}`;
  const planBranch = `ai-loop/plan-after-goal-${goalId}`;
  const absPlan = join(REPO_ROOT, planPath);

  if (!closure.planningWorktreeCreated) {
    emit('Creating the planning worktree…');
    // Branched from main's TIP, not from the accepted baseline. The two are
    // usually the same commit and the difference only shows when they are
    // not: anything that lands on main between integration and this point —
    // the deterministic status fix above, a harness commit made while the run
    // was stopped — would otherwise be absent here, and the planning commit
    // would be built against a main that had moved on. Its cherry-pick then
    // conflicts on a line both sides changed, which is exactly how Goal020
    // ended in CHERRY_PICK_CONFLICT.
    //
    // The accepted baseline is unaffected: it is a published fact the next
    // Goal must declare, and it reaches the planner through
    // `planningContext.migrationAcceptedBaseline`, not through this branch
    // point.
    const tip = await probe.head();
    await gitCreateWorktree({ repoRoot: REPO_ROOT, path: planPath, branch: planBranch, base: tip });
    await persistClosure({ planningWorktreeCreated: true, planningBase: tip }, LOOP_STATES.BASELINE_ACCEPTED);
  }

  // What the worktree was ACTUALLY branched from, which is what its diff has
  // to be taken against. `planningBase` was recorded from the start and never
  // read; reading it is what lets the branch point move at all.
  const planningDiffBase = planningDiffBaseFor(closure, newBaseline);

  /**
   * Publishes one NEXT_GOAL_PLANNING job and waits for its result.
   *
   * `feedback`, when given, is the previous attempt's contract violation
   * (jobId, code, diagnostic) — carried in `planningContext` so
   * `buildPlanningPrompt` can hand it to the Tech Lead as explicit, directed
   * correction context. The previous job's own job/result files are never
   * touched: this always mints a NEW jobId, so the invalid attempt stays on
   * disk as history.
   */
  async function publishAndAwaitPlanning({ feedback = null } = {}) {
    const jobId = store.newJobId(goalId, accepted.decision.round, 'tech_lead');

    // --- Planning routing --------------------------------------------------
    // Scored from the roadmap the planner is about to re-evaluate and from
    // what already went wrong, since at planning time there is no diff to
    // read. Deterministic and zero-token: no model is called to choose a model.
    const planningAssessment = classifyPlanningComplexity({
      text: await readPlanningRiskText({ goal, closure }),
      history: {
        previousRoundRejected: (accepted.decision.round ?? 1) > 1,
        previousDeveloperEscalation: await goalHadDeveloperEscalation(store, goalId),
      },
    });
    const planningRouting = routeTechLead({
      stage: ROUTING_STAGES.PLANNING,
      assessment: planningAssessment,
      mode: resolveRoutingMode(),
    });
    emit(`Planning routing: ${planningAssessment.classification} (score ${planningAssessment.riskScore})`
      + ` → ${planningRouting.label} effort ${planningRouting.effort}`);
    if (planningAssessment.signals.length > 0) emit(`  signals: ${planningAssessment.signals.join(', ')}`);
    if (feedback) emit(`Directed retry of ${feedback.previousJobId}: feeding back [${feedback.code}] as explicit correction context`);

    await store.publishJob('tech_lead', {
      protocolVersion: PROTOCOL_VERSION_V2,
      jobId, role: 'tech_lead', type: 'NEXT_GOAL_PLANNING',
      goal: goalId, round: accepted.decision.round,
      worktree: absPlan,
      routing: toJobRouting(planningRouting),
      planningContext: {
        closedGoal: goalId,
        closedGoalPath: goal.goalPath,
        closedGoalDecision: 'ACCEPTED',
        previousMigrationBaseline: previousBaseline,
        // The Goal being written must declare exactly this SHA.
        migrationAcceptedBaseline: newBaseline,
        sourceClosureCommit: closure.sourceClosureCommit,
        integratedClosureCommit: closure.integratedClosureCommit,
        closureDocuments: closure.closureDocs ?? [],
        writeScope: CLOSURE_WRITE_PREFIX,
        instruction: 'Escreva SOMENTE o próximo Goal e marque apenas ele READY.',
        ...(feedback ? { priorAttemptFeedback: feedback } : {}),
      },
    });
    emit(`Planning job published: ${jobId}`);
    await persistClosure({ planningJobId: jobId }, machine.state);

    const envelope = await waitForResult(store, 'tech_lead', jobId, { leaseStore });
    return { jobId, envelope };
  }

  // Applies a successfully validated PlanningDecision — profileStore, planStore
  // and their events, and finally closure.nextGoalId. Shared by every call site
  // below so recovering an already-completed envelope can never diverge from
  // what a fresh one does (see lib/planning-application.mjs for why that
  // divergence was the bug). Never called on a failed envelope.
  const applyPlanning = (envelope) => applyPlanningResult({
    envelope, goalId, absPlan, planningDiffBase, repoRoot: REPO_ROOT, emit,
    machineState: machine.state, persistClosure, profileStore, planStore, store,
  });

  /**
   * One directed retry when the planner's own output violated the contract.
   *
   * PLAN_INVALID is the one failure class whose remedy is another sample: the
   * inference completed, the Tech Lead answered, and the answer was malformed
   * — a unit id shaped `WU1` instead of `WU-001`, a gate with no scope. The
   * violation is a fact the next prompt can carry, which is what makes the
   * retry directed rather than a reroll.
   *
   * This lived ONLY on the re-entry path below, and the asymmetry was the bug:
   * the same failure got a retry when a person re-ran `ia-loop:close`, and
   * stopped the autonomous run as UNKNOWN_FATAL when it happened the first
   * time. Goal020 ended there — `Work Unit id "WU1" is not in the expected
   * shape`, seven minutes of Opus discarded, HUMAN_REQUIRED, and the campaign
   * frozen behind it because a closure that names no next Goal is read as a
   * stop by `reconcileCampaignPosition` (deliberately, and rightly).
   *
   * Every other failure still stops. This is a narrow instrument: a contract
   * violation in the answer, never a way to retry whatever is inconvenient.
   */
  async function planningWithDirectedRetry({ jobId, envelope }) {
    if (envelope.ok) return envelope;

    // The envelope's own `code` is the capacity/failure-taxonomy REASON (e.g.
    // UNKNOWN_FATAL), not the underlying contract code — that lives only on
    // the AGENT_FAILURE event, which also carries the sanitized diagnostic
    // text a directed retry needs. `lib/planning-retry.mjs` owns that
    // distinction, and owns it in one place so the answer cannot depend on
    // which invocation is asking.
    const failureEvent = findPlanningFailureEvent(await store.readEvents(), jobId);
    const decision = classifyPlanningFailure({ envelope, failureEvent, jobId });

    if (decision.action !== PLANNING_FAILURE_ACTIONS.RETRY_WITH_FEEDBACK) {
      throw new SpikeError('PLANNING_FAILED', decision.message);
    }

    emit(decision.message);
    if (decision.diagnostic) emit(`  violation: ${decision.diagnostic}`);

    // A NEW jobId, so the invalid attempt stays on disk as history. The
    // feedback comes from the DECISION, not from the raw event: one place
    // normalised it, and reading around that place is how the two paths
    // drifted apart in the first place.
    const { envelope: retried } = await publishAndAwaitPlanning({
      feedback: {
        previousJobId: jobId,
        code: decision.code,
        diagnostic: decision.diagnostic,
      },
    });

    if (!retried.ok) {
      throw new SpikeError(
        'PLANNING_FAILED',
        `Directed retry also failed: [${retried.code}] ${retried.message}. `
        + 'Re-run ia-loop:close to retry again using this new violation as feedback.',
      );
    }
    return retried;
  }

  if (!closure.planningJobId) {
    machine.transitionTo(LOOP_STATES.NEXT_GOAL_PLANNING);
    const { jobId, envelope } = await publishAndAwaitPlanning();
    await applyPlanning(await planningWithDirectedRetry({ jobId, envelope }));
  } else {
    machine.transitionTo(LOOP_STATES.NEXT_GOAL_PLANNING);

    if (closure.nextGoalId) {
      emit(`Planning already done (job ${closure.planningJobId}), next Goal ${closure.nextGoalId}.`);
    } else {
      const priorEnvelope = await store.readResult('tech_lead', closure.planningJobId);

      if (priorEnvelope === null) {
        // No result recorded at all: the job may still be running, or the
        // worker crashed before ever publishing. Neither case is safe to
        // guess through — worktree recovery below assumes a completed,
        // validated inference, and a directed retry needs the real violation.
        throw new SpikeError(
          'PLANNING_RESULT_MISSING',
          `No result recorded yet for planning job ${closure.planningJobId}. `
          + 'If the tech_lead worker is still running, wait for it; if it crashed, use ia-loop:recover.',
        );
      } else if (priorEnvelope.ok) {
        // priorEnvelope IS the completed, validated PlanningDecision — the same
        // shape `applyPlanningResult` already knows how to apply. Re-deriving
        // nextGoalId from a raw worktree diff here (as this branch used to)
        // duplicated that logic AND silently dropped everything next to it in
        // the same result: the developer profile and the execution plan were
        // never persisted, so the Goal ran the single-unit compatibility
        // fallback instead of the DAG the Tech Lead actually produced and had
        // approved. That is exactly what happened resuming Goal009: nextGoalId
        // 010 got recorded, its 20-unit plan and OPUS_HIGH profile did not.
        emit(`Planning job ${closure.planningJobId} already ran; applying its recorded result.`);
        await applyPlanning(priorEnvelope);
      } else {
        // A completed, validated inference never reached this envelope: the
        // Tech Lead's own answer was rejected (a contract violation, e.g.
        // PLAN_INVALID), not lost to a harness crash. Worktree recovery would
        // silently accept whatever the worktree happens to hold — exactly the
        // "edit the plan to make it pass" shortcut this must not take.
        //
        // Same instrument the first attempt uses, so the two can never drift:
        // whether the violation happened moments ago or on a previous run, it
        // is the same failure and it gets the same directed retry.
        await applyPlanning(await planningWithDirectedRetry({
          jobId: closure.planningJobId,
          envelope: priorEnvelope,
        }));
      }
    }
  }
  emit('');

  // ---------- Commit and integrate the planning ---------------------------
  if (!closure.sourcePlanningCommit) {
    const planChanges = await collectWorktreeChanges(absPlan, planningDiffBase);
    assertClosureScope(planChanges.changedFiles);

    const { sha } = await stageAndCommit({
      cwd: absPlan,
      paths: planChanges.changedFiles,
      message: `docs(migration): close Goal${goalId} and prepare next goal`,
    });
    emit(`  sourcePlanningCommit: ${sha}`);
    await persistClosure({ sourcePlanningCommit: sha }, machine.state);
  }

  if (!closure.planningIntegrationCommit) {
    if (await probe.isDirty()) throw new SpikeError('MAIN_CHECKOUT_DIRTY', 'Main must be clean before integrating the planning.');
    const { after } = await cherryPick({ repoRoot: REPO_ROOT, sha: closure.sourcePlanningCommit });
    emit(`  planningIntegrationCommit: ${after}`);
    await persistClosure({ planningIntegrationCommit: after }, LOOP_STATES.NEXT_GOAL_READY);
  }
  machine.transitionTo(LOOP_STATES.NEXT_GOAL_READY);

  // ---------- Supervised stop ---------------------------------------------
  machine.transitionTo(LOOP_STATES.AWAITING_HUMAN);
  const mainHead = await probe.head();

  await store.writeRuntime({
    ...(await store.readRuntime()),
    state: machine.state,
    closure,
    // The baseline is the INTEGRATED closure commit, never the planning commit
    // that came after it.
    migrationAcceptedBaseline: newBaseline,
    goalClosed: true,
    nextGoalExecuted: false,
  });
  await store.appendEvent({
    type: 'GOAL_CLOSED', goal: goalId,
    sourceClosureCommit: closure.sourceClosureCommit,
    integratedClosureCommit: closure.integratedClosureCommit,
    newMigrationBaseline: newBaseline,
    nextGoalId: closure.nextGoalId,
  });

  emit('State:');
  for (const t of machine.history) emit(`  ${t.from} -> ${t.to}`);
  emit('');
  emit(`Goal ${goalId}: ACCEPTED and closed`);
  emit(`sourceClosureCommit:       ${closure.sourceClosureCommit}`);
  emit(`integratedClosureCommit:   ${closure.integratedClosureCommit}`);
  emit(`newMigrationBaseline:      ${newBaseline}`);
  emit(`previousBaseline:          ${previousBaseline}`);
  emit(closure.migrationComplete
    ? `migration:                 COMPLETE — ${closure.migrationCompleteReason}`
    : `next Goal:                 ${closure.nextGoalId} — ${closure.nextGoalTitle} (READY)`);
  emit(`sourcePlanningCommit:      ${closure.sourcePlanningCommit}`);
  emit(`planningIntegrationCommit: ${closure.planningIntegrationCommit}`);
  emit(`main HEAD:                 ${mainHead}`);
  emit('');
  emit(`State: ${machine.state}`);
  emit('');
  emit('Next Goal executed: NO');
  emit('Worktrees preserved. No push, no merge, no PR.');
  return 0;
}

// Only when this file IS the program. Importing it — from a test, a doc
// generator, or an agent reading the tooling — must never start anything.
if (isDirectExecution(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      const code = error instanceof SpikeError ? error.code : 'UNEXPECTED_ERROR';
      console.error(`\nIA Loop — Goal Closure\n\nBlocker: [${code}] ${error.message}\n\nState: HUMAN_REQUIRED`);
      process.exitCode = 1;
    });
}
