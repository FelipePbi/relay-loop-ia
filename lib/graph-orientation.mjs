/**
 * IA Loop — orientation from the code graph, resolved BEFORE the model runs.
 *
 * Measured on Goals 011–013: ~57% of every agent action is orientation —
 * `sed`, `grep`, `cat`, `ls` — and it is paid again by every Work Unit,
 * because each unit is a cold process. The repository already carries a code
 * graph built to answer exactly those questions, and a PreToolUse hook that
 * tells every agent to use it. The hook fires. The agents ignore it: 3
 * `graphify` calls against 630 orientation actions in Goal 013.
 *
 * So the harness consults the graph itself and hands the answer over inside
 * the context packet. No model call, no tokens — the same trade the
 * DETERMINISTIC tier already makes everywhere else.
 *
 * WHY `explain` AND NOT `query`
 *
 * The first version of this module ran `graphify query` on the unit's
 * objective. An A/B probe on Goal 014's WU-02 (same unit, same model, one
 * read-only pass each) rejected it: 25 turns / 0.94M tokens without it against
 * 26 turns / 1.11M with it. The mechanism worked — the oriented run dropped
 * Grep and Glob entirely — but it was oriented towards the wrong place.
 *
 * `query` does a depth-2 BFS from every symbol it can match in the question.
 * Feed it a 300-character objective and it seeds from ~20 nodes and returns
 * over a thousand, of which the budget shows twenty: for "add GET /v1/status
 * to the BFF" it surfaced the frontend's AppShell and three Go files. Retuning
 * the phrasing does not fix it — basenames scored 619 nodes, two-segment paths
 * 938, and the terse phrasing an agent writes by hand 547. The fan-out is the
 * command, not the wording.
 *
 * `explain` takes one node and returns that node plus its actual edges, with
 * file and line on both sides: ~1.6-2.2 KB, bounded by the node's real degree.
 * That is a briefing. The plan already names the files a unit will touch, so
 * there is nothing to guess — this asks the graph what those files are wired
 * to, which is the question a cold process would otherwise spend thirty
 * actions rediscovering.
 *
 * Three properties this MUST hold, because it runs on the hot path of every
 * unit:
 *
 *   never throws      a broken or missing graph degrades to "no orientation",
 *                     which is exactly today's behaviour. Orientation is an
 *                     optimisation; it may never be the reason a unit fails.
 *   never shells out  node names derive from plan-authored paths. They travel
 *                     as one argv element to execFile, so no quoting,
 *                     expansion or chaining is possible on any platform.
 *   always bounded    a cap on how many nodes are explained and on the total
 *                     text. Orientation that outgrows what it replaces is a
 *                     loss, and the probe above is what that looks like.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Where the graph lives, relative to the worktree being oriented. */
export const GRAPH_FILE = join('graphify-out', 'graph.json');

/**
 * How many files get explained.
 *
 * Four covers the change surface of every unit in Goals 010-014 without
 * approaching the text cap. A unit touching more than that is a unit whose
 * first four files still orient it.
 */
export const MAX_EXPLAIN_NODES = 4;

/** A graph lookup is local. If it is slow, something is wrong. */
export const DEFAULT_TIMEOUT_MS = 20_000;

/** Ceiling on the injected briefing, measured in characters of packet. */
export const MAX_ORIENTATION_CHARS = 6_000;

/** What `graphify explain` prints when the name matches nothing. */
const NO_MATCH = /^No node matching/m;

/** ...and when the name is too SHORT to identify one node. */
const AMBIGUOUS = /^Ambiguous:/m;

/** How many times a name is widened before giving up on a file. */
const MAX_WIDENINGS = 4;

/**
 * Why a packet carries no orientation. Recorded rather than hidden: a run
 * where orientation silently stopped working should be visible as such, not
 * indistinguishable from a run that never had it.
 */
export const ORIENTATION_STATUS = Object.freeze({
  OK: 'OK',
  /** Turned off by the operator. See `IA_LOOP_GRAPH_ORIENTATION`. */
  DISABLED: 'DISABLED',
  /** No graph in this worktree — vendored trees and fresh clones included. */
  NO_GRAPH: 'NO_GRAPH',
  /** The caller had no file paths to orient on. */
  NO_FILES: 'NO_FILES',
  /** The binary is absent, errored, or timed out. */
  FAILED: 'FAILED',
  /** It ran and matched nothing — every path is a file the Goal will create. */
  EMPTY: 'EMPTY',
});

function defaultRun({ binary, args, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      { cwd, timeout: timeoutMs, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ error, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });
}

/**
 * The names this graph might know a file by, shortest first.
 *
 * A node is keyed on its SHORTEST UNIQUE path suffix, which is not a fixed
 * depth: `AppShell.tsx` is one segment because nothing else is called that,
 * while `bff/src/app.ts` needs three because two apps have an `app.ts`. Asking
 * for more segments than a node was given misses it outright — measured:
 * `explain "layout/AppShell.tsx"` finds nothing while `explain "AppShell.tsx"`
 * finds it.
 *
 * So the caller does not guess. It walks the suffixes from the basename
 * outward, and `graphify` itself says which one is right: a too-short name
 * answers `Ambiguous:` and a name for a file outside the graph answers
 * `No node matching`. Those are different answers and the resolver treats
 * them differently.
 */
export function candidateNodeNames(path, { max = MAX_WIDENINGS } = {}) {
  if (typeof path !== 'string') return [];
  const segments = path.trim().split(/[\\/]/).filter((segment) => segment !== '');
  if (segments.length === 0) return [];

  const names = [];
  for (let depth = 1; depth <= Math.min(max, segments.length); depth += 1) {
    names.push(segments.slice(-depth).join('/'));
  }
  return names;
}

/** Paths worth looking up, deduplicated by basename, order preserved, bounded. */
export function candidatePaths(paths, { max = MAX_EXPLAIN_NODES } = {}) {
  const seen = new Set();
  const out = [];
  for (const path of paths ?? []) {
    if (typeof path !== 'string' || path.trim() === '') continue;
    // A directory pointer ("src/features/") names no node.
    if (/[\\/]$/.test(path.trim())) continue;
    const key = path.trim().split(/[\\/]/).pop();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(path.trim());
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Explains the files this unit (or this diff) is about, and returns what the
 * packet should carry.
 *
 * Every failure mode resolves; none rejects. The caller attaches the result
 * verbatim, including a non-OK status, so that "this unit had no map" stays a
 * readable fact in the ledger rather than a silent absence.
 */
export async function resolveGraphOrientation({
  files,
  cwd,
  maxNodes = MAX_EXPLAIN_NODES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  binary = process.env.IA_LOOP_GRAPHIFY_BIN || 'graphify',
  enabled = process.env.IA_LOOP_GRAPH_ORIENTATION !== '0',
  run = defaultRun,
  exists = existsSync,
} = {}) {
  // A kill switch, because the benefit is not yet proven. Two A/B probes on a
  // single unit could not resolve it: the same prompt A varied 25 -> 15 turns
  // between runs, so run-to-run variance is wider than the effect. What IS
  // known is the price — roughly 1.1k tokens of packet per unit, ~0.2% of a
  // Goal — so this ships on and gets measured across a real Goal's units,
  // where the ledger already records status, turns and tokens per unit.
  if (!enabled) {
    return Object.freeze({ status: ORIENTATION_STATUS.DISABLED, nodes: Object.freeze([]), text: null });
  }

  const paths = candidatePaths(files, { max: maxNodes });
  if (paths.length === 0) {
    return Object.freeze({ status: ORIENTATION_STATUS.NO_FILES, nodes: Object.freeze([]), text: null });
  }
  if (!cwd || !exists(join(cwd, GRAPH_FILE))) {
    return Object.freeze({ status: ORIENTATION_STATUS.NO_GRAPH, nodes: Object.freeze([]), text: null });
  }

  const startedMs = Date.now();
  const sections = [];
  const explained = [];
  let failure = null;

  outer:
  for (const path of paths) {
    for (const name of candidateNodeNames(path)) {
      // argv array, no shell: `name` derives from a plan a model wrote.
      const { error, stdout, stderr } = await run({ binary, args: ['explain', name], cwd, timeoutMs });

      // A binary that is missing or hanging stays that way for every
      // remaining node too, so those two abandon the whole briefing.
      if (error?.code === 'ENOENT') { failure = 'GRAPHIFY_NOT_FOUND'; break outer; }
      if (error?.killed) { failure = 'TIMEOUT'; break outer; }

      // Read the OUTPUT before judging the exit code: `Ambiguous` exits 1, and
      // treating that as a crash is what made a perfectly resolvable unit come
      // back FAILED. A non-zero exit here is an answer, not an error.
      const text = (stdout || stderr || '').trim();

      // Too short to identify one node: widen and ask again.
      if (AMBIGUOUS.test(text)) continue;
      // Not in the graph at all — a file this Goal will create, or one of the
      // `docs/` paths the graph excludes by design. Widening cannot help.
      if (text === '' || NO_MATCH.test(text)) break;
      // Non-zero for a reason this resolver does not recognise.
      if (error) { failure = 'EXIT_ERROR'; break outer; }

      const next = [...sections, text].join('\n\n');
      if (next.length > MAX_ORIENTATION_CHARS) break outer;
      sections.push(text);
      explained.push(name);
      break;
    }
  }

  const durationMs = Date.now() - startedMs;

  if (sections.length === 0) {
    return failure
      ? Object.freeze({ status: ORIENTATION_STATUS.FAILED, nodes: Object.freeze([]), text: null, reason: failure, durationMs })
      : Object.freeze({ status: ORIENTATION_STATUS.EMPTY, nodes: Object.freeze([]), text: null, durationMs });
  }

  return Object.freeze({
    status: ORIENTATION_STATUS.OK,
    nodes: Object.freeze(explained),
    // Present even on a partial answer: some orientation beat none, and the
    // node list says exactly how far it got.
    partial: explained.length < paths.length,
    text: sections.join('\n\n'),
    durationMs,
  });
}
