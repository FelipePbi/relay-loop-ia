#!/usr/bin/env node
/**
 * IA Loop — manual, safe cleanup of leaked temporary resources.
 *
 *   npm run ia-loop:resources:cleanup -- --dry-run   (default; mutates nothing)
 *   npm run ia-loop:resources:cleanup -- --apply     (acts, CONFIRMED ownership only)
 *
 * `--apply` never touches a resource whose ownership is not CONFIRMED (or,
 * for a resource already gone, PROCESS_GONE/PID_REUSED — nothing left to
 * kill, just a directory to reclaim). UNKNOWN, EXECUTABLE_MISMATCH and
 * DATA_DIR_MISMATCH are always left alone: this tool fails closed by design,
 * per the absolute rule that ownership must be PROVEN, never assumed from a
 * process name or a port number.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SpikeError } from './lib/claude-process.mjs';
import { createResourceRegistry, LIVE_RESOURCE_STATUSES } from './lib/resource-registry.mjs';
import { createProcessInspector } from './lib/process-inspector.mjs';
import { provePostgresOwnership, isCleanable } from './lib/postgres-ownership.mjs';
import { RESOURCE_TYPE_POSTGRES, stopTemporaryPostgres } from './lib/temporary-postgres.mjs';
import { tempRootFor } from './lib/resource-paths.mjs';
import { isDirectExecution } from './lib/direct-execution.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, '.state');

export async function planCleanup({ registry, inspector, commandLineFn }) {
  const live = (await registry.list()).filter((r) => LIVE_RESOURCE_STATUSES.includes(r.status));

  const plan = [];
  for (const resource of live) {
    if (resource.resourceType !== RESOURCE_TYPE_POSTGRES) {
      plan.push({ resource, ownership: 'UNKNOWN', detail: `No ownership proof implemented for resourceType ${resource.resourceType}`, safeToClean: false });
      continue; // eslint-disable-line no-continue
    }
    // eslint-disable-next-line no-await-in-loop -- cleanup planning is not on a hot path
    const proof = await provePostgresOwnership(resource, inspector, commandLineFn ? { commandLineFn } : {});
    plan.push({ resource, ownership: proof.ownership, detail: proof.detail, safeToClean: isCleanable(proof) });
  }
  return plan;
}

export function renderPlan(plan, { apply }) {
  const out = [];
  if (plan.length === 0) {
    out.push('No live temporary resources found.');
    return out.join('\n');
  }

  for (const item of plan) {
    const { resource } = item;
    out.push(`Resource:`);
    out.push(`  ${resource.resourceId}`);
    out.push(`Owner:`);
    out.push(`  ${[resource.goalId, resource.round ? `R${resource.round}` : null, resource.role, resource.attemptId].filter(Boolean).join(' ') || 'unattributed'}`);
    if (resource.metadata?.postgresPid) out.push(`PID:\n  ${resource.metadata.postgresPid}`);
    if (resource.metadata?.port) out.push(`Port:\n  ${resource.metadata.port}`);
    if (resource.metadata?.dataDirectory) out.push(`PGDATA:\n  ${resource.metadata.dataDirectory}`);
    out.push(`Ownership:\n  ${item.safeToClean ? 'CONFIRMED' : item.ownership}`);
    out.push(`Reason:\n  ${item.detail}`);
    out.push(item.safeToClean
      ? `Would:\n  pg_ctl stop\n  wait\n  remove temp dir`
      : 'Would:\n  (nothing — ownership not proven; left untouched)');
    if (apply && item.safeToClean) out.push('Applied: yes');
    else if (apply) out.push('Applied: no (UNKNOWN ownership skipped)');
    out.push('');
  }
  return out.join('\n').trimEnd();
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const explicitDryRun = args.includes('--dry-run');
  if (apply && explicitDryRun) {
    console.error('Pass either --dry-run or --apply, not both.');
    return 2;
  }

  const registry = createResourceRegistry(STATE_DIR);
  const inspector = createProcessInspector();
  const tempRoot = tempRootFor(STATE_DIR);

  const plan = await planCleanup({ registry, inspector });
  console.log(renderPlan(plan, { apply }));

  if (!apply) {
    console.log('\nDry run — nothing was changed. Re-run with --apply to act on CONFIRMED resources only.');
    return 0;
  }

  for (const item of plan.filter((p) => p.safeToClean)) {
    // eslint-disable-next-line no-await-in-loop -- cleanups are applied one at a time, deliberately serial
    await stopTemporaryPostgres(registry, item.resource.resourceId, { tempRoot, inspector });
  }
  return 0;
}

if (isDirectExecution(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      const code = error instanceof SpikeError ? error.code : 'UNEXPECTED_ERROR';
      console.error(`ATENDLY IA LOOP — resources cleanup\n\n[${code}] ${error.message}`);
      process.exitCode = 1;
    });
}
