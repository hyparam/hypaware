// @ts-check

/**
 * How many distinct `entrypoint` values the tracker keeps. The set is
 * naturally tiny (one per client surface on the machine: `codex-tui`,
 * whatever Codex Desktop reports, `local-agent`, ...), but `entrypoint`
 * is a client-supplied string that rides in from request headers and
 * rollout metadata, so an odd or hostile client must not be able to grow
 * a daemon-lifetime map without bound. On overflow the least recently
 * seen entry is evicted, which is exactly the entry a "recent clients"
 * readout would drop anyway.
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
     * @param {readonly Record<string, unknown>[]} rows
     */
    record(rows) {
      if (!Array.isArray(rows) || rows.length === 0) return
      const at = now()
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        const entrypoint = row.entrypoint
        if (typeof entrypoint !== 'string' || entrypoint.length === 0) continue
        const clientName = typeof row.client_name === 'string' && row.client_name.length > 0
          ? row.client_name
          : null
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
        .sort((a, b) => (a.last_seen < b.last_seen ? 1 : a.last_seen > b.last_seen ? -1 : 0))
    },

    /** @returns {number} */
    size() {
      return seen.size
    },
  }
}
