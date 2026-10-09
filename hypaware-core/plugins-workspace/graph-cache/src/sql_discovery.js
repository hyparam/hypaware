// @ts-check

import { discover, explicitTerms, extractTerms } from './discovery.js'
import { MIN_TOKEN, basenameOf, createIndexBuilder, splitTokens } from './index_builder.js'

/**
 * @import { DiscoveryResult } from '../../../../hypaware-core/plugins-workspace/graph-cache/src/types.js'
 */

/**
 * Discovery through SQL, for the sources without a replica on disk: the team
 * server's `node`/`edge` tables over `query_sql --remote` (`team_server`,
 * labeled slow) and this machine's own capture graph (`local`, labeled local
 * captures only). Three bounded reads fetch just the neighbourhood discovery
 * walks: File nodes whose key contains a question term or a `--file`
 * basename, the `touched` edges into them, and the sessions on those edges.
 * They are fed through the same index builder and the same `discover()` the
 * replica uses, so every source ranks leads the same way.
 */

/** File nodes read at most. */
export const MAX_SQL_FILES = 500
/** Touched edges read at most: discovery's own visit budget. */
export const MAX_SQL_EDGES = 20_000
/** Sessions read at most. */
export const MAX_SQL_SESSIONS = 2_000
/** Ids per `IN (...)` list. */
const IN_CHUNK = 500

/**
 * @ref LLP 0480#sources [implements]: team_server and local discovery read a bounded neighbourhood by SQL and rank it with the replica's discovery
 * @param {{
 *   runSql: (sql: string) => Promise<Record<string, unknown>[]>,
 *   question: string,
 *   terms?: string[],
 *   offset?: number,
 *   repo?: string | null,
 *   repoRoot?: string | null,
 *   files?: string[],
 *   leads?: number,
 * }} args
 * @returns {Promise<{ result: DiscoveryResult, queries: number, capped: boolean }>}
 */
export async function discoverBySql({ runSql, question, terms, offset, repo = null, repoRoot = null, files = [], leads }) {
  // The prefilter keeps any File the replica's matching could: for each
  // term, every part of 3+ characters appears in the key (LLP 0488's compound
  // rule), and for each --file, its basename. `strpos` is a literal match, so
  // `_`, `%` and `\` in a term match themselves. discover then applies the
  // token rule to what this returns, as on the replica.
  // @ref LLP 0488#path-tokens [implements]: team_server and local discovery prefilter by the same term parts the replica matches
  /** @type {string[][]} */
  const clauses = []
  for (const term of terms ? explicitTerms(terms) : extractTerms(question)) {
    const parts = [...new Set(splitTokens(term.text).filter((p) => p.length >= MIN_TOKEN))]
    if (parts.length) clauses.push(parts)
  }
  for (const file of files) {
    const base = basenameOf(file).toLowerCase()
    if (base) clauses.push([base])
  }
  const builder = createIndexBuilder()
  let queries = 0
  let capped = false
  if (clauses.length > 0) {
    const fileRows = await runSql(
      'SELECT node_id, node_type, natural_key, label, first_seen FROM node WHERE node_type = \'File\' AND ('
      + clauses.map((parts) => `(${parts.map((p) => `strpos(lower(natural_key), ${sqlString(p)}) > 0`).join(' AND ')})`).join(' OR ')
      + `) LIMIT ${MAX_SQL_FILES}`,
    )
    queries++
    if (fileRows.length >= MAX_SQL_FILES) capped = true
    for (const row of fileRows) builder.addNode(row)
    const fileIds = unique(fileRows.map((r) => r.node_id))
    /** @type {Record<string, unknown>[]} */
    const edgeRows = []
    for (const chunk of chunks(fileIds, IN_CHUNK)) {
      if (edgeRows.length >= MAX_SQL_EDGES) { capped = true; break }
      const rows = await runSql(
        'SELECT edge_type, src_id, dst_id, src_type, dst_type, first_seen, source_keys FROM edge '
        + `WHERE edge_type = 'touched' AND dst_id IN (${chunk.map(sqlString).join(', ')}) LIMIT ${MAX_SQL_EDGES - edgeRows.length}`,
      )
      queries++
      edgeRows.push(...rows)
    }
    if (edgeRows.length >= MAX_SQL_EDGES) capped = true
    const sessionIds = unique(edgeRows.filter((e) => e.src_type === 'Session').map((e) => e.src_id))
    if (sessionIds.length > MAX_SQL_SESSIONS) capped = true
    for (const chunk of chunks(sessionIds.slice(0, MAX_SQL_SESSIONS), IN_CHUNK)) {
      const rows = await runSql(
        'SELECT node_id, node_type, natural_key, label, props, first_seen FROM node '
        + `WHERE node_type = 'Session' AND node_id IN (${chunk.map(sqlString).join(', ')})`,
      )
      queries++
      for (const row of rows) builder.addNode(row)
    }
    for (const row of edgeRows) builder.addEdge(row)
  }
  const index = await builder.finish()
  const result = discover(index, { question, repo, repoRoot, files, ...(leads !== undefined ? { leads } : {}), ...(terms ? { terms } : {}), ...(offset !== undefined ? { offset } : {}) })
  if (capped) result.coverage.truncated = true
  return { result, queries, capped }
}

/** @param {unknown[]} values @returns {string[]} */
function unique(values) {
  return [...new Set(values.filter((v) => typeof v === 'string' && v.length > 0).map(String))]
}

/**
 * @template T
 * @param {T[]} list @param {number} size
 * @returns {T[][]}
 */
function chunks(list, size) {
  /** @type {T[][]} */
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** @param {string} value */
function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}
