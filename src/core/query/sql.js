// @ts-check

import { collect, executeSql as squirrelExecuteSql, extractTables, parseSql } from 'squirreling'

import { Attr, getKernelInstruments, withSpan } from '../observability/index.js'

/** @typedef {import('../../../collectivus-plugin-kernel-types').QueryRegistry} QueryRegistry */
/** @typedef {import('../../../collectivus-plugin-kernel-types').QueryScope} QueryScope */
/** @typedef {import('../../../collectivus-plugin-kernel-types').HypAwareV2Config} HypAwareV2Config */
/** @typedef {import('../../../collectivus-plugin-kernel-types').PluginLogger} PluginLogger */
/** @typedef {import('../cache/storage.js').ExtendedQueryStorageService} ExtendedQueryStorageService */
/** @typedef {import('squirreling').AsyncDataSource} AsyncDataSource */

/** @typedef {'never' | 'auto' | 'always'} RefreshMode */

/**
 * @typedef {Object} ExecuteSqlOptions
 * @property {string} query
 * @property {QueryRegistry} registry
 * @property {ExtendedQueryStorageService} storage
 * @property {HypAwareV2Config} [config]
 * @property {QueryScope} [scope]
 * @property {RefreshMode} [refresh]
 * @property {PluginLogger} [log]
 */

/**
 * @typedef {Object} ExecuteSqlResult
 * @property {string[]} columns
 * @property {Record<string, unknown>[]} rows
 * @property {string[]} datasets
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
        let statement
        try {
          statement = parseSql({ query: trimmed })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          throw new Error(`SQL must be a single read-only SELECT statement: ${message}`)
        }

        const tableNames = uniqueStrings(extractTables(statement))
        span.setAttribute('table_count', tableNames.length)

        /** @type {Record<string, AsyncDataSource>} */
        const tables = {}
        /** @type {string[]} */
        const datasetsUsed = []

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

        return { columns, rows, datasets: datasetsUsed }
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
