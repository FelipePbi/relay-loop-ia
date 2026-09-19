/**
 * IA Loop — a place for RESOURCE_* events to go without every caller
 * inventing its own logging.
 *
 * Deliberately tiny: normal/verbose terminal lines only, matching the
 * existing `log(tag, message)` convention in worker-loop.mjs. No secrets,
 * no prompt text, and never called from inside a model invocation.
 */
export function logResourceEvent(log, event, detail = '') {
  log('RESOURCE', `${event}${detail ? ` ${detail}` : ''}`);
}
