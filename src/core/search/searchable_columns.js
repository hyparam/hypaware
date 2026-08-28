// @ts-check

/**
 * The columns grep search covers, shared by every tier and by both
 * repositories. The client scans its own uncompacted files and reads
 * hypgrep sidecars over its compacted ones; the server scans its cache
 * and reads sidecars over its archive. All four paths import this one
 * set, so no tier can surface a match another tier cannot: a column
 * outside the set is neither indexed nor tested against any scanned row.
 * Everything else stays reachable through SQL (`hyp query sql`, and the
 * server's `POST /v1/query`).
 *
 * Insertion order is meaningful: matched columns are reported in this
 * order, so the content column leads a hit's snippets.
 *
 * Every column here holds STRING. `tool_args` is deliberately absent, and
 * its absence is a gap recorded rather than left to be rediscovered (the
 * discipline of server LLP 0157 #identifier-columns). It is the dataset's
 * one VARIANT column (iceberg `variant`, a JSON cell), and no tier in
 * either repository can produce a hit from it: both index workers filter
 * VARIANT out before building, and the server's shared row predicate gates
 * on `typeof value === 'string' && value !== ''`, which an object-valued
 * cell fails. A column in this set that cannot produce a hit is worse than
 * one absent from it, because it is decoded on every brute scan for the
 * cost and named in the tool description for the promise while answering
 * zero. hyparam/hypaware#977 restores the coverage on every tier at once,
 * once hypgrep can index VARIANT.
 *
 * The set is a constant, not configuration. Sharing it is what makes
 * "zero hits" mean the same thing locally and remotely, and a per-install
 * knob would reintroduce exactly the drift the sharing removes.
 *
 * @ref LLP 0264#shared [implements]: the allowlist is hoisted here and imported by the server, because two drifting copies would make the same query lie on one side
 * @ref LLP 0265#out-of-scope [constrained-by]: no config knob for indexed columns; the allowlist is the shared constant by decision
 */
export const SEARCHABLE_COLUMNS = constantSet([
  'content_text',
  'tool_name',
  'session_id',
  'conversation_id',
  'agent_id',
  'model',
  'cwd',
  'git_branch',
  'git_remote',
])

/**
 * The one dataset grep search covers, on both repositories: the client
 * greps its own `ai_gateway_messages` cache, the server the same dataset's
 * cache and archive. Named here beside the columns it scopes so the search
 * service and the sidecar-build pass cannot disagree about which tables
 * carry indexes.
 */
export const GREP_DATASET = 'ai_gateway_messages'

/**
 * The sidecar path beside a data file: hypgrep's own default, which is a
 * contract. Any reader with byte access to the cache can search a file
 * with the stock hypgrep CLI, no daemon involved. It lives beside the
 * allowlist for the same reason `GREP_DATASET` does: the build pass that
 * publishes a sidecar and the search service that probes for one must
 * spell this path identically, or the build writes an index nobody looks
 * for and every file silently falls back to the scan tier. Takes a
 * filesystem path or a `file://` URL; only the extension is rewritten.
 *
 * @param {string} dataFile
 * @returns {string}
 */
export function sidecarPathFor(dataFile) {
  return dataFile.replace(/\.parquet$/i, '.index.parquet')
}

/**
 * A Set that cannot be added to, deleted from, or cleared. `SCAN_COLUMNS`
 * below is a load-time snapshot of the allowlist, so a caller mutating the
 * exported Set would make a column searchable process-wide while the brute
 * scan never decodes it: searchable on the row predicate, silently zero on
 * the scan that never reads the column, which is the exact drift the
 * sharing removes. `Object.freeze` does not reach `Set.prototype.add`, so
 * the mutators are replaced rather than relied on.
 *
 * @param {string[]} columns
 * @returns {Set<string>}
 */
function constantSet(columns) {
  const set = new Set(columns)
  for (const method of ['add', 'delete', 'clear']) {
    Object.defineProperty(set, method, {
      value: () => {
        throw new Error('SEARCHABLE_COLUMNS is a constant, not configuration')
      },
    })
  }
  return Object.freeze(set)
}

/**
 * The columns EITHER tier has to decode. A brute scan reads a whole
 * parquet file with no index to prune it, so without this list it
 * decodes `system_text` and the other bulk machinery columns only to
 * ignore them. Server LLP 0157 measured `system_text` alone at 90.8% of
 * decoded index-build text, which is why "every string column" is
 * refuted by production measurement. The indexed tier passes the same
 * list down: `parquetFind` forwards `columns` into its own read of each
 * candidate range, and a range is a whole coalesced run of blocks capped
 * only at row-group boundaries, so an unprojected indexed read can decode
 * more bytes than the brute scan it exists to beat.
 *
 * The extras beyond `SEARCHABLE_COLUMNS` are derived from the readers,
 * not guessed, because a starved column throws nothing: it reads as
 * missing and silently yields a wrong or empty hit.
 *
 * - `date`: the from/to window predicate, and the hit's own day.
 * - `received_at`: the SERVER's tier exclusion, the rule that keeps a row
 *   its cache and its archive both hold from being counted twice. The
 *   client has no such rule (a row lives in exactly one data file, and one
 *   file takes exactly one tier) and its `ai_gateway_messages` carries no
 *   such column at all, so on this side the per-file projection drops it.
 *   It is listed because this constant is shared:
 *   dropping it would starve the server's own exclusion, which is a wrong
 *   answer rather than a slower one.
 * - `part_id`, `message_id`, `message_created_at`: the hit's locator
 *   fields, and the sort key plus tiebreak that order the answer.
 *
 * The chain triple (`session_id`, `agent_id`, `conversation_id`) is read
 * by the chain predicate and the hit too, and is already searchable.
 *
 * Before either tier reads a file, `grep_service.js` intersects this list
 * with the file's physical schema. That keeps a narrower schema, an older
 * cache generation or the client's own `ai_gateway_messages` (which carries
 * no `received_at`) readable under hyparquet versions that reject an unknown
 * projected name.
 */
export const SCAN_COLUMNS = [
  ...SEARCHABLE_COLUMNS,
  'date',
  'received_at',
  'part_id',
  'message_id',
  'message_created_at',
]
