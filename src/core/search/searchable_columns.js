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
 * All but one of these hold STRING. `tool_args` is a JSON column, so it
 * reads back from parquet as an object rather than text; the matcher's
 * `cellText` renders it before testing, because a column in this set that
 * cannot produce a hit is worse than one that is absent from it.
 *
 * The set is a constant, not configuration. Sharing it is what makes
 * "zero hits" mean the same thing locally and remotely, and a per-install
 * knob would reintroduce exactly the drift the sharing removes.
 *
 * @ref LLP 0264#shared [implements]: the allowlist is hoisted here and imported by the server, because two drifting copies would make the same query lie on one side
 * @ref LLP 0265#out-of-scope [constrained-by]: no config knob for indexed columns; the allowlist is the shared constant by decision
 */
export const SEARCHABLE_COLUMNS = new Set([
  'content_text',
  'tool_name',
  'tool_args',
  'session_id',
  'conversation_id',
  'agent_id',
  'model',
  'cwd',
  'git_branch',
  'git_remote',
])

/**
 * The columns a brute scan has to decode: the searchable set plus every
 * column the scan's own readers consult. A brute scan reads a whole
 * parquet file with no index to prune it, so without this list it
 * decodes `system_text` and the other bulk machinery columns only to
 * ignore them. Server LLP 0157 measured `system_text` alone at 90.8% of
 * decoded index-build text, which is why "every string column" is
 * refuted by production measurement. The indexed path is unaffected:
 * hypgrep's `parquetFind` reads whole candidate rows and this list does
 * not reach it.
 *
 * The extras beyond `SEARCHABLE_COLUMNS` are derived from the readers,
 * not guessed, because a starved column throws nothing: it reads as
 * missing and silently yields a wrong or empty hit.
 *
 * - `date`: the from/to window predicate, and the hit's own day.
 * - `received_at`: the tier exclusion, the rule that keeps a row held by
 *   two tiers at once from being counted twice.
 * - `part_id`, `message_id`, `message_created_at`: the hit's locator
 *   fields, and the sort key plus tiebreak that order the answer.
 *
 * The chain triple (`session_id`, `agent_id`, `conversation_id`) is read
 * by the chain predicate and the hit too, and is already searchable.
 *
 * A column named here but absent from the file is skipped rather than
 * refused (hyparquet's object mode ignores an unknown name), so a
 * narrower schema, an older cache generation or the client's own
 * `ai_gateway_messages` (which carries no `received_at`), reads exactly
 * as it did before.
 */
export const SCAN_COLUMNS = [
  ...SEARCHABLE_COLUMNS,
  'date',
  'received_at',
  'part_id',
  'message_id',
  'message_created_at',
]
