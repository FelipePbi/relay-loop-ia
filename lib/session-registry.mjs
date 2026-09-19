/**
 * IA Loop — durable registry of agent sessions.
 *
 * The orchestrator must survive its own restart: if the Node process (or the
 * terminal) dies, the session ids have to be recoverable from disk so each
 * agent can be resumed instead of rebuilt from scratch.
 *
 * Stores only what the orchestrator needs to address a session again:
 * role, model, session id, status, last activity, turn count and cwd.
 * Never conversation content, never credentials.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { SpikeError } from './claude-process.mjs';

export const REGISTRY_VERSION = 1;

export const SESSION_STATUS = Object.freeze({
  CREATED: 'CREATED',
  ACTIVE: 'ACTIVE',
  ERROR: 'ERROR',
});

function emptyRegistry() {
  return { version: REGISTRY_VERSION, sessions: {} };
}

/**
 * Reads the registry. A missing file is a normal first run, not an error;
 * a corrupt or foreign-version file is refused rather than silently reset.
 */
export async function loadRegistry(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyRegistry();
    throw new SpikeError('REGISTRY_UNREADABLE', `Cannot read session registry: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SpikeError('REGISTRY_CORRUPT', `Session registry is not valid JSON: ${error.message}`);
  }

  if (parsed?.version !== REGISTRY_VERSION) {
    throw new SpikeError(
      'REGISTRY_VERSION_MISMATCH',
      `Expected registry version ${REGISTRY_VERSION} but found ${JSON.stringify(parsed?.version)}`,
    );
  }
  if (parsed.sessions === null || typeof parsed.sessions !== 'object' || Array.isArray(parsed.sessions)) {
    throw new SpikeError('REGISTRY_CORRUPT', 'Session registry has no usable "sessions" object');
  }

  return { version: REGISTRY_VERSION, sessions: { ...parsed.sessions } };
}

/** Writes the registry atomically, so a crash mid-write cannot corrupt it. */
export async function saveRegistry(path, registry) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await rename(temp, path);
}

export function getSession(registry, role) {
  return registry.sessions[role] ?? null;
}

/**
 * Inserts or updates one role's session record.
 * Returns a new registry object; the input is never mutated.
 */
export function upsertSession(registry, role, patch) {
  if (typeof role !== 'string' || role.trim() === '') {
    throw new SpikeError('INVALID_ARGS', 'role must be a non-empty string');
  }

  const previous = registry.sessions[role] ?? {};
  const merged = {
    role,
    model: patch.model ?? previous.model ?? null,
    sessionId: patch.sessionId ?? previous.sessionId ?? null,
    status: patch.status ?? previous.status ?? SESSION_STATUS.CREATED,
    cwd: patch.cwd ?? previous.cwd ?? null,
    turns: patch.turns ?? previous.turns ?? 0,
    lastActivity: patch.lastActivity ?? new Date().toISOString(),
  };

  if (!Object.values(SESSION_STATUS).includes(merged.status)) {
    throw new SpikeError('INVALID_ARGS', `Unknown session status "${merged.status}"`);
  }

  return {
    version: REGISTRY_VERSION,
    sessions: { ...registry.sessions, [role]: merged },
  };
}

/**
 * Guards the invariant that matters most: two roles must never share a session.
 * A shared id would silently merge the Tech Lead's and the Developer's context.
 */
export function assertSessionsAreIndependent(registry) {
  const byId = new Map();
  for (const [role, session] of Object.entries(registry.sessions)) {
    if (!session.sessionId) continue;
    if (byId.has(session.sessionId)) {
      throw new SpikeError(
        'SESSION_ID_COLLISION',
        `Roles "${byId.get(session.sessionId)}" and "${role}" share session id ${session.sessionId}`,
      );
    }
    byId.set(session.sessionId, role);
  }
  return true;
}
