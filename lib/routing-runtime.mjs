/**
 * IA Loop — routing, joined to the job store.
 *
 * `model-routing.mjs` is pure policy and knows nothing about disk. This is the
 * thin layer that gives that policy the two things it needs from the store —
 * what the job was routed to, and what already happened to this job — and hands
 * the capacity runner the two hooks it asks for.
 *
 * Everything it answers is derived from PERSISTED state, never from a variable
 * this process happens to hold. That is what makes a restart continue instead
 * of re-deciding: the same job file and the same attempt history produce the
 * same model, in this process or the next one.
 */

import {
  ESCALATION_VERDICTS,
  REROUTE_REASONS,
  authorizeDeveloperEscalation,
  authorizeReviewEscalation,
  authorizeWorkUnitEscalation,
  planCapacityFallback,
  resolveRoutingForAttempt,
  resolveRoutingMode,
  routeWorkUnit,
  toRoutedRecord,
} from './model-routing.mjs';
import { readJson } from './job-store.mjs';
import { WORK_UNIT_NAMESPACE } from './job-store.mjs';

/**
 * The router a worker hands to `runWithCapacity`.
 *
 * `base` is the decision the job carries. `kind` says which escalation policy
 * applies — a Developer asking for a stronger executor and a reviewer asking
 * for a stronger reviewer are judged by different rules.
 */
export function createAttemptRouter({
  store,
  role,
  jobId,
  base,
  kind = 'developer',
  mode = resolveRoutingMode(),
  goal = null,
  round = null,
}) {
  async function history() {
    const envelope = await readJson(store.paths.job(role, jobId));
    return envelope?.attemptHistory ?? [];
  }

  /** What this attempt runs on, replayed from the job and its history. */
  async function current() {
    if (!base) return { routing: null, fellBack: false, escalated: false };
    return resolveRoutingForAttempt({ base, attemptHistory: await history() });
  }

  async function refuse({ verdict, reason, request, attempt }) {
    await store.appendEvent({
      type: 'MODEL_ESCALATION_REFUSED',
      goal, round, agent: role, jobId, attempt,
      verdict,
      requested: request?.reason ?? null,
      reason,
    });
  }

  return {
    current,

    /** Availability only. The router refuses anything else, loudly and on record. */
    async fallbackFor({ reason, attempt }) {
      const { routing, fellBack } = await current();
      if (!routing) return null;

      const decision = planCapacityFallback({
        current: routing, reason, alreadyFellBack: fellBack, mode,
      });
      if (!decision) return null;

      return { decision, routed: toRoutedRecord(decision), from: routing.modelKey };
    },

    /**
     * A structurally valid answer that asked for a stronger model.
     *
     * The request is READ from the contract — never from prose — and granted
     * only by the policy. A refusal is recorded too: "the Developer asked and
     * the router said no" is exactly the kind of thing that must not be
     * invisible later.
     */
    async escalationFor({ result, attempt }) {
      const request = kind === 'review' ? result?.escalationRequest : result?.escalation;
      const wantsEscalation = kind === 'review'
        ? Boolean(request) && result?.decision === 'HUMAN_REQUIRED'
        : result?.status === 'ESCALATION_REQUIRED';
      if (!wantsEscalation) return null;

      const { routing, escalated } = await current();
      const authorize = kind === 'review' ? authorizeReviewEscalation : authorizeDeveloperEscalation;
      const verdict = authorize({ request, current: routing, alreadyEscalated: escalated, mode });

      if (verdict.verdict !== ESCALATION_VERDICTS.AUTHORIZED) {
        await refuse({ verdict: verdict.verdict, reason: verdict.reason, request, attempt });
        return null;
      }

      return {
        decision: verdict.decision,
        routed: toRoutedRecord(verdict.decision),
        from: routing?.modelKey ?? null,
        reason: verdict.reason,
        evidence: verdict.evidence,
      };
    },
  };
}

/**
 * The router for ONE Work Unit.
 *
 * Separate from `createAttemptRouter` because a unit escalates along a
 * different axis. The two agent roles move between *models* chosen for a role;
 * a unit moves between *tiers* — MECHANICAL to STANDARD to COMPLEX — and the
 * model is whatever the tier's row in the table says. Encoding that as another
 * `kind` inside the role router would mean one function answering two
 * different questions with two different notions of "current".
 *
 * The tier is DERIVED from the persisted attempt history, never held in a
 * variable: the number of authorised escalations recorded on the job is what
 * says which tier this attempt is on, so a restart replays to the same answer.
 */
export function createWorkUnitAttemptRouter({
  store,
  jobId,
  unit,
  goal = null,
  round = null,
  mode = resolveRoutingMode(),
}) {
  const role = WORK_UNIT_NAMESPACE;

  async function history() {
    const envelope = await readJson(store.paths.job(role, jobId));
    return envelope?.attemptHistory ?? [];
  }

  /**
   * What this attempt runs on, and which tier it is on.
   *
   * `escalations` counts only entries the router itself wrote as an
   * escalation. A capacity fallback also changes the model, and it must NOT
   * count: falling back from Haiku to Sonnet because a quota closed is not the
   * unit proving it needed a stronger tier, and treating it as one would let
   * an availability problem quietly promote work nobody escalated.
   */
  async function current() {
    const entries = await history();
    const escalations = entries.filter((entry) => entry?.reason === REROUTE_REASONS.MODEL_ESCALATION).length;
    const base = routeWorkUnit({ unit, escalations, mode });
    if (!base.routing) return { routing: null, tier: base.tier, escalations, fellBack: false, escalated: escalations > 0 };

    const replayed = resolveRoutingForAttempt({ base: base.routing, attemptHistory: entries });
    return {
      routing: replayed.routing,
      tier: base.tier,
      escalations,
      fellBack: replayed.fellBack,
      escalated: escalations > 0,
    };
  }

  // The last refusal this router issued, in memory only. It exists so a caller
  // can tell the one refusal that is not the unit's fault — the table ran out —
  // from the ones that are, without matching on the reason's prose.
  let lastRefusal = null;

  async function refuse({
    verdict, reason, request, attempt, atTopOfTable = false,
  }) {
    lastRefusal = { verdict, reason, attempt, atTopOfTable, requested: request?.reason ?? null };
    await store.appendEvent({
      type: 'MODEL_ESCALATION_REFUSED',
      goal, round, agent: role, jobId, attempt,
      workUnitId: unit.id,
      verdict,
      requested: request?.reason ?? null,
      atTopOfTable,
      reason,
    });
  }

  return {
    current,

    /** What the router last said no to, or null if it has said no to nothing. */
    lastRefusal: () => (lastRefusal ? { ...lastRefusal } : null),

    /** Availability only, exactly as for a role. */
    async fallbackFor({ reason, attempt }) {
      const { routing, fellBack } = await current();
      if (!routing) return null;

      const planned = planCapacityFallback({ current: routing, reason, alreadyFellBack: fellBack, mode });
      if (!planned) return null;

      return { decision: planned, routed: toRoutedRecord(planned), from: routing.modelKey };
    },

    /**
     * A unit that answered under contract and asked for a stronger tier — OR
     * a MECHANICAL unit that came back BLOCKED while the CLI itself recorded
     * real permission_denials for the attempt.
     *
     * The second case is not the model asking: Haiku, across three separate
     * real runs (Goal010 twice, Goal011 once), reported BLOCKED and blamed
     * "permission" in prose without ever reliably naming it as an escalation
     * request. Trusting that prose was the mistake — this instead only acts
     * on the CLI's OWN record of which tool_use calls it denied, which is
     * infrastructure evidence, not a claim. A BLOCKED result with no denial
     * evidence at all is a normal outcome and is never escalated automatically
     * — only a confirmed tooling limitation does.
     *
     * `failedAttempts` is read from the history rather than trusted from the
     * request, because REPEATED_EXECUTION_FAILURE is the one reason that makes
     * a claim about the past — and a claim about the past is checkable.
     */
    async escalationFor({ result, attempt, permissionDenials = [] }) {
      const { tier, escalations } = await current();

      const hasPermissionDenials = Array.isArray(permissionDenials) && permissionDenials.length > 0;
      const isToolingBlocked = result?.status === 'BLOCKED' && tier === 'MECHANICAL' && hasPermissionDenials;

      if (result?.status !== 'ESCALATION_REQUIRED' && !isToolingBlocked) return null;

      const entries = await history();
      const failedAttempts = entries.filter((entry) => entry?.status === 'FAILED'
        || entry?.reason === 'AGENT_FAILURE'
        || entry?.status === 'INTERRUPTED').length;

      const request = isToolingBlocked
        ? {
          reason: 'TOOLING_PERMISSION_DENIED',
          confidence: 'HIGH',
          detail: `The CLI recorded ${permissionDenials.length} permission denial(s) during this attempt `
            + `(${[...new Set(permissionDenials.map((d) => d.tool_name).filter(Boolean))].join(', ') || 'unknown tool'}).`,
          evidence: permissionDenials.map((d) => `${d.tool_name ?? 'unknown tool'} denied (tool_use_id ${d.tool_use_id ?? 'unknown'})`),
        }
        : result.escalation;

      const verdict = authorizeWorkUnitEscalation({
        request,
        currentTier: tier,
        escalations,
        // The attempt that is asking has itself not succeeded, so it counts.
        failedAttempts: failedAttempts + 1,
        mode,
      });

      if (verdict.verdict !== ESCALATION_VERDICTS.AUTHORIZED) {
        await refuse({
          verdict: verdict.verdict,
          reason: verdict.reason,
          request,
          attempt,
          atTopOfTable: verdict.atTopOfTable === true,
        });
        return null;
      }

      const { routing } = await current();
      return {
        decision: verdict.decision,
        routed: toRoutedRecord(verdict.decision),
        from: routing?.modelKey ?? null,
        reason: verdict.reason,
        evidence: verdict.evidence,
        fromTier: verdict.fromTier,
        toTier: verdict.toTier,
      };
    },
  };
}
