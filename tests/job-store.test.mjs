/**
 * Job store, worker heartbeat and V2 contract tests. No model calls.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJobStore, readJson, writeJsonAtomic } from '../lib/job-store.mjs';
import {
  WORKER_HEALTH,
  healthFromHeartbeat,
  readWorkerHealth,
  writeHeartbeat,
} from '../lib/worker-registry.mjs';
import {
  PROTOCOL_VERSION_V2,
  validateDeveloperJob,
  validateDeveloperResult,
  validateReviewDecision,
  validateReviewJob,
} from '../lib/contracts-v2.mjs';

const codeIs = (code) => (error) => error.code === code;

const BASELINE = '1e874e2785d2bc78860db0eb571ea901a4395c17';
const EXEC_BASE = '0e77cb6cddc1da015e188cf7cdb55a5ff3b2ce60';

async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-store-'));
  try {
    return await run(createJobStore(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function developerJob(overrides = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION_V2,
    jobId: 'job-1',
    role: 'developer',
    goal: '003',
    round: 1,
    type: 'IMPLEMENTATION',
    migrationAcceptedBaseline: BASELINE,
    executionBase: EXEC_BASE,
    worktree: '.ai-worktrees/goal-003',
    goalPath: 'docs/migration/goals/003-x.md',
    blockers: [],
    ...overrides,
  };
}

function reviewJob(overrides = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION_V2,
    jobId: 'job-2',
    role: 'tech_lead',
    goal: '003',
    round: 1,
    developerJobId: '003-r1-developer-aaaa1111',
    reviewLevel: 'DEEP',
    migrationAcceptedBaseline: BASELINE,
    executionBase: EXEC_BASE,
    worktree: '.ai-worktrees/goal-003',
    goalPath: 'docs/migration/goals/003-x.md',
    changedFiles: ['apps/bff/src/lib/auth.ts'],
    implementationReport: 'Relatório.',
    previousBlockers: [],
    ...overrides,
  };
}

// --- Atomic write ----------------------------------------------------------

test('atomic write leaves no temp file and produces readable JSON', async () => {
  await withStore(async (store, dir) => {
    const path = join(dir, 'nested', 'value.json');
    await writeJsonAtomic(path, { a: 1 });

    assert.deepEqual(await readJson(path), { a: 1 });
    await assert.rejects(readFile(`${path}.${process.pid}.tmp`, 'utf8'));
  });
});

test('a corrupt file is refused, never silently zeroed', async () => {
  await withStore(async (store, dir) => {
    const path = join(dir, 'broken.json');
    await writeFile(path, '{ not json', 'utf8');

    await assert.rejects(readJson(path), codeIs('FILE_CORRUPT'));
    // The bad content is still there for the operator to inspect.
    assert.equal(await readFile(path, 'utf8'), '{ not json');
  });
});

test('a missing file reads as null unless required', async () => {
  await withStore(async (store, dir) => {
    assert.equal(await readJson(join(dir, 'nope.json')), null);
    await assert.rejects(readJson(join(dir, 'nope.json'), { required: true }), codeIs('FILE_MISSING'));
  });
});

// --- Jobs ------------------------------------------------------------------

test('a job round-trips through the store', async () => {
  await withStore(async (store) => {
    const job = validateDeveloperJob(developerJob());
    await store.publishJob('developer', job);

    assert.deepEqual(await store.listJobs('developer'), ['job-1.json']);
    const read = await store.readJob('developer', 'job-1');
    assert.equal(read.goal, '003');
    assert.equal(read.round, 1);
  });
});

test('publishing the same job twice is refused', async () => {
  await withStore(async (store) => {
    const job = validateDeveloperJob(developerJob());
    await store.publishJob('developer', job);
    await assert.rejects(store.publishJob('developer', job), codeIs('DUPLICATE_JOB'));
  });
});

test('publishing a job to the wrong role is refused', async () => {
  await withStore(async (store) => {
    const job = validateDeveloperJob(developerJob());
    await assert.rejects(store.publishJob('tech_lead', job), codeIs('ROLE_MISMATCH'));
  });
});

test('an unknown role is refused', async () => {
  await withStore(async (store) => {
    await assert.rejects(store.listJobs('architect'), codeIs('UNKNOWN_ROLE'));
  });
});

test('listing jobs for a role with no queue yields an empty list', async () => {
  await withStore(async (store) => {
    assert.deepEqual(await store.listJobs('tech_lead'), []);
  });
});

test('the event log is append-only and ordered', async () => {
  await withStore(async (store) => {
    await store.appendEvent({ type: 'A' });
    await store.appendEvent({ type: 'B' });
    const events = await store.readEvents();

    assert.deepEqual(events.map((e) => e.type), ['A', 'B']);
    assert.ok(events.every((e) => e.at));
  });
});

test('a corrupt event log line is reported, not skipped', async () => {
  await withStore(async (store) => {
    await store.appendEvent({ type: 'A' });
    await writeFile(store.paths.events, '{"type":"A"}\nnot json\n', 'utf8');
    await assert.rejects(store.readEvents(), codeIs('EVENT_LOG_CORRUPT'));
  });
});

// --- Heartbeat -------------------------------------------------------------

test('heartbeat age maps to RUNNING, STALE and OFFLINE', () => {
  const now = Date.parse('2026-09-07T12:00:00.000Z');
  const at = (secondsAgo) => ({ lastHeartbeat: new Date(now - secondsAgo * 1000).toISOString() });

  assert.equal(healthFromHeartbeat(at(1), { now }).health, WORKER_HEALTH.RUNNING);
  assert.equal(healthFromHeartbeat(at(20), { now }).health, WORKER_HEALTH.STALE);
  assert.equal(healthFromHeartbeat(at(120), { now }).health, WORKER_HEALTH.OFFLINE);
});

test('a worker that never started reads as OFFLINE', async () => {
  await withStore(async (store) => {
    const health = await readWorkerHealth(store, 'developer');
    assert.equal(health.health, WORKER_HEALTH.OFFLINE);
    assert.equal(health.state, null);
  });
});

test('a heartbeat records role, state and strategy but truncates the session id', async () => {
  await withStore(async (store) => {
    await writeHeartbeat(store, 'tech_lead', {
      state: 'IDLE',
      model: 'claude-fable-5-1',
      sessionStrategy: 'PERSISTENT',
      sessionId: 'abcdef01-2345-6789-abcd-ef0123456789',
    });

    const health = await readWorkerHealth(store, 'tech_lead');
    assert.equal(health.health, WORKER_HEALTH.RUNNING);
    assert.equal(health.state, 'IDLE');
    assert.equal(health.sessionStrategy, 'PERSISTENT');
    assert.equal(health.sessionIdShort, 'abcdef01');

    const raw = await readJson(store.paths.worker('tech_lead'));
    assert.ok(!JSON.stringify(raw).includes('ef0123456789'), 'full session id must not be persisted in the heartbeat');
  });
});

test('an invalid worker state is refused', async () => {
  await withStore(async (store) => {
    await assert.rejects(
      writeHeartbeat(store, 'developer', { state: 'DANCING', model: 'm', sessionStrategy: 'STATELESS' }),
      codeIs('INVALID_ARGS'),
    );
  });
});

test('a corrupt heartbeat timestamp is reported', () => {
  assert.throws(() => healthFromHeartbeat({ lastHeartbeat: 'yesterday' }), codeIs('FILE_CORRUPT'));
});

// --- V2 contracts ----------------------------------------------------------

test('a valid DeveloperJob passes and keeps both baselines distinct', () => {
  const job = validateDeveloperJob(developerJob());
  assert.equal(job.migrationAcceptedBaseline, BASELINE);
  assert.equal(job.executionBase, EXEC_BASE);
  assert.notEqual(job.migrationAcceptedBaseline, job.executionBase);
});

test('a DeveloperJob addressed to the wrong role is refused', () => {
  assert.throws(() => validateDeveloperJob(developerJob({ role: 'tech_lead' })), codeIs('ROLE_MISMATCH'));
});

test('a malformed SHA is refused in either baseline', () => {
  assert.throws(() => validateDeveloperJob(developerJob({ migrationAcceptedBaseline: 'abc' })), codeIs('INVALID_SHA'));
  assert.throws(() => validateDeveloperJob(developerJob({ executionBase: 'HEAD' })), codeIs('INVALID_SHA'));
});

test('a CORRECTION job must carry blockers and IMPLEMENTATION must not', () => {
  assert.throws(
    () => validateDeveloperJob(developerJob({ type: 'CORRECTION', blockers: [] })),
    codeIs('CONTRACT_FIELD_INVALID'),
  );
  assert.throws(
    () => validateDeveloperJob(developerJob({ type: 'IMPLEMENTATION', blockers: ['x'] })),
    codeIs('CONTRACT_FIELD_INVALID'),
  );
  const correction = validateDeveloperJob(developerJob({ type: 'CORRECTION', blockers: ['corrigir X'] }));
  assert.equal(correction.blockers.length, 1);
});

test('a DeveloperResult must match its job, goal and round', () => {
  const base = {
    protocolVersion: PROTOCOL_VERSION_V2,
    jobId: 'job-1',
    goal: '003',
    round: 1,
    status: 'REVIEW_REQUIRED',
    summary: 'feito',
    implementationReport: 'relatório',
    validations: [{ name: 'test:gate', passed: true }],
  };
  const expected = { jobId: 'job-1', goal: '003', round: 1 };

  assert.equal(validateDeveloperResult(base, expected).status, 'REVIEW_REQUIRED');
  assert.throws(() => validateDeveloperResult({ ...base, jobId: 'other' }, expected), codeIs('JOB_ID_MISMATCH'));
  assert.throws(() => validateDeveloperResult({ ...base, goal: '004' }, expected), codeIs('GOAL_MISMATCH'));
  assert.throws(() => validateDeveloperResult({ ...base, round: 2 }, expected), codeIs('ROUND_MISMATCH'));
  assert.throws(() => validateDeveloperResult({ ...base, status: 'DONE' }, expected), codeIs('UNSUPPORTED_STATUS'));
});

test('a valid ReviewJob carries the real change surface', () => {
  const job = validateReviewJob(reviewJob());
  assert.equal(job.reviewLevel, 'DEEP');
  assert.deepEqual([...job.changedFiles], ['apps/bff/src/lib/auth.ts']);
});

test('an unknown review level is refused', () => {
  assert.throws(() => validateReviewJob(reviewJob({ reviewLevel: 'QUICK' })), codeIs('UNSUPPORTED_REVIEW_LEVEL'));
});

test('V2 preserves the V1 decision invariants', () => {
  const expected = { jobId: 'job-2', goal: '003', round: 1 };
  const base = {
    protocolVersion: PROTOCOL_VERSION_V2,
    jobId: 'job-2',
    goal: '003',
    round: 1,
    decision: 'ACCEPTED',
    blockers: [],
    nextAction: 'STOP',
  };

  assert.equal(validateReviewDecision(base, expected).decision, 'ACCEPTED');
  assert.throws(
    () => validateReviewDecision({ ...base, blockers: ['x'] }, expected),
    codeIs('DECISION_BLOCKERS_INCOHERENT'),
  );
  assert.throws(
    () => validateReviewDecision({ ...base, decision: 'CHANGES_REQUIRED', blockers: [], nextAction: 'RETURN_TO_DEVELOPER' }, expected),
    codeIs('DECISION_BLOCKERS_INCOHERENT'),
  );
  assert.throws(
    () => validateReviewDecision({ ...base, nextAction: 'RETURN_TO_DEVELOPER' }, expected),
    codeIs('DECISION_NEXT_ACTION_INCOHERENT'),
  );
});

// --- Runtime snapshots -----------------------------------------------------

test('runtime and current-goal snapshots round-trip', async () => {
  await withStore(async (store) => {
    await store.writeCurrentGoal({ goalId: '003', migrationAcceptedBaseline: BASELINE, executionBase: EXEC_BASE });
    await store.writeRuntime({ mode: 'DRY_RUN', goal: '003', goalExecuted: false });

    const goal = await store.readCurrentGoal();
    assert.equal(goal.goalId, '003');
    assert.notEqual(goal.migrationAcceptedBaseline, goal.executionBase);

    const runtime = await store.readRuntime();
    assert.equal(runtime.mode, 'DRY_RUN');
    assert.equal(runtime.goalExecuted, false);
  });
});

// --- Candidate results ------------------------------------------------------
//
// Goal006 R1's review: the CLI produced a valid ReviewDecision, but a harness
// bug in model-identity verification (see claude-process.mjs) discarded it
// before it ever reached publishResult. These prove the audit trail that lets
// that answer be recovered later without a second inference — never as a
// trusted result on its own, always alongside the FAILED envelope.

test('16. a candidate result round-trips and is recoverable by attempt', async () => {
  await withStore(async (store) => {
    await store.publishCandidateResult('tech_lead', '006-r1-tech_lead-eabcb3e9', {
      requestedModel: 'claude-fable-5-1',
      modelVerificationError: { code: 'PRIMARY_MODEL_EVIDENCE_MISSING', message: 'no evidence' },
      observedModels: ['claude-fable-5-1'],
      payload: { role: 'tech_lead', ok: true, decision: 'CHANGES_REQUIRED' },
    }, { attemptId: '006-r1-tech_lead-eabcb3e9-a1' });

    const candidate = await store.readCandidateResult(
      'tech_lead', '006-r1-tech_lead-eabcb3e9', '006-r1-tech_lead-eabcb3e9-a1',
    );
    assert.equal(candidate.attemptId, '006-r1-tech_lead-eabcb3e9-a1');
    assert.equal(candidate.payload.decision, 'CHANGES_REQUIRED');
    assert.equal(candidate.modelVerificationError.code, 'PRIMARY_MODEL_EVIDENCE_MISSING');
  });
});

test('a candidate result requires an attemptId, same as a real result', async () => {
  await withStore(async (store) => {
    await assert.rejects(
      () => store.publishCandidateResult('developer', 'job-1', { payload: {} }),
      codeIs('RESULT_ATTEMPT_REQUIRED'),
    );
  });
});

test('reading a candidate result that was never published returns null', async () => {
  await withStore(async (store) => {
    const candidate = await store.readCandidateResult('developer', 'job-1', 'job-1-a1');
    assert.equal(candidate, null);
  });
});

test('17. a candidate result persists only the whitelisted fields, never arbitrary extras', async () => {
  await withStore(async (store, dir) => {
    await store.publishCandidateResult('developer', 'job-1', {
      requestedModel: 'claude-opus-5',
      modelVerificationError: null,
      observedModels: ['claude-opus-5'],
      payload: { role: 'developer', ok: true },
      // None of these belong in a candidate result and must not survive.
      reasoning: 'chain-of-thought the model produced while deciding',
      rawStdout: 'full raw CLI stdout, potentially containing anything',
      secret: 'sk-should-never-be-here',
    }, { attemptId: 'job-1-a1' });

    const raw = await readFile(join(dir, 'results', 'developer', 'job-1.candidate-job-1-a1.json'), 'utf8');
    assert.ok(!raw.includes('chain-of-thought'));
    assert.ok(!raw.includes('rawStdout') && !raw.includes('full raw CLI stdout'));
    assert.ok(!raw.includes('sk-should-never-be-here'));

    const candidate = JSON.parse(raw);
    assert.deepEqual(Object.keys(candidate).sort(), [
      'attemptId', 'jobId', 'modelVerificationError', 'observedModels',
      'payload', 'publishedAt', 'requestedModel', 'role', 'storeVersion',
    ]);
  });
});
