// @ts-check

/**
 * Shared skeleton pieces for client-history backfill providers
 * (`@hypaware/claude`, `@hypaware/codex`). Everything here is
 * client-agnostic: the import window, the item envelope, and the
 * dataset constants the envelope targets.
 */

/**
 * @import { AiGatewayProjectedExchange, BackfillItem, BackfillProvenance, BackfillRunContext } from '../../../hypaware-plugin-kernel-types.js'
 */

// Dataset name and materializer dispatch key owned by `@hypaware/ai-gateway`
// (DATASET_NAME / AI_GATEWAY_PROJECTED_EXCHANGE_KIND in its dataset.js).
// Held as plain constants so backfill adapters do not pull the gateway's
// runtime module graph in just for two strings; the end-to-end tests pin
// them by feeding yielded items through the real materializer.
export const AI_GATEWAY_MESSAGES_DATASET = 'ai_gateway_messages'
export const PROJECTED_EXCHANGE_KIND = 'ai_gateway.projected_exchange'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Resolve the import window in epoch millis. Explicit `since` / `until`
 * win; otherwise a positive `retentionDays` sets the lower bound so a
 * default run does not import history older than the cache retains.
 * Both ends may be open (`undefined`).
 *
 * @param {BackfillRunContext} ctx
 * @returns {{ sinceMs?: number, untilMs?: number }}
 */
export function resolveWindow(ctx) {
  const untilMs = parseIsoMs(ctx.until)
  let sinceMs = parseIsoMs(ctx.since)
  if (sinceMs === undefined && typeof ctx.retentionDays === 'number' && ctx.retentionDays > 0) {
    sinceMs = Date.now() - ctx.retentionDays * DAY_MS
  }
  return { sinceMs, untilMs }
}

/**
 * Parse an optional ISO-8601 string to epoch millis, returning
 * `undefined` for an absent or unparseable value.
 *
 * @param {string | undefined} value
 * @returns {number | undefined}
 */
function parseIsoMs(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * Keep items whose `timestampMs` falls within the window. Items with no
 * timestamp (legacy records, unparseable stamps) are kept rather than
 * silently dropped.
 *
 * @template {{ timestampMs?: number }} T
 * @param {T[]} items
 * @param {{ sinceMs?: number, untilMs?: number }} window
 * @returns {T[]}
 */
export function filterByWindow(items, window) {
  if (window.sinceMs === undefined && window.untilMs === undefined) return items
  return items.filter((item) => {
    if (item.timestampMs === undefined) return true
    if (window.sinceMs !== undefined && item.timestampMs < window.sinceMs) return false
    if (window.untilMs !== undefined && item.timestampMs > window.untilMs) return false
    return true
  })
}

/**
 * Wrap a projection in the `BackfillItem` envelope the runner expects.
 * The kernel types `value` as `Record<string, unknown>`; the projection
 * is a concrete interface, so bridge through `unknown`.
 *
 * @param {AiGatewayProjectedExchange} exchange
 * @param {BackfillProvenance} provenance
 * @returns {BackfillItem}
 */
export function projectedExchangeItem(exchange, provenance) {
  return {
    dataset: AI_GATEWAY_MESSAGES_DATASET,
    kind: PROJECTED_EXCHANGE_KIND,
    value: /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (exchange)),
    provenance,
  }
}

/** @param {unknown} err */
export function errMessage(err) {
  return err instanceof Error ? err.message : String(err)
}
