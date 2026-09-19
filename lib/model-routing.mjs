/**
 * IA Loop — adaptive model routing.
 *
 * One place decides which model runs, for every role and every stage. Before
 * this, the choice was three constants in three files: the Tech Lead was Fable
 * for everything it ever did, and the Developer was whatever profile the
 * planning call had named. That spent the scarcest model on work that did not
 * need it, and left no way to ask afterwards WHY a model had been chosen.
 *
 * The policy, in one sentence: Opus is the Tech Lead, Sonnet is the standard
 * executor, and Fable is a specialist no default reaches — only an authorized
 * escalation or a human override puts a job on it.
 *
 *   tech_lead / planning   → Opus high      escalation → Fable high
 *   tech_lead / review     → Opus high      escalation → Fable high
 *   tech_lead / closure    → Opus high
 *   developer              default    → Sonnet high    escalation    → Opus high
 *                                                      deep          → Opus xhigh
 *
 * Three properties this file is built around:
 *
 *   DETERMINISTIC   the complexity classifier is text and state, never a model.
 *                   Calling a model to decide which model to call would spend
 *                   the very thing this exists to save.
 *   AUDITABLE       every decision carries its score, its signals and its
 *                   reason, and every change of model is a NEW attempt with the
 *                   old one intact. Nothing is ever rewritten to look like it
 *                   ran on a model it did not run on.
 *   REPLAYABLE      the model an attempt runs on is derived from persisted
 *                   state (the job's base routing plus its attempt history), so
 *                   a restart resolves the same answer instead of re-deciding.
 */

import { SpikeError } from './claude-process.mjs';
import { CAPACITY_REASONS } from './capacity-classifier.mjs';

// ---------------------------------------------------------------------------
// Registry — the only place a model id is written down
// ---------------------------------------------------------------------------

/**
 * Canonical models. `family` is what the anti-fallback check matches the
 * served model against, so it is not decoration.
 */
export const MODELS = Object.freeze({
  /**
   * The cheap executor, and only ever for MECHANICAL Work Units.
   *
   * It exists here so that "boilerplate, DTOs, exports, a route that follows a
   * pattern already in the tree" stops being billed at Sonnet's price. It is
   * deliberately NOT selectable by the Tech Lead and NOT a Developer profile:
   * the only path to it is the Work Unit router, and the only way off it is an
   * escalation that carries evidence.
   */
  haiku: Object.freeze({
    key: 'haiku', model: 'claude-haiku-4-5-20251001', family: 'haiku', label: 'Claude Haiku 4.5',
  }),
  sonnet: Object.freeze({
    key: 'sonnet', model: 'claude-sonnet-5', family: 'sonnet', label: 'Claude Sonnet 5',
  }),
  opus: Object.freeze({
    key: 'opus', model: 'claude-opus-5', family: 'opus', label: 'Claude Opus 5',
  }),
  fable: Object.freeze({
    key: 'fable', model: 'claude-fable-5-1', family: 'fable', label: 'Claude Fable 5.1',
  }),
});

export const MODEL_KEYS = Object.freeze(Object.keys(MODELS));

/** Resolves a model key to its record. Fails closed: an unknown key is never guessed. */
export function resolveModel(key) {
  const record = MODELS[key];
  if (!record) {
    throw new SpikeError('UNKNOWN_MODEL', `Unknown model key ${JSON.stringify(key)} (known: ${MODEL_KEYS.join(', ')})`);
  }
  return record;
}

/** The model key that serves a full CLI model id, or null when nothing matches. */
export function modelKeyOf(modelId) {
  return MODEL_KEYS.find((key) => MODELS[key].model === modelId) ?? null;
}

// ---------------------------------------------------------------------------
// Policy — the table §35 asked for, in one object
// ---------------------------------------------------------------------------

export const ROUTING_STAGES = Object.freeze({
  PLANNING: 'planning',
  REVIEW: 'review',
  IMPLEMENTATION: 'implementation',
  CORRECTION: 'correction',
  /** One Work Unit inside an implementation or correction round. */
  WORK_UNIT: 'work_unit',
  /** Closure documentation: bookkeeping over a decision already taken. */
  CLOSURE: 'closure',
});

export const ROUTING_CONFIG = Object.freeze({
  tech_lead: Object.freeze({
    /**
     * Planning and review both run on the standard model, whatever the risk
     * classification says. `specialist` is NOT a tier the router can select:
     * it is the target of an authorized escalation, and of a manual override.
     *
     * It used to be the `deep` tier, chosen whenever the classifier scored
     * HIGH or above. Measured over Goals 009-013, that fired on every single
     * planning and review call — planning scored exactly 5 every time (3 for
     * roadmap prose, +2 for `round > 1`, which is always true here) and review
     * scored 14-20, because the file signals are uncapped and this repository's
     * paths match the security regex on every diff. A tier that never refuses
     * is not a classification, it is a default with extra steps.
     *
     * The quota limit then ran the experiment by accident: capacity fallbacks
     * put round-1 review on Opus for Goals 009, 010 and 013, which found 7, 6
     * and 5 blockers and closed in two rounds each, while the two goals the
     * specialist reviewed end to end (011, 012) found 4 and 3 and needed a
     * third round, both because round 1 had not demanded the proof it asked
     * for. Opus also inspected more (49/37/60 turns against 40/22) at roughly
     * a sixth of the cost.
     */
    planning: Object.freeze({
      standard: Object.freeze({ model: 'opus', effort: 'high' }),
      specialist: Object.freeze({ model: 'fable', effort: 'high' }),
    }),
    review: Object.freeze({
      standard: Object.freeze({ model: 'opus', effort: 'high' }),
      specialist: Object.freeze({ model: 'fable', effort: 'high' }),
    }),
    /**
     * Closure documentation: recording what a Goal already ACCEPTED changed.
     * Never risk-classified — there is no diff being judged, so there is
     * nothing for a HIGH/CRITICAL score to promote it to. One tier, not two.
     *
     * The specialist stays reachable, but never as this stage's own default:
     * only an explicit routing on the job (a human override, or a future
     * escalation policy) puts a closure job on Fable. Absence of a routing
     * field is not evidence the job predates adaptive routing — a closure job
     * never carries one, by construction — so it must not fall into the
     * "legacy unrouted job" compatibility path built for actual reviews.
     */
    closure: Object.freeze({
      standard: Object.freeze({ model: 'opus', effort: 'high' }),
    }),
  }),
  developer: Object.freeze({
    default: Object.freeze({ model: 'sonnet', effort: 'high' }),
    escalation: Object.freeze({ model: 'opus', effort: 'high' }),
    // Reserved for an Opus attempt that itself ran into something exceptional.
    // Never the answer to a first difficulty, and `max` is not in the table at
    // all: it is available to a human, not to the router.
    deepEscalation: Object.freeze({ model: 'opus', effort: 'xhigh' }),
  }),
});

/**
 * The Work Unit table.
 *
 * The whole point of decomposing a Goal is that the four kinds of work in it
 * cost four different things to get right, so they should not cost the same
 * thing to run. `executor: 'native'` is not a cheap model — it is NO model:
 * the orchestrator runs the command itself.
 *
 * Kept next to the role tables above rather than in a router of its own,
 * because the property that matters is that there is exactly ONE file that can
 * name a model, and adding a second table somewhere else would end that.
 */
export const WORK_UNIT_EXECUTORS = Object.freeze({ NATIVE: 'native', MODEL: 'model' });

export const WORK_UNIT_ROUTING = Object.freeze({
  DETERMINISTIC: Object.freeze({ executor: WORK_UNIT_EXECUTORS.NATIVE }),
  MECHANICAL: Object.freeze({ executor: WORK_UNIT_EXECUTORS.MODEL, model: 'haiku', effort: 'high' }),
  STANDARD: Object.freeze({ executor: WORK_UNIT_EXECUTORS.MODEL, model: 'sonnet', effort: 'high' }),
  COMPLEX: Object.freeze({ executor: WORK_UNIT_EXECUTORS.MODEL, model: 'opus', effort: 'high' }),
});

/**
 * Where a unit type escalates to. One step at a time, never two.
 *
 * COMPLEX has nowhere to go: an Opus unit that cannot finish is a human's
 * problem, not a routing problem, and inventing a fifth tier to send it to
 * would be pretending otherwise.
 */
export const WORK_UNIT_ESCALATION = Object.freeze({
  DETERMINISTIC: null,
  MECHANICAL: 'STANDARD',
  STANDARD: 'COMPLEX',
  COMPLEX: null,
});

/**
 * The risk floor.
 *
 * A unit the planner called MECHANICAL but marked HIGH risk (or HIGH
 * complexity) is not mechanical, whatever the label says: "Haiku deciding
 * architecture" is explicitly not a thing this may produce. The floor promotes
 * it to STANDARD and says so in the reason, so the promotion is visible rather
 * than being a silent disagreement with the plan.
 *
 * There is deliberately no symmetric rule promoting STANDARD to COMPLEX on
 * risk: Opus is not the answer to "this looks scary", it is the answer to
 * evidence, which arrives through escalation.
 */
const MECHANICAL_FLOOR_TRIGGERS = Object.freeze({ risk: ['HIGH'], complexity: ['HIGH'] });

export const COMPLEXITY = Object.freeze({
  LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', CRITICAL: 'CRITICAL',
});

/**
 * Score boundaries, centralised so no caller repeats a number.
 * 0–1 LOW · 2–3 MEDIUM · 4–6 HIGH · 7+ CRITICAL
 */
export const RISK_THRESHOLDS = Object.freeze({ MEDIUM: 2, HIGH: 4, CRITICAL: 7 });


export function classificationForScore(riskScore) {
  const score = Number.isFinite(riskScore) ? riskScore : 0;
  if (score >= RISK_THRESHOLDS.CRITICAL) return COMPLEXITY.CRITICAL;
  if (score >= RISK_THRESHOLDS.HIGH) return COMPLEXITY.HIGH;
  if (score >= RISK_THRESHOLDS.MEDIUM) return COMPLEXITY.MEDIUM;
  return COMPLEXITY.LOW;
}

// ---------------------------------------------------------------------------
// Manual override — one switch, read in one place
// ---------------------------------------------------------------------------

export const ROUTING_MODES = Object.freeze({
  AUTO: 'AUTO',
  FORCE_SONNET: 'FORCE_SONNET',
  FORCE_OPUS: 'FORCE_OPUS',
  FORCE_FABLE: 'FORCE_FABLE',
});

const FORCED_MODEL = Object.freeze({
  [ROUTING_MODES.FORCE_SONNET]: 'sonnet',
  [ROUTING_MODES.FORCE_OPUS]: 'opus',
  [ROUTING_MODES.FORCE_FABLE]: 'fable',
});

/**
 * The routing mode in force. AUTO unless a human said otherwise.
 *
 * An unknown value is refused rather than silently treated as AUTO: a typo in
 * an override must not look like the default.
 */
export function resolveRoutingMode(env = process.env) {
  const raw = (env.IA_LOOP_ROUTING_MODE ?? '').trim();
  if (raw === '') return ROUTING_MODES.AUTO;
  const mode = raw.toUpperCase();
  if (!Object.hasOwn(ROUTING_MODES, mode)) {
    throw new SpikeError(
      'INVALID_ROUTING_MODE',
      `Unknown routing mode ${JSON.stringify(raw)} (known: ${Object.keys(ROUTING_MODES).join(', ')})`,
    );
  }
  return ROUTING_MODES[mode];
}

// ---------------------------------------------------------------------------
// Complexity signals — deterministic, zero-token
// ---------------------------------------------------------------------------

/**
 * Weighted signals. Portuguese and English both appear because the Goal
 * documents are written in Portuguese while the code and the contracts are in
 * English; a classifier that only read one of them would score every Goal low.
 *
 * Keyword matching is the FALLBACK, not the mechanism: structured evidence
 * (migrations on disk, files changed, a recorded escalation, a rejected round)
 * is scored first and weighs more, precisely because it cannot be phrased away.
 */
export const SIGNAL_WEIGHTS = Object.freeze({ HIGH: 3, MEDIUM: 2, HISTORY: 2, SCOPE: 1 });

/**
 * The most that PROSE alone may contribute to a score.
 *
 * Measured, not assumed: run against this repository's real documents, an
 * uncapped keyword score put the roadmap at 30 and every single Goal at
 * CRITICAL — a long document about a migration project mentions architecture,
 * security, concurrency and migrations because it is a long document, not
 * because the next change is dangerous. Routing every Goal to the specialist
 * is exactly what this feature exists to stop.
 *
 * So text can carry a Goal to MEDIUM and no further. HIGH and CRITICAL need
 * evidence that cannot be phrased away: migrations in the diff, security
 * surface in the paths, a rejected round, an escalation that actually happened.
 */
export const TEXT_SIGNAL_CAP = RISK_THRESHOLDS.HIGH - 1;

const TEXT_SIGNALS = Object.freeze([
  // --- Highest weight: the properties that are expensive to get wrong -------
  ['ARCHITECTURE', SIGNAL_WEIGHTS.HIGH, /\barquitetur\w*|\barchitectur\w*|redesenho|redesign/i],
  ['STATE_MACHINE', SIGNAL_WEIGHTS.HIGH, /m[áa]quina de estados?|state machine|transi[çc][ãa]o de estado|state transition/i],
  ['CONCURRENCY', SIGNAL_WEIGHTS.HIGH, /concorr[êe]nc\w*|concurren\w*|race condition|corrida|lock\b|mutex|dead ?lock/i],
  ['DISTRIBUTED_STATE', SIGNAL_WEIGHTS.HIGH, /lease[s]?\b|fila[s]? de|\bqueue[s]?\b|worker[s]?\b|estado distribu[íi]do|distributed state|idempot[êe]nc\w*/i],
  ['SECURITY', SIGNAL_WEIGHTS.HIGH, /seguran[çc]a|security|autentica[çc][ãa]o|authenticat\w*|autoriza[çc][ãa]o|authoriz\w*|isolamento de tenant|tenant isolation|credencia\w*|secret[s]?\b/i],
  // Deliberately NOT a bare "migração": this whole repository documents "a
  // migração do Atendly", so the plain word fires on every Goal and would
  // score them all HIGH. What matters here is a DATABASE migration.
  ['MIGRATION', SIGNAL_WEIGHTS.HIGH, /\bmigrations?\b|migra[çc][ãa]o de (?:dados|schema|banco)|schema migration|altera[çc][ãa]o de schema|prisma\/migrations|backfill|expand\/contract|expand e corte/i],
  ['BREAKING_CHANGE', SIGNAL_WEIGHTS.HIGH, /breaking change|quebra de compatibilidade|incompat[íi]vel|remo[çc][ãa]o de campo|drop column|drop constraint/i],
  ['DATA_CONSISTENCY', SIGNAL_WEIGHTS.HIGH, /consist[êe]ncia|consistency|transa[çc][ãa]o|transaction|atomic\w*|perda de dado|data loss/i],
  ['RECOVERY', SIGNAL_WEIGHTS.HIGH, /recovery|recupera[çc][ãa]o|rollback|failover|reconcilia[çc][ãa]o|reconciliation/i],

  // --- Medium weight: broad blast radius, not necessarily deep risk --------
  ['INFRA', SIGNAL_WEIGHTS.MEDIUM, /\binfra\w*|\bci\/cd\b|\bci\b|pipeline de deploy|deploy\w*|docker|render\.yaml/i],
  ['API_CONTRACT', SIGNAL_WEIGHTS.MEDIUM, /contrato[s]? (?:p[úu]blico|de api)|api contract|public_api|endpoint[s]?\b|openapi/i],
  ['CROSS_CUTTING', SIGNAL_WEIGHTS.MEDIUM, /cross-?cutting|transversal|v[áa]rios m[óo]dulos|multiple modules|todos os apps|shared librar\w*|pacote compartilhado/i],
  ['LARGE_REFACTOR', SIGNAL_WEIGHTS.MEDIUM, /refactor\w*|refatora[çc][ãa]o|reescrit\w*|rewrite/i],
  ['RUNTIME_CONFIG', SIGNAL_WEIGHTS.MEDIUM, /runtime config\w*|configura[çc][ãa]o de runtime|feature flag|vari[áa]ve\w+ de ambiente|environment variable/i],
  ['BACKWARD_COMPAT', SIGNAL_WEIGHTS.MEDIUM, /backward compat\w*|retrocompat\w*|compatibilidade com|expand\/contract|expand e corte/i],
]);

/** Structured evidence beats prose, so a path that IS a migration scores as one. */
const MIGRATION_PATH = /(^|\/)(prisma\/migrations|migrations)\//i;
const SECURITY_PATH = /(auth|session|tenant|security|permission|credential)/i;
const INFRA_PATH = /(^|\/)(\.github\/|render\.yaml|dockerfile|docker-compose|\.ci\/)/i;
const WORKER_PATH = /(worker|queue|lease|scheduler|cron|consumer|producer)/i;

function matchTextSignals(text) {
  const haystack = typeof text === 'string' ? text : '';
  if (haystack.trim() === '') return [];
  const found = [];
  for (const [id, weight, pattern] of TEXT_SIGNALS) {
    if (pattern.test(haystack)) found.push({ id, weight, source: 'TEXT' });
  }
  return found;
}

/** History raises risk regardless of what any document says about itself. */
function historySignals({
  previousRoundRejected = false,
  previousDeveloperEscalation = false,
  previousHarnessRecovery = false,
  recurrentRegressions = false,
} = {}) {
  const found = [];
  if (previousRoundRejected) found.push({ id: 'PREVIOUS_ROUND_REJECTED', weight: SIGNAL_WEIGHTS.HISTORY, source: 'HISTORY' });
  if (previousDeveloperEscalation) found.push({ id: 'PREVIOUS_DEVELOPER_ESCALATION', weight: SIGNAL_WEIGHTS.HISTORY, source: 'HISTORY' });
  if (previousHarnessRecovery) found.push({ id: 'PREVIOUS_HARNESS_RECOVERY', weight: SIGNAL_WEIGHTS.HISTORY, source: 'HISTORY' });
  if (recurrentRegressions) found.push({ id: 'RECURRENT_REGRESSIONS', weight: SIGNAL_WEIGHTS.HISTORY, source: 'HISTORY' });
  return found;
}

function dedupe(signals) {
  const byId = new Map();
  for (const signal of signals) {
    // The heaviest reading of a signal wins; the same signal never scores
    // twice. A structured reading outranks a textual one for the same id, so
    // "the diff contains a migration" is what scores, not "the document says
    // migration" — and mentioning it twice adds nothing either way.
    const existing = byId.get(signal.id);
    const better = !existing
      || signal.weight > existing.weight
      || (signal.weight === existing.weight && existing.source === 'TEXT' && signal.source !== 'TEXT');
    if (better) byId.set(signal.id, signal);
  }
  return [...byId.values()];
}

function assess(signals) {
  const unique = dedupe(signals);

  // Prose is capped; evidence is not. See TEXT_SIGNAL_CAP.
  const textScore = unique
    .filter((s) => s.source === 'TEXT')
    .reduce((total, signal) => total + signal.weight, 0);
  const evidenceScore = unique
    .filter((s) => s.source !== 'TEXT')
    .reduce((total, signal) => total + signal.weight, 0);
  const riskScore = Math.min(textScore, TEXT_SIGNAL_CAP) + evidenceScore;

  return {
    classification: classificationForScore(riskScore),
    riskScore,
    textScore,
    evidenceScore,
    signals: unique.map((s) => s.id),
    signalDetail: unique,
  };
}

/**
 * Signals read from the change surface itself.
 *
 * Shared by both classifiers on purpose: a migration is a migration whether it
 * is being planned next to one or reviewed inside one.
 */
function fileSignals(changedFiles) {
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  const signals = [];
  if (files.length === 0) return signals;

  if (files.some((file) => MIGRATION_PATH.test(file))) {
    signals.push({ id: 'MIGRATION', weight: SIGNAL_WEIGHTS.HIGH, source: 'FILES' });
  }
  if (files.some((file) => SECURITY_PATH.test(file))) {
    signals.push({ id: 'SECURITY', weight: SIGNAL_WEIGHTS.HIGH, source: 'FILES' });
  }
  if (files.some((file) => WORKER_PATH.test(file))) {
    signals.push({ id: 'DISTRIBUTED_STATE', weight: SIGNAL_WEIGHTS.HIGH, source: 'FILES' });
  }
  if (files.some((file) => INFRA_PATH.test(file))) {
    signals.push({ id: 'INFRA', weight: SIGNAL_WEIGHTS.MEDIUM, source: 'FILES' });
  }

  // A diff spread over many apps is cross-cutting whatever any report says.
  const appsTouched = new Set(files.map((file) => /^apps\/([^/]+)\//.exec(file)?.[1]).filter(Boolean));
  if (appsTouched.size >= 3) {
    signals.push({ id: 'CROSS_CUTTING', weight: SIGNAL_WEIGHTS.MEDIUM, source: 'FILES' });
  }

  if (files.length >= 40) {
    signals.push({ id: 'LARGE_SCOPE', weight: SIGNAL_WEIGHTS.SCOPE * 2, source: 'FILES' });
  } else if (files.length >= 15) {
    signals.push({ id: 'LARGE_SCOPE', weight: SIGNAL_WEIGHTS.SCOPE, source: 'FILES' });
  }

  return signals;
}

/**
 * Risk of the work a planning call is about to scope.
 *
 * At planning time the evidence is the roadmap and the history — there is no
 * diff yet — so the text of the Goal being closed and of the migration status
 * is what there is to read, plus what already went wrong.
 */
export function classifyPlanningComplexity({ text = '', history = {} } = {}) {
  // Deliberately NOT scored on the closed Goal's diff. That diff is evidence
  // about the work just FINISHED, not about the one being scoped next, and in
  // this repository every Goal touches a migration — using it would send every
  // planning call to the specialist, which is the opposite of the point.
  //
  // What is left is honest: a bounded reading of the roadmap (capped, because
  // prose about a migration project always mentions migrations) and the things
  // that actually went wrong — a round that was rejected, an execution that
  // had to be escalated, a harness recovery. Those are what make the NEXT
  // decision hard.
  const signals = [
    ...matchTextSignals(text),
    ...historySignals(history),
  ];
  return { stage: ROUTING_STAGES.PLANNING, ...assess(signals) };
}

/**
 * Risk of reviewing a diff that now exists.
 *
 * Deliberately richer than planning: by review time the change surface is real,
 * so files, migrations and the Developer's own escalation are scored as facts
 * rather than inferred from prose.
 */
export function classifyReviewComplexity({
  changedFiles = [],
  diffStat = null,
  text = '',
  developerEscalated = false,
  previousBlockers = [],
  history = {},
} = {}) {
  const signals = [
    ...matchTextSignals(text),
    ...fileSignals(changedFiles),
    ...historySignals(history),
  ];

  const insertions = Number(/(\d+) insertions?/.exec(diffStat ?? '')?.[1] ?? 0);
  if (insertions >= 1500) {
    signals.push({ id: 'LARGE_DIFF', weight: SIGNAL_WEIGHTS.SCOPE * 2, source: 'DIFF' });
  } else if (insertions >= 500) {
    signals.push({ id: 'LARGE_DIFF', weight: SIGNAL_WEIGHTS.SCOPE, source: 'DIFF' });
  }

  // The execution was harder than the plan expected. That is evidence about
  // the change, not about the Developer, and it is exactly when a reviewer
  // benefits from being the stronger model.
  if (developerEscalated) {
    signals.push({ id: 'DEVELOPER_ESCALATED', weight: SIGNAL_WEIGHTS.HIGH, source: 'HISTORY' });
  }
  if (Array.isArray(previousBlockers) && previousBlockers.length > 0) {
    signals.push({ id: 'PREVIOUS_ROUND_REJECTED', weight: SIGNAL_WEIGHTS.HISTORY, source: 'HISTORY' });
  }

  return { stage: ROUTING_STAGES.REVIEW, ...assess(signals) };
}

// ---------------------------------------------------------------------------
// Routing decisions
// ---------------------------------------------------------------------------

/** Builds the structured decision every caller persists and every event carries. */
function decision({ role, stage, complexity, riskScore, signals, modelKey, effort, reason, fallbackAllowed, mode }) {
  const model = resolveModel(modelKey);
  return Object.freeze({
    role,
    stage,
    complexity: complexity ?? null,
    riskScore: Number.isFinite(riskScore) ? riskScore : null,
    signals: Object.freeze([...(signals ?? [])]),
    modelKey: model.key,
    model: model.model,
    family: model.family,
    label: model.label,
    effort,
    reason,
    fallbackAllowed: Boolean(fallbackAllowed),
    mode: mode ?? ROUTING_MODES.AUTO,
  });
}

/**
 * The model a Tech Lead stage runs on.
 *
 * `assessment` is what the classifier returned. An override replaces the model
 * but keeps the assessment, so the audit still shows what the router thought.
 */
export function routeTechLead({
  stage,
  assessment,
  mode = ROUTING_MODES.AUTO,
  config = ROUTING_CONFIG,
} = {}) {
  if (stage !== ROUTING_STAGES.PLANNING && stage !== ROUTING_STAGES.REVIEW) {
    throw new SpikeError('INVALID_ARGS', `Unknown Tech Lead stage ${JSON.stringify(stage)}`);
  }
  // The classification is recorded, never used to pick the model: the
  // specialist is reachable only through an authorized escalation or a manual
  // override. See the comment on ROUTING_CONFIG.tech_lead for the evidence.
  const chosen = config.tech_lead[stage].standard;
  const forced = FORCED_MODEL[mode] ?? null;

  return decision({
    role: 'tech_lead',
    stage,
    complexity: assessment?.classification ?? COMPLEXITY.LOW,
    riskScore: assessment?.riskScore ?? 0,
    signals: assessment?.signals ?? [],
    modelKey: forced ?? chosen.model,
    effort: chosen.effort,
    reason: forced ? `MANUAL_OVERRIDE_${mode}` : 'TECH_LEAD_STANDARD_MODEL',
    // Fable is the only model with a weekly quota tight enough to strand the
    // pipeline, so only a Fable selection carries a fallback.
    fallbackAllowed: (forced ?? chosen.model) === 'fable',
    mode,
  });
}

/**
 * The model closure documentation runs on.
 *
 * Not `routeTechLead`: that function's whole shape is "classify risk, then
 * pick standard or deep from it", and closure documentation has no risk to
 * classify — it is bookkeeping over a decision the review already made. This
 * always resolves to the standard Tech Lead tier, unless routing is pinned by
 * a manual override. It never returns Fable as a DEFAULT: the specialist is
 * reachable only through an explicit routing already sitting on the job,
 * which this function is not given and does not need to be — a caller that
 * has one uses it directly instead of calling this at all.
 */
export function routeClosureDocumentation({
  mode = ROUTING_MODES.AUTO,
  config = ROUTING_CONFIG,
} = {}) {
  const table = config.tech_lead.closure.standard;
  const forced = FORCED_MODEL[mode] ?? null;

  return decision({
    role: 'tech_lead',
    stage: ROUTING_STAGES.CLOSURE,
    complexity: null,
    riskScore: null,
    signals: [],
    modelKey: forced ?? table.model,
    effort: table.effort,
    reason: forced ? `MANUAL_OVERRIDE_${mode}` : 'CLOSURE_DOCUMENTATION_STANDARD',
    fallbackAllowed: (forced ?? table.model) === 'fable',
    mode,
  });
}

/**
 * The model a Developer stage runs on.
 *
 * `level` is 'default' | 'escalation' | 'deepEscalation'; the caller derives it
 * from the attempt history rather than from a feeling.
 */
export function routeDeveloper({
  stage = ROUTING_STAGES.IMPLEMENTATION,
  level = 'default',
  assessment = null,
  reason = null,
  mode = ROUTING_MODES.AUTO,
  config = ROUTING_CONFIG,
} = {}) {
  const chosen = config.developer[level];
  if (!chosen) throw new SpikeError('INVALID_ARGS', `Unknown Developer routing level ${JSON.stringify(level)}`);
  const forced = FORCED_MODEL[mode] ?? null;

  return decision({
    role: 'developer',
    stage,
    complexity: assessment?.classification ?? null,
    riskScore: assessment?.riskScore ?? null,
    signals: assessment?.signals ?? [],
    modelKey: forced ?? chosen.model,
    effort: chosen.effort,
    reason: forced ? `MANUAL_OVERRIDE_${mode}` : (reason ?? (level === 'default' ? 'STANDARD_EXECUTION' : level.toUpperCase())),
    // Sonnet may fall back to Opus when it is the quota that stops it.
    fallbackAllowed: (forced ?? chosen.model) === 'sonnet',
    mode,
  });
}

// ---------------------------------------------------------------------------
// Work Unit routing
// ---------------------------------------------------------------------------

/**
 * The executor for one Work Unit.
 *
 * Input is what the PLAN declared plus what already HAPPENED to this unit —
 * never a model call, never a feeling. Output says either "no model at all" or
 * exactly which model at which effort, with the reason that produced it.
 *
 * `tier` is the effective type after the risk floor and after any authorised
 * escalations already recorded for this unit; it is what the next escalation
 * step is measured from, so replaying the history gives the same answer twice.
 */
export function routeWorkUnit({
  unit,
  escalations = 0,
  mode = ROUTING_MODES.AUTO,
  config = WORK_UNIT_ROUTING,
} = {}) {
  if (!unit?.type || !Object.hasOwn(config, unit.type)) {
    throw new SpikeError('INVALID_ARGS', `Unknown Work Unit type ${JSON.stringify(unit?.type)}`);
  }

  let tier = unit.type;
  let reason = `${tier}_WORK_UNIT`;

  if (tier === 'MECHANICAL'
    && (MECHANICAL_FLOOR_TRIGGERS.risk.includes(unit.risk)
      || MECHANICAL_FLOOR_TRIGGERS.complexity.includes(unit.complexity))) {
    tier = 'STANDARD';
    reason = 'MECHANICAL_RISK_FLOOR';
  }

  // Escalations already granted for this unit are part of its identity, so a
  // restart re-derives the same tier instead of starting again from the plan.
  for (let step = 0; step < escalations; step += 1) {
    const next = WORK_UNIT_ESCALATION[tier];
    if (!next) break;
    tier = next;
    reason = `ESCALATED_TO_${tier}`;
  }

  const chosen = config[tier];

  if (chosen.executor === WORK_UNIT_EXECUTORS.NATIVE) {
    return Object.freeze({
      executor: WORK_UNIT_EXECUTORS.NATIVE,
      unitId: unit.id,
      unitType: unit.type,
      tier,
      action: unit.action ?? null,
      reason: 'DETERMINISTIC_WORK_UNIT',
      mode,
      // A deterministic unit has no routing decision to persist: there is no
      // model, so there is nothing a fallback or an escalation could move.
      routing: null,
    });
  }

  const forced = FORCED_MODEL[mode] ?? null;
  const routed = decision({
    role: 'developer',
    stage: ROUTING_STAGES.WORK_UNIT,
    complexity: unit.complexity ?? null,
    riskScore: null,
    signals: [unit.type, `RISK_${unit.risk ?? 'LOW'}`],
    modelKey: forced ?? chosen.model,
    effort: chosen.effort,
    reason: forced ? `MANUAL_OVERRIDE_${mode}` : reason,
    // Haiku and Sonnet both have somewhere to go when a quota — not a bug —
    // stops them. Opus is the top of this table and has nothing below it that
    // would be an improvement.
    fallbackAllowed: (forced ?? chosen.model) !== 'opus',
    mode,
  });

  return Object.freeze({
    executor: WORK_UNIT_EXECUTORS.MODEL,
    unitId: unit.id,
    unitType: unit.type,
    tier,
    action: null,
    reason: routed.reason,
    mode,
    routing: routed,
  });
}

// ---------------------------------------------------------------------------
// Capacity fallback — availability only, never a way to hide a bug
// ---------------------------------------------------------------------------

/**
 * Failure reasons a fallback may answer.
 *
 * Availability, and nothing else. A harness bug, a bad argv, an auth problem or
 * an unexplained fatal keeps the existing policy: those are fixed, not routed
 * around, and quietly moving them onto another model would hide the defect
 * while still paying for it.
 */
export const FALLBACK_REASONS = Object.freeze([
  CAPACITY_REASONS.USAGE_LIMIT,
  CAPACITY_REASONS.RATE_LIMIT,
  CAPACITY_REASONS.MODEL_UNAVAILABLE,
]);

/** Where a model falls back to when capacity — not correctness — stops it. */
const FALLBACK_TARGET = Object.freeze({
  fable: Object.freeze({ model: 'opus', effort: 'high' }),
  sonnet: Object.freeze({ model: 'opus', effort: 'high' }),
  // One step up, like every other fallback here: a Haiku unit blocked by a
  // quota is ordinary work that still needs doing, and the standard executor
  // is the cheapest thing that can do it. Sending it to Opus would answer an
  // availability problem with the most expensive model in the table.
  haiku: Object.freeze({ model: 'sonnet', effort: 'high' }),
});

export function isFallbackReason(reason) {
  return FALLBACK_REASONS.includes(reason);
}

/**
 * The fallback for a failed attempt, or null when there is none.
 *
 * Returns null — never a guess — when the failure is not an availability
 * problem, when the model has no fallback target, or when the fallback has
 * already been used for this job (a second fallback would be a third model,
 * which no policy here authorises).
 */
export function planCapacityFallback({
  current,
  reason,
  alreadyFellBack = false,
  mode = ROUTING_MODES.AUTO,
} = {}) {
  if (!current?.fallbackAllowed) return null;
  if (!isFallbackReason(reason)) return null;
  if (alreadyFellBack) return null;
  // A human pinning a model means it, including when the quota bites.
  if (mode !== ROUTING_MODES.AUTO) return null;

  const target = FALLBACK_TARGET[current.modelKey];
  if (!target) return null;

  return decision({
    role: current.role,
    stage: current.stage,
    complexity: current.complexity,
    riskScore: current.riskScore,
    signals: current.signals,
    modelKey: target.model,
    effort: target.effort,
    reason: `CAPACITY_FALLBACK_${reason}`,
    fallbackAllowed: false,
    mode,
  });
}

// ---------------------------------------------------------------------------
// Escalation — capability, not availability
// ---------------------------------------------------------------------------

export const ESCALATION_REASONS = Object.freeze({
  REPEATED_EXECUTION_FAILURE: 'REPEATED_EXECUTION_FAILURE',
  PLAN_MISMATCH: 'PLAN_MISMATCH',
  ARCHITECTURAL_DECISION_REQUIRED: 'ARCHITECTURAL_DECISION_REQUIRED',
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',
  REVIEW_INCONCLUSIVE: 'REVIEW_INCONCLUSIVE',
  ARCHITECTURAL_RISK_DISCOVERED: 'ARCHITECTURAL_RISK_DISCOVERED',
  SECURITY_RISK_DISCOVERED: 'SECURITY_RISK_DISCOVERED',
});

/** Escalation requests a Developer may make, and what each one demands as proof. */
const DEVELOPER_ESCALATION_REASONS = Object.freeze([
  ESCALATION_REASONS.REPEATED_EXECUTION_FAILURE,
  ESCALATION_REASONS.PLAN_MISMATCH,
  ESCALATION_REASONS.ARCHITECTURAL_DECISION_REQUIRED,
  ESCALATION_REASONS.LOW_CONFIDENCE,
]);

const REVIEW_ESCALATION_REASONS = Object.freeze([
  ESCALATION_REASONS.REVIEW_INCONCLUSIVE,
  ESCALATION_REASONS.ARCHITECTURAL_RISK_DISCOVERED,
  ESCALATION_REASONS.SECURITY_RISK_DISCOVERED,
]);

/** Minimum evidence entries an escalation request must carry to be believed. */
export const MIN_ESCALATION_EVIDENCE = 1;

export const ESCALATION_VERDICTS = Object.freeze({
  AUTHORIZED: 'AUTHORIZED',
  REFUSED: 'REFUSED',
  ALREADY_ESCALATED: 'ALREADY_ESCALATED',
});

/**
 * Decides whether a Developer's request for a stronger model is legitimate.
 *
 * The worker may ASK; only this decides. Asking is not evidence, and a request
 * with no evidence is refused precisely so "run me on the expensive model" can
 * never become the cheap way out of a hard afternoon.
 */
export function authorizeDeveloperEscalation({
  request,
  current,
  alreadyEscalated = false,
  mode = ROUTING_MODES.AUTO,
} = {}) {
  if (alreadyEscalated) {
    return { verdict: ESCALATION_VERDICTS.ALREADY_ESCALATED, decision: null, reason: 'A successor attempt already exists for this escalation.' };
  }
  if (mode !== ROUTING_MODES.AUTO) {
    return { verdict: ESCALATION_VERDICTS.REFUSED, decision: null, reason: `Routing is pinned by ${mode}; escalation is a human's call while it is.` };
  }
  if (!request || typeof request !== 'object') {
    return { verdict: ESCALATION_VERDICTS.REFUSED, decision: null, reason: 'No escalation request was made.' };
  }
  if (!DEVELOPER_ESCALATION_REASONS.includes(request.reason)) {
    return {
      verdict: ESCALATION_VERDICTS.REFUSED,
      decision: null,
      reason: `Escalation reason ${JSON.stringify(request.reason)} is not one the router recognises.`,
    };
  }

  const evidence = Array.isArray(request.evidence) ? request.evidence.filter((e) => typeof e === 'string' && e.trim() !== '') : [];
  if (evidence.length < MIN_ESCALATION_EVIDENCE) {
    return {
      verdict: ESCALATION_VERDICTS.REFUSED,
      decision: null,
      reason: 'An escalation must carry evidence; a stated confidence alone is not one.',
    };
  }

  // Sonnet escalates to Opus high. An Opus attempt that asks again gets xhigh
  // once, and never max: that stays a human decision.
  const level = current?.modelKey === 'opus' ? 'deepEscalation' : 'escalation';
  if (level === 'deepEscalation' && current?.effort === 'xhigh') {
    return {
      verdict: ESCALATION_VERDICTS.REFUSED,
      decision: null,
      reason: 'Already at the deepest routed effort; anything beyond this is a human decision.',
    };
  }

  return {
    verdict: ESCALATION_VERDICTS.AUTHORIZED,
    reason: request.reason,
    evidence,
    decision: routeDeveloper({
      stage: current?.stage ?? ROUTING_STAGES.IMPLEMENTATION,
      level,
      reason: request.reason,
      mode,
    }),
  };
}

/**
 * Reasons a Work Unit may give for asking to be moved up a tier.
 *
 * Closed, and SPLIT BY TIER on purpose. The two escalations are not the same
 * question:
 *
 *   MECHANICAL -> STANDARD  "this was not as mechanical as the plan thought".
 *                           Cheap to be wrong about, so a low-confidence
 *                           reading of the work is admissible evidence.
 *   STANDARD  -> COMPLEX    "this needs the strongest executor". Expensive, so
 *                           the admissible reasons are the ones that describe a
 *                           PROPERTY OF THE PROBLEM — concurrency, state,
 *                           architecture, a plan that does not fit the code —
 *                           and not a feeling about it. A lint failure, a
 *                           typecheck failure or one red test is a thing to
 *                           fix, not a reason to buy a bigger model.
 */
export const WORK_UNIT_ESCALATION_REASONS = Object.freeze({
  MECHANICAL: Object.freeze([
    'NOT_AS_MECHANICAL_AS_CLASSIFIED',
    'PATTERN_INSUFFICIENT',
    'BEHAVIOUR_DECISION_REQUIRED',
    'CROSS_MODULE_IMPACT_DISCOVERED',
    'REPEATED_EXECUTION_FAILURE',
    'LOW_CONFIDENCE',
    // Not requested by the model — synthesised by the harness itself (see
    // createWorkUnitAttemptRouter.escalationFor) from the CLI's own
    // permission_denials record on a BLOCKED attempt. A generic BLOCKED with
    // no such evidence never reaches this reason at all; see model-routing's
    // tests for the Goal010/Goal011 incidents this closes.
    'TOOLING_PERMISSION_DENIED',
  ]),
  STANDARD: Object.freeze([
    'REPEATED_EXECUTION_FAILURE',
    'UNEXPECTED_ARCHITECTURE',
    'DEEP_DEBUGGING_REQUIRED',
    'CONCURRENCY_ISSUE',
    'STATE_INCONSISTENCY',
    'PLAN_INCOMPATIBILITY',
    'COMPLEXITY_DISCOVERED',
  ]),
});

/** Every reason any tier may name, for the contract's enum. */
export const ALL_WORK_UNIT_ESCALATION_REASONS = Object.freeze([
  ...new Set([...WORK_UNIT_ESCALATION_REASONS.MECHANICAL, ...WORK_UNIT_ESCALATION_REASONS.STANDARD]),
]);

/**
 * Failed attempts a REPEATED_EXECUTION_FAILURE must actually be able to point
 * at. One failure is not a repetition, and calling it one is how a single red
 * test becomes an Opus call.
 */
export const MIN_ATTEMPTS_FOR_REPEATED_FAILURE = 2;

/**
 * Decides whether a Work Unit's request for a stronger tier is legitimate.
 *
 * The unit may ASK; only this decides. Every refusal is returned with its
 * reason so the caller can record it: "the unit asked and the router said no"
 * is exactly the kind of thing that must not be invisible afterwards.
 */
export function authorizeWorkUnitEscalation({
  request,
  currentTier,
  escalations = 0,
  failedAttempts = 0,
  mode = ROUTING_MODES.AUTO,
} = {}) {
  const nextTier = WORK_UNIT_ESCALATION[currentTier] ?? null;
  if (!nextTier) {
    return {
      verdict: ESCALATION_VERDICTS.REFUSED,
      decision: null,
      reason: `A ${currentTier} Work Unit is already at the top of the table; anything beyond it is a human decision.`,
      // Flagged, not just phrased, because this refusal is the only one that
      // says nothing against the unit: every other one means it asked badly —
      // no evidence, an inadmissible reason, a claim about the past that does
      // not check out — while this one means the TABLE ran out. A caller that
      // wants to treat the two differently should not have to match on prose.
      atTopOfTable: true,
    };
  }
  if (mode !== ROUTING_MODES.AUTO) {
    return {
      verdict: ESCALATION_VERDICTS.REFUSED,
      decision: null,
      reason: `Routing is pinned by ${mode}; escalation is a human's call while it is.`,
    };
  }
  if (!request || typeof request !== 'object') {
    return { verdict: ESCALATION_VERDICTS.REFUSED, decision: null, reason: 'No escalation request was made.' };
  }

  const admissible = WORK_UNIT_ESCALATION_REASONS[currentTier] ?? [];
  if (!admissible.includes(request.reason)) {
    return {
      verdict: ESCALATION_VERDICTS.REFUSED,
      decision: null,
      reason: `Reason ${JSON.stringify(request.reason)} does not justify moving a ${currentTier} unit to ${nextTier} `
        + `(admissible: ${admissible.join(', ')}).`,
    };
  }

  const evidence = Array.isArray(request.evidence)
    ? request.evidence.filter((item) => typeof item === 'string' && item.trim() !== '')
    : [];
  if (evidence.length < MIN_ESCALATION_EVIDENCE) {
    return {
      verdict: ESCALATION_VERDICTS.REFUSED,
      decision: null,
      reason: 'An escalation must carry evidence; a stated confidence alone is not one.',
    };
  }

  // "It failed repeatedly" has to be checkable against the attempts that
  // actually exist, or it is just a phrase that unlocks a bigger model.
  if (request.reason === 'REPEATED_EXECUTION_FAILURE' && failedAttempts < MIN_ATTEMPTS_FOR_REPEATED_FAILURE) {
    return {
      verdict: ESCALATION_VERDICTS.REFUSED,
      decision: null,
      reason: `REPEATED_EXECUTION_FAILURE needs at least ${MIN_ATTEMPTS_FOR_REPEATED_FAILURE} failed attempts; `
        + `this unit has ${failedAttempts}.`,
    };
  }

  const chosen = WORK_UNIT_ROUTING[nextTier];
  return {
    verdict: ESCALATION_VERDICTS.AUTHORIZED,
    reason: request.reason,
    evidence,
    fromTier: currentTier,
    toTier: nextTier,
    escalations: escalations + 1,
    decision: decision({
      role: 'developer',
      stage: ROUTING_STAGES.WORK_UNIT,
      complexity: null,
      riskScore: null,
      signals: [request.reason],
      modelKey: chosen.model,
      effort: chosen.effort,
      reason: request.reason,
      fallbackAllowed: chosen.model !== 'opus',
      mode,
    }),
  };
}

/**
 * Decides whether a review that reached no confident conclusion may be redone
 * by the specialist.
 *
 * Only ever upward, and only from Opus: a Fable review that is inconclusive has
 * nowhere stronger to go, and saying so is more honest than another attempt.
 */
export function authorizeReviewEscalation({
  request,
  current,
  alreadyEscalated = false,
  mode = ROUTING_MODES.AUTO,
} = {}) {
  if (alreadyEscalated) {
    return { verdict: ESCALATION_VERDICTS.ALREADY_ESCALATED, decision: null, reason: 'A successor review attempt already exists.' };
  }
  if (mode !== ROUTING_MODES.AUTO) {
    return { verdict: ESCALATION_VERDICTS.REFUSED, decision: null, reason: `Routing is pinned by ${mode}.` };
  }
  if (!request || !REVIEW_ESCALATION_REASONS.includes(request.reason)) {
    return { verdict: ESCALATION_VERDICTS.REFUSED, decision: null, reason: 'No recognised review escalation reason.' };
  }
  if (current?.modelKey === 'fable') {
    return { verdict: ESCALATION_VERDICTS.REFUSED, decision: null, reason: 'The specialist already reviewed this; there is nothing to escalate to.' };
  }

  const evidence = Array.isArray(request.evidence) ? request.evidence.filter((e) => typeof e === 'string' && e.trim() !== '') : [];
  if (evidence.length < MIN_ESCALATION_EVIDENCE) {
    return { verdict: ESCALATION_VERDICTS.REFUSED, decision: null, reason: 'A review escalation must carry evidence.' };
  }

  return {
    verdict: ESCALATION_VERDICTS.AUTHORIZED,
    reason: request.reason,
    evidence,
    decision: decision({
      role: 'tech_lead',
      stage: ROUTING_STAGES.REVIEW,
      complexity: COMPLEXITY.HIGH,
      riskScore: current?.riskScore ?? RISK_THRESHOLDS.HIGH,
      signals: [...(current?.signals ?? []), request.reason],
      modelKey: 'fable',
      effort: ROUTING_CONFIG.tech_lead.review.specialist.effort,
      reason: request.reason,
      fallbackAllowed: true,
      mode,
    }),
  };
}

// ---------------------------------------------------------------------------
// Replay — the model an attempt runs on, derived from persisted state
// ---------------------------------------------------------------------------

/** Reasons an attempt ended because the router moved it, recorded in history. */
export const REROUTE_REASONS = Object.freeze({
  MODEL_FALLBACK: 'MODEL_FALLBACK',
  MODEL_ESCALATION: 'MODEL_ESCALATION',
});

/**
 * Rebuilds the routing of the CURRENT attempt from what is on disk.
 *
 * A restart must not re-decide: it must arrive at the same answer the run had
 * already reached. The job carries the base decision; every reroute is recorded
 * in the attempt history with the model it moved to, so replaying the history
 * over the base is deterministic and needs no memory of the process that made it.
 */
export function resolveRoutingForAttempt({ base, attemptHistory = [] } = {}) {
  if (!base) throw new SpikeError('INVALID_ARGS', 'resolveRoutingForAttempt needs the job base routing');

  let current = base;
  let fellBack = false;
  let escalated = false;

  for (const entry of attemptHistory ?? []) {
    const routed = entry?.routedTo;
    if (!routed?.modelKey) continue;

    current = {
      ...current,
      ...routed,
      // Preserved from the base: what the classifier saw does not change
      // because the model did.
      complexity: current.complexity,
      riskScore: current.riskScore,
      signals: current.signals,
    };
    if (entry.reason === REROUTE_REASONS.MODEL_FALLBACK) fellBack = true;
    if (entry.reason === REROUTE_REASONS.MODEL_ESCALATION) escalated = true;
  }

  return { routing: current, fellBack, escalated };
}

/**
 * A routing decision that describes an existing Developer profile.
 *
 * Compatibility, and the bridge for jobs written before routing existed: a job
 * carrying only a profile name still yields a decision the runtime can replay,
 * instead of being re-decided on read.
 */
export function routingFromProfile(profile, { stage = ROUTING_STAGES.IMPLEMENTATION, mode = ROUTING_MODES.AUTO } = {}) {
  const key = modelKeyOf(profile.model);
  if (!key) {
    throw new SpikeError(
      'UNKNOWN_MODEL',
      `Profile ${profile.name} declares model ${profile.model}, which is not in the routing registry`,
    );
  }
  return decision({
    role: 'developer',
    stage,
    complexity: null,
    riskScore: null,
    signals: [],
    modelKey: key,
    effort: profile.effort,
    reason: `PROFILE_${profile.name}`,
    fallbackAllowed: key === 'sonnet',
    mode,
  });
}

/** The compact record persisted on an attempt-history entry. */
export function toRoutedRecord(decisionRecord) {
  return {
    modelKey: decisionRecord.modelKey,
    model: decisionRecord.model,
    family: decisionRecord.family,
    effort: decisionRecord.effort,
    reason: decisionRecord.reason,
    fallbackAllowed: decisionRecord.fallbackAllowed,
  };
}

/** The record a job carries so a worker executes a decision instead of making one. */
export function toJobRouting(decisionRecord) {
  return {
    role: decisionRecord.role,
    stage: decisionRecord.stage,
    modelKey: decisionRecord.modelKey,
    model: decisionRecord.model,
    family: decisionRecord.family,
    effort: decisionRecord.effort,
    complexity: decisionRecord.complexity,
    riskScore: decisionRecord.riskScore,
    signals: [...decisionRecord.signals],
    reason: decisionRecord.reason,
    fallbackAllowed: decisionRecord.fallbackAllowed,
    mode: decisionRecord.mode,
  };
}
