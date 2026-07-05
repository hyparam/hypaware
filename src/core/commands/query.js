// @ts-check

import { Attr, withSpan } from '../observability/index.js'
import { migrateLegacyPartitions } from '../cache/migrate.js'
import { renderSchema, schemaForDataset } from '../query/schema.js'
import { parseCommandArgv } from '../cli/verb_codec.js'

/**
 * @import { CommandRunContext, VerbInputSchema } from '../../../hypaware-plugin-kernel-types.js'
 */

// `measureCacheRoot` / `walkCacheRoot` / `loadRetentionDays` moved into
// `src/core/daemon/status.js` as part of the Phase 8 status collector
// (`collectHypAwareStatus`). Callers route through that helper now so
// disk probes happen once per `hyp status` invocation.

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runQuery(argv, ctx) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    ctx.stdout.write('usage: hyp query <subcommand> [args...]\n')
    ctx.stdout.write('  subcommands: schema, status, sql, refresh, maintain\n')
    return 0
  }
  ctx.stderr.write(`hyp query: unknown subcommand '${argv[0]}'\n`)
  ctx.stderr.write('  expected one of: schema, status, sql, refresh, maintain\n')
  return 2
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runQuerySchema(argv, ctx) {
  const dataset = argv[0]
  if (!dataset) {
    ctx.stderr.write('usage: hyp query schema <dataset>\n')
    return 2
  }
  return withSpan(
    'query.resolve_tables',
    {
      [Attr.COMPONENT]: 'query',
      [Attr.OPERATION]: 'resolve_tables',
      [Attr.DATASET]: dataset,
      status: 'ok',
    },
    async () => {
      const schema = schemaForDataset(ctx.query, dataset)
      if (!schema) {
        ctx.stdout.write(`dataset: ${dataset}\n`)
        ctx.stdout.write('  (no dataset registered - install a plugin that contributes it)\n')
        return 0
      }
      ctx.stdout.write(renderSchema(dataset, schema))
      return 0
    },
    { component: 'query' }
  )
}

/**
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 */
export async function runQueryStatus(_argv, ctx) {
  const { cacheStatus } = await import('../cache/maintenance.js')
  const datasets = ctx.query.listDatasets()
  const report = await cacheStatus({ cacheRoot: ctx.storage.cacheRoot })
  ctx.stdout.write(`cache:    ${report.cacheRoot}\n`)
  ctx.stdout.write(`pending:  ${report.pendingSpoolBytes} bytes\n`)
  ctx.stdout.write(`datasets: ${datasets.length} registered\n`)
  for (const dataset of datasets) {
    ctx.stdout.write(`  ${dataset.name}  (${dataset.plugin})\n`)
  }
  if (report.partitions.length > 0) {
    ctx.stdout.write(`partitions: ${report.partitions.length}\n`)
    for (const p of report.partitions) {
      const partKey = Object.entries(p.partition).map(([k, v]) => `${k}=${v}`).join('/')
      const label = `${p.dataset}/${partKey || 'all'}`
      if (p.layout === 'source-table') {
        const extras = []
        if (p.deleteFileCount) extras.push(`deletes=${p.deleteFileCount}`)
        if (p.lastRetentionCutoffDate) extras.push(`retention_cutoff=${p.lastRetentionCutoffDate}`)
        ctx.stdout.write(`  ${label}  source-table  rows=${p.rowCount}  files=${p.dataFileCount}  snapshots=${p.snapshotCount}  metadata=${p.metadataBytes}B${extras.length ? '  ' + extras.join('  ') : ''}\n`)
      } else {
        ctx.stdout.write(`  ${label}  epoch=${p.epoch}  rows=${p.rowCount}  files=${p.dataFileCount}  snapshots=${p.snapshotCount}  metadata=${p.metadataBytes}B\n`)
      }
    }
  }
  return 0
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runQueryRefresh(argv, ctx) {
  const target = argv[0]
  const datasets = ctx.query.listDatasets()
  const filtered = target ? datasets.filter((d) => d.name === target) : datasets
  if (target && filtered.length === 0) {
    ctx.stderr.write(`hyp query refresh: unknown dataset '${target}'\n`)
    return 1
  }
  let total = 0
  for (const dataset of filtered) {
    if (typeof dataset.refreshPartition !== 'function') continue
    const partitions = await dataset.discoverPartitions({
      config: ctx.config,
      scope: { limit: 1_000_000 },
      cacheDir: ctx.storage.cacheRoot,
    })
    for (const partition of partitions) {
      const result = await dataset.refreshPartition(partition, {
        cacheDir: ctx.storage.cacheRoot,
        force: true,
        log: {
          debug() {},
          info() {},
          warn() {},
          error() {},
        },
        storage: ctx.storage,
      })
      const storage = /** @type {typeof ctx.storage & { flushTable?: (tablePath: string, opts?: { force?: boolean, reason?: string }) => Promise<unknown> }} */ (ctx.storage)
      if (partition.tablePath && typeof storage.flushTable === 'function') {
        await storage.flushTable(partition.tablePath, { force: true, reason: 'query_refresh' })
      }
      if (result.status === 'written') total += result.rows
    }
  }
  ctx.stdout.write(`refreshed ${filtered.length} dataset(s), wrote ${total} row(s)\n`)
  return 0
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runQueryMaintain(argv, ctx) {
  const { maintainCache } = await import('../cache/maintenance.js')
  const parsed = parseQueryMaintainArgv(argv)
  if ('error' in parsed) {
    ctx.stderr.write(`hyp query maintain: ${parsed.error}\n`)
    return 2
  }
  const { dataset, force, dryRun, compactOnly, expireOnly } = parsed
  if (!compactOnly && !expireOnly && !dryRun) {
    const migrationResult = await migrateLegacyPartitions({
      cacheRoot: ctx.storage.cacheRoot,
      force,
    })
    if (migrationResult.migrated > 0) {
      ctx.stdout.write(`migrate: ${migrationResult.migrated} legacy partition(s), ${migrationResult.rowsMigrated} row(s)\n`)
    }
  }
  const maintenanceConfig = ctx.config?.query?.cache?.maintenance
  const report = await maintainCache({
    cacheRoot: ctx.storage.cacheRoot,
    dataset,
    force,
    dryRun,
    compactOnly,
    expireOnly,
    config: maintenanceConfig,
    // @ref LLP 0027#re-settle-sweep: `hyp query maintain` re-settles
    // committed fallback rows too, so a manual sweep also closes the race.
    storage: ctx.storage,
    getSettleHook: (dataset) => ctx.query.getDataset(dataset)?.resettleBatch,
  })
  if (report.dryRun) {
    ctx.stdout.write('[dry-run]\n')
  }
  for (const p of report.partitions) {
    const partKey = Object.entries(p.partition).map(([k, v]) => `${k}=${v}`).join('/')
    const label = `${p.dataset}/${partKey || 'all'}`
    const actions = []
    if (p.snapshotsExpired > 0) actions.push(`expired ${p.snapshotsExpired} snapshots`)
    if (p.compacted) actions.push(`compacted epoch=${p.newEpoch ?? '?'} (${p.dataFilesBefore} -> ${p.dataFilesAfter} files)`)
    if (actions.length > 0) {
      ctx.stdout.write(`  ${label}: ${actions.join(', ')}\n`)
    }
  }
  ctx.stdout.write(`maintenance: ${report.totalSnapshotsExpired} snapshots expired, ${report.totalCompacted} partitions compacted (${report.elapsedMs}ms)\n`)
  return 0
}

const QUERY_MAINTAIN_USAGE = 'usage: hyp query maintain [dataset] [--dry-run] [--force] [--compact-only] [--expire-only]'

/** @type {VerbInputSchema} */
const QUERY_MAINTAIN_SCHEMA = {
  type: 'object',
  properties: {
    dataset: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    'compact-only': { type: 'boolean', default: false },
    'expire-only': { type: 'boolean', default: false },
  },
  positional: ['dataset'],
}

/**
 * @param {string[]} argv
 * @returns {{ error: string } | { dataset?: string, dryRun: boolean, force: boolean, compactOnly: boolean, expireOnly: boolean }}
 */
function parseQueryMaintainArgv(argv) {
  const parsed = parseCommandArgv(argv, QUERY_MAINTAIN_SCHEMA)
  if ('help' in parsed) return { error: QUERY_MAINTAIN_USAGE }
  if (!parsed.ok) return { error: parsed.error }
  const p = /** @type {{ dataset?: string, 'dry-run': boolean, force: boolean, 'compact-only': boolean, 'expire-only': boolean }} */ (parsed.params)
  if (p['compact-only'] && p['expire-only']) {
    return { error: '--compact-only and --expire-only are mutually exclusive' }
  }
  return { dataset: p.dataset, dryRun: p['dry-run'], force: p.force, compactOnly: p['compact-only'], expireOnly: p['expire-only'] }
}
