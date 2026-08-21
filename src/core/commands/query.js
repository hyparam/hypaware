// @ts-check

import { Attr, withSpan } from '../observability/index.js'
import { migrateLegacyPartitions } from '../cache/migrate.js'
import { renderSchema, schemaForDataset } from '../query/schema.js'
import { parseCoreCommandArgv } from '../cli/command_args.js'
import { parseCommandArgv, STRICT_SHORT_FLAGS } from '../cli/verb_codec.js'
import { useColor } from '../cli/stdio.js'

/**
 * @import { CommandRunContext, VerbInputSchema } from '../../../hypaware-plugin-kernel-types.js'
 * @import { OverviewRows } from '../../../src/core/query/types.js'
 */

// `measureCacheRoot` / `walkCacheRoot` / `loadRetentionDays` moved into
// `src/core/daemon/status.js` as part of the Phase 8 status collector
// (`collectHypAwareStatus`). Callers route through that helper now so
// disk probes happen once per `hyp status` invocation.

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runQuerySchema(argv, ctx) {
  const parsed = parseCoreCommandArgv('query schema', argv, ctx)
  if (!parsed.ok) return parsed.code
  const dataset = String(parsed.params.dataset)
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
 * Report this machine's local cache. There is no remote form: the server
 * owns its own registration state and never exposes it through this
 * command, so `--remote` is refused rather than ignored.
 *
 * The refusal matters more here than it does for `--refresh`. A rejected
 * refresh is obvious (nothing happened), but a silently-ignored `--remote`
 * on `status` prints a plausible, server-shaped inventory of the *wrong*
 * host, with nothing on stderr and a zero exit. Callers asking "what does
 * the server have" have been observed to read the local answer as the
 * server's and carry on.
 *
 * @ref LLP 0273#decision [implements]: status rejects --remote before any cache work, so no local inventory reaches stdout
 * @ref LLP 0273#asymmetry: the silent ignore is self-consistent here, unlike a dropped --refresh, so nothing later contradicts it
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runQueryStatus(argv, ctx) {
  if (argv.some((arg) => arg === '--remote' || arg.startsWith('--remote='))) {
    ctx.stderr.write(
      "hyp cache status: --remote is not supported - status reports this machine's local cache (the server owns its own)\n"
    )
    ctx.stderr.write(
      "  to see what a remote host holds, probe it: hyp query sql 'select 1 from <dataset> limit 1' --remote <target>\n"
    )
    return 2
  }
  // Everything else goes through the shared codec, for the same reason the
  // spelled-out `--remote` is refused above: `status` takes no arguments, so
  // anything else here is a near miss (`--remot prod`, `-r prod`,
  // `--format json`, a bare `prod`) that a silent ignore would answer with
  // the same well-formed local inventory the refusal exists to withhold.
  // @ref LLP 0273#asymmetry [implements]: a wrong-host answer is self-consistent, so a mistyped flag has to fail loudly too
  const parsed = parseCoreCommandArgv('cache status', argv, ctx)
  if (!parsed.ok) return parsed.code
  const { cacheStatus } = await import('../cache/maintenance.js')
  const datasets = ctx.query.listDatasets()
  const report = await cacheStatus({ cacheRoot: ctx.storage.cacheRoot })
  ctx.stdout.write(`cache:    ${report.cacheRoot}\n`)
  ctx.stdout.write(`pending:  ${report.pendingSpoolBytes} bytes\n`)
  // Grep-index coverage over the searchable dataset: how much of a `hyp
  // query grep` is served by sidecar indexes versus the brute scan. The
  // gap is expected (fresh files are indexed only when compaction
  // finalizes them), so the line explains the remainder rather than
  // leaving "grep is slow" to tracing.
  // @ref LLP 0264#lifecycle [implements]: index coverage is observable where the operator already looks
  const searchable = report.partitions.filter((p) => p.indexedFileCount !== undefined)
  if (searchable.length > 0) {
    const files = searchable.reduce((n, p) => n + p.dataFileCount, 0)
    const indexed = searchable.reduce((n, p) => n + (p.indexedFileCount ?? 0), 0)
    ctx.stdout.write(`grep index: ${indexed} of ${files} data files indexed` +
      (indexed < files ? ' (searches brute-scan the rest; compaction indexes them)\n' : '\n'))
  }
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
        if (p.indexedFileCount !== undefined) extras.push(`indexed=${p.indexedFileCount}`)
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

const QUERY_OVERVIEW_USAGE =
  'usage: hyp query overview [--json] [--sql] [--days <n>] [--include-local-only]'

/** @type {VerbInputSchema} */
const QUERY_OVERVIEW_SCHEMA = {
  type: 'object',
  properties: {
    json: { type: 'boolean', default: false },
    sql: { type: 'boolean', default: false },
    days: { type: 'integer', minimum: 1 },
    // The block's own withheld-rows disclosure names this flag as the
    // remedy, on stderr and again in the empty state. Declaring it is what
    // makes that advice true: without it the codec refuses the flag, so the
    // one action the output told the user to take exits 2.
    // @ref LLP 0105#override [implements]: the informed-consent override, offered wherever the withholding is disclosed
    'include-local-only': {
      type: 'boolean',
      default: false,
      description:
        'Include local-only rows even when this context is synced. If this session ' +
        'is itself captured, their content enters the transcript and can be forwarded.',
    },
  },
}

/**
 * `hyp query overview [--json] [--sql] [--days <n>] [--include-local-only]`
 *
 * Prints the gateway overview: token volume per provider and model, then
 * sessions and tokens per day, repos, and tools. The same block the
 * `hyp init` wizard ends on, so "see that again" is one command rather than
 * four remembered SQL statements. `--sql` prints those statements above
 * each table: they are worth learning and hard to guess (token usage lives
 * inside the `attributes` JSON), but too long to show unasked.
 *
 * The window is chosen to fit a row budget and always stated in the
 * output; `--days <n>` pins it instead, whatever it costs, because an
 * explicit request outranks the budget.
 *
 * Local-only, deliberately. The runner is a seam, so pointing it at a
 * remote `query_sql` tool is a small change - but against a fleet-sized
 * server even a bounded window exceeds the gateway timeout (measured: 504
 * at 60s unbounded, 58s bounded to 7 days, ~10s bounded to 1 day).
 * `--remote` waits on a server-side summary rather than shipping a flag
 * that times out.
 *
 * Exits 1 when `ai_gateway_messages` is not registered: the user asked for
 * their AI traffic and there is no source that records it, which is a
 * result worth a non-zero code (with the fix on stderr), not a silent
 * empty table.
 *
 * @ref LLP 0135#first-look [implements]: the wizard's closing block, re-runnable on demand
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runQueryOverview(argv, ctx) {
  const { OVERVIEW_DATASET, collectOverview, overviewRunnerFromCtx, renderOverview } =
    await import('../query/overview.js')
  // Through the shared codec, not a hand-rolled `indexOf('--days')`: that
  // form silently ignores `--days=7` and accepts unknown flags, so a user
  // who pinned a window would get the auto-planned one and no indication
  // that anything was dropped.
  const parsed = parseCommandArgv(argv, QUERY_OVERVIEW_SCHEMA)
  if ('help' in parsed) {
    ctx.stdout.write(`${QUERY_OVERVIEW_USAGE}\n`)
    return 0
  }
  if (!parsed.ok) {
    ctx.stderr.write(`hyp query overview: ${parsed.error}\n${QUERY_OVERVIEW_USAGE}\n`)
    return 2
  }
  const p = /** @type {{ json: boolean, sql: boolean, days?: number, 'include-local-only': boolean }} */ (parsed.params)
  const json = p.json
  const showSql = p.sql
  // `minimum: 1` on the schema does the range check, with the codec's
  // standard wording ("--days expects a positive integer (got 0)").
  const days = p.days
  // Same reporting as `hyp query sql`: a withheld-row count is required
  // disclosure (LLP 0105), a freshness line is advisory. Both to stderr
  // so stdout stays the block (and stays valid JSON under --json).
  const runner = overviewRunnerFromCtx(
    ctx,
    (notice) => ctx.stderr.write(notice.line),
    { includeLocalOnly: p['include-local-only'] === true }
  )
  if (!runner || !runner.hasDataset(OVERVIEW_DATASET)) {
    // Says what is true, then what to do. The absent thing is a dataset
    // name (`ai_gateway_messages`) that means nothing to the person who
    // typed the command - naming it explains the tool's internals instead
    // of their situation. It also reads as breakage when it is really just
    // "no AI client is set up yet".
    ctx.stderr.write(
      'hyp query overview: nothing has been recorded yet - no AI client is connected.\n' +
      '  Run `hyp setup` to start capturing Claude or Codex sessions.\n'
    )
    return 1
  }

  return withSpan(
    'query.overview',
    {
      [Attr.COMPONENT]: 'query',
      [Attr.OPERATION]: 'query.overview',
      [Attr.DATASET]: OVERVIEW_DATASET,
      format: json ? 'json' : 'text',
      show_sql: showSql,
      ...(days !== undefined ? { days_requested: days } : {}),
      status: 'ok',
    },
    async (span) => {
      /** @type {OverviewRows} */
      let overview
      try {
        overview = await collectOverview(runner, { ...(days !== undefined ? { days } : {}) })
      } catch (err) {
        span.setAttribute('status', 'error')
        span.setAttribute(Attr.ERROR_KIND, err instanceof Error ? err.name : 'unknown')
        ctx.stderr.write(`hyp query overview: ${err instanceof Error ? err.message : String(err)}\n`)
        // The kernel's budget refusal advises a WHERE/date filter or a LIMIT
        // - right for hand-written SQL, useless here: this block already has
        // a date filter and takes no LIMIT. Name the lever it does have.
        // @ref LLP 0056 [constrained-by]: the refusal is the kernel's; the actionable next step is this command's to name
        if (err instanceof Error && err.name === 'QueryExecutionBudgetError') {
          const shorter = days !== undefined ? Math.max(1, Math.floor(days / 2)) : 7
          ctx.stderr.write(`  this block's lever is a shorter window: hyp query overview --days ${shorter}\n`)
        }
        return 1
      }
      span.setAttribute('provider_rows', overview.providerRows.length)
      span.setAttribute('day_rows', overview.dailyRows.length)
      if (overview.window) {
        span.setAttribute('window_days', overview.window.days)
        span.setAttribute('window_rows', overview.window.rows)
        span.setAttribute('window_narrowed', overview.window.narrowed)
      }
      if (json) {
        ctx.stdout.write(JSON.stringify(overview, null, 2) + '\n')
        return 0
      }
      ctx.stdout.write(renderOverview({
        ...overview,
        color: useColor(ctx.stdout, ctx.env),
        showSql,
        withheld: runner.sawWithholding?.() ?? false,
      }))
      return 0
    },
    { component: 'query' }
  )
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runQueryRefresh(argv, ctx) {
  const parsed = parseCoreCommandArgv('cache refresh', argv, ctx)
  if (!parsed.ok) return parsed.code
  const target = /** @type {string | undefined} */ (parsed.params.dataset)
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
    // @ref LLP 0207#re-baseline: a rebaseline writes the cursor without a
    // rewrite; without this line the run reads as "nothing due".
    if (p.rebaselined) actions.push(`rebaselined to ${p.dataFilesBefore} files (foreign sorted replace)`)
    // @ref LLP 0217#record-effectiveness: without this the run reports
    // "0 partitions compacted" for a partition it is deliberately leaving
    // fragmented, and the reason is only recoverable by reading cursors.
    // The skip line quotes the count the recorded rewrite ran over, not the
    // live count: the sentence is about that rewrite, and the two diverge
    // whenever the partition shrank without becoming due again.
    if (p.compactionIneffective) {
      actions.push(p.compacted
        ? 'no file-count reduction'
        : `compaction skipped: the last rewrite of ${p.compactionIneffectiveFiles} files reduced nothing`)
    }
    // @ref LLP 0218#report-the-spent-attempt: the other stated reason a
    // partition is left alone. The retry a writer change granted was spent by
    // a rewrite that failed, which is why nothing has been attempted since;
    // saying so names the manual way out instead of leaving the partition
    // looking converged.
    if (p.compactionAttemptFailed) {
      actions.push(`compaction skipped: the retry failed under this writer at ${p.compactionAttemptFailedAt}, --force to retry`)
    }
    // @ref LLP 0220#tick-reports-degraded: this tick's own failure, as
    // opposed to the line above, which reports one an earlier tick already
    // recorded on the cursor. The walk continued past this partition, so
    // without the line the run reads as a clean one that happened to do
    // less work.
    if (p.failed) {
      actions.push(`FAILED: ${p.errorMessage} (${p.errorKind}); the walk continued`)
    }
    if (actions.length > 0) {
      ctx.stdout.write(`  ${label}: ${actions.join(', ')}\n`)
    }
  }
  const rebaselineNote = report.totalRebaselined > 0 ? `, ${report.totalRebaselined} rebaselined` : ''
  const failedNote = report.totalFailed > 0 ? `, ${report.totalFailed} partitions failed` : ''
  ctx.stdout.write(`maintenance: ${report.totalSnapshotsExpired} snapshots expired, ${report.totalCompacted} partitions compacted${rebaselineNote}${failedNote} (${report.elapsedMs}ms)\n`)
  // Before this PR the exception propagated to bin/hypaware.js, which wrote
  // `hyp: <message>` to stderr - so a caller that only captures stderr (a
  // cron or systemd wrapper, `>/dev/null`) still needs a line there on a
  // degraded tick, not just the stdout summary above.
  if (report.totalFailed > 0) {
    ctx.stderr.write(`hyp query maintain: ${report.totalFailed} partition(s) failed; the walk continued\n`)
  }
  // A partition that threw used to abort the walk and exit non-zero. The
  // walk survives it now, but the tick did not do what it was asked, so the
  // exit status still says so: a script that gated on this must not start
  // reading a degraded run as a clean one.
  return report.totalFailed > 0 ? 1 : 0
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
  const parsed = parseCommandArgv(argv, QUERY_MAINTAIN_SCHEMA, STRICT_SHORT_FLAGS)
  if ('help' in parsed) return { error: QUERY_MAINTAIN_USAGE }
  if (!parsed.ok) return { error: parsed.error }
  const p = /** @type {{ dataset?: string, 'dry-run': boolean, force: boolean, 'compact-only': boolean, 'expire-only': boolean }} */ (parsed.params)
  if (p['compact-only'] && p['expire-only']) {
    return { error: '--compact-only and --expire-only are mutually exclusive' }
  }
  return { dataset: p.dataset, dryRun: p['dry-run'], force: p.force, compactOnly: p['compact-only'], expireOnly: p['expire-only'] }
}
