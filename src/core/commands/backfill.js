// @ts-check

import { randomUUID } from 'node:crypto'

import { Attr, getLogger, withSpan } from '../observability/index.js'
import { DEFAULT_RETENTION_DAYS } from '../cache/retention.js'

/**
 * Base partition segment for backfilled writes. `storage.appendRows`
 * re-routes each row to its real source partition using the dataset's
 * registered `cachePartitioning` declaration, so this segment only
 * names the spool bucket and the dataset-attribution path — it keeps
 * backfill spool state distinct from the live capture spool while
 * landing rows in the exact same per-source Iceberg tables.
 */
const BACKFILL_PARTITION_SEGMENT = 'backfill'

/**
 * @import { BackfillContribution, BackfillItem, BackfillEvent, BackfillMaterializerContribution, BackfillPlan, BackfillPlanContext, BackfillRunContext, CommandRunContext, PluginLogger } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { BackfillProviderResult } from './types.d.ts'
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
    } else {
      ctx.stdout.write('No backfill providers selected. Run `hyp backfill list` for the registered set.\n')
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
 * `hyp backfill list [--json]` — enumerate every registered provider.
 *
 * Unlike `hyp backfill <provider...>`, list does NOT filter to the
 * active config — discovery is the whole point of the command, and a
 * later run may opt into an explicit provider name.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runBackfillList(argv, ctx) {
  const json = argv.includes('--json')
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
 * `hyp backfill plan [provider...] [--retention-days <n>] [--json]`
 *
 * Calls each selected provider's `plan()` hook (if present) and prints
 * the consolidated plan. Providers without a `plan()` implementation
 * are listed but contribute no plan body.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
export async function runBackfillPlan(argv, ctx) {
  const parsed = parsePlanArgv(argv)
  if (parsed.error !== undefined) {
    ctx.stderr.write(`hyp backfill plan: ${parsed.error}\n`)
    return 2
  }

  const devRunId = ctx.env.DEV_RUN_ID ?? `bf-${randomUUID()}`
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
      `hyp backfill plan: unknown provider(s): ${selected.unknown.join(', ')}\n`
    )
    return 1
  }

  return withSpan(
    'backfill.plan',
    {
      [Attr.COMPONENT]: 'backfill',
      [Attr.OPERATION]: 'backfill.plan',
      [Attr.DEV_RUN_ID]: devRunId,
      provider_count: selected.providers.length,
      retention_days: retentionDays ?? 0,
      status: 'ok',
    },
    async () => {
      /** @type {Array<{ provider: string, plugin: string, datasets: string[], plan: BackfillPlan | undefined }>} */
      const results = []
      for (const provider of selected.providers) {
        if (typeof provider.plan !== 'function') {
          results.push({ provider: provider.name, plugin: provider.plugin, datasets: provider.datasets, plan: undefined })
          continue
        }
        const planCtx = buildPlanContext({
          env: ctx.env,
          storage: ctx.storage,
          retentionDays,
        })
        try {
          const plan = await provider.plan(planCtx)
          results.push({
            provider: provider.name,
            plugin: provider.plugin,
            datasets: provider.datasets,
            plan,
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          ctx.stderr.write(`hyp backfill plan: ${provider.name}: ${message}\n`)
          results.push({
            provider: provider.name,
            plugin: provider.plugin,
            datasets: provider.datasets,
            plan: undefined,
          })
        }
      }
      if (parsed.json) {
        ctx.stdout.write(JSON.stringify({ run_id: devRunId, providers: results }, null, 2) + '\n')
      } else {
        renderPlanText({ results, retentionDays, stdout: ctx.stdout })
      }
      return 0
    },
    { component: 'backfill' }
  )
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
 *   ctx: CommandRunContext,
 *   provider: string,
 *   dryRun: boolean,
 *   retentionDays?: number,
 *   since?: string,
 *   until?: string,
 *   devRunId?: string,
 * }} args
 * @returns {Promise<{ ok: boolean, scanned: number, rowsWritten: number, skipped: number }>}
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
  })
  return {
    ok: result.status === 'ok',
    scanned: result.items_seen,
    rowsWritten: result.rows_written,
    skipped: result.rows_skipped,
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
 * @param {BackfillProviderResult} result
 * @param {string} error
 */
function markProviderFailed(result, error) {
  result.status = 'failed'
  result.error ??= error
}

/**
 * Run a single provider end-to-end: scan -> materialize -> write -> flush.
 * Emits `backfill.provider_*` / `backfill.scan` / `backfill.materialize`
 * / `backfill.write` / `backfill.flush` lifecycle spans, all carrying
 * `dev_run_id` and `provider`. Failures abort the provider but do not
 * abort sibling providers — the runner walks them sequentially.
 *
 * @param {{
 *   provider: BackfillContribution,
 *   ctx: CommandRunContext,
 *   devRunId: string,
 *   retentionDays: number | undefined,
 *   since: string | undefined,
 *   until: string | undefined,
 *   dryRun: boolean,
 * }} args
 * @returns {Promise<BackfillProviderResult>}
 */
async function runProvider(args) {
  const { provider, ctx, devRunId, retentionDays, since, until, dryRun } = args
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
      const runCtx = buildRunContext({
        env: ctx.env,
        storage: ctx.storage,
        retentionDays,
        since,
        until,
        dryRun,
        log,
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
            markProviderFailed(result, `missing materializer for kind ${yielded.kind}`)
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
            markProviderFailed(
              result,
              `materializer for kind ${yielded.kind} targets dataset ${materializer.dataset}, not ${yielded.dataset}`
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
          })
          if (!Array.isArray(rows) || rows.length === 0) {
            result.rows_skipped += 1
            continue
          }
          result.sessions_seen += 1
          const written = await writeRows({
            rows,
            dataset: yielded.dataset,
            provider: provider.name,
            devRunId,
            ctx,
            log,
          })
          result.rows_written += written.rowsWritten
          if (written.status === 'failed') {
            markProviderFailed(result, written.error ?? `failed to write dataset ${yielded.dataset}`)
          }
        }

        if (!dryRun) {
          for (const dataset of datasetsTouched) {
            await flushDataset({ dataset, provider: provider.name, devRunId, ctx, log })
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        markProviderFailed(result, message)
        log.error('backfill.provider_error', {
          [Attr.COMPONENT]: 'backfill',
          provider: provider.name,
          error_kind: 'provider_run_failed',
          error: message,
        })
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
          ...(result.error ? { error_kind: 'provider_run_failed' } : {}),
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
 *   ctx: CommandRunContext,
 *   devRunId: string,
 *   provider: string,
 *   log: PluginLogger,
 * }} args
 */
async function materializeItem(args) {
  const { materializer, item, ctx, devRunId, provider, log } = args
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
      })
      return rows ?? []
    },
    { component: 'backfill' }
  )
}

/**
 * Append rows to the dataset's intrinsic cache table. The runner
 * resolves the table path via the kernel `QueryRegistry`. Datasets
 * without a registered table path are logged and skipped — provider
 * authors should not yield items for unregistered datasets.
 *
 * @param {{
 *   rows: Record<string, unknown>[],
 *   dataset: string,
 *   provider: string,
 *   devRunId: string,
 *   ctx: CommandRunContext,
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
      // `cachePartitioning` declaration — the same write path the live
      // gateway recorder uses. We only need a dataset-attributable base
      // path plus the dataset's schema columns.
      const tablePath = ctx.storage.cacheTablePath(dataset, [BACKFILL_PARTITION_SEGMENT])
      const schemaColumns = registered.schema?.columns ?? []
      await ctx.storage.appendRows(tablePath, schemaColumns, rows)
      return { rowsWritten: rows.length, status: 'ok' }
    },
    { component: 'backfill' }
  )
}

/**
 * Flush each touched dataset so `hyp query` immediately sees the
 * imported rows. Storage layers without an explicit flush helper get
 * a logged skip — append still committed to the spool path.
 *
 * @param {{
 *   dataset: string,
 *   provider: string,
 *   devRunId: string,
 *   ctx: CommandRunContext,
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
      // public `QueryStorageService` surface — feature-detect it. The
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
 *   log: PluginLogger,
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
    dryRun: args.dryRun,
    log: args.log,
  }
}

/**
 * @param {{
 *   env: NodeJS.ProcessEnv,
 *   storage: CommandRunContext['storage'],
 *   retentionDays?: number,
 * }} args
 * @returns {BackfillPlanContext}
 */
function buildPlanContext(args) {
  /** @type {BackfillPlanContext} */
  return {
    env: args.env,
    cacheRoot: args.storage.cacheRoot,
    ...(args.retentionDays !== undefined ? { retentionDays: args.retentionDays } : {}),
    log: noopProviderLogger(),
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

/** @returns {PluginLogger} */
function noopProviderLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} }
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
  /** @type {string[]} */
  const providers = []
  /** @type {string | undefined} */
  let since
  /** @type {string | undefined} */
  let until
  /** @type {number | undefined} */
  let retentionDays
  let dryRun = false
  let json = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      return { error: 'usage: hyp backfill [provider...] [--since <iso>] [--until <iso>] [--retention-days <n>] [--dry-run] [--json]' }
    }
    if (arg === '--dry-run') { dryRun = true; continue }
    if (arg === '--json') { json = true; continue }

    const flagged = parseFlag(arg, argv, i)
    if (flagged.kind === 'consumed') {
      if (flagged.flag === 'since') since = flagged.value
      else if (flagged.flag === 'until') until = flagged.value
      else if (flagged.flag === 'retention-days') {
        const days = Number(flagged.value)
        if (!Number.isFinite(days) || days < 0) {
          return { error: `--retention-days expects a non-negative number (got ${flagged.value})` }
        }
        retentionDays = days
      }
      if (flagged.consumed > 1) i += flagged.consumed - 1
      continue
    }
    if (flagged.kind === 'error') return { error: flagged.error }
    if (arg.startsWith('--')) {
      return { error: `unknown flag '${arg}'` }
    }
    providers.push(arg)
  }

  /** @type {{ providers: string[], since?: string, until?: string, retentionDays?: number, dryRun: boolean, json: boolean }} */
  const result = { providers, dryRun, json }
  if (since !== undefined) result.since = since
  if (until !== undefined) result.until = until
  if (retentionDays !== undefined) result.retentionDays = retentionDays
  return result
}

/**
 * Parse `hyp backfill plan ...` argv. Same as the run argv except
 * `--since`, `--until`, and `--dry-run` are not accepted (plan does
 * not write rows; it just calls `plan()`).
 *
 * @param {string[]} argv
 * @returns {{
 *   providers: string[],
 *   retentionDays?: number,
 *   json: boolean,
 *   error?: undefined,
 * } | { error: string }}
 */
export function parsePlanArgv(argv) {
  /** @type {string[]} */
  const providers = []
  /** @type {number | undefined} */
  let retentionDays
  let json = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      return { error: 'usage: hyp backfill plan [provider...] [--retention-days <n>] [--json]' }
    }
    if (arg === '--json') { json = true; continue }
    const flagged = parseFlag(arg, argv, i)
    if (flagged.kind === 'consumed') {
      if (flagged.flag === 'retention-days') {
        const days = Number(flagged.value)
        if (!Number.isFinite(days) || days < 0) {
          return { error: `--retention-days expects a non-negative number (got ${flagged.value})` }
        }
        retentionDays = days
      } else if (flagged.flag === 'since' || flagged.flag === 'until') {
        return { error: `--${flagged.flag} is not valid on 'hyp backfill plan'` }
      }
      if (flagged.consumed > 1) i += flagged.consumed - 1
      continue
    }
    if (flagged.kind === 'error') return { error: flagged.error }
    if (arg.startsWith('--')) {
      return { error: `unknown flag '${arg}'` }
    }
    providers.push(arg)
  }

  /** @type {{ providers: string[], retentionDays?: number, json: boolean }} */
  const result = { providers, json }
  if (retentionDays !== undefined) result.retentionDays = retentionDays
  return result
}

/**
 * @param {string} arg
 * @param {string[]} argv
 * @param {number} i
 * @returns {{ kind: 'consumed', flag: 'since' | 'until' | 'retention-days', value: string, consumed: number }
 *   | { kind: 'pass' } | { kind: 'error', error: string }}
 */
function parseFlag(arg, argv, i) {
  const eqIdx = arg.indexOf('=')
  const head = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg
  const inline = eqIdx >= 0 ? arg.slice(eqIdx + 1) : undefined
  switch (head) {
  case '--since':
  case '--until':
  case '--retention-days': {
    const value = inline ?? argv[i + 1]
    if (value === undefined || (inline === undefined && value.startsWith('--'))) {
      return { kind: 'error', error: `flag ${head} requires a value` }
    }
    const flag = head === '--since' ? 'since' : head === '--until' ? 'until' : 'retention-days'
    return { kind: 'consumed', flag, value, consumed: inline !== undefined ? 1 : 2 }
  }
  default:
    return { kind: 'pass' }
  }
}

/**
 * @param {{
 *   results: Array<{ provider: string, plugin: string, datasets: string[], plan: BackfillPlan | undefined }>,
 *   retentionDays?: number,
 *   stdout: { write(chunk: string): unknown },
 * }} args
 */
function renderPlanText(args) {
  const { results, retentionDays, stdout } = args
  stdout.write(`backfill plan${retentionDays !== undefined ? ` (retention=${retentionDays}d)` : ''}\n`)
  if (results.length === 0) {
    stdout.write('  (no providers selected)\n')
    return
  }
  for (const entry of results) {
    stdout.write(`  ${entry.provider}  (${entry.plugin})  -> ${entry.datasets.join(', ')}\n`)
    const plan = entry.plan
    if (!plan) {
      stdout.write('    (provider did not return a plan)\n')
      continue
    }
    if (typeof plan.estimated_items === 'number') {
      stdout.write(`    estimated_items: ${plan.estimated_items}\n`)
    }
    if (Array.isArray(plan.sources)) {
      for (const src of plan.sources) {
        stdout.write(`    source: ${src}\n`)
      }
    }
    if (Array.isArray(plan.notes)) {
      for (const note of plan.notes) {
        stdout.write(`    note: ${note}\n`)
      }
    }
  }
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
