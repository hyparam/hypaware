// @ts-check

import { compareStrings, sanitizeLabel } from 'hypaware/core/util'
import { getLogger } from '../../../../src/core/observability/index.js'

/** @import { AiGatewayCaptureReason } from '../../../../hypaware-plugin-kernel-types.js' */
/** @import { CaptureOutcomeEntry } from '../../../../hypaware-core/plugins-workspace/ai-gateway/src/types.js' */

/**
 * How many distinct `entrypoint` values the tracker keeps. The set is
 * naturally tiny (one per client surface on the machine: `codex-tui`,
 * whatever Codex Desktop reports, `local-agent`, ...), but `entrypoint`
 * is a captured string nothing on the way in constrains, so an odd or
 * hostile client must not be able to grow a daemon-lifetime map without
 * bound. On overflow the least recently seen entry is evicted, which is
 * exactly the entry a "recent clients" readout would drop anyway.
 *
 * A count cap alone is not a bound: 32 entries of unbounded length is
 * still unbounded, and `status.json` is rewritten on every daemon tick.
 * `sanitizeLabel` supplies the other half (see `record`).
 */
const MAX_TRACKED_ENTRYPOINTS = 32

/**
 * Track which client surfaces have produced rows through this gateway,
 * and when. The daemon lifts the snapshot into `status.json` so
 * `hyp status` can answer "did Codex Desktop traffic arrive recently?"
 * without a cache read and without any client-specific knowledge in
 * core: the tracker never interprets an `entrypoint`, it only counts and
 * timestamps whatever the projector put in the column.
 *
 * In-memory and daemon-scoped by construction. It is an activity signal,
 * not a store: the cache remains the only durable record of a row.
 *
 * @param {{ max?: number, now?: () => number }} [options]
 * @ref LLP 0164#gateway-tracks-what-core-cannot-name [implements]: the gateway counts and timestamps entrypoints it never interprets
 */
export function createEntrypointActivity(options = {}) {
  const max = options.max ?? MAX_TRACKED_ENTRYPOINTS
  const now = options.now ?? (() => Date.now())
  /** @type {Map<string, { clientName: string | null, lastSeenMs: number, rows: number }>} */
  const seen = new Map()

  return {
    /**
     * Fold a batch of projected message rows into the activity map. Rows
     * with no `entrypoint` are ignored rather than bucketed under a
     * placeholder: "unknown" is not a client surface, and inventing one
     * would put a name in `hyp status` that no query can reproduce.
     *
     * `entrypoint` and `client_name` are sanitized before they are stored,
     * because this map is the source for a file on disk and for text
     * printed to a terminal. The values are captured verbatim from the
     * wire (`originator`) or, for Claude, copied off a transcript `.jsonl`
     * line on disk - and that second route has no HTTP parser bounding its
     * length or rejecting control bytes. Sanitizing at the point of record
     * (rather than at render) also keeps the map key itself clean, so the
     * eviction cap above cannot be diluted by values that differ only in
     * bytes no reader will ever see.
     *
     * @param {readonly Record<string, unknown>[]} rows
     */
    record(rows) {
      if (!Array.isArray(rows) || rows.length === 0) return
      const at = now()
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        const entrypoint = sanitizeLabel(row.entrypoint)
        if (entrypoint === undefined) continue
        const clientName = sanitizeLabel(row.client_name) ?? null
        const existing = seen.get(entrypoint)
        if (existing) {
          existing.lastSeenMs = at
          existing.rows += 1
          if (clientName) existing.clientName = clientName
          // Re-insert so Map iteration order stays least-recently-seen
          // first, which is what the eviction below relies on.
          seen.delete(entrypoint)
          seen.set(entrypoint, existing)
          continue
        }
        seen.set(entrypoint, { clientName, lastSeenMs: at, rows: 1 })
        while (seen.size > max) {
          const oldest = seen.keys().next()
          if (oldest.done) break
          seen.delete(oldest.value)
        }
      }
    },

    /**
     * The status-file view: most recently seen first, ISO timestamps, and
     * snake_case keys because this lands verbatim in `status.json`
     * alongside the gateway's other `details`.
     *
     * @returns {{ entrypoint: string, client_name: string | null, last_seen: string, rows: number }[]}
     */
    snapshot() {
      return Array.from(seen.entries())
        .map(([entrypoint, entry]) => ({
          entrypoint,
          client_name: entry.clientName,
          last_seen: new Date(entry.lastSeenMs).toISOString(),
          rows: entry.rows,
        }))
        .sort((a, b) => compareStrings(b.last_seen, a.last_seen))
    },

    /** @returns {number} */
    size() {
      return seen.size
    },
  }
}

export const CAPTURE_REASONS = Object.freeze([
  'text', 'media_omitted', 'load_unload', 'session_ignored', 'invalid_request', 'unsupported_shape',
  'invalid_response', 'malformed_stream', 'trailing_record', 'missing_terminal', 'transport_error',
  'upstream_unavailable', 'http_error', 'capture_limit', 'processor_unavailable', 'append_failure',
  'recording_disabled', 'owner_absent', 'owner_disabled', 'policy_unreadable', 'stale_generation', 'recording_barrier_unconfirmed',
])
const BENIGN_CAPTURE_REASONS = new Set(['text', 'media_omitted', 'load_unload', 'session_ignored', 'recording_disabled', 'owner_absent', 'owner_disabled', 'stale_generation'])

/**
 * A fixed known-route vocabulary, not an arbitrary-name or request-history map.
 * Every field is a capped scalar; readback never visits conversation storage.
 * @ref LLP 0474#diagnostics [implements]: finite default failure evidence, persistence only after append and coalesced secret-safe stderr transitions
 * @param {Iterable<string>} routes
 */
export function createCaptureOutcomes(routes) {
  /** @type {Map<string, CaptureOutcomeEntry>} */
  const entries = new Map()
  for (const route of routes) {
    if (entries.size >= 32) break
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(route)) continue
    entries.set(route, { route, observed: 0, persisted: 0, failed: 0, reasons: {}, reported_at: 0 })
  }
  const mirror = getLogger('ai-gateway-capture', { mirrorStderr: true })
  return {
    /** @param {string} route @param {AiGatewayCaptureReason | 'observed'} reason @param {string} [id] @param {boolean} [persisted] */
    record(route, reason, id, persisted = false) {
      const entry = entries.get(route)
      if (!entry || (reason !== 'observed' && !CAPTURE_REASONS.includes(reason))) return
      const at = Date.now()
      const timestamp = new Date(at).toISOString()
      const safeId = id && /^[a-zA-Z0-9:_-]{1,80}$/.test(id) ? id : undefined
      const count = value => Math.min(0x7fffffff, (value ?? 0) + 1)
      if (reason === 'observed') { entry.observed = count(entry.observed); entry.last_observed = timestamp; return }
      entry.reasons[reason] = count(entry.reasons[reason])
      if (persisted) { entry.persisted = count(entry.persisted); entry.last_persisted = timestamp; entry.persisted_id = safeId }
      if (!BENIGN_CAPTURE_REASONS.has(reason)) { entry.failed = count(entry.failed); entry.last_failed = timestamp; entry.failed_id = safeId }
      if (!persisted && (reason === 'text' || reason === 'media_omitted')) return
      entry.last_outcome = timestamp
      entry.reason = reason
      if (entry.reported_reason !== reason && (entry.reported_at === 0 || at - entry.reported_at >= 30_000)) {
        entry.reported_at = at
        entry.reported_reason = reason
        const fields = { operation: 'capture_outcome', route, reason, ...(safeId ? { exchange_id: safeId } : {}) }
        if (BENIGN_CAPTURE_REASONS.has(reason)) mirror.info('aigw.capture_outcome', fields)
        else mirror.warn('aigw.capture_outcome', fields)
      }
    },
    snapshot: () => [...entries.values()].map(({ reported_at, reported_reason, ...entry }) => ({ ...entry, reasons: { ...entry.reasons } })),
  }
}

/**
 * Merge only the finite per-route scalars. Gateway admission/drop evidence and
 * processor persistence have different owners; live forwarding must not erase
 * a processor failure or impersonate a successful append.
 * @ref LLP 0474#diagnostics [implements]: bounded aggregate capture evidence remains independent of sink status
 * @param {unknown} recorded
 * @param {unknown} live
 */
export function mergeCaptureOutcomes(recorded, live) {
  /** @type {Map<string, Record<string, unknown>>} */
  const entries = new Map()
  for (const list of [recorded, live]) {
    if (!Array.isArray(list)) continue
    for (let entry of list.slice(0, 32)) {
      if (!entry || typeof entry.route !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(entry.route)) continue
      const previous = entries.get(entry.route)
      if (!previous && entries.size >= 32) continue
      const safe = captureSummary(entry)
      if (!previous) { entries.set(entry.route, safe); continue }
      entry = safe
      const newer = typeof entry.last_outcome === 'string' && entry.last_outcome > String(previous.last_outcome ?? '')
      /** @type {Record<string, unknown>} */
      const merged = { ...previous, ...(newer ? { reason: entry.reason, last_outcome: entry.last_outcome } : {}) }
      for (const key of ['observed', 'persisted', 'failed']) merged[key] = Math.min(0x7fffffff, Math.max(Number(previous[key]) || 0, Number(entry[key]) || 0))
      for (const [key, idKey] of [['last_observed', ''], ['last_persisted', 'persisted_id'], ['last_failed', 'failed_id']]) {
        if (typeof entry[key] === 'string' && entry[key] > String(previous[key] ?? '')) {
          merged[key] = entry[key]
          if (idKey) merged[idKey] = entry[idKey]
        }
      }
      // Histories overlap at raw admission/projection; counts are observed
      // lower bounds, not a sum pretending to be a durable request ledger.
      const a = /** @type {Record<string, unknown>} */ (previous.reasons ?? {})
      const b = /** @type {Record<string, unknown>} */ (entry.reasons ?? {})
      const reasons = { ...a }
      for (const key of Object.keys(b).slice(0, 32)) reasons[key] = Math.min(0x7fffffff, Math.max(Number(a[key]) || 0, Number(b[key]) || 0))
      merged.reasons = reasons
      entries.set(entry.route, merged)
    }
  }
  return [...entries.values()]
}

/** @param {Record<string, unknown>} entry */
function captureSummary(entry) {
  /** @type {Record<string, unknown>} */
  const out = { route: entry.route }
  for (const key of ['observed', 'persisted', 'failed']) out[key] = Math.max(0, Math.min(0x7fffffff, Number(entry[key]) || 0))
  for (const key of ['last_observed', 'last_outcome', 'last_persisted', 'last_failed']) {
    if (typeof entry[key] === 'string' && /^\d{4}-\d{2}-\d{2}T[0-9:.]{12}Z$/.test(entry[key])) out[key] = entry[key]
  }
  for (const key of ['persisted_id', 'failed_id']) if (typeof entry[key] === 'string' && /^[a-zA-Z0-9:_-]{1,80}$/.test(entry[key])) out[key] = entry[key]
  if (typeof entry.reason === 'string' && CAPTURE_REASONS.includes(entry.reason)) out.reason = entry.reason
  /** @type {Record<string, number>} */
  const reasons = {}
  const counts = /** @type {Record<string, unknown> | undefined} */ (entry.reasons)
  for (const reason of CAPTURE_REASONS) if (counts && typeof counts[reason] === 'number' && Number.isFinite(counts[reason])) reasons[reason] = Math.max(0, Math.min(0x7fffffff, Math.floor(counts[reason])))
  out.reasons = reasons
  return out
}
