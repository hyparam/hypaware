// @ts-check

import { collect, executeSql as squirrelExecuteSql, extractTables, parseSql } from 'squirreling'

import { Attr, getKernelInstruments, withSpan } from '../observability/index.js'
import { QUERY_FLUSH_DEBOUNCE_MS } from '../cache/spool.js'

/**
 * @import { HypAwareV2Config, PluginLogger, QueryRegistry, QueryScope } from '../../../collectivus-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../src/core/cache/types.js'
 * @import { ExecuteSqlOptions, ExecuteSqlResult, RefreshMode } from '../../../src/core/query/types.js'
 * @import { AsyncDataSource } from 'squirreling'
 */

/**
 * Run a read-only SELECT against the kernel's dataset registry. The
 * caller (the `hyp query sql` command or a future server endpoint)
 * supplies the registry and storage; this function never reads from
 * disk directly — every byte of cache IO goes through the storage
 * service so spans and metrics are attributed correctly.
 *
 * Wraps the entire run in a `query.execute_sql` span and emits one
 * `query.scan_dataset` child per referenced dataset, matching the
 * Phase 4 smoke contract.
 *
 * @param {ExecuteSqlOptions} args
 * @returns {Promise<ExecuteSqlResult>}
 * @ref LLP 0015#query-is-intrinsic [implements] — core-owned read-only SQL over the registry; IO only via the storage service
 */
export async function executeQuerySql(args) {
  const { query, registry, storage } = args
  const refresh = args.refresh ?? 'auto'
  const scope = args.scope ?? { limit: 1_000_000 }
  const config = args.config ?? { version: 2 }
  const log = args.log

  return withSpan(
    'query.execute_sql',
    {
      [Attr.COMPONENT]: 'query',
      [Attr.OPERATION]: 'query.execute_sql',
      sql_truncated: query.slice(0, 256),
      refresh_mode: refresh,
      status: 'ok',
    },
    async (span) => {
      const instruments = getKernelInstruments()
      const start = Date.now()
      try {
        const trimmed = query.trim()
        if (trimmed.length === 0) throw new Error('SQL query is required')
        // squirreling only parses read-only SELECTs, so its own error message
        // already points at the real problem (syntax error, unknown function,
        // non-SELECT statement). Surface it verbatim rather than wrapping it.
        const statement = parseSql({ query: trimmed })

        const tableNames = uniqueStrings(extractTables(statement))
        span.setAttribute('table_count', tableNames.length)

        /** @type {Record<string, AsyncDataSource>} */
        const tables = {}
        /** @type {string[]} */
        const datasetsUsed = []
        /** @type {string[]} */
        const freshnessMessages = []

        for (const name of tableNames) {
          const dataset = registry.getDataset(name)
          if (!dataset) {
            throw new Error(`SQL query references unknown dataset: ${name}`)
          }
          datasetsUsed.push(name)

          const partitions = await dataset.discoverPartitions({
            config,
            scope,
            cacheDir: storage.cacheRoot,
          })

          if (refresh === 'always' && typeof dataset.refreshPartition === 'function') {
            for (const partition of partitions) {
              await dataset.refreshPartition(partition, {
                cacheDir: storage.cacheRoot,
                force: true,
                log: log ?? noopLogger(),
                storage,
              })
            }
          }

          await settlePendingCacheForQuery({
            partitions,
            storage,
            refresh,
            messages: freshnessMessages,
          })

          const source = await withSpan(
            'query.scan_dataset',
            {
              [Attr.COMPONENT]: 'query',
              [Attr.OPERATION]: 'query.scan_dataset',
              [Attr.DATASET]: name,
              partition_count: partitions.length,
              status: 'ok',
            },
            async () => {
              return dataset.createDataSource(partitions, { scope, storage })
            },
            { component: 'query' }
          )
          tables[name] = source
        }

        const results = squirrelExecuteSql({ tables, query: trimmed })
        const rows = await collect(results)
        const columns = results.columns ?? []
        span.setAttribute('row_count', rows.length)

        instruments.queryRunsTotal.add(1, { status: 'ok' })
        instruments.queryDurationMs.record(Date.now() - start, { status: 'ok' })

        return { columns, rows, datasets: datasetsUsed, freshnessMessages }
      } catch (err) {
        span.setAttribute('status', 'failed')
        instruments.queryRunsTotal.add(1, { status: 'failed' })
        instruments.queryDurationMs.record(Date.now() - start, { status: 'failed' })
        throw err
      }
    },
    { component: 'query' }
  )
}

/**
 * @param {{
 *   partitions: Array<{ tablePath?: string }>,
 *   storage: ExtendedQueryStorageService,
 *   refresh: RefreshMode,
 *   messages: string[],
 * }} args
 */
async function settlePendingCacheForQuery(args) {
  const now = Date.now()
  for (const partition of args.partitions) {
    if (!partition.tablePath) continue
    const info = await args.storage.pendingInfo(partition.tablePath)
    if (!info.pending) continue
    if (args.refresh === 'always') {
      await args.storage.flushTable(partition.tablePath, { force: true, reason: 'query_always' })
      continue
    }
    if (args.refresh === 'never') continue
    if (info.lastFlushAtMs === null || now - info.lastFlushAtMs >= QUERY_FLUSH_DEBOUNCE_MS) {
      await args.storage.flushTable(partition.tablePath, { reason: 'query_auto' })
      continue
    }
    args.messages.push(
      `cache: last write to query cache was ${formatAgeMinutes(now - info.lastFlushAtMs)} ago`
    )
  }
}

/** @param {number} ageMs */
function formatAgeMinutes(ageMs) {
  const minutes = Math.max(0, Math.floor(ageMs / 60_000))
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function uniqueStrings(values) {
  /** @type {string[]} */
  const out = []
  const seen = new Set()
  for (const v of values) {
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

/**
 * @returns {PluginLogger}
 */
function noopLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  }
}
