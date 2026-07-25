// @ts-check

import { Attr, withSpan } from '../../../../src/core/observability/index.js'
import { executeQuerySql } from '../../../../src/core/query/sql.js'

import {
  EDGE_COLUMNS,
  EDGE_DATASET,
  graphTablePath,
  NODE_COLUMNS,
  NODE_DATASET,
} from './datasets.js'

/**
 * @import { HypAwareV2Config, QueryRegistry } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../../src/core/cache/types.js'
 * @import { ExecuteSqlOptions, ExecuteSqlResult } from '../../../../src/core/query/types.js'
 * @import { Contract, ContractRule, GraphRow, RulePredicate } from './types.js'
 */

/** The dedicated projection heap budget when the knob is unset: 3 GiB. */
const GRAPH_PROJECTION_DEFAULT_MAX_HEAP_BYTES = 3072 * 1024 * 1024

/**
 * The graph projection's DEDICATED execution heap budget in bytes, from
 * HYP_GRAPH_PROJECTION_MAX_HEAP_MB (default 3 GiB). The T0 shared scan
 * materializes the whole source table into memory before the rule loop sees a
 * row, so it needs headroom the 1 GiB user-query default (LLP 0056, added in
 * #295) rightly denies interactive traffic. This is a dedicated budget, not an
 * exemption: passing a finite bound keeps the fail-clean property (over-budget
 * projection refuses with a typed error the scheduler logs as
 * `graph_projection.scope_failed`) while leaving the user-query guard untouched.
 * Never returns 0: 0 disables executeQuerySql's watchdog entirely, risking a
 * daemon OOM crash-loop that is strictly worse than a stale graph, so a blank,
 * zero, non-positive, or non-numeric knob falls back to the default rather than
 * removing the guard. Mirrors resolveHeapBudgetBytes' blank-var handling.
 *
 * @returns {number}
 * @ref LLP 0097 [constrained-by]: reuses the maxHeapBytes option and inherits its fail-clean refusal; deliberately does NOT use the "0 disables" escape the doc exposes
 */
export function resolveProjectionMaxHeapBytes() {
  const raw = process.env.HYP_GRAPH_PROJECTION_MAX_HEAP_MB?.trim()
  if (raw) {
    const mb = Number(raw)
    if (Number.isFinite(mb) && mb > 0) return mb * 1024 * 1024
  }
  return GRAPH_PROJECTION_DEFAULT_MAX_HEAP_BYTES
}

/**
 * Run the T0 deterministic projection: read each registered source contract's
 * rules, materialize node/edge rows (deterministic ids + inline provenance),
 * dedup against already-committed rows, and append the new ones. Rows from
 * different contracts that mint the same content-addressed id merge by the
 * order-independent `mergeRow`, so two sources naming the same Actor/File
 * structurally converge for free. Idempotent: a second run with no new source
 * data writes zero rows.
 *
 * @param {{ query: QueryRegistry, storage: ExtendedQueryStorageService, contracts: Contract[], config?: HypAwareV2Config, dryRun?: boolean, __executeSql?: (args: ExecuteSqlOptions) => Promise<ExecuteSqlResult> }} args
 * @returns {Promise<{ nodes: number, edges: number, nodesWritten: number, edgesWritten: number }>}
 * @ref LLP 0023#contract-contribution [implements]: the engine runs every registered contract; adding a source is contributing one
 */
export async function projectGraph({ query, storage, contracts, config, dryRun = false, __executeSql = executeQuerySql }) {
  // A dedicated finite budget for every projection scan: the shared scan below
  // fully materializes the source table, so it needs more than the 1 GiB
  // user-query default without stripping the guard (never 0). Resolved once and
  // applied at all three scan sites (shared scan, raw-SQL rules, dedup read).
  const maxHeapBytes = resolveProjectionMaxHeapBytes()
  return withSpan(
    'graph.project',
    {
      [Attr.COMPONENT]: 'plugin',
      [Attr.OPERATION]: 'graph.project',
      dry_run: dryRun,
      status: 'ok',
    },
    async (span) => {
      /** @type {Map<string, GraphRow>} */
      const nodes = new Map()
      /** @type {Map<string, GraphRow>} */
      const edges = new Map()

      /**
       * Feed one source row through a set of rules into the node/edge maps.
       * Merge is order-independent (`mergeRow`), so fanning a shared scan's
       * row out to many rules is observationally identical to the old
       * one-query-per-rule order.
       *
       * @param {Record<string, unknown>} row
       * @param {ContractRule[]} rules
       */
      const applyRules = (row, rules) => {
        for (const rule of rules) {
          if (rule.where && !matchesPredicate(rule.where, row)) continue
          const built = rule.toRow(row)
          if (!built) continue
          const target = rule.kind === 'node' ? nodes : edges
          const idKey = rule.kind === 'node' ? 'node_id' : 'edge_id'
          const id = /** @type {string} */ (built[idKey])
          const existing = target.get(id)
          if (existing) mergeRow(existing, built)
          else target.set(id, built)
        }
      }

      let sourceRows = 0
      let scanCount = 0
      for (const contract of contracts) {
        const keep = contract.rowFilter?.keep
        const declarative = contract.rules.filter((rule) => rule.columns)
        const raw = contract.rules.filter((rule) => typeof rule.sql === 'string')

        // One shared scan per contract: the union of the declarative rules'
        // columns (plus the row filter's), each rule's predicate evaluated
        // in JS per row. This is the whole LLP 0095 fix: rule count no
        // longer multiplies table scans, and the contract row filter runs
        // once per row instead of once per rule per row.
        // @ref LLP 0096#decision [implements]: one scan per contract; JS predicates with SQL null semantics; rowFilter once per row
        // @ref LLP 0095 [implements]: this shared scan is the read-amplification fix - rule count no longer multiplies table scans
        if (declarative.length > 0) {
          const columns = new Set()
          for (const rule of declarative) {
            for (const col of rule.columns ?? []) columns.add(col)
            for (const col of predicateColumns(rule.where)) columns.add(col)
          }
          for (const col of contract.rowFilter?.columns ?? []) columns.add(col)
          // Cache-to-cache read: the projection's output stays in the local
          // cache, so the LLP 0105 visibility filter is bypassed here (else a
          // daemon-context projection would silently drop local-only sessions
          // from the graph even for private-context readers). Visibility is
          // enforced when the graph datasets are READ, via their
          // localOnlyContentColumns declaration (datasets.js).
          // @ref LLP 0105#surfaces [constrained-by]: the filter governs read surfaces; derived-cache builds keep full fidelity and the derived dataset carries its own declaration
          const result = await __executeSql({
            query: `SELECT ${[...columns].sort().join(', ')} FROM ${contract.sourceDataset}`,
            registry: query,
            storage,
            config,
            refresh: 'always',
            includeLocalOnly: true,
            maxHeapBytes,
          })
          sourceRows += result.rows.length
          scanCount += 1
          for (const row of result.rows) {
            if (keep && !keep(row)) continue
            applyRules(row, declarative)
          }
        }

        // Raw-SQL rules run standalone, grouped by identical SQL text so
        // rule pairs sharing a query (a surface's node + edge rule) cost one
        // scan. Their SQL already selects the rowFilter's columns (registry
        // enforced), so the filter applies here too.
        /** @type {Map<string, ContractRule[]>} */
        const bySql = new Map()
        for (const rule of raw) {
          const sql = /** @type {string} */ (rule.sql)
          const group = bySql.get(sql)
          if (group) group.push(rule)
          else bySql.set(sql, [rule])
        }
        for (const [sql, rules] of bySql) {
          // Same cache-to-cache bypass and dedicated budget as the shared scan.
          const result = await __executeSql({
            query: sql,
            registry: query,
            storage,
            config,
            refresh: 'always',
            includeLocalOnly: true,
            maxHeapBytes,
          })
          sourceRows += result.rows.length
          scanCount += 1
          for (const row of result.rows) {
            if (keep && !keep(row)) continue
            applyRules(row, rules)
          }
        }
      }

      const nodeRows = [...nodes.values()]
      const edgeRows = [...edges.values()]
      span.setAttribute('contract_count', contracts.length)
      span.setAttribute('scan_count', scanCount)
      span.setAttribute('source_row_count', sourceRows)
      span.setAttribute('node_count', nodeRows.length)
      span.setAttribute('edge_count', edgeRows.length)

      if (dryRun) {
        return { nodes: nodeRows.length, edges: edgeRows.length, nodesWritten: 0, edgesWritten: 0 }
      }

      const freshNodes = await dedupExisting(nodeRows, 'node_id', NODE_DATASET, query, storage, config, maxHeapBytes, __executeSql)
      const freshEdges = await dedupExisting(edgeRows, 'edge_id', EDGE_DATASET, query, storage, config, maxHeapBytes, __executeSql)

      if (freshNodes.length > 0) {
        await storage.appendRows(graphTablePath(storage, NODE_DATASET), [...NODE_COLUMNS], freshNodes)
      }
      if (freshEdges.length > 0) {
        await storage.appendRows(graphTablePath(storage, EDGE_DATASET), [...EDGE_COLUMNS], freshEdges)
      }

      span.setAttribute('nodes_written', freshNodes.length)
      span.setAttribute('edges_written', freshEdges.length)
      return {
        nodes: nodeRows.length,
        edges: edgeRows.length,
        nodesWritten: freshNodes.length,
        edgesWritten: freshEdges.length,
      }
    },
    { component: 'plugin' }
  )
}

/**
 * Filter out rows whose id is already committed in the dataset: the
 * pre-write dedup that keeps re-projection idempotent at query time.
 * Duplicates that slip past it (concurrent projections, partial
 * failures) are merged later by `compactGraphTables` (maintenance.js).
 *
 * @param {GraphRow[]} rows
 * @param {'node_id' | 'edge_id'} idCol
 * @param {string} dataset
 * @param {QueryRegistry} query
 * @param {ExtendedQueryStorageService} storage
 * @param {HypAwareV2Config | undefined} config
 * @param {number} maxHeapBytes
 * @param {(args: ExecuteSqlOptions) => Promise<ExecuteSqlResult>} executeSql
 * @returns {Promise<GraphRow[]>}
 * @ref LLP 0023#pre-write-dedup [implements]: only a missing dataset is benign; real failures abort instead of duplicating
 */
async function dedupExisting(rows, idCol, dataset, query, storage, config, maxHeapBytes, executeSql) {
  if (rows.length === 0) return rows
  /** @type {Set<string>} */
  const seen = new Set()
  try {
    // Dedup must see EVERY committed id (ids are content-addressed hashes,
    // not content): a visibility-filtered id set would re-append rows the
    // filter hid and corrupt idempotency. Cache-internal, so bypass. Same
    // dedicated projection budget as the source scans (never the 1 GiB default).
    const res = await executeSql({
      query: `SELECT ${idCol} FROM ${dataset}`,
      registry: query,
      storage,
      config,
      refresh: 'always',
      includeLocalOnly: true,
      maxHeapBytes,
    })
    for (const r of res.rows) {
      const v = r[idCol]
      if (typeof v === 'string') seen.add(v)
    }
  } catch (err) {
    // Only "the dataset isn't there yet" is benign (nothing to dedup
    // against). A real query/storage failure must abort the projection:
    // treating it as an empty id set would append duplicates and report
    // success while the cache is unreadable.
    if (!isMissingDatasetError(err)) throw err
  }
  return rows.filter((r) => !seen.has(/** @type {string} */ (r[idCol])))
}

/**
 * Evaluate a rule's declarative predicate against one source row with SQL
 * semantics: every clause must hold, and a null or absent column never
 * matches (`WHERE col = 'x'` skips null rows; so does this).
 *
 * @param {RulePredicate} where
 * @param {Record<string, unknown>} row
 * @returns {boolean}
 * @ref LLP 0096#decision [implements]: eq/in/likePrefix only, AND-composed, null never matches
 */
export function matchesPredicate(where, row) {
  if (where.eq) {
    for (const [col, value] of Object.entries(where.eq)) {
      if (row[col] !== value) return false
    }
  }
  if (where.in) {
    for (const [col, values] of Object.entries(where.in)) {
      const v = row[col]
      if (typeof v !== 'string' || !values.includes(v)) return false
    }
  }
  if (where.likePrefix) {
    for (const [col, prefix] of Object.entries(where.likePrefix)) {
      const v = row[col]
      if (typeof v !== 'string' || !v.startsWith(prefix)) return false
    }
  }
  return true
}

/**
 * The columns a predicate reads, so the shared scan selects them even when
 * no rule's `columns` lists them (a rule may filter on a column `toRow`
 * never touches).
 *
 * @param {RulePredicate | undefined} where
 * @returns {string[]}
 */
function predicateColumns(where) {
  if (!where) return []
  return [
    ...Object.keys(where.eq ?? {}),
    ...Object.keys(where.in ?? {}),
    ...Object.keys(where.likePrefix ?? {}),
  ]
}

/**
 * True when a dedup query failed because the dataset is not queryable
 * yet (unregistered, or its backing path is absent) rather than because
 * the query itself failed.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isMissingDatasetError(err) {
  if (!err || typeof err !== 'object') return false
  if (/** @type {Record<string, unknown>} */ (err).code === 'ENOENT') return true
  return err instanceof Error && err.message.includes('unknown dataset')
}

/**
 * Per-accumulated-row provenance for props conflict resolution: props key
 * → `first_seen` time of the row that supplied the current value. Kept
 * out-of-band (never serialized) so merged rows stay plain GraphRows.
 *
 * @type {WeakMap<GraphRow, Map<string, number | undefined>>}
 */
const propsProvenance = new WeakMap()

/**
 * Merge a duplicate row into the accumulated one: keep the earliest
 * `first_seen` and union props. On a props key conflict the value from
 * the earliest-seen row wins; equal (or unknown) times fall back to a
 * value comparison so the result is independent of merge order, which
 * matters because the projection's source SELECTs have no stable
 * ordering. Shared with the dedup compaction in maintenance.js so
 * projection-time and compaction-time merges agree.
 *
 * @param {GraphRow} existing
 * @param {GraphRow} incoming
 * @ref LLP 0023#merge-policy [implements]: order-independent merge shared by projection and compaction
 */
export function mergeRow(existing, incoming) {
  const existingTime = firstSeenTime(existing.first_seen)
  const incomingTime = firstSeenTime(incoming.first_seen)
  const ip = incoming.props
  if (ip && typeof ip === 'object') {
    let times = propsProvenance.get(existing)
    if (!times) {
      times = new Map()
      if (existing.props && typeof existing.props === 'object') {
        for (const key of Object.keys(existing.props)) times.set(key, existingTime)
      }
      propsProvenance.set(existing, times)
    }
    /** @type {Record<string, unknown>} */
    const merged = existing.props && typeof existing.props === 'object' ? { ...existing.props } : {}
    for (const [key, value] of Object.entries(ip)) {
      if (!(key in merged) || propsValueWins(incomingTime, value, times.get(key), merged[key])) {
        merged[key] = value
        times.set(key, incomingTime)
      }
    }
    existing.props = merged
  }
  if (incomingTime !== undefined && (existingTime === undefined || incomingTime < existingTime)) {
    existing.first_seen = incoming.first_seen
  }
}

/**
 * Deterministic props conflict policy: the value seen earliest wins; a
 * value with a known time beats one without; equal times tie-break on
 * the JSON encoding so merge order can never influence the result.
 *
 * @param {number | undefined} incomingTime
 * @param {unknown} incomingValue
 * @param {number | undefined} currentTime
 * @param {unknown} currentValue
 * @returns {boolean}
 */
function propsValueWins(incomingTime, incomingValue, currentTime, currentValue) {
  if (incomingTime !== currentTime) {
    if (incomingTime === undefined) return false
    if (currentTime === undefined) return true
    return incomingTime < currentTime
  }
  return stableJson(incomingValue) < stableJson(currentValue)
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stableJson(value) {
  return JSON.stringify(value) ?? 'undefined'
}

/**
 * Epoch millis for a `first_seen` value. Projection-time rows carry ISO
 * strings; rows scanned back from Iceberg carry `Date` objects: both
 * must compare the same way.
 *
 * @param {unknown} value
 * @returns {number | undefined}
 */
export function firstSeenTime(value) {
  if (typeof value === 'string') {
    const t = Date.parse(value)
    return Number.isNaN(t) ? undefined : t
  }
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}
