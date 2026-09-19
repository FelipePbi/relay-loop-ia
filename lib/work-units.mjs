/**
 * IA Loop — Work Units and the execution DAG.
 *
 * A Goal used to be ONE task handed to ONE Developer model. Everything the
 * Goal touched — a boilerplate DTO, a service with real business logic, and
 * `npm run typecheck` — was paid for at the same price, on the same model,
 * with the same whole-Goal context re-read for each of them.
 *
 * A Work Unit is the smallest thing worth routing separately: self-contained
 * enough to execute, small enough to be given a narrow context, big enough to
 * produce a useful result, and verifiable on its own. It is deliberately NOT a
 * microtask — "add an import" is not a unit, and the normaliser below exists to
 * merge such things back together before anything is executed.
 *
 * Three properties this file is built around:
 *
 *   DECLARATIVE   the plan states TYPE, COMPLEXITY and RISK. It never states a
 *                 model. Which model runs is the router's decision and lives in
 *                 model-routing.mjs, so the model policy stays in one place.
 *                 A plan that names a model is REFUSED, not quietly obeyed.
 *   VALIDATED     unique ids, resolvable dependencies, no cycles, acceptance
 *                 criteria present, known types, permitted deterministic
 *                 actions. A plan that fails any of these is PLAN_INVALID and
 *                 nothing is dispatched — a cycle must never be discovered by
 *                 a worker that has already started.
 *   ORDERED       the dependencies form a DAG, and the DAG is the schedule.
 *                 Topological order is derived here, once, from the plan.
 */

import { SpikeError } from './claude-process.mjs';
import { DETERMINISTIC_ACTIONS, assertDeterministicAction } from './deterministic-actions.mjs';

/**
 * What kind of work a unit is — and therefore, through the router, what runs it.
 *
 *   DETERMINISTIC  a command. No model is called at all; the orchestrator runs
 *                  the tool itself. Asking a model to run `npm run typecheck`
 *                  is paying for an inference to type a command.
 *   MECHANICAL     the behaviour is already decided and the pattern already
 *                  exists. Cheap model.
 *   STANDARD       ordinary implementation work: business logic, services,
 *                  integrations, behavioural tests. The main executor.
 *   COMPLEX        the small set of things where being wrong is expensive:
 *                  concurrency, state machines, recovery, data consistency,
 *                  cross-cutting architectural change.
 */
export const WORK_UNIT_TYPES = Object.freeze(['DETERMINISTIC', 'MECHANICAL', 'STANDARD', 'COMPLEX']);

export const WORK_UNIT_COMPLEXITY = Object.freeze(['LOW', 'MEDIUM', 'HIGH']);
export const WORK_UNIT_RISK = Object.freeze(['LOW', 'MEDIUM', 'HIGH']);

/**
 * The lifecycle of one unit inside a round.
 *
 * PENDING   declared, dependencies not satisfied yet
 * READY     dependencies satisfied, nothing has claimed it
 * RUNNING   an attempt is in flight
 * COMPLETED it produced a result under contract
 * FAILED    it was attempted and did not succeed
 * ESCALATED its attempt ended because the router moved it to a stronger model
 * BLOCKED   a dependency failed, so it can never become READY
 * SKIPPED   normalisation merged it away, or the round retired it
 * OBSERVED  a gate ran over a tree a dependency left incomplete. Its answer
 *           is real and reaches the reviewer; it is not acceptance, which is
 *           why it is its own state and never COMPLETED.
 */
export const WORK_UNIT_STATES = Object.freeze([
  'PENDING', 'READY', 'RUNNING', 'COMPLETED', 'FAILED', 'ESCALATED', 'BLOCKED', 'SKIPPED', 'OBSERVED',
]);

/** Id prefixes with a meaning. Closed, so an id always says what it is. */
export const WORK_UNIT_ID_PREFIXES = Object.freeze(['WU', 'VERIFY', 'FIX', 'DIAG']);

const ID_PATTERN = new RegExp(`^(${WORK_UNIT_ID_PREFIXES.join('|')})-\\d{1,3}$`);

/**
 * Fields a plan may never carry.
 *
 * The Tech Lead declares the NATURE of the work; the router decides the model.
 * A plan that says `model: haiku` has taken a decision that belongs somewhere
 * else, and accepting it would put the model policy in two places — which is
 * exactly what centralising it was for. Refused rather than stripped: silently
 * ignoring a field a planner believed in is worse than saying no.
 */
const FORBIDDEN_UNIT_FIELDS = Object.freeze([
  'model', 'modelKey', 'modelId', 'profile', 'developerProfile', 'effort', 'executor',
]);

/**
 * Fragmentation limits.
 *
 * A guard, not a straitjacket. These are the bands a plan is REPORTED against;
 * only `hardMax` actually refuses one, because "this Goal genuinely has eleven
 * units" must stay possible while "this Goal has eighty" must not.
 */
export const FRAGMENTATION_LIMITS = Object.freeze({
  small: Object.freeze({ min: 1, max: 3 }),
  medium: Object.freeze({ min: 3, max: 8 }),
  large: Object.freeze({ min: 5, max: 15 }),
  hardMax: 20,
});

function fail(code, message, details = {}) {
  throw new SpikeError(code, message, details);
}

function assertNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('PLAN_INVALID', `Field "${field}" must be a non-empty string`);
  }
  return value.trim();
}

function assertStringArray(value, field, { maxItems = 200 } = {}) {
  if (!Array.isArray(value)) fail('PLAN_INVALID', `Field "${field}" must be an array`);
  if (value.length > maxItems) {
    fail('PLAN_INVALID', `Field "${field}" carries ${value.length} entries; the limit is ${maxItems}`);
  }
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      fail('PLAN_INVALID', `Field "${field}[${index}]" must be a non-empty string`);
    }
    return item.trim();
  });
}

/**
 * The complexity a unit gets when the plan did not state one.
 *
 * Derived from the type rather than defaulted to LOW: a COMPLEX unit with an
 * absent complexity field is not a low-complexity unit, and a router that read
 * it as one would undo the classification the planner did make.
 */
const DEFAULT_COMPLEXITY_FOR_TYPE = Object.freeze({
  DETERMINISTIC: 'LOW',
  MECHANICAL: 'LOW',
  STANDARD: 'MEDIUM',
  COMPLEX: 'HIGH',
});

/** Workspace directories a deterministic action may run in. Closed on purpose. */
const SCOPE_PATTERN = /^(apps|packages|tools|scripts)\/[A-Za-z0-9._-]+$/;

function assertActionScope(scope, id, spec) {
  if (scope === undefined || scope === null || scope === '') {
    if (spec.requiresScope) {
      fail('PLAN_INVALID', `Work Unit ${id} runs "${spec.name}", which needs a scope (e.g. apps/bff)`, { id });
    }
    return null;
  }
  const value = assertNonEmptyString(scope, `${id}.scope`);
  if (!SCOPE_PATTERN.test(value)) {
    fail(
      'PLAN_INVALID',
      `Work Unit ${id} names scope ${JSON.stringify(value)}, which is not a workspace directory `
      + '(expected apps/<name>, packages/<name>, tools/<name> or scripts/<name>)',
      { id, scope: value },
    );
  }
  return value;
}

/**
 * A test path or filter.
 *
 * Restricted to characters that cannot mean anything to a shell. Nothing here
 * is ever passed THROUGH a shell — the executor spawns argv directly — but a
 * value that cannot express a metacharacter also cannot express an intent
 * nobody reviewed.
 */
const PATTERN_SAFE = /^[A-Za-z0-9._\-/*]{1,200}$/;

function assertActionPattern(pattern, id, spec) {
  if (pattern === undefined || pattern === null || pattern === '') {
    if (spec.requiresPattern) {
      fail('PLAN_INVALID', `Work Unit ${id} runs "${spec.name}", which needs a test pattern`, { id });
    }
    return null;
  }
  const value = assertNonEmptyString(pattern, `${id}.pattern`);
  if (!PATTERN_SAFE.test(value)) {
    fail('PLAN_INVALID', `Work Unit ${id} names an unsafe test pattern ${JSON.stringify(value)}`, { id });
  }
  return value;
}

/**
 * Validates one Work Unit in isolation.
 *
 * Cross-unit facts (duplicate ids, dangling dependencies, cycles) are NOT
 * checked here: they are properties of the plan, and checking them per unit
 * would report the same cycle three times without ever naming it.
 */
export function validateWorkUnit(raw, { index = null } = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('PLAN_INVALID', `Work Unit ${index === null ? '' : `#${index} `}is not a JSON object`);
  }

  for (const field of FORBIDDEN_UNIT_FIELDS) {
    if (raw[field] !== undefined) {
      fail(
        'PLAN_DECLARES_MODEL',
        `Work Unit ${raw.id ?? `#${index}`} declares "${field}". A plan states type, complexity and risk; `
        + 'which model runs is the router’s decision and is never named here.',
        { unit: raw.id ?? null, field },
      );
    }
  }

  const id = assertNonEmptyString(raw.id, 'id');
  if (!ID_PATTERN.test(id)) {
    fail(
      'PLAN_INVALID',
      `Work Unit id ${JSON.stringify(id)} is not in the expected shape `
      + `(${WORK_UNIT_ID_PREFIXES.join('|')} followed by up to three digits, e.g. WU-001)`,
      { id },
    );
  }

  if (!WORK_UNIT_TYPES.includes(raw.type)) {
    fail(
      'PLAN_INVALID',
      `Work Unit ${id} has type ${JSON.stringify(raw.type)} (expected one of: ${WORK_UNIT_TYPES.join(', ')})`,
      { id, type: raw.type ?? null },
    );
  }

  const objective = assertNonEmptyString(raw.objective, `${id}.objective`);
  const complexity = raw.complexity ?? DEFAULT_COMPLEXITY_FOR_TYPE[raw.type];
  if (!WORK_UNIT_COMPLEXITY.includes(complexity)) {
    fail('PLAN_INVALID', `Work Unit ${id} has complexity ${JSON.stringify(complexity)}`, { id });
  }
  const risk = raw.risk ?? 'LOW';
  if (!WORK_UNIT_RISK.includes(risk)) {
    fail('PLAN_INVALID', `Work Unit ${id} has risk ${JSON.stringify(risk)}`, { id });
  }

  const dependencies = assertStringArray(raw.dependencies ?? [], `${id}.dependencies`, { maxItems: 20 });
  if (dependencies.includes(id)) {
    fail('PLAN_CYCLE', `Work Unit ${id} depends on itself`, { cycle: [id, id] });
  }

  const expectedFiles = assertStringArray(raw.expectedFiles ?? [], `${id}.expectedFiles`, { maxItems: 60 });
  const relevantFiles = assertStringArray(raw.relevantFiles ?? [], `${id}.relevantFiles`, { maxItems: 60 });
  const acceptanceCriteria = assertStringArray(raw.acceptanceCriteria ?? [], `${id}.acceptanceCriteria`, { maxItems: 20 });
  const verification = assertStringArray(raw.verification ?? [], `${id}.verification`, { maxItems: 10 });
  for (const name of verification) assertDeterministicAction(name, `${id}.verification`);

  if (raw.type === 'DETERMINISTIC') {
    // A deterministic unit IS a command, so it must name one — from the closed
    // registry, never as free text. A model-authored shell string is not
    // something this executes, whatever the plan says.
    const action = assertNonEmptyString(raw.action, `${id}.action`);
    const spec = assertDeterministicAction(action, `${id}.action`);
    return Object.freeze({
      id,
      title: raw.title ? String(raw.title).slice(0, 160) : objective.slice(0, 160),
      objective,
      type: raw.type,
      complexity,
      risk,
      dependencies: Object.freeze(dependencies),
      action,
      scope: assertActionScope(raw.scope, id, spec),
      pattern: assertActionPattern(raw.pattern, id, spec),
      expectedFiles: Object.freeze(expectedFiles),
      relevantFiles: Object.freeze(relevantFiles),
      // Kept even though a command's acceptance criterion is its exit code:
      // what the planner meant by the step stays readable in the packet.
      acceptanceCriteria: Object.freeze(acceptanceCriteria),
      verification: Object.freeze([]),
      implementationHints: null,
      mergedFrom: Object.freeze([]),
    });
  }

  // Everything a model executes must say what "done" means. Without it there
  // is nothing to check the answer against, and the unit's result becomes the
  // model's own opinion of its own work.
  if (acceptanceCriteria.length === 0) {
    fail(
      'PLAN_INVALID',
      `Work Unit ${id} has no acceptanceCriteria. A unit a model executes must state what "done" means.`,
      { id },
    );
  }

  return Object.freeze({
    id,
    title: raw.title ? String(raw.title).slice(0, 160) : objective.slice(0, 160),
    objective,
    type: raw.type,
    complexity,
    risk,
    dependencies: Object.freeze(dependencies),
    action: null,
    scope: null,
    pattern: null,
    expectedFiles: Object.freeze(expectedFiles),
    relevantFiles: Object.freeze(relevantFiles),
    acceptanceCriteria: Object.freeze(acceptanceCriteria),
    verification: Object.freeze(verification),
    implementationHints: typeof raw.implementationHints === 'string'
      ? raw.implementationHints.slice(0, 1200)
      : null,
    mergedFrom: Object.freeze([]),
  });
}

// ---------------------------------------------------------------------------
// The DAG
// ---------------------------------------------------------------------------

/**
 * Topological order, and the proof there is one.
 *
 * Kahn's algorithm: every node whose dependencies are all placed becomes
 * available. If nodes remain when nothing is available, what remains IS the
 * cycle — which is what the error reports, because "there is a cycle
 * somewhere" is not actionable.
 *
 * Ties are broken by declaration order, so the schedule of a valid plan is
 * stable across processes: a restart schedules the same thing next.
 */
export function topologicalOrder(units) {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const remaining = new Map(units.map((unit) => [unit.id, new Set(unit.dependencies)]));
  const order = [];
  const levels = new Map();
  let level = 0;

  for (;;) {
    const available = units
      .filter((unit) => remaining.has(unit.id) && remaining.get(unit.id).size === 0)
      .map((unit) => unit.id);

    if (available.length === 0) break;

    // Every unit in this wave has all of its dependencies already placed, so
    // they are independent of each other — that is what a level is, and it is
    // what a future scheduler would parallelise.
    for (const id of available) {
      order.push(byId.get(id));
      levels.set(id, level);
      remaining.delete(id);
    }
    for (const pending of remaining.values()) {
      for (const id of available) pending.delete(id);
    }
    level += 1;
  }

  if (remaining.size > 0) {
    const cycle = [...remaining.keys()];
    fail(
      'PLAN_CYCLE',
      `The execution plan has a dependency cycle involving: ${cycle.join(' -> ')}. `
      + 'Nothing is dispatched: a cycle discovered by a worker is a worker that never finishes.',
      { cycle },
    );
  }

  return { order, levels };
}

/**
 * Independent units, grouped by DAG level.
 *
 * Derived even though execution is serial today: the information is a property
 * of the PLAN, not of the scheduler, and recording it now makes safe
 * parallelism later a scheduling change rather than a re-analysis.
 */
export function executionLevels(units) {
  const { levels } = topologicalOrder(units);
  const grouped = new Map();
  for (const unit of units) {
    const level = levels.get(unit.id);
    if (!grouped.has(level)) grouped.set(level, []);
    grouped.get(level).push(unit.id);
  }
  return [...grouped.entries()].sort(([a], [b]) => a - b).map(([, ids]) => ids);
}

// ---------------------------------------------------------------------------
// Normalisation — merging units too small to be worth their overhead
// ---------------------------------------------------------------------------

/**
 * Objectives that describe an edit, not a deliverable.
 *
 * Deliberately narrow. The point is to catch "adicionar import" and "add an
 * export", not to second-guess a planner that wrote a small but real unit.
 * Anything not matched here is left exactly as the plan wrote it.
 */
const TRIVIAL_OBJECTIVE = new RegExp(
  '^(adicionar|add|criar|create|inserir|insert|remover|remove|renomear|rename|exportar|export|importar|import)\\s+'
  + '(um |uma |o |a |the |an |as )?'
  + '(import|export|const|vari[aá]vel|variable|return|linha|line|campo|field|alias|tipo|type)\\b',
  'i',
);

/**
 * How many trivial edits one merge may absorb.
 *
 * A bound, because merging is only a saving while the result is still one
 * coherent deliverable. Absorb ten and the "unit" is a shopping list with one
 * context and one acceptance check covering ten unrelated edits, which is the
 * problem decomposition was meant to solve, inverted.
 */
const MAX_MERGE_CHAIN = 4;

function isTrivial(unit) {
  if (unit.type !== 'MECHANICAL') return false;
  if (unit.acceptanceCriteria.length > 1) return false;
  if (unit.expectedFiles.length > 1) return false;
  if (unit.objective.length > 120) return false;
  return TRIVIAL_OBJECTIVE.test(unit.objective);
}

/**
 * Whether a unit may still absorb another.
 *
 * Judged on what the unit ORIGINALLY was, not on what it has accumulated. A
 * unit that has already absorbed two trivial edits necessarily has three
 * acceptance criteria and a longer objective, so re-deriving triviality from
 * the accumulated fields would stop every chain after exactly one merge — and
 * "create the file, add the export, add the import" is the three-step chain
 * this exists to collapse.
 */
function isMergeable(unit, trivialIds) {
  if (!trivialIds.has(unit.id)) return false;
  const absorbed = (unit.mergedFrom ?? []).length;
  if (absorbed >= MAX_MERGE_CHAIN) return false;
  return (unit.mergedFrom ?? []).every((id) => trivialIds.has(id));
}

/**
 * Merges chains of trivial units before anything is executed.
 *
 * The rule is deliberately conservative: A and B merge only when B's ONLY
 * dependency is A, nothing else depends on A, and both are trivial MECHANICAL
 * units. Anything looser starts rewriting a plan the Tech Lead meant, and the
 * cost of a wrong merge — two unrelated changes in one unit, one context, one
 * acceptance check — is higher than the overhead it saves.
 *
 * The merged unit keeps the PARENT's id, so every dependency edge pointing at
 * it stays valid, and records what it absorbed in `mergedFrom`, so the audit
 * trail never loses a unit the planner declared.
 */
export function normalizeWorkUnits(units) {
  const merges = [];
  const declarationOrder = units.map((unit) => unit.id);
  // Decided once, on the units as declared. See `isMergeable`.
  const trivialIds = new Set(units.filter((unit) => isTrivial(unit)).map((unit) => unit.id));
  let current = units.map((unit) => ({ ...unit, mergedFrom: [...(unit.mergedFrom ?? [])] }));

  for (;;) {
    const dependents = new Map();
    for (const unit of current) {
      for (const dependency of unit.dependencies) {
        if (!dependents.has(dependency)) dependents.set(dependency, []);
        dependents.get(dependency).push(unit.id);
      }
    }

    const child = current.find((unit) => {
      if (!trivialIds.has(unit.id)) return false;
      if (unit.dependencies.length !== 1) return false;
      const parent = current.find((candidate) => candidate.id === unit.dependencies[0]);
      if (!parent || !isMergeable(parent, trivialIds)) return false;
      // The parent must have exactly this one dependent, or merging would
      // silently drop a branch of the DAG.
      return (dependents.get(parent.id) ?? []).length === 1;
    });

    if (!child) break;

    const parent = current.find((candidate) => candidate.id === child.dependencies[0]);
    const merged = {
      ...parent,
      objective: `${parent.objective}; ${child.objective}`,
      acceptanceCriteria: [...parent.acceptanceCriteria, ...child.acceptanceCriteria],
      expectedFiles: [...new Set([...parent.expectedFiles, ...child.expectedFiles])],
      relevantFiles: [...new Set([...parent.relevantFiles, ...child.relevantFiles])],
      verification: [...new Set([...parent.verification, ...child.verification])],
      mergedFrom: [...(parent.mergedFrom ?? []), child.id, ...(child.mergedFrom ?? [])],
    };

    merges.push({ into: parent.id, absorbed: child.id });
    current = current
      .filter((unit) => unit.id !== child.id && unit.id !== parent.id)
      .map((unit) => ({
        ...unit,
        // Anything that depended on the absorbed unit now depends on the one
        // that absorbed it. The edge is preserved, not dropped.
        dependencies: [...new Set(unit.dependencies.map((d) => (d === child.id ? parent.id : d)))],
      }));
    current.push(merged);
    current.sort((a, b) => declarationOrder.indexOf(a.id) - declarationOrder.indexOf(b.id));
  }

  return {
    units: current.map((unit) => Object.freeze({
      ...unit,
      dependencies: Object.freeze([...unit.dependencies]),
      acceptanceCriteria: Object.freeze([...unit.acceptanceCriteria]),
      expectedFiles: Object.freeze([...unit.expectedFiles]),
      relevantFiles: Object.freeze([...unit.relevantFiles]),
      verification: Object.freeze([...unit.verification]),
      mergedFrom: Object.freeze(unit.mergedFrom ?? []),
    })),
    merges,
  };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** How fragmented a plan is, against the bands above. Reported, not enforced. */
export function describeFragmentation(count) {
  if (count <= FRAGMENTATION_LIMITS.small.max) return { band: 'SMALL', count, withinGuidance: true };
  if (count <= FRAGMENTATION_LIMITS.medium.max) return { band: 'MEDIUM', count, withinGuidance: true };
  if (count <= FRAGMENTATION_LIMITS.large.max) return { band: 'LARGE', count, withinGuidance: true };
  return { band: 'OVER_GUIDANCE', count, withinGuidance: false };
}

/**
 * Validates a whole execution plan and derives its schedule.
 *
 * Everything that can make execution unsafe is decided HERE, before a single
 * unit is dispatched: duplicate ids, dangling dependencies, cycles, unknown
 * types, an unpermitted deterministic action, absurd fragmentation.
 */
export function validateExecutionPlan(raw, { goal = null, normalize = true } = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('PLAN_INVALID', 'ExecutionPlan is not a JSON object');
  }
  if (goal && raw.goal !== undefined && raw.goal !== null && raw.goal !== goal) {
    fail('PLAN_INVALID', `ExecutionPlan targets goal ${JSON.stringify(raw.goal)} but was read for ${goal}`);
  }

  if (!Array.isArray(raw.workUnits) || raw.workUnits.length === 0) {
    fail('PLAN_INVALID', 'ExecutionPlan must carry at least one work unit');
  }
  if (raw.workUnits.length > FRAGMENTATION_LIMITS.hardMax) {
    fail(
      'PLAN_FRAGMENTATION_EXCESSIVE',
      `ExecutionPlan declares ${raw.workUnits.length} work units; the ceiling is ${FRAGMENTATION_LIMITS.hardMax}. `
      + 'A plan this fragmented spends more on orchestration and repeated context than it saves on models.',
      { declared: raw.workUnits.length, hardMax: FRAGMENTATION_LIMITS.hardMax },
    );
  }

  const validated = raw.workUnits.map((unit, index) => validateWorkUnit(unit, { index }));

  const seen = new Set();
  for (const unit of validated) {
    if (seen.has(unit.id)) {
      fail('PLAN_DUPLICATE_ID', `Work Unit id ${unit.id} appears more than once`, { id: unit.id });
    }
    seen.add(unit.id);
  }

  for (const unit of validated) {
    for (const dependency of unit.dependencies) {
      if (!seen.has(dependency)) {
        fail(
          'PLAN_UNKNOWN_DEPENDENCY',
          `Work Unit ${unit.id} depends on ${dependency}, which the plan does not declare`,
          { unit: unit.id, dependency },
        );
      }
    }
  }

  const normalised = normalize ? normalizeWorkUnits(validated) : { units: validated, merges: [] };
  // Re-derived after merging: a merge rewrites dependency edges, and a plan is
  // only acyclic if it is acyclic in the form that will actually be executed.
  const { order, levels } = topologicalOrder(normalised.units);

  return Object.freeze({
    goal: raw.goal ?? goal ?? null,
    goalSummary: typeof raw.goalSummary === 'string' ? raw.goalSummary.slice(0, 2000) : null,
    executionStrategy: typeof raw.executionStrategy === 'string' ? raw.executionStrategy.slice(0, 1200) : null,
    workUnits: Object.freeze(normalised.units),
    order: Object.freeze(order.map((unit) => unit.id)),
    levels: Object.freeze(executionLevels(normalised.units).map((ids) => Object.freeze(ids))),
    levelOf: Object.freeze(Object.fromEntries(levels)),
    merges: Object.freeze(normalised.merges),
    fragmentation: Object.freeze(describeFragmentation(normalised.units.length)),
    // Set by whoever built the plan, so the review packet can say whether the
    // DAG came from the Tech Lead or from the compatibility fallback.
    source: typeof raw.source === 'string' ? raw.source : 'TECH_LEAD_PLAN',
  });
}

/** The unit with this id, or null. */
export function findUnit(plan, unitId) {
  return plan.workUnits.find((unit) => unit.id === unitId) ?? null;
}

/**
 * The JSON-schema fragment for a plan, handed to the CLI.
 *
 * Deliberately mirrors the validator rather than replacing it: the schema
 * stops most bad shapes at the source, and the validator is what actually
 * decides — a schema cannot express "no cycles".
 */
export const EXECUTION_PLAN_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    goalSummary: { type: 'string', maxLength: 2000 },
    executionStrategy: { type: 'string', maxLength: 1200 },
    workUnits: {
      type: 'array',
      minItems: 1,
      maxItems: FRAGMENTATION_LIMITS.hardMax,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string', maxLength: 160 },
          objective: { type: 'string', maxLength: 1200 },
          type: { type: 'string', enum: [...WORK_UNIT_TYPES] },
          complexity: { type: 'string', enum: [...WORK_UNIT_COMPLEXITY] },
          risk: { type: 'string', enum: [...WORK_UNIT_RISK] },
          dependencies: { type: 'array', items: { type: 'string' } },
          action: { type: 'string', enum: Object.keys(DETERMINISTIC_ACTIONS) },
          scope: { type: 'string' },
          pattern: { type: 'string' },
          expectedFiles: { type: 'array', items: { type: 'string' } },
          relevantFiles: { type: 'array', items: { type: 'string' } },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
          verification: { type: 'array', items: { type: 'string', enum: Object.keys(DETERMINISTIC_ACTIONS) } },
          implementationHints: { type: 'string', maxLength: 1200 },
        },
        required: ['id', 'objective', 'type', 'dependencies'],
        additionalProperties: false,
      },
    },
  },
  required: ['workUnits'],
  additionalProperties: false,
});
