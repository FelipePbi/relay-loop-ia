/**
 * A pause armed by the operator belongs to the campaign, not to a run id.
 *
 * Written from Goal 014: `ia-loop:pause --after-goal` was armed, then
 * `ia-loop:auto --from 014` archived that run and minted a new one with
 * `pauseAfterGoal: false`. The loop closed Goal 014 exactly as asked and then
 * started Goal 015 by itself, spending $6.71 before anyone noticed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RUN_STATUS, createAutonomousStore, shouldPauseAt } from '../lib/autonomous-state.mjs';

const BASELINE = 'b'.repeat(40);

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-pause-'));
  try {
    return await run(createAutonomousStore(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** Drives a run to the state `--from` requires: stopped, then archived. */
async function armThenArchive(auto, { afterGoal }) {
  await auto.start({ fromGoal: '014', migrationAcceptedBaseline: BASELINE });
  await auto.requestPause({ afterGoal });
  await auto.markHumanRequired('GOAL_BOUNDARY_AMBIGUOUS', 'main checkout is dirty');
  const archived = await auto.archiveRun({ resolvedBy: 'operator', note: 'checkout limpo' });
  await auto.releaseLoopLease();
  return archived;
}

test('a pause armed for AFTER THE GOAL survives the run being retired by --from', async () => {
  await withStore(async (auto) => {
    const archived = await armThenArchive(auto, { afterGoal: true });
    assert.equal(archived.pauseRequested, true, 'precondition: the archived run carried the intent');

    const next = await auto.start({
      fromGoal: '015', migrationAcceptedBaseline: BASELINE, inheritPause: archived,
    });

    assert.equal(next.pauseRequested, true);
    assert.equal(next.pauseAfterGoal, true);
    assert.deepEqual(
      shouldPauseAt(next, { boundary: 'GOAL_BOUNDARY' }),
      { pause: true, reason: 'PAUSE_REQUESTED_AFTER_GOAL' },
      'the new run stops at the end of its Goal instead of starting another',
    );
  });
});

test('a pause armed for the NEXT BOUNDARY survives too, without becoming an after-goal pause', async () => {
  await withStore(async (auto) => {
    const archived = await armThenArchive(auto, { afterGoal: false });
    const next = await auto.start({
      fromGoal: '015', migrationAcceptedBaseline: BASELINE, inheritPause: archived,
    });

    assert.equal(next.pauseRequested, true);
    assert.equal(next.pauseAfterGoal, false, 'the stricter intent must not be relaxed into a looser one');
    assert.equal(shouldPauseAt(next, { boundary: 'AFTER_DECISION' }).pause, true);
  });
});

test('a run retired WITHOUT a pause armed starts unpaused, as before', async () => {
  await withStore(async (auto) => {
    await auto.start({ fromGoal: '014', migrationAcceptedBaseline: BASELINE });
    await auto.markHumanRequired('GOAL_BOUNDARY_AMBIGUOUS', 'main checkout is dirty');
    const archived = await auto.archiveRun({ resolvedBy: 'operator', note: 'resolvido' });
    await auto.releaseLoopLease();

    const next = await auto.start({
      fromGoal: '015', migrationAcceptedBaseline: BASELINE, inheritPause: archived,
    });

    assert.equal(next.pauseRequested, false);
    assert.equal(next.pauseAfterGoal, false);
    assert.equal(shouldPauseAt(next, { boundary: 'GOAL_BOUNDARY' }).pause, false);
  });
});

test('pauseAfterGoal is never inherited on its own, without the request that gives it meaning', async () => {
  await withStore(async (auto) => {
    const next = await auto.start({
      fromGoal: '015',
      migrationAcceptedBaseline: BASELINE,
      // A record that could only come from a corrupted or hand-edited file.
      inheritPause: { pauseRequested: false, pauseAfterGoal: true },
    });
    assert.equal(next.pauseAfterGoal, false);
    assert.equal(next.status, RUN_STATUS.RUNNING);
  });
});

test('no inheritance argument at all behaves exactly as before', async () => {
  await withStore(async (auto) => {
    const run = await auto.start({ fromGoal: '014', migrationAcceptedBaseline: BASELINE });
    assert.equal(run.pauseRequested, false);
    assert.equal(run.pauseAfterGoal, false);
  });
});
