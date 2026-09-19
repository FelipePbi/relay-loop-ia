/**
 * Classifying an orchestrator-internal defect (INVALID_TRANSITION and
 * friends) so `run-auto.mjs` — a SEPARATE process that only sees an exit
 * code and whatever is on disk — never reads it as UNKNOWN_FATAL, the same
 * label a genuinely inexplicable model failure gets.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJobStore } from '../lib/job-store.mjs';
import { SpikeError } from '../lib/claude-process.mjs';
import { classifyOrchestratorFault, recordOrchestratorFault } from '../lib/orchestrator-fault.mjs';

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-orch-fault-'));
  try {
    return await run(createJobStore(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('INVALID_TRANSITION classifies as HARNESS_ERROR', () => {
  const error = new SpikeError('INVALID_TRANSITION', 'Transition WORKTREE_READY -> ACCEPTED is not allowed');
  assert.equal(classifyOrchestratorFault(error), 'HARNESS_ERROR');
});

test('UNKNOWN_STATE classifies as HARNESS_ERROR', () => {
  assert.equal(classifyOrchestratorFault(new SpikeError('UNKNOWN_STATE', 'x')), 'HARNESS_ERROR');
});

test('HYDRATION_EVIDENCE_REQUIRED classifies as HARNESS_ERROR', () => {
  assert.equal(classifyOrchestratorFault(new SpikeError('HYDRATION_EVIDENCE_REQUIRED', 'x')), 'HARNESS_ERROR');
});

test('an unrelated SpikeError is never reclassified', () => {
  assert.equal(classifyOrchestratorFault(new SpikeError('WORKERS_NOT_RUNNING', 'x')), null);
  assert.equal(classifyOrchestratorFault(new SpikeError('DUPLICATE_COMPLETED_STAGE_DISPATCH', 'x')), null);
});

// The real incident: reconciliation resumed Goal007 straight into REVIEW
// (Developer R2 already COMPLETED), but run-goal.mjs still built a
// hypothetical CORRECTION job from an empty blocker list to decide whether to
// reuse it, and validateDeveloperJob correctly refused that shape. The
// refusal is about THIS TOOLING's own bookkeeping — never about the Goal, the
// worker or the model — even though validateDeveloperResult/
// validateReviewDecision throw the identical code for a contract a MODEL
// broke. What tells the two apart is not the code, it is WHERE it is thrown:
// this test is only meaningful for the run-goal.mjs job-construction call
// sites, which throw uncaught, straight into this catch.
test('CONTRACT_FIELD_INVALID from building an outgoing job classifies as HARNESS_ERROR', () => {
  const error = new SpikeError('CONTRACT_FIELD_INVALID', 'A CORRECTION job must carry at least one blocker');
  assert.equal(classifyOrchestratorFault(error), 'HARNESS_ERROR');
});

test('recordOrchestratorFault overwrites a stale reason from an already-resolved gate', async () => {
  await withStore(async (store) => {
    // A previous, unrelated, already human-resolved failure left this behind.
    await store.writeRuntime({ goal: '007', round: 2, state: 'WORKTREE_READY', escalationReason: 'POLICY_VIOLATION' });

    const error = new SpikeError('CONTRACT_FIELD_INVALID', 'A CORRECTION job must carry at least one blocker');
    const outcome = await recordOrchestratorFault(store, { goal: '007', error });
    assert.equal(outcome.classification, 'HARNESS_ERROR');

    const runtime = await store.readRuntime();
    assert.equal(runtime.escalationReason, 'HARNESS_ERROR', 'the NEW failure\'s reason, never the stale one');
  });
});

test('a plain, non-SpikeError Error is never classified', () => {
  assert.equal(classifyOrchestratorFault(new Error('boom')), null);
});

test('null/undefined never classify', () => {
  assert.equal(classifyOrchestratorFault(null), null);
  assert.equal(classifyOrchestratorFault(undefined), null);
});

test('recordOrchestratorFault writes escalationReason and an audit event for a matching goal', async () => {
  await withStore(async (store) => {
    await store.writeRuntime({ goal: '005', round: 2, state: 'WORKTREE_READY', decision: 'ACCEPTED' });
    const error = new SpikeError('INVALID_TRANSITION', 'Transition WORKTREE_READY -> ACCEPTED is not allowed', {
      from: 'WORKTREE_READY', to: 'ACCEPTED',
    });

    const outcome = await recordOrchestratorFault(store, { goal: '005', error });
    assert.equal(outcome.recorded, true);
    assert.equal(outcome.classification, 'HARNESS_ERROR');

    const runtime = await store.readRuntime();
    assert.equal(runtime.escalationReason, 'HARNESS_ERROR');
    // Untouched: the fault is recorded alongside the facts, not over them.
    assert.equal(runtime.decision, 'ACCEPTED');

    const events = await store.readEvents();
    const fault = events.find((e) => e.type === 'ORCHESTRATOR_FAULT');
    assert.equal(fault.code, 'INVALID_TRANSITION');
    assert.equal(fault.classification, 'HARNESS_ERROR');
    assert.equal(fault.goal, '005');
  });
});

test('recordOrchestratorFault never writes across a Goal boundary', async () => {
  await withStore(async (store) => {
    await store.writeRuntime({ goal: '006', round: 1, state: 'WORKTREE_READY' });
    const error = new SpikeError('INVALID_TRANSITION', 'x');

    const outcome = await recordOrchestratorFault(store, { goal: '005', error });
    assert.equal(outcome.recorded, true, 'the event is still recorded — the audit trail is never lost');

    const runtime = await store.readRuntime();
    assert.equal(runtime.goal, '006', 'a fault attributed to 005 must never touch 006\'s runtime');
    assert.equal(runtime.escalationReason, undefined);
  });
});

test('recordOrchestratorFault does nothing for a non-fault error', async () => {
  await withStore(async (store) => {
    await store.writeRuntime({ goal: '005', state: 'WORKTREE_READY' });
    const outcome = await recordOrchestratorFault(store, { goal: '005', error: new SpikeError('WORKERS_NOT_RUNNING', 'x') });
    assert.equal(outcome.recorded, false);
    assert.equal(outcome.classification, null);
    const events = await store.readEvents();
    assert.equal(events.length, 0);
  });
});

test('recordOrchestratorFault does nothing without a goal', async () => {
  await withStore(async (store) => {
    const outcome = await recordOrchestratorFault(store, { goal: null, error: new SpikeError('INVALID_TRANSITION', 'x') });
    assert.equal(outcome.recorded, false);
    const events = await store.readEvents();
    assert.equal(events.length, 0);
  });
});
