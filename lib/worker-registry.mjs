/**
 * IA Loop — worker heartbeat and health.
 *
 * Each worker writes a small heartbeat file; the orchestrator derives health
 * from its age alone. No daemon, no sockets, no polling storm.
 */

import { SpikeError } from './claude-process.mjs';
import { readJson, writeJsonAtomic, STORE_VERSION } from './job-store.mjs';

export const WORKER_HEALTH = Object.freeze({
  RUNNING: 'RUNNING',
  STALE: 'STALE',
  OFFLINE: 'OFFLINE',
});

/** Heartbeat every 5s; stale after 15s; offline after 60s. */
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const STALE_AFTER_MS = 15_000;
export const OFFLINE_AFTER_MS = 60_000;

export const WORKER_STATES = Object.freeze([
  'STARTING', 'IDLE', 'WORKING', 'PUBLISHING', 'ERROR', 'STOPPING',
  // A worker waiting out a model limit is healthy, not stuck: it keeps
  // heartbeating so health never degrades to STALE/OFFLINE while it waits.
  'WAITING_FOR_CAPACITY',
]);

/** Session strategy per role. The asymmetry is deliberate — see the README. */
export const SESSION_STRATEGY = Object.freeze({
  PERSISTENT: 'PERSISTENT',
  STATELESS: 'STATELESS',
});

export async function writeHeartbeat(store, role, {
  state, model, sessionStrategy, sessionId = null, detail = null,
  capacityReason = null, nextRetryAt = null,
}) {
  if (!WORKER_STATES.includes(state)) {
    throw new SpikeError('INVALID_ARGS', `Unknown worker state ${JSON.stringify(state)}`);
  }

  await writeJsonAtomic(store.paths.worker(role), {
    storeVersion: STORE_VERSION,
    role,
    pid: process.pid,
    state,
    model,
    sessionStrategy,
    // Truncated on purpose: enough to correlate logs, not the full identifier.
    sessionIdShort: sessionId ? String(sessionId).slice(0, 8) : null,
    detail,
    capacityReason,
    nextRetryAt,
    lastHeartbeat: new Date().toISOString(),
  });
}

/**
 * Derives health from heartbeat age.
 * A missing heartbeat file means the worker was never started, i.e. OFFLINE.
 */
export function healthFromHeartbeat(heartbeat, { now = Date.now(), staleAfterMs = STALE_AFTER_MS, offlineAfterMs = OFFLINE_AFTER_MS } = {}) {
  if (!heartbeat?.lastHeartbeat) return { health: WORKER_HEALTH.OFFLINE, ageMs: null };

  const beatAt = Date.parse(heartbeat.lastHeartbeat);
  if (Number.isNaN(beatAt)) {
    throw new SpikeError('FILE_CORRUPT', `Worker heartbeat has an unparseable timestamp: ${heartbeat.lastHeartbeat}`);
  }

  const ageMs = now - beatAt;
  if (ageMs >= offlineAfterMs) return { health: WORKER_HEALTH.OFFLINE, ageMs };
  if (ageMs >= staleAfterMs) return { health: WORKER_HEALTH.STALE, ageMs };
  return { health: WORKER_HEALTH.RUNNING, ageMs };
}

export async function readWorkerHealth(store, role, options = {}) {
  const heartbeat = await readJson(store.paths.worker(role));
  const { health, ageMs } = healthFromHeartbeat(heartbeat, options);

  return {
    role,
    health,
    ageMs,
    state: heartbeat?.state ?? null,
    model: heartbeat?.model ?? null,
    sessionStrategy: heartbeat?.sessionStrategy ?? null,
    sessionIdShort: heartbeat?.sessionIdShort ?? null,
    capacityReason: heartbeat?.capacityReason ?? null,
    nextRetryAt: heartbeat?.nextRetryAt ?? null,
    pid: heartbeat?.pid ?? null,
  };
}

/**
 * Starts a heartbeat timer. Returns a stop function.
 * `unref` keeps the timer from holding the process open on its own.
 */
export function startHeartbeat(store, role, getStatus, { intervalMs = HEARTBEAT_INTERVAL_MS } = {}) {
  let stopped = false;

  const beat = async () => {
    if (stopped) return;
    try {
      await writeHeartbeat(store, role, getStatus());
    } catch {
      // A failed heartbeat must never take the worker down; the orchestrator
      // will observe it as STALE, which is the correct signal.
    }
  };

  void beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref?.();

  return async () => {
    stopped = true;
    clearInterval(timer);
  };
}
