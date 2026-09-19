/**
 * Session registry and persistent-session argument tests.
 * No model calls are made here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildArgs } from '../lib/claude-process.mjs';
import {
  REGISTRY_VERSION,
  SESSION_STATUS,
  assertSessionsAreIndependent,
  getSession,
  loadRegistry,
  saveRegistry,
  upsertSession,
} from '../lib/session-registry.mjs';

const codeIs = (code) => (error) => error.code === code;

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ia-loop-registry-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

// --- Argument construction -------------------------------------------------

test('a one-shot call disables persistence and pins a session id', () => {
  const args = buildArgs({ prompt: 'p', model: 'claude-opus-5', sessionId: 'abc' });

  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(args[args.indexOf('--session-id') + 1], 'abc');
  assert.ok(!args.includes('--resume'));
});

test('a persistent first turn keeps the conversation on disk', () => {
  const args = buildArgs({
    prompt: 'p',
    model: 'claude-opus-5',
    sessionId: 'abc',
    persistSession: true,
  });

  // Persistence is exactly the absence of this flag.
  assert.ok(!args.includes('--no-session-persistence'));
  assert.equal(args[args.indexOf('--session-id') + 1], 'abc');
  assert.ok(!args.includes('--resume'));
});

test('a resumed turn uses --resume with the same id and no --session-id', () => {
  const args = buildArgs({
    prompt: 'p',
    model: 'claude-opus-5',
    sessionId: 'abc',
    persistSession: true,
    resume: true,
  });

  assert.equal(args[args.indexOf('--resume') + 1], 'abc');
  assert.ok(!args.includes('--session-id'));
  assert.ok(!args.includes('--no-session-persistence'));
});

test('resuming a non-persisted session is refused', () => {
  assert.throws(
    () => buildArgs({ prompt: 'p', model: 'm', sessionId: 'abc', resume: true }),
    codeIs('INVALID_ARGS'),
  );
});

test('isolation flags survive in persistent mode', () => {
  const args = buildArgs({
    prompt: 'p',
    model: 'claude-fable-5-1',
    sessionId: 'abc',
    persistSession: true,
    resume: true,
  });

  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
  assert.ok(args.includes('--safe-mode'));
  assert.ok(args.includes('--strict-mcp-config'));
  for (const forbidden of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--fallback-model']) {
    assert.ok(!args.includes(forbidden), `${forbidden} must never be used`);
  }
});

// --- Registry --------------------------------------------------------------

test('a missing registry file reads as an empty registry', async () => {
  await withTempDir(async (dir) => {
    const registry = await loadRegistry(join(dir, 'nope.json'));
    assert.equal(registry.version, REGISTRY_VERSION);
    assert.deepEqual(registry.sessions, {});
  });
});

test('a registry round-trips through disk with every required field', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'sessions.json');
    const registry = upsertSession({ version: REGISTRY_VERSION, sessions: {} }, 'developer', {
      model: 'claude-opus-5',
      sessionId: 'session-dev',
      status: SESSION_STATUS.ACTIVE,
      cwd: dir,
      turns: 2,
    });

    await saveRegistry(path, registry);
    const reloaded = await loadRegistry(path);
    const session = getSession(reloaded, 'developer');

    assert.equal(session.role, 'developer');
    assert.equal(session.model, 'claude-opus-5');
    assert.equal(session.sessionId, 'session-dev');
    assert.equal(session.status, SESSION_STATUS.ACTIVE);
    assert.equal(session.turns, 2);
    assert.ok(session.lastActivity, 'lastActivity must be recorded');
    // No temp file left behind by the atomic write.
    await assert.rejects(readFile(`${path}.tmp`, 'utf8'));
  });
});

test('upsertSession does not mutate the registry it was given', () => {
  const original = { version: REGISTRY_VERSION, sessions: {} };
  const next = upsertSession(original, 'developer', { sessionId: 'a', model: 'm', cwd: '.' });

  assert.deepEqual(original.sessions, {});
  assert.equal(next.sessions.developer.sessionId, 'a');
});

test('upsertSession preserves fields not present in the patch', () => {
  let registry = upsertSession({ version: REGISTRY_VERSION, sessions: {} }, 'developer', {
    model: 'claude-opus-5',
    sessionId: 'a',
    cwd: '/tmp/dev',
    turns: 1,
  });
  registry = upsertSession(registry, 'developer', { turns: 2 });

  const session = getSession(registry, 'developer');
  assert.equal(session.model, 'claude-opus-5');
  assert.equal(session.sessionId, 'a');
  assert.equal(session.cwd, '/tmp/dev');
  assert.equal(session.turns, 2);
});

test('an unknown status is rejected', () => {
  assert.throws(
    () => upsertSession({ version: REGISTRY_VERSION, sessions: {} }, 'developer', { status: 'ZOMBIE' }),
    codeIs('INVALID_ARGS'),
  );
});

test('two roles sharing a session id is refused', () => {
  let registry = upsertSession({ version: REGISTRY_VERSION, sessions: {} }, 'developer', { sessionId: 'same' });
  registry = upsertSession(registry, 'tech_lead', { sessionId: 'same' });

  assert.throws(() => assertSessionsAreIndependent(registry), codeIs('SESSION_ID_COLLISION'));
});

test('distinct session ids pass the independence check', () => {
  let registry = upsertSession({ version: REGISTRY_VERSION, sessions: {} }, 'developer', { sessionId: 'dev' });
  registry = upsertSession(registry, 'tech_lead', { sessionId: 'lead' });

  assert.equal(assertSessionsAreIndependent(registry), true);
});

test('a corrupt or foreign-version registry is refused, never silently reset', async () => {
  await withTempDir(async (dir) => {
    const corrupt = join(dir, 'corrupt.json');
    await writeFile(corrupt, '{ not json', 'utf8');
    await assert.rejects(loadRegistry(corrupt), codeIs('REGISTRY_CORRUPT'));

    const foreign = join(dir, 'foreign.json');
    await writeFile(foreign, JSON.stringify({ version: 99, sessions: {} }), 'utf8');
    await assert.rejects(loadRegistry(foreign), codeIs('REGISTRY_VERSION_MISMATCH'));

    const shapeless = join(dir, 'shapeless.json');
    await writeFile(shapeless, JSON.stringify({ version: REGISTRY_VERSION, sessions: [] }), 'utf8');
    await assert.rejects(loadRegistry(shapeless), codeIs('REGISTRY_CORRUPT'));
  });
});
