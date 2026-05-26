// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import { Attr, withSpan } from '../observability/index.js'
import { migrateLegacyPartitions } from '../cache/migrate.js'
import { readObservabilityEnv } from '../observability/env.js'
import { defaultConfigPath, loadConfigFile } from '../config/schema.js'
import { runWalkthrough, runPickerWalkthrough } from './walkthrough.js'
import { mergeInstalledManifestsIntoKnown, validateConfig } from '../config/validate.js'
import { discoverInstalledPlugins } from '../runtime/installed.js'
import { discoverBundledPlugins } from '../runtime/bundled.js'
import { buildPluginCatalog } from '../plugin_catalog.js'
import { collectHypAwareStatus } from '../daemon/status.js'
import { renderResult } from '../query/format.js'
import { renderSchema, schemaForDataset } from '../query/schema.js'
import { executeQuerySql } from '../query/sql.js'
import {
  installPlugin,
  listInstalledPlugins,
  loadLock,
  removePlugin,
  updatePlugin,
} from '../plugin_install/install.js'
import {
  buildTtyPrompt,
  buildWarnings,
  decideConfirmation,
  renderConfirmationSummary,
} from '../plugin_install/confirm.js'

/**
 * @import { AiGatewayCapability, CommandRegistration, CommandRunContext, HypAwareV2Config } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { ExtendedQueryStorageService } from '../cache/types.d.ts'
 * @import { DaemonInstallOptions, HypAwareStatusReport, ServiceState } from '../daemon/types.d.ts'
 * @import { ConfirmInstall } from '../plugin_install/types.d.ts'
 * @import { QueryFormat, RefreshMode } from '../query/types.d.ts'
 * @import { ExtendedSinkRegistry, ExtendedSourceRegistry } from '../registry/types.d.ts'
 * @import { CommandRegistryExtended, InitFlags } from './types.d.ts'
 */

/**
 * Register the V1 core command set onto the supplied registry. These
 * commands are NOT plugin contributions — they ship with the kernel
 * (per Phase 3 plan §Built-In Commands and the V1 Parity Table).
 *
 * Phase 3 implementations are deliberately thin: each command emits the
 * right spans/logs so the dispatcher's behavior is observable, but the
 * underlying subsystems (query cache, plugin install path, etc.) land
 * in later phases. Future phases swap in real bodies without changing
 * the registry shape.
 *
 * @param {CommandRegistryExtended} registry
 */
export function registerCoreCommands(registry) {
  for (const cmd of buildCoreCommands()) {
    registry.register(cmd)
  }
}

/** @returns {CommandRegistration[]} */
function buildCoreCommands() {
  return [
    {
      name: 'status',
      summary: 'Show kernel status (active plugins, sources, sinks, cache)',
      usage: 'hyp status [--json]',
      run: runStatus,
    },
    {
      name: 'query',
      summary: 'Query the local cache (see subcommands: schema, status, sql, refresh, maintain)',
      usage: 'hyp query <subcommand> [args...]',
      run: runQuery,
    },
    {
      name: 'query schema',
      summary: 'Print the schema for a dataset',
      usage: 'hyp query schema <dataset>',
      run: runQuerySchema,
    },
    {
      name: 'query status',
      summary: 'Show cache freshness and dataset registration state',
      usage: 'hyp query status',
      run: runQueryStatus,
    },
    {
      name: 'query sql',
      summary: 'Run a SQL query against registered datasets',
      usage: 'hyp query sql <sql> [--refresh <mode>] [--format <fmt>]',
      run: runQuerySql,
    },
    {
      name: 'query refresh',
      summary: 'Force a cache refresh for a dataset',
      usage: 'hyp query refresh [dataset]',
      run: runQueryRefresh,
    },
    {
      name: 'query maintain',
      summary: 'Run cache maintenance (legacy migration, snapshot expiration, compaction)',
      usage: 'hyp query maintain [dataset] [--dry-run] [--force] [--compact-only] [--expire-only]',
      run: runQueryMaintain,
    },
    {
      name: 'collect',
      summary: 'Collect rows from a registered source (see subcommands: list, remove)',
      usage: 'hyp collect <subcommand> [args...]',
      run: runCollect,
    },
    {
      name: 'collect list',
      summary: 'List configured collectors',
      usage: 'hyp collect list',
      run: runCollectList,
    },
    {
      name: 'collect remove',
      summary: 'Remove a configured collector',
      usage: 'hyp collect remove <name>',
      run: runCollectRemove,
    },
    {
      name: 'plugin install',
      summary: 'Install a plugin from name, git URL, or local directory',
      usage: 'hyp plugin install <source> [--ref <ref>] [--path <subdir>] [--yes]',
      run: runPluginInstall,
    },
    {
      name: 'plugin list',
      summary: 'List active (bundled) and installed plugins',
      usage: 'hyp plugin list [--json]',
      run: runPluginList,
    },
    {
      name: 'plugin info',
      summary: 'Show details for an installed plugin',
      usage: 'hyp plugin info <plugin>',
      run: runPluginInfo,
    },
    {
      name: 'plugin outdated',
      summary: 'List plugins with updates available',
      usage: 'hyp plugin outdated [--json]',
      run: runPluginOutdated,
    },
    {
      name: 'plugin update',
      summary: 'Update an installed plugin',
      usage: 'hyp plugin update [plugin] [--yes]',
      run: runPluginUpdate,
    },
    {
      name: 'plugin remove',
      summary: 'Remove an installed plugin',
      usage: 'hyp plugin remove <plugin>',
      run: runPluginRemove,
    },
    {
      name: 'config',
      summary: 'Inspect or operate on the HypAware config (subcommand: validate)',
      usage: 'hyp config <subcommand> [args...]',
      run: runConfig,
    },
    {
      name: 'config validate',
      summary: 'Load and cross-validate the active config file',
      usage: 'hyp config validate [--path <file>]',
      run: runConfigValidate,
    },
    {
      name: 'init',
      summary: 'Initialize a new HypAware install (interactive walkthrough or preset)',
      usage: 'hyp init [preset]',
      run: runInit,
    },
    {
      name: 'attach',
      summary: 'Attach an AI client to the local gateway',
      usage: 'hyp attach [client] [--client <name>] [--dry-run] [--json] [--yes]',
      run: runAttach,
    },
    {
      name: 'detach',
      summary: 'Detach an AI client from the local gateway',
      usage: 'hyp detach [client] [--client <name>] [--dry-run] [--json]',
      aliases: ['unattach'],
      run: runDetach,
    },
    {
      name: 'ignore',
      summary: 'Mark the current session as ignored by recording sources',
      usage: 'hyp ignore',
      run: runIgnore,
    },
    {
      name: 'skills install',
      summary: 'Install registered skills into AI client directories',
      usage: 'hyp skills install [--client <name>]',
      run: runSkillsInstall,
    },
    {
      name: 'daemon',
      summary: 'Manage the HypAware daemon (subcommands: install, uninstall, run, start, stop, restart, status)',
      usage: 'hyp daemon <subcommand> [args...]',
      run: runDaemonHelp,
    },
    {
      name: 'daemon install',
      summary: 'Install the persistent user service (launchd / systemd)',
      usage: 'hyp daemon install [--config <path>] [--dry-run [--json]]',
      run: runDaemonInstall,
    },
    {
      name: 'daemon uninstall',
      summary: 'Uninstall the persistent user service (keeps config, recordings, logs)',
      usage: 'hyp daemon uninstall',
      run: runDaemonUninstall,
    },
    {
      name: 'daemon run',
      summary: 'Run the HypAware daemon in the foreground',
      usage: 'hyp daemon run --foreground [--config <path>]',
      run: runDaemonRun,
    },
    {
      name: 'daemon start',
      summary: 'Start the installed daemon service',
      usage: 'hyp daemon start',
      run: runDaemonStart,
    },
    {
      name: 'daemon status',
      summary: 'Print the running daemon’s health snapshot',
      usage: 'hyp daemon status [--json]',
      run: runDaemonStatus,
    },
    {
      name: 'daemon stop',
      summary: 'Signal the running daemon to shut down',
      usage: 'hyp daemon stop',
      run: runDaemonStop,
    },
    {
      name: 'daemon restart',
      summary: 'Stop the daemon (and direct the operator to relaunch)',
      usage: 'hyp daemon restart',
      run: runDaemonRestart,
    },
    {
      name: 'sink',
      summary: 'Manage sink instances (subcommand: force)',
      usage: 'hyp sink <subcommand> [args...]',
      run: runSinkHelp,
    },
    {
      name: 'sink force',
      summary: 'Force the sink driver to fire a tick now (optionally for one instance)',
      usage: 'hyp sink force [instance]',
      run: runSinkForce,
    },
    {
      name: 'smoke',
      summary: 'Run a smoke flow under a fresh tmp HYP_HOME (internal)',
      usage: 'hyp smoke <flow-name>',
      hidden: true,
      run: runSmoke,
    },
  ]
}

/* ---------- status ---------- */

/**
 * `hyp status [--json]`
 *
 * Renders the V1 install state — config path, daemon install/run
 * state, active plugins, source/sink/client status, cache + retention
 * window, recent error count — and any diagnostics + repair
 * suggestions surfaced by the Phase 8 collector.
 *
 * Span: `status.render`. Attributes match the bead contract
 * (`source_count`, `sink_count`, `cache_size_bytes`,
 * `oldest_partition_date`, `daemon_state`, `diagnostics_count`) and
 * also carry the legacy attributes (`client_count`, `retention_days`)
 * that earlier smokes assert on.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
async function runStatus(argv, ctx) {
  const json = argv.includes('--json')

  /** @type {ExtendedSourceRegistry} */
  const sources = /** @type {any} */ (ctx.sources)
  /** @type {ExtendedSinkRegistry} */
  const sinks = /** @type {any} */ (ctx.sinks)

  const runtimeClientNames = listClientNames(ctx.capabilities)

  const report = await collectHypAwareStatus({
    env: ctx.env,
    runtime: {
      sources,
      sinks,
      capabilities: ctx.capabilities,
      query: ctx.query,
      storage: ctx.storage,
    },
  })

  // Source/sink lists from the report are the canonical set. The
  // walkthrough smoke checks for plugin names in stdout, so we lean
  // on the report's `sources`/`sinks` arrays which include both
  // contributions and running state.
  const sourceRows = report.sources
  const sinkRows = report.sinks
  const clientNames = runtimeClientNames.length > 0
    ? runtimeClientNames
    : report.clients
      .filter((c) => c.configured)
      .map((c) => c.name)
      .sort()
  const registeredDatasets = ctx.query.listDatasets()
  const datasets = registeredDatasets.length > 0
    ? registeredDatasets
    : inferDatasetsFromPlugins(report.activePlugins)

  return withSpan(
    'status.render',
    {
      [Attr.COMPONENT]: 'status',
      [Attr.OPERATION]: 'status.render',
      source_count: sourceRows.length,
      sink_count: sinkRows.length,
      client_count: clientNames.length,
      dataset_count: datasets.length,
      cache_size_bytes: report.cache.totalBytes,
      oldest_partition_date: report.cache.oldestDate ?? '',
      retention_days: report.retention.days,
      active_plugin_count: report.activePlugins.length,
      daemon_state: report.daemon.state ?? (report.daemon.running ? 'running' : 'stopped'),
      diagnostics_count: report.diagnostics.length,
      overall: report.overall,
      format: json ? 'json' : 'text',
      status: 'ok',
    },
    async () => {
      if (json) {
        const payload = renderStatusJson({
          report,
          clientNames,
          datasets,
          cacheRoot: ctx.storage.cacheRoot,
        })
        ctx.stdout.write(JSON.stringify(payload, null, 2) + '\n')
        return 0
      }
      renderStatusText({
        report,
        clientNames,
        datasets,
        cacheRoot: ctx.storage.cacheRoot,
        stdout: ctx.stdout,
      })
      return 0
    },
    { component: 'status' }
  )
}

/**
 * Render the V1 status report as a stable JSON shape. Consumers may
 * pin keys without dispatching on platform; missing values surface as
 * `null` rather than being omitted, so smoke assertions can probe
 * specific fields directly.
 *
 * Excludes any `@hypaware/central` and `@hypaware/gascity` keys per
 * V1 contract (Phase 8 bead): the V1 surface must not require either.
 *
 * @param {{
 *   report: HypAwareStatusReport,
 *   clientNames: string[],
 *   datasets: { name: string, plugin: string }[],
 *   cacheRoot: string,
 * }} args
 */
function renderStatusJson({ report, clientNames, datasets, cacheRoot }) {
  return {
    overall: report.overall,
    config: {
      path: report.configPath,
      exists: report.configExists,
      valid: report.configValid,
    },
    // V1 stable shape — array of `{name}` so consumers can pin keys
    // without needing to know the version. The collector currently
    // does not track per-plugin version (Phase 2 set version on each
    // entry but it was always 'unknown'); keeping the field reserved
    // lets later phases populate it without breaking smokes.
    active_plugins: report.activePlugins.map((name) => ({ name })),
    daemon: {
      installed: report.daemon.installed,
      loaded: report.daemon.loaded,
      running: report.daemon.running,
      state: report.daemon.state ?? 'unknown',
      pid: report.daemon.pid ?? null,
      mode: report.daemon.mode ?? null,
      run_id: report.daemon.runId ?? null,
      platform: report.daemon.platform,
      ...(report.daemon.error ? { error: report.daemon.error } : {}),
    },
    sources: report.sources.map((s) => ({
      name: s.name,
      plugin: s.plugin,
      state: s.state,
      ...(s.error ? { error: s.error } : {}),
    })),
    sinks: report.sinks.map((s) => ({
      instance: s.instance,
      plugin: s.plugin,
      kind: s.kind,
      ...(s.lastTickAt ? { last_tick_at: s.lastTickAt } : {}),
      ...(s.lastSuccessAt ? { last_success_at: s.lastSuccessAt } : {}),
    })),
    // Backwards-compatible shape: array of registered client names.
    // Phase 8 attach detail lives under `client_attach`.
    clients: clientNames,
    client_attach: report.clients.map((c) => ({
      name: c.name,
      configured: c.configured,
      attached: c.attached,
      ...(c.settingsPath ? { settings_path: c.settingsPath } : {}),
      ...(c.version ? { version: c.version } : {}),
      ...(c.port ? { port: c.port } : {}),
      ...(c.error ? { error: c.error } : {}),
    })),
    datasets: datasets.map((d) => ({ name: d.name, plugin: d.plugin })),
    cache: {
      dir: cacheRoot,
      retention_days: report.retention.days,
      retention_source: report.retention.source,
      size_bytes: report.cache.totalBytes,
      oldest_partition_date: report.cache.oldestDate,
    },
    recent_error_count: report.recentErrorCount,
    diagnostics: report.diagnostics.map((d) => ({
      severity: d.severity,
      kind: d.kind,
      message: d.message,
      repair: d.repair,
      ...(d.pointer ? { pointer: d.pointer } : {}),
    })),
  }
}

/**
 * Render the V1 status report as human-friendly text. Mirrors the
 * JSON shape but groups sections and surfaces diagnostics + repair
 * suggestions at the bottom.
 *
 * @param {{
 *   report: HypAwareStatusReport,
 *   clientNames: string[],
 *   datasets: { name: string, plugin: string }[],
 *   cacheRoot: string,
 *   stdout: { write(chunk: string): unknown },
 * }} args
 */
function renderStatusText({ report, clientNames, datasets, cacheRoot, stdout }) {
  stdout.write('hypaware\n')
  stdout.write(`  overall:  ${report.overall}\n`)
  const configState = report.configExists
    ? (report.configValid ? 'ok' : 'invalid')
    : 'missing'
  stdout.write(`  config:   ${report.configPath} (${configState})\n`)

  const daemonLine = describeDaemon(report.daemon)
  stdout.write(`  daemon:   ${daemonLine}\n`)

  stdout.write('  active plugins:\n')
  if (report.activePlugins.length === 0) {
    stdout.write('    (none — no config or no plugins selected)\n')
  } else {
    for (const name of report.activePlugins) {
      stdout.write(`    - ${name}\n`)
    }
  }

  stdout.write('  sources:\n')
  if (report.sources.length === 0) {
    stdout.write('    (none)\n')
  } else {
    for (const s of report.sources) {
      stdout.write(`    - ${s.name}  (${s.plugin})  [${s.state}]\n`)
    }
  }

  stdout.write('  sinks:\n')
  if (report.sinks.length === 0) {
    stdout.write('    (none — keeping captured data local only)\n')
  } else {
    for (const s of report.sinks) {
      stdout.write(`    - ${s.instance}  (${s.plugin}, ${s.kind})\n`)
    }
  }

  stdout.write('  clients:\n')
  if (clientNames.length === 0 && report.clients.every((c) => !c.configured)) {
    stdout.write('    (none)\n')
  } else {
    // Surface the union of registered clients (from the gateway) and
    // configured/attached clients (from the report). Each line shows
    // configured + attached state so a missing attach jumps out.
    const seen = new Set()
    for (const c of report.clients) {
      seen.add(c.name)
      const state = []
      state.push(c.configured ? 'configured' : 'not in config')
      state.push(c.attached ? 'attached' : 'not attached')
      stdout.write(`    - ${c.name}  [${state.join(', ')}]\n`)
    }
    for (const name of clientNames) {
      if (seen.has(name)) continue
      stdout.write(`    - ${name}  [registered]\n`)
    }
  }

  stdout.write(`  cache:           ${cacheRoot}\n`)
  stdout.write(
    `  cache retention: ${report.retention.days} days${
      report.retention.source === 'default' ? ' (default)' : ''
    }\n`
  )
  stdout.write(`  cache size:      ${report.cache.totalBytes} bytes\n`)
  stdout.write(`  datasets:        ${datasets.length}\n`)
  stdout.write(`  recent errors:   ${report.recentErrorCount}\n`)

  if (report.diagnostics.length > 0) {
    stdout.write('  diagnostics:\n')
    for (const d of report.diagnostics) {
      const tag = d.severity === 'error' ? 'ERROR' : 'WARN '
      stdout.write(`    [${tag}] ${d.kind}: ${d.message}\n`)
      for (const repair of d.repair) {
        stdout.write(`        repair: ${repair}\n`)
      }
    }
  }
}

/**
 * @param {ServiceState} daemon
 */
function describeDaemon(daemon) {
  const parts = []
  parts.push(daemon.installed ? 'installed' : 'not installed')
  if (daemon.installed) parts.push(daemon.loaded ? 'loaded' : 'not loaded')
  parts.push(daemon.running ? 'running' : 'not running')
  if (daemon.state) parts.push(`state=${daemon.state}`)
  if (daemon.pid) parts.push(`pid=${daemon.pid}`)
  if (daemon.mode) parts.push(`mode=${daemon.mode}`)
  if (daemon.error) parts.push(`error=${daemon.error}`)
  return parts.join(', ')
}

/**
 * @param {CommandRunContext['capabilities']} capabilities
 * @returns {string[]}
 */
function listClientNames(capabilities) {
  if (!capabilities.has('hypaware.ai-gateway')) return []
  /** @type {AiGatewayCapability} */
  const gateway = capabilities.require('hyp-core/status', 'hypaware.ai-gateway', '^2.0.0')
  return gateway.listClients().map((c) => c.name).sort()
}

/**
 * `hyp status` intentionally avoids activating configured plugins so
 * the command does not bind local listeners just to render a report.
 * When no live query registry exists, infer the V1 bundled datasets
 * from the config-backed active plugin set.
 *
 * @param {string[]} activePlugins
 * @returns {{ name: string, plugin: string }[]}
 */
function inferDatasetsFromPlugins(activePlugins) {
  const active = new Set(activePlugins)
  /** @type {{ name: string, plugin: string }[]} */
  const datasets = []
  if (active.has('@hypaware/ai-gateway')) {
    datasets.push({ name: 'ai_gateway_messages', plugin: '@hypaware/ai-gateway' })
  }
  if (active.has('@hypaware/otel')) {
    datasets.push(
      { name: 'logs', plugin: '@hypaware/otel' },
      { name: 'metrics', plugin: '@hypaware/otel' },
      { name: 'traces', plugin: '@hypaware/otel' }
    )
  }
  return datasets.sort((a, b) => a.name.localeCompare(b.name))
}

// `measureCacheRoot` / `walkCacheRoot` / `loadRetentionDays` moved into
// `src/core/daemon/status.js` as part of the Phase 8 status collector
// (`collectHypAwareStatus`). Callers route through that helper now so
// disk probes happen once per `hyp status` invocation.

/* ---------- query ---------- */

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runQuery(argv, ctx) {
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
async function runQuerySchema(argv, ctx) {
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
        ctx.stdout.write('  (no dataset registered — install a plugin that contributes it)\n')
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
async function runQueryStatus(_argv, ctx) {
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
      ctx.stdout.write(`  ${p.dataset}/${partKey || 'all'}  epoch=${p.epoch}  rows=${p.rowCount}  files=${p.dataFileCount}  snapshots=${p.snapshotCount}  metadata=${p.metadataBytes}B\n`)
    }
  }
  return 0
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runQuerySql(argv, ctx) {
  const parsed = parseQuerySqlArgv(argv)
  if (!parsed.ok) {
    ctx.stderr.write(parsed.error + '\n')
    return 2
  }
  try {
    const result = await executeQuerySql({
      query: parsed.sql,
      registry: ctx.query,
      storage: /** @type {ExtendedQueryStorageService} */ (ctx.storage),
      refresh: parsed.refresh,
      config: ctx.config,
    })
    for (const message of result.freshnessMessages ?? []) {
      ctx.stderr.write(`${message}\n`)
    }
    ctx.stdout.write(renderResult({ columns: result.columns, rows: result.rows }, parsed.format))
    return 0
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.stderr.write(`hyp query sql: ${message}\n`)
    return 1
  }
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runQueryRefresh(argv, ctx) {
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
 * Parse the `hyp query sql` argv tail. Accepts the positional SQL string and
 * `--refresh` / `--format` flags in any order.
 *
 * @param {string[]} argv
 * @returns {{ ok: true, sql: string, refresh: RefreshMode, format: QueryFormat } | { ok: false, error: string }}
 */
function parseQuerySqlArgv(argv) {
  /** @type {string[]} */
  const positional = []
  /** @type {RefreshMode} */
  let refresh = 'auto'
  /** @type {QueryFormat} */
  let format = 'table'

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--refresh') {
      const value = argv[i + 1]
      if (value !== 'never' && value !== 'auto' && value !== 'always') {
        return { ok: false, error: `hyp query sql: --refresh expects one of never|auto|always (got ${value ?? '<missing>'})` }
      }
      refresh = value
      i += 1
    } else if (token === '--format') {
      const value = argv[i + 1]
      if (value !== 'table' && value !== 'json' && value !== 'jsonl' && value !== 'markdown') {
        return { ok: false, error: `hyp query sql: --format expects one of table|json|jsonl|markdown (got ${value ?? '<missing>'})` }
      }
      format = value
      i += 1
    } else {
      positional.push(token)
    }
  }

  if (positional.length === 0) {
    return { ok: false, error: 'usage: hyp query sql <sql> [--refresh <mode>] [--format <fmt>]' }
  }
  const sql = positional.join(' ')
  return { ok: true, sql, refresh, format }
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runQueryMaintain(argv, ctx) {
  const { maintainCache } = await import('../cache/maintenance.js')
  const parsed = parseQueryMaintainArgv(argv)
  if (parsed.error) {
    ctx.stderr.write(`hyp query maintain: ${parsed.error}\n`)
    return 2
  }
  if (!parsed.compactOnly && !parsed.expireOnly) {
    const migrationResult = await migrateLegacyPartitions({
      cacheRoot: ctx.storage.cacheRoot,
      force: parsed.force,
    })
    if (migrationResult.migrated > 0) {
      ctx.stdout.write(`migrate: ${migrationResult.migrated} legacy partition(s), ${migrationResult.rowsMigrated} row(s)\n`)
    }
  }
  const maintenanceConfig = ctx.config?.query?.cache?.maintenance
  const { dataset, force, dryRun, compactOnly, expireOnly } = /** @type {{ dataset?: string, dryRun: boolean, force: boolean, compactOnly: boolean, expireOnly: boolean }} */ (parsed)
  const report = await maintainCache({
    cacheRoot: ctx.storage.cacheRoot,
    dataset,
    force,
    dryRun,
    compactOnly,
    expireOnly,
    config: maintenanceConfig,
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

/**
 * @param {string[]} argv
 * @returns {{ dataset?: string, dryRun: boolean, force: boolean, compactOnly: boolean, expireOnly: boolean, error?: undefined } | { error: string }}
 */
function parseQueryMaintainArgv(argv) {
  /** @type {string | undefined} */
  let dataset
  let dryRun = false
  let force = false
  let compactOnly = false
  let expireOnly = false
  for (const arg of argv) {
    if (arg === '--dry-run') { dryRun = true; continue }
    if (arg === '--force') { force = true; continue }
    if (arg === '--compact-only') { compactOnly = true; continue }
    if (arg === '--expire-only') { expireOnly = true; continue }
    if (arg === '--help' || arg === '-h') {
      return { error: 'usage: hyp query maintain [dataset] [--dry-run] [--force] [--compact-only] [--expire-only]' }
    }
    if (arg.startsWith('--')) {
      return { error: `unknown flag '${arg}'` }
    }
    if (dataset === undefined) { dataset = arg; continue }
    return { error: `unexpected argument '${arg}'` }
  }
  if (compactOnly && expireOnly) {
    return { error: '--compact-only and --expire-only are mutually exclusive' }
  }
  return { dataset, dryRun, force, compactOnly, expireOnly }
}

/* ---------- collect ---------- */

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runCollect(argv, ctx) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    ctx.stdout.write('usage: hyp collect <subcommand> [args...]\n')
    ctx.stdout.write('  subcommands: list, remove\n')
    return 0
  }
  ctx.stderr.write(`hyp collect: unknown subcommand '${argv[0]}'\n`)
  return 2
}

/**
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 */
async function runCollectList(_argv, ctx) {
  ctx.stdout.write('No collectors configured.\n')
  return 0
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runCollectRemove(argv, ctx) {
  if (argv.length === 0) {
    ctx.stderr.write('usage: hyp collect remove <name>\n')
    return 2
  }
  ctx.stdout.write(`(collect remove lands in Phase 5; would remove '${argv[0]}')\n`)
  return 0
}

/* ---------- plugin ---------- */

/**
 * Resolve the kernel state directory the plugin install commands
 * write into. Mirrors `readObservabilityEnv` so `HYP_HOME` flows
 * through to plugin install just like it does for the cache.
 *
 * @param {CommandRunContext} ctx
 */
function pluginStateDir(ctx) {
  return readObservabilityEnv(ctx.env).stateDir
}

/**
 * Build the `knownPlugins` map and `knownDatasets` set used by
 * `validateConfig`. Discovers bundled and installed plugin manifests
 * and derives capability metadata from the manifests themselves via
 * `buildPluginCatalog`, so config validation runs against the actual
 * declared capabilities rather than a hardcoded table.
 *
 * Discovery failures are absorbed silently — `hyp config validate`
 * keeps working when the lock is missing or any installed manifest is
 * corrupt; the underlying discovery layer logs its own diagnostics.
 *
 * @param {CommandRunContext} ctx
 * @returns {Promise<{ knownPlugins: Map<import('../../../collectivus-plugin-kernel-types.d.ts').PluginName, import('../config/types.d.ts').PluginMetadata>, knownDatasets: Set<string> }>}
 */
async function buildKnownPluginsForCtx(ctx) {
  /** @type {import('../manifest.js').LoadedManifest[]} */
  let bundledLoaded = []
  /** @type {import('../manifest.js').LoadedManifest[]} */
  let installedLoaded = []
  try {
    const bundled = await discoverBundledPlugins()
    bundledLoaded = [...bundled.loaded, ...bundled.excluded]
  } catch { /* bundled discovery failure is non-fatal */ }
  try {
    const stateDir = pluginStateDir(ctx)
    const installed = await discoverInstalledPlugins({ stateDir })
    installedLoaded = installed.loaded
  } catch { /* installed discovery failure is non-fatal */ }
  const catalog = buildPluginCatalog(bundledLoaded, installedLoaded)
  return { knownPlugins: catalog.pluginMetadata, knownDatasets: catalog.knownDatasets }
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runPluginInstall(argv, ctx) {
  const parsed = parsePluginInstallArgs(argv)
  if (!parsed.ok) {
    ctx.stderr.write(`hyp plugin install: ${parsed.message}\n`)
    return parsed.code
  }
  const stateDir = pluginStateDir(ctx)
  const confirm = buildPluginInstallConfirm({
    yes: parsed.yes,
    ctx,
    headerKind: 'install',
  })
  const result = await installPlugin({
    rawSource: parsed.rawSource,
    stateDir,
    cwd: ctx.cwd,
    opts: { ref: parsed.ref, subdir: parsed.subdir },
    confirm,
  })
  if (!result.ok) {
    ctx.stderr.write(`hyp plugin install: ${result.message}\n`)
    return result.errorKind === 'remote_install_confirmation_required' ? 2 : 1
  }
  ctx.stdout.write(
    `installed ${result.entry.name}@${result.entry.version} from ${result.entry.source.kind}\n`
  )
  ctx.stdout.write(`  install_dir: ${result.entry.install_dir}\n`)
  if (result.entry.resolved_ref) {
    ctx.stdout.write(`  resolved_ref: ${result.entry.resolved_ref}\n`)
  }
  return 0
}

/**
 * Build the install-time trust gate. The factory is shared between the
 * install and update CLI commands so both produce the same prompt and
 * the same telemetry outcomes.
 *
 * @param {{
 *   yes: boolean,
 *   ctx: CommandRunContext,
 *   headerKind: 'install' | 'update',
 * }} args
 * @returns {ConfirmInstall}
 */
function buildPluginInstallConfirm({ yes, ctx, headerKind }) {
  const stderr = ctx.stderr
  return async function confirm(staged) {
    const summary = renderConfirmationSummary(
      {
        manifest: staged.manifest,
        source: staged.source,
        resolvedRef: staged.resolvedRef,
        contentHash: staged.contentHash,
        manifestHash: staged.manifestHash,
      },
      {
        ...(staged.previous ? { previous: staged.previous } : {}),
        headerKind,
      }
    )
    const warnings = buildWarnings({
      manifest: staged.manifest,
      source: staged.source,
      resolvedRef: staged.resolvedRef,
      contentHash: staged.contentHash,
      manifestHash: staged.manifestHash,
    })
    for (const w of warnings) stderr.write(`${w}\n`)
    stderr.write(summary)
    // Prompt on stderr so stdout stays parseable. We require both
    // stderr and stdin to be a TTY before asking — piping either
    // direction means "no human watching, prompt is useless."
    const tty = isTty(stderr) && isTty(process.stdin)
    const ask = tty
      ? buildTtyPrompt({
        stdin: process.stdin,
        stdout: /** @type {NodeJS.WritableStream} */ (stderr),
      })
      : undefined
    const decision = await decideConfirmation({ yes, tty, ...(ask ? { ask } : {}) })
    return decision
  }
}

/**
 * Parse `hyp plugin install <source> [--ref <ref>] [--path <subdir>] [--yes]`.
 * Flags accept both `--flag value` and `--flag=value` forms. The
 * function does NOT verify mutual exclusion of `--ref` with a URL
 * fragment — that lives in the resolver so the same rule applies to
 * programmatic callers.
 *
 * @param {string[]} argv
 * @returns {(
 *   { ok: true, rawSource: string, ref?: string, subdir?: string, yes: boolean }
 *   | { ok: false, code: number, message: string }
 * )}
 */
function parsePluginInstallArgs(argv) {
  /** @type {string | undefined} */
  let rawSource
  /** @type {string | undefined} */
  let ref
  /** @type {string | undefined} */
  let subdir
  let yes = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--yes' || arg === '-y') {
      yes = true
      continue
    }
    if (arg === '--ref' || arg === '--path') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, code: 2, message: `flag ${arg} requires a value` }
      }
      // Block `-X` style values too — `applyGitSourceFlags` enforces
      // the same rule but rejecting at the CLI layer gives a friendlier
      // error before the install span opens.
      if (value.startsWith('-')) {
        return { ok: false, code: 2, message: `flag ${arg} value must not start with '-'` }
      }
      if (arg === '--ref') ref = value
      else subdir = value
      i += 1
      continue
    }
    if (arg.startsWith('--ref=')) {
      const value = arg.slice('--ref='.length)
      if (value.startsWith('-')) {
        return { ok: false, code: 2, message: `flag --ref value must not start with '-'` }
      }
      ref = value
      continue
    }
    if (arg.startsWith('--path=')) {
      const value = arg.slice('--path='.length)
      if (value.startsWith('-')) {
        return { ok: false, code: 2, message: `flag --path value must not start with '-'` }
      }
      subdir = value
      continue
    }
    if (rawSource === undefined) {
      rawSource = arg
      continue
    }
    return { ok: false, code: 2, message: `unexpected argument '${arg}'` }
  }
  if (!rawSource) {
    return { ok: false, code: 2, message: 'usage: hyp plugin install <source> [--ref <ref>] [--path <subdir>] [--yes]' }
  }
  return { ok: true, rawSource, ref, subdir, yes }
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runPluginList(argv, ctx) {
  const json = argv.includes('--json')
  const stateDir = pluginStateDir(ctx)
  const installed = await listInstalledPlugins(stateDir)
  const active = ctx.plugins ?? []

  if (json) {
    const installedByName = new Map(installed.map((e) => [e.name, e]))
    const activeByName = new Map(active.map((p) => [p.name, p]))
    const allNames = new Set([
      ...installedByName.keys(),
      ...activeByName.keys(),
    ])
    /** @type {Array<{name: string, version: string, source: 'bundled'|'installed', active: boolean, installed_at?: string, update?: unknown}>} */
    const plugins = []
    for (const name of Array.from(allNames).sort()) {
      const inst = installedByName.get(name)
      const act = activeByName.get(name)
      const version = act?.version ?? inst?.version ?? ''
      plugins.push({
        name,
        version,
        source: inst ? 'installed' : 'bundled',
        active: !!act,
        ...(inst ? { installed_at: inst.installed_at } : {}),
        ...(inst?.update !== undefined ? { update: inst.update } : {}),
      })
    }
    ctx.stdout.write(JSON.stringify({ plugins }, null, 2) + '\n')
    return 0
  }

  if (active.length === 0 && installed.length === 0) {
    ctx.stdout.write('No plugins active or installed.\n')
    return 0
  }
  if (active.length > 0) {
    ctx.stdout.write('Active plugins (from current boot):\n')
    for (const p of active) {
      ctx.stdout.write(`  ${p.name}@${p.version}  (bundled)\n`)
    }
  }
  if (installed.length > 0) {
    ctx.stdout.write('Installed plugins:\n')
    for (const entry of installed) {
      const available = entry.update?.available ? '  (update available)' : ''
      ctx.stdout.write(`  ${entry.name}@${entry.version}${available}\n`)
    }
  }
  return 0
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runPluginInfo(argv, ctx) {
  if (argv.length === 0) {
    ctx.stderr.write('usage: hyp plugin info <plugin>\n')
    return 2
  }
  const name = argv[0]
  const stateDir = pluginStateDir(ctx)
  const lock = await loadLock(stateDir)
  const entry = lock.plugins[name]
  if (!entry) {
    ctx.stderr.write(`hyp plugin info: '${name}' is not installed\n`)
    return 1
  }
  ctx.stdout.write(`${entry.name}@${entry.version}\n`)
  ctx.stdout.write(`  source:        ${entry.source.kind} (${entry.source.raw})\n`)
  ctx.stdout.write(`  install_dir:   ${entry.install_dir}\n`)
  ctx.stdout.write(`  content_hash:  ${entry.content_hash}\n`)
  ctx.stdout.write(`  manifest_hash: ${entry.manifest_hash}\n`)
  ctx.stdout.write(`  installed_at:  ${entry.installed_at}\n`)
  if (entry.update) {
    ctx.stdout.write(`  update_check:  ${entry.update.checked_at}\n`)
    ctx.stdout.write(`  available:     ${entry.update.available}\n`)
    if (entry.update.latest_version) {
      ctx.stdout.write(`  latest:        ${entry.update.latest_version}\n`)
    }
  }
  return 0
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runPluginOutdated(argv, ctx) {
  const json = argv.includes('--json')
  const stateDir = pluginStateDir(ctx)
  const entries = await listInstalledPlugins(stateDir)
  const outdated = entries.filter((e) => e.update?.available === true)
  if (json) {
    ctx.stdout.write(
      JSON.stringify(
        {
          plugins: outdated.map((e) => ({
            name: e.name,
            version: e.version,
            latest_version: e.update?.latest_version,
            checked_at: e.update?.checked_at,
          })),
        },
        null,
        2
      ) + '\n'
    )
    return 0
  }
  if (outdated.length === 0) {
    ctx.stdout.write('All plugins up to date.\n')
    return 0
  }
  for (const entry of outdated) {
    const latest = entry.update?.latest_version ?? '?'
    ctx.stdout.write(`  ${entry.name}: ${entry.version} -> ${latest}\n`)
  }
  return 0
}

/**
 * `hyp plugin update <plugin>` runs the full fetch → validate → diff →
 * confirm → swap pipeline for an installed plugin. The bare form
 * `hyp plugin update` (no plugin name) keeps the legacy "refresh
 * update_check state for every plugin" behavior so users have a way
 * to refresh the `outdated` view without committing to a re-install.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runPluginUpdate(argv, ctx) {
  const parsed = parsePluginUpdateArgs(argv)
  if (!parsed.ok) {
    ctx.stderr.write(`hyp plugin update: ${parsed.message}\n`)
    return parsed.code
  }
  const stateDir = pluginStateDir(ctx)
  if (parsed.target) {
    const confirm = buildPluginInstallConfirm({
      yes: parsed.yes,
      ctx,
      headerKind: 'update',
    })
    const result = await updatePlugin({ name: parsed.target, stateDir, confirm })
    if (!result.ok) {
      ctx.stderr.write(`hyp plugin update: ${result.message}\n`)
      return result.errorKind === 'remote_install_confirmation_required' ? 2 : 1
    }
    ctx.stdout.write(
      `updated ${result.entry.name}@${result.entry.version}\n`
    )
    if (result.entry.resolved_ref) {
      ctx.stdout.write(`  resolved_ref: ${result.entry.resolved_ref}\n`)
    }
    ctx.stdout.write(`  content_hash: ${result.entry.content_hash}\n`)
    return 0
  }

  // No target: keep the "refresh update-check state for all" behavior so
  // users still have a way to recompute `outdated` without re-installing.
  const { checkForPluginUpdate } = await import('../plugin_install/update_check.js')
  const { upsertEntry, writeLock } = await import('../plugin_install/lock.js')
  const lock = await loadLock(stateDir)
  const entries = Object.values(lock.plugins)
  let next = lock
  for (const entry of entries) {
    const probeInput = { ...entry, update: undefined }
    const state = await checkForPluginUpdate({ entry: probeInput })
    next = upsertEntry(next, { ...entry, update: state })
  }
  await writeLock(stateDir, next)
  ctx.stdout.write(`refreshed update state for ${entries.length} plugin(s)\n`)
  return 0
}

/**
 * Parse `hyp plugin update [plugin] [--yes]`.
 *
 * @param {string[]} argv
 * @returns {(
 *   { ok: true, target?: string, yes: boolean }
 *   | { ok: false, code: number, message: string }
 * )}
 */
function parsePluginUpdateArgs(argv) {
  /** @type {string | undefined} */
  let target
  let yes = false
  for (const arg of argv) {
    if (arg === '--yes' || arg === '-y') {
      yes = true
      continue
    }
    if (arg.startsWith('--')) {
      return { ok: false, code: 2, message: `unknown flag '${arg}'` }
    }
    if (target === undefined) {
      target = arg
      continue
    }
    return { ok: false, code: 2, message: `unexpected argument '${arg}'` }
  }
  return target ? { ok: true, target, yes } : { ok: true, yes }
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runPluginRemove(argv, ctx) {
  if (argv.length === 0) {
    ctx.stderr.write('usage: hyp plugin remove <plugin>\n')
    return 2
  }
  const name = argv[0]
  const stateDir = pluginStateDir(ctx)
  const result = await removePlugin({ name, stateDir })
  if (!result.ok) {
    ctx.stderr.write(`hyp plugin remove: ${result.message}\n`)
    return 1
  }
  ctx.stdout.write(`removed ${name}\n`)
  return 0
}

/* ---------- config ---------- */

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runConfig(argv, ctx) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    ctx.stdout.write('usage: hyp config <subcommand> [args...]\n')
    ctx.stdout.write('  subcommands: validate\n')
    return 0
  }
  ctx.stderr.write(`hyp config: unknown subcommand '${argv[0]}'\n`)
  ctx.stderr.write('  expected one of: validate\n')
  return 2
}

/**
 * Load and cross-validate the active config file. Emits `config.load`
 * and `config.validate` spans with `config_path`, `plugin_count`,
 * `sink_count`, and `error_kind` per the Phase 6 contract; per-error
 * logs are written by the schema/validate modules themselves so
 * smoke assertions can grep `error_kind` straight off the logs JSONL.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runConfigValidate(argv, ctx) {
  const parsed = parseConfigValidateArgv(argv, ctx.env)
  if (parsed.error !== undefined) {
    ctx.stderr.write(parsed.error + '\n')
    return 2
  }

  const loadResult = await loadConfigFile(parsed.configPath)
  if (!loadResult.ok) {
    ctx.stderr.write(`hyp config validate: ${loadResult.message}\n`)
    return 1
  }

  const { knownPlugins, knownDatasets } = await buildKnownPluginsForCtx(ctx)
  const result = await validateConfig(loadResult.config, { knownPlugins, knownDatasets })
  if (!result.ok) {
    ctx.stderr.write(
      `hyp config validate: ${result.errors.length} error(s) in ${loadResult.configPath}\n`
    )
    for (const err of result.errors) {
      ctx.stderr.write(`  [${err.errorKind}] ${err.pointer || '<root>'}: ${err.message}\n`)
    }
    return 1
  }

  ctx.stdout.write(
    `config ok: ${loadResult.configPath} (plugins=${result.pluginCount}, sinks=${result.sinkCount})\n`
  )
  return 0
}

/**
 * Resolve the config path. Precedence:
 *
 *  1. `--path <file>` on the command line.
 *  2. `HYP_CONFIG` env var.
 *  3. `<HYP_HOME>/hypaware-config.json` (falling back to `$HOME/.hyp`
 *     when `HYP_HOME` is unset, matching `readObservabilityEnv`).
 *
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ configPath: string, error?: undefined } | { error: string, configPath?: undefined }}
 */
function parseConfigValidateArgv(argv, env) {
  /** @type {string|undefined} */
  let pathFlag
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--path') {
      pathFlag = argv[i + 1]
      if (!pathFlag) return { error: 'hyp config validate: --path expects a file path' }
      i += 1
    } else if (token === '--help' || token === '-h') {
      return { error: 'usage: hyp config validate [--path <file>]' }
    } else {
      return { error: `hyp config validate: unexpected argument '${token}'` }
    }
  }
  if (pathFlag) return { configPath: path.resolve(pathFlag) }
  if (env.HYP_CONFIG) return { configPath: path.resolve(env.HYP_CONFIG) }
  const hypHome = env.HYP_HOME || path.join(env.HOME || '', '.hyp')
  return { configPath: defaultConfigPath(hypHome) }
}

/* ---------- daemon ---------- */

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runDaemonHelp(argv, ctx) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    ctx.stdout.write('usage: hyp daemon <subcommand> [args...]\n')
    ctx.stdout.write('  subcommands: install, uninstall, run, start, stop, restart, status\n')
    return 0
  }
  ctx.stderr.write(`hyp daemon: unknown subcommand '${argv[0]}'\n`)
  ctx.stderr.write('  expected one of: install, uninstall, run, start, stop, restart, status\n')
  return 2
}

/**
 * `hyp daemon run --foreground [--config <path>]` — boot the kernel as a daemon and
 * tend it in the current process until SIGTERM/SIGINT. Phase 3
 * intentionally only supports `--foreground`; the detached run path
 * lands with the Phase 4 launchd/systemd installers, so a no-flag
 * call surfaces a deterministic error instead of attempting to
 * background ourselves and silently failing.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runDaemonRun(argv, ctx) {
  const parsed = parseDaemonRunArgs(argv)
  if (parsed.error) {
    ctx.stderr.write(`hyp daemon run: ${parsed.error}\n`)
    return 2
  }
  if (!parsed.foreground) {
    ctx.stderr.write(
      'hyp daemon run: --foreground is required in Phase 3 (detached run lands with the Phase 4 installer)\n'
    )
    return 2
  }
  const { runDaemon } = await import('../daemon/runtime.js')
  const hypHome = ctx.env.HYP_HOME || path.join(ctx.env.HOME || '', '.hyp')
  try {
    const handle = await runDaemon({
      hypHome,
      ...(parsed.configPath !== undefined ? { configPath: parsed.configPath } : {}),
      env: ctx.env,
      runId: ctx.env.DEV_RUN_ID,
      foreground: parsed.foreground,
    })
    ctx.stdout.write(`daemon: running (pid=${process.pid})\n`)
    const exitCode = await handle.done
    ctx.stdout.write('daemon: stopped\n')
    return exitCode
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.stderr.write(`hyp daemon run: ${message}\n`)
    return 1
  }
}

/**
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runDaemonStatus(argv, ctx) {
  const json = argv.includes('--json')
  const { readStatusFile } = await import('../daemon/status.js')
  const { readPidFile, processIsAlive } = await import('../daemon/pid.js')
  const stateDir = readObservabilityEnv(ctx.env).stateDir
  const status = readStatusFile(stateDir)
  const pidEntry = readPidFile(stateDir)
  const running = !!(pidEntry && processIsAlive(pidEntry.pid))
  if (!status) {
    if (json) {
      ctx.stdout.write(JSON.stringify({ running: false, state: 'unknown' }, null, 2) + '\n')
      return 0
    }
    ctx.stdout.write('daemon: not started (no status file)\n')
    return 0
  }
  const liveUptimeMs = running && status.healthyAt
    ? Math.max(0, Date.now() - Date.parse(status.healthyAt))
    : status.uptimeMs
  if (json) {
    const payload = { running, ...status, uptimeMs: liveUptimeMs }
    ctx.stdout.write(JSON.stringify(payload, null, 2) + '\n')
    return 0
  }
  ctx.stdout.write(`daemon: ${status.state}${running ? '' : ' (no live process)'}\n`)
  ctx.stdout.write(`  pid:        ${status.pid}\n`)
  ctx.stdout.write(`  startedAt:  ${status.startedAt}\n`)
  if (status.healthyAt) ctx.stdout.write(`  healthyAt:  ${status.healthyAt}\n`)
  if (status.stoppedAt) ctx.stdout.write(`  stoppedAt:  ${status.stoppedAt}\n`)
  ctx.stdout.write(`  uptime_ms:  ${liveUptimeMs}\n`)
  ctx.stdout.write('  sources:\n')
  if (status.sources.length === 0) {
    ctx.stdout.write('    (none)\n')
  } else {
    for (const source of status.sources) {
      ctx.stdout.write(`    - ${source.name} (${source.plugin}): ${source.state}${source.error ? ' — ' + source.error : ''}\n`)
    }
  }
  ctx.stdout.write('  sinks:\n')
  if (status.sinks.length === 0) {
    ctx.stdout.write('    (none)\n')
  } else {
    for (const sink of status.sinks) {
      ctx.stdout.write(`    - ${sink.instance} (${sink.plugin}, ${sink.kind})\n`)
    }
  }
  return 0
}

/**
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 */
async function runDaemonStop(_argv, ctx) {
  const { requestDaemonStop } = await import('../daemon/runtime.js')
  const stateDir = readObservabilityEnv(ctx.env).stateDir
  const outcome = await requestDaemonStop({ stateRoot: stateDir })
  if (outcome === 'not_running') {
    ctx.stdout.write('daemon: not running\n')
    return 0
  }
  if (outcome === 'timed_out') {
    ctx.stderr.write('daemon: stop signal sent but daemon did not exit within 5s\n')
    return 1
  }
  ctx.stdout.write('daemon: stopped\n')
  return 0
}

/**
 * `hyp daemon restart` — restart the installed service if present,
 * otherwise fall back to a stop + operator-relaunch hint for the
 * foreground path.
 *
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 */
async function runDaemonRestart(_argv, ctx) {
  const { restartServiceDaemon, serviceDaemonStatus } = await import('../daemon/install.js')
  const homeDir = ctx.env.HOME
  const status = await serviceDaemonStatus({ homeDir })
  if (status.installed) {
    try {
      await restartServiceDaemon({ homeDir })
      ctx.stdout.write('daemon: restarted\n')
      return 0
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      ctx.stderr.write(`hyp daemon restart: ${message}\n`)
      return 1
    }
  }
  const code = await runDaemonStop([], ctx)
  if (code !== 0) return code
  ctx.stdout.write('daemon restart: stopped. No installed service found;\n')
  ctx.stdout.write('  re-run `hyp daemon run --foreground` to bring it back up,\n')
  ctx.stdout.write('  or `hyp daemon install` to set up the persistent service first.\n')
  return 0
}

/**
 * `hyp daemon install` — install the persistent platform service.
 * Supports `--dry-run [--json]` to render the planned plist / unit
 * file without touching disk.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runDaemonInstall(argv, ctx) {
  const parsed = parseDaemonInstallArgs(argv)
  if (parsed.help) {
    ctx.stdout.write('usage: hyp daemon install [--config <path>] [--bin <path>] [--dry-run [--json]]\n')
    return 0
  }
  if (parsed.error) {
    ctx.stderr.write(`hyp daemon install: ${parsed.error}\n`)
    return 2
  }

  const { renderDaemonInstall, installDaemon, daemonKindLabel } = await import('../daemon/install.js')
  const homeDir = ctx.env.HOME
  const binPath = parsed.binPath ?? (process.argv[1] ?? '')
  if (!binPath) {
    ctx.stderr.write('hyp daemon install: cannot determine binPath; pass --bin <path>\n')
    return 2
  }

  /** @type {DaemonInstallOptions} */
  const options = {
    binPath,
    ...(parsed.configPath !== undefined ? { configPath: parsed.configPath } : {}),
    ...(homeDir !== undefined ? { homeDir } : {}),
    ...(parsed.platform !== undefined ? { platform: parsed.platform } : {}),
  }

  if (parsed.dryRun) {
    const plan = renderDaemonInstall(options)
    if (parsed.json) {
      ctx.stdout.write(JSON.stringify(plan, null, 2) + '\n')
      return 0
    }
    ctx.stdout.write(`platform:    ${plan.platform}\n`)
    ctx.stdout.write(`service:     ${plan.serviceKind}\n`)
    ctx.stdout.write(`target:      ${plan.targetPath}\n`)
    ctx.stdout.write(`bin:         ${plan.binPath}\n`)
    ctx.stdout.write(`config:      ${plan.configPath}\n`)
    ctx.stdout.write(`log dir:     ${plan.logDir}\n`)
    ctx.stdout.write('--- content ---\n')
    ctx.stdout.write(plan.content)
    if (!plan.content.endsWith('\n')) ctx.stdout.write('\n')
    return 0
  }

  try {
    const plan = await installDaemon(options)
    ctx.stdout.write(`✓ Daemon installed (${daemonKindLabel(plan.platform)})\n`)
    ctx.stdout.write(`  target:  ${plan.targetPath}\n`)
    ctx.stdout.write(`  config:  ${plan.configPath}\n`)
    ctx.stdout.write(`  logs:    ${plan.logDir}/daemon.out.log\n`)
    return 0
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.stderr.write(`hyp daemon install: ${message}\n`)
    return 1
  }
}

/**
 * `hyp daemon uninstall` — remove the persistent service while
 * leaving config, recordings, and logs in place.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runDaemonUninstall(argv, ctx) {
  for (const token of argv) {
    if (token === '--help' || token === '-h') {
      ctx.stdout.write('usage: hyp daemon uninstall\n')
      return 0
    }
    ctx.stderr.write(`hyp daemon uninstall: unexpected argument '${token}'\n`)
    return 2
  }
  const { uninstallDaemon, daemonKindLabel } = await import('../daemon/install.js')
  const homeDir = ctx.env.HOME
  try {
    await uninstallDaemon({ ...(homeDir !== undefined ? { homeDir } : {}) })
    ctx.stdout.write(`✓ Daemon removed (${daemonKindLabel()})\n`)
    return 0
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.stderr.write(`hyp daemon uninstall: ${message}\n`)
    return 1
  }
}

/**
 * `hyp daemon start` — start (kickstart) the installed service.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runDaemonStart(argv, ctx) {
  for (const token of argv) {
    if (token === '--help' || token === '-h') {
      ctx.stdout.write('usage: hyp daemon start\n')
      return 0
    }
    ctx.stderr.write(`hyp daemon start: unexpected argument '${token}'\n`)
    return 2
  }
  const { startServiceDaemon, serviceDaemonStatus } = await import('../daemon/install.js')
  const homeDir = ctx.env.HOME
  const status = await serviceDaemonStatus({ ...(homeDir !== undefined ? { homeDir } : {}) })
  if (!status.installed) {
    ctx.stderr.write('hyp daemon start: service not installed (run `hyp daemon install` first)\n')
    return 1
  }
  try {
    await startServiceDaemon({ ...(homeDir !== undefined ? { homeDir } : {}) })
    ctx.stdout.write('daemon: started\n')
    return 0
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.stderr.write(`hyp daemon start: ${message}\n`)
    return 1
  }
}

/**
 * @param {string[]} argv
 * @returns {{ help?: boolean, error?: string, dryRun?: boolean, json?: boolean, configPath?: string, binPath?: string, platform?: NodeJS.Platform }}
 */
function parseDaemonInstallArgs(argv) {
  /** @type {{ help?: boolean, error?: string, dryRun?: boolean, json?: boolean, configPath?: string, binPath?: string, platform?: NodeJS.Platform }} */
  const r = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--help' || token === '-h') { r.help = true; return r }
    if (token === '--dry-run') { r.dryRun = true; continue }
    if (token === '--json') { r.json = true; continue }
    if (token === '--config' || token.startsWith('--config=')) {
      const value = token === '--config' ? argv[++i] : token.slice('--config='.length)
      if (!value) { r.error = '--config requires a path'; return r }
      r.configPath = value
      continue
    }
    if (token === '--bin' || token.startsWith('--bin=')) {
      const value = token === '--bin' ? argv[++i] : token.slice('--bin='.length)
      if (!value) { r.error = '--bin requires a path'; return r }
      r.binPath = value
      continue
    }
    if (token === '--platform' || token.startsWith('--platform=')) {
      const value = token === '--platform' ? argv[++i] : token.slice('--platform='.length)
      if (value !== 'darwin' && value !== 'linux') {
        r.error = `--platform must be 'darwin' or 'linux' (got '${value}')`
        return r
      }
      r.platform = value
      continue
    }
    r.error = `unexpected argument '${token}'`
    return r
  }
  if (r.json && !r.dryRun) {
    r.error = '--json requires --dry-run'
  }
  return r
}

/**
 * @param {string[]} argv
 * @returns {{ foreground: boolean, configPath?: string, error?: string }}
 */
function parseDaemonRunArgs(argv) {
  /** @type {{ foreground: boolean, configPath?: string, error?: string }} */
  const r = { foreground: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--foreground' || token === '-f') {
      r.foreground = true
      continue
    }
    if (token === '--config' || token.startsWith('--config=')) {
      const value = token === '--config' ? argv[++i] : token.slice('--config='.length)
      if (!value) {
        r.error = '--config requires a path'
        return r
      }
      r.configPath = value
      continue
    }
    if (token === '--help' || token === '-h') {
      r.error = 'usage: hyp daemon run --foreground [--config <path>]'
      return r
    }
    r.error = `unexpected argument '${token}'`
    return r
  }
  return r
}

/* ---------- smoke ---------- */

/**
 * `hyp smoke <flow>` — internal developer command.
 *
 * The smoke harness owns a fresh tmp `HYP_HOME` and installs its own
 * observability against that tmpdir. Installing observability in the
 * parent dispatch (which is required to emit `command.run` for this
 * invocation) would lock the tracer to the parent's `HYP_HOME` before
 * the harness can swap it. We resolve that by spawning a subprocess
 * dedicated to the flow: the parent emits its `command.run` span, the
 * child boots a clean observability instance against the harness
 * tmpdir, and the child's exit code is propagated back.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runSmoke(argv, ctx) {
  const flow = argv[0]
  if (!flow) {
    ctx.stderr.write('usage: hyp smoke <flow-name>\n')
    return 2
  }
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const binPath = fileURLToPath(new URL('../../../bin/hypaware.js', import.meta.url))
  const result = spawnSync(
    process.execPath,
    [binPath, '__smoke_internal', flow],
    {
      stdio: ['inherit', 'inherit', 'inherit'],
      env: ctx.env,
      cwd: ctx.cwd,
    }
  )
  if (result.error) {
    ctx.stderr.write(`hyp smoke: ${result.error.message}\n`)
    return 1
  }
  return result.status ?? 1
}

/* ---------- sink ---------- */

/**
 * `hyp sink` group landing — no default behavior, just usage.
 *
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 */
async function runSinkHelp(_argv, ctx) {
  ctx.stdout.write('usage: hyp sink <subcommand> [args...]\n')
  ctx.stdout.write('  subcommands:\n')
  ctx.stdout.write('    force [instance]   Run a sink tick now, ignoring schedules\n')
  return 0
}

/**
 * `hyp sink force [instance]`
 *
 * Drives one tick of the sink driver immediately, bypassing each
 * sink's cron schedule. The optional `instance` argument restricts
 * the tick to a single sink — useful when an operator just wants to
 * flush one configured destination without waking the others.
 *
 * The driver writes the same `sink.export_batch` span and outbox
 * artifacts it does on a scheduled tick — the only difference is the
 * trigger.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runSinkForce(argv, ctx) {
  const instance = argv[0]
  const obsEnv = readObservabilityEnv(ctx.env)
  const { createSinkDriver } = await import('../sinks/driver.js')
  const driver = createSinkDriver({
    sinkRegistry: /** @type {any} */ (ctx.sinks),
    queryRegistry: ctx.query,
    storage: ctx.storage,
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

/* ---------- misc ---------- */

/**
 * `hyp init [preset]`
 *
 * Without arguments runs the interactive walkthrough (TTY only — when
 * stdout is not a TTY the command prints the available presets and
 * exits non-zero so scripts get a deterministic failure instead of
 * blocking on stdin).
 *
 * With a `<preset>` argument resolves the preset through the kernel
 * `InitPresetRegistry` and invokes its `run(argv, ctx)`. Unknown
 * presets land on stderr with the list of available names.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runInit(argv, ctx) {
  if (argv.length > 0 && !argv[0].startsWith('-')) {
    const presetName = argv[0]
    const preset = ctx.initPresets.get(presetName)
    if (!preset) {
      const available = ctx.initPresets.list()
      ctx.stderr.write(`hyp init: unknown preset '${presetName}'\n`)
      if (available.length === 0) {
        ctx.stderr.write('  no presets registered — install a plugin that contributes one\n')
      } else {
        ctx.stderr.write('  available:\n')
        for (const p of available) {
          ctx.stderr.write(`    ${p.name}  (${p.plugin})  — ${p.summary}\n`)
        }
      }
      return 1
    }
    return preset.run(argv.slice(1), ctx)
  }

  // Phase 5: non-interactive flags. Detected by the presence of any
  // recognized init flag in argv. When absent, fall through to the
  // legacy preset/walkthrough dispatcher below.
  if (hasInitFlags(argv)) {
    const parsed = parseInitFlags(argv)
    if (parsed.error) {
      ctx.stderr.write(`hyp init: ${parsed.error}\n`)
      return 2
    }
    return runPickerInit(parsed.flags, ctx)
  }

  if (argv.length === 0) {
    if (isTty(ctx.stdout)) {
      const result = await runPickerWalkthrough({
        capabilities: ctx.capabilities,
        sources: /** @type {any} */ (ctx.sources),
        skills: /** @type {any} */ (ctx.skills),
        stdout: ctx.stdout,
        stderr: ctx.stderr,
        env: ctx.env,
        finale: {},
      })
      return result.exitCode
    }
    const available = ctx.initPresets.list()
    ctx.stderr.write('hyp init: stdin is not a TTY — pass a preset name or non-interactive flags.\n')
    ctx.stderr.write('  non-interactive: hyp init --yes [--client claude] [--source otel] ...\n')
    if (available.length === 0) {
      ctx.stderr.write('  no presets registered\n')
    } else {
      ctx.stderr.write('  presets:\n')
      for (const p of available) {
        ctx.stderr.write(`    ${p.name}  (${p.plugin})  — ${p.summary}\n`)
      }
    }
    return 2
  }

  const presetName = argv[0]
  const preset = ctx.initPresets.get(presetName)
  if (!preset) {
    const available = ctx.initPresets.list()
    ctx.stderr.write(`hyp init: unknown preset '${presetName}'\n`)
    if (available.length === 0) {
      ctx.stderr.write('  no presets registered — install a plugin that contributes one\n')
    } else {
      ctx.stderr.write('  available:\n')
      for (const p of available) {
        ctx.stderr.write(`    ${p.name}  (${p.plugin})  — ${p.summary}\n`)
      }
    }
    return 1
  }
  return preset.run(argv.slice(1), ctx)
}

/**
 * Recognized init flag names (Phase 5). Used as a fast-path detector
 * so legacy preset-name invocations still flow through the existing
 * dispatcher.
 *
 * @type {Set<string>}
 */
const INIT_FLAG_NAMES = new Set([
  '--yes', '-y',
  '--no-daemon',
  '--dry-run',
  '--client', '--source', '--export',
  '--retention-days', '--from-file',
  '--bin',
])

/**
 * @param {string[]} argv
 */
function hasInitFlags(argv) {
  return argv.some((t) => {
    if (INIT_FLAG_NAMES.has(t)) return true
    for (const name of INIT_FLAG_NAMES) {
      if (t.startsWith(`${name}=`)) return true
    }
    return false
  })
}

/**
 * @param {string[]} argv
 * @returns {{ flags: InitFlags, error?: string }}
 */
function parseInitFlags(argv) {
  /** @type {InitFlags} */
  const flags = {
    yes: false,
    noDaemon: false,
    dryRun: false,
    clients: [],
    sources: [],
    exportChoice: undefined,
    retentionDays: 30,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--yes' || arg === '-y') { flags.yes = true; continue }
    if (arg === '--no-daemon') { flags.noDaemon = true; continue }
    if (arg === '--dry-run') { flags.dryRun = true; continue }
    if (arg === '--client' || arg.startsWith('--client=')) {
      const value = arg === '--client' ? argv[++i] : arg.slice('--client='.length)
      if (value !== 'claude' && value !== 'codex') {
        return { flags, error: `--client: expected claude or codex (got "${value ?? ''}")` }
      }
      if (!flags.clients.includes(value)) flags.clients.push(value)
      continue
    }
    if (arg === '--source' || arg.startsWith('--source=')) {
      const value = arg === '--source' ? argv[++i] : arg.slice('--source='.length)
      const allowed = ['claude', 'codex', 'raw-anthropic', 'raw-openai', 'otel']
      if (!allowed.includes(value ?? '')) {
        return { flags, error: `--source: expected one of ${allowed.join(', ')} (got "${value ?? ''}")` }
      }
      const typed = /** @type {'claude'|'codex'|'raw-anthropic'|'raw-openai'|'otel'} */ (value)
      if (!flags.sources.includes(typed)) flags.sources.push(typed)
      continue
    }
    if (arg === '--export' || arg.startsWith('--export=')) {
      const value = arg === '--export' ? argv[++i] : arg.slice('--export='.length)
      const allowed = ['keep-local', 'local-parquet', 'configure-later']
      if (!allowed.includes(value ?? '')) {
        return { flags, error: `--export: expected one of ${allowed.join(', ')} (got "${value ?? ''}")` }
      }
      flags.exportChoice = /** @type {'keep-local'|'local-parquet'|'configure-later'} */ (value)
      continue
    }
    if (arg === '--retention-days' || arg.startsWith('--retention-days=')) {
      const value = arg === '--retention-days' ? argv[++i] : arg.slice('--retention-days='.length)
      const parsed = Number.parseInt(value ?? '', 10)
      if (!Number.isInteger(parsed) || parsed < 0) {
        return { flags, error: `--retention-days: expected non-negative integer (got "${value ?? ''}")` }
      }
      flags.retentionDays = parsed
      continue
    }
    if (arg === '--from-file' || arg.startsWith('--from-file=')) {
      const value = arg === '--from-file' ? argv[++i] : arg.slice('--from-file='.length)
      if (!value) return { flags, error: '--from-file: requires a path' }
      flags.fromFile = value
      continue
    }
    if (arg === '--bin' || arg.startsWith('--bin=')) {
      const value = arg === '--bin' ? argv[++i] : arg.slice('--bin='.length)
      if (!value) return { flags, error: '--bin: requires a path' }
      flags.binPath = value
      continue
    }
    return { flags, error: `unknown argument: ${arg}` }
  }
  return { flags }
}

/**
 * Non-interactive Phase 5 init. Composes picks from CLI flags,
 * optionally seeds the config from a file (`--from-file`), and
 * delegates to {@link runPickerWalkthrough}.
 *
 * @param {InitFlags} flags
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
async function runPickerInit(flags, ctx) {
  // --from-file short-circuits the picker entirely. The supplied
  // config is validated and written to the canonical location;
  // walkthrough.start / walkthrough.write_config / walkthrough.finish
  // spans are still emitted so the smoke contract holds.
  if (flags.fromFile) {
    return runInitFromFile(flags, ctx)
  }

  // Default picks when `--yes` is the only signal: capture Claude +
  // OTEL, export to local Parquet. Matches the default V1 install
  // documented in finish-v1.md §V1 Acceptance Criteria.
  const sources = flags.sources.slice()
  if (sources.length === 0) {
    if (flags.yes) {
      sources.push('claude', 'otel')
    } else {
      ctx.stderr.write('hyp init: no sources selected — pass --source <kind> or --yes\n')
      return 2
    }
  }
  // Folding clients into sources, so `--client claude` alone is
  // sufficient even without an explicit `--source claude`.
  for (const c of flags.clients) {
    if (!sources.includes(c)) sources.push(c)
  }

  const exportChoice = flags.exportChoice ?? (flags.yes ? 'local-parquet' : 'keep-local')

  const result = await runPickerWalkthrough({
    capabilities: ctx.capabilities,
    sources: /** @type {any} */ (ctx.sources),
    skills: /** @type {any} */ (ctx.skills),
    stdout: ctx.stdout,
    stderr: ctx.stderr,
    env: ctx.env,
    picks: {
      sources,
      exportChoice,
      retentionDays: flags.retentionDays,
    },
    finale: {
      skipDaemon: flags.noDaemon,
      dryRun: flags.dryRun,
      ...(flags.binPath ? { binPath: flags.binPath } : {}),
    },
  })
  return result.exitCode
}

/**
 * `hyp init --from-file <path>` — read a v2 config from disk, validate
 * it, and write it to the canonical location. Still emits the
 * walkthrough spans so the smoke pipeline observes a consistent
 * lifecycle.
 *
 * @param {InitFlags} flags
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
async function runInitFromFile(flags, ctx) {
  const { withSpan, Attr } = await import('../observability/index.js')
  const { readObservabilityEnv } = await import('../observability/env.js')
  let raw
  try {
    raw = await fs.readFile(/** @type {string} */ (flags.fromFile), 'utf8')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.stderr.write(`hyp init: --from-file: ${message}\n`)
    return 1
  }
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.stderr.write(`hyp init: --from-file: invalid JSON: ${message}\n`)
    return 1
  }
  const catalogCtx = await buildKnownPluginsForCtx(ctx)
  const validation = await validateConfig(/** @type {any} */ (parsed), { knownPlugins: catalogCtx.knownPlugins, knownDatasets: catalogCtx.knownDatasets })
  if (!validation.ok) {
    for (const err of validation.errors) {
      ctx.stderr.write(
        `hyp init: --from-file: [${err.errorKind}] ${err.pointer || '<root>'}: ${err.message}\n`
      )
    }
    return 1
  }

  await withSpan(
    'walkthrough.start',
    {
      [Attr.COMPONENT]: 'walkthrough',
      [Attr.OPERATION]: 'walkthrough.start',
      sources_available: 0,
      exports_available: 0,
      from_file: true,
      status: 'ok',
    },
    async () => {},
    { component: 'walkthrough' }
  )

  const obsEnv = readObservabilityEnv(ctx.env)
  const targetPath = ctx.env.HYP_CONFIG
    ? path.resolve(ctx.env.HYP_CONFIG)
    : defaultConfigPath(obsEnv.hypHome)

  await withSpan(
    'walkthrough.write_config',
    {
      [Attr.COMPONENT]: 'walkthrough',
      [Attr.OPERATION]: 'walkthrough.write_config',
      config_path: targetPath,
      from_file: true,
      status: 'ok',
    },
    async () => {
      await fs.mkdir(path.dirname(targetPath), { recursive: true })
      await fs.writeFile(targetPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8')
    },
    { component: 'walkthrough' }
  )

  await withSpan(
    'walkthrough.finish',
    {
      [Attr.COMPONENT]: 'walkthrough',
      [Attr.OPERATION]: 'walkthrough.finish',
      from_file: true,
      config_path: targetPath,
      status: 'ok',
    },
    async () => {},
    { component: 'walkthrough' }
  )

  ctx.stdout.write(`✓ Wrote ${targetPath}\n`)
  return 0
}

/** @param {unknown} stream */
function isTty(stream) {
  return !!stream && typeof stream === 'object' && /** @type {{ isTTY?: boolean }} */ (stream).isTTY === true
}

/**
 * `hyp attach [client] [--client <name>] [--yes]`
 *
 * Resolves the `hypaware.ai-gateway` capability, looks up the named
 * client adapter, and dispatches to the adapter's `attach()`. Each
 * adapter emits its own `client.attach` span; this router only
 * threads stdout/stderr and the gateway's `localEndpoint()` into the
 * adapter context.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runAttach(argv, ctx) {
  return runClientLifecycle('attach', argv, ctx)
}

/**
 * `hyp detach [client] [--client <name>]`
 *
 * Resolves the gateway capability, looks up the named client, and
 * dispatches to its `detach()`. `detach()` is invoked with the
 * adapter's config slice (currently empty until per-adapter config
 * lands) plus stdout/stderr.
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runDetach(argv, ctx) {
  return runClientLifecycle('detach', argv, ctx)
}

/**
 * @param {'attach'|'detach'} action
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {Promise<number>}
 */
async function runClientLifecycle(action, argv, ctx) {
  const parsed = parseClientArgs(argv)
  if (parsed.error) {
    ctx.stderr.write(`error: ${parsed.error}\n`)
    return 2
  }

  if (!ctx.capabilities.has('hypaware.ai-gateway')) {
    await withSpan(
      `client.${action}`,
      {
        [Attr.COMPONENT]: `cmd-${action}`,
        [Attr.OPERATION]: `client.${action}`,
        client_name: parsed.client,
        hyp_client: parsed.client,
        dry_run: parsed.dryRun === true,
        status: 'failed',
        error_kind: 'cap_missing',
      },
      async () => {
        const message =
          `${action} requires the @hypaware/ai-gateway plugin to be installed and activated`
        if (parsed.json) {
          ctx.stdout.write(
            JSON.stringify({
              status: 'failed',
              action,
              client: parsed.client,
              dry_run: parsed.dryRun === true,
              error_kind: 'cap_missing',
              error: message,
            }) + '\n'
          )
        } else {
          ctx.stderr.write(`error: ${message}\n`)
        }
      },
      { component: `cmd-${action}` }
    )
    return 1
  }
  /** @type {AiGatewayCapability} */
  const gateway = ctx.capabilities.require('hyp-core', 'hypaware.ai-gateway', '^2.0.0')

  const clientNames = expandClientName(parsed.client, gateway)
  if (clientNames.length === 0) {
    ctx.stderr.write(
      `error: unknown client '${parsed.client}'. Registered clients: ${
        gateway.listClients().map((c) => c.name).join(', ') || '(none)'
      }\n`
    )
    return 1
  }

  let exitCode = 0
  for (const name of clientNames) {
    const client = gateway.getClient(name)
    if (!client) {
      ctx.stderr.write(`error: unknown client '${name}'\n`)
      exitCode = 1
      continue
    }
    try {
      if (action === 'attach') {
        // In dry-run mode the gateway source may not be started yet,
        // so `localEndpoint()` could throw. Fall back to a placeholder
        // endpoint — adapters are expected to short-circuit before
        // touching it.
        let endpoint
        if (parsed.dryRun) {
          try {
            endpoint = gateway.localEndpoint()
          } catch {
            endpoint = configuredGatewayEndpoint(ctx.config) ?? 'http://127.0.0.1:0'
          }
        } else {
          try {
            endpoint = gateway.localEndpoint()
          } catch (err) {
            const configured = configuredGatewayEndpoint(ctx.config)
            if (!configured) throw err
            endpoint = configured
          }
        }
        await client.attach({
          endpoint,
          config: {},
          stdout: ctx.stdout,
          stderr: ctx.stderr,
          dryRun: parsed.dryRun,
          json: parsed.json,
        })
      } else {
        await client.detach({
          config: {},
          stdout: ctx.stdout,
          stderr: ctx.stderr,
          dryRun: parsed.dryRun,
          json: parsed.json,
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      ctx.stderr.write(`error: ${action} client '${name}' failed: ${message}\n`)
      exitCode = 1
    }
  }
  return exitCode
}

/**
 * Resolve the gateway endpoint from the active config when the gateway
 * source is not live in this process yet. This is the normal shape for
 * commands like `hyp attach`, which only need to write client settings
 * to the same fixed port the daemon will bind later.
 *
 * @param {HypAwareV2Config} config
 * @returns {string | undefined}
 */
function configuredGatewayEndpoint(config) {
  const entry = config.plugins?.find((p) => p.name === '@hypaware/ai-gateway')
  const cfg = entry?.config
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return undefined
  const listen = /** @type {Record<string, unknown>} */ (cfg).listen
  if (typeof listen !== 'string') return undefined
  return endpointFromListen(listen)
}

/**
 * @param {string} listen
 * @returns {string | undefined}
 */
function endpointFromListen(listen) {
  const idx = listen.lastIndexOf(':')
  if (idx === -1) return undefined
  const rawHost = listen.slice(0, idx)
  const rawPort = listen.slice(idx + 1)
  const port = Number.parseInt(rawPort, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== rawPort) {
    return undefined
  }
  const host = rawHost.startsWith('[') && rawHost.endsWith(']')
    ? rawHost.slice(1, -1)
    : rawHost
  if (host.length === 0) return undefined
  const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `http://${formattedHost}:${port}`
}

/**
 * Parse an optional positional client name plus `--client <name>`,
 * `--yes` / `-y`, `--dry-run`, and `--json` from argv.
 * @param {string[]} argv
 */
function parseClientArgs(argv) {
  /** @type {{ client: string, yes: boolean, dryRun: boolean, json: boolean, error?: string }} */
  const r = { client: 'claude', yes: false, dryRun: false, json: false }
  /** @type {string | undefined} */
  let requestedClient
  /**
   * @param {string | undefined} value
   * @param {'--client'|'positional'} source
   * @returns {boolean}
   */
  function setClient(value, source) {
    if (!value || value.startsWith('-')) {
      r.error = source === '--client'
        ? '--client requires a name'
        : 'client name is required'
      return false
    }
    if (requestedClient && requestedClient !== value) {
      r.error = `client specified multiple times (${requestedClient}, ${value})`
      return false
    }
    requestedClient = value
    r.client = value
    return true
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--yes' || arg === '-y') {
      r.yes = true
      continue
    }
    if (arg === '--dry-run') {
      r.dryRun = true
      continue
    }
    if (arg === '--json') {
      r.json = true
      continue
    }
    if (arg === '--client' || arg.startsWith('--client=')) {
      const value = arg === '--client' ? argv[++i] : arg.slice('--client='.length)
      if (!setClient(value, '--client')) return r
      continue
    }
    if (!arg.startsWith('-')) {
      if (!setClient(arg, 'positional')) return r
      continue
    }
    r.error = `unknown argument: ${arg}`
    return r
  }
  return r
}

/**
 * Resolve `--client all` to every registered client name; otherwise
 * return the requested name verbatim.
 *
 * @param {string} requested
 * @param {AiGatewayCapability} gateway
 */
function expandClientName(requested, gateway) {
  if (requested === 'all') {
    return gateway.listClients().map((c) => c.name)
  }
  return [requested]
}

/**
 * @param {string[]} _argv
 * @param {CommandRunContext} ctx
 */
async function runIgnore(_argv, ctx) {
  ctx.stdout.write('(session ignore is contributed by recording-source plugins)\n')
  return 0
}

/**
 * `hyp skills install [--client <name>]`
 *
 * Walks the kernel skill registry and materializes each contribution
 * into the right per-client skill directory. The skill source tree
 * (a directory with `SKILL.md`) is copied recursively; existing
 * installations are replaced (idempotent).
 *
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 */
async function runSkillsInstall(argv, ctx) {
  const parsed = parseSkillsArgs(argv)
  if (parsed.error) {
    ctx.stderr.write(`error: ${parsed.error}\n`)
    return 2
  }

  const skills = ctx.skills.list()
  if (skills.length === 0) {
    ctx.stdout.write('(no skills registered)\n')
    return 0
  }

  const homeDir = ctx.env.HOME ?? process.env.HOME ?? ''
  if (!homeDir) {
    ctx.stderr.write('error: HOME is not set; cannot resolve skill install paths\n')
    return 1
  }

  const skillDirMap = await buildSkillDirMap()

  let count = 0
  for (const skill of skills) {
    for (const targetClient of skill.clients) {
      if (parsed.client !== 'all' && parsed.client !== targetClient) continue
      const skillDir = skillDirMap.get(targetClient)
      if (!skillDir) {
        ctx.stderr.write(`warning: skill '${skill.name}' targets unknown client '${targetClient}'\n`)
        continue
      }
      const dest = path.join(homeDir, skillDir, skill.name)
      try {
        await fs.rm(dest, { recursive: true, force: true })
        await copyDir(skill.sourceDir, dest)
        ctx.stdout.write(`installed skill '${skill.name}' → ${dest}\n`)
        count += 1
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        ctx.stderr.write(`warning: skill '${skill.name}' for ${targetClient} failed: ${message}\n`)
      }
    }
  }
  ctx.stdout.write(`installed ${count} skill copy(ies)\n`)
  return 0
}

/**
 * Build a map from client name to skill directory by reading plugin
 * manifests. This avoids hardcoding `.claude/skills` / `.codex/skills`
 * in core.
 *
 * @returns {Promise<Map<string, string>>}
 */
async function buildSkillDirMap() {
  /** @type {Map<string, string>} */
  const map = new Map()
  try {
    const bundled = await discoverBundledPlugins()
    const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
    for (const [clientName, descriptor] of catalog.clientDescriptors) {
      map.set(clientName, descriptor.skillDir)
    }
  } catch { /* discovery failure → empty map → warnings per skill */ }
  return map
}

/** @param {string[]} argv */
function parseSkillsArgs(argv) {
  /** @type {{ client: string, error?: string }} */
  const r = { client: 'all' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--client' || arg.startsWith('--client=')) {
      const value = arg === '--client' ? argv[++i] : arg.slice('--client='.length)
      if (!value) { r.error = '--client requires a name'; return r }
      r.client = value
      continue
    }
    r.error = `unknown argument: ${arg}`
    return r
  }
  return r
}

/**
 * @param {string} src
 * @param {string} dest
 * @returns {Promise<void>}
 */
async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDir(from, to)
    } else if (entry.isFile()) {
      await fs.copyFile(from, to)
    }
  }
}
