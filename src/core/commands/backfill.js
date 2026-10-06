// @ts-check

import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import { parseCoreCommandArgv } from '../cli/command_args.js'
import { parseCommandArgv, STRICT_SHORT_FLAGS } from '../cli/verb_codec.js'

import { Attr, getLogger, withSpan } from '../observability/index.js'
import { readObservabilityEnv } from '../observability/env.js'
import { DEFAULT_RETENTION_DAYS } from '../cache/retention.js'
import { resolveEntrypointOwners } from '../backfill/entrypoint_owner.js'
import { resolveConfigPath } from '../runtime/boot.js'
import { readRecordingStateFromDisk } from '../config/client_recording.js'
import { loadClientDescriptors } from '../daemon/status.js'

/**
 * Base partition segment for backfilled writes. `storage.appendRows`
 * re-routes each row to its real source partition using the dataset's
 * registered `cachePartitioning` declaration, so this segment only
 * names the spool bucket and the dataset-attribution path; it keeps
 * backfill spool state distinct from the live capture spool while
 * landing rows in the exact same per-source Iceberg tables.
 */
const BACKFILL_PARTITION_SEGMENT = 'backfill'

/**
 * @import { BackfillContribution, BackfillItem, BackfillEvent, BackfillMaterializerContribution, BackfillRunContext, CommandRunContext, PluginLogger, PluginName } from '../../../hypaware-plugin-kernel-types.js'
 * @import { BackfillProviderResult, BackfillRunnerContext } from '../../../src/core/commands/types.js'
 * @import { EntrypointOwners } from '../../../src/core/backfill/types.js'
 */

/**
 * `hyp backfill [provider...] [--since <iso>] [--until <iso>] [--retention-days <n>] [--dry-run] [--json]`
 *
 * Runs one or more registered backfill providers. Default behavior:
 *
 * - No provider arg → run providers whose owning plugin appears in the
 *   active config. Explicit provider names override that filter and
 *   may target unconfigured providers (the listing command is the
 *   discovery surface).
 * - No date window → use the configured query retention window
 *   (`config.query.cache.retention.default_days`), falling back to
 *   `DEFAULT_RETENTION_DAYS`.
 * - `--dry-run` → providers scan and yield items but the runner skips
 *   materialization and writes; `backfill.materialize` / `backfill.write`
 *   are not invoked.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
export async function runBackfill(argv, ctx) {
  const parsed = parseRunArgv(argv)
  if (parsed.error !== undefined) {
    ctx.stderr.write(`hyp backfill: ${parsed.error}\n`)
    return 2
  }

  const devRunId = ctx.env.DEV_RUN_ID ?? `bf-${randomUUID()}`
  const log = getLogger('backfill')
  const retentionDays = resolveRetentionDays({
    flag: parsed.retentionDays,
    config: ctx.config,
  })

  const selected = selectProviders({
    requested: parsed.providers,
    available: ctx.backfills.list(),
    activePlugins: ctx.config.plugins ?? [],
  })

  if (selected.unknown.length > 0) {
    ctx.stderr.write(
      `hyp backfill: unknown provider(s): ${selected.unknown.join(', ')}\n`
    )
    return 1
  }
  if (selected.providers.length === 0) {
    if (parsed.json) {
      ctx.stdout.write(JSON.stringify({ run_id: devRunId, providers: [] }, null, 2) + '\n')
    } else if (ctx.backfills.list().length > 0) {
      ctx.stdout.write(
        'No backfill providers matched your active config. Providers are registered but none are enabled here. Run `hyp backfill list` to see them, or name one explicitly (e.g. `hyp backfill claude`).\n'
      )
    } else {
      ctx.stdout.write(
        'No backfill providers registered. No active plugin contributes one; check enabled plugins with `hyp daemon status`, and if you just joined a fleet the config may still be syncing.\n'
      )
    }
    return 0
  }

  /** @type {Array<BackfillProviderResult>} */
  const results = []

  return withSpan(
    'backfill.start',
    {
      [Attr.COMPONENT]: 'backfill',
      [Attr.OPERATION]: 'backfill.start',
      [Attr.DEV_RUN_ID]: devRunId,
      provider_count: selected.providers.length,
      dry_run: parsed.dryRun,
      retention_days: retentionDays ?? 0,
      since: parsed.since ?? '',
      until: parsed.until ?? '',
      status: 'ok',
    },
    async () => {
      log.info('backfill.start', {
        [Attr.COMPONENT]: 'backfill',
        [Attr.DEV_RUN_ID]: devRunId,
        provider_count: selected.providers.length,
        dry_run: parsed.dryRun,
      })
      for (const provider of selected.providers) {
        const result = await runProvider({
          provider,
          ctx,
          devRunId,
          retentionDays,
          since: parsed.since,
          until: parsed.until,
          dryRun: parsed.dryRun,
        })
        results.push(result)
      }
      log.info('backfill.finish', {
        [Attr.COMPONENT]: 'backfill',
        [Attr.DEV_RUN_ID]: devRunId,
        total_items: results.reduce((acc, r) => acc + r.items_seen, 0),
        total_rows_written: results.reduce((acc, r) => acc + r.rows_written, 0),
        total_rows_skipped: results.reduce((acc, r) => acc + r.rows_skipped, 0),
        error_count: results.filter((r) => r.status === 'failed').length,
      })
      renderRunResults({ results, devRunId, json: parsed.json, dryRun: parsed.dryRun, stdout: ctx.stdout })
      return deriveBackfillExitCode(results)
    },
    { component: 'backfill' }
  )
}

/**
 * `hyp backfill list [--json]`: enumerate every registered provider.
 *
 * Unlike `hyp backfill <provider...>`, list does NOT filter to the
 * active config; discovery is the whole point of the command, and a
 * later run may opt into an explicit provider name.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runBackfillList(argv, ctx) {
  const parsed = parseCoreCommandArgv('backfill list', argv, ctx)
  if (!parsed.ok) return parsed.code
  const json = parsed.params.json === true
  const providers = ctx.backfills.list()
  if (json) {
    ctx.stdout.write(
      JSON.stringify(
        {
          providers: providers.map((p) => ({
            name: p.name,
            plugin: p.plugin,
            datasets: p.datasets,
            summary: p.summary ?? '',
          })),
        },
        null,
        2
      ) + '\n'
    )
    return 0
  }
  if (providers.length === 0) {
    ctx.stdout.write('No backfill providers registered.\n')
    ctx.stdout.write(
      'No active plugin contributes a backfill provider. Check enabled plugins with `hyp daemon status`; if you just joined a fleet, the config may still be syncing.\n'
    )
    return 0
  }
  ctx.stdout.write('Backfill providers:\n')
  for (const provider of providers) {
    const datasets = provider.datasets.join(', ')
    ctx.stdout.write(`  ${provider.name}  (${provider.plugin})  -> ${datasets}\n`)
    if (provider.summary) {
      ctx.stdout.write(`    ${provider.summary}\n`)
    }
  }
  return 0
}

/**
 * Run a single registered backfill provider end-to-end and return a
 * compact result. Shares the exact scan → materialize → write → flush
 * path (and per-provider telemetry) as `hyp backfill <provider>`, so
 * rows imported here land in the same per-source tables as live capture.
 *
 * Used by the onboarding finale to import a picked client's local
 * history right after the config is written. Unknown providers resolve
 * to a failed result (rather than throwing) so callers can render a
 * status line without a try/catch.
 *
 * @param {{
 *   ctx: BackfillRunnerContext,
 *   provider: string,
 *   dryRun: boolean,
 *   retentionDays?: number,
 *   since?: string,
 *   until?: string,
 *   devRunId?: string,
 *   sweep?: boolean,
 * }} args
 * @returns {Promise<{ ok: boolean, scanned: number, rowsWritten: number, skipped: number, errorKind?: string }>}
 */
export async function runBackfillProvider(args) {
  const { ctx, provider: providerName, dryRun } = args
  const contribution = ctx.backfills.get(providerName)
  if (!contribution) {
    return { ok: false, scanned: 0, rowsWritten: 0, skipped: 0 }
  }
  const devRunId = args.devRunId ?? ctx.env.DEV_RUN_ID ?? `bf-${randomUUID()}`
  const result = await runProvider({
    provider: contribution,
    ctx,
    devRunId,
    retentionDays: args.retentionDays,
    since: args.since,
    until: args.until,
    dryRun,
    sweep: args.sweep,
  })
  return {
    ok: result.status === 'ok',
    scanned: result.items_seen,
    rowsWritten: result.rows_written,
    skipped: result.rows_skipped,
    ...(result.error_kind ? { errorKind: result.error_kind } : {}),
  }
}

/* ------------------------------- Internals ------------------------------- */

/**
 * @param {BackfillProviderResult[]} results
 * @returns {number}
 */
function deriveBackfillExitCode(results) {
  return results.some((result) => result.status === 'failed') ? 1 : 0
}

/**
 * Record the first failure of a run and the step it came from. The kind is
 * taken here rather than derived at the `backfill.provider_finish` span,
 * which can see only that something failed (issue #2255).
 *
 * @param {BackfillProviderResult} result
 * @param {string} error
 * @param {string} errorKind
 */
function markProviderFailed(result, error, errorKind) {
  result.status = 'failed'
  result.error ??= error
  result.error_kind ??= errorKind
}

/**
 * Fail one yielded item on a path that does not throw, and tell the provider
 * its rows did not land before resuming its generator. A provider that
 * recorded per-input progress on resume would otherwise mark the input done
 * against rows nothing wrote. A throwing write needs no signal: it aborts the
 * run before the generator resumes.
 *
 * @ref LLP 0359#file-fingerprints [constrained-by]: the provider's skip map is
 *   process-local and not durable, so an item the runner drops needs a signal
 *   before the generator resumes
 * @param {BackfillRunContext} runCtx
 * @param {BackfillProviderResult} result
 * @param {string} error
 * @param {string} errorKind
 */
function markItemFailed(runCtx, result, error, errorKind) {
  markProviderFailed(result, error, errorKind)
  runCtx.itemsFailed = (runCtx.itemsFailed ?? 0) + 1
}

/**
 * Run a single provider end-to-end: scan -> materialize -> write -> flush.
 * Emits `backfill.provider_*` / `backfill.scan` / `backfill.materialize`
 * / `backfill.write` / `backfill.flush` lifecycle spans, all carrying
 * `dev_run_id` and `provider`. Failures abort the provider but do not
 * abort sibling providers; the runner walks them sequentially.
 *
 * @param {{
 *   provider: BackfillContribution,
 *   ctx: BackfillRunnerContext,
 *   devRunId: string,
 *   retentionDays: number | undefined,
 *   since: string | undefined,
 *   until: string | undefined,
 *   dryRun: boolean,
 *   sweep?: boolean,
 * }} args
 * @returns {Promise<BackfillProviderResult>}
 */
async function runProvider(args) {
  const { provider, ctx, devRunId, retentionDays, since, until, dryRun, sweep } = args
  /** @type {BackfillProviderResult} */
  const result = {
    provider: provider.name,
    plugin: provider.plugin,
    datasets: provider.datasets.slice(),
    items_seen: 0,
    rows_written: 0,
    rows_skipped: 0,
    sessions_seen: 0,
    status: 'ok',
  }

  const log = createProviderLogger(provider.name, devRunId)
  const datasetsTouched = new Set()
  // One opaque identity per provider invocation. Dataset materializers may
  // keep in-run state in a WeakMap without keying it on a reusable diagnostic
  // string or retaining it after this invocation becomes unreachable.
  // @ref LLP 0359#bounded-dedupe [implements]: concurrent/nested runs get
  //   isolated, automatically collectible materializer state
  const runToken = {}

  return withSpan(
    'backfill.provider_start',
    {
      [Attr.COMPONENT]: 'backfill',
      [Attr.OPERATION]: 'backfill.provider_start',
      [Attr.PLUGIN]: provider.plugin,
      [Attr.DEV_RUN_ID]: devRunId,
      provider: provider.name,
      dry_run: dryRun,
      status: 'ok',
    },
    async () => {
      // Which client owns which transcript `entrypoint`, and whether that
      // client is configured. Built here rather than inside a provider because
      // the answer needs the FULL catalog (a claiming plugin is typically NOT
      // active, which is exactly the case that closes the gate) plus the
      // effective plugin list, neither of which the plugin activation context
      // carries. Best-effort: an empty map means every session imports, i.e.
      // the pre-gate behavior.
      // @ref LLP 0140#manifest-declares-ownership [implements]: the runner resolves entrypoint ownership from the catalog and hands providers the resolved map
      const owners = await resolveOwnersForRun(ctx, log)

      // A detached client is not recorded, by the sweep or by anything else
      // that runs its provider. A provider that classifies sessions by
      // transcript entrypoint (Claude's, which also carries Desktop) runs on:
      // its classifier drops the detached client's sessions one by one, so a
      // still-recording client sharing the tree keeps its lane.
      // @ref LLP 0464#runner-gate [implements]: the runner, not each plugin, skips a detached client's provider
      if (owners.providerDetached?.(provider) === true) {
        log.info('backfill.provider_not_recording', {
          [Attr.COMPONENT]: 'backfill',
          [Attr.OPERATION]: 'backfill.provider_start',
          [Attr.PLUGIN]: provider.plugin,
          provider: provider.name,
          reason: 'client_detached',
          status: 'ok',
        })
        return result
      }

      const runCtx = buildRunContext({
        env: ctx.env,
        storage: ctx.storage,
        retentionDays,
        since,
        until,
        dryRun,
        sweep,
        log,
        entrypointOwners: owners.entrypointOwners,
        isPluginConfigured: owners.isPluginConfigured,
        isPluginDetached: owners.isPluginDetached,
      })

      try {
        for await (const yielded of provider.run(runCtx)) {
          if (isEvent(yielded)) {
            handleEvent({ provider: provider.name, devRunId, event: yielded, log, result })
            continue
          }
          if (!isItem(yielded)) {
            log.warn('backfill.invalid_yield', {
              [Attr.COMPONENT]: 'backfill',
              provider: provider.name,
              reason: 'unrecognized_shape',
            })
            continue
          }
          result.items_seen += 1
          datasetsTouched.add(yielded.dataset)

          const materializer = ctx.backfillMaterializers.get(yielded.kind)
          if (!materializer) {
            log.warn('backfill.materializer_missing', {
              [Attr.COMPONENT]: 'backfill',
              provider: provider.name,
              kind: yielded.kind,
              [Attr.DATASET]: yielded.dataset,
            })
            markItemFailed(runCtx, result, `missing materializer for kind ${yielded.kind}`, 'materializer_missing')
            result.rows_skipped += 1
            continue
          }
          if (materializer.dataset !== yielded.dataset) {
            log.warn('backfill.dataset_mismatch', {
              [Attr.COMPONENT]: 'backfill',
              provider: provider.name,
              kind: yielded.kind,
              [Attr.DATASET]: yielded.dataset,
              materializer_dataset: materializer.dataset,
            })
            markItemFailed(
              runCtx,
              result,
              `materializer for kind ${yielded.kind} targets dataset ${materializer.dataset}, not ${yielded.dataset}`,
              'dataset_mismatch'
            )
            result.rows_skipped += 1
            continue
          }

          if (dryRun) {
            // Dry-run accounts items in `sessions_seen` so the summary
            // stays useful, but skips materialize/write/flush.
            result.sessions_seen += 1
            continue
          }

          const rows = await materializeItem({
            materializer,
            item: yielded,
            ctx,
            devRunId,
            provider: provider.name,
            log,
            runToken,
            sweep,
          })
          if (!Array.isArray(rows) || (rows.length === 0 && !yielded.reconcile)) {
            result.rows_skipped += 1
            continue
          }
          result.sessions_seen += 1
          const written = await writeRows({
            rows,
            dataset: yielded.dataset,
            reconcile: yielded.reconcile,
            provider: provider.name,
            devRunId,
            ctx,
            log,
          })
          result.rows_written += written.rowsWritten
          if (written.status === 'failed') {
            markItemFailed(runCtx, result, written.error ?? `failed to write dataset ${yielded.dataset}`, 'dataset_not_registered')
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        markProviderFailed(result, message, 'provider_run_failed')
        log.error('backfill.provider_error', {
          [Attr.COMPONENT]: 'backfill',
          provider: provider.name,
          error_kind: 'provider_run_failed',
          error: message,
        })
      }

      // Outside the scan's try, so a provider that throws mid-stream still
      // makes the rows it already appended queryable instead of leaving them
      // invisible until some later natural flush. The provider is already
      // marked failed, and `markProviderFailed` keeps the first error, so a
      // throwing flush cannot mask the provider's.
      //
      // The guard is per dataset, not around the loop: a provider may touch
      // several datasets, and aborting at the first failing one would strand
      // the rest behind it in exactly the delayed-visibility state this flush
      // exists to prevent.
      // @ref LLP 0333#every-table-before-failure [constrained-by]: every
      //   touched table gets its forced-flush attempt before the failure is
      //   declared; strictness constrains the outcome, not the abort order
      if (!dryRun) {
        for (const dataset of datasetsTouched) {
          try {
            await flushDataset({
              dataset,
              provider: provider.name,
              devRunId,
              ctx,
              log,
            })
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            markProviderFailed(result, message, 'flush_failed')
            log.error('backfill.flush_error', {
              [Attr.COMPONENT]: 'backfill',
              provider: provider.name,
              [Attr.DATASET]: dataset,
              error_kind: 'flush_failed',
              error: message,
            })
          }
        }
      }

      const finalStatus = result.status === 'ok' ? 'ok' : 'failed'
      await withSpan(
        'backfill.provider_finish',
        {
          [Attr.COMPONENT]: 'backfill',
          [Attr.OPERATION]: 'backfill.provider_finish',
          [Attr.PLUGIN]: provider.plugin,
          [Attr.DEV_RUN_ID]: devRunId,
          provider: provider.name,
          items_seen: result.items_seen,
          rows_written: result.rows_written,
          rows_skipped: result.rows_skipped,
          sessions_seen: result.sessions_seen,
          status: finalStatus,
          ...(result.error_kind ? { error_kind: result.error_kind } : {}),
        },
        async () => {},
        { component: 'backfill' }
      )

      return result
    },
    { component: 'backfill' }
  )
}

/**
 * @param {{
 *   materializer: BackfillMaterializerContribution,
 *   item: BackfillItem,
 *   ctx: BackfillRunnerContext,
 *   devRunId: string,
 *   provider: string,
 *   log: PluginLogger,
 *   runToken: object,
 *   sweep: boolean | undefined,
 * }} args
 */
async function materializeItem(args) {
  const { materializer, item, ctx, devRunId, provider, log, runToken, sweep } = args
  return withSpan(
    'backfill.materialize',
    {
      [Attr.COMPONENT]: 'backfill',
      [Attr.OPERATION]: 'backfill.materialize',
      [Attr.PLUGIN]: materializer.plugin,
      [Attr.DEV_RUN_ID]: devRunId,
      [Attr.DATASET]: materializer.dataset,
      provider,
      kind: item.kind,
      ...(item.provenance?.client_name ? { client_name: item.provenance.client_name } : {}),
      status: 'ok',
    },
    async () => {
      const rows = await materializer.materialize(item, {
        env: ctx.env,
        log,
        storage: ctx.storage,
        devRunId,
        runToken,
        ...(sweep !== undefined ? { sweep } : {}),
      })
      return rows ?? []
    },
    { component: 'backfill' }
  )
}

/**
 * Append rows to the dataset's intrinsic cache table. The runner
 * resolves the table path via the kernel `QueryRegistry`. Datasets
 * without a registered table path are logged and skipped; provider
 * authors should not yield items for unregistered datasets.
 *
 * @param {{
 *   rows: Record<string, unknown>[],
 *   reconcile?: BackfillItem['reconcile'],
 *   dataset: string,
 *   provider: string,
 *   devRunId: string,
 *   ctx: BackfillRunnerContext,
 *   log: PluginLogger,
 * }} args
 * @returns {Promise<{ rowsWritten: number, status: 'ok' | 'failed', error?: string }>}
 */
async function writeRows(args) {
  const { rows, dataset, provider, devRunId, ctx, log } = args
  return withSpan(
    'backfill.write',
    {
      [Attr.COMPONENT]: 'backfill',
      [Attr.OPERATION]: 'backfill.write',
      [Attr.DEV_RUN_ID]: devRunId,
      [Attr.DATASET]: dataset,
      provider,
      row_count: rows.length,
      status: 'ok',
    },
    async () => {
      const registered = ctx.query.getDataset?.(dataset)
      if (!registered) {
        log.warn('backfill.dataset_not_registered', {
          [Attr.COMPONENT]: 'backfill',
          provider,
          [Attr.DATASET]: dataset,
        })
        return {
          rowsWritten: 0,
          status: 'failed',
          error: `dataset not registered: ${dataset}`,
        }
      }
      // `appendRows` derives the dataset from the path and re-routes
      // rows into per-source partitions via the registered
      // `cachePartitioning` declaration; the same write path the live
      // gateway recorder uses. We only need a dataset-attributable base
      // path plus the dataset's schema columns.
      const tablePath = ctx.storage.cacheTablePath(dataset, [BACKFILL_PARTITION_SEGMENT])
      const schemaColumns = registered.schema?.columns ?? []
      if (args.reconcile) {
        if (!ctx.storage.reconcileRows) throw new Error('This capture requires local snapshot reconciliation support')
        const count = await ctx.storage.reconcileRows(dataset, schemaColumns, rows, args.reconcile)
        return { rowsWritten: count, status: 'ok' }
      }
      await ctx.storage.appendRows(tablePath, schemaColumns, rows)
      return { rowsWritten: rows.length, status: 'ok' }
    },
    { component: 'backfill' }
  )
}

/**
 * Flush each touched dataset so `hyp query` immediately sees the
 * imported rows. Storage layers without an explicit flush helper get
 * a logged skip; append still committed to the spool path.
 *
 * @param {{
 *   dataset: string,
 *   provider: string,
 *   devRunId: string,
 *   ctx: BackfillRunnerContext,
 *   log: PluginLogger,
 * }} args
 */
async function flushDataset(args) {
  const { dataset, provider, devRunId, ctx, log } = args
  await withSpan(
    'backfill.flush',
    {
      [Attr.COMPONENT]: 'backfill',
      [Attr.OPERATION]: 'backfill.flush',
      [Attr.DEV_RUN_ID]: devRunId,
      [Attr.DATASET]: dataset,
      provider,
      status: 'ok',
    },
    async () => {
      const registered = ctx.query.getDataset?.(dataset)
      // `flushTable` lives on the extended storage service, not the
      // public `QueryStorageService` surface; feature-detect it. The
      // flushed path must match the base path `writeRows` appended to
      // so the same spool bucket is committed.
      /** @type {any} */
      const storage = ctx.storage
      if (registered && typeof storage?.flushTable === 'function') {
        const tablePath = storage.cacheTablePath(dataset, [BACKFILL_PARTITION_SEGMENT])
        await storage.flushTable(tablePath, { force: true, reason: `backfill:${provider}` })
      } else {
        log.info('backfill.flush_skipped', {
          [Attr.COMPONENT]: 'backfill',
          provider,
          [Attr.DATASET]: dataset,
        })
      }
    },
    { component: 'backfill' }
  )
}

/**
 * @param {{
 *   provider: string,
 *   devRunId: string,
 *   event: BackfillEvent,
 *   log: PluginLogger,
 *   result: BackfillProviderResult,
 * }} args
 */
function handleEvent(args) {
  const { provider, devRunId, event, log, result } = args
  if (event.event === 'scan_started' || event.event === 'scan') {
    const sessions = Number(event.attributes?.sessions_seen)
    if (Number.isFinite(sessions)) result.sessions_seen += sessions
    log.info('backfill.scan', {
      [Attr.COMPONENT]: 'backfill',
      [Attr.DEV_RUN_ID]: devRunId,
      provider,
      ...(event.attributes ?? {}),
    })
    return
  }
  log.info(`backfill.event.${event.event}`, {
    [Attr.COMPONENT]: 'backfill',
    [Attr.DEV_RUN_ID]: devRunId,
    provider,
    ...(event.attributes ?? {}),
  })
}

/**
 * @param {{
 *   env: NodeJS.ProcessEnv,
 *   storage: CommandRunContext['storage'],
 *   retentionDays?: number,
 *   since?: string,
 *   until?: string,
 *   dryRun: boolean,
 *   sweep?: boolean,
 *   log: PluginLogger,
 *   entrypointOwners?: EntrypointOwners,
 *   isPluginConfigured?: (plugin: PluginName) => boolean,
 *   isPluginDetached?: (plugin: PluginName) => boolean,
 * }} args
 * @returns {BackfillRunContext}
 */
function buildRunContext(args) {
  /** @type {BackfillRunContext} */
  return {
    env: args.env,
    storage: args.storage,
    cacheRoot: args.storage.cacheRoot,
    ...(args.since !== undefined ? { since: args.since } : {}),
    ...(args.until !== undefined ? { until: args.until } : {}),
    ...(args.retentionDays !== undefined ? { retentionDays: args.retentionDays } : {}),
    ...(args.entrypointOwners !== undefined ? { entrypointOwners: args.entrypointOwners } : {}),
    ...(args.isPluginConfigured !== undefined ? { isPluginConfigured: args.isPluginConfigured } : {}),
    ...(args.isPluginDetached !== undefined ? { isPluginDetached: args.isPluginDetached } : {}),
    ...(args.sweep !== undefined ? { sweep: args.sweep } : {}),
    dryRun: args.dryRun,
    itemsFailed: 0,
    log: args.log,
  }
}

/**
 * Resolve the entrypoint-ownership map for one provider run, plus
 * the configured-plugin predicate it was built with. The predicate travels
 * separately because container-root admission keys on it alone: an owners
 * map only has entries for plugins that declare `transcript_entrypoints`
 * values, and a container-owning plugin must not need any value claim to
 * import its own container (LLP 0140#container-root-owns).
 *
 * Best-effort by design: catalog discovery already degrades to empty in
 * `loadClientDescriptors`, and a failure here must not fail a backfill. An
 * empty map imports everything from the scanning client's own tree, which
 * is the behavior that shipped before the gate existed, and the absent
 * predicate closes the container gate, which is the behavior before the
 * container was scanned at all. Degrading never captures MORE than
 * intended.
 *
 * @param {BackfillRunnerContext} ctx
 * @param {PluginLogger} log
 * A detached client (`recording: false`, LLP 0464) counts as not configured
 * here, so its claimed entrypoints and its container close exactly the way an
 * unconfigured client's do. The switch is read fresh, so a daemon that booted
 * before the detach honors it on its next run.
 *
 * @returns {Promise<{ entrypointOwners: EntrypointOwners, isPluginConfigured?: (plugin: PluginName) => boolean, isPluginDetached?: (plugin: PluginName) => boolean, providerDetached?: (provider: BackfillContribution) => boolean }>}
 */
async function resolveOwnersForRun(ctx, log) {
  try {
    const { stateDir, hypHome } = readObservabilityEnv(ctx.env)
    const descriptors = await loadClientDescriptors({ stateDir })
    const configured = await resolveConfiguredPlugins(ctx, hypHome)
    const { detached } = await readRecordingStateFromDisk({ env: ctx.env })
    /** @param {PluginName} plugin */
    const isPluginConfigured = (plugin) => configured.has(plugin) && !detached.has(plugin)
    /** @param {BackfillContribution} provider */
    const providerDetached = (provider) => {
      if (!detached.has(provider.plugin)) return false
      const own = descriptors.get(provider.name)
      return !(own?.plugin === provider.plugin && (own.transcriptEntrypoints?.length ?? 0) > 0)
    }
    return {
      entrypointOwners: resolveEntrypointOwners(descriptors.values(), isPluginConfigured),
      isPluginConfigured,
      /** @param {PluginName} plugin */
      isPluginDetached: (plugin) => detached.has(plugin),
      providerDetached,
    }
  } catch (err) {
    log.warn('backfill.entrypoint_owners_unavailable', {
      [Attr.COMPONENT]: 'backfill',
      [Attr.ERROR_KIND]: 'catalog_unavailable',
      error: err instanceof Error ? err.message : String(err),
    })
    return { entrypointOwners: new Map() }
  }
}

/**
 * The plugin names that count as "configured" for the entrypoint gate.
 *
 * The durable record of a client opt-in is the config document, not this
 * process's activation set. Reading only `ctx.plugins` made the gate
 * permanently closed on the one path where the opt-in actually happens:
 * `hyp init` boots the `all-available` profile, which by construction
 * omits every `V1_EXCLUDED_FROM_DEFAULT` plugin (`@hypaware/claude-desktop`
 * among them), and the picker cannot change an activation set that was
 * fixed at process start. So a user who selected Claude Desktop could get the
 * transcript plugins written to config and then have Desktop history silently
 * gated out of the finale's own backfill.
 * That contradicts LLP 0139's "works end to end" and
 * LLP 0140#manifest-declares-ownership, which says the *effective plugin
 * list*, not the activated one.
 *
 * Three sources, unioned, because each covers a case the others miss:
 * the activation set (an injected kernel whose config lives in memory),
 * `ctx.config` (a fleet host, where the central layer is already merged),
 * and a fresh read of the local document (the picker wrote it after boot).
 * Unioning fails open, which is the direction LLP 0140#fail-open-on-unknown
 * already chose for an ambiguous ownership answer.
 *
 * The local read is deliberately not `loadConfigFile`: this is a
 * membership probe, and a host with no config document is an ordinary
 * state for it, not the `config.load_failed` error row that helper emits.
 *
 * @ref LLP 0140#manifest-declares-ownership [implements]: "configured" is membership of the effective config, read fresh, not of the boot profile's activation set
 * @ref LLP 0172#lane-b-sweep [constrained-by]: `ctx.plugins` stays optional
 * here (rather than `CommandRunContext`'s required array) so this helper
 * keeps working unchanged under `resolveOwnersForRun`'s narrowed
 * `BackfillRunnerContext`, which carries no activation set; the union
 * already treats an absent source as "answers nothing," so a caller with
 * no `plugins` field degrades to the other two sources, not a type error.
 * @param {Pick<CommandRunContext, 'config' | 'env'> & { plugins?: CommandRunContext['plugins'] }} ctx
 * @param {string} hypHome
 * @returns {Promise<Set<string>>}
 */
async function resolveConfiguredPlugins(ctx, hypHome) {
  /** @type {Set<string>} */
  const names = new Set()
  for (const active of ctx.plugins ?? []) names.add(active.name)
  addEnabledPluginNames(names, ctx.config)
  try {
    const raw = await fsp.readFile(resolveConfigPath({ env: ctx.env, hypHome }), 'utf8')
    addEnabledPluginNames(names, JSON.parse(raw))
  } catch {
    // No readable local document (never written, or mid-write). The other
    // two sources still answer; an unreadable file must not widen or
    // narrow the gate on its own.
  }
  return names
}

/**
 * Add every `enabled !== false` plugin name in a config document to `names`.
 * Tolerant of an arbitrary parsed object: the local document is read raw
 * here, so it has not been through the schema validator.
 *
 * @param {Set<string>} names
 * @param {unknown} config
 */
function addEnabledPluginNames(names, config) {
  const plugins = /** @type {{ plugins?: unknown }} */ (config ?? {})?.plugins
  if (!Array.isArray(plugins)) return
  for (const entry of plugins) {
    if (!entry || typeof entry !== 'object') continue
    const { name, enabled } = /** @type {{ name?: unknown, enabled?: unknown }} */ (entry)
    if (typeof name !== 'string' || name.length === 0 || enabled === false) continue
    names.add(name)
  }
}

/**
 * @param {string} provider
 * @param {string} devRunId
 * @returns {PluginLogger}
 */
function createProviderLogger(provider, devRunId) {
  const base = getLogger('backfill')
  /** @param {Record<string, unknown> | undefined} fields */
  function stamp(fields) {
    return {
      ...(fields ?? {}),
      [Attr.COMPONENT]: 'backfill',
      [Attr.DEV_RUN_ID]: devRunId,
      provider,
    }
  }
  return {
    debug(message, fields) { base.debug(message, stamp(fields)) },
    info(message, fields)  { base.info(message,  stamp(fields)) },
    warn(message, fields)  { base.warn(message,  stamp(fields)) },
    error(message, fields) { base.error(message, stamp(fields)) },
  }
}

/**
 * Provider selection rules:
 *
 * - If the caller named one or more providers, return the intersection
 *   of named ∩ registered. Names that don't match a registered provider
 *   surface in `unknown` so the CLI can fail with a clear message.
 * - If the caller named nothing, return only providers whose owning
 *   plugin appears in `config.plugins`. This protects users from
 *   importing history for plugins they haven't enabled.
 *
 * @param {{
 *   requested: string[],
 *   available: BackfillContribution[],
 *   activePlugins: Array<{ name?: string, enabled?: boolean }>,
 * }} args
 * @returns {{ providers: BackfillContribution[], unknown: string[] }}
 */
export function selectProviders(args) {
  const byName = new Map(args.available.map((p) => [p.name, p]))
  if (args.requested.length > 0) {
    /** @type {BackfillContribution[]} */
    const providers = []
    /** @type {string[]} */
    const unknown = []
    for (const name of args.requested) {
      const found = byName.get(name)
      if (found) providers.push(found)
      else unknown.push(name)
    }
    return { providers, unknown }
  }
  const enabledPlugins = new Set(
    args.activePlugins
      .filter((p) => p && p.enabled !== false)
      .map((p) => p.name)
      .filter((name) => typeof name === 'string' && name.length > 0)
  )
  const providers = args.available.filter((p) => enabledPlugins.has(p.plugin))
  return { providers, unknown: [] }
}

/**
 * Resolve the effective retention window in days.
 *
 * Precedence:
 *  1. Explicit `--retention-days <n>` flag.
 *  2. `config.query.cache.retention.default_days`.
 *  3. `DEFAULT_RETENTION_DAYS`.
 *
 * @param {{ flag?: number, config: CommandRunContext['config'] }} args
 * @returns {number}
 */
export function resolveRetentionDays(args) {
  if (typeof args.flag === 'number' && Number.isFinite(args.flag) && args.flag >= 0) return args.flag
  const configured = args.config?.query?.cache?.retention?.default_days
  if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 0) return configured
  return DEFAULT_RETENTION_DAYS
}

/**
 * Parse `hyp backfill ...` argv. Accepts:
 *
 *  - Positional provider names (any order, before/after flags).
 *  - `--since <iso>` / `--since=<iso>`
 *  - `--until <iso>` / `--until=<iso>`
 *  - `--retention-days <n>` / `--retention-days=<n>`
 *  - `--dry-run`
 *  - `--json`
 *
 * @param {string[]} argv
 * @returns {{
 *   providers: string[],
 *   since?: string,
 *   until?: string,
 *   retentionDays?: number,
 *   dryRun: boolean,
 *   json: boolean,
 *   error?: undefined,
 * } | { error: string }}
 */
export function parseRunArgv(argv) {
  const parsed = parseCommandArgv(argv, {
    type: 'object',
    properties: {
      providers: { type: 'array', greedy: true },
      since: { type: 'string' },
      until: { type: 'string' },
      'retention-days': { type: 'number', minimum: 0 },
      'dry-run': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
    positional: ['providers'],
  }, STRICT_SHORT_FLAGS)
  if ('help' in parsed) {
    return { error: 'usage: hyp backfill [provider...] [--since <iso>] [--until <iso>] [--retention-days <n>] [--dry-run] [--json]' }
  }
  if (!parsed.ok) return { error: parsed.error }
  const p = /** @type {{ providers?: string[], since?: string, until?: string, 'retention-days'?: number, 'dry-run': boolean, json: boolean }} */ (parsed.params)

  /** @type {number | undefined} */
  let sinceMs
  if (p.since !== undefined) {
    sinceMs = Date.parse(p.since)
    if (Number.isNaN(sinceMs)) {
      return { error: `--since expects a parseable date (got ${p.since})` }
    }
  }

  /** @type {number | undefined} */
  let untilMs
  if (p.until !== undefined) {
    untilMs = Date.parse(p.until)
    if (Number.isNaN(untilMs)) {
      return { error: `--until expects a parseable date (got ${p.until})` }
    }
  }

  if (sinceMs !== undefined && untilMs !== undefined && sinceMs > untilMs) {
    return { error: `--since must be before or equal to --until (got ${p.since} > ${p.until})` }
  }

  /** @type {{ providers: string[], since?: string, until?: string, retentionDays?: number, dryRun: boolean, json: boolean }} */
  const result = { providers: p.providers ?? [], dryRun: p['dry-run'], json: p.json }
  if (p.since !== undefined) result.since = p.since
  if (p.until !== undefined) result.until = p.until
  if (p['retention-days'] !== undefined) result.retentionDays = p['retention-days']
  return result
}

/**
 * @param {{
 *   results: BackfillProviderResult[],
 *   devRunId: string,
 *   json: boolean,
 *   dryRun: boolean,
 *   stdout: { write(chunk: string): unknown },
 * }} args
 */
function renderRunResults(args) {
  const { results, devRunId, json, dryRun, stdout } = args
  if (json) {
    stdout.write(
      JSON.stringify(
        {
          run_id: devRunId,
          dry_run: dryRun,
          providers: results.map((r) => ({
            provider: r.provider,
            plugin: r.plugin,
            datasets: r.datasets,
            status: r.status,
            items_seen: r.items_seen,
            sessions_seen: r.sessions_seen,
            rows_written: r.rows_written,
            rows_skipped: r.rows_skipped,
            ...(r.error ? { error: r.error } : {}),
          })),
        },
        null,
        2
      ) + '\n'
    )
    return
  }
  stdout.write(`backfill ${dryRun ? '(dry-run) ' : ''}run_id=${devRunId}\n`)
  for (const r of results) {
    stdout.write(`  ${r.provider}  [${r.status}]\n`)
    stdout.write(`    items_seen=${r.items_seen}  sessions=${r.sessions_seen}  rows_written=${r.rows_written}  rows_skipped=${r.rows_skipped}\n`)
    if (r.error) stdout.write(`    error: ${r.error}\n`)
  }
}

/** @param {unknown} v @returns {v is BackfillItem} */
function isItem(v) {
  if (!v || typeof v !== 'object') return false
  const o = /** @type {Record<string, unknown>} */ (v)
  if (o.type !== undefined && o.type !== 'item') return false
  return typeof o.dataset === 'string' && typeof o.kind === 'string' && o.value !== undefined
}

/** @param {unknown} v @returns {v is BackfillEvent} */
function isEvent(v) {
  if (!v || typeof v !== 'object') return false
  const o = /** @type {Record<string, unknown>} */ (v)
  return o.type === 'event' && typeof o.event === 'string'
}
