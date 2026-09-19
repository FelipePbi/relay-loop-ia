/**
 * IA Loop — what the router actually did, per Goal.
 *
 * Derived from the event log, never from a counter someone remembered to
 * increment: MODEL_ROUTED, MODEL_FALLBACK, MODEL_ESCALATED and
 * MODEL_ESCALATION_REFUSED are already written at the moment each decision is
 * taken, so this can be asked long after the run and still be true.
 *
 * It exists to answer one question honestly — did adaptive routing actually
 * save the expensive models, or did everything quietly end up on Fable again?
 */

const ROUTED = 'MODEL_ROUTED';
const FALLBACK = 'MODEL_FALLBACK';
const ESCALATED = 'MODEL_ESCALATED';
const REFUSED = 'MODEL_ESCALATION_REFUSED';

const WORK_UNIT_STARTED = 'WORK_UNIT_STARTED';
const WORK_UNIT_COMPLETED = 'WORK_UNIT_COMPLETED';
const DETERMINISTIC_EXECUTED = 'WORK_UNIT_DETERMINISTIC_EXECUTED';
const CONTEXT_EXPANDED = 'WORK_UNIT_CONTEXT_EXPANDED';
const PLAN_RESOLVED = 'WORK_UNIT_PLAN_RESOLVED';

const STAGE_LABEL = Object.freeze({
  planning: 'Planning',
  review: 'Review',
  implementation: 'Developer',
  correction: 'Developer (correction)',
  work_unit: 'Work Unit',
  closure: 'Closure documentation',
});

/**
 * Summarises the routing of one Goal.
 *
 * `events` is the raw event log. Only this Goal's routing events are read, so
 * a summary can never borrow another Goal's numbers.
 */
export function summarizeRouting(events, { goal } = {}) {
  const mine = (events ?? []).filter((event) => (goal ? event.goal === goal : true));

  const calls = { haiku: 0, sonnet: 0, opus: 0, fable: 0 };
  const stages = new Map();
  const fallbacks = [];
  const escalations = [];
  const refusals = [];

  /**
   * Work Unit execution, counted from the same event log.
   *
   * Derived rather than accumulated for the same reason everything else here
   * is: a counter someone remembered to increment is a counter someone will
   * forget to increment, and this has to stay answerable long after the run.
   */
  const workUnits = {
    plans: 0,
    total: 0,
    byType: {},
    byState: {},
    // Every attempt at a DETERMINISTIC action, successful or not — this is
    // "how many times a model was not called", true regardless of outcome.
    deterministicRuns: 0,
    deterministicSuccesses: 0,
    deterministicFailures: 0,
    contextExpansions: 0,
    attempts: 0,
    // "Model calls avoided" means a model call was genuinely made unnecessary
    // — which only a SUCCESSFUL deterministic check does. A failed attempt
    // (Goal 011: spawn ENOENT on Windows, all 10) still spent zero model
    // calls, but it verified nothing; the unit still needed a model-based fix
    // afterwards, so nothing was actually avoided. Counting it here would
    // report a Windows spawn bug as a savings win. Equal to
    // deterministicSuccesses; kept as its own field because the two answer
    // different questions ("what worked" vs. "what this replaced") and a
    // future caller should not have to know they happen to be the same number.
    modelCallsAvoided: 0,
  };

  for (const event of mine) {
    if (event.type === PLAN_RESOLVED) {
      workUnits.plans += 1;
      for (const [type, count] of Object.entries(event.types ?? {})) {
        workUnits.byType[type] = (workUnits.byType[type] ?? 0) + count;
      }
    } else if (event.type === WORK_UNIT_STARTED) {
      workUnits.total += 1;
    } else if (event.type === WORK_UNIT_COMPLETED) {
      workUnits.byState[event.state] = (workUnits.byState[event.state] ?? 0) + 1;
      workUnits.attempts += event.attempts ?? 0;
    } else if (event.type === DETERMINISTIC_EXECUTED) {
      workUnits.deterministicRuns += 1;
      if (event.ok) {
        workUnits.deterministicSuccesses += 1;
        workUnits.modelCallsAvoided += 1;
      } else {
        workUnits.deterministicFailures += 1;
      }
      workUnits.byState[event.ok ? 'COMPLETED' : 'FAILED'] = (workUnits.byState[event.ok ? 'COMPLETED' : 'FAILED'] ?? 0) + 1;
    } else if (event.type === CONTEXT_EXPANDED) {
      // Counted from the GRANT, not from the unit's final record: an expansion
      // that ended a unit's last attempt never reaches a WORK_UNIT_COMPLETED,
      // and the whole point of the number is to notice slicing that is too
      // aggressive — including when it is too aggressive to recover from.
      workUnits.contextExpansions += 1;
    }

    if (event.type === ROUTED) {
      if (Object.hasOwn(calls, event.selectedModel)) calls[event.selectedModel] += 1;
      // Last write wins per stage+round: the model that ACTUALLY ran is the
      // one the last attempt was routed to.
      //
      // A Work Unit stage is keyed by its JOB as well, because a round has
      // many of them: collapsing them onto `work_unit:1` would report the last
      // unit as though it were the whole round.
      const key = event.stage === 'work_unit'
        ? `work_unit:${event.round ?? 0}:${event.jobId}`
        : `${event.stage}:${event.round ?? 0}`;
      stages.set(key, {
        stage: event.stage,
        round: event.round ?? 0,
        // Only a Work Unit row has one; it is what makes the row identifiable
        // when a round has a dozen of them.
        unit: event.stage === 'work_unit' ? (event.workUnitId ?? unitIdOf(event.jobId)) : null,
        model: event.selectedModel,
        effort: event.effort ?? null,
        complexity: event.complexity ?? null,
        riskScore: event.riskScore ?? null,
        reason: event.reason ?? null,
        signals: event.signals ?? [],
        attempts: (stages.get(key)?.attempts ?? 0) + 1,
        firstModel: stages.get(key)?.firstModel ?? event.selectedModel,
      });
    } else if (event.type === FALLBACK) {
      fallbacks.push({ role: event.agent, from: event.from, to: event.to, reason: event.reason, round: event.round ?? 0 });
    } else if (event.type === ESCALATED) {
      escalations.push({ role: event.agent, from: event.from, to: event.to, reason: event.reason, round: event.round ?? 0 });
    } else if (event.type === REFUSED) {
      refusals.push({ role: event.agent, requested: event.requested, reason: event.reason, round: event.round ?? 0 });
    }
  }

  return {
    goal: goal ?? null,
    calls,
    totalCalls: calls.haiku + calls.sonnet + calls.opus + calls.fable,
    stages: [...stages.values()].sort((a, b) => a.round - b.round),
    fallbacks,
    escalations,
    refusals,
    // Null when the Goal did not run as a DAG, so a legacy run reports nothing
    // rather than reporting zeros that look like a decomposition that failed.
    workUnits: workUnits.plans > 0 ? workUnits : null,
  };
}

/** The unit id carried inside a Work Unit job id (`008-r1-unit-wu-001`). */
function unitIdOf(jobId) {
  const match = /-unit-([a-z]+)-(\d+)(?:-g\d+)?$/.exec(jobId ?? '');
  return match ? `${match[1].toUpperCase()}-${match[2]}` : null;
}

/** The block printed at the end of a Goal, and by the status screen. */
export function renderRoutingSummary(summary) {
  const lines = ['MODEL ROUTING'];

  if (summary.stages.length === 0) {
    lines.push('  (no routed model call recorded for this Goal)');
    return lines;
  }

  for (const stage of summary.stages) {
    const label = STAGE_LABEL[stage.stage] ?? stage.stage;
    const risk = stage.complexity
      ? `${stage.complexity}${stage.riskScore === null ? '' : ` (score ${stage.riskScore})`}`
      : 'n/a';
    const named = stage.unit ? `${label} ${stage.unit}` : label;
    lines.push(`  ${named} R${stage.round}: ${risk} → ${stage.model}${stage.effort ? ` ${stage.effort}` : ''}`);
    if (stage.attempts > 1 && stage.firstModel !== stage.model) {
      lines.push(`    started on ${stage.firstModel}, ended on ${stage.model} after ${stage.attempts} attempts`);
    }
    if ((stage.signals ?? []).length > 0) lines.push(`    signals: ${stage.signals.join(', ')}`);
  }

  lines.push(`  Calls: haiku ${summary.calls.haiku} · sonnet ${summary.calls.sonnet}`
    + ` · opus ${summary.calls.opus} · fable ${summary.calls.fable}`);

  if (summary.workUnits) {
    const units = summary.workUnits;
    lines.push('  Work Units:');
    lines.push(`    declared: ${Object.entries(units.byType).map(([type, count]) => `${count} ${type}`).join(' · ') || 'none'}`);
    lines.push(`    executed: ${units.total} · states: `
      + `${Object.entries(units.byState).map(([state, count]) => `${count} ${state}`).join(' · ') || 'none'}`);
    lines.push(`    attempts: ${units.attempts} · context expansions: ${units.contextExpansions}`);
    // Attempts and outcome kept apart on purpose: a failed attempt still cost
    // zero model calls, but it verified nothing, so it is not a savings win —
    // "model calls avoided" only counts the runs that actually succeeded.
    lines.push(`    deterministic: ${units.deterministicRuns} attempt(s)`
      + ` — ${units.deterministicSuccesses} succeeded · ${units.deterministicFailures} failed`
      + ` · model calls: 0 · model calls avoided (successful only): ${units.modelCallsAvoided}`);
  }
  lines.push(`  Fallbacks: ${summary.fallbacks.length}`);
  for (const item of summary.fallbacks) {
    lines.push(`    ${item.role} R${item.round}: ${item.from} → ${item.to} (${item.reason})`);
  }
  lines.push(`  Escalations: ${summary.escalations.length}`);
  for (const item of summary.escalations) {
    lines.push(`    ${item.role} R${item.round}: ${item.from} → ${item.to} (${item.reason})`);
  }
  if (summary.refusals.length > 0) {
    lines.push(`  Escalations refused: ${summary.refusals.length}`);
    for (const item of summary.refusals) {
      lines.push(`    ${item.role} R${item.round}: asked ${item.requested} — ${item.reason}`);
    }
  }

  return lines;
}
