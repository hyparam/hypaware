// @ts-check

import { createHash } from 'node:crypto'
import path from 'node:path'

import { discoverCachePartitions } from '../../../../src/core/cache/partition.js'
import { isUsagePolicyDrop } from '../../../../src/core/usage-policy/index.js'
import { alignRows, canPushWhere, emptySource, normalizeScanColumn, unionSources, whereColumns } from 'hypaware/core/query'
import { AI_GATEWAY_MESSAGE_COLUMNS, aiGatewayRowsFromProjectedExchange } from './message_projector.js'
import { isPlainObject, stringValue } from 'hypaware/core/util'

/**
 * @import { AiGatewayProjectedExchange, BackfillItem, BackfillMaterializeContext, BackfillMaterializerContribution, CachePartitionMeta, ColumnSpec, DatasetDataSourceContext, DatasetDiscoveryContext, DatasetRefreshResult, DatasetRegistration, DatasetSettleContext, QueryPartition, QueryStorageService, ScannableDataSource } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../../src/core/cache/types.js'
 * @import { GatewayState } from './types.js'
 * @import { AsyncDataSource } from 'squirreling'
 */

const PLUGIN_NAME = '@hypaware/ai-gateway'

/**
 * Materializer dispatch key. Backfill providers (e.g. `@hypaware/claude`,
 * `@hypaware/codex`) yield `BackfillItem`s of this `kind` carrying an
 * `AiGatewayProjectedExchange` as `value`; the `hyp backfill` runner
 * resolves them to this materializer to produce `ai_gateway_messages`
 * rows.
 */
export const AI_GATEWAY_PROJECTED_EXCHANGE_KIND = 'ai_gateway.projected_exchange'

export const DATASET_NAME = 'ai_gateway_messages'
// @ref LLP 0030#breaking: the partition key moved from conversation_id
// to session_id (schema v6). The label bump gives the recreated cache a
// fresh partition path; discoverParts still lists the legacy v4 path so
// any pending v4 spool still flushes.
export const PARTITION_LABEL = 'proxy_messages_v5'
const LEGACY_PARTITION_LABELS = Object.freeze(['proxy_messages_v4'])

/**
 * Column shape for `ai_gateway_messages`. The shape is owned by the
 * AI gateway plugin and versioned through the partition label.
 *
 * @type {ReadonlyArray<ColumnSpec>}
 */
export const AI_GATEWAY_SCHEMA_COLUMNS = AI_GATEWAY_MESSAGE_COLUMNS

/** @type {{ columns: ColumnSpec[] }} */
export const AI_GATEWAY_SCHEMA = { columns: [...AI_GATEWAY_SCHEMA_COLUMNS] }

/**
 * On-disk table path under the kernel-managed cache. The plugin writes
 * through `ctx.storage.appendRows`; the storage service owns durable
 * spool and Iceberg flush details.
 *
 * @param {QueryStorageService} storage
 * @returns {string}
 */
export function aiGatewayTablePath(storage) {
  return storage.cacheTablePath(DATASET_NAME, [PARTITION_LABEL])
}

/**
 * Discover all partitions for `ai_gateway_messages`, including
 * new-style per-client/date partitions and the current/legacy
 * `proxy_messages_v*` spool partitions.  Always includes the current
 * and legacy spool paths so pending data gets flushed during query
 * settlement (the v4 → v5 bump on the session_id partition split means
 * a recreated cache can still carry residual v4 spool).
 *
 * @param {DatasetDiscoveryContext} ctx
 * @returns {Promise<QueryPartition[]>}
 */
export async function discoverParts(ctx) {
  const cacheDir = ctx.cacheDir ?? ''
  if (!cacheDir) return []

  /** @type {QueryPartition[]} */
  const partitions = []
  const seen = new Set()

  for (const label of [PARTITION_LABEL, ...LEGACY_PARTITION_LABELS]) {
    const spoolPath = path.join(cacheDir, 'datasets', DATASET_NAME, label)
    if (seen.has(spoolPath)) continue
    partitions.push({
      dataset: DATASET_NAME,
      partition: { partition: label },
      tablePath: spoolPath,
    })
    seen.add(spoolPath)
  }

  const discovered = await discoverCachePartitions(cacheDir, buildDiscoveryScope(ctx.scope))
  for (const p of discovered) {
    if (seen.has(p.path)) continue
    seen.add(p.path)
    partitions.push({
      dataset: DATASET_NAME,
      partition: p.partition,
      tablePath: p.path,
    })
  }

  return partitions
}

/**
 * Live-ingest refresh path. Rows are written through the kernel cache
 * service from the gateway recorder, so there is no external source
 * file to refresh here.
 *
 * @returns {Promise<DatasetRefreshResult>}
 */
export async function refreshPartition() {
  return { status: 'skipped', rows: 0 }
}

/**
 * Build a squirreling-compatible AsyncDataSource over all discovered
 * partitions.  Unions data from legacy and new-style partitions so
 * queries see a seamless view across the transition.
 *
 * @param {QueryPartition[]} partitions
 * @param {DatasetDataSourceContext} ctx
 * @returns {Promise<ScannableDataSource>}
 */
export async function createDataSource(partitions, ctx) {
  const storage = /** @type {ExtendedQueryStorageService} */ (ctx.storage)

  // Re-discover partitions to pick up any newly flushed data that
  // wasn't visible during the initial discoverParts call.
  const freshPartitions = await discoverCachePartitions(storage.cacheRoot, buildDiscoveryScope(ctx.scope))

  /** @type {Set<string>} */
  const tablePaths = new Set()
  for (const p of partitions) {
    if (p.tablePath) tablePaths.add(p.tablePath)
  }
  for (const p of freshPartitions) {
    tablePaths.add(p.path)
  }

  /** @type {ScannableDataSource[]} */
  const sources = []
  for (const tablePath of tablePaths) {
    const source = await storage.dataSourceForTable(tablePath)
    // Skip only sources KNOWN empty. icebird omits numRows when the current
    // snapshot carries position deletes (a live count would need a scan), so
    // treating undefined as 0 here silently dropped every partition touched
    // by hyp purge and blinded all queries to its surviving rows.
    // @ref LLP 0104 [constrained-by]: purge deletes rows via position deletes; an unknowable count must not read as an empty partition
    if (source && source.numRows !== 0) sources.push(source)
  }

  if (sources.length === 0) return emptySource(SCHEMA_COLUMN_NAMES)
  if (sources.length === 1) return withSchemaColumns(sources[0])
  return withSchemaColumns(unionSources(sources))
}

const SCHEMA_COLUMN_NAMES = AI_GATEWAY_SCHEMA_COLUMNS.map((c) => c.name)

/**
 * Expose the dataset's DECLARED schema columns on a data source even when the
 * underlying parquet partitions physically lack some of them (the normal state
 * after an additive schema bump), when older partitions predate a new column
 * (e.g. `git_remote`/`head_sha`/`repo_root` in v7, LLP 0032). Squirreling's
 * `validateScan` rejects a SELECT that names a column absent from the source's
 * `columns`, so without this a contract or query that reads a freshly-added
 * column would throw `ColumnNotFoundError` over any pre-bump partition. The scan
 * itself is unchanged: a column an old partition physically lacks stays
 * addressable, and the exact value a read of it yields depends on the read path
 * (LLP 0015#multi-partition-union).
 *
 * @ref LLP 0032#capture [implements]: additive columns stay queryable over old partitions; no partition-label bump / cache wipe needed
 * @param {ScannableDataSource} source
 * @returns {ScannableDataSource}
 */
function withSchemaColumns(source) {
  const columns = Array.from(new Set([...source.columns, ...SCHEMA_COLUMN_NAMES]))
  /** @type {ScannableDataSource} */
  const wrapped = {
    columns,
    numRows: source.numRows,
    scan(options) {
      // The engine names this scan's output columns from the list advertised
      // here, but fills them from each row's own `columns`. A partition that
      // predates a declared column yields a SHORTER row, which slides every
      // output name past the gap onto its neighbour's value: over a drifted
      // union `SELECT *, git_remote` answered with git_remote's value under
      // the name of the column that happened to follow the star's short
      // width. Pad each row back out to the advertised list.
      // @ref LLP 0241#alignment [implements]: a declared-but-absent column becomes a padded cell, not a missing slot the star can slide through
      const scanColumns = options?.columns ?? columns
      const result = source.scan(options)
      return {
        appliedWhere: result.appliedWhere,
        appliedLimitOffset: result.appliedLimitOffset,
        rows: () => alignRows(result.rows(), scanColumns),
      }
    },
  }
  // Forward the column-stream hook so single-column aggregates stay on the
  // engine's streaming fast path. A partition that physically lacks the
  // requested column (the additive schema-drift case this wrapper exists
  // for) surfaces its values as `undefined` holes in the chunk; normalize
  // them to null so every partition's chunk reads the same way and an
  // accumulator sees one representation across the merged stream. This is
  // NOT the value the row path reads: `scan` above pads an absent cell with
  // `undefined` (LLP 0241 §alignment), and 0241 deliberately left the
  // null/undefined split between the two paths unsettled, so nothing may
  // branch on which one it got.
  //
  // A `where` naming a DECLARED-but-physically-absent column can't be
  // handed to the source: this wrapper is the only layer that knows the
  // column exists at all, and a parquet-backed source throws on a filter
  // column it can't find. Strip the predicate (and the limit/offset that
  // are only meaningful after it) and report `appliedWhere: false`; the
  // engine then filters over the null-normalized values, where IS NULL
  // and friends read the absent column correctly.
  // @ref LLP 0055 [implements]: withSchemaColumns forwards scanColumn; a partition lacking the column yields nulls, never throws
  // @ref LLP 0098#wrapper-duties [implements]: a predicate naming a declared-but-absent column is stripped before it can reach a parquet filter
  if (typeof source.scanColumn === 'function') {
    const scanColumn = /** @type {NonNullable<AsyncDataSource['scanColumn']>} */ (source.scanColumn)
    wrapped.scanColumn = (options) => {
      const pushable = !options.where || canPushWhere(source, whereColumns(options.where))
      const subOptions = pushable ? options : { column: options.column, signal: options.signal }
      const inner = normalizeScanColumn(scanColumn(subOptions), subOptions)
      return {
        appliedWhere: pushable && inner.appliedWhere,
        appliedLimitOffset: pushable && inner.appliedLimitOffset,
        async *chunks() {
          for await (const chunk of inner.chunks()) {
            for (let i = 0; i < chunk.length; i++) {
              if (chunk[i] === undefined) /** @type {unknown[]} */ (chunk)[i] = null
            }
            yield chunk
          }
        },
      }
    }
  }
  // Native batches are transparent only when the physical prepared schema
  // already covers the full declared schema. A drifted source stays on the
  // row/column paths above, which own its absent-column semantics.
  // @ref LLP 0294#schema-drift [implements]: prepared batches never invent a value for a declared-but-absent field
  if (source.schema && source.prepareScan) {
    const prepareScan = source.prepareScan
    const fieldsByName = new Map(source.schema.fields.map((field) => [field.name, field]))
    if (columns.every((column) => fieldsByName.has(column))) {
      wrapped.schema = {
        fields: columns.map((column) => /** @type {NonNullable<ReturnType<typeof fieldsByName.get>>} */ (fieldsByName.get(column))),
      }
      wrapped.prepareScan = (request) => prepareScan.call(source, request)
    }
  }
  return wrapped
}

/**
 * @param {DatasetDiscoveryContext['scope'] | DatasetDataSourceContext['scope'] | undefined} scope
 */
function buildDiscoveryScope(scope) {
  return {
    datasets: [DATASET_NAME],
    ...(scope?.date ? { date: scope.date } : {}),
    ...(scope?.dates ? { dates: scope.dates } : {}),
    ...(scope?.from ? { from: scope.from } : {}),
    ...(scope?.to ? { to: scope.to } : {}),
  }
}

/**
 * The DatasetRegistration passed to `ctx.query.registerDataset` from
 * activate(). Takes the gateway state so `settleBatch` can dispatch to
 * registered settlement enrichers by `client_name`.
 *
 * @param {GatewayState} [state]
 * @returns {DatasetRegistration}
 */
export function aiGatewayDatasetRegistration(state) {
  return {
    name: DATASET_NAME,
    plugin: PLUGIN_NAME,
    schema: AI_GATEWAY_SCHEMA,
    // Forward under the `proxy` ingest signal: the central server maps
    // `proxy` -> ai_gateway_messages. Without this the central forward
    // sink falls back to the dataset name, which is not a known signal,
    // and AI-gateway rows never leave the gateway.
    sourceSignal: 'proxy',
    primaryTimestampColumn: 'message_created_at',
    cachePartitioning: {
      source: {
        columns: ['client_name', 'conversation_source', 'provider'],
        fallback: 'unknown',
      },
      iceberg: {
        // @ref LLP 0311#date-partition [implements]: the cache partitions on
        // date alone; the identity columns are sortOnly lookup columns, so
        // the table sorts by them without the one-file-per-session floor.
        // @ref LLP 0022#within-partition-sort: these identity fields, in
        // declared order, still seed the export sort order (sortOnly does
        // not affect the export), so session_id leads the clustering and
        // conversation_id rides along as a secondary thread-lookup sort key.
        fields: [
          { column: 'session_id', transform: 'identity', required: true, sortOnly: true },
          { column: 'conversation_id', transform: 'identity', sortOnly: true },
          { column: 'cwd', transform: 'identity', sortOnly: true },
          { column: 'date', transform: 'identity', required: true },
        ],
      },
    },
    discoverPartitions: discoverParts,
    refreshPartition,
    createDataSource,
    settleBatch: createSettleBatch(state),
    resettleBatch: createResettleBatch(state),
  }
}

/**
 * Build the flush-time settlement pass (LLP 0024). On each flush batch:
 *
 *  1. Short-circuit when the batch carries no fallback rows AND no null-cwd
 *     rows - the common case, so the hot path does zero transcript or storage
 *     I/O. (A null-cwd row is the #258 session-start race, handled by 2/LLP 0085.)
 *  2. Group selected rows by `client_name` and hand each group to the
 *     enricher registered for that client; the enricher upgrades the rows it
 *     can match against its native log (re-stamping
 *     `message_id`/`part_id`/native identity, clearing `identity_source`),
 *     re-resolves a null-cwd row's `cwd` from the now-present session context
 *     (filling it, or marking the row for removal when it resolves to a
 *     `.hypignore` `ignore`, LLP 0085), and returns the rest unchanged.
 *  3. Dedupe the whole batch by `part_id` against already-committed
 *     partitions and within-batch, so an upgraded row collapses onto the
 *     uuid twin a later replay already wrote. The committed row wins (the
 *     flush path has no row-delete; dropping the in-flight duplicate is
 *     the only achievable collapse).
 *
 * @param {GatewayState | undefined} state
 * @returns {(rows: Record<string, unknown>[], ctx: DatasetSettleContext) => Promise<Record<string, unknown>[]>}
 */
function createSettleBatch(state) {
  return async function settleBatch(rows, ctx) {
    if (!Array.isArray(rows) || rows.length === 0) return rows
    const hasFallback = rows.some(isFallbackRow)
    // @ref LLP 0085 [implements]: a null-cwd row (the #258 session-start race)
    // gets a second look at flush even when it is NOT a gateway fallback (its
    // transcript identity landed but the session-context record raced), so the
    // settle pass must select it too.
    const hasNullCwd = rows.some(rowHasNullCwd)
    if (!hasFallback && !hasNullCwd) return rows
    // @ref LLP 0085 [implements]: the settle pass may now REMOVE a row (a
    // late-resolved `.hypignore` ignore), not only upgrade its identity - the
    // filtered batch is what gets committed, so the dropped row never reaches a
    // durable partition or a sink.
    const settled = await upgradeFallbackRows(rows, state, ctx, {
      select: settleSelect,
      allowDrop: true,
    })
    // Dedupe only matters for a fallback->native upgrade that can twin a
    // committed uuid row; a pure cwd-enrich/drop pass creates no new twins, so
    // preserve the original dedupe trigger and leave non-fallback batches
    // byte-for-byte as before.
    return hasFallback ? dedupeByPartId(settled, ctx) : settled
  }
}

/** @param {Record<string, unknown>} row */
function settleSelect(row) {
  return isFallbackRow(row) || rowHasNullCwd(row)
}

/**
 * True when a row carries no usable `cwd` - the session-start race shape the
 * settlement backstop re-resolves at flush (issue #258 / LLP 0085).
 *
 * @param {Record<string, unknown>} row
 */
function rowHasNullCwd(row) {
  const cwd = row?.cwd
  return cwd === undefined || cwd === null || cwd === ''
}

/**
 * Build the maintenance re-settle pass (LLP 0027 "Re-settle sweep"). This
 * is the flush-time settle WITHOUT the committed-`part_id` dedupe: in the
 * sweep the rows handed in are ALREADY committed, so a committed-scan
 * dedupe would match a non-upgraded fallback against its own committed
 * copy and wrongly drop it. The maintenance rewrite owns the de-twin
 * instead, it has both committed twins of the partition in hand and
 * collapses an upgraded fallback against the native twin within the
 * rewrite set. So this pass upgrades fallback rows to native identity and
 * returns them; it never drops a row.
 *
 * @param {GatewayState | undefined} state
 * @returns {(rows: Record<string, unknown>[], ctx: DatasetSettleContext) => Promise<Record<string, unknown>[]>}
 */
function createResettleBatch(state) {
  return async function resettleBatch(rows, ctx) {
    if (!Array.isArray(rows) || rows.length === 0) return rows
    if (!rows.some(isFallbackRow)) return rows
    return upgradeFallbackRows(rows, state, ctx)
  }
}

/**
 * Dispatch selected rows to the registered settlement enricher for their
 * `client_name` and return the batch with matched rows upgraded to native
 * identity (and, when `allowDrop` is set, with rows the enricher marks for
 * removal filtered out). Rows the enricher cannot settle, and unselected rows,
 * are returned unchanged. An enricher failure never drops a row.
 *
 * `select` chooses which rows reach the enricher (default: `gateway_fallback`
 * rows only, the identity-upgrade case). `allowDrop` governs whether a
 * `USAGE_POLICY_DROP` sentinel in the enricher's output removes the row: the
 * flush-time `settleBatch` sets it (LLP 0085); the maintenance `resettleBatch`
 * does NOT, so a compaction re-settle never purges an already-committed row.
 *
 * @param {Record<string, unknown>[]} rows
 * @param {GatewayState | undefined} state
 * @param {DatasetSettleContext} ctx
 * @param {{ select?: (row: Record<string, unknown>) => boolean, allowDrop?: boolean }} [opts]
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function upgradeFallbackRows(rows, state, ctx, opts = {}) {
  const select = opts.select ?? isFallbackRow
  const allowDrop = opts.allowDrop === true
  const enrichers = state?.enrichers
  if (!enrichers || enrichers.size === 0) return rows

  /** @type {Map<string, Record<string, unknown>[]>} */
  const byClient = new Map()
  for (const row of rows) {
    if (!select(row)) continue
    const client = stringValue(row.client_name)
    const enricher = client ? enrichers.get(client) : undefined
    if (!enricher) continue
    const list = byClient.get(client ?? '')
    if (list) list.push(row)
    else byClient.set(client ?? '', [row])
  }
  if (byClient.size === 0) return rows

  /** @type {Map<Record<string, unknown>, Record<string, unknown>>} */
  const upgrades = new Map()
  /** @type {Set<Record<string, unknown>>} */
  const drops = new Set()
  for (const [client, group] of byClient) {
    const enricher = enrichers.get(client)
    if (!enricher) continue
    try {
      const out = await enricher.settle(group, ctx)
      for (let i = 0; i < group.length && i < out.length; i++) {
        const result = out[i]
        // @ref LLP 0085 [implements]: the enricher marks a late-resolved
        // `ignore` row for removal with the USAGE_POLICY_DROP sentinel at its
        // position; the flush path honors it, the compaction re-settle ignores
        // it (allowDrop=false) so a committed row is never purged.
        if (isUsagePolicyDrop(result)) {
          if (allowDrop) drops.add(group[i])
          continue
        }
        if (result && result !== group[i]) upgrades.set(group[i], result)
      }
    } catch {
      // An enricher failure must never drop rows: leave the group as
      // provisional fallback; a later flush or sweep can retry.
      continue
    }
  }
  if (upgrades.size === 0 && drops.size === 0) return rows
  /** @type {Record<string, unknown>[]} */
  const next = []
  for (const row of rows) {
    if (drops.has(row)) continue
    next.push(upgrades.get(row) ?? row)
  }
  return next
}

/**
 * Drop rows whose `part_id` already exists in a committed partition or
 * earlier in this same batch. Mirrors the backfill materializer's
 * pre-write dedupe (committed scan + per-call fold-in), so an upgraded
 * fallback row collapses onto the canonical committed uuid row.
 *
 * Scans ONLY committed partitions (deliberately NOT the spool). The rows
 * passed here are the batch being flushed out of the spool, so seeding
 * the seen-set with spool `part_id`s would make every row match itself
 * and be dropped (see scanSpooledPartIds's hazard note). That spool scan
 * belongs to backfill alone.
 *
 * The committed scan is restricted to the `part_id`s present in THIS
 * batch: the flush only needs membership answers for the rows in hand,
 * and the unrestricted variant materialized every part_id ever written
 * (millions of entries, hundreds of MB) on every fallback-carrying
 * flush tick, a main driver of daemon GC thrash (LLP 0204#fix).
 *
 * @param {Record<string, unknown>[]} rows
 * @param {DatasetSettleContext} ctx
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function dedupeByPartId(rows, ctx) {
  const storage = ctx?.storage
  if (rows.length === 0 || !canScanExistingRows(storage)) return rows
  /** @type {Set<string>} */
  const batchKeys = new Set()
  for (const row of rows) {
    const key = partIdKey(row)
    if (key !== undefined) batchKeys.add(key)
  }
  const seen = await scanExistingPartIds(storage, batchKeys, batchSessionIds(rows))
  /** @type {Record<string, unknown>[]} */
  const fresh = []
  for (const row of rows) {
    const key = partIdKey(row)
    if (key === undefined) { fresh.push(row); continue }
    if (seen.has(key)) continue
    seen.add(key)
    fresh.push(row)
  }
  return fresh
}

/**
 * Pre-write `part_id` dedupe for a LIVE producer that is not the proxy
 * recorder: the OTEL telemetry listener of `@hypaware/claude`. Same
 * membership question the backfill materializer asks, with the same two
 * seeds (committed partitions plus the spool), but restricted to the
 * keys of the batch in hand so a per-exchange call stays O(batch).
 *
 * Folding the spool in is safe here and required: the rows being tested
 * have NOT been spooled yet, so a spool hit means another producer
 * (the proxy, or a backfill run) already wrote this part. That is the
 * whole overlap story of the migration window. The hazard note on
 * `scanSpooledPartIds` applies to the FLUSH path only, which passes
 * rows that are themselves the spool.
 *
 * Best-effort with respect to storage, like every other dedupe here: a
 * stub without the read surface lets every row through.
 *
 * @ref LLP 0252#projection-unchanged [implements]: a third producer writes the
 *   same dataset and its overlap with the proxy and backfill producers collapses
 *   on `part_id` before the write, not after
 * @param {Record<string, unknown>[]} rows
 * @param {QueryStorageService | undefined} storage
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function dedupeStoredPartIds(rows, storage) {
  if (rows.length === 0 || !canScanExistingRows(storage)) return rows
  /** @type {Set<string>} */
  const batchKeys = new Set()
  for (const row of rows) {
    const key = partIdKey(row)
    if (key !== undefined) batchKeys.add(key)
  }
  const seen = await scanExistingPartIds(storage, batchKeys, batchSessionIds(rows))
  await scanSpooledPartIds(storage, seen, batchKeys)
  /** @type {Record<string, unknown>[]} */
  const fresh = []
  for (const row of rows) {
    const key = partIdKey(row)
    if (key === undefined) { fresh.push(row); continue }
    if (seen.has(key)) continue
    seen.add(key)
    fresh.push(row)
  }
  return fresh
}

/**
 * Return every session scope represented by a batch. If a malformed or legacy
 * row lacks its required session id, disable targeting and preserve the
 * original full scan.
 *
 * @param {Record<string, unknown>[]} rows
 * @returns {string[] | undefined}
 */
function batchSessionIds(rows) {
  const ids = new Set()
  for (const row of rows) {
    const sessionId = row.session_id
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    ids.add(sessionId)
  }
  return [...ids]
}

/** @param {Record<string, unknown>} row */
function isFallbackRow(row) {
  const attrs = row?.attributes
  const parsed = typeof attrs === 'string' ? safeParseJson(attrs) : attrs
  if (!isPlainObject(parsed)) return false
  const gateway = parsed.gateway
  return isPlainObject(gateway) && gateway.identity_source === 'gateway_fallback'
}

/** @param {string} value */
function safeParseJson(value) {
  try { return JSON.parse(value) } catch { return undefined }
}

/**
 * Backfill materializer for `ai_gateway.projected_exchange`. Registered
 * via `ctx.backfillMaterializers.register(...)` at plugin activation.
 *
 * Backfill providers yield a whole conversation as a single
 * `AiGatewayProjectedExchange` payload; this converts it into canonical
 * `ai_gateway_messages` rows through `aiGatewayRowsFromProjectedExchange`
 * (the exact expansion the live gateway recorder uses) so backfilled
 * and live-captured rows are byte-identical for the same projection.
 * Row expansion is pure with respect to `item.value`: it allocates a
 * fresh conversation state per call, so reruns and out-of-order items
 * produce identical row identity (`part_id = <message_id>#<part_index>`).
 *
 * On top of that pure expansion the materializer applies a narrow
 * PRE-WRITE dedupe: before a batch is handed back to the runner for
 * `appendRows`, any row whose `part_id` already exists in the dataset is
 * skipped. This is the PRIMARY rerun guarantee: rerunning a backfill
 * re-materializes byte-identical rows, and without this guard each rerun
 * would re-append them and lean on cache-maintenance compaction to
 * collapse the duplicates later. Compaction's content-hash dedupe
 * (`_hyp_cache_row_id`) stays a backup layer, not the thing correctness
 * depends on. The dedupe is best-effort with respect to storage: when
 * `ctx.storage` does not expose the partition-read surface (a bare test
 * stub), every materialized row passes through unchanged.
 *
 * @returns {BackfillMaterializerContribution}
 */
export function aiGatewayBackfillMaterializer() {
  // The materializer instance is created once at plugin activation and reused
  // for every invocation. The dedupe state is isolated by the runner's opaque
  // run token and becomes collectible with that token.
  const dedupe = createBackfillDedupe()
  return {
    kind: AI_GATEWAY_PROJECTED_EXCHANGE_KIND,
    dataset: DATASET_NAME,
    plugin: PLUGIN_NAME,
    /**
     * @param {BackfillItem} item
     * @param {BackfillMaterializeContext} [ctx]
     * @returns {Promise<Record<string, unknown>[]>}
     */
    async materialize(item, ctx) {
      const projection = asProjectedExchange(item.value)
      if (!projection) return []
      const rows = aiGatewayRowsFromProjectedExchange(projection, {
        gatewayAttributes: backfillGatewayAttributes(item),
      })
      return dedupe.skipExisting(rows, ctx)
    },
  }
}

/**
 * Build the per-run pre-write dedupe used by the backfill materializer.
 *
 * Every item probes committed and spooled storage only for its own candidate
 * part ids and session ids. Emitted keys are also folded into an in-run set so
 * a re-yielded item is skipped before it reaches the writer. That set is keyed
 * by the runner's opaque token in a WeakMap, not by a process-wide current run
 * id, so concurrent callers cannot replace each other and completed runs are
 * not retained.
 *
 * The seen-set is seeded from two sources: the committed (flushed)
 * Iceberg partitions AND the rows still pending in the spool (captured
 * live but not yet flushed, issue #107). Without the spool scan, backfill
 * re-materializes its own copy of an unflushed live row and the spool
 * later flushes its copy, leaving two rows with the same `part_id`. The
 * spool scan is BACKFILL-ONLY (see scanSpooledPartIds); the flush-time
 * settle path must never fold spool rows into its seen-set.
 *
 * @returns {{ skipExisting(rows: Record<string, unknown>[], ctx: BackfillMaterializeContext | undefined): Promise<Record<string, unknown>[]> }}
 */
function createBackfillDedupe() {
  /** @type {WeakMap<object, Set<string>>} */
  const seenByRun = new WeakMap()
  // Compatibility for direct/older callers that do not supply a token. Keep
  // only the current diagnostic run so this path cannot retain historical
  // candidate sets. Production runners always take the WeakMap path.
  /** @type {{ runId: string, seen: Set<string> } | undefined} */
  let legacyMemo

  return {
    async skipExisting(rows, ctx) {
      const storage = ctx?.storage
      // Feature-detect the committed-partition read surface. A bare
      // storage stub (unit tests that only assert row shape) has neither
      // method, so dedupe is skipped and every row passes through.
      if (rows.length === 0 || !canScanExistingRows(storage)) return rows

      const batchKeys = partIdKeys(rows)
      const stored = await scanExistingPartIds(storage, batchKeys, batchSessionIds(rows))
      // Fold in only candidate ids pending in the spool. A full spool scan may
      // still be required by the storage surface, but unrelated ids never
      // inflate the materializer's heap.
      await scanSpooledPartIds(storage, stored, batchKeys)
      const runState = runSeen(ctx, seenByRun, legacyMemo)
      legacyMemo = runState.legacyMemo
      const seen = runState.seen

      /** @type {Record<string, unknown>[]} */
      const fresh = []
      for (const row of rows) {
        const key = partIdKey(row)
        if (key === undefined) {
          // No usable identity to dedupe on: never drop the row.
          fresh.push(row)
          continue
        }
        if (stored.has(key) || seen.has(key)) continue
        seen.add(key)
        fresh.push(row)
      }
      return fresh
    },
  }
}

/**
 * @param {Record<string, unknown>[]} rows
 * @returns {Set<string>}
 */
function partIdKeys(rows) {
  const keys = new Set()
  for (const row of rows) {
    const key = partIdKey(row)
    if (key !== undefined) keys.add(key)
  }
  return keys
}

/**
 * @param {BackfillMaterializeContext | undefined} ctx
 * @param {WeakMap<object, Set<string>>} seenByRun
 * @param {{ runId: string, seen: Set<string> } | undefined} legacyMemo
 * @returns {{ seen: Set<string>, legacyMemo: { runId: string, seen: Set<string> } | undefined }}
 */
function runSeen(ctx, seenByRun, legacyMemo) {
  if (ctx?.runToken) {
    let seen = seenByRun.get(ctx.runToken)
    if (!seen) {
      seen = new Set()
      seenByRun.set(ctx.runToken, seen)
    }
    return { seen, legacyMemo }
  }
  const runId = ctx?.devRunId ?? 'legacy'
  if (!legacyMemo || legacyMemo.runId !== runId) legacyMemo = { runId, seen: new Set() }
  return { seen: legacyMemo.seen, legacyMemo }
}

/**
 * @param {QueryStorageService | undefined} storage
 * @returns {storage is QueryStorageService}
 */
function canScanExistingRows(storage) {
  return !!storage &&
    typeof storage.discoverCachePartitions === 'function' &&
    typeof storage.readRows === 'function'
}

/**
 * Widest session list the scoped committed read is allowed to carry. Past it
 * the scan reverts to the unrestricted full read.
 *
 * A scoped read is not an index probe. Iceberg prunes a file or row group on
 * an `IN` list only when EVERY listed value falls outside the chunk
 * `session_id` bounds, so each value added is another chance to keep the
 * chunk and pruning decays toward nothing as the list widens. Every row that
 * survives is then matched by hyparquet walking the whole value list. So the
 * scoped read costs O(rows scanned x sessions) where the full read costs
 * O(rows scanned), and past a crossover it is slower than the scan it exists
 * to avoid, by an unbounded factor rather than a bounded one. Measured against
 * a 200k-row committed partition: 0.93x the full read at 200 sessions, 1.9x
 * at 500, 5.4x at 1,000, 13.8x at 4,000, crossing over near 220.
 *
 * The cap sits under that measured crossover, but the number it caps is the
 * linear term, not the crossover: the shape is O(sessions) on every layout,
 * while where it crosses 1x moves with file count, row width, and how tight
 * the per-file `session_id` bounds are. So the guarantee the cap buys is
 * bounded cost, not a specific multiple. On a layout whose crossover sits
 * below the cap, a batch at the cap costs a small multiple of the full read
 * instead of slightly less than it, and above the cap it IS the full read.
 * Read the numbers as calibration, not as a portable constant.
 *
 * Choosing the full read is always safe: it answers the same membership
 * question over a superset of the rows, so its seen-set is a superset of the
 * scoped one and it can only find MORE committed twins, never fewer. It
 * cannot miss a duplicate the scoped read would have caught, and it is the
 * shape this scan already takes for a batch with no usable session ids.
 *
 * @ref LLP 0311#context [constrained-by]: bounds on the leading `session_id`
 * sort key prune a session lookup, which is a claim about ONE narrow lookup;
 * a batch-wide list of them is not one.
 */
const MAX_SCOPED_SESSION_IDS = 200

/**
 * Scan committed `ai_gateway_messages` partitions and collect the set of
 * `part_id`s already present. Reads are projected to the three identity
 * columns so the scan stays cheap, and every failure mode (unreadable
 * partition, missing table) degrades to "not seen" rather than aborting
 * the caller (a dedupe miss only risks a duplicate that compaction will
 * later collapse, whereas throwing would drop real rows).
 *
 * `restrictTo` bounds the result: only keys in that set are collected,
 * and the scan stops early once all of them have been found. The
 * flush-time settle passes its batch keys here so a steady-state flush
 * holds O(batch) memory. Backfill now passes the same candidate restriction;
 * its in-run emitted-id set is separate and never needs the full committed
 * identity set (LLP 0359).
 *
 * `sessionIds` scopes hot-path reads to the batch's exact sessions. The cache
 * is sorted by `session_id`, so Iceberg can prune unrelated files while the
 * lookup still searches every date that may contain that session. A partition
 * that cannot answer the scoped read (a schema with no `session_id` column)
 * degrades to the full read rather than being skipped: skipping it would
 * report a committed row as fresh and write a duplicate. A list wider than
 * `MAX_SCOPED_SESSION_IDS` degrades the same way, for cost rather than
 * capability.
 *
 * @param {QueryStorageService} storage
 * @param {ReadonlySet<string>} [restrictTo]
 * @param {string[]} [sessionIds]
 * @returns {Promise<Set<string>>}
 */
async function scanExistingPartIds(storage, restrictTo, sessionIds) {
  /** @type {Set<string>} */
  const seen = new Set()
  if (restrictTo && restrictTo.size === 0) return seen
  /** @type {CachePartitionMeta[]} */
  let partitions = []
  try {
    partitions = await storage.discoverCachePartitions({ datasets: [DATASET_NAME] })
  } catch {
    return seen
  }
  const targeted = !!sessionIds && sessionIds.length <= MAX_SCOPED_SESSION_IDS &&
    typeof storage.readRowsWhere === 'function'
  for (const part of partitions ?? []) {
    const tablePath = part?.path
    if (!tablePath || (typeof part.rowCount === 'number' && part.rowCount === 0)) continue
    try {
      if (await collectPartIds(storage, tablePath, targeted ? sessionIds : undefined, seen, restrictTo)) {
        return seen
      }
    } catch {
      // A TARGETED read can fail where the unrestricted one succeeds: the
      // predicate names `session_id`, and a partition whose schema predates
      // that column (LLP 0030 bumped the label to `proxy_messages_v5`, but a
      // cache upgraded rather than recreated still carries the older table)
      // rejects it outright. Skipping the partition would answer "not
      // committed" for a row that IS committed, and the caller writes a
      // duplicate on that answer, so degrade to the full read before giving up
      // on the partition.
      if (targeted) {
        try {
          if (await collectPartIds(storage, tablePath, undefined, seen, restrictTo)) return seen
        } catch {
          // Genuinely unreadable; other partitions still contribute.
        }
      }
      continue
    }
  }
  return seen
}

/**
 * Fold one partition's `part_id`s into `seen`, honouring `restrictTo`.
 * Returns true once every restricted key has been found, so the caller can
 * stop opening partitions. Re-running it over a partition is harmless (`seen`
 * is a set), which is what lets the caller retry a failed targeted read as an
 * unrestricted one.
 *
 * @param {QueryStorageService} storage
 * @param {string} tablePath
 * @param {string[] | undefined} sessionIds
 * @param {Set<string>} seen
 * @param {ReadonlySet<string>} [restrictTo]
 * @returns {Promise<boolean>}
 */
async function collectPartIds(storage, tablePath, sessionIds, seen, restrictTo) {
  // @ref LLP 0311#context [implements]: session_id leads the table sort,
  // so a session-scoped read prunes cold files while searching every date
  const rows = sessionIds && typeof storage.readRowsWhere === 'function'
    ? storage.readRowsWhere(
        tablePath,
        ['part_id', 'message_id', 'part_index'],
        { session_id: sessionIds },
      )
    : storage.readRows(tablePath, ['part_id', 'message_id', 'part_index'])
  for await (const row of rows) {
    const key = partIdKey(row)
    if (key === undefined) continue
    if (restrictTo) {
      if (!restrictTo.has(key)) continue
      seen.add(key)
      if (seen.size >= restrictTo.size) return true
    } else {
      seen.add(key)
    }
  }
  return false
}

/**
 * Fold the `part_id`s of rows still pending in the spool into `seen`.
 * These are rows captured live but not yet flushed to a committed
 * partition, so `scanExistingPartIds` cannot see them. Folding them in
 * lets `hyp backfill` skip re-materializing a row whose live copy is
 * about to flush (the fix for issue #107).
 *
 * CRITICAL HAZARD: BACKFILL ONLY. This must never be wired into the
 * flush-time settle path (`createSettleBatch` -> `dedupeByPartId`). At
 * flush, the rows being settled ARE the spool rows; if the settle
 * seen-set contained spool `part_id`s, every row would match itself and
 * be dropped (the flush would delete the data it is committing). So the
 * spool scan stays opt-in and is invoked only from `createBackfillDedupe`.
 *
 * Best-effort like the committed scan: a storage stub without the spool
 * read surface, or any read error, leaves `seen` untouched (a dedupe
 * miss only risks a duplicate compaction can later collapse, whereas
 * throwing would abort the backfill).
 *
 * @ref LLP 0027#open-questions [implements]: resolves the documented
 *   "backfill-vs-spool same-id duplicates" residue by scanning spooled
 *   rows in the materializer (not the settle path).
 *
 * `restrictTo`, when supplied, keeps only the keys of the batch in hand.
 * Backfill supplies it too, so even though the storage surface streams the
 * spool, unrelated identities do not accumulate in the materializer heap.
 *
 * @param {QueryStorageService} storage
 * @param {Set<string>} seen
 * @param {ReadonlySet<string>} [restrictTo]
 * @returns {Promise<void>}
 */
async function scanSpooledPartIds(storage, seen, restrictTo) {
  if (!canScanSpooledRows(storage)) return
  if (restrictTo && restrictTo.size === 0) return
  try {
    for await (const row of storage.readSpooledRows(DATASET_NAME, ['part_id', 'message_id', 'part_index'])) {
      const key = partIdKey(row)
      if (key === undefined) continue
      if (restrictTo && !restrictTo.has(key)) continue
      seen.add(key)
    }
  } catch {
    // Spool unreadable mid-scan: keep whatever we folded in already.
  }
}

/**
 * @param {QueryStorageService | undefined} storage
 * @returns {storage is ExtendedQueryStorageService}
 */
function canScanSpooledRows(storage) {
  return !!storage && typeof (/** @type {any} */ (storage).readSpooledRows) === 'function'
}

/**
 * Resolve a row's dedupe key. Prefers the deterministic `part_id` the
 * row expansion stamps (`<message_id>#<part_index>`); for transitional
 * fixtures that predate `part_id` it falls back to recomposing that same
 * key from `message_id` + `part_index`, so a backfilled row and a row
 * read back from storage compare equal regardless of which path filled
 * `part_id`. Returns `undefined` when neither identity is available.
 *
 * @param {Record<string, unknown>} row
 * @returns {string | undefined}
 */
function partIdKey(row) {
  const partId = row.part_id
  if (typeof partId === 'string' && partId.length > 0) return partId
  const messageId = row.message_id
  const partIndex = row.part_index
  if (
    typeof messageId === 'string' &&
    messageId.length > 0 &&
    (typeof partIndex === 'number' || typeof partIndex === 'bigint')
  ) {
    return `${messageId}#${partIndex}`
  }
  return undefined
}

/**
 * Narrow a `BackfillItem.value` to an `AiGatewayProjectedExchange`. The
 * runner already validated the envelope shape; this guards the
 * payload's minimal contract (`provider`, `session_id`, and a
 * `messages` array) so a malformed provider record yields zero rows
 * instead of throwing mid-run. `session_id` is the non-null partition
 * key; `conversation_id` is nullable (null for Claude). @ref LLP 0030
 *
 * @param {unknown} value
 * @returns {AiGatewayProjectedExchange | undefined}
 */
function asProjectedExchange(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const v = /** @type {Record<string, unknown>} */ (value)
  if (typeof v.provider !== 'string' || v.provider.length === 0) return undefined
  if (typeof v.session_id !== 'string' || v.session_id.length === 0) return undefined
  if (!Array.isArray(v.messages)) return undefined
  return /** @type {AiGatewayProjectedExchange} */ (value)
}

/**
 * Build the `gateway`-namespaced attributes stamped onto every
 * backfilled row. Marks the row's origin (`source: 'backfill'`) and
 * carries hashed/opaque provenance hints so imports stay attributable
 * without recording raw local file paths in the canonical row.
 *
 * @param {BackfillItem} item
 * @returns {Record<string, unknown>}
 */
function backfillGatewayAttributes(item) {
  /** @type {Record<string, unknown>} */
  const gateway = { source: 'backfill' }
  const provenance = item.provenance
  if (provenance?.source_path) gateway.source_path_hash = shortHash(provenance.source_path)
  if (provenance?.native_id) gateway.native_id = provenance.native_id
  return { gateway }
}

/** @param {string} input */
function shortHash(input) {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}
