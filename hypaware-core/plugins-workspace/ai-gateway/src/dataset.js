// @ts-check

import { createHash } from 'node:crypto'
import path from 'node:path'

import { discoverCachePartitions } from '../../../../src/core/cache/partition.js'
import { AI_GATEWAY_MESSAGE_COLUMNS, aiGatewayRowsFromProjectedExchange } from './message_projector.js'

/**
 * @import { AiGatewayProjectedExchange, BackfillItem, BackfillMaterializerContribution, ColumnSpec, DatasetDataSourceContext, DatasetDiscoveryContext, DatasetRefreshResult, DatasetRegistration, QueryPartition, QueryStorageService } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { ExtendedQueryStorageService } from '../../../../src/core/cache/types.d.ts'
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
export const PARTITION_LABEL = 'proxy_messages_v4'

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
 * new-style per-client/date partitions and legacy `proxy_messages_v4`
 * or `all` partitions.  Always includes the legacy spool path so
 * pending data gets flushed during query settlement.
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

  const legacyPath = path.join(cacheDir, 'datasets', DATASET_NAME, PARTITION_LABEL)
  partitions.push({
    dataset: DATASET_NAME,
    partition: { partition: PARTITION_LABEL },
    tablePath: legacyPath,
  })
  seen.add(legacyPath)

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
 * activate().
 *
 * @returns {DatasetRegistration}
 */
export function aiGatewayDatasetRegistration() {
  return {
    name: DATASET_NAME,
    plugin: PLUGIN_NAME,
    schema: AI_GATEWAY_SCHEMA,
    primaryTimestampColumn: 'message_created_at',
    cachePartitioning: {
      source: {
        columns: ['client_name', 'conversation_source', 'provider'],
        fallback: 'unknown',
      },
      iceberg: {
        fields: [
          { column: 'conversation_id', transform: 'identity', required: true },
          { column: 'cwd', transform: 'identity' },
          { column: 'date', transform: 'identity', required: true },
        ],
      },
    },
    discoverPartitions: discoverParts,
    refreshPartition,
    createDataSource,
  }
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
 * The materializer is pure with respect to `item.value`: it allocates a
 * fresh conversation state per call, so reruns and out-of-order items
 * produce identical row identity.
 *
 * @returns {BackfillMaterializerContribution}
 */
export function aiGatewayBackfillMaterializer() {
  return {
    kind: AI_GATEWAY_PROJECTED_EXCHANGE_KIND,
    dataset: DATASET_NAME,
    plugin: PLUGIN_NAME,
    materialize(item) {
      const projection = asProjectedExchange(item.value)
      if (!projection) return []
      return aiGatewayRowsFromProjectedExchange(projection, {
        gatewayAttributes: backfillGatewayAttributes(item),
      })
    },
  }
}

/**
 * Narrow a `BackfillItem.value` to an `AiGatewayProjectedExchange`. The
 * runner already validated the envelope shape; this guards the
 * payload's minimal contract (`provider`, `conversation_id`, and a
 * `messages` array) so a malformed provider record yields zero rows
 * instead of throwing mid-run.
 *
 * @param {unknown} value
 * @returns {AiGatewayProjectedExchange | undefined}
 */
function asProjectedExchange(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const v = /** @type {Record<string, unknown>} */ (value)
  if (typeof v.provider !== 'string' || v.provider.length === 0) return undefined
  if (typeof v.conversation_id !== 'string' || v.conversation_id.length === 0) return undefined
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
