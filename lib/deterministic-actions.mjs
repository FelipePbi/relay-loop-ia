/**
 * IA Loop — the commands a Work Unit may run without a model.
 *
 * §5: `lint`, `typecheck`, `build`, tests and `git diff --check` are commands.
 * Asking Haiku to type `npm run typecheck` pays for an inference to produce a
 * string the orchestrator already knows, and then pays again for the model to
 * read the output it could have read itself. So the orchestrator runs them.
 *
 * The registry is CLOSED, and that is the security property, not a
 * convenience. A plan names an ACTION, never a command line: a model-authored
 * shell string is not something this file will execute, whatever the plan says
 * and however plausible the string looks. `scope` and `pattern` are the only
 * planner-supplied inputs, both validated against narrow patterns in
 * work-units.mjs, and nothing is ever passed through a shell — every action is
 * spawned as argv, so there is no metacharacter to mean anything.
 *
 * `targeted` marks the actions cheap enough to run per unit; `global` marks
 * the ones a plan should place once, at the end. §29's "targeted first, global
 * afterwards" is a property of how a plan is written, and this is the field
 * that lets a reader see whether it was.
 */

import { SpikeError } from './claude-process.mjs';

/**
 * Where an action runs.
 *
 *   WORKTREE   the Goal's worktree root (the default; the tree under change)
 *   SCOPE      a workspace directory inside the worktree, named by the unit
 */
export const ACTION_CWD = Object.freeze({ WORKTREE: 'WORKTREE', SCOPE: 'SCOPE' });

/**
 * The actions, and exactly what each one runs.
 *
 * `command` is argv, split already: there is no string to parse and therefore
 * no place for a quoting mistake to become an injection.
 */
export const DETERMINISTIC_ACTIONS = Object.freeze({
  typecheck: Object.freeze({
    name: 'typecheck',
    label: 'TypeScript typecheck',
    command: Object.freeze(['npx', 'tsc', '--noEmit']),
    cwd: ACTION_CWD.SCOPE,
    requiresScope: true,
    requiresPattern: false,
    targeted: true,
  }),
  lint: Object.freeze({
    name: 'lint',
    label: 'Lint',
    command: Object.freeze(['npm', 'run', 'lint']),
    cwd: ACTION_CWD.SCOPE,
    requiresScope: true,
    requiresPattern: false,
    targeted: true,
  }),
  'targeted-tests': Object.freeze({
    name: 'targeted-tests',
    label: 'Targeted tests',
    // Vitest is what apps/* use; the pattern is the file or directory filter.
    command: Object.freeze(['npx', 'vitest', 'run']),
    appendPattern: true,
    cwd: ACTION_CWD.SCOPE,
    requiresScope: true,
    requiresPattern: true,
    targeted: true,
  }),
  'unit-tests': Object.freeze({
    name: 'unit-tests',
    label: 'Unit tests',
    command: Object.freeze(['npm', 'test']),
    cwd: ACTION_CWD.SCOPE,
    requiresScope: true,
    requiresPattern: false,
    targeted: true,
  }),
  'tooling-tests': Object.freeze({
    name: 'tooling-tests',
    label: 'IA Loop tooling tests',
    command: Object.freeze(['npm', 'run', 'test:ia-loop']),
    cwd: ACTION_CWD.WORKTREE,
    requiresScope: false,
    requiresPattern: false,
    targeted: true,
  }),
  'gate-tests': Object.freeze({
    name: 'gate-tests',
    label: 'Validation gate scripts',
    command: Object.freeze(['npm', 'run', 'test:gate']),
    cwd: ACTION_CWD.WORKTREE,
    requiresScope: false,
    requiresPattern: false,
    targeted: true,
  }),
  'git-diff-check': Object.freeze({
    name: 'git-diff-check',
    label: 'git diff --check',
    command: Object.freeze(['git', 'diff', '--check']),
    cwd: ACTION_CWD.WORKTREE,
    requiresScope: false,
    requiresPattern: false,
    targeted: true,
  }),
  build: Object.freeze({
    name: 'build',
    label: 'Build all workspaces',
    command: Object.freeze(['npm', 'run', 'build:all']),
    cwd: ACTION_CWD.WORKTREE,
    requiresScope: false,
    requiresPattern: false,
    targeted: false,
  }),
  'validate-core': Object.freeze({
    name: 'validate-core',
    label: 'Core validation gate',
    command: Object.freeze(['npm', 'run', 'validate:core']),
    cwd: ACTION_CWD.WORKTREE,
    requiresScope: false,
    requiresPattern: false,
    targeted: false,
  }),
  /**
   * The integration gate, which needs databases the harness does not yet
   * provision.
   *
   * `scripts/validate-integration.mjs` refuses to run unless every
   * `*_TEST_DATABASE_URL` names a disposable cluster — deliberately, so it can
   * never fall back to an inherited `DATABASE_URL` and write to something
   * real. The orchestrator does not start one (`lib/temporary-postgres.mjs`
   * exists and has no caller), so the command exits instantly.
   *
   * Measured on Goal 014: three attempts, exit 2 every time, each one spending
   * a fix unit on a defect no model can repair, and the gate reported as a
   * failure of the Goal rather than of its own precondition. Declaring the
   * requirement turns that into one honest skip. It does NOT make the gate
   * pass — provisioning the cluster is separate work.
   */
  'validate-integration': Object.freeze({
    name: 'validate-integration',
    label: 'Integration validation gate',
    command: Object.freeze(['npm', 'run', 'validate:integration']),
    cwd: ACTION_CWD.WORKTREE,
    requiresScope: false,
    requiresPattern: false,
    targeted: false,
    requiresEnv: Object.freeze([
      'BFF_TEST_DATABASE_URL',
      'AI_TEST_DATABASE_URL',
      'EVOLUTION_TEST_DATABASE_URL',
      'SCHEDULING_TEST_DATABASE_URL',
    ]),
  }),
  /**
   * The rendered gate: Playwright over Chromium at the five widths the vault
   * names.
   *
   * It belongs HERE, as a command the orchestrator runs, rather than as
   * something the reviewer drives, for the same reason as every other action:
   * a model that starts a browser pays for inference to produce a string, and
   * pays again to read output it never needed to read. It also keeps browser
   * flakiness out of a review, where a spurious failure costs a whole round
   * instead of a re-run.
   *
   * `global`, and it must be placed after `validate-core`: the gate serves the
   * built app with `next start`, and `validate:core` is what produces the
   * build it serves.
   */
  'validate-ui': Object.freeze({
    name: 'validate-ui',
    label: 'Rendered UI gate',
    command: Object.freeze(['npm', 'run', 'validate:ui']),
    cwd: ACTION_CWD.WORKTREE,
    requiresScope: false,
    requiresPattern: false,
    targeted: false,
  }),
});

export const DETERMINISTIC_ACTION_NAMES = Object.freeze(Object.keys(DETERMINISTIC_ACTIONS));

/**
 * Resolves an action name to its spec. Fails closed: an unknown name is never
 * approximated to the nearest known one, because "run something like the
 * typecheck" is not a thing a verification step may do.
 */
export function assertDeterministicAction(name, field = 'action') {
  const spec = DETERMINISTIC_ACTIONS[name];
  if (!spec) {
    throw new SpikeError(
      'UNKNOWN_DETERMINISTIC_ACTION',
      `Field "${field}" names ${JSON.stringify(name)}, which is not a permitted deterministic action `
      + `(known: ${DETERMINISTIC_ACTION_NAMES.join(', ')})`,
      { name, known: DETERMINISTIC_ACTION_NAMES },
    );
  }
  return spec;
}
