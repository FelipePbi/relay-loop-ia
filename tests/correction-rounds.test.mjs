/**
 * V4 correction rounds: round budget, job terminality, running-state
 * persistence and harness-error classification. No model is called.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LOOP_CONFIG, ESCALATION_REASONS, planAfterReview } from '../lib/loop-config.mjs';
import { LOOP_STATES, createLoopStateMachine } from '../lib/loop-state.mjs';
import { buildCorrectionContext } from '../lib/context-builders.mjs';
import { createJobStore, isTerminalJobStatus, JOB_STATUSES } from '../lib/job-store.mjs';
import { CAPACITY_REASONS, classifyFailure, isHarnessError } from '../lib/capacity-classifier.mjs';
import { CAPACITY_ACTIONS, decideCapacityAction } from '../lib/capacity-policy.mjs';
import { PROTOCOL_VERSION_V2, validateDeveloperJob } from '../lib/contracts-v2.mjs';

const codeIs = (code) => (error) => error.code === code;
const BASELINE = '1e874e2785d2bc78860db0eb571ea901a4395c17';
const INITIAL_HEAD = '99a7210101f481b994a008a57c4f663bc3d5c566';
const NOW = Date.parse('2026-09-07T10:00:00.000Z');

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-v4-'));
  try { return await run(createJobStore(dir), dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

// --- Round budget ----------------------------------------------------------

test('CHANGES_REQUIRED on round 1 starts correction round 2', () => {
  const plan = planAfterReview({ decision: 'CHANGES_REQUIRED', round: 1 });
  assert.equal(plan.action, 'CORRECT');
  assert.equal(plan.nextRound, 2);
});

test('CHANGES_REQUIRED on round 2 starts correction round 3', () => {
  const plan = planAfterReview({ decision: 'CHANGES_REQUIRED', round: 2 });
  assert.equal(plan.action, 'CORRECT');
  assert.equal(plan.nextRound, 3);
});

test('CHANGES_REQUIRED on round 3 escalates instead of starting round 4', () => {
  const plan = planAfterReview({ decision: 'CHANGES_REQUIRED', round: 3 });
  assert.equal(plan.action, 'STOP');
  assert.equal(plan.decision, 'HUMAN_REQUIRED');
  assert.equal(plan.reason, ESCALATION_REASONS.MAX_CORRECTION_ROUNDS_REACHED);
});

test('the round budget is one named value, not scattered', () => {
  assert.equal(LOOP_CONFIG.maxCorrectionRounds, 3);
  const tighter = { ...LOOP_CONFIG, maxCorrectionRounds: 1 };
  assert.equal(planAfterReview({ decision: 'CHANGES_REQUIRED', round: 1, config: tighter }).action, 'STOP');
});

test('ACCEPTED and HUMAN_REQUIRED stop regardless of round', () => {
  for (const round of [1, 2, 3]) {
    assert.equal(planAfterReview({ decision: 'ACCEPTED', round }).action, 'STOP');
    assert.equal(planAfterReview({ decision: 'ACCEPTED', round }).decision, 'ACCEPTED');
    assert.equal(planAfterReview({ decision: 'HUMAN_REQUIRED', round }).action, 'STOP');
  }
});

// --- State machine ---------------------------------------------------------

function toDecision(m) {
  m.transitionTo(LOOP_STATES.GOAL_READY);
  m.transitionTo(LOOP_STATES.PREPARING_WORKTREE);
  m.transitionTo(LOOP_STATES.WORKTREE_READY);
  m.transitionTo(LOOP_STATES.DEVELOPER_QUEUED);
  m.transitionTo(LOOP_STATES.DEVELOPER_RUNNING);
  m.transitionTo(LOOP_STATES.REVIEW_REQUIRED);
  m.transitionTo(LOOP_STATES.REVIEWER_QUEUED);
  m.transitionTo(LOOP_STATES.REVIEWER_RUNNING);
  return m;
}

test('the full correction cycle is a legal path', () => {
  const m = toDecision(createLoopStateMachine());
  m.transitionTo(LOOP_STATES.CHANGES_REQUIRED);
  m.transitionTo(LOOP_STATES.CORRECTION_QUEUED);
  m.transitionTo(LOOP_STATES.CORRECTION_RUNNING);
  m.transitionTo(LOOP_STATES.REVIEW_REQUIRED);
  m.transitionTo(LOOP_STATES.REVIEWER_QUEUED);
  m.transitionTo(LOOP_STATES.REVIEWER_RUNNING);
  m.transitionTo(LOOP_STATES.ACCEPTED);
  m.transitionTo(LOOP_STATES.AWAITING_HUMAN);

  assert.equal(m.state, LOOP_STATES.AWAITING_HUMAN);
});

test('a correction round never re-enters the initial implementation phase', () => {
  const m = toDecision(createLoopStateMachine());
  m.transitionTo(LOOP_STATES.CHANGES_REQUIRED);
  m.transitionTo(LOOP_STATES.CORRECTION_QUEUED);

  assert.equal(m.canTransitionTo(LOOP_STATES.DEVELOPER_QUEUED), false);
  assert.equal(m.canTransitionTo(LOOP_STATES.DEVELOPER_RUNNING), false);
  assert.equal(m.canTransitionTo(LOOP_STATES.CORRECTION_RUNNING), true);
});

test('every terminal decision still funnels through AWAITING_HUMAN', () => {
  for (const verdict of [LOOP_STATES.ACCEPTED, LOOP_STATES.CHANGES_REQUIRED, LOOP_STATES.HUMAN_REQUIRED]) {
    const m = toDecision(createLoopStateMachine());
    m.transitionTo(verdict);
    assert.equal(m.canTransitionTo(LOOP_STATES.AWAITING_HUMAN), true, verdict);
    assert.equal(m.canTransitionTo(LOOP_STATES.STOPPED), false, verdict);
  }
});

test('a capacity wait can resume into a correction phase', () => {
  const m = toDecision(createLoopStateMachine());
  m.transitionTo(LOOP_STATES.CHANGES_REQUIRED);
  m.transitionTo(LOOP_STATES.CORRECTION_QUEUED);
  m.transitionTo(LOOP_STATES.WAITING_FOR_CAPACITY);

  assert.equal(m.canTransitionTo(LOOP_STATES.CORRECTION_QUEUED), true);
  assert.equal(m.canTransitionTo(LOOP_STATES.CORRECTION_RUNNING), true);
});

// --- Correction context ----------------------------------------------------

const correctionArgs = {
  goal: '003',
  goalPath: 'docs/migration/goals/003-x.md',
  round: 2,
  previousRound: 1,
  migrationAcceptedBaseline: BASELINE,
  executionBase: INITIAL_HEAD,
  worktreeInitialHead: INITIAL_HEAD,
  worktree: '/repo/.ai-worktrees/goal-003',
  blockers: ['003-R1-01 CSRF cross-host', '003-R1-02 eventos inbound', '003-R1-03 vínculo pendente'],
  previousImplementationReport: 'relatório R1',
  previousDecision: 'CHANGES_REQUIRED',
  changedFiles: ['apps/bff/src/lib/auth.ts'],
};

test('the correction context carries the blockers and the original baselines', () => {
  const ctx = buildCorrectionContext(correctionArgs);

  assert.equal(ctx.type, 'CORRECTION');
  assert.equal(ctx.round, 2);
  assert.equal(ctx.blockers.length, 3);
  // The baselines never move between rounds.
  assert.equal(ctx.worktreeInitialHead, INITIAL_HEAD);
  assert.equal(ctx.executionBase, INITIAL_HEAD);
  assert.equal(ctx.migrationAcceptedBaseline, BASELINE);
  assert.match(ctx.scope, /SOMENTE os blockers/);
});

test('the correction context never carries a transcript or conversation history', () => {
  const serialized = JSON.stringify(buildCorrectionContext(correctionArgs));
  for (const forbidden of ['transcript', 'conversation', 'messages', 'history', 'sessionId']) {
    assert.ok(!serialized.includes(forbidden), `must not carry "${forbidden}"`);
  }
});

test('a correction round without blockers is refused', () => {
  assert.throws(() => buildCorrectionContext({ ...correctionArgs, blockers: [] }), codeIs('INVALID_ARGS'));
});

test('a correction round is never round 1', () => {
  assert.throws(() => buildCorrectionContext({ ...correctionArgs, round: 1 }), codeIs('INVALID_ARGS'));
});

test('a CORRECTION job keeps the original baselines and requires blockers', () => {
  const job = validateDeveloperJob({
    protocolVersion: PROTOCOL_VERSION_V2,
    jobId: '003-r2-correction-abc', role: 'developer', goal: '003', round: 2,
    type: 'CORRECTION',
    migrationAcceptedBaseline: BASELINE,
    executionBase: INITIAL_HEAD,
    worktreeInitialHead: INITIAL_HEAD,
    worktree: '/repo/.ai-worktrees/goal-003',
    goalPath: 'p.md',
    blockers: ['fix this'],
  });

  assert.equal(job.type, 'CORRECTION');
  assert.equal(job.executionBase, INITIAL_HEAD);
  assert.notEqual(job.migrationAcceptedBaseline, job.executionBase);
});

// --- Job terminality -------------------------------------------------------

test('a FAILED job is never claimable again', async () => {
  await withStore(async (store) => {
    const job = validateDeveloperJob({
      protocolVersion: PROTOCOL_VERSION_V2,
      jobId: 'j1', role: 'developer', goal: '003', round: 1, type: 'IMPLEMENTATION',
      migrationAcceptedBaseline: BASELINE, executionBase: INITIAL_HEAD,
      worktree: '/w', goalPath: 'p.md', blockers: [],
    });
    await store.publishJob('developer', job);

    assert.equal(await store.isJobClaimable('developer', 'j1'), true, 'a QUEUED job is claimable');

    await store.setJobStatus('developer', 'j1', 'FAILED');
    assert.equal(await store.isJobClaimable('developer', 'j1'), false, 'a FAILED job must not be re-run');

    // History is preserved, not deleted.
    assert.equal(await store.readJobStatus('developer', 'j1'), 'FAILED');
  });
});

test('COMPLETED and SUPERSEDED are terminal too; RUNNING is not', async () => {
  await withStore(async (store) => {
    const job = validateDeveloperJob({
      protocolVersion: PROTOCOL_VERSION_V2,
      jobId: 'j2', role: 'developer', goal: '003', round: 1, type: 'IMPLEMENTATION',
      migrationAcceptedBaseline: BASELINE, executionBase: INITIAL_HEAD,
      worktree: '/w', goalPath: 'p.md', blockers: [],
    });
    await store.publishJob('developer', job);

    for (const [status, claimable] of [['RUNNING', true], ['WAITING_FOR_CAPACITY', true], ['COMPLETED', false], ['SUPERSEDED', false]]) {
      await store.setJobStatus('developer', 'j2', status);
      assert.equal(await store.isJobClaimable('developer', 'j2'), claimable, status);
    }
  });
});

test('terminal statuses are declared explicitly', () => {
  assert.ok(JOB_STATUSES.includes('SUPERSEDED'));
  assert.equal(isTerminalJobStatus('FAILED'), true);
  assert.equal(isTerminalJobStatus('COMPLETED'), true);
  assert.equal(isTerminalJobStatus('SUPERSEDED'), true);
  assert.equal(isTerminalJobStatus('RUNNING'), false);
  assert.equal(isTerminalJobStatus('QUEUED'), false);
});

test('each round gets a distinct job id', async () => {
  await withStore(async (store) => {
    const r1 = store.newJobId('003', 1, 'developer');
    const r2 = store.newJobId('003', 2, 'correction');
    const rev2 = store.newJobId('003', 2, 'tech_lead');

    assert.match(r1, /^003-r1-developer-/);
    assert.match(r2, /^003-r2-correction-/);
    assert.match(rev2, /^003-r2-tech_lead-/);
    assert.notEqual(r1, r2);
  });
});

// --- Harness error classification -----------------------------------------

test('ENAMETOOLONG is a harness error, never a capacity limit', () => {
  // Regression: the first real Goal003 run logged this as CAPACITY_LIMIT_REACHED
  // / UNKNOWN_FATAL, which is semantically wrong — no model limit was involved.
  const outcome = {
    error: { code: 'SPAWN_FAILED', message: 'Failed to spawn claude.exe: spawn ENAMETOOLONG' },
    structuredOutput: false,
  };
  const classification = classifyFailure(outcome);

  assert.equal(classification.reason, CAPACITY_REASONS.HARNESS_ERROR);
  assert.equal(isHarnessError(classification.reason), true);
  assert.notEqual(classification.reason, CAPACITY_REASONS.RATE_LIMIT);
  assert.notEqual(classification.reason, CAPACITY_REASONS.USAGE_LIMIT);
});

test('a harness error escalates and never waits for capacity', () => {
  const decision = decideCapacityAction({ reason: CAPACITY_REASONS.HARNESS_ERROR, attempt: 1, now: NOW });

  assert.equal(decision.action, CAPACITY_ACTIONS.HUMAN_REQUIRED);
  assert.equal(decision.nextRetryAt, null, 'a local failure is not waited out');
  assert.match(decision.note, /Local harness failure/);
});

test('other local spawn failures classify as harness errors too', () => {
  for (const message of ['spawn E2BIG', 'argument list too long', 'spawn claude ENOENT']) {
    const reason = classifyFailure({ error: { code: 'NON_ZERO_EXIT', message }, structuredOutput: false }).reason;
    assert.equal(reason, CAPACITY_REASONS.HARNESS_ERROR, message);
  }
});

test('a real rate limit is still a capacity limit, not a harness error', () => {
  const reason = classifyFailure({
    error: { code: 'NON_ZERO_EXIT', message: 'API Error: 429 rate_limit_error' },
    structuredOutput: false,
  }).reason;
  assert.equal(reason, CAPACITY_REASONS.RATE_LIMIT);
  assert.equal(isHarnessError(reason), false);
});

test('a resumed execution can re-enter directly at a correction round', () => {
  // Regression: resuming a Goal that already finished round 1 lands in
  // WORKTREE_READY and must be able to start a correction, not be forced back
  // through the initial implementation phase.
  const m = createLoopStateMachine();
  m.transitionTo(LOOP_STATES.GOAL_READY);
  m.transitionTo(LOOP_STATES.PREPARING_WORKTREE);
  m.transitionTo(LOOP_STATES.WORKTREE_READY);

  assert.equal(m.canTransitionTo(LOOP_STATES.CORRECTION_QUEUED), true);
  m.transitionTo(LOOP_STATES.CORRECTION_QUEUED);
  m.transitionTo(LOOP_STATES.CORRECTION_RUNNING);
  assert.equal(m.state, LOOP_STATES.CORRECTION_RUNNING);
});

test('the protocol version is pinned in the schemas handed to the CLI', async () => {
  // Regression: an open {type:'integer'} let a model answer protocolVersion 1,
  // and the mismatch only surfaced after the inference was already paid for.
  const { DEVELOPER_RESULT_SCHEMA, REVIEW_DECISION_SCHEMA } = await import('../lib/contracts-v2.mjs');

  assert.deepEqual(DEVELOPER_RESULT_SCHEMA.properties.protocolVersion.enum, [PROTOCOL_VERSION_V2]);
  assert.deepEqual(REVIEW_DECISION_SCHEMA.properties.protocolVersion.enum, [PROTOCOL_VERSION_V2]);
});

test('a contract slip is retryable, not fatal', () => {
  // Burning a whole round over a wrong version number would be the wrong trade.
  for (const code of ['UNSUPPORTED_PROTOCOL_VERSION', 'ROLE_MISMATCH', 'ROUND_MISMATCH', 'CONTRACT_FIELD_INVALID']) {
    const reason = classifyFailure({ error: { code, message: 'contract slip' }, structuredOutput: false }).reason;
    assert.equal(reason, CAPACITY_REASONS.UNKNOWN_TRANSIENT, code);
    assert.equal(decideCapacityAction({ reason, attempt: 1, now: NOW }).action, CAPACITY_ACTIONS.WAIT, code);
  }
});

test('a contract slip still escalates once the transient budget runs out', () => {
  const reason = CAPACITY_REASONS.UNKNOWN_TRANSIENT;
  assert.equal(decideCapacityAction({ reason, attempt: 4, now: NOW }).action, CAPACITY_ACTIONS.HUMAN_REQUIRED);
});

test('a correction round is resumable after a capacity wait', async () => {
  // Regression: CORRECTION_* were missing from the resumable set, so persisting
  // a capacity wait during a correction failed and the job was marked FAILED.
  const { validateWaitingRuntime } = await import('../lib/capacity-state.mjs');
  const iso = new Date(NOW).toISOString();

  for (const resumeFrom of [LOOP_STATES.CORRECTION_QUEUED, LOOP_STATES.CORRECTION_RUNNING]) {
    const runtime = {
      goal: '003', round: 2, blockedAgent: 'developer', resumeFrom,
      capacity: { reason: 'RATE_LIMIT', attempt: 1, firstSeenAt: iso, lastAttemptAt: iso, nextRetryAt: iso, retryIntervalMs: 30_000 },
    };
    assert.equal(validateWaitingRuntime(runtime).resumeFrom, resumeFrom);
  }
});

test('identity fields are pinned in the per-call schema', async () => {
  // Regression: a model answered jobId "003" (the goal) instead of the job id.
  const { developerResultSchemaFor, reviewDecisionSchemaFor } = await import('../lib/contracts-v2.mjs');
  const ids = { jobId: '003-r2-correction-abc', goal: '003', round: 2 };

  for (const schema of [developerResultSchemaFor(ids), reviewDecisionSchemaFor(ids)]) {
    assert.deepEqual(schema.properties.jobId.enum, [ids.jobId]);
    assert.deepEqual(schema.properties.goal.enum, [ids.goal]);
    assert.deepEqual(schema.properties.round.enum, [ids.round]);
    assert.deepEqual(schema.properties.protocolVersion.enum, [PROTOCOL_VERSION_V2]);
  }
});
