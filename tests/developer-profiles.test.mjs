/**
 * Developer profile registry and model routing.
 *
 * Nothing here calls a model. What is proved is that the profile on the job is
 * the ONLY thing that decides which model runs, that an unknown profile stops
 * the run, and that no path anywhere falls back to a different model.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildArgs, invokeAgent } from '../lib/claude-process.mjs';
import {
  CLI_EFFORT_LEVELS,
  DEFAULT_DEVELOPER_PROFILE,
  DEVELOPER_PROFILES,
  SELECTABLE_DEVELOPER_PROFILES,
  assertProfileWasHonoured,
  assertSelectableProfile,
  createDeveloperProfileStore,
  describeProfile,
  resolveDeveloperProfile,
} from '../lib/developer-profiles.mjs';
import { validateDeveloperJob, validateReviewDecision, PROTOCOL_VERSION_V2 } from '../lib/contracts-v2.mjs';
import { validatePlanningDecision } from '../lib/planning-decision.mjs';
import { banner } from '../lib/worker-loop.mjs';

const SONNET = 'claude-sonnet-5';
const OPUS = 'claude-opus-5';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function usage(n = 10) {
  return { input_tokens: n, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}
function modelUsage(n = 10) {
  return { inputTokens: n, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
}

/**
 * A stream-json transcript naming `model` as the served model — via the
 * explicit `assistant`/`message.model` evidence invokeAgent now reads, not
 * via `usage`/`modelUsage`, which stays purely advisory (see
 * claude-process.mjs's resolvePrimaryModel).
 */
function envelopeFor(model, result = '{"role":"developer","ok":true}') {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: '11111111-1111-4111-8111-111111111111' }),
    JSON.stringify({ type: 'assistant', message: { model, content: [{ type: 'text', text: 'ok' }] } }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result,
      usage: usage(),
      modelUsage: { [model]: modelUsage() },
    }),
  ];
  return lines.join('\n');
}

function fakeSpawn({ stdout, onSpawn } = {}) {
  return (executable, args, options) => {
    onSpawn?.({ executable, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', stdout);
      child.emit('close', 0);
    });
    return child;
  };
}

/** Runs one agent call under a profile and reports the argv it produced. */
async function runUnderProfile(profileName, { servedBy = null } = {}) {
  const profile = resolveDeveloperProfile(profileName);
  let args = null;
  const outcome = await invokeAgent({
    executable: 'claude',
    model: profile.model,
    effort: profile.effort,
    expectedFamily: profile.family,
    expectedRole: 'developer',
    prompt: 'p',
    sessionId: '11111111-1111-4111-8111-111111111111',
    spawnFn: fakeSpawn({
      stdout: envelopeFor(servedBy ?? profile.model),
      onSpawn: (call) => { args = call.args; },
    }),
  });
  return { args, outcome, profile };
}

const developerJob = (overrides = {}) => ({
  protocolVersion: PROTOCOL_VERSION_V2,
  jobId: '006-r1-developer-abcd1234',
  role: 'developer',
  goal: '006',
  round: 1,
  type: 'IMPLEMENTATION',
  migrationAcceptedBaseline: SHA_A,
  executionBase: SHA_B,
  worktree: 'E:/wt',
  goalPath: 'docs/migration/goals/006-x.md',
  blockers: [],
  ...overrides,
});

// --- 11-13. The registry ---------------------------------------------------

test('11. SONNET_MEDIUM is registered as Sonnet at medium effort', () => {
  const profile = resolveDeveloperProfile('SONNET_MEDIUM');
  assert.equal(profile.model, SONNET);
  assert.equal(profile.effort, 'medium');
  assert.equal(profile.family, 'sonnet');
  assert.ok(CLI_EFFORT_LEVELS.includes(profile.effort));
});

test('12. OPUS_MEDIUM is registered as Opus at medium effort', () => {
  const profile = resolveDeveloperProfile('OPUS_MEDIUM');
  assert.equal(profile.model, OPUS);
  assert.equal(profile.effort, 'medium');
  assert.equal(profile.family, 'opus');
});

test('13. OPUS_HIGH is registered as Opus at high effort', () => {
  const profile = resolveDeveloperProfile('OPUS_HIGH');
  assert.equal(profile.model, OPUS);
  assert.equal(profile.effort, 'high');
  assert.equal(profile.family, 'opus');
  assert.equal(describeProfile('OPUS_HIGH'), 'OPUS_HIGH · Claude Opus 5 · effort High');
});

test('13b. every registered effort is one the installed CLI accepts', () => {
  for (const profile of Object.values(DEVELOPER_PROFILES)) {
    if (profile.effort === null) continue;
    assert.ok(CLI_EFFORT_LEVELS.includes(profile.effort), `${profile.name} declares an unsupported effort`);
  }
});

// --- 14. Fail closed -------------------------------------------------------

test('14. an unknown profile fails closed everywhere it can appear', () => {
  assert.throws(() => resolveDeveloperProfile('OPUS_ULTRA'), (e) => e.code === 'UNKNOWN_DEVELOPER_PROFILE');
  assert.throws(() => resolveDeveloperProfile(''), (e) => e.code === 'UNKNOWN_DEVELOPER_PROFILE');
  assert.throws(() => resolveDeveloperProfile(null), (e) => e.code === 'UNKNOWN_DEVELOPER_PROFILE');

  assert.throws(
    () => validateDeveloperJob(developerJob({ developerProfile: 'GPT_LARGE' })),
    (e) => e.code === 'UNKNOWN_DEVELOPER_PROFILE',
  );
  // The compatibility profile exists, but the Tech Lead may not name it.
  assert.throws(() => assertSelectableProfile('LEGACY_OPUS'), (e) => e.code === 'UNKNOWN_DEVELOPER_PROFILE');
  assert.ok(!SELECTABLE_DEVELOPER_PROFILES.includes('LEGACY_OPUS'));
});

test('14b. an effort the CLI would silently ignore is refused before spawn', () => {
  // The CLI only WARNS about an unknown --effort and then runs at default
  // effort. Refusing here is what stops that from being a silent downgrade.
  assert.throws(
    () => buildArgs({ prompt: 'p', model: OPUS, sessionId: 'a', effort: 'ultra' }),
    (e) => e.code === 'UNSUPPORTED_EFFORT',
  );
});

// --- 15-16. Default and persistence ---------------------------------------

test('15. the default profile is SONNET_HIGH', () => {
  // Adaptive routing raised the default effort: Sonnet is the standard
  // executor and gets a real chance to finish the work before anything
  // escalates. The MODEL is unchanged — the default was never Opus.
  assert.equal(DEFAULT_DEVELOPER_PROFILE, 'SONNET_HIGH');
  assert.equal(validateDeveloperJob(developerJob()).developerProfile, 'SONNET_HIGH');
  const planning = validatePlanningDecision({
    protocolVersion: PROTOCOL_VERSION_V2,
    jobId: 'j1', goal: '005', decision: 'NEXT_GOAL', summary: 's',
    nextGoalId: '006', nextGoalTitle: 't', nextGoalPath: 'docs/migration/goals/006-x.md',
  }, { jobId: 'j1', goal: '005' });
  assert.equal(planning.developerProfile, 'SONNET_HIGH');
});

test('16. a Goal persists its profile through the store, across processes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-profiles-'));
  try {
    const store = createDeveloperProfileStore(dir);
    assert.equal(await store.read('007'), null);

    await store.write('007', { profile: 'OPUS_HIGH', reason: 'Tenant isolation.' });
    // A brand-new store handle: this is what a restarted process sees.
    const reread = await createDeveloperProfileStore(dir).read('007');
    assert.equal(reread.profile, 'OPUS_HIGH');
    assert.equal(reread.selectedBy, 'tech_lead');
    assert.equal(reread.reason, 'Tenant isolation.');

    await assert.rejects(
      () => store.write('008', { profile: 'NOPE' }),
      (e) => e.code === 'UNKNOWN_DEVELOPER_PROFILE',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 17-20. The worker executes what the job says -------------------------

test('17. the job carries the profile, and the worker reads it from there', () => {
  const job = validateDeveloperJob(developerJob({ developerProfile: 'OPUS_HIGH', developerProfileReason: 'Auth.' }));
  assert.equal(job.developerProfile, 'OPUS_HIGH');
  assert.equal(job.developerProfileReason, 'Auth.');

  const profile = resolveDeveloperProfile(job.developerProfile);
  assert.equal(profile.model, OPUS);
  assert.equal(profile.effort, 'high');
});

test('18. a SONNET_MEDIUM job calls Sonnet at medium effort and nothing else', async () => {
  const { args, outcome } = await runUnderProfile('SONNET_MEDIUM');

  assert.equal(args[args.indexOf('--model') + 1], SONNET);
  assert.equal(args[args.indexOf('--effort') + 1], 'medium');
  assert.ok(!args.join(' ').includes(OPUS));
  assert.equal(outcome.resolvedPrimaryModel, SONNET);
  assert.equal(outcome.error, null);
});

test('19. an OPUS_MEDIUM job calls Opus at medium effort', async () => {
  const { args, outcome } = await runUnderProfile('OPUS_MEDIUM');
  assert.equal(args[args.indexOf('--model') + 1], OPUS);
  assert.equal(args[args.indexOf('--effort') + 1], 'medium');
  assert.equal(outcome.resolvedPrimaryModel, OPUS);
});

test('20. an OPUS_HIGH job calls Opus at high effort', async () => {
  const { args, outcome } = await runUnderProfile('OPUS_HIGH');
  assert.equal(args[args.indexOf('--model') + 1], OPUS);
  assert.equal(args[args.indexOf('--effort') + 1], 'high');
  assert.equal(outcome.resolvedPrimaryModel, OPUS);
});

// --- 21-23. No fallback, ever ---------------------------------------------

test('21. no profile ever produces a fallback flag', async () => {
  for (const name of SELECTABLE_DEVELOPER_PROFILES) {
    const { args } = await runUnderProfile(name);
    for (const forbidden of ['--fallback-model', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions']) {
      assert.ok(!args.includes(forbidden), `${name} passed ${forbidden}`);
    }
  }
});

test('22. the resolved primary model must match the profile that was promised', () => {
  assert.equal(assertProfileWasHonoured({ profile: 'SONNET_MEDIUM', resolvedPrimaryModel: SONNET }), SONNET);
  assert.equal(assertProfileWasHonoured({ profile: 'OPUS_HIGH', resolvedPrimaryModel: OPUS }), OPUS);
  assert.throws(
    () => assertProfileWasHonoured({ profile: 'OPUS_HIGH', resolvedPrimaryModel: null }),
    (e) => e.code === 'RESOLVED_MODEL_UNKNOWN',
  );
});

test('23. a mismatch between profile and served model is MODEL_FALLBACK_DETECTED', async () => {
  // Opus was asked for; Sonnet answered. That is a fallback, and a fallback is
  // a failure — never something to accept quietly.
  const { outcome } = await runUnderProfile('OPUS_HIGH', { servedBy: SONNET });
  assert.equal(outcome.error?.code, 'MODEL_FALLBACK_DETECTED');
  assert.equal(outcome.available, false);

  assert.throws(
    () => assertProfileWasHonoured({ profile: 'OPUS_HIGH', resolvedPrimaryModel: SONNET }),
    (e) => e.code === 'MODEL_FALLBACK_DETECTED',
  );
  // And symmetrically: Sonnet was asked for, Opus answered.
  assert.throws(
    () => assertProfileWasHonoured({ profile: 'SONNET_MEDIUM', resolvedPrimaryModel: OPUS }),
    (e) => e.code === 'MODEL_FALLBACK_DETECTED',
  );
});

// --- 28. The Tech Lead may promote ----------------------------------------

test('28. a review may promote the next round, and only with CHANGES_REQUIRED', () => {
  const base = {
    protocolVersion: PROTOCOL_VERSION_V2,
    jobId: 'j', goal: '006', round: 1,
    decision: 'CHANGES_REQUIRED', blockers: ['tenant leak'], nextAction: 'RETURN_TO_DEVELOPER',
  };

  const promoted = validateReviewDecision(
    { ...base, nextDeveloperProfile: 'OPUS_HIGH', nextDeveloperProfileReason: 'Tenant isolation.' },
    { jobId: 'j', goal: '006', round: 1 },
  );
  assert.equal(promoted.nextDeveloperProfile, 'OPUS_HIGH');

  // Silence is not a promotion and not a downgrade — it is silence.
  assert.equal(validateReviewDecision(base, { jobId: 'j', goal: '006', round: 1 }).nextDeveloperProfile, null);

  assert.throws(
    () => validateReviewDecision({ ...base, nextDeveloperProfile: 'MEGA' }, { jobId: 'j', goal: '006', round: 1 }),
    (e) => e.code === 'UNKNOWN_DEVELOPER_PROFILE',
  );
  assert.throws(
    () => validateReviewDecision({
      protocolVersion: PROTOCOL_VERSION_V2, jobId: 'j', goal: '006', round: 1,
      decision: 'ACCEPTED', blockers: [], nextAction: 'STOP', nextDeveloperProfile: 'OPUS_HIGH',
    }, { jobId: 'j', goal: '006', round: 1 }),
    (e) => e.code === 'CONTRACT_FIELD_INVALID',
  );
});

// --- 31. The terminal is not hardcoded ------------------------------------

test('31. the Developer banner lists profiles instead of claiming a model', () => {
  const rendered = banner({
    title: 'DEVELOPER',
    supportedProfiles: SELECTABLE_DEVELOPER_PROFILES.map(describeProfile),
    sessionLine: 'Session strategy: STATELESS',
  });

  assert.ok(rendered.includes('Supported profiles:'));
  assert.ok(!/^Model:/m.test(rendered), 'an idle Developer must not claim a single model');
  for (const name of SELECTABLE_DEVELOPER_PROFILES) assert.ok(rendered.includes(name));
  assert.ok(rendered.includes('State: IDLE'));

  // The Tech Lead is deliberately unchanged: still one fixed model.
  const techLead = banner({ title: 'TECH LEAD', model: 'Claude Fable 5.1', sessionLine: 'Session: abc' });
  assert.ok(techLead.includes('Model: Claude Fable 5.1'));
});

test('31b. the Developer worker source pins no model of its own', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../workers/developer.mjs', import.meta.url), 'utf8');
  // The model must arrive on the job. A literal id here would be a second,
  // competing source of truth for the routing decision.
  assert.ok(!source.includes("'claude-opus-5'"), 'developer.mjs must not hardcode a model id');
  assert.ok(!source.includes("'claude-sonnet-5'"), 'developer.mjs must not hardcode a model id');
});
