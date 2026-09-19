#!/usr/bin/env node
/**
 * IA Loop — temporary resource inspection.
 *
 *   npm run ia-loop:resources
 *
 * Reads only what is on disk and queries process liveness (read-only OS
 * calls) to report ownership. Never starts, stops, or deletes anything —
 * that is `run-resources-cleanup.mjs`, and even it defaults to a dry run.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SpikeError } from './lib/claude-process.mjs';
import { createResourceRegistry, LIVE_RESOURCE_STATUSES, RESOURCE_STATUS } from './lib/resource-registry.mjs';
import { createProcessInspector } from './lib/process-inspector.mjs';
import { provePostgresOwnership } from './lib/postgres-ownership.mjs';
import { RESOURCE_TYPE_POSTGRES } from './lib/temporary-postgres.mjs';
import { isDirectExecution } from './lib/direct-execution.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, '.state');

function duration(fromIso, now) {
  const started = Date.parse(fromIso);
  if (Number.isNaN(started)) return 'unknown';
  const s = Math.max(0, Math.round((now - started) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export async function buildResourceReport({ registry, inspector, now = Date.now() }) {
  const resources = await registry.list();
  const live = resources.filter((r) => LIVE_RESOURCE_STATUSES.includes(r.status));

  const rows = [];
  for (const resource of live) {
    let ownership = null;
    if (resource.resourceType === RESOURCE_TYPE_POSTGRES) {
      // eslint-disable-next-line no-await-in-loop -- report generation is not on a hot path
      ownership = await provePostgresOwnership(resource, inspector);
    }
    rows.push({ resource, ownership });
  }

  return {
    total: resources.length,
    live: rows,
    byStatus: Object.fromEntries(
      Object.values(RESOURCE_STATUS).map((status) => [status, resources.filter((r) => r.status === status).length]),
    ),
    now,
  };
}

export function renderResourceReport(report) {
  const out = [];
  if (report.live.length === 0) {
    out.push('Temporary resources: none');
    return out.join('\n');
  }

  const postgresCount = report.live.filter((row) => row.resource.resourceType === RESOURCE_TYPE_POSTGRES).length;
  out.push(`Temporary resources:\n  PostgreSQL: ${postgresCount} tracked (not all necessarily ACTIVE)\n`);

  for (const { resource, ownership } of report.live) {
    out.push(`  resource: ${resource.resourceId}`);
    out.push(`  owner: ${[resource.goalId, resource.round ? `R${resource.round}` : null, resource.role, resource.attemptId]
      .filter(Boolean).join('/') || 'unattributed'}`);
    if (resource.metadata?.postgresPid) out.push(`  pid: ${resource.metadata.postgresPid}`);
    if (resource.metadata?.port) out.push(`  port: ${resource.metadata.port}`);
    if (resource.metadata?.dataDirectory) out.push(`  data dir: ${resource.metadata.dataDirectory}`);
    out.push(`  age: ${duration(resource.createdAt, report.now)}`);
    out.push(`  state: ${resource.status}`);
    if (ownership) out.push(`  ownership: ${ownership.ownership} — ${ownership.detail}`);
    out.push('');
  }
  return out.join('\n').trimEnd();
}

async function main() {
  const registry = createResourceRegistry(STATE_DIR);
  const inspector = createProcessInspector();
  const report = await buildResourceReport({ registry, inspector });
  console.log(renderResourceReport(report));
  return 0;
}

if (isDirectExecution(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      const code = error instanceof SpikeError ? error.code : 'UNEXPECTED_ERROR';
      console.error(`ATENDLY IA LOOP — resources\n\nCannot read state: [${code}] ${error.message}`);
      process.exitCode = 1;
    });
}
