/**
 * Unit tests for the code-graph orientation the harness resolves before a
 * model runs.
 *
 * The properties under test are the ones that make it safe to put on the hot
 * path of every Work Unit: it never throws, it never reaches a shell, and it
 * is bounded — the A/B probe that rejected the first version failed on exactly
 * that last point, by injecting a thousand-node answer nobody asked for.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_EXPLAIN_NODES,
  MAX_ORIENTATION_CHARS,
  ORIENTATION_STATUS,
  candidateNodeNames,
  candidatePaths,
  resolveGraphOrientation,
} from '../lib/graph-orientation.mjs';

const GRAPH_PRESENT = () => true;
const GRAPH_ABSENT = () => false;

const EXPLAIN = (name) => [
  `Node: ${name}`,
  `  Source:    apps/bff/src/modules/${name} L1`,
  '  Degree:    21',
  '',
  'Connections (21):',
  '  --> SchedulingClient [imports] apps/bff/src/modules/dashboard/routes.ts:L5',
].join('\n');

/**
 * Answers like `graphify explain` does, from a name -> stdout table.
 *
 * The exit codes are reproduced faithfully, because they are not uniform: a
 * found node and a `No node matching` both exit 0, while `Ambiguous` exits 1.
 * Reading the exit code before the output is a real bug this mock exists to
 * catch — it turned a perfectly resolvable unit into a FAILED one.
 */
function runnerFor(table, { ambiguous = [] } = {}) {
  const calls = [];
  return {
    calls,
    names: () => calls.map((c) => c.args[1]),
    run: async (invocation) => {
      calls.push(invocation);
      const name = invocation.args[1];
      if (ambiguous.includes(name)) {
        return {
          error: Object.assign(new Error('exit 1'), { code: 1 }),
          stdout: `Ambiguous: '${name}' matches 28 nodes in different files.`,
          stderr: '',
        };
      }
      return { error: null, stdout: table[name] ?? "No node matching 'x' found.", stderr: '' };
    },
  };
}

// --- naming -------------------------------------------------------------

test('candidate names widen from the basename outward, because a node keeps its SHORTEST unique suffix', () => {
  assert.deepEqual(
    candidateNodeNames('apps/bff/src/app.ts'),
    ['app.ts', 'src/app.ts', 'bff/src/app.ts', 'apps/bff/src/app.ts'],
  );
  assert.deepEqual(
    candidateNodeNames('apps\\frontend\\AppShell.tsx'),
    ['AppShell.tsx', 'frontend/AppShell.tsx', 'apps/frontend/AppShell.tsx'],
  );
  assert.deepEqual(candidateNodeNames('README.md'), ['README.md']);
  assert.deepEqual(candidateNodeNames(undefined), []);
});

test('candidate paths deduplicate by basename, drop directories, and stay bounded', () => {
  const many = Array.from({ length: 20 }, (_, i) => `src/mod${i}/routes${i}.ts`);
  assert.equal(candidatePaths(many).length, MAX_EXPLAIN_NODES);
  // A plan routinely lists a directory; no node is named after one.
  assert.deepEqual(
    candidatePaths(['apps/frontend/src/features/', 'apps/bff/src/app.ts', 'other/copy/app.ts'], { max: 9 }),
    ['apps/bff/src/app.ts'],
  );
  assert.deepEqual(candidatePaths([]), []);
  assert.deepEqual(candidatePaths(undefined), []);
});

// --- refusing to run ----------------------------------------------------

test('the kill switch turns it off without spawning anything', async () => {
  const { run, calls } = runnerFor({ 'app.ts': EXPLAIN('app.ts') });
  const result = await resolveGraphOrientation({
    files: ['apps/bff/src/app.ts'], cwd: '/repo', exists: GRAPH_PRESENT, run, enabled: false,
  });
  assert.equal(result.status, ORIENTATION_STATUS.DISABLED);
  assert.equal(result.text, null);
  assert.equal(calls.length, 0);
});

test('no files yields NO_FILES and never spawns anything', async () => {
  const { run, calls } = runnerFor({});
  const result = await resolveGraphOrientation({ files: [], cwd: '/repo', exists: GRAPH_PRESENT, run });
  assert.equal(result.status, ORIENTATION_STATUS.NO_FILES);
  assert.equal(calls.length, 0);
});

test('a worktree without a graph degrades to NO_GRAPH instead of failing the unit', async () => {
  const { run, calls } = runnerFor({});
  const result = await resolveGraphOrientation({
    files: ['apps/bff/src/app.ts'], cwd: '/repo', exists: GRAPH_ABSENT, run,
  });
  assert.equal(result.status, ORIENTATION_STATUS.NO_GRAPH);
  assert.equal(calls.length, 0, 'nothing is spawned when there is no graph to read');
});

// --- resolving a name ---------------------------------------------------

test('each resolved file is explained, and the packet names which nodes it got', async () => {
  const { run, names } = runnerFor({ 'app.ts': EXPLAIN('app.ts'), 'routes.ts': EXPLAIN('routes.ts') });
  const result = await resolveGraphOrientation({
    files: ['apps/bff/src/app.ts', 'apps/bff/src/modules/dashboard/routes.ts'],
    cwd: '/repo', exists: GRAPH_PRESENT, run,
  });

  assert.equal(result.status, ORIENTATION_STATUS.OK);
  assert.deepEqual(result.nodes, ['app.ts', 'routes.ts']);
  assert.equal(result.partial, false);
  assert.deepEqual(names(), ['app.ts', 'routes.ts'], 'a unique basename is one lookup, not four');
});

test('an AMBIGUOUS name widens until it identifies one node, and exit 1 is an answer not a crash', async () => {
  const { run, names } = runnerFor(
    { 'bff/src/app.ts': EXPLAIN('bff/src/app.ts') },
    { ambiguous: ['app.ts', 'src/app.ts'] },
  );
  const result = await resolveGraphOrientation({
    files: ['apps/bff/src/app.ts'], cwd: '/repo', exists: GRAPH_PRESENT, run,
  });

  assert.equal(result.status, ORIENTATION_STATUS.OK, 'a non-zero exit carrying "Ambiguous" is not a failure');
  assert.deepEqual(result.nodes, ['bff/src/app.ts']);
  assert.deepEqual(names(), ['app.ts', 'src/app.ts', 'bff/src/app.ts'], 'widened one segment at a time');
});

test('the node name travels as ONE argv element, never through a shell', async () => {
  const { run, calls } = runnerFor({});
  // No slash, so path splitting leaves it intact and the argv boundary is
  // what is actually under test rather than an accident of truncation.
  const hostile = 'routes.ts" ; rm -rf . #';
  await resolveGraphOrientation({ files: [hostile], cwd: '/repo', exists: GRAPH_PRESENT, run });

  assert.deepEqual(calls[0].args, ['explain', hostile]);
  assert.equal(
    calls[0].args.length, 2,
    'quoting, chaining and comment characters are inert: nothing parses this string',
  );
});

test('a file the Goal is about to CREATE has no node yet and is skipped, not widened or failed', async () => {
  const { run, names } = runnerFor({ 'app.ts': EXPLAIN('app.ts') });
  const result = await resolveGraphOrientation({
    files: ['apps/bff/src/modules/status/routes.ts', 'apps/bff/src/app.ts'],
    cwd: '/repo', exists: GRAPH_PRESENT, run,
  });
  assert.equal(result.status, ORIENTATION_STATUS.OK);
  assert.deepEqual(result.nodes, ['app.ts'], 'only the node that exists is carried');
  assert.deepEqual(names(), ['routes.ts', 'app.ts'], 'an absent file is not widened — widening cannot find it');
});

test('every path being unknown is EMPTY, which is an answer and not an error', async () => {
  const { run } = runnerFor({});
  const result = await resolveGraphOrientation({
    files: ['apps/bff/src/modules/status/routes.ts'], cwd: '/repo', exists: GRAPH_PRESENT, run,
  });
  assert.equal(result.status, ORIENTATION_STATUS.EMPTY);
  assert.equal(result.text, null);
});

// --- the bound that the A/B probe exists to enforce ---------------------

test('the briefing stops at the character cap and reports itself as partial', async () => {
  const big = 'x'.repeat(MAX_ORIENTATION_CHARS - 100);
  const { run } = runnerFor({ 'one.ts': big, 'two.ts': big });
  const result = await resolveGraphOrientation({
    files: ['src/a/one.ts', 'src/b/two.ts'], cwd: '/repo', exists: GRAPH_PRESENT, run,
  });

  assert.equal(result.status, ORIENTATION_STATUS.OK);
  assert.ok(result.text.length <= MAX_ORIENTATION_CHARS, 'never exceeds the cap, it stops before crossing it');
  assert.deepEqual(result.nodes, ['one.ts'], 'the second node is dropped whole, never truncated mid-answer');
  assert.equal(result.partial, true);
});

test('at most MAX_EXPLAIN_NODES files are looked up, however many are handed in', async () => {
  const table = Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [`routes${i}.ts`, EXPLAIN(`routes${i}.ts`)]),
  );
  const { run, calls } = runnerFor(table);
  await resolveGraphOrientation({
    files: Array.from({ length: 20 }, (_, i) => `src/mod${i}/routes${i}.ts`),
    cwd: '/repo', exists: GRAPH_PRESENT, run,
  });
  assert.equal(calls.length, MAX_EXPLAIN_NODES);
});

// --- failure is never fatal ---------------------------------------------

test('a missing graphify binary is reported, not thrown, and stops the remaining lookups', async () => {
  const calls = [];
  const run = async (invocation) => {
    calls.push(invocation);
    return { error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), stdout: '' };
  };
  const result = await resolveGraphOrientation({
    files: ['a/one.ts', 'b/two.ts', 'c/three.ts'], cwd: '/repo', exists: GRAPH_PRESENT, run,
  });
  assert.equal(result.status, ORIENTATION_STATUS.FAILED);
  assert.equal(result.reason, 'GRAPHIFY_NOT_FOUND');
  assert.equal(calls.length, 1, 'a missing binary stays missing; it is not retried per file');
});

test('a timeout is reported as TIMEOUT, distinct from a non-zero exit', async () => {
  const timedOut = async () => ({ error: Object.assign(new Error('killed'), { killed: true }), stdout: '' });
  const crashed = async () => ({ error: Object.assign(new Error('exit 2'), { code: 2 }), stdout: 'segfault' });
  const files = ['a/one.ts'];

  assert.equal(
    (await resolveGraphOrientation({ files, cwd: '/r', exists: GRAPH_PRESENT, run: timedOut })).reason,
    'TIMEOUT',
  );
  assert.equal(
    (await resolveGraphOrientation({ files, cwd: '/r', exists: GRAPH_PRESENT, run: crashed })).reason,
    'EXIT_ERROR',
  );
});

test('a failure AFTER a node resolved keeps the partial briefing rather than discarding it', async () => {
  let call = 0;
  const run = async (invocation) => {
    call += 1;
    if (call === 1) return { error: null, stdout: EXPLAIN(invocation.args[1]), stderr: '' };
    return { error: Object.assign(new Error('killed'), { killed: true }), stdout: '' };
  };
  const result = await resolveGraphOrientation({
    files: ['a/one.ts', 'b/two.ts'], cwd: '/repo', exists: GRAPH_PRESENT, run,
  });
  assert.equal(result.status, ORIENTATION_STATUS.OK, 'some orientation beats none');
  assert.deepEqual(result.nodes, ['one.ts']);
  assert.equal(result.partial, true);
});
