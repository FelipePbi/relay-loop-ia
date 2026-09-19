/**
 * Unit tests for the persistent agent session.
 *
 * Both groups exist because of one incident: the Tech Lead's conversation grew
 * to 23 MB and 922 turns across a week of Goals while its registry reported
 * `turns: 2` and the event log said nothing at all. The counter was measuring
 * sends since the last worker restart, and no lifecycle event was ever
 * emitted, so the one conversation with no ceiling was also the one nobody
 * could see.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPersistentSession } from '../lib/persistent-session.mjs';
import { SESSION_STATUS } from '../lib/session-registry.mjs';

const BASE = Object.freeze({
  executable: '/fake/claude',
  role: 'tech_lead',
  model: 'claude-fable-5-1',
  expectedFamily: 'fable',
  cwd: '/fake/cwd',
});

const OK = async () => ({ error: null, payload: {} });
const FAILS = async () => ({ error: true, reason: 'USAGE_LIMIT' });

// --- the counter means the conversation's life ---------------------------

test('turns seed from the restored record, so a worker restart continues the count', () => {
  const session = createPersistentSession({
    ...BASE, sessionId: 'abc', started: true, turns: 922, invoke: OK,
  });
  assert.equal(session.turns, 922);
  assert.equal(session.toRecord().turns, 922, 'the registry receives the lifetime count');
});

test('a send advances the restored count rather than counting from zero', async () => {
  const session = createPersistentSession({
    ...BASE, sessionId: 'abc', started: true, turns: 922, invoke: OK,
  });
  await session.send({ prompt: 'x' });
  assert.equal(session.turns, 923);
});

test('a fresh session starts at zero, and junk in the record never travels', () => {
  for (const restored of [undefined, null, 0, -5, 3.5, 'many']) {
    const session = createPersistentSession({ ...BASE, turns: restored, invoke: OK });
    assert.equal(session.turns, 0, `turns: ${String(restored)} must not corrupt the counter`);
  }
});

// --- the conversation is observable --------------------------------------

test('a failed turn reports itself, with the count that says how big it had grown', async () => {
  const seen = [];
  const session = createPersistentSession({
    ...BASE, sessionId: 'abc', started: true, turns: 100, invoke: FAILS,
    onLifecycle: (event) => seen.push(event),
  });

  const outcome = await session.send({ prompt: 'x' });

  assert.equal(outcome.error, true);
  assert.equal(session.status, SESSION_STATUS.ERROR);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    type: 'AGENT_SESSION_FAILED',
    role: 'tech_lead',
    model: 'claude-fable-5-1',
    sessionId: 'abc',
    turns: 101,
    reason: 'USAGE_LIMIT',
  });
});

test('a successful turn is not an event; only the failure is worth interrupting for', async () => {
  const seen = [];
  const session = createPersistentSession({
    ...BASE, invoke: OK, onLifecycle: (event) => seen.push(event),
  });
  await session.send({ prompt: 'x' });
  await session.send({ prompt: 'y' });
  assert.deepEqual(seen, []);
  assert.equal(session.status, SESSION_STATUS.ACTIVE);
});

test('an observer that throws never breaks the session it is observing', async () => {
  const session = createPersistentSession({
    ...BASE, invoke: FAILS,
    onLifecycle: () => { throw new Error('the event store is down'); },
  });

  // Telemetry that can fail a review is worse than no telemetry.
  const outcome = await session.send({ prompt: 'x' });
  assert.equal(outcome.error, true, 'the send still returns its own outcome');
  assert.equal(session.turns, 1);
});

test('no observer at all is a supported configuration', async () => {
  const session = createPersistentSession({ ...BASE, invoke: FAILS });
  await assert.doesNotReject(() => session.send({ prompt: 'x' }));
});

// --- resume semantics, unchanged by any of the above ---------------------

test('the first send of a NEW session creates it; only afterwards does it resume', async () => {
  const calls = [];
  const session = createPersistentSession({
    ...BASE,
    invoke: async (args) => { calls.push(args.resume); return { error: null }; },
  });

  await session.send({ prompt: 'x' });
  await session.send({ prompt: 'y' });
  assert.deepEqual(calls, [false, true]);
});

test('a send that FAILED leaves the conversation unresumable, so the next one recreates it', async () => {
  const calls = [];
  let fail = true;
  const session = createPersistentSession({
    ...BASE,
    invoke: async (args) => {
      calls.push(args.resume);
      const outcome = fail ? { error: true, reason: 'USAGE_LIMIT' } : { error: null };
      fail = false;
      return outcome;
    },
  });

  await session.send({ prompt: 'x' });
  await session.send({ prompt: 'y' });
  assert.deepEqual(calls, [false, false], 'resuming a turn that never landed would fail');
});
