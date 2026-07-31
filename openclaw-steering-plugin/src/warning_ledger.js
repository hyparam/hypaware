// Rate-limited pass-through warning emission (LLP 0149#decision): "rate-
// limited per provider+cause, not per turn, so a misconfigured provider does
// not flood logs." This package runs inside OpenClaw's own process, not the
// HypAware kernel, so it has no access to HypAware's structured-logging
// sink; it emits a structured record naming provider, cause, and session so
// whatever collects OpenClaw's own plugin output can still answer a
// coverage query, matching the fields LLP 0149 names as the coverage ledger.
//
// @ref LLP 0149#decision [implements]: one rate-limited warning per
// provider+cause naming provider, cause, session.

const DEFAULT_WINDOW_MS = 5 * 60 * 1000

/**
 * @typedef {{ provider: string, cause: string, session?: string }} UncapturedTurn
 */

/**
 * @param {{
 *   windowMs?: number,
 *   now?: () => number,
 *   emit?: (record: UncapturedTurn & { component: string, operation: string, status: string }) => void,
 * }} [opts]
 */
export function createWarningLedger(opts = {}) {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
  const now = opts.now ?? Date.now
  const emit = opts.emit ?? defaultEmit
  /** @type {Map<string, number>} */
  const lastEmittedAt = new Map()

  return {
    /**
     * @param {UncapturedTurn} record
     * @returns {boolean} true if the warning was emitted, false if it was suppressed by the rate limit
     */
    warn(record) {
      const key = `${record.provider}:${record.cause}`
      const at = now()
      const last = lastEmittedAt.get(key)
      if (last !== undefined && at - last < windowMs) {
        return false
      }
      lastEmittedAt.set(key, at)
      emit({
        component: 'openclaw-steering-plugin',
        operation: 'before_model_resolve',
        status: 'uncaptured',
        provider: record.provider,
        cause: record.cause,
        session: record.session,
      })
      return true
    },
  }
}

/**
 * @param {UncapturedTurn & { component: string, operation: string, status: string }} record
 */
function defaultEmit(record) {
  console.warn('[hypaware-openclaw-steering] uncaptured provider turn', record)
}
