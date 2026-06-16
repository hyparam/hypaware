// @ts-check

import { createHash } from 'node:crypto'
import path from 'node:path'

import { discoverCachePartitions } from '../../../../src/core/cache/partition.js'
import { AI_GATEWAY_MESSAGE_COLUMNS, aiGatewayRowsFromProjectedExchange } from './message_projector.js'

/**
 * @import { AiGatewayProjectedExchange, BackfillItem, BackfillMaterializeContext, BackfillMaterializerContribution, CachePartitionMeta, ColumnSpec, DatasetDataSourceContext, DatasetDiscoveryContext, DatasetRefreshResult, DatasetRegistration, DatasetSettleContext, QueryPartition, QueryStorageService } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { ExtendedQueryStorageService } from '../../../../src/core/cache/types.d.ts'
 * @import { GatewayState } from './types.d.ts'
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
// @ref LLP 0030#breaking — the partition key moved from conversation_id
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

  /** @type {AsyncDataSource[]} */
  const sources = []
  for (const tablePath of tablePaths) {
    const source = await storage.dataSourceForTable(tablePath)
    if (source && (source.numRows ?? 0) > 0) sources.push(source)
  }

  if (sources.length === 0) return emptySource()
  if (sources.length === 1) return sources[0]
  return unionSources(sources)
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
 * Merge multiple AsyncDataSources into a single union source.
 *
 * @param {AsyncDataSource[]} sources
 * @returns {AsyncDataSource}
 */
function unionSources(sources) {
  /** @type {Set<string>} */
  const allColumns = new Set()
  let totalRows = 0
  for (const s of sources) {
    for (const col of s.columns) allColumns.add(col)
    totalRows += s.numRows ?? 0
  }
  return {
    columns: Array.from(allColumns),
    numRows: totalRows,
    scan(options) {
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {
          for (const source of sources) {
            const scan = source.scan(options)
            for await (const row of scan.rows()) {
              yield row
            }
          }
        },
      }
    },
  }
}

function emptySource() {
  return {
    columns: AI_GATEWAY_SCHEMA_COLUMNS.map((c) => c.name),
    numRows: 0,
    scan() {
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {},
      }
    },
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
        // @ref LLP 0030#breaking — the required identity partition field
        // is session_id (always present), not conversation_id (now
        // nullable). @ref LLP 0022#within-partition-sort — these identity
        // fields, in declared order, also seed the export sort order, so
        // session_id leads the clustering and conversation_id rides along
        // as a secondary thread-lookup sort key.
        fields: [
          { column: 'session_id', transform: 'identity', required: true },
          { column: 'conversation_id', transform: 'identity' },
          { column: 'cwd', transform: 'identity' },
          { column: 'date', transform: 'identity', required: true },
        ],
      },
    },
    discoverPartitions: discoverParts,
    refreshPartition,
    createDataSource,
    settleBatch: createSettleBatch(state),
  }
}

/**
 * Build the flush-time settlement pass (LLP 0024). On each flush batch:
 *
 *  1. Short-circuit when the batch carries no fallback rows
 *     (`attributes.gateway.identity_source === 'gateway_fallback'`) — the
 *     common case, so the hot path does zero transcript or storage I/O.
 *  2. Group fallback rows by `client_name` and hand each group to the
 *     enricher registered for that client; the enricher upgrades the
 *     rows it can match against its native log (re-stamping
 *     `message_id`/`part_id`/native identity, clearing `identity_source`)
 *     and returns the rest unchanged.
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
    if (!hasFallback) return rows

    let settled = rows
    const enrichers = state?.enrichers
    if (enrichers && enrichers.size > 0) {
      /** @type {Map<string, Record<string, unknown>[]>} */
      const byClient = new Map()
      for (const row of rows) {
        if (!isFallbackRow(row)) continue
        const client = stringValue(row.client_name)
        const enricher = client ? enrichers.get(client) : undefined
        if (!enricher) continue
        const list = byClient.get(client ?? '')
        if (list) list.push(row)
        else byClient.set(client ?? '', [row])
      }
      if (byClient.size > 0) {
        /** @type {Map<Record<string, unknown>, Record<string, unknown>>} */
        const upgrades = new Map()
        for (const [client, group] of byClient) {
          const enricher = enrichers.get(client)
          if (!enricher) continue
          try {
            const out = await enricher.settle(group, ctx)
            for (let i = 0; i < group.length && i < out.length; i++) {
              if (out[i] && out[i] !== group[i]) upgrades.set(group[i], out[i])
            }
          } catch {
            // An enricher failure must never drop rows — leave the
            // group as provisional fallback; a later flush can retry.
            continue
          }
        }
        if (upgrades.size > 0) {
          settled = rows.map((row) => upgrades.get(row) ?? row)
        }
      }
    }

    return dedupeByPartId(settled, ctx)
  }
}

/**
 * Drop rows whose `part_id` already exists in a committed partition or
 * earlier in this same batch. Mirrors the backfill materializer's
 * pre-write dedupe (committed scan + per-call fold-in), so an upgraded
 * fallback row collapses onto the canonical committed uuid row.
 *
 * @param {Record<string, unknown>[]} rows
 * @param {DatasetSettleContext} ctx
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function dedupeByPartId(rows, ctx) {
  const storage = ctx?.storage
  if (rows.length === 0 || !canScanExistingRows(storage)) return rows
  const seen = await scanExistingPartIds(storage)
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

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value */
function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Backfill materializer for `ai_gateway.projected_exchange`. Registered
 * via `ctx.backfillMaterializers.register(...)` at plugin activation.
 *
 * Backfill providers yield a whole conversation as a single
 * `AiGatewayProjectedExchange` payload; this converts it into canonical
 * `ai_gateway_messages` rows through `aiGatewayRowsFromProjectedExchange`
 * — the exact expansion the live gateway recorder uses — so backfilled
 * and live-captured rows are byte-identical for the same projection.
 * Row expansion is pure with respect to `item.value`: it allocates a
 * fresh conversation state per call, so reruns and out-of-order items
 * produce identical row identity (`part_id = <message_id>#<part_index>`).
 *
 * On top of that pure expansion the materializer applies a narrow
 * PRE-WRITE dedupe: before a batch is handed back to the runner for
 * `appendRows`, any row whose `part_id` already exists in the dataset is
 * skipped. This is the PRIMARY rerun guarantee — rerunning a backfill
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
  // The materializer instance is created once at plugin activation and
  // reused for every `hyp backfill` invocation in the process, so the
  // dedupe state is scoped per run id (see createBackfillDedupe).
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
 * The seen-`part_id` set is rebuilt whenever `ctx.devRunId` changes: all
 * items in one backfill run share a single scan of the already-committed
 * partitions, and every emitted batch folds its own keys back in so two
 * items in the same run that resolve to the same `part_id` (transitional
 * fixtures, fallback-id collisions, a re-yielded conversation) also
 * dedupe against each other. A later run carries a fresh run id, so it
 * re-scans and observes the prior run's now-committed rows — which is
 * what makes a clean rerun write zero new rows.
 *
 * Reads see only committed (flushed) partitions, so a run interrupted
 * before its end-of-run flush leaves rows in the durable spool that the
 * next run's scan cannot see; compaction's content-hash dedupe is the
 * documented backup for that residual window.
 *
 * @returns {{ skipExisting(rows: Record<string, unknown>[], ctx: BackfillMaterializeContext | undefined): Promise<Record<string, unknown>[]> }}
 */
function createBackfillDedupe() {
  /** @type {{ runId: string | undefined, seen: Set<string> } | undefined} */
  let memo

  return {
    async skipExisting(rows, ctx) {
      const storage = ctx?.storage
      // Feature-detect the committed-partition read surface. A bare
      // storage stub (unit tests that only assert row shape) has neither
      // method, so dedupe is skipped and every row passes through.
      if (rows.length === 0 || !canScanExistingRows(storage)) return rows

      const runId = ctx?.devRunId
      if (!memo || memo.runId !== runId) {
        memo = { runId, seen: await scanExistingPartIds(storage) }
      }
      const seen = memo.seen

      /** @type {Record<string, unknown>[]} */
      const fresh = []
      for (const row of rows) {
        const key = partIdKey(row)
        if (key === undefined) {
          // No usable identity to dedupe on — never drop the row.
          fresh.push(row)
          continue
        }
        if (seen.has(key)) continue
        seen.add(key)
        fresh.push(row)
      }
      return fresh
    },
  }
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
 * Scan every committed `ai_gateway_messages` partition and collect the
 * set of `part_id`s already present. Reads are projected to the three
 * identity columns so the scan stays cheap, and every failure mode
 * (unreadable partition, missing table) degrades to "not seen" rather
 * than aborting the backfill — a dedupe miss only risks a duplicate that
 * compaction will later collapse, whereas throwing would drop real rows.
 *
 * @param {QueryStorageService} storage
 * @returns {Promise<Set<string>>}
 */
async function scanExistingPartIds(storage) {
  /** @type {Set<string>} */
  const seen = new Set()
  /** @type {CachePartitionMeta[]} */
  let partitions = []
  try {
    partitions = await storage.discoverCachePartitions({ datasets: [DATASET_NAME] })
  } catch {
    return seen
  }
  for (const part of partitions ?? []) {
    const tablePath = part?.path
    if (!tablePath || (typeof part.rowCount === 'number' && part.rowCount === 0)) continue
    try {
      for await (const row of storage.readRows(tablePath, ['part_id', 'message_id', 'part_index'])) {
        const key = partIdKey(row)
        if (key !== undefined) seen.add(key)
      }
    } catch {
      // Skip an unreadable partition; other partitions still contribute.
      continue
    }
  }
  return seen
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
