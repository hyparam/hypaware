// @ts-check

import { readObservabilityEnv } from '../observability/env.js'
import { parseCommandArgv } from '../cli/verb_codec.js'

/**
 * @import { CommandRunContext } from '../../../collectivus-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../src/core/cache/types.js'
 * @import { ExportMaintenanceDatasetReport } from '../../../hypaware-core/plugins-workspace/format-iceberg/src/types.js'
 * @import { ExtendedSinkRegistry } from '../../../src/core/registry/types.js'
 */

/**
 * `hyp sink` group landing: no default behavior, just usage.
 *
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 */
export async function runSinkHelp(_argv, ctx) {
  ctx.stdout.write('usage: hyp sink <subcommand> [args...]\n')
  ctx.stdout.write('  subcommands:\n')
  ctx.stdout.write('    force [instance]        Run a sink tick now, ignoring schedules\n')
  ctx.stdout.write('    maintain [instance]      Run export maintenance (snapshot expiration)\n')
  return 0
}

/**
 * `hyp sink force [instance]`
 *
 * Drives one tick of the sink driver immediately, bypassing each
 * sink's cron schedule. The optional `instance` argument restricts
 * the tick to a single sink (useful when an operator just wants to
 * flush one configured destination without waking the others.
 *
 * The driver writes the same `sink.export_batch` span and outbox
 * artifacts it does on a scheduled tick. The only difference is the
 * trigger.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runSinkForce(argv, ctx) {
  const instance = argv[0]
  const obsEnv = readObservabilityEnv(ctx.env)
  const { createSinkDriver } = await import('../sinks/driver.js')
  const driver = createSinkDriver({
    sinkRegistry: /** @type {ExtendedSinkRegistry} */ (ctx.sinks),
    queryRegistry: ctx.query,
    storage: /** @type {ExtendedQueryStorageService} */ (ctx.storage),
    stateRoot: obsEnv.stateDir,
    config: ctx.config,
  })
  const tickOpts = { now: new Date(), force: true, source: /** @type {'manual'} */ ('manual') }
  if (instance) /** @type {any} */ (tickOpts).sinkInstance = instance
  const report = await driver.tick(tickOpts)
  if (report.sinks.length === 0) {
    if (instance) {
      ctx.stderr.write(`hyp sink force: no sink named '${instance}' was instantiated\n`)
      return 1
    }
    ctx.stdout.write('no sinks instantiated; nothing to do\n')
    return 0
  }
  for (const r of report.sinks) {
    ctx.stdout.write(
      `${r.instance}: ${r.status} (partitions=${r.partitionsExported}, bytes=${r.bytesWritten}${
        r.error ? `, error=${r.error}` : ''
      })\n`
    )
  }
  return report.sinks.some((r) => r.status === 'failed') ? 1 : 0
}

/**
 * `hyp sink maintain [instance] [--compact] [--dry-run]`
 *
 * Runs export maintenance on table-format (Iceberg) sink instances:
 * snapshot expiration on exported tables, and (only with `--compact`)
 * a data-file rewrite via icebird's `icebergRewrite`.
 *
 * @ref LLP 0022#compaction: rewrites are out-of-band only: this manual
 * CLI invocation is the one place they may run. The daemon loop and the
 * sink tick never compact.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runSinkMaintain(argv, ctx) {
  const parsed = parseCommandArgv(argv, {
    type: 'object',
    properties: {
      instance: { type: 'string' },
      compact: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
    positional: ['instance'],
  })
  if ('help' in parsed) {
    ctx.stdout.write('usage: hyp sink maintain [instance] [--compact] [--dry-run]\n')
    return 0
  }
  if (!parsed.ok) {
    ctx.stderr.write(`hyp sink maintain: ${parsed.error}\n`)
    return 2
  }
  const { instance, compact, 'dry-run': dryRun } = /** @type {{ instance?: string, compact: boolean, 'dry-run': boolean }} */ (parsed.params)

  // Indirect the specifier so the declaration build (rootDir=src) does not
  // pull this hypaware-core runtime module under src's emit root (TS6059).
  // The module is loaded lazily and only when `sink maintain` runs.
  const maintenanceModule = '../../../hypaware-core/plugins-workspace/format-iceberg/src/maintenance.js'
  const { maintainExportTables } = await import(maintenanceModule)

  const allHandles = /** @type {ExtendedSinkRegistry} */ (ctx.sinks).listHandles?.() ?? []
  const tableFormatHandles = allHandles.filter(
    (h) => h.kind === 'table-format' && h.tableFormat === 'iceberg' && h.blobStore
  )

  if (instance) {
    const match = tableFormatHandles.find(/** @param {any} h */ (h) => h.instanceName === instance)
    if (!match) {
      ctx.stderr.write(`hyp sink maintain: no iceberg table-format sink named '${instance}'\n`)
      const available = tableFormatHandles.map(/** @param {any} h */ (h) => h.instanceName)
      if (available.length > 0) {
        ctx.stderr.write(`  available: ${available.join(', ')}\n`)
      }
      return 1
    }
  }

  const targets = instance
    ? tableFormatHandles.filter(/** @param {any} h */ (h) => h.instanceName === instance)
    : tableFormatHandles

  if (targets.length === 0) {
    ctx.stdout.write('no iceberg table-format sinks instantiated; nothing to maintain\n')
    return 0
  }

  if (dryRun) ctx.stdout.write('[dry-run]\n')

  let totalExpired = 0
  let totalCompacted = 0
  let rewriteErrors = 0
  for (const handle of targets) {
    const config = handle.config ?? {}
    const prefix = typeof config.prefix === 'string' && config.prefix.length > 0
      ? config.prefix
      : 'iceberg/datasets'

    const report = await maintainExportTables({
      blobStore: handle.blobStore,
      prefix,
      config: typeof config.maintenance === 'object' ? config.maintenance : undefined,
      compact,
      dryRun,
    })

    for (const d of report.datasets) {
      const actions = []
      if (d.snapshotsExpired > 0) actions.push(`expired ${d.snapshotsExpired} snapshots (was ${d.snapshotsBefore})`)
      if (d.compacted) actions.push(`compacted ${d.dataFilesBefore} -> ${d.dataFilesAfter} data files`)
      else if (compact) actions.push(describeCompactionSkip(d))
      if (actions.length === 0) actions.push('nothing to do')
      ctx.stdout.write(`  ${handle.instanceName}/${d.dataset}: ${actions.join(', ')}\n`)
      if (d.compactionReason === 'error') rewriteErrors += 1
    }
    totalExpired += report.totalSnapshotsExpired
    totalCompacted += report.totalTablesCompacted

    if (report.datasets.length === 0) {
      ctx.stdout.write(`  ${handle.instanceName}: no exported datasets found\n`)
    }
  }

  ctx.stdout.write(
    compact
      ? `sink maintain: ${totalExpired} snapshots expired, ${totalCompacted} tables compacted\n`
      : `sink maintain: ${totalExpired} snapshots expired` +
        ' (data-file compaction is out-of-band: re-run with --compact, see LLP 0022)\n'
  )
  if (rewriteErrors > 0) {
    ctx.stderr.write(`sink maintain: ${rewriteErrors} rewrite(s) failed\n`)
    return 1
  }
  return 0
}

/**
 * Render the precise reason a requested compaction did not commit, so the
 * operator can tell an idle table from a failed rewrite (LLP 0022). The
 * `compactionReason` discriminant comes from `compactExportTable`.
 *
 * @param {ExportMaintenanceDatasetReport} d
 * @returns {string}
 */
function describeCompactionSkip(d) {
  switch (d.compactionReason) {
    case 'below-threshold':
      return 'compaction_skipped (below compact_file_count)'
    case 'above-byte-cap':
      return 'compaction_skipped (table exceeds compact_max_bytes; raise the cap and the heap to rewrite)'
    case 'no-table':
      return 'compaction_skipped (no table metadata)'
    case 'conflict':
      return 'compaction_conflict (concurrent commit won the race; staged files cleaned up - re-run to retry from fresh metadata)'
    case 'error':
      return `compaction_failed (${d.compactionError ?? 'unknown error'})`
    default:
      return 'compaction_skipped'
  }
}
